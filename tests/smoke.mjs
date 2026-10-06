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
import { launchChromium } from "./lib/browser.mjs";

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
  const browser = await launchChromium(chromium);
  const page = await browser.newPage();
  const fatal = [];
  page.on("pageerror", (e) => fatal.push("Uncaught: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error" && !BENIGN.test(msg.text())) fatal.push("Console: " + msg.text()); });

  const checks = [];
  const assert = (name, cond) => { checks.push({ name, cond: !!cond }); };

  // What's New sits above the tab bar (as it must: see below), so a tab tap
  // would land on the popup. Mark it seen, as the other browser checks do.
  await page.addInitScript(() => { try { localStorage.setItem("ufc_whatsnew_seen", "9999"); } catch {} });
  try {
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(700); // let deferred init settle

    const state = await page.evaluate(() => ({
      title: document.title,
      eventsOk: typeof window.EVENTS !== "undefined" && Array.isArray(window.EVENTS) && window.EVENTS.length > 0,
      bodyText: (document.body?.innerText || "").trim().length,
      // League, in the tab bar, is how Ranks opens.
      lbBtn: !!document.querySelector("#tabBar #tabLeague[onclick*=goTab]"),
      hasCards: document.querySelectorAll("[class*=ev],[class*=card],[class*=fight]").length,
    }));

    assert("app title renders", state.title && state.title.length > 0);
    assert("EVENTS data present", state.eventsOk);
    assert("page has visible content", state.bodyText > 200);
    assert("core UI rendered (cards)", state.hasCards > 0);
    assert("leaderboard (League) tab present", state.lbBtn);

    // Exercise a core interaction: opening the leaderboard must not throw and must open the panel.
    if (state.lbBtn) {
      await page.click("#tabLeague");
      await page.waitForTimeout(400);
      const lbOpen = await page.evaluate(() => {
        const p = document.getElementById("lbPanel");
        return !!(p && (p.classList.contains("open") || getComputedStyle(p).display !== "none")) &&
          document.getElementById("tabLeague").classList.contains("active");
      });
      assert("tapping League opens the leaderboard panel and marks the tab", lbOpen);
      // The tab bar stays on top of Ranks, so Cards brings the home screen back.
      await page.click("#tabCards");
      await page.waitForTimeout(300);
      const lbClosed = await page.evaluate(() => !document.getElementById("lbPanel").classList.contains("open") &&
        document.getElementById("tabCards").classList.contains("active"));
      assert("tapping Cards closes Ranks and marks the Cards tab", lbClosed);
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
    // The tab bar (index.html's .tabbar) is fixed to the bottom of the screen,
    // so every bottom sheet must sit above it: at phone size, What's New's
    // "Got it" has to be the thing a tap at its centre lands on.
    await page.setViewportSize({ width: 390, height: 844 });
    const wnTap = await page.evaluate(async () => {
      window.renderWhatsNew(window.WHATS_NEW.slice(-1));
      await new Promise((r) => setTimeout(r, 500));   // past its slide-up
      const b = document.getElementById("wn-gotit-btn").getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      window.closeWhatsNew();
      return !!hit && hit.id === "wn-gotit-btn";
    });
    assert("What's New's Got it is tappable above the tab bar on a phone", wnTap);
    // The header title sits between the avatar and the search button: in every
    // theme, at a 375px phone, it must fit between them. Silver's script title
    // must stay mixed case (the shared .logo-text is uppercase for Bebas/Barlow).
    await page.setViewportSize({ width: 375, height: 812 });
    const titles = await page.evaluate(async () => {
      const out = [];
      for (const t of ["octagon", "neon", "usa", "noche", "silver", "seasonal"]) {
        window.setTheme(t);
        await new Promise((r) => setTimeout(r, 150));
        const kids = [...document.querySelector(".logo").children]
          .filter((e) => !e.classList.contains("noche-papel") && getComputedStyle(e).display !== "none")
          .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
        const av = document.getElementById("hdrAvatar").getBoundingClientRect().right;
        const sq = document.getElementById("hdrSearchBtn").getBoundingClientRect().left;
        const fits = Math.min(...kids.map((k) => k.left)) >= av && Math.max(...kids.map((k) => k.right)) <= sq;
        const tf = getComputedStyle(document.querySelector(".logo-text")).textTransform;
        out.push({ t, fits, tf });
      }
      window.setTheme("octagon");
      return out;
    });
    const misfit = titles.filter((x) => !x.fits).map((x) => x.t).join(", ");
    assert("every theme's header title fits between the avatar and search at 375px" + (misfit ? " (not: " + misfit + ")" : ""),
      titles.length === 6 && !misfit);
    assert("Silver's script title isn't forced to capitals", titles.some((x) => x.t === "silver" && x.tf === "none"));
    // FN Mode: once a bout is picked, its method and 🔒 lock are set right there,
    // through the same setters as the card row.
    const fnx = await page.evaluate(() => {
      const w = window, ev = w.EVENTS.find((e) => e.fights.some((f) => !f.winner && !w.fightLocked(e, f)));
      if (!ev) return { skipped: true };
      w.openFN(ev);
      const f = w.fnFights.find((x) => !x.winner && !w.fightLocked(ev, x));
      w.fnIdx = w.fnFights.indexOf(f);
      const k = w.pk(ev, f), had = w.preds[k];
      w.updateFN();
      const before = document.querySelectorAll("#fn-extras button").length;
      w.preds[k] = f.f1.n; w.updateFN();
      const btns = [...document.querySelectorAll("#fn-extras button")].map((b) => b.textContent);
      // A lock the server clamps (two already used on another phone) must
      // leave FN Mode too, not keep showing as locked.
      let clamped = true;
      if (w.locksOn(ev.date)) {
        const hadC = w.preds_conf[k];
        w.preds_conf[k] = 1; w.updateFN();
        const lockedShown = /Locked/.test(document.querySelector("#fn-extras .fn-ex-lock").textContent);
        w._lockClampCheck(k, [{ confidence: 0 }]);
        clamped = lockedShown && /Lock it/.test(document.querySelector("#fn-extras .fn-ex-lock").textContent);
        if (hadC === undefined) delete w.preds_conf[k]; else w.preds_conf[k] = hadC;
        w.saveConf();
      }
      if (had === undefined) delete w.preds[k]; else w.preds[k] = had;
      w.closeFN();
      return { before, btns, locks: w.locksOn(ev.date), clamped };
    });
    assert("FN Mode shows method (and lock) choices only once a bout is picked", fnx.skipped ||
      (fnx.before === 0 && ["KO/TKO", "Sub", "Dec"].every((m) => fnx.btns.includes(m)) &&
        (!fnx.locks || fnx.btns.some((b) => /Lock/.test(b)))));
    assert("a lock the server clamps is dropped from an open FN Mode too", fnx.skipped || fnx.clamped);
    // The Picks tab opens this week's card at a glance (one row per bout), not
    // the full history panel.
    const ps = await page.evaluate(() => {
      const w = window, ev = w._picksCard();
      document.getElementById("tabPicks").click();
      const out = { open: document.getElementById("picksSheet").classList.contains("open"),
        active: document.getElementById("tabPicks").classList.contains("active"),
        rows: document.querySelectorAll("#psList .ps-row").length, want: ev ? ev.fights.length : 0,
        history: document.getElementById("picksBody").classList.contains("open") };
      w.closePicksSheet();
      return out;
    });
    assert("the Picks tab opens this week's card, one row per bout, without the history panel",
      ps.open && ps.active && ps.rows === ps.want && !ps.history);
    // An open sheet keeps up with picks and results that land while it's up,
    // and on a live card a tapped bout opens the pick view on that bout.
    const ps2 = await page.evaluate(() => {
      const w = window, ev = w._picksCard();
      if (!ev) return { skipped: true };
      const f = ev.fights[ev.fights.length - 1], k = w.pk(ev, f), had = w.preds[k];
      delete w.preds[k];
      w.openPicksSheet();
      const before = document.getElementById("psSum").textContent;
      w.preds[k] = f.f1.n; w.render();
      const after = document.getElementById("psSum").textContent;
      if (had === undefined) delete w.preds[k]; else w.preds[k] = had;
      w.closePicksSheet(); w.render();
      const realLive = w.fnIsLive; w.fnIsLive = () => true;
      const target = ev.fights[1];
      w._fnJumpTo(ev, target);
      const jumped = !w.fnLive && w.fnFights[w.fnIdx] === target && !document.getElementById("fnMode").classList.contains("fn-mode-live");
      w.fnIsLive = realLive; w.closeFN();
      return { refreshed: before !== after, jumped };
    });
    assert("an open Picks sheet refreshes when picks or results change", ps2.skipped || ps2.refreshed);
    assert("on a live card, a bout tapped in the Picks sheet opens the pick view on that bout", ps2.skipped || ps2.jumped);
    // The menu: Year Wrapped only in December (clock pinned both ways), Edit
    // Profile only for a signed-in account.
    const menu = await page.evaluate(() => {
      const RD = Date, at = (m) => { window.Date = class extends RD { constructor(...a) { super(...(a.length ? a : [2026, m, 5, 12])); } static now() { return new RD(2026, m, 5, 12).getTime(); } }; window._syncProfile(); window.Date = RD; return document.getElementById("wrappedBtn").style.display; };
      return { dec: at(11), oct: at(9), profile: document.getElementById("profileBtn").style.display, signedIn: !!window._sessEmail() };
    });
    assert("Year Wrapped is in the menu in December and not in October", menu.dec === "" && menu.oct === "none");
    assert("Edit Profile shows in the menu's account area only when signed in", menu.signedIn ? menu.profile === "" : menu.profile === "none");
    // iOS zooms in on focus into a field under 16px and stays zoomed, which
    // sends the fixed header and tab bar sliding around. Every text field, the
    // fighter search and the dynamically built selects included, is 16px+.
    const small = await page.evaluate(() => {
      const probe = document.createElement("select"); probe.className = "fotn-sel"; document.body.appendChild(probe);
      const bad = [...document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]),textarea,select")]
        .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.className || e.tagName);
      probe.remove(); return bad;
    });
    assert("every text field is 16px or larger, so iOS doesn't zoom the page on focus" + (small.length ? " (" + small.join(", ") + ")" : ""), small.length === 0);
    // Closing the menu returns focus where it was, but never into a text
    // field: re-focusing the fighter search zoomed the page on iOS.
    const refocus = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const s = document.getElementById("fighterSearch"); s.focus();
      window.openMoreMenu(); await sleep(120); window.closeMoreMenu(); await sleep(20);
      const back = document.activeElement === s;
      const btn = document.getElementById("hdrAvatar"); btn.focus();
      window.openMoreMenu(); await sleep(120); window.closeMoreMenu(); await sleep(20);
      return { search: back, button: document.activeElement === btn };
    });
    assert("closing the menu never re-focuses a text field (iOS would zoom), but still returns focus to a button", !refocus.search && refocus.button);
    // Keyboard reach: Enter on a role="button" element that isn't a <button>
    // must activate it (the activity feed header toggles the feed).
    const kb = await page.evaluate(() => {
      const hdr = document.querySelector('.feed-hdr[role="button"]'), feed = document.getElementById("activityFeed");
      if (!hdr || !feed) return null;
      const was = feed.classList.contains("open");
      hdr.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const now = feed.classList.contains("open");
      if (now !== was) window.toggleActivityFeed();   // put it back
      return { tabbable: hdr.tabIndex === 0, toggled: now !== was };
    });
    assert("a role=\"button\" control is tabbable and Enter activates it", kb && kb.tabbable && kb.toggled);
    // Click targets built in JS (el.onclick = …) are made reachable as they
    // enter the page, and a control disabled the CSS way stays disabled from the
    // keyboard (Codex on #277: a .fn-not-picked panel could be re-picked).
    const dyn = await page.evaluate(async () => {
      const sp = document.createElement("span"); let hits = 0;
      sp.onclick = () => { hits++; };
      document.body.appendChild(sp);
      await new Promise((r) => setTimeout(r, 0));
      const reach = sp.getAttribute("role") === "button" && sp.tabIndex === 0;
      sp.style.pointerEvents = "none";
      sp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const blocked = hits === 0;
      sp.style.pointerEvents = "";
      sp.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      sp.remove();
      return { reach, blocked, works: hits === 1 };
    });
    assert("a click target built in JS gets role=button + tabindex as it enters the page", dyn && dyn.reach);
    assert("…Enter does nothing on one disabled with pointer-events:none, and Space works once it isn't", dyn && dyn.blocked && dyn.works);
    const unreachable = await page.evaluate(() => {
      window.openLeaderboard && window.openLeaderboard();
      return new Promise((r) => setTimeout(() => r([...document.querySelectorAll("div,span,li,td,p,section,header,img")]
        .filter((el) => typeof el.onclick === "function" && !el.hasAttribute("role")
          && !/event\.target\s*===\s*this/.test(el.getAttribute("onclick") || ""))
        .map((el) => el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : ""))), 400));
    });
    assert(`no click target in the booted app (home + Ranks) is unreachable by keyboard${unreachable.length ? ": " + unreachable.slice(0, 5).join(", ") : ""}`, unreachable.length === 0);
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
