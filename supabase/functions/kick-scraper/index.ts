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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!CRON_SECRET || (auth !== `Bearer ${CRON_SECRET}` && key !== CRON_SECRET)) {
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
  return new Response(JSON.stringify({ ok: false, dispatched: false, status: ghRes.status, detail }), { status: 502, headers: { "Content-Type": "application/json" } });
});
