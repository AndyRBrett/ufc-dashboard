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
  assert.doesNotMatch(r.json.breakdown,/Let me check/);
  assert.match(r.json.breakdown,/185 pounds/);
  assert.equal(r.json.sources.length,1);
  assert.equal(r.json.sources[0].url,source.url);
}
for (const message of ['Web search is not enabled for your organization.', 'Model does not support web search.', "tools.0.type: web_search_20250305 is an invalid tool type."]) {
  responses=[{status:400,body:{error:{type:'invalid_request_error',message}}},{content:[{type:'text',text:'No meeting appears in the cached UFC history; I cannot verify other promotions right now.'}]}];
  const r=await ask({action:'chat',question,fightContext:context});
  assert.equal(r.status,200);assert.equal(calls.length,2);
  assert.equal(calls[1].tools,undefined);assert.equal(calls[1].max_tokens,180);
  assert.match(calls[1].system,/Web search is unavailable/);
}
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
  const page=await browser.newPage();const sent=[];
  await page.route(/supabase\.co/,route=>{
    if(route.request().url().includes('/functions/v1/ai-breakdown')){
      sent.push(JSON.parse(route.request().postData()));
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({breakdown:'No recorded meeting. Gautier is a middleweight.',sources:[{url:source.url,title:'Career records'},{url:'javascript:alert(1)',title:'bad'}]})});
    }
    return route.fulfill({status:200,contentType:'application/json',body:'[]'});
  });
  await page.addInitScript(()=>localStorage.setItem('ufc_whatsnew_seen','9999'));
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.evaluate(fixture=>{ FIGHTER_STATS=fixture;_authReady=Promise.resolve();_ensureFreshToken=()=>Promise.resolve();_authBearer=()=> 'Bearer test'; },stats);
  const ev={name:'Fixture card',date:'2026-10-02',fights:[{lbl:'Main Event',f1:{n:'Ateba Gautier',r:'8-1'},f2:{n:'Robert Valentin',r:'10-3'},wc:'Middleweight'}]};
  await page.evaluate(ev=>openPickChat(ev,0),ev);
  await page.fill('#chatInput',question);await page.click('#chatSendBtn');
  await page.waitForFunction(()=>!_chatBusy);
  assert.match(sent[0].fightContext,/Ateba Gautier/);assert.match(sent[0].fightContext,/Tai Tuivasa/);
  assert.equal(await page.locator('#chatHistory a').count(),1);
  await page.fill('#chatInput','And who has he beaten?');await page.click('#chatSendBtn');await page.waitForFunction(()=>!_chatBusy);
  assert.equal(sent[1].history[0].text,question);assert.match(sent[1].fightContext,/Ateba Gautier/);
  await page.evaluate(()=>{closeChat();openBot('Home');});
  await page.fill('#botInput',question);await page.click('#botSendBtn');await page.waitForFunction(()=>!_botBusy);
  assert.match(sent[2].fightContext,/Tai Tuivasa/);assert.equal(await page.locator('#botHistory a').count(),1);
  await page.evaluate(ev=>{closeBot();var btn=document.createElement('button'),p=document.createElement('div');p.id='historyBreakdown';document.body.appendChild(p);fetchAIBreakdown(ev.fights[0],ev,btn,p);},ev);
  await page.waitForFunction(()=>document.querySelector('#historyBreakdown a'));
  assert.match(sent[3].fightContext,/Robert Valentin/);
  assert.equal(await page.locator('#historyBreakdown a').count(),1);
} finally {await browser.close();await new Promise(ok=>server.close(ok));globalThis.fetch=originalFetch;}
console.log('check-ai-history: cached context, historical search, citations, bounds, failures and all three UI paths pass.');
