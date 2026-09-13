// Guard: Fight Week Intel must never attribute a link to the wrong card.
//
// The section is built by string-matching feed headlines against fighter names
// (intel.py). That is the right trade — it is free, where an LLM pass is not —
// but it means the failure mode is mis-attribution, and mis-attribution here is
// not cosmetic: an interview about a different Silva rendered under tonight's
// main event is the app confidently telling you something false about a fight
// you are about to bet picks on.
//
// So intel.json is treated as untrusted input by the app. intelItemsFor()
// re-validates every item against the card actually being rendered, and this
// test holds that contract:
//
//   1. An item tagged with a fighter who is NOT on the card is dropped, even
//      though intel.py put it in that event's bucket.
//   2. A bucket whose date doesn't match the event is dropped whole — slugs get
//      reused ("UFC_Fight_Night_292"), and a stale bucket would otherwise show
//      last month's intel under a new card.
//   3. Only absolute https:// links render. A relative path, javascript:, or a
//      data: URL never becomes an href.
//   4. Renamed fighters still match (nmEq), so a mid-card rename doesn't blank
//      the section the way it once un-scored picks.
//   5. The committed intel.json is cross-checked against the committed data.js
//      — but ADVISORY ONLY. See the note above that block for why it must never
//      fail the build.
import { readFileSync, existsSync } from "node:fs";
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

const ctx = vm.createContext({ console, String, Object, Array, JSON, fetch: () => {}, Promise });
vm.runInContext(block("fighter-names"), ctx);
vm.runInContext(block("fight-week-intel"), ctx);
const call = (expr) => vm.runInContext(expr, ctx);

// A card with two fighters. Anything else tagged on an item is not on it.
const EV = {
  date: "2026-09-19", slug: "UFC_Test",
  fights: [
    { lbl: "Main Event", f1: { n: "Anthony Hernandez" }, f2: { n: "Gregory Rodrigues" } },
    { lbl: "Prelim",     f1: { n: "Sean King III" },     f2: { n: "Jessie Rosas" } },
  ],
};
const item = (over) => Object.assign({
  title: "Fight week interview", url: "https://example.com/a", source: "MMA Junkie",
  kind: "article", published: null, thumb: null, blurb: "words",
  fighters: ["Anthony Hernandez"],
}, over);
const run = (bucketItems, bucketOver) => {
  ctx.__intel = { events: { UFC_Test: Object.assign(
    { name: "T", date: "2026-09-19", items: bucketItems }, bucketOver || {}) } };
  ctx.__ev = EV;
  return call("intelItemsFor(__intel,__ev).map(function(i){return i.url;})");
};

// 1. Off-card fighter tags.
check("an item tagged with a fighter on the card is kept",
  run([item({ url: "https://example.com/keep" })]).join() === "https://example.com/keep");
check("an item tagged with a fighter NOT on the card is dropped",
  run([item({ fighters: ["Islam Makhachev"] })]).length === 0);
check("a mixed tag list (one on-card, one off-card) is dropped, not partially trusted",
  run([item({ fighters: ["Anthony Hernandez", "Islam Makhachev"] })]).length === 0);
check("an item with no fighter tags at all is dropped",
  run([item({ fighters: [] })]).length === 0);

// 2. Stale bucket under a reused slug.
check("a bucket whose date doesn't match the event is dropped whole",
  run([item()], { date: "2026-08-15" }).length === 0);
check("a bucket with no date at all still renders (older file format)",
  run([item()], { date: undefined }).length === 1);
check("an event with no bucket yields nothing rather than throwing",
  call(`intelItemsFor({events:{}},__ev).length`) === 0);
check("a missing/failed intel.json yields nothing rather than throwing",
  call(`intelItemsFor(null,__ev).length`) === 0);

// 3. Only absolute https links leave the app.
for (const bad of ["http://example.com/a", "/local/path", "javascript:alert(1)",
                   "data:text/html,<b>x</b>", "//example.com/a", ""]) {
  check(`a ${JSON.stringify(bad)} link never renders`,
    run([item({ url: bad })]).length === 0);
}
check("an https link renders", run([item({ url: "https://x.test/y" })]).length === 1);

// 4. A renamed fighter still resolves (same nmEq path that protects picks).
check("a fighter tagged under a generational-suffix variant still matches",
  run([item({ fighters: ["Sean King"] })]).length === 1);
check("accents and punctuation fold away",
  run([item({ fighters: ["Jessié  Rosas" ] })]).length === 1);
check("a different fighter is still kept apart",
  run([item({ fighters: ["Sean Strickland"] })]).length === 0);

// 5. The committed intel.json (when there is one) must satisfy the same contract
//    against the committed data.js — a curator change that starts emitting
//    off-card tags fails here rather than in front of users.
const intelPath = join(ROOT, "intel.json");
// Advisory cross-check — reports drift, never fails.
//
// This block MUST NOT call fail(). check:intel runs in validate-web.yml, and
// pages.yml's deploy `needs: validate` — so a failure here stops the site from
// deploying, live fight results included.
//
// Drift between these two files is normal and self-healing, not a defect. The
// curator is cadence-gated while scrape.py rewrites data.js every five minutes,
// so any late replacement, withdrawal or date move leaves intel.json describing
// the previous roster until the next curator run (which the roster fingerprint
// in intel-state.json now triggers immediately). Failing on that would block the
// deploy for a data gap — exactly what CLAUDE.md forbids: "a blocked commit
// during a card also blocks the live results everyone is watching."
//
// Nothing is lost by making it advisory, because the app does not trust this
// file either: intelItemsFor() drops the same stale items at render time, and
// the fixture assertions above prove it — deterministically, on synthetic input
// that cannot drift. Those are the contract. This is a report.
if (!existsSync(intelPath)) {
  console.log("  · no intel.json committed yet — nothing to cross-check");
} else {
  let note = (m) => console.log("  · " + m);
  try {
    const intel = JSON.parse(readFileSync(intelPath, "utf8"));
    const dctx = vm.createContext({});
    vm.runInContext(readFileSync(join(ROOT, "data.js"), "utf8"), dctx);
    const events = vm.runInContext("EVENTS", dctx);
    let checked = 0, dropped = 0, total = 0;
    for (const ev of events) {
      const key = ev.slug || ev.date;
      const bucket = intel.events && intel.events[key];
      if (!bucket) continue;
      checked++;
      total += (bucket.items || []).length;
      ctx.__intel = intel; ctx.__ev = ev;
      dropped += (bucket.items || []).length - call("intelItemsFor(__intel,__ev).length");
    }
    const orphans = Object.keys(intel.events || {})
      .filter((k) => !events.some((e) => (e.slug || e.date) === k));
    note(`intel.json vs data.js: ${checked} event(s), ${total} item(s), `
         + `${dropped} would be dropped at render, ${orphans.length} orphan bucket(s)`);
    if (dropped || orphans.length) {
      note("the card moved since the last curator run — the app drops these on its own, "
           + "and the next intel.py run rebuilds them (advisory, not a failure)");
    }
  } catch (e) {
    note(`intel.json could not be cross-checked (${e.message}) — advisory, not a failure`);
  }
}

// The intel section's cutoff must match render()'s event-visibility window.
//
// Event dates are UTC midnight and US prime-time cards run past it: a Saturday
// 21:00 ET main card is 01:00 UTC Sunday. A one-day bound here hid the section
// at the exact moment the main card started, while render() kept the event block
// on screen for another day — the card visible, its intel gone. The two bounds
// are one decision and must move together.
{
  const evFilter = /EVENTS\.filter\(function\(e\)\{return new Date\(e\.date\)>=now-(\d*)\*?DAY_MS/.exec(html);
  const intelCut = /new Date\(evRef\.date\)\.getTime\(\)<Date\.now\(\)-(\d*)\*?DAY_MS/.exec(html);
  const days = (m) => m ? (m[1] === "" ? 1 : Number(m[1])) : null;
  check(`the intel cutoff matches render()'s event window `
        + `(render ${days(evFilter)}d vs intel ${days(intelCut)}d)`,
    evFilter !== null && intelCut !== null && days(evFilter) === days(intelCut));
}

// The advisory block must stay advisory. It sits in the deploy gate, so a fail()
// added there would let a routine card change stop the site from publishing —
// the regression this file exists to prevent a second time. Asserted against its
// own source, because the property is "this code never calls fail()", and the
// only way to observe that from inside a run where it happens not to fire is to
// read it.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const a = self.indexOf("// Advisory cross-check");
  const b = self.indexOf("// The advisory block must stay advisory");
  // Comments in that block mention fail() by name, so strip them before looking.
  const region = self.slice(a, b).replace(/^\s*\/\/.*$/gm, "");
  check("the intel.json cross-check cannot fail the build (no fail() in the advisory block)",
    a > 0 && b > a && !/\bfail\s*\(/.test(region));
}

if (failures) { console.error(`\n${failures} intel check(s) failed`); process.exit(1); }
console.log("\nFight Week Intel checks passed");
