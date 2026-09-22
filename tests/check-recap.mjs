// Guard: the post-card recap must report the night the way the board and the
// belt already scored it.
//
// The recap is a second reader of the same pick rows, so its failure mode is
// drift: a recap that crowns someone the Title History doesn't, counts a pick
// the board doesn't, or reports a "defence" on a card nobody scored on. None of
// that throws — the sheet just says something false about people's picks. So
// this runs the REAL scoring (fighter-names + pick-match blocks,
// _eventFinished, computeBeltLineage) under the recap and checks its answers.
//
// Also holds the wiring: the recap is fed by the boot-time community fetch
// (which must carry bonus_pick for FOTN), is a real overlay in _escClosers
// (so What's New and deep links see it), and waits behind What's New.
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
  if (a < 0 || b < 0) {
    console.error(`  ✗ index.html: no // ${name}:start … // ${name}:end block — renamed or removed?`);
    process.exit(1);
  }
  return html.slice(a, b);
}
// One top-level function by name, brace-matched.
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
const ctx = vm.createContext({
  console, String, Object, Array, JSON, Math, Date, isFinite,
  DAY_MS: DAY, EVENTS: [], RESULTS_ARCHIVE: {}, lbScope: "all", MAIN_CARD_BOUTS: 5,
  // Nicknames are "<emoji> <name>"; the real splitNick needs the emoji regex
  // machinery, and the recap only needs the name half.
  splitNick: (n) => ({ name: String(n || "").replace(/^\S+\s+/, "") }),
});
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("pick-match"), ctx);
vm.runInContext(fn("_eventFinished"), ctx);
vm.runInContext(fn("computeBeltLineage"), ctx);
vm.runInContext(block("card-recap"), ctx);

const bout = (a, b, winner, odds) => ({
  f1: { n: a }, f2: { n: b }, winner: winner || "", state: winner ? "post" : "pre",
  method: winner ? "KO/TKO" : "", odds: odds || null,
});
const pick = (who, date, a, b, p, extra) =>
  Object.assign({ nickname: "🥊 " + who, event_date: date, f1: a, f2: b, pick: p }, extra || {});
function setEvents(evs) { ctx.EVENTS = evs; }
const recap = (rows, date, me) => ctx.computeCardRecap(rows, date, me);

// --- card 1: Ann goes perfect and wins the vacant belt --------------------
const C1 = "2026-09-12", C2 = "2026-09-19", C3 = "2026-09-26";
const card1 = { name: "UFC Fight Night: One", date: C1, fights: [
  bout("A1", "B1", "A1", { f1: -200, f2: 170 }),
  bout("A2", "B2", "B2", { f1: -300, f2: 260 }),   // B2 is a +260 dog
  bout("A3", "B3", "A3"),
] };
const rows1 = [
  pick("Ann", C1, "A1", "B1", "A1"), pick("Ann", C1, "A2", "B2", "B2"), pick("Ann", C1, "A3", "B3", "A3"),
  pick("Bob", C1, "A1", "B1", "A1"), pick("Bob", C1, "A2", "B2", "A2"), pick("Bob", C1, "A3", "B3", "B3"),
];
setEvents([card1]);
{
  const r = recap(rows1, C1, "ann");
  check("first card: title reported as WON by the top scorer", r.title.kind === "won" && /Ann/.test(r.title.name));
  check("card standings put the title winner first", /Ann/.test(r.standings[0].name));
  check("3/3 is a perfect card", r.me.perfect === true && r.me.correct === 3 && r.me.total === 3);
  // 3 winners + 1 underdog point for the +260 call; no method picks.
  check("card points use the belt's scoring (winners + underdog bonus)", r.me.pts === 4);
  check("best upset is the longest-priced winner called", r.me.upset && r.me.upset.pick === "B2" && r.me.upset.line === 260);
  check("a first card has no rank before it", r.me.rankBefore === null && r.me.rankAfter === 1);
  const bob = recap(rows1, C1, "bob");
  check("1/3 is not perfect, and a missed dog is no upset", bob.me.perfect === false && bob.me.upset === null);
  check("card rank is out of everyone who picked", bob.me.cardRank === 2 && bob.me.of === 2);
  check("a player with no picks on the card gets me:null", recap(rows1, C1, "cat").me === null);
  // Level on points → same rank in the list AND under Your night.
  const tie = recap(rows1.concat([pick("Dee", C1, "A1", "B1", "A1"), pick("Dee", C1, "A3", "B3", "B3")]), C1, "dee");
  check("tied players share a card rank, in the list and in Your night",
    tie.me.cardRank === 2 && tie.standings.filter((u) => u.rank === 2).length === 2);
}

// --- card 2: Bob outscores the champ and takes it -------------------------
const card2 = { name: "UFC Fight Night: Two", date: C2, fights: [
  bout("C1", "D1", "C1"), bout("C2", "D2", "C2"), bout("C3", "D3", "C3"), bout("C4", "D4", "C4"),
] };
const rows2 = rows1.concat([
  pick("Bob", C2, "C1", "D1", "C1"), pick("Bob", C2, "C2", "D2", "C2"), pick("Bob", C2, "C3", "D3", "C3"), pick("Bob", C2, "C4", "D4", "C4"),
  pick("Ann", C2, "C1", "D1", "D1"), pick("Ann", C2, "C2", "D2", "C2"),
]);
setEvents([card1, card2]);
{
  const r = recap(rows2, C2, "bob");
  check("challenger beating the champ reads as TAKEN, from the old champ",
    r.title.kind === "taken" && /Bob/.test(r.title.name) && /Ann/.test(r.title.from));
  check("all-time rank movement is reported (2 → 1)", r.me.rankBefore === 2 && r.me.rankAfter === 1);
  const old = recap(rows2, C1, "ann");
  check("an OLD card's recap replays the belt only through that card", old.title.kind === "won" && /Ann/.test(old.title.name));
  check("latestRecapDate is the newest finished card", ctx.latestRecapDate(rows2) === C2);
}

// --- a tie at the top goes to the champion --------------------------------
{
  const rowsTie = rows1.concat([
    pick("Ann", C2, "C1", "D1", "C1"), pick("Bob", C2, "C1", "D1", "C1"),
  ]);
  const r = recap(rowsTie, C2, "bob");
  check("champ tying the top score is a DEFENCE, not a loss", r.title.kind === "defended" && /Ann/.test(r.title.name) && r.title.defenses === 1);
}

// --- nobody scored: no title news -----------------------------------------
{
  const rowsZero = rows1.concat([pick("Ann", C2, "C1", "D1", "D1"), pick("Bob", C2, "C2", "D2", "D2")]);
  const r = recap(rowsZero, C2, "ann");
  check("a card nobody scored on reports no title change (not a 'defence')", r.title.kind === "none");
}

// --- unfinished cards never get a recap -----------------------------------
{
  const live = { name: "UFC 999", date: C3, fights: [bout("E1", "F1", "E1"), bout("E2", "F2")] };
  setEvents([card1, card2, live]);
  const rows = rows2.concat([pick("Ann", C3, "E1", "F1", "E1")]);
  check("a card still in progress is not recapped", ctx.latestRecapDate(rows) === C2);
  setEvents([card1, card2]);
}

// --- FOTN counts once per player per card toward the all-time rank --------
{
  const c1f = Object.assign({}, card1, { fotn: "A3" });
  setEvents([c1f, card2]);
  // Cat: 0 winners but FOTN right, on two rows of the same card.
  const rows = rows1.concat([
    pick("Cat", C1, "A1", "B1", "B1", { bonus_pick: "A3" }),
    pick("Cat", C1, "A2", "B2", "A2", { bonus_pick: "A3" }),
  ]);
  const r = recap(rows, C1, "cat");
  // Ann 4, Bob 1, Cat 1 (FOTN once, not twice) → Cat ties Bob at #2.
  // Counted twice, Cat would sit alone on 2 and push Bob down to #3.
  check("FOTN adds once to the all-time rank, however many rows carry it",
    r.me.rankAfter === 2 && recap(rows, C1, "bob").me.rankAfter === 2);
  check("FOTN stays out of the card points (the belt ignores it)", r.me.pts === 0);
  setEvents([card1, card2]);
}

// --- wiring ---------------------------------------------------------------
check("recap overlay is a real overlay in _escClosers",
  /var _escClosers=\[[\s\S]*?\["recap-overlay",/.test(html));
check("closeWhatsNew releases a recap queued behind it",
  /_recapAfterWn\(\)/.test(fn("closeWhatsNew")));
{
  const f = fn("fetchCommunityPicks");
  check("community fetch selects bonus_pick (FOTN) and feeds checkCardRecap",
    /select=[^"]*bonus_pick/.test(f) && /checkCardRecap\(rows\)/.test(f));
}
check("checkCardRecap waits for What's New instead of stacking on it",
  /wn-overlay[\s\S]*?_recapQueued=date/.test(fn("checkCardRecap")));
check("closing checkpoints the card so it never auto-repeats",
  /RECAP_SEEN_KEY/.test(fn("closeCardRecap")));

if (failures) { console.error(`\ncheck:recap — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:recap — all good");
