// Guard: Year Wrapped must tell each player about their year the way the
// board and the belt already scored it.
//
// Wrapped is a third reader of the pick rows (after the board and the card
// recap), so its failure mode is the recap's: drift. A Wrapped that says #2
// while the board says #3, counts last year's picks, crowns a reign Title
// History doesn't, or calls a missed underdog your "biggest upset" doesn't
// throw — it just says something false on a screen people screenshot and
// share. So this runs the REAL scoring (fighter-names + pick-match blocks,
// _eventFinished, computeBeltLineage, _lbScoreUsers and the recap helpers)
// under the Wrapped and checks its answers, then checks the wiring.
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
const splitNick = (n) => ({ name: String(n || "").replace(/^\S+\s+/, "") });
const ctx = vm.createContext({
  console: { log() {}, warn() {}, error: console.error },   // _lbScoreUsers logs every hit
  String, Object, Array, JSON, Math, Date, isFinite,
  DAY_MS: DAY, EVENTS: [], RESULTS_ARCHIVE: {}, lbScope: "all", MAIN_CARD_BOUTS: 5,
  USER_ID: null, splitNick,
});
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("pick-match"), ctx);
vm.runInContext(fn("_eventFinished"), ctx);
vm.runInContext(fn("computeBeltLineage"), ctx);
vm.runInContext(fn("_lbScoreUsers"), ctx);
vm.runInContext(block("card-recap"), ctx);
vm.runInContext(block("year-wrapped"), ctx);
// The slide builder is pure (strings in, strings out); the rest of the UI
// block touches the DOM and is only checked for wiring below.
vm.runInContext(fn("_wrShort") + fn("_wrPlural") + 'var _WR_METHOD={"KO/TKO":"KO/TKO","Sub":"Submission","Dec":"Decision"};' +
  fn("_wrLineTxt") + fn("_wrNailedHow") + fn("wrappedSlides") + fn("_wrShareText"), ctx);

const bout = (a, b, winner, odds, method) => ({
  f1: { n: a }, f2: { n: b }, winner: winner || "", state: winner ? "post" : "pre",
  method: winner ? (method || "KO/TKO") : "", odds: odds || null,
});
const pick = (who, date, a, b, p, extra) =>
  Object.assign({ nickname: "🥊 " + who, event_date: date, f1: a, f2: b, pick: p }, extra || {});
const wrap = (rows, year, me) => ctx.computeYearWrapped(rows, year, me);

// --- fixture: three 2026 cards and one 2025 card (archived) ----------------
const OLD = "2025-12-13", C1 = "2026-08-29", C2 = "2026-09-12", C3 = "2026-09-19";
ctx.RESULTS_ARCHIVE = { [OLD]: { name: "UFC Last Year", fights: [
  { f1: "Z1", f2: "Y1", winner: "Z1", method: "KO/TKO" },
  { f1: "Z2", f2: "Y2", winner: "Z2", method: "KO/TKO" },
  { f1: "Z3", f2: "Y3", winner: "Z3", method: "KO/TKO" },
] } };
const card1 = { name: "UFC Fight Night: One", date: C1, fotn: "A1", fights: [
  bout("A1", "B1", "A1", { f1: -200, f2: 170 }),
  bout("A2", "B2", "B2", { f1: -300, f2: 260 }),     // B2 +260
  bout("A3", "B3", "A3", { f1: -150, f2: 130 }, "Decision (Unanimous)"),
] };
const card2 = { name: "UFC Fight Night: Two", date: C2, fights: [
  bout("A1", "C1", "A1", { f1: -400, f2: 320 }),
  bout("C2", "D2", "D2", { f1: -500, f2: 400 }),     // D2 +400
  bout("C3", "D3", "C3", { f1: -120, f2: 100 }),
  bout("C4", "D4", "C4"),
] };
const card3 = { name: "UFC 331: Three", date: C3, fights: [
  bout("E1", "F1", "E1", { f1: -110, f2: -110 }),
  bout("A1", "F2", "F2", { f1: -250, f2: 200 }),
  bout("E3", "F3", "E3"),
] };
ctx.EVENTS = [card1, card2, card3];

const rows = [
  // Last year: Ann swept an archived card. None of it may reach 2026.
  pick("Ann", OLD, "Z1", "Y1", "Z1"), pick("Ann", OLD, "Z2", "Y2", "Z2"), pick("Ann", OLD, "Z3", "Y3", "Z3"),
  pick("Bob", OLD, "Z1", "Y1", "Y1"),
  // Card 1 — Ann perfect (with the +260 dog and FOTN), Bob 1/3.
  pick("Ann", C1, "A1", "B1", "A1", { method: "KO/TKO", bonus_pick: "A1" }),
  pick("Ann", C1, "A2", "B2", "B2", { method: "Sub" }),
  pick("Ann", C1, "A3", "B3", "A3", { method: "Dec" }),
  pick("Bob", C1, "A1", "B1", "A1"), pick("Bob", C1, "A2", "B2", "A2"), pick("Bob", C1, "A3", "B3", "B3"),
  // Card 2 — Ann takes the -500 favourite and loses; Bob calls the +400 dog.
  pick("Ann", C2, "A1", "C1", "A1", { method: "KO/TKO" }),
  pick("Ann", C2, "C2", "D2", "C2", { method: "KO/TKO" }),
  pick("Ann", C2, "C3", "D3", "D3", { method: "KO/TKO" }),
  pick("Ann", C2, "C4", "D4", "C4", { method: "KO/TKO" }),
  pick("Bob", C2, "A1", "C1", "A1"), pick("Bob", C2, "C2", "D2", "D2"), pick("Bob", C2, "C3", "D3", "C3"), pick("Bob", C2, "C4", "D4", "C4"),
  // Card 3 — Ann backs A1 a third time and loses; Bob sits it out.
  pick("Ann", C3, "E1", "F1", "E1"), pick("Ann", C3, "A1", "F2", "A1"), pick("Ann", C3, "E3", "F3", "E3"),
  // Cat agrees with Ann on almost everything.
  pick("Cat", C1, "A1", "B1", "A1"), pick("Cat", C1, "A2", "B2", "B2"), pick("Cat", C1, "A3", "B3", "A3"),
  pick("Cat", C2, "A1", "C1", "A1"), pick("Cat", C2, "C2", "D2", "C2"), pick("Cat", C2, "C3", "D3", "C3"),
];

const board26 = ctx._lbScoreUsers(ctx._recapBoardOrder(rows), (p) => p.event_date.slice(0, 4) === "2026");
const boardRank = (base) => 1 + board26.filter((v) => ctx.userPts(v) > ctx.userPts(board26.find((u) => ctx._lbBaseName(u.nickname) === base))).length;

// --- which year ------------------------------------------------------------
check("wrappedYear is the newest year with a scored pick", ctx.wrappedYear(rows, "ann") === "2026");
check("a year with only unscored picks is not wrapped",
  ctx.wrappedYear([pick("Dee", "2027-01-10", "Q1", "Q2", "Q1")], "dee") === null);
check("someone with no picks has no Wrapped", ctx.wrappedYear(rows, "nobody") === null && wrap(rows, "2026", "nobody") === null);

// --- the numbers are the board's numbers, for this year only ---------------
const ann = wrap(rows, "2026", "ann");
const bob = wrap(rows, "2026", "bob");
{
  const b = board26.find((u) => /Ann/.test(u.nickname));
  check("points equal the board's points scoped to the year", ann.pts === ctx.userPts(b));
  check("last year's archived sweep is not counted", ann.picks === 10 && ann.cards === 3);
  check("record and accuracy match the board", ann.correct === b.correct && ann.accuracy === b.accuracy);
  check("every player's rank equals the year-scoped board rank",
    ["ann", "bob", "cat"].every((x) => wrap(rows, "2026", x).rank === boardRank(x)) && ann.of === 3);
  check("longest heater is the board's best streak", ann.bestStreak === b.bestStreak);
}

// --- best night, perfect cards, FOTN ---------------------------------------
{
  // Card 1: 3 winners + KO/TKO and Dec methods (+1) + B2 +260 (+1) + FOTN (+1) = 6.
  check("best night is card 1 with FOTN, methods and the dog bonus", ann.bestCard.date === C1 && ann.bestCard.pts === 6);
  check("a 3/3 card counts as perfect; a 3/4 doesn't", ann.perfectCards === 1);
  const perCard = [C1, C2, C3].map((d) => {
    const u = ctx._lbScoreUsers(ctx._recapBoardOrder(rows), (p) => p.event_date === d).find((x) => /Ann/.test(x.nickname));
    return u ? ctx.userPts(u) : 0;
  });
  check("best night equals the board's This-Event points for that card", ann.bestCard.pts === Math.max(...perCard));
}

// --- upsets and lines ------------------------------------------------------
check("biggest upset is the longest-priced winner called", ann.upset && ann.upset.pick === "B2" && ann.upset.line === 260);
check("a called +400 beats a +260", bob.upset && bob.upset.pick === "D2" && bob.upset.line === 400);
check("a +100 pick is an underdog; a -110 pick'em and an unpriced bout are not", ann.dogs === 2 && ann.priced === 8);

// --- ride-or-die, method, twin, nemesis ------------------------------------
check("ride-or-die is the fighter backed most (A1 ×3, 2–1)", ann.ride && ann.ride.name === "A1" && ann.ride.n === 3 && ann.ride.w === 2);
{
  // Dee backs two different fighters once each and misses her only dog (+130).
  const dee = wrap(rows.concat([pick("Dee", C1, "A1", "B1", "A1"), pick("Dee", C1, "A3", "B3", "B3")]), "2026", "dee");
  check("a fighter backed once is nobody's ride-or-die", dee.ride === null);
  check("a missed underdog is not an upset", dee.upset === null && dee.dogs === 1);
}
{
  // Fighters appear about twice a year, so "backed most" is usually a tie across
  // many 2-for-2s. A ride-or-die needs WRAPPED_RIDE_MIN picks and a clear lead.
  check("backed twice isn't a ride-or-die (Cat: A1 ×2)", wrap(rows, "2026", "cat").ride === null);
  const tie = rows.concat([
    pick("Ann", "2026-09-26", "E3", "G1", "E3"), pick("Ann", "2026-10-03", "E3", "G2", "E3"),
  ]);
  ctx.EVENTS = [card1, card2, card3,
    { name: "UFC Four", date: "2026-09-26", fights: [bout("E3", "G1", "E3")] },
    { name: "UFC Five", date: "2026-10-03", fights: [bout("E3", "G2", "E3")] }];
  // Ann now backs A1 ×3 (2–1) and E3 ×3 (3–0): no clear leader, so nobody —
  // not whichever of them the pick rows happen to reach first.
  check("a tie at the top is no ride-or-die, however the wins split", wrap(tie, "2026", "ann").ride === null);
  ctx.EVENTS = [card1, card2, card3];
}
// Nailed it: winner AND method, longest line. Ann's method hits are A1 KO (-200),
// A3 Dec (-150), A1 KO (-400) and C4 KO (unpriced): A3 at -150 is the longest.
check("nailed it is the winner+method call at the longest line", ann.nailed && ann.nailed.pick === "A3" &&
  ann.nailed.method === "Dec" && ann.nailed.line === -150 && ann.nailed.opp === "B3");
check("no method hits, nothing nailed", wrap(rows, "2026", "cat").nailed === null);
{
  // Unpriced ties: Eve's three method hits are all on unpriced bouts. The rarer
  // finish wins (Sub over KO/TKO), then the newer card (C3 over C2) — in any
  // row order.
  const ev = [
    pick("Eve", C2, "C4", "D4", "C4", { method: "KO/TKO" }),
    pick("Eve", C3, "E3", "F3", "E3", { method: "KO/TKO" }),
  ];
  const n1 = wrap(ev, "2026", "eve").nailed, n2 = wrap(ev.slice().reverse(), "2026", "eve").nailed;
  check("unpriced ties go to the most recent card, whatever the row order", n1.pick === "E3" && n2.pick === "E3");
  // The submission is on the OLDER card, so recency alone would pick the KO.
  ctx.EVENTS = [card1, Object.assign({}, card2, { fights: card2.fights.map((f) => f.f1.n === "C4" ? Object.assign({}, f, { method: "Submission" }) : f) }), card3];
  const subRows = [pick("Eve", C2, "C4", "D4", "C4", { method: "Sub" }), pick("Eve", C3, "E3", "F3", "E3", { method: "KO/TKO" })];
  check("a submission call outranks a newer KO/TKO call at the same (missing) line, in either row order",
    [subRows, subRows.slice().reverse()].every((r) => { const n = wrap(r, "2026", "eve").nailed; return n.pick === "C4" && n.method === "Sub"; }));
  // Same card, same finish, both unpriced: the bigger fight (higher on the
  // card) wins, then the name — in either row order.
  // Names are chosen so alphabetical order would pick the OTHER bout.
  ctx.EVENTS = [card1, card2, { name: "UFC Six", date: C3, fights: [bout("H1", "J1", "H1"), bout("Zed", "J2", "Zed"), bout("Abe", "J3", "Abe")] }];
  const same = [pick("Eve", C3, "Abe", "J3", "Abe", { method: "KO/TKO" }), pick("Eve", C3, "Zed", "J2", "Zed", { method: "KO/TKO" })];
  check("same card, same finish: the fight higher on the card wins, in either row order",
    [same, same.slice().reverse()].every((r) => wrap(r, "2026", "eve").nailed.pick === "Zed"));
  // Last resort (bout not found anywhere): the name, so row order still can't decide.
  check("with nothing else to go on, the fighter's name decides — not row order",
    ctx._wrNailedBeats({ rank: -Infinity, rare: 2, date: C3, idx: 999, key: "pp" }, { rank: -Infinity, rare: 2, date: C3, idx: 999, key: "qq" }) &&
    !ctx._wrNailedBeats({ rank: -Infinity, rare: 2, date: C3, idx: 999, key: "qq" }, { rank: -Infinity, rare: 2, date: C3, idx: 999, key: "pp" }));
  ctx.EVENTS = [card1, card2, card3];
}
{
  // Cat's only winner+method hit is B2 by KO at +260 — already her biggest
  // upset, which has its own row. Nailed it must not repeat it.
  const cr = rows.map((p) => /Cat/.test(p.nickname) && p.f2 === "B2" ? Object.assign({}, p, { method: "KO/TKO" }) : p);
  const c = wrap(cr, "2026", "cat");
  check("nailed it never repeats the biggest upset", c.upset && c.upset.pick === "B2" && c.nailed === null);
}
{
  const s = ctx.wrappedSlides(Object.assign({}, ann, { ride: null }));
  const n = s.find((x) => /exactly/.test(x.kicker));
  check("without a ride-or-die the slide becomes 'You called it exactly'",
    n && n.big === "A3" && /by decision over B3 at -150/.test(n.sub) && !s.some((x) => /ride-or-die/.test(x.kicker)));
  check("with a ride-or-die there's no separate nailed-it slide",
    !ctx.wrappedSlides(ann).some((x) => /exactly/.test(x.kicker)));
}
check("go-to finish is the most-called method", ann.goTo === "KO/TKO" && ann.methodPicks === 7 && ann.methodHits === 4);
check("pick twin is the highest agreement rate (Cat, 5 of 6)", ann.twin && /Cat/.test(ann.twin.name) && ann.twin.pct === 83 && ann.twin.shared === 6);
check("nemesis is the lowest agreement rate (Bob)", ann.nemesis && /Bob/.test(ann.nemesis.name) && ann.nemesis.pct === 43);
{
  const two = rows.filter((p) => !/Cat/.test(p.nickname));
  const a2 = wrap(two, "2026", "ann");
  check("with one rival, they're the twin and there's no separate nemesis", /Bob/.test(a2.twin.name) && a2.nemesis === null);
  const few = wrap(rows.filter((p) => /Ann/.test(p.nickname) || (/Bob/.test(p.nickname) && p.event_date === C1)), "2026", "ann");
  check("fewer than WRAPPED_TWIN_MIN shared bouts makes nobody a twin", few.twin === null);
}

// --- the belt ---------------------------------------------------------------
{
  const belt = ctx.computeBeltLineage(rows);
  const mine = belt.reigns.filter((r) => r.base === "ann" && r.date.startsWith("2026"));
  const defs26 = belt.reigns.filter((r) => r.base === "ann")
    .reduce((n, r) => n + r.defDates.filter((d) => d.startsWith("2026")).length, 0);
  check("title reigns are Title History's 2026 reigns",
    ann.title.reigns === mine.length && ann.title.defenses === defs26);
  // Ann's 2025 reign was defended on card 1 (2026): that defence is 2026's.
  check("a defence made this year counts even when the reign began last year",
    ann.title.defenses === 1 && belt.reigns.find((r) => r.date === OLD).defDates[0] === C1);
  {
    // Carried in and never lost: no 2026 win, only defences — still a belt year.
    const carried = rows.filter((p) => !(p.event_date === C2 && /Bob/.test(p.nickname)) && p.event_date !== C3);
    const w = wrap(carried, "2026", "ann");
    check("a champion who only defended this year is not told \"Not this year\"",
      w.title.reigns === 0 && w.title.defenses === 2 && w.title.holding &&
      /champ/i.test(ctx.wrappedSlides(w).find((x) => /belt/.test(x.kicker)).big));
    check("carried-in defences make that champion the year's longest holder", /Ann/.test(wrap(carried, "2026", "bob").title.king.name));
  }
  check("holding flag follows the current champion", ann.title.holding === (belt.holderBase === "ann"));
  // Ann won it on last year's card and took it back on card 3: one 2026 reign.
  check("a reign begun last year is not a 2026 reign", belt.reigns.some((r) => r.base === "ann" && r.date === OLD) && ann.title.reigns === 1);
  check("the year's longest-held title is named for a player without one", bob.title.king && bob.title.king.cards >= 1);
}

// --- identities -------------------------------------------------------------
{
  const dup = rows.map((p) => Object.assign({ updated_at: "2026-09-20T00:00:00Z" }, p)).concat([
    pick("Bob", C1, "B1", "A1", "B1", { user_id: "old", updated_at: "2026-08-01T00:00:00Z" }),
  ]);
  const w = wrap(dup, "2026", "bob");
  check("a stale duplicate identity is deduped exactly as the board does", w.picks === bob.picks && w.pts === bob.pts);
}

// --- personality -----------------------------------------------------------
{
  const A = ctx.WRAPPED_ARCHETYPES, pickA = (s) => A.find((a) => a.test(s)).id;
  const base = { total: 40, accuracy: 55, priced: 30, dogShare: 0.2, methodPicks: 20, finishShare: 0.6, decShare: 0.4 };
  check("65%+ over 15 picks is The Oracle", pickA({ ...base, accuracy: 66 }) === "oracle");
  check("an Oracle rate on a handful of picks is not", pickA({ ...base, total: 6, accuracy: 100 }) !== "oracle");
  check("30%+ dogs is Underdog Hunter", pickA({ ...base, dogShare: 0.35 }) === "hunter");
  check("75%+ finishes is Violence Enjoyer", pickA({ ...base, finishShare: 0.8, decShare: 0.2 }) === "violence");
  check("half decisions is Scorecard Scholar", pickA({ ...base, finishShare: 0.5, decShare: 0.5 }) === "scholar");
  check("almost no dogs is Chalk Connoisseur", pickA({ ...base, dogShare: 0.05 }) === "chalk");
  check("everyone gets one", pickA({ total: 1, accuracy: 0, priced: 0, dogShare: 0, methodPicks: 0, finishShare: 0, decShare: 0 }) === "tactician");
  check("the Wrapped carries an archetype", ann.archetype && ann.archetype.name);
}

// --- slides ----------------------------------------------------------------
{
  const s = ctx.wrappedSlides(ann);
  check("slides open on an intro and close on the summary", /Wrapped/.test(s[0].kicker) && s[s.length - 1].summary === true);
  check("every non-summary slide has a headline", s.every((x) => x.summary || (x.big && String(x.big).length)));
  const sparse = Object.assign({}, bob, { upset: null, ride: null, nailed: null, twin: null, nemesis: null, goTo: null, bestStreak: 1 });
  const ss = ctx.wrappedSlides(sparse);
  check("slides with nothing to say are skipped, not shown blank",
    !ss.some((x) => /upset|ride-or-die|exactly|twin|heater|go-to/i.test(x.kicker)));
  check("share text carries rank, points and personality",
    /#\d+ of 3/.test(ctx._wrShareText(ann)) && ctx._wrShareText(ann).includes(ann.archetype.name));
}

// --- the December popup ------------------------------------------------------
{
  const due = (m, d, seen, r) => ctx.wrappedPopupDue(r || rows, "ann", new Date(2026, m, d, 12), seen);
  check("due in December for the year being lived", due(11, 1, "") === "2026" && due(11, 31, null) === "2026");
  check("not due in November or January", due(10, 30, "") === null && ctx.wrappedPopupDue(rows, "ann", new Date(2027, 0, 2, 12), "") === null);
  check("once a year: a checkpointed year is not shown again", due(11, 15, "2026") === null);
  check("last year's checkpoint doesn't block this year", due(11, 15, "2025") === "2026");
  check("no scored pick this year, no popup", due(11, 15, "", rows.filter((p) => p.event_date === OLD)) === null);
  check("no name, no popup", ctx.wrappedPopupDue(rows, "", new Date(2026, 11, 5), "") === null);
  const cw = fn("closeWrapped");
  check("closing in December checkpoints the year (auto-opened or by hand)",
    /getMonth\(\)===11/.test(cw) && /WRAPPED_SEEN_KEY/.test(cw));
  const cp = fn("checkWrappedPopup");
  check("the popup waits behind What's New and a card recap instead of stacking",
    /wn-overlay/.test(cp) && /recap-overlay/.test(cp) && /_recapQueued/.test(cp) && /_wrQueued=true/.test(cp));
  check("closing What's New or the recap releases a queued Wrapped",
    /_wrappedAfterOverlay\(\)/.test(fn("_recapAfterWn")) && /_wrappedAfterOverlay\(\)/.test(fn("closeCardRecap")) &&
    /_recapAfterWn\(\)/.test(fn("closeWhatsNew")));
  const f = fn("fetchCommunityPicks");
  check("fed by the boot-time community fetch, after the recap check",
    /checkCardRecap\(rows\)[\s\S]*checkWrappedPopup\(rows\)/.test(f));
}

// --- one scorer, not three -------------------------------------------------
{
  const cw = fn("computeYearWrapped");
  check("Wrapped scores through _lbScoreUsers and replays the belt via computeBeltLineage",
    /_lbScoreUsers\(/.test(cw) && /computeBeltLineage\(/.test(cw) && !/users\[uid\]/.test(cw));
}

// --- wiring ----------------------------------------------------------------
{
  const ui = block("year-wrapped-ui");
  check("the UI never writes markup from data (textContent only)", !/innerHTML/.test(ui));
  const a = html.indexOf('<div id="wr-overlay"'), b = html.indexOf("</div>\n</div>", a);
  const markup = html.slice(a, b);
  check("overlay exists with Previous / Next as real buttons and an X",
    /id="wr-prev"[^>]*onclick="wrappedStep\(-1\)"/.test(markup) && /id="wr-next"[^>]*onclick="wrappedStep\(1\)"/.test(markup) &&
    /id="wr-close-btn"[^>]*onclick="closeWrapped\(\)"/.test(markup));
  check("the dialog handles its own keys (arrows + Tab trap)", /onkeydown="_wrKey\(event\)"/.test(markup) &&
    /ArrowRight[\s\S]*ArrowLeft[\s\S]*Tab/.test(fn("_wrKey")));
  const esc = (html.match(/var _escClosers=\[[\s\S]*?\n\];/) || [""])[0];
  const wi = esc.indexOf("wr-overlay"), li = esc.indexOf("lbPanel");
  check("Escape closes Wrapped before the board beneath it", wi >= 0 && li > wi);
  const ow = fn("openWrapped"), cl = fn("closeWrapped");
  check("the scroll lock is only released if Wrapped took it (it doesn't nest)",
    /_wrLocked=document\.body\.style\.position!=="fixed"/.test(ow) && /if\(_wrLocked\)unlockScroll\(\)/.test(cl));
  check("focus returns to where it was on close", /_wrPrevFocus\.focus\(\)/.test(cl));
  check("Wrapped reads the polled community rows before the board's snapshot",
    /return _commRows\|\|_lbRows/.test(fn("_wrRows")));
  // Share hands over an IMAGE. It's drawn when Wrapped opens so the share call
  // itself runs synchronously inside the tap — iOS drops the sheet otherwise.
  check("the share image is drawn up front, when Wrapped opens", /_wrPrepareImage\(w\)/.test(ow));
  const sw = fn("shareWrapped");
  check("Share sends the card as a PNG file where files can be shared",
    /navigator\.canShare\(\{files:\[f\]\}\)/.test(sw) && /navigator\.share\(\{files:\[f\]/.test(sw));
  check("nothing async sits between the tap and navigator.share",
    !/toBlob|_wrPrepareImage|\bawait\b|\.then\(/.test(sw.slice(0, sw.indexOf("navigator.share("))));
  check("no file sharing (desktop): the image downloads instead", /_wrDownload\(f\)/.test(sw) && /a\.download=f\.name/.test(fn("_wrDownload")));
  check("a failed image draw falls back to text, not 'still drawing' forever",
    /_wrFileState==="failed"\)\{_wrShareTextOnly\(\)/.test(sw) && /_wrFileState="failed"/.test(fn("_wrPrepareImage")));
  {
    // After navigator.share rejects, the tap's activation is spent: the
    // fallback must not call navigator.share again.
    const onFail = sw.slice(sw.indexOf(".catch("), sw.indexOf("});", sw.indexOf(".catch("))).replace(/\/\/[^\n]*/g, "");
    check("a rejected image share falls back without a second navigator.share",
      /_wrDownload\(f\)/.test(onFail) && !/_wrShareTextOnly|navigator\.share/.test(onFail));
  }
  check("the card is story-sized (1080×1920)", /WR_CARD_W=1080,WR_CARD_H=1920/.test(html));
  check("reachable from the More menu", /id="wrappedBtn"[^>]*openWrapped\(\)/.test(html));
  check("reachable from the leaderboard", /wrappedYear\(rows,/.test(fn("loadLeaderboard")) && /openWrapped\(\)/.test(fn("loadLeaderboard")));
}

if (failures) { console.error(`\ncheck:wrapped — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:wrapped — all good");
