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
  const boot = async (feed) => {
    const page = await browser.newPage();
    const errors = [], writes = [], reads = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => { errors.push("dialog: " + d.message()); d.dismiss(); });   // an XSS would alert
    await page.addInitScript(() => { try { localStorage.setItem("ufc_uid", "u-Andy"); localStorage.setItem("ufc_name", "🥊 Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999"); } catch (e) {} });
    if (feed) await page.route(/events-extra\.json/, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(feed) }));
    await page.route(/supabase\.co/, (route) => {
      const req = route.request(), url = req.url();
      if (/\/rest\/v1\/picks/.test(url)) {
        if (req.method() === "GET") reads.push(url);
        else writes.push({ method: req.method(), url, body: req.postData() });
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
      const { page, errors } = await boot(null);       // the repo's own feed: empty
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
      await page.click("text=Jena Bishop");
      await page.waitForTimeout(400);
      s = await state(page);
      const post = writes.find((w) => w.method === "POST");
      const row = post ? JSON.parse(post.body) : {};
      check("a PFL pick is saved with promotion 'pfl'", row.promotion === "pfl" && row.pick === "Jena Bishop" && row.f1 === "Liz Carmouche" && row.f2 === "Jena Bishop" && row.confidence === 0);
      check("...kept locally apart from UFC picks (UFC's untouched)", /Jena Bishop/.test(s.picks || "") && s.ufcPreds === ufcBefore);
      await page.click("text=Jena Bishop");
      await page.waitForTimeout(400);
      const del = writes.find((w) => w.method === "DELETE");
      check("un-picking deletes only that promotion's row", del && /promotion=eq\.pfl/.test(del.url) && /f1=eq\.Liz%20Carmouche/.test(del.url));
      const locked = await page.evaluate(() => [...document.querySelectorAll("#sportApp .sport-pick")].filter((b) => /Done/.test(b.textContent)).every((b) => b.disabled));
      check("a card past its lock time can't be picked", locked);
      const won = await page.evaluate(() => [...document.querySelectorAll("#sportApp .sport-pick.won")].map((b) => b.textContent));
      check("results show on the card", won.some((t) => /Done A/.test(t)) && won.some((t) => /Done D/.test(t)));
      await page.evaluate(() => openLeaderboard());
      await page.waitForTimeout(800);
      const board = await page.evaluate(() => ({ text: document.getElementById("lbBody").textContent, lbSportBar: !document.getElementById("lbSportBar").hidden }));
      check("Ranks shows the PFL board, scored by sportStandings", /PFL standings/.test(board.text) && /Bob1\/11 pt(?!s)/.test(board.text) && /Cat0\/10 pts/.test(board.text));
      check("...read with promotion=eq.pfl, and the switcher is on Ranks too", reads.some((u) => /promotion=eq\.pfl/.test(u) && /select=user_id,nickname/.test(u)) && board.lbSportBar);
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
    /function loadLeaderboard\(isLive\)\{\s*\/\/[^\n]*\n\s*if\(typeof curSport==="function"&&curSport\(\)!=="ufc"\)\{renderSportBoard\(\);return;\}/.test(html));
  check("the feed is only used after PickEngine.validateFeed", /var v=PickEngine\.validateFeed\(j\);\s*_sportFeed=\{promotions:v\.promotions,events:v\.events\};/.test(html));
}

if (failures) { console.error(`\ncheck:sports — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:sports — all good");
