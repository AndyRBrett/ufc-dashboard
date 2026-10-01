// Report and block (App Store guideline 1.2: an app with user content must let
// people report it and block abusive users), and the privacy policy page.
//
//   1. 0013_safety.sql, run for real in PGlite (Postgres in WASM): who can see,
//      add and remove a block; a report is write-only and filed only as
//      yourself; the daily report cap; a blocked pair can't challenge each
//      other, in either direction.
//   2. The app, headless: the server's block list is adopted, a blocked
//      player's challenges leave the inbox, a received roast carries Report and
//      Block, a report posts the right row (and blocks, if asked), and Privacy &
//      Safety lists and unblocks.
//   3. privacy.html exists, runs no script, and the app links to it.
//
// send-push's side (no social push crosses a block) is in check:pushauth.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

// --- 1. the migration ----------------------------------------------------------
{
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  await db.exec(readFileSync(join(ROOT, "supabase/migrations/0003_challenges.sql"), "utf8"));
  await db.exec(readFileSync(join(ROOT, "supabase/migrations/0013_safety.sql"), "utf8"));
  // Applying it twice must be harmless (every migration here is re-runnable).
  await db.exec(readFileSync(join(ROOT, "supabase/migrations/0013_safety.sql"), "utf8"));

  const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222", C = "33333333-3333-3333-3333-333333333333";
  async function as(role, uid, sql, params) {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${role};`);
    try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
  }
  const ok = async (...a) => { try { await as(...a); return true; } catch { return false; } };

  check("a player can block someone", await ok("authenticated", A, `insert into user_blocks (blocker_id, blocked_id, blocked_name) values ($1, $2, 'Bob')`, [A, B]));
  check("...but never as someone else", !(await ok("authenticated", A, `insert into user_blocks (blocker_id, blocked_id) values ($1, $2)`, [C, B])));
  check("...nor themselves", !(await ok("authenticated", A, `insert into user_blocks (blocker_id, blocked_id) values ($1, $1)`, [A])));
  check("the anon key can't block anyone", !(await ok("anon", "", `insert into user_blocks (blocker_id, blocked_id) values ($1, $2)`, [A, C])));
  check("the blocker sees their block", (await as("authenticated", A, `select * from user_blocks`)).rows.length === 1);
  check("the blocked person can't see it (they aren't told)", (await as("authenticated", B, `select * from user_blocks`)).rows.length === 0);
  check("the blocked person can't delete it", (await as("authenticated", B, `delete from user_blocks where blocked_id = $1 returning 1`, [B])).rows.length === 0
    && (await db.query(`select * from user_blocks`)).rows.length === 1);

  const chal = (who, target) => as("authenticated", who,
    `insert into challenges (challenger_id, challenger_name, target_id, target_name, event_date, event_name) values ($1, 'x', $2, 'y', '2026-10-03', 'Card')`, [who, target]);
  const refused = async (p) => { try { await p; return false; } catch { return true; } };
  check("a blocked player can't challenge the one who blocked them", await refused(chal(B, A)));
  check("...nor the blocker them (a block cuts both ways)", await refused(chal(A, B)));
  check("anyone else still can", !(await refused(chal(C, A))));
  check("a challenge still can't be sent as someone else", await refused(as("authenticated", C,
    `insert into challenges (challenger_id, challenger_name, target_id, target_name, event_date, event_name) values ($1, 'x', $2, 'y', '2026-10-03', 'Card')`, [A, C])));

  check("the block check isn't an RPC: the app can't call it to learn who blocked whom",
    await refused(as("authenticated", B, `select public.challenges_block_guard()`)) &&
    (await db.query(`select count(*)::int n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
      where ns.nspname = 'public' and p.prosecdef and p.prorettype <> 'trigger'::regtype
        and has_function_privilege('authenticated', p.oid, 'execute')`)).rows[0].n === 0);
  check("the blocker can unblock", (await as("authenticated", A, `delete from user_blocks where blocked_id = $1 returning 1`, [B])).rows.length === 1);
  check("...and then they can challenge again", !(await refused(chal(B, A))));

  const report = (who, reporter, extra = "") => as("authenticated", who,
    `insert into content_reports (reporter_id, reported_id, reported_name, kind, content, reason${extra ? ", status" : ""}) values ($1, $2, 'Bob', 'roast', 'You stink', 'Harassment'${extra ? ", '" + extra + "'" : ""})`, [reporter, B]);
  check("a player can report", !(await refused(report(A, A))));
  check("...only as themselves", await refused(report(A, C)));
  check("...not pre-marked as handled", await refused(report(A, A, "dismissed")));
  check("reports are write-only: the reporter can't read them back", await refused(as("authenticated", A, `select * from content_reports`)));
  check("...and nobody else can either", await refused(as("authenticated", B, `select * from content_reports`)) && await refused(as("anon", "", `select * from content_reports`)));
  check("the anon key can't file a report", await refused(as("anon", "", `insert into content_reports (reporter_id, kind) values ('x', 'other')`)));
  check("an unknown kind is refused", await refused(as("authenticated", A, `insert into content_reports (reporter_id, kind) values ($1, 'weird')`, [A])));
  for (let i = 0; i < 19; i++) await report(A, A);
  check("20 reports a day per reporter, then refused", await refused(report(A, A)));
  check("...which doesn't stop anyone else", !(await refused(report(C, C))));
}

// --- 2. the app ------------------------------------------------------------------
const html = readFileSync(join(ROOT, "index.html"), "utf8");
{
  const require = createRequire(import.meta.url);
  let chromium = null;
  try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch {} }
  if (!chromium) { failures++; console.error("  ✗ Playwright not installed (npm install)"); }
  else {
    const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".mp3": "audio/mpeg" };
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
    const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
    try {
      const page = await browser.newPage();
      const errors = [], writes = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        try {
          localStorage.setItem("ufc_sb_session", JSON.stringify({ access_token: "tok", refresh_token: "r", user_id: "u-andy", expires_at: 9999999999 }));
          localStorage.setItem("ufc_name", "🥊 Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999");
        } catch (e) {}
      });
      const CHALS = [
        { id: "c-bob", challenger_id: "u-bob", challenger_name: "Bob", target_id: "u-andy", target_name: "🥊 Andy", event_date: "2099-01-01", event_name: "UFC 999", f1: null, f2: null, stake: "Dinner", status: "pending", created_at: "2026-09-30T00:00:00Z" },
        { id: "c-carol", challenger_id: "u-carol", challenger_name: "Carol", target_id: "u-andy", target_name: "🥊 Andy", event_date: "2099-01-01", event_name: "UFC 999", f1: null, f2: null, stake: "Lunch", status: "pending", created_at: "2026-09-30T00:00:00Z" },
      ];
      await page.route(/supabase\.co/, (route) => {
        const req = route.request(), url = decodeURIComponent(req.url()), m = req.method();
        if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") writes.push({ m, url, body: req.postData() });
        let body = "[]";
        if (/\/rest\/v1\/user_blocks\?select=/.test(url) && m === "GET") body = JSON.stringify([{ blocked_id: "u-bob", blocked_name: "Bob" }]);
        else if (/\/rest\/v1\/challenges\?/.test(url) && m === "GET") body = JSON.stringify(CHALS);
        route.fulfill({ status: m === "POST" ? 201 : 200, contentType: "application/json", body: m === "POST" || m === "DELETE" ? "" : body });
      });
      await page.goto(base + "/index.html", { waitUntil: "load", timeout: 20000 });
      await page.waitForFunction(() => { try { return !!JSON.parse(localStorage.getItem("ufc_blocks") || "{}")["u-bob"]; } catch (e) { return false; } }, null, { timeout: 12000 }).catch(() => {});
      const synced = await page.evaluate(() => JSON.parse(localStorage.getItem("ufc_blocks") || "{}"));
      check("boot: the server's block list is adopted", !!synced["u-bob"] && synced["u-bob"].n === "Bob" && !synced["u-bob"].p);

      await page.evaluate(() => fetchChallenges());
      await page.waitForFunction(() => _challenges.length > 0, null, { timeout: 5000 }).catch(() => {});
      const chIds = await page.evaluate(() => _challenges.map((c) => c.id));
      check("a blocked player's challenge leaves the inbox; everyone else's stays", chIds.join() === "c-carol");
      await page.evaluate(() => { openChallengeInbox(); });
      const inbox = await page.evaluate(() => ({
        text: document.getElementById("chalList").textContent,
        acts: [...document.querySelectorAll("#chalList .safety-act")].map((b) => b.textContent),
      }));
      check("...and an incoming challenge carries 🚩 Report and 🚫 Block", !/Dinner/.test(inbox.text) && /Lunch/.test(inbox.text) && inbox.acts.join("|") === "🚩 Report|🚫 Block");
      await page.evaluate(() => closeChalSheet());

      // A received roast, from someone on the board.
      await page.evaluate(() => {
        _lbRows = (_lbRows || []).concat([{ user_id: "u-carol", nickname: "Carol", event_date: "2026-09-26", f1: "A", f2: "B", pick: "A" },
          { user_id: "u-carol-old", nickname: "Carol", event_date: "2026-09-20", f1: "A", f2: "B", pick: "A" }]);
        showIncomingTrashTalk("You pick like a raccoon. — Joe Rogan", "Carol");
      });
      const sheet = await page.evaluate(() => ({
        shown: getComputedStyle(document.getElementById("trashSafety")).display !== "none",
        acts: [...document.querySelectorAll("#trashSafety .safety-act")].map((b) => b.textContent),
      }));
      check("a received roast carries 🚩 Report and 🚫 Block", sheet.shown && sheet.acts.join("|") === "🚩 Report|🚫 Block");
      await page.click("#trashSafety .safety-act");
      const rep = await page.evaluate(() => ({
        open: document.getElementById("reportBg").classList.contains("open"),
        quote: document.getElementById("reportQuote").textContent,
        block: document.getElementById("reportAlsoBlock").checked,
      }));
      check("Report opens the report sheet quoting the roast, with 'Also block' on", rep.open && /raccoon/.test(rep.quote) && rep.block);
      writes.length = 0;
      await page.click("#reportSendBtn");
      check("...a report needs a reason (nothing sent without one)", !writes.some((w) => /content_reports/.test(w.url)));
      await page.click("#reportReasons .lb-trash-chip");
      await page.fill("#reportNote", "every week");
      await page.click("#reportSendBtn");
      await page.waitForFunction(() => !document.getElementById("reportBg").classList.contains("open"), null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(200);
      const repRow = writes.filter((w) => /\/rest\/v1\/content_reports/.test(w.url)).map((w) => JSON.parse(w.body))[0] || {};
      check("...then files it as this account, with the roast, the name and the reason",
        repRow.reporter_id === "u-andy" && repRow.kind === "roast" && /raccoon/.test(repRow.content) && repRow.reported_name === "Carol" &&
        repRow.reported_id === "u-carol" && repRow.reason === "Harassment or bullying: every week");
      const blk = writes.filter((w) => /\/rest\/v1\/user_blocks$/.test(w.url.split("?")[0]) && w.m === "POST").map((w) => JSON.parse(w.body))[0] || [];
      check("...and blocks every account the board holds under that name", blk.map((r) => r.blocked_id).sort().join() === "u-carol,u-carol-old" && blk.every((r) => r.blocker_id === "u-andy"));
      const after = await page.evaluate(() => ({ carol: isBlocked("u-carol") && isBlocked("u-carol-old"), chals: _challenges.map((c) => c.id).join() }));
      check("...which takes their challenges out of the inbox too", after.carol && after.chals === "");
      await page.evaluate(() => closeTrashSheet());

      await page.evaluate(() => openSafety());
      const list = await page.evaluate(() => [...document.querySelectorAll("#safetyBlocked .safety-row span")].map((s) => s.textContent).sort().join("|"));
      check("Privacy & Safety lists each blocked player once", list === "Bob|Carol");
      writes.length = 0;
      await page.click("#safetyBlocked .safety-row:first-child .safety-unblock");
      await page.waitForTimeout(200);
      const del = writes.find((w) => w.m === "DELETE" && /user_blocks/.test(w.url));
      const left = await page.evaluate(() => [...document.querySelectorAll("#safetyBlocked .safety-row span")].map((s) => s.textContent).join("|"));
      check("...and Unblock removes them here and on the server", !!del && /blocker_id=eq\.u-andy/.test(del.url) && left.split("|").length === 1);
      await page.keyboard.press("Escape");
      check("Escape closes Privacy & Safety (it's a real overlay)", await page.evaluate(() => !document.getElementById("safetyBg").classList.contains("open")));
      check("no page errors", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
    } finally { await browser.close(); server.close(); }
  }
}

// --- 3. the privacy policy, and the wiring ---------------------------------------
{
  const pp = readFileSync(join(ROOT, "privacy.html"), "utf8");
  check("privacy.html runs no script (CSP script-src 'none', no <script>)", !/<script/i.test(pp) && /script-src 'none'/.test(pp));
  for (const [what, re] of [["picks are public", /Other players can see them/], ["AI providers", /Anthropic/], ["xAI", /xAI/],
    ["deletion", /Delete my account/], ["report and block", /Report[\s\S]*Block/], ["contact", /Contact/]]) {
    check(`privacy.html covers ${what}`, re.test(pp));
  }
  check("the app links the privacy policy from Privacy & Safety", /href="privacy\.html"/.test(html) && /id="safetyBtn"[^>]*openSafety\(\)/.test(html));
  check("Report and Privacy & Safety are real overlays (_escClosers)", /\["reportBg",function\(\)\{closeReport\(\);\}\]/.test(html) && /\["safetyBg",function\(\)\{closeSafety\(\);\}\]/.test(html));
  check("deleting an account deletes its blocks (0014's delete_my_account)",
    /'user_blocks:blocker_id'/.test(readFileSync(join(ROOT, "supabase/migrations/0014_delete_account.sql"), "utf8")));
  check("a room's name can be reported by anyone but its owner", /if\(r\.owner_id!==USER_ID\)\{[^}]*openReport\(\{kind:"room",uids:\[r\.owner_id\],content:r\.name\}\)/.test(html));
  check("a blocked player isn't offered as a roast target", /else if\(!isBlocked\(u\.user_id\)&&!isBlockedName\(u\.nickname\)\)\{opponents\.push/.test(html));
  const safety = html.slice(html.indexOf("// safety:start"), html.indexOf("// safety:end"));
  check("the safety block writes other people's words with textContent, never innerHTML",
    safety.length > 0 && !/innerHTML\s*=\s*[^"'\s]/.test(safety) && !/innerHTML\s*=\s*["'][^"']+["']/.test(safety));
}

if (failures) { console.error(`\ncheck:safety — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:safety — all good");
