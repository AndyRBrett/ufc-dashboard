// Headless boot smoke test — the safety net for "the app still runs".
//
// check-web.mjs catches syntax-level breaks; this catches the ones that
// compile fine but throw on load (a renamed function, an undefined global, a
// bad data shape) — the kind that white-pages the app for everyone mid-card.
// It serves the real files over HTTP, opens index.html in headless Chromium,
// and asserts the app actually boots and its core surfaces work.
//
// Playwright resolution: uses the locally-installed `playwright` package (CI
// installs it via npm ci). Launches the system Chromium at PLAYWRIGHT_BROWSERS_PATH
// when present, else Playwright's own download.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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

// Static server rooted at the repo so relative asset requests resolve like production.
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

// Errors that are environment noise, not app bugs (no real backend in the test).
const BENIGN = /supabase|gkccophrdqtqcowmblre|wikipedia|wikimedia|Failed to load resource|net::|ERR_|the server responded with a status|401|403|Load failed|NetworkError|fetch/i;

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
  const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage();
  const fatal = [];
  page.on("pageerror", (e) => fatal.push("Uncaught: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !BENIGN.test(msg.text())) fatal.push("Console: " + msg.text()); });

  const checks = [];
  const assert = (name, cond) => { checks.push({ name, cond: !!cond }); };

  try {
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(700); // let deferred init settle

    const state = await page.evaluate(() => ({
      title: document.title,
      eventsOk: typeof window.EVENTS !== "undefined" && Array.isArray(window.EVENTS) && window.EVENTS.length > 0,
      bodyText: (document.body?.innerText || "").trim().length,
      lbBtn: !!document.querySelector("[onclick*=openLeaderboard]"),
      hasCards: document.querySelectorAll("[class*=ev],[class*=card],[class*=fight]").length,
    }));

    assert("app title renders", state.title && state.title.length > 0);
    assert("EVENTS data present", state.eventsOk);
    assert("page has visible content", state.bodyText > 200);
    assert("core UI rendered (cards)", state.hasCards > 0);
    assert("leaderboard button present", state.lbBtn);

    // Exercise a core interaction: opening the leaderboard must not throw and must open the panel.
    if (state.lbBtn) {
      await page.evaluate(() => window.openLeaderboard && window.openLeaderboard());
      await page.waitForTimeout(400);
      const lbOpen = await page.evaluate(() => {
        const p = document.getElementById("lbPanel");
        return !!(p && (p.classList.contains("open") || getComputedStyle(p).display !== "none"));
      });
      assert("leaderboard panel opens", lbOpen);
    }
    // Year Wrapped's share card: a real canvas draw in a real browser, with
    // long names that have to be shrunk/ellipsised to fit.
    const card = await page.evaluate(() => {
      if (typeof window.drawWrappedCard !== "function") return null;
      const w = { year: "2026", name: "🐺 Somebody With A Really Very Long Nickname Indeed", rank: 2, of: 5, pts: 132.5,
        correct: 90, picks: 140, accuracy: 64, cards: 14, bestStreak: 9,
        bestCard: { pts: 14.5, evName: "UFC Fight Night: Nurmagomedov vs. Song", date: "2026-08-29" },
        upset: { pick: "Nina Nikolija Milosevic", line: 455 }, ride: { name: "Alonzo Menifield", n: 3, w: 2 },
        twin: { name: "🦅 Tristin", pct: 71 }, title: { reigns: 2, defenses: 3, holding: true },
        archetype: { em: "🐺", name: "Underdog Hunter" } };
      const cv = window.drawWrappedCard(document.createElement("canvas"), w);
      const px = cv.getContext("2d").getImageData(540, 1300, 1, 1).data;
      return { w: cv.width, h: cv.height, png: cv.toDataURL("image/png").length, painted: px[3] === 255 };
    });
    assert("Wrapped share card draws a 1080×1920 image", card && card.w === 1080 && card.h === 1920 && card.painted && card.png > 20000);
  } catch (e) {
    fatal.push("Navigation/boot failed: " + e.message);
  } finally {
    await browser.close();
    server.close();
  }

  let bad = 0;
  for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
  if (fatal.length) { console.error("\n  Fatal errors during boot:"); fatal.slice(0, 10).forEach((e) => console.error("    • " + e.slice(0, 200))); }

  if (bad || fatal.length) { console.error(`\nsmoke: FAILED (${bad} assertion(s), ${fatal.length} fatal error(s)) — DO NOT deploy.`); process.exit(1); }
  console.log("\nsmoke: app boots and core surfaces work.");
}

main().catch((e) => { console.error("smoke harness crashed:", e); server.close(); process.exit(1); });
