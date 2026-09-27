// Uses the runtime's built-in Deno.serve — no deno.land/std import, so deploys
// don't depend on deno.land being up.
import webpush from "npm:web-push";
// v3 — spoiler-free by default: safe_title/safe_body go to everyone except
// subscribers with live_results = true (also supports include_user_ids targeting)

// Restrict which sites may invoke this endpoint. Comma-separated env override;
// defaults to the production GitHub Pages origin.
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://andyrbrett.github.io")
  .split(",").map((o) => o.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowOrigin = ALLOWED_ORIGINS.includes("*")
    ? "*"
    : ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };
}

// Best-effort client IP for rate limiting. X-Forwarded-For is a hop-by-hop list
// where each proxy *appends* the address it received the request from, so the
// left-most entry is whatever the caller itself claims (trivially spoofable —
// a caller can send a fresh fake value on every request to dodge the per-IP
// limiter entirely). The right-most entry is the one appended by the hop
// closest to us (Supabase's own edge gateway), which the caller cannot forge.
function clientIp(req: Request): string {
  const parts = (req.headers.get("x-forwarded-for") ?? "")
    .split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}

// Lightweight per-IP rate limit so a runaway/abusive caller can't spam pushes.
// In-memory and per-instance (resets on cold start) — a cheap guard, not a hard
// global quota (same trade-off as ai-breakdown).
const RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT") ?? "20");             // requests...
const RATE_WINDOW_MS = Number(Deno.env.get("RATE_WINDOW_MS") ?? "60000");  // ...per this window
const _hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (_hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  _hits.set(ip, recent);
  if (_hits.size > 5000) {
    for (const [k, v] of _hits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) _hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT;
}

// Global backstop, independent of the (spoofable) per-IP key above — caps total
// push volume even if every request claims a different IP.
const GLOBAL_RATE_LIMIT = Number(Deno.env.get("GLOBAL_RATE_LIMIT") ?? "200");
const GLOBAL_RATE_WINDOW_MS = Number(Deno.env.get("GLOBAL_RATE_WINDOW_MS") ?? "60000");
let _globalHits: number[] = [];
function globalRateLimited(): boolean {
  const now = Date.now();
  _globalHits = _globalHits.filter((t) => now - t < GLOBAL_RATE_WINDOW_MS);
  _globalHits.push(now);
  return _globalHits.length > GLOBAL_RATE_LIMIT;
}

// Only notification types the app actually sends. Anything else is rejected so
// the public anon key can't be used to mint arbitrary notification streams.
const TYPE_RE = /^(main|prelim|brief|register|result:.+|pick-(first|done)-.+|trash-talk-\d+|chal(-resp)?-[\w-]+|nudge-[\w-]+|swap-[\w-]+)$/;
// MAX_BODY must comfortably exceed the longest message any client can send.
// The AI trash-talk roast is now capped at 120 tokens (~500 chars of English),
// but 1600 is kept: it also covers roasts generated before the cap that a
// client may still be holding, and stays well under the ~4KB encrypted
// web-push payload limit. Do not tighten it to match the roast cap without
// checking every other notification type first.
const MAX_TITLE = 120, MAX_BODY = 1600;

// A push "endpoint" is a URL this function will POST to with the service-role
// key in hand, and `register` accepts it from any caller holding the public anon
// key — i.e. from anyone. Unrestricted, that is a server-side request forgery
// primitive: register an endpoint pointing at an internal address (or any third
// party) and every later send makes this function fetch it for you, from inside
// Supabase's network, on a schedule you choose.
//
// Only the four real browser push services are ever legitimate here. Hosts are
// matched exactly or as a leading-dot suffix so `evil-fcm.googleapis.com.attacker
// .com` cannot pass as `fcm.googleapis.com`. Overridable via env so a new
// provider can be admitted without a code change.
const PUSH_HOSTS = (Deno.env.get("PUSH_ENDPOINT_HOSTS") ??
  "fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,notify.windows.com")
  .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const MAX_ENDPOINT = 512, MAX_KEY = 256, MAX_USER_ID = 128, MAX_NICKNAME = 60;

// Registering a subscription claims an identity: the row is keyed on user_id and
// upserted on conflict, so whoever gets to pick user_id owns that user's
// notifications from then on. The anon key cannot establish that — it ships in
// index.html and is the same for everybody — and user_ids are not secret either,
// since the leaderboard's picks table is world-readable by design. So a caller
// proves who they are with their own Supabase session JWT, and may only register
// as themselves.
//
// Escape hatch, not a default: flipping this to "0" restores the old behaviour
// without a code deploy if the auth round-trip ever becomes the thing that is
// broken at 2am during a card.
const REQUIRE_JWT_FOR_REGISTER =
  (Deno.env.get("REQUIRE_JWT_FOR_REGISTER") ?? "1") !== "0";

// Resolve a bearer token to the user it belongs to, or null. Asking GoTrue is
// deliberate: it validates signature, expiry and revocation in one call and
// needs no JWT secret in this function's env. It costs one round-trip, but only
// on register — which happens when someone subscribes or changes a preference,
// not on the send path.
async function verifyUser(supabaseUrl: string, anonKey: string, token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { "apikey": anonKey, "Authorization": `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && typeof u.id === "string" && u.id ? u.id : null;
  } catch {
    return null;
  }
}

function allowedEndpoint(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

// ---- Who may send what -----------------------------------------------------
//
// Three kinds of caller, and what each may do:
//
//   service  a Supabase function of ours (check-results, send-reminders) that
//            proves it with the service-role key in X-Service-Key. Trusted:
//            its title, body and audience go out as given. The key rides in its
//            own header so Authorization can keep carrying the anon key the
//            gateway's JWT check expects, whatever format the service key has.
//   user     a signed-in app user, proven by their own session JWT (checked
//            against GoTrue). May send the social pushes (picks, nudges,
//            challenges, trash talk) AS THEMSELVES, and the result/reminder
//            backups below. The server writes every title and body except the
//            trash-talk roast itself (which is the message), and resolves every
//            audience it can from the database rather than the request.
//   anon     the public anon key, which ships in index.html and proves nothing.
//            May only trigger the result/reminder backups, which the server
//            rebuilds entirely from the committed data.js and the picks table.
//
// Before this, anyone holding the anon key could send any title and body to
// every subscriber under any type the regex admitted, e.g. a fake "Your pick
// WON!" to the whole group, or a "challenge" from someone else.
type Caller = { kind: "service" } | { kind: "user"; uid: string } | { kind: "anon" };

// Types only a service caller may send: their copy (the Friday brief's Lab
// numbers, a swap's who-replaced-whom) can't be rebuilt here.
const SERVICE_ONLY = /^(brief|swap-[\w-]+)$/;
// The app's backups for the cron senders: any caller may trigger them, but a
// non-service caller's text and audience are ignored and rebuilt from data.
const REBUILT = /^(main|prelim|result:.+)$/;
// Social pushes: a signed-in sender, sending as themselves.
const SOCIAL = /^(pick-(first|done)-.+|trash-talk-\d+|chal(-resp)?-[\w-]+|nudge-[\w-]+)$/;

function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Per-sender cap for social pushes, on top of the per-IP one: a verified
// user_id is a far better key than a spoofable address. In-memory, per
// instance, like the others.
const SENDER_LIMIT = Number(Deno.env.get("SENDER_LIMIT") ?? "30");          // pushes...
const SENDER_WINDOW_MS = Number(Deno.env.get("SENDER_WINDOW_MS") ?? "3600000"); // ...per hour
const _senderHits = new Map<string, number[]>();
function senderLimited(uid: string): boolean {
  const now = Date.now();
  const recent = (_senderHits.get(uid) ?? []).filter((t) => now - t < SENDER_WINDOW_MS);
  recent.push(now);
  _senderHits.set(uid, recent);
  return recent.length > SENDER_LIMIT;
}

// The card data, read from the committed data.js on main (the same source
// kick-scraper reads, and for the same reason: Pages can lag a blocked deploy).
// It is a JS literal, not JSON, and is never executed here: the few fields
// needed are matched out with patterns anchored on scrape.py's fixed layout.
const DATA_URL = Deno.env.get("DATA_URL") ??
  "https://raw.githubusercontent.com/AndyRBrett/ufc-dashboard/main/data.js";
export interface Bout { lbl: string; winner: string | null; state: string; f1: string; f2: string }
export interface Card { name: string; date: string; time: string; prelimTime: string | null; fights: Bout[] }
export function parseCards(js: string): Card[] {
  const i = js.indexOf("var EVENTS=");
  const ev = i >= 0 ? js.slice(i) : "";
  const out: Card[] = [];
  const head = /\{\s*name:"((?:[^"\\]|\\.)*)",\s*date:"(\d{4}-\d{2}-\d{2})"([\s\S]*?)fights:\[([\s\S]*?)\n\s*\]/g;
  let m: RegExpExecArray | null;
  while ((m = head.exec(ev)) !== null) {
    const [, name, date, meta, fightsSrc] = m;
    const time = (/\btime:"(\d{1,2}:\d{2})"/.exec(meta) || [])[1] || "";
    const prelimTime = (/\bprelimTime:"(\d{1,2}:\d{2})"/.exec(meta) || [])[1] || null;
    const fights: Bout[] = [];
    const fr = /\{lbl:"([^"]*)"[^\n]*?winner:(null|"((?:[^"\\]|\\.)*)")[^\n]*?state:"(\w+)"[^\n]*?f1:\{n:"((?:[^"\\]|\\.)*)"[^\n]*?f2:\{n:"((?:[^"\\]|\\.)*)"/g;
    let f: RegExpExecArray | null;
    while ((f = fr.exec(fightsSrc)) !== null) {
      fights.push({ lbl: f[1], winner: f[2] === "null" ? null : un(f[3]), state: f[4], f1: un(f[5]), f2: un(f[6]) });
    }
    out.push({ name: un(name), date, time, prelimTime, fights });
  }
  return out;
}
function un(s: string): string { return s.replace(/\\(.)/g, "$1"); }
let _cards: { at: number; cards: Card[] } | null = null;
async function loadCards(): Promise<Card[]> {
  if (_cards && Date.now() - _cards.at < 60_000) return _cards.cards;
  const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { headers: { "User-Agent": "UFC-Dashboard/1.0 (send-push)" } });
  if (!r.ok) throw new Error(`data.js HTTP ${r.status}`);
  const cards = parseCards(await r.text());
  _cards = { at: Date.now(), cards };
  return cards;
}

// The result key every sender derives (index.html's live poll, check-results):
// fold accents off, lowercase, collapse everything else to "-".
export function fightKey(winner: string, loser: string): string {
  let t = winner + "-" + loser;
  try { t = t.normalize("NFKD"); } catch { /* keep */ }
  return t.replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export function sameName(a: string, b: string): boolean {
  const n = (x: string) => { try { x = x.normalize("NFKD"); } catch { /* keep */ } return x.replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z]/g, ""); };
  return !!a && !!b && n(a) === n(b);
}

// America/New_York offset in hours for a given UTC instant (-4 in EDT, -5 in EST):
// the ET wall clock read back as if it were UTC, minus the real instant.
function etOffsetH(at: Date): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(at).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((wall - Math.floor(at.getTime() / 60000) * 60000) / 3600_000);
}
function segmentStart(card: Card, t: string): number {
  const [y, mo, d] = card.date.split("-").map(Number), [hh, mm] = t.split(":").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm));
  return guess.getTime() - etOffsetH(guess) * 3600_000;
}

function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const UID_RE = /^[\w-]{1,128}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface Msg {
  title: string; body: string; safe_title?: string; safe_body?: string;
  include_user_ids?: string[] | null; exclude_user_id?: string | null; url?: string; kind?: string;
}
type Built = { ok: true; msg: Msg } | { ok: false; status: number; error: string };

// Builds what actually gets sent for a non-service caller, from data this
// function trusts: the committed card, the picks and challenges tables, and the
// verified sender. Returns an error (not a best guess) when it can't.
async function buildMsg(
  body: ReqBody, caller: Caller, sb: string, sbHeaders: Record<string, string>, now: number,
): Promise<Built> {
  const t = body.type, date = String(body.event_date ?? "");
  const get = async (path: string) => {
    const r = await fetch(`${sb}/rest/v1/${path}`, { headers: sbHeaders });
    if (!r.ok) throw new Error(`${path.split("?")[0]} HTTP ${r.status}`);
    return await r.json();
  };
  const nickOf = async (uid: string): Promise<string> => {
    try {
      const subs = await get(`push_subs?user_id=eq.${encodeURIComponent(uid)}&select=nickname&limit=1`);
      if (subs[0]?.nickname) return clean(subs[0].nickname, 30);
      const p = await get(`picks?user_id=eq.${encodeURIComponent(uid)}&promotion=eq.ufc&select=nickname&order=updated_at.desc&limit=1`);
      if (p[0]?.nickname) return clean(p[0].nickname, 30);
    } catch { /* fall through */ }
    return "Someone";
  };
  const shortName = (c: Card) => c.name.replace("UFC Fight Night: ", "");

  // Reminder backups: only for a real segment, and only in the hour before it.
  if (t === "main" || t === "prelim") {
    const card = (await loadCards()).find((c) => c.date === date);
    const at = card && (t === "main" ? card.time : card.prelimTime);
    if (!card || !at) return { ok: false, status: 409, error: "No such segment" };
    const start = segmentStart(card, at);
    if (now < start - 75 * 60_000 || now > start + 10 * 60_000) return { ok: false, status: 409, error: "Not in the reminder window" };
    const head = "🥊 " + card.name.split(":")[0];
    return { ok: true, msg: t === "main"
      ? { title: head + " — Main Card", body: "Starting in under 1 hour. Lock in your picks!" }
      : { title: head + " — Prelims", body: "Starting in under 1 hour." } };
  }

  // Result backup: the bout must be final in the committed data, and the
  // audience is read from the picks table, never taken from the request.
  const rm = /^result:(.+):(win|loss)$/.exec(t);
  if (rm) {
    const card = (await loadCards()).find((c) => c.date === date);
    const bout = card?.fights.find((f) => f.state === "post" && f.winner &&
      fightKey(f.winner, sameName(f.winner, f.f1) ? f.f2 : f.f1) === rm[1]);
    if (!bout || !bout.winner) return { ok: false, status: 409, error: "Result not final yet" };
    const winner = bout.winner, loser = sameName(winner, bout.f1) ? bout.f2 : bout.f1;
    const ids = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const r = await fetch(`${sb}/rest/v1/picks?select=user_id,f1,f2,pick&event_date=eq.${encodeURIComponent(date)}&promotion=eq.ufc`,
        { headers: { ...sbHeaders, Range: `${from}-${from + 999}` } });
      if (!r.ok) return { ok: false, status: 502, error: "Could not read picks" };
      const rows: { user_id: string; f1: string; f2: string; pick: string }[] = await r.json();
      for (const p of rows) {
        const onBout = (sameName(p.f1, bout.f1) && sameName(p.f2, bout.f2)) || (sameName(p.f1, bout.f2) && sameName(p.f2, bout.f1));
        if (onBout && p.user_id && sameName(p.pick, winner) === (rm[2] === "win")) ids.add(p.user_id);
      }
      if (rows.length < 1000) break;
    }
    if (!ids.size) return { ok: false, status: 409, error: "Nobody to tell" };
    return { ok: true, msg: {
      title: rm[2] === "win" ? "Your pick WON! 🔥" : "Tough luck ❌",
      body: rm[2] === "win" ? `${winner} def. ${loser} — you called it!` : `${winner} def. ${loser}`,
      safe_title: "🥊 Fight result is in",
      safe_body: "A fight you picked is final — open the app to see how you did. (No spoilers here!)",
      include_user_ids: [...ids],
    } };
  }

  if (!SOCIAL.test(t)) return { ok: false, status: 403, error: "Not allowed for this caller" };
  if (caller.kind !== "user") return { ok: false, status: 401, error: "Sign-in required" };
  const me = caller.uid;
  if (!DATE_RE.test(date)) return { ok: false, status: 400, error: "Bad event_date" };
  if (senderLimited(me)) return { ok: false, status: 429, error: "Too many pushes — slow down" };
  const nick = await nickOf(me);

  // "X is picking!" / "X is locked in!": only about yourself.
  const pm = /^pick-(first|done)-(.+)$/.exec(t);
  if (pm) {
    if (pm[2] !== me) return { ok: false, status: 403, error: "Can only announce your own picks" };
    const card = (await loadCards()).find((c) => c.date === date);
    if (!card) return { ok: false, status: 409, error: "No such card" };
    return { ok: true, msg: pm[1] === "first"
      ? { title: `🎯 ${nick} is picking!`, body: `${nick} just made their first pick for ${shortName(card)}`, exclude_user_id: me }
      : { title: `🥊 ${nick} is locked in!`, body: `${nick} completed all main card picks for ${shortName(card)}`, exclude_user_id: me } };
  }

  // Nudge: from you, to the one person the type names, at most 3 a day. The
  // cap is the dedup key itself, so every part of it is pinned: today's date
  // (UTC, as the app sends it), the target's and sender's exact 8-char id
  // prefixes, and a slot of 1-3. Otherwise a new date or a shorter prefix
  // would mint a fresh key and a 4th, 5th... nudge.
  const nm = /^nudge-([\w]{1,8})-([\w]{1,8})-(\d+)$/.exec(t);
  if (nm) {
    const to = Array.isArray(body.include_user_ids) ? body.include_user_ids : [];
    if (date !== new Date(now).toISOString().slice(0, 10) || nm[2] !== me.slice(0, 8) || to.length !== 1 ||
        !UID_RE.test(to[0]) || nm[1] !== to[0].slice(0, 8) || !/^[1-3]$/.test(nm[3])) {
      return { ok: false, status: 403, error: "Bad nudge" };
    }
    const card = (await loadCards()).filter((c) => c.date >= date && c.fights.some((f) => f.state === "pre"))
      .sort((a, b) => a.date < b.date ? -1 : 1)[0];
    return { ok: true, msg: { title: "⏰ Card locks soon!",
      body: `${nick} noticed you still have picks to make${card ? " for " + shortName(card) : ""} 👀`, include_user_ids: [to[0]] } };
  }

  // Challenge / response: read the row; only its challenger may announce it,
  // only its target may accept it, and it goes to the other party only.
  const cm = /^chal(-resp)?-([\w-]+)$/.exec(t);
  if (cm) {
    let rows: { challenger_id: string; challenger_name: string; target_id: string; target_name: string; f1: string | null; f2: string | null; stake: string; status: string; event_date: string }[];
    try { rows = await get(`challenges?id=eq.${encodeURIComponent(cm[2])}&select=challenger_id,challenger_name,target_id,target_name,f1,f2,stake,status,event_date`); }
    catch { return { ok: false, status: 502, error: "Could not read challenge" }; }
    const c = rows[0];
    if (!c || c.event_date !== date) return { ok: false, status: 404, error: "No such challenge" };
    const fight = c.f1 && c.f2 ? `${c.f1.split(" ").pop()} vs ${c.f2.split(" ").pop()}` : "Whole card";
    const stake = clean(c.stake, 120);
    if (!cm[1]) {
      if (c.challenger_id !== me) return { ok: false, status: 403, error: "Not your challenge" };
      return { ok: true, msg: { title: `⚔️ ${clean(c.challenger_name, 30) || nick} challenged you!`, body: `${fight} — ${stake}`,
        include_user_ids: [c.target_id], url: "./?inbox=1", kind: "challenge" } };
    }
    if (c.target_id !== me || c.status !== "accepted") return { ok: false, status: 403, error: "Not yours to accept" };
    return { ok: true, msg: { title: `⚔️ ${clean(c.target_name, 30) || nick} accepted your challenge!`, body: `${fight} — ${stake} · It's on!`,
      include_user_ids: [c.challenger_id], url: "./?inbox=1", kind: "challenge" } };
  }

  // Trash talk: the roast is the message, so its text is the sender's to
  // choose (capped); the title is ours, naming the real sender.
  const text = clean(body.body, MAX_BODY);
  if (!text) return { ok: false, status: 400, error: "Empty trash talk" };
  const dash = text.lastIndexOf("—");
  const persona = clean(dash >= 0 ? text.slice(dash + 1) : "", 40) || "A famous voice";
  let to: string[] | null = null;
  if (Array.isArray(body.include_user_ids) && body.include_user_ids.length) {
    to = body.include_user_ids.filter((u) => typeof u === "string" && UID_RE.test(u) && u !== me).slice(0, 60);
    if (!to.length) return { ok: false, status: 400, error: "No valid targets" };
  }
  return { ok: true, msg: { title: `🎤 ${persona} (via ${nick})`, body: text, include_user_ids: to, exclude_user_id: me } };
}

async function alreadySent(sb: string, h: Record<string, string>, date: string, type: string): Promise<boolean> {
  const r = await fetch(`${sb}/rest/v1/notif_log?event_date=eq.${encodeURIComponent(date)}&type=eq.${encodeURIComponent(type)}&select=event_date`, { headers: h });
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0;
}

interface ReqBody {
  event_date?: string;
  type: string;
  title?: string;
  body?: string;
  // Spoiler-free variant. When present, only subscribers who opted in to live
  // results (push_subs.live_results = true) get title/body; everyone else gets
  // safe_title/safe_body. Spoiler-free is the default for all subscribers.
  safe_title?: string;
  safe_body?: string;
  exclude_user_id?: string | null;
  // Senders may have a push_subs row registered under an older anonymous
  // user_id, which exclude_user_id can't match — excluding the device's push
  // endpoint as well guarantees they never receive their own notification.
  exclude_endpoint?: string | null;
  include_user_ids?: string[] | null;
  // Optional client-routing hints forwarded into the push payload: `url` is a
  // same-app relative link the SW opens on tap; `kind` lets the SW route the
  // tap (e.g. "challenge" opens the challenge inbox instead of the trash sheet).
  url?: string;
  kind?: string;
  // type="register" fields
  user_id?: string;
  nickname?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  live_results?: boolean;
}

Deno.serve(async (req) => {
  const CORS = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
  }

  const ANON_KEY = Deno.env.get("SB_ANON_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const isAnonKey = ANON_KEY !== "" && bearer === ANON_KEY;
  // A signed-in caller sends their own session JWT instead of the anon key, so
  // the flat equality check this replaced would have turned every authenticated
  // request away. Shape is all that is checked here — three dot-separated
  // segments — and it confers no trust whatsoever; register verifies the token
  // against GoTrue below, and every other path is anon-key-equivalent exactly as
  // it was before.
  const looksLikeJwt = bearer.split(".").length === 3 && bearer.length > 40;
  if (ANON_KEY && !isAnonKey && !looksLikeJwt) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY");
  const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");

  if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !SUPABASE_URL || !SERVICE_ROLE_KEY || !VAPID_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: CORS });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  const ip = clientIp(req);
  if (rateLimited(ip) || globalRateLimited()) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded — slow down" }), { status: 429, headers: CORS });
  }
  if (!body || typeof body !== "object" || !body.type || !TYPE_RE.test(body.type)) {
    return new Response(JSON.stringify({ error: "Unknown notification type" }), { status: 400, headers: CORS });
  }
  if ((body.title ?? "").length > MAX_TITLE || (body.body ?? "").length > MAX_BODY ||
      (body.safe_title ?? "").length > MAX_TITLE || (body.safe_body ?? "").length > MAX_BODY) {
    return new Response(JSON.stringify({ error: "Notification content too long" }), { status: 400, headers: CORS });
  }

  const sbHeaders = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Subscription registration — uses service role to bypass RLS on push_subs
  if (body.type === "register") {
    const { user_id, nickname, endpoint, p256dh, auth } = body;
    if (!user_id || !endpoint || !p256dh || !auth) {
      return new Response(JSON.stringify({ error: "Missing required subscription fields" }), { status: 400, headers: CORS });
    }
    // Bound every stored field. Without caps a caller can park megabytes in
    // push_subs through an endpoint that is never delivered to.
    if (user_id.length > MAX_USER_ID || endpoint.length > MAX_ENDPOINT ||
        p256dh.length > MAX_KEY || auth.length > MAX_KEY ||
        (nickname ?? "").length > MAX_NICKNAME) {
      return new Response(JSON.stringify({ error: "Subscription field too long" }), { status: 400, headers: CORS });
    }
    if (!allowedEndpoint(endpoint)) {
      return new Response(JSON.stringify({ error: "Unrecognised push endpoint" }), { status: 400, headers: CORS });
    }
    // You may only register as yourself. Without this, reading any user_id off
    // the public leaderboard and re-registering it with your own endpoint took
    // over that person's notifications: the upsert below conflicts on user_id,
    // so their row is overwritten rather than added to.
    if (REQUIRE_JWT_FOR_REGISTER) {
      const callerId = await verifyUser(SUPABASE_URL, ANON_KEY, isAnonKey ? "" : bearer);
      if (!callerId) {
        return new Response(
          JSON.stringify({ error: "Sign-in required to register for notifications" }),
          { status: 401, headers: CORS },
        );
      }
      if (callerId !== user_id) {
        return new Response(
          JSON.stringify({ error: "Cannot register a subscription for another user" }),
          { status: 403, headers: CORS },
        );
      }
    }
    const row: Record<string, unknown> = {
      user_id,
      nickname: nickname || user_id.slice(0, 8),
      endpoint,
      p256dh,
      auth,
      live_results: body.live_results === true,
    };
    const upsert = (r: Record<string, unknown>) => fetch(
      `${SUPABASE_URL}/rest/v1/push_subs?on_conflict=user_id`,
      {
        method: "POST",
        headers: { ...sbHeaders, "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(r),
      }
    );
    let upsertRes = await upsert(row);
    if (!upsertRes.ok) {
      // live_results column may not exist yet (migration 0002 not applied) —
      // retry without it; the subscriber stays spoiler-free by default.
      delete row.live_results;
      upsertRes = await upsert(row);
    }
    if (!upsertRes.ok) {
      const detail = await upsertRes.text();
      return new Response(JSON.stringify({ error: "Failed to save subscription", detail }), { status: 502, headers: CORS });
    }
    // The upsert conflicts on user_id, so a device whose anonymous user_id has
    // changed leaves a stale row with the same endpoint under the old id —
    // causing duplicate (and self-) notifications. Remove those here.
    await fetch(
      `${SUPABASE_URL}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(endpoint)}&user_id=neq.${encodeURIComponent(user_id)}`,
      { method: "DELETE", headers: sbHeaders }
    ).catch(() => {});
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: CORS });
  }

  if (!body.event_date || !body.type) {
    return new Response(JSON.stringify({ error: "Missing event_date or type" }), { status: 400, headers: CORS });
  }

  // Who is asking (see "Who may send what" above). A JWT that doesn't verify is
  // refused outright rather than treated as anon: it was meant to be someone.
  let caller: Caller;
  if (sameSecret(req.headers.get("X-Service-Key") ?? "", SERVICE_ROLE_KEY)) caller = { kind: "service" };
  else if (isAnonKey || !ANON_KEY) caller = { kind: "anon" };
  else {
    const uid = await verifyUser(SUPABASE_URL, ANON_KEY, bearer);
    if (!uid) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
    caller = { kind: "user", uid };
  }
  if (caller.kind !== "service") {
    if (SERVICE_ONLY.test(body.type)) {
      return new Response(JSON.stringify({ error: "Not allowed for this caller" }), { status: 403, headers: CORS });
    }
    // Already sent? Answer before the rebuild: every phone that sees a result
    // asks for the same push, and rebuilding reads data.js and a card's picks.
    // (The atomic claim below still decides the race.)
    if (await alreadySent(SUPABASE_URL, sbHeaders, body.event_date, body.type)) {
      return new Response(JSON.stringify({ sent: 0, skipped: true }), { status: 200, headers: CORS });
    }
    let built: Built;
    try { built = await buildMsg(body, caller, SUPABASE_URL, sbHeaders, Date.now()); }
    catch (e) { return new Response(JSON.stringify({ error: "Could not build notification", detail: String(e).slice(0, 200) }), { status: 502, headers: CORS }); }
    if (!built.ok) return new Response(JSON.stringify({ error: built.error }), { status: built.status, headers: CORS });
    // Everything that reaches a phone now comes from the server; only the
    // device's own endpoint (a self-exclusion filter) is still taken as given.
    body = { type: body.type, event_date: body.event_date, exclude_endpoint: body.exclude_endpoint ?? null, ...built.msg };
  } else if (body.include_user_ids && (!Array.isArray(body.include_user_ids) || !body.include_user_ids.every((u) => typeof u === "string" && UID_RE.test(u)))) {
    return new Response(JSON.stringify({ error: "Bad include_user_ids" }), { status: 400, headers: CORS });
  }

  // Deduplicate: check if already sent for this event + type
  if (await alreadySent(SUPABASE_URL, sbHeaders, body.event_date, body.type)) {
    return new Response(JSON.stringify({ sent: 0, skipped: true }), { status: 200, headers: CORS });
  }

  // Insert log entry first (prevents race conditions — second caller will see this row)
  const logInsert = await fetch(`${SUPABASE_URL}/rest/v1/notif_log`, {
    method: "POST",
    headers: { ...sbHeaders, "Prefer": "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ event_date: body.event_date, type: body.type }),
  });
  if (!logInsert.ok && logInsert.status !== 409) {
    // If insert failed for a reason other than duplicate, another caller likely won the race
    return new Response(JSON.stringify({ sent: 0, skipped: true }), { status: 200, headers: CORS });
  }

  // Fetch push subscriptions — targeted list takes priority, then exclude-self, then all
  let subsFilter: string;
  if (body.include_user_ids && body.include_user_ids.length > 0) {
    const ids = body.include_user_ids.map(encodeURIComponent).join(",");
    subsFilter = `&user_id=in.(${ids})`;
  } else if (body.exclude_user_id) {
    subsFilter = `&user_id=neq.${encodeURIComponent(body.exclude_user_id)}`;
  } else {
    subsFilter = "";
  }
  let subsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/push_subs?select=endpoint,p256dh,auth,live_results${subsFilter}`,
    { headers: sbHeaders }
  );
  if (!subsRes.ok) {
    // live_results column may not exist yet (migration 0002 not applied) —
    // refetch without it; everyone is then treated as spoiler-free.
    subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subs?select=endpoint,p256dh,auth${subsFilter}`,
      { headers: sbHeaders }
    );
  }
  if (!subsRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch subscriptions" }), { status: 502, headers: CORS });
  }
  let subs: { endpoint: string; p256dh: string; auth: string; live_results?: boolean }[] = await subsRes.json();

  // Drop the sender's own device and collapse duplicate rows that share an
  // endpoint (left behind when a device re-registers under a new user_id).
  const seenEndpoints = new Set<string>();
  subs = subs.filter((sub) => {
    if (body.exclude_endpoint && sub.endpoint === body.exclude_endpoint) return false;
    if (seenEndpoints.has(sub.endpoint)) return false;
    seenEndpoints.add(sub.endpoint);
    return true;
  });

  if (!subs.length) {
    return new Response(JSON.stringify({ sent: 0, skipped: false, reason: "no subscribers" }), { status: 200, headers: CORS });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  // Only relative same-app URLs may be forwarded — a push must never be able
  // to deep-link the PWA to a foreign origin.
  // The one other page is the Fight Lab, and only by its known tabs (the
  // Friday brief links to #week).
  const safeUrl = body.url && /^\.\/((\?[\w=&-]*)?|lab\.html(#[a-z]+)?)$/.test(body.url) ? body.url : undefined;
  const routing = { url: safeUrl, kind: body.kind || undefined };
  const livePayload = JSON.stringify({ title: body.title, body: body.body, ...routing });
  // When a spoiler-free variant is supplied, it is the default; the full
  // result only goes to subscribers who explicitly opted in to live results.
  const safePayload = body.safe_title
    ? JSON.stringify({ title: body.safe_title, body: body.safe_body ?? "", ...routing })
    : null;
  let sent = 0, failed = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      const payload = safePayload && sub.live_results !== true ? safePayload : livePayload;
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err: any) {
      failed++;
      // 410 Gone = unsubscribed; 404 = endpoint gone. Remove the dead row so future sends skip it.
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await fetch(`${SUPABASE_URL}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
          method: "DELETE",
          headers: sbHeaders,
        }).catch(() => {});
      }
    }
  }));

  return new Response(JSON.stringify({ sent, failed }), { status: 200, headers: CORS });
});
