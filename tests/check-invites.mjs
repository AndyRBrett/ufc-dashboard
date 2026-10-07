// Founding members and invite links (soft-launch prep, 0020_founders_invites.sql).
//
//   1. The migration, run for real in PGlite: a founder is an email account
//      created before founding_cutoff() (never an anonymous one, never one
//      after); an invite is claimed once, only by a new account, never as
//      someone else or by writing the tables directly; "playing" counts only
//      invitees with UFC picks on 2 past cards; deleting an account clears its
//      code and invites on both sides and nobody else's.
//   2. The app: ?ref= is captured and dropped from the URL, claimed after
//      sign-in, the sheet is a real overlay, invite text goes in with
//      textContent, and the board's badge comes from founders_among.
//   3. The privacy policy says what is kept, and account deletion lists it.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { launchChromium } from "./lib/browser.mjs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));
const mig = (f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8");

// --- 1. the database ---------------------------------------------------------
const OLD = "11111111-1111-1111-1111-111111111111";   // founder, invites people
const NEW = "22222222-2222-2222-2222-222222222222";   // new account, claims OLD's link
const ANON = "33333333-3333-3333-3333-333333333333";  // anonymous session
const LATE = "44444444-4444-4444-4444-444444444444";  // account made after the cutoff
const VET = "55555555-5555-5555-5555-555555555555";   // an existing player (old account)
const NEW2 = "66666666-6666-6666-6666-666666666666";  // second invitee, no picks yet

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table auth.users (id uuid primary key, email text, created_at timestamptz default now(), is_anonymous boolean default false);
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.picks (
    id bigserial primary key, created_at timestamptz default now(),
    user_id text default '-', nickname text default '-', event_date text default '-',
    event_name text default '-', f1 text default '-', f2 text default '-', pick text default '-',
    method text default '', confidence integer default 0, updated_at timestamptz default now(),
    bonus_pick text, promotion text default 'ufc', unique (user_id, event_date, f1, f2));
  alter table public.picks enable row level security;
  create policy picks_select on public.picks for select using (true);
  grant select on public.picks to anon, authenticated;
  create table public.push_subs (user_id text primary key, endpoint text, p256dh text, auth text, nickname text);
  alter table public.push_subs enable row level security;
`);
for (const m of ["0003_challenges.sql", "0004_user_prefs.sql", "0006_rooms.sql", "0008_rooms_codes_throttle.sql",
  "0009_ai_quota.sql", "0010_picks_lock.sql", "0013_safety.sql", "0014_delete_account.sql", "0016_roast_inbox.sql",
  "0020_founders_invites.sql"]) await db.exec(mig(m));
await db.exec(mig("0020_founders_invites.sql"));   // re-runnable

await db.exec(`
  insert into auth.users (id, email, created_at, is_anonymous) values
    ('${OLD}',  'old@x.test',  now() - interval '60 days', false),
    ('${NEW}',  'new@x.test',  now() - interval '1 day',   false),
    ('${ANON}', null,          now() - interval '1 day',   true),
    ('${LATE}', 'late@x.test', timestamptz '2027-02-01 00:00+00', false),
    ('${VET}',  'vet@x.test',  now() - interval '90 days', false),
    ('${NEW2}', 'new2@x.test', now() - interval '2 days',  false);
`);

// Run a statement as a signed-in user (or as anon with no user).
async function as(uid, sql, params = [], { anon = false } = {}) {
  const claims = uid ? JSON.stringify({ sub: uid, is_anonymous: anon }) : "";
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false),
                 set_config('request.jwt.claims', '${claims}', false); set role ${uid ? "authenticated" : "anon"};`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
}
async function err(fn) { try { await fn(); return ""; } catch (e) { return e.message || String(e); } }

// Founders
{
  const r = await as(null, "select * from public.founders_among($1)", [[OLD, NEW, ANON, LATE, "not-a-uuid", "x'; drop table picks; --"]]);
  const got = r.rows.map((x) => Object.values(x)[0]).sort();
  check("founders_among: email accounts made before the cutoff, from an anonymous caller", JSON.stringify(got) === JSON.stringify([OLD, NEW].sort()));
  check("...never an anonymous login, an account made after the cutoff, or a malformed id", !got.includes(ANON) && !got.includes(LATE));
  const big = await as(null, "select count(*)::int n from public.founders_among($1)", [Array(600).fill(OLD)]);
  check("...and reads at most 500 ids per call", big.rows[0].n === 1);
}

// Codes
{
  const e = await err(() => as(ANON, "select public.my_invite()", [], { anon: true }));
  check("an anonymous session gets no invite code ('link an email first')", /link an email/.test(e));
  const a = (await as(OLD, "select public.my_invite() j")).rows[0].j;
  const b = (await as(OLD, "select public.my_invite() j")).rows[0].j;
  check("my_invite makes one 10-character code per account and keeps it", /^[0-9A-HJKMNP-TV-Z]{10}$/.test(a.code) && a.code === b.code);
  check("...and says the caller is a founder, with the cutoff", a.founder === true && /^2027-01-01/.test(String(a.founding_until)));
  const late = (await as(LATE, "select public.my_invite() j")).rows[0].j;
  check("an account made after the cutoff is not a founder", late.founder === false);
  globalThis.CODE = a.code;
}
const CODE = globalThis.CODE;

// Claims
{
  const claim = async (uid, code, o) => (await as(uid, "select public.claim_invite($1) s", [code], o)).rows[0].s;
  check("a made-up code is 'unknown'", await claim(NEW, "ZZZZZZZZZZ") === "unknown");
  check("your own code is 'self'", await claim(OLD, CODE) === "self");
  check("an existing player's account isn't an invite ('existing')", await claim(VET, CODE) === "existing");
  check("a new account claims it ('ok'), case and spaces forgiven", await claim(NEW, " " + CODE.toLowerCase() + " ") === "ok");
  check("...once ('already')", await claim(NEW, CODE) === "already");
  check("a second new account claims it too", await claim(NEW2, CODE) === "ok");
  const e = await err(() => claim(ANON, CODE, { anon: true }));
  check("an anonymous session can't claim ('link an email first')", /link an email/.test(e));
  const ins = await err(() => as(VET, "insert into public.invites (invitee_id, inviter_id) values ($1, $2)", [VET, OLD]));
  check("nobody writes invites directly", /permission denied/.test(ins));
  const insc = await err(() => as(VET, "insert into public.invite_codes (user_id, code) values ($1, 'AAAAAAAAAA')", [OLD]));
  check("...or invite codes", /permission denied/.test(insc));
  const rd = await err(() => as(NEW, "select * from public.invites"));
  check("...and nobody reads the tables directly (counts come through my_invite)", /permission denied/.test(rd));
}

// Counts: NEW plays two past cards, NEW2 one past card and one future one.
{
  const past = (d) => { const t = new Date(Date.now() - d * 86400000); return t.toISOString().slice(0, 10); };
  await db.exec(`insert into public.picks (user_id, event_date, f1, f2, pick, promotion) values
    ('${NEW}', '${past(30)}', 'A', 'B', 'A', 'ufc'), ('${NEW}', '${past(20)}', 'C', 'D', 'C', 'ufc'),
    ('${NEW2}', '${past(30)}', 'A', 'B', 'A', 'ufc'), ('${NEW2}', '${past(-5)}', 'E', 'F', 'E', 'ufc'),
    ('${NEW2}', '${past(20)}', 'G', 'H', 'G', 'pfl'), ('${NEW2}', '${past(25)}', 'I', 'J', 'I', 'ufc');
    insert into public.card_bells (event_date, first_bell, last_bell) values
      ('${past(30)}', now() - interval '30 days', now() - interval '30 days'),
      ('${past(20)}', now() - interval '20 days', now() - interval '20 days')`);
  const j = (await as(OLD, "select public.my_invite() j")).rows[0].j;
  check("my_invite counts who joined through the link", j.joined === 2);
  check("...and 'playing' only for UFC picks on 2 past cards (not a future card, another sport or a date with no card)", j.playing === 1);
  const n = (await as(NEW, "select public.my_invite() j")).rows[0].j;
  check("an invitee's own counts start at zero", n.joined === 0 && n.playing === 0);
}

// Deletion
{
  await as(NEW, "select public.delete_my_account()");
  const left = await db.query(`select (select count(*)::int from public.invites where invitee_id = '${NEW}') a,
                                      (select count(*)::int from public.invite_codes where user_id = '${NEW}') b,
                                      (select count(*)::int from public.invites where invitee_id = '${NEW2}') c,
                                      (select count(*)::int from public.invite_codes where user_id = '${OLD}') d`);
  const r = left.rows[0];
  check("Delete my account removes the invitee's invite and code", r.a === 0 && r.b === 0);
  check("...and leaves everyone else's", r.c === 1 && r.d === 1);
  await as(OLD, "select public.delete_my_account()");
  const after = await db.query(`select count(*)::int n from public.invites`);
  check("deleting the inviter removes the invites they made", after.rows[0].n === 0);
  await db.exec(`delete from auth.users where id = '${LATE}'`);
  const lc = await db.query(`select count(*)::int n from public.invite_codes where user_id = '${LATE}'`);
  check("an admin deleting a login clears its code too (auth.users trigger)", lc.rows[0].n === 0);
  const ghost = await err(() => as(OLD, "select public.my_invite()"));
  check("a deleted account's leftover token can't make a new code", /account deleted|link an email/.test(ghost));
}

// --- 2. the app --------------------------------------------------------------
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const blk = html.slice(html.indexOf("// invites:start"), html.indexOf("// invites:end"));
check("index.html has the invites block", blk.length > 200);
check("?ref= is read, checked against the code alphabet, stored, and dropped from the URL",
  /searchParams\.get\("ref"\)/.test(blk) && /searchParams\.delete\("ref"\)/.test(blk) && /INVITE_CODE_RE\.test/.test(blk) && /ufc_ref/.test(blk));
{
  const ps = html.slice(html.indexOf("function _postSignIn"), html.indexOf("function _postSignIn") + 700);
  check("a stored invite is claimed after sign-in, once the email is saved", ps.indexOf("_claimInvite()") > ps.indexOf("if(email){") && ps.indexOf("if(email){") > 0);
}
check("...and only kept for a network error (a dead code is forgotten)", /ok\|already\|self\|unknown\|existing/.test(blk));
check("the sheet is a real overlay (_escClosers)", /\["inviteBg",function\(\)\{closeInvite\(\);\}\]/.test(html));
check("⋯ More has Invite friends", /id="inviteMenuBtn"[^>]*openInvite\(\)/.test(html));
check("the invites block never writes with innerHTML", !/innerHTML/.test(blk));
check("the board's founder badge comes from founders_among", /rpc\/founders_among/.test(blk) && /data-uid|dataset\.uid/.test(html));

// --- 2b. the app, in a browser -------------------------------------------------
{
  const { chromium } = await import("playwright");
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChromium(chromium);
  const PAST = "2026-09-26";
  const open = async (email, url) => {
    const page = await browser.newPage(), calls = [], errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript((em) => {
      try {
        localStorage.setItem("ufc_sb_session", JSON.stringify(Object.assign({ access_token: "tok", refresh_token: "r", user_id: "u-andy", expires_at: 9999999999 }, em ? { email: em } : {})));
        localStorage.setItem("ufc_name", "🥊 Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999");
      } catch (e) {}
    }, email);
    await page.route(/supabase\.co/, (route) => {
      const req = route.request(), u = decodeURIComponent(req.url()), m = req.method();
      calls.push({ m, u, body: req.postData() });
      let status = 200, body = "[]";
      if (/rpc\/claim_invite/.test(u)) body = JSON.stringify("ok");
      else if (/rpc\/my_invite/.test(u)) body = JSON.stringify({ code: "ABCDEFGH23", joined: 3, playing: 2, founder: true, founding_until: "2027-01-01T05:00:00+00:00" });
      else if (/rpc\/founders_among/.test(u)) body = JSON.stringify(["u-carol"]);
      else if (/\/rest\/v1\/picks\?/.test(u) && m === "GET") body = JSON.stringify([
        { user_id: "u-carol", nickname: "Carol", event_date: PAST, event_name: "UFC X", f1: "A", f2: "B", pick: "A", promotion: "ufc" },
        { user_id: "u-bob", nickname: "Bob", event_date: PAST, event_name: "UFC X", f1: "A", f2: "B", pick: "B", promotion: "ufc" }]);
      else if (m === "POST") status = 201, body = "";
      route.fulfill({ status, contentType: "application/json", body });
    });
    await page.goto(base + url, { waitUntil: "load", timeout: 20000 });
    return { page, calls, errors };
  };
  try {
    // An account opening someone's link: claimed, forgotten, URL cleaned.
    {
      const { page, calls, errors } = await open("andy@example.com", "/index.html?ref=abcdefgh23");
      await page.waitForFunction(() => !localStorage.getItem("ufc_ref"), null, { timeout: 8000 }).catch(() => {});
      const claim = calls.find((c) => /rpc\/claim_invite/.test(c.u));
      check("browser: ?ref= is claimed for a signed-in account, upper-cased", !!claim && JSON.parse(claim.body).p_code === "ABCDEFGH23");
      check("...then forgotten, and dropped from the address bar", await page.evaluate(() => !localStorage.getItem("ufc_ref") && !/ref=/.test(location.search)));
      await page.evaluate(() => openInvite());
      await page.waitForFunction(() => /ABCDEFGH23/.test(document.getElementById("inviteLink").value), null, { timeout: 5000 }).catch(() => {});
      const sheet = await page.evaluate(() => ({
        open: document.getElementById("inviteBg").classList.contains("open"),
        link: document.getElementById("inviteLink").value, btn: document.getElementById("inviteShareBtn").disabled,
        stats: document.getElementById("inviteStats").textContent, founder: document.getElementById("inviteFounder").textContent,
      }));
      check("Invite friends shows the account's own ?ref= link and enables Share", sheet.open && /\?ref=ABCDEFGH23$/.test(sheet.link) && !sheet.btn);
      check("...with counts, never names, and the founder line", /3 joined/.test(sheet.stats) && /2 playing/.test(sheet.stats) && /founding member/.test(sheet.founder));
      await page.keyboard.press("Escape");
      check("Escape closes it", await page.evaluate(() => !document.getElementById("inviteBg").classList.contains("open")));
      // The board's badge: on the founder's row only.
      await page.evaluate(() => { goTab("league"); });
      await page.waitForSelector('[data-lbmode="all"]', { timeout: 8000 }).catch(() => {});
      await page.evaluate(() => { const b = document.querySelector('[data-lbmode="all"]'); if (b) setLbMode(b); });
      await page.waitForSelector(".lb-founder", { timeout: 10000 }).catch(() => {});
      const badges = await page.evaluate(() => [...document.querySelectorAll(".lb-founder")].map((b) => b.closest(".lb-nameline").dataset.uid));
      check("the board puts 🎖️ on the founder's row and no one else's", badges.join() === "u-carol");
      check("...asking founders_among once for the rows on screen", calls.filter((c) => /rpc\/founders_among/.test(c.u)).length === 1);
      check("no page errors", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
      await page.close();
    }
    // No email yet: the code waits, nothing is claimed, and the sheet asks for an email.
    {
      const { page, calls } = await open(null, "/index.html?ref=ABCDEFGH23");
      await page.waitForTimeout(800);
      const kept = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem("ufc_ref")).code; } catch (e) { return null; } });
      check("browser: without an email the code waits in ufc_ref and nothing is claimed", kept === "ABCDEFGH23" && !calls.some((c) => /claim_invite/.test(c.u)));
      await page.evaluate(() => openInvite());
      check("...and Invite friends asks to link an email instead", await page.evaluate(() =>
        !document.getElementById("inviteBg").classList.contains("open") && /invite link/i.test(document.getElementById("acctDesc").textContent)));
      await page.close();
    }
    // A malformed code is never stored.
    {
      const { page } = await open(null, "/index.html?ref=hello");
      check("browser: a ?ref= outside the code alphabet is dropped", await page.evaluate(() => !localStorage.getItem("ufc_ref") && !/ref=/.test(location.search)));
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
}

// --- 3. privacy and deletion -------------------------------------------------
const pp = readFileSync(join(ROOT, "privacy.html"), "utf8");
check("privacy.html says invites are kept, and that a founder badge is shown", /invited you/i.test(pp) && /Founding member/i.test(pp));
const del = mig("0014_delete_account.sql");
check("delete_my_account (0014) lists both invite tables", /'invite_codes:user_id'/.test(del) && /'invites:invitee_id'/.test(del) && /'invites:inviter_id'/.test(del));

console.log(failures ? `\ncheck:invites — ${failures} failure(s)` : "\ncheck:invites — all good");
process.exit(failures ? 1 : 0);
