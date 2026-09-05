// Guard: the three result-push senders must derive the SAME dedup key.
//
// A fight result can be pushed by any of three independent senders —
// scrape.py (`send_push_notifications`), the in-page live poll
// (index.html `_pushResult`) and the cron backup
// (supabase/functions/check-results). Only one push per fight is supposed to go
// out: each sender POSTs send-push with the type `result:<fight_key>:<group>`
// and send-push's notif_log dedups on (event_date, type). That dedup is pure
// string equality, so it works if and only if all three build the identical
// key from the identical fighter names.
//
// They drifted. scrape.py ASCII-folds a name by dropping every non-ASCII
// codepoint left after NFKD, which deletes the Latin letters whose diacritic
// lives in the codepoint itself — "Klaudia Syguła" becomes "Klaudia Sygua". The
// two JS senders only stripped NFD combining marks, so they kept the "ł", and
// their slug step turned it into a separator: "…klaudia-sygu-a" instead of
// "…klaudia-sygua". Two different types, no dedup, and everyone who picked
// Cornolle vs Syguła got the same "Your pick WON!" notification twice.
//
// This test pulls the real _fold implementations out of all three files and
// asserts they agree, so the next edit to one of them can't silently re-open
// the duplicate-notification hole.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Names whose ASCII folding is not the trivial "strip the combining mark" case.
// Each one produced a different key per sender before the fix.
const NAMES = [
  ["Nora Cornolle", "Klaudia Syguła"], // the reported duplicate
  ["Matthieu Letho Duclos", "Luis Felipe Dias"],
  ["Karol Rosa", "Michał Oleksiejczuk"],
  ["Jérôme Le Banner", "Søren Bak"],
  ["Khamzat Chimaev", "Đorđe Petrović"],
  ["José Aldo", "Marlon Vera"],
];

function fail(msg) { console.error("  ✗ " + msg); process.exitCode = 1; }

// --- extract `function _fold(...)` from a source file, by brace matching -----
function extractFold(src, file) {
  const start = src.indexOf("function _fold(");
  if (start < 0) throw new Error(`${file}: no _fold() found — did the shared ASCII fold get renamed or removed?`);
  let depth = 0, i = src.indexOf("{", start);
  const open = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${file}: unbalanced braces in _fold() (started at ${open})`);
}

// Same idea for scrape.py, by indentation: take `def _fold(...)` and every line
// after it that is blank or indented.
function extractPyFold(src) {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith("def _fold("));
  if (start < 0) throw new Error("scrape.py: no _fold() found — did the shared ASCII fold get renamed or removed?");
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) end++;
  return lines.slice(start, end).join("\n");
}

async function loadFold(relPath, { ts = false } = {}) {
  let body = extractFold(readFileSync(join(ROOT, relPath), "utf8"), relPath);
  if (ts) body = (await transform(body, { loader: "ts", format: "esm" })).code;
  return new Function(`${body}; return _fold;`)();
}

// The slug step, identical in every sender (and in scrape.py's re.sub).
const slug = (fold, w, l) =>
  fold(w + "-" + l).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const foldWeb = await loadFold("index.html");
const foldFn = await loadFold("supabase/functions/check-results/index.ts", { ts: true });

// scrape.py is the reference: its output is what data.js already ships and what
// every stored pick (`date|f1|f2`) is keyed on, so the other two must match IT.
// Its _fold() is exec'd out of the file rather than imported — validate-web.yml
// has no python dependencies installed, and the fold needs none either.
const pyFold = extractPyFold(readFileSync(join(ROOT, "scrape.py"), "utf8"));
let pyKeys;
try {
  pyKeys = JSON.parse(execFileSync("python3", ["-c", `
import json, re, sys, unicodedata
exec(sys.argv[1])
print(json.dumps([
    re.sub(r"[^a-z0-9]+", "-", _fold(f"{w}-{l}").lower()).strip("-")
    for w, l in json.loads(sys.argv[2])
]))
`, pyFold, JSON.stringify(NAMES)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
} catch (e) {
  console.error("notify-dedup-key: could not evaluate scrape.py's _fold() — " + (e.stderr || e.message));
  process.exit(1);
}

for (let i = 0; i < NAMES.length; i++) {
  const [w, l] = NAMES[i];
  const py = pyKeys[i], web = slug(foldWeb, w, l), fn = slug(foldFn, w, l);
  if (py === web && py === fn) {
    console.log(`  ✓ ${w} def. ${l} → result:${py}`);
  } else {
    fail(`${w} def. ${l} — senders disagree, so this fight would be pushed more than once:\n` +
      `      scrape.py     result:${py}\n      index.html    result:${web}\n      check-results result:${fn}`);
  }
}

// The fold has to be applied where the key is built. Folding only the Wikipedia
// text is not enough: `_pushResult` takes the loser straight off data.js, and
// check-results takes both names from its own parse.
const callsFold = [
  ["index.html", /var fightKey=_fold\(winner\+"-"\+loser\)/],
  ["supabase/functions/check-results/index.ts", /return _fold\(winner \+ "-" \+ loser\)/],
  ["scrape.py", /fight_key = re\.sub\(r"\[\^a-z0-9\]\+", "-", asc\(f"\{winner\}-\{loser\}"\)\.lower\(\)\)/],
];
for (const [file, re] of callsFold) {
  if (re.test(readFileSync(join(ROOT, file), "utf8"))) console.log(`  ✓ ${file} folds when building the fight key`);
  else fail(`${file}: the fight key is no longer built from the ASCII-folded names — an unfolded name would key differently from the other senders and duplicate the push.`);
}

if (process.exitCode) console.error("\nnotify-dedup-key: FAILED — result pushes would duplicate.");
else console.log("\nnotify-dedup-key: all senders agree on the result dedup key.");
