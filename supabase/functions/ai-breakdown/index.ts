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

// Private background on the regulars, keyed by the leaderboard nickname the
// client already sends. The roast prompt is otherwise blind to WHO it is
// talking about — every burn had to run on rank and picks, so the same handful
// of angles kept coming back around. One personal detail is what makes a roast
// actually land, so each nickname carries a short dossier the model may pull a
// SINGLE detail from (see buildDossier for the usage rules).
//
// Matching is exact on the normalized nickname — never substring: short handles
// like "T" and "AB" would otherwise match half the board. An unknown nickname
// simply contributes nothing, which is the pre-existing behaviour.
const ROASTER_PROFILES: { aliases: string[]; bio: string }[] = [
  {
    aliases: ["jpeso", "jordan", "jordansalinas"],
    bio: "Jordan Salinas — late to absolutely everything, parties way too hard, die-hard Houston sports fan, and takes men's fashion a little too seriously.",
  },
  {
    aliases: ["t", "torrey", "torreybrett", "softhands"],
    bio: "Torrey Brett — AB's brother, tall and on the heavy side, nicknamed 'Soft Hands'. Software developer, animal lover. Just moved to Dallas and hates the city, and hates even more that the Dallas teams are stocked with Houston guys now that he lives there.",
  },
  {
    aliases: ["ab", "andy", "andybrett"],
    bio: "Andy Brett — Torrey's brother, the short skinny one. Teaches kids' martial arts. Easy-going and thoughtful, but leans into a challenge way too hard.",
  },
  {
    aliases: ["dereko", "derek"],
    bio: "Derek — could be mistaken for Eminem, or B-Rabbit out of 8 Mile. Obsessed with cliff jumping.",
  },
  {
    aliases: ["tristin", "tris"],
    bio: "Tristin — AB's wife. Smart, beautiful and ruthless past the point of necessity. Her sense of humour is darker than anyone expects.",
  },
];

const _profileIndex = new Map<string, string>();
for (const p of ROASTER_PROFILES) {
  for (const a of p.aliases) _profileIndex.set(a, p.bio);
}
const normNick = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
function profileFor(nickname: string): string | null {
  return _profileIndex.get(normNick(nickname)) ?? null;
}

// One optional paragraph of who-these-people-are, appended to the roast prompt.
// Deliberately framed as something the persona already knows rather than data
// to report: without the "never recite / at most one" rule the model reads the
// dossier back as a list of facts, which is the opposite of a burn.
function buildDossier(myName: string, targets: string[], hasHint: boolean): string {
  const lines: string[] = [];
  const mine = profileFor(myName);
  if (mine) lines.push(`${myName} (the one talking): ${mine}`);
  const seen = new Set<string>();
  for (const t of targets) {
    const key = normNick(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const bio = profileFor(t);
    if (bio) lines.push(`${t} (target): ${bio}`);
  }
  if (!lines.length) return "";
  // With an angle on the table the dossier is a seasoning at most: a personal
  // detail that pulls away from what the sender actually asked for is worse
  // than no detail at all.
  const use = hasHint
    ? "Use AT MOST ONE of those details, and only if it sharpens the angle you were given — if it pulls anywhere else, leave it out."
    : "Use AT MOST ONE of those details, and only when it makes the burn funnier than the picks would; ignore the lot if the roast is sharper without.";
  return ` YOU KNOW THESE PEOPLE personally — background, not material to report: ${lines.join(" | ")} ${use} Never list them, never explain them, never let on that you were handed them.`;
}

// Assembles the full roast prompt from the short variable parts the client
// sends. The scaffolding used to live client-side inlined into `question`,
// which put every trash-talk request ~3x over MAX_QUESTION once input caps
// landed; building it here keeps the caps tight without breaking the feature.
// It deliberately does NOT reuse buildChatPrompt. Routing the roast through the
// chat template meant the model's opening frame was "You are a UFC picks expert
// helping a fan make decisions on this card... use the fight data provided",
// with the roast — and any angle the sender typed — demoted to a QUESTION field
// in the middle, and the template's own "Answer only the question" as the FINAL
// instruction. That framing is why roasts came back as picks commentary and why
// a typed angle ("wax on wax off those tears") could vanish entirely: the model
// was answering an analyst's question, not writing a roast.
function buildTrashTalk(d: ReqBody): { system: string; user: string } {
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
  // Two INDEPENDENT random dimensions so no two roasts share a skeleton: WHAT the
  // burn is about (angle) and the SHAPE it takes (form). Rotating only the angle
  // still produced the same intro→diss-the-picks→signed-outro cadence every time;
  // varying the form is what makes it read like a real person riffing instead of a
  // template being filled in. A freshness token stops verbatim repeats.
  const angles = solo ? [
    "Write them off as a clueless nobody with no business talking picks.",
    "Trash their whole vibe — they pick like they've never watched a fight.",
    "Tell them to find a new hobby; this one clearly isn't for them.",
    `Make it clear they're beneath ${myName} and always will be.`,
    "Question whether they even understand how the sport works.",
    "Act like you can barely remember their name, they matter that little.",
    "Treat their confidence as the funniest part of how bad they are.",
    "Pity them — they tried their best and it still wasn't close."
  ] : [
    "Write the whole group off as clowns cosplaying as fight fans.",
    "Dismiss the entire board as tourists who got lucky once.",
    `Crown ${myName} and bury the rest in a single breath.`,
    "Tell them collectively to quit while they're behind.",
    `Mock the lot of them for thinking they're on ${myName}'s level.`,
    "Treat the whole leaderboard like it's beneath your attention.",
    "Act amazed this many people could be this wrong at once."
  ];
  // Rhetorical shapes — the real fix for the monotony. Each one breaks the
  // opener/jab/outro mold in a different direction. Every shape must be
  // deliverable in one or two short sentences: the run-on-breath and
  // mock-pep-talk shapes were cut because they invited the model to sprawl
  // past what anyone reads in a push notification.
  const forms = [
    "one clipped, dismissive line — they weren't worth a full effort",
    "open mid-thought, like you're already three insults deep",
    "a fake compliment that curdles into a gut-punch by the last word",
    "a rhetorical question you never let them answer",
    "a single devastating one-liner and nothing else",
    "a cold quiet threat delivered like a calm promise",
    "one absurd comparison, done in a single line",
    "start bored, snap into contempt by the end"
  ];
  const angleHint = angles[Math.floor(Math.random() * angles.length)];
  const formHint = forms[Math.floor(Math.random() * forms.length)];
  const seed = Math.random().toString(36).slice(2, 7);
  const hint = (d.hint ?? "").trim();
  // A user-supplied angle is an instruction, not a suggestion. It used to be
  // one clause among a dozen — the random form, the card, the profiles and the
  // structure rules all pulled equally hard, so "roast his Houston teams" came
  // back as a generic burn that never mentioned Houston. Everything that can
  // compete with the angle is now explicitly subordinated to it, and the angle
  // is restated last, where it is the final thing the model reads.
  const formRule = hint
    ? `Shape THIS one like: ${formHint} — but if that shape fights the angle, drop the shape and keep the angle.`
    : `Shape THIS one like: ${formHint}.`;
  const cardRule = hint
    ? "You MAY glance at the CARD for ONE detail, and only if it serves the angle — a card detail that changes the subject is worse than none."
    : "You MAY glance at the CARD for ONE detail, and only if it genuinely makes the burn funnier — most roasts should skip the card entirely and run on pure personality and disrespect.";
  // Attitude first and almost all the way through; a card reference is optional
  // seasoning, never the main course. A stat dump kills the burn, and — the whole
  // point of this rewrite — so does a predictable structure.
  const baseRules = `Speak PURELY as ${persona} — their cadence, their swagger, their exact way of talking shit. This is raw trash talk, rude and personal, NOT a scouting report. Do NOT follow a formula: no throat-clearing opener, no obligatory middle jab about their picks, no tidy mic-drop to close — just talk the way ${persona} actually would and let it land however it lands. ${formRule} ${cardRule} FACTS ARE STRICT: only tie a target to a pick explicitly attributed to THEM, never invent one, never blame them for a fight they won, never quote percentages or numbers. Don't lead with a rank, a username, or "hey" — drop straight into the voice, no emojis. LENGTH IS A HARD CAP: this lands as a push notification read on a phone — ONE short sentence is the default, TWO short sentences is the absolute maximum, and the whole roast stays under 30 words before the signature. If it needs more room it isn't funny enough yet; cut, don't explain the joke. Brevity IS the disrespect. When burying a group, land ONE collective burn — do not go person by person. Sign off with '— ${persona}' using the FULL name exactly as written, and even that should feel in-character. No preamble. (variety token, do not print: ${seed})`;
  const who = solo ? `ripping into ${opponentNames}` : `burying ${opponentNames}`;
  // Empty string whenever nobody involved has a profile, so unknown nicknames
  // produce exactly the prompt they produced before profiles existed.
  const dossier = buildDossier(myName, targets, !!hint);
  // Stated up front as a hard requirement, and repeated after the rules — last
  // position is the one the model weights most, and it is the only instruction
  // that outranks everything except accuracy and the length cap.
  // Everything about WHO you are and HOW to write goes in the system prompt.
  // The user turn carries only the situation and the ask — and it ENDS on the
  // angle, because the last thing in the conversation is what actually steers
  // the answer.
  const system = `You ARE ${persona}. You write trash talk on behalf of ${myName} ${who} — one savage line, in character. You are NOT an analyst and this is NOT a scouting report: never explain a pick, never weigh a matchup, never give advice. ${baseRules}${dossier}`;
  const situation = `LEADERBOARD: ${boardName}. ${boardAngle}
${myName}${d.myRank ? ` — rank #${d.myRank}, ${d.myRecord || ""}` : ""}. Roasting: ${opponentNames}.
CARD (background only — you almost never need it):
${d.card || "n/a"}`;
  // With no angle typed, the randomised angle is the ask. With one, the ask IS
  // the angle, stated last and stated as the only thing that matters.
  return hint
    ? {
      system,
      user: `${situation}

${myName} told you exactly what to hit them with. This is the entire job — a roast that does not land on it is a failed roast, no matter how funny it is:

  THE ANGLE: "${hint}"

Write it now, as ${persona}: one or two short sentences built on that angle, then the '— ${persona}' signature. Use the angle's own imagery and words where you can. Do not swap it for a generic insult about their picks, their rank or their record.`,
    }
    : {
      system,
      user: `${situation}

Write it now, as ${persona}: one or two short sentences, then the '— ${persona}' signature. Your take this time: ${angleHint}`,
    };
}

// The client recovers the persona from the roast's trailing "— X" signature
// (the receiver's sheet header and the notification fallback both parse it),
// so the FULL persona name must survive verbatim. Models speaking in-voice
// love to shorten names ("— Dustin" for Dustin Poirier), which then truncates
// the header everywhere — rewrite the signature with the full name instead of
// trusting the prompt instruction to hold.
function enforceSignature(text: string, persona: string): string {
  const t = text.trim();
  const i = t.lastIndexOf("—");
  if (i > 0) {
    // The roast body is full of em-dashes, so only treat the final chunk as a
    // signature when it reads as (part of) the persona's name.
    const tail = t.slice(i + 1).trim().replace(/[.!?"']+$/, "");
    const a = tail.toLowerCase(), b = persona.toLowerCase();
    if (a && (b.includes(a) || a.includes(b))) {
      return t.slice(0, i).trimEnd() + " — " + persona;
    }
  }
  // No recognizable signature (model skipped it or signed with a nickname) —
  // append the canonical one; the client parses the LAST "—", so this wins.
  return t + " — " + persona;
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
  let system: string | undefined;
  let maxTokens = 250;
  if (action === "chat") {
    prompt = buildChatPrompt(body);
    maxTokens = 180;
  } else if (action === "parlay") {
    prompt = buildParlayPrompt(body);
    maxTokens = 300;
  } else if (action === "trash-talk") {
    const built = buildTrashTalk(body);
    system = built.system;
    prompt = built.user;
    // The prompt hard-caps roasts at ~30 words / two sentences (people stopped
    // reading the long ones). 120 tokens is ~3x that budget, so the signature
    // always lands even when the model runs a little over, while still bounding
    // output if it ignores the cap entirely. send-push's MAX_BODY is sized
    // above the longest output this can produce.
    maxTokens = 120;
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
    ...(system ? { system } : {}),
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
  let text: string = data?.content?.[0]?.text ?? "";
  if (action === "trash-talk" && text) {
    text = enforceSignature(text, body.persona || "A Famous Friend");
  }
  return new Response(JSON.stringify({ breakdown: text }), { status: 200, headers: CORS });
});
