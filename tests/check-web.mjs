// Fast, zero-dependency validation of the browser-facing code.
//
// The app is a single 5,600-line index.html with all its logic in inline
// <script> blocks. One syntax typo there turns the whole app into a blank
// white page — and nothing in CI used to look at it. This catches that class
// of break in milliseconds, with no browser required, so it can gate every
// deploy (including the automated data-update path) without being flaky.
//
// It checks three things:
//   1. Every inline <script> in index.html compiles (SyntaxError = white page).
//   2. sw.js compiles (a broken service worker breaks the installed PWA).
//   3. data.js compiles AND actually produces a non-empty EVENTS array
//      (a malformed data push is the other way the app dies on load).
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const ok = (m) => console.log("  ✓ " + m);

// 1. Inline scripts in index.html — compile each block (no execution).
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const scriptRe = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
let m, inline = 0;
while ((m = scriptRe.exec(html)) !== null) {
  const attrs = m[1] || "";
  if (/\bsrc\s*=/.test(attrs)) continue;                 // external file, not inline code
  if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs)) continue; // e.g. application/json data blocks
  inline++;
  try { new vm.Script(m[2], { filename: `index.html#script${inline}` }); }
  catch (e) { fail(`index.html inline script #${inline}: ${e.message}`); }
}
if (inline === 0) fail("no inline scripts found in index.html — did the parser break?");
else if (!failures) ok(`index.html — ${inline} inline script block(s) compile`);

// 2. Service worker.
try { new vm.Script(readFileSync(join(ROOT, "sw.js"), "utf8"), { filename: "sw.js" }); ok("sw.js compiles"); }
catch (e) { fail(`sw.js: ${e.message}`); }

// 3. data.js must compile and yield a usable EVENTS array.
const dataSrc = readFileSync(join(ROOT, "data.js"), "utf8");
try {
  const ctx = { window: {}, globalThis: {} };
  vm.createContext(ctx);
  new vm.Script(dataSrc, { filename: "data.js" }).runInContext(ctx);
  const EV = ctx.EVENTS ?? ctx.window.EVENTS;
  if (!Array.isArray(EV)) fail("data.js ran but EVENTS is not an array");
  else if (EV.length === 0) fail("data.js produced an EMPTY EVENTS array");
  else ok(`data.js compiles and defines EVENTS (${EV.length} event(s))`);
} catch (e) { fail(`data.js: ${e.message}`); }

if (failures) { console.error(`\ncheck-web: ${failures} problem(s) found — DO NOT deploy.`); process.exit(1); }
console.log("\ncheck-web: all web assets valid.");
