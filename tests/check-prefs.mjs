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
      if (String(url).includes("user_prefs") && opt && opt.method === "POST") {
        // Recorded when the write COMPLETES, not when it is issued, and the
        // first one is made slow on purpose. Recording at issue time would
        // preserve order even with no serialization at all, so the test would
        // pass a broken implementation.
        const body = JSON.parse(opt.body);
        const delay = postDelays.length ? postDelays.shift() : 0;
        return new Promise((res) => setTimeout(() => {
          calls.saved.push(body);
          res({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }, delay));
      }
      return Promise.resolve({
        ok: status >= 200 && status < 300, status,
        json: () => Promise.resolve(rows),
      });
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
  let rows = [], status = 200;
  const postDelays = [];
  vm.runInContext(src, ctx);
  vm.runInContext("_prefsApply(" + JSON.stringify(prefs) + ")", ctx);
  return {
    store, calls, perm,
    // Re-enter through the real entry points, as a toggle would.
    save: (changed) => vm.runInContext("_prefsSave(" + (changed ? JSON.stringify(changed) : "") + ")", ctx),
    load: (r, st) => { rows = r; status = st === undefined ? 200 : st; return vm.runInContext("_prefsLoad()", ctx); },
    set: (k, v) => { store[k] = v; },
    delayPosts: (...d) => { postDelays.length = 0; postDelays.push(...d); },
    // The seed write is fired from inside _prefsLoad and not chained into its
    // promise, so tests must wait on the write queue itself.
    flush: () => vm.runInContext("_prefsQ", ctx),
    become: (id) => vm.runInContext("USER_ID = " + JSON.stringify(id), ctx),
    touched: () => vm.runInContext("JSON.stringify(_prefsTouched)", ctx),
    reset: () => vm.runInContext("_prefsTouched = {}; _prefsPending = null;", ctx),
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
  // Withheld permission: the held row must not be APPLIED locally — that would
  // light the bell with nothing subscribed.
  const h = run(ALL_ON, "default");
  await h.save("live_results");
  check("while permission is withheld, held intent is not applied locally",
    h.store.ufc_push !== "1" && h.store.ufc_notif !== "1");
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("...and a keyed save cannot erase it, because it never sends it",
    last && !("push" in last) && !("reminders" in last));
}

// --- Codex #140 round 2 P1: held intent must survive saves made BEFORE the
// permission prompt, and must never resurrect a key the user has since changed.
{
  // Fresh install, everything stored on, permission still withheld. The user
  // toggles Live Result Spoilers off — an ordinary action needing no
  // permission — which saves. That save must not write push/reminders false.
  const h = run(ALL_ON, "default");
  h.set("ufc_live_results", "0");
  await h.save("live_results");
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("a save before the prompt writes ONLY the key it changed",
    last && Object.keys(last).filter((k) => k !== "user_id" && k !== "updated_at")
      .join() === "live_results");
  check("...so held push intent is left standing on the server, not overwritten",
    last && !("push" in last) && !("reminders" in last));
  check("...while honouring the change the user actually made",
    last && last.live_results === false);
}
{
  // Same, then permission is granted. The stale snapshot must not switch the
  // spoiler preference back on behind the user.
  const h = run(ALL_ON, "default");
  h.set("ufc_live_results", "0");
  await h.save("live_results");
  h.perm.value = "granted";
  h.set("ufc_push", "1");
  await h.save("push");
  check("granting later does not resurrect the preference the user turned off",
    h.store.ufc_live_results === "0");
  check("...while the untouched reminder intent is applied on the grant",
    h.store.ufc_notif === "1");
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("...and that save touches only the bell it was called for",
    last && !("live_results" in last) && !("reminders" in last) && last.push === true);
}

// --- Codex #140 round 3 P2: a load in flight must not undo a toggle ---
{
  // Stored push:true. The user taps the bell OFF while the GET is still in
  // the air. When the old row lands it must not write ufc_push back to "1"
  // and re-subscribe, which would silently reverse the tap.
  const h = run(null, "granted");
  h.set("ufc_push", "0");
  await h.save("push");                 // the tap
  await h.load([ALL_ON]);               // the response that was already flying
  check("a stale load does not re-enable a bell the user just turned off",
    h.store.ufc_push === "0");
  check("...and does not re-subscribe behind them",
    h.calls.ensureFresh === 0);
  check("...while an untouched key from the same row still applies",
    h.store.ufc_notif === "1");
}
{
  // Same race with permission withheld: the prompt must not nag about a
  // preference the user has just switched off themselves.
  const h = run(null, "default");
  h.set("ufc_push", "0");
  await h.save("push");
  await h.load([{ push: true, live_results: false, reminders: false }]);
  check("no prompt for intent the user has explicitly just declined",
    h.calls.toasts.length === 0);
}

// --- Codex #140 round 4 P2: a touched key must not be HELD, only skipped ---
{
  // Permission withheld. The user turns the bell off, then a load lands with
  // push:true. Filtering only at apply time leaves the stored true sitting in
  // the held row, and the next unrelated save merges it straight back to the
  // account — the choice reappears on the next reinstall.
  const h = run(null, "default");
  h.set("ufc_push", "0");
  await h.save("push");                       // explicit: bell off
  await h.load([ALL_ON]);                     // response says push:true
  h.set("ufc_live_results", "1");
  await h.save("live_results");               // an unrelated later toggle
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("an unrelated save cannot resurrect a touched key — it is not in the write",
    last && !("push" in last));
  check("...and leaves untouched held intent alone on the server too",
    last && !("reminders" in last));
}

// --- Codex #140 round 4 P2: touched keys belong to the identity that set them ---
{
  const h = run(null, "granted");
  h.set("ufc_push", "0");
  await h.save("push");
  check("a touch is recorded for the signing-out identity",
    JSON.parse(h.touched()).push === true);
  h.reset();                                   // what _postSignIn does on a switch
  await h.load([ALL_ON]);
  check("after switching accounts, the new account's stored prefs DO apply",
    h.store.ufc_push === "1");
}

// --- Codex #140 round 4 P2: a response must not land on a different identity ---
{
  const h = run(null, "granted");
  const inflight = h.load([ALL_ON]);           // request issued as u1
  h.become("u2");                              // sign-in adopts another account
  await inflight;
  check("a load issued for one account is discarded if the identity changed",
    h.store.ufc_push === undefined && h.calls.ensureFresh === 0);
}
{
  const h = run(null, "granted");
  await h.load([ALL_ON]);                      // identity unchanged
  check("...while a load for the current identity still applies normally",
    h.store.ufc_push === "1");
}

// --- Codex #140 P1: an existing install must seed a row before it can be wiped ---
{
  const h = run(null, "granted");
  h.set("ufc_live_results", "1");
  h.set("ufc_notif", "1");
  await h.load([]);                   // no row yet: account predates the table
  await h.flush();
  const seeded = h.calls.saved[h.calls.saved.length - 1];
  check("an account with no row seeds it from existing local settings",
    seeded && seeded.live_results === true && seeded.reminders === true);
}
{
  const h = run(null, "granted");
  await h.load([]);                   // nothing on locally
  await h.flush();
  check("a user with nothing enabled writes no row — no empty write per user",
    h.calls.saved.length === 0);
}

// --- Codex #140 round 5 P2: a write must not carry columns it did not change ---
{
  // Two devices, one account. This device last saw reminders off; the other
  // device just turned them on. A full-row write from this device's snapshot
  // would erase that. A per-column write cannot.
  const h = run(null, "granted");
  h.set("ufc_live_results", "1");
  await h.save("live_results");
  const last = h.calls.saved[h.calls.saved.length - 1];
  check("a toggle writes only its own column, so another device's setting survives",
    last && !("reminders" in last) && !("push" in last) && last.live_results === true);
  check("...and still carries the row key and a timestamp",
    last && last.user_id === "u1" && typeof last.updated_at === "string");
}
{
  // Seeding is the one full-row write, and it is safe precisely because it
  // only happens when the account has no row to overwrite.
  const h = run(null, "granted");
  h.set("ufc_push", "1");
  await h.load([]);
  await h.flush();
  const seeded = h.calls.saved[h.calls.saved.length - 1];
  check("seeding an account with no row does write the full row",
    seeded && "push" in seeded && "live_results" in seeded && "reminders" in seeded);
}

// --- Codex #140 round 5 P2: two quick toggles must land in order ---
{
  const h = run(null, "granted");
  h.delayPosts(25, 0);              // the first write is the slow one
  h.set("ufc_push", "1");
  const first = h.save("push");     // on
  h.set("ufc_push", "0");
  const second = h.save("push");    // ...then off, before the first resolves
  await Promise.all([first, second]);
  const order = h.calls.saved.map((w) => w.push);
  check("concurrent toggles are serialized, so the last one written is the last one made",
    order[order.length - 1] === false);
}

// --- Codex #140 round 5 P2: a failed read must not be mistaken for an empty one ---
{
  const h = run(null, "granted");
  h.set("ufc_push", "1");
  await h.load([], 500);
  await h.flush();
  check("a transient read failure does not seed over a row that may exist",
    h.calls.saved.length === 0);
}
{
  const h = run(null, "granted");
  h.set("ufc_push", "1");
  await h.load([], 404);
  await h.flush();
  check("a 404 (table absent) neither seeds nor throws",
    h.calls.saved.length === 0);
}

// --- plumbing: every toggle persists, both restore points read ---
const seg = (name) => {
  const i = html.indexOf("function " + name);
  if (i < 0) return "";
  return html.slice(i, i + 1400);
};
// Each toggle must NAME the key it changed, or _prefsSave cannot tell an
// explicit choice from an unset flag and will resurrect held intent over it.
check("togglePush persists on the off path, naming its key",
  /_prefsSave\("push"\)/.test(seg("togglePush")));
check("enablePush persists once the subscription lands, naming its key",
  /_prefsSave\("push"\)/.test(seg("enablePush")));
check("toggleLiveResults persists, naming its key",
  /_prefsSave\("live_results"\)/.test(seg("toggleLiveResults")));
check("toggleNotif persists on both paths, naming its key",
  (seg("toggleNotif").match(/_prefsSave\("reminders"\)/g) || []).length >= 2);
check("boot reads prefs once auth resolves", /_authReady\.then\(_prefsLoad\)/.test(html));
// The reset must sit OUTSIDE finish(): finish() waits on the profile fetch,
// and the account modal is already closed, so a toggle in that window would be
// handled with the previous account's state.
{
  const fn = html.slice(html.indexOf("function _postSignIn"), html.indexOf("function _postSignIn") + 2400);
  const reset = fn.indexOf("_prefsTouched={};_prefsPending=null;");
  const finishStart = fn.indexOf("var finish=function(){");
  check("switching identity clears touched keys and held intent",
    reset > 0);
  check("...before finish(), not inside it — the modal closes during that wait",
    reset > 0 && finishStart > 0 && reset < finishStart);
}
check("a non-2xx write is rejected, not counted as stored",
  /if\(!r\.ok\)throw new Error\("prefs save "\+r\.status\);/.test(html));
check("signing into another identity rebinds the push endpoint to it",
  /if\(changed\)_ensurePushFresh\(\);/.test(html));
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
const delSrc = html.slice(html.indexOf("function deleteAccount"), html.indexOf("function deleteAccount") + 2600);
check("a failed prefs delete is not swallowed — deletion cannot report false success",
  /if\(!r\.ok&&r\.status!==404\)throw new Error\("delete prefs "/.test(delSrc));
check("...but a 404 (table not yet migrated) still lets the account be deleted",
  /r\.status!==404/.test(delSrc));
check("the prefs delete does not re-swallow via its own .catch",
  !/user_prefs\?user_id=eq\.[^;]*\}\)\.catch\(function\(\)\{\}\)/.test(delSrc));
check("user_prefs grants the owner DELETE so that request can succeed",
  /user_prefs_delete[\s\S]{0,200}for delete to authenticated using \(auth\.uid\(\)::text = user_id\)/.test(sql) &&
  /grant select, insert, update, delete on public\.user_prefs to authenticated/.test(sql));
check("anon holds no grant on user_prefs",
  /revoke all on public\.user_prefs from anon, authenticated/.test(sql) &&
  !/grant[^\n]*to[^\n]*\banon\b/.test(sql.split("revoke all")[1] || ""));

if (failures) { console.error(`\n${failures} preference check(s) failed`); process.exit(1); }
console.log("\nNotification preference checks passed");
