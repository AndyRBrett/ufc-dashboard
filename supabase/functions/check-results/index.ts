// Uses the runtime's built-in Deno.serve — no deno.land/std import, so deploys
// don't depend on deno.land being up.
//
// The result-push reconciler. Every run (cron-job.org every 2 min, and
// update.yml right after each data commit) it makes two passes:
//
// 1. Wikipedia (fast): parse the card's results page with results.js
//    (ResultsParse), the reader the app's live poll runs, bundled as
//    _shared/results-bundle.js and tied to scrape.py's parser by
//    tests/fixtures/results/expected.json. A result is on Wikipedia minutes
//    before the scraper commits it, so this pass usually sends first.
// 2. data.js (complete): for every decided bout in the COMMITTED data.js (what
//    the app shows, after health.py's gate and scrape.py's _RESULT_PINS), send
//    any win/loss group that has pickers and no notif_log row yet. It needs no
//    Wikipedia title and trusts no other sender, so a result the other paths
//    missed is sent within a run. A group this pass sends is also recorded as
//    `net:<type>` in notif_log, and reported in `net`, so a fired safety net is
//    visible: update.yml opens an issue for it (see CLAUDE.md, "Result pushes:
//    one reconciler, checked against data.js").
//
// The article title comes from data.js's `slug`, which scrape.py records as
// the article it read (diacritics kept). On 2026-11-21 this function rebuilt
// "UFC Fight Night: Prochazka vs. Stirling" from the picks' ASCII name; the
// article is "Procházka", not even a redirect, and it parsed nothing all card.
// A numbered PPV reads "UFC 334", never its full-title redirect stub.
//
// scrape.py still asks send-push for each result it commits (anon, rebuilt
// server-side). All senders build `result:<fightKey>:<group>` the same way, so
// send-push's notif_log (event_date, type) claim lets one push per group
// through. check:dedup holds the key.
//
// Deployed with --no-verify-jwt: the Supabase gateway would otherwise reject the
// cron's `Authorization: Bearer <CRON_SECRET>` as an invalid JWT before this code
// runs. Inbound auth is enforced here via CRON_SECRET instead.
import { secretEquals } from "../_shared/secret.js";
import { ResultsParse } from "../_shared/results-bundle.js";
import { parseDataJs, pinnedDataUrl } from "../_shared/datajs.js";

interface Pick { user_id: string; f1: string; f2: string; pick: string; }
// What ResultsParse.parseResults returns: a win, or a draw / no contest
// (undecided, both names in f1/f2, no winner).
interface FightResult { winner: string; loser: string; method: string; round: number | null; undecided?: boolean; f1?: string; f2?: string; }
interface Card { name: string; date: string; slug?: string; fights: { f1: { n: string }; f2: { n: string }; winner?: string; state?: string }[]; }

const SAFE_TITLE = "🥊 Fight result is in";
const SAFE_BODY = "A fight you picked is final — open the app to see how you did. (No spoilers here!)";

// Only look back ~2 days (matches scrape.py's stale-spoiler guard) and ~1 day
// forward so a card that crosses UTC midnight is still in window.
const LOOKBACK_DAYS = 2;
const LOOKAHEAD_DAYS = 1;
const MAX_EVENTS = 5; // hard cap on Wikipedia fetches per run

// The committed data.js, never Pages (see send-reminders' DATA_URL).
const DATA_URL = Deno.env.get("DATA_URL") ??
  "https://raw.githubusercontent.com/AndyRBrett/ufc-dashboard/main/data.js";

const UA = { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" };

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

async function fetchWikitext(slug: string): Promise<string | null> {
  // redirects=1 as well as the right slug: a renamed article still reads.
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json&redirects=1&origin=*`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.parse?.wikitext?.["*"] ?? null;
}

// The article to read for a card: data.js's recorded slug for a Fight Night,
// "UFC 334" for a numbered PPV (its full title is a redirect stub). The same
// rule as the app's live poll (index.html, _pollOne). data.js's own name
// decides which, when it has the card (the picks carry a copy of it).
export function articleSlug(name: string, card: Card | undefined): string {
  const nm = card?.name || name;
  return (!/^UFC\s+\d+/.test(nm) && card?.slug) || ResultsParse.eventSlug(nm);
}

// Is a result group already in notif_log under another spelling? Senders key
// by the names they read (Wikipedia's or data.js's), which fightKey folds for
// case and accents but not for a respelling. So a bout counts as sent when a
// logged key for that date and group names both surnames, winner first.
const slugOf = (s: string) => ResultsParse.fold(String(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function groupLogged(logged: Set<string>, date: string, winner: string, loser: string, group: string): boolean {
  if (logged.has(`${date}|result:${ResultsParse.fightKey(winner, loser)}:${group}`)) return true;
  const w = slugOf(ResultsParse.lastName(winner)), l = slugOf(ResultsParse.lastName(loser));
  if (!w || !l) return false;
  const pre = `${date}|result:`, suf = `:${group}`;
  for (const k of logged) {
    if (!k.startsWith(pre) || !k.endsWith(suf)) continue;
    const mid = "-" + k.slice(pre.length, k.length - suf.length) + "-";
    const wi = mid.indexOf(`-${w}-`), li = mid.lastIndexOf(`-${l}-`);
    if (wi >= 0 && li > wi) return true;
  }
  return false;
}

// Every row a picks query matches. PostgREST answers at most 1,000 rows, and
// scrape.py's unpaged read lost one player's result pushes all card on
// 2026-11-21 once the table passed that. null if any page fails.
// check:pickstore fails on a server-side picks read that isn't paged.
const PICKS_PAGE = 1000;
async function readAllPicks<T>(url: string, headers: Record<string, string>): Promise<T[] | null> {
  const rows: T[] = [];
  try {
    for (let from = 0; ; from += PICKS_PAGE) {
      const r = await fetch(url, { headers: { ...headers, Range: `${from}-${from + PICKS_PAGE - 1}` } });
      if (!r.ok) return null;
      const page: T[] = await r.json();
      rows.push(...page);
      if (page.length < PICKS_PAGE) return rows;
      if (from >= 50 * PICKS_PAGE) return null;   // never this big; a Range ignored would loop forever
    }
  } catch (_e) { return null; }
}

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

  // Inbound auth: only a caller that knows CRON_SECRET. Header only
  // (`Authorization: Bearer <secret>`): a secret in a query string is written
  // to every log that records a URL, which a header is not.
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
  // The service key reads notif_log (service-role only) and picks, and marks
  // a fired safety net. Without it the function still sends, unfiltered.
  const SB_SERVICE_ROLE_KEY = Deno.env.get("SB_SERVICE_ROLE_KEY") ?? "";
  const serviceHeaders = SB_SERVICE_ROLE_KEY
    ? { "apikey": SB_SERVICE_ROLE_KEY, "Authorization": `Bearer ${SB_SERVICE_ROLE_KEY}` }
    : null;

  const anonHeaders = { "apikey": SB_ANON_KEY, "Authorization": `Bearer ${SB_ANON_KEY}` };
  // picks is read with the service key. Since 0017 the anon key can't see a
  // pick until its bout's lock + LOCK_GRACE has passed, and an anon read inside
  // that grace would hand send-push an empty audience that notif_log then
  // dedups for good. Anon remains the fallback for a deployment without it.
  const picksHeaders = serviceHeaders ?? anonHeaders;
  // X-Service-Key tells send-push this is one of our own functions, so it sends
  // the text and audience given (from anyone else it rebuilds them).
  const pushHeaders: Record<string, string> = { "Content-Type": "application/json", "Authorization": `Bearer ${SB_ANON_KEY}` };
  if (SB_SERVICE_ROLE_KEY) pushHeaders["X-Service-Key"] = SB_SERVICE_ROLE_KEY;

  const now = Date.now();
  const lo = ymd(new Date(now - LOOKBACK_DAYS * 864e5));
  const hi = ymd(new Date(now + LOOKAHEAD_DAYS * 864e5));

  // 0. The committed data.js: the article titles and the decided bouts. A
  // caller that just pushed a commit names it (X-Data-Sha) so this reads that
  // commit, not main's ~5-minute-stale copy. Unreadable: the Wikipedia pass
  // still runs (on rebuilt titles) and the data.js pass is skipped, reported.
  let cards: Card[] | null = null;
  let dataError: string | null = null;
  try {
    const pinned = pinnedDataUrl(DATA_URL, req.headers.get("X-Data-Sha"));
    let r = await fetch(pinned === DATA_URL ? `${DATA_URL}?t=${now}` : pinned, { headers: UA });
    if (!r.ok && pinned !== DATA_URL) r = await fetch(`${DATA_URL}?t=${now}`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const evs = parseDataJs(await r.text()).EVENTS;
    if (!Array.isArray(evs)) throw new Error("no EVENTS");
    cards = evs as Card[];
  } catch (e) { dataError = String(e).slice(0, 200); }
  const cardFor = (date: string, name: string): Card | undefined =>
    cards ? (cards.find((c) => c.date === date && c.name === name) ?? cards.find((c) => c.date === date)) : undefined;

  // 1. Recent events that people actually picked (the only possible audience).
  // picks-read: paged by readAllPicks.
  const evRows = await readAllPicks<{ event_date: string; event_name: string }>(
    `${SUPABASE_URL}/rest/v1/picks?select=event_date,event_name&event_date=gte.${lo}&event_date=lte.${hi}&promotion=eq.ufc&order=id`,
    picksHeaders,
  );
  if (!evRows) {
    return new Response(JSON.stringify({ error: "Failed to fetch events" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  const events = new Map<string, string>(); // event_date -> event_name
  for (const r of evRows) {
    if (r.event_date && r.event_name && !events.has(r.event_date)) events.set(r.event_date, r.event_name);
  }

  // The dedup log for the window, read once. `${event_date}|${type}` keys
  // mirror send-push's (event_date, type) claim. It also holds `net:` markers.
  const logged = new Set<string>();
  if (serviceHeaders) {
    try {
      const logRes = await fetch(
        `${SUPABASE_URL}/rest/v1/notif_log?event_date=gte.${lo}&event_date=lte.${hi}&select=event_date,type`,
        { headers: serviceHeaders },
      );
      if (logRes.ok) {
        const logRows: { event_date: string; type: string }[] = await logRes.json();
        for (const lr of logRows) if (lr.event_date && lr.type) logged.add(`${lr.event_date}|${lr.type}`);
      }
    } catch (_e) { /* best-effort; send-push still dedups if this read fails */ }
  }

  let parsedCount = 0, pushedCount = 0, skippedCount = 0, deferredCount = 0, processed = 0;
  const fights: unknown[] = [];
  // Picked cards whose results page couldn't be read. Reported, not swallowed:
  // on 2026-11-21 this function answered `parsed: 0` all card and nobody knew.
  const unread: { date: string; name: string }[] = [];
  const picksByDate = new Map<string, Pick[] | null>();
  const picksFor = async (date: string): Promise<Pick[] | null> => {
    if (!picksByDate.has(date)) {
      // All of them or none: a partial audience would be deduped for good,
      // while a failed read just waits for the next run. picks-read: paged by readAllPicks.
      picksByDate.set(date, await readAllPicks<Pick>(
        `${SUPABASE_URL}/rest/v1/picks?select=user_id,f1,f2,pick&event_date=eq.${encodeURIComponent(date)}&promotion=eq.ufc&order=id`,
        picksHeaders,
      ));
    }
    return picksByDate.get(date) ?? null;
  };

  // Group one decided bout's pickers and send each group not yet logged.
  // Returns the types it sent (claimed by send-push).
  const sendBout = async (date: string, winner: string, loser: string, boutNames: [string, string] | null, picks: Pick[]): Promise<string[]> => {
    const m = ResultsParse.namesMatch;
    const winners: string[] = [], losers: string[] = [];
    for (const p of picks) {
      if (!p.user_id) continue;
      const isFight = (m(p.f1, winner) && m(p.f2, loser)) || (m(p.f2, winner) && m(p.f1, loser));
      if (!isFight) continue;
      if (!boutNames) boutNames = [p.f1, p.f2];   // the pick rows' own names, as the lock is keyed
      (m(p.pick, winner) ? winners : losers).push(p.user_id);
    }
    if (!winners.length && !losers.length) return [];   // nobody picked this bout
    const todo = ([["win", winners], ["loss", losers]] as [string, string[]][])
      .filter(([g, ids]) => ids.length && !groupLogged(logged, date, winner, loser, g));
    if (!todo.length) { skippedCount++; return []; }
    const lockAt = boutNames ? await boutLockAt(SUPABASE_URL, picksHeaders, date, boutNames[0], boutNames[1]) : undefined;
    if (!graceOver(lockAt, now)) { deferredCount++; return []; }   // next run, once the grace is over (or the lock can be read)

    const fightKey = ResultsParse.fightKey(winner, loser);
    const sent: string[] = [];
    for (const [group, userIds] of todo) {
      const notifType = `result:${fightKey}:${group}`;
      const win = group === "win";
      try {
        const r = await fetch(`${SUPABASE_URL}/functions/v1/send-push`, {
          method: "POST",
          headers: pushHeaders,
          body: JSON.stringify({
            event_date: date,
            type: notifType,
            title: win ? "Your pick WON! 🔥" : "Tough luck ❌",
            body: win ? `${winner} def. ${loser} — you called it!` : `${winner} def. ${loser}`,
            safe_title: SAFE_TITLE,
            safe_body: SAFE_BODY,
            include_user_ids: userIds,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (j && typeof j.sent === "number" && j.sent > 0) pushedCount += j.sent;
        logged.add(`${date}|${notifType}`);   // claimed (or already claimed): never twice in a run
        if (r.ok && j && typeof j.sent === "number" && !j.skipped) sent.push(notifType);
        fights.push({ event_date: date, type: notifType, recipients: userIds.length, result: j });
      } catch (_e) { /* best-effort; the next run retries, notif_log dedups */ }
    }
    return sent;
  };

  // Pass 1: Wikipedia.
  for (const [eventDate, eventName] of events) {
    if (processed >= MAX_EVENTS) break;
    processed++;
    const slug = articleSlug(eventName, cardFor(eventDate, eventName));
    let wt: string | null = null;
    try { wt = await fetchWikitext(slug); } catch (_e) { wt = null; }
    if (!wt) { unread.push({ date: eventDate, name: eventName }); continue; }

    const parsed: FightResult[] = ResultsParse.parseResults(wt);
    parsedCount += parsed.length;
    if (!parsed.length) continue;
    const picks = await picksFor(eventDate);
    if (!picks) continue;

    for (const res of parsed) {
      // A draw / no contest has no winner to announce, and a result without a
      // loser can't be matched to a bout.
      if (res.undecided || !res.winner || !res.loser) continue;
      await sendBout(eventDate, res.winner, res.loser, null, picks);
    }
  }

  // Pass 2: the committed data.js. Anything sent here, the Wikipedia pass and
  // the scraper both missed: mark it (`net:<type>`) so it is seen.
  const net: { date: string; type: string }[] = [];
  if (cards) {
    for (const card of cards) {
      if (card.date < lo || card.date > hi || !events.has(card.date)) continue;
      const decided = (card.fights || []).filter((f) => f.winner && f.state === "post");
      if (!decided.length) continue;
      const picks = await picksFor(card.date);
      if (!picks) continue;
      for (const f of decided) {
        const winner = String(f.winner), a = f.f1?.n, b = f.f2?.n;
        if (!a || !b) continue;
        const loser = ResultsParse.namesMatch(winner, a) ? b : a;
        const sent = await sendBout(card.date, winner, loser, [a, b], picks);
        for (const type of sent) {
          if (serviceHeaders) {
            await fetch(`${SUPABASE_URL}/rest/v1/notif_log`, {
              method: "POST",
              headers: { ...serviceHeaders, "Content-Type": "application/json", "Prefer": "resolution=ignore-duplicates,return=minimal" },
              body: JSON.stringify({ event_date: card.date, type: `net:${type}` }),
            }).catch(() => {});
          }
          logged.add(`${card.date}|net:${type}`);
        }
      }
    }
  }
  // Every fired safety net in the window, this run's and earlier ones'.
  for (const k of logged) {
    const at = k.indexOf("|net:");
    if (at > 0) net.push({ date: k.slice(0, at), type: k.slice(at + 5) });
  }

  return new Response(
    JSON.stringify({ events: events.size, parsed: parsedCount, pushed: pushedCount, skipped: skippedCount, deferred: deferredCount, unread, net, dataError, fights }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
