// Trash-talk provider routing test.
//
// The roast now runs on Grok and the rest of ai-breakdown still runs on Claude.
// That split has four ways to go quietly wrong, none of which any other gate can
// see — the function parses, the app boots, and a roast still comes back:
//
//   1. an analysis action (breakdown / chat / parlay) silently routed to Grok,
//      which is a different model answering questions about real fights;
//   2. the gloves-off suffix leaking into those analysis prompts;
//   3. the Grok→Claude fallback re-sending the UNFILTERED system prompt to
//      Anthropic, or rebuilding the prompt and losing the angle the first
//      attempt was given;
//   4. an OpenAI-shaped response read with Anthropic's accessor (or the
//      reverse), which yields an empty roast rather than an error.
//
// So assert the routing rules directly, and exercise both callers against a
// stubbed fetch so the wire format is checked rather than assumed.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

// Swappable env so provider selection can be tested under each configuration.
//
// GROK_TIMEOUT_MS is overridden to something tiny for the whole module, because
// the timeout test has to actually WAIT one out. At the real 8s default this
// single test would add eight seconds to `npm run verify`, and the gate set's
// whole promise is that it is fast enough to run before every push. The real
// default is asserted separately, by reading it out of the source. RETRY_BACKOFF_MS
// is squashed for the same reason: three retry-path tests at real backoff spend
// ~13s of `verify` asleep.
let ENV = { GROK_TIMEOUT_MS: "250", RETRY_BACKOFF_MS: "1" };
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const FULL = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8");
const src = FULL.split("Deno.serve(")[0];
const handler = FULL.slice(FULL.indexOf("Deno.serve("));
const { code } = esbuild.transformSync(
  src + "\nexport { buildTrashTalk, trashTalkProvider, unfilteredRule, callGrok, callAnthropic, GROK_MODEL, GROK_MAX_TOKENS, MODEL, clampRoast, ROAST_MAX_CHARS, GROK_TIMEOUT_MS, ROAST_RETRY_BUDGET_MS };",
  { loader: "ts", format: "esm" },
);
const M = await import("data:text/javascript," + encodeURIComponent(code));

const checks = [];
const assert = (name, cond) => checks.push({ name, cond: !!cond });

// ── Which model writes the roast ───────────────────────────────────────────
// Deploying the function without a Grok key must change nothing. This is the
// property that makes the rollout safe: the code ships before the secret does.
ENV = {};
assert("no Grok key falls back to Claude", M.trashTalkProvider("") === "claude");
assert("a Grok key routes the roast to Grok", M.trashTalkProvider("xai-abc") === "grok");
// The kill switch, for when the tone goes wrong or xAI bills badly.
for (const v of ["claude", "Claude", " ANTHROPIC "]) {
  ENV = { TRASH_TALK_PROVIDER: v };
  assert(`TRASH_TALK_PROVIDER=${JSON.stringify(v)} forces Claude even with a key`,
    M.trashTalkProvider("xai-abc") === "claude");
}
ENV = { TRASH_TALK_PROVIDER: "grok" };
assert("TRASH_TALK_PROVIDER=grok with no key still degrades to Claude",
  M.trashTalkProvider("") === "claude");
ENV = {};

// ── The gloves-off rule ────────────────────────────────────────────────────
const rule = M.unfilteredRule("Johnny Lawrence");
assert("the rule actually licenses profanity", /swear/i.test(rule) && /crude/i.test(rule));
assert("the rule is spoken in the sender's persona", rule.includes("Johnny Lawrence"));
// The floor is one line and it is word-level: no slurs. It is asserted here so
// that it cannot be dropped by accident — a prompt tweak aimed at making the
// roast rawer should not quietly take it with it.
assert("slurs stay ruled out", /no slurs/i.test(rule));
assert("the slur rule is the ONLY rule", /ONE rule, and it is the only one/i.test(rule));
// The topic bans deliberately came out: they were catching ordinary roast
// material (the Eminem likeness, AB and Tristin being married) and the threat
// ban contradicted the comedic-menace form this same prompt offers. If either
// reappears, someone has re-tightened the floor without saying so.
assert("no blanket topic ban came back",
  !/race, religion, sex, gender, disability or sexuality/i.test(rule));
assert("the threat ban did not come back", !/threat of real violence/i.test(rule));
assert("the rule says no subject is off-limits", /off-limits/i.test(rule) && /fair game/i.test(rule));

// It must be a pure SUFFIX. The fallback strips it by re-sending the stored
// filtered system prompt, which is only equivalent if appending was the only
// difference — a flag threaded through buildTrashTalk would re-roll the random
// angle, form and seed and quietly discard the first attempt's framing.
const built = M.buildTrashTalk({
  persona: "Johnny Lawrence", myNickname: "AB", targets: ["T"], lbMode: "all", card: "x",
});
const unfiltered = built.system + M.unfilteredRule("Johnny Lawrence");
assert("the unfiltered prompt is the filtered one plus the rule",
  unfiltered.startsWith(built.system) && unfiltered.slice(built.system.length) === rule);
assert("the rule lands last, where the model weights it hardest",
  unfiltered.endsWith(rule));
// Length, accuracy and the signature are not relaxed by going unfiltered.
assert("the length cap survives the rule", /LENGTH IS A HARD CAP/.test(unfiltered));
assert("accuracy survives the rule", /FACTS ARE STRICT/.test(unfiltered));
assert("the signature survives the rule", /Sign off with '— Johnny Lawrence'/.test(unfiltered));

// ── Routing, read off the handler ──────────────────────────────────────────
// Only the roast branch may pick a provider or attach the rule; a breakdown is
// a claim about a real fight and stays on the model the rest of the app trusts.
assert("provider defaults to claude in the handler", /let provider: Provider = "claude"/.test(handler));
const trashBranch = handler.slice(handler.indexOf('action === "trash-talk"'));
assert("only the roast branch selects a provider",
  (handler.match(/trashTalkProvider\(/g) || []).length === 1 &&
  trashBranch.includes("trashTalkProvider("));
assert("only the roast branch attaches the gloves-off rule",
  (handler.match(/unfilteredRule\(/g) || []).length === 1 &&
  trashBranch.includes("unfilteredRule("));
// The fallback: same user turn, filtered system, no rebuild.
assert("the fallback restores the filtered system prompt",
  /provider = "claude";[\s\S]{0,200}system = claudeSystem;/.test(handler));
assert("the fallback does not rebuild the prompt",
  (handler.match(/buildTrashTalk\(/g) || []).length === 1);
assert("a Grok failure with no Anthropic key surfaces rather than looping",
  /if \(\(r\.ok && r\.text\.trim\(\)\) \|\| !apiKey\) return r;/.test(handler));
// A reasoning model handed too tight a budget answers 200 with empty content:
// the budget covers its internal reasoning, not just the reply. That is a dud
// roast, not a success, and it used to reach the client as the generic
// "No trash talk generated." with nothing logged to explain it.
assert("a blank-but-successful Grok reply is treated as a failure",
  /r\.ok && r\.text\.trim\(\)/.test(handler));
assert("the empty-roast case is distinguished in the log",
  /empty roast \(token budget exhausted\?\)/.test(handler));
// The roast's length is held by the prompt, so Grok's ceiling exists purely to
// leave reasoning room. Reusing Claude's 120 here is the bug this guards.
assert("Grok gets its own token ceiling, not the roast's prompt-level cap",
  /callGrok\(grokKey, \{ system, user: userText, maxTokens: GROK_MAX_TOKENS \}\)/.test(handler));
assert("the Claude fallback keeps the tight cap", /callAnthropic\(apiKey, \{ system, user: userText, maxTokens \}\)/.test(handler));
assert("Grok's ceiling leaves real reasoning room", M.GROK_MAX_TOKENS >= 500);

// ── Wire format, against a stubbed fetch ───────────────────────────────────
const calls = [];
const stub = (status, payload) => {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
};

stub(200, { choices: [{ message: { content: "get fucked, kid — Johnny Lawrence" } }] });
let r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("Grok's reply is read from choices[0].message.content",
  r.ok && r.text === "get fucked, kid — Johnny Lawrence");
assert("Grok is called at the xAI chat-completions endpoint",
  calls[0].url === "https://api.x.ai/v1/chat/completions");
assert("Grok gets bearer auth, not an x-api-key",
  calls[0].init.headers["authorization"] === "Bearer xai-key" &&
  !("x-api-key" in calls[0].init.headers));
assert("the system prompt rides as a system-role message",
  calls[0].body.messages[0].role === "system" && calls[0].body.messages[0].content === "SYS" &&
  calls[0].body.messages[1].role === "user" && calls[0].body.messages[1].content === "USR" &&
  !("system" in calls[0].body));
assert("the roast's token cap reaches Grok", calls[0].body.max_tokens === 120);
assert("Grok's model is the configured one", calls[0].body.model === M.GROK_MODEL);

calls.length = 0;
stub(200, { content: [{ text: "tamer burn — Johnny Lawrence" }] });
r = await M.callAnthropic("sk-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("Claude's reply is still read from content[0].text",
  r.ok && r.text === "tamer burn — Johnny Lawrence");
assert("Claude still gets a top-level system field, not a system message",
  calls[0].body.system === "SYS" && calls[0].body.messages.length === 1);
assert("Claude still gets x-api-key auth", calls[0].init.headers["x-api-key"] === "sk-key");

// A failure reports its status and detail instead of an empty-string roast that
// would be sent to the board as if the model had written it.
calls.length = 0;
stub(400, { error: "bad request" });
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("a Grok failure is reported as a failure", !r.ok && r.status === 400 && r.text === "");
assert("a 400 is not retried — it fails the same way three times", calls.length === 1);

calls.length = 0;
stub(503, { error: "unavailable" });
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("a transient Grok status is retried", calls.length === 3 && !r.ok);

// ── Transport failures must not escape the caller ──────────────────────────
// A DNS failure, TLS error or connection reset makes fetch REJECT rather than
// resolve with a status. An exception thrown out of callGrok skips callModel's
// Claude fallback entirely and fails the whole request — the fallback would
// miss the one shape a real outage actually takes.
calls.length = 0;
let attempts = 0;
globalThis.fetch = async () => { attempts++; throw new TypeError("error sending request: connection reset"); };
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("a transport error resolves instead of throwing", r && r.ok === false);
assert("a transport error reports status 0, not a fake HTTP code", r.status === 0);
assert("the transport error's cause survives for the log", /connection reset/.test(r.detail));
assert("a transport error is retried like any transient failure", attempts === 3);
// Same guarantee on the Claude side, which is where the fallback lands.
attempts = 0;
r = await M.callAnthropic("sk-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("the Claude caller is equally throw-proof", r.ok === false && r.status === 0);

// A 200 carrying something that isn't the expected JSON must not throw either.
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
  text: async () => "<html>502 Bad Gateway</html>",
});
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
assert("a non-JSON 200 yields an empty roast rather than an exception",
  r.ok === true && r.text === "");

// ── The roast's hard length bound ──────────────────────────────────────────
// GROK_MAX_TOKENS raised the programmatic ceiling to 1000 (~4000 chars), while
// send-push still rejects a body over MAX_BODY. Without a bound here the
// sender reads a roast on screen and then cannot send it: 200 from this
// function, 400 from send-push, nothing they can do.
const MAX_BODY = Number(
  readFileSync(join(ROOT, "supabase/functions/send-push/index.ts"), "utf8")
    .match(/MAX_BODY\s*=\s*(\d+)/)[1],
);
assert("send-push's MAX_BODY was found, so this test is actually comparing something",
  MAX_BODY > 0);
assert("a compliant roast is left completely untouched",
  M.clampRoast("Wax on, wax off those tears, kid.", M.ROAST_MAX_CHARS) ===
  "Wax on, wax off those tears, kid.");
const runaway = ("You absolute clown, you pick like a concussed toddler. ").repeat(100);
const clamped = M.clampRoast(runaway, M.ROAST_MAX_CHARS);
assert("a runaway roast is cut to the bound", clamped.length <= M.ROAST_MAX_CHARS);
assert("the cut lands on a sentence end so it still reads as a line", /[.!?]$/.test(clamped));
// The signature is appended AFTER the clamp, so the real wire length is
// clamp + signature. That total is what has to clear MAX_BODY.
const signed = M.clampRoast(runaway, M.ROAST_MAX_CHARS) + " — " + "x".repeat(100);
assert("clamped roast plus the longest possible signature still fits send-push",
  signed.length < MAX_BODY);
assert("the bound leaves a compliant roast far more room than it needs",
  M.ROAST_MAX_CHARS > 300);
// No sentence end to fall back on — a word boundary and an ellipsis, never a
// mid-word chop.
// Distinct words, so a mid-word chop is actually detectable — a fixture of one
// repeated word cannot tell the two apart.
const words = Array.from({ length: 400 }, (_, i) => `insult${i}`);
const noStops = M.clampRoast(words.join(" "), M.ROAST_MAX_CHARS);
const lastTok = noStops.replace(/…$/, "").split(" ").pop();
assert("a roast with no sentence end is cut at a word boundary",
  noStops.length <= M.ROAST_MAX_CHARS && noStops.endsWith("…") && words.includes(lastTok));

// ── The reported provider describes the TEXT, not the last call ────────────
// The angle retry can fail over to Claude and still have its output rejected,
// leaving Grok's original text in hand. Reporting "claude" there points
// debugging at the wrong model in exactly the case this metadata is for.
assert("the response reports the text's provider, not the live one",
  /provider: textProvider/.test(handler) && /textProvider === "grok" \? GROK_MODEL : MODEL/.test(handler));
assert("the fallback flag is snapshotted with the text too",
  /textFellBack \? \{ fellBack: true \}/.test(handler));
assert("the snapshot moves only when the retry's text is accepted",
  /text = retry\.text;\s*textProvider = provider;\s*textFellBack = fellBack;/.test(handler));
assert("the clamp runs before the signature, so the signature survives it",
  /enforceSignature\(clampRoast\(text, ROAST_MAX_CHARS\)/.test(handler));

// ── Latency: the roast is generated while someone watches a spinner ────────
// The shipped default is the only Grok model measured on this workload — 1.7s
// end to end, against ~2s for the Claude path it replaced. Three things keep a
// slow roast from shipping: a non-reasoning default, a bounded wait, and a
// retry that doesn't fire when the first call was already slow.

// 1. The default model does not reason.
assert("the default Grok model is a non-reasoning one",
  /non-reasoning/.test(M.GROK_MODEL));

// 2. Grok calls are bounded, and the bound is not applied to Claude — which is
//    the fallback of last resort, so aborting it would leave nothing to return.
assert("Grok's call is given a timeout",
  /fetchWithRetry\(GROK_API_URL[\s\S]{0,260}\}, GROK_TIMEOUT_MS\)/.test(src));
assert("the Claude call is deliberately not timed out",
  !/fetchWithRetry\(CLAUDE_API_URL[\s\S]{0,260}\}, GROK_TIMEOUT_MS\)/.test(src));
// Read the shipped defaults out of the source, not from the module — the module
// is loaded with a tiny timeout injected so the wait-it-out test stays fast.
const shippedDefault = (name) => {
  const m = src.match(new RegExp(`${name} = Number\\(Deno\\.env\\.get\\("${name}"\\) \\?\\? "(\\d+)"\\)`));
  return m ? Number(m[1]) : NaN;
};
const TIMEOUT_DEFAULT = shippedDefault("GROK_TIMEOUT_MS");
const RETRY_BUDGET_DEFAULT = shippedDefault("ROAST_RETRY_BUDGET_MS");
// The test squashes the backoff to keep `verify` fast; production must not be
// squashed with it, or a retry storm hits the provider with no spacing at all.
const BACKOFF_DEFAULT = shippedDefault("RETRY_BACKOFF_MS");
assert("the shipped retry backoff is real, not the test's squashed one",
  BACKOFF_DEFAULT >= 500);
assert("the shipped timeout default was found", Number.isFinite(TIMEOUT_DEFAULT));
assert("the shipped timeout is short enough to matter — nobody waits 23s for a joke",
  TIMEOUT_DEFAULT <= 10000);
assert("the shipped timeout still allows a normal call to finish", TIMEOUT_DEFAULT >= 3000);

// A timed-out call must resolve as a failure (so the fallback runs) and must
// NOT be retried — retrying three times multiplies the exact latency the
// timeout exists to bound, which is worse than having no timeout at all.
calls.length = 0;
attempts = 0;
globalThis.fetch = async (_url, init) => {
  attempts++;
  return await new Promise((_resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init?.signal?.aborted) return onAbort();
    init?.signal?.addEventListener("abort", onAbort);
  });
};
const t0 = Date.now();
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
const elapsed = Date.now() - t0;
assert("a hung Grok call is aborted rather than hanging forever", r.ok === false);
assert("a timeout is reported as a transport-class failure", r.status === 0);
assert("the timeout says so, so it is not confused with a reset",
  /timed out after/.test(r.detail));
assert("a timeout is NOT retried — that would multiply the latency it bounds",
  attempts === 1);
assert("the whole call returns within about one timeout, not three",
  elapsed < 2000);

// The deadline covers the WHOLE sequence, not each attempt. This is the case a
// per-attempt timer misses entirely: a slow but *retryable* response is not an
// abort, so breaking on abort does nothing for it. Three of them, each given a
// fresh timer, plus the backoffs that sit between them, used to spend roughly
// 3x the advertised bound before the fallback ran.
calls.length = 0;
attempts = 0;
// Each attempt must be given the REMAINING budget. Asserted structurally as
// well as behaviourally: `left() <= 0` between attempts masks a per-attempt
// timer well enough that timing alone barely separates them, and a timing-only
// assertion loose enough to be stable is too loose to catch the regression.
assert("every attempt's timer is the remaining budget, not a fresh one",
  /setTimeout\(\(\) => ctl\.abort\(\), left\(\)\)/.test(src) &&
  !/ctl\.abort\(\), timeoutMs\)/.test(src));
// The backoff is spent from the same budget. Unobservable in this test (backoff
// is squashed to 1ms to keep `verify` fast), so it is pinned structurally.
assert("the backoff counts against the deadline rather than sitting on top of it",
  /if \(deadline && wait >= left\(\)\)/.test(src));

globalThis.fetch = async (_url, init) => {
  attempts++;
  // Slow enough that a second full attempt cannot fit inside the deadline —
  // which is what makes the correct behaviour and the per-attempt-timer
  // regression separable by wall clock at all.
  //
  // This stub HONOURS the abort signal, because real fetch does. An earlier
  // version just slept and ignored it: the abort fired on schedule and the
  // fake request sailed on past it, so the test measured the stub's behaviour
  // rather than the deadline's and failed against correct code.
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, 200);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    if (init?.signal?.aborted) return onAbort();
    init?.signal?.addEventListener("abort", onAbort);
  });
  return { ok: false, status: 503, text: async () => "busy", json: async () => ({}) };
};
const slowStart = Date.now();
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
const slowTotal = Date.now() - slowStart;
assert("a slow retryable response still ends as a failure", r.ok === false);
assert("slow retries cannot outrun the deadline",
  slowTotal < M.GROK_TIMEOUT_MS * 1.3);

// The body is read inside the timer too: fetch resolves on headers, so a
// response that sends headers and then stalls its body would otherwise hang
// past the deadline with the fallback still waiting on it.
attempts = 0;
globalThis.fetch = async (_url, init) => {
  attempts++;
  return {
    ok: true, status: 200,
    json: async () => ({}),
    text: () => new Promise((_res, rej) => {
      const onAbort = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init?.signal?.aborted) return onAbort();
      init?.signal?.addEventListener("abort", onAbort);
    }),
  };
};
const stallStart = Date.now();
r = await M.callGrok("xai-key", { system: "SYS", user: "USR", maxTokens: 120 });
const stallTotal = Date.now() - stallStart;
assert("a stalled body is aborted, not waited on forever", r.ok === false);
assert("a stalled body is bounded by the same deadline",
  stallTotal < M.GROK_TIMEOUT_MS * 2);

// 3. The angle retry is a second full model call, so it is skipped when the
//    first one already spent the budget.
assert("the retry budget is read before spending a second call",
  /timeLeftForRetry = Date\.now\(\) - startedAt < ROAST_RETRY_BUDGET_MS/.test(handler));
assert("the angle retry is gated on that budget",
  /trashHint && timeLeftForRetry && !usesAngle/.test(handler));
assert("the shipped retry budget was found", Number.isFinite(RETRY_BUDGET_DEFAULT));
assert("the budget sits below the timeout, so a maxed-out first call buys no retry",
  RETRY_BUDGET_DEFAULT < TIMEOUT_DEFAULT);
assert("the budget still leaves a fast first call room to use its retry",
  RETRY_BUDGET_DEFAULT >= 3000);

let bad = 0;
for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
if (bad) { console.error(`\ntrash-provider: FAILED (${bad} assertion(s)) — DO NOT deploy.`); process.exit(1); }
console.log("\ntrash-provider: the roast runs unfiltered on Grok, analysis stays on Claude, and a Grok outage falls back clean.");
