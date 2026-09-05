// kick-scraper — triggers the data scraper (update.yml) via GitHub's
// workflow_dispatch API on a reliable external schedule.
//
// GitHub heavily throttles `schedule:` cron events — during a Saturday fight
// window we saw ~6 of ~96 expected runs actually fire — so the app's data.js
// went stale for ~80 min at a time. API-driven workflow_dispatch runs are NOT
// subject to that throttling. cron-job.org pings this every few minutes; the
// GitHub token lives here (server-side) so the cron call stays header-free
// (?key= auth, exactly like check-results / send-reminders).
//
// That cron was once the ONLY trigger, so the job being disabled took the whole
// path down silently. scheduled-push.yml now pings this as a throttled backup
// (header auth) and fails its run on a 502, which is the alert.
//
// Deployed with --no-verify-jwt; inbound auth is enforced here via CRON_SECRET.

// Schedule source used only to decide whether a card is live, so off-days don't
// burn odds-API quota. Same file the PWA loads.
const DATA_URL = Deno.env.get("DATA_URL") ??
  "https://andyrbrett.github.io/ufc-dashboard/data.js";

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

// True if data.js shows an event dated today/yesterday (UTC — fight nights cross
// midnight) that still has an unfinished (`state:"pre"`) bout. Event headers use
// `name:"…"`; fight objects use `n:"…"`, so splitting on `name:"` is safe.
function hasLiveCard(js: string): { live: boolean; event?: string } {
  const i = js.indexOf("var EVENTS=");
  const ev = i >= 0 ? js.slice(i) : js;
  const now = new Date();
  const today = ymd(now);
  const yest = ymd(new Date(now.getTime() - 864e5));
  const re = /name:"([^"]+)",\s*date:"(\d{4}-\d{2}-\d{2})"([\s\S]*?)(?=name:"|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ev)) !== null) {
    const [, name, date, body] = m;
    if ((date === today || date === yest) && /state:"pre"/.test(body)) {
      return { live: true, event: name };
    }
  }
  return { live: false };
}

// Constant-time comparison. `!==` on a secret returns at the first differing
// byte, so response timing across enough requests leaks the secret prefix by
// prefix. Length is still observable; that is standard and not worth hiding.
function secretEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  // This one is reached by an external cron (cron-job.org), which is configured
  // to authenticate with ?key= rather than a header. A secret in a query string
  // is logged wherever URLs are logged, and this is the worst function to leak:
  // it holds GH_DISPATCH_TOKEN, so the secret is a route to firing workflows in
  // the repo.
  //
  // It is not removed here because doing so would stop the scraper being kicked
  // mid-card the moment this deploys, before anyone could reconfigure the cron.
  // Move that job to `Authorization: Bearer <secret>` and set
  // CRON_ALLOW_QUERY_KEY=0 — no code change needed — and this path is closed.
  const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
  const ALLOW_QUERY_KEY = (Deno.env.get("CRON_ALLOW_QUERY_KEY") ?? "1") !== "0";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const key = ALLOW_QUERY_KEY ? (new URL(req.url).searchParams.get("key") ?? "") : "";
  if (!CRON_SECRET || !(secretEquals(bearer, CRON_SECRET) || secretEquals(key, CRON_SECRET))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const TOKEN = Deno.env.get("GH_DISPATCH_TOKEN");
  if (!TOKEN) {
    return new Response(JSON.stringify({ error: "Server misconfigured (GH_DISPATCH_TOKEN)" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const repo = Deno.env.get("GH_REPO") ?? "AndyRBrett/ufc-dashboard";
  const workflow = Deno.env.get("GH_WORKFLOW") ?? "update.yml";
  const ref = Deno.env.get("GH_REF") ?? "main";

  // Quota guard — fail OPEN: only skip when we're confident there's no live card.
  // A fetch/parse hiccup must never silently stop scraping, so default to firing.
  let gate: { live: boolean; event?: string } = { live: true };
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { headers: { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" } });
    if (r.ok) gate = hasLiveCard(await r.text());
  } catch (_e) { /* fail open: gate stays { live: true } */ }

  if (!gate.live && (new URL(req.url).searchParams.get("force") !== "1")) {
    return new Response(JSON.stringify({ ok: true, dispatched: false, reason: "no live card" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ufc-dashboard-kick-scraper",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref }),
    },
  );

  // GitHub returns 204 No Content on a successful dispatch.
  if (ghRes.status === 204) {
    return new Response(JSON.stringify({ ok: true, dispatched: true, workflow, ref, event: gate.event ?? null }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  const detail = await ghRes.text().catch(() => "");

  // Announce the failure rather than just returning it. This path is the one
  // that goes quiet: a 401/403 here means the app's fight card stops refreshing
  // while push notifications keep working, so nothing user-facing looks broken.
  // On 2026-09-05 that ran for 26 pings on a fight day and the first anyone
  // heard of it was cron-job.org emailing to say it had disabled the job.
  //
  // console.error surfaces it in the Supabase function logs, and the JSON body
  // carries a `hint` so whoever reads the response (the scheduled-push.yml
  // backup step, or a curl) is told what to fix without digging through docs.
  const credentialFailure = ghRes.status === 401 || ghRes.status === 403;
  const hint = credentialFailure
    ? "GH_DISPATCH_TOKEN is revoked, expired or lacks Actions: Read and write on the repo — recreate it and overwrite the Supabase secret (see README)."
    : `GitHub refused the ${workflow} dispatch on ${ref}.`;
  console.error(`kick-scraper: dispatch failed — GitHub returned ${ghRes.status}. ${hint} detail=${detail.slice(0, 500)}`);

  return new Response(JSON.stringify({ ok: false, dispatched: false, status: ghRes.status, hint, detail }), { status: 502, headers: { "Content-Type": "application/json" } });
});
