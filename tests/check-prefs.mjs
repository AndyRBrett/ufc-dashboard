// Guard: notification preferences follow the account, and restoring one never
// claims a capability the browser has not granted.
//
// The failure this exists for is silent. _prefsApply runs on a fresh install
// that has just signed in, where the stored prefs say "push was on" but the OS
// notification permission is back at "default" (iOS only prompts on a user
// gesture, and a reinstall resets it). Writing ufc_push="1" there lights the
// bell while nothing is subscribed — the user believes notifications are on
// and is unreachable whenever the app is closed, which is exactly the state
// _ensurePushFresh was written to prevent. Worse, _ensurePushFresh would then
// pass its own localStorage gate and bail on the permission check, so nothing
// ever repairs it.
//
// Also asserts the plumbing that makes prefs persist at all: every toggle
// writes, and both restore points read.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

const a = html.indexOf("// prefs:start"), b = html.indexOf("// prefs:end");
if (a < 0 || b < 0) { fail("index.html: no // prefs:start … // prefs:end block — renamed or removed?"); process.exit(1); }
const src = html.slice(a, b);

// Build a context where every side effect _prefsApply can have is observable.
function run(prefs, permission) {
  const store = {};
  const calls = { ensureFresh: 0, bell: [], liveRes: [], toasts: [], schedule: 0, saved: [] };
  const perm = { value: permission };
  const ctx = vm.createContext({
    console, JSON, Object, String, Array, Promise, Date, encodeURIComponent,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    Notification: { get permission() { return perm.value; } },
    window: { Notification: { get permission() { return perm.value; } } },
    USER_ID: "u1", notifActive: false,
    document: { getElementById: () => null },
    fetch: (url, opt) => {
      if (String(url).includes("user_prefs") && opt && opt.method === "POST")
        calls.saved.push(JSON.parse(opt.body));
      return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
    },
    _authReady: Promise.resolve(),
    SUPABASE_URL: "https://x", _sbHeaders: () => ({}),
    // Defined above the prefs block in index.html, so stub it here with the
    // same semantics: reads the same key the block writes.
    _liveResultsOn: () => store.ufc_live_results === "1",
    _ensurePushFresh: () => { calls.ensureFresh++; },
    _setBellActive: (v) => calls.bell.push(v),
    _setLiveResActive: (v) => calls.liveRes.push(v),
    checkNotifSchedule: () => { calls.schedule++; },
    toast: (m) => calls.toasts.push(m),
  });
  // `"Notification" in window` is how the source probes support.
  let rows = [];
  vm.runInContext(src, ctx);
  vm.runInContext("_prefsApply(" + JSON.stringify(prefs) + ")", ctx);
  return {
    store, calls, perm,
    // Re-enter through the real entry points, as a toggle would.
    save: () => vm.runInContext("_prefsSave()", ctx),
    load: (r) => { rows = r; return vm.runInContext("_prefsLoad()", ctx); },
    set: (k, v) => { store[k] = v; },
  };
}

const ALL_ON = { push: true, live_results: true, reminders: true };

// --- the load-bearing one: no permission means no claim of push ---
{
  const { store, calls } = run(ALL_ON, "default");
  check("permission 'default': ufc_push is NOT set from a stored pref",
    store.ufc_push !== "1");
  check("permission 'default': the bell is not lit",
    !calls.bell.includes(true));
  check("permission 'default': no push re-subscribe is attempted",
    calls.ensureFresh === 0);
  check("permission 'default': local reminders are not claimed either",
    store.ufc_notif !== "1");
  check("permission 'default': the remembered intent surfaces as a prompt",
    calls.toasts.length === 1 && /bell/i.test(calls.toasts[0]));
  check("permission 'default': live_results still restores (no OS permission needed)",
    store.ufc_live_results === "1" && calls.liveRes.includes(true));
}
{
  const { store, calls } = run(ALL_ON, "denied");
  check("permission 'denied' is treated exactly like 'default'",
    store.ufc_push !== "1" && calls.ensureFresh === 0 && calls.toasts.length === 1);
}
// --- granted: the toggles actually come back ---
{
  const { store, calls } = run(ALL_ON, "granted");
  check("permission 'granted': ufc_push restores and the bell lights",
    store.ufc_push === "1" && calls.bell.includes(true));
  check("permission 'granted': the subscription is re-validated",
    calls.ensureFresh === 1);
  check("permission 'granted': reminders restore and reschedule",
    store.ufc_notif === "1" && calls.schedule === 1);
  check("permission 'granted': no prompt — nothing for the user to do",
    calls.toasts.length === 0);
}
// --- positives only: a stored false never kills a live local subscription ---
{
  const { store } = run({ push: false, live_results: false, reminders: false }, "granted");
  check("a stored false does not write ufc_push=0 over a working local one",
    store.ufc_push === undefined);
  check("a stored false does not switch off local live_results",
    store.ufc_live_results === undefined);
}
// --- an empty/absent row is a no-op, not a throw ---
{
  let threw = false;
  try { run(null, "granted"); } catch { threw = true; }
  check("a missing prefs row is a no-op rather than a crash", !threw);
}

// --- Codex #140 P1: the prompt must not destroy the intent it prompts for ---
// Fresh install, reminders were on, permission not yet granted. The user
// follows the toast and taps the bell; enablePush() grants permission and
// calls _prefsSave(). If the pending row is not applied first, that save reads
// ufc_notif as unset and writes reminders:false over the stored true, so
// reminders never come back.
{
  const h = run(ALL_ON, "default");
  check("no permission: the unapplied row is held, not dropped",
    h.store.ufc_notif !== "1");
  h.perm.value = "granted";          // the bell tap granted it
  h.set("ufc_push", "1");            // ...and enablePush wrote its own flag
  await h.save();
  check("after the grant, the held reminder intent is applied",
    h.store.ufc_notif === "1");
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("the save that follows the grant persists reminders:true, not false",
    last && last.reminders === true);
  check("...and does not lose live_results on the way through",
    last && last.live_results === true);
}
{
  // The same trap via the reminder button instead of the bell.
  const h = run(ALL_ON, "default");
  h.perm.value = "granted";
  h.set("ufc_notif", "1");
  await h.save();
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("granting through the reminder toggle does not clobber push:true",
    last && last.push === true);
}
{
  const h = run(ALL_ON, "default");
  await h.save();                     // still no permission
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("while permission is still withheld, the held row is NOT applied",
    h.store.ufc_push !== "1" && last && last.push === false);
}

// --- Codex #140 P1: an existing install must seed a row before it can be wiped ---
{
  const h = run(null, "granted");
  h.set("ufc_live_results", "1");
  h.set("ufc_notif", "1");
  await h.load([]);                   // no row yet: account predates the table
  const seeded = h.calls.saved[h.calls.saved.length - 1];
  check("an account with no row seeds it from existing local settings",
    seeded && seeded.live_results === true && seeded.reminders === true);
}
{
  const h = run(null, "granted");
  await h.load([]);                   // nothing on locally
  check("a user with nothing enabled writes no row — no empty write per user",
    h.calls.saved.length === 0);
}

// --- plumbing: every toggle persists, both restore points read ---
const seg = (name) => {
  const i = html.indexOf("function " + name);
  if (i < 0) return "";
  return html.slice(i, i + 1400);
};
check("togglePush persists on the off path", /_prefsSave\(\)/.test(seg("togglePush")));
check("enablePush persists once the subscription lands", /_prefsSave\(\)/.test(seg("enablePush")));
check("toggleLiveResults persists", /_prefsSave\(\)/.test(seg("toggleLiveResults")));
check("toggleNotif persists on both paths",
  (seg("toggleNotif").match(/_prefsSave\(\)/g) || []).length >= 2);
check("boot reads prefs once auth resolves", /_authReady\.then\(_prefsLoad\)/.test(html));
check("an in-app sign-in re-reads prefs for the new identity",
  /_prefsLoad\(\);\s*\/\/ \.\.\.and restore/.test(html));
check("the upsert is keyed on user_id, so a second device updates rather than duplicates",
  /user_prefs\?on_conflict=user_id/.test(html) && /resolution=merge-duplicates/.test(html));

// --- the migration exists and is owner-only ---
const sql = readFileSync(join(ROOT, "supabase/migrations/0004_user_prefs.sql"), "utf8");
check("user_prefs has RLS enabled", /alter table public\.user_prefs enable row level security/.test(sql));
check("user_prefs select is owner-only — prefs are nobody else's business",
  /user_prefs_select[\s\S]{0,200}auth\.uid\(\)::text = user_id/.test(sql));
check("\"Delete forever\" removes the prefs row — the dialog promises exactly that",
  /user_prefs\?user_id=eq\.[\s\S]{0,120}method:"DELETE"/.test(html.slice(html.indexOf("function deleteAccount"), html.indexOf("function deleteAccount") + 1800)));
check("user_prefs grants the owner DELETE so that request can succeed",
  /user_prefs_delete[\s\S]{0,200}for delete to authenticated using \(auth\.uid\(\)::text = user_id\)/.test(sql) &&
  /grant select, insert, update, delete on public\.user_prefs to authenticated/.test(sql));
check("anon holds no grant on user_prefs",
  /revoke all on public\.user_prefs from anon, authenticated/.test(sql) &&
  !/grant[^\n]*to[^\n]*\banon\b/.test(sql.split("revoke all")[1] || ""));

if (failures) { console.error(`\n${failures} preference check(s) failed`); process.exit(1); }
console.log("\nNotification preference checks passed");
