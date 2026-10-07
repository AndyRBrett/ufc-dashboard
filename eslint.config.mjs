// Lint gate for the JavaScript (`npm run lint`, part of `verify`).
//
// Correctness only, never style: undefined names, unreachable code, duplicate
// keys, self-comparison and the rest of eslint:recommended's bug rules. The
// inline scripts in index.html / lab.html are linted by scripts/lint-html.mjs,
// which hands them to this same config.
import js from "@eslint/js";
import globals from "globals";

// Browser-side scripts share one global scope: data.js and scoring.js define
// names the app and the Lab read, so they're declared here once.
const shared = { PickEngine: "writable", SCORING_VERSION: "readonly" };

// scoring.js runs against a host environment: the app defines these as
// globals, and lab/engine.js's loadKernel (and the send-reminders bundle)
// pass the same names in as parameters, with stubs for the app-only ones.
// Keep in step with the `params` list in lab/engine.js.
const scoringHost = Object.fromEntries(
  ["EVENTS", "RESULTS_ARCHIVE", "FIGHTER_STATS", "RANKINGS", "USER_ID",
   "MAIN_CARD_BOUTS", "DAY_MS", "lbScope", "userName", "_lbRows", "_commRows"]
    .map((n) => [n, "readonly"]));

const rules = {
  ...js.configs.recommended.rules,
  // Deliberate: many catches are "best effort, keep the app up". A bare
  // `catch {}` is allowed; an empty block anywhere else still fails.
  "no-empty": ["error", { allowEmptyCatch: true }],
  // Unused code is cleanup, not a bug; the gate only fails on bugs.
  "no-unused-vars": "off",
  // Escapes in regex literals copied from Python sources are harmless.
  "no-useless-escape": "off",
};

export default [
  { ignores: ["node_modules/**", "dist/**", "data.js", "supabase/functions/_shared/lab-bundle.js", "docs/archived-themes/**"] },
  {
    files: ["scoring.js", "lab/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.browser, ...globals.commonjs, ...shared } },
    rules,
  },
  {
    files: ["scoring.js"],
    languageOptions: { globals: scoringHost },
    // SCORING_VERSION is declared here and read by the app; `shared` lists it
    // for the files that only read it.
    rules: { "no-redeclare": ["error", { builtinGlobals: false }] },
  },
  {
    // The inline <script> blocks of index.html / lab.html (scripts/lint-html.mjs).
    files: ["*.inline.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.browser } },
    rules,
  },
  {
    files: ["sw.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.serviceworker } },
    rules,
  },
  {
    files: ["**/*.mjs", "build.mjs", "supabase/functions/_shared/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
    rules,
  },
  {
    // Browser gates: bodies passed to page.evaluate() run inside the app and
    // name its globals, which no static scope here can know.
    files: ["tests/check-ai-history.mjs", "tests/check-guide.mjs", "tests/check-invites.mjs", "tests/check-lab.mjs", "tests/check-safety.mjs",
            "tests/check-sports.mjs", "tests/check-verdict.mjs", "tests/notification-tap.mjs"],
    rules: { "no-undef": "off" },
  },
];
