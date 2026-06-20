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
// It is a faithful port of the client live-poll (index.html `_pollOne` /
// `_pushResult`) and scrape.py `send_push_notifications`. The name-matching and
// fight-key derivation below are copied byte-for-byte from index.html so that
// the `result:<fightKey>:<group>` type — and therefore the `send-push`
// `notif_log` (event_date, type) dedup — is identical across all three senders.
// Only one push per fight ever goes out, whichever trigger sees it first.
//
// Deployed with --no-verify-jwt: the Supabase gateway would otherwise reject the
// cron's `Authorization: Bearer <CRON_SECRET>` as an invalid JWT before this code
// runs. Inbound auth is enforced here via CRON_SECRET instead.

// ---------------------------------------------------------------------------
// Wikipedia result parsing — ported verbatim from index.html (~4975-5074).
// ---------------------------------------------------------------------------

function _cleanWiki(t: string): string {
  if (!t) return "";
  t = t.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1");
  t = t.replace(/\{\{[^}]+\}\}/g, "");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\[\d+\]/g, "");
  try { t = t.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (_e) { /* noop */ }
  return t.trim().replace(/^,|,$/g, "").trim();
}

function _normMethod(m: string): string {
  if (!m) return "";
  const ml = m.toLowerCase();
  if (ml.indexOf("ko") >= 0 || ml.indexOf("tko") >= 0) return "KO/TKO";
  if (ml.indexOf("submission") >= 0 || ml.indexOf("sub") >= 0) return "Submission";
  if (ml.indexOf("unanimous") >= 0) return "Decision (Unanimous)";
  if (ml.indexOf("split") >= 0) return "Decision (Split)";
  if (ml.indexOf("majority") >= 0) return "Decision (Majority)";
  if (ml.indexOf("decision") >= 0) return "Decision";
  if (ml.indexOf("dq") >= 0) return "DQ";
  return m.trim();
}

function _lastName(name: string): string {
  const p = _cleanWiki(name).trim().split(/\s+/);
  return p.length ? p[p.length - 1].toLowerCase() : "";
}

function _namesMatch(a: string, b: string): boolean {
  const a2 = a.toLowerCase().replace(/[^a-z]/g, "");
  const b2 = b.toLowerCase().replace(/[^a-z]/g, "");
  return _lastName(a) === _lastName(b) ||
    (a2.length > 3 && b2.indexOf(a2) >= 0) ||
    (b2.length > 3 && a2.indexOf(b2) >= 0);
}

interface FightResult { winner: string; loser: string; method: string; round: number | null; }

function _parseMMATemplate(wt: string): FightResult[] {
  const results: FightResult[] = [];
  const re = /\{\{MMAevent bout\s*\n([\s\S]*?)\}\}/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wt)) !== null) {
    const lines = m[1].split("\n").map((l) => l.trim().replace(/^\|/, "").trim()).filter(Boolean);
    if (lines.length < 5) continue;
    let di = -1;
    for (let i = 0; i < lines.length; i++) {
      const ll = lines[i].toLowerCase().trim();
      if (ll === "def." || ll === "def" || ll === "d.") { di = i; break; }
    }
    if (di < 1) continue;
    const winner = _cleanWiki(lines[di - 1]).replace(/\s*\(c\)\s*/g, "").trim();
    const loser = di + 1 < lines.length ? _cleanWiki(lines[di + 1]).replace(/\s*\(c\)\s*/g, "").trim() : "";
    const method = di + 2 < lines.length ? lines[di + 2] : "";
    const rndS = di + 3 < lines.length ? lines[di + 3] : "";
    if (!winner || !method) continue;
    const rnd = parseInt(rndS, 10);
    results.push({ winner, loser, method: _normMethod(method), round: isNaN(rnd) ? null : rnd });
  }
  return results;
}

function _flushRow(rowIn: string[]): FightResult | null {
  const row = rowIn.map(_cleanWiki).filter(Boolean);
  if (row.length < 3) return null;
  const skipHdrs = ["weight class", "winner", "method", "round", "main card", "preliminary", "early prelim"];
  const joined = row.join(" ").toLowerCase();
  if (skipHdrs.some((h) => joined.indexOf(h) >= 0)) return null;
  let winner = "", loser = "", method = "", rnd: number | null = null, di = -1;
  for (let i = 0; i < row.length; i++) {
    const cl = row[i].trim().toLowerCase();
    if (cl === "def." || cl === "def" || cl === "d.") { di = i; break; }
  }
  let rest: string[];
  if (di > 0) {
    winner = row[di - 1].replace(/\s*\(c\)\s*/g, "").trim();
    loser = di + 1 < row.length ? row[di + 1].replace(/\s*\(c\)\s*/g, "").trim() : "";
    rest = row.slice(di + 2);
  } else {
    if (row.length < 4) return null;
    winner = row[1]; loser = row[2]; rest = row.slice(3);
  }
  if (!winner || winner.length < 2) return null;
  rest.forEach((cell) => {
    const cl = cell.toLowerCase();
    if (!method && (cl.indexOf("ko") >= 0 || cl.indexOf("tko") >= 0 || cl.indexOf("decision") >= 0 || cl.indexOf("submission") >= 0 || cl.indexOf("sub") >= 0 || cl.indexOf("dq") >= 0)) method = cell;
    else if (!rnd && /^\d$/.test(cell.trim())) rnd = parseInt(cell.trim(), 10);
  });
  if (!method && winner && loser && rnd) method = "Decision";
  if (!method) return null;
  return { winner, loser, method: _normMethod(method), round: rnd || null };
}

function _parseWikitable(wt: string): FightResult[] {
  const results: FightResult[] = [];
  let inTable = false, row: string[] = [];
  wt.split("\n").forEach((line) => {
    const s = line.trim();
    if (s.indexOf("{|") >= 0 && s.toLowerCase().indexOf("wikitable") >= 0) { inTable = true; row = []; return; }
    if (s.indexOf("|}") === 0) { if (row.length) { const r = _flushRow(row); if (r) results.push(r); } inTable = false; row = []; return; }
    if (!inTable) return;
    if (s.indexOf("|-") === 0) { if (row.length) { const r2 = _flushRow(row); if (r2) results.push(r2); } row = []; return; }
    if (s.indexOf("!") === 0) { row = []; return; }
    if (s.indexOf("|") === 0) {
      const content = s.replace(/^\|/, "");
      if (content.indexOf("||") >= 0) content.split("||").forEach((p) => row.push(p.trim()));
      else row.push(content);
    }
  });
  return results;
}

function _deriveSlug(evName: string): string {
  return evName.replace(/[^a-zA-Z0-9 :._-]/g, "").replace(/ /g, "_");
}

function _fightKey(winner: string, loser: string): string {
  return (winner + "-" + loser).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

interface Pick { user_id: string; f1: string; f2: string; pick: string; }

const SAFE_TITLE = "🥊 Fight result is in";
const SAFE_BODY = "A fight you picked is final — open the app to see how you did. (No spoilers here!)";

// Only look back ~2 days (matches scrape.py's stale-spoiler guard) and ~1 day
// forward so a card that crosses UTC midnight is still in window.
const LOOKBACK_DAYS = 2;
const LOOKAHEAD_DAYS = 1;
const MAX_EVENTS = 5; // hard cap on Wikipedia fetches per run

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

async function fetchWikitext(slug: string): Promise<string | null> {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(slug)}&prop=wikitext&format=json&origin=*`;
  const r = await fetch(url, { headers: { "User-Agent": "UFC-Dashboard/1.0 (github.com/AndyRBrett/ufc-dashboard)" } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.parse?.wikitext?.["*"] ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { "Content-Type": "application/json" } });
  }

  // Inbound auth: only a caller that knows CRON_SECRET may trigger a scrape.
  // Accept it as `Authorization: Bearer <secret>` (GitHub Actions) or a ?key=
  // query param (so external cron UIs work without custom headers).
  const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!CRON_SECRET || (auth !== `Bearer ${CRON_SECRET}` && key !== CRON_SECRET)) {
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
  const pushHeaders = { "Content-Type": "application/json", "Authorization": `Bearer ${SB_ANON_KEY}` };

  const now = Date.now();
  const lo = ymd(new Date(now - LOOKBACK_DAYS * 864e5));
  const hi = ymd(new Date(now + LOOKAHEAD_DAYS * 864e5));

  // 1. Recent events that people actually picked (the only possible audience).
  const evRes = await fetch(
    `${SUPABASE_URL}/rest/v1/picks?select=event_date,event_name&event_date=gte.${lo}&event_date=lte.${hi}`,
    { headers: anonHeaders },
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

  let parsedCount = 0, pushedCount = 0, skippedCount = 0, processed = 0;
  const fights: unknown[] = [];

  for (const [eventDate, eventName] of events) {
    if (processed >= MAX_EVENTS) break;
    processed++;

    const slug = _deriveSlug(eventName);
    let wt: string | null = null;
    try { wt = await fetchWikitext(slug); } catch (_e) { wt = null; }
    if (!wt) continue;

    let parsed = _parseMMATemplate(wt);
    if (!parsed.length) parsed = _parseWikitable(wt);
    parsedCount += parsed.length;
    if (!parsed.length) continue;

    // Picks for this event, used to group winners vs losers per resolved fight.
    let picks: Pick[] = [];
    try {
      const pRes = await fetch(
        `${SUPABASE_URL}/rest/v1/picks?select=user_id,f1,f2,pick&event_date=eq.${encodeURIComponent(eventDate)}`,
        { headers: anonHeaders },
      );
      if (pRes.ok) picks = await pRes.json();
    } catch (_e) { picks = []; }

    for (const res of parsed) {
      if (!res.winner || !res.loser) continue;
      const winners: string[] = [], losers: string[] = [];
      for (const p of picks) {
        if (!p.user_id) continue;
        const isFight =
          (_namesMatch(p.f1, res.winner) && _namesMatch(p.f2, res.loser)) ||
          (_namesMatch(p.f2, res.winner) && _namesMatch(p.f1, res.loser));
        if (!isFight) continue;
        (_namesMatch(p.pick, res.winner) ? winners : losers).push(p.user_id);
      }
      if (!winners.length && !losers.length) continue; // nobody picked this bout

      const fightKey = _fightKey(res.winner, res.loser);
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
    JSON.stringify({ events: events.size, parsed: parsedCount, pushed: pushedCount, skipped: skippedCount, fights }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
