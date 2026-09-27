// Guard: send-push only sends what the server can vouch for.
//
// Before this, anyone holding the public anon key (it ships in index.html)
// could send any title and body to every subscriber: a fake "Your pick WON!"
// to the whole group, or a "challenge" from somebody else. Now:
//   - our own functions prove themselves with X-Service-Key and are trusted;
//   - a signed-in user (session JWT, checked against GoTrue) may send the
//     social pushes as themselves only, with text the server writes;
//   - anyone else may only trigger the result/reminder backups, which the
//     server rebuilds from the committed data.js and the picks table.
//
// This transpiles the REAL send-push function, runs its handler against a
// stubbed Supabase (REST + GoTrue), a synthetic data.js and a recording
// web-push, and checks who receives what.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const SB = "https://sb.test", DATA = "https://data.test/data.js";
const ANON = "anon-key", SERVICE = "service-key";
const ENV = { SB_ANON_KEY: ANON, SB_SERVICE_ROLE_KEY: SERVICE, SUPABASE_URL: SB, DATA_URL: DATA,
  VAPID_PRIVATE_KEY: "v", VAPID_PUBLIC_KEY: "v", VAPID_SUBJECT: "mailto:x@y.z", RATE_LIMIT: "100000", GLOBAL_RATE_LIMIT: "100000" };
const jwt = (who) => "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(who).toString("base64url") + ".signature-signature";
const USERS = { [jwt("alice")]: "a11ce000-0000-4000-8000-000000000001", [jwt("bob")]: "b0b00000-0000-4000-8000-000000000002", [jwt("carol")]: "ca201000-0000-4000-8000-000000000003" };

// A card in scrape.py's exact layout: two bouts final, one still to come.
const CARD = `// UFC Dashboard data
var RANKINGS={};
var EVENTS=[
  {
    name:"UFC Fight Night: Test vs. Card",
    date:"2026-10-03",
    venue:"Apex",
    time:"20:00",
    prelimTime:"17:00",
    fights:[
      {lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:{f1:-150,f2:130},winner:"José Aldo",method:"KO/TKO",round:1,state:"post",f1:{n:"José Aldo",r:"1-0-0",rk:"",s:null},f2:{n:"Sean O\\'Malley",r:"1-0-0",rk:"",s:null}},
      {lbl:"Prelim",wc:"Flyweight",title:false,rematch:false,odds:{f1:-150,f2:130},winner:null,method:null,round:null,state:"pre",f1:{n:"Ann A",r:"1-0-0",rk:"",s:null},f2:{n:"Bea B",r:"1-0-0",rk:"",s:null}}
    ]
  }
];
`;
const PICKS = [
  { user_id: "a11ce000-0000-4000-8000-000000000001", f1: "José Aldo", f2: "Sean O'Malley", pick: "Jose Aldo", nickname: "🥋 Alice" },
  { user_id: "b0b00000-0000-4000-8000-000000000002", f1: "José Aldo", f2: "Sean O'Malley", pick: "Sean O'Malley", nickname: "Bob" },
  { user_id: "ca201000-0000-4000-8000-000000000003", f1: "Ann A", f2: "Bea B", pick: "Ann A", nickname: "Carol" },
];
const SUBS = ["a11ce000-0000-4000-8000-000000000001", "b0b00000-0000-4000-8000-000000000002", "ca201000-0000-4000-8000-000000000003", "da7e0000-0000-4000-8000-000000000004"]
  .map((u, i) => ({ user_id: u, nickname: ["alice", "bob", "carol", "dave"][i], endpoint: "https://fcm.googleapis.com/" + u, p256dh: "k", auth: "a", live_results: true }));
const CHALS = {
  "c1": { challenger_id: "b0b00000-0000-4000-8000-000000000002", challenger_name: "Bob", target_id: "a11ce000-0000-4000-8000-000000000001", target_name: "Alice",
    f1: "José Aldo", f2: "Sean O'Malley", stake: "Loser spins the wheel 🎡", status: "pending", event_date: "2026-10-03" },
  "c2": { challenger_id: "a11ce000-0000-4000-8000-000000000001", challenger_name: "Alice", target_id: "b0b00000-0000-4000-8000-000000000002", target_name: "Bob",
    f1: null, f2: null, stake: "Dinner", status: "accepted", event_date: "2026-10-03" },
};

let sent = [], log = new Set();
globalThis.__webpush = { setVapidDetails() {}, sendNotification: async (sub, payload) => { sent.push({ to: sub.endpoint.split("/").pop(), ...JSON.parse(payload) }); } };
const inFilter = (url) => { const m = /user_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(url)); return m ? m[1].split(",") : null; };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.startsWith(DATA)) return new Response(CARD, { status: 200 });
  if (url === SB + "/auth/v1/user") {
    const tok = (init.headers.Authorization || "").replace("Bearer ", "");
    return USERS[tok] ? json({ id: USERS[tok] }) : json({ msg: "bad jwt" }, 401);
  }
  if (url.startsWith(SB + "/rest/v1/notif_log")) {
    if ((init.method || "GET") === "POST") { log.add(init.body); return new Response("", { status: 201 }); }
    return json([]);
  }
  if (url.startsWith(SB + "/rest/v1/push_subs")) {
    const u = decodeURIComponent(url);
    const eq = /user_id=eq\.([^&]+)/.exec(u), neq = /user_id=neq\.([^&]+)/.exec(u), inl = inFilter(url);
    let rows = SUBS;
    if (eq) rows = rows.filter((r) => r.user_id === eq[1]);
    if (neq) rows = rows.filter((r) => r.user_id !== neq[1]);
    if (inl) rows = rows.filter((r) => inl.includes(r.user_id));
    return json(rows);
  }
  if (url.startsWith(SB + "/rest/v1/picks")) {
    const u = decodeURIComponent(url);
    if (!/promotion=eq\.ufc/.test(u)) return json({ error: "picks read without promotion=eq.ufc" }, 400);
    const eq = /user_id=eq\.([^&]+)/.exec(u);
    return json(eq ? PICKS.filter((p) => p.user_id === eq[1]) : PICKS);
  }
  if (url.startsWith(SB + "/rest/v1/challenges")) {
    const id = /id=eq\.([^&]+)/.exec(url)[1];
    return json(CHALS[id] ? [CHALS[id]] : []);
  }
  return new Response("unexpected " + url, { status: 500 });
};

let handler = null;
globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (h) => { handler = h; } };
const src = readFileSync(join(ROOT, "supabase/functions/send-push/index.ts"), "utf8")
  .replace(/^import webpush from "npm:web-push";$/m, "const webpush = globalThis.__webpush;");
const { code } = await transform(src, { loader: "ts", format: "esm" });
const mod = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

// 20:00 ET on 2026-10-03 is 00:00 UTC on the 4th (EDT).
const MAIN = Date.UTC(2026, 9, 4, 0, 0);
let NOW = MAIN - 3 * 3600_000;
Date.now = () => NOW;

async function send(body, { auth = ANON, service = null } = {}) {
  sent = []; log = new Set();
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + auth };
  if (service) headers["X-Service-Key"] = service;
  const r = await handler(new Request("https://fn/send-push", { method: "POST", headers, body: JSON.stringify(body) }));
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, j, sent: sent.slice(), to: sent.map((s) => s.to).sort() };
}
const FORGED = { title: "HACKED", body: "click evil.example", safe_title: "HACKED", safe_body: "HACKED" };
const clean = (r) => r.sent.every((s) => !/HACKED|evil/.test(JSON.stringify(s)));

// data.js is read, never run: the real committed layout must parse.
{
  const fx = readFileSync(join(ROOT, "tests/fixtures/fight-week/data.js"), "utf8");
  const card = mod.parseCards(fx).find((c) => c.date === "2026-09-26");
  check("parseCards reads scrape.py's layout (the 2026-09-26 fixture: 12 bouts, 20:00 / 17:00)",
    !!card && card.fights.length === 12 && card.time === "20:00" && card.prelimTime === "17:00" && card.fights[0].f1 === "Raul Rosas Jr.");
  const syn = mod.parseCards(CARD)[0];
  check("...including escaped quotes and a null winner", syn.fights[0].f2 === "Sean O'Malley" && syn.fights[1].winner === null);
  check("fightKey matches the key every sender uses (accents folded)",
    mod.fightKey("Raul Rosas Jr.", "Raoni Barcelos") === "raul-rosas-jr-raoni-barcelos" && mod.fightKey("José Aldo", "Sean O'Malley") === "jose-aldo-sean-o-malley");
}

// Anyone with the anon key: no social pushes, no service-only ones, no forged text.
for (const t of ["trash-talk-123", "chal-c1", "pick-first-a11ce000-0000-4000-8000-000000000001", "nudge-b0b00000-a11ce000-1"]) {
  const r = await send({ event_date: "2026-10-03", type: t, ...FORGED, include_user_ids: ["b0b00000-0000-4000-8000-000000000002"] });
  check(`anon key cannot send ${t.replace(/-[\w-]+$/, "")} (401, nothing sent)`, r.status === 401 && r.sent.length === 0);
}
for (const t of ["brief", "swap-old-bout"]) {
  const r = await send({ event_date: "2026-10-03", type: t, ...FORGED });
  check(`only our functions may send ${t} (403 for anon)`, r.status === 403 && r.sent.length === 0);
}
{
  const r = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:win", ...FORGED, include_user_ids: ["ca201000-0000-4000-8000-000000000003", "da7e0000-0000-4000-8000-000000000004"] });
  check("an anon result push goes to exactly the people who picked the winner, read from picks (not the request)",
    r.status === 200 && r.to.join() === "a11ce000-0000-4000-8000-000000000001");
  check("...with the server's own text: '<winner> def. <loser>'", clean(r) && r.sent[0].title === "Your pick WON! 🔥" && r.sent[0].body === "José Aldo def. Sean O'Malley — you called it!");
  const l = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:loss" });
  check("...and the loss push to the people who picked the loser", l.status === 200 && l.to.join() === "b0b00000-0000-4000-8000-000000000002");
  const early = await send({ event_date: "2026-10-03", type: "result:ann-a-bea-b:win", ...FORGED });
  check("a result the committed data doesn't have yet is refused (409), not guessed", early.status === 409 && early.sent.length === 0);
}
{
  const r = await send({ event_date: "2026-10-03", type: "main", ...FORGED });
  check("a main-card reminder 3 hours out is refused (409)", r.status === 409 && r.sent.length === 0);
  NOW = MAIN - 50 * 60_000;
  const ok = await send({ event_date: "2026-10-03", type: "main", ...FORGED });
  check("...and in the hour before, goes to everyone with the server's text (ET offset applied)",
    ok.status === 200 && ok.sent.length === 4 && clean(ok) && ok.sent[0].title === "🥊 UFC Fight Night — Main Card");
  NOW = MAIN - 3 * 3600_000;
}

// A signed-in user sends as themselves only, with server-written text.
{
  const bad = await send({ event_date: "2026-10-03", type: "anything" }, { auth: "eyJ.not-a-real-token-that-verifies-xxxxxxxx.sig" });
  check("a JWT that doesn't verify is refused (401), not downgraded to anon", bad.status === 400 || bad.status === 401);
  const bad2 = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:win" }, { auth: "eyJ.not-a-real-token-that-verifies-xxxxxxxx.sig" });
  check("...even on a type anon may trigger", bad2.status === 401 && bad2.sent.length === 0);

  const other = await send({ event_date: "2026-10-03", type: "pick-first-b0b00000-0000-4000-8000-000000000002", ...FORGED }, { auth: jwt("alice") });
  check("Alice cannot announce Bob's picks (403)", other.status === 403 && other.sent.length === 0);
  const mine = await send({ event_date: "2026-10-03", type: "pick-first-a11ce000-0000-4000-8000-000000000001", ...FORGED }, { auth: jwt("alice") });
  check("Alice's own 'is picking!' goes to everyone else, titled with her registered nickname",
    mine.status === 200 && !mine.to.includes("a11ce000-0000-4000-8000-000000000001") && mine.sent.length === 3 && clean(mine) &&
    mine.sent[0].title === "🎯 alice is picking!" && /Test vs\. Card/.test(mine.sent[0].body));

  const notMine = await send({ event_date: "2026-10-03", type: "chal-c1", ...FORGED, include_user_ids: ["ca201000-0000-4000-8000-000000000003"] }, { auth: jwt("alice") });
  check("a challenge can only be announced by its challenger (403)", notMine.status === 403 && notMine.sent.length === 0);
  const chal = await send({ event_date: "2026-10-03", type: "chal-c1", ...FORGED, include_user_ids: ["ca201000-0000-4000-8000-000000000003"] }, { auth: jwt("bob") });
  check("...and goes only to its target, with the row's fight and stake",
    chal.status === 200 && chal.to.join() === "a11ce000-0000-4000-8000-000000000001" && clean(chal) &&
    chal.sent[0].title === "⚔️ Bob challenged you!" && chal.sent[0].body === "Aldo vs O'Malley — Loser spins the wheel 🎡" && chal.sent[0].kind === "challenge");
  const resp = await send({ event_date: "2026-10-03", type: "chal-resp-c2", ...FORGED }, { auth: jwt("alice") });
  check("only a challenge's target may announce accepting it (403 for the challenger)", resp.status === 403);
  const resp2 = await send({ event_date: "2026-10-03", type: "chal-resp-c2", ...FORGED }, { auth: jwt("bob") });
  check("...the target's acceptance goes to the challenger", resp2.status === 200 && resp2.to.join() === "a11ce000-0000-4000-8000-000000000001" && /accepted your challenge/.test(resp2.sent[0].title));

  const spoof = await send({ event_date: "2026-10-03", type: "nudge-a11ce000-b0b00000-1", include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("a nudge must be from its sender (Carol can't send Bob's)", spoof.status === 403);
  const fourth = await send({ event_date: "2026-10-03", type: "nudge-a11ce000-ca201000-4", include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("...and at most the 3rd of the day", fourth.status === 403);
  const nudge = await send({ event_date: "2026-10-03", type: "nudge-a11ce000-ca201000-1", ...FORGED, include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("a valid nudge reaches only its one target, with server text", nudge.status === 200 && nudge.to.join() === "a11ce000-0000-4000-8000-000000000001" && clean(nudge) && /^carol noticed/.test(nudge.sent[0].body));

  const roast = await send({ event_date: "2026-10-03", type: "trash-talk-17", title: "HACKED", body: "You pick like a blindfolded raccoon. — Joe Rogan",
    include_user_ids: ["b0b00000-0000-4000-8000-000000000002", "bad id!"] }, { auth: jwt("alice") });
  check("trash talk: the roast is the sender's, the title is the server's and names the real sender",
    roast.status === 200 && roast.to.join() === "b0b00000-0000-4000-8000-000000000002" && roast.sent[0].title === "🎤 Joe Rogan (via alice)" && /raccoon/.test(roast.sent[0].body));
}

// Our own functions are trusted as given, and only with the right key.
{
  const brief = await send({ event_date: "2026-10-03", type: "brief", title: "📋 Fight Week Brief", body: "Lab numbers", url: "./lab.html#week" }, { service: SERVICE });
  check("X-Service-Key: the Friday brief goes out as composed", brief.status === 200 && brief.sent.length === 4 && brief.sent[0].title === "📋 Fight Week Brief");
  const wrong = await send({ event_date: "2026-10-03", type: "brief", title: "x", body: "y" }, { service: "service-kez" });
  check("...a wrong key is just an anon caller (403)", wrong.status === 403 && wrong.sent.length === 0);
  const swap = await send({ event_date: "2026-10-03", type: "swap-a-b", title: "x", body: "y", include_user_ids: ["b0b00000-0000-4000-8000-000000000002"] }, { service: SERVICE });
  check("...a targeted swap alert reaches only its targets", swap.status === 200 && swap.to.join() === "b0b00000-0000-4000-8000-000000000002");
}

// The app sends through _pushPost (session JWT first), never the bare anon key.
{
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const direct = html.split('/functions/v1/send-push"').length - 1;
  check("index.html calls send-push in exactly three places: two registers and _pushPost", direct === 3 && /function _pushPost\(req\)/.test(html));
  check("_pushPost leads with the session JWT and only falls back to anon on a 401",
    /var auth=_authBearer\(\),anon="Bearer "\+SUPABASE_ANON;[\s\S]{0,120}r\.status===401&&auth!==anon\?go\(anon\):r/.test(html));
  for (const f of ["check-results", "send-reminders"]) {
    const s = readFileSync(join(ROOT, "supabase/functions", f, "index.ts"), "utf8");
    check(`${f} identifies itself to send-push with X-Service-Key`, /pushHeaders\["X-Service-Key"\] = SB_SERVICE_ROLE_KEY/.test(s));
  }
}

if (failures) { console.error(`\ncheck:pushauth — ${failures} failed`); process.exit(1); }
console.log("\ncheck:pushauth — all good");
