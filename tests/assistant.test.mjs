import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSnapshot,ownedRows} from '../supabase/functions/ghost-assistant/checks.mjs';
const now = Date.parse('2026-10-26T14:00:00Z');
test('flags past bookings but not completed appointments',()=>{
 const clients=['Booked','Confirmed','Completed'].map((status,i)=>({id:String(i),name:'Test',status,call_date_time:'2026-10-25T14:00:00Z'}));
 assert.equal(inspectSnapshot(clients,[],now).filter(f=>f.kind==='missing_outcome').length,2);
});
test('upcoming window uses absolute timestamps, including offset',()=>{
 const c={id:'1',name:'Test',status:'Booked',call_date_time:'2026-10-26T14:00:00-06:00'};
 assert.equal(inspectSnapshot([c],[],now)[0].kind,'upcoming_unconfirmed');
 assert.equal(inspectSnapshot([{...c,call_date_time:'invalid'}],[],now).length,0);
});
test('only external unverified sends are described as opened; null remains unknown',()=>{
 const rows=['unverified','sent','delivered',null,'failed','queued','sent_manual'].map((delivery_status,i)=>({client_id:String(i),delivery_status}));
 const f=inspectSnapshot([],rows,now)[0];assert.deepEqual(f.client_ids,['0']);assert.match(f.detail,/1 loaded/);
});
test('duplicates require nonempty exact normalized phone match',()=>{
 const rows=[{id:'a',name:'A',phone:'(555) 123-4567'},{id:'b',name:'B',phone:'5551234567'},{id:'c',phone:''},{id:'d',phone:''}];
 assert.deepEqual(inspectSnapshot(rows,[],now)[0].client_ids,['a','b']);
});
test('history excludes all clients outside the owner snapshot',()=>{
 assert.deepEqual(ownedRows([{client_id:'mine'},{client_id:'team'},{client_id:null}],new Set(['mine'])),[{client_id:'mine'}]);
});
