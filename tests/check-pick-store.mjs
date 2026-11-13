// Guard: everyone's picks are read once, and only the open cards are re-read.
//
// The home page's 30-second poll and the leaderboard each used to download
// every pick ever made (two full copies, the first again on every pick anyone
// saved), and the database ran its hidden-until-lock check on every row of
// every read. The picks store (index.html, // picks-store:start … :end) splits
// the rows at a date cut: cards before it can't change and are read rarely,
// cards after it are the only thing the poll asks for.
//
// What can go wrong, and what this holds:
//   - the merged rows differ from what the single query returned (order
//     decides whose row is "freshest", so the board would shift)
//   - a row counted twice, or lost, at the cut
//   - the poll quietly going back to reading everything
//   - old cards never re-read after a rename, or re-read on every call
//   - a failed read of the past emptying a board that had rows
//
// No browser and no live data: the block runs in a vm against a fake table
// that filters and orders the way PostgREST does. The clock is pinned.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => (cond ? console.log("  ✓ " + name) : fail(name));

const a = html.indexOf("// picks-store:start"), b = html.indexOf("// picks-store:end");
if (a < 0 || b < 0) { fail("index.html: no // picks-store:start … :end block"); process.exit(1); }
const src = html.slice(a, b);

const DAY = 864e5;
const NOW0 = Date.parse("2026-09-26T18:00:00Z");

// --- a fake picks table that answers like PostgREST --------------------------
// updated_at exactly as the API prints it: fraction trimmed of trailing zeros.
const micros = (s) => {
  const m = /^(.*?)(?:\.(\d+))?\+00:00$/.exec(s);
  return Date.parse(m[1] + "Z") * 1000 + (m[2] ? +(m[2] + "000000").slice(0, 6) : 0);
};
const serverOrder = (rows) => rows.slice().sort((x, y) =>
  micros(y.updated_at) - micros(x.updated_at)
  || (x.user_id < y.user_id ? -1 : x.user_id > y.user_id ? 1 : 0)
  || (x.event_date < y.event_date ? -1 : x.event_date > y.event_date ? 1 : 0)
  || (x.f1 < y.f1 ? -1 : x.f1 > y.f1 ? 1 : 0));

function table() {
  const users = ["0a1", "3f2", "9c4", "b77", "e05"];
  const dates = ["2026-08-01", "2026-09-05", "2026-09-19", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-26", "2026-10-03"];
  // Stamps chosen to collide and to need every digit: same instant across
  // users and cards, fractions of 0, 2, 3 and 6 digits.
  const stamps = ["2026-09-20T10:00:00+00:00", "2026-09-20T10:00:00.5+00:00", "2026-09-20T10:00:00.12+00:00",
    "2026-09-20T10:00:00.123+00:00", "2026-09-20T10:00:00.123456+00:00", "2026-09-20T10:00:00.123457+00:00",
    "2026-09-25T23:59:59.999999+00:00", "2026-09-26T00:00:00+00:00"];
  const rows = [];
  let n = 0;
  for (const d of dates) for (const u of users) for (let k = 0; k < 3; k++) {
    rows.push({ user_id: u, event_name: "Card " + d, event_date: d, f1: "A" + k, f2: "B" + k, pick: "A" + k,
      method: "", confidence: 0, nickname: "N" + u, updated_at: stamps[(n * 7 + k * 3) % stamps.length], bonus_pick: null });
    n++;
  }
  return rows;
}

function load({ rows = table(), honourFilter = true } = {}) {
  const state = { now: NOW0, rows, calls: [], failPast: false, hold: null };
  class FakeDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(state.now); }
    static now() { return state.now; }
  }
  const ctx = vm.createContext({
    console, JSON, Object, String, Array, Promise, isNaN, Date: FakeDate,
    DAY_MS: DAY, PICKS_UFC: "&promotion=eq.ufc",
    _sbFetchAll: (q) => {
      const m = /[?&]event_date=(lt|gte)\.(\d{4}-\d{2}-\d{2})/.exec(q);
      state.calls.push({ q, op: m && m[1], cut: m && m[2] });
      if (m && m[1] === "lt" && state.failPast) return Promise.reject(new Error("HTTP 500"));
      let out = state.rows;
      if (honourFilter && m) out = out.filter((r) => (m[1] === "lt" ? r.event_date < m[2] : r.event_date >= m[2]));
      out = serverOrder(out);
      if (m && m[1] === "lt" && state.hold) return state.hold.then(() => out);
      return Promise.resolve(out);
    },
  });
  vm.runInContext(src + "\n;this.api={loadPickRows,_picksPastStale,_picksCut,_pickTs,_picksMerge,PICKS_COLS,PICKS_CUT_DAYS,PICKS_PAST_TTL_MS};", ctx);
  return { state, api: ctx.api };
}
const ops = (calls) => calls.map((c) => c.op).join(",");
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);

// --- 1. the merged rows are the single query's rows, in its order ------------
{
  const { state, api } = load();
  const got = await api.loadPickRows();
  const want = serverOrder(state.rows);
  check("the merged rows are exactly what the single query returned, in its order", same(got, want));
  check("...read as two requests split at one cut", ops(state.calls) === "lt,gte" && state.calls[0].cut === state.calls[1].cut);
  check("...the cut is PICKS_CUT_DAYS (3) before today, in UTC", state.calls[0].cut === "2026-09-23" && api.PICKS_CUT_DAYS === 3);
  check("...every request is scoped to UFC and asks for the board's columns",
    state.calls.every((c) => /&promotion=eq\.ufc/.test(c.q) && c.q.includes("select=" + api.PICKS_COLS)));
  check("...and asks the server for the order the merge relies on",
    state.calls.every((c) => c.q.includes("&order=updated_at.desc,user_id.asc,event_date.asc,f1.asc")));
  for (const col of ["user_id", "event_name", "event_date", "f1", "f2", "pick", "method", "confidence", "nickname", "updated_at", "bonus_pick"])
    if (!api.PICKS_COLS.split(",").includes(col)) fail("PICKS_COLS lost " + col + " (pickPts / the board read it)");
  const again = await api.loadPickRows();
  check("each call gets its own array", again !== got && same(again, got));
}

// --- 2. timestamps compare to the microsecond --------------------------------
{
  const { api } = load();
  const t = api._pickTs;
  check("a trimmed fraction is read at its real value (.5 is half a second, not 5 microseconds)",
    t("2026-09-20T10:00:00.5+00:00") - t("2026-09-20T10:00:00+00:00") === 500000);
  check("...microseconds are kept (Date.parse alone stops at milliseconds)",
    t("2026-09-20T10:00:00.123457+00:00") - t("2026-09-20T10:00:00.123456+00:00") === 1);
  check("...a Z stamp and a +00:00 stamp of one instant are equal",
    t("2026-09-20T10:00:00.250Z") === t("2026-09-20T10:00:00.25+00:00"));
  check("...an offset is honoured", t("2026-09-20T12:00:00+02:00") === t("2026-09-20T10:00:00+00:00"));
  check("...and junk is 0, never NaN", t("") === 0 && t(null) === 0 && t("soon") === 0);
}

// --- 3. nothing twice, nothing lost, whatever the server sends back ----------
{
  // A server (or a test double) that ignores the date filter returns every row
  // to both requests. The store keeps each side to its own dates.
  const { state, api } = load({ honourFilter: false });
  const got = await api.loadPickRows();
  const key = (r) => [r.user_id, r.event_date, r.f1, r.f2].join("|");
  check("a reply that ignores the date filter still yields every row exactly once",
    got.length === state.rows.length && new Set(got.map(key)).size === state.rows.length);
  check("...in the single query's order", same(got, serverOrder(state.rows)));
  const { state: s2, api: a2 } = load({ rows: table().concat([{ user_id: "zz", event_date: "-", f1: "x", f2: "y", pick: "x", nickname: "old", updated_at: "2026-01-01T00:00:00+00:00" }]) });
  check("a row with the column's default date ('-') is kept, on the past side",
    (await a2.loadPickRows()).some((r) => r.user_id === "zz") && s2.rows.length === table().length + 1);
}

// --- 4. only the open cards are re-read ---------------------------------------
{
  const { state, api } = load();
  await api.loadPickRows();
  state.calls.length = 0;
  for (let i = 0; i < 20; i++) { state.now += 30 * 1000; await api.loadPickRows(); }
  check("twenty polls over ten minutes re-read only the open cards", ops(state.calls) === Array(20).fill("gte").join(","));

  // A pick saved on an open card shows on the very next read.
  state.rows = state.rows.concat([{ user_id: "new", event_name: "Card", event_date: "2026-09-26", f1: "A0", f2: "B0", pick: "B0", nickname: "Late", updated_at: "2026-09-26T17:59:00+00:00" }]);
  check("a pick just saved on an open card is in the next read", (await api.loadPickRows()).some((r) => r.user_id === "new"));

  state.calls.length = 0;
  state.now += api.PICKS_PAST_TTL_MS + 1000;
  await api.loadPickRows();
  check("the old cards are re-read once PICKS_PAST_TTL_MS has passed", ops(state.calls) === "lt,gte");
  check("...which is minutes, not seconds and not hours", api.PICKS_PAST_TTL_MS >= 5 * 60 * 1000 && api.PICKS_PAST_TTL_MS <= 30 * 60 * 1000);
  state.calls.length = 0;
  await api.loadPickRows();
  check("...and then left alone again", ops(state.calls) === "gte");
}

// --- 5. a rename re-reads the old cards, once ---------------------------------
{
  const { state, api } = load();
  await api.loadPickRows();
  state.rows = state.rows.map((r) => (r.user_id === "0a1" ? { ...r, nickname: "Renamed" } : r));
  state.calls.length = 0;
  const before = await api.loadPickRows();
  check("without a signal, a rename on old cards isn't seen yet (that is the trade)",
    before.some((r) => r.user_id === "0a1" && r.event_date < "2026-09-23" && r.nickname === "N0a1"));
  api._picksPastStale();
  const after = await api.loadPickRows();
  check("_picksPastStale re-reads the old cards on the next call",
    after.filter((r) => r.user_id === "0a1").every((r) => r.nickname === "Renamed"));
  state.calls.length = 0;
  await api.loadPickRows();
  check("...once", ops(state.calls) === "gte");

  // Two callers at once (the poll and the board) share one read of the past.
  api._picksPastStale();
  state.calls.length = 0;
  await Promise.all([api.loadPickRows(), api.loadPickRows(), api.loadPickRows()]);
  check("callers that overlap share one read of the old cards", state.calls.filter((c) => c.op === "lt").length === 1);

  // A rename that lands while the past is being read must not be lost to it.
  let release;
  state.hold = new Promise((r) => { release = r; });
  api._picksPastStale();
  const slow = api.loadPickRows();
  api._picksPastStale();
  state.hold = null;
  state.rows = state.rows.map((r) => (r.user_id === "3f2" ? { ...r, nickname: "Second" } : r));
  const fresh = await api.loadPickRows();
  release(); await slow;
  check("a rename during a read of the old cards starts a new read, and the newer one is what's kept",
    fresh.filter((r) => r.user_id === "3f2").every((r) => r.nickname === "Second")
    && (await api.loadPickRows()).filter((r) => r.user_id === "3f2").every((r) => r.nickname === "Second"));
}

// --- 6. the cut moves with the calendar ---------------------------------------
{
  const { state, api } = load();
  state.now = Date.parse("2026-09-26T23:59:00Z");
  const first = await api.loadPickRows();
  state.calls.length = 0;
  // Two minutes on, across UTC midnight: well inside PICKS_PAST_TTL_MS, so
  // only the moved cut can be what re-reads. 2026-09-23's card crosses it.
  state.now += 2 * 60 * 1000;
  const next = await api.loadPickRows();
  check("when the date rolls, the cut moves and the old cards are re-read at the new cut",
    ops(state.calls) === "lt,gte" && state.calls.every((c) => c.cut === "2026-09-24"));
  check("...with no row lost or doubled as a card crosses it", same(next, first));
  check("the cut is never later than the hide-until-lock policy's (two days, Eastern)",
    // The policy shows every pick on a card dated before (now ET - 2 days). At
    // any hour, UTC(now - 3d) is on or before that date.
    [0, 3, 4, 5, 12, 23].every((h) => {
      const now = Date.parse("2026-11-01T00:00:00Z") + h * 36e5;
      const et = new Date(now - 2 * DAY - 5 * 36e5).toISOString().slice(0, 10);
      return api._picksCut(now) <= et;
    }));
}

// --- 7. a failed read never empties a board that had rows ---------------------
{
  const { state, api } = load();
  const good = await api.loadPickRows();
  state.failPast = true;
  api._picksPastStale();
  const kept = await api.loadPickRows();
  check("a failed re-read of the old cards keeps the copy already held", same(kept, good));
  state.failPast = false;
  state.calls.length = 0;
  await api.loadPickRows();
  check("...and the next call tries again", ops(state.calls) === "lt,gte");

  const cold = load();
  cold.state.failPast = true;
  let threw = false;
  try { await cold.api.loadPickRows(); } catch { threw = true; }
  check("with no copy at all, a failed read is an error, never half a board", threw);
  cold.state.failPast = false;
  check("...and it recovers on the next call", same(await cold.api.loadPickRows(), serverOrder(cold.state.rows)));
}

// --- 8. the app reads everyone's picks only through the store -----------------
{
  const body = (name) => {
    const at = html.indexOf("function " + name + "(");
    return at < 0 ? "" : html.slice(at, html.indexOf("\nfunction ", at + 10));
  };
  check("the 30-second poll reads through the store", /loadPickRows\(\)/.test(body("fetchCommunityPicks")));
  check("...and hands its readers the rows oldest first, as before", /rows=rows\.slice\(\)\.reverse\(\);[\s\S]*_commRows=rows;/.test(body("fetchCommunityPicks")));
  check("the leaderboard reads through the store", /loadPickRows\(\)/.test(body("loadLeaderboard")));
  // Any other read of picks must name a user or a date: nothing reads the
  // whole UFC table on its own again.
  const whole = [];
  html.split("\n").forEach((line, i) => {
    let at = line.indexOf("/rest/v1/picks?");
    while (at >= 0) {
      const ctx = line.slice(at, at + 400);
      const isRead = !/method:"(POST|PATCH|DELETE)"/.test(line.slice(at, at + 600));
      if (isRead && /PICKS_UFC/.test(ctx) && !/user_id=eq\.|event_date=|"\+op\+"/.test(ctx) && !/select=user_id&limit=1/.test(ctx)) whole.push(i + 1);
      at = line.indexOf("/rest/v1/picks?", at + 1);
    }
  });
  check("no other code reads every UFC pick" + (whole.length ? " (index.html:" + whole.join(", ") + ")" : ""), whole.length === 0);
  check("a rename marks the old cards stale here and tells other devices to",
    /_picksPastStale\(\);_rtBroadcast\(true\);/.test(html) && /payload:past===true\?\{past:true\}:\{\}/.test(html)
    && /m\.payload\.payload\.past\)_picksPastStale\(\);/.test(html));
}

if (failures) { console.error(`\ncheck:pickstore — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:pickstore — everyone's picks are read once, and only the open cards are re-read.");
