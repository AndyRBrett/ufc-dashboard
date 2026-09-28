// Guard: text from outside the app never reaches the page as HTML.
//
// The CSP allows 'unsafe-inline' (the app is one inline-JS file), so an inline
// event handler that lands in innerHTML runs. Card and fighter names are
// scraped from Wikipedia, which anyone can edit; nicknames, room names, roasts
// and stakes are other users' input; overseer-status.json and intel.json are
// written by other processes. All of that must go in with textContent or text
// nodes. An unclosed "<img src=x onerror=…" in a card title once had a path to
// every visitor's browser through the leaderboard's empty state, borrowing the
// ">" of the "<br>" that followed it.
//
// Every innerHTML / outerHTML / insertAdjacentHTML / document.write in
// index.html and lab.html must therefore assign string literals only, or be one
// of the reviewed expressions below, each built from the app's own constants.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

// Reviewed non-literal HTML, keyed by the expression with whitespace removed.
const ALLOWED = {
  "out": "usBuildFlags: slice geometry the function computes from numbers",
  "'<i>'+S.em+'</i><span>'+S.tag+'</span><i>'+S.em+'</i>'": "season banner: emoji and tagline from the app's own SEASONS table",
  "seasonLogo(S.nm)": "season logo: SVG built from the app's own SEASONS table",
  "fallingCanSvg()": "a fixed SVG",
  "'<svgwidth=\"'+total+'\"height=\"22\"viewBox=\"00'+total+''+SV_VB+'\"preserveAspectRatio=\"none\">'+out+'</svg>'": "Silver ridge: numbers only",
};

// The right-hand side of the assignment (or the call's argument list),
// scanned to the end of the statement: quotes, comments, and bracket depth
// are respected, so a multi-line ternary is read whole.
function statementFrom(src, i) {
  let depth = 0, q = null, out = "";
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { out += c; if (c === "\\") { out += src[++i]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    if ((c === ";" || c === ",") && depth === 0) break;
    out += c;
  }
  return out;
}
// Literal-only: one or more quoted strings joined by "+", nothing else.
const LITERAL = /^\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*\s*$/;

const seen = new Set();
for (const file of ["index.html", "lab.html"]) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const sink = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(/g;
  let m, bad = [];
  while ((m = sink.exec(src))) {
    let rhs = statementFrom(src, m.index + m[0].length);
    // insertAdjacentHTML(position, html): the HTML is the second argument.
    if (m[0].startsWith(".insertAdjacentHTML")) rhs = statementFrom(src, src.indexOf(",", m.index) + 1);
    if (LITERAL.test(rhs) || rhs.trim() === "") continue;
    const key = rhs.replace(/\s+/g, "");
    if (ALLOWED[key]) { seen.add(key); continue; }
    bad.push(`${file}:${src.slice(0, m.index).split("\n").length}: ${rhs.trim().replace(/\s+/g, " ").slice(0, 160)}`);
  }
  for (const b of bad) console.error("    " + b);
  check(`${file}: every HTML sink takes string literals or a reviewed expression`, bad.length === 0);
}
const stale = Object.keys(ALLOWED).filter((k) => !seen.has(k));
check("the allow-list has no stale entries (each still matches a real sink)", stale.length === 0);
for (const s of stale) console.error("    stale: " + s);

// The self-test: the pattern that shipped must be caught, and the fix must pass.
{
  const was = "body.innerHTML='<div class=\"lb-empty\">No picks yet for '+_evTxt+'.<br>Make your picks!</div>';";
  const rhs = statementFrom(was, was.indexOf("=") + 1);
  check("the old empty-state line (a card name concatenated into HTML) would be flagged",
    !LITERAL.test(rhs) && !ALLOWED[rhs.replace(/\s+/g, "")]);
  check("...and a literal-only assignment passes", LITERAL.test(statementFrom("el.innerHTML='<b>'+\"x\";", 13)));
}

if (failures) { console.error(`\ncheck:html — ${failures} failed`); process.exit(1); }
console.log("\ncheck:html — all good");
