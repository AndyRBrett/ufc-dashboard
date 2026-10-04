// The server-side pick lock (migrations 0010 for UFC, 0012 for the other sports), run for
// real: PGlite is Postgres compiled to WASM, so the trigger, RLS and roles
// behave exactly as they do on Supabase. Also checks send-reminders' lockRows,
// which writes the lock times the trigger reads, against the app's own rule.
//
// What must hold, for the app's roles (anon / authenticated):
//   - a pick for a bout whose segment started more than LOCK_GRACE ago is
//     never added, changed, moved or deleted; the rest of a batch still lands
//   - a pick made inside the grace still lands
//   - a nickname rename across every row still applies to locked rows
//   - bonus_pick freezes at the card's first bell
//   - no schedule row: a bout falls back to its card's last bell, a card with
//     none at all locks from midnight ET after its date, never before
//   - the other sports (PFL, RIZIN, DWCS) are held to the same rule, each against
//     its own promotion's times; a bout name UFC has locked is open under another
//     promotion, and never the other way round
//   - our own functions and delete_my_picks() pass through
//   - the 🔒 cap (0005) still clamps, and can't be used to move a locked lock
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
import { PGlite } from "@electric-sql/pglite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const db = new PGlite();
// Supabase's shape, minimally: the three roles, auth.uid() from the JWT claim,
// the live picks columns and policies.
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  create table public.picks (
    id bigserial primary key, created_at timestamptz default now(),
    user_id text default '-', nickname text default '-', event_date text default '-',
    event_name text default '-', f1 text default '-', f2 text default '-', pick text default '-',
    method text default '', confidence integer default 0, updated_at timestamptz default now(),
    bonus_pick text, promotion text default 'ufc',
    unique (user_id, event_date, f1, f2));
  alter table public.picks enable row level security;
  create policy picks_select on public.picks for select using (true);
  create policy picks_insert on public.picks for insert to authenticated with check (auth.uid()::text = user_id);
  create policy picks_update on public.picks for update to authenticated using (auth.uid()::text = user_id) with check (auth.uid()::text = user_id);
  create policy picks_delete on public.picks for delete to authenticated using (auth.uid()::text = user_id);
  grant usage on schema public to anon, authenticated, service_role;
  grant select, insert, update, delete on public.picks to anon, authenticated, service_role;
  grant usage on sequence public.picks_id_seq to authenticated, service_role;
`);
for (const m of ["0005_picks_lock_cap.sql", "0010_picks_lock.sql", "0012_sport_pick_locks.sql"]) {
  await db.exec(readFileSync(join(ROOT, "supabase/migrations", m), "utf8"));
}

const U1 = "11111111-1111-1111-1111-111111111111", U2 = "22222222-2222-2222-2222-222222222222";
// Run statements as a role (and user), the way PostgREST does.
async function as(role, uid, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${role};`);
  try { return await db.query(sql, params); } finally { await db.exec("reset role;"); }
}
const rows = async (where = "true") => (await db.query(`select * from picks where ${where} order by id`)).rows;
const one = async (where) => (await rows(where))[0];

// Dates: a card that's on now, one next week, one long past with no schedule.
// LIVE is today's ET date, never a fixed one: 0017 makes every pick visible on a
// card more than 2 days old (ET), so a pinned date turned the hidden-pick cases
// red 2 days after it was written and blocked every Pages deploy. PGlite reads
// the same JS clock, so the shift audit (a Date shim) moves both together.
const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const LIVE = etToday(), NEXT = "2099-10-10", PAST = "2020-01-04", PAST_NONE = "2020-02-01";
await db.exec(`
  insert into pick_locks (event_date, a, b, lock_at) values
    ('${LIVE}', 'alpha one', 'bravo two', now() - interval '20 minutes'),   -- prelim, well past
    ('${LIVE}', 'charlie three', 'delta four', now() - interval '2 minutes'),-- just started: inside grace
    ('${LIVE}', 'echo five', 'foxtrot six', now() + interval '2 hours'),     -- main card, open
    ('${LIVE}', 'india nine', 'juliet ten', now() + interval '2 hours'),
    ('${NEXT}', 'golf seven', 'hotel eight', now() + interval '6 days');
  insert into card_bells (event_date, first_bell, last_bell) values
    ('${LIVE}', now() - interval '20 minutes', now() + interval '2 hours'),
    ('${NEXT}', now() + interval '6 days', now() + interval '6 days 4 hours'),
    ('${PAST}', now() - interval '3 years', now() - interval '3 years');
`);
const upsert = `insert into picks (user_id, nickname, event_date, f1, f2, pick, method, confidence, bonus_pick, promotion)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  on conflict (user_id, event_date, f1, f2) do update set pick = excluded.pick, method = excluded.method,
    confidence = excluded.confidence, bonus_pick = excluded.bonus_pick, nickname = excluded.nickname`;
const pick = (uid, date, f1, f2, p, extra = {}) => as("authenticated", uid, upsert,
  [uid, extra.nick || "🥊 Andy", date, f1, f2, p, extra.method || "", extra.conf || 0, extra.bonus ?? null, extra.promo || "ufc"]);

// Seed U1's picks as our own function would (service_role bypasses the lock),
// including on already-locked bouts, the way they'd have been made before the bell.
await as("service_role", null, upsert, [U1, "🥊 Andy", LIVE, "Alpha One", "Bravo Two", "Alpha One", "KO", 1, "Echo Five", "ufc"]);
await as("service_role", null, upsert, [U1, "🥊 Andy", PAST, "Old A", "Old B", "Old A", "", 0, null, "ufc"]);
check("our own functions (service_role) write past the lock", (await rows(`user_id='${U1}'`)).length === 2);

// 1. A new pick on a locked bout is dropped, and doesn't fail anything else.
await pick(U2, LIVE, "Alpha One", "Bravo Two", "Bravo Two");
check("a new pick after the bell is not added", !(await one(`user_id='${U2}' and f1='Alpha One'`)));
await pick(U2, LIVE, "Echo Five", "Foxtrot Six", "Echo Five");
check("a pick on a bout still open lands", (await one(`user_id='${U2}' and f1='Echo Five'`))?.pick === "Echo Five");
await pick(U2, LIVE, "Charlie Three", "Delta Four", "Delta Four");
check("a pick inside the 5-minute grace still lands", (await one(`user_id='${U2}' and f1='Charlie Three'`))?.pick === "Delta Four");
await as("authenticated", U2, `insert into picks (user_id, event_date, f1, f2, pick) values
  ($1, '${LIVE}', 'Alpha One', 'Bravo Two', 'Bravo Two'), ($1, '${NEXT}', 'Golf Seven', 'Hotel Eight', 'Golf Seven')`, [U2]);
check("a batch with one locked row still saves the rest", !!(await one(`user_id='${U2}' and f1='Golf Seven'`)) && !(await one(`user_id='${U2}' and f1='Alpha One'`)));
// Names match regardless of case, spacing and corner order.
await pick(U2, LIVE, "  bravo TWO ", "Alpha one", "Alpha one");
check("a locked bout is found whatever the case, spacing or corner order", !(await one(`user_id='${U2}' and f2='Alpha one'`)));
await pick(U2, LIVE, " foxtrot SIX", "Echo five ", "Echo five ");
check("an open bout is found whatever the case, spacing or corner order (so it stays open)", !!(await one(`user_id='${U2}' and f1=' foxtrot SIX'`)));

// 2. An existing pick on a locked bout can't be changed, but a rename still applies.
await pick(U1, LIVE, "Alpha One", "Bravo Two", "Bravo Two", { method: "SUB", conf: 0, nick: "🥊 Andy" });
let r = await one(`user_id='${U1}' and f1='Alpha One'`);
check("a locked pick can't be switched", r.pick === "Alpha One" && r.method === "KO");
check("a locked 🔒 can't be removed to dodge its -1", r.confidence === 1);
// An upsert on a locked bout is dropped at its INSERT half, so the UPDATE path
// is reached by a plain PATCH: every pick field must still come back.
await as("authenticated", U1, `update picks set pick = 'Bravo Two', method = 'SUB', confidence = 0 where user_id = $1 and f1 = 'Alpha One'`, [U1]);
r = await one(`user_id='${U1}' and f1='Alpha One'`);
check("a direct PATCH can't switch a locked pick, its method or its 🔒",
  r.pick === "Alpha One" && r.method === "KO" && r.confidence === 1);
await as("authenticated", U1, `update picks set bonus_pick = 'Foxtrot Six' where user_id = $1 and f1 = 'Alpha One'`, [U1]);
check("a direct PATCH can't change bonus_pick after the first bell", (await one(`user_id='${U1}' and f1='Alpha One'`)).bonus_pick === "Echo Five");
await as("authenticated", U1, `update picks set nickname = '🦅 Andy' where user_id = $1`, [U1]);
check("a nickname rename still reaches every row, locked or not", (await rows(`user_id='${U1}'`)).every((x) => x.nickname === "🦅 Andy"));
await as("authenticated", U1, `update picks set f1 = 'Echo Five', f2 = 'Foxtrot Six', pick = 'Echo Five' where user_id = $1 and f1 = 'Alpha One'`, [U1]);
r = await one(`user_id='${U1}' and event_date='${LIVE}' and pick='Alpha One'`);
check("a locked row can't be moved onto another bout", !!r && r.f1 === "Alpha One");
await pick(U1, LIVE, "Echo Five", "Foxtrot Six", "Echo Five");
await as("authenticated", U1, `update picks set f1 = 'Alpha One', f2 = 'Bravo Two', pick = 'Bravo Two' where user_id = $1 and f1 = 'Echo Five'`, [U1]);
check("an open row can't be moved onto a locked bout", (await one(`user_id='${U1}' and f1='Echo Five'`))?.pick === "Echo Five");

// 3. Deletes.
await as("authenticated", U1, `delete from picks where user_id = $1 and f1 = 'Alpha One'`, [U1]);
check("a locked pick can't be deleted", !!(await one(`user_id='${U1}' and f1='Alpha One'`)));
await as("authenticated", U2, `delete from picks where user_id = $1 and f1 = 'Echo Five'`, [U2]);
check("an open pick can still be deleted", !(await one(`user_id='${U2}' and f1='Echo Five'`)));
await as("authenticated", U1, `update picks set pick = 'Old B' where user_id = $1 and event_date = '${PAST}'`, [U1]);
check("a past card's pick can't be changed after its result", (await one(`user_id='${U1}' and event_date='${PAST}'`)).pick === "Old A");

// 4. The fight-of-the-night bonus freezes at the card's first bell.
await pick(U1, LIVE, "Echo Five", "Foxtrot Six", "Echo Five", { bonus: "Foxtrot Six" });
check("bonus_pick can't change after the card's first bell", (await one(`user_id='${U1}' and f1='Echo Five'`)).bonus_pick === "Echo Five");
await pick(U2, NEXT, "Golf Seven", "Hotel Eight", "Golf Seven", { bonus: "Hotel Eight" });
check("bonus_pick changes freely before the first bell", (await one(`user_id='${U2}' and f1='Golf Seven'`)).bonus_pick === "Hotel Eight");
await pick(U1, LIVE, "India Nine", "Juliet Ten", "India Nine", { bonus: "Juliet Ten" });
r = await one(`user_id='${U1}' and f1='India Nine'`);
check("a new row after the first bell carries the bonus already held, not a new one", r && r.bonus_pick === "Echo Five");

// 5. Missing schedule rows. A name that matches no row (a respelling scoring's
// nmKey would still accept) answers to the card's FIRST bell, so it can't
// outlast its bout's own segment.
check("a new pick on an open bout after the first bell still lands", r && r.pick === "India Nine");
await pick(U2, LIVE, "Alpha  One", "Bravo-Two", "Alpha  One");
check("a respelled locked bout falls back to the card's first bell (locked)", !(await one(`user_id='${U2}' and f1='Alpha  One'`)));
await pick(U2, NEXT, "Unlisted A", "Unlisted B", "Unlisted A");
check("an unlisted bout on a card that hasn't started is open", !!(await one(`user_id='${U2}' and f1='Unlisted A'`)));
await pick(U2, PAST, "New A", "New B", "New A");
check("an unscheduled bout on a past card falls back to its last bell (locked)", !(await one(`user_id='${U2}' and event_date='${PAST}'`)));
await db.exec(`insert into card_bells (event_date, first_bell, last_bell) values ('2099-01-02', now() - interval '1 hour', now() + interval '2 hours')`);
await pick(U2, "2099-01-02", "Late A", "Late B", "Late A");
check("an unscheduled bout is locked once its card's first bell has passed, whatever the date", !(await one(`user_id='${U2}' and event_date='2099-01-02'`)));
await pick(U2, PAST_NONE, "Z A", "Z B", "Z A");
check("a card with no schedule at all is locked once its date is over", !(await one(`user_id='${U2}' and event_date='${PAST_NONE}'`)));
await pick(U2, "2099-12-31", "Far A", "Far B", "Far A");
check("a card with no schedule yet, still ahead, is open", !!(await one(`user_id='${U2}' and event_date='2099-12-31'`)));

// 6. The other sports follow the same lock (0012), each against its own
// promotion's lock times.
await db.exec(`
  insert into sport_pick_locks (promotion, event_date, a, b, lock_at) values
    ('pfl',   '${LIVE}', 'sa one',    'sb two',   now() - interval '20 minutes'),  -- started, well past
    ('pfl',   '${LIVE}', 'sc three',  'sd four',  now() - interval '2 minutes'),   -- just started: inside grace
    ('pfl',   '${LIVE}', 'se five',   'sf six',   now() + interval '2 hours'),     -- open
    ('rizin', '${LIVE}', 'alpha one', 'bravo two', now() + interval '2 hours');    -- UFC has these two locked
  insert into sport_card_bells (promotion, event_date, first_bell) values
    ('pfl',   '${LIVE}', now() - interval '20 minutes'),
    ('rizin', '${LIVE}', now() + interval '2 hours'),
    ('dwcs',  '2099-01-02', now() - interval '1 hour');
`);
const sport = (uid, date, f1, f2, p, promo, extra = {}) => pick(uid, date, f1, f2, p, { promo, ...extra });
await sport(U2, LIVE, "SA One", "SB Two", "SB Two", "pfl");
check("a new PFL pick after its bout started is not added", !(await one(`user_id='${U2}' and f1='SA One'`)));
await sport(U2, LIVE, "SE Five", "SF Six", "SE Five", "pfl");
check("a PFL pick on an open bout lands", (await one(`user_id='${U2}' and f1='SE Five'`))?.pick === "SE Five");
await sport(U2, LIVE, "SC Three", "SD Four", "SD Four", "pfl");
check("a PFL pick inside the 5-minute grace still lands", (await one(`user_id='${U2}' and f1='SC Three'`))?.pick === "SD Four");
await sport(U2, LIVE, " sb TWO ", "Sa one", "Sa one", "pfl");
check("a locked PFL bout is found whatever the case, spacing or corner order", !(await one(`user_id='${U2}' and f2='Sa one'`)));
await sport(U2, LIVE, "Alpha One", "Bravo Two", "Bravo Two", "rizin");
check("a bout UFC has locked is open under another promotion's own times", (await one(`user_id='${U2}' and promotion='rizin'`))?.pick === "Bravo Two");
await sport(U2, LIVE, "SA One", "SB Two", "SB Two", "rizin");
check("...and a PFL-locked bout is open under RIZIN (locks are per promotion)", !!(await one(`user_id='${U2}' and promotion='rizin' and f1='SA One'`)));
// An existing pick on a locked PFL bout, made before the bell (service_role).
await as("service_role", null, upsert, [U1, "🥊 Andy", LIVE, "SA One", "SB Two", "SA One", "KO/TKO", 1, null, "pfl"]);
await as("authenticated", U1, `update picks set pick = 'SB Two', method = 'Sub', confidence = 0 where user_id = $1 and f1 = 'SA One'`, [U1]);
r = await one(`user_id='${U1}' and f1='SA One'`);
check("a direct PATCH can't switch a locked PFL pick, its method or its 🔒", r.pick === "SA One" && r.method === "KO/TKO" && r.confidence === 1);
await pick(U1, LIVE, "SA One", "SB Two", "SB Two", { promo: "pfl", method: "Sub", conf: 0 });
r = await one(`user_id='${U1}' and f1='SA One'`);
check("an upsert on a locked PFL bout changes nothing", r.pick === "SA One" && r.method === "KO/TKO" && r.confidence === 1);
await as("authenticated", U1, `update picks set nickname = '🦅 Andy' where user_id = $1 and promotion = 'pfl'`, [U1]);
check("a nickname rename still reaches locked PFL rows", (await one(`user_id='${U1}' and f1='SA One'`)).nickname === "🦅 Andy");
await as("authenticated", U1, `delete from picks where user_id = $1 and f1 = 'SA One'`, [U1]);
check("a locked PFL 🔒 can't be deleted to dodge its -1", !!(await one(`user_id='${U1}' and f1='SA One'`)));
await as("authenticated", U2, `delete from picks where user_id = $1 and f1 = 'SE Five' and promotion = 'pfl'`, [U2]);
check("an open PFL pick can still be deleted", !(await one(`user_id='${U2}' and f1='SE Five' and promotion='pfl'`)));
await as("authenticated", U1, `update picks set f1 = 'SE Five', f2 = 'SF Six', pick = 'SE Five' where user_id = $1 and f1 = 'SA One'`, [U1]);
check("a locked PFL row can't be moved onto another bout", !!(await one(`user_id='${U1}' and f1='SA One' and pick='SA One'`)));
await as("authenticated", U1, `update picks set promotion = 'rizin' where user_id = $1 and f1 = 'SA One'`, [U1]);
check("a locked PFL pick can't be moved to another promotion", (await one(`user_id='${U1}' and f1='SA One'`)).promotion === "pfl");
await sport(U1, LIVE, "SE Five", "SF Six", "SE Five", "pfl");
await as("authenticated", U1, `update picks set f1 = 'SA One', f2 = 'SB Two', pick = 'SB Two' where user_id = $1 and f1 = 'SE Five'`, [U1]);
check("an open PFL row can't be moved onto a locked bout", (await one(`user_id='${U1}' and f1='SE Five'`))?.pick === "SE Five");
await as("authenticated", U2, `update picks set promotion = 'ufc' where user_id = $1 and promotion = 'rizin' and f1 = 'Alpha One'`, [U2]);
check("an open row can't be walked onto a bout another promotion has locked (Alpha One is locked under UFC)", (await one(`user_id='${U2}' and f1='Alpha One'`))?.promotion === "rizin");
// And the other direction, which 0010 already guarded: a locked UFC pick can't leave UFC.
await as("service_role", null, upsert, [U2, "🥊 B", LIVE, "Charlie Three", "Delta Four", "Charlie Three", "", 1, null, "ufc"]);
await db.exec(`update pick_locks set lock_at = now() - interval '1 hour' where a = 'charlie three'`);
await as("authenticated", U2, `update picks set promotion = 'pfl', pick = 'Delta Four' where user_id = $1 and f1 = 'Charlie Three' and promotion = 'ufc'`, [U2]);
r = await one(`user_id='${U2}' and f1='Charlie Three' and promotion='ufc'`);
check("a locked UFC pick can't be moved to another promotion (or re-picked on the way)", r && r.promotion === "ufc" && r.pick === "Charlie Three");
await as("authenticated", U2, `delete from picks where user_id = $1 and f1 = 'Charlie Three' and promotion = 'ufc'`, [U2]);
check("…so it still can't be deleted", !!(await one(`user_id='${U2}' and f1='Charlie Three' and promotion='ufc'`)));
// Missing rows fall back the way UFC's do.
await sport(U2, LIVE, "S  A  One", "SB-Two", "S  A  One", "pfl");
check("a respelled locked PFL bout falls back to the card's bell (locked)", !(await one(`user_id='${U2}' and f1='S  A  One'`)));
await sport(U2, NEXT, "Sx A", "Sx B", "Sx A", "pfl");
check("an unlisted PFL bout on a card that hasn't started is open", !!(await one(`user_id='${U2}' and f1='Sx A'`)));
await sport(U2, "2020-01-04", "Old S A", "Old S B", "Old S A", "pfl");
check("a PFL card with no schedule at all is locked once its date is over", !(await one(`user_id='${U2}' and event_date='2020-01-04' and promotion='pfl'`)));
await sport(U2, "2099-01-02", "Late S A", "Late S B", "Late S A", "dwcs");
check("an unlisted DWCS bout is locked once its card's bell has passed, whatever the date", !(await one(`user_id='${U2}' and promotion='dwcs'`)));
await sport(U2, "2099-12-31", "Far S A", "Far S B", "Far S A", "dwcs");
check("a DWCS card with no schedule yet, still ahead, is open", !!(await one(`user_id='${U2}' and f1='Far S A'`)));
await sport(U2, "2099-12-31", "Nor A", "Nor B", "Nor A", "unheard-of");
check("a promotion the database has never heard of is held to the same fallback (open until its date is over)", !!(await one(`user_id='${U2}' and promotion='unheard-of'`)));
await sport(U2, "2020-03-03", "Nor C", "Nor D", "Nor C", "unheard-of");
check("...and locked once it is over", !(await one(`user_id='${U2}' and event_date='2020-03-03'`)));
let sportRefused = 0;
for (const sql of ["select * from sport_pick_locks", "select * from sport_card_bells",
  "insert into sport_pick_locks values ('pfl','2099-01-01','a','b',now())", "update sport_card_bells set first_bell = now()"]) {
  try { await as("authenticated", U1, sql); } catch (_e) { sportRefused++; }
  try { await as("anon", null, sql); } catch (_e) { sportRefused++; }
}
check("the sport lock tables aren't readable or writable by app users", sportRefused === 8);
await db.exec(`update sport_pick_locks set lock_at = now() - interval '1 hour' where a = 'se five'`);
await sport(U1, LIVE, "SE Five", "SF Six", "SF Six", "pfl", { method: "Dec" });
check("once its lock row says the bout began, an open PFL bout closes (times are read live)", (await one(`user_id='${U1}' and f1='SE Five' and promotion='pfl'`)).pick === "SE Five");

// 7. The 🔒 cap still works alongside it.
await pick(U2, NEXT, "K1 A", "K1 B", "K1 A", { conf: 1 });
await pick(U2, NEXT, "K2 A", "K2 B", "K2 A", { conf: 1 });
await pick(U2, NEXT, "K3 A", "K3 B", "K3 A", { conf: 1 });
check("the third 🔒 on a card is still clamped to 0", (await one(`user_id='${U2}' and f1='K3 A'`)).confidence === 0);

// 8. Deleting an account removes everything, and only the caller's.
const before2 = (await rows(`user_id='${U2}'`)).length;
const del = await as("authenticated", U1, "select delete_my_picks() as n");
check("delete_my_picks removes every one of the caller's picks, locked ones too",
  del.rows[0].n >= 3 && (await rows(`user_id='${U1}'`)).length === 0);
check("…and nobody else's", (await rows(`user_id='${U2}'`)).length === before2);
let refused = false;
try { await as("anon", null, "select delete_my_picks()"); } catch (_e) { refused = true; }
check("anon can't call delete_my_picks", refused);
refused = false;
try { await as("authenticated", U1, "select * from pick_locks"); } catch (_e) { refused = true; }
check("lock tables aren't readable or writable by app users", refused);

// 9. lockRows: send-reminders writes the times by the app's own rule.
globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
const src = readFileSync(join(ROOT, "supabase/functions/send-reminders/index.ts"), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const linked = code.replace(/from "\.\.\/_shared\/([\w-]+\.js)"/g,
  (_m, f) => `from "${pathToFileURL(join(ROOT, "supabase/functions/_shared", f)).href}"`);
const mod = await import("data:text/javascript;base64," + Buffer.from(linked).toString("base64"));
const { bundledKernel } = await import(pathToFileURL(join(ROOT, "supabase/functions/_shared/lab-bundle.js")).href);
const k = bundledKernel({});
const ev = { date: "2026-10-03", earlyPrelimTime: "17:00", prelimTime: "19:00", time: "21:00", fights: [
  { f1: { n: "Main A" }, f2: { n: "Main B" }, lbl: "Main Event" },
  { f1: { n: "Card A" }, f2: { n: "Card B" }, lbl: "Main Card" },
  { f1: { n: "TBD" }, f2: { n: "" }, lbl: "Prelim" },
  { f1: { n: "Prelim A" }, f2: { n: "Prelim B" }, lbl: "Prelim" },
  { f1: { n: "Early A" }, f2: { n: "Early B" }, lbl: "Early Prelim" },
  { f1: { n: "Early A" }, f2: { n: "Early B" }, lbl: "Early Prelim" }] };  // a duplicate must not reach the upsert twice
const now = Date.UTC(2026, 9, 3, 12);
const { bouts, cards } = mod.lockRows([ev], k, now);
const lockOf = (a, bs = bouts) => bs.find((b) => b.a === a.toLowerCase() || b.b === a.toLowerCase())?.lock_at;
const et = (h, m = 0) => new Date(Date.UTC(2026, 9, 3, h + 4, m)).toISOString();   // EDT
check("lockRows: a main-card bout locks at the main card (its opener at the bell)", lockOf("Card A") === et(21));
check("lockRows: a prelim locks at the prelims", lockOf("Prelim A") === et(19));
check("lockRows: an early prelim locks at the early prelims (a duplicate at the earlier of its times)", lockOf("Early A") === et(17));
check("lockRows: each bout written once, blank names skipped", bouts.length === 4);
check("lockRows: names stored lower-cased and sorted", bouts.every((b) => b.a < b.b && b.a === b.a.toLowerCase()));
check("lockRows: the card's first and last bells", cards.length === 1 && cards[0].first_bell === et(17) && cards[0].last_bell === et(21));
const fn = { ...ev, earlyPrelimTime: undefined, prelimTime: "18:00", time: "20:00",
  fights: [{ f1: { n: "X A" }, f2: { n: "X B" }, lbl: "Early Prelim" }] };
check("lockRows: an early prelim with no early clock answers to the prelims",
  mod.lockRows([fn], k, now).bouts[0].lock_at === et(18));
// The ET offset is the CARD's, not today's: a November card written from
// October must lock on EST (21:00 ET = 02:00 UTC), or it locks an hour early.
{
  const novNow = Date.UTC(2026, 9, 31, 12), novEv = { ...ev, date: "2026-11-07" };
  const nb = mod.lockRows([novEv], k, novNow).bouts;
  check("lockRows: a November card written in October locks on EST",
    nb.find((b) => b.a === "card a" || b.b === "card a")?.lock_at === new Date(Date.UTC(2026, 10, 8, 2)).toISOString());
}
// 9a. One fight at a time: a segment's opener locks at the bell, each later
// bout when the one before it has a result, and never later than
// LOCK_CHAIN_MS after the bout before it locked.
{
  const b = (lbl, n, extra = {}) => ({ lbl, f1: { n: n + " A" }, f2: { n: n + " B" }, ...extra });
  const mk = (...fs) => ({ date: "2026-10-03", earlyPrelimTime: "16:00", prelimTime: "18:00", time: "20:00", fights: fs });
  const etm = (h, m) => Date.UTC(2026, 9, 3, h + 4, m);
  const C = mod.LOCK_CHAIN_MS;
  check("lockRows: the backstop is 45 minutes (a five-round fight plus walkouts)", C === 45 * 60e3);
  // UFC 332's early prelims, array order (last runs first).
  const fresh = mk(b("Main Event", "Silva"), b("Co-Main", "Talbott"), b("Early Prelim", "Walker"), b("Early Prelim", "Smith"),
    b("Early Prelim", "Anjos"), b("Early Prelim", "Vettori"), b("Early Prelim", "Nolan"));
  let r = mod.lockRows([fresh], k, etm(16, 5)).bouts;
  check("lockRows: before any result, the opener locks at the bell and each next bout 45 minutes after the one before, until the next segment's bell",
    lockOf("Nolan A", r) === et(16) && lockOf("Vettori A", r) === et(16, 45) && lockOf("Anjos A", r) === et(17, 30) &&
    lockOf("Smith A", r) === et(18, 0) && lockOf("Walker A", r) === et(18, 0));   // capped at the prelims' bell
  check("lockRows: the main card has its own chain, from its own opener", lockOf("Talbott A", r) === et(20) && lockOf("Silva A", r) === et(20, 45));
  const long = mk(b("Main Event", "Top"), ...Array.from({ length: 6 }, (_, i) => b("Prelim", "Pr" + i)));
  const lr = mod.lockRows([long], k, etm(17, 0)).bouts;
  check("lockRows: the next segment's bell closes a long segment's chain (6 prelims: the last three at 20:00, not up to 21:45)",
    lockOf("Pr5 A", lr) === et(18) && lockOf("Pr3 A", lr) === et(19, 30) && lockOf("Pr2 A", lr) === et(20) && lockOf("Pr0 A", lr) === et(20));
  fresh.fights[6].winner = "Nolan A";
  r = mod.lockRows([fresh], k, etm(16, 23)).bouts;
  check("lockRows: a result locks the next bout at the run that first sees it",
    lockOf("Vettori A", r) === et(16, 23) && lockOf("Anjos A", r) === et(17, 8) && lockOf("Smith A", r) === et(17, 53));
  const prior = Object.fromEntries(r.map((x) => [x.event_date + "|" + x.a + "|" + x.b, Date.parse(x.lock_at)]));
  r = mod.lockRows([fresh], k, etm(16, 40), prior).bouts;
  check("lockRows: a later run keeps that first sighting rather than moving it to now",
    lockOf("Vettori A", r) === et(16, 23) && lockOf("Anjos A", r) === et(17, 8));
  r = mod.lockRows([fresh], k, etm(16, 40), { ...prior, "2026-10-03|vettori a|vettori b": etm(16, 45) }).bouts;
  check("lockRows: a stored time still ahead (last run's backstop) is not a sighting; now is",
    lockOf("Vettori A", r) === et(16, 40));
  fresh.fights[6].winner = ""; fresh.fights[5].state = "post";
  r = mod.lockRows([fresh], k, etm(16, 50)).bouts;
  check("lockRows: a bout decided without its predecessor's result locks itself, everything before it and the next",
    lockOf("Nolan A", r) === et(16) && lockOf("Anjos A", r) === et(16, 50));
  check("lockRows: …keeping a backstop that had already passed (never moving a lock later)", lockOf("Vettori A", r) === et(16, 45));
  check("lockRows: …and the chain carries on from the new time", lockOf("Smith A", r) === et(17, 35));
}
check("lockRows: a card weeks away or long gone is not written",
  mod.lockRows([{ ...ev, date: "2026-12-12" }, { ...ev, date: "2026-08-01" }], k, now).cards.length === 0);
// 9b. The other sports (0012): send-reminders writes their lock times by the
// APP's rule, sportLockMs in index.html. Lifted from the page and compared over
// every promotion, both DST offsets and with and without a feed `time`, so the
// two copies of the rule and of the per-promotion hours can't drift apart.
{
  const html0 = readFileSync(join(ROOT, "index.html"), "utf8");
  const fnSrc = (name) => {
    const i = html0.indexOf(`function ${name}(`);
    if (i < 0) throw new Error(`index.html no longer defines ${name}()`);
    let j = html0.indexOf("{", i), d = 0;
    for (; j < html0.length; j++) { if (html0[j] === "{") d++; else if (html0[j] === "}" && --d === 0) break; }
    return html0.slice(i, j + 1);
  };
  const hours = /var SPORT_LOCK_UTC_H=(\d+);/.exec(html0), by = /var SPORT_LOCK_UTC_H_BY=(\{[^}]*\});/.exec(html0);
  check("index.html declares the sport lock hours", !!hours && !!by);
  const vm = await import("node:vm");
  const ctx = vm.createContext({ Date, Object, Number, RegExp });
  vm.runInContext(`var SPORT_LOCK_UTC_H=${hours[1]};var SPORT_LOCK_UTC_H_BY=${by[1]};\n` +
    ["_etOffsetAt", "_sportLockH", "sportLockMs"].map(fnSrc).join("\n"), ctx);
  check("the default hour matches the app's", mod.SPORT_LOCK_UTC_H === ctx.SPORT_LOCK_UTC_H);
  check("the per-promotion hours match the app's (RIZIN, DWCS, and no others)",
    JSON.stringify(Object.entries(mod.SPORT_LOCK_UTC_H_BY).sort()) === JSON.stringify(Object.entries(ctx.SPORT_LOCK_UTC_H_BY).sort()));
  let same = true, n = 0;
  for (const promotion of ["pfl", "rizin", "dwcs", "one", "__proto__", "constructor", "toString"])
    for (const date of ["2026-03-07", "2026-03-08", "2026-03-09", "2026-10-03", "2026-10-31", "2026-11-01", "2026-11-02", "2027-03-14"])
      for (const time of [undefined, null, "", "18:00", "19:30", "9:05", "bogus", "25:99"]) {
        n++;
        if (mod.sportLockAt({ promotion, date, time }) !== ctx.sportLockMs({ promotion, date, time })) { same = false; console.error("    differs:", promotion, date, time); }
      }
  check(`send-reminders' sport lock instant equals the app's for all ${n} combinations`, same);
  check("a card in Japan (RIZIN) and a Vegas Tuesday show (DWCS) get their own hours, not one shared default",
    mod.sportLockAt({ promotion: "rizin", date: "2026-10-03" }) === Date.UTC(2026, 9, 3, 2) &&
    mod.sportLockAt({ promotion: "dwcs", date: "2026-09-29" }) === Date.UTC(2026, 8, 29, 22) &&
    mod.sportLockAt({ promotion: "pfl", date: "2026-10-16" }) === Date.UTC(2026, 9, 16, 10));

  const feed = { promotions: [{ id: "pfl", name: "PFL" }, { id: "dwcs", name: "DWCS" }, { id: "ufc", name: "Fake" }], events: [
    { promotion: "pfl", name: "PFL X", date: "2026-10-03", bouts: [
      { a: "Ann One", b: "Ann Two" }, { a: "Ann Two", b: "Ann One" }, { a: " Bea One ", b: "Bea Two" } ] },
    { promotion: "dwcs", name: "DWCS 95", date: "2026-10-03", time: "19:00", bouts: [{ a: "Cat One", b: "Cat Two" }] },
    { promotion: "ufc", name: "Claims UFC", date: "2026-10-03", bouts: [{ a: "U A", b: "U B" }] },           // a feed can't claim 'ufc'
    { promotion: "pfl", name: "Bad", date: "2026-10-03", bouts: [{ a: "Same", b: "Same" }] },               // one fighter twice
    { promotion: "pfl", name: "Far", date: "2026-12-12", bouts: [{ a: "Far A", b: "Far B" }] },
    { promotion: "pfl", name: "Gone", date: "2026-08-01", bouts: [{ a: "Old A", b: "Old B" }] } ] };
  const sr = mod.sportLockRows(feed, Date.UTC(2026, 9, 3, 12));
  const at = (promo, a) => sr.bouts.find((b) => b.promotion === promo && (b.a === a || b.b === a))?.lock_at;
  check("sportLockRows: each feed bout is written once, lower-cased and sorted, under its promotion",
    sr.bouts.length === 3 && sr.bouts.every((b) => b.a < b.b && b.a === b.a.toLowerCase()) &&
    sr.bouts.filter((b) => b.a === "ann one").length === 1 && !!at("pfl", "bea one"));
  check("sportLockRows: a card locks at the app's instant (PFL default hour; DWCS's own `time` in ET)",
    at("pfl", "ann one") === new Date(Date.UTC(2026, 9, 3, 10)).toISOString() && at("dwcs", "cat one") === new Date(Date.UTC(2026, 9, 3, 23)).toISOString());
  check("sportLockRows: one card row per promotion and date, carrying that instant",
    sr.cards.length === 2 && sr.cards.every((c) => c.promotion && c.event_date === "2026-10-03") &&
    sr.cards.find((c) => c.promotion === "dwcs").first_bell === new Date(Date.UTC(2026, 9, 3, 23)).toISOString());
  check("sportLockRows: a card the app would drop (claims 'ufc', one fighter twice) gets no lock row",
    !at("ufc", "u a") && !sr.bouts.some((b) => b.a === "same"));
  check("sportLockRows: a card weeks away or long gone is not written", !at("pfl", "far a") && !at("pfl", "old a"));
  check("sportLockRows: garbage in is an empty result, not a throw",
    mod.sportLockRows(null, Date.now()).bouts.length === 0 && mod.sportLockRows({ events: "x" }, Date.now()).bouts.length === 0);
  const src2 = readFileSync(join(ROOT, "supabase/functions/send-reminders/index.ts"), "utf8");
  check("send-reminders writes sport locks only with the service key, into the two sport tables",
    /if \(SB_SERVICE_ROLE_KEY\) \{\s*try \{\s*const fr = await fetch\(`\$\{PAGES_BASE\}events-extra\.json/.test(src2) &&
    /put\("sport_pick_locks", "promotion,event_date,a,b", bouts\)/.test(src2) && /put\("sport_card_bells", "promotion,event_date", cards\)/.test(src2));
  check("...and a bad feed cannot cost UFC its lock times (separate try/catch, separate result)", /sportLocks = \{ error:/.test(src2) && /locks = \{ error:/.test(src2));
}
check("send-reminders writes locks only with the service key, building on what it last wrote",
  /if \(SB_SERVICE_ROLE_KEY\) \{\s*try \{\s*const h = \{[^}]*apikey: SB_SERVICE_ROLE_KEY[^]*?const \{ bouts, cards \} = lockRows\(evs, bundledKernel\(\{\}\), now, prior\)/.test(src) &&
  /rest\/v1\/pick_locks\?select=event_date,a,b,lock_at&event_date=in\./.test(src));
check("the fight-change alert reads picks with the service key (0017 hides unlocked picks from anon)",
  /apikey: SB_SERVICE_ROLE_KEY \|\| SB_ANON_KEY, Authorization: `Bearer \$\{SB_SERVICE_ROLE_KEY \|\| SB_ANON_KEY\}`, Range/.test(src));

// 10. The app deletes an account through the RPC.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
// (Since 0014 that RPC is delete_my_account, which also runs as the owner so
// the lock lets locked picks through; check:delete runs it on a locked pick.)
check("Delete account goes through an owner RPC, never a plain picks DELETE the lock would refuse",
  /\/rest\/v1\/rpc\/delete_my_account/.test(html) && /delete from picks where user_id = me/.test(readFileSync(join(ROOT, "supabase/migrations/0014_delete_account.sql"), "utf8")));

// 11. Only email accounts write picks (0015). Applied last: every earlier
// section runs as a bare uid with no is_anonymous claim, which 0015 refuses.
await db.exec(`
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
`);
await db.exec(readFileSync(join(ROOT, "supabase/migrations/0015_picks_require_account.sql"), "utf8"));
const U3 = "33333333-3333-3333-3333-333333333333", U4 = "44444444-4444-4444-4444-444444444444";
async function asJwt(uid, anon, sql) {
  const claims = JSON.stringify(anon === undefined ? { sub: uid } : { sub: uid, is_anonymous: anon });
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('request.jwt.claims', '${claims}', false); set role authenticated;`);
  try { return await db.query(sql); } finally { await db.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
}
const pickSql = (uid, who) => `insert into picks (user_id, event_date, f1, f2, pick) values ('${uid}', '${NEXT}', 'acct a', 'acct b', '${who}')`;
const rlsRefused = async (fn) => { try { await fn(); return false; } catch (e) { return /row-level security/.test(String(e.message)); } };
check("0015: an anonymous session's pick is refused", await rlsRefused(() => asJwt(U3, true, pickSql(U3, "acct a"))));
check("0015: a token with no is_anonymous claim is treated as anonymous (fails closed)", await rlsRefused(() => asJwt(U3, undefined, pickSql(U3, "acct a"))));
await asJwt(U4, false, pickSql(U4, "acct a"));
check("0015: an email account's pick is accepted", !!(await one(`user_id = '${U4}' and f1 = 'acct a'`)));
await db.exec(`insert into picks (user_id, event_date, f1, f2, pick) values ('${U3}', '${NEXT}', 'acct a', 'acct b', 'acct a')`);   // a row from before the rule
check("0015: an anonymous session can't change its old pick",
  await rlsRefused(() => asJwt(U3, true, `update picks set pick = 'acct b' where user_id = '${U3}'`)) && (await one(`user_id = '${U3}'`)).pick === "acct a");
await asJwt(U3, false, `update picks set pick = 'acct b' where user_id = '${U3}'`);
check("0015: ...but once it links an email (same uid) it can", (await one(`user_id = '${U3}'`)).pick === "acct b");
await asJwt(U4, false, `update picks set pick = 'hijack' where user_id = '${U3}'`);
check("0015: an account still can't touch someone else's pick", (await one(`user_id = '${U3}'`)).pick === "acct b");
await asJwt(U3, true, `delete from picks where user_id = '${U3}'`);
check("0015: an anonymous session may still delete its own row", !(await one(`user_id = '${U3}'`)));
check("app: a pick tap without an email opens Sign In to Pick, before the name prompt",
  /function checkName\(cb\)\{if\(_pickNeedsAccount\(cb\)\)return;/.test(html) && /function _pickNeedsAccount\(cb\)\{\s*if\(_sessEmail\(\)\)return false;/.test(html));
check("app: lock, method, bonus and sport lock/method are gated too",
  /if\(!preds\[k\]\)return;\s*if\(_pickNeedsAccount\(null\)\)return;/.test(html) &&
  /mb\.onclick=function\(\)\{if\(_pickNeedsAccount\(null\)\)return;preds_method/.test(html) &&
  /fotSel\.onchange=function\(\)\{if\(_pickNeedsAccount\(null\)\)/.test(html) &&
  (html.match(/function sport(Method|Lock)\(promo,ev,b[^]*?_pickNeedsAccount\(null\)/g) || []).length === 2);
check("app: pick writes refresh a token minted before the email was linked",
  /_authReady\.then\(_accountToken\)\.then\(function\(\)\{\s*var hdrs/.test(html) && /function _sportSync\(promo,ev,b,name\)\{\s*return _authReady\.then\(_accountToken\)/.test(html));

// 12. Nobody sees anyone else's pick until that bout locks (0017).
await db.exec(readFileSync(join(ROOT, "supabase/migrations/0017_picks_hidden_until_lock.sql"), "utf8"));
{
  const U5 = "55555555-5555-5555-5555-555555555555", U6 = "66666666-6666-6666-6666-666666666666";
  await db.exec(`
    insert into pick_locks (event_date, a, b, lock_at) values
      ('${LIVE}', 'hide a', 'hide b', now() + interval '1 hour'),
      ('${LIVE}', 'show a', 'show b', now() - interval '6 minutes'),
      ('${LIVE}', 'grace a', 'grace b', now() - interval '2 minutes');
    insert into picks (user_id, event_date, f1, f2, pick) values
      ('${U5}', '${LIVE}', 'Hide A', 'Hide B', 'Hide A'),
      ('${U5}', '${LIVE}', 'Show A', 'Show B', 'Show A'),
      ('${U5}', '${LIVE}', 'Grace A', 'Grace B', 'Grace A'),
      ('${U5}', '${PAST}', 'Gone A', 'Gone B', 'Gone A'),
      ('${U5}', '${NEXT}', 'Next A', 'Next B', 'Next A');
    insert into picks (user_id, event_date, f1, f2, pick, promotion) values
      ('${U5}', '${LIVE}', 'Pfl A', 'Pfl B', 'Pfl A', 'pfl');
    insert into sport_pick_locks (promotion, event_date, a, b, lock_at) values
      ('pfl', '${LIVE}', 'pfl a', 'pfl b', now() + interval '1 hour');
  `);
  const seenBy = async (role, uid) => (await as(role, uid, `select f1 from picks where user_id = '${U5}' order by f1`)).rows.map((x) => x.f1);
  const other = await seenBy("authenticated", U6), anon = await seenBy("anon", null), own = await seenBy("authenticated", U5);
  check("0017: another player can't see a pick on a bout that hasn't locked", !other.includes("Hide A") && !anon.includes("Hide A"));
  check("0017: …nor one on next week's card", !other.includes("Next A") && !anon.includes("Next A"));
  check("0017: …nor one locked less than LOCK_GRACE ago, while it could still be written", !other.includes("Grace A") && !anon.includes("Grace A"));
  check("0017: once the bout has locked (plus the grace) everyone sees it", other.includes("Show A") && anon.includes("Show A"));
  check("0017: a past card is visible to everyone", other.includes("Gone A") && anon.includes("Gone A"));
  check("0017: another sport's pick is hidden by its own lock time", !other.includes("Pfl A") && own.includes("Pfl A"));
  check("0017: the owner always sees all of their own picks", ["Hide A", "Show A", "Grace A", "Gone A", "Next A", "Pfl A"].every((n) => own.includes(n)));
  let locks = { rows: [] };
  try { locks = await as("anon", null, `select lock_at from pick_locks where a = 'hide a'`); } catch (_e) { /* refused */ }
  check("0017: lock times are readable by the app", locks.rows.length === 1);
  let wrote = true;
  try { await as("authenticated", U6, `update pick_locks set lock_at = now() + interval '9 hours' where a = 'show a'`); } catch (_e) { wrote = false; }
  const still = (await db.query(`select lock_at > now() as ahead from pick_locks where a = 'show a'`)).rows[0].ahead;
  check("0017: …but not writable: nobody can move a bout's lock to reopen it", !still);
  void wrote;
  await db.exec(`update picks set nickname = '🥊 Jordan' where user_id = '${U5}' and f1 = 'Next A'`);
  const taken = async (uid, name, since = "2026-01-01") => (await as("authenticated", uid, `select nickname_taken($1, $2) as t`, [name, since])).rows[0].t;
  check("0017: the name check still sees a name on a hidden pick", await taken(U6, "jordan") === true && await taken(U6, "Jordan") === true);
  check("0017: …not your own name, and not a name only on old cards", await taken(U5, "jordan") === false && await taken(U6, "jordan", "2100-01-01") === false);
  check("0017: …and a % or _ in the name is a character, not a wildcard", await taken(U6, "jord%") === false && await taken(U6, "_ordan") === false);
}

// Since 0017 the anon key can't see a pick before its bout's lock + grace, so a
// server function that reads picks to build a result push's audience must use
// the service key: an anon read inside the grace returns nobody, and notif_log
// then dedups that push away for good. send-push and send-reminders always did;
// check-results read with the anon key until this was caught.
{
  const fns = ["check-results", "send-push", "send-reminders"];
  for (const fn of fns) {
    const src = readFileSync(join(ROOT, "supabase/functions", fn, "index.ts"), "utf8");
    const reads = [...src.matchAll(/\/rest\/v1\/picks\?[^`]*`\s*,\s*\{\s*headers:\s*([^,}\s]+)/g)].map((m) => m[1]);
    const anon = reads.filter((h) => /anon/i.test(h));
    check(`0017: ${fn} reads picks with the service key, never the anon key (${reads.length} read(s))`, reads.length > 0 && anon.length === 0);
  }
}

// check-results waits out a bout's lock grace before claiming its result push:
// the service-key read sees every pick so far, but the database still takes one
// for LOCK_GRACE after the lock, and notif_log would dedup a later picker out.
{
  const src = readFileSync(join(ROOT, "supabase/functions/check-results/index.ts"), "utf8");
  const stub = "globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };\n";
  const { code: crCode } = await transform(stub + src, { loader: "ts", format: "esm" });
  const crLinked = crCode.replace(/from "\.\.\/_shared\/([\w-]+\.js)"/g,
    (_m, f) => `from "${pathToFileURL(join(ROOT, "supabase/functions/_shared", f)).href}"`);
  const cr = await import("data:text/javascript;base64," + Buffer.from(crLinked).toString("base64"));
  const T = Date.parse("2026-10-10T02:00:00Z"), min = 60_000;
  check("check-results: a result inside its bout's lock grace waits", cr.graceOver(T - 3 * min, T) === false);
  check("check-results: …and goes once the grace is over", cr.graceOver(T - 5 * min, T) === true && cr.graceOver(T - 10 * min, T) === true);
  check("check-results: a lock time that couldn't be read waits (fail closed)", cr.graceOver(undefined, T) === false && cr.graceOver(NaN, T) === false);
  check("check-results: LOCK_GRACE matches the database's 5 minutes", cr.LOCK_GRACE_MS === 5 * 60 * 1000);
  check("check-results: the result loop asks pick_lock_for and defers on graceOver before any send",
    /await boutLockAt\(SUPABASE_URL, picksHeaders, eventDate/.test(src) && /if \(!graceOver\(lockAt, now\)\) \{ deferredCount\+\+; continue; \}/.test(src)
    && src.indexOf("graceOver(lockAt, now)") < src.indexOf("functions/v1/send-push"));
  // "No lock row" is not "long past": a card with no schedule falls back to
  // midnight ET after its date, which is why the functions ask pick_lock_for
  // for the effective lock instead of reading pick_locks.
  const fb = (await db.query("select public.pick_lock_for('ufc', '2031-06-07', 'nobody a', 'nobody b') as t")).rows[0].t;
  check("pick_lock_for answers an unscheduled card with midnight ET after its date (so a result can land before it)",
    new Date(fb).toISOString() === "2031-06-08T04:00:00.000Z");
  // boutLockAt reads the RPC and fails closed on an error.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => /rpc\/pick_lock_for/.test(String(url)) && JSON.parse(init.body).p_promo === "ufc"
    ? new Response(JSON.stringify("2026-10-10T01:57:00+00:00"), { status: 200 }) : new Response("no", { status: 500 });
  const got = await cr.boutLockAt("https://x", {}, "2026-10-10", "A", "B");
  globalThis.fetch = async () => new Response("down", { status: 503 });
  const down = await cr.boutLockAt("https://x", {}, "2026-10-10", "A", "B");
  globalThis.fetch = async () => new Response(JSON.stringify("-infinity"), { status: 200 });
  const ninf = await cr.boutLockAt("https://x", {}, "2026-10-10", "A", "B");
  globalThis.fetch = realFetch;
  check("check-results: boutLockAt reads pick_lock_for, is undefined on an error and 0 for -infinity",
    got === Date.parse("2026-10-10T01:57:00Z") && down === undefined && ninf === 0);
}

if (failures) { console.error(`\ncheck-pick-lock: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-pick-lock: once a bout locks, its picks can't be added, changed, moved or deleted, and nobody else's show before it.");
