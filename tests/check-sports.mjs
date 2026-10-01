// check:sports — the sport switcher (UFC | PFL | ...).
//
// What it must never do:
//   - show up (or change anything) when the feed has nothing to pick
//   - put another promotion's pick anywhere near UFC: its row must say its
//     promotion, UFC's local picks must be untouched, the Ranks board must be
//     that promotion's own
//   - let a pick through after its card's lock time, or on a decided bout
//   - render feed text (fighter / event names) as HTML
//   - score a pick on a bout that isn't on that promotion's card
//
// Unit checks run scoring.js's sportStandings; the rest boots the real app
// headlessly with a fixture feed and a stubbed Supabase.
import vm from "node:vm";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Pick buttons show surnames ("One"), so a bout is found by a fighter's full name.
async function pickBy(page, full) {
  const ok = await page.evaluate((n) => {
    for (const r of document.querySelectorAll("#sportApp .fight-row")) {
      const fn = [...r.querySelectorAll(".fn")].map((x) => x.textContent), i = fn.indexOf(n);
      if (i >= 0) { r.querySelectorAll(".pick-row .pick-btn")[i].click(); return true; }
    }
    return false;
  }, full);
  if (!ok) throw new Error("no bout for " + full);
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, ok) => { if (ok) console.log("  ✓ " + name); else { failures++; console.error("  ✗ " + name); } };

// --- scoring -----------------------------------------------------------------------
{
  const ctx = vm.createContext({ String, Object, Array, JSON, Math, Date, isFinite, Number, console });
  vm.runInContext(readFileSync(join(ROOT, "scoring.js"), "utf8"), ctx);
  const events = [
    { promotion: "pfl", date: "2026-10-16", name: "PFL Chicago", bouts: [
      { a: "Liz Carmouche", b: "Jena Bishop", winner: "Jena Bishop" },
      { a: "Timur Khizriev", b: "Gabriel Braga", winner: "Timur Khizriev" },
      { a: "Open A", b: "Open B", winner: "" } ] },
  ];
  const r = (uid, nick, f1, f2, pick, extra) => Object.assign({ user_id: uid, nickname: nick, promotion: "pfl", event_date: "2026-10-16", f1, f2, pick }, extra || {});
  const rows = [
    r("u1", "🥊 Ann", "Liz Carmouche", "Jena Bishop", "Jena Bishop"),
    r("u1", "🥊 Ann", "Gabriel Braga", "Timur Khizriev", "Timur Khizriev"),       // flipped corners
    r("u1", "🥊 Ann", "Open A", "Open B", "Open A"),
    r("u2", "🦂 Bob", "Liz Carmouche", "Jena Bishop", "Liz Carmouche"),
    r("u2", "🦂 Bob", "Not On", "The Card", "Not On"),                            // no such bout
    r("u3", "🐺 UFC", "Liz Carmouche", "Jena Bishop", "Jena Bishop", { promotion: "ufc" }),
    r(null, "constructor", "Liz Carmouche", "Jena Bishop", "Jena Bishop"),
  ];
  const s = ctx.sportStandings(rows, events, "pfl");
  const by = Object.fromEntries(s.map((u) => [u.nickname, u]));
  check("1 point per correct winner, flipped corners matched", by["🥊 Ann"].pts === 2 && by["🥊 Ann"].correct === 2 && by["🥊 Ann"].resolved === 2 && by["🥊 Ann"].total === 3);
  check("an undecided bout counts as open, not wrong", by["🥊 Ann"].accuracy === 100);
  check("a pick on a bout that isn't on the card doesn't count", by["🦂 Bob"].total === 1 && by["🦂 Bob"].pts === 0);
  check("another promotion's rows (UFC) never score here", !by["🐺 UFC"]);
  check("a player named after an Object.prototype key scores normally", by["constructor"] && by["constructor"].pts === 1);
  check("ranked by points, then accuracy", s[0].nickname === "🥊 Ann");
  check("a different promotion's board is empty for these rows", ctx.sportStandings(rows, events, "one").length === 0);
  // Flipped corners / a re-spelling leave a second row for the same bout
  // (the upsert key is ordered): one pick per player per bout, newest wins.
  const dup = [
    r("u9", "🐯 Dee", "Jena Bishop", "Liz Carmouche", "Jena Bishop"),            // newest (rows are newest-first)
    r("u9", "🐯 Dee", "Liz Carmouche", "Jena Bishop", "Liz Carmouche"),          // older, other corner order
    r("u9", "🐯 Dee", "Liz Carmouche", "Jéna Bishop", "Liz Carmouche"),          // older, old spelling
  ];
  const d = ctx.sportStandings(dup, events, "pfl")[0];
  check("one pick per player per bout (flip / re-spelling rows don't double-count), newest wins", d.total === 1 && d.pts === 1);
}

// --- UFC rules on the other sports ----------------------------------------------------
// PFL / RIZIN / DWCS are MMA, so their board scores through pickPts, the same
// function the UFC board uses: winner 1, method +0.5, underdog bonus off the
// bout's line, 🔒 +1 / -1 (only on cards from LOCKS_START). Separate boards, one rulebook.
{
  const ctx = vm.createContext({ String, Object, Array, JSON, Math, Date, isFinite, Number, console });
  vm.runInContext(readFileSync(join(ROOT, "scoring.js"), "utf8"), ctx);
  const D = "2026-10-16";
  const events = [{ promotion: "pfl", date: D, name: "PFL X", bouts: [
    { a: "Big Dog", b: "Chalk Fav", winner: "Big Dog", method: "KO/TKO", odds: { a: 300, b: -400 } },   // +300 dog wins
    { a: "Mid Dog", b: "Mid Fav", winner: "Mid Dog", method: "Decision (unanimous)", odds: { a: 200, b: -250 } },   // +200 dog wins
    { a: "Short Dog", b: "Short Fav", winner: "Short Dog", method: "Submission (rear-naked choke)", odds: { a: 120, b: -140 } },
    { a: "No Line A", b: "No Line B", winner: "No Line A", method: "KO/TKO" },                         // the feed had no line
    { a: "Fav Wins", b: "Dog Loses", winner: "Fav Wins", method: "Decision (split)", odds: { a: -500, b: 350 } },
    { a: "Open A", b: "Open B", winner: "", odds: { a: 150, b: -180 } } ] }];
  const row = (uid, f1, f2, pick, method, lock, date) => ({ user_id: uid, nickname: uid, promotion: "pfl", event_date: date || D, f1, f2, pick, method: method || "", confidence: lock ? 1 : 0 });
  const score = (rows) => ctx.sportStandings(rows, events, "pfl")[0];
  const one = (pick, method, lock, f1, f2, date) => score([row("u", f1, f2, pick, method, lock, date)]);
  check("a plain correct winner is still 1 point", one("Big Dog", "", false, "Big Dog", "Chalk Fav").pts === 1 + 1 /* +300 underdog */);
  check("the right method adds 0.5", one("Fav Wins", "Dec", false, "Fav Wins", "Dog Loses").pts === 1.5);
  check("KO/TKO, Sub and Dec all read the feed's method text", one("No Line A", "KO/TKO", false, "No Line A", "No Line B").methods === 1 && one("Short Dog", "Sub", false, "Short Dog", "Short Fav").methods === 1 && one("Mid Dog", "Dec", false, "Mid Dog", "Mid Fav").methods === 1);
  check("the wrong method adds nothing", one("Fav Wins", "Sub", false, "Fav Wins", "Dog Loses").methods === 0 && one("Fav Wins", "Sub", false, "Fav Wins", "Dog Loses").pts === 1);
  check("underdog bonus follows the UFC tiers: +300 earns 1, +200 earns 0.5, +120 earns 0", one("Big Dog", "", false, "Big Dog", "Chalk Fav").dogPts === 1 && one("Mid Dog", "", false, "Mid Dog", "Mid Fav").dogPts === 0.5 && one("Short Dog", "", false, "Short Dog", "Short Fav").dogPts === 0);
  check("a bout with no line in the feed earns no underdog bonus, and doesn't break", one("No Line A", "", false, "No Line A", "No Line B").pts === 1 && one("No Line A", "", false, "No Line A", "No Line B").dogPts === 0);
  check("picking the favourite earns no bonus", one("Fav Wins", "", false, "Fav Wins", "Dog Loses").dogPts === 0);
  check("the bonus is read from the pick's side even when the row's corners are flipped", one("Big Dog", "", false, "Chalk Fav", "Big Dog").dogPts === 1);
  check("a winning lock is +1 on top of the pick", one("Fav Wins", "", true, "Fav Wins", "Dog Loses").pts === 2 && one("Fav Wins", "", true, "Fav Wins", "Dog Loses").lockPts === 1);
  check("a losing lock is -1 (the pick itself earns nothing)", one("Dog Loses", "", true, "Fav Wins", "Dog Loses").pts === -1 && one("Dog Loses", "", true, "Fav Wins", "Dog Loses").lockPts === -1);
  check("a lock on a bout still open scores nothing yet", one("Open A", "", true, "Open A", "Open B").pts === 0);
  const old = one("Fav Wins", "", true, "Fav Wins", "Dog Loses", "2026-09-01");
  check("a lock on a card older than LOCKS_START is ignored (legacy stars never scored)", old === undefined || old.lockPts === 0);
  // Everything at once, and the invariant that matters: the sport board's points
  // are exactly what pickPts gives the UFC board for the same pick and result.
  const all = one("Big Dog", "KO/TKO", true, "Big Dog", "Chalk Fav");
  check("winner + method + underdog + lock add up (1 + 0.5 + 1 + 1 = 3.5)", all.pts === 3.5);
  let same = true;
  for (const b of events[0].bouts) for (const pickName of [b.a, b.b]) for (const method of ["", "KO/TKO", "Sub", "Dec"]) for (const lock of [false, true]) {
    if (!b.winner) continue;
    const got = one(pickName, method, lock, b.a, b.b).pts;
    const want = ctx.pickPts({ pick: pickName, method, confidence: lock ? 1 : 0, event_date: D },
      { winner: b.winner, method: b.method, odds: b.odds ? { f1: b.odds.a, f2: b.odds.b } : null, f1n: b.a, f2n: b.b });
    if (got !== want) same = false;
  }
  check("for every pick, method and lock, the sport board equals pickPts (the UFC board's own function)", same);
  check("the parts add up: correct + methods/2 + underdog + lock = points", (() => { const u = score([row("u", "Big Dog", "Chalk Fav", "Big Dog", "KO/TKO", true), row("u", "Fav Wins", "Dog Loses", "Dog Loses", "", true)]); return u.pts === u.correct + u.methods * 0.5 + u.dogPts + u.lockPts; })());
}

// --- the app ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch {} }
if (!chromium) { failures++; console.error("  ✗ Playwright not installed (npm install)"); }
else {
  const iso = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const future = iso(new Date(now.getTime() + 10 * 86400000));
  const yesterday = iso(new Date(now.getTime() - 1 * 86400000));
  const FEED = {
    promotions: [{ id: "pfl", name: "PFL", sport: "mma" }, { id: "ufc", name: "Fake UFC" }],
    events: [
      { promotion: "pfl", name: "PFL Test Card", date: future, venue: "Wintrust Arena", location: "Chicago", bouts: [
        { a: "Liz Carmouche", b: "Jena Bishop", label: "Main Event", division: "Women's Flyweight", title: true },
        { a: "Timur Khizriev", b: "<img src=x onerror=alert(1)>" } ] },
      { promotion: "pfl", name: "PFL Last Night", date: yesterday, bouts: [
        { a: "Done A", b: "Done B", winner: "Done A" }, { a: "Done C", b: "Done D", winner: "Done D" } ] },
      { promotion: "pfl", name: "Bad Card", date: future, bouts: [{ a: "Same Guy", b: "Same Guy" }] },
    ],
  };
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".mp3": "audio/mpeg" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
  const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
  let slowUfc = false, clampLocks = false, restoreRows = null;
  const boot = async (feed, opts = {}) => {
    const page = await browser.newPage();
    const errors = [], writes = [], reads = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => { errors.push("dialog: " + d.message()); d.dismiss(); });   // an XSS would alert
    await page.addInitScript(() => { try { localStorage.setItem("ufc_uid", "u-Andy"); localStorage.setItem("ufc_name", "🥊 Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999"); } catch (e) {} });
    // Picks need an email account (0015), so every boot is a signed-in player
    // unless it asks to be anonymous; opts.session is the same session, kept
    // for the restore test's sake.
    if (opts.session || !opts.anonymous) await page.addInitScript(() => { try { localStorage.setItem("ufc_sb_session", JSON.stringify({ access_token: "t", refresh_token: "r", user_id: "u-Andy", email: "andy@example.com", expires_at: Math.floor(Date.now() / 1000) + 86400 })); } catch (e) {} });
    if (opts.sportPicks) await page.addInitScript((v) => { try { localStorage.setItem("ufc_sport_picks", v); } catch (e) {} }, JSON.stringify(opts.sportPicks));
    if (feed) await page.route(/events-extra\.json/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feed) }));
    await page.route(/supabase\.co/, async (route) => {
      const req = route.request(), url = req.url();
      if (slowUfc && /promotion=eq\.ufc/.test(url) && /select=user_id,event_name/.test(url)) {
        await new Promise((r) => setTimeout(r, 1500));
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
          { user_id: "u-ufc", nickname: "🥊 UfcGuy", promotion: "ufc", event_date: "2026-01-01", f1: "X", f2: "Y", pick: "X", method: "", confidence: 0, updated_at: "2026-01-01T00:00:00Z" }]) });
      }
      if (/\/rest\/v1\/picks/.test(url)) {
        if (req.method() === "GET") reads.push(url);
        else writes.push({ method: req.method(), url, body: req.postData() });
        // The server's cap trigger clamps a lock past two to 0 and returns the stored row.
        if (clampLocks && req.method() === "POST")
          return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify([Object.assign(JSON.parse(req.postData()), { confidence: 0 })]) });
        if (restoreRows && req.method() === "GET" && /select=event_date,f1,f2,pick/.test(url))
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(restoreRows) });
        if (req.method() === "GET" && /promotion=eq\.pfl/.test(url) && /select=user_id,nickname/.test(url))
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
            { user_id: "u-bob", nickname: "🦂 Bob", promotion: "pfl", event_date: yesterday, f1: "Done A", f2: "Done B", pick: "Done A" },
            { user_id: "u-cat", nickname: "😀 Cat", promotion: "pfl", event_date: yesterday, f1: "Done A", f2: "Done B", pick: "Done B" } ]) });
      }
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1200);
    return { page, errors, writes, reads };
  };
  const state = (page) => page.evaluate(() => ({
    bar: !document.getElementById("sportBar").hidden,
    tabs: [...document.querySelectorAll("#sportBar .sport-tab")].map((b) => b.textContent),
    other: document.body.classList.contains("sport-other"),
    appShown: getComputedStyle(document.getElementById("app")).display !== "none",
    sportShown: !document.getElementById("sportApp").hidden,
    sportText: document.getElementById("sportApp").textContent,
    imgs: document.querySelectorAll("#sportApp img").length,
    picks: localStorage.getItem("ufc_sport_picks"),
    ufcPreds: localStorage.getItem("ufc_preds"),
    sport: localStorage.getItem("ufc_sport"),
  }));
  try {
    {
      // An explicitly empty feed, never the repo's own events-extra.json: that
      // file is live data (extra.py publishes to it), so a test that assumed
      // it was empty broke the first time a card was published and blocked
      // every deploy, live UFC updates included.
      const { page, errors } = await boot({ promotions: [], events: [] });
      const s = await state(page);
      check("empty feed: no switcher, UFC exactly as before", !s.bar && !s.other && s.appShown && !s.sportShown);
      check("empty feed: no page errors", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
      await page.close();
    }
    {
      // A promotion whose only card is long over (or a stub) is not a reason
      // to show the switcher.
      const stale = { promotions: [{ id: "pfl", name: "PFL" }], events: [
        { promotion: "pfl", name: "Old", date: "2020-01-01", bouts: [{ a: "A One", b: "B Two" }, { a: "C Three", b: "D Four" }] },
        { promotion: "pfl", name: "Stub", date: future, bouts: [{ a: "E Five", b: "F Six" }] } ] };
      const { page } = await boot(stale);
      const s = await state(page);
      check("nothing pickable (only an old card and a one-bout stub): no switcher", !s.bar && !s.other);
      await page.close();
    }
    // --- UFC's pick options on the other sports: method, 🔒, the two-per-card cap ---
    {
      const F2 = { promotions: [{ id: "pfl", name: "PFL" }], events: [
        { promotion: "pfl", name: "PFL Locks", date: future, bouts: [
          { a: "Ann One", b: "Ann Two" }, { a: "Bea One", b: "Bea Two" }, { a: "Cat One", b: "Cat Two" } ] }] };
      const { page, errors, writes } = await boot(F2);
      await page.click("#sportBar .sport-tab:nth-child(2)");
      await page.waitForTimeout(300);
      const txt = () => page.evaluate(() => document.getElementById("sportApp").textContent);
      const meta = () => page.evaluate(() => JSON.parse(localStorage.getItem("ufc_sport_meta") || "{}"));
      const nothing = await page.evaluate(() => document.querySelectorAll("#sportApp .method-pick-row").length);
      check("no pick yet: no method or lock controls", nothing === 0);
      await pickBy(page, "Ann One");
      await page.waitForTimeout(250);
      const how = await page.evaluate(() => [...document.querySelectorAll("#sportApp .method-pick-row .pick-btn")].map((b) => b.textContent));
      check("picking a winner shows How: KO/TKO, Sub, Dec (the UFC card's own controls)", JSON.stringify(how) === '["KO/TKO","Sub","Dec"]');
      check("...and the card counts locks: 0/2", /0\/2 locks/.test(await txt()));
      writes.length = 0;
      await page.click('#sportApp .method-pick-row .pick-btn:has-text("KO/TKO")');
      await page.waitForTimeout(250);
      let post = JSON.parse((writes.find((w) => w.method === "POST") || { body: "{}" }).body);
      check("choosing a method saves it with the pick, tagged pfl", post.method === "KO/TKO" && post.pick === "Ann One" && post.promotion === "pfl" && post.confidence === 0);
      await page.click('#sportApp .method-pick-row .pick-btn:has-text("KO/TKO")');
      await page.waitForTimeout(250);
      check("tapping the method again clears it", (await meta())[Object.keys(await meta())[0]].m === "");
      await page.click('#sportApp .method-pick-row .pick-btn:has-text("Dec")');
      await page.waitForTimeout(250);
      writes.length = 0;
      await page.click("#sportApp .lock-btn");
      await page.waitForTimeout(250);
      post = JSON.parse((writes.find((w) => w.method === "POST") || { body: "{}" }).body);
      check("🔒 saves confidence 1 and keeps the method", post.confidence === 1 && post.method === "Dec" && post.promotion === "pfl");
      check("...the card now counts 1/2 locks", /1\/2 locks/.test(await txt()));
      await pickBy(page, "Bea One");
      await page.waitForTimeout(250);
      await page.click('#sportApp .fight-row:has(.fn:text-is("Bea One")) .lock-btn');
      await page.waitForTimeout(250);
      check("a second lock is allowed: 2/2 locks", /2\/2 locks/.test(await txt()));
      await page.click("#sportApp .more-btn");   // bouts past the co-main sit behind "N more fights", as on UFC
      await pickBy(page, "Cat One");
      await page.waitForTimeout(250);
      check("...and the next bout's label says none are left", /No locks left/.test(await txt()));
      writes.length = 0;
      await page.click('#sportApp .fight-row:has(.fn:text-is("Cat One")) .lock-btn');
      await page.waitForTimeout(250);
      const toastTxt = await page.evaluate(() => document.getElementById("toast").textContent);
      check("a third lock is refused (2 per card), nothing sent", /Only 2 locks per card/.test(toastTxt) && !writes.some((w) => w.method === "POST") && Object.values(await meta()).filter((m) => m.l).length === 2);
      await page.click('#sportApp .fight-row:has(.fn:text-is("Ann One")) .lock-btn');       // unlock one
      await page.waitForTimeout(250);
      check("unlocking frees the slot: 1/2 locks", /1\/2 locks/.test(await txt()));
      await pickBy(page, "Ann One");                 // un-pick
      await page.waitForTimeout(250);
      check("un-picking drops the pick's method and lock too", !Object.keys(await meta()).some((k) => /Ann One/.test(k)));
      check("no page errors with method and locks", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
      await page.close();
    }
    // The server is the last word on the cap (two phones on one account).
    {
      clampLocks = true;
      const F3 = { promotions: [{ id: "pfl", name: "PFL" }], events: [{ promotion: "pfl", name: "PFL Clamp", date: future, bouts: [{ a: "Dee One", b: "Dee Two" }, { a: "Eve One", b: "Eve Two" }] }] };
      const { page } = await boot(F3);
      await page.click("#sportBar .sport-tab:nth-child(2)");
      await pickBy(page, "Dee One");
      await page.waitForTimeout(200);
      await page.click("#sportApp .lock-btn");
      await page.waitForTimeout(500);
      const kept = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem("ufc_sport_meta") || "{}")).filter((m) => m.l).length);
      const t = await page.evaluate(() => document.getElementById("toast").textContent);
      check("a lock the server clamps is dropped locally, with a message", kept === 0 && /Lock not saved/.test(t) && /🔓 Lock it/.test(await page.evaluate(() => document.getElementById("sportApp").textContent)));
      clampLocks = false;
      await page.close();
    }
    // A device that lost its storage gets method and lock back with its picks.
    {
      const F4 = { promotions: [{ id: "pfl", name: "PFL" }], events: [{ promotion: "pfl", name: "PFL Back", date: future, bouts: [{ a: "Fay One", b: "Fay Two" }, { a: "Gus One", b: "Gus Two" }] }] };
      restoreRows = [{ event_date: future, f1: "Fay One", f2: "Fay Two", pick: "Fay Two", method: "Sub", confidence: 1 },
                     { event_date: future, f1: "Gus One", f2: "Gus Two", pick: "Gus One", method: "", confidence: 0 }];
      // Restore needs a signed-in user; the harness's mocked auth gives none, so seed a live session.
      const { page } = await boot(F4, { session: true });
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => JSON.parse(localStorage.getItem("ufc_sport_meta") || "{}"));
      const v = Object.entries(m).find(([k]) => /Fay One/.test(k));
      check("a restored pick brings its method and lock back", !!v && v[1].m === "Sub" && v[1].l === 1);
      restoreRows = null;
      await page.close();
    }
    // Picks need an email account: an anonymous tap opens Sign In to Pick and
    // saves nothing, locally or to the server.
    {
      const { page, writes } = await boot(FEED, { anonymous: true });
      await page.click("#sportBar .sport-tab:nth-child(2)");
      await pickBy(page, "Jena Bishop");
      await page.waitForTimeout(400);
      const g = await page.evaluate(() => ({
        open: document.getElementById("acctBg").classList.contains("open"),
        title: document.getElementById("acctTitle").textContent,
        picks: localStorage.getItem("ufc_sport_picks") }));
      check("no email: a pick tap opens Sign In to Pick and saves nothing",
        g.open && g.title === "Sign In to Pick" && !/Jena Bishop/.test(g.picks || "") && !writes.some((w) => w.method === "POST"));
      await page.click("#acctBg .nm-xbtn");
      check("...and dismissing the sheet drops the held pick, so a later sign-in can't make it", await page.evaluate(() => window._pp === null));
      await page.close();
    }
    // A pick this device made before the rule can still be cleared without an
    // account (0015 keeps owner DELETE), the way UFC's undoPick can.
    {
      const legacy = { ["pfl|" + future + "|Liz Carmouche|Jena Bishop"]: "Jena Bishop" };
      const { page, writes } = await boot(FEED, { anonymous: true, sportPicks: legacy });
      await page.click("#sportBar .sport-tab:nth-child(2)");
      await pickBy(page, "Jena Bishop");
      await page.waitForTimeout(400);
      const g = await page.evaluate(() => ({ open: document.getElementById("acctBg").classList.contains("open"), picks: localStorage.getItem("ufc_sport_picks") }));
      check("no email: an old sport pick can still be un-picked (local and server), with no sign-in sheet",
        !g.open && !/Jena Bishop/.test(g.picks || "") && writes.some((w) => w.method === "DELETE" && /promotion=eq\.pfl/.test(w.url)));
      await page.close();
    }
    {
      const { page, errors, writes, reads } = await boot(FEED);
      let s = await state(page);
      check("a card to pick: the switcher shows UFC and PFL (a feed can't claim 'ufc')", s.bar && JSON.stringify(s.tabs) === '["UFC","PFL"]');
      const ufcBefore = s.ufcPreds;
      await page.click("#sportBar .sport-tab:nth-child(2)");
      s = await state(page);
      check("switching to PFL hides the UFC card and shows PFL's", s.other && !s.appShown && s.sportShown && /PFL Test Card/.test(s.sportText) && s.sport === "pfl");
      check("an invalid feed card (one fighter twice) is dropped", !/Bad Card/.test(s.sportText));
      check("feed text is rendered as text, never HTML", s.imgs === 0 && /<img src=x onerror=alert\(1\)>/.test(s.sportText));
      await pickBy(page, "Jena Bishop");
      await page.waitForTimeout(400);
      s = await state(page);
      const post = writes.find((w) => w.method === "POST");
      const row = post ? JSON.parse(post.body) : {};
      check("a PFL pick is saved with promotion 'pfl'", row.promotion === "pfl" && row.pick === "Jena Bishop" && row.f1 === "Liz Carmouche" && row.f2 === "Jena Bishop" && row.confidence === 0);
      check("...kept locally apart from UFC picks (UFC's untouched)", /Jena Bishop/.test(s.picks || "") && s.ufcPreds === ufcBefore);
      check("a pick also clears the same bout's row in the other corner order",
        writes.some((w) => w.method === "DELETE" && /promotion=eq\.pfl/.test(w.url) && /f1=eq\.Jena%20Bishop&f2=eq\.Liz%20Carmouche/.test(w.url)));
      writes.length = 0;
      await pickBy(page, "Jena Bishop");
      await page.waitForTimeout(400);
      const dels = writes.filter((w) => w.method === "DELETE");
      check("un-picking deletes only that promotion's rows, both corner orders",
        dels.length === 2 && dels.every((w) => /promotion=eq\.pfl/.test(w.url)) &&
        dels.some((w) => /f1=eq\.Liz%20Carmouche/.test(w.url)) && dels.some((w) => /f1=eq\.Jena%20Bishop/.test(w.url)));
      const lock = await page.evaluate(() => ({
        nov: sportLockMs({ date: "2026-11-14", time: "18:00" }), oct: sportLockMs({ date: "2026-10-16", time: "18:00" }),
        mar: sportLockMs({ date: "2027-03-13", time: "18:00" }), mar2: sportLockMs({ date: "2027-03-14", time: "18:00" }),
        none: sportLockMs({ date: "2026-11-14" }),
        rizin: sportLockMs({ promotion: "rizin", date: "2026-12-31" }),
        dwcs: sportLockMs({ promotion: "dwcs", date: "2026-08-04" }),
        proto: sportLockMs({ promotion: "__proto__", date: "2026-11-14" }) }));
      check("a RIZIN card (Japan, first bell ~04:00 UTC) locks at 02:00 UTC, before its bell, not the 10:00 default",
        lock.rizin === Date.UTC(2026, 11, 31, 2, 0));
      check("DWCS (first bell 19:00 ET = 23:00 UTC) locks at 22:00 UTC, an hour before it, not at 6am",
        lock.dwcs === Date.UTC(2026, 7, 4, 22, 0));
      check("an unknown promotion (even '__proto__') keeps the default hour", lock.proto === Date.UTC(2026, 10, 14, 10, 0));
      check("a timed card locks at its own date's ET offset (EST after the November change, EDT from March's)",
        lock.nov === Date.UTC(2026, 10, 14, 23, 0) && lock.oct === Date.UTC(2026, 9, 16, 22, 0) &&
        lock.mar === Date.UTC(2027, 2, 13, 23, 0) && lock.mar2 === Date.UTC(2027, 2, 14, 22, 0) && lock.none === Date.UTC(2026, 10, 14, 10, 0));
      const locked = await page.evaluate(() => { const bs = [...document.querySelectorAll("#sportApp .fight-row")].filter((r) => /Done/.test(r.textContent)).flatMap((r) => [...r.querySelectorAll(".pick-btn")]); return bs.length > 0 && bs.every((b) => b.classList.contains("plocked") && !b.onclick); });
      check("a card past its lock time can't be picked", locked);
      const won = await page.evaluate(() => [...document.querySelectorAll("#sportApp .pick-btn.pcorrect")].map((b) => b.textContent));
      check("results show on the card", won.includes("A") && won.includes("D"));
      // The hero counts down to the next card's lock. When that lock passes
      // with another card still open, the page moves on by itself: the hero
      // names the next card and the closed card's buttons lock, with no
      // reload, and the re-render doesn't duplicate the view.
      const adv = await page.evaluate(() => {
        const first = sportEvents("pfl").find((e) => Date.now() < sportLockMs(e));
        const d = new Date(Date.parse(first.date + "T00:00:00Z") + 7 * 864e5).toISOString().slice(0, 10);
        _sportFeed.events.push(Object.assign({}, first, { name: "PFL Later Card", date: d }));
        renderSportView();
        const before = document.querySelector("#sportApp .cd-event").textContent;
        const real = Date.now, t = sportLockMs(first) + 1000;
        Date.now = () => t;
        try { _sportTick(); } finally { Date.now = real; }
        const box = [...document.querySelectorAll("#sportApp .ev-band")].find((x) => x.textContent.includes(first.name)).nextElementSibling;
        const out = { before, after: document.querySelector("#sportApp .cd-event").textContent,
          heroes: document.querySelectorAll("#sportApp .sport-hero").length,
          names: [...document.querySelectorAll("#sportApp .ev-name")].map((x) => x.textContent),
          locked: [...box.querySelectorAll(".pick-btn")].every((b) => b.classList.contains("plocked") && !b.onclick) };
        _sportFeed.events.pop(); renderSportView();
        return out;
      });
      check("when the hero's card locks, the hero moves to the next card and that card's picks lock",
        adv.before === "PFL Test Card" && adv.after === "PFL Later Card" && adv.locked && adv.heroes === 1 && new Set(adv.names).size === adv.names.length && adv.names.includes("PFL Later Card"));
      await page.evaluate(() => openLeaderboard());
      await page.waitForTimeout(800);
      const board = await page.evaluate(() => ({ text: document.getElementById("lbBody").textContent, lbSportBar: !document.getElementById("lbSportBar").hidden }));
      check("Ranks shows the PFL board, scored by sportStandings", /PFL standings/.test(board.text) && /Bob1\/1 correct1 pt(?!s)/.test(board.text) && /Cat0\/1 correct0 pts/.test(board.text));
      check("...read with promotion=eq.pfl, and the switcher is on Ranks too", reads.some((u) => /promotion=eq\.pfl/.test(u) && /select=user_id,nickname/.test(u)) && board.lbSportBar);
      await page.click("#lbSportBar .sport-tab:nth-child(1)");
      await page.waitForTimeout(600);
      // Switch to PFL while the (slow) UFC board is still loading: the UFC
      // response lands last and must not paint over the PFL board.
      slowUfc = true;
      await page.evaluate(() => loadLeaderboard());
      await page.click("#lbSportBar .sport-tab:nth-child(2)");
      await page.waitForTimeout(2600);
      const late = await page.evaluate(() => document.getElementById("lbBody").textContent);
      check("a stale UFC response can't overwrite the PFL board it lost the race to", /PFL standings/.test(late));
      slowUfc = false;
      await page.click("#lbSportBar .sport-tab:nth-child(1)");
      await page.waitForTimeout(600);
      s = await state(page);
      check("switching back to UFC restores the UFC card", !s.other && s.appShown && !s.sportShown && s.sport === "ufc");
      check("no page errors (and no alert) in the sport view", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
}

// --- wiring ---------------------------------------------------------------------------
{
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  check("the UFC board hands off to the sport board before touching UFC rows",
    /function loadLeaderboard\(isLive\)\{\s*var _gen=\+\+_lbGen;\s*\/\/[^\n]*\n\s*if\(typeof curSport==="function"&&curSport\(\)!=="ufc"\)\{renderSportBoard\(_gen\);return;\}/.test(html));
  check("the UFC board drops a response a newer load overtook", /\+PICKS_UFC\)\.then\(function\(rows\)\{\s*if\(_gen!==_lbGen\)return;/.test(html));
  check("the feed is only used after PickEngine.validateFeed", /var v=PickEngine\.validateFeed\(j\);\s*_sportFeed=\{promotions:v\.promotions,events:v\.events\};/.test(html));
}

if (failures) { console.error(`\ncheck:sports — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:sports — all good");
