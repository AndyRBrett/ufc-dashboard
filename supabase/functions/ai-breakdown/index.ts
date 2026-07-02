// Uses the runtime's built-in Deno.serve — no deno.land/std import, so deploys
// don't depend on deno.land being up.

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
// Overridable so the model can be upgraded without redeploying code.
const MODEL = Deno.env.get("MODEL") ?? "claude-haiku-4-5-20251001";

// Restrict which sites may call this (Claude-backed, cost-bearing) endpoint.
// Comma-separated env override; defaults to the production GitHub Pages origin.
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

// Lightweight per-IP rate limit to cap Claude cost from runaway/abusive callers.
// In-memory and per-instance (resets on cold start) — a cheap guard, not a hard global quota.
const RATE_LIMIT = Number(Deno.env.get("RATE_LIMIT") ?? "20");          // requests...
const RATE_WINDOW_MS = Number(Deno.env.get("RATE_WINDOW_MS") ?? "60000"); // ...per this window
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
// Claude spend even if every request claims a different IP. Deliberately loose;
// it exists purely to put a ceiling on worst-case cost, not to police normal use.
const GLOBAL_RATE_LIMIT = Number(Deno.env.get("GLOBAL_RATE_LIMIT") ?? "200");
const GLOBAL_RATE_WINDOW_MS = Number(Deno.env.get("GLOBAL_RATE_WINDOW_MS") ?? "60000");
let _globalHits: number[] = [];
function globalRateLimited(): boolean {
  const now = Date.now();
  _globalHits = _globalHits.filter((t) => now - t < GLOBAL_RATE_WINDOW_MS);
  _globalHits.push(now);
  return _globalHits.length > GLOBAL_RATE_LIMIT;
}

// Per-request input caps — max_tokens only bounds Claude's *output*; without a
// cap here a caller can inflate *input* tokens (and therefore cost) arbitrarily
// even while staying under the request-count rate limits above.
const MAX_QUESTION = 400, MAX_CARD = 4000, MAX_USER_PICKS = 2000;
const MAX_PERSONA = 100, MAX_NICKNAME = 60, MAX_TARGETS = 20;
const MAX_HINT = 160, MAX_RECORD = 200, MAX_EVNAME = 120;
function inputTooLarge(d: ReqBody): boolean {
  if ((d.question ?? "").length > MAX_QUESTION) return true;
  if ((d.card ?? "").length > MAX_CARD) return true;
  if ((d.userPicks ?? "").length > MAX_USER_PICKS) return true;
  if ((d.persona ?? "").length > MAX_PERSONA) return true;
  if ((d.myNickname ?? "").length > MAX_NICKNAME) return true;
  if ((d.hint ?? "").length > MAX_HINT) return true;
  if ((d.myRecord ?? "").length > MAX_RECORD) return true;
  if ((d.evName ?? "").length > MAX_EVNAME) return true;
  if (d.targets) {
    if (d.targets.length > MAX_TARGETS) return true;
    if (d.targets.some((t) => (t ?? "").length > MAX_NICKNAME)) return true;
  }
  return false;
}

interface Fighter { n: string; rec: string; rk: string; }
interface Stats { slpm: number; acc: number; td: number; tdd: number; ko: number; sub: number; stn: string; }
interface FormEntry { r: string; m: string; }
interface ReqBody {
  action?: string;
  // breakdown fields
  f1?: Fighter; f2?: Fighter;
  wc?: string; title?: boolean; event?: string;
  odds?: { f1: number; f2: number };
  s1?: Stats; s2?: Stats;
  form1?: FormEntry[]; form2?: FormEntry[];
  // chat fields
  card?: string; userPicks?: string; question?: string;
  // trash-talk fields — only the short variable parts; the prompt scaffolding
  // (board framing, roast angles, structure rules) is assembled server-side in
  // buildTrashTalkPrompt so the per-field input caps above can stay tight.
  persona?: string;
  myNickname?: string; myRank?: number; myRecord?: string;
  targets?: string[];               // nicknames of whoever's being roasted
  lbMode?: string;                  // "current" (this week's event) or all-time
  evName?: string | null;           // event name when lbMode === "current"
  hint?: string;                    // optional user-supplied angle
}

function buildBreakdownPrompt(d: ReqBody): string {
  const fmtOdds = (n: number) => n > 0 ? `+${n}` : `${n}`;
  const fmtForm = (form: FormEntry[]) =>
    (form ?? []).slice(0, 3).map(f => `${f.r}(${f.m})`).join(", ") || "N/A";
  const rk = (r: string) => r === "C" ? "Champion" : r ? `#${r} ranked` : "unranked";
  const f1 = d.f1!; const f2 = d.f2!;
  const statsBlock = d.s1 && d.s2 ? `
Stats: ${f1.n}: ${d.s1.slpm} str/min, ${d.s1.acc}% acc, ${d.s1.td} TD/15min, ${d.s1.tdd}% TDD, ${d.s1.ko} KO wins, ${d.s1.sub} sub wins, ${d.s1.stn}
Stats: ${f2.n}: ${d.s2.slpm} str/min, ${d.s2.acc}% acc, ${d.s2.td} TD/15min, ${d.s2.tdd}% TDD, ${d.s2.ko} KO wins, ${d.s2.sub} sub wins, ${d.s2.stn}` : "";
  return `You are a concise UFC analyst writing for fans. Give a technical breakdown of this fight in exactly 3-4 sentences. Focus on: the key stylistic matchup, who has the statistical edge and where, and the most likely path to victory for each. End with one sentence naming your predicted winner and method. Be specific and punchy — no filler, no "It will be exciting", no hedging.

FIGHT: ${f1.n} (${f1.rec}, ${rk(f1.rk)}) vs ${f2.n} (${f2.rec}, ${rk(f2.rk)})
EVENT: ${d.event}${d.title ? " — TITLE FIGHT" : ""}  |  WEIGHT CLASS: ${d.wc}
${d.odds ? `ODDS: ${f1.n} ${fmtOdds(d.odds.f1)} / ${f2.n} ${fmtOdds(d.odds.f2)}` : ""}
${f1.n} recent form: ${fmtForm(d.form1 ?? [])}
${f2.n} recent form: ${fmtForm(d.form2 ?? [])}${statsBlock}

Respond with only the analysis — no headers, no bullet points.`;
}

function buildChatPrompt(d: ReqBody): string {
  return `You are a UFC picks expert helping a fan make decisions on this card. Answer in 2-4 sentences. Be specific, direct, and use the fight data provided. No generic advice.

EVENT: ${d.event}
CARD:
${d.card}
USER'S CURRENT PICKS: ${d.userPicks || "None yet"}

QUESTION: ${d.question}

Answer only the question — no preamble, no sign-off.`;
}

// Assembles the full roast prompt from the short variable parts the client
// sends. The scaffolding used to live client-side inlined into `question`,
// which put every trash-talk request ~3x over MAX_QUESTION once input caps
// landed; building it here keeps the caps tight without breaking the feature.
// The assembled text is wrapped in the same chat template the client used to
// route through (action:"chat"), so the prompt Claude sees is unchanged.
function buildTrashTalkPrompt(d: ReqBody): string {
  const persona = d.persona || "A Famous Friend";
  const myName = d.myNickname || "The Champ";
  const targets = (d.targets ?? []).filter(Boolean);
  const solo = targets.length === 1;
  const opponentNames = targets.join(", ") || "nobody worth mentioning";
  // Ground the smack talk in whichever leaderboard is actually on screen —
  // this week's event standings vs all-time career records read very differently.
  const boardName = d.lbMode === "current"
    ? `this week's ${d.evName || "event"} leaderboard (picks for this event only)`
    : "the ALL-TIME leaderboard (career records across every event)";
  const boardAngle = d.lbMode === "current"
    ? `The rankings are about ${d.evName || "this week's card"} — work that event into the smack talk.`
    : "This is about all-time, career-long bragging rights — make the history sting.";
  // A randomised hook + a freshness token so the same persona on the same board
  // doesn't keep producing the same line — fresh marching orders on every tap.
  // Each angle bakes in the structure the user wants: lead rude + generic, THEN
  // twist the knife with one concrete stat/pick. Branch on solo vs group so the
  // hook actually fits who's being roasted.
  const angles = solo ? [
    "Open by writing them off as a clueless nobody, THEN twist the knife with the one fight they blew — name the fighter.",
    "Trash how they pick fights in general, THEN back it with a specific bad call from the dossier.",
    "Tell them to find a new hobby, THEN cite the cold streak or whiffed pick that proves it.",
    `Treat them as beneath ${myName}, THEN drop the head-to-head clash where they ate it.`,
    "Question whether they've ever watched a fight, THEN name the fighter they backed that exposes it."
  ] : [
    "Write the whole group off as clowns, THEN single out the one who blew the biggest pick by name.",
    "Mock them all for fading the same fighter, THEN name who got buried worst.",
    "Dismiss the entire board as tourists, THEN twist the knife with one specific blown call.",
    `Crown ${myName} and bury the rest, THEN drop a real head-to-head clash someone lost.`,
    "Tell them collectively to quit, THEN back it with the coldest streak on the board."
  ];
  const angleHint = angles[Math.floor(Math.random() * angles.length)];
  const seed = Math.random().toString(36).slice(2, 7);
  // Rude and generic FIRST, the stat as a follow-up kicker — and never percentages.
  const baseRules = `STRUCTURE THE ROAST: open with a blunt, generic, genuinely RUDE insult in ${persona}'s voice — pure attitude, NO numbers or stats up front. THEN follow up with ONE specific dig pulled from the CARD (a fight they blew, a fighter they backed, a cold streak). FACTS ARE STRICT: only mock the target for picks explicitly attributed to THEM in the CARD; NEVER claim they backed a fighter that isn't listed under their name, and never blame them for a fight they actually won — if there's nothing real to mock, lean on pure persona attitude instead of inventing anything. Never quote percentages — they don't land in trash talk. Don't open on a rank or username, skip the emoji crutch, speak purely in ${persona}'s unmistakable voice. End with '— ${persona}'. No preamble. 2-3 sentences. (variety token, do not print: ${seed})`;
  const who = solo ? `ripping into ${opponentNames}` : `burying ${opponentNames}`;
  const hint = (d.hint ?? "").trim();
  const question = hint
    ? `You ARE ${persona}. Trash talk on behalf of ${myName} ${who} on ${boardName}. ${boardAngle} Build the bit around this angle: "${hint}". ${baseRules}`
    : `You ARE ${persona}. Trash talk on behalf of ${myName} ${who} on ${boardName}. ${boardAngle} ${angleHint} ${baseRules}`;
  return buildChatPrompt({
    event: `UFC Picks Leaderboard — ${boardName}`,
    card: d.card,
    userPicks: myName + (d.myRank ? ` — Rank #${d.myRank}, ${d.myRecord || ""}` : ""),
    question,
  });
}

function buildParlayPrompt(d: ReqBody): string {
  return `You are a UFC betting analyst. Suggest exactly 3 parlay combinations for this card. Mix risk levels: one safe (2 heavy favourites), one medium (2-3 fighters with value), one risky upset special.

For each parlay use EXACTLY this format on one line:
PARLAY 1: [Fighter A] + [Fighter B] | [one sentence reasoning]
PARLAY 2: [Fighter A] + [Fighter B] + [Fighter C] | [one sentence reasoning]
PARLAY 3: [Fighter A] + [Fighter B] | [one sentence reasoning]

Only suggest fighters from this card. Keep each reason under 20 words.

EVENT: ${d.event}
CARD (fighter vs fighter | odds | weight class):
${d.card}`;
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
  const auth = req.headers.get("Authorization") ?? "";
  if (ANON_KEY && auth !== `Bearer ${ANON_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS });
  }

  const ip = clientIp(req);
  if (rateLimited(ip) || globalRateLimited()) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded. Slow down." }), { status: 429, headers: CORS });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS });
  }

  if (inputTooLarge(body)) {
    return new Response(JSON.stringify({ error: "Input too long" }), { status: 400, headers: CORS });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured: missing API key" }), { status: 500, headers: CORS });
  }

  const action = body.action ?? "breakdown";
  let prompt: string;
  let maxTokens = 250;
  if (action === "chat") {
    prompt = buildChatPrompt(body);
    maxTokens = 180;
  } else if (action === "parlay") {
    prompt = buildParlayPrompt(body);
    maxTokens = 300;
  } else if (action === "trash-talk") {
    prompt = buildTrashTalkPrompt(body);
    // Same budget as the chat path the client used to route roasts through —
    // send-push's body-length cap is sized around this output.
    maxTokens = 180;
  } else {
    // breakdown needs both fighters — guard before the non-null assertions in buildBreakdownPrompt
    if (!body.f1?.n || !body.f2?.n) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: f1 and f2" }),
        { status: 400, headers: CORS }
      );
    }
    prompt = buildBreakdownPrompt(body);
    maxTokens = 250;
  }

  const claudeReqBody = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });

  let claudeRes: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1500));
    claudeRes = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: claudeReqBody,
    });
    if (claudeRes.ok || claudeRes.status !== 529) break;
  }

  if (!claudeRes!.ok) {
    const err = await claudeRes!.text();
    const overloaded = claudeRes!.status === 529;
    return new Response(
      JSON.stringify({ error: overloaded ? "overloaded" : "Claude API error", detail: err }),
      { status: 502, headers: CORS }
    );
  }

  const data = await claudeRes!.json();
  const text: string = data?.content?.[0]?.text ?? "";
  return new Response(JSON.stringify({ breakdown: text }), { status: 200, headers: CORS });
});
