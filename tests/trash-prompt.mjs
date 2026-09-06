// Trash-talk prompt assembly test.
//
// The roast is the one prompt here where structure decides whether the feature
// works at all. It used to be wrapped in the chat template, so the model opened
// on "You are a UFC picks expert helping a fan make decisions on this card" and
// closed on "Answer only the question" — with the sender's typed angle demoted
// to a field in the middle. Roasts came back as picks commentary and a typed
// angle could vanish outright. Nothing else in the gate set can see that: the
// function parses and the app boots either way. So assert the shape directly —
// who the model is told it is, and what the last thing it reads is.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

globalThis.Deno = { env: { get: () => undefined } };
const src = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8").split("Deno.serve(")[0];
const { code } = esbuild.transformSync(src + "\nexport { buildTrashTalk, usesAngle, angleKeywords };", { loader: "ts", format: "esm" });
const { buildTrashTalk, usesAngle } = await import("data:text/javascript," + encodeURIComponent(code));

const base = {
  persona: "Johnny Lawrence", myNickname: "AB", myRank: 2, myRecord: "30-100",
  targets: ["T"], lbMode: "all", card: "Hooker vs Parnasse",
};
const HINT = "wax on wax off those tears you've been crying";

const checks = [];
const assert = (name, cond) => checks.push({ name, cond: !!cond });

const withHint = buildTrashTalk({ ...base, hint: HINT });
const noHint = buildTrashTalk({ ...base });

// The roast must never inherit the analyst framing again.
for (const [label, p] of [["with an angle", withHint], ["without one", noHint]]) {
  const all = p.system + "\n" + p.user;
  assert(`no picks-expert framing ${label}`, !/UFC picks expert|helping a fan make decisions/.test(all));
  assert(`no chat-template closer ${label}`, !/Answer only the question/.test(all));
  assert(`the persona is who the model IS ${label}`, /^You ARE Johnny Lawrence\./.test(p.system));
  assert(`analysis is ruled out ${label}`, /NOT an analyst/.test(p.system));
}

// The angle has to be the last thing the model reads — that position was
// previously owned by the chat template's own instruction.
assert("the angle reaches the user turn", withHint.user.includes(HINT));
assert("the angle is stated as the whole job", /THE ANGLE: "/.test(withHint.user));
assert("the angle lands in the final stretch of the prompt",
  withHint.user.length - withHint.user.lastIndexOf(HINT) < 400);
assert("the model is told to reuse the angle's own words", /angle's own words and imagery verbatim/.test(withHint.user));
assert("swapping the angle for a generic burn is ruled out", /do not swap it for a generic insult/i.test(withHint.user));
assert("paraphrasing the angle is ruled out", /Do not paraphrase it/.test(withHint.user));
// The system prompt defines the whole job; an angle that only appears in the
// user turn leaves every rule about HOW to write blind to it.
assert("the angle reaches the system prompt too", withHint.system.includes(HINT));
assert("the system prompt demands the words back", /WORD FOR WORD/.test(withHint.system));
assert("the final line hands the angle over verbatim", withHint.user.trim().endsWith(`"${HINT}"`));

// The randomised canned angles are the main thing that used to compete.
const CANNED = ["Write them off as a clueless nobody", "Trash their whole vibe", "Tell them to find a new hobby",
  "Question whether they even understand how the sport works", "Act like you can barely remember their name",
  "Treat their confidence as the funniest part", "Pity them", "beneath"];
const withHintAll = withHint.system + withHint.user;
assert("no canned angle competes with the user's", !CANNED.some((a) => withHintAll.includes(a)));
assert("a canned angle IS the ask when the user gave none", CANNED.some((a) => noHint.user.includes(a)));

// Everything else that can pull off-angle is subordinated, not silent — and the
// random rhetorical shape, which competed hardest, is not applied at all.
const FORMS = ["one clipped, dismissive line", "open mid-thought", "a fake compliment that curdles",
  "a rhetorical question you never let them answer", "a single devastating one-liner",
  "a cold quiet threat", "one absurd comparison", "start bored, snap into contempt"];
assert("no random shape competes with the angle", !/Shape THIS one like/.test(withHintAll) && !FORMS.some((f) => withHintAll.includes(f)));
assert("a shape still varies the roast when no angle was typed", /Shape THIS one like/.test(noHint.system));
assert("the card detail yields to the angle", /only if it serves the angle/.test(withHint.system));
assert("the profile dossier yields to the angle", /only if it sharpens the angle/.test(withHint.system));
assert("the dossier keeps its own rule with no angle", /makes the burn funnier than the picks/.test(noHint.system));
assert("the card is demoted to background", /background only/.test(withHint.user));

// Accuracy, length and the signature are NOT subordinated to the angle.
assert("accuracy rules survive an angle", /FACTS ARE STRICT/.test(withHint.system));
assert("the length cap survives an angle", /LENGTH IS A HARD CAP/.test(withHint.system));
assert("the signature rule survives an angle", /Sign off with '— Johnny Lawrence'/.test(withHint.system));

// A blank box is not an angle.
const blank = buildTrashTalk({ ...base, hint: "   " });
assert("whitespace-only input is not an angle", !/THE ANGLE:/.test(blank.user) && CANNED.some((a) => blank.user.includes(a)));

// Odd input shouldn't mangle the prompt around it.
const quoted = buildTrashTalk({ ...base, hint: 'he "always" folds' });
assert("quotes in an angle pass through intact", quoted.user.includes('he "always" folds') && /THE ANGLE: "/.test(quoted.user));

// Prompting alone never fully held, so the function also checks its own output
// and retries once. These are the cases that check has to get right.
assert("a roast carrying the angle's words passes",
  usesAngle("Wax on, wax off those tears, kid. — Johnny Lawrence", HINT));
assert("a generic burn that ignored the angle fails",
  !usesAngle("You're rank two with a losing record and it shows. — Johnny Lawrence", HINT));
assert("a near-verbatim delivery survives grammar drift",
  usesAngle("Wax on, wax off — go cry about it. Those tears wax nothing. — Johnny Lawrence", HINT));
assert("a paraphrase that keeps the topic but not the words fails",
  !usesAngle("Karate Kid stuff won't save you now. — Johnny Lawrence", HINT));
assert("an angle with no content words can't fail the check", usesAngle("anything at all", "the and but"));

let bad = 0;
for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
if (bad) { console.error(`\ntrash-prompt: FAILED (${bad} assertion(s)) — DO NOT deploy.`); process.exit(1); }
console.log("\ntrash-prompt: the roast is written as the persona, and ends on the sender's angle.");
