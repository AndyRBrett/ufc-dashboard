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
    r = await page.evaluate(`(function(){
      window._trashText = "You pick like you're still asleep — Chael Sonnen";
      window.fireTrashTalk();
      return {btn: document.getElementById("trashSendBtn").textContent};
    })()`);
    await page.waitForTimeout(300);
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

    await page.evaluate(`window.fireTrashTalk()`);
    await page.waitForTimeout(300);
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
