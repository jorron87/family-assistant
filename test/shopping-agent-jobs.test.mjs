import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingAgentJobs,shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';
import {createShoppingMaintenance} from '../src/shopping-maintenance.mjs';

test('one product job carries all family questions and only explicitly related chain identities',()=>{
  const a='sesum:KIWI:12',b='sesum:REMA_1000:12',other='sesum:COOP_EXTRA:12';
  const rows=[{do:'shopping-sesum-placement-review',sourceKey:a,relatedSources:[{sourceKey:b,sourceFingerprint:'b'}]},...Array.from({length:23},(_,i)=>({do:'shopping-sesum-family-review',sourceKey:b,watchId:'family-'+i})),{do:'shopping-sesum-placement-review',sourceKey:other,name:'Same display name',ean:'same-ean'},...Array.from({length:21},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i}))];
  const saved=JSON.stringify(rows),batch=shoppingAgentBatch(rows),jobs=shoppingAgentJobs(rows);
  assert.equal(jobs.length,23);assert.equal(batch.jobs.length,20);assert.equal(batch.jobs[0].items.length,24);assert.deepEqual(batch.jobs[0].sourceKeys,[a,b].sort());
  assert.equal(batch.items.length,43);assert.equal(batch.summary.total,46);assert.equal(batch.summary.agentJobs.remaining,3);assert.equal(JSON.stringify(rows),saved);
  assert.equal(shoppingAgentBatch(rows,{id:b}).jobs.length,1);assert.equal(shoppingAgentBatch(rows,{id:other}).jobs[0].items.length,1);
  const next=[{do:'shopping-sesum-discovery',sourceKey:a,sourceFingerprint:'current'}];assert.equal(shoppingAgentBatch(next,{id:a}).items[0].do,'shopping-sesum-discovery');
});

test('native family decisions share a product job while market families stay independently bounded',()=>{
  const rows=[{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'one'},{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'two'},{do:'shopping-market-refresh',watchIds:Array.from({length:91},(_,i)=>'f'+i)}];
  const batch=shoppingAgentBatch(rows);assert.equal(batch.jobs.length,20);assert.equal(batch.jobs[0].items.length,2);assert.equal(batch.summary.total,93);assert.equal(batch.summary.agentJobs.total,92);assert.equal(batch.items.find(i=>i.do==='shopping-market-refresh').watchIds.length,19);
});

test('exact source metadata shares a job across different donor bases without combining their receipts',()=>{
  const rows=[{do:'shopping-sesum-placement-review',sourceKey:'sesum:KIWI:1',researchProductKey:'full-metadata-a',registrationFingerprint:'donor-a'}, {do:'shopping-sesum-placement-review',sourceKey:'sesum:REMA_1000:1',researchProductKey:'full-metadata-a',registrationFingerprint:'different-donor-b'},{do:'shopping-sesum-family-review',sourceKey:'sesum:REMA_1000:1',watchId:'actual-family'},{do:'shopping-sesum-placement-review',sourceKey:'sesum:COOP_EXTRA:1',researchProductKey:'different-label-b',ean:'same',name:'same'}];
  const before=JSON.stringify(rows),batch=shoppingAgentBatch(rows);assert.equal(batch.jobs.length,2);assert.equal(batch.jobs[0].items.length,3);assert.equal(batch.items.length,4);assert.deepEqual(batch.jobs[0].sourceKeys,['sesum:KIWI:1','sesum:REMA_1000:1']);assert.equal(JSON.stringify(rows),before);assert.notEqual(batch.jobs[0].items[0].registrationFingerprint,batch.jobs[0].items[1].registrationFingerprint);
});

test('automatic price work honors owner, family priority, busy backoff and its own lease without launching an agent',async()=>{
  let at=1000000,lease=null,phone=[],calendar=[],resolve,calls=0,enabled=true;
  const store={snapshot:()=>({runLease:lease}),phone:{list:()=>phone},calendarActions:()=>calendar,shopping:{odaRefreshPlan:input=>{assert.equal(input.automatic,true);return [{watchId:'reviewed-family'}];}},beginRun:()=>({acquired:true,lease:lease={token:'owned-code-work'}}),endRun:token=>{assert.equal(token,lease.token);lease=null;}};
  const oda={refreshPrices:input=>{calls++;assert.deepEqual(input,{watchIds:['reviewed-family'],maxPages:5});return new Promise(r=>resolve=r);}};
  const code=createShoppingMaintenance({store,oda,enabled:()=>enabled,clock:()=>at});
  lease={token:'foreign'};await code.tick();assert.equal(lease.token,'foreign');assert.equal(calls,0);lease=null;
  phone=[{status:'queued'}];await code.tick();phone=[];calendar=[{id:'pending'}];await code.tick();calendar=[];enabled=false;await code.tick();assert.equal(calls,0);enabled=true;
  let stock=[{id:'family-stock'}];store.shopping.stockIntake={work:()=>stock};await code.tick();assert.equal(calls,0);stock=[];
  const pending=code.tick();await code.tick();assert.equal(calls,1);assert.equal(code.status().running,true);resolve({deferred:true,reason:'oda-busy'});await pending;assert.equal(lease,null);assert.equal(code.status().running,false);
  await code.tick();assert.equal(calls,1);at+=5*60000;const retry=code.tick();assert.equal(calls,2);resolve({families:1,results:[]});await retry;assert.equal(lease,null);
  // Even an unexpected failure cannot release a replacement/foreign lease.
  at+=60000;oda.refreshPrices=async()=>{lease={token:'new-owner'};throw Error('Source unavailable');};await code.tick();assert.equal(lease.token,'new-owner');assert.match(code.status().lastError,/failed/);
});
