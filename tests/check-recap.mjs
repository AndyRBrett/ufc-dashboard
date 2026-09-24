// Guard: the post-card recap must report the night the way the board and the
// belt already scored it.
//
// The recap is a second reader of the same pick rows, so its failure mode is
// drift: a recap that crowns someone the Title History doesn't, counts a pick
// the board doesn't, or reports a "defence" on a card nobody scored on. None of
// that throws — the sheet just says something false about people's picks. So
// this runs the REAL scoring (fighter-names + pick-match blocks,
// _eventFinished, computeBeltLineage, and the board's own _lbScoreUsers) under
// the recap and checks its answers.
//
// The recap's numbers must be the BOARD's numbers. The first version kept its
// own scoring, which also counted archived cards the board does not, and told
// a player they held #2 while the leaderboard had them #3. The "matches the
// board" checks below reproduce that and hold the recap to _lbScoreUsers.
//
// Also holds the wiring: the recap is fed by the boot-time community fetch
// (which must carry bonus_pick for FOTN), waits behind What's New, and — like
// What's New — is locked: no backdrop-click, no Escape, only the X or "Got it".
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The app's source: index.html plus scoring.js, where the scoring blocks this
// test lifts have lived since engine-migration stage 3.
const html = readFileSync(join(ROOT, "index.html"), "utf8") + "\n" + readFileSync(join(ROOT, "scoring.js"), "utf8");

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
  USER_ID: null,
  // Nicknames are "<emoji> <name>"; the real splitNick needs the emoji regex
  // machinery, and the recap only needs the name half.
  splitNick: (n) => ({ name: String(n || "").replace(/^\S+\s+/, "") }),
});
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("pick-match"), ctx);
vm.runInContext(fn("_eventFinished"), ctx);
vm.runInContext(fn("computeBeltLineage"), ctx);
vm.runInContext(fn("_lbScoreUsers"), ctx);
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

// --- a cancelled bout is not a miss --------------------------------------
{
  // Bout 4 finished with no winner (cancelled / no contest). It is in the
  // board's u.total with a null result; the recap's record must not count it.
  const cx = Object.assign({}, card1, { fights: card1.fights.concat([
    Object.assign(bout("A4", "B4"), { state: "post" }),
  ]) });
  setEvents([cx]);
  const r = recap(rows1.concat([pick("Ann", C1, "A4", "B4", "A4")]), C1, "ann");
  check("a cancelled bout leaves the record consistent with the perfect flag",
    r.me.perfect === true && r.me.correct === 3 && r.me.total === 3);
  setEvents([card1]);
}

// --- stale duplicate identities count once ---------------------------------
{
  // Bob's picks also exist under an old user_id: the same winning pick
  // (corners flipped) plus an older, since-changed pick on A3.
  const dup = rows1.map((p) => Object.assign({ updated_at: "2026-09-10T00:00:00Z" }, p)).concat([
    pick("Bob", C1, "B1", "A1", "A1", { user_id: "old", updated_at: "2026-09-01T00:00:00Z" }),
    pick("Bob", C1, "A3", "B3", "A3", { user_id: "old", updated_at: "2026-09-01T00:00:00Z" }),
  ]);
  const r = recap(dup, C1, "bob");
  check("a bout picked under two stale identities is scored once (newest row wins)",
    r.me.total === 3 && r.me.correct === 1 && r.me.pts === 1);
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
  // Card points are the board's "This Event" points, which include FOTN.
  check("card points include FOTN, as the board's This Event tab does", r.me.pts === 1);
  setEvents([card1, card2]);
}

// --- the recap's ranks ARE the board's ranks, and All-Time is every card ---
{
  // Zed's biggest night is on an ARCHIVED card (in RESULTS_ARCHIVE, gone from
  // EVENTS). All-Time counts every card captured, so the board scores it —
  // it used to skip it, leaving those picks counted but never scored — and the
  // recap, reading the board, must rank Zed exactly where the board does.
  const OLD = "2026-08-01";
  ctx.RESULTS_ARCHIVE = { [OLD]: { name: "UFC Old", fights: [
    { f1: "X1", f2: "Y1", winner: "X1", method: "KO/TKO" },
    { f1: "X2", f2: "Y2", winner: "X2", method: "KO/TKO" },
    { f1: "X3", f2: "Y3", winner: "X3", method: "Decision (Unanimous)" },
  ] } };
  setEvents([card1, card2]);
  const rows = rows2.concat([
    pick("Zed", OLD, "X1", "Y1", "X1", { method: "KO/TKO" }), pick("Zed", OLD, "Y2", "X2", "X2"), pick("Zed", OLD, "X3", "Y3", "Y3"),
    pick("Zed", C2, "C1", "D1", "C1"), pick("Zed", C2, "C2", "D2", "C2"), pick("Zed", C2, "C3", "D3", "C3"), pick("Zed", C2, "C4", "D4", "C4"),
  ]);
  const board = ctx._lbScoreUsers(ctx._recapBoardOrder(rows), null);
  const zed = board.find((u) => /Zed/.test(u.nickname));
  // Archive: 2 winners (corners flipped on one) + a KO/TKO method = 2.5, no dog
  // points (no line on record). EVENTS card: 4. Total 6.5.
  check("All-Time scores archived cards (winners + method, corner-order-agnostic, no dog bonus)",
    zed && zed.correct === 6 && zed.methods === 1 && zed.dogPts === 0 && ctx.userPts(zed) === 6.5);
  check("an archived miss is scored as a miss, not left unresolved",
    zed.picks.filter((p) => p.result === false).length === 1 && zed.picks.every((p) => p.result !== null));
  const boardRank = {};
  board.forEach((u) => { boardRank[ctx._lbBaseName(u.nickname)] = 1 + board.filter((v) => ctx.userPts(v) > ctx.userPts(u)).length; });
  const r = recap(rows, C2, "zed");
  check("the recap ranks an archive-heavy player where the board does (#1)",
    r.me.rankAfter === boardRank.zed && r.me.rankAfter === 1);
  check("every player's recap rank equals their leaderboard rank",
    ["ann", "bob", "zed"].every((b) => recap(rows, C2, b).me.rankAfter === boardRank[b]));
  check("an archive-only card is never recapped (no closing lines to read)",
    ctx.latestRecapDate([pick("Zed", OLD, "X1", "Y1", "X1")]) === null);
  ctx.RESULTS_ARCHIVE = {};
}

// --- one scorer, not two ---------------------------------------------------
{
  const lb = fn("loadLeaderboard");
  check("the leaderboard scores through _lbScoreUsers (no private copy to drift)",
    /_lbScoreUsers\(rows,/.test(lb) && !/var users=\{\};/.test(lb));
  const cr = fn("computeCardRecap");
  check("the recap's standings and ranks come from _lbScoreUsers",
    (cr.match(/_lbScoreUsers\(/g) || []).length === 3);
}

// --- wiring ---------------------------------------------------------------
// Locked like What's New: only the X and "Got it" dismiss it.
{
  const tag = (html.match(/<div id="recap-overlay"[^>]*>/) || [""])[0];
  check("recap overlay exists with no backdrop-click handler", tag && !/onclick/.test(tag));
  const esc = (html.match(/var _escClosers=\[[\s\S]*?\n\];/) || [""])[0];
  check("recap is NOT in _escClosers (Escape must not dismiss it)", esc && !/recap-overlay/.test(esc));
  check("Escape is swallowed while the recap is open (never closes the board beneath)",
    /Escape[\s\S]{0,400}recap-overlay[\s\S]{0,120}preventDefault\(\);return;/.test(html));
  const a = html.indexOf('<div id="recap-overlay"'), b = html.indexOf("</div>\n</div>", a);
  const markup = html.slice(a, b);
  check("exactly two controls close it: the X and \"Got it\"",
    (markup.match(/closeCardRecap\(\)/g) || []).length === 2 &&
    /id="rc-close-btn"/.test(markup) && /id="rc-gotit-btn"[^>]*>Got it</.test(markup));
  check("focus moves to \"Got it\" on open", /rc-gotit-btn"\)\.focus\(\)/.test(fn("renderCardRecap")));
  check("Tab is trapped between the X and \"Got it\"",
    /onkeydown="_rcTrapFocus\(event\)"/.test(markup) && /rc-close-btn[\s\S]*rc-gotit-btn/.test(fn("_rcTrapFocus")));
}
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
