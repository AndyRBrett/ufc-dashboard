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
import { launchChromium } from "./lib/browser.mjs";

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

  // --- the pickers' Tale of the Tape: the room's top two, off the room's board ---
  {
    const t = ctx.taleOfTheTape(rows, ctx._curRoom().members, belt);
    const row = (l) => t.rows.find((r) => r.label === l);
    check("tape: the room's #1 and #2 on its own all-time board, members only",
      t && /Me/.test(t.a.name) && /JP/.test(t.b.name) && !/Outsider/.test(t.a.name + t.b.name) && t.a.pts === ctx.userPts(room.find((u) => u.user_id === "u-me")));
    check("tape: accuracy is the board's (100% vs 0%), with the edge marked", row("Accuracy").a === "100%" && row("Accuracy").b === "0%" && row("Accuracy").edge === 1);
    // Me called Delta Four at +250 (1/1); JP's only pick, Bravo Two at +130, lost (0/1).
    check("tape: underdog records read each bout's own line", row("Underdogs").a === "100% (1/1)" && row("Underdogs").b === "0% (0/1)");
    check("tape: head to head counts the cards both scored (1-0 here)", t.h2h.a === 1 && t.h2h.b === 0 && t.h2h.draw === 0);
    check("tape: no data reads as a dash, not a zero, and never takes the edge", row("Locks").a === "—" && row("Locks").edge === 0);
    check("tape: the verdict names who leads, from the numbers", /Me leads every column/.test(t.verdict));
    check("tape: the belt's reigns are credited to their holder", row("Titles").a === "1" && row("Titles").b === "0");
    // Identical picks: a drawn card, level columns, and the verdict says so.
    const same = rows.filter((r) => r.user_id !== "u-jp").concat(rows.filter((r) => r.user_id === "u-me").map((r) => ({ ...r, user_id: "u-jp", nickname: "🦂 JP" })));
    const tt = ctx.taleOfTheTape(same, ctx._curRoom().members, null);
    check("tape: a card both scored level is a draw, not a win", tt.h2h.draw === 1 && tt.h2h.a === 0 && tt.h2h.b === 0);
    check("tape: dead level on paper says so", /Dead level/.test(tt.verdict) && tt.rows.every((r) => r.edge === 0));
    // A number against no data isn't an edge: Me called a method, JP never has.
    const meth = rows.map((r) => r.user_id === "u-me" && r.f1 === "Alpha One" ? { ...r, method: "KO/TKO" } : r);
    const tm = ctx.taleOfTheTape(meth, ctx._curRoom().members, belt).rows.find((r) => r.label === "Methods");
    check("tape: a record against a dash takes no edge", tm.a !== "—" && tm.b === "—" && tm.edge === 0);
    check("tape: none outside a room or without a card",
      ctx.roomTapeEl(rows, null, belt, { name: "UFC 333", fights: [{ state: "pre" }] }) === null &&
      ctx.roomTapeEl(rows, ctx._curRoom(), belt, null) === null &&
      ctx.roomTapeEl(rows, ctx._curRoom(), belt, { name: "UFC 333", fights: [] }) === null);
    // It used to vanish at the first bell, right when the room is watching.
    check("tape: stays up once the card has started, and after it's over",
      ctx.roomTapeEl(rows, ctx._curRoom(), belt, { name: "UFC 333", fights: [{ state: "pre" }] }) !== null &&
      ctx.roomTapeEl(rows, ctx._curRoom(), belt, { name: "UFC 333", fights: [{ state: "post" }, { state: "live" }, { state: "pre" }] }) !== null &&
      ctx.roomTapeEl(rows, ctx._curRoom(), belt, { name: "UFC 333", fights: [{ state: "post" }, { state: "post" }] }) !== null);
    // Codex on #262: a started or finished card's tape must not read as pre-card.
    const ph = (p) => ctx.taleOfTheTape(rows, ctx._curRoom().members, belt, p);
    const lvl = (p) => ctx.taleOfTheTape(same, ctx._curRoom().members, null, p).verdict;
    check("tape: the copy follows the card's phase",
      ph().phase === "pre" && /big night/.test(ph().verdict) &&
      ph("live").phase === "live" && /rest of the night/.test(ph("live").verdict) &&
      ph("post").phase === "post" && /ground to make up/.test(ph("post").verdict) && !/night/.test(ph("post").verdict) &&
      /This card decides it/.test(lvl("live")) && /next card decides it/.test(lvl("post")));
    const tsrc = fn("roomTapeEl"), psrc = fn("drawTapePoster");
    check("tape: the board passes the card's phase, and the poster never says 'Before' a started card",
      /taleOfTheTape\(rows,room\.members,belt,phase\)/.test(tsrc) && /t\.phase==="live"/.test(psrc) && /t\.phase==="post"/.test(psrc));
    check("tape: a room with fewer than two scored members gets no tape",
      ctx.taleOfTheTape(rows.filter((r) => r.user_id !== "u-jp"), ctx._curRoom().members, belt) === null);
  }
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
// --- migration 0008: long codes, and a wrong code comes back empty ---------------------
{
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1], replies: { "/rest/v1/rpc/join_room POST": ({ body }) => ({ status: 200, json: { id: "r1", name: "Fight Club", code: body.p_code } }) } });
  await ctx.joinRoom("7k3m-9pqr-2x");
  const rpc = ctx.__calls.find((c) => /rpc\/join_room/.test(c.url || ""));
  check("a 10-char base32 code is accepted and normalised", rpc && rpc.body.p_code === "7K3M9PQR2X");
  const n = ctx.__calls.length;
  await ctx.joinRoom("7K3M9PQRUX");
  check("...but not with a letter Crockford base32 leaves out (U; I, L and O are read as 1, 1 and 0)", ctx.__calls.length === n && ctx.__toasts.some((t) => /doesn't look right/.test(t)));
}
{
  const replies = { "/rest/v1/rpc/join_room POST": { status: 200, json: null } };
  const ctx = makeCtx({ email: "me@x.test", replies, storage: { ufc_room_join: "AB12CD" } });
  const r = await ctx.joinRoom("AB12CD");
  check("an empty reply (how the database answers a wrong code) reads as no such room, and the code is forgotten",
    r === null && !ctx.__store.has("ufc_room_join") && ctx.__toasts.some((t) => /No room with that code/.test(t)));
  const ctx2 = makeCtx({ email: "me@x.test", replies: { "/rest/v1/rpc/join_room POST": { status: 400, json: { message: "too many attempts" } } } });
  await ctx2.joinRoom("AB12CD");
  check("a throttled account is told to wait", ctx2.__toasts.some((t) => /Too many wrong codes/.test(t)));
}
{
  const sql = readFileSync(join(ROOT, "supabase/migrations/0008_rooms_codes_throttle.sql"), "utf8");
  const jr = sql.slice(sql.indexOf("function public.join_room"));
  check("0008: a miss is recorded and returned as null, never raised (a raise would roll the record back)",
    /if r\.id is null then\s+insert into room_join_misses[\s\S]*?return null;/.test(jr) && !/raise exception 'no such room'/.test(jr));
  check("0008: the throttle is checked before the lookup", jr.indexOf("too many attempts") < jr.indexOf("from rooms where"));
  check("0008: joins are serialised per account before the miss count (a concurrent burst can't all pass it)",
    /pg_advisory_xact_lock\(hashtext\('room_join:' \|\| me\)\)/.test(jr) && jr.indexOf("pg_advisory_xact_lock") < jr.indexOf("select count(*) into misses"));
  check("0008: codes skip the UUID's fixed version/variant bytes (6 and 8)", /array\[0, 1, 2, 3, 4, 5, 7, 9, 10, 11\]/.test(sql));
}
{
  const ctx = makeCtx({ email: "me@x.test", replies: { "/rest/v1/rpc/join_room POST": { reject: true } }, storage: { ufc_room_join: "AB12CD" } });
  await ctx.joinRoom("AB12CD");
  check("a network failure keeps the pending join for next time", ctx.__store.get("ufc_room_join") === "AB12CD");
}

// --- migration 0018: a temporary password, run for real in PGlite ----------------------
{
  const { PGlite } = await import("@electric-sql/pglite");
  const mig = (f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8");
  const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222", C = "33333333-3333-3333-3333-333333333333";
  const db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
    grant usage on schema public to anon, authenticated;`);
  for (const m of ["0006_rooms.sql", "0008_rooms_codes_throttle.sql", "0018_room_passwords.sql"]) await db.exec(mig(m));
  const as = async (uid, sql, params = [], anon = false) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false), set_config('request.jwt.claims', '{"is_anonymous": ${anon}}', false);`);
    try { return await db.query(sql, params); } finally { await db.exec("reset role"); }
  };
  const tryAs = (...a) => as(...a).then((r) => ({ r }), (e) => ({ e: e.message }));
  const room = (await as(A, "select * from create_room('Fight Club')")).rows[0];
  const made = await tryAs(A, "select * from set_room_pass($1)", [room.id]);
  const pass = made.r && made.r.rows[0].pass;
  check("0018: a member makes a 6-char Crockford password that lasts 24 hours",
    /^[0-9A-HJKMNP-TV-Z]{6}$/.test(pass || "") && Math.abs(Date.parse(made.r.rows[0].pass_expires) - Date.now() - 864e5) < 6e4);
  check("0018: a non-member can't make one", /not a member/.test((await tryAs(B, "select * from set_room_pass($1)", [room.id])).e || ""));
  check("0018: the password can't be set directly (columns outside the UPDATE grant)",
    !!(await tryAs(A, "update rooms set pass = 'AAAAAA' where id = $1", [room.id])).e);
  const j = await as(B, "select * from join_room($1)", [pass.slice(0, 3).toLowerCase() + "-" + pass.slice(3)]);
  check("0018: typing the password (any case, with a dash) joins the room", j.rows[0].id === room.id &&
    (await db.query("select 1 from room_members where room_id = $1 and user_id = $2", [room.id, B])).rows.length === 1);
  const legacy = await as(C, "select * from join_room($1)", [room.code]);
  check("0018: the permanent code still joins", legacy.rows[0].id === room.id);
  check("0018: an anonymous session still can't join with a password", /link an email/.test((await tryAs(C, "select * from join_room($1)", [pass], true)).e || ""));
  await db.query("update rooms set pass_expires = now() - interval '1 minute' where id = $1", [room.id]);
  await db.query("delete from room_members where user_id = $1", [C]);
  const exp = await as(C, "select * from join_room($1)", [pass]);
  check("0018: an expired password joins nothing and counts as a miss",
    exp.rows[0].id === null && (await db.query("select count(*)::int n from room_join_misses where user_id = $1", [C])).rows[0].n === 1);
  await db.query("insert into room_join_misses (user_id, at) values ($1, now() - interval '2 days')", [C]);
  await as(C, "select * from join_room('ZZZZZZ')");
  check("0018: a miss still prunes misses older than a day (0008's housekeeping)",
    (await db.query("select count(*)::int n from room_join_misses where at < now() - interval '1 day'")).rows[0].n === 0);
  await as(A, "select * from set_room_pass($1)", [room.id]);
  const cl = await as(B, "select * from clear_room_pass($1)", [room.id]);
  check("0018: a member can end it early", cl.rows[0].pass === null && cl.rows[0].pass_expires === null);
  const sql = mig("0018_room_passwords.sql");
  const jr = sql.slice(sql.indexOf("function public.join_room"));
  check("0018: join_room keeps 0008's throttle, serialisation and null-on-miss",
    jr.indexOf("pg_advisory_xact_lock") < jr.indexOf("too many attempts") && jr.indexOf("too many attempts") < jr.indexOf("from rooms where") && /return null;/.test(jr) && !/raise exception 'no such room'/.test(jr) && /perform public\.room_join_misses_prune\(\)/.test(jr));
  check("0018: a new password never equals a live code or password", /not exists \(select 1 from rooms where code = c or pass = c\)/.test(sql));
}
// --- the app side of passwords ------------------------------------------------------
{
  const future = new Date(Date.now() + 5 * 3600e3).toISOString(), past = new Date(Date.now() - 6e4).toISOString();
  const ctx = makeCtx({ email: "me@x.test", rooms: [{ ...R1, pass: "K7M4QX", pass_expires: future }],
    replies: { "/rest/v1/rpc/join_room POST": ({ body }) => ({ status: 200, json: { id: "r1", name: "Fight Club", code: body.p_code } }) } });
  check("a live password is shown; an expired one is not", ctx.roomPass({ pass: "K7M4QX", pass_expires: future }) === "K7M4QX" && ctx.roomPass({ pass: "K7M4QX", pass_expires: past }) === null);
  await ctx.joinRoom("k7m 4qx");
  const rpc = ctx.__calls.find((c) => /rpc\/join_room/.test(c.url || ""));
  check("a typed 6-char password goes to join_room, normalised", rpc && rpc.body.p_code === "K7M4QX");
  check("look-alike letters are read as digits (O→0, I/L→1)", ctx.normRoomCode("ko-il2x") === "K0112X");
  await ctx.roomsLoad();
  ctx.renderRoomSheet();
  const flat = (n) => [n.textContent || "", ...(n.children || []).map(flat)].join(" ");
  const shown = flat(ctx.__els.roomList);
  check("the room sheet shows the live password and its share / end buttons", /Password K7M 4QX/.test(shown) && /Share password/.test(shown) && /End password/.test(shown));
  const sel = ctx.__calls.find((c) => /rest\/v1\/rooms\?select=/.test(c.url || ""));
  check("rooms load with the password columns", /pass,pass_expires/.test(sel.url));
}
{
  // Before 0018 is applied the columns don't exist: rooms still load.
  const replies = { "/rest/v1/rooms GET": ({ path }) => /pass/.test(path) ? { status: 400, json: { message: "column rooms.pass does not exist" } } : { status: 200, json: [R1] } };
  const ctx = makeCtx({ email: "me@x.test", replies });
  const got = await ctx.roomsLoad();
  check("before migration 0018, rooms load without passwords", got.length === 1 && got[0].pass === null);
}
{
  const ctx = makeCtx({ email: "me@x.test", rooms: [R1],
    replies: { "/rest/v1/rpc/set_room_pass POST": { status: 200, json: { id: "r1", pass: "K7M4QX", pass_expires: new Date(Date.now() + 864e5).toISOString() } } } });
  let shared = null;
  ctx.navigator.share = (d) => { shared = d; return Promise.resolve(); };
  await ctx.roomsLoad();
  await ctx.makeRoomPass("r1");
  check("making a password shares it as text, with no link", shared && /K7M 4QX/.test(shared.text) && !shared.url && !/https?:/.test(shared.text));
  shared = null;
  ctx._rooms[0].pass_expires = new Date(Date.now() + 90 * 60e3).toISOString();
  ctx._sharePass(ctx._rooms[0]);
  check("sharing later states the time actually left, not a fresh 24 hours", shared && /works for 2 more hours/.test(shared.text) && !/24/.test(shared.text));
}
{
  // Opened from a link in iOS Safari: ask before joining there.
  const ctx = makeCtx({ email: "me@x.test", href: "https://x.test/app/index.html?join=AB12CD" });
  ctx.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";
  let asked = 0; ctx.confirm = () => { asked++; return false; };
  ctx._roomsBoot();
  await settle();
  check("iOS Safari from a link: asks first, and Cancel joins nothing and forgets the code",
    asked === 1 && !ctx.__calls.some((c) => /join_room/.test(c.url || "")) && !ctx.__store.has("ufc_room_join"));
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
  const te = fn("roomTapeEl");
  check("the Tale of the Tape shows only in a room, through the card, and can't break the board",
    /if\(!room\|\|!ev\|\|!ev\.fights\|\|!ev\.fights\.length\)return null;/.test(te) && !/if\(!room[^\n]*state===/.test(te) && /catch\(e\)\{console\.warn\("\[tape\]"/.test(te));
  // Codex: the empty "nobody in the room has picked this card" board returned
  // before the tape, which is exactly when a pre-card tape matters most.
  const early = lb.slice(lb.indexOf("if(_room){var _re"), lb.indexOf("if(_room){var _re") + 700);
  check("the tape also shows when nobody in the room has picked the card yet (the early-return path)",
    /roomTapeEl\(rows,_room,belt,nextEv\)[\s\S]*?return;/.test(early) && (lb.match(/roomTapeEl\(rows,_room,belt,nextEv\)/g) || []).length === 2);
  check("the tape reaches the page as text (nicknames are other people's input)", !/innerHTML/.test(fn("taleEl")) && /_rmEl\(/.test(fn("taleEl")));
  check("the tape scores nothing itself: boardStandings and the belt only", !/_lbScoreUsers\(|pickPts\(/.test(fn("taleOfTheTape")) && /boardStandings\(rows,\{users:members\}\)/.test(fn("taleOfTheTape")));
  const rs = fn("renderRoomSheet");
  check("room names reach the page as text, never HTML", !/innerHTML\s*=\s*[^"'\s]/.test(rs) && /textContent/.test(fn("_rmEl")) && !/innerHTML/.test(fn("_syncRoomBtn")));
  const empty = lb.slice(lb.indexOf("if(_room){var _re"), lb.indexOf("if(_room){var _re") + 400);
  check("the empty-room message uses text nodes", /createTextNode\("Nobody in "\+_room\.name/.test(empty) && !/innerHTML[^=]*=[^"]*_room\.name/.test(empty));
  check("nudges on a room's board list (and push) members only", /var _inRoom=_room\?roomHas\(_room\):null;\s*var slackers=_slackersFor\(nextEv,(?:rows|_slRows)\)\.filter\(function\(u\)\{return u\.user_id&&\(!_inRoom\|\|_inRoom\(u\.user_id\)\);\}\)/.test(lb));
  check("every board render re-reads the room's roster (throttled)", /roomsRefreshForBoard\(\);/.test(lb));
  // "Delete forever" is one RPC (0014's delete_my_account); it must clear
  // owned rooms and seats in others (check:delete runs it for real).
  const m14 = readFileSync(join(ROOT, "supabase/migrations/0014_delete_account.sql"), "utf8");
  check("deleting an account deletes the rooms it owns and its seats in others", /'rooms:owner_id'/.test(m14) && /'room_members:user_id'/.test(m14));
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
    const browser = await launchChromium(chromium);
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
