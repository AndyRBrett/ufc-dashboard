// Guard: a lock 🔒 must score the same everywhere a pick is scored.
//
// A lock is +LOCK_HIT on a winner and LOCK_MISS on a loser, on top of what the
// pick already earns. It rides in the picks row's `confidence` column, which
// used to hold 1–3 "confidence stars" that never scored — old cards carry
// plenty of them — so a lock counts only on cards dated LOCKS_START or later.
// Failure modes this holds, none of which throw:
//   - the board, the belt and challenges disagreeing on what a lock is worth
//     (each used to keep its own copy of the pick formula);
//   - legacy stars suddenly scoring and rewriting past standings / the belt;
//   - a cancelled bout or NC charging the miss;
//   - more than LOCKS_PER_CARD locks on a card from the UI.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) { console.error(`  ✗ index.html: no // ${name} block`); process.exit(1); }
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

const DAY = 86400000;
const toasts = [];
const ctx = vm.createContext({
  console, String, Object, Array, JSON, Math, Date, isFinite, Number,
  DAY_MS: DAY, EVENTS: [], RESULTS_ARCHIVE: {}, lbScope: "all", MAIN_CARD_BOUTS: 5,
  USER_ID: null,
  splitNick: (n) => ({ name: String(n || "").replace(/^\S+\s+/, "") }),
  // toggleLock's surroundings
  preds: {}, preds_conf: {},
  pk: (ev, f) => ev.date + "|" + f.f1.n + "|" + f.f2.n,
  fightLocked: (ev, f) => !!f._started, lockReason: () => "locked",
  saveConf: () => {}, render: () => {}, syncPick: () => {},
  toast: (m) => toasts.push(m),
});
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("pick-match"), ctx);
vm.runInContext(fn("_eventFinished"), ctx);
vm.runInContext(fn("computeBeltLineage"), ctx);
vm.runInContext(fn("_lbScoreUsers"), ctx);
vm.runInContext(fn("cardLocksUsed"), ctx);
vm.runInContext(fn("toggleLock"), ctx);

const { LOCKS_START, LOCK_HIT, LOCK_MISS, LOCKS_PER_CARD } = vm.runInContext(
  "({LOCKS_START,LOCK_HIT,LOCK_MISS,LOCKS_PER_CARD})", ctx);

check("the shipped rules: 2 per card, +1 on a hit, −1 on a miss",
  LOCKS_PER_CARD === 2 && LOCK_HIT === 1 && LOCK_MISS === -1);

const bout = (a, b, winner, odds, state) => ({
  f1: { n: a }, f2: { n: b }, winner: winner || "", state: state || (winner ? "post" : "pre"),
  method: winner ? "KO/TKO" : "", odds: odds || null,
});
const pick = (who, date, a, b, p, extra) =>
  Object.assign({ nickname: "🥊 " + who, user_id: who, event_date: date, f1: a, f2: b, pick: p }, extra || {});

const NEW = LOCKS_START;                  // first card locks count on
const OLD = "2026-09-19";                 // a legacy-stars card
check("the legacy card used below really predates LOCKS_START", OLD < NEW);

const newCard = { name: "UFC Fight Night: New", date: NEW, fights: [
  bout("A1", "B1", "A1"),
  bout("A2", "B2", "B2", { f1: -300, f2: 260 }),     // +260 dog
  bout("A3", "B3", "A3"),
  bout("A4", "B4", "", null, "post"),                // cancelled / NC
] };
const oldCard = { name: "UFC 331: Old", date: OLD, fights: [bout("C1", "D1", "C1"), bout("C2", "D2", "D2")] };
ctx.EVENTS = [oldCard, newCard];

const res = (date, a, b) => ctx._findFightResult(date, a, b);

// --- pickPts ----------------------------------------------------------------
{
  const P = (p) => ctx.pickPts(p, res(p.event_date, p.f1, p.f2));
  check("unlocked winner = 1", P(pick("x", NEW, "A1", "B1", "A1")) === 1);
  check("locked winner = 1 + LOCK_HIT", P(pick("x", NEW, "A1", "B1", "A1", { confidence: 1 })) === 1 + LOCK_HIT);
  check("locked loser = LOCK_MISS", P(pick("x", NEW, "A1", "B1", "B1", { confidence: 1 })) === LOCK_MISS);
  check("a lock stacks on the underdog + method bonus",
    P(pick("x", NEW, "A2", "B2", "B2", { confidence: 1, method: "KO/TKO" })) === 1 + 0.5 + 1 + LOCK_HIT);
  check("a lock on a cancelled bout is 0, not a miss",
    P(pick("x", NEW, "A4", "B4", "A4", { confidence: 1 })) === 0);
  check("legacy stars (any value) on a pre-LOCKS_START card never score",
    P(pick("x", OLD, "C1", "D1", "D1", { confidence: 3 })) === 0 &&
    P(pick("x", OLD, "C2", "D2", "D2", { confidence: 3 })) === 1);
}

// --- the board and the belt agree ----------------------------------------
{
  const rows = [
    // Ann: 2 winners, one locked (+1) → 3 + ... and one locked loser (−1)
    pick("Ann", NEW, "A1", "B1", "A1", { confidence: 1 }),
    pick("Ann", NEW, "A3", "B3", "B3", { confidence: 1 }),
    pick("Ann", NEW, "A2", "B2", "A2"),
    // Bob: 2 winners, no locks
    pick("Bob", NEW, "A1", "B1", "A1"),
    pick("Bob", NEW, "A3", "B3", "A3"),
    pick("Bob", NEW, "A2", "B2", "A2"),
    // Cat: one locked winner → 1 + LOCK_HIT
    pick("Cat", NEW, "A1", "B1", "A1", { confidence: 1 }),
    // Legacy stars all over an old card
    pick("Ann", OLD, "C1", "D1", "D1", { confidence: 3 }),
    pick("Ann", OLD, "C2", "D2", "C2", { confidence: 2 }),
  ];
  const board = ctx._lbScoreUsers(rows, (p) => p.event_date === NEW);
  const byName = Object.fromEntries(board.map((u) => [u.user_id, u]));
  const annPts = ctx.userPts(byName.Ann), bobPts = ctx.userPts(byName.Bob);
  check("board: Ann's lock hit and lock miss net to zero (1 + 1 − 1 = 1)", annPts === 1 && byName.Ann.lockPts === 0);
  check("board: Bob scores his 2 winners", bobPts === 2);
  check("board: a lone lock hit reaches the total (userPts)", ctx.userPts(byName.Cat) === 1 + LOCK_HIT);
  check("board: each pick row carries its lock swing",
    byName.Ann.picks.filter((p) => p.locked).map((p) => p.lockPts).sort().join(",") === [LOCK_MISS, LOCK_HIT].sort().join(","));

  const oldBoard = ctx._lbScoreUsers(rows, (p) => p.event_date === OLD);
  const oldAnn = oldBoard.find((u) => u.user_id === "Ann");
  check("board: legacy stars don't move an old card's score",
    oldAnn.lockPts === 0 && ctx.userPts(oldAnn) === 0 && oldAnn.picks.every((p) => !p.locked));

}

// --- the belt counts the lock -----------------------------------------------
{
  // Eve: locked +260 dog hits (1+1+1 = 3), two misses. Fay: two winners, one
  // miss (2). Without the lock they tie on 2 and Fay takes it on accuracy, so
  // only a belt that counts the lock crowns Eve.
  const rows = [
    pick("Eve", NEW, "A2", "B2", "B2", { confidence: 1 }),
    pick("Eve", NEW, "A1", "B1", "B1"),
    pick("Eve", NEW, "A3", "B3", "B3"),
    pick("Fay", NEW, "A1", "B1", "A1"),
    pick("Fay", NEW, "A3", "B3", "A3"),
    pick("Fay", NEW, "A2", "B2", "A2"),
  ];
  const belt = ctx.computeBeltLineage(rows);
  const last = belt.reigns[belt.reigns.length - 1];
  const eve = ctx._lbScoreUsers(rows, (p) => p.event_date === NEW).find((u) => u.user_id === "Eve");
  check("belt scores the lock the way the board does (Eve 3 beats Fay 2)",
    /Eve/.test(last.name) && last.pts === 3 && ctx.userPts(eve) === 3);
}

// --- the cap -------------------------------------------------------------
{
  const ev = { date: NEW, fights: [bout("E1", "F1"), bout("E2", "F2"), bout("E3", "F3"), Object.assign(bout("E4", "F4"), { _started: true })] };
  const k = (i) => ctx.pk(ev, ev.fights[i]);
  ctx.preds = { [k(0)]: "E1", [k(1)]: "E2", [k(2)]: "E3", [k(3)]: "E4" };
  ctx.preds_conf = {};
  ctx.toggleLock(ev, ev.fights[0]);
  ctx.toggleLock(ev, ev.fights[1]);
  check("two locks go on", ctx.preds_conf[k(0)] === 1 && ctx.preds_conf[k(1)] === 1);
  ctx.toggleLock(ev, ev.fights[2]);
  check("a third lock on the card is refused", !ctx.preds_conf[k(2)] && ctx.cardLocksUsed(ev) === LOCKS_PER_CARD);
  ctx.toggleLock(ev, ev.fights[0]);
  ctx.toggleLock(ev, ev.fights[2]);
  check("unlocking one frees a slot", !ctx.preds_conf[k(0)] && ctx.preds_conf[k(2)] === 1);
  ctx.toggleLock(ev, ev.fights[3]);
  check("a bout whose segment has started can't be locked", !ctx.preds_conf[k(3)]);
  delete ctx.preds[k(1)];
  check("a lock left on an unpicked bout doesn't use a slot", ctx.cardLocksUsed(ev) === 1);
}

// --- every per-pick scorer goes through pickPts ------------------------------
{
  const copies = html.match(/1\+\(scoreMethod\(p\.method\|\|"",res\.method\|\|""\)\?0\.5:0\)/g) || [];
  check("only pickPts carries the per-pick formula (no stray copy skipping the lock)", copies.length === 1);
  check("the old 1–3 star picker is gone", !/\[1,2,3\]\.forEach\(function\(n\)\{\s*var sb=/.test(html));
}

if (failures) { console.error(`\n${failures} lock check(s) failed`); process.exit(1); }
console.log("Lock checks passed");
