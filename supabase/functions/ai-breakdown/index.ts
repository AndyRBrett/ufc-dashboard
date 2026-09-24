// Uses the runtime's built-in Deno.serve — no deno.land/std import, so deploys
// don't depend on deno.land being up.

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
// Overridable so the model can be upgraded without redeploying code.
const MODEL = Deno.env.get("MODEL") ?? "claude-haiku-4-5-20251001";

// --- Grok (xAI), for the roast only ----------------------------------------
//
// Claude writes a good burn but keeps sanding the edges off it: the language
// comes back PG no matter how the prompt is phrased, and a roast that reads
// like it was cleared by a publicist is not what anyone on this board wants
// pushed to their phone. Grok will actually swear, so the `trash-talk` action
// runs on it while `breakdown`, `chat` and `parlay` — where accuracy matters
// and tone does not — stay on Claude. Two models, split by what each is good
// at, not a wholesale migration.
//
// The endpoint is OpenAI-shaped chat-completions, so the response is parsed
// differently (choices[0].message.content, not content[0].text) — that is the
// only structural difference; system/user split and max_tokens carry over.
const GROK_API_URL = Deno.env.get("GROK_API_URL") ?? "https://api.x.ai/v1/chat/completions";
// NON-REASONING, AND MEASURED. This is the only Grok model that has actually
// served a roast here: 1.7s end to end, against roughly 2s for the Claude path
// it replaced. The roast is generated while someone stands there watching a
// spinner on a live card, so that number is the requirement, not a nice-to-have.
// A burn of a few sentences has nothing to reason about, so a thinking budget
// buys latency and no quality.
//
// What is NOT the reason: grok-4.6 was the first default here and a roast on
// that config took 23.4 seconds, but that call never reached xAI — the key
// wasn't named what the function reads, so it went to Claude, which was
// evidently retrying under load. **grok-4.6's real latency on this workload has
// never been measured.** Don't repeat the 23.4s figure as evidence against it;
// if you want 4.6, measure it rather than inheriting this note's conclusion.
//
// Verified against GET /v1/models on this account — never typed from memory.
// Note the display name matches the id for some ("Grok 4.6" → "grok-4.6") and
// not others, so check the list before changing this. An id this account
// cannot serve is a 400, and a 400 on the roast falls back to Claude silently
// — it reads as a tone regression, not a typo.
//
// GROK_MODEL is a secret, so any of this moves without a redeploy.
const GROK_MODEL = Deno.env.get("GROK_MODEL") ?? "grok-4.20-0309-non-reasoning";

// Grok gets a far bigger token ceiling than Claude does for the same roast, and
// it is not so the roast can be longer — length is enforced by the prompt (~70
// words, four sentences) and ROAST_MAX_CHARS, not by this number.
//
// It is because a REASONING model spends this budget thinking before it writes.
// On the OpenAI-shaped API the cap covers reasoning tokens as well as the reply,
// so the 250 that comfortably fits a short riff from a non-reasoning model
// can be consumed entirely by a reasoning model's scratchpad — returning HTTP
// 200 with empty content, which is a dud roast and not an error anyone can see.
// A ceiling this loose costs nothing extra when the model doesn't reason (you
// are billed for tokens produced, not for the cap) and saves the request when
// it does. Lower it only if a bill says to.
const GROK_MAX_TOKENS = Number(Deno.env.get("GROK_MAX_TOKENS") ?? "1000");

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
const MAX_IQ_LINES = 8, MAX_IQ_LINE = 200;
function inputTooLarge(d: ReqBody): boolean {
  if ((d.question ?? "").length > MAX_QUESTION) return true;
  if ((d.card ?? "").length > MAX_CARD) return true;
  if ((d.userPicks ?? "").length > MAX_USER_PICKS) return true;
  if ((d.persona ?? "").length > MAX_PERSONA) return true;
  if ((d.myNickname ?? "").length > MAX_NICKNAME) return true;
  if ((d.hint ?? "").length > MAX_HINT) return true;
  if ((d.myRecord ?? "").length > MAX_RECORD) return true;
  if ((d.evName ?? "").length > MAX_EVNAME) return true;
  if (d.iq) {
    const q = d.iq;
    if (typeof q !== "object") return true;
    if ((q.player ?? "").length > MAX_NICKNAME || (q.archetype ?? "").length > 40 || (q.blurb ?? "").length > 120) return true;
    if ((q.record ?? "").length > 20 || (q.locks ?? "").length > 20) return true;
    if (!Array.isArray(q.insights) || q.insights.length > MAX_IQ_LINES || q.insights.some((t) => typeof t !== "string" || t.length > MAX_IQ_LINE)) return true;
    if (q.rivals && (!Array.isArray(q.rivals) || q.rivals.length > 5 || q.rivals.some((t) => typeof t !== "string" || t.length > MAX_IQ_LINE))) return true;
  }
  if ((d.viewerId ?? "").length > 80) return true;
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
  // fight-iq fields — the Fight Lab's deterministic Fight IQ, already computed
  // in the browser (lab/analytics.js). The model only writes prose around it.
  iq?: IqFacts;
  viewerId?: string;                // whose daily write-up budget this spends
}
interface IqFacts {
  player: string; archetype: string; blurb?: string;
  record: string; accuracy: number | null; points: number;
  locks?: string; methodPct?: number | null; clv?: number | null;
  insights: string[]; rivals?: string[];
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
    bio: "Jordan Salinas — late to absolutely everything, parties way too hard, die-hard Houston sports fan, and takes men's fashion a little too seriously. Once flipped his car and totaled it.",
  },
  {
    aliases: ["t", "torrey", "torreybrett", "softhands"],
    bio: "Torrey Brett — AB's brother, tall and on the heavy side, nicknamed 'Soft Hands'. Software developer, animal lover. Just moved to Dallas and hates the city, and hates even more that the Dallas teams are stocked with Houston guys now that he lives there. Dallas is only ever something to insult: any Dallas reference trashes the city or its teams, and never defends, praises or sticks up for Dallas.",
  },
  {
    aliases: ["ab", "andy", "andybrett"],
    bio: "Andy Brett — Torrey's brother, the short skinny one. Teaches kids' martial arts. Easy-going and thoughtful, but leans into a challenge way too hard.",
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

// One optional paragraph of who-this-person-is, appended to the roast prompt.
// Deliberately framed as something the persona already knows rather than data
// to report: without the "never recite" rule the model reads it back as a list
// of facts, which is the opposite of a burn.
//
// It carries ONE target's profile, picked at random, and never the sender's.
// Both are structural on purpose, after prompt rules alone kept losing:
//
//   - The sender's own profile was the source of every leak. Torrey's "Soft
//     Hands" came back as a brag from the top of the board; then his Dallas
//     move was pinned on the whole group, twice ("soft-handed Dallas
//     transplants", "hiding in Dallas like the rest of you cowards") — with a
//     rule forbidding exactly that sitting in the prompt. A roast aimed at
//     other people has no use for the sender's details, so it doesn't get them.
//   - Handing over every target's profile invited the model to stack them and
//     cross-wire them into one smear. The prompt only ever allowed one detail
//     per roast; now only one person's details exist to use, so there is
//     nothing to mix up, and the random pick keeps roasts varied across sends.
function buildDossier(myName: string, targets: string[], hasHint: boolean): string {
  const me = normNick(myName);
  const profiled: { name: string; bio: string }[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    const key = normNick(t);
    if (!key || key === me || seen.has(key)) continue;
    seen.add(key);
    const bio = profileFor(t);
    if (bio) profiled.push({ name: t, bio });
  }
  if (!profiled.length) return "";
  const { name, bio } = profiled[Math.floor(Math.random() * profiled.length)];
  // With an angle on the table the detail backs it up: one that piles onto
  // what the sender asked for is welcome, one that drags the roast somewhere
  // else entirely is not.
  const use = hasHint
    ? "Use AT MOST ONE detail from it, and only if it builds on the angle you were given — if it drags the roast somewhere else entirely, leave it out."
    : "Use AT MOST ONE detail from it, and only when it makes the burn funnier than the picks would; ignore it if the roast is sharper without.";
  // Every detail is a flaw, a quirk or a grudge — ammunition, never praise.
  const polarity = " Every detail there is a weakness or a grudge, never a strength — do not spin it into a compliment, a boast or a badge of honour.";
  // It belongs to that one person: nobody else on the board shares it.
  const ownership = ` That background is about ${name} and ${name} ONLY — aim any of it at ${name} alone. Nobody else on the board shares any of it: never pin it on anyone else, and never spread it across the group.`;
  return ` YOU KNOW ${name} personally — background, not material to report: ${bio} ${use}${polarity}${ownership} Never list it, never explain it, never let on that you were handed it.`;
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
  // opener/jab/outro mold in a different direction. The roast has room for a
  // short riff now (see LENGTH in baseRules), so a shape can build over a few
  // sentences instead of having to land in one — but none of them should read
  // as a list of separate insults.
  const forms = [
    "open mid-thought, like you're already three insults deep, and keep escalating",
    "a fake compliment that curdles into a gut-punch by the last line",
    "a string of rhetorical questions you never let them answer",
    "a cold quiet threat delivered like a calm promise, then twist the knife",
    "one absurd comparison, then stretch it until it hurts",
    "start bored, snap into contempt by the end",
    "a mock pep talk that falls apart into pure disrespect",
    "a slow build to one devastating closing line"
  ];
  const angleHint = angles[Math.floor(Math.random() * angles.length)];
  const formHint = forms[Math.floor(Math.random() * forms.length)];
  const seed = Math.random().toString(36).slice(2, 7);
  const hint = (d.hint ?? "").trim();
  // A user-supplied angle is the subject of the roast, but it is a springboard,
  // not a script. It used to be enforced near-verbatim, because Claude kept
  // swapping a typed angle for its own tamer burn; on Grok that fight is over,
  // and holding it to the sender's exact words made the roast read like the
  // sender's line read back rather than the persona riffing on it. So the
  // angle must be recognisably what the roast is ABOUT, and the model is free
  // to rephrase it, exaggerate it and build on it. The random shape is still
  // not applied with an angle typed — two competing briefs made the model
  // split the difference — and the angle is still repeated in the system
  // prompt and as the final line of the user turn, the two positions the
  // model weights hardest.
  const formRule = hint ? "" : `Shape THIS one like: ${formHint}.`;
  const cardRule = hint
    ? "You MAY glance at the CARD for ONE detail, and only if it serves the angle — a card detail that changes the subject is worse than none."
    : "You MAY glance at the CARD for ONE detail, and only if it genuinely makes the burn funnier — most roasts should skip the card entirely and run on pure personality and disrespect.";
  // Attitude first and almost all the way through; a card reference is optional
  // seasoning, never the main course. A stat dump kills the burn, and — the whole
  // point of this rewrite — so does a predictable structure.
  const baseRules = `Speak PURELY as ${persona} — their cadence, their swagger, their exact way of talking shit. This is raw trash talk, rude and personal, NOT a scouting report. Do NOT follow a formula: no throat-clearing opener, no obligatory middle jab about their picks, no tidy mic-drop to close — just talk the way ${persona} actually would and let it land however it lands. ${formRule} ${cardRule} FACTS ARE STRICT: only tie a target to a pick explicitly attributed to THEM, never invent one, never blame them for a fight they won, never quote percentages or numbers. Don't lead with a rank, a username, or "hey" — drop straight into the voice, no emojis. LENGTH IS A HARD CAP: this is read on a phone, so give it a proper riff — TWO to FOUR sentences, building on itself, and the whole roast stays under 70 words before the signature. Every sentence has to hit harder than the last; no filler, no explaining the joke. When burying a group, keep it one collective burn — do not go person by person. Sign off with '— ${persona}' using the FULL name exactly as written, and even that should feel in-character. No preamble. (variety token, do not print: ${seed})`;
  const who = solo ? `ripping into ${opponentNames}` : `burying ${opponentNames}`;
  // Empty string whenever nobody involved has a profile, so unknown nicknames
  // produce exactly the prompt they produced before profiles existed.
  const dossier = buildDossier(myName, targets, !!hint);
  // Everything about WHO you are and HOW to write goes in the system prompt;
  // the user turn carries only the situation and the ask, and ENDS on the
  // angle, because the last thing in the conversation is what actually steers
  // the answer.
  //
  // The angle used to appear only in that user turn. The system prompt — the
  // part that defines the whole job — never saw it, so every rule the model
  // read about who it is and how to write was phrased as if no angle existed,
  // and a roast that merely shared the angle's TOPIC satisfied all of them.
  // It goes in both places now. Both ask for the angle to be what the roast is
  // about — not for its exact words back (see formRule above for why).
  const angleRule = hint
    ? ` THE ANGLE IS THE SUBJECT: ${myName} told you what to hit them with — "${hint}". Build the roast around that idea, in ${persona}'s voice. Treat it as a springboard, not a script: you are free to reword it, exaggerate it, twist it and pile on top of it — a better take on the same idea beats reading it back verbatim. Borrow its words or imagery wherever they land hardest. The one way to fail is to drift off it: a reader who saw what ${myName} typed must recognise that THIS is what the roast is about.`
    : "";
  const system = `You ARE ${persona}. You write trash talk on behalf of ${myName} ${who} — a short savage riff, in character. You are NOT an analyst and this is NOT a scouting report: never explain a pick, never weigh a matchup, never give advice. ${baseRules}${dossier}${angleRule}`;
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

${myName} told you what to hit them with. Run with it — make it the heart of the roast and take it further than they did:

  THE ANGLE: "${hint}"

Write it now, as ${persona}: two to four sentences built around that angle. Rephrase it, exaggerate it and escalate it however ${persona} would, but keep it the subject throughout — do not swap it for a generic insult about their picks, their rank or their record. Then the '— ${persona}' signature.

Hit them with this: "${hint}"`,
    }
    : {
      system,
      user: `${situation}

Write it now, as ${persona}: two to four sentences, then the '— ${persona}' signature. Your take this time: ${angleHint}`,
    };
}

// --- Did the roast actually go after the sender's angle? --------------------
//
// The angle is a springboard now, not a script (see buildTrashTalk), so the
// model is free to reword it. What it still may not do is abandon it for its
// own burn, which is the failure the sender notices ("I asked for wax on wax
// off and got a joke about his rank"). So the output is checked against the
// angle's content words, and a roast that carries NONE of them buys ONE
// retry — bounded, and only ever spent when a hint was typed and ignored.
const ANGLE_STOPWORDS = new Set([
  "the", "and", "but", "for", "with", "that", "this", "they", "them", "their", "you", "your",
  "his", "her", "hers", "its", "our", "ours", "was", "were", "are", "been", "being", "have",
  "has", "had", "not", "all", "any", "can", "will", "just", "him", "she", "who", "how", "why",
  "what", "when", "then", "than", "some", "about", "into", "from", "out", "off", "over", "get",
  "got", "one", "like", "make", "made", "say", "says", "said", "too", "very", "really",
]);
// Words any roast on this board is likely to say whether or not it went near
// the angle. With a one-word bar, "compare his picks to a broken slot machine"
// would otherwise be satisfied by "your picks are embarrassing" — so these
// never count as evidence the angle was used. Compared after normWord.
const ANGLE_CONTEXT_WORDS = new Set([
  "pick", "rank", "record", "fight", "fighter", "card", "board", "leaderboard", "event",
  "ufc", "mma", "win", "won", "lose", "loss", "lost", "point", "score", "bet", "odd",
  "roast", "trash", "talk", "week", "night", "season", "year", "guy", "man", "bro", "dude",
].map((w) => w.replace(/(?:'s|s|es|ed|ing)$/, "")));
const normWord = (w: string) => w.replace(/(?:'s|s|es|ed|ing)$/, "");
// `names` are the sender's and targets' nicknames: a roast addresses them by
// name regardless of the angle, so a name is no evidence either.
function angleKeywords(hint: string, names: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const nameWords = new Set(names.flatMap((n) => (n ?? "").toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean).map(normWord));
  for (const w of (hint ?? "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/)) {
    if (w.length < 3 || ANGLE_STOPWORDS.has(w)) continue;
    const k = normWord(w);
    if (!k || seen.has(k) || ANGLE_CONTEXT_WORDS.has(k) || nameWords.has(k)) continue;
    seen.add(k);
    out.push(w);
  }
  return out;
}
// "Used it" means at least one of the angle's distinctive words came back —
// context vocabulary and names excluded (see ANGLE_CONTEXT_WORDS). It used
// to demand most of them, back when the angle was enforced near-verbatim; that
// threshold would now reject exactly the reworded riffs the prompt asks for.
// One word is a deliberately low bar: it only catches a roast that walked away
// from the angle entirely. An angle with no content words at all (punctuation,
// pure stopwords) can't be judged, so it passes rather than burning a retry.
function usesAngle(text: string, hint: string, names: string[] = []): boolean {
  const kws = angleKeywords(hint, names);
  if (!kws.length) return true;
  const hay = " " + (text ?? "").toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ") + " ";
  const words = new Set(hay.trim().split(" ").map(normWord));
  const hits = kws.filter((k) => words.has(normWord(k)) || hay.includes(" " + k + " ")).length;
  return hits >= 1;
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

// --- The gloves-off rule ---------------------------------------------------
//
// Appended to the END of the roast system prompt, and ONLY when the roast is
// going to a provider that will actually honour it. Last position is deliberate
// — it is the same reason the sender's angle is repeated as the final line of
// the user turn: the model weights the end of its instructions hardest, and a
// "you may swear" buried mid-prompt loses to the thirty rules around it.
//
// It is a suffix rather than a flag threaded through buildTrashTalk so that the
// filtered prompt and the unfiltered one are the SAME STRING plus this — which
// is what makes the Grok→Claude fallback below exact. On a fallback we drop the
// suffix and re-send the identical system prompt, instead of rebuilding it and
// re-rolling the random angle, form and seed the first attempt already picked.
//
// The floor is ONE line now: no slurs. Two things that used to sit here came
// out, because between five friends who opted into this they were pulling
// ordinary roast material off the table:
//
//   - the blanket "don't touch race, religion, sex, gender, disability or
//     sexuality". Too broad by a mile. It caught jokes about someone's looks
//     and any joke about AB and Tristin being married — which is exactly the
//     material the board exists for.
//   - "no threat meant literally". This prompt LISTS comedic menace as one of
//     its rhetorical forms ("a cold quiet threat delivered like a calm
//     promise"), so the ban was arguing with the feature around it.
//
// What stays is word-level, not topic-level: no topic is off-limits and the
// roast can go as hard at anyone here as it likes, it just doesn't reach for
// those words. This is a standing instruction in a system prompt rather than
// something a sender typed once, and the output is signed with a real name and
// pushed to a real friend's lock screen. The sender does read the roast before
// hitting send, so this is a floor on what gets GENERATED, not the last line
// of defence — if it ever needs to move further, move it here.
function unfilteredRule(persona: string): string {
  return ` NO CLEAN-LANGUAGE FILTER — THIS IS THE WHOLE POINT: everyone on this board opted in and they want it filthy. Swear properly and often, go crude, go below the belt, get genuinely mean. Profanity is not seasoning here, it is the register: ${persona} talking shit in private, not ${persona} on a broadcast. A roast that could be read aloud on daytime TV has FAILED this job — if you find yourself reaching for a polite word, use the rude one instead. NOTHING about these people is off-limits: their looks, their weight, their habits, their marriage, their city, their job, their whole personality are fair game, and no subject is too far. ONE rule, and it is the only one: no slurs — that is a rule about specific words, not about what you are allowed to go after. Everything else is open.`;
}

type Provider = "grok" | "claude";

// Which model writes the roast. Grok whenever there is a key for it, because
// that is the entire reason it was wired up; TRASH_TALK_PROVIDER=claude is the
// kill switch if xAI starts billing badly or the tone goes wrong. With no Grok
// key configured this returns "claude" and the feature behaves exactly as it
// did before — deploying this function without setting GROK_API_KEY changes
// nothing, which is what makes the rollout safe.
function trashTalkProvider(grokKey: string): Provider {
  const want = (Deno.env.get("TRASH_TALK_PROVIDER") ?? "grok").trim().toLowerCase();
  if (want === "claude" || want === "anthropic") return "claude";
  return grokKey ? "grok" : "claude";
}

interface ModelReply { ok: boolean; status: number; text: string; detail: string; }

// Retry the statuses that mean "try again", not the ones that mean "you asked
// wrong". A 400/401/403 retried three times is three times the latency for the
// same failure, and the roast is generated while someone watches a spinner.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
const RETRIES = 3;
// Configurable so the gate that exercises the retry paths doesn't have to sit
// through real backoffs — three retried calls at 1.5s/3s is ~13s of `verify`
// spent sleeping, and this gate set's whole promise is that it runs before
// every push without anyone minding.
const RETRY_BACKOFF_MS = Number(Deno.env.get("RETRY_BACKOFF_MS") ?? "1500");

// Status 0 means "no HTTP response at all" — a DNS failure, TLS error or
// connection reset, where fetch REJECTS rather than resolving with a status.
// That is the shape a real provider outage takes, and an exception thrown out
// of a caller skips the Claude fallback entirely and fails the whole request:
// the one scenario the fallback exists for would be the one it didn't cover.
// So transport errors are caught, retried like any other transient failure,
// and finally reported as an ordinary failed ModelReply.
const STATUS_TRANSPORT = 0;

// How long the roast may wait on Grok before giving up and letting Claude write
// it instead. Without this the only ceiling is the platform's, so a model
// having a slow day strands someone on a spinner with no way out — which is
// exactly how the 23-second roast happened.
//
// It is deliberately NOT applied to the Claude call: Claude is the fallback of
// last resort, and aborting it leaves nothing to return at all.
const GROK_TIMEOUT_MS = Number(Deno.env.get("GROK_TIMEOUT_MS") ?? "8000");

interface RawReply { ok: boolean; status: number; body: string; detail: string; }

// `timeoutMs` is a deadline for the WHOLE sequence — every attempt and every
// backoff between them — not a fresh budget per attempt.
//
// A per-attempt timer bounds one call and nothing else. Three slow-but-
// retryable responses (a 503 arriving at 7.9s, which is exactly what a provider
// under load returns) would each get their own full timer, and the backoffs sit
// outside those timers: ~28 seconds before the Claude fallback runs, from a
// bound advertised as 8. Aborting immediately on a timeout was never enough,
// because a 503 is not an abort.
//
// The body is read INSIDE the timer too. fetch resolves when the headers land,
// so clearing the timer there leaves `res.text()` unbounded — headers followed
// by a stalled or truncated body would hang past the deadline with the fallback
// still waiting. Reading to a string here is what lets the timer cover it, and
// the bodies involved are one short roast.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs = 0,
): Promise<RawReply> {
  let ok = false, status = STATUS_TRANSPORT, body = "", detail = "";
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;
  const left = () => deadline - Date.now();
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = attempt * RETRY_BACKOFF_MS;
      // The wait counts against the budget as well; sleeping past the deadline
      // to make a request that can no longer finish helps nobody.
      if (deadline && wait >= left()) {
        detail = detail || `deadline ${timeoutMs}ms reached before retry`;
        break;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    if (deadline && left() <= 0) {
      detail = detail || `timed out after ${timeoutMs}ms`;
      break;
    }
    const ctl = deadline ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), left()) : null;
    try {
      const res = await fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
      ok = res.ok;
      status = res.status;
      body = await res.text();
    } catch (e) {
      ok = false; status = STATUS_TRANSPORT; body = "";
      // A timeout is never retried: the deadline is spent by definition.
      if (ctl?.signal.aborted) {
        detail = `timed out after ${timeoutMs}ms`;
        break;
      }
      detail = `transport error: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (ok || !RETRYABLE.has(status)) break;
  }
  return { ok, status, body, detail };
}

// A response whose body isn't the JSON we expect must not throw: an exception
// escapes the caller and skips the Claude fallback entirely.
function parseJson(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ── Fight IQ write-up ───────────────────────────────────────────────────────
// A scouting report written around the Fight Lab's own numbers. The numbers
// are computed deterministically in the browser; the model's only job is the
// prose, in a voice picked at random so it doesn't read the same twice.
//
// "Never invent a number" is enforced, not just asked for: numbersInvented()
// rejects a write-up containing any figure that isn't in the facts it was
// given, and the handler retries once and then fails cleanly. A Fight IQ that
// makes up a record is the app stating something false about someone's picks.
export const IQ_TONES = [
  "a blunt old-school boxing trainer giving a fighter the honest truth",
  "a hyped-up hype man who thinks this picker is the greatest of all time, however the numbers look",
  "a dry nature-documentary narrator observing a strange creature in its habitat",
  "a sports-radio caller who has Opinions and one minute before the break",
  "a scout's cold, clinical report to a team's front office",
  "a friend roasting them in the group chat — affectionate, merciless",
];
export const IQ_DAILY_CAP = Number(Deno.env.get("IQ_DAILY_CAP") ?? "3");
const _iqUses = new Map<string, { day: string; n: number }>();
// Best-effort, per edge-function instance: the app also caps on the device,
// and the per-IP rate limit above still applies. It bounds spend, it isn't a
// ledger — a cold start resets it, which at worst allows a few extra.
export function iqCapReached(viewer: string, now = Date.now()): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  const u = _iqUses.get(viewer);
  if (!u || u.day !== day) { _iqUses.set(viewer, { day, n: 1 }); return false; }
  if (u.n >= IQ_DAILY_CAP) return true;
  u.n++;
  return false;
}
function iqFactsText(q: IqFacts): string {
  const lines = [
    `Player: ${q.player}`,
    `Picker type: ${q.archetype}${q.blurb ? ` — ${q.blurb}` : ""}`,
    `Record: ${q.record}${q.accuracy != null ? ` (${q.accuracy}%)` : ""}`,
    `Points: ${q.points}`,
  ];
  if (q.locks) lines.push(`Locks: ${q.locks}`);
  if (q.methodPct != null) lines.push(`Method calls correct: ${q.methodPct}%`);
  if (q.clv != null) lines.push(`Average line move after their pick: ${q.clv} points`);
  q.insights.forEach((t) => lines.push(`- ${t}`));
  (q.rivals ?? []).forEach((t) => lines.push(`- ${t}`));
  return lines.join("\n");
}
export function buildIqWriteup(q: IqFacts, tone: string): { system: string; user: string } {
  return {
    system: `You write short, funny scouting reports about one member of a group of friends who pick UFC fights together, in the voice of ${tone}.
FACTS ARE STRICT: use only the facts given. Never state a number, record, percentage or name that isn't in them — rephrase in words if you need to. Don't predict future results.
Write 3 to 5 sentences, under 90 words, plain text, no headings or lists. Address the player as "you".`,
    user: `Facts about ${q.player}'s picking:\n${iqFactsText(q)}\n\nWrite the scouting report.`,
  };
}
// Every figure in the write-up must appear in the facts. Small counting words
// ("two locks") are words, not digits, and pass; a bare 1–3 is allowed for
// ordinary phrasing ("round 1", "top 3").
export function numbersInvented(text: string, facts: string): string[] {
  const norm = (n: string) => String(Number(n.replace(/,/g, "")));
  const known = new Set((facts.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm));
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(norm)
    .filter((n) => !known.has(n) && !(Number(n) >= 1 && Number(n) <= 3 && Number.isInteger(Number(n))));
}

async function callAnthropic(
  apiKey: string,
  { system, user, maxTokens }: { system?: string; user: string; maxTokens: number },
): Promise<ModelReply> {
  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: [{ role: "user", content: user }],
  });
  const r = await fetchWithRetry(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: payload,
  });
  if (!r.ok) return { ok: false, status: r.status, text: "", detail: r.detail || r.body };
  const data = parseJson(r.body) as { content?: { text?: string }[] } | null;
  return { ok: true, status: r.status, text: data?.content?.[0]?.text ?? "", detail: "" };
}

// xAI's API is OpenAI-compatible: bearer auth, a messages array that carries the
// system prompt as its own role: "system" entry rather than a top-level field,
// and the answer at choices[0].message.content. Everything else — max_tokens,
// the retry policy, the shape this returns — matches callAnthropic so the
// handler can swap one for the other without caring which it got.
async function callGrok(
  apiKey: string,
  { system, user, maxTokens }: { system?: string; user: string; maxTokens: number },
): Promise<ModelReply> {
  const payload = JSON.stringify({
    model: GROK_MODEL,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
  });
  const r = await fetchWithRetry(GROK_API_URL, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: payload,
  }, GROK_TIMEOUT_MS);
  if (!r.ok) return { ok: false, status: r.status, text: "", detail: r.detail || r.body };
  const data = parseJson(r.body) as { choices?: { message?: { content?: string } }[] } | null;
  return { ok: true, status: r.status, text: data?.choices?.[0]?.message?.content ?? "", detail: "" };
}

// --- The roast's only HARD length bound ------------------------------------
//
// The prompt asks for under ~70 words and four sentences, but prompt text is a
// request, not a bound. That was tolerable while max_tokens was 120: ~480
// characters at the very worst, comfortably inside send-push's MAX_BODY of
// 1600. GROK_MAX_TOKENS raised the programmatic ceiling to 1000 to leave a
// reasoning model room to think, and 1000 tokens of actual prose is ~4000
// characters — well past MAX_BODY.
//
// The failure that opens up is a nasty one because it splits the two halves of
// the feature: ai-breakdown returns 200, the sender reads a roast on screen and
// taps send, and send-push rejects it with a 400 they can do nothing about. So
// the length gets enforced here, where the text is produced, rather than being
// left to the prompt.
//
// 900 is far above any compliant roast (70 words is ~420 characters) and far
// below MAX_BODY even once the signature is appended, so this never fires on a
// roast that followed its instructions — it only catches a runaway.
const ROAST_MAX_CHARS = Number(Deno.env.get("ROAST_MAX_CHARS") ?? "900");

// How long the first call may have taken and still leave room to spend a second
// one chasing the sender's angle. Set below GROK_TIMEOUT_MS so a first call that
// went the distance never buys a retry that would double it.
const ROAST_RETRY_BUDGET_MS = Number(Deno.env.get("ROAST_RETRY_BUDGET_MS") ?? "6000");

// Cutting a joke short is bad; sending nothing is worse. Prefer the last
// sentence end so a trimmed roast still reads as a finished line, and fall
// back to a word boundary with an ellipsis when there is no sentence to keep.
function clampRoast(text: string, max: number): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastEnd = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  if (lastEnd >= max / 2) return cut.slice(0, lastEnd + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
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

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  // GROK_API_KEY is the name used here; XAI_API_KEY is accepted too because
  // that is what xAI's own console calls it and it is the one people paste.
  const grokKey = Deno.env.get("GROK_API_KEY") ?? Deno.env.get("XAI_API_KEY") ?? "";

  const action = body.action ?? "breakdown";
  let prompt: string;
  let system: string | undefined;
  let maxTokens = 250;
  // Only the roast is eligible for Grok; everything else is analysis and stays
  // on Claude. Resolved before the key check below so a Grok-only deployment
  // isn't rejected for missing an Anthropic key it never uses.
  let provider: Provider = "claude";
  // Kept so the Grok→Claude fallback can re-send the same prompt minus the
  // gloves-off suffix. See unfilteredRule.
  let claudeSystem: string | undefined;
  let iqTone = "", iqFacts = "";
  if (action === "chat") {
    prompt = buildChatPrompt(body);
    maxTokens = 180;
  } else if (action === "parlay") {
    prompt = buildParlayPrompt(body);
    maxTokens = 300;
  } else if (action === "fight-iq") {
    const q = body.iq;
    if (!q || !q.player || !q.record || !Array.isArray(q.insights)) {
      return new Response(JSON.stringify({ error: "Missing Fight IQ facts" }), { status: 400, headers: CORS });
    }
    const viewer = (body.viewerId || clientIp(req)).trim();
    if (iqCapReached(viewer)) {
      return new Response(JSON.stringify({ error: "daily-cap", cap: IQ_DAILY_CAP }), { status: 429, headers: CORS });
    }
    iqTone = IQ_TONES[Math.floor(Math.random() * IQ_TONES.length)];
    const built = buildIqWriteup(q, iqTone);
    system = built.system;
    prompt = built.user;
    iqFacts = iqFactsText(q);
    maxTokens = 300;
  } else if (action === "trash-talk") {
    provider = trashTalkProvider(grokKey);
    const built = buildTrashTalk(body);
    claudeSystem = built.system;
    system = provider === "grok"
      ? built.system + unfilteredRule(body.persona || "A Famous Friend")
      : built.system;
    prompt = built.user;
    // The prompt caps roasts at ~70 words / four sentences. 250 tokens is ~2.5x
    // that budget, so the signature always lands even when the model runs a
    // little over. This is the Claude path's ceiling; Grok uses GROK_MAX_TOKENS.
    // Either way ROAST_MAX_CHARS is the hard bound that keeps a runaway inside
    // send-push's MAX_BODY.
    maxTokens = 250;
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

  // The active provider can change mid-request (Grok down → Claude), so the key
  // check runs against whichever one could actually be used.
  if (provider === "claude" && !apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured: missing API key" }), { status: 500, headers: CORS });
  }

  // One call, whichever model is live. On a Grok failure this falls back to
  // Claude rather than surfacing an error: the roast is generated while someone
  // watches a spinner on a live card, and a tamer burn beats no burn. The
  // fallback re-sends the SAME user turn with the gloves-off suffix stripped
  // from the system prompt — not a rebuilt prompt, which would re-roll the
  // random angle and form the first attempt already chose.
  //
  // A blank-but-successful reply counts as a failure here. It is the specific
  // way a reasoning model fails this request: on the OpenAI-shaped API the
  // token budget covers the model's internal reasoning as well as the text it
  // returns, so a reasoning model handed the roast's tight cap can spend the
  // whole budget thinking and return HTTP 200 with empty content. That used to
  // sail through as success and reach the client as "No trash talk generated."
  // — a silent dud with no error anywhere to explain it. See GROK_MAX_TOKENS.
  let fellBack = false;
  const callModel = async (userText: string): Promise<ModelReply> => {
    if (provider === "grok") {
      const r = await callGrok(grokKey, { system, user: userText, maxTokens: GROK_MAX_TOKENS });
      if ((r.ok && r.text.trim()) || !apiKey) return r;
      provider = "claude";
      fellBack = true;
      system = claudeSystem;
      const why = r.ok ? "returned an empty roast (token budget exhausted?)" : `failed (${r.status})`;
      console.error(`grok ${why}, falling back to claude: ${r.detail.slice(0, 200)}`);
    }
    return await callAnthropic(apiKey, { system, user: userText, maxTokens });
  };

  const startedAt = Date.now();
  const first = await callModel(prompt);

  if (!first.ok) {
    const overloaded = first.status === 529 || first.status === 503;
    return new Response(
      JSON.stringify({ error: overloaded ? "overloaded" : "Model API error", detail: first.detail }),
      { status: 502, headers: CORS }
    );
  }

  let text: string = first.text;
  if (action === "fight-iq") {
    let bad = numbersInvented(text, iqFacts);
    if (bad.length) {
      const again = await callModel(`${prompt}

Your last draft used figures that aren't in the facts (${bad.join(", ")}). Write it again using only the facts given — say it in words instead.`);
      if (again.ok) { text = again.text; bad = numbersInvented(text, iqFacts); }
    }
    if (!text.trim() || bad.length) {
      return new Response(JSON.stringify({ error: "Couldn't write it without making something up — try again." }), { status: 502, headers: CORS });
    }
    return new Response(JSON.stringify({ breakdown: text.trim(), tone: iqTone, model: MODEL }), { status: 200, headers: CORS });
  }
  // Which provider produced the text actually being returned — NOT simply the
  // last one called. `provider` and `fellBack` track the most recent call, and
  // the angle retry below can fail over to Claude and still have its output
  // rejected, leaving Grok's original text in hand under a "claude" label.
  // That mislabels exactly the fallback case this metadata exists to diagnose,
  // so the snapshot moves only when `text` itself is replaced.
  let textProvider: Provider = provider;
  let textFellBack = fellBack;
  // The angle is the one instruction worth spending a second call on: if the
  // roast walked away from it entirely, ask again with the miss named. Only one
  // retry, and whatever comes back is used either way — a roast without the
  // angle still beats no roast when the card is live.
  //
  // The retry is a SECOND full model call, so it doubles what the sender waits.
  // That was half of the 23-second roast. It is worth its cost when the first
  // call was quick and skipped when it wasn't: a roast that drops the typed
  // angle is a worse roast, but a roast that takes half a minute is a worse
  // feature, and the sender can always retype the angle and hit generate again.
  const trashHint = (body.hint ?? "").trim();
  const trashNames = [body.myNickname ?? "", ...(body.targets ?? [])];
  const timeLeftForRetry = Date.now() - startedAt < ROAST_RETRY_BUDGET_MS;
  if (action === "trash-talk" && text && trashHint && timeLeftForRetry && !usesAngle(text, trashHint, trashNames)) {
    const retry = await callModel(`${prompt}

Your last attempt was: "${text.trim()}"
It walked away from ${body.myNickname || "the sender"}'s angle entirely. Write it again and make "${trashHint}" what the roast is about — reword and escalate it however ${body.persona || "the persona"} would, but it has to be recognisably that angle. Same length cap, same signature.`);
    if (retry.ok && retry.text && usesAngle(retry.text, trashHint, trashNames)) {
      text = retry.text;
      textProvider = provider;
      textFellBack = fellBack;
    }
  }
  if (action === "trash-talk" && text) {
    // Clamp BEFORE the signature so the signature always survives the cut —
    // the client recovers the persona by parsing the trailing "— X".
    text = enforceSignature(clampRoast(text, ROAST_MAX_CHARS), body.persona || "A Famous Friend");
  }
  // `provider`/`model` are reported back so a roast that reads oddly tame can be
  // traced to a silent fallback instead of being debugged as a prompt problem.
  // The client reads only `breakdown`; these are extra fields, not a contract change.
  return new Response(
    JSON.stringify({
      breakdown: text,
      ...(action === "trash-talk"
        ? {
          provider: textProvider,
          model: textProvider === "grok" ? GROK_MODEL : MODEL,
          ...(textFellBack ? { fellBack: true } : {}),
        }
        : {}),
    }),
    { status: 200, headers: CORS }
  );
});
