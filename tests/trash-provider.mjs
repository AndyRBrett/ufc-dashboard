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
let ENV = {};
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const FULL = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8");
const src = FULL.split("Deno.serve(")[0];
const handler = FULL.slice(FULL.indexOf("Deno.serve("));
const { code } = esbuild.transformSync(
  src + "\nexport { buildTrashTalk, trashTalkProvider, unfilteredRule, callGrok, callAnthropic, GROK_MODEL, GROK_MAX_TOKENS, MODEL };",
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

let bad = 0;
for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
if (bad) { console.error(`\ntrash-provider: FAILED (${bad} assertion(s)) — DO NOT deploy.`); process.exit(1); }
console.log("\ntrash-provider: the roast runs unfiltered on Grok, analysis stays on Claude, and a Grok outage falls back clean.");
