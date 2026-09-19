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

      // The scroll lock must hold the background still WITHOUT repositioning
      // <body>. body{position:fixed} lays the document against the initial
      // containing block, which under viewport-fit=cover includes the
      // status-bar band; iOS then blurs what is under the status bar and does
      // not undo it when the lock releases. That is how the fixed top-bar blur
      // came back every time an overlay was opened and closed.
      const locked = await page.evaluate(() => ({
        bodyPosition: document.body.style.position,
        bodyTop: document.body.style.top,
        bodyOverflow: document.body.style.overflow,
        htmlOverflow: document.documentElement.style.overflow,
      }));
      assert("scroll lock never sets body{position:fixed}", locked.bodyPosition !== "fixed");
      assert("scroll lock never offsets body with a top", !locked.bodyTop);
      assert("scroll lock does hold the background (body overflow hidden)", locked.bodyOverflow === "hidden");
      assert("scroll lock hides html overflow too", locked.htmlOverflow === "hidden");

      // Style strings alone cannot prove the lock WORKS: on iOS, overflow:hidden
      // does not stop a touch drag from scrolling the root, which is exactly why
      // body{position:fixed} was used before. Assert the behaviour instead — a
      // background touchmove must be cancelled, and a drag inside a real
      // scroller must not be.
      const drag = await page.evaluate(() => {
        // fromY -> toY so the lock can tell which way the finger went: a
        // scroller pinned at its edge must NOT be exempt for a drag that would
        // carry the gesture past that edge and into the page behind.
        const fire = (el, fromY = 10, toY = 10) => {
          const start = new Touch({ identifier: 1, target: el, clientX: 10, clientY: fromY });
          el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [start] }));
          const move = new Touch({ identifier: 1, target: el, clientX: 10, clientY: toY });
          const e = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [move] });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        // The panel is empty headlessly, so build a scroller that matches what
        // the leaderboard list is at runtime rather than skipping the case.
        const panel = document.getElementById("lbPanel") || document.body;
        const scroller = document.createElement("div");
        scroller.style.cssText = "overflow-y:auto;height:40px";
        scroller.innerHTML = "<div style='height:400px'></div>";
        panel.appendChild(scroller);
        const inner = scroller.firstChild;
        const out = {
          background: fire(document.getElementById("fnBanner") || document.body),
          scrollerIsReal: scroller.scrollHeight > scroller.clientHeight,
          // At the top, dragging DOWN would chain to the page behind: cancel.
          atTopDragDown: (scroller.scrollTop = 0, fire(inner, 10, 60)),
          // At the top, dragging UP still has somewhere to go: allow.
          atTopDragUp: (scroller.scrollTop = 0, fire(inner, 60, 10)),
          // Mid-scroll, either direction is the scroller's own business.
          midDragDown: (scroller.scrollTop = 100, fire(inner, 10, 60)),
          // At the bottom, dragging UP would chain: cancel.
          atBottomDragUp: (scroller.scrollTop = scroller.scrollHeight, fire(inner, 60, 10)),
        };
        out.insideScroller = out.midDragDown;
        scroller.remove();
        return out;
      });
      assert("a background drag is cancelled, so the page cannot scroll behind the overlay",
        drag.background === true);
      assert("...while a mid-scroll drag inside a real scroller is left alone",
        drag.scrollerIsReal && drag.midDragDown === false);
      assert("a scroller pinned at its top does not exempt a downward drag",
        drag.atTopDragDown === true);
      assert("...but still scrolls upward from there", drag.atTopDragUp === false);
      assert("a scroller pinned at its bottom does not exempt an upward drag",
        drag.atBottomDragUp === true);

      await page.evaluate(() => window.closeLeaderboard && window.closeLeaderboard());
      await page.waitForTimeout(300);
      const unlocked = await page.evaluate(() => ({
        bodyOverflow: document.body.style.overflow,
        htmlOverflow: document.documentElement.style.overflow,
        bodyOverscroll: document.body.style.overscrollBehavior,
      }));
      assert("closing the overlay releases the lock", !unlocked.bodyOverflow && !unlocked.htmlOverflow);
      assert("...and clears overscroll-behavior with it", !unlocked.bodyOverscroll);
      const dragAfter = await page.evaluate(() => {
        const el = document.getElementById("fnBanner") || document.body;
        const t = new Touch({ identifier: 1, target: el, clientX: 10, clientY: 10 });
        const e = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [t] });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      });
      assert("...and stops cancelling drags, so the page scrolls again", dragAfter === false);
    }
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
