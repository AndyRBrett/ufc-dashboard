// Frozen fixtures: historical context and the actual API/UI wire paths.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { fighterHistory } from '../fightbot/core.mjs';
import { launchChromium } from "./lib/browser.mjs";

const html = readFileSync('index.html', 'utf8');
const stats = {
  'Ateba Gautier': { rec: '8-1', opp: ['Robert Valentin', 'Jose Medina'], url: 'http://ufcstats.com/fighter-details/fixture', fetched_at: '2026-09-01T00:00:00Z' },
  'Tai Tuivasa': { rec: '14-7', opp: ['Derrick Lewis', 'Ciryl Gane'], url: 'http://ufcstats.com/fighter-details/fixture2' },
  'Alex One': { rec: '2-1', opp: [] }, 'Alex Two': { rec: '3-1', opp: [] },
  'José Álvarez': { rec: '4-1', opp: ['Tai Tuivasa'] },
};
const helpers = html.split('// fight-history:start')[1].split('// fight-history:end')[0];
const ctx = { FIGHTER_STATS: stats };
vm.runInNewContext(helpers, ctx);
const question = 'Has Ateba ever fought tai tuivasa';
let context = ctx._aiFightContext(question);
assert.match(context, /Ateba Gautier:.*Robert Valentin/);
assert.match(context, /Tai Tuivasa:.*Derrick Lewis/);
assert.match(context, /cached as of 2026-09-01/);
assert.equal(ctx._aiFightContext('Has Alex fought Tai?').includes('Alex One'), false);
assert.match(ctx._aiFightContext('Jose Alvarez'), /José Álvarez/);
assert.match(ctx._aiFightContext('', ['Ateba Gautier']), /Ateba Gautier/);
assert.ok(ctx._aiFightContext('Ateba', [], { 'Ateba Gautier': { opp: Array(3000).fill('Long Name') } }).length <= 6000);
assert.match(ctx._aiFightContext('Alex One'), /history unavailable/);
assert.match(fighterHistory(stats, 'Ateba', 'Tai Tuivasa').meeting, /not found in cached UFC/);
// Per-bout results: "who has X lost to" is answerable from the cache.
const silva = { 'Natalia Silva': { rec: '20-5-1', opp: ['Rose Namajunas', 'Jasmine Jasudavicius'], res: ['W U-Dec R5 2025', 'L S-Dec R3 2022'] } };
const silvaCtx = ctx._aiFightContext('Who has Natalia Silva lost to in the ufc', [], silva);
assert.match(silvaCtx, /UFC losses per UFCStats, newest first: Jasmine Jasudavicius \(S-Dec R3 2022\)/);
assert.match(silvaCtx, /UFC wins over, newest first: Rose Namajunas \(U-Dec R5 2025\)/);
assert.equal(silvaCtx.match(/Rose Namajunas/g).length, 1, 'each bout listed once');
// Two long careers in one question: both fighters survive the size cap, losses
// stay whole, and a shortened win list says so instead of posing as complete.
const career = (who, n) => ({ rec: '26-17-0', url: 'http://ufcstats.com/fighter-details/' + who,
  opp: Array.from({ length: n }, (_, i) => `${who} Opponent Number ${i}`),
  res: Array.from({ length: n }, (_, i) => (i % 3 ? 'W U-Dec R3 ' : 'L KO/TKO R2 ') + (2025 - i)) });
const vets = { 'Jim Miller': career('Miller', 120), 'Neil Magny': career('Magny', 120) };
const vetCtx = ctx._aiFightContext('Has Jim Miller fought Neil Magny?', [], vets);
assert.ok(vetCtx.length <= 6000);
assert.match(vetCtx, /Jim Miller:/); assert.match(vetCtx, /Neil Magny:/);
assert.match(vetCtx, /Miller Opponent Number 117 \(KO\/TKO R2 1908\)/, 'every loss kept');
assert.match(vetCtx, /earlier UFC wins not listed/);
assert.match(silvaCtx, /career MMA record \(all promotions\) 20-5-1/);
assert.match(silvaCtx, /not UFC losses happened in other promotions/);
// A misaligned res is never zipped onto the wrong opponent.
assert.doesNotMatch(ctx._aiFightContext('Natalia Silva', [], { 'Natalia Silva': { opp: ['A B', 'C D'], res: ['W Dec'] } }), /UFC losses/);
assert.deepEqual(fighterHistory(silva, 'Natalia Silva').ufc_fights_newest_first[1], { opponent: 'Jasmine Jasudavicius', result: 'L S-Dec R3 2022' });
assert.match(fighterHistory(stats, 'Tai Tuivasa', 'Derrick Lewis').meeting, /found in completed UFC/);
assert.ok(fighterHistory(stats, 'Alex').error);

let handler, calls = [], responses = [];
const env = { RATE_LIMIT: '100', ANTHROPIC_API_KEY: 'test', SB_ANON_KEY: 'anon', SUPABASE_URL: 'https://sb.test', SB_SERVICE_ROLE_KEY: 'service', RETRY_BACKOFF_MS: '1' };
globalThis.Deno = { env: { get: k => env[k] }, serve: h => handler = h };
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'history-test' });
  if (String(url).includes('ai_quota_take')) return Response.json(true);
  calls.push(JSON.parse(init.body));
  const next = responses.shift() || { content: [{ type: 'text', text: 'No completed meeting is shown in these records.' }] };
  return Response.json(next.body || next, {status: next.status || 200});
};
const { code } = await transform(readFileSync('supabase/functions/ai-breakdown/index.ts','utf8'), { loader: 'ts', format: 'esm' });
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const ask = async body => {
  calls = [];
  const r = await handler(new Request('https://fn.test', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer signed-in', Origin:'https://andyrbrett.github.io' }, body:JSON.stringify(body) }));
  return { status:r.status, json:await r.json() };
};
const source = { type:'web_search_result_location', url:'https://www.ufc.com/athlete/ateba-gautier', title:'Ateba Gautier', cited_text:'Ateba Gautier fights at middleweight, 185 pounds.' };
const reply = () => ({ content:[
  {type:'text',text:'Let me check the records.'},
  {type:'server_tool_use',id:'search1',name:'web_search',input:{query:'Ateba Gautier Tai Tuivasa fight history'}},
  {type:'web_search_tool_result',tool_use_id:'search1',content:[]},
  {type:'text',text:'No recorded meeting is listed. Gautier fights at 185 pounds.',citations:[source]},
  {type:'text',text:'Their career records show different opponents.',citations:[source]},
] });
for (const action of ['chat','guide','breakdown']) {
  responses = [reply()];
  const r = await ask({ action, question, fightContext:context, card:'Fixture card', f1:{n:'Ateba Gautier',rec:'8-1'}, f2:{n:'Robert Valentin',rec:'10-3'} });
  assert.equal(r.status,200,JSON.stringify(r.json));
  assert.ok(calls[0].tools.some(t=>t.type==='web_search_20250305'&&t.max_uses===3));
  assert.equal(calls[0].model,'claude-sonnet-5-5');
  assert.match(calls[0].system,/MUST use web_search/);
  assert.match(calls[0].system,/never tell the user to look it up elsewhere/);
  assert.match(calls[0].messages[0].content,/completed UFCStats opponents/);
  assert.match(calls[0].system,/absent opponent.*not proof/);
  if(action==='chat') assert.ok(calls[0].system.includes(mod.APP_GUIDE));
  assert.doesNotMatch(r.json.breakdown,/Let me check/);
  assert.match(r.json.breakdown,/185 pounds/);
  assert.equal(r.json.sources.length,1);
  assert.equal(r.json.sources[0].url,source.url);
}
// The screenshot's exact request must reach recommendation instructions at
// system priority, alongside card context and the user's saved selections.
for (const action of ['chat', 'guide']) {
  const recommendation = 'My pick is Ateba Gautier by KO/TKO, with moderate confidence based on the supplied striking data. I would change your Valentin pick; this is a prediction, not a guarantee.';
  responses = [{content:[{type:'text',text:recommendation}]}];
  const r = await ask({action, question:'What should my picks be for the main event of this card',
    event:'Fixture card', card:'[Main Event] Ateba Gautier (8-1, odds -150) vs Robert Valentin (10-3, odds +130) · Middleweight\n  Ateba Gautier: 4 strikes landed/min',
    userPicks:'You picked: Robert Valentin by Dec'});
  assert.equal(r.status,200); assert.equal(r.json.breakdown,recommendation);
  assert.ok(calls[0].system.includes(mod.PICK_RECOMMENDATION_RULES));
  assert.match(calls[0].system,/recommend a fighter directly/);
  assert.match(calls[0].system,/Predictions are allowed/);
  assert.match(calls[0].system,/never claim you saved, changed or locked a pick/);
  assert.match(calls[0].system,/Answer the question asked, then stop/);
  assert.match(calls[0].system,/lead with the direct answer/);
  assert.doesNotMatch(calls[0].system,/never invent a button, score, pick or rule/);
  assert.match(calls[0].messages[0].content,/\[Main Event\]/);
  assert.match(calls[0].messages[0].content,/You picked: Robert Valentin by Dec/);
  assert.ok(calls[0].max_tokens>=400 && calls[0].max_tokens<=1200);
}
for (const message of ['Web search is not enabled for your organization.', 'Model does not support web search.', "tools.0.type: web_search_20250305 is an invalid tool type."]) {
  responses=[{status:400,body:{error:{type:'invalid_request_error',message}}},{content:[{type:'text',text:'No meeting appears in the cached UFC history; I cannot verify other promotions right now.'}]}];
  const r=await ask({action:'chat',question,fightContext:context});
  assert.equal(r.status,200);assert.equal(calls.length,2);
  assert.equal(calls[1].tools,undefined);assert.equal(calls[1].max_tokens,400);
  assert.match(calls[1].system,/Web search is unavailable/);
}
responses=[{status:400,body:{error:{message:'Web search is not enabled'}}},{content:[{type:'text',text:'An armbar attacks the elbow by controlling and extending the arm.'}]}];
assert.equal((await ask({action:'guide',question:'What is an armbar?'})).status,200);
assert.match(calls[1].system,/still explain established MMA/);
// The screenshot: a paid research call that answered "the data doesn't say,
// see UFCStats" without searching is re-run once with the search demanded.
const punt = 'According to the cached UFCStats data, Natalia Silva\'s completed UFC opponents include Rose Namajunas. Her record is 20-5-1, so she has five losses, but the app data doesn\'t specify which opponents she lost to. You can view her full fight history with loss details on UFCStats.';
assert.ok(mod.puntsInsteadOfAnswering(punt));
for (const ok of ['Natalia Silva has one UFC loss, a split decision to Jasmine Jasudavicius in 2022.', 'Gautier fights at 185 pounds.', 'A rear-naked choke compresses the neck.'])
  assert.equal(mod.puntsInsteadOfAnswering(ok), false, ok);
responses=[{content:[{type:'text',text:punt}]}, reply()];
{ const r=await ask({action:'guide',question:'Who has Natalia Silva lost to in the ufc',fightContext:context});
  assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(calls.length,2);
  assert.ok(calls[1].tools);assert.ok(calls[1].messages[0].content.includes(mod.FORCE_RESEARCH_NOTE));
  assert.match(r.json.breakdown,/185 pounds/);assert.equal(r.json.sources.length,1); }
// A punt AFTER searching isn't retried (it already looked), nor is a real answer.
responses=[{content:[{type:'server_tool_use',id:'s',name:'web_search',input:{query:'q'}},{type:'web_search_tool_result',tool_use_id:'s',content:[]},{type:'text',text:'I could not verify which promotion that loss came from.'}]}];
await ask({action:'guide',question:'Who has Natalia Silva lost to',fightContext:context});
assert.equal(calls.length,1);
// A failed forced retry keeps the first answer rather than erroring.
responses=[{content:[{type:'text',text:'I cannot verify that from the app data.'}]},{status:400,body:{error:{message:'Invalid request'}}}];
{ const r=await ask({action:'guide',question:'Who has Natalia Silva lost to',fightContext:context});
  assert.equal(r.status,200);assert.match(r.json.breakdown,/cannot verify/); }
// The research model thinks, so its ceiling leaves room beyond the answer.
responses=[reply()];
await ask({action:'guide',question,fightContext:context});
assert.ok(calls[0].max_tokens>=8000);assert.equal(calls[0].output_config.effort,'medium');
// An unknown RESEARCH_MODEL falls back to MODEL, still with search.
responses=[{status:404,body:{error:{type:'not_found_error',message:'model: claude-sonnet-5-5'}}},reply()];
{ const r=await ask({action:'guide',question,fightContext:context});
  assert.equal(r.status,200);assert.equal(calls.length,2);
  assert.equal(calls[1].model,'claude-haiku-4-5-20251001');assert.ok(calls[1].tools); }
assert.equal(mod.researchModelUnavailable(400,JSON.stringify({error:{message:'Web search is not enabled'}})),false);
responses=[{content:[{type:'text',text:'Tap Ranks.'}]}];
await ask({action:'guide',question:'How do locks work?'});
assert.equal(calls[0].model,'claude-haiku-4-5-20251001');
responses=[{status:400,body:{error:{message:'Invalid max_tokens value'}}}];
assert.equal((await ask({action:'chat',question})).status,502);assert.equal(calls.length,1);
responses=[{status:400,body:{error:{message:'Web search is not enabled'}}},{status:400,body:{error:{message:'Web search is not enabled'}}}];
assert.equal((await ask({action:'chat',question})).status,502);assert.equal(calls.length,2);
assert.equal(mod.webSearchUnavailable(401,'Web search is not enabled'),false);
responses=[{content:[{type:'text',text:'Tap Ranks.'}]}];
await ask({action:'guide',question:'How do locks work?'});
assert.equal(calls[0].tools,undefined);
assert.equal(mod.fightResearchEnabled({action:'trash-talk',question}),false);
assert.equal(mod.fightResearchEnabled({action:'fight-iq',question}),false);
assert.equal(mod.fightResearchEnabled({action:'verdict',question}),false);
for (const q of ['Explain a rear-naked choke', 'Who is the current ONE flyweight champion?', 'What happened at PRIDE 33?', 'Who is the best Japanese prospect?', 'What is the latest news from Bellator?', 'How are rounds judged in MMA?', 'How does scoring work in ONE?', 'Who won FOTN last night?']) {
  assert.equal(mod.fightResearchEnabled({action:'guide',question:q}),true,q);
}
for (const q of ['How do locks work?', 'How do I join a room?', 'How does scoring work in the app?', 'Where are my picks?', 'How do I choose a Bonus Pick in the app?']) {
  assert.equal(mod.fightResearchEnabled({action:'guide',question:q}),false,q);
}
responses=[{content:[{type:'text',text:'A rear-naked choke compresses the neck with an arm around it, using the other arm to secure the grip.'}]}];
const general=await ask({action:'guide',question:'Explain a rear-naked choke'});
assert.equal(general.status,200);assert.ok(calls[0].tools);
assert.match(calls[0].system,/general MMA assistant/);
assert.match(calls[0].system,/selected card.*never limits/);
assert.match(calls[0].system,/Never use external search to invent app/);

responses=[{stop_reason:'pause_turn',content:[{type:'server_tool_use',id:'s1',name:'web_search',input:{query:'records'}}]},reply()];
assert.equal((await ask({action:'chat',question})).status,200);
assert.equal(calls.length,2);
assert.equal(calls[1].messages[1].role,'assistant');
responses=Array(2).fill({stop_reason:'pause_turn',content:[]});
assert.equal((await ask({action:'chat',question})).status,502);
assert.equal(calls.length,2);
responses=[{stop_reason:'max_tokens',content:[{type:'text',text:'Let me check'}]}];
assert.equal((await ask({action:'chat',question})).status,502);
assert.equal((await ask({action:'chat',question,fightContext:'x'.repeat(6001)})).status,400);
assert.equal(calls.length,0);
assert.equal((await ask({action:'chat',question,fightContext:{}})).status,400);
assert.equal(mod.guideStrays('Gautier has 77 wins.',{fightContext:context},context).includes('77'),true);
assert.equal(mod.numbersMisattributed('Gautier weighs 265 pounds.', {fightContext:context}, 'Tai Tuivasa: heavyweight, 265 pounds.').includes('265'),true);
assert.equal(mod.numbersMisattributed('Gautier weighs 185 pounds.', {fightContext:context}, 'Ateba Gautier: middleweight, 185 pounds.').length,0);

// Card context supplies the event outside the card text; event numbers
// must be accepted, including in a sentence naming one of its fighters.
const pickRequest={action:'guide',event:'UFC 332: Silva vs. Wang',card:'[Main Event] Natalia Silva (20-5-1, odds -208) vs Wang Cong (10-1-0, odds +168) · Flyweight',question:'Who should I pick for this fight?'};
assert.deepEqual(mod.guideStrays('For UFC 332, I lean Natalia Silva by decision.',pickRequest,mod.guideFactsText(pickRequest)),[]);
assert.ok(mod.guideStrays('Natalia Silva has 332 wins.',pickRequest,mod.guideFactsText(pickRequest)).includes('332'));
assert.ok(mod.guideStrays('At UFC 332, Natalia Silva has 332 wins.',pickRequest,mod.guideFactsText(pickRequest)).includes('332'));
assert.ok(mod.guideStrays('For UFC 333, I lean Natalia Silva.',pickRequest,mod.guideFactsText(pickRequest)).includes('333'));
assert.deepEqual(mod.guideStrays('For ufc   332, I lean Natalia Silva.',pickRequest,mod.guideFactsText(pickRequest)),[]);
responses=[{content:[{type:'text',text:'For UFC 332, I lean Natalia Silva by decision, with moderate confidence.'}]}];
let pickResponse=await ask(pickRequest);assert.equal(pickResponse.status,200);assert.equal(calls.length,1);
// A real invented statistic still fails and gets one qualitative repair.
responses=[{content:[{type:'text',text:'Natalia Silva has 777 wins.'}]},{content:[{type:'text',text:'- Natalia Silva by decision: moderate confidence based on the supplied matchup.'}]}];
pickResponse=await ask(pickRequest);assert.equal(pickResponse.status,200);assert.equal(calls.length,2);
assert.match(calls[1].messages[0].content,/using NO numeric claims/);
assert.match(calls[1].messages[0].content,/Do not refuse or redirect/);
responses=Array(2).fill({content:[{type:'text',text:'Natalia Silva has 777 wins.'}]});
pickResponse=await ask(pickRequest);assert.equal(pickResponse.status,502);assert.equal(pickResponse.json.code,'unverified-answer');

// The first successful live answer contradicted these supplied facts.
const qualityRequest={action:'guide',event:'Fixture card',question:'Give me your pick recommendations',card:
 '[Main Card] Roberto Soldic (21-4-0, odds -220) vs Khaos Williams (16-5-0, odds +179) · Welterweight\n'+
 '[Main Card] Ateba Gautier (11-1-0) vs Roman Kopylov (15-5-0) · Middleweight\n'+
 '  Roman Kopylov: last fights W Dec vs Marco Tulio, L Dec vs Gregory Rodrigues, L Dec, W TKO\n'+
 '[Main Card] King Green (36-17-1) vs Esteban Ribovics (16-3-0) · Lightweight\n'+
 '  Esteban Ribovics: last fights W TKO vs Edson Barboza, L Sub vs Mateusz Gamrot, W Dec, L Dec'};
const wrong='Soldic is the favourite with a perfect record. Kopylov has lost his last two fights. Ribovics just lost by submission.';
assert.equal(mod.recommendationContradictions(wrong,qualityRequest).length,3);
for(const phrase of ['Kopylov has lost his last two.','Kopylov has lost his last two and does not wrestle.','Kopylov won his last two, so pick him.']) assert.equal(mod.recommendationContradictions(phrase,qualityRequest).length,1,phrase);
assert.deepEqual(mod.recommendationContradictions('Kopylov lost his last two rounds.',qualityRequest),[]);
for(const phrase of ['Kopylov lost the last two—rounds two and three—but won the fight.','Kopylov lost the last two, rounds two and three, but won the fight.']) assert.deepEqual(mod.recommendationContradictions(phrase,qualityRequest),[],phrase);
for(const question of ['Best underdog value?','Parlay suggestions?','Give me your predictions','Who should I fade?']){
 assert.equal(mod.recommendationContradictions(wrong,{...qualityRequest,question}).length,3,question);
}
for(const phrase of ['Kopylov lost his latest fight.','Kopylov lost his last fight.','Kopylov lost his most recent bout.']) assert.equal(mod.recommendationContradictions(phrase,qualityRequest).length,1);
assert.deepEqual(mod.recommendationContradictions('Kopylov won his latest fight.',qualityRequest),[]);
const sharedSurnames={...qualityRequest,card:'[Main Card] Bruno Silva (23-9-0) vs Other Fighter (12-1-0) · Middleweight\n  Bruno Silva: last fights L Dec, L Sub\n[Main Event] Natalia Silva (20-5-1) vs Wang Cong (10-1-0) · Flyweight\n  Natalia Silva: last fights W Dec, W Dec'};
assert.equal(mod.recommendationContradictions('Natalia Silva recently lost.',sharedSurnames).length,1);
assert.deepEqual(mod.recommendationContradictions('Bruno Silva recently lost. Natalia Silva recently won.',sharedSurnames),[]);
assert.deepEqual(mod.recommendationContradictions('Silva recently lost.',sharedSurnames),[]);
assert.deepEqual(mod.recommendationContradictions('Soldic by decision, lower confidence without his stats. Kopylov won his latest fight. Ribovics lost to Gamrot before his latest win.',qualityRequest),[]);
assert.deepEqual(mod.recommendationContradictions('Gautier to win by knockout. Kopylov to lose.',qualityRequest),[]);
assert.deepEqual(mod.recommendationContradictions('Kopylov has lost his last two fights.',{...qualityRequest,question:'What happened at an older event?'}),[]);
responses=[{content:[{type:'text',text:wrong}]},{content:[{type:'text',text:'Soldic by decision, lower confidence without his stats. Gautier by knockout, moderate confidence; Kopylov won his latest bout.'}]}];
const qualityAnswer=await ask(qualityRequest);assert.equal(qualityAnswer.status,200);assert.equal(calls.length,2);assert.doesNotMatch(qualityAnswer.json.breakdown,/perfect record|lost his last two/);
assert.match(calls[1].messages[0].content,/Correct each listed issue/);

// Main-card recommendations let the model select; factual explanations are
// rendered from the card rather than accepting invented model prose.
const mainRequest={...qualityRequest,question:'What picks do you recommend for the main card'};
const selection=JSON.stringify({picks:[{fighter:'Roberto Soldic',method:'KO/TKO',confidence:'high'},{fighter:'Ateba Gautier',method:'decision',confidence:'moderate'},{fighter:'King Green',method:'decision',confidence:'moderate'}]});
const bouts=mod.mainCardSelections(mainRequest);
assert.equal(bouts.length,3);
assert.equal(mod.mainCardSelections({...mainRequest,question:'What were my previous main-card picks?'}).length,0);
for(const question of ['Which main-card picks won?','Which of my main-card picks lost?','Were my main-card picks correct?','Who were the main-card winners?']) assert.equal(mod.mainCardSelections({...mainRequest,question}).length,0,question);
assert.equal(mod.mainCardSelections({...mainRequest,question:'Recommend my main-card picks'}).length,3);
const grounded=mod.renderMainCardSelections(selection,bouts);
assert.match(grounded,/- Roberto Soldic by KO\/TKO \(low, limited data\)/);
assert.match(grounded,/- Ateba Gautier by decision \(/);
// One short line per bout: the reasons are for a follow-up "why?".
assert.doesNotMatch(grounded,/Cached career record|Listed American odds|Latest cached results|21-4-0/);
assert.equal(grounded.split('\n').length,bouts.length+2);
assert.ok(grounded.length<=60*bouts.length+120,grounded);
assert.match(grounded,/Ask why/);
// "…and explain why" gets one short grounded clause per pick, from the card.
assert.ok(mod.asksWhy('Recommend my main-card picks and explain why'));
assert.equal(mod.asksWhy('Recommend my main-card picks'),false);
const explained=mod.renderMainCardSelections(selection,bouts,true);
assert.match(explained,/- Roberto Soldic by KO\/TKO \(low, limited data\): record 21-4-0/);
assert.match(explained,/no recent fight data/);
assert.doesNotMatch(explained,/Ask why|Cached career record/);
assert.equal(explained.split('\n').length,bouts.length+2);
assert.doesNotMatch(grounded,/perfect record|four straight|better striking accuracy/);
assert.equal(mod.renderMainCardSelections(selection.replace('Roberto Soldic','Unknown Fighter'),bouts),null);
assert.equal(mod.renderMainCardSelections(JSON.stringify({picks:[]}),bouts),null);
assert.equal(mod.renderMainCardSelections(selection.replace('"confidence":"high"','"confidence":"high","reason":"perfect record"'),bouts),null);
responses=[{content:[{type:'text',text:selection}]}];
assert.equal((await ask({...mainRequest,question:'Recommend my main-card picks and explain why'})).json.breakdown,explained);
for(const action of ['guide','chat']) {
 responses=[{content:[{type:'text',text:selection}]}];
 const result=await ask({...mainRequest,action});assert.equal(result.status,200);assert.equal(result.json.breakdown,grounded);assert.equal(calls.length,1);
 assert.equal(calls[0].tools,undefined);assert.match(calls[0].system,/JSON object/);
}
responses=[{content:[{type:'text',text:'Soldic has a perfect record.'}]},{content:[{type:'text',text:selection}]}];
assert.equal((await ask(mainRequest)).status,200);assert.equal(calls.length,2);
responses=Array(2).fill({content:[{type:'text',text:'Soldic has a perfect record.'}]});
assert.equal((await ask(mainRequest)).status,502);

if (process.argv.includes('--no-browser')) {
  console.log('check-ai-history: context, search, citation parsing, bounds and failures pass.');
  process.exit(0);
}

// Browser: all three entry points send context and show safe source links.
const originalFetch = globalThis.fetch;
const server=http.createServer((req,res)=>{
  try { const path=new URL(req.url,'http://test').pathname;res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':'text/html');res.end(readFileSync('.'+(path==='/'?'/index.html':path))); }
  catch {res.statusCode=404;res.end('');}
});
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
const browser=await launchChromium(chromium);
try {
  const page=await browser.newPage();const sent=[];let releaseAnswer;
  await page.route(/supabase\.co/,async route=>{
    if(route.request().url().includes('/functions/v1/ai-breakdown')){
      const payload=JSON.parse(route.request().postData());sent.push(payload);
      if(payload.question==='Delayed advice')await new Promise(resolve=>releaseAnswer=resolve);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({breakdown:'No recorded meeting. Gautier is a middleweight.',sources:[{url:source.url,title:'Career records'},{url:'javascript:alert(1)',title:'bad'}]})});
    }
    // An empty picks table is the app's admin-wipe signal (reconcileMyPicks),
    // which clears local picks: answering '[]' there raced the userPicks checks.
    if(/\/rest\/v1\/picks\?select=user_id&limit=1/.test(route.request().url()))
      return route.fulfill({status:200,contentType:'application/json',body:'[{"user_id":"someone"}]'});
    return route.fulfill({status:200,contentType:'application/json',body:'[]'});
  });
  await page.addInitScript(()=>{localStorage.setItem('ufc_whatsnew_seen','9999');localStorage.setItem('ufc_ai_consent','1');});
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.evaluate(fixture=>{ FIGHTER_STATS=fixture;_authReady=Promise.resolve();_ensureFreshToken=()=>Promise.resolve();_authBearer=()=> 'Bearer test'; },stats);
  const ev={name:'Fixture card',date:'2026-10-02',fights:[{lbl:'Main Event',f1:{n:'Ateba Gautier',r:'8-1',s:{slpm:4,acc:52,td:1,tdd:75,ko:5,sub:2,form:[{r:'W',m:'KO'}]}},f2:{n:'Robert Valentin',r:'10-3'},odds:{f1:-150,f2:130},wc:'Middleweight'}]};
  const bounded=await page.evaluate(ev=>_buildCardSummary({fights:Array.from({length:30},(_,i)=>({...ev.fights[0],lbl:i===0?'Main Event':'Prelim'}))}),ev);
  assert.ok(bounded.length<=3900);assert.match(bounded,/\[Main Event\]/);
  await page.evaluate(ev=>openPickChat(ev,0),ev);
  await page.fill('#botInput',question);await page.click('#botSendBtn');
  await page.waitForFunction(()=>!_botBusy);
  assert.match(sent[0].card,/\[Main Event\] Ateba Gautier \(8-1, odds -150\)/);
  assert.match(sent[0].card,/4 strikes landed\/min \(52% acc\)/);
  assert.match(sent[0].card,/last fights W KO/);
  assert.match(sent[0].fightContext,/Ateba Gautier/);assert.match(sent[0].fightContext,/Tai Tuivasa/);
  assert.equal(await page.locator('#botHistory a').count(),1);
  await page.fill('#botInput','And who has he beaten?');await page.click('#botSendBtn');await page.waitForFunction(()=>!_botBusy);
  assert.equal(sent[1].history[0].text,question);assert.match(sent[1].fightContext,/Ateba Gautier/);
  await page.evaluate(()=>{closeBot();openBot('Home');});
  await page.fill('#botInput',question);await page.click('#botSendBtn');await page.waitForFunction(()=>!_botBusy);
  assert.match(sent[2].fightContext,/Tai Tuivasa/);assert.equal(await page.locator('#botHistory a').count(),3);
  assert.equal(sent[0].action,'guide');assert.equal(sent[2].action,'guide');
  assert.equal(sent[2].event,ev.name);assert.equal(sent[2].history.length,4);
  assert.equal(await page.locator('#chatModal').count(),0);
  assert.match(await page.locator('#botTitle').textContent(),/Ask FightBot.*Fixture card/);
  await page.evaluate(ev=>{closeBot();var btn=document.createElement('button'),p=document.createElement('div');p.id='historyBreakdown';document.body.appendChild(p);fetchAIBreakdown(ev.fights[0],ev,btn,p);},ev);
  await page.waitForFunction(()=>document.querySelector('#historyBreakdown a'));
  assert.match(sent[3].fightContext,/Robert Valentin/);
  assert.equal(await page.locator('#historyBreakdown a').count(),1);
  // A new card changes the current context but preserves the conversation.
  const next={...ev,name:'Another fixture card',date:'2026-10-09'};
  await page.evaluate(ev=>{preds[ev.date+'|'+ev.fights[0].f1.n+'|'+ev.fights[0].f2.n]=ev.fights[0].f2.n;openPickChat(ev,1);},next);
  await page.fill('#botInput','Delayed advice');await page.click('#botSendBtn');
  for(let i=0;!releaseAnswer&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(releaseAnswer,'request reached the mocked backend');
  const pending=sent.at(-1);
  assert.equal(pending.event,next.name);assert.match(pending.userPicks,/Robert Valentin/);
  assert.equal(pending.history.length,6);
  await page.evaluate(()=>{closeBot();openBot('Home');});
  assert.equal(await page.locator('#botHistory .loading').count(),1);
  assert.equal(await page.locator('#botSendBtn').isDisabled(),true);
  releaseAnswer();await page.waitForFunction(()=>!_botBusy);
  assert.equal(await page.locator('#botHistory .loading').count(),0);
  assert.equal(await page.locator('#botHistory a').count(),4);
  assert.match(await page.locator('#botTitle').textContent(),/Another fixture card/);
  // The first PR review caught a card switch during an in-flight answer.
  releaseAnswer=null;
  await page.fill('#botInput','Delayed advice');await page.click('#botSendBtn');
  for(let i=0;!releaseAnswer&&i<100;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(releaseAnswer);
  await page.evaluate(ev=>{closeBot();openPickChat(ev,0);},ev);
  assert.match(await page.locator('#botTitle').textContent(),/Fixture card/);
  assert.equal(await page.locator('#botHistory .loading').count(),0);
  assert.equal(await page.locator('#botSendBtn').isDisabled(),false);
  // Start a new request before releasing the old response. Its completion
  // must not add a stale answer or unlock/overwrite the new conversation.
  await page.fill('#botInput','Who should I pick?');await page.click('#botSendBtn');
  releaseAnswer();await page.waitForFunction(()=>!_botBusy);
  assert.equal(sent.at(-1).event,ev.name);
  assert.equal(await page.locator('#botHistory a').count(),5);
  assert.equal(await page.evaluate(()=>_botHist.length),10);


} finally {await browser.close();await new Promise(ok=>server.close(ok));globalThis.fetch=originalFetch;}
console.log('check-ai-history: cached context, historical search, citations, bounds, failures and all three UI paths pass.');
