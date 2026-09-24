// Guard: the engine migration may move code, never numbers.
//
// Migrating index.html onto the Pick Engine is a refactor of the one file every
// score comes from: the board, the Belt's lineage, the post-card recap and Year
// Wrapped. A refactor that shifts any of them by half a point doesn't throw —
// it quietly rewrites standings people have screenshotted. So this pins every
// one of those outputs, on FROZEN data and SYNTHETIC picks, to a golden file
// taken before the migration started. Every migration stage must reproduce it
// byte for byte; a stage that can't is not a refactor.
//
//   npm run check:parity            compare against tests/fixtures/parity-golden.json
//   node tests/check-parity.mjs --update   rewrite the golden (ONLY for an
//                                   intended scoring change, never to make a
//                                   migration stage pass — say so in the PR)
//
// Frozen data: tests/fixtures/parity-data.json (a slim copy of data.js plus one
// synthetic post-LOCKS_START card, so locks, the dog bonus and FOTN all score).
// Picks are generated from a fixed seed: real picks never go in the repo.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(ROOT, "tests/fixtures/parity-golden.json");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const data = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/parity-data.json"), "utf8"));

function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) { console.error(`  ✗ index.html: no // ${name}:start … :end block`); process.exit(1); }
  return html.slice(a, b);
}
function fn(name) {
  const a = html.indexOf(`function ${name}(`);
  if (a < 0) { console.error(`  ✗ index.html: function ${name} not found`); process.exit(1); }
  let i = html.indexOf("{", a), depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) return html.slice(a, i + 1);
  }
  throw new Error("unbalanced " + name);
}

// The app's scoring, lifted exactly as check:recap / check:wrapped lift it.
const ENGINE_SRC = readFileSync(join(ROOT, "lab/engine.js"), "utf8");
const SCORING_SRC = readFileSync(join(ROOT, "scoring.js"), "utf8");
function kernel(lbScope, withEngine) {
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: console.error },
    String, Object, Array, JSON, Math, Date, isFinite, Number,
    DAY_MS: 86400000, EVENTS: data.EVENTS, RESULTS_ARCHIVE: data.RESULTS_ARCHIVE,
    lbScope, MAIN_CARD_BOUTS: 5, USER_ID: null, userName: "", _lbRows: null, _commRows: null,
  });
  // Stage 3: every scoring function lives in scoring.js, run whole — exactly as
  // the app loads it. The Belt, recap and Wrapped still live in index.html.
  // The engine path vs the fallback path (stage 2): with lab/engine.js loaded,
  // _boutLookup answers through the engine; without it, through its own loops.
  if (withEngine) vm.runInContext(ENGINE_SRC, ctx, { filename: "lab/engine.js" });
  vm.runInContext(SCORING_SRC, ctx, { filename: "scoring.js" });
  vm.runInContext(fn("computeBeltLineage"), ctx);
  vm.runInContext(block("card-recap"), ctx);
  vm.runInContext(block("year-wrapped"), ctx);
  return ctx;
}

// --- deterministic synthetic picks -------------------------------------------
let seed = 20260924;
const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const players = [
  ["u-andy", "🥋 AB"], ["u-tristin", "👑 Tristin"], ["u-derek", "🥊 Dereko"],
  ["u-jp", "🦂 JPe$o"], ["u-t", "🦍 T"], ["u-torrey", "😀 Torrey"],
];
const METHODS = ["KO/TKO", "Sub", "Dec", ""];
const rows = [];
const bouts = [];
data.EVENTS.forEach((e) => e.fights.forEach((f) => bouts.push({ date: e.date, name: e.name, a: f.f1.n, b: f.f2.n })));
Object.entries(data.RESULTS_ARCHIVE).forEach(([date, a]) => {
  if (data.EVENTS.some((e) => e.date === date)) return;
  (a.fights || []).forEach((f) => bouts.push({ date, name: a.name, a: f.f1, b: f.f2 }));
});
let t = Date.parse("2026-05-01T00:00:00Z");
bouts.forEach((bt, bi) => {
  players.forEach(([uid, nick], pi) => {
    if (rnd() < 0.12) return;                               // not everyone picks everything
    const flip = rnd() < 0.2;                               // row stored with corners swapped
    const pick = rnd() < 0.58 ? bt.a : bt.b;
    rows.push({
      user_id: uid, nickname: nick, event_date: bt.date, event_name: bt.name,
      f1: flip ? bt.b : bt.a, f2: flip ? bt.a : bt.b, pick,
      method: METHODS[Math.floor(rnd() * 4)],
      // Stars before LOCKS_START (must not score), locks after (must).
      confidence: rnd() < 0.15 ? (bt.date < "2026-09-26" ? 3 : 1) : 0,
      // FOTN only exists on the synthetic card: half the room calls it right.
      bonus_pick: bt.date === "2026-12-19" && bt.a === "Lock Winner" ? (pi % 2 ? "Lock Winner" : "Big Fav") : null,
      updated_at: new Date(t += 60000).toISOString(),
    });
  });
});
// Ghost identities, as a device reset leaves them: a stale id under the same
// name with fewer picks, and a different-case copy.
rows.push({ ...rows[0], user_id: "u-andy-ghost", nickname: "🥋 AB", updated_at: "2026-05-01T00:00:00.000Z" });
rows.push({ ...rows[1], user_id: "u-jp-2", nickname: "🚀 Jpe$o", updated_at: "2026-05-01T00:00:01.000Z" });
// A same-name pair with EXACTLY equal pick counts: which one the board keeps is
// decided by the tie-break alone, so the fixture pins it.
const twoBouts = bouts.filter((b) => b.date === "2026-12-19").slice(0, 2);
twoBouts.forEach((bt, i) => rows.push({ user_id: i ? "u-tie-b" : "u-tie-a", nickname: "🐺 Tie", event_date: bt.date, event_name: bt.name,
  f1: bt.a, f2: bt.b, pick: bt.a, method: "", confidence: 0, bonus_pick: null, updated_at: `2026-05-02T00:00:0${i}.000Z` }));
// The board reads rows newest-first.
rows.sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));

// --- the outputs --------------------------------------------------------------
const round = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);
function boardView(k, rs, keep) {
  return k._lbScoreUsers(rs, keep).map((u) => ({
    nickname: u.nickname, user_id: u.user_id, pts: round(k.userPts(u)), correct: u.correct, total: u.total,
    methods: u.methods, fotn: u.fotn, dogPts: round(u.dogPts), lockPts: u.lockPts,
    accuracy: u.accuracy, bestStreak: u.bestStreak, currentStreak: u.currentStreak,
  }));
}
function snapshot(withEngine) {
  const all = kernel("all", withEngine), main = kernel("main", withEngine);
  if (withEngine && !all._appEngine()) { console.error("  ✗ the engine path never engaged — _appEngine() is null with lab/engine.js loaded"); process.exit(1); }
  if (!withEngine && all._appEngine()) { console.error("  ✗ the fallback path used an engine it shouldn't have"); process.exit(1); }
  const dates = [...new Set(rows.map((r) => r.event_date))].sort();
  const bases = [...new Set(players.map(([, n]) => all.splitNick(n).name.toLowerCase()))];
  return {
    rows: rows.length,
    board_all: boardView(all, rows),
    board_main_card: boardView(main, rows, main._pickInScope),
    per_card: Object.fromEntries(dates.map((d) => [d, boardView(all, rows.filter((r) => r.event_date === d))])),
    belt: JSON.parse(JSON.stringify(all.computeBeltLineage(rows))),
    recaps: Object.fromEntries(dates.filter((d) => all._eventFinished(d)).map((d) => [d,
      Object.fromEntries(bases.map((b) => [b, JSON.parse(JSON.stringify(all.computeCardRecap(rows, d, b) ?? null))]))])),
    wrapped_2026: Object.fromEntries(bases.map((b) => [b, JSON.parse(JSON.stringify(all.computeYearWrapped(rows, "2026", b) ?? null))])),
  };
}

const now = snapshot(true);          // the engine path — what users run
const fallback = snapshot(false);    // lab/engine.js failed to load
if (process.argv.includes("--update")) {
  writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + "\n");
  console.log(`check-parity: golden rewritten (${now.rows} synthetic picks, ${Object.keys(now.per_card).length} cards). Say why in the PR.`);
  process.exit(0);
}
if (!existsSync(GOLDEN)) { console.error("  ✗ no golden file — run: node tests/check-parity.mjs --update"); process.exit(1); }
const want = JSON.parse(readFileSync(GOLDEN, "utf8"));

// First difference, by path, so a failing stage says exactly which number moved.
function diff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || Array.isArray(a) !== Array.isArray(b))
    return `${path || "(root)"}: golden ${JSON.stringify(a)?.slice(0, 120)} → now ${JSON.stringify(b)?.slice(0, 120)}`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = diff(a[k], b[k], path + (Array.isArray(a) ? `[${k}]` : "." + k));
    if (d) return d;
  }
  return null;
}
let failures = 0;
{
  const d = diff(now, fallback, "engine-vs-fallback");
  if (d) { failures++; console.error("  ✗ the engine and fallback paths disagree: " + d); }
  else console.log("  ✓ the engine path and the fallback path produce identical outputs");
}
// Every pick's bout, both ways: the SAME fight object (not just the same score).
{
  const e = kernel("all", true), f = kernel("all", false);
  let checked = 0, bad = null;
  const probe = rows.concat(rows.slice(0, 50).map((r) => ({ ...r, f1: r.f2, f2: r.f1 })),
    [{ event_date: "2026-12-19", f1: "Nobody", f2: "Lock Winner" }, { event_date: "1999-01-01", f1: "A", f2: "B" },
     // on a date the live window still holds, but only in that date's archive
     { event_date: "2026-12-19", f1: "Gone From Card", f2: "Archive Only" }]);
  for (const r of probe) {
    const x = e._boutLookup(r.event_date, r.f1, r.f2), y = f._boutLookup(r.event_date, r.f1, r.f2);
    checked++;
    const same = (!x && !y) || (x && y && x.live === y.live && x.fight === y.fight && x.k === y.k);
    if (!same && !bad) bad = `${r.event_date} ${r.f1} vs ${r.f2}: engine ${JSON.stringify(x && { live: x.live, k: x.k })} / fallback ${JSON.stringify(y && { live: y.live, k: y.k })}`;
  }
  const arcOnly = e._boutLookup("2026-12-19", "Gone From Card", "Archive Only");
  if (!arcOnly || arcOnly.live !== false || arcOnly.k !== 0) { failures++; console.error("  ✗ a bout missing from its live card isn't found in that date's archive"); }
  else console.log("  ✓ a bout missing from its live card falls back to that date's archive");
  if (bad) { failures++; console.error("  ✗ lookup mismatch — " + bad); }
  else console.log(`  ✓ engine and fallback find the identical bout object for all ${checked} lookups (incl. flipped corners and misses)`);
}
for (const part of Object.keys(want)) {
  const d = diff(want[part], now[part], part);
  if (d) { failures++; console.error("  ✗ " + d); }
  else console.log(`  ✓ ${part} matches the pre-migration golden`);
}
// The fixture has to actually exercise what it claims to, or a match is hollow.
const exercised = {
  "locks score (post-LOCKS_START card)": now.board_all.some((u) => u.lockPts !== 0),
  "legacy stars exist in the fixture": rows.some((r) => r.confidence === 3),
  "the dog bonus scores": now.board_all.some((u) => u.dogPts > 0),
  "FOTN scores": now.board_all.some((u) => u.fotn > 0),
  "no two frozen cards share a date (the board looks cards up by date)": new Set(data.EVENTS.map((e) => e.date)).size === data.EVENTS.length,
  "ghost identities are collapsed": now.board_all.length === players.length + 1,
  "an exact tie between two same-name identities is in the fixture": now.board_all.filter((u) => u.nickname === "🐺 Tie").length === 1,
  "the Belt changes hands": new Set(now.belt.reigns.map((r) => r.base)).size >= 3,
  "card recaps are produced (live-window cards)": Object.values(now.recaps).filter((c) => Object.values(c).some(Boolean)).length >= 3,
  "every player gets a 2026 Wrapped": Object.values(now.wrapped_2026).every(Boolean),
};
for (const [name, ok] of Object.entries(exercised)) {
  if (ok) console.log(`  ✓ fixture exercises: ${name}`);
  else { failures++; console.error(`  ✗ fixture no longer exercises: ${name}`); }
}
if (failures) { console.error(`\ncheck-parity: ${failures} difference(s) from the pre-migration golden — a refactor must not move a number.`); process.exit(1); }
console.log("\ncheck-parity: board, belt, recaps and Wrapped are byte-identical to before the migration.");
