// The server-side pick lock (supabase/migrations/0010_picks_lock.sql), run for
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
//   - other promotions, our own functions and delete_my_picks() pass through
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
for (const m of ["0005_picks_lock_cap.sql", "0010_picks_lock.sql"]) {
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
const LIVE = "2026-10-03", NEXT = "2099-10-10", PAST = "2020-01-04", PAST_NONE = "2020-02-01";
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

// 6. Other sports keep their own lock.
await pick(U2, LIVE, "Alpha One", "Bravo Two", "Bravo Two", { promo: "pfl" });
check("another promotion's rows are not policed here", !!(await one(`user_id='${U2}' and promotion='pfl'`)));
await as("service_role", null, upsert, [U2, "🥊 B", LIVE, "Charlie Three", "Delta Four", "Charlie Three", "", 1, null, "ufc"]);
await db.exec(`update pick_locks set lock_at = now() - interval '1 hour' where a = 'charlie three'`);
await as("authenticated", U2, `update picks set promotion = 'pfl', pick = 'Delta Four' where user_id = $1 and f1 = 'Charlie Three' and promotion = 'ufc'`, [U2]);
r = await one(`user_id='${U2}' and f1='Charlie Three'`);
check("a locked UFC pick can't be moved to another promotion (or re-picked on the way)", r && r.promotion === "ufc" && r.pick === "Charlie Three");
await as("authenticated", U2, `delete from picks where user_id = $1 and f1 = 'Charlie Three'`, [U2]);
check("…so it still can't be deleted", !!(await one(`user_id='${U2}' and f1='Charlie Three'`)));

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
  { f1: { n: "Prelim A" }, f2: { n: "Prelim B" }, lbl: "Prelim" },
  { f1: { n: "Early A" }, f2: { n: "Early B" }, lbl: "Early Prelim" },
  { f1: { n: "Early A" }, f2: { n: "Early B" }, lbl: "Early Prelim" },   // a duplicate must not reach the upsert twice
  { f1: { n: "TBD" }, f2: { n: "" }, lbl: "Prelim" }] };
const now = Date.UTC(2026, 9, 3, 12);
const { bouts, cards } = mod.lockRows([ev], k, now);
const lockOf = (a) => bouts.find((b) => b.a === a.toLowerCase() || b.b === a.toLowerCase())?.lock_at;
const et = (h) => new Date(Date.UTC(2026, 9, 3, h + 4)).toISOString();   // EDT
check("lockRows: a main-card bout locks at the main card", lockOf("Main A") === et(21) && lockOf("Card A") === et(21));
check("lockRows: a prelim locks at the prelims", lockOf("Prelim A") === et(19));
check("lockRows: an early prelim locks at the early prelims", lockOf("Early A") === et(17));
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
    nb.find((b) => b.a === "main a" || b.b === "main a")?.lock_at === new Date(Date.UTC(2026, 10, 8, 2)).toISOString());
}
check("lockRows: a card weeks away or long gone is not written",
  mod.lockRows([{ ...ev, date: "2026-12-12" }, { ...ev, date: "2026-08-01" }], k, now).cards.length === 0);
check("send-reminders writes locks only with the service key", /if \(SB_SERVICE_ROLE_KEY\) \{\s*try \{\s*const \{ bouts, cards \} = lockRows/.test(src));

// 10. The app deletes an account through the RPC.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
check("Delete account calls delete_my_picks", /\/rest\/v1\/rpc\/delete_my_picks/.test(html));

if (failures) { console.error(`\ncheck-pick-lock: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-pick-lock: once a bout's segment starts, its picks can't be added, changed, moved or deleted.");
