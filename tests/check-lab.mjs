// Guard: the Fight Lab must say what the board says, and must never take the
// app down with it.
//
// The lab (lab.html + lab/engine.js + lab/analytics.js) is a read-only reader
// of the same picks the board scores, so its failure mode is the recap's and
// Wrapped's: drift — a Fight IQ that credits points the board doesn't, a CLV
// with its sign flipped, a "hot streak" that counts the very fight it claims
// to predict. None of that throws. So this runs the engine against the REAL
// scoring lifted out of index.html and checks its answers, then boots the page
// headlessly under its own CSP (no 'unsafe-eval') with picks stubbed.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

// Load the two lab modules into one context, as the page does.
const ctx = vm.createContext({ console, Math, Date, JSON, Object, Array, String, Number, isFinite, parseFloat, Function });
ctx.globalThis = ctx;
vm.runInContext(readFileSync(join(ROOT, "lab/engine.js"), "utf8"), ctx, { filename: "lab/engine.js" });
vm.runInContext(readFileSync(join(ROOT, "lab/analytics.js"), "utf8"), ctx, { filename: "lab/analytics.js" });
const PE = ctx.PickEngine, FL = ctx.FightLab;
check("lab modules define PickEngine and FightLab", PE && FL);

// ---------------------------------------------------------------- fixture --
const C1 = "2026-08-29", C2 = "2026-09-26";   // C2 is on/after LOCKS_START: locks count
const bout = (a, b, winner, odds, extra) => Object.assign({
  lbl: "Main Card", wc: "Lightweight", f1: { n: a, r: "" }, f2: { n: b, r: "" },
  winner: winner || "", state: winner ? "post" : "pre", method: winner ? "KO/TKO" : "", odds: odds || null,
}, extra || {});
const EVENTS = [
  { name: "UFC Fight Night: One", date: C1, time: "22:00", prelimTime: "19:00", slug: "one", fotn: "A1", fights: [
    bout("A1", "B1", "A1", { f1: -200, f2: 170 }, { lbl: "Main Event" }),
    bout("A2", "B2", "B2", { f1: -300, f2: 260 }),                       // +260 dog wins → +1 bonus
    bout("A3", "B3", "A3", { f1: -150, f2: 130 }, { method: "Decision (Unanimous)", lbl: "Prelim", wc: "Women's Strawweight" }),
  ] },
  { name: "UFC 999: Two", date: C2, time: "22:00", prelimTime: "20:00", slug: "two", fights: [
    bout("C1", "D1", "C1", { f1: -120, f2: 100 }, { lbl: "Main Event" }),
    bout("C2", "D2", "D2", { f1: -400, f2: 320 }),
    bout("C3", "D3", "", { f1: -110, f2: -110 }),                         // undecided
  ] },
];
const ARCHIVE = { "2026-06-06": { name: "UFC Old", fights: [{ f1: "Z1", f2: "Y1", winner: "Z1", method: "Submission" }] } };
const env = { EVENTS, RESULTS_ARCHIVE: ARCHIVE, FIGHTER_STATS: {}, RANKINGS: {} };

let K;
const SCORING = readFileSync(join(ROOT, "scoring.js"), "utf8");
try { K = PE.loadKernel(html, env, undefined, SCORING); check("kernel runs scoring.js and lifts the model + intel out of index.html", true); }
catch (e) { fail("kernel failed to load from index.html: " + e.message); process.exit(1); }
check("kernel's LOCKS_START is the fixture's assumption (2026-09-26)", K.LOCKS_START === C2);

const eng = PE.createEngine({ adapters: [PE.ufcAdapter(env)], rules: { ufc: PE.ufcRules(K) } });
check("ufcAdapter keeps live cards and adds archived ones", eng.events("ufc").length === 3);
check("segments come from the bout label", eng.events("ufc")[1].bouts[2].segment === "prelims" && eng.events("ufc")[1].bouts[0].segment === "main");

const pick = (who, date, a, b, p, extra) => Object.assign(
  { user_id: "u-" + who, nickname: "🥊 " + who, event_date: date, f1: a, f2: b, pick: p, method: "", confidence: 0,
    updated_at: date + "T12:00:00Z" }, extra || {});
const rows = [
  pick("Andy", C1, "A1", "B1", "A1", { method: "KO/TKO", bonus_pick: "A1" }),
  pick("Andy", C1, "A2", "B2", "B2"),
  pick("Andy", C1, "B3", "A3", "A3", { method: "KO/TKO" }),                  // corners flipped in the row
  pick("Andy", C2, "C1", "D1", "C1", { confidence: 1 }),                     // lock hits: +1
  pick("Andy", C2, "C2", "D2", "C2", { confidence: 1 }),                     // lock misses: −1
  pick("Andy", C2, "C3", "D3", "C3", { confidence: 1 }),                     // undecided
  pick("Andy", "2026-06-06", "Z1", "Y1", "Z1", { method: "Sub" }),
  pick("Tristin", C1, "A1", "B1", "B1"),
  pick("Tristin", C1, "A2", "B2", "A2", { confidence: 3 }),                  // pre-LOCKS_START star: must not score
  pick("Tristin", C2, "C1", "D1", "D1"),
  pick("Tristin", C2, "C2", "D2", "D2", { method: "Dec" }),
];
const res = eng.resolvePicks(rows);
check("every fixture pick resolves to a bout (incl. flipped corners and the archive)", res.every((p) => p.bout));

// 1. Parity with the board: the engine's per-pick points plus FOTN equal the
//    board's own userPts for every player.
const board = K._lbScoreUsers(rows);
board.forEach((u) => {
  const sum = res.filter((p) => p.player === u.user_id).reduce((s, p) => s + p.points, 0) + (u.fotn || 0);
  check(`${u.nickname}: engine points ${sum} == board userPts ${K.userPts(u)}`, Math.abs(sum - K.userPts(u)) < 1e-9);
});
const andyLocks = res.filter((p) => p.player === "u-Andy" && p.locked);
check("a lock on/after LOCKS_START is a lock; a pre-LOCKS_START star is not",
  andyLocks.length === 3 && !res.find((p) => p.player === "u-Tristin" && p.raw.confidence === 3).locked);

// 1b. Ghost identities: a device reset leaves a second user_id under the same
//     nickname (or a different case of it). The board shows one row per person;
//     so must every reader.
const ghosts = rows.concat([
  pick("Andy", C1, "A1", "B1", "B1", { user_id: "u-Andy-old" }),                    // same name, stale id, fewer picks
  Object.assign(pick("tristin", C1, "A3", "B3", "B3"), { user_id: "u-tristin-2", nickname: "👑 tristin" }), // case + emoji differ
]);
const kept = PE.boardRows(K, ghosts);
const ids = [...new Set(kept.map((r) => r.user_id))].sort();
check("boardRows keeps exactly the identities the board keeps (one per person)",
  JSON.stringify(ids) === JSON.stringify(K._lbScoreUsers(ghosts).map((u) => u.user_id).sort()) && ids.length === 2);
check("boardRows drops the ghost's rows rather than merging them", !kept.some((r) => r.user_id === "u-Andy-old" || r.user_id === "u-tristin-2"));

// 1c. Two cards on one date carrying the same pairing (a rebooked bout): the app
//     has always taken the FIRST card in EVENTS order; so must the engine.
{
  const dup = { EVENTS: [
    { name: "First", date: "2026-11-01", fights: [bout("X1", "Y1", "X1")] },
    { name: "Second", date: "2026-11-01", fights: [bout("X1", "Y1", "Y1")] },
  ], RESULTS_ARCHIVE: {} };
  const de = PE.createEngine({ adapters: [PE.ufcAdapter(dup)], rules: { ufc: PE.ufcRules(K) } });
  const hit = de.findBout("2026-11-01", "Y1", "X1");
  check("a pairing on two same-date cards resolves to the first card, as the app's loops do", hit && hit.event.name === "First");
}

// 2. Feed adapter: untrusted input, validated whole.
const feed = PE.feedAdapter({
  promotions: [{ id: "pfl", name: "PFL" }, { id: "ufc", name: "Fake UFC" }],
  events: [
    { promotion: "pfl", name: "PFL 1", date: "2026-10-10", bouts: [{ a: "P1", b: "Q1", winner: "P1", method: "KO/TKO", odds: { a: -150, b: 130 } }] },
    { promotion: "ufc", name: "UFC shadow", date: "2026-10-10", bouts: [{ a: "A", b: "B" }] },
    { promotion: "pfl", name: "Bad date", date: "10/10/2026", bouts: [{ a: "A", b: "B" }] },
    { promotion: "pfl", name: "Bad winner", date: "2026-10-11", bouts: [{ a: "A", b: "B", winner: "C" }] },
    { promotion: "pfl", name: "Twice", date: "2026-10-12", bouts: [{ a: "A", b: "a" }] },
  ],
});
check("feed: 'ufc' namespace is refused", feed.problems.some((p) => /reserved/.test(p)) && feed.problems.some((p) => /unknown promotion "ufc"/.test(p)));
check("feed: bad date, stray winner and one-fighter-twice are all dropped", feed.events().length === 1 && feed.problems.length === 5);
const both = PE.createEngine({ adapters: [PE.ufcAdapter(env), feed], rules: { ufc: PE.ufcRules(K) } });
check("feed events are namespaced and findable per promotion", both.findBout("2026-10-10", "Q1", "P1", "pfl") && !both.findBout("2026-10-10", "Q1", "P1", "ufc"));
const pflPick = both.resolvePicks([{ user_id: "x", event_date: "2026-10-10", f1: "P1", f2: "Q1", pick: "P1", method: "KO/TKO" }], "pfl")[0];
check("feed picks score on the simple rules (1 + 0.5 method)", pflPick.points === 1.5);
// The committed feed is LIVE data (extra.py publishes to it every few hours),
// so this is advisory, like check:intel's data.js cross-check: a failure here
// runs in the deploy gate and would block every publish, live UFC results
// included, over a data gap the app already handles (validateFeed drops a bad
// card at render). It reports; the fixture assertions above hold the contract.
try {
  const repo = JSON.parse(readFileSync(join(ROOT, "events-extra.json"), "utf8"));
  const probs = PE.validateFeed(repo).problems;
  if (probs.length) console.log("  ⚠ advisory: committed events-extra.json has cards the app will drop: " + probs.join("; "));
  else console.log("  ✓ (advisory) committed events-extra.json validates cleanly");
} catch (e) { console.log("  ⚠ advisory: committed events-extra.json unreadable: " + e.message); }

// 3. Odds history: orientation, surname-only names, CLV sign.
const series = { events: [{ event_id: "2026-09-27:two", concluded: true, bouts: [{
  f1: "D1", f2: "C1",   // reversed corners on purpose
  series: [{ at: "2026-09-20T00:00:00Z", f1_odds: 110, f2_odds: -130 }, { at: "2026-09-26T00:00:00Z", f1_odds: 150, f2_odds: -180 }],
  open: { at: "2026-09-20T00:00:00Z", f1_odds: 110, f2_odds: -130 }, close: { at: "2026-09-26T00:00:00Z", f1_odds: 150, f2_odds: -180 },
}, { f1: "Surname", f2: "Other", series: [{ at: "2026-09-20T00:00:00Z", f1_odds: -200, f2_odds: 170 }],
     open: { at: "2026-09-20T00:00:00Z", f1_odds: -200, f2_odds: 170 }, close: null }] }] };
const idx = FL.oddsIndex(series);
const hist = idx.lookup(C2, "C1", "D1");
check("odds lookup re-orients a reversed bout and tolerates a UTC-shifted event id", hist && hist.open.a === -130 && hist.close.a === -180);
check("odds lookup matches a surname-only series entry", !!idx.lookup(C2, "Jon Surname", "Ann Other"));
const c1 = res.find((p) => p.player === "u-Andy" && p.date === C2 && p.pick === "C1");
c1.updatedAt = "2026-09-21T00:00:00Z";
const clv = FL.pickCLV(c1, idx);
check("CLV is positive when the price moved toward the pick after it was made", clv && clv.atPick === -130 && clv.close === -180 && clv.pp > 0);
// A row stamped at or after the close (rewritten after the fight by a rename
// or a restore) can't say when the pick was made: no CLV, never a flat 0.
check("no CLV for a pick stamped at or after the closing line", FL.pickCLV(Object.assign({}, c1, { updatedAt: "2026-09-27T00:00:00Z" }), idx) === null &&
  FL.pickCLV(Object.assign({}, c1, { updatedAt: null }), idx) === null);

// 4. Fight IQ: no claims under the sample floor, no leaking the result.
const iq = FL.fightIQ(res.filter((p) => p.player === "u-Andy"), { odds: idx, stats: {}, group: res });
check("Fight IQ calls a thin history Casual", iq.archetype.key === "casual");
const andyBoard = board.find((u) => u.user_id === "u-Andy");
check("Fight IQ points include the FOTN bonus and equal the board total", andyBoard.fotn === 1 && iq.points === K.userPts(andyBoard));
// Two locks on one card: the main event (order 0) lands after the prelim-side
// bout (order 1), so a hit main event ends a skid a missed undercard lock started.
const skid = FL.fightIQ([
  { player: "p", date: C2, decided: true, correct: true, locked: true, side: 0, points: 2, bout: { order: 0, id: "m", competitors: [{ name: "C1" }, { name: "D1" }], result: { winner: "C1" } } },
  { player: "p", date: C2, decided: true, correct: false, locked: true, side: 0, points: -1, bout: { order: 1, id: "u", competitors: [{ name: "C2" }, { name: "D2" }], result: { winner: "D2" } } },
  { player: "p", date: C1, decided: true, correct: false, locked: true, side: 0, points: -1, bout: { order: 0, id: "o", competitors: [{ name: "A1" }, { name: "B1" }], result: { winner: "B1" } } },
], {});
check("lock skid orders same-card locks by when the result landed", skid.lockSkid === 0);
// Fight IQ card: deterministic, honest ratings, nothing under the floor.
{
  const thin = FL.fightCard(res.filter((p) => p.player === "u-Andy"), iq, { odds: idx, group: res });
  check("a thin history's card rates nothing it can't back (every trait is — below MIN_SAMPLE)", thin.traits.length === 6 && thin.traits.every((t) => t.rating === null) && thin.tier === "Rookie");
  // 10 underdog picks at +300 (market expects 2.5 wins); 5 hit -> Upset Sense 50 * 5 / 2.5 = 99 (cap).
  const mk = (i, win, odds, extra) => Object.assign({ player: "q", nickname: "🐶 Q", date: "2026-0" + (1 + (i % 5)) + "-10", decided: true, side: 0, correct: win,
    method: "", locked: false, points: win ? 1 : 0, event: { name: "E" + i },
    bout: { id: "b" + i, order: 0, division: "Lightweight", segment: "main", result: { winner: win ? "A" + i : "B" + i, method: "KO/TKO" },
            competitors: [{ name: "A" + i, odds }, { name: "B" + i, odds: -odds }] } }, extra || {});
  const dogPicks = Array.from({ length: 10 }, (_, i) => mk(i, i < 5, 300));
  const favPicks = Array.from({ length: 10 }, (_, i) => mk(10 + i, i < 5, -300));   // expected 7.5 wins, got 5 -> 33
  const all = dogPicks.concat(favPicks);
  const qiq = FL.fightIQ(all, { stats: {}, group: all });
  const qc = FL.fightCard(all, qiq, { group: all, belt: { holderBase: "q", reigns: [{ base: "q", defenses: 2 }, { base: "z", defenses: 0 }, { base: "q", defenses: 0 }] }, baseName: "q" });
  const tr = Object.fromEntries(qc.traits.map((t) => [t.key, t]));
  check("Upset Sense compares wins to what the odds expected (50 = the market)", tr.upset.rating === 99 && tr.upset.detail === "5W–5L on underdogs");
  check("Chalk Handling falls below 50 when favorites win less than priced", tr.chalk.rating === 33);
  check("the best call is the longest-priced winner, the worst miss the shortest-priced loss", qc.bestCall.odds === 300 && qc.worstMiss.odds === -300);
  check("belt history counts only this player's reigns", qc.belt.reigns === 2 && qc.belt.defenses === 2 && qc.belt.longest === 3 && qc.belt.holding === true);
  check("recent form is the last five cards, W at half or better", qc.form.length === 5 && qc.form.every((f) => "WL".includes(f.r)));
  // A standard -110/-110 market: ten picks, five wins, is exactly average (50), not 48.
  const even = Array.from({ length: 10 }, (_, i) => mk(40 + i, i < 5, -110, { bout: { id: "e" + i, order: 0, division: "Lightweight", segment: "main",
    result: { winner: i < 5 ? "A" + i : "B" + i, method: "Dec" }, competitors: [{ name: "A" + i, odds: -110 }, { name: "B" + i, odds: -110 }] } }));
  const ec = FL.fightCard(even, FL.fightIQ(even, { stats: {}, group: even }), { group: even });
  check("ratings take the bookmaker's margin out: a coin-flip market at .500 rates exactly 50", ec.traits.find((t) => t.key === "chalk").rating === 50);
  // Only favorites ever won, and only underdogs ever lost: both cells still fill.
  const favOnly = [mk(60, true, -200), mk(61, false, 150)];
  const fo = FL.fightCard(favOnly, FL.fightIQ(favOnly, { stats: {}, group: favOnly }), { group: favOnly });
  check("best call and worst miss come from every priced win and loss", fo.bestCall && fo.bestCall.odds === -200 && fo.worstMiss && fo.worstMiss.odds === 150);
  check("every archetype has a quip for the card", Object.keys(FL.ARCHETYPES).every((k) => FL.CARD_QUIPS[k]));
  const sniper = FL.archetype({ n: 40, pct: 55 }, { dog: 0, fav: 0.5, contrarian: 0, finish: 0.5, grappler: 0 }, { n: 0 }, 20, 45);
  check("Method Sniper: 15+ methods called at 40%+", sniper.key === "method");
}
check("Fight IQ makes no split insight under MIN_SAMPLE", iq.insights.every((i) => i.kind === "clv" || i.kind === "locks" || i.kind === "rival"));
const st = { form: [{ r: "W" }, { r: "W" }, { r: "W" }, { r: "L" }], opp: ["ThisOpp", "O2", "O3", "O4"] };
check("win streak going in excludes the bout's own result", FL.streakBefore(st, "ThisOpp") === false);
check("win streak is read from the fights before the bout", FL.streakBefore({ form: [{ r: "L" }, { r: "W" }, { r: "W" }, { r: "W" }], opp: ["ThisOpp", "a", "b", "c"] }, "ThisOpp") === true);
check("a bout that isn't in the form list is not guessed at", FL.streakBefore(st, "Stranger") === null);

// 5. Backtest refuses bouts whose stats were fetched after the fight.
const S = { Z1: { rec: "10-0-0", slpm: 4, td: 1, form: [], fetched_at: "2026-09-01T00:00:00Z" },
            Y1: { rec: "5-5-0", slpm: 3, td: 1, form: [], fetched_at: "2026-09-01T00:00:00Z" } };
const bt = FL.backtest({ stats: S, rankings: {}, archive: ARCHIVE, kernel: K });
check("backtest excludes a bout scored with post-fight stats", bt.n === 0 && bt.excluded === 1);
S.Z1.fetched_at = S.Y1.fetched_at = "2026-06-01T00:00:00Z";
check("backtest scores a bout with pre-fight stats", FL.backtest({ stats: S, rankings: {}, archive: ARCHIVE, kernel: K }).n === 1);
const noRk = FL.backtest({ stats: S, rankings: {}, archive: ARCHIVE, kernel: K });
const withRk = FL.backtest({ stats: S, rankings: { Y1: 1 }, archive: ARCHIVE, kernel: K });
check("backtest ignores today's rankings (they can reflect the result)", noRk.brier === withRk.brier);

// 6. Watch Party ticker replays the card in result order.
const card2 = eng.events("ufc").find((e) => e.date === C2);
const feedTxt = FL.activityTicker(card2, res).map((x) => x.text);
check("ticker reports a lock hit and a lock miss", feedTxt.some((t) => /Andy's lock hit/.test(t)) && feedTxt.some((t) => /Andy's lock missed/.test(t)));
check("ticker names the lone caller of an upset", feedTxt.some((t) => /Tristin called the \+320 upset/.test(t)));
check("ticker announces a leader", feedTxt.some((t) => /lead/.test(t)));
check("ticker lists the latest bout first, its result line leading", /^C1 def\. D1/.test(feedTxt[0]));

// 7. Market math is de-vigged: an even line reads 50/50, not 47.6/47.6.
const dv = PE.deVig(-110, -110);
check("de-vig of -110/-110 is exactly 50/50", Math.abs(dv.a - 0.5) < 1e-12 && Math.abs(dv.b - 0.5) < 1e-12);

// 7b. Stage 3: one scoring rulebook. Every scoring function is defined once, in
//     scoring.js — never again inline in index.html, where a second copy could
//     drift — and the kernel runs that file rather than slicing it from HTML.
{
  const idx = readFileSync(join(ROOT, "index.html"), "utf8");
  const dupes = ["nmKey", "nmEq", "nmBout", "splitNick", "dogPtsFor", "dogPtsForPick", "userPts", "locksOn", "isLockPick",
    "lockPtsFor", "pickPts", "scoreMethod", "_boutLookup", "_findFightResult", "_isMainCardPick", "_eventFinished",
    "_lbScoreUsers", "boardStandings", "standingsKeep", "computeBeltLineage", "sportBout", "sportStandings", "isMainCardBout", "isEarlyPrelimBout"].filter((f) => idx.includes(`function ${f}(`) || (SCORING.split(`function ${f}(`).length - 1) !== 1);
  check("each scoring function is defined exactly once, in scoring.js", dupes.length === 0 || (console.error("    " + dupes.join(", ")), false));
  // A local of the same name in index.html shadows the global inside that
  // function — stage 4 first called its scoped board "standings", which
  // computeCardRecap's own `var standings` hid, breaking every recap.
  const globals = [...SCORING.matchAll(/^function ([\w$]+)\(/gm)].map((m) => m[1]);
  const code = idx.replace(/^\s*\/\/.*$/gm, "");
  const params = new Set([...code.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())));
  const shadowed = globals.filter((g) => params.has(g) || new RegExp(`(?:\\bvar|\\blet|\\bconst)\\s+${g.replace(/\$/g, "\\$")}\\b`).test(code));
  check("no index.html local shadows a scoring.js function", shadowed.length === 0 || (console.error("    " + shadowed.join(", ")), false));
  check("index.html loads scoring.js after data.js and before its own script",
    /<script src="data\.js"><\/script>[\s\S]*?<script src="scoring\.js\?v=[^"]+"><\/script>/.test(idx) && idx.indexOf('src="scoring.js') < idx.indexOf("var SUPABASE_URL="));
  // One version, three places: scoring.js's own, the page's request + expectation, the SW precache.
  const vFile = (/var SCORING_VERSION="([^"]+)"/.exec(SCORING) || [])[1];
  const vSrc = (/<script src="scoring\.js\?v=([^"]+)">/.exec(idx) || [])[1];
  const vExpect = (/var SCORING_EXPECT="([^"]+)"/.exec(idx) || [])[1];
  const vSw = (/'\.\/scoring\.js\?v=([^']+)'/.exec(readFileSync(join(ROOT, "sw.js"), "utf8")) || [])[1];
  check(`scoring.js version agrees in all four places (${vFile})`, !!vFile && vFile === vSrc && vFile === vExpect && vFile === vSw ||
    (console.error(`    file=${vFile} src=${vSrc} expect=${vExpect} sw=${vSw}`), false));
  check("the kernel runs scoring.js rather than slicing scoring from index.html",
    !PE.KERNEL_BLOCKS.includes("pick-match") && !PE.KERNEL_BLOCKS.includes("fighter-names") && !PE.KERNEL_FNS.includes("_lbScoreUsers"));
}

// 8. Wiring: the app links to the lab, and the SW never serves one page as the other.
check("index.html links to lab.html from the More menu", /id="labBtn"[^>]*href="lab\.html"|href="lab\.html"[^>]*id="labBtn"/.test(html));
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
check("sw.js caches lab.html under its own key (never over the app shell './')", /lab\.html/.test(sw) && /'\.\/lab\.html'/.test(sw));
check("sw.js keeps the lab's data network-first", /odds-series\.json/.test(sw) && /\/lab\//.test(sw));
check("sw.js precaches scoring.js and serves it network-first (it must match the page)",
  /'\.\/scoring\.js\?v=[^']+'/.test(sw.slice(sw.indexOf("var core"), sw.indexOf("var core") + 200)) && /isScoring/.test(sw) && /\|\| isScoring \|\|/.test(sw)
  && /isScoring \? req\.url/.test(sw));

// ---------------------------------------------------------------- browser --
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch { chromium = null; } }
if (!chromium) { fail("Playwright not installed — run npm install"); }
else {
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png" };
  const server = http.createServer((req, res2) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res2.writeHead(404); res2.end(); return; }
    res2.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res2.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
  const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
  try {
    // Real data.js; picks stubbed with rows on real bouts from it.
    const dctx = vm.createContext({}); vm.runInContext(readFileSync(join(ROOT, "data.js"), "utf8"), dctx);
    const stub = [];
    dctx.EVENTS.filter((e) => e.fights.some((f) => f.winner)).forEach((e) => e.fights.forEach((f, i) => {
      ["Andy", "Tristin", "Torrey"].forEach((who, j) => stub.push({ user_id: "u-" + who, nickname: "🥊 " + who, event_date: e.date,
        f1: f.f1.n, f2: f.f2.n, pick: (i + j) % 3 ? f.f1.n : f.f2.n, method: ["KO/TKO", "Sub", "Dec"][(i + j) % 3], confidence: 0,
        updated_at: e.date + "T10:00:00Z", event_name: e.name, bonus_pick: null }));
    }));
    // Ghosts, as seen in production: a second "T" and a different-case "Jpe$o".
    const firstBout = stub[0];
    stub.push(Object.assign({}, firstBout, { user_id: "u-Andy-ghost", nickname: "🦍 Andy" }));
    stub.push(Object.assign({}, firstBout, { user_id: "u-torrey-ghost", nickname: "🚀 torrey" }));
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("Uncaught: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("Console: " + m.text()); });
    await page.route(/supabase\.co/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stub) }));
    // The ✍️ scouting report: stub the model's answer, record what was asked.
    const iqCalls = [];
    await page.route(/functions\/v1\/ai-breakdown/, (route) => {
      iqCalls.push(JSON.parse(route.request().postData() || "{}"));
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ breakdown: "You pick like a nature documentary.", tone: "a dry narrator" }) });
    });
    await page.addInitScript(() => { try { localStorage.setItem("ufc_uid", "u-Andy"); localStorage.setItem("ufc_name", "🥊 Andy"); } catch (e) {} });
    await page.goto(base + "/lab.html#iq", { waitUntil: "load", timeout: 20000 });
    await page.waitForFunction(() => !/Loading the lab/.test(document.getElementById("main").textContent), null, { timeout: 15000 });
    const tabs = ["iq", "market", "week", "matchup", "party", "hub"];
    for (const t of tabs) {
      await page.click(`#tabs button[data-tab="${t}"]`);
      await page.waitForTimeout(150);
      const txt = await page.evaluate(() => document.getElementById("main").innerText);
      check(`lab tab "${t}" renders without an error panel`, txt.length > 40 && !/hit an error|couldn't start|could not load/.test(txt));
    }
    // Matchup is picked from a menu of real, upcoming bouts, never typed:
    // every pair offered has two stats profiles, and a choice re-compares.
    await page.click('#tabs button[data-tab="matchup"]');
    const mu = await page.evaluate(() => {
      const menu = document.querySelector("#main select.mu-bout");
      const opts = menu ? [...menu.querySelectorAll("option")].map((o) => o.value) : [];
      const pairs = opts.map((v) => v.split("\n"));
      const cards = menu ? menu.querySelectorAll("optgroup").length : 0;
      const withBouts = L.engine.upcoming(new Date(), "ufc").filter((ev) => ev.bouts.some((b) => b.competitors && FIGHTER_STATS[b.competitors[0].name] && FIGHTER_STATS[b.competitors[1].name])).length;
      const next = opts.find((v) => v !== menu.value);
      if (next) { menu.value = next; menu.dispatchEvent(new Event("change")); }
      const head = [...document.querySelectorAll("#main table.cmp th")].map((t) => t.textContent);
      return { text: document.querySelectorAll("#main input[type=text]").length, selects: document.querySelectorAll("#main select").length,
        n: opts.length, allProfiled: pairs.every((p) => p.length === 2 && FIGHTER_STATS[p[0]] && FIGHTER_STATS[p[1]]),
        cards, withBouts, updated: !!next && next.split("\n").every((n) => head.includes(n)) };
    });
    check("Matchup is one menu of upcoming bouts (no free text, no any-two-fighters menus), each pair profiled, re-comparing on change",
      mu.text === 0 && mu.selects === 1 && mu.n > 0 && mu.allProfiled && mu.updated);
    check("...and it offers every upcoming card with a comparable bout (" + mu.withBouts + ")", mu.cards === mu.withBouts);
    await page.click('#tabs button[data-tab="iq"]');
    const iqTxt = await page.evaluate(() => document.getElementById("main").innerText);
    check("Fight IQ opens on the viewer's own picks and shows an archetype", /\(you\)/.test(await page.evaluate(() => document.querySelector("select").selectedOptions[0].textContent)) && /Record/.test(iqTxt));
    const fcard = await page.evaluate(() => { const c = document.querySelector("#main .fcard"); return c ? { cls: c.className, traits: c.querySelectorAll(".fc-trait").length, text: c.textContent } : null; });
    check("Fight IQ opens on the viewer's collectible card, themed by archetype, six traits",
      !!fcard && /\bfc-[a-z]+\b/.test(fcard.cls) && fcard.traits === 6 && /Fight IQ/.test(fcard.text));
    const opts = await page.evaluate(() => [...document.querySelectorAll("select option")].map((o) => o.textContent.replace(/\s*\(you\)$/, "")));
    const bases = opts.map((o) => o.replace(/^\S+\s+/, "").toLowerCase());
    check("the player picker lists each person once (no ghost identities)", opts.length === 3 && new Set(bases).size === bases.length);
    await page.click('#tabs button[data-tab="iq"]');
    const recTile = await page.evaluate(() => document.querySelector(".tile .v").textContent.replace(/^(\d+)W(\d+)L$/, "$1-$2"));
    for (let i = 0; i < 4; i++) {
      await page.click("text=✍️");
      await page.waitForFunction(() => !/Writing…/.test(document.body.innerText), null, { timeout: 5000 });
    }
    const iqTxt2 = await page.evaluate(() => document.getElementById("main").innerText);
    check("the scouting report shows the write-up and its voice", /nature documentary/.test(iqTxt2) || /scouts are off until tomorrow/.test(iqTxt2));
    check("the request is the fight-iq action carrying the Lab's own computed numbers",
      iqCalls.length > 0 && iqCalls[0].action === "fight-iq" && iqCalls[0].iq.record === recTile && Array.isArray(iqCalls[0].iq.insights) && iqCalls[0].viewerId === "u-Andy");
    check("the device cap stops the 4th write-up before any network call", iqCalls.length === 3 && /scouts are off until tomorrow/.test(iqTxt2));
    check("lab page boots under its CSP with no uncaught or console errors", errs.length === 0 || (console.error(errs.join("\n")), false));
    await page.close();

    // The app still boots and exposes the entry point.
    const app = await browser.newPage();
    const appErrs = [];
    app.on("pageerror", (e) => appErrs.push(e.message));
    await app.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await app.waitForTimeout(500);
    check("the app's More menu carries the Fight Lab link", await app.evaluate(() => { const a = document.getElementById("labBtn"); return !!a && a.getAttribute("href") === "lab.html"; }));
    check("the app answers bout lookups through the Pick Engine (migration stage 2)",
      await app.evaluate(() => typeof PickEngine !== "undefined" && typeof _appEngine === "function" && _appEngine() !== null));
    check("the app boots with the link added (no uncaught errors)", appErrs.length === 0 || (console.error(appErrs.join("\n")), false));
    await app.close();

    // The Lab wears the app's theme: same resolved colours, every theme.
    {
      const VARS = ["--bg", "--card", "--card2", "--text", "--muted", "--red", "--green", "--border"];
      const read = (pg) => pg.evaluate((vars) => {
        const cs = getComputedStyle(document.body);
        return { theme: document.body.getAttribute("data-theme"), bg: cs.backgroundColor,
          vars: Object.fromEntries(vars.map((v) => [v, cs.getPropertyValue(v).trim()])) };
      }, VARS);
      const mism = [];
      for (const t of ["octagon", "neon", "fire", "usa", "seasonal", "silver", "noche"]) {
        const ctxT = await browser.newContext();
        await ctxT.addInitScript((th) => { try { localStorage.setItem("ufc_theme", th); } catch (e) {} }, t);
        await ctxT.route(/supabase\.co/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
        const ap = await ctxT.newPage(); await ap.goto(base + "/index.html", { waitUntil: "load" }); await ap.waitForTimeout(300);
        const lp = await ctxT.newPage(); await lp.goto(base + "/lab.html", { waitUntil: "load" });
        await lp.waitForFunction(() => !/Loading the lab/.test(document.getElementById("main").textContent), null, { timeout: 15000 });
        const A = await read(ap), B = await read(lp);
        const metaA = await ap.evaluate(() => document.querySelector('meta[name="theme-color"]').getAttribute("content"));
        const metaB = await lp.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
        if (metaB.length !== 1 || metaB[0].toLowerCase() !== metaA.toLowerCase()) mism.push(`${t}: status bar app=${metaA} lab=${metaB.join("|")}`);
        const bad = VARS.filter((v) => A.vars[v] !== B.vars[v]);
        if (A.theme !== t || B.theme !== t || bad.length || A.bg !== B.bg) mism.push(`${t}: ${bad.map((v) => `${v} app=${A.vars[v]} lab=${B.vars[v]}`).join(", ") || "bg " + A.bg + " vs " + B.bg}`);
        // Second visit, index.html unreachable: the cached theme still paints.
        const lp2 = await ctxT.newPage();
        await lp2.route(/index\.html/, (r) => r.fulfill({ status: 503, body: "" }));
        await lp2.goto(base + "/lab.html", { waitUntil: "domcontentloaded" });
        const C = await read(lp2);
        if (C.vars["--bg"] !== A.vars["--bg"]) mism.push(`${t} (cached, pre-paint): --bg app=${A.vars["--bg"]} lab=${C.vars["--bg"]}`);
        await ctxT.close();
      }
      check("the Fight Lab wears the app's theme — identical colours for all 7 themes", mism.length === 0 || (console.error("    " + mism.join("\n    ")), false));
      check("…and paints it before index.html arrives, from the cached theme", !mism.some((m) => /cached/.test(m)));
      check("…with the app's status-bar colour, via a replaced meta node", !mism.some((m) => /status bar/.test(m)));
      // First visit, nothing cached: hidden until themed (no Octagon flash)…
      {
        const c1 = await browser.newContext();
        await c1.addInitScript(() => { try { localStorage.setItem("ufc_theme", "neon"); } catch (e) {} });
        await c1.route(/supabase\.co/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
        let release; const gate = new Promise((r) => (release = r));
        await c1.route(/index\.html/, async (r) => { await gate; r.continue(); });   // hold the theme source
        const p1 = await c1.newPage();
        await p1.goto(base + "/lab.html", { waitUntil: "domcontentloaded" });
        const hiddenEarly = await p1.evaluate(() => document.documentElement.style.visibility === "hidden");
        release();
        await p1.waitForFunction(() => document.documentElement.style.visibility === "" && getComputedStyle(document.body).getPropertyValue("--bg").trim() !== "#07070a", null, { timeout: 5000 });
        check("a first, uncached visit is hidden until the theme lands — no Octagon flash", hiddenEarly);
        await c1.close();
        // …and never left blank when index.html can't be fetched.
        const c2 = await browser.newContext();
        await c2.addInitScript(() => { try { localStorage.setItem("ufc_theme", "fire"); } catch (e) {} });
        await c2.route(/index\.html/, (r) => r.fulfill({ status: 503, body: "" }));
        const p2 = await c2.newPage();
        await p2.goto(base + "/lab.html", { waitUntil: "domcontentloaded" });
        await p2.waitForTimeout(1700);
        check("…and shown anyway within the wait if the theme can't be fetched", await p2.evaluate(() => document.documentElement.style.visibility !== "hidden"));
        await c2.close();
      }
      // Seasonal: the month's own bar colour, every month, as the app's SEASONS has it.
      {
        const lab = readFileSync(join(ROOT, "lab.html"), "utf8");
        const a = lab.indexOf("// lab-theme:start"), b = lab.indexOf("// lab-theme:end");
        const f = new Function(lab.slice(a, b) + ";return appThemeColor;")();
        const ap = await browser.newPage(); await ap.goto(base + "/index.html", { waitUntil: "load" });
        const bars = await ap.evaluate(() => SEASONS.map((x) => x.bar)); await ap.close();
        const labBars = bars.map((_, i) => f(html, "seasonal", i));
        check("the seasonal status bar is the month's own colour for all 12 months", JSON.stringify(bars) === JSON.stringify(labBars));
      }
    }

    // scoring.js is required: if it can't load, the app runs the same one-shot
    // purge-and-reload self-heal a missing data.js does, rather than a dead page.
    {
      const sc = await browser.newPage();
      // Count main-frame navigations from the very first one: the self-heal can
      // reload before the first load event even fires (a fast cache purge), so
      // waiting for "another" load after goto() races it. Poll until a second
      // navigation has happened, with a generous ceiling for slow CI runners.
      let navs = 0;
      sc.on("framenavigated", (fr) => { if (fr === sc.mainFrame()) navs++; });
      await sc.route(/scoring\.js/, (r) => r.fulfill({ status: 404, body: "" }));
      await sc.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 }).catch(() => {});
      for (let t = 0; t < 150 && navs < 2; t++) await sc.waitForTimeout(100);
      await sc.waitForLoadState("load").catch(() => {});
      const reloaded = navs >= 2;
      const healed = await sc.evaluate(() => { try { return sessionStorage.getItem("_selfHealed"); } catch (e) { return null; } }).catch(() => null);
      check("with scoring.js unreachable the app self-heals (purge + one reload), like a missing data.js", healed === "1" && reloaded);
      await sc.close();
    }

    // A stale rulebook — scoring.js from a previous release — is refused, not run:
    // the page self-heals exactly as if the file were missing.
    {
      const st = await browser.newPage();
      let navs = 0;
      st.on("framenavigated", (fr) => { if (fr === st.mainFrame()) navs++; });
      const stale = readFileSync(join(ROOT, "scoring.js"), "utf8").replace(/var SCORING_VERSION="[^"]+"/, 'var SCORING_VERSION="1999-01-01-0"');
      await st.route(/scoring\.js/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: stale }));
      await st.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 }).catch(() => {});
      for (let t = 0; t < 150 && navs < 2; t++) await st.waitForTimeout(100);
      await st.waitForLoadState("load").catch(() => {});
      const healed = await st.evaluate(() => { try { return sessionStorage.getItem("_selfHealed"); } catch (e) { return null; } }).catch(() => null);
      check("a stale scoring.js (previous release) is refused and self-heals instead of scoring", navs >= 2 && healed === "1");
      await st.close();
    }

    // If lab/engine.js can't load (404, a first launch offline), the app must
    // still boot and score through its own loops.
    const bare = await browser.newPage();
    const bareErrs = [];
    bare.on("pageerror", (e) => bareErrs.push(e.message));
    await bare.route(/lab\/engine\.js/, (r) => r.fulfill({ status: 404, body: "" }));
    await bare.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await bare.waitForTimeout(500);
    const bareState = await bare.evaluate(() => ({
      noEngine: typeof PickEngine === "undefined" && _appEngine() === null,
      lookupWorks: (() => { const e = EVENTS.find((x) => x.fights.length); const f = e.fights[0];
        const h = _boutLookup(e.date, f.f2.n, f.f1.n); return !!h && h.live && h.fight === f; })(),
    }));
    check("with lab/engine.js unreachable the app falls back to its own lookups", bareState.noEngine && bareState.lookupWorks);
    check("…and boots without an uncaught error", bareErrs.length === 0 || (console.error(bareErrs.join("\n")), false));
    await bare.close();
  } finally { await browser.close(); server.close(); }
}

if (failures) { console.error(`\ncheck-lab: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-lab: Fight Lab reads the board's numbers and boots cleanly.");
