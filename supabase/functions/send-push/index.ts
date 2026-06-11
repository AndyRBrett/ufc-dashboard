import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
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
  // type="register" fields
  user_id?: string;
  nickname?: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  live_results?: boolean;
}

serve(async (req) => {
  const CORS = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS });
  }

  const ANON_KEY = Deno.env.get("SB_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (ANON_KEY && auth !== `Bearer ${ANON_KEY}`) {
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

  const livePayload = JSON.stringify({ title: body.title, body: body.body });
  // When a spoiler-free variant is supplied, it is the default; the full
  // result only goes to subscribers who explicitly opted in to live results.
  const safePayload = body.safe_title
    ? JSON.stringify({ title: body.safe_title, body: body.safe_body ?? "" })
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
