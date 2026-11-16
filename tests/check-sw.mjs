// Guard: what an app open downloads through the service worker.
//
// sw.js serves the page, data.js, scoring.js and kernel.js network-first. It
// used to fetch them with `cache: 'reload'`, which always asks the server but
// never sends the validator, so an unchanged ~900 KB index.html (and data.js
// between scraper commits) came down in full on every open. `cache: 'no-cache'`
// asks the same server with If-None-Match: a 304 when nothing changed, the new
// file when something did. This drives a real browser with the real sw.js
// against a server that answers like GitHub Pages (ETag, max-age=600) and holds
// both halves: an unchanged file is revalidated, never re-sent, and a changed
// one is never served stale.
//
// It also holds that the mascot recordings are fetched only for their own
// theme: every visitor used to download the USA eagles and the Noche grito
// (~370 KB), and every install precached this month's seasonal cue (up to
// ~2.1 MB) whatever theme it ran.
//
// No request routing anywhere: Playwright turns the HTTP cache off as soon as
// a route is set, and without a cached copy a browser never sends a
// validator, so the test could not tell 'reload' from 'no-cache'. Outside
// hosts (Supabase, Wikipedia) are left to fail on their own; the app boots
// without them.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./lib/browser.mjs";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = await import("playwright-core")); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".png": "image/png", ".css": "text/css", ".svg": "image/svg+xml" };
const override = new Map();         // path → replacement body, to simulate a new commit
let log = [];                       // [path, status] as the server answered it
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) { log.push([p, 404]); res.writeHead(404); res.end(); return; }
  const body = override.has(p) ? Buffer.from(override.get(p)) : readFileSync(file);
  const etag = '"' + createHash("sha1").update(body).digest("hex") + '"';
  // GitHub Pages: an ETag and a 10-minute max-age on every file.
  const headers = { "content-type": TYPES[extname(file)] || "application/octet-stream", etag, "cache-control": "max-age=600" };
  if (req.headers["if-none-match"] === etag) { log.push([p, 304]); res.writeHead(304, headers); res.end(); return; }
  log.push([p, 200]);
  res.writeHead(200, headers); res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const answered = (path) => log.filter(([p]) => p === path).map(([, s]) => s);

const browser = await launchChromium(chromium);
try {
  // ---------------------------------------------------- 1. revalidate, not re-send
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 30000 });
    // The SW installs (skipWaiting + clients.claim) and takes this page over.
    const controlled = await page.waitForFunction(() => !!navigator.serviceWorker && !!navigator.serviceWorker.controller,
      null, { timeout: 20000 }).then(() => true, () => false);
    check("the service worker installs and controls the page", controlled);
    check("installing it fetches no mascot sound on the default theme",
      !log.some(([p]) => p.startsWith("/sounds/")) || (console.error("    " + log.filter(([p]) => p.startsWith("/sounds/")).map(([p]) => p).join(", ")), false));

    // Each "open" is a new page in the same browser context: the same HTTP
    // cache and service worker, as reopening the app has. page.reload() would
    // not do: Chrome's in-page memory cache hands a reloaded document its
    // scripts without asking the service worker at all, under 'reload' and
    // 'no-cache' alike, so the test could never see the next open's requests.
    const open = async () => {
      const pg = await ctx.newPage();
      await pg.goto(base + "/index.html", { waitUntil: "load", timeout: 30000 });
      await pg.waitForTimeout(300);
      return pg;
    };
    await page.close();

    // A second open, nothing changed: the SW asks the server, which says 304.
    log = [];
    let pg2 = await open();
    const pageStatus = answered("/index.html"), dataStatus = answered("/data.js");
    check(`an unchanged index.html is revalidated, not re-sent (server answered ${pageStatus.join(",") || "nothing"})`,
      pageStatus.length > 0 && pageStatus.every((s) => s === 304));
    check(`an unchanged data.js is revalidated, not re-sent (server answered ${dataStatus.join(",") || "nothing"})`,
      dataStatus.length > 0 && dataStatus.every((s) => s === 304));
    check("…and the app still boots from those answers", await pg2.evaluate("typeof EVENTS !== 'undefined' && Array.isArray(EVENTS)"));

    // A new commit: data.js changes. The next open must get it, never the old copy.
    override.set("/data.js", readFileSync(join(ROOT, "data.js"), "utf8") + "\nvar __SW_PROBE=1;\n");
    await pg2.close();
    log = [];
    const pg3 = await open();
    check(`a changed data.js is fetched in full (server answered ${answered("/data.js").join(",") || "nothing"})`,
      answered("/data.js").includes(200));
    check("…and the page runs the new copy, not the cached one", await pg3.evaluate("typeof __SW_PROBE !== 'undefined' && __SW_PROBE === 1"));
    override.clear();
    await ctx.close();
  }

  // ------------------------------------------------ 2. each sound for its own theme
  for (const [theme, want, notWant] of [
    ["noche", ["/sounds/season-may.mp3"], ["/sounds/eagle-1.mp3", "/sounds/eagle-2.mp3"]],
    ["usa", ["/sounds/eagle-1.mp3", "/sounds/eagle-2.mp3"], ["/sounds/season-may.mp3"]],
  ]) {
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    await ctx.addInitScript((t) => { try { localStorage.setItem("ufc_theme", t); } catch (e) {} }, theme);
    const page = await ctx.newPage();
    log = [];
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(800);
    const got = log.map(([p]) => p).filter((p) => p.startsWith("/sounds/"));
    check(`the ${theme} theme fetches its own recording (${want.join(", ")}) and no other mascot's`,
      want.every((w) => got.includes(w)) && !notWant.some((n) => got.includes(n)) || (console.error("    fetched: " + (got.join(", ") || "none")), false));
    await ctx.close();
  }
  {
    // Switching theme in the app fetches the new mascot's sound then, not before.
    const ctx = await browser.newContext({ serviceWorkers: "block" });
    const page = await ctx.newPage();
    log = [];
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(500);
    const before = log.some(([p]) => p.startsWith("/sounds/"));
    await page.evaluate("applyTheme('usa')");
    await page.waitForTimeout(500);
    check("the default theme fetches no mascot sound, and switching to USA fetches the eagles",
      !before && answered("/sounds/eagle-1.mp3").length > 0 && answered("/sounds/eagle-2.mp3").length > 0);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\ncheck-sw: ${failures} check(s) failed.`); process.exit(1); }
console.log("\ncheck-sw: an unchanged file is a 304, a changed one is fresh, and each sound waits for its theme.");
