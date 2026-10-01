// "Delete my account" deletes the account (Apple guideline 5.1.1(v)): the
// login itself and every row tied to it, for the caller only.
//
//   1. 0014_delete_account.sql, run for real in PGlite on top of the
//      migrations whose tables it clears: two players with picks (one locked),
//      a push subscription, prefs, a room each, seats, challenges, blocks both
//      ways, AI usage, wrong room codes, a rollback snapshot and a login. Alice
//      deletes; everything of hers goes, everything of Bob's stays, reports
//      stay, and nobody can delete someone else.
//   2. The app calls it, falls back to the old row-by-row delete only when the
//      RPC isn't there (404), and says what it removes.
//   3. The privacy policy says the same thing the code does.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));
const mig = (f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8");

const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create table auth.users (id uuid primary key, email text);
  create table auth.identities (id bigserial primary key, user_id uuid not null references auth.users(id) on delete cascade);
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
  create policy picks_delete on public.picks for delete to authenticated using (auth.uid()::text = user_id);
  grant select, insert, update, delete on public.picks to anon, authenticated, service_role;
  create table public.push_subs (user_id text primary key, endpoint text, p256dh text, auth text, nickname text);
  alter table public.push_subs enable row level security;
  create table public.picks_backup_2026_09_24 as select * from public.picks;
`);
for (const m of ["0003_challenges.sql", "0004_user_prefs.sql", "0006_rooms.sql", "0008_rooms_codes_throttle.sql",
  "0009_ai_quota.sql", "0010_picks_lock.sql", "0013_safety.sql", "0014_delete_account.sql"]) await db.exec(mig(m));
await db.exec(mig("0014_delete_account.sql"));   // re-runnable

// Two players with a bit of everything. Alice's pick on a long-past card is
// locked (no schedule row: midnight ET after its date), so only the owner can
// delete it.
for (const [u, n] of [[A, "Alice"], [B, "Bob"]]) {
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u, n.toLowerCase() + "@example.com"]);
  await db.query(`insert into auth.identities (user_id) values ($1)`, [u]);
  await db.query(`insert into picks (user_id, nickname, event_date, f1, f2, pick, confidence) values ($1, $2, '2020-01-04', 'A', 'B', 'A', 1)`, [u, n]);
  await db.query(`insert into picks_backup_2026_09_24 (user_id, nickname) values ($1, $2)`, [u, n]);
  await db.query(`insert into push_subs (user_id, endpoint) values ($1, $2)`, [u, "https://push/" + n]);
  await db.query(`insert into user_prefs (user_id) values ($1)`, [u]);
  await db.query(`insert into ai_usage (user_id, day, bucket, n) values ($1, current_date, 'all', 3)`, [u]);
  await db.query(`insert into room_join_misses (user_id) values ($1)`, [u]);
  await db.query(`insert into rooms (name, code, owner_id) values ($1, $2, $3)`, [n + "'s room", n.toUpperCase() + "CODE", u]);
}
await db.exec(`
  insert into room_members (room_id, user_id) select id, owner_id from rooms;
  insert into room_members (room_id, user_id) select id, '${A}' from rooms where owner_id = '${B}';
  insert into room_members (room_id, user_id) select id, '${B}' from rooms where owner_id = '${A}';
  insert into challenges (challenger_id, challenger_name, target_id, target_name, event_date, event_name) values
    ('${A}', 'Alice', '${B}', 'Bob', '2026-10-03', 'Card'), ('${B}', 'Bob', '${A}', 'Alice', '2026-10-03', 'Card');
  insert into user_blocks (blocker_id, blocked_id) values ('${A}', '33333333-3333-3333-3333-333333333333'), ('${B}', '${A}');
  insert into content_reports (reporter_id, reported_id, kind) values ('${A}', '${B}', 'roast'), ('${B}', '${A}', 'roast');
`);

async function as(role, uid, sql) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${role};`);
  try { return await db.query(sql); } finally { await db.exec("reset role;"); }
}
const refused = async (p) => { try { await p; return false; } catch { return true; } };
const count = async (sql) => (await db.query(sql)).rows[0].n;
const holdings = async (u) => ({
  login: await count(`select count(*)::int n from auth.users where id = '${u}'`),
  identities: await count(`select count(*)::int n from auth.identities where user_id = '${u}'`),
  picks: await count(`select count(*)::int n from picks where user_id = '${u}'`),
  backup: await count(`select count(*)::int n from picks_backup_2026_09_24 where user_id = '${u}'`),
  push: await count(`select count(*)::int n from push_subs where user_id = '${u}'`),
  prefs: await count(`select count(*)::int n from user_prefs where user_id = '${u}'`),
  ai: await count(`select count(*)::int n from ai_usage where user_id = '${u}'`),
  misses: await count(`select count(*)::int n from room_join_misses where user_id = '${u}'`),
  rooms: await count(`select count(*)::int n from rooms where owner_id = '${u}'`),
  seats: await count(`select count(*)::int n from room_members where user_id = '${u}'`),
  challenges: await count(`select count(*)::int n from challenges where challenger_id = '${u}' or target_id = '${u}'`),
  blocks: await count(`select count(*)::int n from user_blocks where blocker_id = '${u}' or blocked_id = '${u}'`),
});

check("the anon key can't call it", await refused(as("anon", "", `select public.delete_my_account()`)));
check("a plain delete of a locked pick is still refused (the lock trigger is in place)",
  (await as("authenticated", A, `delete from picks where user_id = '${A}' returning 1`)).rows.length === 0);
const before = await holdings(B);
const res = (await as("authenticated", A, `select public.delete_my_account() r`)).rows[0].r;
const after = await holdings(A);
check("it reports what it removed", res && res.picks === 1 && res.login === 1 && res.challenges === 2);
for (const [k, v] of Object.entries(after)) check(`Alice's ${k}: all gone`, v === 0);
check("Bob's challenges with Alice go too (they name a deleted account); nothing else of his moves",
  JSON.stringify(await holdings(B)) === JSON.stringify({ ...before, challenges: 0, seats: 1, blocks: 0 }));
check("...his own room survives, minus Alice's seat", await count(`select count(*)::int n from room_members r join rooms o on o.id = r.room_id where o.owner_id = '${B}'`) === 1);
check("reports stay (a moderation record), both filed by and about her", await count(`select count(*)::int n from content_reports`) === 2);
check("the RPC takes no arguments: there is no way to aim it at someone else",
  await count(`select count(*)::int n from pg_proc where proname = 'delete_my_account' and pronargs = 0`) === 1 &&
  await count(`select count(*)::int n from pg_proc where proname = 'delete_my_account'`) === 1);
check("calling it again (a stale token, a double tap) is harmless", !(await refused(as("authenticated", A, `select public.delete_my_account()`))));

// --- 2. the app ------------------------------------------------------------------
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const del = html.slice(html.indexOf("function deleteAccount(){"), html.indexOf("function selectEmoji("));
check("the app deletes through delete_my_account", /\/rest\/v1\/rpc\/delete_my_account"/.test(del));
check("...and falls back to the row-by-row delete only when the RPC isn't there (404)",
  /if\(r\.status!==404\)\{if\(!r\.ok\)throw new Error\("delete account "\+r\.status\);return;\}/.test(del) &&
  del.indexOf("rpc/delete_my_account") < del.indexOf("rpc/delete_my_picks"));
check("the dialog says the login goes too", /permanently deletes your account: your sign-in/.test(html));

// --- 3. the privacy policy -------------------------------------------------------
const pp = readFileSync(join(ROOT, "privacy.html"), "utf8");
check("the privacy policy says Delete my account removes the email and challenges",
  /Delete my account/.test(pp) && /linked email address/.test(pp.slice(pp.indexOf("Deleting your data"))) &&
  !/To also remove your linked email address/.test(pp));

if (failures) { console.error(`\ncheck:delete — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:delete — all good");
