// Uses the runtime's built-in Deno.serve — no deno.land/std import, so deploys
// don't depend on deno.land being up.
// Always-on server-side result-push backup.
//
// GitHub Actions throttles the scraper hard and the client live-poll only fires
// while someone has the app open, so a fight that ends while nobody is watching
// (and no scheduled scrape fired) produces no push. This scheduled function
// closes that gap: driven by pg_cron, it parses Wikipedia for newly-final
// fights and calls the existing `send-push` for each one.
//
// It reads Wikipedia with results.js (ResultsParse), the same code the open
// app's live poll runs, bundled here by scripts/build-fn-bundle.mjs as
// _shared/results-bundle.js and tied to scrape.py's parser by
// tests/fixtures/results/expected.json. Its own copy had drifted: it asked for
// the full event name, so every numbered PPV read a redirect stub with no
// results ("UFC 334: Gane vs. Hokit" is a redirect to "UFC 334") and this
// backup never fired for one; and it knew nothing of draws or no contests.
//
// It and scrape.py are the two result senders (the app stopped sending them:
// see index.html's live-poll block). Both build `result:<fightKey>:<group>` the
// same way, so send-push's notif_log (event_date, type) dedup lets one push per
// fight through, whichever gets there first. check:dedup holds the key.
//
// Deployed with --no-verify-jwt: the Supabase gateway would otherwise reject the
// cron's `Authorization: Bearer <CRON_SECRET>` as an invalid JWT before this code
// runs. Inbound auth is enforced here via CRON_SECRET instead.
import { secretEquals } from "../_shared/secret.js";
import { ResultsParse } from "../_shared/results-bundle.js";

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

interface Pick { user_id: string; f1: string; f2: string; pick: string; }
// What ResultsParse.parseResults returns: a win, or a draw / no contest
// (undecided, both names in f1/f2, no winner).
interface FightResult { winner: string; loser: string; method: string; round: number | null; undecided?: boolean; f1?: string; f2?: string; }

const SAFE_TITLE = "🥊 Fight result is in";
const SAFE_BODY = "A fight you picked is final — open the app to see how you did. (No spoilers here!)";

// Only look back ~2 days (matches scrape.py's stale-spoiler guard) and ~1 day
// forward so a card that crosses UTC midnight is still in window.
const LOOKBACK_DAYS = 2;
const LOOKAHEAD_DAYS = 1;
const MAX_EVENTS = 5; // hard cap on Wikipedia fetches per run

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

async function fetchWikitext(slug: string): Promise<string | null> {
  // redirects=1 as well as the right slug: a renamed article still reads.
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json&redirects=1&origin=*`;
  const r = await fetch(url, { headers: { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.parse?.wikitext?.["*"] ?? null;
}

// A Fight Night's article is titled with the fighters' real spelling
// ("UFC Fight Night: Procházka vs. Stirling"), but picks store data.js's
// ASCII-folded name, and that title isn't even a redirect: this read nothing
// all card on 2026-11-21. Search the way scrape.py's search_event_slug does,
// and take only a title that folds to the same event (_pick_search_title).
const foldTitle = (s: string) => ResultsParse.fold(String(s)).toLowerCase().replace(/[^a-z0-9]/g, "");
async function searchEventSlug(evName: string): Promise<string | null> {
  const want = foldTitle(evName);
  const tries: [string, (j: any) => string[]][] = [
    [`action=opensearch&search=${encodeURIComponent(evName)}&limit=5&namespace=0&format=json`, (j) => Array.isArray(j?.[1]) ? j[1] : []],
    [`action=query&list=search&srsearch=${encodeURIComponent(evName)}&srlimit=5&format=json`, (j) => (j?.query?.search ?? []).map((h: { title: string }) => h.title)],
  ];
  for (const [q, titles] of tries) {
    try {
      const r = await fetch(`https://en.wikipedia.org/w/api.php?${q}&origin=*`, { headers: { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" } });
      if (!r.ok) continue;
      const hit = titles(await r.json()).find((t) => typeof t === "string" && foldTitle(t) === want);
      if (hit) return hit.replace(/ /g, "_");
    } catch (_e) { /* try the next search */ }
  }
  return null;
}

// Constant-time comparison. `!==` on a secret returns at the first differing
// byte, so response timing across enough requests leaks the secret prefix by
// prefix. Length is still observable; that is standard and not worth hiding.

// The pick lock's grace (0010's LOCK_GRACE): the database still accepts a pick
// for 5 minutes after its bout locks.
export const LOCK_GRACE_MS = 5 * 60 * 1000;

// May this bout's result push claim its audience yet? Only once its effective
// lock (`lockAt`, ms, from the database's pick_lock_for) plus the grace has
// passed: the database still takes picks until then, and notif_log would dedup
// a later picker out for good. `lockAt` undefined means the lock couldn't be
// read, and that waits too (fail closed); the next run asks again.
export function graceOver(lockAt: number | undefined, now: number): boolean {
  return typeof lockAt === "number" && !isNaN(lockAt) && now >= lockAt + LOCK_GRACE_MS;
}

// A bout's effective lock time from pick_lock_for(): its pick_locks row, else
// its card's first bell, else midnight ET after the date, the rule the lock
// trigger enforces. undefined when it can't be read. "-infinity" (a date the
// database can't read) is locked, so 0.
export async function boutLockAt(url: string, h: Record<string, string>, date: string, a: string, b: string): Promise<number | undefined> {
  try {
    const r = await fetch(`${url}/rest/v1/rpc/pick_lock_for`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ p_promo: "ufc", p_date: date, p_f1: a, p_f2: b }),
    });
    if (!r.ok) return undefined;
    const v = await r.json();
    if (v === "-infinity") return 0;
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return isNaN(t) ? undefined : t;
  } catch (_e) { return undefined; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  // Inbound auth: only a caller that knows CRON_SECRET may trigger a scrape.
  // Header only: `Authorization: Bearer <secret>`. The ?key= form was removed
  // query param (so external cron UIs work without custom headers).
  // Header-only. A secret in the query string is written to every log that
  // records a URL — Supabase's own edge logs, any proxy in front of them, and
  // the Referer of anything the response links to — which a header is not.
  // scheduled-push.yml has always sent this as a header, so dropping the
  // ?key= path costs nothing here.
  const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!CRON_SECRET || !secretEquals(bearer, CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SB_ANON_KEY = Deno.env.get("SB_ANON_KEY");
  if (!SUPABASE_URL || !SB_ANON_KEY) {
    return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
  // Service-role key is used ONLY to read the dedup log (notif_log is RLS-locked
  // to service-role; see migration 0001). It is a project-wide secret already set
  // for send-push. If absent we fall back to no pre-filtering — send-push still
  // dedups, we just lose the invocation saving — so this stays best-effort.
  const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";

  const anonHeaders = { "apikey": SB_ANON_KEY, "Authorization": `Bearer ${SB_ANON_KEY}` };
  // picks is read with the service key. Since 0017 the anon key can't see a
  // pick until its bout's lock + LOCK_GRACE has passed, and when two results
  // land in one run the later bout's picks can still be inside that grace: an
  // anon read would hand send-push an empty audience, and notif_log would then
  // dedup that result push away for good. Anon remains the fallback for a
  // deployment without the service key (it sees every locked bout's picks).
  const picksHeaders = SB_SERVICE_ROLE_KEY
    ? { "apikey": SB_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SB_SERVICE_ROLE_KEY}` }
    : anonHeaders;
  // X-Service-Key tells send-push this is one of our own functions, so it sends
  // the text and audience given (from anyone else it rebuilds them). Without
  // the key a result still goes out, rebuilt from data.js, once that has it.
  const pushHeaders: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${SB_ANON_KEY}` };
  if (SB_SERVICE_ROLE_KEY) pushHeaders["X-Service-Key"] = SB_SERVICE_ROLE_KEY;

  const now = Date.now();
  const lo = ymd(new Date(now - LOOKBACK_DAYS * 864e5));
  const hi = ymd(new Date(now + LOOKAHEAD_DAYS * 864e5));

  // 1. Recent events that people actually picked (the only possible audience).
  const evRes = await fetch(
    `${SUPABASE_URL}/rest/v1/picks?select=event_date,event_name&event_date=gte.${lo}&event_date=lte.${hi}&promotion=eq.ufc`,
    { headers: picksHeaders },
  );
  if (!evRes.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch events" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  const evRows: { event_date: string; event_name: string }[] = await evRes.json();
  const events = new Map<string, string>(); // event_date -> event_name
  for (const r of evRows) {
    if (r.event_date && r.event_name && !events.has(r.event_date)) events.set(r.event_date, r.event_name);
  }

  // Pre-read the dedup log once so we can skip send-push entirely for fights any
  // trigger already notified. Without this the function re-POSTs send-push every
  // run for the whole lookback window just to get {skipped:true} back — one wasted
  // invocation per already-final picked fight per run. `${event_date}|${type}`
  // keys mirror send-push's (event_date, type) notif_log dedup exactly.
  const alreadySent = new Set<string>();
  if (SB_SERVICE_ROLE_KEY) {
    try {
      const logRes = await fetch(
        `${SUPABASE_URL}/rest/v1/notif_log?event_date=gte.${lo}&event_date=lte.${hi}&select=event_date,type`,
        { headers: { "apikey": SB_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SB_SERVICE_ROLE_KEY}` } },
      );
      if (logRes.ok) {
        const logRows: { event_date: string; type: string }[] = await logRes.json();
        for (const lr of logRows) {
          if (lr.event_date && lr.type) alreadySent.add(`${lr.event_date}|${lr.type}`);
        }
      }
    } catch (_e) { /* best-effort; send-push still dedups if this read fails */ }
  }

  let parsedCount = 0, pushedCount = 0, skippedCount = 0, deferredCount = 0, processed = 0;
  const fights: unknown[] = [];

  for (const [eventDate, eventName] of events) {
    if (processed >= MAX_EVENTS) break;
    processed++;

    const slug = ResultsParse.eventSlug(eventName);
    let wt: string | null = null;
    try { wt = await fetchWikitext(slug); } catch (_e) { wt = null; }
    if (!wt) {
      const alt = await searchEventSlug(eventName);
      if (alt && alt !== slug) { try { wt = await fetchWikitext(alt); } catch (_e) { wt = null; } }
    }
    if (!wt) continue;

    const parsed: FightResult[] = ResultsParse.parseResults(wt);
    parsedCount += parsed.length;
    if (!parsed.length) continue;

    // Picks for this event, used to group winners vs losers per resolved fight.
    let picks: Pick[] = [];
    try {
      const pRes = await fetch(
        `${SUPABASE_URL}/rest/v1/picks?select=user_id,f1,f2,pick&event_date=eq.${encodeURIComponent(eventDate)}&promotion=eq.ufc`,
        { headers: picksHeaders },
      );
      if (pRes.ok) picks = await pRes.json();
    } catch (_e) { picks = []; }

    for (const res of parsed) {
      // A draw / no contest has no winner to announce (the scraper sends none
      // either), and a result without a loser can't be matched to a bout.
      if (res.undecided || !res.winner || !res.loser) continue;
      const m = ResultsParse.namesMatch;
      const winners: string[] = [], losers: string[] = [];
      let boutNames: [string, string] | null = null;   // the pick rows' own names (data.js's), as the lock is keyed
      for (const p of picks) {
        if (!p.user_id) continue;
        const isFight = (m(p.f1, res.winner) && m(p.f2, res.loser)) || (m(p.f2, res.winner) && m(p.f1, res.loser));
        if (!isFight) continue;
        if (!boutNames) boutNames = [p.f1, p.f2];
        (m(p.pick, res.winner) ? winners : losers).push(p.user_id);
      }
      if (!winners.length && !losers.length) continue; // nobody picked this bout
      const lockAt = boutNames ? await boutLockAt(SUPABASE_URL, picksHeaders, eventDate, boutNames[0], boutNames[1]) : undefined;
      if (!graceOver(lockAt, now)) { deferredCount++; continue; }   // next run, once the grace is over (or the lock can be read)

      const fightKey = ResultsParse.fightKey(res.winner, res.loser);
      const groups: [string, string[], string, string][] = [
        ["win", winners, "Your pick WON! 🔥", `${res.winner} def. ${res.loser} — you called it!`],
        ["loss", losers, "Tough luck ❌", `${res.winner} def. ${res.loser}`],
      ];
      for (const [group, userIds, title, body] of groups) {
        if (!userIds.length) continue;
        const notifType = `result:${fightKey}:${group}`;
        // Already notified by some trigger — skip the (otherwise dedup'd) send-push call.
        if (alreadySent.has(`${eventDate}|${notifType}`)) { skippedCount++; continue; }
        try {
          const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
            method: "POST",
            headers: pushHeaders,
            body: JSON.stringify({
              event_date: eventDate,
              type: notifType,
              title, body,
              safe_title: SAFE_TITLE,
              safe_body: SAFE_BODY,
              include_user_ids: userIds,
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (j && typeof j.sent === "number" && j.sent > 0) pushedCount += j.sent;
          fights.push({ event_date: eventDate, type: notifType, recipients: userIds.length, result: j });
        } catch (_e) { /* best-effort; cron retries next run, notif_log dedups */ }
      }
    }
  }

  return new Response(
    JSON.stringify({ events: events.size, parsed: parsedCount, pushed: pushedCount, skipped: skippedCount, deferred: deferredCount, fights }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
