import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSesumCollector,sesumSenderAllowed,sesumUrl,sesumQueryPlan} from '../src/shopping-sesum.mjs';
import {encrypt,decrypt} from '../src/crypto.mjs';

const when='2026-11-09T12:00:00Z',productUrl='https://www.sesum.no/produkt/123-synthetic-tomatoes';
function fixture(t,{familyCount=1,...config}={}){
  const dataDir=mkdtempSync(join(tmpdir(),'family-sesum-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  let at=new Date(when),rows=Array.from({length:familyCount},(_,i)=>({familyId:'family-'+i,name:'Synthetic family '+i,unit:'kg',queries:['synthetic '+i]}));
  const received=[],options={dataDir,encryptionKey:Buffer.alloc(32,17),config:{enabled:true,cycleCalls:1,...config},families:()=>rows,now:()=>at,receivePrices:input=>{received.push(input);return {matched:0,needsReview:1,blocked:0};}};
  return {client:createSesumCollector(options),options,dataDir,received,advance:ms=>{at=new Date(+at+ms);},setFamilies:next=>{rows=next;}};
}
const response=(work,job,result,status='ok')=>({runId:work.runId,jobId:job.id,status,fetchedAt:when,result});
const search=(job,{products=[],next=[],end=true}={})=>({ok:true,kind:'search',sourceUrl:job.url,productUrls:products,nextUrls:next,endReached:end,errors:[]});
const product=(job,{observedAt='2026-11-09T10:00:00Z',price=7.9}={})=>({ok:true,kind:'product',sourceUrl:job.url,product:{id:'123',name:'Synthetic tomatoes 390 g',ean:'12345678',weight:390,weightUnit:'g'},prices:[{storeCode:'EXTRA',price,observedAt,source:'receipt'}]});
const saved=f=>JSON.parse(decrypt(readFileSync(join(f.dataDir,'sesum-collector.json.enc')),f.options.encryptionKey));
const persist=(f,state)=>writeFileSync(join(f.dataDir,'sesum-collector.json.enc'),encrypt(Buffer.from(JSON.stringify(state)),f.options.encryptionKey));
const DIRECT_BUILD='sesum-collector-build-1.7.1-1';
const variableProduct=(job,{basis=true,price=109,observedAt='2026-11-09T10:00:00.000000+00:00',proofChanges={}}={})=>{
  const result=product(job,{price,observedAt});Object.assign(result.product,{name:'Synthetic whole ginger root',weight:null,weightUnit:null,soldByWeight:true,ean:null});
  Object.assign(result.prices[0],{storeId:'9',rawUnitPrice:999,isPromo:false,promotion:null});
  if(basis)result.prices[0].unitPriceBasis={kind:'own-chain-row-label-v1',productId:'123',sourceUrl:job.url,storeId:'9',storeCode:'EXTRA',rowControl:'kjederad-9',label:'109,00 kr/kg',amount:109,unit:'kg',observedAt,source:'receipt',...proofChanges};
  return result;
};
const repairInput=row=>({repair:row.directUnitBasisRepair.repair,runId:row.directUnitBasisRepair.runId,jobIds:[row.jobId],observationFingerprints:{[row.jobId]:row.directUnitBasisRepair.observationFingerprint},parserBuild:DIRECT_BUILD,evidence:'The saved own variable-weight row predates the tested exact own-row unit-label parser; reread only this selected product.'});

test('all own receipt ages precede configured-chain filtering and survive replay without changing product metadata fingerprints',async t=>{
  const f=fixture(t,{familyCount:2,chainCodes:['KIWI']});let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];
  const raw=product(detail);raw.prices=[{storeCode:'JOKER',storeId:'3',price:7.9,observedAt:'2023-01-01T12:00:00Z',source:'own_actual_receipt',isPromo:false}];raw.priceCandidates=[{storeCode:'MENY_NO',storeId:'5',price:null,observedAt:'2023-01-02T12:00:00Z',source:'own_actual_receipt'}];raw.candidates=[{id:'456',name:'Unrelated fresh suggestion',observedAt:when,source:'related_receipt',sourceUrl:null}];
  raw.product.ownReceiptSummary={kind:'own-product-chain-receipts-v1',productId:'123',sourceUrl:detail.url,receipts:[{storeCode:'KIWI',storeId:'4',source:'injected-not-an-own-row',observedAt:when}]};
  await f.client.receive(response(work,detail,raw));const first=f.client.catalog().items[0],summary=first.product.ownReceiptSummary;assert.equal(first.product.prices.length,0);assert.equal(first.product.priceCandidates.length,0);assert.equal(summary.receipts.length,2);assert.deepEqual(new Set(summary.receipts.map(row=>row.observedAt)),new Set(['2023-01-01T12:00:00Z','2023-01-02T12:00:00Z']));assert.ok(!JSON.stringify(summary).includes('injected-not-an-own-row'));assert.equal(f.client.status().manifest[0].chains[0].freshProducts,0);
  const restored=createSesumCollector(f.options);work=restored.work();seed=work.jobs[0];await restored.receive(response(work,seed,search(seed,{products:[productUrl]})));assert.deepEqual(f.received.at(-1).products[0].ownReceiptSummary,summary);assert.equal(f.received.at(-1).fetchedAt,when,'local family replay never turns an old own receipt into a new one');
  restored.refresh();work=restored.work();seed=work.jobs[0];await restored.receive(response(work,seed,search(seed,{products:[productUrl]})));work=restored.work();const fresh=product(work.jobs[0]);fresh.prices=[{...raw.prices[0],observedAt:'2024-01-01T12:00:00Z'}];await restored.receive(response(work,work.jobs[0],fresh));assert.equal(restored.catalog().items[0].productObservationFingerprint,first.productObservationFingerprint,'actual price dates and own receipt summary are outside product metadata');
});

test('legacy complete and applied product observations import metadata locally once across restart without a source claim or price replay',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await f.client.receive(response(work,detail,result));
  const old=saved(f);delete old.run.jobs[detail.id].productObservation.ownReceiptSummary;old.pauseUntil='2026-11-09T12:30:00Z';persist(f,old);f.advance(60000);
  const metadata=[],client=createSesumCollector({...f.options,receiveMetadata:input=>{metadata.push(input);return {observed:1};}}),before=saved(f);assert.equal(client.status().metadataReplayPendingCount,1);assert.equal(client.status().replayPendingCount,1);assert.deepEqual(client.work({peek:true}).jobs,[]);client.catalog();assert.equal(metadata.length,0,'read-only status, catalogue and peek do not consume imports');
  const imported=await client.replayPending();assert.equal(imported.metadataApplied,1);assert.equal(imported.applied,0);assert.equal(imported.pending,0);assert.equal(metadata.length,1);assert.equal(metadata[0].fetchedAt,when);assert.equal(metadata[0].products[0].prices.length,0);assert.deepEqual(metadata[0].products[0].ownReceiptSummary.receipts,[],'legacy missing age remains unknown');assert.equal(f.received.length,1,'metadata importing never calls the old price callback again');
  const after=saved(f);assert.deepEqual(after.run.jobs,before.run.jobs);assert.equal(after.run.finishedAt,before.run.finishedAt);assert.equal(after.pauseUntil,before.pauseUntil);const restarted=createSesumCollector({...f.options,receiveMetadata:input=>metadata.push(input)});assert.equal(restarted.status().metadataReplayPendingCount,0);assert.equal((await restarted.replayPending()).metadataApplied,0);assert.equal(metadata.length,1);
});

test('metadata-only import failures remain durable pending with bounded local backoff and no source or price retries',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await f.client.receive(response(work,detail,result));
  let attempts=0;const metadata=[],options={...f.options,receiveMetadata:input=>{attempts++;if(attempts===1)throw Error('Synthetic metadata receiver unavailable');metadata.push(input);return {observed:1};}},client=createSesumCollector(options);const before=saved(f);
  const failed=await client.replayPending();assert.equal(failed.metadataFailed,1);assert.equal(failed.pending,1);assert.equal(client.status().metadataReplayPendingCount,1);assert.equal(client.status().replayPendingCount,1);assert.equal((await client.replayPending()).metadataFailed,0);assert.equal(attempts,1);assert.deepEqual(client.work({peek:true}).jobs,[]);
  const restarted=createSesumCollector(options);assert.equal(restarted.status().metadataReplayPendingCount,1);assert.equal((await restarted.replayPending()).metadataApplied,0);f.advance(60001);assert.equal((await restarted.replayPending()).metadataApplied,1);assert.equal(restarted.status().replayPendingCount,0);assert.equal(metadata[0].fetchedAt,when);assert.equal(f.received.length,1);assert.deepEqual(saved(f).run.jobs,before.run.jobs);assert.equal(saved(f).run.finishedAt,before.run.finishedAt);
});

test('archived latest own metadata imports in the configured finite budget and concurrent drains share one operation',async t=>{
  const f=fixture(t,{cycleCalls:2});let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await f.client.receive(response(work,detail,result));f.client.refresh();
  const state=saved(f),old=state.observations['123'];for(const id of ['124','125']){const url=`https://www.sesum.no/produkt/${id}-archived-own-product`;state.observations[id]={...structuredClone(old),jobId:'archived-'+id,sourceUrl:url,product:{...structuredClone(old.product),id,sourceUrl:url,ownReceiptSummary:{kind:'own-product-chain-receipts-v1',productId:id,sourceUrl:url,receipts:[]}}};}persist(f,state);
  const metadata=[],options={...f.options,receiveMetadata:async input=>{await Promise.resolve();metadata.push(input);return {observed:1};}},client=createSesumCollector(options),before=saved(f);assert.equal(client.status().metadataReplayPendingCount,3);
  const [a,b]=await Promise.all([client.replayPending(),client.replayPending()]);assert.equal(a.metadataApplied,2);assert.deepEqual(a,b);assert.equal(metadata.length,2);assert.equal(client.status().metadataReplayPendingCount,1);const restarted=createSesumCollector(options);assert.equal((await restarted.replayPending()).metadataApplied,1);assert.equal(metadata.length,3);assert.equal(restarted.status().metadataReplayPendingCount,0);assert.equal(new Set(metadata.map(input=>input.products[0].id)).size,3);assert.ok(metadata.every(input=>input.fetchedAt===when));assert.deepEqual(saved(f).run.jobs,before.run.jobs);assert.equal(f.received.length,1);
});

test('a successful normal price callback already delivers metadata and never schedules a duplicate metadata-only callback',async t=>{
  const f=fixture(t),metadata=[],client=createSesumCollector({...f.options,receiveMetadata:input=>metadata.push(input)});let work=client.work(),seed=work.jobs[0];await client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await client.receive(response(work,detail,result));
  assert.equal(f.received.length,1);assert.equal(f.received[0].products[0].id,'123');assert.equal(client.status().metadataReplayPendingCount,0);assert.equal((await client.replayPending()).metadataApplied,0);assert.deepEqual(metadata,[]);assert.equal(createSesumCollector({...f.options,receiveMetadata:input=>metadata.push(input)}).status().metadataReplayPendingCount,0);
});

test('explicit metadata import never ensures a changed or overdue source plan and works from archives without any current run',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await f.client.receive(response(work,detail,result));
  const state=saved(f);state.pauseUntil='2026-11-11T12:00:00Z';persist(f,state);f.advance(25*3600000);f.setFamilies([{familyId:'new-family',name:'Changed household semantic plan',unit:'kg'}]);
  const metadata=[],options={...f.options,receiveMetadata:input=>metadata.push(input)},client=createSesumCollector(options),before=saved(f);assert.equal(client.status().planCurrent,false);assert.equal(client.status().refreshDue,true);assert.equal((await client.replayMetadata()).metadataApplied,1);const after=saved(f);assert.deepEqual(after.run,before.run);assert.equal(after.pauseUntil,before.pauseUntil);assert.equal(metadata[0].fetchedAt,when);assert.equal(f.received.length,1);
  const archived=structuredClone(before);archived.observations['123']=client.catalog().items[0];archived.run=null;archived.metadataImports={};persist(f,archived);const noRun=createSesumCollector(options);assert.equal(noRun.status().status,'not_started');assert.equal(noRun.status().metadataReplayPendingCount,1);assert.equal((await noRun.replayMetadata()).metadataApplied,1);assert.equal(saved(f).run,null);assert.equal(saved(f).pauseUntil,before.pauseUntil);assert.equal(noRun.status().metadataReplayPendingCount,0);assert.equal(metadata.length,2);assert.equal(f.received.length,1);
});

test('metadata-only imports and incoming source receipts serialize without a deadlock or consuming the source reservation', {timeout:5000},async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=product(detail);result.prices=[];await f.client.receive(response(work,detail,result));f.client.refresh();
  let release,started;const gate=new Promise(resolve=>{release=resolve;}),begun=new Promise(resolve=>{started=resolve;}),events=[];const client=createSesumCollector({...f.options,receiveMetadata:async()=>{events.push('metadata-start');started();await gate;events.push('metadata-end');}});
  work=client.work();seed=work.jobs[0];const reservation=saved(f).run.jobs[seed.id].deliveredUntil,one=client.replayMetadata(),two=client.replayMetadata();await begun;const incoming=client.receive(response(work,seed,search(seed)));await Promise.resolve();assert.equal(saved(f).run.jobs[seed.id].status,'pending');assert.equal(saved(f).run.jobs[seed.id].deliveredUntil,reservation);assert.deepEqual(events,['metadata-start']);release();
  const [a,b,receipt]=await Promise.all([one,two,incoming]);assert.equal(a.metadataApplied,1);assert.deepEqual(a,b);assert.equal(receipt.status,'complete');assert.deepEqual(events,['metadata-start','metadata-end']);assert.equal(client.status().metadataReplayPendingCount,0);assert.equal(f.received.length,1,'the local import and incoming search never rerun a product price callback');
});

test('own unit label evidence survives encrypted reload, callback retry and exact-URL family replay at original times',async t=>{
  const f=fixture(t,{familyCount:2});let calls=0;const inputs=[],client=createSesumCollector({...f.options,receivePrices:input=>{inputs.push(input);if(++calls===1)throw Error('Temporary local receipt failure');return {matched:0,needsReview:1,blocked:0};}});
  let work=client.work(),seed=work.jobs[0];await client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=client.work();const detail=work.jobs[0],actual=variableProduct(detail);
  await assert.rejects(client.receive(response(work,detail,actual)),/Temporary local/);assert.deepEqual(inputs[0].products[0].prices[0].unitPriceBasis,{...actual.prices[0].unitPriceBasis,storeCode:'COOP_EXTRA'});
  f.advance(60001);const restored=createSesumCollector({...f.options,receivePrices:input=>{inputs.push(input);return {needsReview:1};}});assert.equal((await restored.replayPending()).applied,1);
  work=restored.work();seed=work.jobs[0];await restored.receive(response(work,seed,search(seed,{products:[productUrl]})));
  const replay=inputs.at(-1);assert.deepEqual(replay.familyIds,['family-1']);assert.equal(replay.fetchedAt,when);assert.equal(replay.products[0].prices[0].observedAt,actual.prices[0].observedAt);assert.deepEqual(replay.products[0].prices[0].unitPriceBasis,inputs[0].products[0].prices[0].unitPriceBasis);
  const catalog=restored.catalog().items[0];assert.equal(catalog.product.prices[0].unitPriceBasis.amount,109);assert.equal(catalog.product.prices[0].rawUnitPrice,999);assert.equal(catalog.directUnitBasisRepair,undefined);assert.ok(catalog.savedObservationFingerprint);
});

test('an invalid optional unit proof holds only that quote basis and never persists untrusted nested fields',async t=>{
  for(const proofChanges of [{productId:'999'},{sourceUrl:'https://www.sesum.no/produkt/999-related'},{storeId:'4'},{rowControl:'kjederad-4'},{storeCode:'KIWI'},{label:'99,00 kr/kg'},{unit:'l'},{observedAt:'2026-11-09T11:00:00Z'},{source:'another receipt'},{token:'must-not-persist'}]){
    const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0],result=variableProduct(detail,{proofChanges});
    result.prices.push({storeId:'4',storeCode:'KIWI',price:150,observedAt:'2026-11-09T10:00:00Z',source:'receipt',unitPriceBasis:{kind:'own-chain-row-label-v1',productId:'123',sourceUrl:detail.url,storeId:'4',storeCode:'KIWI',rowControl:'kjederad-4',label:'150,00 kr/kg',amount:150,unit:'kg',observedAt:'2026-11-09T10:00:00Z',source:'receipt'}});
    await f.client.receive(response(work,detail,result));const prices=f.received[0].products[0].prices;assert.equal(prices[0].price,109);assert.equal(prices[0].unitPriceBasis,null);assert.equal(prices[0].unitPriceBasisReason,'invalid-own-unit-price-basis');assert.equal(prices[1].unitPriceBasis.amount,150);assert.ok(!JSON.stringify(saved(f)).includes('must-not-persist'));
  }
});

test('a finite complete-variable repair preserves progress, aliases, attempts and authentication pause until a real reread',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,variableProduct(detail,{basis:false})));
  work=f.client.work();seed=work.jobs[0];await f.client.receive({runId:work.runId,jobId:seed.id,status:'error',fetchedAt:when,error:{code:'auth_required',retryAfterMs:600000}});
  const old=saved(f),before=old.run.jobs[detail.id];before.attempts=2;before.error={code:'old-recovered-error',message:'Retain actual history'};old.run.productAliases={olderAlias:detail.id};persist(f,old);
  const client=createSesumCollector(f.options),catalog=client.catalog().items[0],input=repairInput(catalog),pause=client.status().pauseUntil;input.jobIds.push('olderAlias');input.observationFingerprints.olderAlias=input.observationFingerprints[detail.id];
  const receipt=client.retry(input);assert.deepEqual(receipt.retried,[detail.id]);assert.equal(receipt.pauseUntil,pause);assert.deepEqual(client.work().jobs,[]);
  const pending=saved(f),job=pending.run.jobs[detail.id];assert.equal(pending.run.id,old.run.id);assert.deepEqual(pending.run.jobs[seed.id],old.run.jobs[seed.id]);assert.equal(job.attempts,2);assert.deepEqual(job.error,before.error);assert.deepEqual(job.productObservation,before.productObservation);assert.deepEqual(job.appliedFamilyIds,before.appliedFamilyIds);assert.equal(job.retryHistory.at(-1).previousCompletedAt,before.completedAt);assert.equal(job.retryHistory.at(-1).observationFingerprint,catalog.savedObservationFingerprint);assert.equal(pending.pauseUntil,pause);
  assert.throws(()=>client.retry(input));f.advance(600001);const restored=createSesumCollector(f.options),next=restored.work();assert.equal(next.jobs[0].id,detail.id);assert.equal(next.jobs.length,1,'the repair consumes the ordinary source call budget');
  const fetchedAt='2026-11-09T12:10:00.001Z';await restored.receive({...response(next,next.jobs[0],variableProduct(next.jobs[0])),fetchedAt,collectorBuild:DIRECT_BUILD});
  const repaired=saved(f).run.jobs[detail.id];assert.equal(repaired.attempts,2);assert.deepEqual(repaired.observationHistory[0].product,before.productObservation);assert.equal(repaired.observationHistory[0].fetchedAt,when);assert.equal(repaired.productObservation.prices[0].observedAt,'2026-11-09T10:00:00.000000+00:00');assert.equal(repaired.observationFetchedAt,fetchedAt);assert.equal(restored.catalog().items[0].directUnitBasisRepair,undefined);assert.equal(restored.status().jobCountsByKind.search.complete,1);assert.throws(()=>restored.retry(input));
});

test('complete repair validation is atomic and excludes searches, fixed or unknown weight, valid proof and in-flight work',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,variableProduct(detail,{basis:false})));
  const row=f.client.catalog().items[0],good=repairInput(row),before=saved(f);
  for(const patch of [{repair:'unknown-mode'},{runId:undefined},{runId:'wrong-run'},{parserBuild:'untested-build'},{observationFingerprints:{[detail.id]:'stale'}},{jobIds:[detail.id,seed.id],observationFingerprints:{...good.observationFingerprints,[seed.id]:'not-an-own-product'}},{evidence:''}]){assert.throws(()=>f.client.retry({...good,...patch}));assert.deepEqual(saved(f),before,'an invalid selected batch never mutates even its valid first job');}
  for(const change of ['fixed','unknown','basis','callback','replay','reservation']){
    const state=structuredClone(before),job=state.run.jobs[detail.id];
    if(change==='fixed')job.productObservation.soldByWeight=false;if(change==='unknown')job.productObservation.soldByWeight=null;if(change==='basis')job.productObservation=variableProduct(detail).product,job.productObservation.prices=variableProduct(detail).prices;
    if(change==='callback')job.callbackPending={product:job.productObservation,fetchedAt:when,familyIds:['family-0']};if(change==='replay')job.replayFamilyIds=['family-0'];if(change==='reservation')job.deliveredUntil='2026-11-09T12:05:00Z';persist(f,state);
    const client=createSesumCollector(f.options);assert.equal(client.catalog().items[0].directUnitBasisRepair,undefined,change);assert.throws(()=>client.retry(good),change);assert.deepEqual(saved(f),state,change);
  }
});

test('a tested reread that still lacks a label stays held without offering an automatic repair loop or refreshing its price',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,variableProduct(detail,{basis:false})));
  const input=repairInput(f.client.catalog().items[0]);f.client.retry(input);f.advance(60000);work=f.client.work();await f.client.receive({...response(work,work.jobs[0],variableProduct(work.jobs[0],{basis:false})),fetchedAt:'2026-11-09T12:01:00Z',collectorBuild:DIRECT_BUILD});
  const row=f.client.catalog().items[0];assert.equal(row.directUnitBasisRepair,undefined);assert.equal(row.product.prices[0].unitPriceBasis,null);assert.equal(row.product.prices[0].unitPriceBasisReason,'missing-own-unit-price-basis');assert.equal(row.product.prices[0].observedAt,'2026-11-09T10:00:00.000000+00:00');assert.deepEqual(f.client.work().jobs,[]);assert.throws(()=>f.client.retry({...input,observationFingerprints:{[detail.id]:row.savedObservationFingerprint}}));
  f.client.refresh();assert.equal(f.client.catalog().items[0].directUnitBasisRepair,undefined,'archived earlier-run observations never advertise a current-run repair');
});

test('an older cached collector cannot reopen the same finite repair after a new capture time or retry-history eviction',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,variableProduct(detail,{basis:false})));
  const old=f.client.catalog().items[0],input=repairInput(old);f.client.retry(input);f.advance(60000);work=f.client.work();await f.client.receive({...response(work,work.jobs[0],variableProduct(work.jobs[0],{basis:false})),fetchedAt:'2026-11-09T12:01:00Z',collectorBuild:'sesum-collector-build-1.7.0-3'});
  const row=f.client.catalog().items[0];assert.notEqual(row.savedObservationFingerprint,old.savedObservationFingerprint);assert.equal(row.directUnitBasisRepair,undefined,'an older worker still consumes the one explicitly requested enrichment attempt');assert.equal(row.product.prices[0].unitPriceBasisReason,'missing-own-unit-price-basis');assert.equal(row.product.prices[0].observedAt,'2026-11-09T10:00:00.000000+00:00');assert.equal(saved(f).run.jobs[detail.id].observationHistory[0].fetchedAt,when);
  const state=saved(f);state.run.jobs[detail.id].retryHistory=Array.from({length:20},(_,i)=>({requestedAt:when,evidence:'Independent later diagnostic history '+i,previousStatus:'partial'}));persist(f,state);
  const restored=createSesumCollector(f.options),after=restored.catalog().items[0];assert.equal(after.directUnitBasisRepair,undefined);assert.deepEqual(restored.work().jobs,[]);const before=saved(f);assert.throws(()=>restored.retry({...input,observationFingerprints:{[detail.id]:after.savedObservationFingerprint}}));assert.deepEqual(saved(f),before,'repeated same-build requests neither enqueue work nor erase prior source evidence');
});

test('exact-URL migration preserves a consumed repair when a newer successful duplicate becomes canonical',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,variableProduct(detail,{basis:false})));
  f.client.retry(repairInput(f.client.catalog().items[0]));f.advance(60000);work=f.client.work();await f.client.receive({...response(work,work.jobs[0],variableProduct(work.jobs[0],{basis:false})),fetchedAt:'2026-11-09T12:01:00Z',collectorBuild:'sesum-collector-build-1.7.0-3'});
  const state=saved(f),copy={...structuredClone(state.run.jobs[detail.id]),id:'newer-legacy-copy',generation:7,createdAt:'2026-11-09T12:02:00Z',fetchedAt:'2026-11-09T12:02:00Z',observationFetchedAt:'2026-11-09T12:02:00Z',retryHistory:[]};delete copy.directUnitBasisRepairRequests;state.run.jobs[copy.id]=copy;delete state.run.productDedupeVersion;persist(f,state);f.advance(120000);
  const restored=createSesumCollector(f.options);assert.deepEqual(restored.work({peek:true}).jobs,[]);assert.equal(saved(f).run.productAliases[detail.id],copy.id);assert.equal(restored.catalog().items[0].jobId,copy.id);assert.equal(restored.catalog().items[0].directUnitBasisRepair,undefined,'changing canonical IDs cannot create another same-build enrichment attempt');assert.ok(saved(f).run.mergedProductJobs[detail.id].job.observationHistory.length);
});

test('one global source batch survives reload, releases after every receipt, and recovers after reservation expiry',async t=>{
  const f=fixture(t,{familyCount:12,cycleCalls:4,requireSingleBatch:true}),first=f.client.work();assert.equal(first.jobs.length,4);
  const restored=createSesumCollector(f.options);
  for(const peek of [false,true]){const blocked=restored.work({peek});assert.deepEqual(blocked.jobs,[]);assert.equal(blocked.reason,'active-source-batch');}
  await restored.receive(response(first,first.jobs[0],search(first.jobs[0])));assert.deepEqual(restored.work().jobs,[],'other three jobs still reserve the batch');
  for(const job of first.jobs.slice(1))await restored.receive(response(first,job,search(job)));
  const second=restored.work();assert.equal(second.jobs.length,4);assert.ok(second.jobs.every(j=>!first.jobs.some(old=>old.id===j.id)));
  f.advance(5*60000+1);const recovered=createSesumCollector(f.options).work();assert.equal(recovered.jobs.length,4,'expired reservations do not block the run forever');
});

test('same exact product URL across query generations replays its successful observation to a new family without refetch',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work(),seed=work.jobs[0];
  await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];
  await f.client.receive(response(work,detail,product(detail)));
  const second=f.client.work(),secondSeed=second.jobs[0];await f.client.receive(response(second,secondSeed,search(secondSeed)));
  const state=saved(f),copy={id:'older-generation-copy',kind:'product',url:productUrl,generation:7,familyIds:['family-1'],status:'pending',attempts:0,createdAt:when};
  state.run.jobs[copy.id]=copy;delete state.run.productDedupeVersion;persist(f,state);f.received.length=0;f.advance(3600000);
  const restored=createSesumCollector(f.options);assert.equal(restored.work({peek:true}).jobs.length,0);
  assert.equal(restored.status().replayPendingCount,1);assert.equal(restored.status().status,'collecting');assert.equal(f.received.length,0,'peek queues evidence but never consumes replay');
  const result=await restored.replayPending();assert.equal(result.applied,1);assert.equal(result.pending,0);assert.equal(f.received.length,1);
  assert.deepEqual(f.received[0].familyIds,['family-1']);assert.equal(f.received[0].fetchedAt,when);assert.equal(f.received[0].products[0].prices[0].observedAt,'2026-11-09T10:00:00Z');assert.equal(f.received[0].products[0].prices[0].sourceStoreCode,'EXTRA');
  assert.equal(restored.status().jobCountsByKind.product.complete,1);assert.equal(restored.status().status,'complete');
  assert.equal(saved(f).run.productAliases[copy.id],detail.id);assert.deepEqual(saved(f).run.mergedProductJobs[copy.id].job,copy);
  assert.equal((await restored.receive(response(work,{...detail,id:copy.id},product(detail)))).duplicate,true);
});

test('a newer validated source change with failed callback outranks an older successful duplicate and retries locally',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,product(detail)));
  const state=saved(f),old=state.run.jobs[detail.id],newTime='2026-11-09T12:01:00Z',changed=structuredClone(old.productObservation);changed.name='Synthetic source changed contents 390 g';changed.prices[0].price=9;
  state.run.jobs.repair={id:'repair',kind:'product',url:productUrl,generation:7,status:'pending',familyIds:['family-0'],attempts:0,createdAt:when,retryHistory:[{evidence:'Selected concrete source repair'}]};state.run.repairPriority=['repair'];
  state.run.jobs.changed={...structuredClone(old),id:'changed',generation:8,status:'pending',familyIds:['family-1'],productObservation:changed,observationFetchedAt:newTime,observationStatus:'ok',observationError:'Previous callback failed',appliedFamilyIds:[],deliveredUntil:null,priceChains:[],priceReceipts:[]};delete state.run.productDedupeVersion;persist(f,state);f.advance(120000);
  let calls=0;const inputs=[],options={...f.options,receivePrices:input=>{inputs.push(input);if(++calls===1)throw Error('Local apply unavailable');return {matched:0,needsReview:1,blocked:0};}},restored=createSesumCollector(options);
  const first=await restored.replayPending();assert.equal(first.failed,1);assert.equal(restored.status().jobCountsByKind.product.complete,0);assert.equal(restored.status().replayPendingCount,1);
  assert.equal(saved(f).run.productAliases.repair,'changed','selected older repairs follow the newer actual source evidence');assert.ok(saved(f).run.repairPriority.includes('changed'));assert.deepEqual(saved(f).run.mergedProductJobs.repair.job.retryHistory,[{evidence:'Selected concrete source repair'}]);
  assert.equal(inputs[0].products[0].name,changed.name);assert.equal(inputs[0].fetchedAt,newTime);assert.equal(restored.work({peek:true}).jobs.some(j=>j.kind==='product'),false,'local callback failure cannot cause a remote product reread');
  assert.equal((await restored.replayPending()).applied,0,'persistent local backoff is respected');
  f.advance(60001);const reloaded=createSesumCollector(options);assert.equal((await reloaded.replayPending()).applied,1);
  assert.equal(reloaded.status().jobCountsByKind.product.complete,1);assert.equal(inputs[1].products[0].name,changed.name);assert.equal(inputs[1].fetchedAt,newTime);
  assert.equal((await reloaded.receive(response(work,detail,product(detail)))).duplicate,true,'an older in-flight alias cannot replace the newer source change');
  f.advance(60000);const newer=product(detail,{price:10});newer.product.name='A still newer actual own product';
  await reloaded.receive({...response(work,detail,newer),fetchedAt:'2026-11-09T12:03:00Z'});
  assert.equal(inputs.at(-1).products[0].name,newer.product.name,'a completed canonical job must still accept a newer actual alias receipt');
  assert.equal(reloaded.catalog().items[0].fetchedAt,'2026-11-09T12:03:00Z');assert.ok(saved(f).run.mergedProductJobs[detail.id]);
});

test('a newer partial duplicate retains its repair evidence instead of becoming complete through an older receipt',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,product(detail)));
  const state=saved(f);state.run.jobs.partial={id:'partial',kind:'product',url:productUrl,generation:9,familyIds:['family-0'],status:'partial',attempts:2,createdAt:when,fetchedAt:'2026-11-09T12:01:00Z',errors:['source_schema_changed']};delete state.run.productDedupeVersion;persist(f,state);f.advance(120000);
  const restored=createSesumCollector(f.options);await restored.replayPending();const status=restored.status();assert.equal(status.jobCountsByKind.product.complete,0);assert.equal(status.jobCountsByKind.product.partial,1);
  assert.deepEqual(saved(f).run.jobs.partial.errors,['source_schema_changed']);assert.equal(f.received.length,1,'the older success is preserved as evidence, not reapplied over a later partial read');
  restored.retry({jobIds:['partial'],evidence:'Verified source parser repair.'});assert.equal(restored.work().jobs[0].id,'partial');
});

test('local replay is serialized, bounded by the cycle budget and resumes with original evidence after reload',async t=>{
  const f=fixture(t,{familyCount:2,cycleCalls:2}),urls=[productUrl,'https://www.sesum.no/produkt/124-other-synthetic'];let work=f.client.work();
  for(const [i,job] of work.jobs.entries())await f.client.receive(response(work,job,search(job,{products:i?[]:urls})));
  work=f.client.work();for(const job of work.jobs){const result=product(job);result.product.id=new URL(job.url).pathname.match(/\/(\d+)/)[1];await f.client.receive(response(work,job,result));}
  const state=saved(f);for(const job of Object.values(state.run.jobs).filter(j=>j.kind==='product'))state.run.jobs['copy-'+job.id]={id:'copy-'+job.id,kind:'product',url:job.url,generation:2,status:'pending',familyIds:['family-1'],attempts:0,createdAt:when};
  delete state.run.productDedupeVersion;persist(f,state);
  const inputs=[];let release;const gate=new Promise(resolve=>{release=resolve;}),options={...f.options,config:{...f.options.config,cycleCalls:1},receivePrices:async input=>{inputs.push(input);await gate;return {needsReview:1};}},restored=createSesumCollector(options);
  const first=restored.replayPending(),concurrent=restored.replayPending();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(inputs.length,1,'two normal work callers share one bounded local replay batch');release();
  assert.equal((await first).pending,1);assert.equal((await concurrent).pending,1);assert.equal(inputs.length,1);
  const reloaded=createSesumCollector(options);assert.equal((await reloaded.replayPending()).pending,0);assert.equal(inputs.length,2);
  assert.ok(inputs.every(input=>input.fetchedAt===when&&input.products[0].prices[0].observedAt==='2026-11-09T10:00:00Z'));
  assert.ok(inputs.every(input=>JSON.stringify(input.familyIds)==='["family-1"]'));assert.equal(reloaded.status().status,'complete');
});

for(const recordedEdges of [true,false])test(`a reused completed search ${recordedEdges?'propagates known descendants':'re-reads unknown legacy descendants'} for a newly attached family`,async t=>{
  const f=fixture(t);f.setFamilies([{familyId:'family-0',name:'Synthetic family 0',unit:'kg',queries:['shared']}]);
  let work=f.client.work();const seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();await f.client.receive(response(work,work.jobs[0],product(work.jobs[0])));
  f.setFamilies([{familyId:'family-0',name:'Synthetic family 0',unit:'kg',queries:['shared']},{familyId:'family-1',name:'Synthetic family 1',unit:'kg',queries:['shared']}]);f.client.work({peek:true});
  const state=saved(f);for(const job of Object.values(state.run.jobs))if(job.kind==='search'&&job.generation>0)delete state.run.jobs[job.id];
  if(!recordedEdges)delete state.run.jobs[seed.id].productJobIds;
  const page={id:'late-page',kind:'search',url:sesumUrl(seed.url+'&page=2','search'),generation:0,familyIds:['family-1'],status:'pending',attempts:0,createdAt:when};state.run.jobs[page.id]=page;persist(f,state);
  const restored=createSesumCollector(f.options);await restored.receive(response({runId:work.runId},page,search(page,{next:[seed.url],end:false})));
  if(!recordedEdges){assert.equal(saved(f).run.jobs[seed.id].rescanReason,'missing-search-product-edges');assert.equal(restored.status().status,'collecting');const reread=restored.work();assert.equal(reread.jobs[0].id,seed.id);await restored.receive(response(reread,reread.jobs[0],search(reread.jobs[0],{products:[productUrl]})));}
  assert.equal(f.received.length,2);assert.deepEqual(f.received[1].familyIds,['family-1']);assert.equal(f.received[1].fetchedAt,when);assert.equal(restored.status().jobCountsByKind.product.complete,1);assert.equal(restored.status().status,'complete');
});

test('different observed slugs and a new full run keep independent source fetches',async t=>{
  const f=fixture(t,{cycleCalls:2}),other=productUrl+'-changed';let work=f.client.work();await f.client.receive(response(work,work.jobs[0],search(work.jobs[0],{products:[productUrl,other]})));
  work=f.client.work();assert.equal(work.jobs.length,2);assert.equal(new Set(work.jobs.map(j=>j.url)).size,2,'same numeric ID is not proof that changed source URLs have unchanged metadata');
  for(const job of work.jobs)await f.client.receive(response(work,job,product(job)));
  const previous=work.runId;f.client.refresh();work=f.client.work();assert.notEqual(work.runId,previous);await f.client.receive(response(work,work.jobs[0],search(work.jobs[0],{products:[productUrl]})));
  assert.equal(f.client.work().jobs[0].kind,'product','a full refresh does not replay an older run as a new observation');
});

test('a selected repair keeps priority when its exact-URL duplicate has an older complete receipt',async t=>{
  const f=fixture(t);let work=f.client.work(),seed=work.jobs[0];await f.client.receive(response(work,seed,search(seed,{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,product(detail)));
  const state=saved(f),repair={id:'selected-repair',kind:'product',url:productUrl,generation:3,familyIds:['family-0'],status:'pending',attempts:0,createdAt:when,retryHistory:[{evidence:'Verified concrete parser repair',previousStatus:'partial'}]};
  state.run.jobs[repair.id]=repair;state.run.repairPriority=[repair.id];delete state.run.productDedupeVersion;persist(f,state);
  const restored=createSesumCollector(f.options);await restored.replayPending();assert.equal(restored.work().jobs[0].id,repair.id);assert.deepEqual(saved(f).run.jobs[repair.id].retryHistory,repair.retryHistory);
});

test('a newly attached family refetches an old complete product whose validated observation is missing',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work();await f.client.receive(response(work,work.jobs[0],search(work.jobs[0],{products:[productUrl]})));work=f.client.work();const detail=work.jobs[0];await f.client.receive(response(work,detail,product(detail)));
  const state=saved(f);delete state.run.jobs[detail.id].productObservation;persist(f,state);
  const restored=createSesumCollector(f.options);work=restored.work();const second=work.jobs[0];assert.equal(second.kind,'search');await restored.receive(response(work,second,search(second,{products:[productUrl]})));
  assert.equal(restored.status().jobCountsByKind.product.pending,1);assert.equal(restored.status().replayPendingCount,0);assert.equal(restored.status().status,'collecting');assert.equal(saved(f).run.jobs[detail.id].rescanReason,'missing-validated-product-observation');
  work=restored.work();assert.equal(work.jobs[0].id,detail.id);await restored.receive(response(work,work.jobs[0],product(work.jobs[0])));
  assert.deepEqual(f.received.at(-1).familyIds,['family-0','family-1']);assert.equal(restored.status().status,'complete');
});

test('source queries stay within 64 characters without losing core words or the original descriptor plan',()=>{
  const requested='  Kjøttdeig av ren storfe med lavt fettinnhold til gryter og hverdagsmiddager uten tilsatt smak · uten dokumentert frysemerking  ';
  const [plan]=sesumQueryPlan([requested]);assert.equal(plan.requestedQuery,requested);assert.ok(plan.actualQueries.length>1);
  assert.ok(plan.actualQueries.every(q=>q.length<=64));assert.equal(plan.actualQueries.join(' '),plan.coreQuery,'all product-search words survive at word boundaries');
  assert.deepEqual(plan.descriptorNotes,['uten dokumentert frysemerking']);assert.ok(!plan.actualQueries.includes(plan.descriptorNotes[0]),'library qualification notes are retained separately, not broad descriptor-only requests');
  assert.deepEqual(plan.unsearchableTerms,[]);assert.throws(()=>sesumUrl('https://www.sesum.no/sok?q='+encodeURIComponent('x'.repeat(65)),'search'),/64/);
});

test('query-plan migration retains 109 completed short searches and a collected product while replacing only unsafe long requests',t=>{
  const f=fixture(t,{cycleCalls:8}),shorts=Array.from({length:109},(_,i)=>'short source query '+i),long='Kjøttdeig av ren storfe med lavt fettinnhold til gryter og hverdagsmiddager uten tilsatt smak · uten dokumentert frysemerking';
  const family={familyId:'family-0',name:'Synthetic family 0',unit:'kg',queries:[...shorts,long],requirementsFingerprint:'unchanged-requirements'};f.setFamilies([family]);
  const jobs=Object.fromEntries(shorts.map((q,i)=>{const url=new URL('https://www.sesum.no/sok');url.searchParams.set('q',q);return ['short-'+i,{id:'short-'+i,kind:'search',url:url.href,generation:0,familyIds:['family-0'],status:'complete',attempts:0,createdAt:when,fetchedAt:when,endReached:true,discovered:0,nextJobIds:[]}];}));
  const longUrl=new URL('https://www.sesum.no/sok');longUrl.searchParams.set('q',long);jobs['unsafe-long']={id:'unsafe-long',kind:'search',url:longUrl.href,generation:0,familyIds:['family-0'],status:'pending',attempts:1,createdAt:when,error:{code:'network_error'}};
  const savedProduct={...product({url:productUrl}).product,prices:[],priceCandidates:[],relatedProducts:[]};jobs['collected-product']={id:'collected-product',kind:'product',url:productUrl,generation:0,familyIds:['family-0'],status:'complete',attempts:0,createdAt:when,fetchedAt:when,productObservation:savedProduct};
  const legacy={schemaVersion:1,run:{id:'legacy-run',startedAt:when,finishedAt:null,status:'collecting',fingerprint:'old-planner',families:[{familyId:family.familyId,name:family.name,unit:family.unit,queries:family.queries,fingerprint:family.requirementsFingerprint}],chainCodes:['KIWI','REMA_1000','COOP_EXTRA'],revision:0,jobs},history:[],pauseUntil:null,observations:{}};
  const path=join(f.dataDir,'sesum-collector.json.enc');writeFileSync(path,encrypt(Buffer.from(JSON.stringify(legacy)),f.options.encryptionKey));
  const client=createSesumCollector(f.options),work=client.work({peek:true}),status=client.status();assert.equal(work.runId,'legacy-run');assert.equal(status.jobCountsByKind.search.complete,109);assert.equal(status.jobCountsByKind.product.complete,1);
  assert.ok(work.jobs.length>0&&work.jobs.every(j=>j.kind==='search'&&new URL(j.url).searchParams.get('q').length<=64));assert.equal(f.received.length,0,'saved products are not reapplied or refetched for a planning-only change');
  const after=JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey));for(let i=0;i<109;i++)assert.deepEqual(after.run.jobs['short-'+i],jobs['short-'+i]);
  assert.deepEqual(after.run.jobs['collected-product'],jobs['collected-product']);assert.ok(!after.run.jobs['unsafe-long']);assert.equal(after.run.supersededSearches['unsafe-long'].reason,'source-query-limit-64');
  assert.equal(status.manifest[0].requestedQueries.length,110);assert.equal(status.manifest[0].queryPlan.length,110);assert.equal(client.catalog().items[0].fetchedAt,when);
});

test('an indivisible overlong search term remains an explicit partial constraint, never silently truncated',t=>{
  const f=fixture(t,{queryOverrides:{'family-0':['x'.repeat(65)]}});f.client.work();const status=f.client.status();
  assert.ok(status.manifest[0].unresolvedItems.some(i=>i.reason==='single-term-exceeds-source-limit-64'));
  assert.equal(status.manifest[0].queryPlan.find(p=>p.requestedQuery.length===65).unsearchableTerms[0],'x'.repeat(65));
});

test('all followed families enter the manifest with no arbitrary family cap; peek never claims work',t=>{
  const {client}=fixture(t,{familyCount:121});
  const peek=client.work({peek:true}),work=client.work();
  assert.equal(peek.jobs[0].id,work.jobs[0].id);
  const status=client.status();assert.equal(status.familyCount,121);assert.equal(status.jobCounts.pending,121);assert.equal(status.manifest.reduce((n,f)=>n+f.chains.length,0),363);
  assert.notEqual(client.work().jobs[0].id,work.jobs[0].id);
});

test('pagination and all product details resume encrypted; collection and fresh-price coverage differ',async t=>{
  const f=fixture(t),first=f.client.work(),job=first.jobs[0],next=job.url+'&page=2';
  await f.client.receive(response(first,job,search(job,{products:[productUrl],next:[next],end:false})));
  let work=f.client.work(),detail=work.jobs[0];assert.equal(detail.kind,'product','known product prices should arrive before every search page finishes');
  const result=product(detail,{observedAt:'2023-01-01T00:00:00Z'});
  const receipt=await f.client.receive(response(work,detail,result));assert.equal(receipt.status,'complete');
  assert.equal(f.client.status().status,'collecting');
  const detailWork=work,restored=createSesumCollector(f.options);work=restored.work();const page=work.jobs[0];assert.equal(page.kind,'search');
  await restored.receive(response(work,page,search(page)));
  assert.equal(f.received[0].products[0].prices[0].storeCode,'COOP_EXTRA');
  assert.equal(f.received[0].products[0].prices[0].observedAt,'2023-01-01T00:00:00Z');
  assert.equal(restored.status().status,'complete');assert.equal(restored.status().manifest[0].chains[2].freshProducts,0);
  assert.equal((await restored.receive(response(detailWork,detail,result))).duplicate,true);assert.equal(f.received.length,1);
  assert.ok(!readFileSync(join(f.dataDir,'sesum-collector.json.enc')).includes(Buffer.from('Synthetic family')));
});

test('fair scheduling collects products early and advances every one of 91 families without dropping work',async t=>{
  const f=fixture(t,{familyCount:91,cycleCalls:8});let searched=new Set(),firstPriceAfterSearchCount=null,cycle=0;
  while(f.client.status().status!=='complete'&&cycle++<40){
    const preview=f.client.work({peek:true}),work=f.client.work();assert.deepEqual(preview.jobs.map(j=>j.id),work.jobs.map(j=>j.id),'peek does not advance fair cursors');
    assert.ok(work.jobs.length);assert.equal(new Set(work.jobs.map(j=>j.id)).size,work.jobs.length);
    if(cycle===1){assert.equal(work.jobs.length,8);assert.equal(new Set(work.jobs.map(j=>j.familyIds[0])).size,8,'initial exploration rotates across families');}
    if(cycle===2){assert.equal(work.jobs.filter(j=>j.kind==='product').length,4);assert.equal(work.jobs.filter(j=>j.kind==='search').length,4);}
    for(const job of work.jobs){
      if(job.kind==='search'){
        searched.add(job.familyIds[0]);const id=1000+Number(new URL(job.url).searchParams.get('q').match(/\d+$/)[0]);
        await f.client.receive(response(work,job,search(job,{products:[`https://www.sesum.no/produkt/${id}-synthetic`]})));
      }else{
        if(firstPriceAfterSearchCount===null)firstPriceAfterSearchCount=searched.size;
        const result=product(job);result.product.id=new URL(job.url).pathname.match(/\/produkt\/(\d+)/)[1];await f.client.receive(response(work,job,result));
      }
    }
  }
  const status=f.client.status();assert.equal(status.status,'complete');assert.equal(searched.size,91);assert.equal(f.received.length,91);
  assert.ok(firstPriceAfterSearchCount<91,'products are never starved until discovery finishes');assert.equal(status.jobCountsByKind.search.complete,91);assert.equal(status.jobCountsByKind.product.complete,91);
});

test('freshness ages at read time and unknown receipt dates never become fetch timestamps',async t=>{
  const f=fixture(t,{refreshHours:168});let work=f.client.work(),job=work.jobs[0];
  await f.client.receive(response(work,job,search(job,{products:[productUrl]})));work=f.client.work();job=work.jobs[0];
  await f.client.receive(response(work,job,product(job)));
  assert.equal(f.client.status().manifest[0].chains[2].freshProducts,1);
  f.advance(49*3600000);assert.equal(f.client.status().manifest[0].chains[2].freshProducts,0);
});

test('multiple EANs and unknown weight mode survive; unproven quotes remain raw candidates',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];
  await f.client.receive(response(work,job,search(job,{products:[productUrl]})));work=f.client.work();job=work.jobs[0];
  const result=product(job,{observedAt:null});result.product.ean=['12345678','1234567890123'];result.product.soldByWeight=null;
  result.candidates=[{id:'456',name:'Different synthetic product',sourceUrl:'https://www.sesum.no/produkt/456-other',reason:'site_similarity_not_reviewed',token:'must-not-cross-boundary'}];result.prices[0].cookie='must-not-cross-boundary';
  await f.client.receive(response(work,job,result));
  const received=f.received[0].products[0];assert.deepEqual(received.ean,['12345678','1234567890123']);assert.equal(received.soldByWeight,null);
  assert.equal(received.prices.length,0);assert.equal(received.priceCandidates[0].observedAt,null);assert.equal(received.priceCandidates[0].reason,'missing_price_provenance');
  assert.equal(received.relatedProducts[0].id,'456');assert.ok(!JSON.stringify(received).includes('must-not-cross-boundary'));
  assert.equal(f.client.status().manifest[0].chains[2].freshProducts,0);
});

test('valid EANs and separate short source codes reach encrypted catalog without a PLU identity inference',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];await f.client.receive(response(work,job,search(job,{products:[productUrl]})));work=f.client.work();job=work.jobs[0];
  const result=product(job);result.product.name='Synthetic potatoes';result.product.ean=['1234567890123'];result.product.nonEanCodes=['4073','0001','4073','KIWI-synthetic-64stk'];
  await f.client.receive(response(work,job,result));const received=f.received[0].products[0];assert.deepEqual(received.ean,['1234567890123']);assert.deepEqual(received.nonEanCodes,['4073','0001','KIWI-synthetic-64stk']);
  const restored=createSesumCollector(f.options),saved=restored.catalog().items[0].product;assert.deepEqual(saved.ean,['1234567890123']);assert.deepEqual(saved.nonEanCodes,['4073','0001','KIWI-synthetic-64stk']);assert.equal(saved.prices[0].price,7.9);
});

test('only a selected schema-failed product is retried after a fix; every completed search is retained',async t=>{
  const f=fixture(t,{familyCount:2,cycleCalls:2});let work=f.client.work();
  await f.client.receive(response(work,work.jobs[0],search(work.jobs[0],{products:[productUrl]})));await f.client.receive(response(work,work.jobs[1],search(work.jobs[1])));
  work=f.client.work();const job=work.jobs[0];assert.equal(job.kind,'product');
  await f.client.receive(response(work,job,{ok:false,kind:'product',sourceUrl:job.url,errors:['invalid_ean']},'partial'));
  const path=join(f.dataDir,'sesum-collector.json.enc'),before=JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey));
  assert.throws(()=>f.client.retry({jobIds:[job.id,work.jobs[0].id+'unknown'],evidence:'Parser supports short source codes now.'}),/Ukjent/);
  assert.deepEqual(JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey)),before,'invalid retry batches do not partly mutate progress');
  const receipt=f.client.retry({runId:work.runId,jobIds:[job.id],evidence:'Parser now separates short source codes from EAN.'});assert.deepEqual(receipt.retried,[job.id]);assert.equal(receipt.runId,work.runId);
  const after=JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey));for(const [id,old] of Object.entries(before.run.jobs))if(id!==job.id)assert.deepEqual(after.run.jobs[id],old);
  assert.equal(after.run.jobs[job.id].attempts,0);assert.equal(after.run.jobs[job.id].retryHistory[0].previousErrors[0],'invalid_ean');
  work=f.client.work();assert.deepEqual(work.jobs.map(j=>j.id),[job.id]);const fixed=product(job);fixed.product.ean=['1234567890123'];fixed.product.nonEanCodes=['4073'];await f.client.receive(response(work,job,fixed));
  assert.equal(f.client.status().status,'complete');assert.equal(f.client.status().jobCountsByKind.search.complete,2);assert.equal(f.received.length,1);assert.deepEqual(f.client.catalog().items[0].product.nonEanCodes,['4073']);
});

test('explicit repair jobs get one early slot per four while peek preserves priority and normal family progress',async t=>{
  const f=fixture(t,{familyCount:12,cycleCalls:4}),initial=f.client.work(),repairIds=initial.jobs.map(job=>job.id);
  for(const job of initial.jobs)await f.client.receive(response(initial,job,{ok:false,kind:'search',sourceUrl:job.url,errors:['schema_changed']},'partial'));
  f.client.retry({jobIds:repairIds,evidence:'Verified parser repair; check these exact jobs.'});
  const peek=f.client.work({peek:true});assert.equal(peek.jobs[0].id,repairIds[0]);assert.equal(peek.jobs.filter(job=>repairIds.includes(job.id)).length,1);assert.equal(peek.jobs.length,4);
  assert.deepEqual(f.client.work({peek:true}).jobs.map(job=>job.id),peek.jobs.map(job=>job.id));
  const work=f.client.work();assert.deepEqual(work.jobs.map(job=>job.id),peek.jobs.map(job=>job.id));
  const path=join(f.dataDir,'sesum-collector.json.enc'),claimed=JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey));assert.ok(claimed.run.repairPriority.includes(repairIds[0]),'delivery alone is not a successful repair receipt');
  await f.client.receive(response(work,work.jobs[0],search(work.jobs[0])));
  const acknowledged=JSON.parse(decrypt(readFileSync(path),f.options.encryptionKey));assert.ok(!acknowledged.run.repairPriority.includes(repairIds[0]));assert.equal(f.client.status().familyCount,12);
});

test('repair priority persists but a one-job budget still gives three normal jobs between repairs',async t=>{
  const f=fixture(t,{familyCount:10,cycleCalls:1}),repairIds=[];
  for(let i=0;i<4;i++){const work=f.client.work(),job=work.jobs[0];repairIds.push(job.id);await f.client.receive(response(work,job,{ok:false,kind:'search',sourceUrl:job.url,errors:['schema_changed']},'partial'));}
  f.client.retry({jobIds:repairIds,evidence:'Targeted parser fix verification.'});
  const restored=createSesumCollector(f.options),picked=[];
  for(let i=0;i<5;i++){const work=restored.work(),job=work.jobs[0];assert.equal(work.jobs.length,1);picked.push(repairIds.includes(job.id));await restored.receive(response(work,job,search(job)));}
  assert.deepEqual(picked,[true,false,false,false,true]);assert.equal(restored.status().runId,f.client.status().runId);
});

test('a repair with no receipt stays eligible after its reservation expires',async t=>{
  const f=fixture(t,{familyCount:2,cycleCalls:1,requireSingleBatch:true});let work=f.client.work(),repair=work.jobs[0];
  await f.client.receive(response(work,repair,{ok:false,kind:'search',sourceUrl:repair.url,errors:['schema_changed']},'partial'));
  f.client.retry({jobIds:[repair.id],evidence:'Retry this repaired parser path.'});work=f.client.work();assert.equal(work.jobs[0].id,repair.id);
  assert.deepEqual(f.client.work().jobs,[],'a second worker cannot start while the repair batch is reserved');
  f.advance(5*60000+1);const restored=createSesumCollector(f.options),ordinary=restored.work();assert.notEqual(ordinary.jobs[0].id,repair.id);await restored.receive(response(ordinary,ordinary.jobs[0],search(ordinary.jobs[0])));
  assert.equal(restored.work().jobs[0].id,repair.id);
});

test('retrying selected blocked work cannot clear an authentication pause and needs explicit evidence',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];
  for(let attempt=0;attempt<3;attempt++){
    if(attempt){f.advance(11*60000);work=f.client.work();job=work.jobs[0];}
    await f.client.receive({runId:work.runId,jobId:job.id,status:'error',fetchedAt:when,error:{code:'auth_required',retryAfterMs:600000}});
  }
  const pause=f.client.status().pauseUntil;assert.equal(f.client.status().jobCounts.blocked,1);assert.throws(()=>f.client.retry({jobIds:[job.id]}),/begrunnelse/);
  const receipt=f.client.retry({jobIds:[job.id],evidence:'Retry selected job after normal access is restored.'});assert.equal(receipt.pauseUntil,pause);assert.equal(f.client.status().pauseUntil,pause);assert.deepEqual(f.client.work().jobs,[]);
  assert.equal(createSesumCollector(f.options).status().pauseUntil,pause);f.advance(11*60000);assert.equal(f.client.work().jobs[0].id,job.id);
});

test('similar-product suggestions with null or invalid URLs cannot reject own valid price receipts',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];
  await f.client.receive(response(work,job,search(job,{products:[productUrl]})));work=f.client.work();job=work.jobs[0];
  const result=product(job);result.candidates=[{id:'456',name:'Suggested product',sourceUrl:null,reason:'site_similarity_not_reviewed'},{id:'457',name:'Malformed suggestion',sourceUrl:'https://example.com/anything'},{id:'458',name:'Mismatched suggestion',sourceUrl:'https://www.sesum.no/produkt/459-other'},{id:{toString:'malformed'}},null];
  const receipt=await f.client.receive(response(work,job,result));assert.equal(receipt.status,'complete');
  const received=f.received[0].products[0];assert.equal(received.prices[0].price,7.9);assert.equal(received.relatedProducts.length,3);assert.ok(received.relatedProducts.every(p=>p.sourceUrl===null));
  assert.equal(f.client.status().manifest[0].chains[2].freshProducts,1);
});

test('unpriced own products survive encrypted catalog reload and refresh with separate related suggestions',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];await f.client.receive(response(work,job,search(job,{products:[productUrl]})));work=f.client.work();job=work.jobs[0];
  const result=product(job,{observedAt:null});result.candidates=[{id:'456',name:'Related product',sourceUrl:null,reason:'site_similarity_not_reviewed'}];
  await f.client.receive(response(work,job,result));
  const restored=createSesumCollector(f.options);let catalog=restored.catalog({familyId:'family-0'});assert.equal(catalog.items.length,1);
  const item=catalog.items[0];assert.equal(item.sourceUrl,productUrl);assert.equal(item.fetchedAt,when);assert.equal(item.parsedPriceCount,0);assert.equal(item.unprovenPriceCount,1);assert.equal(item.relatedProductCount,1);
  assert.equal(item.product.priceCandidates[0].observedAt,null);assert.equal(item.product.relatedProducts[0].id,'456');assert.equal(item.product.prices.length,0);assert.equal(restored.status().manifest[0].chains[2].freshProducts,0);
  const originalRun=catalog.runId;f.advance(60000);restored.refresh();catalog=restored.catalog();assert.notEqual(catalog.runId,originalRun);assert.equal(catalog.items[0].runId,originalRun);assert.equal(catalog.items[0].fetchedAt,when,'a refresh never renews an old observation');
  assert.equal(restored.catalog({familyId:'other-family'}).items.length,0);assert.equal(f.received.length,1,'reading the catalog never reapplies a price');
});

test('a failed price callback retains validated source evidence without completing the product job',async t=>{
  const f=fixture(t),client=createSesumCollector({...f.options,receivePrices:()=>{throw Error('Synthetic callback rejection');}});let work=client.work(),job=work.jobs[0];
  await client.receive(response(work,job,search(job,{products:[productUrl]})));work=client.work();job=work.jobs[0];
  await assert.rejects(client.receive(response(work,job,product(job))),/callback rejection/);
  const item=client.catalog().items[0];assert.equal(item.collectionStatus,'pending');assert.equal(item.callbackError,'Synthetic callback rejection');assert.equal(item.fetchedAt,when);assert.equal(item.product.id,'123');
  assert.equal(client.status().jobCounts.pending,1);assert.equal(client.status().manifest[0].chains[2].freshProducts,0);
});

test('all 91 families keep local query overrides while unknown fields and malformed callback fields are guarded',async t=>{
  const queryOverrides=Object.fromEntries(Array.from({length:91},(_,i)=>['family-'+i,['override '+i,'synonym '+i]]));
  const f=fixture(t,{familyCount:91,queryOverrides});const work=f.client.work();assert.equal(f.client.status().familyCount,91);assert.equal(f.client.status().jobCounts.pending,273);
  assert.ok(f.client.status().manifest.every(row=>row.queries.length===3&&row.queries.some(q=>q.startsWith('synthetic'))&&row.queries.some(q=>q.startsWith('override'))&&row.queries.some(q=>q.startsWith('synonym'))));
  const job=work.jobs[0];await f.client.receive(response(work,job,search(job,{products:[productUrl]})));
  // Use a single-family fixture so the own-product job is the next eligible job.
  const own=fixture(t);let next=own.client.work(),searchJob=next.jobs[0];await own.client.receive(response(next,searchJob,search(searchJob,{products:[productUrl]})));next=own.client.work();const detail=next.jobs[0];
  for(const patch of [{brand:{cookie:'private'}},{vendor:'v'.repeat(301)},{weight:-1},{weightUnit:'g'.repeat(31)},{soldByWeight:'false'},{ean:Array(31).fill('12345678')},{ean:['1234567890123','4073']},{nonEanCodes:['not a code']},{nonEanCodes:['12345678']},{nonEanCodes:Array(31).fill('4073')}]){
    const result=product(detail);Object.assign(result.product,patch);await assert.rejects(own.client.receive(response(next,detail,result)),/Sesum/);
  }
  assert.equal(own.received.length,0);const valid=product(detail);valid.product.cookie='must-not-cross';valid.prices[0].token='must-not-cross';
  await own.client.receive(response(next,detail,valid));assert.ok(!JSON.stringify(own.received).includes('must-not-cross'));
});

test('completed zero-match searches differ from pending; implementation receipts need a successful versioned result',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work(),job=work.jobs[0];
  assert.equal(f.client.status().implementationReceipt,null);assert.equal(f.client.status().familyCounts.pending,2);
  await f.client.receive({...response(work,job,search(job)),collectorVersion:'sesum-collector-1.7.0',collectorBuild:'sesum-collector-build-1.7.0-3'});
  let status=f.client.status();assert.equal(status.familyCounts.no_matches,1);assert.equal(status.familyCounts.pending,1);
  assert.equal(status.manifest.find(f=>f.collectionOutcome==='no_matches').completedZeroMatchQueries.length,1);
  assert.equal(status.implementationReceipt.collectorVersion,'sesum-collector-1.7.0');assert.equal(status.implementationReceipt.collectorBuild,'sesum-collector-build-1.7.0-3');assert.equal(status.implementationReceipt.jobId,job.id);
  work=f.client.work();job=work.jobs[0];await f.client.receive(response(work,job,search(job)));
  status=f.client.status();assert.equal(status.familyCounts.no_matches,2);assert.equal(status.implementationReceipt.collectorVersion,'sesum-collector-1.7.0');
});

test('source transport backoff is shared and a later shorter pause cannot erase a 429 pause',async t=>{
  const f=fixture(t,{familyCount:2,cycleCalls:2}),work=f.client.work();
  await f.client.receive({runId:work.runId,jobId:work.jobs[0].id,status:'error',fetchedAt:when,error:{code:'rate_limited',retryAfterMs:1800000}});
  const longPause=f.client.status().pauseUntil;f.advance(60000);
  await f.client.receive({runId:work.runId,jobId:work.jobs[1].id,status:'error',fetchedAt:when,error:{code:'network_error',retryAfterMs:300000}});
  assert.equal(f.client.status().pauseUntil,longPause);assert.deepEqual(f.client.work().jobs,[]);
  f.advance(1800000);assert.equal(f.client.work().jobs.length,2);
});

test('unproved search endings remain partial; schema failures do not stop other families',async t=>{
  const f=fixture(t,{familyCount:2});let work=f.client.work(),job=work.jobs[0];
  await f.client.receive(response(work,job,search(job,{end:false})));
  assert.equal(f.client.status().manifest[0].collectionStatus,'partial');
  work=f.client.work();job=work.jobs[0];
  await f.client.receive(response(work,job,{ok:false,kind:'search',sourceUrl:job.url,errors:['schema_changed']},'partial'));
  assert.equal(f.client.status().status,'partial');assert.equal(f.client.status().jobCounts.partial,2);
});

test('an active search filter cannot certify an exhaustive family search, even with next pages',async t=>{
  const f=fixture(t);let work=f.client.work(),job=work.jobs[0];
  const filtered=search(job,{next:[job.url+'&page=2'],end:false});filtered.errors=['active_search_filter'];
  await f.client.receive(response(work,job,filtered));work=f.client.work();job=work.jobs[0];
  await f.client.receive(response(work,job,search(job)));
  assert.equal(f.client.status().status,'partial');assert.equal(f.client.status().manifest[0].collectionStatus,'partial');
});

test('source pauses persist and changed-family jobs invalidate without discarding the run',async t=>{
  const f=fixture(t);const work=f.client.work(),job=work.jobs[0];
  await f.client.receive({runId:work.runId,jobId:job.id,status:'error',fetchedAt:when,error:{code:'rate_limited',retryAfterMs:1800000}});
  const restored=createSesumCollector(f.options);assert.deepEqual(restored.work().jobs,[]);assert.ok(restored.status().pauseUntil);
  f.setFamilies([{familyId:'family-0',name:'Changed requirement',unit:'kg'}]);
  const changed=restored.work();assert.equal(changed.runId,work.runId);assert.equal(restored.status().familyCount,1);
  await assert.rejects(restored.receive(response(work,job,search(job))),/utgått/);
});

test('family additions retain completed work and pagination cycles remain partial',async t=>{
  const f=fixture(t);let work=f.client.work(),first=work.jobs[0];
  await f.client.receive(response(work,first,search(first)));
  f.setFamilies([{familyId:'family-0',name:'Synthetic family 0',unit:'kg',queries:['synthetic 0']},{familyId:'new-family',name:'New family',unit:'kg',queries:['new query']}]);
  work=f.client.work();const page=work.jobs[0];assert.equal(work.runId,f.client.status().runId);assert.equal(f.client.status().jobCounts.complete,1);
  const next=page.url+'&page=2';await f.client.receive(response(work,page,search(page,{next:[next],end:false})));
  work=f.client.work();const second=work.jobs[0];await f.client.receive(response(work,second,search(second,{next:[page.url],end:false})));
  assert.equal(f.client.status().status,'partial');assert.equal(f.client.status().manifest.find(x=>x.familyId==='family-0').collectionStatus,'complete');
});

test('offsite jobs, changed query pagination, future receipts and foreign senders are rejected',async t=>{
  assert.throws(()=>sesumUrl('https://example.com/sok?q=synthetic','search'));
  assert.throws(()=>sesumUrl('https://www.sesum.no/api/private','product'));
  assert.equal(sesumSenderAllowed({host:'127.0.0.1:4318',origin:'https://www.sesum.no','x-family-request':'1'},{extension:true,write:true}),false);
  assert.equal(sesumSenderAllowed({host:'127.0.0.1:4318',origin:'chrome-extension://'+'a'.repeat(32),'x-family-request':'1'},{extension:true,write:true}),true);
  assert.equal(sesumSenderAllowed({host:'127.0.0.1:4318',origin:'chrome-extension://'+'a'.repeat(32)},{extension:true,write:true}),false);
  const f=fixture(t),work=f.client.work(),job=work.jobs[0];
  await assert.rejects(f.client.receive(response(work,job,search(job,{next:['https://www.sesum.no/sok?q=other&page=2'],end:false}))),/endret/);
  await f.client.receive(response(work,job,search(job,{products:[productUrl]})));const detailWork=f.client.work(),detail=detailWork.jobs[0];
  await assert.rejects(f.client.receive(response(detailWork,detail,product(detail,{observedAt:'2099-01-01T00:00:00Z'}))),/prisdato/);
  assert.equal(f.received.length,0);
});
