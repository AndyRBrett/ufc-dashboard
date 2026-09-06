// Guard: the parlay calculator's numbers, and the warnings that keep them honest.
//
// A parlay page that only multiplies odds tells you the flattering half of the
// story. The two things worth protecting here are the ones a user can't check
// by eye: the de-vigged "true chance" (the market's own probabilities sum past
// 100%, and a naive product quietly inherits that on every leg), and the
// correlation warnings — a combined probability is only valid if the bouts are
// independent, and same-card outcomes aren't.
//
// Both the model block and the parlay block are lifted out of index.html; the
// parlay code calls into the model for de-vigging and for its per-leg
// disagreement warning, so a break in either shows up here.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) {
    console.error(`  ✗ index.html: no // ${name}:start … // ${name}:end block — renamed or removed?`);
    process.exit(1);
  }
  return html.slice(a, b);
}
const ctx = vm.createContext({ Math, Date, isFinite, parseFloat, Object, String, console });
vm.runInContext(block("model"), ctx);
vm.runInContext(block("parlay"), ctx);
const call = (expr) => vm.runInContext(expr, ctx);

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);
const near = (a, b, eps = 0.01) => Math.abs(a - b) < eps;

const bout = (n1, n2, o1, o2) =>
  ({ f1: { n: n1 }, f2: { n: n2 }, odds: { f1: o1, f2: o2 } });
const leg = (b, pick) => call(`parlayLeg(${JSON.stringify(b)},${JSON.stringify(pick)})`);
const combine = (legs) => call(`parlayCombine(${JSON.stringify(legs)})`);

// --- prices ---------------------------------------------------------------
check("American odds convert to decimal both ways",
  near(call("parlayDecimal(150)"), 2.5) && near(call("parlayDecimal(-200)"), 1.5));
check("an impossible price is rejected rather than priced",
  call("parlayDecimal(50)") === null && call("parlayDecimal(null)") === null &&
  call("parlayDecimal('-200')") === null);

// --- legs -----------------------------------------------------------------
const evenBout = bout("Ana Reyes", "Bea Novak", -110, -110);
const l1 = leg(evenBout, "Ana Reyes");
check("a leg carries the price, its implied chance, and the de-vigged one",
  l1 && near(l1.decimal, 1.909) && near(l1.implied, 0.5238) && near(l1.fair, 0.5));
check("the de-vigged chance is never flattering: it sits below the implied one",
  l1.fair < l1.implied);
check("a bout with no line, or a pick who isn't in it, produces no leg",
  leg({ f1: { n: "A" }, f2: { n: "B" }, odds: null }, "A") === null &&
  leg(evenBout, "Somebody Else") === null);

// --- the ticket -----------------------------------------------------------
const three = ["Ana Reyes", "Cara Boyd", "Elle Ward"].map((p, i) =>
  leg(bout(p, "X" + i, -110, -110), p));
const c3 = combine(three);
check("the payout is the product of the legs",
  near(c3.decimal, 1.909 ** 3, 0.01) && c3.payout === Math.round(1.909 ** 3 * 100));
check("the true chance is the product of the DE-VIGGED legs, not the implied ones",
  near(c3.fair, 0.125, 0.001) && c3.fair < c3.implied);
check("expected return is negative and worsens with each leg added",
  c3.ev < 0 && c3.ev < combine(three.slice(0, 2)).ev);
check("an empty ticket prices to nothing rather than to 1",
  combine([]).fair === 0 && combine([]).payout === 0);

// --- warnings -------------------------------------------------------------
const STATS = {
  "Ana Reyes": { rec: "20-2-0", ko: 12, sub: 6, slpm: 4, acc: 50, form: [{ r: "W", m: "KO/TKO" }] },
  "Cara Boyd": { rec: "18-3-0", ko: 10, sub: 5, slpm: 4, acc: 50, form: [{ r: "W", m: "Sub" }] },
  "Elle Ward": { rec: "15-5-0", ko: 1, sub: 1, slpm: 3, acc: 45, form: [{ r: "W", m: "Dec" }] },
};
const warn = (legs, stats = STATS) =>
  call(`parlayWarnings(${JSON.stringify(legs)},null,${JSON.stringify(stats)},{},{})`);
const texts = (ws) => ws.map((w) => w.text).join(" ");

check("no legs, no warnings", warn([]).length === 0);
check("the compounding margin is quantified for a multi-leg ticket",
  /margin compounds/i.test(texts(warn(three))));
check("a single leg isn't lectured about compounding",
  !/compounds/i.test(texts(warn(three.slice(0, 1)))));

// Two picks that both need a finish are NOT independent — the point of the
// whole feature.
const finishers = warn(three.slice(0, 2));
check("legs that both win by finish are flagged as correlated",
  finishers.some((w) => w.level === "high" && /Correlated legs/.test(w.text) &&
                        /Reyes/.test(w.text) && /Boyd/.test(w.text)));
check("a decision-heavy fighter doesn't get called a finisher",
  !/Ward/.test(texts(warn([three[0], three[2]]))));

// A longshot leg carries the ticket, and saying so is more useful than the
// payout number next to it.
const longshot = leg(bout("Dana Ito", "Chalk", 600, -900), "Dana Ito");
check("a longshot leg is named with its real chance",
  /Longshot leg/.test(texts(warn([three[0], longshot], {}))));

// An all-favourites ticket pays little but still needs everything to land.
const favs = ["F1", "F2", "F3"].map((p, i) => leg(bout(p, "D" + i, -300, 240), p));
check("an all-favourites ticket states the chance of at least one upset",
  /Every leg is a favourite/.test(texts(warn(favs, {}))));

console.log(failures
  ? `\nparlay-risk: ${failures} check(s) failed.`
  : "\nparlay-risk: tickets price de-vigged, and correlated legs are called out.");
process.exit(failures ? 1 : 0);
