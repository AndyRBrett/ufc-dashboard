// Trash-talk prompt assembly test.
//
// The roast prompt is a wall of competing instructions — a random rhetorical
// shape, the fight card, the profile dossier, structure and length rules. When
// the sender types an angle ("rip his Houston teams"), that angle has to beat
// all of them, or the roast comes back generic and the feature quietly looks
// broken. Nothing else in the gate set can see this: the function parses fine
// and the app boots fine either way. So assert the shape of the prompt itself.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuild = require("esbuild");

// Load the real edge function, minus its Deno.serve entrypoint, so the prompt
// builders can be called directly in node.
globalThis.Deno = { env: { get: () => undefined } };
const src = readFileSync(join(ROOT, "supabase/functions/ai-breakdown/index.ts"), "utf8").split("Deno.serve(")[0];
const { code } = esbuild.transformSync(src + "\nexport { buildTrashTalkPrompt };", { loader: "ts", format: "esm" });
const { buildTrashTalkPrompt } = await import("data:text/javascript," + encodeURIComponent(code));

const base = {
  persona: "Chael Sonnen", myNickname: "AB", myRank: 1, myRecord: "4-1",
  targets: ["JPeso"], lbMode: "current", evName: "UFC 300", card: "A vs B",
};
const HINT = "he still hasn't paid me back";
const count = (hay, needle) => hay.split(needle).length - 1;

const checks = [];
const assert = (name, cond) => checks.push({ name, cond: !!cond });

const withHint = buildTrashTalkPrompt({ ...base, hint: HINT });
const noHint = buildTrashTalkPrompt({ ...base });

assert("the angle is stated as the job, not a suggestion", /THE ANGLE IS THE JOB/.test(withHint));
assert("the angle text survives into the prompt", withHint.includes(HINT));
assert("the angle is restated after the rules", count(withHint, HINT) >= 2 && withHint.lastIndexOf(HINT) > withHint.indexOf("LENGTH IS A HARD CAP"));
assert("the angle is told it outranks the other rules", /outranks every other instruction/.test(withHint));
assert("a closing check re-anchors on the angle", /FINAL CHECK/.test(withHint));

// The random canned angles are the main thing that used to compete: with a
// user angle on the table, none of them may appear at all.
const CANNED = [
  "Write them off as a clueless nobody",
  "Trash their whole vibe",
  "Tell them to find a new hobby",
  "Question whether they even understand how the sport works",
  "Act like you can barely remember their name",
  "Treat their confidence as the funniest part",
  "Pity them",
  "beneath",
];
assert("no canned angle competes with the user's", !CANNED.some((a) => withHint.includes(a)));
assert("a canned angle IS used when the user gave none", CANNED.some((a) => noHint.includes(a)));

// Everything else that can pull the roast off-angle is explicitly subordinated.
assert("the rhetorical shape yields to the angle", /drop the shape and keep the angle/.test(withHint));
assert("the card detail yields to the angle", /only if it serves the angle/.test(withHint));

const withProfile = buildTrashTalkPrompt({ ...base, targets: ["JPeso"], hint: HINT });
assert("the profile dossier yields to the angle", /only if it sharpens the angle/.test(withProfile));
assert("the dossier keeps its own rule when there's no angle", /makes the burn funnier than the picks/.test(noHint));

// Accuracy and length must NOT be subordinated — they're the two things the
// angle is explicitly not allowed to override.
assert("accuracy rules survive an angle", /FACTS ARE STRICT/.test(withHint));
assert("the length cap survives an angle", /LENGTH IS A HARD CAP/.test(withHint));
assert("the signature rule survives an angle", withHint.includes("— Chael Sonnen"));

// A blank or whitespace-only box is not an angle.
const blank = buildTrashTalkPrompt({ ...base, hint: "   " });
assert("whitespace-only input is not treated as an angle", !/THE ANGLE IS THE JOB/.test(blank) && CANNED.some((a) => blank.includes(a)));

// Odd input shouldn't mangle the prompt around it.
const quoted = buildTrashTalkPrompt({ ...base, hint: 'he "always" folds' });
assert("quotes in an angle pass through intact", quoted.includes('he "always" folds') && /FINAL CHECK/.test(quoted));

let bad = 0;
for (const c of checks) { console.log(`  ${c.cond ? "✓" : "✗"} ${c.name}`); if (!c.cond) bad++; }
if (bad) { console.error(`\ntrash-prompt: FAILED (${bad} assertion(s)) — DO NOT deploy.`); process.exit(1); }
console.log("\ntrash-prompt: a user's angle outranks everything else in the roast.");
