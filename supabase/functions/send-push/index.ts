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
const TYPE_RE = /^(main|prelim|register|result:.+|pick-(first|done)-.+|trash-talk-\d+|chal(-resp)?-[\w-]+|nudge-[\w-]+)$/;
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
  // Everything except register keeps EXACTLY the bar it had before: the anon
  // key, nothing else. The shape check above had to let a JWT through to reach
  // this point (the type is only known once the body is parsed), and without
  // this line that would have quietly downgraded every other path from "knows
  // the anon key" to "sent three dots".
  if (ANON_KEY && !isAnonKey && body.type !== "register") {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }
  if (!body.type || !TYPE_RE.test(body.type)) {
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

  // Deduplicate: check if already sent for this event + type
  const logCheck = await fetch(
    `${SUPABASE_URL}/rest/v1/notif_log?event_date=eq.${encodeURIComponent(body.event_date)}&type=eq.${encodeURIComponent(body.type)}&select=event_date`,
    { headers: sbHeaders }
  );
  const logRows = await logCheck.json();
  if (Array.isArray(logRows) && logRows.length > 0) {
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
  const safeUrl = body.url && /^\.\/(\?[\w=&-]*)?$/.test(body.url) ? body.url : undefined;
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
