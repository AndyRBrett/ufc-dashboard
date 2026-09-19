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
const a = html.indexOf("function etOffset(){");
const b = html.indexOf("// A challenge rides on specific main-card fights");
if (a < 0 || b < 0 || b <= a) {
  fail("index.html: could not locate the lock-clock block (etOffset … lockReason)");
  process.exit(1);
}
const src = html.slice(a, b);

for (const fn of ["_segPassed", "cardStartTime", "boutSegmentTime", "isEarlyPrelimBout"]) {
  if (!src.includes("function " + fn)) fail(`lock block no longer defines ${fn}()`);
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
  load(ET(12)).etOffset() === 4);

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

if (failures) {
  console.error(`\nLock-time checks FAILED (${failures})`);
  process.exit(1);
}
console.log("\nLock-time checks passed");
