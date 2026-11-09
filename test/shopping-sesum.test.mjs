import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSesumCollector,sesumSenderAllowed,sesumUrl} from '../src/shopping-sesum.mjs';

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
  for(const patch of [{brand:{cookie:'private'}},{vendor:'v'.repeat(301)},{weight:-1},{weightUnit:'g'.repeat(31)},{soldByWeight:'false'},{ean:Array(31).fill('12345678')}]){
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
