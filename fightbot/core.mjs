// FightBot core — the tools an assistant (Claude Desktop / Claude Code / any
// MCP client) can call about the card, the odds and the group's picks.
//
// Every answer comes from the same code the Fight Lab runs: lab/engine.js for
// the normalized card and the board's own scoring (lifted from index.html, not
// copied), lab/analytics.js for movers, IQ, briefs and matchups. So FightBot
// can't tell someone a score, a line move or a model number the app wouldn't.
//
// Read-only, like the Lab: it never writes a pick. Picks come from the same
// public read the app makes; data comes from the repo's committed files.
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ------------------------------------------------------------------ loading --
function loadLab() {
  const g = {};
  const ctx = vm.createContext({ console, Math, Date, JSON, Object, Array, String, Number, isFinite, parseFloat, Function });
  ctx.globalThis = ctx;
  vm.runInContext(readFileSync(join(ROOT, "lab/engine.js"), "utf8"), ctx, { filename: "lab/engine.js" });
  vm.runInContext(readFileSync(join(ROOT, "lab/analytics.js"), "utf8"), ctx, { filename: "lab/analytics.js" });
  g.PE = ctx.PickEngine; g.FL = ctx.FightLab;
  return g;
}
const { PE, FL } = loadLab();
export { PE, FL };

function readJSON(name, fallback) {
  const p = join(ROOT, name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; }
}
function supabaseConfig(html) {
  const url = /var SUPABASE_URL="([^"]+)"/.exec(html), key = /var SUPABASE_ANON="([^"]+)"/.exec(html);
  return url && key ? { url: url[1], key: key[1] } : null;
}

// State is rebuilt when any source file changes on disk, so a long-running
// server picks up the scraper's next data.js after a `git pull`.
const SOURCES = ["data.js", "index.html", "scoring.js", "odds-series.json", "intel.json", "events-extra.json"];
let state = null, stamp = "";
function fingerprint() {
  return SOURCES.map((f) => { try { return statSync(join(ROOT, f)).mtimeMs; } catch { return 0; } }).join("|");
}
export function load(force) {
  const fp = fingerprint();
  if (state && !force && fp === stamp) return state;
  const dctx = vm.createContext({});
  vm.runInContext(readFileSync(join(ROOT, "data.js"), "utf8"), dctx, { filename: "data.js" });
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const env = { EVENTS: dctx.EVENTS, RESULTS_ARCHIVE: dctx.RESULTS_ARCHIVE || {}, FIGHTER_STATS: dctx.FIGHTER_STATS || {}, RANKINGS: dctx.RANKINGS || {} };
  const kernel = PE.loadKernel(html, env, undefined, readFileSync(join(ROOT, "scoring.js"), "utf8"));
  const feedRaw = readJSON("events-extra.json", null);
  const adapters = [PE.ufcAdapter(env)];
  if (feedRaw) adapters.push(PE.feedAdapter(feedRaw));
  const oddsRaw = readJSON("odds-series.json", null);
  state = {
    env, kernel, html, generatedAt: dctx.GENERATED_AT || null,
    engine: PE.createEngine({ adapters, rules: { ufc: PE.ufcRules(kernel) } }),
    odds: FL.oddsIndex(oddsRaw), oddsRaw, intel: readJSON("intel.json", null),
    supabase: supabaseConfig(html),
  };
  stamp = fp;
  return state;
}

// Picks: FIGHTBOT_PICKS_FILE (a JSON array, for tests/offline) or the public
// read. Cached briefly — a chat turn often calls two or three tools in a row.
let picksCache = { at: 0, rows: null };
const PICKS_TTL_MS = 60000;
export async function picks(s) {
  if (process.env.FIGHTBOT_PICKS_FILE) return JSON.parse(readFileSync(process.env.FIGHTBOT_PICKS_FILE, "utf8"));
  if (picksCache.rows && Date.now() - picksCache.at < PICKS_TTL_MS) return picksCache.rows;
  if (!s.supabase) throw new Error("no Supabase config found in index.html");
  const PAGE = 1000, q = "/rest/v1/picks?select=user_id,event_name,event_date,f1,f2,pick,method,confidence,nickname,updated_at,bonus_pick&order=updated_at.desc,user_id.asc,event_date.asc,f1.asc";
  let all = [];
  for (let from = 0; ; from += PAGE) {
    const r = await fetch(s.supabase.url + q, { headers: { apikey: s.supabase.key, Authorization: "Bearer " + s.supabase.key, Range: `${from}-${from + PAGE - 1}` } });
    if (!r.ok) throw new Error("picks read failed: HTTP " + r.status);
    const rows = await r.json();
    all = all.concat(rows);
    if (rows.length < PAGE) break;
  }
  picksCache = { at: Date.now(), rows: all };
  return all;
}

// ------------------------------------------------------------------ helpers --
const fmtOdds = (n) => FL.fmtOdds(n);
const pct = (p) => (p == null ? null : Math.round(p * 1000) / 10);
function findEvent(s, date, promo) {
  const evs = s.engine.events(promo || undefined);
  if (!date) return s.engine.nextEvent(new Date(), promo || "ufc");
  return evs.find((e) => e.date === date) || null;
}
function boutView(s, ev, b) {
  const [a, c] = b.competitors;
  const edge = b.raw && b.raw.f1 && b.raw.f1.n ? s.kernel.modelEdge(b.raw, s.env.FIGHTER_STATS, s.env.RANKINGS, s.env.RESULTS_ARCHIVE) : null;
  const mk = PE.deVig(a.odds, c.odds);
  return {
    bout: `${a.name} vs ${c.name}`, label: b.label, segment: b.segment, division: b.division, title: b.title,
    odds: typeof a.odds === "number" ? { [a.name]: fmtOdds(a.odds), [c.name]: fmtOdds(c.odds) } : null,
    market_pct: mk ? { [a.name]: pct(mk.a), [c.name]: pct(mk.b) } : null,
    model_pct: edge ? { [a.name]: pct(edge.model.p1), [c.name]: pct(edge.model.p2) } : null,
    result: b.result ? { winner: b.result.winner, method: b.result.method, round: b.result.round } : null,
  };
}
function resolvePlayer(rows, who, s) {
  if (!who) return null;
  const want = String(who).trim().toLowerCase();
  const byId = {};
  rows.forEach((r) => { const id = r.user_id || r.nickname; if (!byId[id]) byId[id] = r.nickname || ""; else if (!byId[id] && r.nickname) byId[id] = r.nickname; });
  const ids = Object.keys(byId);
  // The app's own splitNick: strips a leading emoji avatar only when there is
  // one, so a legacy name like "Adam B" stays "Adam B" and "🥊Andy" is "Andy".
  const base = (n) => s.kernel.splitNick(n).name.toLowerCase();
  return ids.find((id) => id.toLowerCase() === want) || ids.find((id) => base(byId[id]) === want)
    || ids.find((id) => base(byId[id]).includes(want)) || null;
}
function playerList(rows) {
  const seen = {};
  rows.forEach((r) => { const id = r.user_id || r.nickname; if (r.nickname) seen[id] = r.nickname; else if (!(id in seen)) seen[id] = ""; });
  return Object.values(seen).filter(Boolean);
}

// -------------------------------------------------------------------- tools --
// Each tool: description + JSON Schema input + handler(args) → plain object.
export const TOOLS = {
  get_next_card: {
    description: "The next upcoming fight card: every bout with its segment, current moneyline, de-vigged market win % and the app's fight-model win %.",
    inputSchema: { type: "object", properties: { promotion: { type: "string", description: "Promotion id (default 'ufc')." } } },
    async run(a) {
      const s = load(), ev = findEvent(s, null, a.promotion);
      if (!ev) return { card: null, note: "No upcoming card on the schedule." };
      return { name: ev.name, date: ev.date, location: ev.location, broadcast: ev.broadcast, segments: ev.segments, bouts: ev.bouts.map((b) => boutView(s, ev, b)) };
    },
  },
  get_card: {
    description: "One card by date (YYYY-MM-DD), past or upcoming, including results where decided.",
    inputSchema: { type: "object", properties: { date: { type: "string" }, promotion: { type: "string" } }, required: ["date"] },
    async run(a) {
      const s = load(), ev = findEvent(s, a.date, a.promotion);
      if (!ev) return { card: null, note: `No card on ${a.date}.`, known_dates: s.engine.events().map((e) => e.date).slice(-12) };
      return { name: ev.name, date: ev.date, source: ev.source, bouts: ev.bouts.map((b) => boutView(s, ev, b)) };
    },
  },
  search_fighters: {
    description: "Find fighters in the stats cache by name fragment (accent- and case-insensitive).",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
    async run(a) {
      const s = load(), q = PE.simpleKey(a.query);
      const hits = Object.keys(s.env.FIGHTER_STATS).filter((n) => PE.simpleKey(n).includes(q)).slice(0, a.limit || 15);
      return { matches: hits.map((n) => ({ name: n, record: s.env.FIGHTER_STATS[n].rec || "", rank: s.env.RANKINGS[n] || null })) };
    },
  },
  compare_fighters: {
    description: "Tale of the tape for ANY two fighters (not just a scheduled bout): record, rank, age, reach, striking and grappling rates, finishes, recent form, the app's model estimate with its factors, notable edges, and each fighter's betting history.",
    inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    async run(a) {
      const s = load();
      const pickName = (v) => Object.keys(s.env.FIGHTER_STATS).find((n) => s.kernel.nmEq(n, v)) || v;
      const m = FL.matchup(pickName(a.a), pickName(a.b), { stats: s.env.FIGHTER_STATS, rankings: s.env.RANKINGS, archive: s.env.RESULTS_ARCHIVE,
        kernel: s.kernel, fighterOdds: s.oddsRaw && s.oddsRaw.fighters });
      if (m.missing) return { error: `No stats cached for ${m.missing.join(" and ")}. Try search_fighters.` };
      return {
        fighters: [m.a, m.b], tape: m.rows.map((r) => ({ stat: r.label, [m.a]: r.a, [m.b]: r.b, edge: r.edge ? (r.edge === 1 ? m.a : m.b) : null })),
        form_newest_first: { [m.a]: m.formA, [m.b]: m.formB },
        model: m.model ? { [m.a]: pct(m.model.p1), [m.b]: pct(m.model.p2), confidence: m.model.confidence, factors: m.model.factors } : null,
        notes: m.notes, betting_history: { [m.a]: m.history.a.slice(-5), [m.b]: m.history.b.slice(-5) },
        caveat: "The model is an estimate from cached UFCStats data, not a prediction to bet on.",
      };
    },
  },
  get_odds_movement: {
    description: "Line movement on upcoming bouts: open → latest price, the de-vigged probability move, steam moves (4+ points inside 24h) and underdogs gaining support. Sorted by size of move.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "Limit to one card (YYYY-MM-DD)." }, limit: { type: "number" } } },
    async run(a) {
      const s = load(), now = new Date();
      let evs = s.engine.upcoming(now, "ufc");
      if (a.date) evs = evs.filter((e) => e.date === a.date);
      return { movers: FL.marketMovers(evs, s.odds, now).slice(0, a.limit || 10).map((m) => {
        const side = m.move >= 0 ? "a" : "b", c = m.bout.competitors;
        return { card: m.event.name, date: m.event.date, bout: `${c[0].name} vs ${c[1].name}`, moving_toward: m.toward,
          open: fmtOdds(m.open[side]), latest: fmtOdds(m.current[side]), move_pts: Math.abs(m.move), steam_pts: m.steam || null,
          underdog_gaining: m.dogGaining, snapshots: m.points };
      }) };
    },
  },
  find_underdogs: {
    description: "Upcoming underdogs at or beyond a price (default +200), with the stat edges they hold over the favorite — e.g. 'every +200 dog with better takedown stats'.",
    inputSchema: { type: "object", properties: { min_odds: { type: "number" }, stat: { type: "string", description: "Only dogs with the edge on this stat label, e.g. 'Takedowns / 15 min'." } } },
    async run(a) {
      const s = load(), min = a.min_odds || 200, out = [];
      s.engine.upcoming(new Date(), "ufc").forEach((ev) => ev.bouts.forEach((b) => {
        if (b.result) return;
        b.competitors.forEach((c, i) => {
          if (typeof c.odds !== "number" || c.odds < min) return;
          const fav = b.competitors[1 - i].name;
          const m = FL.matchup(c.name, fav, { stats: s.env.FIGHTER_STATS, rankings: s.env.RANKINGS, archive: s.env.RESULTS_ARCHIVE, kernel: s.kernel });
          const edges = m.rows ? m.rows.filter((r) => r.edge === 1).map((r) => r.label) : [];
          if (a.stat && !edges.some((e) => e.toLowerCase().includes(String(a.stat).toLowerCase()))) return;
          out.push({ card: ev.name, date: ev.date, underdog: c.name, odds: fmtOdds(c.odds), favorite: fav, dog_holds_edge_in: edges,
            model_pct: m.model ? pct(m.model.p1) : null, stats_cached: !m.missing });
        });
      }));
      return { min_odds: fmtOdds(min), underdogs: out };
    },
  },
  fight_week_brief: {
    description: "The fight-week brief for the next card: biggest line move, steam, unpriced bouts, curated fight-week articles, the group's most disputed fight, and the bouts where the model and market disagree most.",
    inputSchema: { type: "object", properties: { player: { type: "string", description: "Whose pick progress to include." } } },
    async run(a) {
      const s = load(), ev = s.engine.nextEvent(new Date(), "ufc");
      if (!ev) return { note: "No upcoming card." };
      let group = [], mine = [], picksNote = null;
      try { const rows = PE.boardRows(s.kernel, await picks(s)); group = s.engine.resolvePicks(rows); const id = resolvePlayer(rows, a.player, s); mine = id ? group.filter((p) => p.player === id) : []; }
      catch (e) { picksNote = e.message; }
      const raw = s.env.EVENTS.find((e) => e.date === ev.date && e.name === ev.name);
      const intel = raw && s.intel ? s.kernel.intelItemsFor(s.intel, raw) : [];
      const edgeFor = (b) => (b.raw && b.raw.f1 ? s.kernel.modelEdge(b.raw, s.env.FIGHTER_STATS, s.env.RANKINGS, s.env.RESULTS_ARCHIVE) : null);
      const br = FL.fightWeekBrief(ev, { odds: s.odds, intel, group, mine, edgeFor, now: new Date() });
      return { card: ev.name, date: ev.date, days_out: br.days, headlines: br.items.map((i) => i.icon + " " + i.text).filter((t) => a.player || !/You've picked/.test(t)),
        worth_studying: br.study.map((x) => ({ bout: `${x.bout.competitors[0].name} vs ${x.bout.competitors[1].name}`, model_likes: x.bout.competitors[x.side - 1].name, gap_pts: x.edge })),
        intel: br.intel.map((i) => ({ title: i.title, url: i.url, source: i.source })), picks_unavailable: picksNote };
    },
  },
  get_leaderboard: {
    description: "The group standings, scored by the app's own leaderboard code (points, record, accuracy, streaks). Optionally one card's standings.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "One card (YYYY-MM-DD); omit for all-time." } } },
    async run(a) {
      const s = load(), rows = PE.boardRows(s.kernel, await picks(s));
      const board = s.kernel.boardStandings(rows, a.date ? { date: a.date } : null);
      return { scope: a.date || "all-time", standings: board.map((u, i) => ({ rank: i + 1, player: u.nickname, points: s.kernel.userPts(u),
        record: `${u.correct}-${u.total - u.correct}`, accuracy_pct: u.accuracy, current_streak: u.currentStreak, best_streak: u.bestStreak })) };
    },
  },
  get_user_picks: {
    description: "One player's picks (by nickname), optionally for one card, with each result and points.",
    inputSchema: { type: "object", properties: { player: { type: "string" }, date: { type: "string" } }, required: ["player"] },
    async run(a) {
      const s = load(), rows = PE.boardRows(s.kernel, await picks(s)), id = resolvePlayer(rows, a.player, s);
      if (!id) return { error: `No player matching "${a.player}".`, players: playerList(rows) };
      const list = s.engine.resolvePicks(rows).filter((p) => p.player === id && (!a.date || p.date === a.date));
      return { player: list[0] ? list[0].nickname : a.player, picks: list.slice(0, 60).map((p) => ({ date: p.date,
        bout: p.bout ? `${p.bout.competitors[0].name} vs ${p.bout.competitors[1].name}` : `${p.raw.f1} vs ${p.raw.f2}`,
        pick: p.pick, method: p.method || null, lock: p.locked, result: p.decided ? (p.correct ? "won" : "lost") : "pending", points: p.points })),
        truncated: list.length > 60 };
    },
  },
  fight_iq: {
    description: "A player's Fight IQ scouting report: picker archetype, record and points, splits by division / favorite vs underdog / style / locks, head-to-head record against each friend, closing-line value, and the insights that stand out.",
    inputSchema: { type: "object", properties: { player: { type: "string" } }, required: ["player"] },
    async run(a) {
      const s = load(), rows = PE.boardRows(s.kernel, await picks(s)), id = resolvePlayer(rows, a.player, s);
      if (!id) return { error: `No player matching "${a.player}".`, players: playerList(rows) };
      const all = s.engine.resolvePicks(rows), iq = FL.fightIQ(all.filter((p) => p.player === id), { odds: s.odds, stats: s.env.FIGHTER_STATS, group: all });
      return { archetype: `${iq.archetype.emoji} ${iq.archetype.name} — ${iq.archetype.blurb}`, record: `${iq.record.w}-${iq.record.l}`,
        accuracy_pct: iq.record.pct, points: iq.points, locks: `${iq.locks.w}-${iq.locks.l}`, method_hit_pct: iq.methods.pct,
        avg_clv_pts: iq.clv.avg, insights: iq.insights.map((i) => i.text),
        splits: iq.splits.filter((x) => x.rec.n >= FL.MIN_SAMPLE).map((x) => ({ [x.kind]: x.key, record: `${x.rec.w}-${x.rec.l}`, pct: x.rec.pct })),
        rivals: iq.rivals.map((r) => ({ vs: r.nickname, record_when_disagreeing: `${r.rec.w}-${r.rec.l}` })) };
    },
  },
  why_did_my_pick_lose: {
    description: "For a player's losing picks on a card: the result, the price they took (the line at their pick), how the line moved after, and what the tape and model show. Each loss says whether that analysis is pre-fight or retrospective (stats fetched after the fight already include the result).",
    inputSchema: { type: "object", properties: { player: { type: "string" }, date: { type: "string", description: "Card date; default the most recent card with results." } }, required: ["player"] },
    async run(a) {
      const s = load(), rows = PE.boardRows(s.kernel, await picks(s)), id = resolvePlayer(rows, a.player, s);
      if (!id) return { error: `No player matching "${a.player}".`, players: playerList(rows) };
      const done = s.engine.concluded("ufc"), date = a.date || (done[done.length - 1] || {}).date;
      const lost = s.engine.resolvePicks(rows).filter((p) => p.player === id && p.date === date && p.correct === false && p.side !== null);
      return { date, losses: lost.map((p) => {
        const c = p.bout.competitors, mine = c[p.side] ? c[p.side].name : p.pick, other = c[1 - p.side] ? c[1 - p.side].name : "";
        // Pre-fight inputs as far as we have them: only earlier cards replayed
        // into the ratings, no rankings (today's can reflect this result). The
        // stats cache is a snapshot, so say plainly when it postdates the fight.
        const prior = {};
        Object.keys(s.env.RESULTS_ARCHIVE).forEach((d) => { if (d < date) prior[d] = s.env.RESULTS_ARCHIVE[d]; });
        const t = Date.parse(date + "T00:00:00Z"), S = s.env.FIGHTER_STATS;
        const preFight = !!(S[mine] && S[other] && Date.parse(S[mine].fetched_at) < t && Date.parse(S[other].fetched_at) < t);
        const m = FL.matchup(mine, other, { stats: S, rankings: {}, archive: prior, kernel: s.kernel, now: new Date(t) });
        const clv = FL.pickCLV(p, s.odds);
        const cardPrice = typeof c[p.side].odds === "number" ? c[p.side].odds : null;
        return { bout: `${c[0].name} vs ${c[1].name}`, you_picked: mine, winner: p.bout.result.winner, method: p.bout.result.method,
          your_price: clv ? fmtOdds(clv.atPick) : cardPrice !== null ? fmtOdds(cardPrice) : null,
          your_price_basis: clv ? "line at your pick" : cardPrice !== null ? "closing line (no history at your pick)" : null,
          closing_price: clv ? fmtOdds(clv.close) : cardPrice !== null ? fmtOdds(cardPrice) : null,
          line_move_after_pick_pts: clv ? clv.pp : null,
          analysis_basis: preFight ? "pre-fight" : "retrospective — fighter stats were fetched after this fight and include its result",
          opponent_edges: m.rows ? m.rows.filter((r) => r.edge === 2).map((r) => r.label) : [], model_had_your_fighter_pct: m.model ? pct(m.model.p1) : null };
      }), note: lost.length ? null : "No losing picks on that card." };
    },
  },
};

export async function callTool(name, args) {
  const t = TOOLS[name];
  if (!t) throw new Error(`Unknown tool: ${name}`);
  return t.run(args || {});
}
export const meta = () => { const s = load(); return { generated_at: s.generatedAt, events: s.engine.events().length }; };
