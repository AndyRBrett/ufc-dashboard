// Frozen fixtures: historical context and the actual API/UI wire paths.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import { fighterHistory } from '../fightbot/core.mjs';

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
assert.match(fighterHistory(stats, 'Tai Tuivasa', 'Derrick Lewis').meeting, /found in completed UFC/);
assert.ok(fighterHistory(stats, 'Alex').error);

let handler, calls = [], responses = [];
const env = { ANTHROPIC_API_KEY: 'test', SB_ANON_KEY: 'anon', SUPABASE_URL: 'https://sb.test', SB_SERVICE_ROLE_KEY: 'service', RETRY_BACKOFF_MS: '1' };
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
  assert.ok(calls[0].tools.some(t=>t.type==='web_search_20250305'&&t.max_uses===1));
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
const browser=await chromium.launch();
try {
  const page=await browser.newPage();const sent=[];let releaseAnswer;
  await page.route(/supabase\.co/,async route=>{
    if(route.request().url().includes('/functions/v1/ai-breakdown')){
      const payload=JSON.parse(route.request().postData());sent.push(payload);
      if(payload.question==='Delayed advice')await new Promise(resolve=>releaseAnswer=resolve);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({breakdown:'No recorded meeting. Gautier is a middleweight.',sources:[{url:source.url,title:'Career records'},{url:'javascript:alert(1)',title:'bad'}]})});
    }
    return route.fulfill({status:200,contentType:'application/json',body:'[]'});
  });
  await page.addInitScript(()=>localStorage.setItem('ufc_whatsnew_seen','9999'));
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
