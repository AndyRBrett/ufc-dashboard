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
