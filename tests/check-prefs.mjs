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
import http from "node:http";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { createRequire } from "node:module";
import { launchChromium } from "./lib/browser.mjs";

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
  const calls = { ensureFresh: 0, bell: [], liveRes: [], toasts: [], restore: 0, schedule: 0, saved: [], liveSync: 0 };
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
    _syncLivePref: () => { calls.liveSync++; },
    _setBellActive: (v) => calls.bell.push(v),
    _setLiveResActive: (v) => calls.liveRes.push(v),
    checkNotifSchedule: () => { calls.schedule++; },
    toast: (m) => calls.toasts.push(m),
    _pushRestoreShow: () => { calls.restore++; },
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
    load: (r, st, allowSeed) => {
      rows = r; status = st === undefined ? 200 : st;
      return vm.runInContext("_prefsLoad(" + (allowSeed === undefined ? "true" : allowSeed) + ")", ctx);
    },
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
  check("permission 'default': the remembered push intent surfaces as the banner, not a toast",
    calls.restore === 1 && calls.toasts.length === 0);
  check("permission 'default': live_results still restores (no OS permission needed)",
    store.ufc_live_results === "1" && calls.liveRes.includes(true));
}
{
  const { store, calls } = run(ALL_ON, "denied");
  check("permission 'denied' is treated exactly like 'default'",
    store.ufc_push !== "1" && calls.ensureFresh === 0 && calls.restore === 1);
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
    calls.toasts.length === 0 && calls.restore === 0);
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
    h.calls.toasts.length === 0 && h.calls.restore === 0);
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

// --- Codex #140 round 8 P1: never seed a switched-into account from the old one ---
{
  // Sign in A -> B, and B has no row (expected for accounts predating 0004).
  // The local flags still hold A's settings — _postSignIn clears touched keys
  // and held intent but cannot clear those, they describe a live subscription
  // on this device. Seeding here would copy A's preferences into B for good,
  // and on to B's other installs.
  const h = run(null, "granted");
  h.set("ufc_push", "1");
  h.set("ufc_notif", "1");
  await h.load([], 200, false);       // identity just switched
  await h.flush();
  check("after an identity switch, an empty row is NOT seeded from local flags",
    h.calls.saved.length === 0);
}
{
  const h = run(null, "granted");
  h.set("ufc_push", "1");
  await h.load([], 200, true);        // ordinary boot, same identity
  await h.flush();
  check("...while an ordinary load still seeds a legacy account",
    h.calls.saved.length === 1);
}

// --- Codex #140 round 7 P2: a restored spoiler preference must reach push_subs ---
{
  // send-push reads push_subs.live_results to decide whether a result alert
  // names the winner. Restoring the flag locally without re-registering shows
  // "on" while alerts stay spoiler-free. push:false here, so the push branch
  // cannot cover it.
  const h = run({ push: false, live_results: true, reminders: false }, "granted");
  check("restoring live_results re-registers the subscription",
    h.calls.liveSync === 1);
  check("...and shows it on locally", h.store.ufc_live_results === "1");
}
{
  const h = run({ push: false, live_results: true, reminders: false }, "default");
  check("...even with OS permission withheld (it is not a push-gated setting)",
    h.calls.liveSync === 1);
}
{
  const h = run({ push: true, live_results: false, reminders: false }, "granted");
  check("a row with live_results off does not re-register for it",
    h.calls.liveSync === 0);
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
check("boot reads prefs once auth resolves, and may seed",
  /_authReady\.then\(function\(\)\{_prefsLoad\(true\);\}\)/.test(html));
check("an in-app sign-in that CHANGED identity passes allowSeed=false",
  /_prefsLoad\(!changed\)/.test(html));
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
  /_prefsLoad\(!changed\);\s*\/\/ \.\.\.and restore/.test(html));
check("the upsert is keyed on user_id, so a second device updates rather than duplicates",
  /user_prefs\?on_conflict=user_id/.test(html) && /resolution=merge-duplicates/.test(html));

// --- the migration exists and is owner-only ---
const sql = readFileSync(join(ROOT, "supabase/migrations/0004_user_prefs.sql"), "utf8");
check("user_prefs has RLS enabled", /alter table public\.user_prefs enable row level security/.test(sql));
check("user_prefs select is owner-only — prefs are nobody else's business",
  /user_prefs_select[\s\S]{0,200}auth\.uid\(\)::text = user_id/.test(sql));
// "Delete forever" is one RPC (0014's delete_my_account), which must clear
// prefs; the app reports success only when it succeeds (check:delete).
check("\"Delete forever\" removes the prefs row — the dialog promises exactly that",
  /'user_prefs:user_id'/.test(readFileSync(join(ROOT, "supabase/migrations/0014_delete_account.sql"), "utf8")) &&
  /rpc\/delete_my_account"[\s\S]{0,200}if\(!r\.ok\)throw new Error\("delete account "/.test(html));
check("user_prefs grants the owner DELETE so that request can succeed",
  /user_prefs_delete[\s\S]{0,200}for delete to authenticated using \(auth\.uid\(\)::text = user_id\)/.test(sql) &&
  /grant select, insert, update, delete on public\.user_prefs to authenticated/.test(sql));
check("anon holds no grant on user_prefs",
  /revoke all on public\.user_prefs from anon, authenticated/.test(sql) &&
  !/grant[^\n]*to[^\n]*\banon\b/.test(sql.split("revoke all")[1] || ""));

// --- One switch per kind of push (⋯ More → Notifications, 0019) --------------
// Run in the real page: the sheet lists every kind, a switch writes ONLY
// notif_off to the account (never push/live_results/reminders, whose restore
// rules are above), the account's choice comes down on load, and a switch
// flipped here is not overwritten by a slower read.
{
  const require = createRequire(import.meta.url);
  let chromium = null;
  try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch {} }
  if (!chromium) fail("Playwright not installed (npm install)");
  else {
    const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, r));
    const browser = await launchChromium(chromium);
    try {
      const page = await browser.newPage();
      const errors = [], writes = [];
      let serverOff = ["nudge"], noRow = false, rpcReply = null;
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => {
        try {
          localStorage.setItem("ufc_sb_session", JSON.stringify({ access_token: "tok", refresh_token: "r", user_id: "u-andy", email: "a@example.com", expires_at: 9999999999 }));
          localStorage.setItem("ufc_name", "Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999");
          localStorage.setItem("ufc_terms", JSON.stringify({ v: "x", at: "" }));
        } catch (e) {}
      });
      await page.route(/supabase\.co/, (route) => {
        const req = route.request(), url = decodeURIComponent(req.url()), m = req.method();
        if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") writes.push({ m, url, body: req.postData() });
        let body = "[]";
        if (/\/rest\/v1\/user_prefs\?select=notif_off/.test(url) && m === "GET") body = noRow ? "[]" : JSON.stringify([{ notif_off: serverOff }]);
        if (/\/rest\/v1\/rpc\/set_notif_kind/.test(url)) { route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rpcReply) }); return; }
        route.fulfill({ status: m === "POST" ? 201 : 200, contentType: "application/json", body: m === "POST" ? "" : body });
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load", timeout: 20000 });
      await page.waitForFunction(() => { try { return JSON.parse(localStorage.getItem("ufc_notif_off") || "[]").includes("nudge"); } catch (e) { return false; } }, null, { timeout: 8000 }).catch(() => {});
      check("notif kinds: the account's switches come down on load", await page.evaluate(() => !window._notifOn("nudge") && window._notifOn("roast")));
      await page.evaluate(() => window.openNotifSheet());
      const sheet = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("#notifList .notif-row")].map((r) => r.querySelector(".notif-t").textContent + "=" + r.getAttribute("aria-checked")),
        roles: [...document.querySelectorAll("#notifList .notif-row")].every((r) => r.getAttribute("role") === "switch" && r.tagName === "BUTTON"),
      }));
      check("notif kinds: the sheet has the push switch, one switch per kind and Result Spoilers, as accessible switches",
        sheet.roles && sheet.rows.length === 10 && /^Push notifications=/.test(sheet.rows[0]) && sheet.rows.includes("Nudges=false") &&
        sheet.rows.includes("Trash talk=true") && sheet.rows.some((r) => /^Result Spoilers=/.test(r)));
      writes.length = 0;
      rpcReply = ["nudge", "brief", "roast"];   // another phone switched the brief off meanwhile
      await page.click('#notifList .notif-row:has(.notif-t:text-is("Trash talk"))');
      check("notif kinds: the sheet shows the switch off at once",
        await page.evaluate(() => !window._notifOn("roast")));
      await page.waitForTimeout(400);
      const w = writes.filter((x) => /\/rest\/v1\/(user_prefs|rpc\/set_notif_kind)/.test(x.url)).map((x) => ({ url: x.url, b: JSON.parse(x.body) }));
      check("notif kinds: a switch changes only its own kind on the server (never the whole list, never push/live_results/reminders)",
        w.length === 1 && /rpc\/set_notif_kind/.test(w[0].url) && JSON.stringify(w[0].b) === JSON.stringify({ kind: "roast", enabled: false }));
      check("notif kinds: ...and adopts the account's merged list it returns (another phone's change included)",
        await page.evaluate(() => !window._notifOn("brief") && !window._notifOn("roast") && !window._notifOn("nudge")));
      serverOff = [];
      await page.evaluate(() => window._notifOffLoad());
      await page.waitForTimeout(200);
      check("notif kinds: a slower read of the old value doesn't undo a switch flipped here", await page.evaluate(() => !window._notifOn("roast")));
      // A different account signing in on this phone never inherits these.
      noRow = true;
      await page.evaluate(() => { window.USER_ID = "u-bob"; window._postSignIn("u-andy", "bob@example.com"); });
      await page.waitForTimeout(600);
      check("notif kinds: a different account (with no saved switches) starts all on, not with the last account's",
        await page.evaluate(() => ["nudge", "brief", "roast", "start", "result"].every((k) => window._notifOn(k))));
      check("notif kinds: a card-start reminder re-checks the switch when it fires, not only when scheduled",
        (html.match(/setTimeout\(function\(\)\{if\(_notifOn\("start"\)\)fireNotif\(/g) || []).length === 2);
      await page.keyboard.press("Escape");
      check("notif kinds: Escape closes the sheet", await page.evaluate(() => !document.getElementById("notifBg").classList.contains("open")));
      // The "turn notifications back on" banner: a reinstall can't restore
      // push by itself (no OS permission), so it asks, and keeps asking until
      // answered. It used to be a toast that vanished in seconds behind the
      // sign-in toast.
      const shown = () => page.evaluate(() => document.getElementById("pushRestore").classList.contains("show"));
      await page.evaluate(() => { Notification.requestPermission = () => Promise.resolve("denied"); window._prefsApply({ push: true }); });
      check("restore banner: a saved push=on without permission shows the banner", await shown());
      await page.waitForTimeout(4000);
      check("restore banner: it stays up (it is not a toast)", await shown());
      await page.click("#pushRestore .push-restore-x");
      check("restore banner: × hides it", !(await shown()));
      await page.evaluate(() => window._prefsApply({ push: true }));
      check("restore banner: once closed, it doesn't come back for that account", !(await shown()));
      await page.evaluate(() => { window.USER_ID = "u-carl"; window._prefsApply({ push: true }); });
      check("restore banner: ...but a different account still gets asked", await shown());
      await page.click("#pushRestore .push-restore-on");
      check("restore banner: Turn on hides it and asks for permission", !(await shown()));
      await page.evaluate(() => window._prefsApply({ push: false, reminders: false }));
      check("restore banner: nothing saved on, no banner", !(await shown()));
      check("notif kinds: no page errors", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
    } finally { await browser.close(); server.close(); }
  }
}

// --- set_notif_kind (0019): one kind at a time, merged on the server ----------
{
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
  `);
  for (const m of ["0004_user_prefs.sql", "0019_notif_categories.sql"]) await db.exec(readFileSync(join(ROOT, "supabase/migrations", m), "utf8"));
  const as = async (role, uid, sql, params) => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid || ""}', false); set role ${role};`);
    try { return (await db.query(sql, params)).rows; } finally { await db.exec("reset role;"); }
  };
  const set = (uid, k, on) => as("authenticated", uid, "select public.set_notif_kind($1, $2) r", [k, on]).then((r) => r[0].r);
  const refused = async (p) => { try { await p; return false; } catch { return true; } };
  check("set_notif_kind: the first switch makes the row", JSON.stringify(await set(A, "roast", false)) === '["roast"]');
  check("set_notif_kind: a second phone's switch adds to it instead of replacing it", JSON.stringify(await set(A, "nudge", false)) === '["roast","nudge"]');
  check("set_notif_kind: switching one back on removes only that one", JSON.stringify(await set(A, "roast", true)) === '["nudge"]');
  check("set_notif_kind: switching off twice lists it once", JSON.stringify(await set(A, "nudge", false)) === '["nudge"]');
  await set(B, "brief", false);
  check("set_notif_kind: one account never touches another's row",
    JSON.stringify((await db.query(`select user_id, notif_off from user_prefs order by user_id`)).rows.map((r) => r.notif_off)) === '[["nudge"],["brief"]]');
  check("set_notif_kind: only the push columns' defaults on a new row (push, reminders stay off)",
    (await db.query(`select push, reminders from user_prefs where user_id = $1`, [B])).rows[0].push === false);
  check("set_notif_kind: a malformed kind is refused", await refused(set(A, "Roast; drop", false)));
  check("set_notif_kind: the anon key can't call it", await refused(as("anon", "", "select public.set_notif_kind('roast', false)")));
}

if (failures) { console.error(`\n${failures} preference check(s) failed`); process.exit(1); }
console.log("\nNotification preference checks passed");
