// Guard: FightBot's call (one AI line on a room's Tale of the Tape or a Card
// Recap's Fight Night Report) and the Tale of the Tape poster.
//
// The call is prose around numbers the app computed, shown under real people's
// names, so its dangerous failure is a made-up stat. It gets the scouting
// report's guard (numbersInvented, one retry, then a clean 502), and it only
// spends AI when someone taps. The poster is drawn in the browser from the
// same tape: no AI, no upload. This pins:
//   1. the real handler: Claude only, bounded facts, no invented numbers, the
//      shared daily budget, one line;
//   2. the app: the call button on the tape and on the report, facts that are
//      exactly what's on screen, session caching, error states; the poster
//      drawn at 1080×1350 and handed to the share sheet, redrawn with the call.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { transform } from "esbuild";
import { launchChromium } from "./lib/browser.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

// ── 1. The handler ───────────────────────────────────────────────────────────
const ENV = { SB_ANON_KEY: "anon", ANTHROPIC_API_KEY: "sk-test", GROK_API_KEY: "xai-test", RETRY_BACKOFF_MS: "1",
  SUPABASE_URL: "https://sb.test", SB_SERVICE_ROLE_KEY: "service" };
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
let replies = [], calls = [];
const DB = { rows: new Map() };
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url === "https://sb.test/auth/v1/user") {
    const m = /^Bearer tok\.(.+)\.sig$/.exec(init.headers.Authorization || "");
    return m ? new Response(JSON.stringify({ id: m[1] }), { status: 200 }) : new Response("{}", { status: 401 });
  }
  if (url === "https://sb.test/rest/v1/rpc/ai_quota_take") {
    const { p_user, p_bucket, p_cap } = JSON.parse(init.body), k = p_user + "|" + p_bucket;
    const n = DB.rows.get(k) || 0;
    if (n >= p_cap) return new Response("false", { status: 200 });
    DB.rows.set(k, n + 1);
    return new Response("true", { status: 200 });
  }
  calls.push({ url, body: JSON.parse(init.body) });
  const text = replies.length ? replies.shift() : "Andy has the locks, JP has the underdogs, and only one of them walks out with the room.";
  if (url.includes("x.ai")) return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
};
const src = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const M = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
check("ai-breakdown loads with the verdict exported", typeof handler === "function" && typeof M.buildVerdict === "function" &&
  JSON.stringify(M.VERDICT_KINDS) === '["tape","report"]');

const facts = ["Andy is first on the board with 42.5 points; JP is second with 39.", "Accuracy: Andy 64%, JP 58% (edge Andy)",
  "Underdogs: Andy 30% (3/10), JP 45% (5/11) (edge JP)", "Locks: Andy 75% (3/4), JP 50% (2/4) (edge Andy)"];
let seq = 0;
async function ask(verdict, who, auth) {
  calls = [];
  who = who ?? "caller-" + (++seq);
  const res = await handler(new Request("https://fn/ai-breakdown", {
    method: "POST",
    headers: { Authorization: auth ?? "Bearer tok." + who + ".sig", "Content-Type": "application/json", "x-forwarded-for": "10.2.0." + (++seq % 250) },
    body: JSON.stringify({ action: "verdict", ...(verdict === undefined ? {} : { verdict }) }),
  }));
  return { status: res.status, json: await res.json(), calls };
}
let r = await ask({ kind: "tape", title: "UFC 333", facts });
check("a call comes back 200 with one line", r.status === 200 && /Andy has the locks/.test(r.json.breakdown));
check("it is written by Claude, never Grok (even with a Grok key set)", r.calls.length === 1 && r.calls[0].url.includes("anthropic.com"));
const sys = r.calls[0].body.system, user = r.calls[0].body.messages[0].content;
check("the prompt carries FACTS ARE STRICT, one line, and every fact it was sent", /FACTS ARE STRICT/.test(sys) && /ONE punchy line/.test(sys) &&
  facts.every((f) => user.includes(f)) && user.includes("Card: UFC 333"));
check("none of the roast's material reaches it", !/Soft Hands|unfiltered|swear/i.test(sys + user));
check("a report is framed as the night's headline, a tape as who has the edge",
  M.buildVerdict({ kind: "report", facts: ["x"] }).system.includes("just finished") && M.buildVerdict({ kind: "tape", facts: ["x"] }).system.includes("who has the edge"));
check("its token ceiling is a line's worth (≤150)", r.calls[0].body.max_tokens <= 150);

replies = ["Andy is 12-0 on locks, lights out."];
r = await ask({ kind: "tape", facts });
check("an invented number triggers one retry naming it", r.calls.length === 2 && /\(12, 0\)|12/.test(r.calls[1].body.messages[0].content));
check("…and the clean retry is what's returned", r.status === 200 && !/12-0/.test(r.json.breakdown));
replies = ["Andy hits 90% of locks.", "Still 90%, trust me."];
r = await ask({ kind: "tape", facts });
check("a call that invents twice is a 502, never shipped", r.status === 502 && !r.json.breakdown);
// Small counts are its whole subject (locks, titles, methods), so it gets no
// "round 1 / top 3" leniency, and a count in words is still a count.
replies = ["Andy owns seven titles and it isn't close.", "Andy has the locks and the titles."];
r = await ask({ kind: "tape", facts });
check("a count spelled out that the facts don't hold ('seven titles') is caught and retried", r.calls.length === 2 &&
  /\(7\)/.test(r.calls[1].body.messages[0].content) && r.status === 200 && !/seven/.test(r.json.breakdown));
const F = facts.map((f) => "- " + f).join("\n");
check("strict: a stray 1–3 is caught (no scouting-report leniency)", JSON.stringify(M.numbersInvented("Andy has 2 titles.", "Titles: Andy 1, JP 0", true)) === '["2"]' &&
  M.numbersInvented("Andy has 2 titles.", "Titles: Andy 1, JP 0").length === 0);
check("strict: counts in the facts pass, in digits or words; 'one' as a pronoun passes",
  M.numbersInvented("Andy is 3/4 on locks, three of four, and only one of them can win.", F, true).length === 0);
check("strict: the verdict path uses it", /numbersInvented\(text, iqFacts, true\)/.test(src) && !/numbersInvented\(text, iqFacts\);[^]*action === "fight-iq"/.test(src.slice(src.indexOf('if (action === "verdict") {\n    let bad'))));
replies = ["Andy's 42.5 points and 3/4 locks say he's the man; JP's 5/11 underdogs say otherwise."];
r = await ask({ kind: "tape", facts });
check("numbers that are in the facts pass untouched", r.status === 200 && r.calls.length === 1 && /42\.5/.test(r.json.breakdown));
replies = ["\"" + "Andy by a mile. ".repeat(40) + "\""];
r = await ask({ kind: "tape", facts });
check(`a runaway reply is cut to one line (≤${M.VERDICT_MAX_LINE} chars), quotes stripped`,
  r.status === 200 && r.json.breakdown.length <= M.VERDICT_MAX_LINE + 1 && !/^"/.test(r.json.breakdown));

for (const [name, v] of [
  ["no verdict at all", undefined],
  ["an unknown kind", { kind: "roast", facts }],
  ["no facts", { kind: "tape", facts: [] }],
  [`more than ${M.VERDICT_MAX_FACTS} facts`, { kind: "tape", facts: Array(M.VERDICT_MAX_FACTS + 1).fill("x") }],
  [`a fact over ${M.VERDICT_MAX_FACT} chars`, { kind: "tape", facts: ["x".repeat(M.VERDICT_MAX_FACT + 1)] }],
  ["a blank fact", { kind: "tape", facts: ["  "] }],
  ["a fact that isn't text", { kind: "tape", facts: [{ text: "x" }] }],
  [`a title over ${M.VERDICT_MAX_TITLE} chars`, { kind: "tape", title: "x".repeat(M.VERDICT_MAX_TITLE + 1), facts }],
]) {
  r = await ask(v);
  check(`${name} is a 400 with no model call`, r.status === 400 && r.calls.length === 0);
}
r = await ask({ kind: "tape", facts }, undefined, "Bearer anon");
check("the anon key alone is refused before any model call", r.status === 401 && r.calls.length === 0);
DB.rows.set("spent|all", M.AI_DAILY_CAP);
r = await ask({ kind: "tape", facts }, "spent");
check("it spends the shared daily AI budget (spent = 429, no model call)", r.status === 429 && r.json.error === "daily-cap" && r.calls.length === 0);

// Client caps match the server's.
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const cap = /var BOT_CALL_MAX_FACTS=(\d+),BOT_CALL_MAX_FACT=(\d+)/.exec(html);
check("the app never sends more facts, or longer ones, than the server takes", cap && +cap[1] <= M.VERDICT_MAX_FACTS && +cap[2] <= M.VERDICT_MAX_FACT);

// --no-browser: the handler half only, for deploy-functions.yml (no Chromium there).
if (process.argv.includes("--no-browser")) {
  if (failures) { console.error(`\ncheck-verdict: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncheck-verdict (no browser): FightBot's call says only what it's told.");
  process.exit(0);
}

// ── 2. The app ───────────────────────────────────────────────────────────────
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, ok));
const browser = await launchChromium(chromium);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const sent = [];
  let mode = "ok";
  await page.route(/supabase\.co/, (route) => {
    const req = route.request();
    if (/functions\/v1\/ai-breakdown/.test(req.url()) && req.method() === "POST") {
      const b = JSON.parse(req.postData() || "{}");
      sent.push(b);
      if (mode === "cap") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "daily-cap" }) });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ breakdown: "Call #" + sent.length + " for " + b.verdict.kind }) });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.addInitScript(() => {
    try { localStorage.setItem("ufc_whatsnew_seen", "9999"); localStorage.setItem("ufc_ai_consent", "1"); } catch {}
    // Capture what the share sheet would get.
    navigator.canShare = () => true;
    navigator.share = (d) => { window.__shared = d; return Promise.resolve(); };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "load" });
  await page.waitForTimeout(400);

  // A tape exactly as taleOfTheTape builds one.
  const T = {
    a: { name: "🥊 Andy", pts: 42.5 }, b: { name: "🦂 JP", pts: 39 },
    rows: [
      { label: "Accuracy", a: "64%", b: "58%", edge: 1 }, { label: "Underdogs", a: "30% (3/10)", b: "45% (5/11)", edge: 2 },
      { label: "Locks", a: "75% (3/4)", b: "50% (2/4)", edge: 1 }, { label: "Methods", a: "—", b: "20% (1/5)", edge: 0 },
      { label: "Streak", a: "4", b: "1", edge: 1 }, { label: "Head to head", a: "3", b: "2", edge: 1 }, { label: "Titles", a: "1", b: "0", edge: 1 },
    ],
    verdict: "JP has the better underdog record, but Andy has the better locks. Andy takes 5 of the columns.",
  };
  const mount = () => page.evaluate((t) => {
    document.querySelectorAll(".test-tape").forEach((e) => e.remove());
    const el = taleEl(t, "UFC 333"); el.classList.add("test-tape");
    el.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#111";
    document.body.appendChild(el);
    return { btn: !!el.querySelector(".bot-call-btn"), poster: !!el.querySelector(".tape-poster-btn"), verdict: el.querySelector(".tape-v").textContent };
  }, T);
  let st = await mount();
  check("the tape shows 🤖 FightBot's call and 🖼️ Share poster under the verdict", st.btn && st.poster && st.verdict === T.verdict);
  check("nothing is spent until someone taps", sent.length === 0);

  const facts = await page.evaluate((t) => tapeFacts(t), T);
  check("the facts are exactly the tape's lines (names, points, every column, the app's read)",
    facts.length === 9 && facts[0].includes("Andy") && facts[0].includes("42.5") && facts[0].includes("JP") &&
    T.rows.every((r) => facts.some((f) => f.startsWith(r.label + ":") && f.includes(r.a) && f.includes(r.b))) &&
    facts[8].includes(T.verdict) && !facts.join(" ").includes("🥊"));

  // The poster before any call.
  const poster = await page.evaluate((t) => {
    const a = drawTapePoster(document.createElement("canvas"), t, "UFC 333", null);
    const b = drawTapePoster(document.createElement("canvas"), t, "UFC 333", "Andy walks it.");
    const px = a.getContext("2d").getImageData(540, 700, 1, 1).data;
    return { w: a.width, h: a.height, painted: px[3] === 255, png: a.toDataURL().length, differs: a.toDataURL() !== b.toDataURL() };
  }, T);
  check("the poster is a 1080×1350 image, painted", poster.w === 1080 && poster.h === 1350 && poster.painted && poster.png > 20000);
  check("…and FightBot's call replaces the verdict on it once there is one", poster.differs);
  await page.waitForTimeout(400);
  await page.click(".test-tape .tape-poster-btn");
  await page.waitForTimeout(100);
  let shared = await page.evaluate(async () => {
    const s = window.__shared; if (!s || !s.files) return null;
    return { type: s.files[0].type, size: s.files[0].size, name: s.files[0].name, title: s.title };
  });
  check("Share poster hands the drawn PNG to the share sheet", shared && shared.type === "image/png" && shared.size > 20000 && shared.title === "Tale of the Tape");

  await page.evaluate(() => { window.__shared = null; });
  // Tap Share in the same task the call lands in: the pre-call poster must not go out.
  const early = await page.evaluate(() => new Promise((ok) => {
    const tape = document.querySelector(".test-tape");
    new MutationObserver((_, obs) => {
      if (!tape.querySelector(".bot-call-line")) return;
      obs.disconnect();
      tape.querySelector(".tape-poster-btn").click();
      ok(window.__shared);
    }).observe(tape, { childList: true, subtree: true });
    tape.querySelector(".bot-call-btn").click();
  }));
  check("Share tapped the moment the call lands never sends the stale pre-call poster", early === null);
  await page.waitForSelector(".test-tape .bot-call-line");
  const line = await page.textContent(".test-tape .bot-call-line");
  check("tapping asks once, as action verdict / kind tape, with the tape's facts and card", sent.length === 1 &&
    sent[0].action === "verdict" && sent[0].verdict.kind === "tape" && sent[0].verdict.title === "UFC 333" &&
    JSON.stringify(sent[0].verdict.facts) === JSON.stringify(facts));
  check("the call shows in place of the button", line === "🤖 Call #1 for tape" && !(await page.$(".test-tape .bot-call-btn")));
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__shared = null; });
  await page.click(".test-tape .tape-poster-btn");
  await page.waitForTimeout(100);
  const shared2 = await page.evaluate(() => window.__shared && window.__shared.files[0].size);
  check("the poster is redrawn with the call on it", shared2 && shared2 !== shared.size);

  st = await mount();
  check("the call is kept for the session: re-rendering the board shows it without asking again",
    !st.btn && sent.length === 1 && (await page.textContent(".test-tape .bot-call-line")) === "🤖 Call #1 for tape");
  check("…and it survives a reload (sessionStorage)", await page.evaluate(() => /Call #1/.test(sessionStorage.getItem("ufc_bot_calls") || "")));
  const T2 = { ...T, a: { ...T.a, pts: 43.5 } };
  const fresh = await page.evaluate((t) => !!taleEl(t, "UFC 333").querySelector(".bot-call-btn"), T2);
  check("new numbers (a point moved) ask again rather than reuse a stale call", fresh);
  const T3 = { ...T, rows: T.rows.map((r) => r.label === "Accuracy" ? { ...r, b: "59%" } : r) };
  check("…and so does any other column moving with the points unchanged (the key is every fact)",
    await page.evaluate((t) => !!taleEl(t, "UFC 333").querySelector(".bot-call-btn"), T3));

  // The Fight Night Report.
  mode = "cap";
  await page.evaluate(() => renderCardRecap({ date: "2026-10-03", evName: "UFC 332", title: { kind: "won", name: "🥊 Andy", pts: 9.5 },
    stories: [{ em: "💣", text: "Andy landed the biggest upset: Delta Four (+250) over Charlie Three" }, { em: "🔒", text: "JP went 2–0 on locks" }],
    me: null, standings: [] }));
  st = await page.evaluate(() => ({ btn: !!document.querySelector("#rc-body .bot-call-btn") }));
  check("the Card Recap's stories get 🤖 FightBot's call", st.btn);
  await page.click("#rc-body .bot-call-btn");
  await page.waitForFunction(() => /AI limit/.test(document.querySelector("#rc-body .bot-call-btn").textContent));
  const rq = sent[sent.length - 1];
  check("…told the title line and the stories, as kind report", rq.verdict.kind === "report" && rq.verdict.title === "UFC 332" &&
    rq.verdict.facts[0].includes("won the title") && rq.verdict.facts[1].includes("Delta Four (+250)") && rq.verdict.facts.length === 3);
  check("a spent allowance says so and leaves the button to try again later", await page.evaluate(() => !document.querySelector("#rc-body .bot-call-btn").disabled));
  mode = "ok";
  await page.click("#rc-body .bot-call-btn");
  await page.waitForSelector("#rc-body .bot-call-line");
  check("…and a retry that works shows the call", /for report/.test(await page.textContent("#rc-body .bot-call-line")));
  check("no page errors", !errors.length);
  if (errors.length) console.error("    " + errors.slice(0, 3).join("\n    "));
} finally {
  await browser.close();
  server.close();
}

if (failures) { console.error(`\ncheck-verdict: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-verdict: FightBot's call says only what the tape and the report say; the poster draws and shares.");
