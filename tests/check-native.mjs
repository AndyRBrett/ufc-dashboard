// Guard: the App Store build's native hooks in index.html (// native:start … :end).
//
// The iOS app (native/, Capacitor) loads this same page with window.Capacitor
// injected. Its push has to go through Capacitor's PushNotifications plugin,
// because Web Push doesn't exist in an app's web view, and everything about it
// has to stay invisible to a browser. This boots the real app headlessly twice:
//   - as a browser: no native path runs, push still means the service worker;
//   - with a fake Capacitor bridge: the bell asks iOS, registers the APNs token
//     with send-push as platform "ios", a tapped notification routes like
//     sw.js's notificationclick, and switching push off forgets the device.
// The server half (send-push's APNs path) is check:pushauth's.
/* global _nativeApp, enablePush, _prefsGranted, _syncLivePref, togglePush -- page globals, used inside page.evaluate */
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { launchChromium } from "./lib/browser.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const html = readFileSync(join(ROOT, "index.html"), "utf8");
check("the native code sits in one marked block", /\/\/ native:start[\s\S]+\/\/ native:end/.test(html));
check("the store build's roast asks for the filtered roast (store: true), the web's doesn't",
  /action:"trash-talk"[^\n]*store:\(typeof _nativeApp==="function"&&_nativeApp\(\)\)\|\|undefined/.test(html));
const outside = html.replace(/\/\/ native:start[\s\S]+?\/\/ native:end/, "");
check("every hook outside the block survives being lifted without it (typeof guard)",
  !/[^"]_nativeApp\(\)/.test(outside.replace(/typeof _nativeApp==="function"&&_nativeApp\(\)/g, "")));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await launchChromium(chromium);
const UID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "abcdef".repeat(11).slice(0, 64);

async function boot(native) {
  const page = await browser.newPage();
  const posts = [], deletes = [], errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.route(/supabase\.co/, async (route) => {
    const r = route.request(), u = r.url();
    if (u.includes("/functions/v1/send-push")) { posts.push(JSON.parse(r.postData() || "{}")); return route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' }); }
    if (u.includes("/rest/v1/apns_devices") && r.method() === "DELETE") { deletes.push(u); return route.fulfill({ status: 204, body: "" }); }
    if (u.includes("/auth/v1/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU", refresh_token: "r",
        expires_in: 3600, user: { id: UID, is_anonymous: true } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  if (native) {
    await page.addInitScript((tok) => {
      const L = {};
      window.__cap = { calls: [], L, granted: false };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", Plugins: { PushNotifications: {
        addListener: (ev, fn) => { L[ev] = fn; return Promise.resolve({ remove() {} }); },
        checkPermissions: () => Promise.resolve({ receive: window.__cap.granted ? "granted" : "prompt" }),
        requestPermissions: () => { window.__cap.calls.push("ask"); window.__cap.granted = true; return Promise.resolve({ receive: "granted" }); },
        register: () => { window.__cap.calls.push("register"); setTimeout(() => L.registration && L.registration({ value: tok }), 10); return Promise.resolve(); },
        unregister: () => { window.__cap.calls.push("unregister"); return Promise.resolve(); },
      } } };
    }, TOKEN);
  }
  await page.goto(base, { waitUntil: "load" });
  await page.waitForFunction(() => typeof enablePush === "function" && typeof _nativeApp === "function");
  await page.waitForTimeout(1500);
  return { page, posts, deletes, errs };
}

try {
  // ── A browser: nothing native happens ──────────────────────────────────
  {
    const { page, posts, errs } = await boot(false);
    check("in a browser _nativeApp() is false", (await page.evaluate(() => _nativeApp())) === false);
    await page.evaluate(() => { window.__nativeHit = false; window._nativeEnablePush = () => { window.__nativeHit = true; }; });
    await page.evaluate(() => { try { enablePush(); } catch { /* headless has no Notification */ } });
    await page.waitForTimeout(300);
    check("...the bell never takes the native path", (await page.evaluate(() => window.__nativeHit)) === false);
    check("...and no iPhone registration is ever sent", !posts.some((p) => p.platform === "ios"));
    check("...and the page boots without errors", errs.length === 0);
    await page.close();
  }

  // ── The iOS shell ──────────────────────────────────────────────────────
  {
    const { page, posts, deletes, errs } = await boot(true);
    check("in the iOS shell _nativeApp() is true and the plugin's four listeners are attached",
      (await page.evaluate(() => _nativeApp())) === true &&
      (await page.evaluate(() => Object.keys(window.__cap.L).sort().join())) === "pushNotificationActionPerformed,pushNotificationReceived,registration,registrationError");
    check("...and the page boots without errors", errs.length === 0);
    check("nothing registers before the user turns push on", !posts.some((p) => p.type === "register"));

    await page.evaluate(() => enablePush());
    await page.waitForFunction(() => localStorage.getItem("ufc_push") === "1", null, { timeout: 5000 }).catch(() => {});
    const reg = posts.find((p) => p.type === "register");
    check("the bell asks iOS, then registers the APNs token with send-push as platform \"ios\", as this user",
      (await page.evaluate(() => window.__cap.calls.slice(0, 2).join())) === "ask,register" &&
      !!reg && reg.platform === "ios" && reg.apns_token === TOKEN && reg.user_id === UID && !("endpoint" in reg));
    check("...push is then on, the token remembered, and prefs see the permission",
      (await page.evaluate(() => [localStorage.getItem("ufc_push"), localStorage.getItem("ufc_apns_token"), _prefsGranted()].join())) === `1,${TOKEN},true`);

    // A launch with push on re-registers (the refresh path the web runs through
    // _ensurePushFresh), carrying a changed live-results choice.
    posts.length = 0;
    await page.evaluate(() => { localStorage.setItem("ufc_live_results", "1"); _syncLivePref(); });
    await page.waitForTimeout(400);
    check("a preference change re-registers the same token with the new live-results choice",
      posts.some((p) => p.type === "register" && p.platform === "ios" && p.apns_token === TOKEN && p.live_results === true));

    // Taps: routed exactly as sw.js's notificationclick routes them.
    await page.evaluate(() => { window.__routed = []; window._routeTap = (k, m, s) => { window.__routed.push([k, m, s]); }; });
    const tap = (data) => page.evaluate((d) => window.__cap.L.pushNotificationActionPerformed({ notification: { data: d } }), data);
    await tap({ kind: "challenge", url: "./?inbox=1", title: "⚔️ Bob challenged you!", fullMessage: "Whole card — Dinner" });
    await tap({ title: "🎤 Joe Rogan (via Bob)", fullMessage: "Nice pick. — Joe Rogan" });
    await tap({ title: "🥊 UFC 333 — Main Card", fullMessage: "" });
    const routed = await page.evaluate(() => window.__routed);
    check("a tapped challenge opens the challenge inbox", JSON.stringify(routed[0]) === JSON.stringify(["challenge", "Whole card — Dinner", ""]));
    check("a tapped roast opens the sheet, crediting the sender from its title", JSON.stringify(routed[1]) === JSON.stringify(["", "Nice pick. — Joe Rogan", "Bob"]));
    check("a tap with nothing to show just opens the app", routed.length === 2);

    await page.evaluate(() => togglePush());
    await page.waitForTimeout(400);
    check("switching push off unregisters with iOS, deletes this device's row and forgets the token",
      (await page.evaluate(() => window.__cap.calls.includes("unregister"))) &&
      deletes.length === 1 && deletes[0].includes("token=eq." + TOKEN) &&
      (await page.evaluate(() => [localStorage.getItem("ufc_push"), localStorage.getItem("ufc_apns_token")].join())) === "0,");
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\ncheck:native — ${failures} failed`); process.exit(1); }
console.log("\ncheck:native — the iOS shell's push and taps work, and a browser never sees them");
