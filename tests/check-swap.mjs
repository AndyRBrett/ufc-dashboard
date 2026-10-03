// Guard: when a bout vanishes from a card, the people who picked it hear about
// it once, and nobody else does.
//
// Picks are stored by fighter name, so a withdrawal leaves the old pick matching
// nothing: it silently never scores. send-reminders now finds those picks and
// sends one targeted push per vanished bout. Every way that goes wrong is quiet
// or loud in the worst way: a rename announced as a replacement, a bad parse
// that "replaces" half the card, a push with no targets (send-push broadcasts an
// untargeted push to EVERYONE), or an alert after the new bout has locked.
//
// This transpiles the REAL send-reminders function and runs its handler under a
// fake clock against the committed data.js and scoring.js, recording what it
// hands to send-push.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// The live data files (data.js, odds-series.json, intel.json) are rewritten
// by the scraper every few minutes, so a test anchored on them rots: once the
// anchor card's results landed, the Lab skipped its finished bouts, the brief
// lost its 📉 line, and this gate blocked every Pages deploy from 03:15 UTC on
// 2026-09-27 — the live site froze mid-card while the repo kept updating. The
// card would also have aged out of EVENTS eventually and failed it again.
// So they are served from a frozen fight-week snapshot: the 2026-09-26 card as
// it stood before its first bell. Code files are still read live from the repo.
const FIX = join(ROOT, "tests/fixtures/fight-week");
const DATA_FILES = new Set(["data.js", "odds-series.json", "intel.json"]);
const served = (f) => join(DATA_FILES.has(f) ? FIX : ROOT, f);
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const PAGES = "https://andyrbrett.github.io/ufc-dashboard/";
const SB = "https://sb.test";
const ENV = { CRON_SECRET: "s3cret", SUPABASE_URL: SB, SB_ANON_KEY: "anon" };

const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
let pagesFetched = [], pushes = [], missing = new Set(), picksRows = [], picksUrls = [];
const PAGE_CAP = 1000;
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith(PAGES)) {
    const f = url.slice(PAGES.length).split("?")[0];
    pagesFetched.push(f);
    if (missing.has(f) || !existsSync(served(f))) return new Response("nope", { status: 404 });
    return new Response(readFileSync(served(f), "utf8"), { status: 200 });
  }
  if (url.startsWith(SB + "/rest/v1/picks")) {
    picksUrls.push(url);
    // PostgREST's cap, scaled down: at most PAGE_CAP rows per response, windowed by Range.
    const m = /^(\d+)-(\d+)$/.exec((init && init.headers && init.headers.Range) || "");
    const from = m ? +m[1] : 0, to = m ? Math.min(+m[2], from + PAGE_CAP - 1) : PAGE_CAP - 1;
    return new Response(JSON.stringify(picksRows.slice(from, to + 1)), { status: 200 });
  }
  if (url === SB + "/functions/v1/send-push") {
    pushes.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ sent: 1 }), { status: 200 });
  }
  return new Response("unexpected " + url, { status: 500 });
};

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const src = readFileSync(join(ROOT, "supabase/functions/send-reminders/index.ts"), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
// A data: URL has no base to resolve ../_shared/ against, so point those imports at the files.
const linked = code.replace(/from "\.\.\/_shared\/([\w-]+\.js)"/g,
  (_m, f) => `from "${pathToFileURL(join(ROOT, "supabase/functions/_shared", f)).href}"`);
check("send-reminders imports the bundled Lab code (nothing to fetch and run)", /_shared\/lab-bundle\.js/.test(src) && linked !== code);
const mod = await import("data:text/javascript;base64," + Buffer.from(linked).toString("base64"));
check("send-reminders exports the swap finder", typeof handler === "function" && typeof mod.findSwaps === "function");

async function runAt(iso) {
  NOW = RealDate.parse(iso);
  globalThis.Date = FakeDate;
  pushes = []; picksUrls = [];
  try {
    const res = await handler(new Request("https://fn/send-reminders", { method: "POST", headers: { Authorization: "Bearer s3cret" } }));
    return { status: res.status, json: await res.json(), swaps: pushes.filter((p) => /^swap-/.test(p.type)) };
  } finally { globalThis.Date = RealDate; }
}

// Anchored on the committed Saturday 2026-09-26 card: prelims 17:00 ET, main 20:00 ET.
const CARD = "2026-09-26";
const dctx = vm.createContext({}); vm.runInContext(readFileSync(served("data.js"), "utf8"), dctx);
const ev = dctx.EVENTS.find((e) => e.date === CARD);
if (!ev || ev.fights.length < 6) { console.error("  ✗ fixture: data.js no longer carries the 2026-09-26 card — re-anchor this test"); process.exit(1); }
const main = ev.fights.find((f) => f.lbl === "Main Card");
const prelim = ev.fights.find((f) => f.lbl === "Prelim");
const row = (u, a, b) => ({ user_id: u, event_date: CARD, f1: a, f2: b });
const onCard = ev.fights.map((f, i) => row("u" + i, f.f1.n, f.f2.n));

// 1. A replaced opponent: the real case. "Mickey Gall" came off, main.f1 took his place.
const stays = main.f2.n, newcomer = main.f1.n;
picksRows = [...onCard,
  row("uT", "Mickey Gall", stays),                       // picked the old bout
  row("uAB", "Mickey Gall", stays), row("uAB", newcomer, stays), // …and already re-picked
];
let r = await runAt("2026-09-25T20:00:00Z");
check("the handler still answers 200", r.status === 200);
check("one push for the vanished bout", r.swaps.length === 1);
const s = r.swaps[0] || {};
check("it goes only to who picked the old bout and hasn't re-picked", JSON.stringify(s.include_user_ids) === JSON.stringify(["uT"]));
check("keyed to the card date as swap-<old bout> (notif_log sends it once)", s.event_date === CARD && /^swap-[\w-]+$/.test(s.type || "") && /gall/.test(s.type));
check("it says who is out and who now faces whom", /Mickey Gall is out/.test(s.title || "") && (s.body || "").includes(`${newcomer} now faces ${stays}`));
check("it opens the app", s.url === "./");
check("the picks read is UFC-scoped", picksUrls.length > 0 && picksUrls.every((u) => u.includes("promotion=eq.ufc")));
const push = readFileSync(join(ROOT, "supabase/functions/send-push/index.ts"), "utf8");
const TYPE_RE = new RegExp(/const TYPE_RE = \/(.+)\/;/.exec(push)[1]);
check("send-push accepts the swap type it is given", TYPE_RE.test(s.type || "") && !TYPE_RE.test("swap-") && !TYPE_RE.test("swap-a b"));
check("copy fits send-push's limits", (s.title || "").length <= 120 && (s.body || "").length > 0 && s.body.length <= 1600);

// 2. Timing: a main-card replacement is still worth sending after the prelims start,
//    never after its own segment locks.
r = await runAt("2026-09-26T23:00:00Z");
check("a main-card swap still sends at 7pm ET, prelims underway", r.swaps.length === 1);
{
  // One fight at a time: this main-card bout is not the main card's opener, so
  // it stays pickable after the main card's bell (Codex on #263: the card was
  // dropped from the watch at that bell, so a replacement then told nobody).
  const { bundledKernel } = await import(pathToFileURL(join(ROOT, "supabase/functions/_shared/lab-bundle.js")).href);
  const bell = Date.parse("2026-09-27T00:05:00Z");
  const key = [main.f1.n, main.f2.n].map((n) => n.trim().toLowerCase()).sort();
  const lockAt = Date.parse(mod.lockRows([ev], bundledKernel({}), bell).bouts.find((b) => b.a === key[0] && b.b === key[1]).lock_at);
  check("the fixture's main-card bout locks after the main card's bell", lockAt > bell);
  r = await runAt("2026-09-27T00:05:00Z");
  check("a main-card swap still sends after the main card's bell, while its bout is open", r.swaps.length === 1);
  r = await runAt(new Date(lockAt + 60e3).toISOString());
  check("nothing once the new bout has locked", r.swaps.length === 0);
}
// A bout locks one fight at a time (lockRows): this prelim, last of its segment
// in the running order, is still pickable after the prelims' bell and goes out
// until its own lock, never after.
picksRows = [...onCard, row("uX", "Mickey Gall", prelim.f2.n)];
{
  const { bundledKernel } = await import(pathToFileURL(join(ROOT, "supabase/functions/_shared/lab-bundle.js")).href);
  const bell = Date.parse("2026-09-26T21:05:00Z");
  const key = [prelim.f1.n, prelim.f2.n].map((n) => n.trim().toLowerCase()).sort();
  const lockAt = Date.parse(mod.lockRows([ev], bundledKernel({}), bell).bouts.find((b) => b.a === key[0] && b.b === key[1]).lock_at);
  check("the fixture's prelim is not its segment's opener (it locks after the bell)", lockAt > bell);
  r = await runAt(new Date(lockAt - 5 * 60e3).toISOString());
  check("a prelim swap still sends after the prelims' bell, before its own bout locks", r.swaps.length === 1);
  r = await runAt(new Date(lockAt + 60e3).toISOString());
  check("…and stops once its bout locks", r.swaps.length === 0);
}

// 3. A rename is not a replacement.
picksRows = [...onCard,
  row("uR", ev.fights[0].f1.n.replace(/ Jr\.?$/, ""), ev.fights[0].f2.n), // suffix fold
  row("uR", ev.fights[0].f2.n.toUpperCase(), ev.fights[0].f1.n),         // case + corner swap
  row("uR", main.f1.n.split(" ")[0] + " Middle " + main.f1.n.split(" ").slice(1).join(" "), main.f2.n), // a dropped middle name
];
r = await runAt("2026-09-25T20:00:00Z");
check("renames and corner swaps send nothing", r.swaps.length === 0);
// …but one shared token is a different fighter: "John Smith" → "John Doe".
picksRows = [...onCard, row("uS", main.f1.n.split(" ")[0] + " Zzzyx", main.f2.n)];
r = await runAt("2026-09-25T20:00:00Z");
check("a replacement sharing only a first name is still announced", r.swaps.length === 1 && /Zzzyx is out/.test(r.swaps[0].title));
check("looksLikeRename: a dropped trailing name part", mod.looksLikeRename((x) => x.toLowerCase(), "Ilimbek Akylbek uulu", "Ilimbek Akylbek") === true);
check("looksLikeRename: respelled first name, same surname and initial", mod.looksLikeRename((x) => x.toLowerCase(), "Mahammadali Osmanli", "Mehemmedeli Osmanli") === true);
check("looksLikeRename: same surname, different first name is not a rename", mod.looksLikeRename((x) => x.toLowerCase(), "Jose Silva", "Thiago Silva") === false);
// Spelling variants must not even count as vanished: four of them would trip the
// bad-parse cap and hide a real replacement on the same card.
picksRows = [...onCard, ...ev.fights.slice(0, 4).map((f) => row("uV", f.f2.n.toUpperCase(), f.f1.n.toLowerCase())), row("uT", "Mickey Gall", stays)];
r = await runAt("2026-09-25T20:00:00Z");
check("spelling variants don't crowd out a real swap", r.swaps.length === 1 && JSON.stringify(r.swaps[0].include_user_ids) === '["uT"]');

// 4. A bout cancelled outright.
picksRows = [...onCard, row("uC", "Nobody Atall", "Someone Else")];
r = await runAt("2026-09-25T20:00:00Z");
check("a cancelled bout gets a ❌ push to its picker", r.swaps.length === 1 && /^❌ Nobody Atall vs Someone Else/.test(r.swaps[0].title) && JSON.stringify(r.swaps[0].include_user_ids) === '["uC"]');

// 5. A bad parse is not a run of pull-outs: it takes most of the card with it.
const ghosts = (n) => Array.from({ length: n }, (_, i) => row("uP", "Ghost " + i, "Phantom " + i));
picksRows = [...onCard.slice(0, 3), ...ghosts(4)];
r = await runAt("2026-09-25T20:00:00Z");
check("more vanished bouts than picked bouts left on the card sends nothing", r.swaps.length === 0 && mod.SWAP_MAX_PER_CARD === 3);
check("…and says why", JSON.stringify(r.json.swaps).includes("bad parse"));
// Old picks on vanished bouts never go away, so four real changes on a full card
// must not read as a bad parse and silence the fourth.
picksRows = [...onCard, ...ghosts(4)];
r = await runAt("2026-09-25T20:00:00Z");
check("four real changes on a full card all get their alert", r.swaps.length === 4);

// 5b. More picks than one response holds: nobody past the first page is dropped
//     (a partial audience is unrecoverable once notif_log has the key).
picksRows = [...Array.from({ length: 2 * PAGE_CAP + 5 }, (_, i) => row("f" + i, ev.fights[i % ev.fights.length].f1.n, ev.fights[i % ev.fights.length].f2.n)),
  row("uLate", "Mickey Gall", stays)];
r = await runAt("2026-09-25T20:00:00Z");
check("the picks read is paged past the row cap", picksUrls.length >= 3 && r.swaps.length === 1 && JSON.stringify(r.swaps[0].include_user_ids) === '["uLate"]');

// 6. Never an untargeted push: send-push would broadcast it to everyone.
picksRows = [...onCard, row("uT", "Mickey Gall", stays), row("uT", newcomer, stays)];
r = await runAt("2026-09-25T20:00:00Z");
check("nobody left to tell means no push at all", r.swaps.length === 0);
check("every swap send the handler can make carries include_user_ids", /include_user_ids: s\.users/.test(src) && /if \(!users\.length\) continue;/.test(src));

// 7. Name matching is bundled: nothing from Pages is fetched to run.
missing = new Set(["scoring.js", "index.html", "lab/engine.js", "lab/analytics.js"]);
pagesFetched = [];
picksRows = [...onCard, row("uT", "Mickey Gall", stays)];
r = await runAt("2026-09-25T20:00:00Z");
check("swap alerts need no code from Pages", r.status === 200 && r.swaps.length === 1 && pagesFetched.every((f) => f === "data.js" || /\.json$/.test(f)));
missing = new Set();

if (failures) { console.error(`\ncheck-swap: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-swap: a vanished bout reaches exactly who picked it, once, while it can still be re-picked.");
