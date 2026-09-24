// Guard: the Friday Fight Week Brief goes out once, on Friday evening, to the
// right place, with copy the Lab would agree with, and never silently not at all.
//
// It's a scheduled push, so every failure is quiet: a window off by an hour
// (the ET offset), a brief after the prelims already started, a send-push that
// rejects the new type or strips the deep link, or a composition error that
// throws and sends nothing. This transpiles the REAL send-reminders function,
// runs its handler under a fake clock against the committed data.js and Lab
// files, and records exactly what it hands to send-push.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const PAGES = "https://andyrbrett.github.io/ufc-dashboard/";
const SB = "https://sb.test";
const ENV = { CRON_SECRET: "s3cret", SUPABASE_URL: SB, SB_ANON_KEY: "anon" };

// --- fake clock + fetch ------------------------------------------------------
const RealDate = Date;
let NOW = 0;
class FakeDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
}
let pushes = [], missing = new Set(), picksRows = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  if (url.startsWith(PAGES)) {
    const f = url.slice(PAGES.length).split("?")[0];
    if (missing.has(f) || !existsSync(join(ROOT, f))) return new Response("nope", { status: 404 });
    return new Response(readFileSync(join(ROOT, f), "utf8"), { status: 200 });
  }
  if (url.startsWith(SB + "/rest/v1/picks")) return new Response(JSON.stringify(picksRows), { status: 200 });
  if (url === SB + "/functions/v1/send-push") {
    pushes.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ sent: 3 }), { status: 200 });
  }
  return new Response("unexpected " + url, { status: 500 });
};

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const src = readFileSync(join(ROOT, "supabase/functions/send-reminders/index.ts"), "utf8");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
check("send-reminders registers a handler and exports the brief gate", typeof handler === "function" && typeof mod.briefDue === "function");

async function runAt(iso) {
  NOW = RealDate.parse(iso);
  globalThis.Date = FakeDate;
  pushes = [];
  try {
    const res = await handler(new Request("https://fn/send-reminders", { method: "POST", headers: { Authorization: "Bearer s3cret" } }));
    return { status: res.status, json: await res.json(), briefs: pushes.filter((p) => p.type === "brief") };
  } finally { globalThis.Date = RealDate; }
}

// The committed card this is anchored on: Saturday 2026-09-26, prelims 17:00 ET.
// Friday 19:00 EDT = 23:00 UTC.
const CARD = "2026-09-26";
const card = (() => { const m = /name:"([^"]+)",\s*date:"2026-09-26"/.exec(readFileSync(join(ROOT, "data.js"), "utf8")); return m && m[1]; })();
if (!card) { console.error("  ✗ fixture: data.js no longer carries the 2026-09-26 card — re-anchor this test"); process.exit(1); }

// A little group disagreement, so the brief has a "most disputed" line to find.
const vm = await import("node:vm");
const dctx = vm.createContext({}); vm.runInContext(readFileSync(join(ROOT, "data.js"), "utf8"), dctx);
const ev = dctx.EVENTS.find((e) => e.date === CARD);
const b0 = ev.fights[1];
picksRows = ["A", "B", "C", "D"].map((w, i) => ({ user_id: "u" + w, nickname: "🥊 " + w, event_date: CARD, f1: b0.f1.n, f2: b0.f2.n,
  pick: i % 2 ? b0.f1.n : b0.f2.n, method: "", confidence: 0, updated_at: "2026-09-24T00:00:00Z", bonus_pick: null }));

// 1. Timing.
let r = await runAt("2026-09-25T22:55:00Z");
check("no brief at 6:55pm ET Friday", r.status === 200 && r.briefs.length === 0);
r = await runAt("2026-09-25T23:05:00Z");
check("a brief at 7:05pm ET Friday", r.briefs.length === 1);
const b = r.briefs[0] || {};
check("brief is keyed to the card date as type 'brief' (notif_log dedups it)", b.event_date === CARD && b.type === "brief");
check("brief deep-links to the Fight Lab's Fight Week tab", b.url === "./lab.html#week");
check("brief title names the day and the headliners", /^📰 Saturday Brief: /.test(b.title || "") && b.title.includes(card.split(":").pop().trim()));
check("brief is the rich one, built by the Lab's own code", r.json.brief && r.json.brief.rich === true);
check("brief carries the group's most disputed fight", /Most disputed/.test(b.body || ""));
check("brief leads with the line move, then the group's split", /^📉 [^\n]+\n🔥 /.test(b.body || ""));
check("brief never carries a per-user line in a group-wide push", !/You've picked/.test(b.body || ""));
check("brief body fits send-push's limits", (b.body || "").length > 0 && b.body.length <= 1600 && b.title.length <= 120);
r = await runAt("2026-09-26T02:55:00Z");
check("still sends at 10:55pm ET (late scheduler), inside the window", r.briefs.length === 1);
r = await runAt("2026-09-26T03:05:00Z");
check("no brief after 11pm ET — too late to be a Friday brief", r.briefs.length === 0);
r = await runAt("2026-09-24T23:05:00Z");
check("no brief on Thursday", r.briefs.length === 0);

// A thin card (few lines to show) must still never get a per-user line.
{
  const thin = dctx.EVENTS.filter((e) => e.date > CARD && e.fights.length <= 3).pop();
  if (thin) {
    NOW = RealDate.parse(thin.date + "T00:00:00Z") - 86400000; globalThis.Date = FakeDate;
    const t = await mod.composeBrief({ name: thin.name, date: thin.date, time: thin.time, prelimTime: thin.prelimTime }, readFileSync(join(ROOT, "data.js"), "utf8"), null, NOW);
    globalThis.Date = RealDate;
    check("a thin card's brief still carries no per-user line", t.rich && !/You've picked/.test(t.body));
  } else check("fixture: a thin upcoming card exists for the per-user-line check", false);
}

// 2. It degrades to a plain teaser rather than sending nothing.
missing = new Set(["lab/analytics.js"]);
r = await runAt("2026-09-25T23:10:00Z");
check("with the Lab code unreachable, a plain teaser still goes out", r.briefs.length === 1 && r.json.brief.rich === false && /Main card 8pm ET/.test(r.briefs[0].body));
missing = new Set();

// 3. The gate itself.
const ET = (d, t) => ({ name: "UFC X", date: d, time: t, prelimTime: "" });
check("a Saturday card's brief is the Friday before at 19:00 ET", new RealDate(mod.briefUtc("2026-09-26")).toISOString() === "2026-09-25T23:00:00.000Z");
check("a Friday card whose first bell is before 19:00 gets no brief", mod.briefDue({ name: "UFC F", date: "2026-09-25", time: "18:00", prelimTime: "16:00" }, RealDate.parse("2026-09-25T23:05:00Z")) === false);
check("a Friday card starting after 19:00 still gets its brief that evening", mod.briefDue(ET("2026-09-25", "21:00"), RealDate.parse("2026-09-25T23:05:00Z")) === true);

// 4. send-push accepts it and keeps the link — and still refuses anything else.
const push = readFileSync(join(ROOT, "supabase/functions/send-push/index.ts"), "utf8");
const TYPE_RE = new RegExp(/const TYPE_RE = \/(.+)\/;/.exec(push)[1]);
check("send-push accepts the 'brief' type", TYPE_RE.test("brief") && !TYPE_RE.test("briefx"));
const urlRe = new RegExp(/body\.url && \/(.+)\/\.test\(body\.url\)/.exec(push)[1]);
check("send-push forwards ./lab.html#week", urlRe.test("./lab.html#week"));
check("send-push still refuses foreign or odd links", ["https://evil.test", "./lab.html#x\"><b>", "./other.html", "./lab.html?x=1", "//evil.test"].every((u) => !urlRe.test(u)));
check("send-push still forwards the app's own ./?… links", urlRe.test("./?chal=1") && urlRe.test("./"));

// 5. The service worker opens the Lab on tap instead of stashing an empty tap.
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");
const labBranch = sw.indexOf("lab\\.html(#[a-z]+)?$/.test(baseUrl)"), stash = sw.indexOf("e.waitUntil(stashTap()");
check("sw.js routes a Lab link before the tap stash", labBranch > 0 && stash > labBranch && /navigate\(baseUrl\)/.test(sw));

if (failures) { console.error(`\ncheck-brief: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-brief: the Friday brief goes out once, on time, to the Lab.");
