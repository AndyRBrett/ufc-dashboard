// Guard: FightBot speaks MCP cleanly and answers from the app's own numbers.
//
// It is a separate process an assistant talks to over stdio, so its failure
// modes are protocol ones — a stray console.log on stdout corrupts every
// message after it, an exception that escapes a tool kills the session — and
// drift: a leaderboard or card that disagrees with the app. This spawns the
// real server with picks from a fixture file (no network) and drives it.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const fail = (m) => { console.error("  ✗ " + m); failures++; };
const check = (name, cond) => cond ? console.log("  ✓ " + name) : fail(name);

// Picks on real bouts from the committed data.js.
const d = vm.createContext({}); vm.runInContext(readFileSync(join(ROOT, "data.js"), "utf8"), d);
const rows = [];
d.EVENTS.filter((e) => e.fights.some((f) => f.winner)).forEach((e) => e.fights.forEach((f, i) => {
  ["Andy", "Tristin"].forEach((who, j) => rows.push({ user_id: "u-" + who, nickname: "🥊 " + who, event_date: e.date, f1: f.f1.n, f2: f.f2.n,
    pick: (i + j) % 2 ? f.f1.n : f.f2.n, method: "KO/TKO", confidence: 0, updated_at: e.date + "T10:00:00Z", event_name: e.name, bonus_pick: null }));
}));
// A legacy nickname with no emoji avatar must resolve by its whole name.
const e0 = d.EVENTS.find((e) => e.fights.some((f) => f.winner)), f0 = e0.fights[0];
rows.push({ user_id: "u-adam", nickname: "Adam B", event_date: e0.date, f1: f0.f1.n, f2: f0.f2.n, pick: f0.f1.n, method: "", confidence: 0,
  updated_at: e0.date + "T10:00:00Z", event_name: e0.name, bonus_pick: null });
// Ghost identities (device resets): a stale "Andy" and a different-case "tristin".
rows.push(Object.assign({}, rows[0], { user_id: "u-Andy-ghost", nickname: "🦍 Andy" }));
rows.push(Object.assign({}, rows[1], { user_id: "u-tristin-ghost", nickname: "🚀 tristin" }));
const dir = mkdtempSync(join(tmpdir(), "fightbot-"));
const picksFile = join(dir, "picks.json");
writeFileSync(picksFile, JSON.stringify(rows));

const srv = spawn(process.execPath, [join(ROOT, "fightbot/server.mjs")], { env: { ...process.env, FIGHTBOT_PICKS_FILE: picksFile }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", rawLines = [];
const waiters = {};
srv.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    rawLines.push(line);
    try { const m = JSON.parse(line); if (waiters[m.id]) { waiters[m.id](m); delete waiters[m.id]; } } catch {}
  }
});
let seq = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = ++seq; waiters[id] = res;
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => rej(new Error("timeout on " + method)), 15000);
});
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: r.result && r.result.isError, data: r.result ? JSON.parse(r.result.content[0].text.replace(/^FightBot error: /, '"') + (r.result.content[0].text.startsWith("FightBot error") ? '"' : "")) : null, raw: r };
};

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  check("initialize answers with tools capability and server info", init.result && init.result.capabilities.tools && init.result.serverInfo.name === "fightbot");
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await rpc("tools/list", {});
  const names = list.result.tools.map((t) => t.name);
  check(`tools/list exposes ${names.length} tools with schemas`, names.length >= 10 && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === "object" && t.description));

  const next = await call("get_next_card", {});
  check("get_next_card returns the upcoming card's bouts", !next.isError && next.data.bouts && next.data.bouts.length > 0);
  const lb = await call("get_leaderboard", {});
  check("get_leaderboard ranks every fixture player", !lb.isError && lb.data.standings.length === 3);
  // Parity: the board's code, run here directly, gives the same points.
  const { load } = await import(join(ROOT, "fightbot/core.mjs"));
  const s = load();
  const direct = s.kernel._lbScoreUsers(rows).map((u) => s.kernel.userPts(u));
  check("leaderboard points equal the app's own _lbScoreUsers/userPts", JSON.stringify(lb.data.standings.map((x) => x.points)) === JSON.stringify(direct));
  const iq = await call("fight_iq", { player: "andy" });
  check("fight_iq resolves a player by bare nickname and reports an archetype", !iq.isError && /—/.test(iq.data.archetype) && iq.data.record);
  const up = await call("get_user_picks", { player: "Tristin" });
  check("get_user_picks returns graded picks", !up.isError && up.data.picks.length > 0 && up.data.picks.some((p) => p.result !== "pending"));
  const who = await call("fight_iq", { player: "nobody-here" });
  check("an unknown player is an isError result that lists who exists", who.isError && who.data.players.length === 3);
check("the player list names each person once (ghost identities collapsed like the board)",
  new Set(who.data.players.map((n) => n.replace(/^\S+\s+/, "").toLowerCase())).size === who.data.players.length);
const adam = await call("get_user_picks", { player: "Adam B" });
check("a legacy nickname without an emoji resolves by its whole name", !adam.isError && adam.data.player === "Adam B");
  const names2 = Object.keys(d.FIGHTER_STATS);
  const cmp = await call("compare_fighters", { a: names2[0], b: names2[1] });
  check("compare_fighters works for any two cached fighters", !cmp.isError && cmp.data.tape.length > 5);
  const miss = await call("compare_fighters", { a: "Not A Fighter", b: names2[0] });
  check("compare_fighters on an unknown name is a readable error, not a crash", miss.isError && /search_fighters/.test(miss.data.error));
  const mv = await call("get_odds_movement", { limit: 3 });
  check("get_odds_movement returns movers", !mv.isError && Array.isArray(mv.data.movers));
  const dogs = await call("find_underdogs", { min_odds: 150 });
  check("find_underdogs returns only dogs at or beyond the price", !dogs.isError && dogs.data.underdogs.every((u) => Number(u.odds) >= 150));
  const brief = await call("fight_week_brief", { player: "Andy" });
  check("fight_week_brief returns headlines", !brief.isError && brief.data.headlines && brief.data.headlines.length > 0);
  const why = await call("why_did_my_pick_lose", { player: "Andy" });
  check("why_did_my_pick_lose explains each loss on the latest card", !why.isError && why.data.losses.length > 0 && why.data.losses.every((l) => l.winner && l.you_picked !== l.winner));
check("every loss says whether its analysis is pre-fight or retrospective", why.data.losses.every((l) => /^(pre-fight|retrospective)/.test(l.analysis_basis)));
// The price is the one at the pick: re-derive it from the engine for each loss.
{
  const { load: ld, FL: FLx } = await import(join(ROOT, "fightbot/core.mjs"));
  const st = ld();
  const ok = why.data.losses.every((l) => {
    const p = st.engine.resolvePicks(rows).find((q) => q.player === "u-Andy" && q.date === why.data.date && q.bout &&
      `${q.bout.competitors[0].name} vs ${q.bout.competitors[1].name}` === l.bout);
    const clv = p ? FLx.pickCLV(p, st.odds) : null;
    return !clv || (l.your_price === (clv.atPick > 0 ? "+" + clv.atPick : String(clv.atPick)) && l.your_price_basis === "line at your pick");
  });
  check("your_price is the line at the pick, not the closing line", ok);
}
  const bad = await rpc("tools/call", { name: "nope", arguments: {} });
  check("an unknown tool is a JSON-RPC error", bad.error && bad.error.code === -32602);
  const unk = await rpc("no/such/method", {});
  check("an unknown method is -32601", unk.error && unk.error.code === -32601);
  check("stdout carries nothing but JSON-RPC messages", rawLines.every((l) => { try { return JSON.parse(l).jsonrpc === "2.0"; } catch { return false; } }));
} catch (e) { fail("session failed: " + e.message); }
finally { srv.kill(); }

if (failures) { console.error(`\ncheck-fightbot: ${failures} failure(s).`); process.exit(1); }
console.log("\ncheck-fightbot: FightBot speaks MCP and answers with the app's numbers.");
