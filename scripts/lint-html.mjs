// Lints the inline <script> blocks of index.html and lab.html with the repo's
// ESLint config (`npm run lint`, part of `verify`).
//
// The app is ~10,000 lines of inline JS, so a misspelt function name is a
// ReferenceError that only fires when someone taps the button that reaches it.
// check:web only proves the scripts parse; this proves every name they use is
// defined somewhere.
//
// A page's inline blocks share one global scope, so they're linted together as
// a single file, with everything outside them blanked to spaces so line and
// column numbers still point into the .html. The external scripts each page
// loads (data.js, scoring.js, lab/*.js) contribute their top-level names as
// globals.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import * as espree from "espree";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Names a script defines at top level (parsed, so `var a = 1, b = 2` yields
// both), plus `window.x =` / `root.x =` exports, which is how several scripts
// hand names to the rest of the page.
function declaredNames(src) {
  const out = new Set();
  const ast = espree.parse(src, { ecmaVersion: 2024, sourceType: "script" });
  for (const node of ast.body) {
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") out.add(node.id.name);
    if (node.type === "VariableDeclaration") for (const d of node.declarations) if (d.id.type === "Identifier") out.add(d.id.name);
  }
  return out;
}
function exportedNames(src) {
  const out = new Set();
  for (const m of src.matchAll(/\b(?:window|self|globalThis|root)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) out.add(m[1]);
  return out;
}

const PAGES = [
  { page: "index.html", externals: ["data.js", "scoring.js", "lab/engine.js"] },
  { page: "lab.html", externals: ["data.js", "lab/engine.js", "lab/analytics.js"] },
];

const eslint = new ESLint({ cwd: ROOT });
let errors = 0;
for (const { page, externals } of PAGES) {
  const html = readFileSync(join(ROOT, page), "utf8");
  const chars = html.replace(/[^\n]/g, " ").split("");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, blocks = 0;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].indexOf(">") + 1;
    for (let i = start; i < start + m[1].length; i++) chars[i] = html[i];
    blocks++;
  }
  const code = chars.join("");
  const ext = new Set();
  for (const f of externals) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const n of declaredNames(src)) ext.add(n);
    for (const n of exportedNames(src)) ext.add(n);
  }
  // Names one inline block exports for another (window.x = ...). Plain
  // declarations need nothing: the blocks are linted as one scope already,
  // and listing them as globals too would read as a redeclaration.
  for (const n of exportedNames(code)) ext.add(n);
  for (const n of declaredNames(code)) ext.delete(n);
  const declared = Object.fromEntries([...ext].map((n) => [n, "writable"]));
  const header = `/* global ${Object.keys(declared).join(", ")} */`;
  // The header shares line 1 with the page's first line, which is never script.
  const src = header + code.slice(code.indexOf("\n"));

  const [res] = await eslint.lintText(src, { filePath: join(ROOT, page.replace(/\.html$/, ".inline.js")) });
  for (const msg of res.messages) {
    if (msg.severity < 2) continue;
    errors++;
    console.error(`  ✗ ${page}:${msg.line}:${msg.column} ${msg.message} (${msg.ruleId})`);
  }
  console.log(`  ${res.errorCount ? "✗" : "✓"} ${page}: ${blocks} inline script block(s), ${res.errorCount} error(s)`);
}
if (errors) { console.error(`\nlint-html: ${errors} error(s) in inline scripts.`); process.exit(1); }
console.log("\nlint-html: inline scripts clean");
