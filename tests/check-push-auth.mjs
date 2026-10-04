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
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name, cond) => cond ? console.log("  ✓ " + name) : (failures++, console.error("  ✗ " + name));

const SB = "https://sb.test", DATA = "https://data.test/data.js";
const ANON = "anon-key", SERVICE = "service-key";
const ENV = { SB_ANON_KEY: ANON, SB_SERVICE_ROLE_KEY: SERVICE, SUPABASE_URL: SB, DATA_URL: DATA,
  VAPID_PRIVATE_KEY: "v", VAPID_PUBLIC_KEY: "v", VAPID_SUBJECT: "mailto:x@y.z", RATE_LIMIT: "100000", GLOBAL_RATE_LIMIT: "100000" };
const jwt = (who) => "eyJhbGciOiJIUzI1NiJ9." + Buffer.from(who).toString("base64url") + ".signature-signature";
const USERS = { [jwt("alice")]: "a11ce000-0000-4000-8000-000000000001", [jwt("bob")]: "b0b00000-0000-4000-8000-000000000002", [jwt("carol")]: "ca201000-0000-4000-8000-000000000003",
  [jwt("eve")]: "e7e00000-0000-4000-8000-000000000005" };

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
  },
  {
    name:"UFC Fight Night: Past vs. Card",
    date:"2026-09-26",
    venue:"Apex",
    time:"20:00",
    prelimTime:"17:00",
    fights:[
      {lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:{f1:-150,f2:130},winner:"Old A",method:"KO/TKO",round:1,state:"post",f1:{n:"Old A",r:"1-0-0",rk:"",s:null},f2:{n:"Old B",r:"1-0-0",rk:"",s:null}}
    ]
  },
  {
    name:"UFC Fight Night: Past vs. Card",
    date:"2026-10-01",
    venue:"Apex",
    time:"20:00",
    prelimTime:"17:00",
    fights:[
      {lbl:"Main Event",wc:"Lightweight",title:false,rematch:false,odds:{f1:-150,f2:130},winner:"Old A",method:"KO/TKO",round:1,state:"post",f1:{n:"Old A",r:"1-0-0",rk:"",s:null},f2:{n:"Old B",r:"1-0-0",rk:"",s:null}}
    ]
  }
];
`;
const PICKS = [
  { user_id: "a11ce000-0000-4000-8000-000000000001", f1: "José Aldo", f2: "Sean O'Malley", pick: "Jose Aldo", nickname: "🥋 Alice" },
  { user_id: "b0b00000-0000-4000-8000-000000000002", f1: "José Aldo", f2: "Sean O'Malley", pick: "Sean O'Malley", nickname: "Bob" },
  { user_id: "ca201000-0000-4000-8000-000000000003", f1: "Ann A", f2: "Bea B", pick: "Ann A", nickname: "Carol" },
].map((p) => ({ ...p, event_date: "2026-10-03" }));
// Past cards, for the social-push gate (SOCIAL_MIN_CARDS, default 2). Alice, Bob
// and Carol have played both finished cards in CARD. Eve has one of them, plus
// picks on two dates no card is on (made up, so they must not count), plus
// this week's.
const EVE = "e7e00000-0000-4000-8000-000000000005";
const HISTORY = [
  ...["a11ce000-0000-4000-8000-000000000001", "b0b00000-0000-4000-8000-000000000002", "ca201000-0000-4000-8000-000000000003"]
    .flatMap((u) => ["2026-09-26", "2026-10-01"].map((d) => ({ user_id: u, event_date: d, f1: "Old A", f2: "Old B", pick: "Old A", nickname: "x" }))),
  { user_id: EVE, event_date: "2026-09-26", f1: "Old A", f2: "Old B", pick: "Old A", nickname: "Eve" },
  { user_id: EVE, event_date: "2026-09-20", f1: "Made Up", f2: "No Card", pick: "Made Up", nickname: "Eve" },
  { user_id: EVE, event_date: "2026-09-30", f1: "Made Up", f2: "No Card", pick: "Made Up", nickname: "Eve" },
  { user_id: EVE, event_date: "2026-10-03", f1: "Ann A", f2: "Bea B", pick: "Ann A", nickname: "Eve" },
];
const SUBS = ["a11ce000-0000-4000-8000-000000000001", "b0b00000-0000-4000-8000-000000000002", "ca201000-0000-4000-8000-000000000003", "da7e0000-0000-4000-8000-000000000004"]
  .map((u, i) => ({ user_id: u, nickname: ["alice", "bob", "carol", "dave"][i], endpoint: "https://fcm.googleapis.com/" + u, p256dh: "k", auth: "a", live_results: true }));
const CHALS = {
  "c1": { challenger_id: "b0b00000-0000-4000-8000-000000000002", challenger_name: "Bob", target_id: "a11ce000-0000-4000-8000-000000000001", target_name: "Alice",
    f1: "José Aldo", f2: "Sean O'Malley", stake: "Loser spins the wheel 🎡", status: "pending", event_date: "2026-10-03" },
  "c2": { challenger_id: "a11ce000-0000-4000-8000-000000000001", challenger_name: "Alice", target_id: "b0b00000-0000-4000-8000-000000000002", target_name: "Bob",
    f1: null, f2: null, stake: "Dinner", status: "accepted", event_date: "2026-10-03" },
};

// Blocks (0013_safety.sql): who has blocked whom. blocksState: "ok", "down" (500)
// or "missing" (404: 0013 not applied).
let BLOCKS = [], blocksState = "ok";
let INBOX = [], inboxState = "ok", PRUNES = [];   // roast_inbox rows written by send-push; retention deletes
let sent = [], log = new Set(), dataReads = 0, picksReads = 0, picksDown = false, dataDown = false;
const PRESENT = new Set();   // notif_log rows that already exist
let LOCK_AT = null;          // pick_locks.lock_at for the bout under test (null: no row)
let lockReads = 0;
globalThis.__webpush = { setVapidDetails() {}, sendNotification: async (sub, payload) => { sent.push({ to: sub.endpoint.split("/").pop(), ...JSON.parse(payload) }); } };
const inFilter = (url) => { const m = /user_id=in\.\(([^)]*)\)/.exec(decodeURIComponent(url)); return m ? m[1].split(",") : null; };
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.startsWith(DATA)) { dataReads++; return dataDown ? new Response("", { status: 502 }) : new Response(CARD, { status: 200 }); }
  if (url === SB + "/auth/v1/user") {
    const tok = (init.headers.Authorization || "").replace("Bearer ", "");
    return USERS[tok] ? json({ id: USERS[tok] }) : json({ msg: "bad jwt" }, 401);
  }
  if (url.startsWith(SB + "/rest/v1/notif_log")) {
    if ((init.method || "GET") === "POST") { log.add(init.body); return new Response("", { status: 201 }); }
    const ty = decodeURIComponent((/type=eq\.([^&]+)/.exec(url) || [])[1] || "");
    return json(PRESENT.has(ty) ? [{ event_date: "x" }] : []);
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
  if (url.startsWith(SB + "/rest/v1/pick_locks")) {
    lockReads++;
    return json(LOCK_AT ? [{ lock_at: LOCK_AT }] : []);
  }
  if (url.startsWith(SB + "/rest/v1/picks")) {
    picksReads++;
    const u = decodeURIComponent(url);
    if (!/promotion=eq\.ufc/.test(u)) return json({ error: "picks read without promotion=eq.ufc" }, 400);
    if (picksDown) return json({ error: "down" }, 500);
    const eq = /user_id=eq\.([^&]+)/.exec(u), deq = /event_date=eq\.([^&]+)/.exec(u), dlt = /event_date=lt\.([^&]+)/.exec(u);
    let rows = [...PICKS, ...HISTORY];
    if (eq) rows = rows.filter((p) => p.user_id === eq[1]);
    if (deq) rows = rows.filter((p) => p.event_date === deq[1]);
    if (dlt) rows = rows.filter((p) => p.event_date < dlt[1]);
    const din = /event_date=in\.\(([^)]*)\)/.exec(u);
    if (din) rows = rows.filter((p) => din[1].split(",").includes(p.event_date));
    return json(rows);
  }
  if (url.startsWith(SB + "/rest/v1/user_blocks")) {
    if (blocksState === "down") return json({ error: "down" }, 500);
    if (blocksState === "missing") return json({ code: "PGRST205" }, 404);
    const m = /or=\(blocker_id\.eq\.([^,]+),blocked_id\.eq\.([^)]+)\)/.exec(decodeURIComponent(url));
    if (!m || m[1] !== m[2]) return json({ error: "user_blocks read must name the sender both ways" }, 400);
    return json(BLOCKS.filter((b) => b.blocker_id === m[1] || b.blocked_id === m[1]));
  }
  // The roast inbox (0016_roast_inbox.sql): every row send-push writes. A
  // "missing" table (404) must not stop the push.
  if (url.startsWith(SB + "/rest/v1/roast_inbox")) {
    if ((init.method || "GET") === "POST") {
      if (inboxState === "missing") return json({ code: "PGRST205" }, 404);
      INBOX.push(...JSON.parse(init.body)); return new Response("", { status: 201 });
    }
    if (init.method === "DELETE" && /created_at=lt\./.test(url)) PRUNES.push(NOW);
    return new Response(null, { status: 204 });
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
  .replace(/^import webpush from "npm:web-push@[\d.]+";$/m, "const webpush = globalThis.__webpush;");
const { code } = await transform(src, { loader: "ts", format: "esm" });
// A data: URL has no base to resolve ../_shared/ against, so point those imports at the files.
const linkShared = (js) => js.replace(/from "\.\.\/_shared\/([\w-]+\.js)"/g,
  (_m, f) => `from "${pathToFileURL(join(ROOT, "supabase/functions/_shared", f)).href}"`);
const mod = await import("data:text/javascript;base64," + Buffer.from(linkShared(code)).toString("base64"));

// 20:00 ET on 2026-10-03 is 00:00 UTC on the 4th (EDT).
const MAIN = Date.UTC(2026, 9, 4, 0, 0);
let NOW = MAIN - 3 * 3600_000;
Date.now = () => NOW;

async function send(body, { auth = ANON, service = null } = {}) {
  sent = []; log = new Set(); INBOX = [];
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + auth };
  if (service) headers["X-Service-Key"] = service;
  const r = await handler(new Request("https://fn/send-push", { method: "POST", headers, body: JSON.stringify(body) }));
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, j, sent: sent.slice(), to: sent.map((s) => s.to).sort(), inbox: INBOX.slice() };
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
  PRESENT.add("result:jose-aldo-sean-o-malley:win"); dataReads = 0; picksReads = 0;
  const dup = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:win" });
  check("an already-sent result is answered from the log before any rebuild (no data.js or picks read)",
    dup.status === 200 && dup.j && dup.j.skipped === true && dataReads === 0 && picksReads === 0 && dup.sent.length === 0);
  PRESENT.clear();
  const early = await send({ event_date: "2026-10-03", type: "result:ann-a-bea-b:win", ...FORGED });
  check("a result the committed data doesn't have yet is refused (409), not guessed", early.status === 409 && early.sent.length === 0);
  // Inside the bout's lock grace the database still takes picks, so the audience
  // isn't final: 425 (not 409, which the scraper retries for 90s), nothing sent.
  LOCK_AT = new Date(Date.now() - 2 * 60_000).toISOString(); lockReads = 0;
  const grace = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:win" });
  check("a result inside its bout's lock grace waits (425, nothing sent, no notif_log claim)",
    grace.status === 425 && grace.sent.length === 0 && lockReads === 1 && ![...log].some((b) => b.includes("jose-aldo-sean-o-malley:win")));
  LOCK_AT = new Date(Date.now() - 6 * 60_000).toISOString();
  const after = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:win" });
  check("...and goes once the grace is over", after.status === 200 && after.to.join() === "a11ce000-0000-4000-8000-000000000001");
  LOCK_AT = null; log.clear();
  const norow = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:loss" });
  check("...while a bout with no lock row (its card's first bell) isn't held", norow.status === 200 && norow.to.join() === "b0b00000-0000-4000-8000-000000000002");
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
  const otherDay = await send({ event_date: "2026-10-02", type: "nudge-a11ce000-ca201000-1", include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("...dated today only (another date would mint a fresh dedup key)", otherDay.status === 403 && otherDay.sent.length === 0);
  const shortPrefix = await send({ event_date: "2026-10-03", type: "nudge-a11ce-ca201000-1", include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("...and naming the target's exact 8-char prefix (a shorter one would too)", shortPrefix.status === 403 && shortPrefix.sent.length === 0);
  const nudge = await send({ event_date: "2026-10-03", type: "nudge-a11ce000-ca201000-1", ...FORGED, include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] }, { auth: jwt("carol") });
  check("a valid nudge reaches only its one target, with server text", nudge.status === 200 && nudge.to.join() === "a11ce000-0000-4000-8000-000000000001" && clean(nudge) && /^carol noticed/.test(nudge.sent[0].body));

  const roast = await send({ event_date: "2026-10-03", type: "trash-talk-17", title: "HACKED", body: "You pick like a blindfolded raccoon. — Joe Rogan",
    include_user_ids: ["b0b00000-0000-4000-8000-000000000002", "bad id!"] }, { auth: jwt("alice") });
  check("trash talk: the roast is the sender's, the title is the server's and names the real sender",
    roast.status === 200 && roast.to.join() === "b0b00000-0000-4000-8000-000000000002" && roast.sent[0].title === "🎤 Joe Rogan (via alice)" && /raccoon/.test(roast.sent[0].body));
  check("roast inbox: the roast is left for exactly its recipient, with the server's title and the sent text",
    roast.inbox.length === 1 && roast.inbox[0].recipient_id === "b0b00000-0000-4000-8000-000000000002"
    && roast.inbox[0].title === "🎤 Joe Rogan (via alice)" && roast.inbox[0].body === roast.sent[0].body);
  const group = await send({ event_date: "2026-10-03", type: "trash-talk-40", body: "Group roast. — Joe Rogan" }, { auth: jwt("alice") });
  check("roast inbox: a whole-group roast leaves a row for everyone it pushed to, never the sender",
    group.status === 200 && group.inbox.map((r) => r.recipient_id).sort().join() === group.to.join() && !group.inbox.some((r) => r.recipient_id === "a11ce000-0000-4000-8000-000000000001"));
  check("roast inbox: nothing but a roast is written there", nudge.inbox.length === 0);
  const forgedAnon = await send({ event_date: "2026-10-03", type: "trash-talk-41", ...FORGED });
  check("roast inbox: a refused roast (anon key) writes nothing", forgedAnon.inbox.length === 0 && forgedAnon.sent.length === 0);
  inboxState = "missing";
  const noTable = await send({ event_date: "2026-10-03", type: "trash-talk-42", body: "Still lands. — Joe Rogan", include_user_ids: ["b0b00000-0000-4000-8000-000000000002"] }, { auth: jwt("alice") });
  check("roast inbox: without the table (0016 not applied) the push still goes out", noTable.status === 200 && noTable.sent.length === 1);
  inboxState = "ok";
  check("roast inbox: retention runs without waiting on a roast, at most hourly",
    PRUNES.length >= 1 && PRUNES.every((t, i) => !i || t - PRUNES[i - 1] >= 3600_000));
}

// A fresh account is not a sender: social pushes need picks on SOCIAL_MIN_CARDS
// finished cards, which the pick lock makes impossible to backfill.
{
  const src = readFileSync(join(ROOT, "supabase/functions/send-push/index.ts"), "utf8");
  check("web-push is imported at an exact version", /^import webpush from "npm:web-push@\d+\.\d+\.\d+";$/m.test(src));
  check("the shipped gate is on (SOCIAL_MIN_CARDS defaults to 2)", /Deno\.env\.get\("SOCIAL_MIN_CARDS"\) \?\? "2"/.test(src));
  const reqs = {
    roast: { type: "trash-talk-18", body: "HACKED evil.example — Joe Rogan" },
    "roast to targets": { type: "trash-talk-19", body: "HACKED evil.example — Joe Rogan", include_user_ids: ["a11ce000-0000-4000-8000-000000000001", "b0b00000-0000-4000-8000-000000000002"] },
    "pick announcement": { type: "pick-first-" + EVE },
    nudge: { type: "nudge-a11ce000-e7e00000-1", include_user_ids: ["a11ce000-0000-4000-8000-000000000001"] },
  };
  for (const [what, b] of Object.entries(reqs)) {
    const r = await send({ event_date: "2026-10-03", ...b }, { auth: jwt("eve") });
    check(`an account with one real finished card (and two made-up dates) cannot send a ${what} (403, nothing sent)`, r.status === 403 && r.sent.length === 0);
  }
  // 2026-10-01 is exactly SOCIAL_CARD_AGE_DAYS before NOW (2026-10-03): it counts.
  HISTORY.push({ user_id: EVE, event_date: "2026-10-01", f1: "Old A", f2: "Old B", pick: "Old A", nickname: "Eve" });
  const ok = await send({ event_date: "2026-10-03", type: "trash-talk-20", body: "Nice pick. — Joe Rogan" }, { auth: jwt("eve") });
  check("...and can once a second real card, exactly two days old, is on record (to every other subscriber)", ok.status === 200 && ok.sent.length === SUBS.length && !ok.to.includes(EVE));
  picksDown = true;
  const down = await send({ event_date: "2026-10-03", type: "trash-talk-21", body: "Nice pick. — Joe Rogan" }, { auth: jwt("alice") });
  check("the gate fails closed: an unreadable history sends nothing", down.status === 503 && down.sent.length === 0);
  picksDown = false;
  // loadCards caches for a minute from its last read (an earlier test read it
  // at MAIN - 50min); step past every read so the outage is actually seen.
  const was = NOW; NOW = MAIN + 3600_000; dataDown = true;
  const noCards = await send({ event_date: "2026-10-03", type: "trash-talk-22", body: "Nice pick. — Joe Rogan" }, { auth: jwt("alice") });
  check("...and so does an unreadable data.js (no list of real cards, nothing sent)", noCards.status === 503 && noCards.sent.length === 0);
  dataDown = false; NOW = was;
}

// Blocks: a social push never crosses one, in either direction.
{
  const A = "a11ce000-0000-4000-8000-000000000001", B = "b0b00000-0000-4000-8000-000000000002", C = "ca201000-0000-4000-8000-000000000003";
  BLOCKS = [{ blocker_id: B, blocked_id: A }];
  const roast = await send({ event_date: "2026-10-03", type: "trash-talk-30", body: "Nice pick. — Joe Rogan", include_user_ids: [B, C] }, { auth: jwt("alice") });
  check("blocks: a roast aimed at someone who blocked the sender skips them and still reaches the rest",
    roast.status === 200 && roast.to.join() === C);
  check("...and leaves no inbox row for them either", roast.inbox.map((r) => r.recipient_id).join() === C);
  const only = await send({ event_date: "2026-10-03", type: "trash-talk-31", body: "Nice pick. — Joe Rogan", include_user_ids: [B] }, { auth: jwt("alice") });
  check("...aimed only at them, nothing is sent (never widened to a broadcast)", only.status === 200 && only.sent.length === 0);
  check("...and its dedup key isn't spent", ![...log].some((l) => l.includes("trash-talk-31")));
  const group = await send({ event_date: "2026-10-03", type: "trash-talk-32", body: "Nice pick. — Joe Rogan" }, { auth: jwt("alice") });
  check("...a whole-group roast reaches everyone but the sender and the one who blocked them",
    group.status === 200 && !group.to.includes(B) && !group.to.includes(A) && group.sent.length === 2);
  const picking = await send({ event_date: "2026-10-03", type: "pick-first-" + A }, { auth: jwt("alice") });
  check("...so does 'is picking!'", picking.status === 200 && !picking.to.includes(B) && picking.sent.length === 2);
  const back = await send({ event_date: "2026-10-03", type: "nudge-a11ce000-b0b00000-1", include_user_ids: [A] }, { auth: jwt("bob") });
  check("...and the blocker can't reach the blocked either (Bob's nudge to Alice goes nowhere)", back.status === 200 && back.sent.length === 0);
  const chal = await send({ event_date: "2026-10-03", type: "chal-c1" }, { auth: jwt("bob") });
  check("...nor his challenge push", chal.status === 200 && chal.sent.length === 0);
  const res = await send({ event_date: "2026-10-03", type: "result:jose-aldo-sean-o-malley:loss" });
  check("result pushes aren't social: a block doesn't touch them", res.status === 200 && res.to.join() === B);
  const brief = await send({ event_date: "2026-10-03", type: "brief", title: "b", body: "b" }, { service: SERVICE });
  check("...nor our own functions' pushes", brief.status === 200 && brief.sent.length === 4);
  blocksState = "down";
  const down = await send({ event_date: "2026-10-03", type: "trash-talk-33", body: "Nice pick. — Joe Rogan" }, { auth: jwt("carol") });
  check("an unreadable block list fails closed (503, nothing sent)", down.status === 503 && down.sent.length === 0);
  blocksState = "missing";
  const missing = await send({ event_date: "2026-10-03", type: "trash-talk-34", body: "Nice pick. — Joe Rogan" }, { auth: jwt("carol") });
  check("...but a missing table (0013 not applied) means nobody has blocked anyone", missing.status === 200 && missing.sent.length === 3);
  blocksState = "ok"; BLOCKS = [];
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
