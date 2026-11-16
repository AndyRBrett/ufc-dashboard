// Guard: the result-push senders must derive the SAME dedup key.
//
// A fight result is pushed by two independent senders: scrape.py
// (`send_push_notifications`, right after its commit) and the cron backup
// supabase/functions/check-results. Only one push per fight is supposed to go
// out: each POSTs send-push with the type `result:<fight_key>:<group>` and
// send-push's notif_log dedups on (event_date, type). That dedup is pure string
// equality, so it works if and only if both build the identical key from the
// identical fighter names.
//
// They drifted once. scrape.py ASCII-folds a name by dropping every non-ASCII
// codepoint left after NFKD, which deletes the Latin letters whose diacritic
// lives in the codepoint itself ("Klaudia Syguła" becomes "Klaudia Sygua"). The
// JS senders only stripped NFD combining marks, kept the "ł", and turned it into
// a separator: "…klaudia-sygu-a". Two types, no dedup, and everyone who picked
// Cornolle vs Syguła got the same "Your pick WON!" notification twice.
//
// check-results now builds the key with results.js (ResultsParse.fightKey),
// bundled into _shared/results-bundle.js. The open app used to be a third
// sender and no longer is (index.html's live-poll block says why); this also
// holds that it stays that way, since a sender this test doesn't know about is
// exactly how the keys drifted the first time.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");

// Names whose ASCII folding is not the trivial "strip the combining mark" case.
const NAMES = [
  ["Nora Cornolle", "Klaudia Syguła"], // the reported duplicate
  ["Matthieu Letho Duclos", "Luis Felipe Dias"],
  ["Karol Rosa", "Michał Oleksiejczuk"],
  ["Jérôme Le Banner", "Søren Bak"],
  ["Khamzat Chimaev", "Đorđe Petrović"],
  ["José Aldo", "Marlon Vera"],
];

function fail(msg) { console.error("  ✗ " + msg); process.exitCode = 1; }
function ok(msg) { console.log("  ✓ " + msg); }

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

// The key check-results builds: results.js, exactly as bundled.
const rctx = {};
vm.runInNewContext(read("results.js"), rctx);
const RP = rctx.ResultsParse;
if (!RP || typeof RP.fightKey !== "function") { fail("results.js: no ResultsParse.fightKey"); process.exit(1); }

// scrape.py is the reference: its output is what data.js already ships and what
// every stored pick (`date|f1|f2`) is keyed on, so check-results must match IT.
// Its _fold() is exec'd out of the file rather than imported — validate-web.yml
// has no python dependencies installed, and the fold needs none either.
const pyFold = extractPyFold(read("scrape.py"));
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
  const py = pyKeys[i], fn = RP.fightKey(w, l);
  if (py === fn) ok(`${w} def. ${l} → result:${py}`);
  else fail(`${w} def. ${l} — senders disagree, so this fight would be pushed twice:\n      scrape.py     result:${py}\n      check-results result:${fn}`);
}

// The fold has to be applied where the key is built: check-results takes both
// names from its own parse, scrape.py from data.js.
const cr = read("supabase/functions/check-results/index.ts");
if (/import \{ ResultsParse \} from "\.\.\/_shared\/results-bundle\.js"/.test(cr) && /const fightKey = ResultsParse\.fightKey\(res\.winner, res\.loser\)/.test(cr))
  ok("check-results builds the key with ResultsParse.fightKey (results.js, bundled)");
else fail("check-results: the fight key is no longer ResultsParse.fightKey from _shared/results-bundle.js — an unfolded name would key differently from scrape.py and duplicate the push.");
if (/function _fold\(|function _fightKey\(/.test(cr)) fail("check-results defines its own _fold / _fightKey again: a second copy is how the keys drifted the first time. Use ResultsParse.");
else ok("check-results has no private copy of the fold or the key");
if (/fight_key = re\.sub\(r"\[\^a-z0-9\]\+", "-", asc\(f"\{winner\}-\{loser\}"\)\.lower\(\)\)/.test(read("scrape.py")))
  ok("scrape.py folds when building the fight key");
else fail("scrape.py: the fight key is no longer built from the ASCII-folded names — an unfolded name would key differently and duplicate the push.");

// No third sender: the open app reads results, it never pushes them.
const html = read("index.html");
const sendsResult = /type:"result:"\+|["']result:["']\s*\+|function _pushResult\(/.test(html);
if (sendsResult) fail("index.html sends result pushes again: a third sender this test doesn't key-check (see the live-poll block for why the app stopped).");
else ok("index.html sends no result pushes (two senders: scrape.py and check-results)");

if (process.exitCode) console.error("\nnotify-dedup-key: FAILED — result pushes would duplicate.");
else console.log("\nnotify-dedup-key: both senders agree on the result dedup key.");
