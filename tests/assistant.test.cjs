const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const logic = require('../hosted/logic.js');
const {brief} = require('../hosted/assistant.js');
const now = new Date('2026-10-26T14:00:00Z');
function client(id, extra={}){return logic.sanitizeClient({id,name:id,status:'Booked',bookedDate:'2026-10-26T13:00:00Z',callDateTime:'2026-10-28T15:00:00Z',...extra},id);}
function state(clients){return {...logic.buildDefaultState(),clients:Object.fromEntries(clients.map(c=>[c.id,c]))};}
test('priorities use existing rules, deduplicate and leave source data unchanged',()=>{
 const s=state([client('follow'),client('soon',{callDateTime:'2026-10-26T18:00:00Z'}),client('reply',{replies:[{at:'2026-10-26T13:00:00Z',text:'Hello'}]}),client('hidden',{ignored:true})]);
 const before=JSON.stringify(s);const b=brief(s,now,logic);
 assert.deepEqual(b.priorities.map(p=>p.id),['reply','soon','follow']);
 assert.equal(b.waiting,1);assert.equal(b.appointments,1);assert.equal(JSON.stringify(s),before);
});
test('paused and skipped follow-ups are not reintroduced',()=>{
 const s=state([client('paused',{automationPausedUntil:'2026-11-01T00:00:00Z'}),client('skipped',{skippedStages:{welcome:true}})]);
 s.clients.skipped.skippedStages = Object.fromEntries(logic.computeDue(s.clients.skipped,now).map(stage=>[stage,now.toISOString()]));
 assert.deepEqual(brief(s,now,logic).priorities,[]);
});
test('empty account and malformed dates do not invent appointments',()=>{
 assert.equal(brief(state([]),now,logic).priorities.length,0);
 assert.equal(brief(state([client('bad',{callDateTime:'bad'})]),now,logic).appointments,0);
});
test('optimization checks report stale calendars and unfinished tasks',()=>{
 const s=state([]);s.calendarConnections=[{calendarId:'x',lastSync:'2026-10-01T00:00:00Z'}];s.todos=[{text:'Check call',done:false},{text:'Done',done:true}];
 const b=brief(s,now,logic);assert.match(b.tips[0],/behind/);assert.deepEqual(b.todos,['Check call']);
});
function endpoint(user, pilotId = 'pilot-user'){
 let handler, providerCalls=0, sentBody;
 const src=stripTypeScriptTypes(fs.readFileSync('supabase/functions/gemini-draft/index.ts','utf8'));
 const sandbox={Deno:{env:{get:name=>name==='ASSISTANT_PILOT_USER_ID'?pilotId:'test'},serve:fn=>handler=fn},Response,console,fetch:async(url,opts)=>{
  if(url.includes('/auth/v1/user')) return new Response(JSON.stringify(user),{status:user?200:401});
  providerCalls++;sentBody=JSON.parse(opts.body);return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'Review the waiting reply.'}]}}]}));
 }};
 vm.runInNewContext(src,sandbox);
 return {call:body=>handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer token'},body:JSON.stringify(body)})),calls:()=>providerCalls,prompt:()=>sentBody};
}
test('unauthenticated requests cannot get pilot access',async()=>{const e=endpoint(null);assert.equal((await e.call({mode:'assistant-access'})).status,401);assert.equal(e.calls(),0);});
test('another account cannot use assistant even with forged identity in body',async()=>{
 const e=endpoint({id:'other',email:'other@example.com'});
 assert.equal((await (await e.call({mode:'assistant-access'})).json()).allowed,false);
 assert.equal((await e.call({mode:'assistant',userId:'pilot-user',question:'hello',context:{}})).status,403);assert.equal(e.calls(),0);
});
test('pilot access is server-authenticated and does not invoke model',async()=>{const e=endpoint({id:'pilot-user',userId:'pilot-user'});assert.equal((await (await e.call({mode:'assistant-access'})).json()).allowed,true);assert.equal(e.calls(),0);});
test('pilot question is bounded and returns advice without actions',async()=>{
 const e=endpoint({id:'pilot-user',userId:'pilot-user'});
 assert.equal((await e.call({mode:'assistant',question:'x'.repeat(2001),context:{}})).status,400);
 const r=await e.call({mode:'assistant',question:'What first?',context:{waiting:1}});assert.equal(r.status,200);assert.equal(e.calls(),1);
 assert.match(e.prompt().contents[0].parts[0].text,/cannot send messages/);
});
test('existing draft operation remains available for other users',async()=>{const e=endpoint({id:'other',email:'other@example.com'});assert.equal((await e.call({prompt:'Write a draft'})).status,200);assert.equal(e.prompt().generationConfig.maxOutputTokens,400);});

test('missing pilot setting denies access',async()=>{const e=endpoint({id:'pilot-user'},'');assert.equal((await (await e.call({mode:'assistant-access'})).json()).allowed,false);});
