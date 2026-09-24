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
try { K = PE.loadKernel(html, env); check("kernel lifts scoring + model + intel out of index.html", true); }
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
const repo = JSON.parse(readFileSync(join(ROOT, "events-extra.json"), "utf8"));
check("committed events-extra.json validates with no problems", PE.validateFeed(repo).problems.length === 0);

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

// 4. Fight IQ: no claims under the sample floor, no leaking the result.
const iq = FL.fightIQ(res.filter((p) => p.player === "u-Andy"), { odds: idx, stats: {}, group: res });
check("Fight IQ calls a thin history Casual", iq.archetype.key === "casual");
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

// 8. Wiring: the app links to the lab, and the SW never serves one page as the other.
check("index.html links to lab.html from the More menu", /id="labBtn"[^>]*href="lab\.html"|href="lab\.html"[^>]*id="labBtn"/.test(html));
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
check("sw.js caches lab.html under its own key (never over the app shell './')", /lab\.html/.test(sw) && /'\.\/lab\.html'/.test(sw));
check("sw.js keeps the lab's data network-first", /odds-series\.json/.test(sw) && /\/lab\//.test(sw));

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
    const page = await browser.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push("Uncaught: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("Console: " + m.text()); });
    await page.route(/supabase\.co/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(stub) }));
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
    await page.click('#tabs button[data-tab="iq"]');
    const iqTxt = await page.evaluate(() => document.getElementById("main").innerText);
    check("Fight IQ opens on the viewer's own picks and shows an archetype", /\(you\)/.test(await page.evaluate(() => document.querySelector("select").selectedOptions[0].textContent)) && /Record/.test(iqTxt));
    check("lab page boots under its CSP with no uncaught or console errors", errs.length === 0 || (console.error(errs.join("\n")), false));
    await page.close();

    // The app still boots and exposes the entry point.
    const app = await browser.newPage();
    const appErrs = [];
    app.on("pageerror", (e) => appErrs.push(e.message));
    await app.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await app.waitForTimeout(500);
    check("the app's More menu carries the Fight Lab link", await app.evaluate(() => { const a = document.getElementById("labBtn"); return !!a && a.getAttribute("href") === "lab.html"; }));
    check("the app boots with the link added (no uncaught errors)", appErrs.length === 0 || (console.error(appErrs.join("\n")), false));
    await app.close();
  } finally { await browser.close(); server.close(); }
}

if (failures) { console.error(`\ncheck-lab: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-lab: Fight Lab reads the board's numbers and boots cleanly.");
