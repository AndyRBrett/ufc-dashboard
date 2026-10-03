// Guard: a bout locks when ITS OWN broadcast segment starts.
//
// A numbered PPV runs THREE segments — early prelims 5pm, prelims 7pm, main
// card 9pm ET — but the event model carried only two clocks. "Early Prelim"
// bouts therefore answered to the 7pm prelim gate, which meant that from their
// own 5pm opening bell until their result landed in data.js they were still
// pickable: you could back a fight you were currently watching. UFC 331 shipped
// three bouts in that state (Shahbazyan/Ferreira, O'Neill/Moura,
// Chikadze/Brito).
//
// The inverse matters just as much and is the older bug: locking every bout on
// the card the moment the FIRST segment starts made the main event unpickable
// hours before it ran, next to a countdown still counting down to it. So this
// asserts both directions at each boundary.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

// Anchored slice: index.html carries several date helpers and an unanchored
// grab reads the wrong one.
const a = html.indexOf("function etOffset(");
const b = html.indexOf("// A challenge rides on specific main-card fights");
if (a < 0 || b < 0 || b <= a) {
  fail("index.html: could not locate the lock-clock block (etOffset … lockReason)");
  process.exit(1);
}
// The segment labels (isMainCardBout / isEarlyPrelimBout) are shared with
// scoring, so since engine-migration stage 3 they live once, in scoring.js —
// the clock block calls them. Evaluate both, as the page does.
const scoring = readFileSync(join(ROOT, "scoring.js"), "utf8");
const labelFn = (name) => {
  const i = scoring.indexOf(`function ${name}(`);
  if (i < 0) { fail(`scoring.js no longer defines ${name}()`); process.exit(1); }
  let j = scoring.indexOf("{", i), d = 0;
  for (; j < scoring.length; j++) { if (scoring[j] === "{") d++; else if (scoring[j] === "}" && --d === 0) break; }
  return scoring.slice(i, j + 1);
};
// etOffset(date) answers from _etOffsetAt, the date-based DST rule (it lives
// with the sport switcher); lift it the same brace-matched way.
const htmlFn = (name) => {
  const i = html.indexOf(`function ${name}(`);
  if (i < 0) { fail(`index.html no longer defines ${name}()`); process.exit(1); }
  let j = html.indexOf("{", i), d = 0;
  for (; j < html.length; j++) { if (html[j] === "{") d++; else if (html[j] === "}" && --d === 0) break; }
  return html.slice(i, j + 1);
};
const src = ["isMainCardBout", "isEarlyPrelimBout", "boutSegmentKey", "segmentRunOrder", "boutDecided"].map(labelFn).join("\n") +
  "\n" + htmlFn("_etOffsetAt") + "\n" + html.slice(a, b);

for (const fn of ["_segPassed", "cardStartTime", "boutSegmentTime"]) {
  if (!html.slice(a, b).includes("function " + fn)) fail(`lock block no longer defines ${fn}()`);
}

// Freeze the clock so "now" is a parameter, not the wall clock.
function load(nowMs) {
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  }
  const ctx = vm.createContext({ Date: FakeDate, parseInt, isNaN, String, console });
  vm.runInContext(src, ctx);
  return ctx;
}

// UFC 331: 19 Sep 2026, EDT (UTC-4). Early prelims 17:00, prelims 19:00, main 21:00 ET.
const EV = {
  date: "2026-09-19", time: "21:00", prelimTime: "19:00", earlyPrelimTime: "17:00",
};
const ET = (hh, mm = 0) => Date.UTC(2026, 8, 19, hh + 4, mm, 0);

const MAIN = { lbl: "Main Event" };
const PRELIM = { lbl: "Prelim" };
const EARLY = { lbl: "Early Prelim" };

const lockedAt = (ms, f, ev = EV) => load(ms).fightLocked(ev, f);

// --- DST sanity: the whole thing hangs off this offset ---------------------
check("19 Sep 2026 resolves to EDT (UTC-4), so 21:00 ET is 01:00 UTC",
  load(ET(12)).etOffset() === 4 && load(ET(12)).etOffset(EV.date) === 4);
// The offset belongs to the CARD's date, not today's. It used to read today's,
// so a November card looked at in September locked an hour early, and a test
// pinned to a September card went red at the November change.
{
  const nov = { date: "2026-11-14", time: "21:00", prelimTime: "19:00" };
  const novMain = Date.UTC(2026, 10, 15, 2, 0);            // 21:00 EST = 02:00 UTC
  const septNow = ET(12), decNow = Date.UTC(2026, 11, 20, 12);
  check("a November card is on EST even when viewed from September",
    load(septNow).etOffset(nov.date) === 5 && lockedAt(novMain - 60000, MAIN, nov) === false && lockedAt(novMain, MAIN, nov) === true);
  check("a September card stays on EDT when checked from December",
    load(decNow).etOffset(EV.date) === 4 && lockedAt(ET(21, 0) - 60000, MAIN) === false && lockedAt(ET(21, 0), MAIN) === true);
  check("the change days: 31 Oct 2026 EDT, 1 Nov EST; 13 Mar 2027 EST, 14 Mar EDT",
    load(septNow).etOffset("2026-11-01") === 5 && load(septNow).etOffset("2026-10-31") === 4 &&
    load(septNow).etOffset("2027-03-13") === 5 && load(septNow).etOffset("2027-03-14") === 4);
}

// --- early prelims: the bug this file exists for ---------------------------
check("an early prelim is pickable at 16:59, a minute before its bell",
  lockedAt(ET(16, 59), EARLY) === false);
check("an early prelim LOCKS at its own 17:00 bell, not the 19:00 prelim gate",
  lockedAt(ET(17, 0), EARLY) === true);
check("an early prelim is still locked at 18:00, mid-segment",
  lockedAt(ET(18, 0), EARLY) === true);

// --- regular prelims must NOT be dragged earlier by the new clock ----------
check("a prelim is still pickable at 17:00 while the early prelims run",
  lockedAt(ET(17, 0), PRELIM) === false);
check("a prelim is still pickable at 18:59",
  lockedAt(ET(18, 59), PRELIM) === false);
check("a prelim locks at its own 19:00 bell",
  lockedAt(ET(19, 0), PRELIM) === true);

// --- main card keeps its own clock, the original regression ----------------
check("the main event is pickable at 17:00, four hours out",
  lockedAt(ET(17, 0), MAIN) === false);
check("the main event is still pickable at 20:59, with prelims long underway",
  lockedAt(ET(20, 59), MAIN) === false);
check("the main event locks at 21:00",
  lockedAt(ET(21, 0), MAIN) === true);

// --- a decided bout is locked whatever the clock says ----------------------
check("a bout with a winner is locked even before its segment starts",
  lockedAt(ET(12), { lbl: "Early Prelim", winner: "Chikadze" }) === true);

// --- the card's own start is its EARLIEST segment --------------------------
check("picksLocked says the card has started once early prelims are on air",
  load(ET(17, 0)).picksLocked(EV) === true);
check("picksLocked says not started at 16:59",
  load(ET(16, 59)).picksLocked(EV) === false);

// --- a two-segment card (Fight Night) is untouched -------------------------
const FN = { date: "2026-09-19", time: "20:00", prelimTime: "17:00" };
check("with no earlyPrelimTime the card starts at its prelim clock",
  load(ET(17, 0)).picksLocked(FN) === true &&
  load(ET(16, 59)).picksLocked(FN) === false);
check("an Early Prelim label with no earlyPrelimTime falls back to the prelim gate",
  lockedAt(ET(16, 59), EARLY, FN) === false &&
  lockedAt(ET(17, 0), EARLY, FN) === true);

// --- TBD clocks must not silently read as 'not started' --------------------
const TBD = { date: "2026-09-19", time: "TBD", prelimTime: "TBD" };
check("a TBD main-card time falls back rather than throwing or locking",
  load(ET(23)).mainCardLocked(TBD) === false);
check("_segPassed reports null (not false) for an unusable clock",
  load(ET(23))._segPassed(TBD, "TBD") === null);

// --- the toast names the segment the user actually tapped ------------------
const lr = load(ET(12)).lockReason;
check("lockReason distinguishes the early prelims from the prelims",
  /early prelims/.test(lr(EARLY)) && /prelims/.test(lr(PRELIM)) &&
  !/early/.test(lr(PRELIM)) && /main card/.test(lr(MAIN)));

// --- one fight at a time inside a segment -----------------------------------
// Only a segment's opener locks at the bell; each later bout locks when the
// fight before it has a result. Jordan, UFC 332: "Rn I can't pick the Johnny
// Walker fight and it's 3 fights away".
// ev.fights is main event first, so each segment runs in reverse array order.
function card() {
  const b = (lbl, n) => ({ lbl, f1: { n: n + " A" }, f2: { n: n + " B" } });
  return { ...EV, fights: [
    b("Main Event", "M1"), b("Co-Main", "M2"), b("Main Card", "M3"),
    b("Prelim", "P1"), b("Prelim", "P2"),
    b("Early Prelim", "E1"), b("Early Prelim", "E2"), b("Early Prelim", "E3") ] };
}
{
  const c = card(), [M1, M2, M3, P1, P2, E1, E2, E3] = c.fights;
  const ctx = load(ET(17, 5));
  check("at the early-prelim bell only the segment's opener (last in the array) locks",
    ctx.fightLocked(c, E3) === true && ctx.fightLocked(c, E2) === false && ctx.fightLocked(c, E1) === false);
  check("a bout two fights away is pickable while the opener runs",
    ctx.fightLocked(c, E1) === false);
  check("…and nothing in a later segment moves", ctx.fightLocked(c, P2) === false && ctx.fightLocked(c, M3) === false);
  E3.winner = "E3 A";
  check("the opener's result locks the next fight, and only that one",
    ctx.fightLocked(c, E2) === true && ctx.fightLocked(c, E1) === false);
  E3.winner = ""; E3.state = "post";
  check("a draw or no contest (finished, no winner) counts as over",
    ctx.fightLocked(c, E3) === true && ctx.fightLocked(c, E2) === true);
  E3.state = "pre";
  E2.winner = "E2 B";
  check("a later fight already decided locks every bout before it (a fight that never got its result)",
    ctx.fightLocked(c, E3) === true && ctx.fightLocked(c, E1) === true);
  E2.winner = "";
  check("the next segment's bell locks everything before it, results or not",
    load(ET(19, 0)).fightLocked(c, E1) === true && load(ET(19, 0)).fightLocked(c, P1) === false);
  check("the main card's bell locks the prelims behind it",
    load(ET(21, 0)).fightLocked(c, P1) === true && load(ET(21, 0)).fightLocked(c, M2) === false);
  check("the main card runs the same way: its opener (the last main-card bout) at the bell",
    load(ET(21, 0)).fightLocked(c, M3) === true && load(ET(21, 0)).fightLocked(c, M1) === false);
  M3.winner = "M3 A";
  check("…the co-main when that result lands, the main event still open",
    load(ET(21, 30)).fightLocked(c, M2) === true && load(ET(21, 30)).fightLocked(c, M1) === false);
  M3.winner = "";
  check("nothing locks before its segment's bell, whatever the results say",
    load(ET(16, 0)).fightLocked(c, E2) === false && load(ET(18, 0)).fightLocked(c, P1) === false);
  // The server's backstop: send-reminders writes a time for each bout, and the
  // app honours it once it has passed.
  const ctx2 = load(ET(17, 50));
  ctx2._serverLocks[ctx2._lockKey(c.date, E1.f1.n, E1.f2.n)] = ET(17, 45);
  check("a server lock time that has passed locks the bout",
    ctx2.fightLocked(c, E1) === true && ctx2.fightLocked(c, E2) === false);
  ctx2._serverLocks[ctx2._lockKey(c.date, E2.f1.n, E2.f2.n)] = ET(18, 30);
  check("…and one still ahead does not", ctx2.fightLocked(c, E2) === false);
  check("server times are keyed like pick_locks: lower-cased, trimmed, sorted",
    ctx2._lockKey("d", " Zed B", "alpha A ") === "d|alpha a|zed b");
  // Other players' picks show at the server's lock plus the grace (0017), so
  // the group bar waits for that, not for the app's own lock.
  {
    const d = card(), e1 = d.fights[5], e2 = d.fights[6], e3 = d.fights[7];   // E1 E2 E3, E3 runs first
    const at = (ms, serverE2) => { const x = load(ms); if (serverE2) x._serverLocks[x._lockKey(d.date, e2.f1.n, e2.f2.n)] = serverE2; return x; };
    e3.winner = "E3 A";                                            // the app locks E2 now
    check("picks aren't revealed while the server's lock is still ahead (its sighting lags the app's)",
      at(ET(17, 20), ET(17, 45)).fightLocked(d, e2) === true && at(ET(17, 20), ET(17, 45))._picksRevealed(d, e2) === false);
    check("…nor inside the grace after it", at(ET(17, 48), ET(17, 45))._picksRevealed(d, e2) === false);
    check("…and are once the grace has passed", at(ET(17, 50), ET(17, 45))._picksRevealed(d, e2) === true);
    check("a bout that isn't locked is never revealed", at(ET(17, 50), ET(17, 0)).fightLocked(d, e1) === false &&
      at(ET(17, 50), ET(17, 0))._picksRevealed(d, e1) === false);
    check("with no server time the app's own lock decides", at(ET(17, 20), null)._picksRevealed(d, e2) === true);
  }
  check("the group bar is drawn only once picks are revealed",
    /if\(locked&&_picksRevealed\(EVENTS\[ei\],fight\)&&cp&&cp\.total>=1\)/.test(html));
  const fn = { ...FN, fights: [{ lbl: "Prelim", f1: { n: "Q A" }, f2: { n: "Q B" } },
    { lbl: "Early Prelim", f1: { n: "R A" }, f2: { n: "R B" } }] };
  check("with no early clock the early prelims open the prelim segment",
    load(ET(17, 0)).fightLocked(fn, fn.fights[1]) === true && load(ET(17, 0)).fightLocked(fn, fn.fights[0]) === false);
  const lr2 = load(ET(17, 5)).lockReason;
  E3.winner = "E3 A";
  check("the toast says a cascaded bout is up next, and keeps the segment wording for an opener",
    /up next/.test(lr2(E2, c)) && /early prelims/.test(lr2({ lbl: "Early Prelim" }, c)));
}

if (failures) {
  console.error(`\nLock-time checks FAILED (${failures})`);
  process.exit(1);
}
console.log("\nLock-time checks passed");
