// kick-scraper's cadence gate — the thing that decides whether the scraper runs
// at all.
//
// GitHub throttles `schedule:` to roughly one delivered run a day (measured
// 2026-09-15/16), so between cards this function IS the pipeline: when it
// declines, data.js does not move. It used to decline on every day that was not
// a fight day, which is how a cancelled Ortega/Moicano bout sat on UFC 331 with
// nobody able to notice for days.
//
// Two failure directions, both silent, so both are pinned here:
//
//   too cold  a live card misread as fight-week is thinned to hourly — results
//             during a card people are watching, an hour late.
//   too hot   an idle week misread as fight week dispatches forever.
//
// The gate is module-scoped Deno TypeScript, so it is transpiled with esbuild
// (already a dev dep, same as check:functions) and evaluated against a stubbed
// Deno global. That runs the REAL function rather than a copy of its rules — a
// copy is what drifts.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "supabase", "functions", "kick-scraper", "index.ts");

let failures = 0;
function ok(name, cond) {
  if (cond) console.log("  ✓ " + name);
  else { failures++; console.error("  ✗ " + name); }
}

const src = readFileSync(SRC, "utf8");

// Deno.serve() runs at import time; the stub makes that a no-op. Env lookups
// fall through to the defaults baked into the module.
const stub = `
globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
`;
const { code } = await transform(stub + src + "\nexport { cardStatus };", {
  loader: "ts",
  format: "esm",
});
const { cardStatus } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

// --- fixtures --------------------------------------------------------------

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const DAY = 864e5;
const today = ymd(Date.now());
const plus = (n) => ymd(Date.now() + n * DAY);

// Matches what events_js serialises closely enough for the gate's regex: an
// event header, then bouts carrying their own state.
function card(name, date, { decided = false } = {}) {
  const state = decided ? 'state:"done"' : 'state:"pre"';
  return `  {\n    name:"${name}",\n    date:"${date}",\n    venue:"Apex",\n    fights:[\n` +
    `      {lbl:"Main Event",wc:"Lightweight",${state},f1:{n:"A",r:"1-0-0"},f2:{n:"B",r:"1-0-0"}},\n` +
    `      {lbl:"Prelim",wc:"Lightweight",${state},f1:{n:"C",r:"1-0-0"},f2:{n:"D",r:"1-0-0"}}\n` +
    `    ]\n  }`;
}
const dataJs = (...cards) => `var RANKINGS={};\nvar EVENTS=[\n${cards.join(",\n")}\n];\n`;

// --- live: every ping dispatches -------------------------------------------

const liveToday = cardStatus(dataJs(card("UFC 331", today)));
ok("a card today with unfinished bouts is live", liveToday.mode === "live");

// Fight nights cross UTC midnight — a 21:00 ET main card is 01:00 UTC the next
// day, so yesterday's date is still tonight's card.
const liveYesterday = cardStatus(dataJs(card("UFC 331", ymd(Date.now() - DAY))));
ok("yesterday's card is still live (cards cross UTC midnight)",
   liveYesterday.mode === "live");

ok("a finished card today is not live",
   cardStatus(dataJs(card("UFC 331", today, { decided: true }))).mode !== "live");

// --- fight week: thinned, but never skipped --------------------------------

const week = cardStatus(dataJs(card("UFC 331", plus(4))));
ok("a card 4 days out is fight-week", week.mode === "fight-week");
ok("fight-week reports how far out it is", week.daysOut === 4);
ok("fight-week names the event", week.event === "UFC 331");

ok("a card 7 days out is still fight-week",
   cardStatus(dataJs(card("UFC 331", plus(7)))).mode === "fight-week");

// This is the regression that started all of it: a withdrawal lands on an
// ordinary weekday, and the scraper has to be running to see it.
ok("a card 3 days out dispatches rather than waiting for GitHub's cron",
   cardStatus(dataJs(card("UFC 331", plus(3)))).mode !== "idle");

// --- idle: nothing close enough --------------------------------------------

ok("a card 8 days out is idle", cardStatus(dataJs(card("UFC 332", plus(8)))).mode === "idle");
ok("an empty schedule is idle", cardStatus("var EVENTS=[\n];\n").mode === "idle");
ok("a finished card and nothing upcoming is idle",
   cardStatus(dataJs(card("UFC 330", ymd(Date.now() - 9 * DAY), { decided: true }))).mode === "idle");

// --- ordering: the nearest card decides ------------------------------------

const many = cardStatus(dataJs(
  card("UFC 333", plus(30)),
  card("UFC 331", plus(2)),
  card("UFC 332", plus(6)),
));
ok("the soonest in-range card sets the mode", many.daysOut === 2 && many.event === "UFC 331");

const liveWins = cardStatus(dataJs(card("UFC 332", plus(5)), card("UFC 331", today)));
ok("a live card outranks an upcoming one whatever the order", liveWins.mode === "live");

// --- force takes its own credential -----------------------------------------
//
// force=1 skips every gate above, so it is the one input that turns a leaked
// credential into unlimited workflow runs. CRON_SECRET is the credential that
// leaks (the platform logs whole request URLs), so force must not accept it in
// ANY form — a header carrying the leaked value is the same secret, just moved.
ok("force=1 checks FORCE_SECRET, not CRON_SECRET",
   /if\s*\(force\)\s*\{[\s\S]{0,200}secretEquals\(bearer,\s*FORCE_SECRET\)/.test(src));
ok("force is refused when FORCE_SECRET is unset", /!FORCE_SECRET\s*\|\|/.test(src));
ok("CRON_SECRET is never consulted on the force path",
   !/force[\s\S]{0,120}secretEquals\([^)]*CRON_SECRET/.test(src));

// --- the cadence lookup must not fail silently -------------------------------
//
// A revoked GH_DISPATCH_TOKEN makes minutesSinceLastRun() null on every ping.
// Declining on that would return 200, which scheduled-push.yml and the cron both
// read as healthy — the scraper stops for fight week with every monitor green.
// Dispatching anyway routes a dead credential into the 502 path, which alarms.
const unknownBranch = src.slice(
  src.indexOf("if (since === null)"),
  src.indexOf("} else if (since <"),
);
ok("the unknown-run branch exists at all", unknownBranch.length > 0 && unknownBranch.length < 2000);
ok("an unreadable run history dispatches rather than returning early",
   !/\breturn\b/.test(unknownBranch));
ok("...and says so in the function logs", /console\.error/.test(unknownBranch));
ok("only a known-too-recent run declines",
   /reason:\s*"fight-week cadence: too soon"/.test(src) &&
   !/last run unknown/.test(src));

console.log(failures ? `\nkick-scraper gate: ${failures} failure(s)` : "\nkick-scraper gate checks passed");
process.exit(failures ? 1 : 0);
