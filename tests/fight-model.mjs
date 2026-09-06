// Guard: the fight model shows a number next to the market price, and a wrong
// number there is worse than none at all.
//
// The model block in index.html is pure and self-contained by design (it reads
// only data.js globals), so it can be lifted out and driven directly. What this
// test protects, in order of how badly it burned:
//
//   1. Every known fighter is SEEDED. Seeding lazily inside the Elo replay left
//      anyone who hadn't fought since the archive began at the 1500 baseline —
//      a #2-ranked 23-3 lightweight rated as an unknown, 59 points away from
//      the market.
//   2. Thin data SHRINKS the claim. A fighter with no record and no stats must
//      not come out a confident favourite; that produced a 79% model number on
//      a 20% market underdog.
//   3. A missing fighter yields NO model, never a half-informed guess.
//   4. The market side is DE-VIGGED before comparison, or the model reads
//      systematically low on both fighters and every bout looks like an edge.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const start = html.indexOf("// model:start"), end = html.indexOf("// model:end");
if (start < 0 || end < 0) {
  console.error("  ✗ index.html: no // model:start … // model:end block — was the fight model renamed or removed?");
  process.exit(1);
}
const ctx = vm.createContext({ Math, Date, isFinite, parseFloat, Object, String, console });
vm.runInContext(html.slice(start, end), ctx);
const call = (expr) => vm.runInContext(expr, ctx);

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const ok = (m) => console.log("  ✓ " + m);
const check = (name, cond) => cond ? ok(name) : fail(name);

const fighter = (over = {}) => Object.assign({
  slpm: 4, acc: 50, td: 1.5, tdd: 60, ko: 5, sub: 2, rec: "15-3-0",
  ht: "5' 11\"", rch: "72\"", stn: "Orthodox", dob: "Jan 01, 1994",
  form: [{ r: "W", m: "Dec" }, { r: "W", m: "TKO" }, { r: "W", m: "Dec" }],
}, over);

const STATS = {
  Champ:   fighter({ rec: "25-1-0", form: [{ r: "W", m: "TKO" }, { r: "W", m: "Sub" }, { r: "W", m: "TKO" }] }),
  Veteran: fighter({ rec: "18-12-0", dob: "Jan 01, 1988",
                     form: [{ r: "L", m: "Dec" }, { r: "L", m: "TKO" }, { r: "W", m: "Dec" }] }),
  Even:    fighter(),
  Unknown: { rec: "", form: [], slpm: 0, acc: 0, td: 0, tdd: 0, ko: 0, sub: 0 },
  Rangy:   fighter({ rch: "80\"" }),
  Short:   fighter({ rch: "68\"" }),
};
const RANKINGS = { Champ: 1 };
const prob = (a, b, archive = {}) =>
  call(`modelProb(${JSON.stringify(a)},${JSON.stringify(b)},${JSON.stringify(STATS)},` +
       `${JSON.stringify(RANKINGS)},${JSON.stringify(archive)})`);

// 1. A ranked, unbeaten fighter who appears in no archived result is still rated.
const seeded = prob("Champ", "Veteran");
check("a fighter absent from the results archive is still seeded, not left at baseline",
      seeded && seeded.elo1 > seeded.elo2 + 100 && seeded.p1 > 0.6);

// 2. Thin data shrinks the claim toward a coin flip.
const thin = prob("Champ", "Unknown");
check("an unknown opponent shrinks the model toward 50%", thin && thin.p1 < 0.8);
check("the shrink is reported, not hidden", thin && thin.confidence <= 0.4);

// 3. No stats, no model.
check("a fighter missing from the stats cache yields no model at all",
      prob("Champ", "Nobody") === null && prob("Nobody", "Champ") === null);

// 4. De-vig: a -110/-110 market is 50/50, not 52/52.
const dv = call("modelDeVig({f1:-110,f2:-110})");
check("the market side is de-vigged before comparison",
      dv && Math.abs(dv.p1 - 0.5) < 1e-9 && Math.abs(dv.p1 + dv.p2 - 1) < 1e-9);
check("a bout with no posted line has no market side",
      call("modelDeVig(null)") === null && call("modelDeVig({f1:-110,f2:null})") === null);

// Probabilities are probabilities, whichever way round the bout is read.
const ab = prob("Champ", "Veteran"), ba = prob("Veteran", "Champ");
check("the two sides sum to 1 and the bout reads the same either way round",
      Math.abs(ab.p1 + ab.p2 - 1) < 1e-9 && Math.abs(ab.p1 - ba.p2) < 1e-9);

// Reach is an edge, and a named one — the tooltip is the whole explanation.
const reach = prob("Rangy", "Short");
check("a reach advantage moves the number and is named as a factor",
      reach.p1 > 0.5 && reach.factors.some((f) => /reach/.test(f.label)));

// An archived win moves the rating; a result we can't align to either corner
// must be skipped rather than guessed at.
const beforeWin = prob("Even", "Champ");
const afterWin = prob("Even", "Champ",
  { "2026-01-10": { fights: [{ f1: "Even", f2: "Champ", winner: "Even", method: "KO/TKO" }] } });
check("an archived win raises the winner's rating", afterWin.p1 > beforeWin.p1);
const bogus = prob("Even", "Champ",
  { "2026-01-10": { fights: [{ f1: "Even", f2: "Champ", winner: "Somebody Else" }] } });
check("a result naming neither corner is skipped, not guessed",
      Math.abs(bogus.p1 - beforeWin.p1) < 1e-9);

// The flag is comparative: only the widest gaps on a card, capped.
const card = {
  date: "2026-09-12", name: "UFC Test",
  fights: [
    { f1: { n: "Champ" }, f2: { n: "Veteran" }, odds: { f1: 200, f2: -250 } },
    { f1: { n: "Rangy" }, f2: { n: "Short" },   odds: { f1: 400, f2: -550 } },
    { f1: { n: "Even" },  f2: { n: "Champ" },   odds: { f1: -110, f2: -110 } },
    { f1: { n: "Even" },  f2: { n: "Veteran" }, odds: { f1: -115, f2: -105 } },
  ],
};
const flags = call(`modelCardFlags(${JSON.stringify(card)},${JSON.stringify(STATS)},` +
                   `${JSON.stringify(RANKINGS)},{})`);
check("no card flags more than MODEL_FLAG_MAX bouts",
      Object.keys(flags).length <= call("MODEL_FLAG_MAX"));
const edges = card.fights.map((f) =>
  call(`modelEdge(${JSON.stringify(f)},${JSON.stringify(STATS)},${JSON.stringify(RANKINGS)},{})`));
check("every flagged bout clears the minimum gap",
      Object.keys(flags).every((k) => {
        const i = card.fights.findIndex((f) => f.f1.n + "|" + f.f2.n === k);
        return i >= 0 && edges[i].edge >= call("MODEL_EDGE_MIN");
      }));
check("an unpriced bout still gets a model but never a gap",
      (() => {
        const e = call(`modelEdge({f1:{n:"Champ"},f2:{n:"Veteran"},odds:null},` +
                       `${JSON.stringify(STATS)},${JSON.stringify(RANKINGS)},{})`);
        return e && e.model && e.market === null && e.edge === 0;
      })());

console.log(failures
  ? `\nfight-model: ${failures} check(s) failed.`
  : "\nfight-model: the model is seeded, shrunk on thin data, and compared de-vigged.");
process.exit(failures ? 1 : 0);
