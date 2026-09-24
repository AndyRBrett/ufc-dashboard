// check:rooms — Watch Party rooms.
//
// Guards the ways rooms could go wrong without anything throwing:
//   - a room's board scoring differently from the main board (it must be the
//     same boardStandings(), scoped to the members — never a second scorer)
//   - an anonymous device joining a room (it would become a ghost member the
//     moment the phone is wiped) — the client sends it to "Link an email"
//     first and resumes the join after the code is verified
//   - a stale anonymous token being refused by the database and the join
//     silently failing — one refresh + retry, only for that refusal
//   - an invite link re-joining on every reload, or re-prompting forever for
//     a dead code
//   - a room name (other people's input) reaching the page as HTML
//
// Unit checks run the real `// rooms:start … :end` block from index.html with
// scoring.js in a VM against a stubbed Supabase; the last section boots the
// real app headlessly from an invite link.
import vm from "node:vm";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const SCORING = readFileSync(join(ROOT, "scoring.js"), "utf8");
let failures = 0;
const check = (name, ok) => { if (ok) console.log("  ✓ " + name); else { failures++; console.error("  ✗ " + name); } };
function block(name) {
  const a = html.indexOf(`// ${name}:start`), b = html.indexOf(`// ${name}:end`);
  if (a < 0 || b < 0) { console.error(`  ✗ index.html: block ${name} not found`); process.exit(1); }
  return html.slice(a, b);
}
function fn(name, src = html) {
  const a = src.indexOf(`function ${name}(`);
  if (a < 0) { console.error(`  ✗ function ${name} not found`); process.exit(1); }
  let i = src.indexOf("{", a), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(a, i + 1);
  }
  throw new Error("unbalanced " + name);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

// --- a VM with the rooms block, scoring.js and a fake Supabase -------------------
function makeCtx(opts = {}) {
  const store = new Map(Object.entries(opts.storage || {}));
  const calls = [];
  const els = {};
  const el = (id) => els[id] || (els[id] = {
    id, textContent: "", value: "", style: {}, children: [], innerHTML: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } },
    setAttribute() {}, appendChild(c) { this.children.push(c); }, querySelector() { return null; },
  });
  const rooms = opts.rooms || [];
  const replies = opts.replies || {};
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: console.error },
    String, Object, Array, JSON, Math, Date, isFinite, Number, Promise, RegExp, Error, URL, encodeURIComponent, setTimeout,
    DAY_MS: 86400000, EVENTS: opts.EVENTS || [], RESULTS_ARCHIVE: opts.RESULTS_ARCHIVE || {}, lbScope: "all", MAIN_CARD_BOUTS: 5,
    USER_ID: opts.USER_ID || "u-me", userName: "", _lbRows: null, _commRows: null,
    SUPABASE_URL: "https://sb.test", SUPABASE_ANON: "anon",
    _authReady: Promise.resolve(),
    _authBearer: () => "Bearer " + ctx.__token,
    __token: opts.token || "tok-1",
    _sessEmail: () => (ctx.__email || null),
    __email: opts.email || null,
    _refreshToken: (rt) => { calls.push({ refresh: rt }); return opts.refreshFails ? Promise.reject(new Error("auth 400")) : Promise.resolve({ access_token: "tok-2" }); },
    _adoptSession: (raw) => { ctx.__token = raw.access_token; },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { href: opts.href || "https://x.test/app/index.html", origin: "https://x.test", pathname: "/app/index.html" },
    history: { replaceState: (a, b, url) => { ctx.__url = url; } },
    document: { getElementById: (id) => el(id), createElement: (t) => ({ tag: t, className: "", textContent: "", children: [], appendChild(c) { this.children.push(c); } }), createTextNode: (t) => ({ text: t }) },
    navigator: {},
    toast: (m) => ctx.__toasts.push(m), __toasts: [],
    openAcct: () => { ctx.__acct++; el("acctBg").classList.add("open"); }, __acct: 0,
    loadLeaderboard: () => { ctx.__lb++; }, __lb: 0,
    confirm: () => true, prompt: () => null,
    _anyOverlayOpen: () => false,
    fetch: (url, init = {}) => {
      const method = init.method || "GET";
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method, body, auth: init.headers && init.headers.Authorization });
      const path = url.replace("https://sb.test", "");
      let r = replies[path.split("?")[0] + " " + method];
      if (typeof r === "function") r = r({ path, body, token: ctx.__token, n: calls.filter((c) => c.url === url).length });
      if (!r && path.startsWith("/rest/v1/rooms") && method === "GET") r = { status: 200, json: rooms };
      if (!r) r = { status: 200, json: null };
      if (r.reject) return Promise.reject(new Error("network"));
      return Promise.resolve({ ok: r.status < 300, status: r.status, text: () => Promise.resolve(r.json == null ? "" : JSON.stringify(r.json)) });
    },
  });
  ctx.__store = store; ctx.__calls = calls; ctx.__els = els;
  vm.runInContext(SCORING, ctx, { filename: "scoring.js" });
  vm.runInContext(block("rooms"), ctx, { filename: "index.html#rooms" });
  return ctx;
}
const R1 = { id: "r1", name: "Fight Club", code: "AB12CD", owner_id: "u-me", room_members: [{ user_id: "u-me" }, { user_id: "u-jp" }] };

// --- scope -------------------------------------------------------------------------
{
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1] });
  const base = { date: "2026-10-03", mainCard: true };
  const everyone = ctx.roomScope(base);
  check("Everyone: the scope passes through with no users filter", !("users" in everyone) && everyone.date === base.date && everyone.mainCard === true);
  await ctx.roomsLoad();
  ctx.selectRoom("r1");
  const inRoom = ctx.roomScope(base);
  check("a selected room adds exactly its members to the scope", JSON.stringify(inRoom.users) === '["u-me","u-jp"]' && inRoom.date === base.date);
  check("the caller's scope object is never mutated", !("users" in base));
  check("the choice persists across reloads", ctx.__store.get("ufc_lb_room") === "r1");
  ctx.lbRoom = "gone";
  check("a room you left (or that was deleted) falls back to Everyone", !("users" in ctx.roomScope(base)));
}

// --- a room's board is the main board, filtered ------------------------------------
{
  const EVENTS = [{ date: "2026-10-03", name: "UFC 332", fotn: null, fights: [
    { f1: { n: "Alpha One" }, f2: { n: "Bravo Two" }, winner: "Alpha One", state: "post", method: "KO/TKO", lbl: "Main Card", odds: { f1: -150, f2: 130 } },
    { f1: { n: "Charlie Three" }, f2: { n: "Delta Four" }, winner: "Delta Four", state: "post", method: "Dec", lbl: "Main Card", odds: { f1: -300, f2: 250 } },
  ] }];
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1], EVENTS });
  const p = (uid, nick, f1, f2, pick) => ({ user_id: uid, nickname: nick, event_date: "2026-10-03", event_name: "UFC 332", f1, f2, pick, method: "", confidence: 0, bonus_pick: null, updated_at: "2026-10-01T00:00:00Z" });
  const rows = [
    p("u-me", "🥊 Me", "Alpha One", "Bravo Two", "Alpha One"), p("u-me", "🥊 Me", "Charlie Three", "Delta Four", "Delta Four"),
    p("u-jp", "🦂 JP", "Alpha One", "Bravo Two", "Bravo Two"),
    p("u-out", "😀 Outsider", "Alpha One", "Bravo Two", "Alpha One"), p("u-out", "😀 Outsider", "Charlie Three", "Delta Four", "Delta Four"),
  ];
  await ctx.roomsLoad(); ctx.selectRoom("r1");
  const room = ctx.boardStandings(rows, ctx.roomScope({ date: "2026-10-03" }));
  const all = ctx.boardStandings(rows, {});
  const pts = (list) => Object.fromEntries(list.map((u) => [u.user_id, ctx.userPts(u)]));
  check("the room board lists only members", JSON.stringify(room.map((u) => u.user_id).sort()) === '["u-jp","u-me"]');
  check("every member scores exactly what the main board gives them", Object.entries(pts(room)).every(([k, v]) => pts(all)[k] === v));
  const belt = ctx.computeBeltLineage(rows, { users: ctx._curRoom().members });
  check("the room's belt is contested only by members", belt && belt.reigns.every((r) => r.base !== "outsider"));
}

// --- joining needs an account -----------------------------------------------------
{
  const ctx = makeCtx({});
  await ctx.joinRoom(" ab12-cd ");
  check("no email: nothing is sent to the database", ctx.__calls.filter((c) => c.url).length === 0);
  check("no email: the Link-an-email sheet opens, saying why", ctx.__acct === 1 && /join room AB12CD/.test(ctx.__els.acctDesc.textContent) && /email/.test(ctx.__els.acctDesc.textContent));
  check("no email: the join is remembered for after sign-in", ctx.__store.get("ufc_room_join") === "AB12CD");
  ctx.__email = "me@x.test";
  ctx.__calls.length = 0;
  const origFetch = ctx.fetch;
  ctx.fetch = (url, init = {}) => {
    if (/rpc\/join_room/.test(url)) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ id: "r1", name: "Fight Club", code: "AB12CD" })) });
    if (/rest\/v1\/rooms/.test(url)) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify([R1])) });
    return origFetch(url, init);
  };
  ctx._roomsAfterSignIn();
  await settle();
  check("after sign-in the pending join completes and shows the room", ctx.lbRoom === "r1" && !ctx.__store.has("ufc_room_join") && ctx.__toasts.some((t) => /Joined Fight Club/.test(t)));
}
{
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1], replies: { "/rest/v1/rpc/join_room POST": ({ body }) => ({ status: 200, json: { id: "r1", name: "Fight Club", code: body.p_code } }) } });
  await ctx.joinRoom("ab 12 cd");
  const rpc = ctx.__calls.find((c) => /rpc\/join_room/.test(c.url || ""));
  check("a typed code is normalised (case, spaces, dashes) before it's sent", rpc && rpc.body.p_code === "AB12CD" && rpc.method === "POST");
  check("the call carries the user's session, not the bare anon key", rpc && rpc.auth === "Bearer tok-1");
  const n = ctx.__calls.length;
  await ctx.joinRoom("nope!");
  check("a malformed code never reaches the database", ctx.__calls.length === n && ctx.__toasts.some((t) => /doesn't look right/.test(t)));
}

// --- the stale-token refusal: refresh once, then retry -----------------------------
{
  const replies = { "/rest/v1/rpc/join_room POST": ({ token }) => token === "tok-1" ? { status: 400, json: { message: "link an email first" } } : { status: 200, json: { id: "r1", name: "Fight Club", code: "AB12CD" } } };
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1], replies, storage: { ufc_sb_session: JSON.stringify({ refresh_token: "rt-1" }) } });
  const r = await ctx.joinRoom("AB12CD");
  const rpcs = ctx.__calls.filter((c) => /rpc\/join_room/.test(c.url || ""));
  check("an anonymous-era token is refreshed once and the join retried", r && r.id === "r1" && rpcs.length === 2 && ctx.__calls.some((c) => c.refresh === "rt-1") && rpcs[1].auth === "Bearer tok-2");
}
{
  const replies = { "/rest/v1/rpc/join_room POST": { status: 400, json: { message: "no such room" } } };
  const ctx = makeCtx({ email: "me@x.test", replies, storage: { ufc_sb_session: JSON.stringify({ refresh_token: "rt-1" }), ufc_room_join: "AB12CD" } });
  await ctx.joinRoom("AB12CD");
  check("any other refusal is not retried", ctx.__calls.filter((c) => /rpc\/join_room/.test(c.url || "")).length === 1 && !ctx.__calls.some((c) => c.refresh));
  check("a dead code is forgotten (no re-prompt on every boot)", !ctx.__store.has("ufc_room_join") && ctx.__toasts.some((t) => /No room with that code/.test(t)));
}
{
  const ctx = makeCtx({ email: "me@x.test", replies: { "/rest/v1/rpc/join_room POST": { reject: true } }, storage: { ufc_room_join: "AB12CD" } });
  await ctx.joinRoom("AB12CD");
  check("a network failure keeps the pending join for next time", ctx.__store.get("ufc_room_join") === "AB12CD");
}

// --- create / leave -----------------------------------------------------------------
{
  const ctx = makeCtx({});
  await ctx.createRoom("Fight Club");
  check("creating needs an account too (no call, Link-an-email opens)", ctx.__acct === 1 && ctx.__calls.filter((c) => c.url).length === 0);
  const ctx2 = makeCtx({ email: "me@x.test", rooms: [R1], replies: { "/rest/v1/rpc/create_room POST": ({ body }) => ({ status: 200, json: { id: "r1", name: body.p_name, code: "AB12CD" } }) } });
  await ctx2.createRoom("  " + "x".repeat(60));
  const c = ctx2.__calls.find((x) => /rpc\/create_room/.test(x.url || ""));
  check("a room name is trimmed and capped at 40 before it's sent", c && c.body.p_name === "x".repeat(40));
}
{
  const other = { ...R1, id: "r2", owner_id: "u-jp" };
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1, other] });
  await ctx.roomsLoad(); ctx.selectRoom("r2");
  await ctx.leaveRoom("r2");
  const del = ctx.__calls.find((x) => x.method === "DELETE");
  check("leaving deletes only MY membership row", del && /room_members\?room_id=eq\.r2&user_id=eq\.u-me$/.test(del.url));
  check("leaving the room on screen switches the board to Everyone", ctx.lbRoom === null);
  ctx.__calls.length = 0;
  await ctx.leaveRoom("r1");
  const del2 = ctx.__calls.find((x) => x.method === "DELETE");
  check("the owner's Leave is a delete of the room", del2 && /\/rest\/v1\/rooms\?id=eq\.r1$/.test(del2.url));
}

// --- invite links -----------------------------------------------------------------
{
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1], href: "https://x.test/app/index.html?join=ab12cd&trash=hi#top" });
  check("the invite link is ?join=CODE on this page", ctx.roomInviteUrl({ code: "AB12CD" }) === "https://x.test/app/index.html?join=AB12CD");
  ctx._roomsBoot();
  await settle();
  check("?join= is removed from the URL (a reload doesn't re-join), other params kept", ctx.__url === "/app/index.html?trash=hi#top");
  check("re-tapping a link for a room I'm in just shows it, no join call", ctx.lbRoom === "r1" && !ctx.__calls.some((c) => /join_room/.test(c.url || "")) && !ctx.__store.has("ufc_room_join"));
}
{
  let open = true;
  const ctx = makeCtx({ href: "https://x.test/app/index.html?join=AB12CD" });
  ctx._anyOverlayOpen = () => open;   // the VM's globals are this object's properties
  ctx._roomsBoot();
  await settle();
  check("the join prompt waits while another sheet (the name prompt) is open", ctx.__acct === 0 && ctx.__store.get("ufc_room_join") === "AB12CD");
  open = false;
  await new Promise((r) => setTimeout(r, 1700));
  check("...and offers the join once that sheet closes", ctx.__acct === 1);
}

// --- another account's rooms never show ------------------------------------------
{
  const ctx = makeCtx({ email: "a@x.test", rooms: [R1], USER_ID: "u-me" });
  await ctx.roomsLoad(); ctx.selectRoom("r1");
  check("(setup) account A sees its room", !!ctx._curRoom());
  ctx.USER_ID = "u-b";                       // signed into account B
  check("switching accounts hides A's room at once, before any request", ctx._curRoom() === null && !("users" in ctx.roomScope({})));
  ctx.fetch = () => Promise.reject(new Error("network"));
  const got = await ctx.roomsLoad();
  check("a failed load for account B returns nothing of A's", got.length === 0 && ctx._rooms.length === 0 && ctx._curRoom() === null);
}
// --- the roster refreshes with the board ---------------------------------------------
{
  const rooms = [JSON.parse(JSON.stringify(R1))];
  const ctx = makeCtx({ email: "me@x.test", rooms });
  ctx.__els.lbPanel = undefined;
  await ctx.roomsLoad(); ctx.selectRoom("r1");
  ctx.document.getElementById("lbPanel").classList.add("open");
  ctx.__lb = 0;
  ctx.roomsRefreshForBoard();
  await settle();
  check("a board refresh within a minute doesn't re-read the roster", ctx.__lb === 0 && ctx.__calls.filter((c) => /rest\/v1\/rooms/.test(c.url || "")).length === 1);
  ctx._roomsAt = 0;
  ctx.roomsRefreshForBoard();
  await settle();
  check("an unchanged roster doesn't re-render the board", ctx.__lb === 0);
  rooms[0].room_members.push({ user_id: "u-new" });
  ctx._roomsAt = 0;
  ctx.roomsRefreshForBoard();
  await settle();
  check("a member who joined shows up: the board re-renders with them", ctx.__lb === 1 && ctx._curRoom().members.includes("u-new"));
  rooms.length = 0;
  ctx._roomsAt = 0; ctx.__lb = 0;
  ctx.roomsRefreshForBoard();
  await settle();
  check("a room deleted under you falls back to Everyone and re-renders", ctx.__lb === 1 && ctx._curRoom() === null);
  const inR = ctx.roomHas({ members: ["u-me"] });
  check("roomHas matches members only (prototype-free)", inR("u-me") && !inR("u-x") && !inR("constructor"));
}

// --- wiring in the page -------------------------------------------------------------
{
  const lb = fn("loadLeaderboard");
  check("the board scores a room through boardStandings + roomScope (no second scorer)", /boardStandings\(rows,roomScope\(/.test(lb) && !/_lbScoreUsers\(/.test(lb));
  check("the board's belt is the room's belt when a room is selected", /computeBeltLineage\(rows,_room\?\{users:_room\.members\}:null\)/.test(lb));
  const rs = fn("renderRoomSheet");
  check("room names reach the page as text, never HTML", !/innerHTML\s*=\s*[^"'\s]/.test(rs) && /textContent/.test(fn("_rmEl")) && !/innerHTML/.test(fn("_syncRoomBtn")));
  const empty = lb.slice(lb.indexOf("if(_room){var _re"), lb.indexOf("if(_room){var _re") + 400);
  check("the empty-room message uses text nodes", /createTextNode\("Nobody in "\+_room\.name/.test(empty) && !/innerHTML[^=]*=[^"]*_room\.name/.test(empty));
  check("nudges on a room's board list (and push) members only", /var _inRoom=_room\?roomHas\(_room\):null;\s*var slackers=_slackersFor\(nextEv,rows\)\.filter\(function\(u\)\{return u\.user_id&&\(!_inRoom\|\|_inRoom\(u\.user_id\)\);\}\)/.test(lb));
  check("every board render re-reads the room's roster (throttled)", /roomsRefreshForBoard\(\);/.test(lb));
  const del = fn("deleteAccount");
  check("deleting an account deletes the rooms it owns and its seats in others", /"\/rest\/v1\/rooms\?owner_id=eq\."/.test(del) && /"\/rest\/v1\/room_members\?user_id=eq\."/.test(del));
  check("...and a failure there is reported, not swallowed", /throw new Error\("delete rooms "/.test(del) && /throw new Error\("delete room seats "/.test(del));
  check("the room sheet is a real overlay (Escape closes it, What's New waits for it)", /\["roomBg",function\(\)\{closeRoomSheet\(\);\}\]/.test(html));
  check("a sign-in resumes a pending join", /function _postSignIn\(prevId,email\)\{\s*_roomsAfterSignIn\(\);/.test(html));
  check("?join= is read before the tap router rewrites the URL", html.indexOf("_roomsBoot();\n(function(){\n  var params=new URLSearchParams") > 0);
}

// --- boots from an invite link ------------------------------------------------------
{
  const require = createRequire(import.meta.url);
  let chromium = null;
  try { ({ chromium } = require("playwright")); } catch { try { ({ chromium } = require("playwright-core")); } catch {} }
  if (!chromium) { failures++; console.error("  ✗ Playwright not installed (npm install)"); }
  else {
    const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".mp3": "audio/mpeg" };
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
      const file = join(ROOT, p);
      if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }); res.end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const exe = process.env.PLAYWRIGHT_BROWSERS_PATH ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium") : undefined;
    const browser = await chromium.launch(exe && existsSync(exe) ? { executablePath: exe } : {});
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => { try { localStorage.setItem("ufc_uid", "u-Andy"); localStorage.setItem("ufc_name", "🥊 Andy"); localStorage.setItem("ufc_whatsnew_seen", "9999"); } catch (e) {} });
      let joinCalls = 0;
      await page.route(/supabase\.co/, (route) => { if (/join_room/.test(route.request().url())) joinCalls++; route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); });
      await page.goto(base + "/index.html?join=ab12cd", { waitUntil: "load", timeout: 20000 });
      await page.waitForFunction(() => document.getElementById("acctBg").classList.contains("open"), null, { timeout: 12000 }).catch(() => {});
      const st = await page.evaluate(() => ({
        acct: document.getElementById("acctBg").classList.contains("open"),
        desc: document.getElementById("acctDesc").textContent,
        url: location.search, pending: localStorage.getItem("ufc_room_join"),
        btn: (document.getElementById("lbRoomBtn") || {}).textContent,
      }));
      check("boot from an invite, no account: the Link-an-email sheet opens for that room", st.acct && /join room AB12CD/.test(st.desc));
      check("boot from an invite: the code is held, the URL is cleaned, nothing is joined yet", st.pending === "AB12CD" && !/join=/.test(st.url) && joinCalls === 0);
      check("the Ranks bar carries the room picker (Everyone by default)", /Everyone/.test(st.btn || ""));
      check("no page errors while booting from an invite", errors.length === 0 || (console.error("    " + errors.join("\n    ")), false));
    } finally { await browser.close(); server.close(); }
  }
}

if (failures) { console.error(`\ncheck:rooms — ${failures} failure(s)`); process.exit(1); }
console.log("\ncheck:rooms — all good");
