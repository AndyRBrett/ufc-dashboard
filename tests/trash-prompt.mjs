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
// The angle is a springboard on Grok, not a script: the model may reword and
// build on it, but it must stay the subject.
assert("the model is free to rework the angle", /Rephrase it, exaggerate it and escalate it/.test(withHint.user));
assert("the angle stays the subject throughout", /keep it the subject throughout/.test(withHint.user));
assert("swapping the angle for a generic burn is ruled out", /do not swap it for a generic insult/i.test(withHint.user));
assert("verbatim delivery is no longer demanded", !/WORD FOR WORD|verbatim —|Do not paraphrase it/.test(withHint.system + withHint.user));
// The system prompt defines the whole job; an angle that only appears in the
// user turn leaves every rule about HOW to write blind to it.
assert("the angle reaches the system prompt too", withHint.system.includes(HINT));
assert("the system prompt makes the angle the subject", /THE ANGLE IS THE SUBJECT/.test(withHint.system));
assert("the system prompt treats it as a springboard", /springboard, not a script/.test(withHint.system));
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
const FORMS = ["open mid-thought", "a fake compliment that curdles",
  "a string of rhetorical questions", "a cold quiet threat", "one absurd comparison",
  "start bored, snap into contempt", "a mock pep talk", "a slow build to one devastating"];
assert("no random shape competes with the angle", !/Shape THIS one like/.test(withHintAll) && !FORMS.some((f) => withHintAll.includes(f)));
assert("a shape still varies the roast when no angle was typed", /Shape THIS one like/.test(noHint.system));
assert("the card detail yields to the angle", /only if it serves the angle/.test(withHint.system));
assert("the profile dossier yields to the angle", /only if it builds on the angle/.test(withHint.system));
assert("the dossier keeps its own rule with no angle", /makes the burn funnier than the picks/.test(noHint.system));
assert("the card is demoted to background", /background only/.test(withHint.user));

// Accuracy, length and the signature are NOT subordinated to the angle.
assert("accuracy rules survive an angle", /FACTS ARE STRICT/.test(withHint.system));
assert("the length cap survives an angle", /LENGTH IS A HARD CAP/.test(withHint.system));
// Room for a real riff now, but still a bounded one.
for (const [label, p] of [["with an angle", withHint], ["without one", noHint]]) {
  assert(`the roast gets two to four sentences ${label}`, /TWO to FOUR sentences/.test(p.system) && /two to four sentences/.test(p.user));
  assert(`the word cap is 70 ${label}`, /under 70 words/.test(p.system));
  assert(`the old one-line cap is gone ${label}`, !/under 30 words|one savage line|one or two short sentences/.test(p.system + p.user));
}
assert("the signature rule survives an angle", /Sign off with '— Johnny Lawrence'/.test(withHint.system));

// A blank box is not an angle.
const blank = buildTrashTalk({ ...base, hint: "   " });
assert("whitespace-only input is not an angle", !/THE ANGLE:/.test(blank.user) && CANNED.some((a) => blank.user.includes(a)));

// Odd input shouldn't mangle the prompt around it.
const quoted = buildTrashTalk({ ...base, hint: 'he "always" folds' });
assert("quotes in an angle pass through intact", quoted.user.includes('he "always" folds') && /THE ANGLE: "/.test(quoted.user));

// The function still checks its own output and retries once — but only when
// the roast walked away from the angle entirely, since rewording it is allowed.
assert("a roast carrying the angle's words passes",
  usesAngle("Wax on, wax off those tears, kid. — Johnny Lawrence", HINT));
assert("a generic burn that ignored the angle fails",
  !usesAngle("You're rank two with a losing record and it shows. — Johnny Lawrence", HINT));
assert("a near-verbatim delivery survives grammar drift",
  usesAngle("Wax on, wax off — go cry about it. Those tears wax nothing. — Johnny Lawrence", HINT));
assert("a reworked riff that keeps the idea passes",
  usesAngle("Mop up the waterworks, princess — all that crying won't fix your picks. — Johnny Lawrence", HINT));
assert("a burn with none of the angle's words still fails",
  !usesAngle("Karate Kid stuff won't save you now. — Johnny Lawrence", HINT));
// With a one-word bar, generic board vocabulary or a name must not count.
const SLOT = "compare his picks to a broken slot machine";
assert("a generic burn that only repeats 'picks' fails",
  !usesAngle("Your picks are embarrassing. — Johnny Lawrence", SLOT));
assert("the distinctive image still passes", usesAngle("You pick like a busted slot machine. — Johnny Lawrence", SLOT));
assert("a target's name is no evidence the angle was used",
  !usesAngle("Torrey, you're a joke. — Johnny Lawrence", "Torrey cries at dog movies", ["AB", "Torrey"]));
assert("the rest of a name-bearing angle still counts",
  usesAngle("Bet you sob at every dog movie. — Johnny Lawrence", "Torrey cries at dog movies", ["AB", "Torrey"]));
assert("an angle with no content words can't fail the check", usesAngle("anything at all", "the and but"));

// Profiles: ONE target's, picked at random, and never the sender's. Prompt
// rules alone kept losing — Torrey's own "Soft Hands" came back as a brag, and
// his Dallas move was pinned on the whole board twice with a rule against it
// in the prompt. What the model isn't given, it can't misattribute.
const BIOS = { T: /Soft Hands|Dallas/, AB: /kids' martial arts/, Tristin: /AB's wife/, JPeso: /flipped his car/ };
const biosIn = (sys) => Object.keys(BIOS).filter((k) => BIOS[k].test(sys));
let senderLeaked = false, multi = false, seenTargets = new Set();
for (let i = 0; i < 40; i++) {
  const r = buildTrashTalk({ ...base, myNickname: "T", targets: ["AB", "Tristin", "JPeso", "Dereko"], hint: "" });
  const got = biosIn(r.system);
  if (got.includes("T")) senderLeaked = true;
  if (got.length > 1) multi = true;
  got.forEach((g) => seenTargets.add(g));
}
assert("the sender's own profile is never sent", !senderLeaked);
assert("a group roast carries exactly one target's profile", !multi && seenTargets.size > 0);
assert("the one profile is picked at random across targets", seenTargets.size >= 2);
const bySoftHands = buildTrashTalk({ ...base, myNickname: "T", targets: ["AB"], hint: "" });
assert("profile details are framed as weaknesses, never spun into a boast",
  /never a strength/.test(bySoftHands.system) && /compliment, a boast or a badge of honour/.test(bySoftHands.system));
assert("the profile is tied to its owner by name and kept off everyone else",
  /about AB and AB ONLY/.test(bySoftHands.system) && /never pin it on anyone else, and never spread it across the group/.test(bySoftHands.system));
// A target who is profiled still gets their profile when the sender isn't.
const targetOnly = buildTrashTalk({ ...base, myNickname: "Nobody", targets: ["T", "Somebody"], hint: "" });
assert("a profiled target's details arrive when roasted by someone else", /Soft Hands/.test(targetOnly.system) && /about T and T ONLY/.test(targetOnly.system));
// Roasting only yourself-adjacent names: no profiled target, no dossier at all.
const selfOnly = buildTrashTalk({ ...base, myNickname: "T", targets: ["Dereko"], hint: "" });
assert("no profiled target, no dossier — even when the sender has a profile", !/YOU KNOW|Soft Hands|Dallas/.test(selfOnly.system));
const byStranger = buildTrashTalk({ ...base, myNickname: "Nobody", targets: ["Nobody Else"], hint: "" });
assert("no profile, no dossier (and no polarity or ownership rule)", !/YOU KNOW|never a strength|ONLY — aim/.test(byStranger.system));

let bad = 0;
for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
if (bad) { console.error(`\ntrash-prompt: FAILED (${bad} assertion(s)) — DO NOT deploy.`); process.exit(1); }
console.log("\ntrash-prompt: the roast is written as the persona, and is built around the sender's angle.");
