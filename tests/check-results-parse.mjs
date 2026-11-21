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
  // A Fight Night's article carries the real spelling, which the ASCII name
  // doesn't give: the poll read nothing all card on 2026-11-21. It reads the
  // slug scrape.py recorded, but never a PPV's (that is a redirect stub).
  const fn = await runPoll({ card: (c) => { c[0].name = "UFC Fight Night: Prochazka vs. Stirling"; c[0].slug = "UFC_Fight_Night:_Procházka_vs._Stirling"; return c; } });
  check("...reads a Fight Night's recorded article (the accented title), not the ASCII name",
    fn.fetched.length === 1 && fn.fetched[0].includes("page=" + encodeURIComponent("UFC_Fight_Night:_Procházka_vs._Stirling") + "&"));
  const ppv = await runPoll({ card: (c) => { c[0].slug = "UFC_334:_Gane_vs._Hokit"; return c; } });
  check("...but a numbered PPV still reads its own article, never its recorded redirect stub",
    ppv.fetched.length === 1 && /[?&]page=UFC_334&/.test(ppv.fetched[0]));
}

// --- fresh results: the committed data.js, read at main's commit -------------
// A result push lands ~2.5 minutes before Pages publishes the commit it came
// from, so the app reads data.js from GitHub at main's current commit (never
// /main/, which GitHub caches ~5 minutes) and adds results it doesn't have.
{
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  // scrape.py's layout: name and date on their own lines, one bout per line.
  const fightLine = (o) => `      {lbl:"${o.lbl || "Main Card"}",wc:"",title:false,rematch:false,odds:{f1:-150,f2:130},winner:${o.winner == null ? '""' : J(o.winner)},method:${J(o.method || "")},${o.round ? "round:" + o.round + "," : ""}state:"${o.state || "pre"}",f1:{n:${J(o.f1)},r:"1-0-0",rk:"",s:{method:"Submission",winner:"Nobody"}},f2:{n:${J(o.f2)},r:"1-0-0",rk:"",s:null}}`;
  const DATA = [
    'var GENERATED_AT="21 Nov 2026 7:10 PM UTC";',
    "var EVENTS=[",
    "  {",
    '    name:"UFC Fight Night: Prochazka vs. Stirling",',
    '    date:"2026-11-14",',
    '    slug:"UFC_Fight_Night:_Proch\\u00e1zka_vs._Stirling",',
    "    fights:[",
    fightLine({ lbl: "Main Event", f1: "Jiri Prochazka", f2: "Navajo Stirling" }),
    fightLine({ f1: "Kyoji Horiguchi", f2: "Asu Almabayev", winner: "Kyoji Horiguchi", method: "Decision (Unanimous)", round: 3, state: "post" }) + ",",
    fightLine({ f1: "Ernesta Kareckait\\u0117", f2: "Melissa Gatto", winner: "", method: "Draw", round: 3, state: "post" }) + ",",
    fightLine({ f1: "Kayla Harrison", f2: "Amanda Nunes", winner: "Amanda Nunes", method: "KO/TKO", round: 1, state: "post" }) + ",",
    fightLine({ f1: "Chris Duncan", f2: "Drew Dober", winner: "Somebody Else", method: "KO/TKO", round: 1, state: "post" }),
    "    ]",
    "  },",
    "  {",
    '    name:"UFC Fight Night: Prochazka vs. Stirling",',
    '    date:"2026-11-07",',
    "    fights:[",
    fightLine({ f1: "Jiri Prochazka", f2: "Navajo Stirling", winner: "Navajo Stirling", method: "KO/TKO", round: 1, state: "post" }),
    "    ]",
    "  }",
    "];",
  ].join("\n").replace(/\\\\u/g, "\\u");   // J() doubled the \u escapes; data.js writes them single
  async function runFresh({ ref = () => ({ ok: true, status: 200, json: () => Promise.resolve({ object: { sha: SHA } }) }), hidden = false } = {}) {
    const a = html.indexOf("// fresh-results:start"), b = html.indexOf("// fresh-results:end");
    if (a < 0 || b < 0) { fail("index.html: no // fresh-results:start … :end block"); process.exit(1); }
    const fetched = [], renders = { n: 0 };
    const EVENTS = [{ name: "UFC Fight Night: Prochazka vs. Stirling", date: "2026-11-14", fights: [
      bout("Main Event", "Jiri Prochazka", "Navajo Stirling"),
      bout("Main Card", "Kyoji Horiguchi", "Asu Almabayev"),
      bout("Prelim", "Ernesta Kareckaite", "Melissa Gatto"),
      bout("Prelim", "Kayla Harrison", "Amanda Nunes", { winner: "Kayla Harrison", method: "Decision (Unanimous)", round: 5, state: "post" }),
      bout("Prelim", "Chris Duncan", "Drew Dober"),
    ] }];
    class FakeDate extends Date { constructor(...x) { if (x.length) super(...x); else super(NOW); } static now() { return NOW; } }
    const timers = [];
    const ctx = vm.createContext({
      console: { log() {}, warn() {} }, JSON, Object, String, Number, Array, RegExp, Promise, isNaN, parseInt, Date: FakeDate,
      EVENTS, HOUR_MS: 3600e3, DAY_MS: 864e5, render: () => { renders.n++; }, loadLeaderboard() {}, fnLive: false, fnModeOpen: () => false,
      document: { hidden, visibilityState: hidden ? "hidden" : "visible", getElementById: () => null, addEventListener() {} },
      setTimeout: (f) => { timers.push(f); return 1; }, setInterval: () => 1,
      fetch: (url, opts) => {
        fetched.push({ url: String(url), opts });
        if (/^https:\/\/api\.github\.com\//.test(url)) return Promise.resolve(ref());
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(DATA) });
      },
      window: {},
    });
    vm.runInContext(read("scoring.js"), ctx);           // boutDecided, nmEq, exactly as the app has them
    vm.runInContext(html.slice(a, b), ctx);
    timers.forEach((f) => f());
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    return { fetched, renders, EVENTS, ctx };
  }
  const { fetched, renders, EVENTS, ctx } = await runFresh();
  const f = EVENTS[0].fights;
  check("fresh results: asks GitHub's API for main's commit, uncached",
    fetched.length === 2 && /^https:\/\/api\.github\.com\/repos\/[^/]+\/ufc-dashboard\/git\/ref\/heads\/main$/.test(fetched[0].url) && fetched[0].opts && fetched[0].opts.cache === "no-store");
  check("...then reads data.js AT that commit, never /main/ (GitHub caches main ~5 minutes)",
    fetched[1].url.startsWith("https://raw.githubusercontent.com/") && fetched[1].url.endsWith("/ufc-dashboard/" + SHA + "/data.js"));
  check("...adds a committed result to a bout still pending here (winner, method, round, over)",
    f[1].winner === "Kyoji Horiguchi" && f[1].method === "Decision (Unanimous)" && f[1].round === 3 && f[1].state === "post");
  check("...marks a draw over with no winner, matching an escaped accented name",
    f[2].state === "post" && f[2].winner === "" && f[2].method === "Draw");
  check("...never rewrites a bout already decided here",
    f[3].winner === "Kayla Harrison" && f[3].method === "Decision (Unanimous)" && f[3].round === 5);
  check("...leaves a bout pending when the file has no result for it", f[0].state === "pre" && !f[0].winner);
  check("...ignores a result naming neither corner", f[4].state === "pre" && !f[4].winner);
  check("...reads only the bout's own fields, not a fighter's stats object", f[0].state === "pre" && f[1].winner === "Kyoji Horiguchi");
  check("...and only the same card (name AND date): last week's card can't decide this one", f[0].state === "pre");
  check("...and re-renders once", renders.n === 1);
  check("...and sends no push (no request but GitHub's)", fetched.every((x) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(x.url)));
  const parsed = ctx.window._freshParse(DATA);
  check("...parses both cards and every bout line", parsed.length === 2 && parsed[0].fights.length === 5 && parsed[1].fights.length === 1);
  const limited = await runFresh({ ref: () => ({ ok: false, status: 403, json: () => Promise.resolve({}) }) });
  check("...a refused API read (rate limit) changes nothing and fetches no data.js",
    limited.fetched.length === 1 && limited.renders.n === 0 && limited.EVENTS[0].fights[1].state === "pre");
  const badSha = await runFresh({ ref: () => ({ ok: true, status: 200, json: () => Promise.resolve({ object: { sha: "main" } }) }) });
  check("...a reply without a real commit id fetches nothing", badSha.fetched.length === 1 && badSha.renders.n === 0);
  const hid = await runFresh({ hidden: true });
  check("...and nothing is fetched while the app is in the background", hid.fetched.length === 0);
}
{
  const sw = read("sw.js");
  check("sw.js caches only same-origin files in its network-first set (GitHub's data.js must never become the offline ./data.js)",
    /var sameOrigin = new URL\(req\.url\)\.origin === self\.location\.origin;/.test(sw) && /if \(sameOrigin && \(isNavigate \|\| isData/.test(sw));
  const csp = (/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html) || [])[1] || "";
  const connect = (/connect-src ([^;]*)/.exec(csp) || [])[1] || "";
  check("the page's CSP lets it reach GitHub's API and raw files",
    connect.split(/\s+/).includes("https://api.github.com") && connect.split(/\s+/).includes("https://raw.githubusercontent.com"));
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

  // A configurable run: picks, the committed data.js, Wikipedia pages and the
  // dedup log are all stubs; every fetch is recorded.
  const FN = "UFC Fight Night: Prochazka vs. Stirling", REAL = "UFC_Fight_Night:_Procházka_vs._Stirling";
  const GANE = [{ user_id: "u-gane", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Ciryl Gane" },
                { user_id: "u-hokit", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Josh Hokit" }];
  const card = (over = {}) => ({ name: FN, date: "2026-11-14", slug: REAL,
    fights: [{ f1: { n: "Ciryl Gane" }, f2: { n: "Josh Hokit" }, winner: "Ciryl Gane", state: "post" }], ...over });
  const runCR = async ({ pages = { [REAL]: WIKI }, cards = [card()], dataStatus = 200, picks = GANE, logged = [], lockAt = "2026-11-15T01:00:00+00:00", headers = {} } = {}) => {
    const seenR = [], pushesR = [], marks = [];
    globalThis.fetch = async (url, init) => {
      url = String(url); seenR.push(url);
      const json = (x) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("https://raw.githubusercontent.com/")) {
        return dataStatus === 200 ? new Response("var EVENTS=" + JSON.stringify(cards) + ";\n", { status: 200 }) : new Response("no", { status: dataStatus });
      }
      if (url.includes("/rest/v1/picks?select=event_date,event_name")) return json([{ event_date: "2026-11-14", event_name: FN }]);
      if (url.includes("/rest/v1/notif_log")) {
        if (init?.method === "POST") { marks.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
        return json(logged.map((type) => ({ event_date: "2026-11-14", type })));
      }
      if (url.startsWith("https://en.wikipedia.org/")) {
        if (!/action=parse/.test(url)) return json({ unexpected: "search" });
        const page = decodeURIComponent(/[?&]page=([^&]+)/.exec(url)[1]);
        return json(pages[page] ? { parse: { wikitext: { "*": pages[page] } } } : { error: { code: "missingtitle" } });
      }
      if (url.includes("/rest/v1/picks?select=user_id,f1,f2,pick")) {
        // PostgREST: at most 1,000 rows, the window the Range header asks for.
        const [x, y] = String(init?.headers?.Range ?? "0-999").split("-").map(Number);
        return json(picks.slice(x, Math.min(y + 1, x + 1000)));
      }
      if (url.includes("/rest/v1/rpc/pick_lock_for")) return json(lockAt);
      if (url.endsWith("/functions/v1/send-push")) { pushesR.push(JSON.parse(init.body)); return json({ sent: 1, failed: 0 }); }
      return new Response("unexpected " + url, { status: 500 });
    };
    Date.now = () => NOW;
    try {
      const r = await handler(new Request("https://fn.test/check-results", { method: "POST", headers: { Authorization: "Bearer cron-secret", ...headers } }));
      return { body: await r.json(), seen: seenR, pushes: pushesR, marks, types: pushesR.map((x) => x.type).sort() };
    } finally { globalThis.fetch = realFetch; Date.now = realNow; }
  };
  const BOTH = ["result:ciryl-gane-josh-hokit:loss", "result:ciryl-gane-josh-hokit:win"];

  // 2026-11-21: picks say "Prochazka", the article is "Procházka", and that
  // isn't even a redirect, so check-results parsed nothing all card. It reads
  // the article scrape.py recorded in data.js (ev.slug), as the app's live
  // poll does, and never searches.
  const acc = await runCR();
  check("an accented Fight Night is read at data.js's recorded slug, with no search",
    acc.body.parsed > 0 && acc.seen.some((u) => u.includes("page=" + encodeURIComponent(REAL))) &&
    !acc.seen.some((u) => /opensearch|list=search/.test(u)));
  check("...and its pushes go out from the Wikipedia pass, so the safety net doesn't fire",
    J(acc.types) === J(BOTH) && J(acc.body.net) === "[]" && acc.marks.length === 0 && J(acc.body.unread) === "[]");
  const ppv = await runCR({ cards: [card({ name: "UFC 334: Gane vs. Hokit", slug: "UFC_334:_Gane_vs._Hokit" })], pages: { UFC_334: WIKI } });
  check("a numbered PPV still reads its own article, never data.js's full-title redirect",
    ppv.body.parsed > 0 && ppv.seen.some((u) => /[?&]page=UFC_334&/.test(u)));

  // The safety net: Wikipedia unreadable, the result is in the committed
  // data.js, so the data.js pass sends both groups and marks them.
  const blind = await runCR({ pages: {} });
  check("with Wikipedia unreadable, the data.js pass sends every group of a decided bout",
    J(blind.types) === J(BOTH) && J(blind.pushes.find((x) => x.type.endsWith(":loss"))?.include_user_ids) === J(["u-hokit"]));
  check("...marks each one net:<type> in notif_log and reports it, with the unread card",
    J(blind.marks.map((m) => m.type).sort()) === J(BOTH.map((t) => "net:" + t)) &&
    J(blind.body.net.map((n) => n.type).sort()) === J(BOTH) && J(blind.body.unread) === J([{ date: "2026-11-14", name: FN }]));
  const earlier = await runCR({ pages: {}, logged: [...BOTH, ...BOTH.map((t) => "net:" + t)] });
  check("...and keeps reporting an earlier run's net sends (the alert is state, not a race), sending nothing again",
    earlier.pushes.length === 0 && J(earlier.body.net.map((n) => n.type).sort()) === J(BOTH));

  // Never twice: a group logged under another spelling of the same bout
  // counts as sent (senders key by the names they read).
  const respelled = await runCR({ pages: {}, logged: ["result:cyril-gane-josh-hokit:win", "result:cyril-gane-josh-hokit:loss"] });
  check("a group logged under a respelled key is not sent again", respelled.pushes.length === 0 && J(respelled.body.net) === "[]");
  const reversed = await runCR({ pages: {}, logged: ["result:josh-hokit-ciryl-gane:win"] });
  check("...but the other winner's key never covers it (winner first)", J(reversed.types) === J(BOTH));
  const half = await runCR({ pages: {}, logged: ["result:ciryl-gane-josh-hokit:win"] });
  check("...and a bout with one side sent gets only the other", J(half.types) === J(["result:ciryl-gane-josh-hokit:loss"]));

  // Still inside the bout's lock grace: the audience isn't final, wait.
  const early = await runCR({ pages: {}, lockAt: new Date(NOW - 60e3).toISOString() });
  check("inside the lock grace nothing is sent", early.pushes.length === 0 && early.body.deferred > 0);
  const pending = await runCR({ pages: {}, cards: [card({ fights: [{ f1: { n: "Ciryl Gane" }, f2: { n: "Josh Hokit" }, state: "pre" }] })] });
  check("an undecided bout in data.js sends nothing", pending.pushes.length === 0);

  // The committed copy, pinned to the commit update.yml just pushed.
  const SHA = "d5171a5f7847c1cf9e9492e8b84187976644bc0c";
  const pinned = await runCR({ headers: { "X-Data-Sha": SHA } });
  check("X-Data-Sha reads data.js at that commit, not main's stale copy",
    pinned.seen.some((u) => u.includes(`/${SHA}/data.js`)) && !pinned.seen.some((u) => u.includes("/main/data.js")));
  const nodata = await runCR({ dataStatus: 500, pages: { "UFC_Fight_Night:_Prochazka_vs._Stirling": WIKI } });
  check("an unreadable data.js is reported, and the Wikipedia pass still runs on the rebuilt title",
    /HTTP 500/.test(nodata.body.dataError || "") && J(nodata.types) === J(BOTH));

  // A card with more picks than one PostgREST response: the losing side sits
  // past row 1,000 and must still be told (scrape.py lost exactly that group).
  const big = Array.from({ length: 1200 }, (_, i) => ({ user_id: "w" + i, f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Ciryl Gane" }))
    .concat([{ user_id: "u-late", f1: "Ciryl Gane", f2: "Josh Hokit", pick: "Josh Hokit" }]);
  const paged = await runCR({ picks: big });
  const lossTo = paged.pushes.find((x) => x.type.endsWith(":loss")), winTo = paged.pushes.find((x) => x.type.endsWith(":win"));
  check("picks past the first 1,000 rows are read: the loser's pickers are told",
    J(lossTo?.include_user_ids) === J(["u-late"]) && winTo?.include_user_ids.length === 1200);

  // Where a fired safety net is seen.
  const wf = read(".github/workflows/scheduled-push.yml");
  check("scheduled-push.yml fails the run on an unread card dated today or earlier",
    /\.unread\[\]\?\s*\|\s*select\(\.date <= \$today\)/.test(wf) && /::error::check-results can't read[\s\S]{0,200}exit 1/.test(wf));
  const up = read(".github/workflows/update.yml");
  const at = up.indexOf("- name: Check result pushes against the committed data.js");
  const step = at < 0 ? "" : up.slice(at, up.indexOf("- name: Write pick lock times now that data.js is committed"));
  check("update.yml calls check-results after the scraper's send, pinned to the commit it pushed",
    step.length > 0 && up.indexOf("python scrape.py --send-pending pending-pushes.json\n") < at &&
    /X-Data-Sha: \$\(git rev-parse HEAD\)/.test(step) && /continue-on-error: true/.test(step));
  check("...and opens an issue for a net send, an unreadable page or an unreadable data.js",
    /\.net\[\]\?/.test(step) && /\.unread\[\]\?/.test(step) && /\.dataError/.test(step) && /gh issue create --title "\$TITLE"/.test(step));
}

if (failures) { console.error(`\ncheck:results — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:results — one reading of a results page (scrape.py's), every decided bout in data.js checked against the log, and a fired safety net seen.");
