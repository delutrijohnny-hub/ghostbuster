import test from 'node:test';
import assert from 'node:assert/strict';
let handler, requests, scenario;
globalThis.Deno = {env:{get:n=>({SUPABASE_URL:'https://test.invalid',SUPABASE_ANON_KEY:'public-test-key',GEMINI_API_KEY:'fake-test-key'})[n]},serve:fn=>{handler=fn;}};
globalThis.fetch = async (url,options={})=>{
 requests.push({url,options});
 const reply = (data,status=200)=>new Response(JSON.stringify(data),{status});
 if(url.endsWith('/auth/v1/user')) return scenario==='signedout'?reply({},401):reply({id:'owner'});
 if(url.includes('assistant_pilot_users')) return reply(scenario==='nonpilot'?[]:[{user_id:'owner'}]);
 if(url.includes('reserve_assistant_run')) return scenario==='quota'?reply({},400):reply('run-1');
 if(url.includes('finish_assistant_run')) return reply(null);
 if(url.includes('/clients?')) return scenario==='datafailure'?reply({},500):reply([{id:'owned-client',name:'Sample',status:'Booked',call_date_time:'2026-10-26T12:00:00Z'}]);
 if(url.includes('/message_log?')) return reply([{id:'m',client_id:'owned-client',delivery_status:'unverified',text:'Draft',sent_at:'2026-10-26T10:00:00Z'},{id:'foreign',client_id:'other-owner',text:'PRIVATE OTHER CLIENT'}]);
 if(url.includes('/sms_events?')) return reply([{id:1,client_id:'owned-client',body:'Please call Monday',created_at:'2026-10-26T11:00:00Z'}]);
 if(url.includes('generativelanguage')) return reply({candidates:[{content:{parts:[{text:'Review the past appointment for Sample.'}]}}]});
 throw Error('Unexpected fetch '+url);
};
await import('../supabase/functions/ghost-assistant/index.ts');
async function call(which,body={mode:'briefing'}) {scenario=which;requests=[];return handler(new Request('https://function.invalid',{method:'POST',headers:{Authorization:'Bearer fake'},body:JSON.stringify(body)}));}
test('signed out request stops before database or AI',async()=>{assert.equal((await call('signedout')).status,401);assert.equal(requests.length,1);});
test('nonpilot authenticated user cannot run assistant',async()=>{assert.equal((await call('nonpilot')).status,403);assert.equal(requests.length,2);});
test('invalid and oversized questions do not call model',async()=>{assert.equal((await call('ok',{mode:'ask',question:'x'.repeat(1501)})).status,400);assert.equal(requests.length,2);});
test('quota rejection stops before account retrieval',async()=>{assert.equal((await call('quota')).status,429);assert.equal(requests.length,3);});
test('failed account read never generates a misleading summary',async()=>{assert.equal((await call('datafailure')).status,503);assert.ok(!requests.some(r=>r.url.includes('generativelanguage')));});
test('owner filtering, inbound schema, read-only response and no send calls',async()=>{
 const res=await call('ok');assert.equal(res.status,200);const data=await res.json();assert.equal(data.read_only,true);
 assert.match(requests.find(r=>r.url.includes('/clients?')).url,/user_id=eq.owner/);
 assert.match(requests.find(r=>r.url.includes('/sms_events?')).url,/kind=eq.sms.inbound/);
 const model=requests.find(r=>r.url.includes('generativelanguage'));assert.ok(!model.options.body.includes('PRIVATE OTHER CLIENT'));
 assert.ok(model.options.body.includes('Please call Monday'));
 assert.ok(!requests.some(r=>/send-sms|send-email|mac_send_queue|scheduled_messages/.test(r.url)));
 assert.equal(data.findings.find(f=>f.kind==='unconfirmed_sends').client_ids[0],'owned-client');
});
