// Notification-tap regression test — "I tapped the push and the app showed me nothing".
//
// This has broken more than once, always in the same shape: a tap is delivered
// on a path nothing is listening on, and the roast is silently dropped. sw.js
// stashes every tap in the 'ufc-tap' cache precisely so no delivery path can
// lose it, but the stash is only useful if the page actually reads it back on
// every path — cold launch AND foreground-resume (a tap on a backgrounded PWA
// never reloads the page, so on-load consumption alone misses it).
//
// Each case below maps to a way a tap reaches the app. Keep them all green.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let chromium;
try { ({ chromium } = require("playwright")); }
catch {
  try { ({ chromium } = require("playwright-core")); }
  catch { console.error("Playwright not installed. Run `npm install` (or `npx playwright install chromium` in CI)."); process.exit(2); }
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png",
  ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

// A realistic roast: the trailing "— Persona" is what the in-app sheet parses.
const ROAST = "You picked three underdogs and went 0-3. Stick to bingo. — Joe Rogan";

const checks = [];
const assert = (name, cond) => checks.push({ name, cond: !!cond });

// Write what sw.js's notificationclick handler stashes before it routes a tap.
const stashTap = (page, payload) => page.evaluate(async (p) => {
  const c = await caches.open("ufc-tap");
  await c.put("/__pending_tap", new Response(JSON.stringify(p), { headers: { "Content-Type": "application/json" } }));
}, payload);

const sheet = (page) => page.evaluate(() => ({
  open: !!document.getElementById("trashSheet")?.classList.contains("open"),
  text: document.getElementById("trashText")?.textContent || "",
  persona: document.getElementById("trashPersona")?.textContent || "",
}));

const closeSheet = (page) => page.evaluate(() => document.getElementById("trashSheet").classList.remove("open"));

// The OS handing focus back to an already-running PWA.
async function foreground(page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(300);
}

// sw.js's own notificationclick handler, run in a vm against stubbed window
// clients: which window a tap goes to is decided there, and a page-side test
// can't see it. The Fight Lab opens in the app's one window, and a roast tap
// that focused a window on lab.html (no message handler, never reads the
// stash) showed nothing at all.
async function swTap(windows, kind = "") {
  const log = { messages: [], navigated: [], opened: [], stashed: null };
  const clientsList = windows.map((w) => ({
    url: w.url, visibilityState: w.visible ? "visible" : "hidden",
    focus() { return w.focusRejects ? Promise.reject(new Error("not allowed")) : Promise.resolve(this); },
    navigate(u) { log.navigated.push({ from: w.url, to: u }); return Promise.resolve(this); },
    postMessage(m) { log.messages.push({ to: w.url, type: m.type }); },
  }));
  const handlers = {};
  const sandbox = {
    self: { addEventListener: (t, f) => { handlers[t] = f; }, registration: { scope: "https://x.github.io/ufc-dashboard/" }, skipWaiting() {} },
    clients: { matchAll: () => Promise.resolve(clientsList), openWindow: (u) => { log.opened.push(u); return Promise.resolve(null); } },
    caches: { open: () => Promise.resolve({ put: (k, r) => r.text().then((t) => { log.stashed = JSON.parse(t); }) }) },
    Response, URL, Promise, JSON, Date, encodeURIComponent, console, setTimeout,
  };
  vm.runInNewContext(readFileSync(join(ROOT, "sw.js"), "utf8"), sandbox);
  let wait = Promise.resolve();
  handlers.notificationclick({
    notification: { close() {}, title: "🎤 Joe Rogan (via AB)", data: { url: kind ? "./?inbox=1" : "./", kind, fullMessage: kind ? "" : ROAST } },
    waitUntil(p) { wait = p; },
  });
  await wait;
  return log;
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
  const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage();
  const fatal = [];
  page.on("pageerror", (e) => fatal.push("Uncaught: " + e.message));

  try {
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(800);

    // sw.js routing: a tap must reach the app page, never die on the Lab.
    {
      const APP = "https://x.github.io/ufc-dashboard/", LAB = APP + "lab.html#week";
      let log = await swTap([{ url: APP, visible: true }]);
      assert("sw: tap on the open app page is posted to it", log.messages.length === 1 && log.messages[0].to === APP && !log.navigated.length);
      assert("sw: the tap is stashed before routing", log.stashed && log.stashed.fullMessage === ROAST && log.stashed.sender === "AB");
      log = await swTap([{ url: LAB, visible: true }]);
      assert("sw: a window on the Lab is sent to the app, not posted a message it ignores",
        !log.messages.length && log.navigated.length === 1 && log.navigated[0].to === "./");
      log = await swTap([{ url: LAB, visible: true }, { url: APP + "index.html", visible: false }]);
      assert("sw: an app-page window beats a visible Lab window",
        log.messages.length === 1 && log.messages[0].to === APP + "index.html" && !log.navigated.length);
      log = await swTap([{ url: LAB, visible: true }, { url: "https://x.github.io/", visible: false }]);
      assert("sw: a same-origin page outside the scope is not taken for the app",
        !log.messages.length && log.navigated.length === 1 && log.navigated[0].from === LAB);
      log = await swTap([{ url: APP + "?inbox=1#x", visible: true }]);
      assert("sw: the app page with a query or hash still counts", log.messages.length === 1 && !log.navigated.length);
      log = await swTap([{ url: APP, visible: true, focusRejects: true }]);
      assert("sw: the roast is posted even when focus() rejects (app already on screen)",
        log.messages.length === 1 && log.messages[0].to === APP && log.messages[0].type === "trash-talk");
      assert("sw: and opens no second window over the app already on screen", !log.opened.length);
      log = await swTap([{ url: APP, visible: false, focusRejects: true }]);
      assert("sw: a hidden window that rejects focus() still falls back to a fresh one", log.opened.length === 1);
      log = await swTap([{ url: LAB, visible: true }], "challenge");
      assert("sw: a challenge tap on the Lab also goes to the app", log.navigated.length === 1 && log.navigated[0].to === "./?inbox=1");
    }

    // 0. Tap on a banner while the app is already on screen: no visibilitychange,
    //    no pageshow, and the SW's message lost. Only the visible-page poll can
    //    find the stash, and it must.
    await stashTap(page, { kind: "", fullMessage: ROAST, sender: "AB", ts: Date.now() });
    await page.waitForTimeout(2600);
    {
      const s0 = await sheet(page);
      assert("a tap on an app already on screen shows with no page event", s0.open && s0.text === ROAST);
    }
    await closeSheet(page);
    await page.evaluate(() => { closeTrashSheet(); closeLeaderboard(); });

    // 1. Tap on a backgrounded (already-loaded) app. No reload happens, and the
    //    SW's postMessage can vanish into a client iOS only *thinks* is alive —
    //    so the foreground must re-check the stash. This is the regression.
    assert("sheet starts closed", !(await sheet(page)).open);
    await stashTap(page, { kind: "", fullMessage: ROAST, sender: "Andy", ts: Date.now() });
    await foreground(page);
    const resumed = await sheet(page);
    assert("resume after tap shows the roast", resumed.open);
    assert("roast text matches the pushed message", resumed.text === ROAST);
    assert("sender is credited", /sent by Andy/.test(resumed.persona));
    assert("persona parsed from the signature", /Joe Rogan/.test(resumed.persona));

    // 2. A consumed tap is gone for good — it must not re-pop on every foreground.
    await closeSheet(page);
    await foreground(page);
    assert("consumed tap does not replay", !(await sheet(page)).open);

    // 3. Both delivery paths landing at once (postMessage AND the stash) is the
    //    normal case, not an edge case. It must show the roast exactly once.
    let shows = 0;
    await page.exposeFunction("__tapShown", () => { shows++; });
    await page.evaluate(() => {
      const orig = window.showIncomingTrashTalk;
      window.showIncomingTrashTalk = function () { window.__tapShown(); return orig.apply(this, arguments); };
    });
    const ts = Date.now();
    await stashTap(page, { kind: "", fullMessage: "double-delivery check", sender: "Andy", ts });
    await page.evaluate((t) => window._routeTap("", "double-delivery check", "Andy", t, 0), ts);
    await foreground(page);
    await page.waitForTimeout(300);
    assert("racing delivery paths show the roast once", shows === 1);

    // 4. A stash that never got opened must not ambush an unrelated launch days later.
    await closeSheet(page);
    await stashTap(page, { kind: "", fullMessage: "ancient roast", sender: "Andy", ts: Date.now() - 600000 });
    await foreground(page);
    assert("stale tap (>5min) is discarded", !(await sheet(page)).open);

    // 5. Cold launch: app was closed, SW openWindow'd it, stash consumed on load.
    await stashTap(page, { kind: "", fullMessage: ROAST, sender: "Andy", ts: Date.now() });
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1600); // the load path routes on an 800ms delay
    assert("cold launch shows the roast", (await sheet(page)).open);

    // 6. Legacy ?trash= URL fallback (old SW, or a payload short enough for a URL).
    //    The '%' here is deliberate: double-decoding used to throw URIError and
    //    swallow the message entirely.
    await page.goto(base + "/index.html?trash=" + encodeURIComponent("legacy 100% path") + "&from=Andy",
      { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1600);
    const legacy = await sheet(page);
    assert("legacy ?trash= param still shows", legacy.open && legacy.text === "legacy 100% path");

    // 7. A service-worker update reloads the page (controllerchange) moments
    //    after a cold launch from a tap. The stash was consumed by the first
    //    load, so the reload used to come back empty — and What's New took the
    //    roast's place. The live tap must survive the reload.
    const wnOpen = (p) => p.evaluate(() => !!document.getElementById("wn-overlay")?.classList.contains("open"));
    await page.evaluate(() => { try { localStorage.removeItem("ufc_whatsnew_seen"); } catch (e) {} });
    await stashTap(page, { kind: "", fullMessage: ROAST, sender: "Andy", ts: Date.now() });
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1600);
    assert("cold launch before the SW reload shows the roast", (await sheet(page)).open);
    await page.reload({ waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(2200);
    const afterReload = await sheet(page);
    assert("the roast survives an SW-update reload", afterReload.open && afterReload.text === ROAST);
    assert("What's New does not open over the replayed roast", !(await wnOpen(page)));

    // 8. Reloaded in the gap between reading the stash and the sheet opening.
    await page.evaluate(() => closeTrashSheet());
    await stashTap(page, { kind: "", fullMessage: "gap roast — Joe Rogan", sender: "Andy", ts: Date.now() });
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(150);          // stash read, 800ms route timer not fired yet
    await page.reload({ waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1800);
    assert("a tap reloaded before its sheet opened still shows", (await sheet(page)).text === "gap roast — Joe Rogan");

    // 9. Once the user closes it, it is done — a later reload must not replay it.
    await page.evaluate(() => closeTrashSheet());
    await page.reload({ waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(1800);
    assert("a roast the user closed is not replayed on reload", !(await sheet(page)).open);

    // 10. The user gets BOTH: What's New is up, a tap arrives on top of it.
    //     The popup steps aside without checkpointing, the roast shows, and the
    //     popup comes back once the roast and the leaderboard are closed.
    await page.evaluate(() => { try { localStorage.removeItem("ufc_whatsnew_seen"); } catch (e) {} });
    await page.reload({ waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(2000);
    assert("What's New opens on a normal launch", await wnOpen(page));
    // Where the user was before the popup grabbed focus — what its eventual
    // dismissal must return them to, even after a tap suspended it.
    await page.evaluate(() => {
      const b = document.createElement("button"); b.id = "orig-focus"; document.body.appendChild(b);
      _wnPrevFocus = b;
    });
    await stashTap(page, { kind: "", fullMessage: ROAST, sender: "Andy", ts: Date.now() });
    await foreground(page);
    assert("a tap steps What's New aside", !(await wnOpen(page)));
    await page.waitForTimeout(300);
    assert("focus leaves the hidden popup for the roast's sheet",
      await page.evaluate(() => {
        const a = document.activeElement;
        return !document.getElementById("wn-overlay").contains(a)
          && !!a && a.classList.contains("lb-trash-close") && document.getElementById("trashSheet").contains(a);
      }));
    assert("and the roast shows", (await sheet(page)).open);
    assert("stepping aside does not checkpoint the popup",
      (await page.evaluate(() => localStorage.getItem("ufc_whatsnew_seen"))) === null);
    await page.waitForTimeout(2000);
    assert("What's New stays away while the roast is open", !(await wnOpen(page)));
    await page.evaluate(() => { closeTrashSheet(); closeLeaderboard(); });
    await page.waitForTimeout(2000);
    assert("What's New comes back once the roast is closed", await wnOpen(page));
    assert("re-shown popup takes focus again", await page.evaluate(() => document.activeElement?.id === "wn-gotit-btn"));
    assert("its original focus target survived the suspension",
      await page.evaluate(() => _wnPrevFocus && _wnPrevFocus.id === "orig-focus"));
    await page.evaluate(() => closeWhatsNew());
    assert("dismissing it returns focus to where the user was",
      await page.evaluate(() => document.activeElement?.id === "orig-focus"));
    assert("dismissing it after all that checkpoints normally",
      (await page.evaluate(() => localStorage.getItem("ufc_whatsnew_seen"))) !== null);

    // The roast inbox (0016_roast_inbox.sql): the app reads its own unseen
    // roasts from the server, so a tap whose payload never reached the page
    // still shows the roast. Fetch is stubbed; the code under test is real.
    {
      const r = await page.evaluate(async (msg) => {
        const realFetch = window.fetch, patches = [];
        let rows = [{ id: 7, title: "🎤 Joe Rogan (via T)", body: msg, created_at: "2026-10-01T19:33:20+00:00" }, { id: 6, title: "🎤 Old (via T)", body: "older roast — Old", created_at: "2026-10-01T18:00:00+00:00" }];
        let status = 200;
        window.fetch = function (url, opts = {}) {
          url = String(url);
          if (url.includes("/rest/v1/roast_inbox")) {
            if ((opts.method || "GET") === "PATCH") { patches.push(url); return Promise.resolve(new Response(null, { status: 204 })); }
            return Promise.resolve(new Response(JSON.stringify(status === 200 ? rows : { code: "PGRST205" }), { status }));
          }
          return realFetch.apply(window, arguments);
        };
        _sbToken = "test-token"; USER_ID = "u-me"; _roastShownAt = {};
        closeTrashSheet(); closeLeaderboard();
        const shown = await checkRoastInbox(true);
        await new Promise((res) => setTimeout(res, 200));
        const out = {
          shown, open: document.getElementById("trashSheet").classList.contains("open"),
          text: document.getElementById("trashText").textContent,
          persona: document.getElementById("trashPersona").textContent,
          // The whole unseen backlog up to the newest, not just the rows read.
          clearedAll: patches.some((u) => /recipient_id=eq\.u-me&seen_at=is\.null&created_at=lte\.2026-10-01T19%3A33%3A20%2B00%3A00$/.test(u)),
        };
        // The same roast again (say the notification's own path showed it first):
        // never a second time.
        closeTrashSheet(); closeLeaderboard();
        out.again = await checkRoastInbox(true);
        out.reopened = document.getElementById("trashSheet").classList.contains("open");
        // No table yet: reads nothing, throws nothing.
        status = 404; _roastShownAt = {};
        out.missing = await checkRoastInbox(true);
        window.fetch = realFetch; _sbToken = null;
        return out;
      }, ROAST);
      assert("roast inbox: an unseen roast on the server shows with no tap payload at all", r.shown && r.open && r.text === ROAST);
      assert("roast inbox: the sender is credited from the server's title", /sent by T/.test(r.persona));
      assert("roast inbox: every unseen roast is marked seen, only the newest shown", r.clearedAll);
      assert("roast inbox: a roast already on screen is not shown twice", r.again === false && !r.reopened);
      assert("roast inbox: no table (0016 not applied) reads nothing", r.missing === false);
    }

    // The challenge inbox: a challenge tap rides the same hand-off that lost
    // roasts, so the app re-reads challenges itself and opens the inbox for an
    // incoming one (or an answer to mine) this device hasn't shown yet.
    {
      const r = await page.evaluate(async () => {
        const realFetch = window.fetch;
        const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
        let rows = [
          { id: "c1", challenger_id: "u-them", challenger_name: "Rival", target_id: "u-me", target_name: "Me",
            event_date: "2999-01-01", event_name: "Future", f1: null, f2: null, stake: "s", status: "pending", created_at: iso(now - 60000) },
          { id: "c0", challenger_id: "u-them", challenger_name: "Rival", target_id: "u-me", target_name: "Me",
            event_date: "2999-01-01", event_name: "Future", f1: null, f2: null, stake: "s", status: "pending", created_at: iso(now - 3 * 86400000) },
        ];
        // Rows are written for "u-me" and served as whoever is signed in when
        // they're read: every challenge read refreshes the session first, and
        // where Supabase is reachable (CI) that swaps in a real anonymous uid
        // mid-test. The stand-in below does the same thing everywhere.
        window.fetch = function (url) {
          url = String(url);
          if (url.includes("/rest/v1/challenges"))
            return Promise.resolve(new Response(JSON.stringify(rows).split('"u-me"').join(JSON.stringify(USER_ID)), { status: 200 }));
          return realFetch.apply(window, arguments);
        };
        const realFresh = _ensureFreshToken;
        _ensureFreshToken = function () { USER_ID = "u-signed-in-" + Math.random().toString(36).slice(2, 6); return Promise.resolve(); };
        const restore = { EVENTS };
        EVENTS = EVENTS.concat([{ date: "2999-01-01", name: "Future", fights: [{ f1: "A B", f2: "C D", lbl: "Main Event", state: "pre" }] }]);
        USER_ID = "u-me"; localStorage.removeItem("ufc_chal_seen");
        // The app runs this check itself (boot, foreground), and on CI that
        // call's real fetch can hang: a forced check must not wait on it. Pin
        // one "in flight" for the whole test, and judge by what is on screen,
        // not by which call happened to open it.
        _chalInboxBusy = true;
        const inboxOpen = () => document.getElementById("chalSheet").classList.contains("open")
          && document.getElementById("chalInboxView").style.display !== "none";
        const run = async () => { const p = checkChallengeInbox(true); _chalInboxBusy = true; await p; _chalInboxBusy = true;
          await new Promise((r) => setTimeout(r, 200)); return inboxOpen(); };
        closeChalSheet(); closeLeaderboard();
        const out = {};
        out.open = await run();
        out.listed = /Rival/.test(document.getElementById("chalList").textContent);
        // Shown once: the next foreground doesn't pop it up again.
        closeChalSheet(); closeLeaderboard();
        out.again = await run();
        // Only the 3-day-old one left unseen? It's too old to interrupt for.
        out.oldSkipped = !_chalNews().some((c) => c.id === "c0");
        // An answer to my own challenge is news to me; my own pending one isn't.
        closeChalSheet(); closeLeaderboard();
        rows = rows.concat([
          { id: "c2", challenger_id: "u-me", challenger_name: "Me", target_id: "u-them", target_name: "Rival",
            event_date: "2999-01-01", event_name: "Future", f1: null, f2: null, stake: "s", status: "pending", created_at: iso(now - 1000) },
        ]);
        out.ownPending = await run();
        closeChalSheet(); closeLeaderboard();
        rows = rows.map((c) => c.id === "c2" ? Object.assign({}, c, { status: "accepted", responded_at: iso(now) }) : c);
        out.answer = await run();
        closeChalSheet(); closeLeaderboard();
        // A long history: a fresh "declined" sorts last, past the 25 rows the
        // inbox draws. It must still be on screen, and only drawn rows count as seen.
        const filler = [];
        for (let i = 0; i < 30; i++) filler.push({ id: "f" + i, challenger_id: "u-them", challenger_name: "Rival", target_id: "u-me", target_name: "Me",
          event_date: "2999-01-01", event_name: "Future", f1: null, f2: null, stake: "s", status: "accepted", created_at: iso(now - 7 * 86400000 - i), responded_at: iso(now - 7 * 86400000) });
        rows = rows.concat(filler, [{ id: "c3", challenger_id: "u-me", challenger_name: "Me", target_id: "u-them", target_name: "Declinator",
          event_date: "2999-01-01", event_name: "Future", f1: null, f2: null, stake: "s", status: "declined", created_at: iso(now - 2000), responded_at: iso(now) }]);
        out.deepOpen = await run();
        out.deepListed = /Declinator/.test(document.getElementById("chalList").textContent);
        const seen = JSON.parse(localStorage.getItem("ufc_chal_seen") || "[]");
        out.unshownUnmarked = filler.filter((c) => seen.indexOf(c.id + ":accepted") < 0).length > 0;
        closeChalSheet(); closeLeaderboard();
        window.fetch = realFetch; EVENTS = restore.EVENTS; _chalInboxBusy = false; _ensureFreshToken = realFresh;
        return out;
      });
      assert("challenge inbox: a new incoming challenge opens the inbox with no tap payload", r.open && r.listed);
      assert("challenge inbox: one already shown on this device isn't popped up again", r.again === false);
      assert("challenge inbox: a days-old challenge doesn't interrupt", r.oldSkipped);
      assert("challenge inbox: my own outgoing challenge doesn't open it", r.ownPending === false);
      assert("challenge inbox: an answer to my challenge does", r.answer === true);
      assert("challenge inbox: a fresh answer past the 25-row cut is still drawn", r.deepOpen && r.deepListed);
      assert("challenge inbox: rows the inbox didn't draw aren't marked seen", r.unshownUnmarked);
    }

    // sw.js tells an open page the moment a push lands, so the page reads the
    // inbox without waiting on the tap.
    {
      const msgs = [];
      const handlers = {};
      vm.runInNewContext(readFileSync(join(ROOT, "sw.js"), "utf8"), {
        self: { addEventListener: (t, f) => { handlers[t] = f; }, registration: { scope: "https://x.github.io/ufc-dashboard/", showNotification: () => Promise.resolve() }, skipWaiting() {} },
        clients: { matchAll: () => Promise.resolve([{ url: "https://x.github.io/ufc-dashboard/", postMessage: (m) => msgs.push(m) }]) },
        caches: {}, Response, URL, Promise, JSON, Date, console, setTimeout,
      });
      let wait = Promise.resolve();
      handlers.push({ data: { json: () => ({ title: "🎤 Joe Rogan (via T)", body: ROAST }) }, waitUntil(p) { wait = p; } });
      await wait;
      assert("sw: a push arriving tells the open page to read the roast inbox", msgs.some((m) => m.type === "push-arrived"));
      // The banner must never wait on telling the page: a lookup of open
      // windows that hangs, or throws, still shows the notification, and
      // shows it straight away (iOS counts a push with no banner as silent).
      for (const how of ["hangs", "throws"]) {
        const shown = [];
        const h = {};
        vm.runInNewContext(readFileSync(join(ROOT, "sw.js"), "utf8"), {
          self: { addEventListener: (t, f) => { h[t] = f; }, registration: { scope: "https://x.github.io/ufc-dashboard/",
            showNotification: (title, opts) => { shown.push({ title, body: opts.body }); return Promise.resolve(); } }, skipWaiting() {} },
          clients: { matchAll: () => { if (how === "throws") throw new Error("nope"); return new Promise(() => {}); } },
          caches: {}, Response, URL, Promise, JSON, Date, console, setTimeout,
        });
        let life = null;
        h.push({ data: { json: () => ({ title: "🎤 Katt Williams (via AB)", body: ROAST }) }, waitUntil(p) { life = p; } });
        // ...and the push event still finishes: a lookup that never settles
        // must not keep the worker alive.
        const settled = await Promise.race([life.then(() => true), new Promise((r) => setTimeout(() => r(false), 3500))]);
        assert(`sw: the push event still finishes when finding open windows ${how}`, settled);
        assert(`sw: the banner shows at once even when finding open windows ${how}`,
          shown.length === 1 && shown[0].title === "🎤 Katt Williams (via AB)" && shown[0].body === ROAST);
      }
    }

    // A roast must always be closable. A tall one (the max length, plus
    // Report / Block) on a short screen used to be free to grow past the top
    // of the panel, taking the ✕ with it and leaving a sheet over everything.
    {
      const was = page.viewportSize();
      await page.setViewportSize({ width: 375, height: 480 });
      const long = "Roast ".repeat(150) + "— Jorge Masvidal";
      await page.evaluate((t) => showIncomingTrashTalk(t, "T"), long);
      await page.waitForTimeout(500);   // past the sheet's slide-in transition
      const r = await page.evaluate(() => {
        const s = document.getElementById("trashSheet"), p = document.getElementById("lbPanel").getBoundingClientRect();
        const x = s.querySelector(".lb-trash-close").getBoundingClientRect();
        return { xTop: x.top, panelTop: p.top, xBottom: x.bottom, vh: innerHeight, scrolls: s.scrollHeight > s.clientHeight };
      });
      assert("a max-length roast on a short screen keeps its ✕ on screen", r.xTop >= r.panelTop && r.xBottom <= r.vh);
      assert("...and scrolls inside the sheet instead of growing past it", r.scrolls);
      await page.tap("#trashSheet .lb-trash-close").catch(() => page.click("#trashSheet .lb-trash-close"));
      await page.waitForTimeout(300);
      assert("...and the ✕ closes it", !(await sheet(page)).open);
      await page.evaluate(() => closeLeaderboard());
      await page.setViewportSize(was);
    }

    // No :has() rules. On body it makes WebKit re-check the whole page on every
    // DOM change, and this page adds and removes an ambient particle several
    // times a second; the toast rule that used one shipped with a frozen roast.
    {
      const css = [...readFileSync(join(ROOT, "index.html"), "utf8").matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1].replace(/\/\*[\s\S]*?\*\//g, "")).join("\n");
      assert("no :has() selector in the app's CSS", !/:has\(/.test(css));
    }

    // On-device diagnostics (diag:start / diag-ui:end): a tapped roast and the
    // tap that closes it are recorded with the element actually under the
    // finger, the roast's text is never stored, and five taps on the version
    // number open the log. The recorder must not get in the way of the tap.
    {
      await page.evaluate(() => { _diagClear(); });
      await page.evaluate((t) => _routeTap("", t, "T", Date.now(), 0), ROAST);
      await page.waitForTimeout(500);
      await page.tap("#trashSheet .lb-trash-close").catch(() => page.click("#trashSheet .lb-trash-close"));
      await page.waitForTimeout(500);
      const d = await page.evaluate(() => { const r = _diagRead(); return { text: JSON.stringify(r), n: r.length, closed: !document.getElementById("trashSheet").classList.contains("open") }; });
      assert("diag: the X still closes the roast with the recorder on", d.closed);
      assert("diag: the tap is logged with what was under the finger", /"(touchend|click)","[^"]*target=button\.lb-trash-close in #trashSheet/.test(d.text));
      assert("diag: the roast's open and close steps are logged", /call","_routeTap kind=roast len=/.test(d.text) && /call","showIncomingTrashTalk len=/.test(d.text) && /call","closeTrashSheet/.test(d.text));
      assert("diag: the roast's words are never stored", !d.text.includes("bingo") && !d.text.includes("underdogs"));
      // ...including when the app was launched by the legacy ?trash= fallback,
      // whose URL is the roast: the boot line keeps parameter names only.
      const legacy = await browser.newPage();
      await legacy.goto(base + "/index.html?trash=" + encodeURIComponent(ROAST) + "&from=AB", { waitUntil: "load" });
      await legacy.waitForTimeout(600);
      const boot = await legacy.evaluate(() => JSON.stringify(_diagRead().filter((r) => r[1] === "boot")));
      await legacy.close();
      assert("diag: a ?trash= launch logs its parameter names, never the roast or sender",
        /params=trash,from/.test(boot) && !boot.includes("bingo") && !boot.includes("AB "));
      const viewer = await page.evaluate(async () => {
        openLeaderboard();
        let v = document.getElementById("appVer");
        if (!v) { v = document.createElement("div"); v.id = "appVer"; v.textContent = "vtest"; document.getElementById("lbBody").appendChild(v); }
        for (let i = 0; i < 5; i++) v.click();
        const el = document.getElementById("diagView");
        const out = { shown: !!el, hasRows: !!el && /call/.test(el.textContent) };
        if (el) el.remove();
        closeLeaderboard();
        return out;
      });
      assert("diag: five taps on the version number open the log", viewer.shown && viewer.hasRows);
      const src = readFileSync(join(ROOT, "index.html"), "utf8");
      const block = src.slice(src.indexOf("// diag:start"), src.indexOf("// diag:end"))
        + src.slice(src.indexOf("// diag-ui:start"), src.indexOf("// diag-ui:end"));
      assert("diag: nothing is sent anywhere and nothing is written as HTML", !/fetch\(|XMLHttpRequest|sendBeacon|innerHTML/.test(block));
    }

    // A toast must not cover the roast it popped up over. A sync notice
    // ("✓ Synced 1 method pick") once landed on top of half a roast.
    {
      const r = await page.evaluate(async (msg) => {
        showIncomingTrashTalk(msg, "T");
        await new Promise((res) => setTimeout(res, 400));
        toast("✓ Synced 1 method pick — now refresh other phones");
        await new Promise((res) => setTimeout(res, 400));
        const a = document.getElementById("toast").getBoundingClientRect();
        const b = document.getElementById("trashSheet").getBoundingClientRect();
        const out = { toastTop: a.top, toastBottom: a.bottom, sheetTop: b.top, h: innerHeight };
        closeTrashSheet(); closeLeaderboard();
        return out;
      }, ROAST);
      assert("a toast over an open roast shows clear of the sheet",
        r.toastBottom <= r.sheetTop && r.toastTop >= 0);
    }
    {
      const r = await page.evaluate(async () => {
        openLeaderboard(); openWheelSheet();
        await new Promise((res) => setTimeout(res, 400));
        toast("✓ Synced 1 method pick");
        await new Promise((res) => setTimeout(res, 400));
        const a = document.getElementById("toast").getBoundingClientRect();
        const b = document.getElementById("wheelSheet").getBoundingClientRect();
        closeWheelSheet(); closeLeaderboard();
        return { toastBottom: a.bottom, sheetTop: b.top };
      });
      assert("a toast over the open wheel shows clear of it too", r.toastBottom <= r.sheetTop);
    }

    // The method repair must not "sync" a bout that has started: the database
    // keeps a locked pick's method but answers 200, so it re-toasted "Synced"
    // on every visit and scored the method on this phone alone. Synthetic
    // cards dated off the page's own clock, never the live data.
    {
      const r = await page.evaluate(() => {
        const day = 86400000, iso = (ms) => new Date(ms).toISOString().slice(0, 10);
        const past = { date: iso(Date.now() - 20 * day), name: "Past Test Card", time: "21:00",
          fights: [{ lbl: "Main Event", f1: { n: "Past One" }, f2: { n: "Past Two" }, winner: "Past One", method: "KO/TKO" }] };
        const next = { date: iso(Date.now() + 20 * day), name: "Next Test Card",
          time: "21:00", prelimTime: "19:00",
          fights: [{ lbl: "Main Event", f1: { n: "Next One" }, f2: { n: "Next Two" } }] };
        // Bell two minutes ago: locked in the app, still inside the server's grace.
        // Card times are ET "HH:MM" on the card's date; build one for two minutes ago.
        const bell = Date.now() - 120000;
        let et = new Date(bell - etOffset(iso(bell)) * 3600000);
        et = new Date(bell - etOffset(et.toISOString().slice(0, 10)) * 3600000);
        const hhmm = String(et.getUTCHours()).padStart(2, "0") + ":" + String(et.getUTCMinutes()).padStart(2, "0");
        const late = { date: et.toISOString().slice(0, 10), name: "Late Test Card", time: hhmm,
          fights: [{ lbl: "Main Event", f1: { n: "Late One" }, f2: { n: "Late Two" } }] };
        EVENTS.push(past, next, late); _fightIndex = null;
        USER_ID = "u-me"; userName = "AB";
        const kPast = pk(past, past.fights[0]), kNext = pk(next, next.fights[0]);
        preds = {}; preds_method = {};
        preds[kPast] = "Past One"; preds_method[kPast] = "KO/TKO";
        preds[kNext] = "Next One"; preds_method[kNext] = "SUB";
        const kLate = pk(late, late.fights[0]);
        preds[kLate] = "Late One"; preds_method[kLate] = "DEC";
        const synced = [], toasts = [];
        const realSync = window.syncPick, realToast = window.toast;
        window.syncPick = (ev, f) => { synced.push(pk(ev, f)); return Promise.resolve({ ok: true }); };
        window.toast = (m) => toasts.push(m);
        const rows = [
          { user_id: "u-me", nickname: "AB", event_date: past.date, f1: "Past One", f2: "Past Two", pick: "Past One", method: "" },
          { user_id: "u-me", nickname: "AB", event_date: next.date, f1: "Next One", f2: "Next Two", pick: "Next One", method: "" },
          { user_id: "u-me", nickname: "AB", event_date: late.date, f1: "Late One", f2: "Late Two", pick: "Late One", method: "" },
        ];
        _reconcileMyMethods(rows);
        window.syncPick = realSync; window.toast = realToast;
        return { synced, kPast, kNext, kLate, lateLocked: fightLocked(late, late.fights[0]), pastMethod: rows[0].method, nextMethod: rows[1].method };
      });
      assert("method repair skips a bout that has started", !r.synced.includes(r.kPast) && r.pastMethod === "");
      assert("method repair still syncs an open bout", r.synced.includes(r.kNext) && r.nextMethod === "SUB");
      assert("method repair keeps retrying inside the server's post-bell grace", r.lateLocked && r.synced.includes(r.kLate));
    }
  } catch (e) {
    fatal.push("Tap test failed to run: " + e.message);
  } finally {
    await browser.close();
    server.close();
  }

  let bad = 0;
  for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
  if (fatal.length) { console.error("\n  Fatal errors:"); fatal.slice(0, 10).forEach((e) => console.error("    • " + e.slice(0, 200))); }

  if (bad || fatal.length) { console.error(`\nnotification-tap: FAILED (${bad} assertion(s), ${fatal.length} fatal error(s)) — a tapped push would show nothing.`); process.exit(1); }
  console.log("\nnotification-tap: every tap delivery path surfaces the message.");
}

main().catch((e) => { console.error("notification-tap harness crashed:", e); server.close(); process.exit(1); });
