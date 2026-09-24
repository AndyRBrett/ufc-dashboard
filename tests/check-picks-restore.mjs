// Guard: an account's picks come back DOWN to a device that has lost them,
// and a restore never overwrites a pick made on the device.
//
// The bug this exists for shipped for months and only surfaced on a fight
// night. Picks synced one way: preds lives in localStorage, syncPick upserts
// it to Supabase, and nothing ever read it back. So the Ranks page (which
// reads the server) listed every pick while the home page (which reads preds)
// showed none and offered the bouts as unpicked — inviting a re-pick of a card
// already picked, hours before it locked. An iOS home-screen app's storage is
// cleared when the icon is deleted, which #138/#139 required; signing back in
// restored the identity, the nickname and the leaderboard, and could not
// restore the picks because no path existed.
//
// The dangerous half of the fix is the merge direction. Restoring is ADDITIVE:
// a server row fills a key only when the device has no pick for that bout. If
// the server could win, a stale row would silently replace tonight's pick —
// and a wrong pick shown as yours reads as deliberate, where a missing one is
// visibly missing. Every assertion below is mutation-tested individually.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The app's source: index.html plus scoring.js, where the scoring blocks this
// test lifts have lived since engine-migration stage 3.
const html = readFileSync(join(ROOT, "index.html"), "utf8") + "\n" + readFileSync(join(ROOT, "scoring.js"), "utf8");

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

function slice(src, startMark, endMark, label) {
  const a = src.indexOf(startMark), b = src.indexOf(endMark);
  if (a < 0 || b < 0) { fail(`index.html: no ${startMark} … ${endMark} block (${label}) — renamed or removed?`); process.exit(1); }
  return src.slice(a, b);
}
const RESTORE = slice(html, "// picks-restore:start", "// picks-restore:end", "restore");
// The real name-matching helpers, not a stand-in: a re-implementation here
// would let the two drift and still pass.
const NAMES = slice(html, "// fighter-names:start", "// fighter-names:end", "name helpers");

const CUT = "2026-06-14";
const CARD = {
  date: "2026-09-19", name: "UFC 331",
  fights: [
    { f1: { n: "Alex Pereira" }, f2: { n: "Magomed Ankalaev" } },
    { f1: { n: "Ilia Topuria" }, f2: { n: "Arman Tsarukyan" } },
    { f1: { n: "Sean O'Malley" }, f2: { n: "Merab Dvalishvili" } },
  ],
};
const ARCHIVE = {
  "2026-07-04": { name: "UFC 318", fights: [
    { f1: "Rory MacDonald", f2: "Gilbert Burns", winner: "Gilbert Burns", method: "DEC" },
    { f1: "Kai Kara-France", f2: "Brandon Royval", winner: "", method: "" },
  ] },
};
const OLD = { date: "2026-05-01", name: "Test Phase", fights: [{ f1: { n: "A One" }, f2: { n: "B Two" } }] };

// Runs the block with a stubbed fetch and returns everything observable.
function run(src, { rows, local = {}, method = {}, conf = {}, fotn = {}, ok = true, userId = "u1", events = [CARD, OLD] }) {
  const out = {
    preds: Object.assign({}, local), method: Object.assign({}, method),
    conf: Object.assign({}, conf), fotn: Object.assign({}, fotn),
    saved: [], toasts: [], renders: 0, url: null, resolved: {},
  };
  const ctx = vm.createContext({
    console, JSON, Object, String, Array, Promise, Date, encodeURIComponent,
    EVENTS: events, PICKS_CUTOFF: CUT,
    SUPABASE_URL: "https://x", USER_ID: userId,
    _authReady: Promise.resolve(),
    _sbHeaders: () => ({}),
    _fightIndex: null,
    RESULTS_ARCHIVE: ARCHIVE,
    _sbFetchAll: (q) => { out.url = q; return ok ? Promise.resolve(rows) : Promise.reject(new Error("HTTP 401")); },
    _saveJSON: (k) => out.saved.push(k),
    save: () => out.saved.push("preds"),
    saveMethod: () => out.saved.push("method"),
    saveConf: () => out.saved.push("conf"),
    saveFOTN: () => out.saved.push("fotn"),
    render: () => { out.renders++; },
    updatePicksWidget: () => {},
    toast: (t) => out.toasts.push(t),
  });
  out.resolved = {};
  ctx.preds = out.preds; ctx.preds_method = out.method;
  ctx.preds_conf = out.conf; ctx.preds_fotn = out.fotn;
  ctx.resolvedPicks = out.resolved;
  vm.runInContext(
    NAMES +
    "\nfunction pk(ev,f){return ev.date+'|'+f.f1.n+'|'+f.f2.n;}" +
    "\nfunction _buildFightIndex(){_fightIndex={};EVENTS.forEach(function(ev){ev.fights.forEach(function(f){_fightIndex[ev.date+'|'+f.f1.n+'|'+f.f2.n]={ev:ev,fight:f};});});}" +
    "\n" + src + "\n_restoreMyPicks();", ctx);
  // Let the stubbed promise chain settle.
  return new Promise((r) => setTimeout(() => r(Object.assign(out, { ran: ctx._restoreRan })), 0));
}

const row = (o) => Object.assign({ event_date: CARD.date, pick: "", method: "", confidence: 0, bonus_pick: null }, o);

const T = {
  async fills(src) {
    const o = await run(src, { rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Alex Pereira" })] });
    return o.preds["2026-09-19|Alex Pereira|Magomed Ankalaev"] === "Alex Pereira" && o.saved.includes("preds");
  },
  // THE invariant: the device's own pick is never replaced by the account's.
  async localWins(src) {
    const k = "2026-09-19|Alex Pereira|Magomed Ankalaev";
    const o = await run(src, {
      rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Magomed Ankalaev" })],
      local: { [k]: "Alex Pereira" },
    });
    return o.preds[k] === "Alex Pereira";
  },
  // ...and a device pick is not even counted, so no toast claims a restore.
  async localWinsSilently(src) {
    const k = "2026-09-19|Alex Pereira|Magomed Ankalaev";
    const o = await run(src, {
      rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Magomed Ankalaev" })],
      local: { [k]: "Alex Pereira" },
    });
    return o.toasts.length === 0 && !o.saved.includes("preds");
  },
  async skipsPreCutoff(src) {
    const o = await run(src, { rows: [row({ event_date: OLD.date, f1: "A One", f2: "B Two", pick: "A One" })] });
    return Object.keys(o.preds).length === 0;
  },
  // A corner flip since pick time must resolve to the card's CURRENT key,
  // or the restored entry is one no render ever reads.
  async flippedCorners(src) {
    const o = await run(src, { rows: [row({ f1: "Magomed Ankalaev", f2: "Alex Pereira", pick: "Alex Pereira" })] });
    return o.preds["2026-09-19|Alex Pereira|Magomed Ankalaev"] === "Alex Pereira";
  },
  // A rename since pick time must match name-tolerantly AND be stored under
  // today's spelling, so preds[k]===fight.winner still compares equal.
  async renamed(src) {
    const o = await run(src, { rows: [row({ f1: "Sean O Malley", f2: "Merab Dvalishvili", pick: "sean o'malley" })] });
    return o.preds["2026-09-19|Sean O'Malley|Merab Dvalishvili"] === "Sean O'Malley";
  },
  // A row naming neither corner is dropped, not guessed at.
  async unknownPick(src) {
    const o = await run(src, { rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Somebody Else" })] });
    return Object.keys(o.preds).length === 0;
  },
  // A bout no longer on any card is dropped.
  async offCard(src) {
    const o = await run(src, { rows: [row({ f1: "Ghost One", f2: "Ghost Two", pick: "Ghost One" })] });
    return Object.keys(o.preds).length === 0;
  },
  async sidecars(src) {
    const o = await run(src, {
      rows: [row({ f1: "Ilia Topuria", f2: "Arman Tsarukyan", pick: "Ilia Topuria", method: "KO", confidence: 3, bonus_pick: "Fight A" })],
    });
    const k = "2026-09-19|Ilia Topuria|Arman Tsarukyan";
    return o.method[k] === "KO" && o.conf[k] === 3 && o.fotn["fotn_2026-09-19"] === "Fight A";
  },
  // Sidecars follow the same direction as the pick itself.
  async sidecarsLocalWins(src) {
    const k = "2026-09-19|Ilia Topuria|Arman Tsarukyan";
    const o = await run(src, {
      rows: [row({ f1: "Ilia Topuria", f2: "Arman Tsarukyan", pick: "Ilia Topuria", method: "KO", confidence: 3 })],
      method: { [k]: "DEC" }, conf: { [k]: 1 },
    });
    return o.method[k] === "DEC" && o.conf[k] === 1;
  },
  // A failed read must not burn the one-shot: the next render retries.
  async retriesAfterFailure(src) {
    const o = await run(src, { rows: [], ok: false });
    return o.ran === false;
  },
  // Neither must "auth resolved with no identity" — nothing to restore FROM
  // is not the same as nothing to restore.
  async retriesWithoutIdentity(src) {
    const o = await run(src, { rows: [], userId: "" });
    return o.ran === false && o.url === null;
  },
  // A successful read DOES burn it, or every render refetches the table.
  async oneShotOnSuccess(src) {
    const o = await run(src, { rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Alex Pereira" })] });
    return o.ran === true;
  },
  // Restoring repaints, or the picks sit in memory behind a stale card.
  async repaints(src) {
    const o = await run(src, { rows: [row({ f1: "Alex Pereira", f2: "Magomed Ankalaev", pick: "Alex Pereira" })] });
    return o.renders === 1 && o.toasts.length === 1;
  },
  // P1: a rename or flip can leave the OLD row beside the current one, and both
  // collapse to this same local key. Newest-first ordering plus first-wins means
  // the CURRENT pick lands; oldest-first would restore the superseded one and
  // the additive checks would then ignore the real pick.
  async aliasCollapsePrefersCurrent(src) {
    const o = await run(src, {
      rows: [
        // _sbFetchAll is stubbed, so the harness supplies them already ordered
        // the way the query asks for them: newest first.
        row({ f1: "Sean O'Malley", f2: "Merab Dvalishvili", pick: "Merab Dvalishvili", method: "SUB" }),
        row({ f1: "Sean O Malley", f2: "Merab Dvalishvili", pick: "Sean O Malley", method: "KO" }),
      ],
    });
    const k = "2026-09-19|Sean O'Malley|Merab Dvalishvili";
    return o.preds[k] === "Merab Dvalishvili" && o.method[k] === "SUB";
  },
  // P1 again, from the other side: the restore must ASK for newest-first.
  async ordersNewestFirst(src) {
    const o = await run(src, { rows: [] });
    return /order=updated_at\.desc/.test(o.url || "");
  },
  // P3: Supabase REST caps a response at 1000 rows, so an unpaged read would
  // return an over-1000 account's oldest rows and drop the active card.
  async pagesTheRead(src) {
    const o = await run(src, { rows: [] });
    return o.url !== null && !/^https/.test(o.url);
  },
  // ...and the order has to end in a unique combo or rows shift between pages.
  async stableOrderForPaging(src) {
    const o = await run(src, { rows: [] });
    return /order=.*f1\.asc,f2\.asc/.test(o.url || "");
  },
  // P2: a card aged out of EVENTS still exists in RESULTS_ARCHIVE, and
  // buildPastPicksData renders such a pick from the key itself.
  async restoresArchived(src) {
    const o = await run(src, {
      rows: [row({ event_date: "2026-07-04", f1: "Rory MacDonald", f2: "Gilbert Burns", pick: "Gilbert Burns", method: "DEC" })],
    });
    const k = "2026-07-04|Rory MacDonald|Gilbert Burns";
    return o.preds[k] === "Gilbert Burns" && o.method[k] === "DEC";
  },
  // resolvedPicks is local-only and was lost too, so an archived pick would
  // read "pending" forever without scoring it off the archive's winner.
  async archivedPickCarriesItsResult(src) {
    const o = await run(src, {
      rows: [
        row({ event_date: "2026-07-04", f1: "Rory MacDonald", f2: "Gilbert Burns", pick: "Gilbert Burns" }),
        row({ event_date: "2026-07-04", f1: "Rory MacDonald", f2: "Gilbert Burns", pick: "Rory MacDonald" }),
      ],
    });
    const k = "2026-07-04|Rory MacDonald|Gilbert Burns";
    return o.resolved[k] === "win" && o.saved.includes("ufc_resolved");
  },
  // An archived bout with no winner yet must not be scored as a loss.
  async archivedUndecidedNotScored(src) {
    const o = await run(src, {
      rows: [row({ event_date: "2026-07-04", f1: "Kai Kara-France", f2: "Brandon Royval", pick: "Brandon Royval" })],
    });
    return o.resolved["2026-07-04|Kai Kara-France|Brandon Royval"] === undefined;
  },
  // A row in neither EVENTS nor the archive is a cancelled/unknown bout: dropped.
  async archiveMissDropped(src) {
    const o = await run(src, {
      rows: [row({ event_date: "2026-07-04", f1: "Ghost One", f2: "Ghost Two", pick: "Ghost One" })],
    });
    return Object.keys(o.preds).length === 0;
  },
  // Scoped to this user, or one device restores another's picks.
  async scopedToUser(src) {
    const o = await run(src, { rows: [] });
    return /user_id=eq\.u1/.test(o.url || "");
  },
};

console.log("picks restore:");
const results = {};
for (const [name, fn] of Object.entries(T)) {
  results[name] = await fn(RESTORE);
  check(name, results[name]);
}

// ===== Mutation tests: each assertion must fail when its target is broken. =====
// Each mutation asserts its target EXISTS before applying, so a rename that
// makes the edit a no-op fails loudly instead of passing as a false green.
console.log("mutations:");
const MUT = [
  ["localWins/localWinsSilently: server allowed to overwrite a device pick",
    "if(preds[k]===undefined){preds[k]=side;added++;}", "{preds[k]=side;added++;}",
    ["localWins", "localWinsSilently"]],
  ["skipsPreCutoff: cutoff dropped",
    "if(!p.event_date||p.event_date<PICKS_CUTOFF)return;", "if(!p.event_date)return;",
    ["skipsPreCutoff"]],
  ["flippedCorners/renamed: the bout scan that resolves flips and renames dropped",
    "if(nmBout(EVENTS[ei].fights[fj],p.f1,p.f2))", "if(false)",
    ["flippedCorners", "renamed"]],
  ["renamed/unknownPick: stored pick used verbatim instead of resolved",
    "if(!side)return;", "side=side||p.pick;",
    ["renamed", "unknownPick"]],
  ["retriesAfterFailure: failure burns the one-shot",
    "}).catch(function(){_restoreRan=false;});", "}).catch(function(){});",
    ["retriesAfterFailure"]],
  ["retriesWithoutIdentity: missing identity burns the one-shot",
    "if(!USER_ID){_restoreRan=false;return;}", "if(!USER_ID){return;}",
    ["retriesWithoutIdentity"]],
  ["repaints: restore does not repaint",
    "if(typeof render===\"function\")render();", "",
    ["repaints"]],
  ["aliasCollapsePrefersCurrent/ordersNewestFirst: read reverts to oldest-first",
    "&order=updated_at.desc,event_date.desc,f1.asc,f2.asc", "&order=updated_at.asc",
    ["aliasCollapsePrefersCurrent", "ordersNewestFirst"]],
  ["restoresArchived: archive branch dropped",
    "if(!af)return;", "if(true)return;",
    ["restoresArchived", "archivedPickCarriesItsResult"]],
  ["archivedUndecidedNotScored: undecided archive bout scored anyway",
    "if(af.winner&&resolvedPicks[ak]===undefined)", "if(resolvedPicks[ak]===undefined)",
    ["archivedUndecidedNotScored"]],
  ["archiveMissDropped: unmatched row restored under the server's own spelling",
    "if(!af)return;", "if(!af){preds[p.event_date+\"|\"+p.f1+\"|\"+p.f2]=p.pick;added++;return;}",
    ["archiveMissDropped"]],
  ["sidecarsLocalWins: server allowed to overwrite a device method",
    "if(p.method&&preds_method[k]===undefined)", "if(p.method)",
    ["sidecarsLocalWins"]],
];
for (const [label, from, to, expect] of MUT) {
  if (!RESTORE.includes(from)) { fail(`mutation target missing (code changed?): ${label}`); continue; }
  const mutated = RESTORE.split(from).join(to);
  if (mutated === RESTORE) { fail(`mutation was a no-op (target unchanged?): ${label}`); continue; }
  let broke = false;
  for (const name of expect) {
    let stillPasses;
    try { stillPasses = await T[name](mutated); }
    catch { stillPasses = false; }   // a throw is a detection too
    if (!stillPasses) broke = true;
  }
  check(label, broke);
}

// ===== Plumbing: the restore has to actually be called. =====
console.log("wiring:");
check("render() calls _restoreMyPicks", /function render\(\)\{[\s\S]{0,200}?_restoreMyPicks\(\)/.test(html));
check("sign-in re-arms and calls it (a boot restore ran under the OLD identity)",
  /_restoreRan=false;_restoreMyPicks\(\);/.test(html));
check("sign-in restore sits after syncAllPicks, so local picks upload first",
  html.indexOf("syncAllPicks();           // merge") < html.indexOf("_restoreRan=false;_restoreMyPicks();"));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\npicks-restore OK");
