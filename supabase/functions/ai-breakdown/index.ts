import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json",
};

interface Fighter { n: string; rec: string; rk: string; }
interface Stats { slpm: number; acc: number; td: number; tdd: number; ko: number; sub: number; stn: string; }
interface FormEntry { r: string; m: string; }
interface ReqBody {
  f1: Fighter; f2: Fighter;
  wc: string; title: boolean; event: string;
  odds?: { f1: number; f2: number };
  s1?: Stats; s2?: Stats;
  form1?: FormEntry[]; form2?: FormEntry[];
}

function buildPrompt(d: ReqBody): string {
  const fmtOdds = (n: number) => n > 0 ? `+${n}` : `${n}`;
  const fmtForm = (form: FormEntry[]) =>
    (form ?? []).slice(0, 3).map(f => `${f.r}(${f.m})`).join(", ") || "N/A";
  const rk = (r: string) => r === "C" ? "Champion" : r ? `#${r} ranked` : "unranked";

  const statsBlock = d.s1 && d.s2 ? `
Stats: ${d.f1.n}: ${d.s1.slpm} str/min, ${d.s1.acc}% acc, ${d.s1.td} TD/15min, ${d.s1.tdd}% TDD, ${d.s1.ko} KO wins, ${d.s1.sub} sub wins, ${d.s1.stn}
Stats: ${d.f2.n}: ${d.s2.slpm} str/min, ${d.s2.acc}% acc, ${d.s2.td} TD/15min, ${d.s2.tdd}% TDD, ${d.s2.ko} KO wins, ${d.s2.sub} sub wins, ${d.s2.stn}` : "";

  return `You are a concise UFC analyst writing for fans. Give a technical breakdown of this fight in exactly 3-4 sentences. Focus on: the key stylistic matchup, who has the statistical edge and where, and the most likely path to victory for each. End with one sentence naming your predicted winner and method. Be specific and punchy — no filler, no "It will be exciting", no hedging.

FIGHT: ${d.f1.n} (${d.f1.rec}, ${rk(d.f1.rk)}) vs ${d.f2.n} (${d.f2.rec}, ${rk(d.f2.rk)})
EVENT: ${d.event}${d.title ? " — TITLE FIGHT" : ""}  |  WEIGHT CLASS: ${d.wc}
${d.odds ? `ODDS: ${d.f1.n} ${fmtOdds(d.odds.f1)} / ${d.f2.n} ${fmtOdds(d.odds.f2)}` : ""}
${d.f1.n} recent form: ${fmtForm(d.form1 ?? [])}
${d.f2.n} recent form: ${fmtForm(d.form2 ?? [])}${statsBlock}

Respond with only the analysis — no headers, no bullet points.`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  // Validate caller via Supabase anon key
  const ANON_KEY = Deno.env.get("SB_ANON_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  if (ANON_KEY && auth !== `Bearer ${ANON_KEY}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: CORS_HEADERS });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server misconfigured: missing API key" }), { status: 500, headers: CORS_HEADERS });
  }

  const claudeRes = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 250,
      messages: [{ role: "user", content: buildPrompt(body) }],
    }),
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.text();
    return new Response(JSON.stringify({ error: "Claude API error", detail: err }), { status: 502, headers: CORS_HEADERS });
  }

  const data = await claudeRes.json();
  const text: string = data?.content?.[0]?.text ?? "";
  return new Response(JSON.stringify({ breakdown: text }), { status: 200, headers: CORS_HEADERS });
});
