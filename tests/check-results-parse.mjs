// Guard: one reading of a Wikipedia results page, and only two result senders.
//
// results.js (ResultsParse) is the reader the open app's live poll and the
// check-results backup both run. Before it, each had its own copy, and they had
// drifted from scrape.py: check-results asked Wikipedia for "UFC 334: Gane vs.
// Hokit", a redirect stub with no results, so the server backup never fired for
// a numbered PPV; and neither copy matched the scraper on draws, no contests,
// unclosed templates or round cells (36% and 50% of random pages disagreed).
//
// This holds:
//   - results.js gives exactly the answers in tests/fixtures/results/expected.json,
//     the golden tests/test_results_golden.py holds scrape.py to
//   - check-results' bundle is that same code, and the app loads it (with the
//     service worker precaching the same versioned URL)
//   - nobody keeps a private copy of the parser again
//   - the live poll, run for real: reads the PPV's own article, marks a win and a
//     draw on the card, re-renders, and sends no push
//   - check-results, run for real: reads "UFC_334", pushes the win and the loss
//     to exactly the people who picked them, and nothing for a draw
// No network, no live data: frozen fixtures and stubs, clock pinned.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => (cond ? console.log("  ✓ " + name) : fail(name));
const J = (x) => JSON.stringify(x);

// --- results.js against the golden -------------------------------------------
const rctx = {};
vm.runInNewContext(read("results.js"), rctx);
const RP = rctx.ResultsParse;
if (!RP) { fail("results.js sets no ResultsParse"); process.exit(1); }
const cases = JSON.parse(read("tests/fixtures/results/cases.json"));
const expected = JSON.parse(read("tests/fixtures/results/expected.json"));
// Python dicts come out with sorted keys; compare JS answers the same way.
const norm = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v)));
{
  const wrong = Object.keys(cases.pages).filter((k) => J(norm(RP.parseResults(cases.pages[k]))) !== J(expected.pages[k]));
  check(`results.js reads all ${Object.keys(cases.pages).length} golden pages as scrape.py does` + (wrong.length ? " (differs: " + wrong.slice(0, 6).join(", ") + ")" : ""), !wrong.length);
  const same = (key, got) => check(`...and agrees on ${key} (${got.length} cases)`, J(got) === J(expected[key]));
  same("clean", cases.names.map(([a]) => RP.cleanWiki(a)));
  same("names_match", cases.names.map(([a, b]) => RP.namesMatch(a, b)));
  same("names_match_clean", cases.names.map(([a, b]) => RP.namesMatch(RP.cleanWiki(a), RP.cleanWiki(b))));
  same("last_name", cases.names.map(([a]) => RP.lastName(a)));
  same("norm_method", cases.methods.map((m) => RP.normMethod(m)));
  same("event_slug", cases.events.map((e) => RP.eventSlug(e)));
  // A golden that lost its answers would let both sides "agree" on nothing.
  check("...and the golden still carries real answers (the PPV page's four results)", (expected.pages.ppv_template || []).length === 4);
}

// --- one copy: the bundle is results.js, the app loads it ----------------------
const { ResultsParse: BP } = await import(pathToFileURL(join(ROOT, "supabase/functions/_shared/results-bundle.js")).href);
check("check-results' bundle reads every golden page exactly as results.js does",
  !!BP && Object.keys(cases.pages).every((k) => J(BP.parseResults(cases.pages[k])) === J(RP.parseResults(cases.pages[k]))));
const html = read("index.html"), sw = read("sw.js");
const ver = (/<script src="results\.js\?v=([^"]+)"><\/script>/.exec(html) || [])[1];
check("index.html loads results.js by a versioned URL", !!ver);
check("...and the service worker precaches that same URL", !!ver && sw.includes("'./results.js?v=" + ver + "'"));
// npm run build writes dist/ from a list of files; one missing from it is a page
// that references a script the built site doesn't have (Codex on #340).
check("...and npm run build ships it in dist/ (build.mjs's standalone scripts)",
  /for \(const f of \[[^\]]*"results\.js"[^\]]*\]\)/.test(read("build.mjs")));
for (const [file, src] of [["index.html", html], ["supabase/functions/check-results/index.ts", read("supabase/functions/check-results/index.ts")]]) {
  const own = ["_parseMMATemplate", "_parseWikitable", "_flushRow", "_cleanWiki", "_normMethod", "_undecidedRes", "_deriveSlug"].filter((n) => new RegExp("function " + n + "\\(").test(src));
  check(`${file} keeps no private copy of the results parser` + (own.length ? " (" + own.join(", ") + ")" : ""), !own.length);
}

// --- the live poll, run for real ---------------------------------------------
const NOW = Date.parse("2026-11-15T03:00:00Z");
const bout = (lbl, a, b, extra) => Object.assign({ lbl, wc: "", title: false, rematch: false, odds: null, winner: "", method: "", round: null, state: "pre", f1: { n: a }, f2: { n: b } }, extra || {});
function card() {
  return [{ name: "UFC 334: Gane vs. Hokit", date: "2026-11-14", fights: [
    bout("Main Event", "Ciryl Gane", "Josh Hokit"),
    bout("Co-Main", "Kayla Harrison", "Amanda Nunes", { winner: "Kayla Harrison", method: "Decision (Unanimous)", round: 5, state: "post" }),
    bout("Prelim", "Ernesta Kareckaite", "Melissa Gatto"),
    bout("Prelim", "Chris Duncan", "Drew Dober"),
  ] }];
}
const WIKI = "{{MMAevent bout\n|Heavyweight\n|[[Ciryl Gane]]\n|def.\n|[[Josh Hokit]]\n|TKO (punches)\n|2\n|3:12\n|\n}}\n" +
  "{{MMAevent bout\n|Women's Flyweight\n|[[Ernesta Kareckaitė]]\n|vs.\n|[[Melissa Gatto]]\n|Draw (majority) (29–27, 28–28, 28–28)\n|3\n|5:00\n|\n}}\n" +
  "{{MMAevent bout\n|Women's Featherweight\n|[[Kayla Harrison]] (c)\n|def.\n|[[Amanda Nunes]]\n|Submission (armbar)\n|1\n|1:00\n|\n}}";
async function runPoll({ withParser = true, card: edit = (c) => c } = {}) {
  const a = html.indexOf("// live-poll:start"), b = html.indexOf("// live-poll:end");
  if (a < 0 || b < 0) { fail("index.html: no // live-poll:start … :end block"); process.exit(1); }
  const fetched = [], renders = { n: 0 }, removed = [];
  const EVENTS = edit(card());
  class FakeDate extends Date { constructor(...x) { if (x.length) super(...x); else super(NOW); } static now() { return NOW; } }
  const ctx = vm.createContext({
    console: { log() {}, warn() {} }, JSON, Object, String, Array, Promise, isNaN, Date: FakeDate,
    EVENTS, HOUR_MS: 3600e3, DAY_MS: 864e5, render: () => { renders.n++; }, loadLeaderboard() {}, fnLive: false,
    fnModeOpen: () => false, encodeURIComponent,
    localStorage: { removeItem: (k) => removed.push(k), getItem: () => null, setItem() {} },
    document: { getElementById: () => null },
    setInterval: () => 1, clearInterval() {},
    fetch: (url) => { fetched.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({ parse: { wikitext: { "*": WIKI } } }) }); },
    window: {},
  });
  vm.runInContext(read("scoring.js"), ctx);           // boutDecided, exactly as the app has it
  if (withParser) vm.runInContext(read("results.js"), ctx);
  vm.runInContext(html.slice(a, b), ctx);
  ctx.window.startLivePolling();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return { fetched, renders, EVENTS, removed };
}
{
  const { fetched, renders, EVENTS, removed } = await runPoll();
  const f = EVENTS[0].fights;
  check("live poll reads the PPV's own article (UFC_334), following redirects",
    fetched.length === 1 && /[?&]page=UFC_334&/.test(fetched[0]) && /[?&]redirects=1/.test(fetched[0]));
  check("...marks the win on the card (winner, method, round, over)",
    f[0].winner === "Ciryl Gane" && f[0].method === "KO/TKO" && f[0].round === 2 && f[0].state === "post");
  check("...marks the draw over with no winner", f[2].state === "post" && f[2].winner === "" && f[2].method === "Draw");
  check("...leaves an already-final bout as it was (no re-reading over a result)",
    f[1].method === "Decision (Unanimous)" && f[1].round === 5);
  check("...leaves a bout it has no result for alone", f[3].state === "pre" && !f[3].winner);
  check("...and re-renders", renders.n === 1);
  check("...and sends no push (no request but Wikipedia's)", fetched.every((u) => u.startsWith("https://en.wikipedia.org/")));
  check("...and clears the push bookkeeping it no longer keeps", removed.includes("ufc_notified_results"));
  const none = await runPoll({ withParser: false });
  check("without results.js there is no live poll (and nothing breaks)", none.fetched.length === 0 && none.renders.n === 0);
  // One result marks one bout, the first it names, as scrape.py applies it: a
  // stale second listing of the same pair must not be decided by it too.
  const dup = await runPoll({ card: (c) => { c[0].fights.push(bout("Prelim", "Ciryl Gane", "Josh Hokit")); return c; } });
  check("...and one result marks one bout (the first it names), never a second listing",
    dup.EVENTS[0].fights[0].winner === "Ciryl Gane" && dup.EVENTS[0].fights[4].state === "pre" && !dup.EVENTS[0].fights[4].winner);
}

// --- check-results, run for real ---------------------------------------------
{
  const src = read("supabase/functions/check-results/index.ts");
  let handler = null;
  const env = { CRON_SECRET: "cron-secret", SUPABASE_URL: "https://sb.test", SB_ANON_KEY: "anon", SB_SERVICE_ROLE_KEY: "svc" };
  globalThis.Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h; } };
  const { code } = await transform(src, { loader: "ts", format: "esm" });
  const linked = code.replace(/from "\.\.\/_shared\/([\w-]+\.js)"/g, (_m, f) => `from "${pathToFileURL(join(ROOT, "supabase/functions/_shared", f)).href}"`);
  await import("data:text/javascript;base64," + Buffer.from(linked).toString("base64"));
  if (typeof handler !== "function") { fail("check-results registered no Deno.serve handler"); process.exit(1); }
  const realFetch = globalThis.fetch, realNow = Date.now;
  const seen = [], pushes = [];
  globalThis.fetch = async (url, init) => {
    url = String(url); seen.push(url);
    const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/rest/v1/picks?select=event_date,event_name")) return json([{ event_date: "2026-11-14", event_name: "UFC 334: Gane vs. Hokit" }]);
    if (url.includes("/rest/v1/notif_log")) return json([]);
    if (url.startsWith("https://en.wikipedia.org/")) return json({ parse: { wikitext: { "*": /page=UFC_334&/.test(url) ? WIKI : "#REDIRECT [[UFC 334]]" } } });
    if (url.includes("/rest/v1/picks?select=user_id,f1,f2,pick")) return json([
      { user_id: "u-gane", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Ciryl Gane" },
      { user_id: "u-hokit", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Josh Hokit" },
      { user_id: "u-draw", f1: "Ernesta Kareckaite", f2: "Melissa Gatto", pick: "Melissa Gatto" },
    ]);
    if (url.includes("/rest/v1/rpc/pick_lock_for")) return json("2026-11-15T01:00:00+00:00");
    if (url.endsWith("/functions/v1/send-push")) { pushes.push(JSON.parse(init.body)); return json({ sent: 1 }); }
    return new Response("unexpected " + url, { status: 500 });
  };
  Date.now = () => NOW;
  let res;
  try {
    res = await handler(new Request("https://fn.test/check-results", { method: "POST", headers: { Authorization: "Bearer cron-secret" } }));
  } finally { globalThis.fetch = realFetch; Date.now = realNow; }
  const wiki = seen.filter((u) => u.startsWith("https://en.wikipedia.org/"));
  check("check-results reads the PPV's own article (UFC_334), not the redirect stub its own copy asked for",
    res.status === 200 && wiki.length === 1 && /[?&]page=UFC_334&/.test(wiki[0]) && /[?&]redirects=1/.test(wiki[0]));
  const byType = Object.fromEntries(pushes.map((p) => [p.type, p.include_user_ids]));
  check("...pushes the win to the people who picked the winner", J(byType["result:ciryl-gane-josh-hokit:win"]) === J(["u-gane"]));
  check("...and the loss to the people who picked the loser", J(byType["result:ciryl-gane-josh-hokit:loss"]) === J(["u-hokit"]));
  check("...with the same key scrape.py builds (ResultsParse.fightKey)", pushes.every((p) => p.type.startsWith("result:" + RP.fightKey("Ciryl Gane", "Josh Hokit") + ":")));
  check("...and nothing for the draw (no winner to announce), nor anyone it can't match", pushes.length === 2 && !pushes.some((p) => p.include_user_ids.includes("u-draw")));
  // Today a draw's empty names match no pick, so the push loop can't act on one
  // even unguarded; the guard is what keeps that true if matching ever loosens.
  check("...because the result loop drops a draw / no contest before matching anyone",
    /for \(const res of parsed\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(res\.undecided \|\| !res\.winner \|\| !res\.loser\) continue;/.test(src));

  // 2026-11-21: picks say "Prochazka", the article is "Procházka", and the
  // folded title isn't a redirect, so check-results parsed nothing all card.
  // It now searches like scrape.py and takes only a title that folds to the
  // same event, never a different card the search also returns.
  const FN = "UFC Fight Night: Prochazka vs. Stirling", REAL = "UFC Fight Night: Procházka vs. Stirling";
  const runFn = async (titles, pickRows = [{ user_id: "u-gane", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Ciryl Gane" }]) => {
    const seenFn = [], pushesFn = [];
    globalThis.fetch = async (url, init) => {
      url = String(url); seenFn.push(url);
      const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.includes("/rest/v1/picks?select=event_date,event_name")) return json([{ event_date: "2026-11-14", event_name: FN }]);
      if (url.includes("/rest/v1/notif_log")) return json([]);
      if (url.includes("action=opensearch")) return json([FN, titles]);
      if (url.includes("list=search")) return json({ query: { search: titles.map((title) => ({ title })) } });
      if (url.includes("action=parse")) {
        const page = decodeURIComponent(/[?&]page=([^&]+)/.exec(url)[1]);
        return json(page === REAL.replace(/ /g, "_") ? { parse: { wikitext: { "*": WIKI } } } : { error: { code: "missingtitle" } });
      }
      if (url.includes("/rest/v1/picks?select=user_id,f1,f2,pick")) {
        // PostgREST: at most 1,000 rows, the window the Range header asks for.
        const [a, b] = String(init?.headers?.Range ?? "0-999").split("-").map(Number);
        return json(pickRows.slice(a, Math.min(b + 1, a + 1000)));
      }
      if (url.includes("/rest/v1/rpc/pick_lock_for")) return json("2026-11-15T01:00:00+00:00");
      if (url.endsWith("/functions/v1/send-push")) { pushesFn.push(JSON.parse(init.body)); return json({ sent: 1 }); }
      return new Response("unexpected " + url, { status: 500 });
    };
    Date.now = () => NOW;
    try {
      const r = await handler(new Request("https://fn.test/check-results", { method: "POST", headers: { Authorization: "Bearer cron-secret" } }));
      return { body: await r.json(), seen: seenFn, pushes: pushesFn };
    } finally { globalThis.fetch = realFetch; Date.now = realNow; }
  };
  const acc = await runFn(["UFC Fight Night: Procházka vs. Rountree", REAL]);
  check("an accented Fight Night title is found by search and its results read",
    acc.body.parsed > 0 && acc.seen.some((u) => u.includes("page=" + encodeURIComponent(REAL.replace(/ /g, "_")))));
  check("...and its result pushes go out", acc.pushes.some((p) => p.type === "result:ciryl-gane-josh-hokit:win"));
  const wrong = await runFn(["UFC Fight Night: Procházka vs. Rountree"]);
  check("...but a search hit for a different card is never read", wrong.body.parsed === 0 && wrong.pushes.length === 0);
  check("...and a card it can't read is reported (scheduled-push.yml fails on it)",
    J(wrong.body.unread) === J([{ date: "2026-11-14", name: FN }]) && J(acc.body.unread) === "[]");
  const wf = read(".github/workflows/scheduled-push.yml");
  check("scheduled-push.yml fails the run on an unread card dated today or earlier",
    /\.unread\[\]\?\s*\|\s*select\(\.date <= \$today\)/.test(wf) && /::error::check-results can't read[\s\S]{0,200}exit 1/.test(wf));

  // A card with more picks than one PostgREST response: the losing side sits
  // past row 1,000 and must still be told (scrape.py lost exactly that group).
  const big = Array.from({ length: 1200 }, (_, i) => ({ user_id: "w" + i, f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Ciryl Gane" }))
    .concat([{ user_id: "u-late", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Josh Hokit" }]);
  const paged = await runFn([REAL], big);
  const lossTo = paged.pushes.find((p) => p.type === "result:ciryl-gane-josh-hokit:loss");
  const winTo = paged.pushes.find((p) => p.type === "result:ciryl-gane-josh-hokit:win");
  check("picks past the first 1,000 rows are read: the loser's pickers are told",
    J(lossTo?.include_user_ids) === J(["u-late"]) && winTo?.include_user_ids.length === 1200);
}

if (failures) { console.error(`\ncheck:results — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:results — one reading of a results page (scrape.py's), two senders, and the PPV backup reads its own article.");
