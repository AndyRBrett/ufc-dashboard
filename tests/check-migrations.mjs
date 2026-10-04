// The repo can rebuild the database: every migration, 0000 up, applies in order
// to an empty Postgres (PGlite) with a minimal stand-in for what Supabase
// provides (the roles, auth.uid() / auth.jwt(), auth.users), and the result has
// the tables, columns, constraints, policies and triggers production has.
//
// Before 0000 existed, picks / push_subs / notif_log were created only in the
// dashboard, so there was no way to stand up a staging copy, and nothing caught
// production drifting from the repo: 0017 sat unapplied while the app and docs
// assumed it was live. EXPECTED below is production's catalog as read on
// 2026-10-04 with 0017 applied; change it only together with a migration.
//
// Run: npm run check:migrations
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "supabase", "migrations");
let failures = 0;
const check = (name, cond, extra = "") => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name + (extra ? "\n      " + extra : "")));

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
`);

// 1. Every migration applies, in filename order, to what the ones before built.
const files = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
check("migrations start at the 0000 baseline", files[0]?.startsWith("0000_"));
const nums = files.map((f) => f.slice(0, 4));
check("migration numbers are unique", new Set(nums).size === nums.length, nums.join(" "));
let applied = 0;
for (const f of files) {
  try { await db.exec(readFileSync(join(DIR, f), "utf8")); applied++; }
  catch (e) { check(`${f} applies`, false, e.message); break; }
}
check(`all ${files.length} migrations apply from an empty database`, applied === files.length);

// 2. The baseline is idempotent: running it again over the finished schema
//    (what applying it to production does) changes nothing and doesn't fail.
const snapshot = async () => JSON.stringify((await db.query(`
  select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
  where schemaname='public' order by 1, 2`)).rows);
const before = await snapshot();
try {
  await db.exec(readFileSync(join(DIR, files[0]), "utf8"));
  // 0000 re-creates the three policies it owns; everything later stays as is.
  check("0000 re-applies cleanly over the finished schema", true);
} catch (e) { check("0000 re-applies cleanly over the finished schema", false, e.message); }
check("…and leaves every policy as the later migrations set it", (await snapshot()) === before);

// 3. The rebuilt core tables match production.
const EXPECTED = {
  columns: {
    picks: "id bigint!,created_at timestamp with time zone!,user_id text,nickname text,event_date text,event_name text,f1 text,f2 text,pick text,method text!,confidence integer!,updated_at timestamp with time zone,bonus_pick text,promotion text!",
    push_subs: "user_id text!,nickname text,endpoint text,p256dh text,auth text,live_results boolean!",
    notif_log: "event_date text!,type text!,sent_at timestamp with time zone",
  },
  constraints: [
    "notif_log.notif_log_pkey PRIMARY KEY (event_date, type)",
    "picks.nickname_length CHECK ((char_length(nickname) <= 20))",
    "picks.picks_pkey PRIMARY KEY (id)",
    "picks.picks_promotion_format CHECK ((promotion ~ '^[a-z0-9-]{2,20}$'::text))",
    "picks.picks_user_fight_unique UNIQUE (user_id, event_date, f1, f2)",
    "push_subs.push_subs_pkey PRIMARY KEY (user_id)",
  ],
  policies: [
    "picks.picks_delete DELETE {authenticated}",
    "picks.picks_insert INSERT {authenticated}",
    "picks.picks_select SELECT {anon}",
    "picks.picks_select_auth SELECT {authenticated}",
    "picks.picks_update UPDATE {authenticated}",
    "push_subs.push_subs_delete DELETE {authenticated}",
    "push_subs.push_subs_no_select SELECT {anon}",
  ],
  triggers: [
    "picks.picks_cap_locks", "picks.picks_enforce_lock", "picks.refuse_deleted_account",
    "push_subs.refuse_deleted_account",
  ],
};
const CORE = "('picks','push_subs','notif_log')";
for (const t of Object.keys(EXPECTED.columns)) {
  const cols = (await db.query(`
    select a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then '!' else '' end as c
    from pg_attribute a where a.attrelid = 'public.${t}'::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum`)).rows.map((r) => r.c).join(",");
  check(`${t}: columns, types and NOT NULLs match production`, cols === EXPECTED.columns[t], `got  ${cols}\n      want ${EXPECTED.columns[t]}`);
}
// contype 'n': PGlite runs Postgres 18, which records NOT NULL as constraint
// rows (production's 17 doesn't); the column check above already covers them.
const cons = (await db.query(`
  select conrelid::regclass::text || '.' || conname || ' ' || pg_get_constraintdef(oid) as c from pg_constraint
  where conrelid::regclass::text in ${CORE} and contype <> 'n' order by 1`)).rows.map((r) => r.c.replace(/^public\./, ""));
const wantCons = [...EXPECTED.constraints].sort();
check("core tables: constraints match production", JSON.stringify(cons.sort()) === JSON.stringify(wantCons), `got  ${cons.join(" | ")}`);
const pols = (await db.query(`
  select tablename || '.' || policyname || ' ' || cmd || ' ' || roles::text as p from pg_policies
  where schemaname='public' and tablename in ${CORE} order by 1`)).rows.map((r) => r.p);
check("core tables: the policy set matches production", JSON.stringify(pols) === JSON.stringify(EXPECTED.policies), `got  ${pols.join(" | ")}`);
const hides = (await db.query(`select qual from pg_policies where tablename='picks' and policyname='picks_select'`)).rows[0]?.qual || "";
check("picks_select hides a pick until its bout locks (0017)", /pick_lock_for/.test(hides));
const trg = (await db.query(`
  select distinct event_object_table || '.' || trigger_name as t from information_schema.triggers
  where event_object_schema='public' and event_object_table in ${CORE} order by 1`)).rows.map((r) => r.t);
check("core tables: triggers match production", JSON.stringify(trg) === JSON.stringify(EXPECTED.triggers), `got  ${trg.join(" | ")}`);
const rls = (await db.query(`select relname from pg_class where relname in ${CORE} and relnamespace='public'::regnamespace and not relrowsecurity`)).rows;
check("core tables: row level security is on for all three", rls.length === 0, rls.map((r) => r.relname).join(", "));

// 4. supabase/config.toml (the local stack) verifies JWTs exactly where the
//    deploy does: a function deployed --no-verify-jwt authenticates itself
//    with CRON_SECRET, so the two files must agree function by function.
{
  const toml = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
  const wf = readFileSync(join(ROOT, ".github", "workflows", "deploy-functions.yml"), "utf8");
  const deployed = [...wf.matchAll(/supabase functions deploy ([\w-]+)([^\n]*)/g)].map((m) => [m[1], !/--no-verify-jwt/.test(m[2])]);
  const local = Object.fromEntries([...toml.matchAll(/\[functions\.([\w-]+)\]\s*\nverify_jwt\s*=\s*(true|false)/g)].map((m) => [m[1], m[2] === "true"]));
  const off = deployed.filter(([fn, v]) => local[fn] !== v).map(([fn]) => fn);
  check(`config.toml's verify_jwt matches deploy-functions.yml for all ${deployed.length} functions`, deployed.length > 0 && off.length === 0, off.join(", "));
}

if (failures) { console.error(`\ncheck-migrations: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-migrations: the database rebuilds from the repo and matches production's core schema.");
