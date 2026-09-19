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
        const move = (el, y, x = 10) => {
          const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          const e = new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [t] });
          el.dispatchEvent(e);
          return e.defaultPrevented;
        };
        const start = (el, y, x = 10) => {
          const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t] }));
        };
        const fire = (el, fromY = 10, toY = 10) => { start(el, fromY); return move(el, toY); };
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

        // Reversing direction mid-gesture: each move must be judged against the
        // PREVIOUS one. Measured against touchstart, dy stays negative until the
        // finger passes where it began, so a downward drag at the top still
        // reads as upward and is exempted straight through to the root.
        scroller.scrollTop = 0;
        start(inner, 100);
        out.reverseFirstUp = move(inner, 50);   // upward, room below: allowed
        out.reverseThenDown = move(inner, 60);  // now downward at the top: cancel

        // A pinned inner scroller must hand off to a scrollable ancestor rather
        // than cancelling: .chat-history inside an overflowing .modal.
        const outer = document.createElement("div");
        outer.style.cssText = "overflow-y:auto;height:40px";
        const nested = document.createElement("div");
        nested.style.cssText = "overflow-y:auto;height:20px";
        nested.innerHTML = "<div style='height:200px'></div>";
        outer.appendChild(nested);
        outer.appendChild(Object.assign(document.createElement("div"), { style: "height:400px" }));
        panel.appendChild(outer);
        nested.scrollTop = 0;       // inner pinned at its top
        outer.scrollTop = 100;      // ...but the parent still has room upward
        out.nestedHandoff = fire(nested.firstChild, 10, 60);
        out.nestedIsReal = nested.scrollHeight > nested.clientHeight &&
                           outer.scrollHeight > outer.clientHeight;
        outer.remove();

        // Sideways swipes on a horizontal strip (.fnl-stand in live FN mode,
        // .filter-wrap) must survive the lock, and stop at its edges the same
        // way a vertical scroller does.
        const strip = document.createElement("div");
        strip.style.cssText = "overflow-x:auto;width:40px;white-space:nowrap";
        strip.innerHTML = "<div style='width:400px;display:inline-block'></div>";
        panel.appendChild(strip);
        const stripInner = strip.firstChild;
        out.stripIsReal = strip.scrollWidth > strip.clientWidth;
        strip.scrollLeft = 100;                                  // mid-scroll
        start(stripInner, 10, 10); out.stripMid = move(stripInner, 10, 60);
        strip.scrollLeft = 0;                                    // pinned left
        start(stripInner, 10, 10); out.stripAtLeftRight = move(stripInner, 10, 60);
        strip.scrollLeft = strip.scrollWidth;                    // pinned right
        start(stripInner, 10, 60); out.stripAtRightLeft = move(stripInner, 10, 10);
        // A gesture scrolls one axis. A mostly-VERTICAL drag that happens to
        // start over the horizontal strip must not be exempted by it — the
        // vertical component would scroll the root behind the overlay.
        strip.scrollLeft = 100;                                  // could move sideways
        start(stripInner, 10, 10);
        out.stripVerticalDrag = move(stripInner, 80, 12);        // dy 70, dx 2
        strip.remove();

        // ...and the mirror: a mostly-HORIZONTAL drag over a vertical-only
        // scroller must not be exempted by it either.
        scroller.scrollTop = 100;
        start(inner, 10, 10);
        out.vScrollerHorizontalDrag = move(inner, 12, 80);       // dx 70, dy 2

        // The axis is latched for the GESTURE, not recomputed per move. A
        // horizontal swipe that opens with a vertical-dominant pixel, or
        // pauses mid-flick, must not flip to the vertical branch and get
        // cancelled — on iOS one early cancel kills the rest of the touch.
        const strip2 = document.createElement("div");
        strip2.style.cssText = "overflow-x:auto;width:40px;white-space:nowrap";
        strip2.innerHTML = "<div style='width:400px;display:inline-block'></div>";
        panel.appendChild(strip2);
        const s2i = strip2.firstChild;
        strip2.scrollLeft = 100;
        start(s2i, 10, 10);
        move(s2i, 12, 11);                       // jittery opener: dy 2, dx 1
        out.jitterThenSwipe = move(s2i, 13, 60); // now clearly horizontal
        // A pause mid-gesture (one vertical-dominant move) must not flip it.
        out.pauseMidSwipe = move(s2i, 16, 61);   // dy 3, dx 1 — still horizontal
        strip2.remove();

        // And the latch holds the other way: a vertical gesture stays vertical
        // even if one later move happens to be horizontal-dominant.
        scroller.scrollTop = 100;
        start(inner, 10, 10);
        move(inner, 60, 10);                     // clearly vertical: latches v
        out.vLatchHeld = move(inner, 62, 70);    // dx 60, dy 2 — still vertical

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
      assert("a reversed gesture is judged on the latest move, not the touchstart",
        drag.reverseFirstUp === false && drag.reverseThenDown === true);
      assert("a pinned inner scroller hands off to a parent that can still scroll",
        drag.nestedIsReal && drag.nestedHandoff === false);
      assert("a sideways swipe on a horizontal strip is left alone",
        drag.stripIsReal && drag.stripMid === false);
      assert("...and is cancelled at the strip's own edges",
        drag.stripAtLeftRight === true && drag.stripAtRightLeft === true);
      assert("a mostly-vertical drag is not exempted by a horizontal strip",
        drag.stripVerticalDrag === true);
      assert("...nor a mostly-horizontal drag by a vertical-only scroller",
        drag.vScrollerHorizontalDrag === true);
      assert("a jittery opener does not flip a horizontal swipe to the vertical branch",
        drag.jitterThenSwipe === false);
      assert("...nor does a pause mid-swipe", drag.pauseMidSwipe === false);
      assert("a latched vertical gesture stays vertical through a sideways move",
        drag.vLatchHeld === false);

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
