// Guard: the site GitHub Pages publishes is complete.
//
// pages.yml publishes only what scripts/site_files.py lists (SITE), not the
// whole repository, so a file the app needs but the list leaves out would be a
// 404 in production while every other check, served from the repo root, passed.
// This builds the published site exactly as the deploy does, serves ONLY that
// directory, boots the app and every Fight Lab tab, and fails on any same-origin
// request that comes back 404. tests/test_site_files.py holds the list's other
// half (every top-level path classified, every referenced file published).
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { launchChromium } from "./lib/browser.mjs";

let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = await import("playwright-core")); }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

const work = mkdtempSync(join(tmpdir(), "site-"));
const SITE = join(work, "_site");
execFileSync("python3", [join(ROOT, "scripts/site_files.py"), SITE], { stdio: "inherit" });

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".mp3": "audio/mpeg", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
const missing = new Set();
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(SITE, p);
  if (!file.startsWith(SITE) || !existsSync(file) || statSync(file).isDirectory()) { missing.add(p); res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium(chromium);
try {
  const ctx = await browser.newContext({ serviceWorkers: "allow" });
  // Outside hosts are not the site's business here; answer them empty.
  await ctx.route((url) => !url.href.startsWith(base), (r) => r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  const page = await ctx.newPage();
  await page.goto(base + "/index.html", { waitUntil: "load", timeout: 30000 });
  await page.waitForTimeout(1500);
  check("the published app boots (EVENTS and FIGHTER_STATS defined)",
    await page.evaluate("typeof EVENTS !== 'undefined' && typeof FIGHTER_STATS !== 'undefined'"));
  // The service worker's install precaches its core list: every entry must exist.
  await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 20000 }).catch(() => {});
  for (const theme of ["usa", "noche", "seasonal"]) await page.evaluate(`applyTheme(${JSON.stringify(theme)})`);
  await page.waitForTimeout(800);

  const lab = await ctx.newPage();
  await lab.goto(base + "/lab.html#iq", { waitUntil: "load", timeout: 30000 });
  await lab.waitForFunction(() => !/Loading the lab/.test(document.getElementById("main").textContent), null, { timeout: 20000 }).catch(() => {});
  for (const t of ["iq", "market", "week", "matchup", "party", "hub"]) {
    await lab.click(`#tabs button[data-tab="${t}"]`).catch(() => {});
    await lab.waitForTimeout(250);
  }
  check("the published Lab boots", await lab.evaluate("typeof EVENTS !== 'undefined' && !!window.PickEngine"));
  for (const p of ["/privacy.html", "/terms.html", "/support.html", "/manifest.json"]) {
    const r = await page.request.get(base + p);
    check(`${p} is published`, r.ok());
  }
  // Generated share-image names (card-recap.png …) are download names, never
  // requested. /favicon.ico is the browser's own probe: the repo has never had
  // one (the pages declare their icons), so production 404s it today as well.
  missing.delete("/favicon.ico");
  check(`no same-origin request 404s on the published site${missing.size ? " (" + [...missing].join(", ") + ")" : ""}`, missing.size === 0);
  await ctx.close();
} finally {
  await browser.close();
  server.close();
  rmSync(work, { recursive: true, force: true });
}

if (failures) { console.error(`\ncheck-site: ${failures} check(s) failed — the published site is missing something.`); process.exit(1); }
console.log("\ncheck-site: the published site is complete.");
