// check:promotion — the picks table holds more than UFC (sport switcher,
// supabase/migrations/0007_picks_promotion.sql). Every UFC reader and every
// UFC-scoped delete must say promotion=eq.ufc, or a PFL pick lands on the UFC
// board, gets restored into the UFC card, is deduped away as a "duplicate",
// or triggers a UFC result push.
//
// This walks every `/rest/v1/picks` call site in the app, the Lab, FightBot,
// the edge functions and the scraper. Each one must carry the filter, or be on
// the short allow-list of calls that are account-wide by design (the pick
// upsert names its promotion in the body instead; account delete, nickname
// rename and name-availability checks span every promotion).
//
// check:parity holds the other half: PFL rows in the input leave every UFC
// output byte-identical, because scoring.js skips them too.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
let failures = 0;
const check = (name, ok) => { if (ok) console.log("  ✓ " + name); else { failures++; console.error("  ✗ " + name); } };

const FILTER = /promotion=eq\.ufc|PICKS_UFC/;
// Account-wide by design. Each entry must match exactly one call site.
const ALLOW = [
  { file: "index.html", re: /\/rest\/v1\/picks\?on_conflict=user_id,event_date,f1,f2"/, why: "the pick upsert (sends promotion:\"ufc\" in its body)" },
  { file: "index.html", re: /\/rest\/v1\/picks\?select=user_id&limit=1"/, why: "the connectivity probe" },
  { file: "index.html", re: /\/rest\/v1\/picks\?user_id=eq\."\+encodeURIComponent\(USER_ID\),\{method:"DELETE",headers:h\}/, why: "Delete my account (every promotion)" },
  { file: "index.html", re: /\/rest\/v1\/picks\?select=event_date&nickname=ilike\./, why: "name availability (names are account-wide)" },
  { file: "index.html", re: /\/rest\/v1\/picks\?user_id=eq\."\+encodeURIComponent\(USER_ID\),\{\s*$/m, why: "nickname rename PATCH (every promotion)" },
  { file: "index.html", re: /\/rest\/v1\/picks\?select=nickname&user_id=eq\./, why: "restore my nickname" },
];
// Calls that build their query in a variable: the variable must carry it.
const VIA = [
  { re: /\/rest\/v1\/picks"\+_sbQ\(/, def: /function _sbQ\(ev,fight\)\{[^\n]*PICKS_UFC;\}/ },
  { re: /\/rest\/v1\/picks"\+_rq,/, def: /var _rq="[^\n]*\+PICKS_UFC;/ },
  { re: /\/rest\/v1\/picks"\+q,/, def: /var q="\?user_id=eq\."[^\n]*\+PICKS_UFC;/ },
];

const FILES = ["index.html", "lab.html", "fightbot/core.mjs", "scrape.py",
  "supabase/functions/send-reminders/index.ts", "supabase/functions/check-results/index.ts"];
let sites = 0;
const allowHits = new Map();
for (const f of FILES) {
  const src = read(f);
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    let at = line.indexOf("/rest/v1/picks");
    while (at >= 0) {
      sites++;
      const rest = line.slice(at);
      const ctx = rest + "\n" + (lines[i + 1] || "");      // a query can wrap onto the next line
      const allow = ALLOW.find((a) => a.file === f && a.re.test(rest));
      const via = VIA.find((v) => v.re.test(rest));
      if (allow) allowHits.set(allow, (allowHits.get(allow) || 0) + 1);
      else if (via) check(`${f}:${i + 1} builds its query from a variable that carries the UFC filter`, via.def.test(src));
      else check(`${f}:${i + 1} reads/deletes UFC picks with promotion=eq.ufc`, FILTER.test(ctx));
      at = line.indexOf("/rest/v1/picks", at + 1);
    }
  });
}
check(`found the picks call sites (${sites})`, sites >= 20);
for (const a of ALLOW) check(`allow-list entry matches exactly one call: ${a.why}`, allowHits.get(a) === 1);

const html = read("index.html");
check("the pick upsert names its promotion", /var data=\{user_id:USER_ID,promotion:"ufc",/.test(html));
check("PICKS_UFC is exactly the filter", /var PICKS_UFC="&promotion=eq\.ufc";/.test(html));
const scoring = read("scoring.js");
check("scoring.js skips non-UFC rows on the board and the Belt",
  /function _isUfcRow\(p\)\{return !p\.promotion\|\|p\.promotion==="ufc";\}/.test(scoring) &&
  (scoring.match(/if\(!_isUfcRow\(p\)\)return;/g) || []).length === 2);
const sql = read("supabase/migrations/0007_picks_promotion.sql");
check("0007 defaults every row to 'ufc' (older clients stay correct)", /add column if not exists promotion text not null default 'ufc'/.test(sql));

// The 2-lock cap is per card, and a card belongs to a promotion. The live
// trigger is 0007's (it replaced 0005's): it must count, and serialise, per
// promotion, and keep 0005's LOCKS_START gate.
{
  const fnSql = sql.slice(sql.indexOf("create or replace function public.picks_cap_locks()"));
  const lockStart = (/LOCKS_START\s*=\s*"(\d{4}-\d{2}-\d{2})"/.exec(scoring) || [])[1];
  check("the lock cap counts only locks of the same promotion", /and p\.promotion = new\.promotion/.test(fnSql));
  check("...serialises per promotion (advisory-lock key)", /hashtext\('picks_lock:' \|\| new\.user_id \|\| '\|' \|\| new\.event_date \|\| '\|' \|\| new\.promotion\)/.test(fnSql));
  check("...re-checks when a row's promotion changes", /before insert or update of confidence, event_date, f1, f2, user_id, promotion on public\.picks/.test(fnSql));
  check("...and keeps the LOCKS_START gate (" + lockStart + ")", !!lockStart && fnSql.includes("new.event_date < '" + lockStart + "'"));
}

if (failures) { console.error(`\ncheck:promotion — ${failures} failure(s)`); process.exit(1); }
console.log(`\ncheck:promotion — every UFC picks query is scoped (${sites} call sites)`);
