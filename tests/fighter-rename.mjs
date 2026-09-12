// Guard: a fighter renamed mid-card must not un-score the picks already made on them.
//
// Real incident (Noche / UFC Fight Night: Silva vs. Delgado, 2026-09-12): ufcstats
// renamed "Sean King III" to "Sean King" between the 19:04 and 19:08 scrapes —
// after picks were locked in and at the exact moment his result landed. Picks are
// stored BY FIGHTER NAME (both the bout key `date|f1|f2` and the pick value), so
// every one of them stopped matching the card:
//
//   the bout lookup   (f.f1.n === p.f1)      → no fight found  → pick stuck "Pending"
//   the winner check  (fight.winner === p.pick) → never true   → no point awarded
//
// People who had picked him correctly got nothing. The fix is that fighters are
// never compared as raw strings: nmEq/nmBout fold case, accents, punctuation and
// generational suffixes away first.
//
// What this test protects:
//   1. nmKey/nmEq/nmBout actually treat the variant spellings as one fighter,
//      and still keep DIFFERENT fighters apart (the expensive failure mode would
//      be over-matching — awarding points for a pick nobody made).
//   2. The scoring path itself — _findFightResult, _isMainCardPick, dogPtsForPick —
//      resolves a pick stored under the old spelling against the renamed card.
//   3. No two fighters on any card currently in data.js collide under nmKey.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) {
    console.error(`  ✗ index.html: no // ${name}:start … // ${name}:end block — renamed or removed?`);
    process.exit(1);
  }
  return html.slice(a, b);
}

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

// The renamed bout, exactly as the card ended up carrying it.
const KING = { lbl: "Prelim", wc: "Featherweight", state: "post",
  winner: "Sean King", method: "KO/TKO", round: 1, odds: { f1: -300, f2: 260 },
  f1: { n: "Sean King" }, f2: { n: "Jessie Rosas" } };
const OTHER = { lbl: "Main Event", wc: "Featherweight", state: "post",
  winner: "Rong Zhu", method: "Decision (Unanimous)", odds: { f1: 132, f2: -159 },
  f1: { n: "Rafa Garcia" }, f2: { n: "Rong Zhu" } };
const DATE = "2026-09-12";

const ctx = vm.createContext({
  console, String, Object, Math, Date,
  EVENTS: [{ date: DATE, name: "UFC Fight Night: Silva vs. Delgado", fights: [OTHER, KING] }],
  RESULTS_ARCHIVE: {},
  MAIN_CARD_BOUTS: 5,
  lbScope: "all",
  isMainCardBout: (f) => f.lbl !== "Prelim",
  splitNick: (n) => ({ name: String(n || "") }),
});
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("pick-match"), ctx);
const call = (expr) => vm.runInContext(expr, ctx);
const nmEq = (a, b) => call(`nmEq(${JSON.stringify(a)},${JSON.stringify(b)})`);
const nmKey = (a) => call(`nmKey(${JSON.stringify(a)})`);

// ── 1. the normalizer ────────────────────────────────────────────────────────
check("the suffix that caused the incident is folded away",
  nmEq("Sean King III", "Sean King") && nmEq("Sean King", "Sean King III"));
check("the other generational suffixes fold too",
  nmEq("Khalil Rountree Jr.", "Khalil Rountree") && nmEq("Bruce Lee Sr", "Bruce Lee") &&
  nmEq("Joe Smith II", "Joe Smith") && nmEq("Joe Smith IV", "Joe Smith"));
check("accents, hyphens and curly apostrophes don't split a fighter in two",
  nmEq("José Aldo", "Jose Aldo") && nmEq("Waldo Cortes-Acosta", "Waldo Cortes Acosta") &&
  nmEq("Sean O’Malley", "Sean O'Malley"));
check("two genuinely different fighters still don't match",
  !nmEq("Sean King", "Jessie Rosas") && !nmEq("King Green", "Sean King") &&
  !nmEq("Rafa Garcia", "Rafael Garcia"));
// An undecided bout carries winner:"" — if blank matched blank, every unresolved
// pick would score as correct the moment it was made.
check("blank never matches blank, so an undecided bout scores nothing",
  !nmEq("", "") && !nmEq(null, undefined) && !nmEq("Sean King", "") && !nmEq(null, null));
check("a bout is recognised from either corner, under either spelling",
  call(`nmBout(${JSON.stringify(KING)},"Sean King III","Jessie Rosas")`) &&
  call(`nmBout(${JSON.stringify(KING)},"Jessie Rosas","Sean King III")`) &&
  !call(`nmBout(${JSON.stringify(KING)},"Rafa Garcia","Rong Zhu")`));

// ── 2. the scoring path, with a pick stored under the OLD name ───────────────
const res = call(`_findFightResult("${DATE}","Sean King III","Jessie Rosas")`);
check("the renamed bout is found from a pick stored under the old name", !!res);
check("and it reports the winner, so the pick can be scored",
  !!res && res.winner === "Sean King");
// This is the whole point: the comparison the leaderboard makes.
check("a correct pick under the old spelling scores as correct",
  !!res && nmEq(res.winner, "Sean King III"));
check("a WRONG pick on the same renamed bout still scores as wrong",
  !!res && !nmEq(res.winner, "Jessie Rosas"));
check("the underdog bonus prices the renamed fighter's own side of the line",
  call(`dogPtsForPick(${JSON.stringify(KING.odds)},"Sean King","Jessie Rosas","Sean King III")`) ===
  call(`dogPtsForPick(${JSON.stringify(KING.odds)},"Sean King","Jessie Rosas","Sean King")`) &&
  call(`dogPtsForPick(${JSON.stringify(KING.odds)},"Sean King","Jessie Rosas","Jessie Rosas")`) === 1);
check("main-card scope still classifies the bout correctly after the rename",
  call(`_isMainCardPick("${DATE}","Sean King III","Jessie Rosas")`) === false &&
  call(`_isMainCardPick("${DATE}","Rafa Garcia","Rong Zhu")`) === true);
check("a bout that was never on the card is still not found",
  call(`_findFightResult("${DATE}","Nobody Here","Someone Else")`) === null);

// The archive is a separate lookup path with its own name strings.
vm.runInContext(`RESULTS_ARCHIVE["2026-05-30"]={fights:[{f1:"Sean King III",f2:"Jessie Rosas",method:"KO/TKO",winner:"Sean King III"}]};`, ctx);
const arch = call(`_findFightResult("2026-05-30","Sean King","Jessie Rosas")`);
check("the results archive resolves across the rename too",
  !!arch && nmEq(arch.winner, "Sean King"));

// ── 3. a rename must not leave the pick stored TWICE on the server ───────────
// _reconcilePickOrder re-keys the local pick to the card's new spelling. The
// server row's conflict key is (user_id,event_date,f1,f2), so the later
// syncAllPicks upsert lands as a SECOND row beside the old-name one, and the
// (now name-tolerant) scoring counts the same pick twice. syncPick only clears
// the reverse ordering of the current spelling, and _dedupeMyPicks has already
// latched by then — so _reconcilePickOrder has to flag the rename, and
// syncAllPicks has to re-run the dedupe. This checks the flag half: the half a
// unit test can see without a live Supabase.
const rctx = vm.createContext({ console, String, Object, Array, JSON });
vm.runInContext(`
  var EVENTS=${JSON.stringify([{ date: DATE, fights: [KING] }])};
  var preds={},preds_method={},preds_conf={},resolvedPicks={};
  var saved=0,savedM=0,savedC=0;
  function save(){saved++;} function saveMethod(){savedM++;} function saveConf(){savedC++;}
  var localStorage={setItem:function(){},getItem:function(){return null;}};
`, rctx);
vm.runInContext(block("fighter-names"), rctx);
vm.runInContext(block("pick-reconcile"), rctx);
const reset = (preds, method, conf, resolved) => vm.runInContext(
  `preds=${JSON.stringify(preds)};preds_method=${JSON.stringify(method || {})};` +
  `preds_conf=${JSON.stringify(conf || {})};resolvedPicks=${JSON.stringify(resolved || {})};` +
  `_pickSpellingChanged=false;_reconcilePickOrder();`, rctx);
const rd = (expr) => vm.runInContext(expr, rctx);

const OLDKEY = `${DATE}|Sean King III|Jessie Rosas`;
const NEWKEY = `${DATE}|Sean King|Jessie Rosas`;
const FLIPKEY = `${DATE}|Jessie Rosas|Sean King`;

reset({ [OLDKEY]: "Sean King III" }, { [OLDKEY]: "KO/TKO" }, { [OLDKEY]: 3 }, { [OLDKEY]: "win" });
check("a pick stored under the old name is re-keyed to the card's spelling",
  rd(`preds[${JSON.stringify(NEWKEY)}]`) !== undefined &&
  rd(`preds[${JSON.stringify(OLDKEY)}]`) === undefined);
check("its method, confidence and resolved entry move with it",
  rd(`preds_method[${JSON.stringify(NEWKEY)}]`) === "KO/TKO" &&
  rd(`preds_conf[${JSON.stringify(NEWKEY)}]`) === 3 &&
  rd(`resolvedPicks[${JSON.stringify(NEWKEY)}]`) === "win" &&
  rd(`resolvedPicks[${JSON.stringify(OLDKEY)}]`) === undefined);
check("the stored pick VALUE is re-spelled, so it compares equal to the winner",
  rd(`preds[${JSON.stringify(NEWKEY)}]`) === "Sean King");
// The flag is what makes syncAllPicks prune the stale server row. Without it the
// pick scores twice for the rest of the session.
check("the rename is flagged, so the stale server row gets pruned",
  rd("_pickSpellingChanged") === true);

// A bare corner flip must NOT raise it — syncPick already deletes that row, and
// a needless re-dedupe costs a full table fetch on every sync.
reset({ [FLIPKEY]: "Sean King" });
check("a bare corner flip is re-keyed but NOT flagged (syncPick already clears it)",
  rd(`preds[${JSON.stringify(NEWKEY)}]`) === "Sean King" &&
  rd("_pickSpellingChanged") === false);

// Steady state: nothing to do, nothing flagged.
reset({ [NEWKEY]: "Sean King" });
check("a pick already under the current spelling is left alone and unflagged",
  rd(`preds[${JSON.stringify(NEWKEY)}]`) === "Sean King" &&
  rd("_pickSpellingChanged") === false &&
  Object.keys(rd("preds")).length === 1);

// ── 4. no collisions on any card we actually ship ────────────────────────────
const dataSrc = readFileSync(join(ROOT, "data.js"), "utf8");
const dctx = vm.createContext({});
vm.runInContext(dataSrc, dctx);
const events = vm.runInContext("EVENTS", dctx);
if (!Array.isArray(events) || !events.length) {
  fail("data.js exposed no EVENTS — cannot check for name collisions");
} else {
  const collisions = [];
  for (const ev of events) {
    const seen = new Map();
    for (const f of ev.fights) for (const n of [f.f1.n, f.f2.n]) {
      const k = nmKey(n);
      if (!k) continue;
      if (seen.has(k) && seen.get(k) !== n) collisions.push(`${ev.date}: "${seen.get(k)}" vs "${n}"`);
      seen.set(k, n);
    }
  }
  check(`no two fighters on any of the ${events.length} carded events collide under nmKey` +
        (collisions.length ? " — " + collisions.join("; ") : ""), collisions.length === 0);
}

if (failures) {
  console.error(`\nfighter-rename: ${failures} check(s) failed — a rename can silently unscore correct picks.`);
  process.exit(1);
}
console.log("\nfighter-rename: a mid-card rename no longer orphans picks made under the old name.");
