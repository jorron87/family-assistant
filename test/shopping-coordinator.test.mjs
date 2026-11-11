import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {createShoppingCoordinator} from '../src/shopping-coordinator.mjs';
import {planShoppingWorkers,workerManifest,applyWorkerProposal} from '../src/shopping-worker-contract.mjs';
import {shoppingWorkerArgs} from '../src/shopping-worker-runtime.mjs';
import {agentContextPages} from '../src/shopping-agent-context.mjs';
import {expandedFamilies,expandedCorpus} from '../scripts/fixtures/shopping-agent-corpus.mjs';

function fixture(count=60,{large=false,chains=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'family-coordinator-test-')),time={at:Date.parse('2026-11-10T12:00:00Z')},state={runLease:{token:'owner-test-lease'}},launches=[],yielding={value:false},corpus=expandedCorpus().slice(0,count);
 const shop=shoppingStore(state,{save(){},now:()=>new Date(time.at)}),families=new Map();shop.settings({monitoringEnabled:true,stores:chains?['KIWI','REMA_1000','COOP_EXTRA'].map(id=>({id:id.toLowerCase(),name:id,chainCode:id,minSavings:0,url:'https://example.test/'+id})):[]});
 for(const f of expandedFamilies)families.set(f.key,shop.watch({id:'synthetic-'+f.key,name:f.name,note:f.note+(large?' Complete criterion. '.repeat(2000):''),unit:f.unit,storage:'pantry'}).id);
 if(large)for(const w of Object.values(state.shopping.watches))w.note+=' Large actual requirements. '.repeat(2000);
 const products=corpus.map(c=>({id:String(1000+c.caseNumber),name:c.name,brand:c.brand,ean:[],weight:c.weight,weightUnit:c.weightUnit,soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/'+(1000+c.caseNumber)+'-synthetic'})),now=new Date(time.at).toISOString();
 if(chains)shop.sesumReceivePrices({familyIds:[],fetchedAt:now,products:products.map(p=>({...p,prices:['KIWI','REMA_1000','COOP_EXTRA'].map(storeCode=>({storeCode,price:25,observedAt:now,source:'receipt_realtime',isPromo:false,promotion:null}))}))});else shop.sesumReceiveMetadata({familyIds:[],fetchedAt:now,products});
 const store={shopping:shop,snapshot:()=>state,profile:()=>({timezone:'Europe/Oslo'})},options={store,root:dir,dataDir:dir,endpoint:'http://127.0.0.1:1/worker',clock:()=>time.at,alive:()=>true,shouldYield:()=>yielding.value,launch:input=>{launches.push(input);return {pid:111};}},coordinator=createShoppingCoordinator(options),plan=planShoppingWorkers(shop.queue().filter(i=>i.do==='shopping-sesum-placement-review'),count<=20?1:3);
 const start=()=>coordinator.start({token:state.runLease.token,batches:plan.batches});
 const packet=index=>shop.agentContext(workerManifest(plan.batches[index]));
 const call=(index,name,input={},target=coordinator)=>target.handle(launches[index].workerId,launches[index].token,name,input);
 const decisions=p=>({scopeEvidence:'Every one of the 91 actual synthetic family criteria was checked against the complete explicit label.',reviewedAllFamilies:true,decisions:p.sources.map((s,sourceIndex)=>{const c=corpus.find(c=>String(1000+c.caseNumber)===s.sourceKey.split(':').at(-1)),expected=c.expected;return {sourceKey:s.sourceKey,sourceIndex,status:expected.status,evidence:c.text,targets:expected.targets.map(k=>({familyIndex:p.families.findIndex(f=>f.familyId===families.get(k)),equivalenceEvidence:c.text})),...(expected.status==='blocked'?{reason:'The complete supplied label lacks or conflicts on a required identity fact.',retryAt:'2026-11-10T18:00:00Z'}:{}),...(expected.status==='no-active-family'?{reason:'The actual complete form and ingredients match none of the 91 active criteria.',noActiveFamilyVerified:true,negativeFamilyAssessments:[{familyIndex:p.families.findIndex(f=>f.familyId===families.get(c.familyKey)),evidence:'Actual full declaration rules out this advertised family: '+c.text}]}:{})};})});
 return {dir,time,state,shop,store,coordinator,options,plan,launches,yielding,start,packet,call,decisions,close(){for(const w of launches){assert.ok(w.directory.startsWith(join(tmpdir(),'family-shopping-worker-')));rmSync(w.directory,{recursive:true,force:true});}assert.ok(dir.startsWith(join(tmpdir(),'family-coordinator-test-')));rmSync(dir,{recursive:true,force:true});}};
}
async function readAll(f,index=0,options={}){const h=await f.call(index,'shopping_context',options);for(const [section,count]of Object.entries(h.pages))for(let page=0;page<count;page++)await f.call(index,'shopping_context',{section,page});return h;}
const startPool=(f,options={})=>f.coordinator.start({token:f.state.runLease.token,batches:f.plan.batches,pool:{capacity:3,batchSize:20,...options}});
function finish(f,index,outcome='deferred'){writeFileSync(join(f.launches[index].directory,'result.json'),JSON.stringify({outcome,summary:'Scoped current product work checked.',reason:'Downstream source registration requires a separate actual primary label review.'}));f.launches[index].onExit(0);}

test('one batched dataprep is exactly equivalent to three current packets and is not reused across requests',()=>{
 const f=fixture();try{const manifests=f.plan.batches.map(workerManifest),packets=f.shop.agentContexts(manifests);assert.deepEqual(packets,manifests.map(a=>f.shop.agentContext(a)));f.shop.watch({...f.state.shopping.watches['synthetic-beef-strips'],note:'New exact reviewed family criteria exclude all previous forms.'});const changed=f.shop.agentContexts(manifests);assert.notEqual(changed[0].contextFingerprint,packets[0].contextFingerprint);assert.deepEqual(changed,manifests.map(a=>f.shop.agentContext(a)));}finally{f.close();}
});
test('three workers claim sixty whole products with no overlap; all related chain rows stay together',()=>{
 const f=fixture(60,{chains:true});try{f.start();assert.equal(f.launches.length,3);const keys=new Set();for(const b of f.plan.batches){assert.equal(b.jobs.length,20);for(const j of b.jobs){assert.equal(j.sourceKeys.length,3);for(const key of j.sourceKeys){assert.ok(!keys.has(key));keys.add(key);}}}assert.equal(keys.size,180);assert.equal(f.state.runLease.token,'owner-test-lease');}finally{f.close();}
});

test('a finished or deferred lane gets fresh whole products while the two slower workers keep running',async()=>{
 const f=fixture(80,{chains:true});try{
  startPool(f);const before=f.coordinator.status(),slow=before.workers.slice(1).map(w=>w.id),originalKeys=new Set(f.plan.batch.jobs.flatMap(j=>j.sourceKeys)),queueBefore=f.shop.queue();
  finish(f,0);assert.equal(f.coordinator.status().pool.needsRefill,true);assert.equal(f.coordinator.status().pool.activeWorkers,2);
  const assignments=[],prepare=f.shop.agentContexts;f.shop.agentContexts=values=>{assignments.push(...values);return prepare(values);};
  f.coordinator.refill({queue:f.shop.queue()});const status=f.coordinator.status();
  assert.equal(status.runId,before.runId);assert.equal(status.pool.activeWorkers,3);assert.equal(status.pool.assignedJobs,80);assert.equal(status.pool.refills,1);assert.equal(status.workers[0].generation,2);assert.deepEqual(status.workers.slice(1).map(w=>w.id),slow);
  assert.ok(assignments.flatMap(a=>a.jobs.flatMap(j=>j.sourceKeys)).every(k=>!originalKeys.has(k)));assert.equal(assignments[0].jobs.length,20);assert.ok(assignments[0].jobs.every(j=>j.sourceKeys.length===3));
  await assert.rejects(f.call(0,'heartbeat'),/revoked/);assert.equal((await f.call(3,'heartbeat')).active,true);assert.equal(f.state.runLease.token,'owner-test-lease');
  f.coordinator.refill({queue:f.shop.queue()});assert.equal(f.launches.length,4,'a poll cannot create a fourth active worker');assert.deepEqual(f.shop.queue(),queueBefore,'deferral never removes actual work');
 }finally{f.close();}
});

test('refill excludes newly related chains and exact metadata aliases of all previously claimed products',()=>{
 const f=fixture(80);try{startPool(f);finish(f,0);const rows=f.shop.queue(),original=f.plan.batches[0].jobs[0].items[0],fake={...original,sourceKey:'sesum:KIWI:999999',relatedSources:[]},linked={...original,sourceKey:'sesum:REMA_1000:999998',relatedSources:[{sourceKey:f.plan.batches[1].jobs[0].sourceKeys[0],sourceFingerprint:'synthetic-link'}]};
  assert.ok(fake.researchProductKey);f.coordinator.refill({queue:[fake,linked,...rows]});assert.equal(f.launches.length,4);assert.equal(f.launches[3].prompt.includes('sesum:KIWI:999999'),false);assert.equal(f.launches[3].prompt.includes('sesum:REMA_1000:999998'),false);
 }finally{f.close();}
});

test('one remaining product can fill a free lane, and an empty pool ends without claiming completion',()=>{
 const f=fixture(61);try{startPool(f);finish(f,0);f.coordinator.refill({queue:f.shop.queue()});assert.equal(f.coordinator.status().workers[0].jobs,1);assert.equal(f.coordinator.status().pool.assignedJobs,61);finish(f,1);finish(f,2);finish(f,3);assert.equal(f.coordinator.status().running,true);f.coordinator.refill({queue:f.shop.queue()});const status=f.coordinator.status();assert.equal(status.running,false);assert.equal(status.last.pool.stopReason,'no-independent-work');assert.equal(status.last.slots.filter(s=>s.status==='deferred').length,4);assert.equal(f.shop.queue().length,61);assert.equal(f.state.runLease.token,'owner-test-lease');}finally{f.close();}
});

test('rolling claims and lane generations survive coordinator recovery without relaunching slow workers',()=>{
 const f=fixture(80);try{startPool(f);finish(f,0);const recovered=createShoppingCoordinator(f.options);recovered.tick();recovered.refill({queue:f.shop.queue()});assert.equal(f.launches.length,4);assert.equal(recovered.status().pool.activeWorkers,3);assert.equal(recovered.status().workers[0].generation,2);recovered.refill({queue:f.shop.queue()});assert.equal(f.launches.length,4);assert.equal(f.state.runLease.token,'owner-test-lease');}finally{f.close();}
});

test('session time, job budget and source handoff stop refill and let existing workers drain',()=>{
 for(const reason of ['time','jobs','source']){const f=fixture(80);try{
  startPool(f,reason==='time'?{durationMs:1000}:reason==='jobs'?{maxJobs:60}:{});finish(f,0);
  if(reason==='time')f.time.at+=1001;
  if(reason==='source')f.coordinator.refill({queue:f.shop.queue(),stopReason:'new-source-work'});else f.coordinator.tick();
  const status=f.coordinator.status();assert.equal(status.pool.needsRefill,false);assert.equal(status.pool.draining,true);assert.equal(status.pool.activeWorkers,2);assert.equal(f.launches.length,3);assert.equal(f.state.runLease.token,'owner-test-lease');
  finish(f,1);finish(f,2);assert.equal(f.coordinator.status().running,false);
 }finally{f.close();}}
});

test('pause, foreign lease and a safety stop also prevent rolling replacements',()=>{
 for(const reason of ['pause','lease','safety']){const f=fixture(80);try{startPool(f);if(reason==='safety')finish(f,0,'safety-stop');else{finish(f,0);if(reason==='pause')f.yielding.value=true;else f.state.runLease={token:'foreign'};}f.coordinator.refill({queue:f.shop.queue()});assert.equal(f.launches.length,3);assert.equal(f.coordinator.status().running,false);assert.equal(f.state.runLease.token,reason==='lease'?'foreign':'owner-test-lease');}finally{f.close();}}
});

test('a runtime failure drains the pool instead of repeatedly launching new failing workers',()=>{
 const f=fixture(80);try{startPool(f);f.launches[0].onExit(1);assert.equal(f.coordinator.status().pool.stopReason,'worker-runtime-error');f.coordinator.refill({queue:f.shop.queue()});assert.equal(f.launches.length,3);assert.equal(f.coordinator.status().pool.stopReason,'worker-runtime-error');assert.equal(f.coordinator.status().pool.activeWorkers,2);finish(f,1);finish(f,2);assert.equal(f.coordinator.status().last.code,1);}finally{f.close();}
});

test('a failed final domain check cannot crash the coordinator or certify completed work',()=>{
 const f=fixture(80);try{startPool(f);f.shop.agentContext=()=>{throw Error('Synthetic source-state read failure');};assert.doesNotThrow(()=>finish(f,0));assert.equal(f.coordinator.status().workers[0].status,'error');assert.equal(f.coordinator.status().pool.draining,true);assert.equal(f.coordinator.status().pool.stopReason,'worker-runtime-error');assert.equal(f.coordinator.status().pool.activeWorkers,2);assert.equal(f.state.runLease.token,'owner-test-lease');}finally{f.close();}
});

test('required negative family questions are delivered even without preserved research checkpoints',async()=>{
 const f=fixture(20);try{f.start();const header=await f.call(0,'shopping_context',{});assert.equal(header.researchAvailable,0);assert.ok(header.plausibleFamiliesToAssess.length>0);assert.ok(header.plausibleFamiliesToAssess.every(r=>r.hints.length>0&&r.hints.every(h=>Number.isInteger(h.familyIndex)&&h.authority.includes('not an approval'))));assert.ok(f.launches[0].prompt.includes('input-format rejection alone is not missing product evidence'));}finally{f.close();}
});
test('unsupported first job keeps its place and is never hidden by parallel routing',()=>{
 assert.equal(planShoppingWorkers([{do:'shopping-review',storeId:'urgent-flyer'},{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1'}],3),null);assert.throws(()=>planShoppingWorkers([],4),/three/);
});

test('small waves fill all configured workers without splitting identities or passing priority work',()=>{
 for(let length=2;length<=60;length++){
  const queue=Array.from({length},(_,i)=>({do:'shopping-product-review',productKey:'native:'+i}));
  queue.push({do:'shopping-review',storeId:'priority-flyer'},{do:'shopping-product-review',productKey:'later'});
  const plan=planShoppingWorkers(queue,3),sizes=plan.batches.map(b=>b.jobs.length);
  assert.equal(sizes.length,Math.min(length,3));assert.ok(Math.max(...sizes)<=20);assert.ok(Math.max(...sizes)-Math.min(...sizes)<=1);
  assert.deepEqual(plan.batches.flatMap(b=>b.jobs.map(j=>j.id)),queue.slice(0,length).map(i=>'product:'+i.productKey));
  if(length===27)assert.deepEqual(sizes,[9,9,9]);
 }
});

test('independent recovery crosses serial work without claiming it or splitting a deferred chain identity',()=>{
 const queue=[{do:'shopping-product-review',productKey:'held'},{do:'shopping-review',storeId:'flyer'},{do:'shopping-sesum-placement-review',sourceKey:'chain:a',relatedSources:[{sourceKey:'chain:b'}]},...Array.from({length:61},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'new:'+i}))],before=JSON.stringify(queue);
 const plan=planShoppingWorkers(queue,3,{independent:true,excludedKeys:new Set(['held','chain:b'])});
 assert.equal(plan.batch.jobs.length,60);assert.ok(plan.batch.jobs.every(j=>j.sourceKeys.length===1&&j.sourceKeys[0].startsWith('new:')));
 assert.equal(plan.batch.summary.agentJobs.total,64);assert.equal(JSON.stringify(queue),before);
 assert.equal(planShoppingWorkers(queue,3),null,'normal prefix routing remains conservative');
});

test('smaller live batches retain the entire queue and every related chain identity',()=>{
 const f=fixture(60,{chains:true});try{const queue=f.shop.queue().filter(i=>i.do==='shopping-sesum-placement-review'),plan=planShoppingWorkers(queue,3,{limit:5});assert.deepEqual(plan.batches.map(b=>b.jobs.length),[5,5,5]);assert.equal(plan.batch.summary.agentJobs.total,60);assert.equal(plan.batch.summary.agentJobs.remaining,45);assert.ok(plan.batch.jobs.every(j=>j.sourceKeys.length===3));assert.throws(()=>planShoppingWorkers(queue,3,{limit:0}),/twenty/);}finally{f.close();}
});

test('yielding placement matches synchronous domain receipts exactly and revalidates changed families before any write',async()=>{
 const a=fixture(20),b=fixture(20),c=fixture(20);try{
  const input=f=>{const packet=f.packet(0);return {assignment:workerManifest(f.plan.batches[0]),contextFingerprint:packet.contextFingerprint,decisions:f.decisions(packet)};};
  a.shop.agentPlacement(input(a));await b.shop.agentPlacementAsync(input(b));assert.deepEqual(b.state.shopping.sesumPlacementReviews,a.state.shopping.sesumPlacementReviews);
  const pending=c.shop.agentPlacementAsync(input(c));setImmediate(()=>c.shop.watch({...c.state.shopping.watches['synthetic-beef-strips'],note:'Actual changed family: frozen only.'}));
  await assert.rejects(pending,/endret/);assert.equal(Object.keys(c.state.shopping.sesumPlacementReviews).length,0);
 }finally{a.close();b.close();c.close();}
});

test('revoking a capability between placement chunks stops subsequent writes and preserves partial receipts as uncertain',async()=>{
 const f=fixture(20);try{f.start();const packet=f.packet(0),original=f.shop.agentPlacementAsync;let chunks=0;
  f.shop.agentPlacementAsync=(input,guard)=>original(input,()=>{if(++chunks===7)f.yielding.value=true;guard();});
  const request={proposalId:'chunked-partial-write',contextFingerprint:packet.contextFingerprint,operation:'placement',input:f.decisions(packet)};
  await assert.rejects(f.call(0,'shopping_propose',request),/capability/);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,4);
  f.yielding.value=false;assert.equal((await f.call(0,'shopping_propose',request)).uncertain,true);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,4);
 }finally{f.close();}
});
test('coordinator rejects overlapping assignments and foreign leases before launching',()=>{
 const f=fixture();try{assert.throws(()=>f.coordinator.start({token:'foreign',batches:f.plan.batches}),/lease/);assert.throws(()=>f.coordinator.start({token:f.state.runLease.token,batches:[f.plan.batches[0],f.plan.batches[0]]}),/Overlapping/);assert.equal(f.launches.length,0);}finally{f.close();}
});
test('out-of-order parallel proposals persist exact receipts once, with all 91 criteria and no extra identities',async()=>{
 const f=fixture();try{f.start();for(const index of [2,0,1]){const p=f.packet(index),input={proposalId:'placement-batch-'+index,contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)},r=await f.call(index,'shopping_propose',input);assert.equal(r.saved,true);assert.equal(r.result.saved,20);assert.equal((await f.call(index,'shopping_propose',input)).replayed,true);await assert.rejects(f.call(index,'shopping_propose',{...input,input:{}}),/reused/);finish(f,index);}
 const rows=f.state.shopping.sesumPlacementReviews;assert.equal(Object.keys(rows).length,60);for(const r of Object.values(rows))if(r.status!=='blocked')assert.equal(r.reviewedFamilies.length,91);assert.equal(f.coordinator.status().running,false);assert.equal(f.coordinator.status().last.applied,3);assert.equal(f.state.runLease.token,'owner-test-lease');
 }finally{f.close();}
});
test('changed family context rejects writes until the complete actual changed criteria are delivered',async()=>{
 const f=fixture(20);try{f.start();const p=f.packet(0);f.shop.watch({...f.state.shopping.watches['synthetic-beef-strips'],note:'Changed exact family requirements: frozen only.'});await assert.rejects(f.call(0,'shopping_propose',{proposalId:'stale-family-proposal',contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)}),/Context changed/);const h=await f.call(0,'shopping_context',{});assert.ok(h.pages.families>0);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'unread-family-proposal',contextFingerprint:h.contextFingerprint,operation:'placement',input:{}}),/complete current/);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,0);await readAll(f);assert.equal(f.packet(0).assignmentChanges.length,0,'fresh family criteria can be read for the same source identities');}finally{f.close();}
});
test('large contexts must be completely paginated; focusing keeps the whole job and never expands claims',async()=>{
 const f=fixture(20,{large:true});try{f.start();let h=await f.call(0,'shopping_context',{});assert.ok(h.pages.families>0);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'unread-large-context',contextFingerprint:h.contextFingerprint,operation:'placement',input:{}}),/complete current/);await assert.rejects(f.call(0,'shopping_context',{sourceKey:'sesum-product:999999'}),/Focus/);h=await f.call(0,'shopping_context',{sourceKey:f.plan.batches[0].jobs[0].sourceKeys[0]});assert.ok(h.pages.jobs>0);assert.ok(Object.values(agentContextPages(f.packet(0))).flat().length>0);}finally{f.close();}
});

test('explicit rereading after compaction discards all delivery shortcuts and blocks writes until facts are delivered again',async()=>{
 const f=fixture(20);try{f.start();const h=await f.call(0,'shopping_context',{reread:true,focus:'all'});assert.equal(h.contextDataProvidedInPrompt,false);assert.equal(h.familiesProvidedInPrompt,false);assert.ok(h.requiredPages.families.length);const p=f.packet(0);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'forgotten-context-proposal',contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)}),/complete current/);for(const [section,indexes]of Object.entries(h.requiredPages))for(const page of indexes)await f.call(0,'shopping_context',{section,page});assert.equal((await f.call(0,'shopping_propose',{proposalId:'actually-reread-proposal',contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)})).result.saved,20);}finally{f.close();}
});

test('an oversized absent family prefix is never mistaken for a delivered null fingerprint',async()=>{
 const f=fixture(20,{large:true});try{f.start();const h=await f.call(0,'shopping_context',{});assert.equal(h.familiesProvidedInPrompt,false);for(const [section,indexes]of Object.entries(h.requiredPages))if(section!=='families')for(const page of indexes)await f.call(0,'shopping_context',{section,page});const p=f.packet(0);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'missing-family-prefix',contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)}),/complete current/);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,0);}finally{f.close();}
});
test('outside identities, unsupported mutations and wrong capabilities never reach archive writes',async()=>{
 const f=fixture(20);try{f.start();await assert.rejects(f.coordinator.handle(f.launches[0].workerId,'wrong','shopping_context',{}),/capability/);const p=f.packet(0);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'outside-product-review',contextFingerprint:p.contextFingerprint,operation:'catalog-review',input:{productKey:'kassal:ODA_NO:999'}}),/outside/);await assert.rejects(f.call(0,'shopping_propose',{proposalId:'forbidden-cart-write',contextFingerprint:p.contextFingerprint,operation:'cart',input:{sourceKey:p.sources[0].sourceKey}}),/not available/);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,0);}finally{f.close();}
});

test('placement identity uses stable explicit source keys and rejects index/key mixups before any receipt',async()=>{
 const f=fixture(20);try{f.start();const p=f.packet(0),input=f.decisions(p);input.decisions[0].sourceKey=p.sources[1].sourceKey;await assert.rejects(f.call(0,'shopping_propose',{proposalId:'mismatched-source-position',contextFingerprint:p.contextFingerprint,operation:'placement',input}),/key and source index disagree/);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,0);const bound=f.decisions(p);for(const r of bound.decisions)delete r.sourceIndex;assert.equal((await f.call(0,'shopping_propose',{proposalId:'stable-source-key-batch',contextFingerprint:p.contextFingerprint,operation:'placement',input:bound})).result.saved,20);}finally{f.close();}
});

test('a missing current-stage page is named precisely so a worker can repair reading without retry loops or hidden delivery',async()=>{
 const f=fixture(20);try{f.start();const h=await f.call(0,'shopping_context',{reread:true,focus:'all'});for(const [section,indexes]of Object.entries(h.requiredPages))if(section!=='jobs')for(const page of indexes)await f.call(0,'shopping_context',{section,page});const input={proposalId:'actually-unread-job-page',contextFingerprint:h.contextFingerprint,operation:'placement',input:f.decisions(f.packet(0))};await assert.rejects(f.call(0,'shopping_propose',input),e=>{assert.ok(e.message.includes('Missing requiredPages='+JSON.stringify({jobs:h.requiredPages.jobs}))); assert.match(e.message,/No proposal was saved/);return true;});assert.equal(f.coordinator.status().applied,0);for(const page of h.requiredPages.jobs)await f.call(0,'shopping_context',{section:'jobs',page});assert.equal((await f.call(0,'shopping_propose',input)).saved,true,'the same unsaved proposal ID is safe after actual missing-page delivery');}finally{f.close();}
});
test('ambiguous partially persisted domain writes remain uncertain and are never automatically retried',async()=>{
 const f=fixture(20);try{f.start();const p=f.packet(0),original=f.shop.agentPlacementAsync;let attempts=0;f.shop.agentPlacementAsync=async(input,guard)=>{attempts++;await original(input,guard);throw Error('Synthetic crash after the domain receipt was saved.');};const input={proposalId:'ambiguous-placement-write',contextFingerprint:p.contextFingerprint,operation:'placement',input:f.decisions(p)};await assert.rejects(f.call(0,'shopping_propose',input),/crash/);assert.equal((await f.call(0,'shopping_propose',input)).uncertain,true);assert.equal(attempts,1);assert.equal(Object.keys(f.state.shopping.sesumPlacementReviews).length,20);}finally{f.close();}
});
test('encrypted research survives restart, is source-bound and does not approve product identity or prices',async()=>{
 const f=fixture(20);try{f.start();const key=f.packet(0).sources[0].sourceKey,input={sourceKey:key,evidence:'Read actual complete primary label for this fixed package.',labelText:'SYNTHETIC PRIVATE LABEL TEXT',sourceReceipts:[{url:'https://example.test/primary',observedAt:'2026-11-10T12:00:00Z',evidence:'Actual synthetic fixed-pack primary declaration.'}]};await f.call(0,'shopping_checkpoint',input);assert.equal((await f.call(0,'shopping_checkpoint',input)).notes,1);const restored=createShoppingCoordinator({...f.options,launch(){throw Error('Must not relaunch recovered workers.');}});const notes=await f.call(0,'shopping_read',{kind:'research'},restored);assert.equal(notes[0].notes[0].labelText,input.labelText);assert.equal(f.packet(0).sources[0].reviewedIdentity,null);assert.equal(readFileSync(join(f.dir,'shopping-coordinator.enc')).includes(Buffer.from(f.launches[0].token)),false);await assert.rejects(f.call(0,'shopping_checkpoint',{...input,sourceKey:'sesum-product:9999'}),/outside/);restored.tick();assert.equal(restored.status().running,true);}finally{f.close();}
});
test('owner pause, urgent family action or foreign lease revokes every capability without ending another lease',async()=>{
 for(const mode of ['pause','foreign']){const f=fixture();try{f.start();if(mode==='pause')f.yielding.value=true;else f.state.runLease={token:'another-owner'};f.coordinator.tick();assert.equal(f.coordinator.status().running,false);assert.equal(f.coordinator.status().last.preempted,true);await assert.rejects(f.call(0,'shopping_context',{}),/revoked/);assert.equal(f.state.runLease.token,mode==='pause'?'owner-test-lease':'another-owner');}finally{f.close();}}
});
test('explicit safety stop prevents new parallel or serial launch; deferred jobs remain visible in the raw queue',()=>{
 const f=fixture();try{f.start();finish(f,0);finish(f,1);finish(f,2);const raw=f.shop.queue();assert.ok(f.coordinator.preferSerial(raw).length);assert.equal(f.shop.queue().length,raw.length);f.start();finish(f,3,'safety-stop');assert.ok(f.coordinator.status().attention);assert.throws(f.start,/attention/);assert.equal(f.state.runLease.token,'owner-test-lease');}finally{f.close();}
});
test('scoped runtime is configured for one MCP broker, no shell/apps/browser or inherited plugin tools',()=>{
 const args=shoppingWorkerArgs({model:'configured-model',reasoningEffort:'high'},{directory:'synthetic',schemaFile:'schema',resultFile:'result',mcpScript:'bridge'}).join(' ');for(const flag of ['features.shell_tool=false','features.apps=false','features.plugins=false','features.browser_use=false','features.multi_agent=false','--ignore-user-config','-s read-only'])assert.ok(args.includes(flag));assert.doesNotMatch(args,/danger-full-access|ignore-rules|worker-token/);
});

test('family extension is additive and preserves household brand, shared attribute, native and explicit exclusion holds',()=>{
 const sourceKey='sesum:KIWI:1',assignment={jobs:[{sourceKeys:[sourceKey]}]},base={groupId:'existing',brands:['Exact Brand'],requires:['plain'],excludeProductKeys:['unrelated-product']},watch={variants:[base]},identity={productKey:sourceKey,groups:[{groupId:'new-group',groupFingerprint:'current-group'}],nativeFamilyReviews:[]},packet={assignmentChanges:[],jobs:[{items:[{do:'shopping-sesum-family-review',sourceKey,familyId:'family'}]}],sources:[{sourceKey,reviewedIdentity:identity}],families:[{familyId:'family',decision:{kind:'library'}}]};let saved=null;
 const store={snapshot:()=>({shopping:{watches:{family:watch}}}),shopping:{libraryLink:input=>(saved=input)}};
 const input={sourceKey,familyId:'family',evidence:'Actual complete label and current family requirements were reviewed.',variant:{groupId:'new-group',brands:['Exact Brand'],requires:['plain'],excludeProductKeys:[]}},apply=data=>applyWorkerProposal({store,assignment,packet,operation:'family-add-variant',input:data,groupReads:new Map([['new-group','current-group']])});
 apply(input);assert.deepEqual(saved.variants[0],base);assert.equal(saved.variants[1].groupFingerprint,'current-group');
 for(const variant of [{...input.variant,brands:[]},{...input.variant,brands:['Other Brand']},{...input.variant,requires:[]}])assert.throws(()=>apply({...input,variant}),/Preserve|broaden/);
 identity.nativeFamilyReviews=[{watchId:'family',status:'pending'}];assert.throws(()=>apply(input),/hold/);identity.nativeFamilyReviews=[];watch.variants[0].excludeProductKeys.push(sourceKey);assert.throws(()=>apply(input),/hold/);
 watch.variants[0].excludeProductKeys=[];assert.throws(()=>applyWorkerProposal({store,assignment,packet,operation:'family-add-variant',input,groupReads:new Map([['new-group','stale-group']])}),/current reviewed group/);
});

test('source registration cannot reuse unread group rules and fingerprints are bound from the current packet',()=>{
 const sourceKey='sesum:KIWI:1',assignment={jobs:[{sourceKeys:[sourceKey]}]},packet={assignmentChanges:[],jobs:[{items:[{do:'shopping-sesum-discovery',sourceKey}]}],sources:[{sourceKey,observation:{sourceFingerprint:'actual-source'}}]};let saved=null;const store={shopping:{sesumRegister:input=>(saved=input)}};
 const input={sourceKey,sourceFingerprint:'invented',memberships:[{groupId:'actual-group',groupFingerprint:'invented'}]},apply=groupReads=>applyWorkerProposal({store,assignment,packet,operation:'source-register',input,groupReads});assert.throws(()=>apply(new Map()),/Read the actual group/);apply(new Map([['actual-group','actually-read-current-group']]));assert.equal(saved.sourceFingerprint,'actual-source');assert.equal(saved.memberships[0].groupFingerprint,'actually-read-current-group');
});
