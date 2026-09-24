// Guard: the AI Fight IQ scouting report says only what the numbers say, stays
// on Claude, varies its voice, and can't be run up into a bill.
//
// The write-up is prose around deterministic stats, so its one dangerous
// failure is the model inventing a number — a record, a percentage — that the
// app then shows as fact about someone's picks. That is enforced server-side
// (numbersInvented + one retry + a clean failure) and pinned here against the
// REAL ai-breakdown handler with a stubbed model.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

// A Grok key is set on purpose: the write-up is analysis and must stay on Claude.
const ENV = { SB_ANON_KEY: "anon", ANTHROPIC_API_KEY: "sk-test", GROK_API_KEY: "xai-test", RETRY_BACKOFF_MS: "1" };
let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };

let replies = [], calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init.body) });
  const text = replies.length ? replies.shift() : "You pick like a man who has read one wrestling book.";
  if (String(url).includes("x.ai")) return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 });
};

const src = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const M = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
check("ai-breakdown loads with the fight-iq helpers exported", typeof handler === "function" && Array.isArray(M.IQ_TONES) && typeof M.numbersInvented === "function");

const facts = {
  player: "Andy", archetype: "Dog Hunter", blurb: "Lives on the plus side of the line.",
  record: "111-58", accuracy: 65.7, points: 142.5, locks: "3-1", methodPct: 25.9, clv: -0.4,
  insights: ["Picking underdogs: you hit 31.8% of them (7–15).", "When you and Tristin disagree, you're 4–17."],
};
let seq = 0;
async function ask(over = {}, viewer) {
  calls = [];
  const res = await handler(new Request("https://fn/ai-breakdown", {
    method: "POST",
    headers: { Authorization: "Bearer anon", "Content-Type": "application/json", "x-forwarded-for": "10.0.0." + (++seq % 250) },
    body: JSON.stringify({ action: "fight-iq", iq: { ...facts, ...over }, viewerId: viewer ?? "viewer-" + seq }),
  }));
  return { status: res.status, json: await res.json(), calls };
}

// 1. A clean write-up.
let r = await ask();
check("a write-up comes back 200 with text and the voice it used", r.status === 200 && r.json.breakdown && M.IQ_TONES.includes(r.json.tone));
check("it is written by Claude, never Grok (even with a Grok key set)", r.calls.length === 1 && r.calls[0].url.includes("anthropic.com") && !r.calls.some((c) => c.url.includes("x.ai")));
const sys = r.calls[0].body.system, user = r.calls[0].body.messages[0].content;
check("the prompt carries FACTS ARE STRICT and the chosen voice", /FACTS ARE STRICT/.test(sys) && sys.includes(r.json.tone));
check("the prompt carries every fact and insight it was given", ["111-58", "65.7", "142.5", "3-1", "25.9", ...facts.insights].every((f) => user.includes(f)));
check("the gloves-off roast rule never reaches the write-up", !/unfiltered|profan|swear/i.test(sys));

// 2. The voice varies.
const tones = new Set();
for (let i = 0; i < 40; i++) tones.add((await ask()).json.tone);
check(`the voice varies between write-ups (${tones.size} different voices in 40)`, tones.size >= 3);

// 3. No invented numbers.
replies = ["You're 140-20 and the greatest ever."];
r = await ask();
check("an invented record triggers exactly one retry, naming the stray figures", r.calls.length === 2 && /140, 20|140|20/.test(r.calls[1].body.messages[0].content));
check("…and the clean retry is what's returned", r.status === 200 && !/140-20/.test(r.json.breakdown));
replies = ["You hit 90% of dogs.", "Still 90% of dogs, honestly."];
r = await ask();
check("a write-up that invents twice fails cleanly instead of shipping the number", r.status === 502 && !r.json.breakdown);
check("numbersInvented: stated figures pass, strays are caught", M.numbersInvented("You're 111-58 at 65.7% with 142.5 points.", user).length === 0 &&
  JSON.stringify(M.numbersInvented("You hit 20% and 7 of 9.", user)) === JSON.stringify(["20", "9"]));
check("numbersInvented: a flipped sign is a different number", JSON.stringify(M.numbersInvented("You gained +0.4 points.", user)) === JSON.stringify(["0.4"]) &&
  M.numbersInvented("The market moved -0.4 against you.", user).length === 0);
check("numbersInvented: a record's hyphen is not a minus sign", M.numbersInvented("A 111-58 record.", user).length === 0);
check("the prompt asks for numbers exactly as given, sign included", /sign included/.test(sys) && /negative = the market moved against/.test(user));
check("numbersInvented: small counting numbers are ordinary phrasing", M.numbersInvented("Your top 3 and round 1.", user).length === 0);

// 4. The daily cap.
const who = "cap-tester";
const codes = [];
for (let i = 0; i < M.IQ_DAILY_CAP + 1; i++) codes.push((await ask({}, who)).status);
check(`a viewer gets ${M.IQ_DAILY_CAP} a day, then 429 daily-cap`, codes.slice(0, M.IQ_DAILY_CAP).every((c) => c === 200) && codes[M.IQ_DAILY_CAP] === 429);
r = await ask({}, who);
check("a capped request never reaches the model", r.calls.length === 0 && r.json.error === "daily-cap");
check("another viewer is unaffected", (await ask({}, "someone-else")).status === 200);
check("the cap resets on a new UTC day", M.iqCapReached("day-roll", Date.parse("2026-09-24T12:00:00Z")) === false &&
  [0, 1].every(() => M.iqCapReached("day-roll", Date.parse("2026-09-24T13:00:00Z")) === false) &&
  M.iqCapReached("day-roll", Date.parse("2026-09-24T14:00:00Z")) === true &&
  M.iqCapReached("day-roll", Date.parse("2026-09-25T00:10:00Z")) === false);

// 5. Input bounds: cost can't be inflated through the facts.
r = await ask({ insights: Array(9).fill("x") });
check("more than 8 insights is rejected before any model call", r.status === 400 && r.calls.length === 0);
r = await ask({ insights: ["x".repeat(201)] });
check("an insight over 200 chars is rejected", r.status === 400 && r.calls.length === 0);
r = await ask({ record: "" });
check("missing facts are a 400, not a guess", r.status === 400 && r.calls.length === 0);

if (failures) { console.error(`\ncheck-iq: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-iq: the scouting report says only what the numbers say.");
