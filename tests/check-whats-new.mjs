// Guard: the "What's New" popup must announce every current entry to a browser
// that hasn't checkpointed one yet, never repeat an entry once dismissed, and
// never grow unbounded.
//
// Two failure modes this protects against, both silent in the browser (nothing
// throws, the popup just shows the wrong thing or nothing at all):
//
//   1. Backfill loss. A checkpoint-less browser is NOT the same as "nothing to
//      announce" — it covers both a brand-new install AND an existing user
//      whose browser predates this feature. Treating seen===null as "baseline
//      silently" would mean nobody who already had the app installed before a
//      feature shipped ever hears about it. unseenWhatsNew must return the
//      full (capped) list for seen===null, not [].
//   2. Unbounded backlog / never clears. The cap must hold regardless of list
//      size, and dismissing must checkpoint the NEWEST entry currently defined
//      (not just the newest one shown), or entries the cap pushed out of view
//      stay permanently "unseen" and reappear once older ones fall off.
//
// Also asserts WHATS_NEW's own invariants: ids ascending (sort/cap assumes
// it), ids unique (a collision would make two features look like one
// checkpoint), and every entry has the fields the renderer needs.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) {
    console.error(`  ✗ index.html: no // ${name}:start … // ${name}:end block — renamed or removed?`);
    process.exit(1);
  }
  return html.slice(a, b);
}

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

const ctx = vm.createContext({ console, String, Object, Array, JSON });
vm.runInContext(block("whats-new"), ctx);
const call = (expr) => vm.runInContext(expr, ctx);
const WHATS_NEW = call("WHATS_NEW");
const MAX = call("WHATS_NEW_MAX");

// --- WHATS_NEW's own invariants -------------------------------------------

check("WHATS_NEW is non-empty (Fight Week Intel's own entry, at minimum)",
  Array.isArray(WHATS_NEW) && WHATS_NEW.length > 0);

check("every entry has id, emoji, title and a non-trivial desc",
  WHATS_NEW.every((e) => e.id && e.emoji && e.title && e.desc && e.desc.length > 10));

check("every id matches YYYY-MM-DD-slug",
  WHATS_NEW.every((e) => /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(e.id)));

{
  const ids = WHATS_NEW.map((e) => e.id);
  check("ids are unique", new Set(ids).size === ids.length);
  const sorted = [...ids].sort();
  check("ids are stored in ascending order (sort/cap in unseenWhatsNew assumes it)",
    JSON.stringify(ids) === JSON.stringify(sorted));
}

// --- unseenWhatsNew(list, seen) --------------------------------------------

const FIX = [
  { id: "2026-01-01-a", emoji: "🅰️", title: "A", desc: "first feature ever shipped" },
  { id: "2026-02-01-b", emoji: "🅱️", title: "B", desc: "second feature ever shipped" },
  { id: "2026-03-01-c", emoji: "🌀", title: "C", desc: "third feature ever shipped" },
];
const unseen = (seen) => call(`unseenWhatsNew(${JSON.stringify(FIX)}, ${JSON.stringify(seen)})`);

check("seen===null (no checkpoint at all) returns every entry, not none — "
      + "this is the backfill case: an existing user's browser predates the feature",
  unseen(null).map((e) => e.id).join() === ["2026-03-01-c", "2026-02-01-b", "2026-01-01-a"].join());

check("checkpointed at the newest entry returns nothing",
  unseen("2026-03-01-c").length === 0);

check("checkpointed at the oldest entry returns only the newer two, newest first",
  unseen("2026-01-01-a").map((e) => e.id).join() === ["2026-03-01-c", "2026-02-01-b"].join());

check("checkpointed past everything (future id) returns nothing",
  unseen("2099-01-01-z").length === 0);

{
  const big = Array.from({ length: MAX + 4 }, (_, i) => ({
    id: `2026-01-${String(i + 1).padStart(2, "0")}-x${i}`, emoji: "x", title: "x", desc: "x feature shipped",
  }));
  const out = call(`unseenWhatsNew(${JSON.stringify(big)}, null)`);
  check(`a list longer than WHATS_NEW_MAX (${MAX}) is capped, not shown in full`,
    out.length === MAX);
  check("the cap keeps the NEWEST entries, not the oldest",
    out[0].id === big[big.length - 1].id);
}

check("an empty WHATS_NEW list never throws and returns nothing",
  call("unseenWhatsNew([], null)").length === 0);

// --- checkWhatsNew / closeWhatsNew orchestration --------------------------
//
// Neither of these is exercised by the pure-logic tests above or by the boot
// smoke test (which never has a stale checkpoint or a competing overlay open).
// A minimal fake DOM + localStorage is enough to catch the two ways this glue
// could silently regress: showing over a deep link, or never actually
// persisting the checkpoint on dismiss (which would make the popup, or the
// backfill it exists to deliver, repeat forever).

// Elements are cached by id (a real `getElementById` returns the same node
// every call) so focus-trap tests can compare identity: `active===closeBtn`
// only means anything if repeated lookups don't hand back a fresh object.
function makeRegistry(doc, openSet) {
  const registry = new Map();
  let anon = 0;
  function make(id) {
    const classes = new Set(openSet.has(id) ? ["open"] : []);
    const el = {
      id,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      textContent: "",
      appendChild() {},
      focus() { doc.activeElement = el; },
    };
    return el;
  }
  return {
    get(id) {
      if (!registry.has(id)) registry.set(id, make(id));
      return registry.get(id);
    },
    createAnon() {
      anon++;
      return make(`anon-${anon}`);
    },
  };
}

// `openIds`: which elements (by id) currently carry the "open" class — real
// overlays AND, in the regression case, non-overlay accordions like
// #activityFeed that carry both an id and a persisted "open" class without
// covering anything. `escCloserIds` models the app's real _escClosers list:
// only ids on it are actual overlays, and _anyOverlayOpen must consult only
// that list, never the DOM at large.
// wn-overlay itself is NOT on this default: it is deliberately absent from
// the real _escClosers (Escape must not dismiss the popup either — see the
// markup-level checks below), and _anyOverlayOpen never needs to see its own
// overlay's state to gate opening it in the first place.
//
// `startFocusOn`: the id (or null) of the element with focus BEFORE the
// popup is asked to open — models a keyboard/screen-reader user's actual
// position on the page, which renderWhatsNew must move away from and
// closeWhatsNew must restore.
function runUi({ openIds = [], escCloserIds = ["trashSheet"], storage = {}, startFocusOn = "page-body", stubRender = true }) {
  const rendered = [];
  const store = { ...storage };
  const openSet = new Set(openIds);
  const doc = {};
  const els = makeRegistry(doc, openSet);
  doc.getElementById = (id) => (openSet.has(id) || ["wn-list", "wn-overlay", "wn-close-btn", "wn-gotit-btn"].includes(id)
    ? els.get(id) : null);
  doc.createElement = () => els.createAnon();
  doc.documentElement = { contains: () => true };
  doc.activeElement = startFocusOn ? els.get(startFocusOn) : null;
  const uiCtx = vm.createContext({
    console, String, Object, Array, JSON,
    document: doc,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = v; },
    },
    WHATS_NEW: FIX,
    WHATS_NEW_SEEN_KEY: "ufc_whatsnew_seen",
    // The real array is [id, closerFn] pairs; only the id matters here.
    _escClosers: escCloserIds.map((id) => [id, () => {}]),
    unseenWhatsNew: (list, seen) => call(`unseenWhatsNew(${JSON.stringify(list)}, ${JSON.stringify(seen)})`),
  });
  let src = block("whats-new-ui");
  if (stubRender) {
    // renderWhatsNew is stubbed to a recorder for the checkWhatsNew-focused
    // tests below — they test the decision to call it, not the DOM/focus
    // work it does. Dropped by brace counting (nested `{}` breaks a lazy
    // regex) so the injected stub is the only definition that survives.
    uiCtx.renderWhatsNew = (items) => rendered.push(items);
    const fnStart = src.indexOf("function renderWhatsNew(items){");
    const bodyStart = src.indexOf("{", fnStart);
    let depth = 0, i = bodyStart;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    src = src.slice(0, fnStart) + src.slice(i);
  }
  vm.runInContext(src, uiCtx);
  return {
    rendered, store, doc, els,
    run: (fn, ...args) => vm.runInContext(`${fn}(${args.map(JSON.stringify).join(",")})`, uiCtx),
    dispatchTab: (opts) => {
      uiCtx.__evt = { key: "Tab", shiftKey: !!(opts && opts.shift), preventDefault() {} };
      return vm.runInContext("_wnTrapFocus(__evt)", uiCtx);
    },
  };
}

{
  // trashSheet IS on _escClosers — a real, currently-open overlay.
  const r = runUi({ openIds: ["trashSheet"] });
  r.run("checkWhatsNew");
  check("checkWhatsNew never renders while a real, known overlay is already open",
    r.rendered.length === 0);
}

{
  // Regression fixture for the Codex P2: #activityFeed carries an id and a
  // persisted "open" class (index.html restores it from localStorage on
  // EVERY boot once a user has ever expanded the feed once) but is not on
  // _escClosers — it's an inline accordion, not an overlay. A blanket
  // ".open[id]" match blocked the popup for any such user, silently and
  // permanently. It must not count.
  const r = runUi({ openIds: ["activityFeed"] });
  r.run("checkWhatsNew");
  check("checkWhatsNew ignores a non-overlay element that merely has an id "
        + "and an \"open\" class (the #activityFeed regression)",
    r.rendered.length === 1);
}

{
  // Same shape, a second non-overlay case: the per-card "N more fights" body.
  const r = runUi({ openIds: ["more3"] });
  r.run("checkWhatsNew");
  check("checkWhatsNew ignores an expanded \"more fights\" body the same way",
    r.rendered.length === 1);
}

{
  const r = runUi({ openIds: [] });
  r.run("checkWhatsNew");
  check("checkWhatsNew renders the (capped) full list for a checkpoint-less browser",
    r.rendered.length === 1 && r.rendered[0].length === FIX.length);
}

{
  const r = runUi({ openIds: [], storage: { ufc_whatsnew_seen: "2026-03-01-c" } });
  r.run("checkWhatsNew");
  check("checkWhatsNew renders nothing once fully checkpointed",
    r.rendered.length === 0);
}

{
  const r = runUi({ openIds: [] });
  r.run("closeWhatsNew");
  check("closeWhatsNew persists the NEWEST entry currently defined as the checkpoint",
    r.store.ufc_whatsnew_seen === FIX[FIX.length - 1].id);
}

// --- forced dismissal: only "Got it" / the X close it -----------------
//
// A user reported the popup closing when they tapped outside it, before
// they'd read the entry — a classic backdrop-click dismissal, and here it
// meant a shipped feature (the whole point of this popup) went unseen. Two
// separate exits had to be checked, not just the one reported: a click on
// the overlay backdrop, and the Escape key via _escClosers (which also
// drives _anyOverlayOpen — see above — so this is a markup assertion, not
// something the vm-context tests above can see).

check("#wn-overlay's opening tag carries no onclick backdrop-dismiss handler",
  /<div id="wn-overlay">/.test(html) && !/<div id="wn-overlay"[^>]*onclick/.test(html));

{
  const a = html.indexOf("var _escClosers=[");
  const b = html.indexOf("];", a);
  const closers = a >= 0 && b > a ? html.slice(a, b) : "";
  check("_escClosers block was located", closers.length > 0);
  check("wn-overlay is NOT in _escClosers, so Escape cannot dismiss it either",
    closers.length > 0 && !closers.includes('"wn-overlay"'));
}

// --- keyboard access, now that there is no other way out ------------------
//
// Codex P2 on #128: removing backdrop-click and Escape (the fix above) means
// the ONLY way out is reaching "Got it" or the X. #wn-overlay sits at the
// very end of the DOM, after every fight card's buttons, so a keyboard user
// whose focus is still on the underlying page when this auto-opens would
// have to tab through the entire app body first — effectively stranded.
// renderWhatsNew must move focus into the popup, _wnTrapFocus must keep Tab
// cycling inside it, and closeWhatsNew must give focus back.

{
  const r = runUi({ stubRender: false });
  r.run("renderWhatsNew", FIX);
  check("renderWhatsNew moves focus onto \"Got it\" — not left on the underlying page",
    r.doc.activeElement === r.els.get("wn-gotit-btn"));
}

{
  const r = runUi({ stubRender: false, startFocusOn: "page-body" });
  r.run("renderWhatsNew", FIX);
  r.run("closeWhatsNew");
  check("closeWhatsNew returns focus to wherever it was before the popup opened",
    r.doc.activeElement === r.els.get("page-body"));
}

{
  const r = runUi({ stubRender: false });
  r.run("renderWhatsNew", FIX);              // focus lands on Got-it
  r.dispatchTab();                            // Tab forward from the last control
  check("Tab from \"Got it\" (the last control) wraps to the close X, not out to the page",
    r.doc.activeElement === r.els.get("wn-close-btn"));
  r.dispatchTab({ shift: true });             // Shift+Tab back from the first control
  check("Shift+Tab from the close X (the first control) wraps back to \"Got it\"",
    r.doc.activeElement === r.els.get("wn-gotit-btn"));
}

if (failures) { console.error(`\n${failures} what's-new check(s) failed`); process.exit(1); }
console.log("\nWhat's New checks passed");
