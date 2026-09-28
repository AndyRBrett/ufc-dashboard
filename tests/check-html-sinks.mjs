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

// Reviewed non-literal HTML. Each entry is bound to one place: the file, the
// nearest named function declared above the sink, and the expression with
// whitespace removed. It must match exactly one sink, so the same expression
// written anywhere else (a new `x.innerHTML = out` holding a nickname, say)
// is not covered by it.
const ALLOWED = {
  "index.html|usBuildFlags|out": "flag band: slice geometry the function computes from numbers",
  "index.html|applySeason|'<i>'+S.em+'</i><span>'+S.tag+'</span><i>'+S.em+'</i>'": "season banner: emoji and tagline from the app's own SEASONS table",
  "index.html|applySeason|seasonLogo(S.nm)": "season logo: SVG built from the app's own SEASONS table",
  "index.html|fallingCanSvg|fallingCanSvg()": "a fixed SVG",
  "index.html|svBuildRidges|'<svgwidth=\"'+total+'\"height=\"22\"viewBox=\"00'+total+''+SV_VB+'\"preserveAspectRatio=\"none\">'+out+'</svg>'": "Silver ridge: numbers only",
};

// The right-hand side of the assignment (or the call's argument list),
// scanned to the end of the statement: quotes, comments, and bracket depth
// are respected, so a multi-line ternary is read whole. With commas=false a
// top-level comma doesn't end it, so a call's whole argument list is read.
function statementFrom(src, i, commas = true) {
  let depth = 0, q = null, out = "";
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { out += c; if (c === "\\") { out += src[++i]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") { q = c; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) { if (depth === 0) break; depth--; }
    if ((c === ";" || (commas && c === ",")) && depth === 0) break;
    out += c;
  }
  return out;
}
// Split an argument list on its top-level commas.
function splitArgs(list) {
  const out = []; let depth = 0, q = null, cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (q) { cur += c; if (c === "\\") { cur += list[++i]; continue; } if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === "`") q = c;
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
// The nearest named function declared above a position: a stable anchor for
// binding an allow-list entry to one place.
function fnAbove(src, i) {
  const all = [...src.slice(0, i).matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  return all.length ? all[all.length - 1][1] : "(top)";
}
// Literal-only: one or more quoted strings joined by "+", nothing else.
const LITERAL = /^\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))*\s*$/;

const seen = new Map();
for (const file of ["index.html", "lab.html"]) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const sink = /\.(innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(/g;
  let m, bad = [];
  while ((m = sink.exec(src))) {
    const at = m.index + m[0].length;
    let parts;
    if (m[0].startsWith(".insertAdjacentHTML")) {
      // (position, html): everything after the position is HTML.
      parts = [splitArgs(statementFrom(src, at, false)).slice(1).join(",")];
    } else if (m[0].startsWith("document.write")) {
      // The browser joins every argument before parsing, so check them all.
      parts = splitArgs(statementFrom(src, at, false));
    } else {
      parts = [statementFrom(src, at)];
    }
    const line = src.slice(0, m.index).split("\n").length;
    for (const rhs of parts) {
      if (LITERAL.test(rhs) || rhs.trim() === "") continue;
      const key = `${file}|${fnAbove(src, m.index)}|${rhs.replace(/\s+/g, "")}`;
      if (ALLOWED[key]) { seen.set(key, (seen.get(key) || 0) + 1); continue; }
      bad.push(`${file}:${line}: ${rhs.trim().replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }
  for (const b of bad) console.error("    " + b);
  check(`${file}: every HTML sink takes string literals or a reviewed expression`, bad.length === 0);
}
const stale = Object.keys(ALLOWED).filter((k) => seen.get(k) !== 1);
check("each allow-list entry matches exactly one sink (none stale, none reused)", stale.length === 0);
for (const s of stale) console.error(`    ${seen.get(s) || 0} matches: ` + s);

// The self-test: the pattern that shipped must be caught, and the fix must pass.
{
  const was = "body.innerHTML='<div class=\"lb-empty\">No picks yet for '+_evTxt+'.<br>Make your picks!</div>';";
  const rhs = statementFrom(was, was.indexOf("=") + 1);
  check("the old empty-state line (a card name concatenated into HTML) would be flagged",
    !LITERAL.test(rhs) && !ALLOWED[rhs.replace(/\s+/g, "")]);
  check("...and a literal-only assignment passes", LITERAL.test(statementFrom("el.innerHTML='<b>'+\"x\";", 13)));
  const w = 'document.write("<span>", window.name);';
  const args = splitArgs(statementFrom(w, w.indexOf("(") + 1, false));
  check("document.write: a later, non-literal argument is checked too", args.length === 2 && !LITERAL.test(args[1]));
  const reuse = "function other(){ body.innerHTML = out; }";
  check("an allow-listed expression in another function is not covered",
    !ALLOWED[`index.html|${fnAbove(reuse, reuse.indexOf("body"))}|out`]);
}

if (failures) { console.error(`\ncheck:html — ${failures} failed`); process.exit(1); }
console.log("\ncheck:html — all good");
