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

// Schedule source used only to decide how hard to drive the scraper. Same file
// the PWA loads.
const DATA_URL = Deno.env.get("DATA_URL") ??
  "https://andyrbrett.github.io/ufc-dashboard/data.js";

// A card this far out is "fight week": the days when withdrawals, replacements
// and the real line movement land. Ortega/Moicano came off UFC 331 four days
// out and the app showed the cancelled bout until someone triggered a run by
// hand — because on a non-fight day the ONLY thing left driving the scraper is
// GitHub's `schedule:`, which is the throttling this whole function exists to
// route around (measured 2026-09-15/16: one delivered run per day).
const FIGHT_WEEK_DAYS = Number(Deno.env.get("FIGHT_WEEK_DAYS") ?? "7");

// ...but fight week does not need the 5-minute cadence a live card does, so
// those pings are thinned to one dispatch an hour. Note this is NOT an odds
// budget control: scrape.py gates every Odds API call itself on elapsed time
// (ODDS_PULL_INTERVALS, 2h–24h by proximity, backed off further on a quiet
// market), so an extra run costs Actions minutes — free on a public repo — and
// nothing else. A run that finds nothing new writes no commit.
const FIGHT_WEEK_MIN_GAP_MIN = Number(Deno.env.get("FIGHT_WEEK_MIN_GAP_MIN") ?? "60");

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

function daysBetween(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(toYmd + "T00:00:00Z") - Date.parse(fromYmd + "T00:00:00Z")) / 864e5);
}

type Mode = "live" | "fight-week" | "idle";

// How hard the scraper should be driven right now, read off data.js.
//
//   live        an event dated today/yesterday (UTC — fight nights cross
//               midnight) still has an unfinished (`state:"pre"`) bout. Results
//               are landing; every ping dispatches.
//   fight-week  an unfinished card is within FIGHT_WEEK_DAYS. Rostered bouts
//               still move; dispatch at most once an hour.
//   idle        nothing close enough to be worth a run.
//
// Event headers use `name:"…"`; fight objects use `n:"…"`, so splitting on
// `name:"` is safe.
function cardStatus(js: string): { mode: Mode; event?: string; daysOut?: number } {
  const i = js.indexOf("var EVENTS=");
  const ev = i >= 0 ? js.slice(i) : js;
  const now = new Date();
  const today = ymd(now);
  const yest = ymd(new Date(now.getTime() - 864e5));
  const re = /name:"([^"]+)",\s*date:"(\d{4}-\d{2}-\d{2})"([\s\S]*?)(?=name:"|$)/g;
  let soonest: { event: string; daysOut: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ev)) !== null) {
    const [, name, date, body] = m;
    if (!/state:"pre"/.test(body)) continue;
    if (date === today || date === yest) return { mode: "live", event: name, daysOut: 0 };
    const out = daysBetween(today, date);
    if (out > 0 && out <= FIGHT_WEEK_DAYS && (!soonest || out < soonest.daysOut)) {
      soonest = { event: name, daysOut: out };
    }
  }
  if (soonest) return { mode: "fight-week", event: soonest.event, daysOut: soonest.daysOut };
  return { mode: "idle" };
}

// Minutes since update.yml last started, via the Actions API. Used only to thin
// the fight-week cadence; null means "couldn't tell".
async function minutesSinceLastRun(repo: string, workflow: string, token: string): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "ufc-dashboard-kick-scraper",
        },
      },
    );
    if (!r.ok) return null;
    const body = await r.json();
    const last = body?.workflow_runs?.[0]?.created_at;
    if (!last) return null;
    return (Date.now() - Date.parse(last)) / 60000;
  } catch (_e) {
    return null;
  }
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
  // Move that job to `Authorization: Bearer <secret>`, ROTATE CRON_SECRET, then
  // set CRON_ALLOW_QUERY_KEY=0 — no code change needed — and this path is
  // closed. The rotation is not optional: switching to a header stops NEW
  // requests logging the secret, and does nothing about the value already
  // sitting in months of logs, which is still accepted either way.
  const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
  const ALLOW_QUERY_KEY = (Deno.env.get("CRON_ALLOW_QUERY_KEY") ?? "1") !== "0";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const key = ALLOW_QUERY_KEY ? (new URL(req.url).searchParams.get("key") ?? "") : "";

  // `force=1` bypasses every cadence gate below, so it is the one input that
  // turns a leaked credential into unlimited workflow runs. It takes a SEPARATE
  // secret, because the threat being contained is CRON_SECRET leaking: moving
  // it to a header would not have helped, since the leaked value and the header
  // value are the same string — whoever reads it out of a logged URL can just
  // send it as `Authorization: Bearer`.
  //
  // FORCE_SECRET is a manual-operator credential. It is never sent by the cron,
  // never appears in a URL, and when it is unset force is simply unavailable —
  // the safe default for a switch nothing automated depends on.
  const FORCE_SECRET = Deno.env.get("FORCE_SECRET") ?? "";
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (force) {
    if (!FORCE_SECRET || !secretEquals(bearer, FORCE_SECRET)) {
      return new Response(JSON.stringify({
        error: "force=1 requires Authorization: Bearer <FORCE_SECRET>",
        hint: FORCE_SECRET ? undefined : "FORCE_SECRET is not set on this deployment, so forced dispatches are disabled.",
      }), { status: 403, headers: { "Content-Type": "application/json" } });
    }
  } else if (!CRON_SECRET || !(secretEquals(bearer, CRON_SECRET) || secretEquals(key, CRON_SECRET))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const TOKEN = Deno.env.get("GH_DISPATCH_TOKEN");
  if (!TOKEN) {
    return new Response(JSON.stringify({ error: "Server misconfigured (GH_DISPATCH_TOKEN)" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const repo = Deno.env.get("GH_REPO") ?? "AndyRBrett/ufc-dashboard";
  const workflow = Deno.env.get("GH_WORKFLOW") ?? "update.yml";
  const ref = Deno.env.get("GH_REF") ?? "main";

  // Cadence gate — fail OPEN: only thin or skip when we're confident about the
  // schedule. A fetch/parse hiccup must never silently stop scraping, so an
  // unreadable data.js is treated as a live card and dispatches.
  let gate: { mode: Mode; event?: string; daysOut?: number } = { mode: "live" };
  try {
    const r = await fetch(`${DATA_URL}?t=${Date.now()}`, { headers: { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" } });
    if (r.ok) gate = cardStatus(await r.text());
  } catch (_e) { /* fail open: gate stays { mode: "live" } */ }

  if (!force && gate.mode === "idle") {
    return new Response(JSON.stringify({ ok: true, dispatched: false, reason: "no card in range", mode: gate.mode }), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  // Fight week is thinned to one run an hour — but only when we can actually
  // tell how long it has been. An unreadable Actions API FAILS OPEN and
  // dispatches.
  //
  // Skipping instead would have been the silent branch: a revoked or
  // Actions-read-less GH_DISPATCH_TOKEN makes this lookup fail on every ping,
  // and a skip returns 200, which scheduled-push.yml and the external cron both
  // read as healthy. The scraper would sit still through fight week with every
  // monitor green — the exact shape of the 2026-09-05 outage. Dispatching
  // instead routes a dead credential into the 502 path below, which already
  // alarms in three places, and the worst case when the API is merely flaky is
  // fight-week pings running at the live-card cadence for the length of the
  // outage. That costs Actions minutes (free) and no metered budget: scrape.py
  // gates the Odds API itself.
  if (!force && gate.mode === "fight-week") {
    const since = await minutesSinceLastRun(repo, workflow, TOKEN);
    if (since === null) {
      console.error(
        `kick-scraper: could not read ${workflow} run history for the fight-week cadence ` +
        `(GH_DISPATCH_TOKEN may lack Actions: Read, or the API is down) — dispatching anyway.`,
      );
    } else if (since < FIGHT_WEEK_MIN_GAP_MIN) {
      return new Response(JSON.stringify({
        ok: true,
        dispatched: false,
        reason: "fight-week cadence: too soon",
        mode: gate.mode,
        event: gate.event ?? null,
        days_out: gate.daysOut ?? null,
        minutes_since_last_run: since,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
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
