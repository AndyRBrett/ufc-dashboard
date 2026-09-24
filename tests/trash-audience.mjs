// Trash-talk routing test — who the roast is ABOUT vs who RECEIVES it.
//
// The whole risk of the audience option is delivering to the wrong people: a
// roast written about one person but broadcast to the board, or worse, a
// "just them" roast that leaks to everyone. Neither is visible in a syntax
// check or a boot smoke test, and neither is something you want to discover
// from the group chat. This drives the real sheet in headless Chromium with a
// stubbed leaderboard and asserts the exact send-push payload.
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
  catch { console.error("Playwright not installed. Run `npm install`."); process.exit(2); }
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

// Stand up the sheet the way selectTrashPersona would, with a known board:
// three opponents, all individually targetable.
const SETUP = () => {
  window.__pushes = [];
  const realFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).indexOf("send-push") >= 0) {
      window.__pushes.push(JSON.parse(opts.body));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
    }
    return realFetch.apply(this, arguments);
  };
  window._trashMe = { user_id: "me", nickname: "AB" };
  // The push's exclude_user_id is USER_ID, which the app only sets once its
  // anonymous sign-in to the live Supabase settles. Offline that fails fast and
  // falls back to a local id; in CI it's a real round-trip that can outlast the
  // page's settle time, leaving USER_ID null and "still excludes the sender"
  // failing on network latency rather than on the code. Pin it like _trashMe.
  window.USER_ID = "me";
  window._trashOpponents = [
    { user_id: "u-jpeso", nickname: "JPeso" },
    { user_id: "u-t", nickname: "T" },
    { user_id: "u-dereko", nickname: "Dereko" },
  ];
  window._trashPersona = "Chael Sonnen";
  window.renderTrashTargets();
};
const pick = (label) => {
  const chip = Array.from(document.querySelectorAll("#trashChips .lb-trash-chip"))
    .find((c) => c.dataset.label === label);
  window.toggleTrashTarget(chip);
};

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
  const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
  const page = await browser.newPage();
  const fatal = [];
  page.on("pageerror", (e) => fatal.push("Uncaught: " + e.message));

  const checks = [];
  const assert = (name, cond) => checks.push({ name, cond: !!cond });

  try {
    await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(700);

    // No target picked yet — nothing to choose an audience for.
    let r = await page.evaluate(`(${SETUP})(); (function(){
      return {row: document.getElementById("trashAudience").style.display,
              audience: window._trashAudience};
    })()`);
    assert("audience row hidden before a target is picked", r.row === "none");
    assert("audience defaults to the targets only", r.audience === "targets");

    // Pick one of three — now the two questions can differ.
    r = await page.evaluate(`(${pick})("JPeso"); (function(){
      return {row: document.getElementById("trashAudience").style.display,
              note: document.getElementById("trashAudNote").textContent};
    })()`);
    assert("audience row appears for a partial selection", r.row === "block");
    assert("note names the target for a 'just them' send", /Only JPeso/.test(r.note));

    // Default routing: only the roasted party gets the push.
    let before = await page.evaluate("window.__pushes.length");
    r = await page.evaluate(`(function(){
      window._trashText = "You pick like you're still asleep — Chael Sonnen";
      window.fireTrashTalk();
      return {btn: document.getElementById("trashSendBtn").textContent};
    })()`);
    // The send is async (auth, then fetch): wait for the push itself. A fixed
    // 300ms sleep read an empty list on a slow CI runner and failed the deploy.
    await page.waitForFunction((n) => window.__pushes.length > n, before, { timeout: 10000 });
    let push = (await page.evaluate("window.__pushes")).slice(-1)[0];
    assert("'just them' sends only to the target", JSON.stringify(push.include_user_ids) === JSON.stringify(["u-jpeso"]));
    assert("'just them' still excludes the sender", push.exclude_user_id !== undefined);

    // Flip to the whole group: same single target, everyone receives.
    r = await page.evaluate(`(function(){
      window.setTrashAudience("group");
      return {note: document.getElementById("trashAudNote").textContent,
              btn: document.getElementById("trashSendBtn").textContent};
    })()`);
    assert("note says the group gets it but it's about the target", /Everyone on the board/.test(r.note) && /JPeso/.test(r.note));
    assert("send button reads as a broadcast", /everyone/i.test(r.btn));

    before = await page.evaluate("window.__pushes.length");
    await page.evaluate(`window.fireTrashTalk()`);
    await page.waitForFunction((n) => window.__pushes.length > n, before, { timeout: 10000 });
    push = (await page.evaluate("window.__pushes")).slice(-1)[0];
    assert("'whole group' broadcasts (no include list)", !push.include_user_ids);
    assert("'whole group' still excludes the sender", !!push.exclude_user_id);

    // Selecting everyone as the TARGET collapses the distinction — the row
    // hides and the audience must not stay stuck on "group".
    r = await page.evaluate(`(${pick})("Everyone"); (function(){
      return {row: document.getElementById("trashAudience").style.display,
              audience: window._trashAudience};
    })()`);
    assert("audience row hides when everyone is already the target", r.row === "none");
    assert("audience resets when the row hides", r.audience === "targets");

    // Rebuilding the picker (new persona) must not carry a stale broadcast over.
    r = await page.evaluate(`(function(){
      window.setTrashAudience("group");
      window.renderTrashTargets();
      return window._trashAudience;
    })()`);
    assert("re-opening the picker resets to 'just them'", r === "targets");

    // ── Early fight week on "This Event": only the sender has picked the card.
    // The sheet used to take its cast from the event board alone, so "Roast
    // who?" came up empty with no way forward. Everyone still active on the
    // all-time board must be roastable, flagged as not having picked, and a
    // long-gone player must not be dragged back in.
    const EARLY = (senderPicked) => {
      const today = new Date().toISOString().slice(0, 10);
      const recent = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
      const ancient = new Date(Date.now() - 300 * 864e5).toISOString().slice(0, 10);
      const row = (uid, nick, date, f1) => ({ user_id: uid, nickname: nick, event_date: date, f1, f2: f1 + "-opp", pick: f1, method: "", confidence: 0, updated_at: date + "T00:00:00Z", bonus_pick: null });
      const EV = "2099-01-01";
      window.USER_ID = "me";
      window.lbMode = "current";
      window._lbCtxEvName = "UFC 999";
      window._lbCtxEvDate = EV;
      window.userName = "T";
      window._lbRows = [
        senderPicked ? row("me", "T", EV, "Alpha") : row("me", "T", recent, "Old"),
        row("u-ab", "AB", recent, "Bravo"),
        row("u-dereko", "Dereko", recent, "Charlie"),
        row("u-gone", "Ghost", ancient, "Delta"),
      ];
      window._lbSorted = window._lbScoreUsers(window._lbRows, (p) => p.event_date === EV);
      window.__toasts = [];
      window.toast = (m) => window.__toasts.push(m);
      document.getElementById("trashSheet").classList.remove("open");
      window.openTrashTalk();
      if (!window._trashMe) return { opened: false, toasts: window.__toasts };
      window.selectTrashPersona("Chael Sonnen");
      const chips = Array.from(document.querySelectorAll("#trashChips .lb-trash-chip")).map((c) => c.dataset.label);
      const note = document.getElementById("trashNoPicksNote");
      return {
        opened: document.getElementById("trashSheet").classList.contains("open"),
        toasts: window.__toasts,
        chips,
        note: note.style.display === "none" ? "" : note.textContent,
        myRank: window._trashMyRank,
        facts: window._trashFacts(window._trashMe, window._trashOpponents),
        myRecord: window._trashRecord(window._trashMe),
      };
    };
    r = await page.evaluate(`(${EARLY})(true)`);
    assert("early week: the sheet opens with the sender as the only picker", r.opened && !r.toasts.length);
    assert("early week: players who haven't picked the card are roastable",
      r.chips.includes("AB") && r.chips.includes("Dereko"));
    assert("early week: a player gone past the active window is not dragged back in", !r.chips.includes("Ghost"));
    assert("early week: the sheet says who hasn't picked, and that it's fair game",
      /No picks yet for UFC 999: AB, Dereko/.test(r.note) && /roast them for it/.test(r.note));
    assert("early week: the facts say they haven't picked, and forbid inventing a record",
      /AB — hasn't made a single pick for UFC 999 yet/.test(r.facts) && /do NOT invent picks/.test(r.facts));

    // Main Card scope drops prelim-only pickers from the shown board. They
    // HAVE picked this card, so they must not be labelled as not having picked.
    r = await page.evaluate(`(function(){
      const EV = "2099-01-01";
      const row = (uid, nick, date, f1) => ({ user_id: uid, nickname: nick, event_date: date, f1, f2: f1 + "-opp", pick: f1, method: "", confidence: 0, updated_at: date + "T00:00:00Z", bonus_pick: null });
      window._lbRows = [row("me", "T", EV, "Alpha"), row("u-tris", "Tristin", EV, "Prelim"), row("u-ab", "AB", new Date().toISOString().slice(0,10), "Bravo")];
      window._lbSorted = window._lbScoreUsers(window._lbRows, (p) => p.event_date === EV && p.user_id !== "u-tris");
      window.__toasts = [];
      window.openTrashTalk(); window.selectTrashPersona("Chael Sonnen");
      const tris = window._trashOpponents.find((o) => o.nickname === "Tristin");
      return { tris: tris && { flagged: !!tris.noEventPicks, picks: tris.picks.length },
               note: document.getElementById("trashNoPicksNote").textContent };
    })()`);
    assert("a prelim-only picker hidden by Main Card scope is still roastable", !!r.tris);
    assert("a prelim-only picker is not labelled as having no picks",
      r.tris && !r.tris.flagged && r.tris.picks === 1 && !/Tristin/.test(r.note) && /AB/.test(r.note));

    // Someone who has never picked anything at all has no row anywhere.
    r = await page.evaluate(`(function(){
      const row = (uid, nick, date, f1) => ({ user_id: uid, nickname: nick, event_date: date, f1, f2: f1 + "-opp", pick: f1, method: "", confidence: 0, updated_at: date + "T00:00:00Z", bonus_pick: null });
      const recent = new Date().toISOString().slice(0,10);
      window._lbRows = [row("u-ab", "AB", recent, "Bravo")];
      window._lbSorted = [];
      window.__toasts = []; window._trashMe = null;
      window.openTrashTalk();
      return { me: window._trashMe && window._trashMe.nickname, toasts: window.__toasts };
    })()`);
    assert("a first-time player with no picks anywhere can still roast", r.me === "T" && !r.toasts.length);

    r = await page.evaluate(`(${EARLY})(false)`);
    assert("a sender with no picks on the card can still roast", r.opened && !r.toasts.length && r.chips.includes("AB"));
    assert("a sender with no picks on the card gets no rank for it", r.myRank === 0);
    assert("a sender with no picks on the card is described that way, not as 0-for-anything",
      /hasn't made a single pick for UFC 999/.test(r.myRecord));
  } catch (e) {
    fatal.push("Run failed: " + e.message);
  } finally {
    await browser.close();
    server.close();
  }

  let bad = 0;
  for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
  if (fatal.length) { console.error("\n  Fatal errors:"); fatal.slice(0, 10).forEach((e) => console.error("    • " + e.slice(0, 300))); }
  if (bad || fatal.length) { console.error(`\ntrash-audience: FAILED (${bad} assertion(s), ${fatal.length} fatal error(s)) — DO NOT deploy.`); process.exit(1); }
  console.log("\ntrash-audience: roasts reach exactly who they're aimed at.");
}

main().catch((e) => { console.error("trash-audience harness crashed:", e); server.close(); process.exit(1); });
