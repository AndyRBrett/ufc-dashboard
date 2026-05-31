import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import webpush from "npm:web-push";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

interface ReqBody {
  event_date: string;
  type: string;
  title: string;
  body: string;
  exclude_user_id?: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  const ANON_KEY = Deno.env.get("SB_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (ANON_KEY && auth !== `Bearer ${ANON_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });
  }

  const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY");
  const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");

  if (!VAPID_PRIVATE_KEY || !VAPID_SUBJECT || !SUPABASE_URL || !SERVICE_ROLE_KEY || !VAPID_PUBLIC_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: CORS_HEADERS });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
  }

  if (!body.event_date || !body.type) {
    return new Response(JSON.stringify({ error: "Missing event_date or type" }), { status: 400, headers: CORS_HEADERS });
  }

  const sbHeaders = {
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  // Deduplicate: check if already sent for this event + type
  const logCheck = await fetch(
    `${SUPABASE_URL}/rest/v1/notif_log?event_date=eq.${encodeURIComponent(body.event_date)}&type=eq.${encodeURIComponent(body.type)}&select=event_date`,
    { headers: sbHeaders }
  );
  const logRows = await logCheck.json();
  if (Array.isArray(logRows) && logRows.length > 0) {
    return new Response(JSON.stringify({ sent: 0, skipped: true }), { status: 200, headers: CORS_HEADERS });
  }

  // Insert log entry first (prevents race conditions — second caller will see this row)
  const logInsert = await fetch(`${SUPABASE_URL}/rest/v1/notif_log`, {
    method: "POST",
    headers: { ...sbHeaders, "Prefer": "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ event_date: body.event_date, type: body.type }),
  });
  if (!logInsert.ok && logInsert.status !== 409) {
    // If insert failed for a reason other than duplicate, another caller likely won the race
    return new Response(JSON.stringify({ sent: 0, skipped: true }), { status: 200, headers: CORS_HEADERS });
  }

  // Fetch all push subscriptions (excluding sender if specified)
  const subsUrl = body.exclude_user_id
    ? `${SUPABASE_URL}/rest/v1/push_subs?select=endpoint,p256dh,auth&user_id=neq.${encodeURIComponent(body.exclude_user_id)}`
    : `${SUPABASE_URL}/rest/v1/push_subs?select=endpoint,p256dh,auth`;
  const subsRes = await fetch(subsUrl, { headers: sbHeaders });
  if (!subsRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch subscriptions" }), { status: 502, headers: CORS_HEADERS });
  }
  const subs: { endpoint: string; p256dh: string; auth: string }[] = await subsRes.json();

  if (!subs.length) {
    return new Response(JSON.stringify({ sent: 0, skipped: false, reason: "no subscribers" }), { status: 200, headers: CORS_HEADERS });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const payload = JSON.stringify({ title: body.title, body: body.body });
  let sent = 0, failed = 0;

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      sent++;
    } catch (err: any) {
      failed++;
      // Push service returned 410 (Gone) or 404 (Not Found) — subscription is permanently invalid.
      // Delete it so future notifications don't silently fail for this user.
      const status = err?.statusCode ?? err?.status;
      if (status === 410 || status === 404) {
        await fetch(
          `${SUPABASE_URL}/rest/v1/push_subs?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
          { method: "DELETE", headers: sbHeaders }
        ).catch(() => {});
      }
    }
  }));

  return new Response(JSON.stringify({ sent, failed }), { status: 200, headers: CORS_HEADERS });
});
