import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {createShoppingAssortment,kassalAssortmentRows} from '../src/shopping-assortment.mjs';
import {createAssortmentCollection,kassalNextPage,sesumCatalogueUrl} from '../src/assortment-collection.mjs';
import {groupMetadataFingerprint} from '../src/product-library.mjs';
import {sesumSourceFingerprint} from '../src/sesum-prices.mjs';
import {createShoppingCoordinator} from '../src/shopping-coordinator.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {shoppingAgentJobs} from '../src/shopping-agent-jobs.mjs';
import {agentManifest} from '../src/shopping-agent-context.mjs';
import {applyWorkerProposal,planShoppingWorkers,workerOperationGuide} from '../src/shopping-worker-contract.mjs';
import {searchAssortmentFamilies} from '../src/assortment-family-search.mjs';
const sandbox={module:{exports:{}},URL,TextEncoder};runInNewContext(readFileSync(new URL('../config/vigilo-keepalive/sesum-core.js',import.meta.url),'utf8'),sandbox);const core=sandbox.module.exports;
const at='2026-11-11T12:00:00Z',config={enabled:true,collectionEnabled:true,priceHorizonDays:14};
const group={id:'duck-breast-plain',name:'Duck breast, raw plain',category:'Meat',canonicalUnit:'kg',inclusionCriteria:'Plain raw duck breast across brands; frozen state remains explicit.',exclusions:['Duck legs','Sous-vide or flavoured prepared meat'],qualityBasis:'Actual duck content and processing, missing nutrition is unknown.',comparisonBasis:'Gross price per kg of verified net edible product.'};
const receipt={url:'https://producer.example.test/duck',observedAt:at,evidence:'Read the actual complete primary label: raw plain duck breast, no added flavour or cooking.'};
const sesum=(id=1,overrides={})=>({id:String(id),name:'Synthetic duck breast',brand:'Synthetic',weight:300,weightUnit:'g',soldByWeight:false,sourceUrl:`https://www.sesum.no/produkt/${id}-synthetic`,prices:[{storeCode:'KIWI',price:90,observedAt:at,source:'actual-own-chain-receipt'}],...overrides});
function fixture(){let time=new Date(at),base=null;const state={},api=createShoppingAssortment(state,{config,now:()=>time,reader:()=>base});return {api,state,setBase:v=>base=v,advance:ms=>time=new Date(+time+ms),ingest:p=>api.receiveSesum({fetchedAt:time.toISOString(),products:[p]})};}
function decision(api,key='sesum:CATALOGUE:1',extra={}){return {productKey:key,sourceFingerprint:api.dossier(key).sourceFingerprint,status:'reviewed',contentsReviewed:true,groupSearchReviewed:true,evidence:'Read actual raw duck contents and searched all relevant existing global definitions.',groups:[group],memberships:[{groupId:group.id,groupFingerprint:groupMetadataFingerprint(group),equivalenceEvidence:'Actual raw plain duck breast contents and preparation fit this reusable family.',qualityEvidence:'Duck content and raw form were verified; nutritional differences remain unknown.'}],sourceReceipts:[receipt],product:{ingredients:'Duck breast',description:'Raw plain duck breast; not cooked or flavoured.'},...extra};}

test('whole assortment classification creates a new family with no household watches or search hints; pack remains unknown',()=>{
 const f=fixture();f.ingest(sesum());assert.equal(f.api.work().length,1);f.api.classify(decision(f.api));assert.equal(f.api.work().length,0);assert.equal(f.api.status().classifiedProducts,1);
 const reader=f.api.overlay(null),rows=reader.members(group.id);assert.equal(rows.length,1);assert.equal(rows[0].reviewCurrent,true);assert.equal(rows[0].eligible,false);assert.equal(rows[0].unitPrice,null);assert.equal(reader.product('sesum:KIWI:1').pack,null);
 assert.throws(()=>f.api.classify(decision(f.api,undefined,{memberships:[]})),/explicit family/);
 assert.throws(()=>f.api.classify(decision(f.api,undefined,{product:{canonicalPackAmount:.3,unit:'kg'}})),/pack evidence/);
});
test('same Sesum product has one agent job and keeps all real chain prices separate, including chains outside household stores',()=>{
 const f=fixture();f.ingest(sesum(1,{prices:[...sesum().prices,{storeCode:'JOKER',price:95,observedAt:at,source:'actual-own-chain-receipt'}]}));assert.equal(f.api.work().length,1);
 f.api.classify(decision(f.api,undefined,{product:{canonicalPackAmount:.3,unit:'kg',packEvidence:'Read this exact primary fixed consumer pack: total net contents 300 g.'}}));const reader=f.api.overlay(null);
 assert.equal(reader.members(group.id).length,2);assert.equal(reader.quote('sesum:JOKER_NO:1').price.grossPackPrice,95);assert.equal(reader.members(group.id).find(r=>r.productKey==='sesum:KIWI:1').unitPrice,300);
});
test('actual price horizon parks unknown, stale, future, unavailable rows without deleting reviews; newer receipts reactivate',()=>{
 const f=fixture();for(const [i,prices] of [[1,[{...sesum().prices[0],observedAt:'2026-10-01T12:00:00Z'}]],[2,[{...sesum().prices[0],observedAt:null}]],[3,[{...sesum().prices[0],observedAt:'2026-11-12T12:00:00Z'}]]])f.ingest(sesum(i,{prices}));f.ingest(sesum(4,{available:false}));assert.equal(f.api.work().length,0);assert.equal(f.api.status().parkedProducts,4);
 f.ingest(sesum(1));f.api.classify(decision(f.api));const fp=f.api.dossier('sesum:CATALOGUE:1').sourceFingerprint;f.advance(15*86400000);assert.equal(f.api.work().length,0);assert.equal(f.api.overlay(null).members(group.id).length,0);assert.equal(f.api.status().parkedProducts,4);
 f.ingest(sesum(1,{prices:[{...sesum().prices[0],observedAt:'2026-11-26T12:00:00Z'}]}));assert.equal(f.api.dossier('sesum:CATALOGUE:1').sourceFingerprint,fp);assert.equal(f.api.work().length,0);assert.equal(f.api.status().classifiedProducts,1);
});
test('price-only updates preserve semantic reviews, metadata changes and group changes reopen them; household changes are irrelevant',()=>{
 const f=fixture();f.ingest(sesum());f.api.classify(decision(f.api));const prior=f.api.dossier('sesum:CATALOGUE:1').sourceFingerprint;
 f.advance(1000);f.ingest(sesum(1,{prices:[{...sesum().prices[0],price:80}]}));assert.equal(f.api.dossier('sesum:CATALOGUE:1').sourceFingerprint,prior);assert.equal(f.api.work().length,0);assert.equal(f.api.overlay(null).quote('sesum:KIWI:1').price.grossPackPrice,80);
 f.ingest(sesum(1,{name:'Synthetic sous-vide duck with garlic'}));assert.equal(f.api.work().length,1);assert.equal(f.state.products['sesum:CATALOGUE:1'].history.length,1);assert.throws(()=>f.api.classify({...decision(f.api),sourceFingerprint:prior}),/source changed/);
 const other=fixture();other.ingest(sesum());other.api.classify(decision(other.api));other.state.groups[group.id].inclusionCriteria='Changed raw duck requirements';assert.equal(other.api.work().length,1);
});
test('blocked grouping is counted separately, returns after retry, remains unresolved and is not a household-negative completion',()=>{
 const f=fixture();f.ingest(sesum());f.api.classify(decision(f.api,undefined,{status:'blocked',reason:'Missing actual contents and processing label.',retryAt:'2026-11-11T13:00:00Z'}));assert.equal(f.api.work().length,0);assert.equal(f.api.status().remainingProducts,1);assert.equal(f.api.status().blockedProducts,1);assert.equal(f.api.status().complete,false);f.advance(3600000);assert.equal(f.api.work().length,1);
});
test('concurrent family creation reuses identical definitions and rejects conflicting definitions before partial writes',()=>{
 const f=fixture();f.ingest(sesum());f.ingest(sesum(2));f.api.classify(decision(f.api));f.api.classify(decision(f.api,'sesum:CATALOGUE:2'));assert.equal(f.api.status().newFamilies,1);
 const before=JSON.stringify(f.state);assert.throws(()=>f.api.classify(decision(f.api,'sesum:CATALOGUE:2',{groups:[{...group,inclusionCriteria:'All duck including legs and prepared meat'}]})),/different criteria/);assert.equal(JSON.stringify(f.state),before);
});
test('Kassal catalogue uses actual matching price receipts, keeps missing EAN and all native chain identities, does not silently drop another grocery product type',()=>{
 const raw={id:1,name:'Synthetic duck',ean:null,store:{code:'MENY_NO'},url:'https://shop.example.test/duck',weight:300,weight_unit:'g',current_price:20,updated_at:at,price_history:[{price:30,date:at}]};
 const input={data:[raw,{...raw,id:2,store:{code:'SPAR_NO'},current_price:{price:22,date:at}},{...raw,id:3,is_medicine:true,current_price:{price:22,date:at}}],fetchedAt:at};
 const rows=kassalAssortmentRows(input,Date.parse(at));assert.equal(rows[0].prices[0].receiptAt,null);assert.equal(rows[0].metadata.ean,null);assert.notEqual(rows[0].productKey,rows[1].productKey);
 const f=fixture();f.api.receiveKassal(input);assert.deepEqual(f.api.work().map(r=>r.productKey),['kassal:SPAR_NO:2','kassal:MENY_NO:3']);
});
test('whole source classification is part of existing frozen three-worker pipeline; legacy no-family receipt cannot suppress it',()=>{
 const state={},shop=shoppingStore(state,{save:()=>{},now:()=>new Date(at),assortmentConfig:config});shop.settings({monitoringEnabled:true,stores:[]});
 for(let i=0;i<91;i++)shop.watch({id:'followed-'+i,name:'Synthetic household need '+i,unit:'kg',storage:'pantry'});
 for(let i=1;i<=6;i++)shop.assortment.receiveSesum({products:[sesum(i)],fetchedAt:at});
 state.shopping.sesumPlacementReviews['sesum:KIWI:1']={status:'no-active-family'};
 const queue=shop.queue().filter(r=>r.do==='shopping-assortment-review'),plan=planShoppingWorkers(queue,3,{independent:true,limit:2});assert.equal(plan.batches.length,3);
 const assignment=agentManifest(plan.batches[0]),packet=shop.agentContext(assignment);assert.equal(packet.families.length,0);assert.equal(packet.products.length,2);assert.deepEqual(packet.assignmentChanges,[]);
 const key=packet.products[0].productKey;applyWorkerProposal({store:{shopping:shop},assignment,packet,operation:'assortment-classify',input:decision(shop.assortment,key)});assert.equal(shop.assortment.status().classifiedProducts,1);assert.equal(shop.assortment.status().remainingProducts,5);
 const current=shop.agentContext(assignment);assert.equal(current.jobs.length,1);assert.equal(current.activeStagesEmpty,false);assert.equal(shop.completion().complete,false,'no full sweep receipt');
 assert.throws(()=>applyWorkerProposal({store:{shopping:shop},assignment,packet:current,operation:'assortment-classify',input:decision(shop.assortment,'sesum:CATALOGUE:6')}),/assigned/);
 assert.ok(workerOperationGuide(['shopping-assortment-review']).includes('group-search'));
});
test('Sesum general and household stages share one whole product job without joining other products by name or EAN',()=>{
 const rows=[{do:'shopping-assortment-review',productKey:'sesum:CATALOGUE:1',assortmentFingerprint:'fp'},{do:'shopping-sesum-placement-review',sourceKey:'sesum:KIWI:1',relatedSources:[{sourceKey:'sesum:REMA_1000:1'}]},{do:'shopping-assortment-review',productKey:'sesum:CATALOGUE:2'}];
 const jobs=shoppingAgentJobs(rows);assert.equal(jobs.length,2);assert.equal(jobs[0].items.length,2);assert.equal(jobs[0].productKey,'sesum:CATALOGUE:1');assert.equal(jobs[0].sourceKeys.length,2);
});
test('family search pages complete definitions, ranks actual names and rejects changed result snapshots',()=>{
 const groups=Object.fromEntries(Array.from({length:55},(_,i)=>['duck-'+i,{name:'Duck breast '+i,category:'Meat',inclusion:'Actual raw duck contents',exclusions:['Egg'],fingerprint:'fp'+i}]));
 const index={groups},first=searchAssortmentFamilies(index,'duck breast',{limit:20});assert.equal(first.total,55);assert.equal(first.items.length,20);assert.ok(first.items[0].exclusions.includes('Egg'));const second=searchAssortmentFamilies(index,'duck breast',{offset:first.nextOffset,limit:20,expectedFingerprint:first.fingerprint});assert.equal(second.items.length,20);assert.equal(new Set([...first.items,...second.items].map(r=>r.groupId)).size,40);
 groups['duck-0'].inclusion='Changed actual contents';assert.throws(()=>searchAssortmentFamilies(index,'duck breast',{expectedFingerprint:first.fingerprint}),/changed/);assert.equal(searchAssortmentFamilies(index,'egg').total,0,'negative criteria do not become positive retrieval hints');
});
test('general library overlay parks old base products at the configured horizon without changing the household/history horizon',()=>{
 const index={groups:{},members:{},qualityNotes:{},products:{'kassal:MENY_NO:9':{name:'Synthetic old',source:'kassal',store:'MENY_NO',available:true,quote:{receiptAt:'2026-10-01T12:00:00Z',reasons:[]}}}};
 const base=createIndexReader(index,{horizonDays:183})(Date.parse(at)),f=fixture();assert.equal(base.active('kassal:MENY_NO:9'),true);f.setBase(base);const reader=f.api.overlay(base);assert.equal(reader.horizonDays,183);assert.equal(reader.active('kassal:MENY_NO:9'),false);assert.equal(base.active('kassal:MENY_NO:9'),true);
});

test('Kassal pagination requires explicit end and unchanged full-catalogue scope',()=>{
 const data=[{id:1}],url='https://kassal.app/api/v1/products?page=2&size=100&unique=0&sort=date_asc';assert.equal(kassalNextPage({data,links:{next:url}},1).next,2);assert.equal(kassalNextPage({data,links:{next:null}},1).next,null);
 for(const result of [{data},{data,links:{next:url.replace('unique=0','unique=1')}},{data,links:{next:url.replace('page=2','page=1')}},{data,links:{next:url+'&search=duck'}},{data,links:{next:url.replace('kassal.app','evil.example.test')}}])assert.throws(()=>kassalNextPage(result,1));
 assert.throws(()=>sesumCatalogueUrl('https://www.sesum.no/kategori/1-test?uten_butikk=KIWI'));assert.throws(()=>sesumCatalogueUrl('https://www.sesum.no/api/private'));
});
function collectionFixture(t,options={}){const dataDir=mkdtempSync(join(tmpdir(),'family-assortment-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));const seen=[],settings={dataDir,config,encryptionKey:Buffer.alloc(32,23),now:()=>new Date(at),receiveSesum:async input=>seen.push(input),receiveKassal:async input=>seen.push(input),...options};return {seen,settings,api:createAssortmentCollection(settings)};}
test('full Sesum catalogue crawl is durable, source-ID deduplicated, unfiltered and callbacks replay without refetch',async t=>{
 let fail=true;const f=collectionFixture(t,{receiveSesum:async input=>{if(fail){fail=false;throw Error('Synthetic local write failure');}f.seen.push(input);}});assert.equal(f.api.work().enabled,false);f.api.start();let work=f.api.work(),job=work.jobs[0];
 await f.api.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:['https://www.sesum.no/produkt/1-first','https://www.sesum.no/produkt/1-other-slug'],nextUrls:[],endReached:true,filtersVerified:true,total:1}});
 const restarted=createAssortmentCollection(f.settings);work=restarted.work();job=work.jobs[0];assert.equal(job.kind,'product');assert.equal(work.jobs.length,1);assert.equal(job.publicCatalogue,true);
 await assert.rejects(restarted.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'product',sourceUrl:job.url,product:{...sesum(),sourceUrl:job.url},prices:sesum().prices}}),/local write/);
 const again=createAssortmentCollection(f.settings);await again.step();assert.equal(f.seen.length,1);assert.equal(again.status().sesum.remaining,0);assert.equal(again.status().collectionComplete,false,'Kassal is still unfinished');
});
test('Kassal listing page callback replays durably, independent of family queries and without another API call',async t=>{
 let calls=0,fail=true;const result={data:[{id:1,name:'Synthetic duck',store:{code:'MENY_NO'},current_price:{price:10,date:at}}],links:{next:null},fetchedAt:at};
 const f=collectionFixture(t,{kassal:{status:()=>({configured:true}),catalogue:async input=>{calls++;assert.equal(input.page,1);return result;}},receiveKassal:async input=>{if(fail){fail=false;throw Error('Synthetic callback failure');}f.seen.push(input);}});f.api.start();assert.equal((await f.api.step()).blocked,true);assert.equal(calls,1);
 const restored=createAssortmentCollection({...f.settings,now:()=>new Date('2026-11-11T13:00:00Z')});await restored.step();assert.equal(calls,1);assert.equal(f.seen.length,1);assert.equal(restored.status().kassal.completeSweep,true);
});
const flight=data=>'<script>self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify(data)+'\n'])+')</script>';
test('public category parser proves index counts, rejects selected-chain/promo filters and requires explicit page ends',()=>{
 const index='<h1>Alle kategorier</h1><p>2 kategorier med varer</p><a href="/kategori/1-duck">Duck</a><a href="/kategori/2-home">Home</a>'+flight({});
 assert.equal(core.parseCatalogue(index,'https://www.sesum.no/kategori').ok,true);assert.equal(core.parseCatalogue(index.replace('2 kategorier','3 kategorier'),'https://www.sesum.no/kategori').ok,false);
 const state={query:'',categoryId:1,chains:[],filter:{onlyPromo:false,onlyEco:false}},html='<h1>Duck</h1><p>1 varer i ditt utvalg</p><a href="/produkt/1-duck">Duck</a>'+flight(state);
 assert.equal(core.parseCatalogue(html,'https://www.sesum.no/kategori/1-duck').endReached,true);
 assert.equal(core.parseCatalogue(html.replace('1 varer','2 varer'),'https://www.sesum.no/kategori/1-duck').ok,false);
 assert.equal(core.parseCatalogue(html+flight({...state,chains:['kiwi']}),'https://www.sesum.no/kategori/1-duck').ok,false);
 assert.equal(core.parseCatalogue(html+flight({...state,filter:{onlyPromo:true}}),'https://www.sesum.no/kategori/1-duck').ok,false);
 assert.equal(core.parseCatalogue(html,'https://www.sesum.no/kategori/1-duck?tilbud=1').ok,false);
});

test('unchanged exact reviewed Sesum metadata reuses full primary receipts; a changed source cannot inherit them',()=>{
 const f=fixture();f.ingest(sesum());f.api.classify(decision(f.api));const indexed=f.api.overlay(null).index(),native=indexed.products['sesum:KIWI:1'];native.sourceFingerprint=sesumSourceFingerprint({...sesum(),id:'1',store:'KIWI',vendor:null,ean:[],nonEanCodes:[]});
 const base=createIndexReader(indexed)(Date.parse(at)),next=fixture();next.setBase(base);next.ingest(sesum());assert.equal(next.api.status().reusedReviews,1);assert.equal(next.api.work().length,0);
 next.ingest(sesum(1,{weight:500}));assert.equal(next.api.work().length,1);assert.equal(next.api.status().reusedReviews,0);
});
test('variable-weight source never becomes a fixed package or a package price from its numeric chain quote',()=>{
 const f=fixture();f.ingest(sesum(1,{soldByWeight:true}));assert.equal(f.api.work().length,1);
 assert.throws(()=>f.api.classify(decision(f.api,undefined,{product:{canonicalPackAmount:.3,unit:'kg',packEvidence:'A guessed approximate weight must never be treated as a fixed consumer pack.'}})),/variable-weight/);
 f.api.classify(decision(f.api));const reader=f.api.overlay(null);assert.equal(reader.product('sesum:KIWI:1').pack,null);assert.equal(reader.quote('sesum:KIWI:1').price.grossPackPrice,null);assert.equal(reader.members(group.id)[0].eligible,false);
});
test('full three-worker coordinator accepts scoped real product reviews and current global-family search reads',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-assortment-coordinator-')),launches=[],state={runLease:{token:'synthetic-assortment-lease'}};
 t.after(()=>{for(const launch of launches){assert.ok(launch.directory.startsWith(join(tmpdir(),'family-shopping-worker-')));rmSync(launch.directory,{recursive:true,force:true});}rmSync(directory,{recursive:true,force:true});});
 const shop=shoppingStore(state,{save(){},now:()=>new Date(at),assortmentConfig:config});shop.settings({monitoringEnabled:true,stores:[]});
 for(let i=1;i<=6;i++)shop.assortment.receiveSesum({products:[sesum(i)],fetchedAt:at});
 const coordinator=createShoppingCoordinator({store:{shopping:shop,snapshot:()=>state,profile:()=>({timezone:'Europe/Oslo'})},root:directory,dataDir:directory,endpoint:'http://127.0.0.1:1/worker',clock:()=>Date.parse(at),alive:()=>true,shouldYield:()=>false,launch:input=>{launches.push(input);return {pid:111};}});
 const plan=planShoppingWorkers(shop.queue().filter(i=>i.do==='shopping-assortment-review'),3,{independent:true,limit:2});coordinator.start({token:state.runLease.token,batches:plan.batches});assert.equal(launches.length,3);
 for(let index=0;index<3;index++){
  const launch=launches[index],call=(name,input)=>coordinator.handle(launch.workerId,launch.token,name,input),manifest=agentManifest(plan.batches[index]);
  for(const job of manifest.jobs){
   const header=await call('shopping_context',{refresh:true,focus:'all'});for(const [section,pages] of Object.entries(header.requiredPages))for(const page of pages)await call('shopping_context',{section,page});
   const search=await call('shopping_read',{kind:'group-search',query:'duck breast'});assert.equal(search.total,index===0&&job===manifest.jobs[0]?0:1);
   const packet=shop.agentContext(manifest),input=decision(shop.assortment,job.productKey,{groups:search.total?[]:[group]});
   const result=await call('shopping_propose',{proposalId:'classify-native-'+job.productKey.split(':').at(-1),contextFingerprint:packet.contextFingerprint,operation:'assortment-classify',input});assert.equal(result.saved,true);
  }
 }
 assert.equal(shop.assortment.status().classifiedProducts,6);assert.equal(shop.assortment.status().remainingProducts,0);assert.equal(shop.queue().filter(i=>i.do==='shopping-assortment-review').length,0);
});
test('bounded live validation cannot expand into an unattended catalogue sweep after restart',async t=>{
 const f=collectionFixture(t);f.api.start({validationReads:1});const work=f.api.work(),job=work.jobs[0];await f.api.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:['https://www.sesum.no/kategori/1-duck'],productUrls:[],nextUrls:[],endReached:true,filtersVerified:true,total:1}});
 assert.equal(f.api.work().enabled,false);const restored=createAssortmentCollection(f.settings);assert.equal(restored.work().enabled,false);assert.equal((await restored.step()).paused,true);assert.equal(restored.status().collectionComplete,false);
});

test('large mixed catalogue does code-only freshness filtering and deduplicates jobs before agent allocation',()=>{
 const f=fixture(),start=performance.now(),count=10000;
 for(let offset=0;offset<count;offset+=100)f.api.receiveKassal({fetchedAt:at,data:Array.from({length:100},(_,j)=>{const n=offset+j+1;return {id:n,name:n%3?'Synthetic food':'Synthetic cleaning product',store:{code:n%2?'MENY_NO':'SPAR_NO'},current_price:{price:30,date:n%4===0?'2024-01-01T12:00:00Z':at},ingredients:'Synthetic complete source contents',weight:500,weight_unit:'g'};})});
 const queue=f.api.work(),jobs=shoppingAgentJobs(queue),plan=planShoppingWorkers(queue,3,{independent:true,limit:5});assert.equal(queue.length,7500);assert.equal(jobs.length,7500);assert.equal(new Set(jobs.map(j=>j.productKey)).size,7500);assert.equal(plan.batches.length,3);assert.equal(plan.batch.jobs.length,15);assert.ok(performance.now()-start<10000,'code-only preparation should remain bounded on 10,000 rows');
});

test('explicit full category view is allowed and small categories prove an end despite the view parameter',()=>{
 const url='https://www.sesum.no/kategori/283-and?visning=alle';assert.equal(sesumCatalogueUrl(url),url);
 const html='<h1>And</h1><p>1 varer i ditt utvalg</p><a href="/produkt/1-duck">Duck</a>'+flight({query:'',categoryId:283,chains:[],filter:{onlyPromo:false}});const result=core.parseCatalogue(html,url);assert.equal(result.ok,true);assert.equal(result.endReached,true);assert.equal(result.categoryName,'And');
 assert.equal(core.parseCatalogue(html,url.replace('visning=alle','visning=tilbud')).ok,false);
});

test('bounded native bootstrap cannot consume the full frontier and persists its auto-pause',async t=>{
 const f=collectionFixture(t,{config:{...config,familySource:'sesum'},receiveCategories:async()=>{}});f.api.start();const initial=f.api.work(),root=initial.jobs[0];
 await f.api.receive({runId:initial.runId,jobId:root.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:root.url,categoryUrls:['https://www.sesum.no/kategori/46-duck'],productUrls:['https://www.sesum.no/produkt/999-unrelated'],nextUrls:[],endReached:true,filtersVerified:true,total:1}});
 f.api.pause();f.api.bootstrap({productUrls:['https://www.sesum.no/produkt/1-synthetic']});const work=f.api.work();assert.deepEqual(new Set(work.jobs.map(j=>j.kind)),new Set(['catalogue','product']));assert.ok(work.jobs.every(j=>!j.url.includes('999')&&!j.url.includes('/46-')));
 for(const job of work.jobs)await f.api.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:job.kind==='catalogue'?{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:[],nextUrls:[],endReached:true,filtersVerified:true,total:1,categories:[{id:'46',name:'Duck',parentId:null}]}:{ok:true,kind:'product',sourceUrl:job.url,product:{...sesum(),categoryPathIds:['46'],sourceUrl:job.url},prices:sesum().prices}});
 const restored=createAssortmentCollection(f.settings);assert.equal(restored.status().bootstrap.status,'complete');assert.equal(restored.status().paused,true);assert.equal(restored.status().collectionComplete,false);assert.equal(restored.work().jobs.length,0);assert.ok(restored.status().sesum.remaining>=2);assert.equal((await restored.step()).kassal.pagesRead,0);
});

test('a finished source bootstrap without category metadata is an explicit paused gap',async t=>{
 const f=collectionFixture(t,{config:{...config,familySource:'sesum'}});f.api.bootstrap();const work=f.api.work(),job=work.jobs[0];
 await f.api.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:[],nextUrls:[],endReached:true,filtersVerified:true,total:0}});
 assert.equal(f.api.status().paused,true);assert.equal(f.api.status().bootstrap.status,'category-metadata-missing');assert.equal(f.api.status().bootstrap.missingCategoryReceipts.length,1);
});

test('selected category collection reuses current known observations without new price dates or unrelated category expansion',async t=>{
 const stored=fixture();stored.ingest(sesum());const prior=stored.api.dossier('sesum:CATALOGUE:1'),f=collectionFixture(t,{config:{...config,familySource:'sesum'},receiveCategories:async()=>{},reuseSesum:input=>stored.api.attachSesumCategories(input)});
 f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/46-duck']});let work=f.api.work();
 for(const job of work.jobs)await f.api.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:['https://www.sesum.no/kategori/99-unrelated'],productUrls:job.url.includes('/46-')?['https://www.sesum.no/produkt/1-synthetic','https://www.sesum.no/produkt/2-new']:[],nextUrls:[],endReached:true,filtersVerified:true,total:2,categories:[{id:'46',name:'Duck',parentId:null},{id:'99',name:'Unrelated',parentId:null}]}});
 const again=createAssortmentCollection(f.settings);work=again.work();assert.equal(work.jobs.length,1);assert.ok(work.jobs[0].url.includes('/2-'));assert.ok(!work.jobs.some(j=>j.url.includes('/99-')));
 const after=stored.api.dossier('sesum:CATALOGUE:1');assert.deepEqual(after.prices,prior.prices);assert.equal(after.sourceFingerprint,prior.sourceFingerprint);assert.equal(after.fetchedAt,prior.fetchedAt);
});

test('native catalogue navigation preserves the explicit all-category name in a navigation section',()=>{
 const html='<h1>Alle kategorier</h1><p>2 kategorier med varer</p><a href="/kategori/1-frukt-gront">Frukt &amp; grønt</a><a href="/kategori/2-frukt">Frukt</a>'+flight({categories:[{id:1,name:'Mer frukt & grønt',alle:'Frukt & grønt',children:[{id:2,name:'Frukt',children:[]}]}]});
 const result=core.parseCatalogue(html,'https://www.sesum.no/kategori');assert.equal(result.ok,true);assert.equal(result.categories.find(c=>c.id==='1').name,'Frukt & grønt');assert.equal(result.categories.find(c=>c.id==='2').parentId,'1');
});

test('native leaf URLs are canonical while parent categories explicitly select the full list',async t=>{
 let leafKnown=false;const f=collectionFixture(t,{config:{...config,familySource:'sesum'},categoryIsLeaf:id=>leafKnown&&id==='545'});f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/545-beans','https://www.sesum.no/kategori/107-coffee']});const initial=f.api.work(),leaf=initial.jobs.find(j=>j.url.includes('/545-'));assert.equal(new URL(leaf.url).search,'?visning=alle');
 for(const job of initial.jobs)await f.api.receive({runId:initial.runId,jobId:job.id,status:job.id===leaf.id?'error':'ok',fetchedAt:at,collectorVersion:'sesum-collector-1.9.0',...(job.id===leaf.id?{error:{code:'network_error'}}:{result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:[],nextUrls:[],endReached:true,filtersVerified:true,total:job.url.endsWith('/kategori')?2:0,categories:[{id:'107',name:'Coffee',parentId:null},{id:'545',name:'Beans',parentId:'107'}]}})});
 leafKnown=true;const restored=createAssortmentCollection(f.settings),work=restored.work();assert.equal(work.runId,initial.runId);assert.equal(work.jobs.length,1);assert.equal(work.jobs[0].url,'https://www.sesum.no/kategori/545-beans');assert.equal(restored.status().bootstrap.retainedOutsideScope,0);assert.equal(restored.status().sesum.implementationReceipt.collectorVersion,'sesum-collector-1.9.0');
});

test('the one-product native category spelling proves a complete source end',()=>{
 const html='<h1>Synthetic sugar</h1><p>1 vare i ditt utvalg</p><a href="/produkt/1-sugar">Synthetic sugar</a>'+flight({query:'',categoryId:9204,chains:[],filter:{onlyPromo:false}});const result=core.parseCatalogue(html,'https://www.sesum.no/kategori/9204-sugar');assert.equal(result.ok,true);assert.equal(result.total,1);assert.equal(result.endReached,true);
});

test('explicit later source pages omit the first-page full-view parameter to avoid canonical redirects',t=>{
 const f=collectionFixture(t);f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/107-coffee?side=2&visning=alle']});const job=f.api.work().jobs.find(j=>j.url.includes('/107-'));assert.equal(job.url,'https://www.sesum.no/kategori/107-coffee?side=2');
});

test('unchanged bootstrap membership is not rewritten into every encrypted progress transaction',t=>{
 const f=collectionFixture(t),urls=Array.from({length:500},(_,i)=>'https://www.sesum.no/produkt/'+(i+1)+'-synthetic');f.api.bootstrap({productUrls:urls});const file=join(f.settings.dataDir,'assortment-collection.transactions.enc.jsonl'),before=readFileSync(file).length;for(let i=0;i<100;i++){f.api.pause();f.api.resume();}const growth=readFileSync(file).length-before;assert.ok(growth<300000,'progress transactions must not grow with all 501 selected IDs');const restored=createAssortmentCollection(f.settings);assert.equal(restored.status().bootstrap.jobs,501);assert.equal(restored.work().jobs.length,8);
});

test('selected listing count drift is reconciled twice, survives restart and never loses discovered products',async t=>{
 const f=collectionFixture(t,{config:{...config,familySource:'sesum'},reuseSesum:({productIds})=>productIds});f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/46-duck']});let api=f.api;
 const deliver=async(job,total,ids,nextUrls=[])=>api.receive({runId:api.status().runId,jobId:job.id,status:'ok',fetchedAt:at,result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:ids.map(id=>'https://www.sesum.no/produkt/'+id+'-synthetic'),nextUrls,endReached:!nextUrls.length,filtersVerified:true,total,categories:job.url.endsWith('/kategori')?[{id:'46',name:'Duck',parentId:null}]:[]}});
 for(const job of api.work().jobs)await deliver(job,job.url.endsWith('/kategori')?1:3,job.url.endsWith('/kategori')?[]:[1],job.url.endsWith('/kategori')?[]:['https://www.sesum.no/kategori/46-duck?side=2']);
 await deliver(api.work().jobs[0],2,[2]);assert.equal(api.status().bootstrap.reconciliationRounds['46'],1);assert.equal(api.status().paused,false);
 api=createAssortmentCollection(f.settings);assert.equal(api.work({peek:true}).jobs.length,2);
 // A product removed between reads remains in the durable selection. The
 // pages must agree on both their total and their actual distinct IDs.
 for(const job of api.work().jobs)await deliver(job,1,job.url.includes('side=2')?[]:[1]);
 assert.equal(api.status().bootstrap.status,'complete');assert.equal(api.status().bootstrap.products.jobs,2);assert.equal(api.status().bootstrap.countMismatches.length,0);assert.throws(()=>api.resume(),/ended/);assert.equal(api.work().jobs.length,0);
 api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/46-duck']});
 for(let round=0;round<3;round++)for(const job of api.work().jobs)await deliver(job,job.url.endsWith('/kategori')?1:2,job.url.endsWith('/kategori')?[]:[1]);
 assert.equal(api.status().bootstrap.status,'listing-count-mismatch');assert.equal(api.status().paused,true);assert.equal(api.status().bootstrap.reconciliationRounds['46'],2);assert.equal(api.status().bootstrap.countMismatches.length,1);
});

test('a new selection refreshes completed pages and stale products while an active selection cannot be overwritten',async t=>{
 let time=new Date(at),reusable=true;const f=collectionFixture(t,{now:()=>time,config:{...config,familySource:'sesum'},reuseSesum:({productIds})=>reusable?productIds:[]});f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/46-duck']});
 const deliver=async job=>f.api.receive({runId:f.api.status().runId,jobId:job.id,status:'ok',fetchedAt:time.toISOString(),result:{ok:true,kind:'catalogue',sourceUrl:job.url,categoryUrls:[],productUrls:job.url.endsWith('/kategori')?[]:['https://www.sesum.no/produkt/1-synthetic'],nextUrls:[],endReached:true,filtersVerified:true,total:1,categories:[{id:'46',name:'Duck',parentId:null}]}});
 assert.throws(()=>f.api.bootstrap({productUrls:['https://www.sesum.no/produkt/999-other']}),/unfinished/);for(const job of f.api.work().jobs)await deliver(job);assert.equal(f.api.status().bootstrap.status,'complete');
 time=new Date(+time+15*86400000);reusable=false;f.api.bootstrap({categoryUrls:['https://www.sesum.no/kategori/46-duck']});for(const job of f.api.work().jobs)await deliver(job);
 const restored=createAssortmentCollection(f.settings),work=restored.work();assert.equal(work.jobs.length,1);assert.equal(work.jobs[0].kind,'product');assert.equal(restored.status().bootstrap.products.reused,0);assert.equal(restored.status().bootstrap.status,'collecting');
});
