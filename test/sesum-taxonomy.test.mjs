import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShoppingCoordinator} from '../src/shopping-coordinator.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSesumTaxonomy} from '../src/sesum-taxonomy.mjs';
import {createShoppingAssortment} from '../src/shopping-assortment.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {shoppingAgentJobs} from '../src/shopping-agent-jobs.mjs';
import {agentManifest} from '../src/shopping-agent-context.mjs';
import {applyWorkerProposal,planShoppingWorkers} from '../src/shopping-worker-contract.mjs';
import {buildExplorerData} from '../src/library-explorer.mjs';
import {prepareExplorer,explore,familySummaries,emptyFilters} from '../public/library-explorer-core.mjs';
const at='2026-11-11T12:00:00Z';
const categories=[{id:'46',name:'Kylling og fjærkre',parentId:null,sourceUrl:'https://www.sesum.no/kategori/46-kylling-og-fjaerkre'},{id:'283',name:'And',parentId:'46',sourceUrl:'https://www.sesum.no/kategori/283-and'},{id:'284',name:'And',parentId:'283',sourceUrl:'https://www.sesum.no/kategori/284-and'},{id:'2112',name:'Andefett',parentId:'283',sourceUrl:'https://www.sesum.no/kategori/2112-andefett'}];
const config={enabled:true,familySource:'sesum',priceHorizonDays:14};
const product=(id=1,extra={})=>({id:String(id),name:'Synthetic duck',brand:'Synthetic',weight:300,weightUnit:'g',soldByWeight:false,categoryPathIds:['46','283','284'],sourceUrl:`https://www.sesum.no/produkt/${id}-synthetic`,prices:[{storeCode:'KIWI',price:30,observedAt:at,source:'actual-native-receipt'}],...extra});
const oda=(id=10,extra={})=>({id,name:'Synthetic Oda duck',description:'Actual raw plain duck breast.',url:`https://oda.com/no/products/${id}-synthetic-duck/`,price:'39.00',unitPrice:'130.00',unitName:'kilogram',availability:{isAvailable:true},...extra});
function fixture(){const state={};let base=null,time=new Date(at);const catalogue=createShoppingAssortment(state,{config,now:()=>time,reader:()=>base}),taxonomy=createSesumTaxonomy(state,{now:()=>time,rows:()=>Object.values(state.products),baseReader:()=>catalogue.overlay(base)});taxonomy.receive({categories,fetchedAt:at});return {state,catalogue,taxonomy,advance:ms=>time=new Date(+time+ms)};}
test('native taxonomy retains exact IDs, identical names at distinct levels and the actual source hierarchy',()=>{
 const f=fixture();assert.equal(f.taxonomy.status().categories,4);const result=f.taxonomy.search('And');assert.ok(result.items.some(c=>c.id==='283'&&c.name==='And'));assert.ok(result.items.some(c=>c.id==='284'&&c.name==='And'));assert.deepEqual(result.items.find(c=>c.id==='284').path.map(c=>c.id),['46','283','284']);
 const revision=f.state.revision;f.taxonomy.receive({categories,fetchedAt:'2026-11-11T12:01:00Z'});assert.equal(f.state.revision,revision,'unchanged taxonomy never rewrites every category per price-page read');
 assert.throws(()=>f.taxonomy.receive({categories:[{id:'283',name:'And',parentId:'284'}],fetchedAt:at}),/cyclic/);
});
test('native Sesum own category path places products in code without independent-family agent jobs',()=>{
 const f=fixture();f.catalogue.receiveSesum({products:[product()],fetchedAt:at});assert.deepEqual(f.catalogue.work(),[]);assert.deepEqual(f.taxonomy.work(),[]);assert.throws(()=>f.catalogue.classify({}),/disabled/);
 const reader=f.taxonomy.reader();assert.deepEqual(Object.keys(reader.index().groups).sort(),['sesum-category:2112','sesum-category:283','sesum-category:284','sesum-category:46'].sort());assert.equal(reader.members('sesum-category:284').length,1);assert.equal(reader.members('sesum-category:283').length,1);assert.equal(reader.members('sesum-category:284')[0].unitPrice,100);assert.equal(reader.index().familySource,'sesum');
});
test('Sesum is master for covered chains: another Kassal store row does not create a duplicate taxonomy product',()=>{
 const f=fixture();f.catalogue.receiveSesum({products:[product()],fetchedAt:at});f.catalogue.receiveKassal({data:[{id:22,name:'Synthetic different API duplicate',store:{code:'KIWI'},current_price:{price:1,date:at}}],fetchedAt:at});const index=f.taxonomy.reader().index();assert.deepEqual(Object.keys(index.products),['sesum:KIWI:1']);
});
test('only current unplaced native Oda identities require category work and cannot create new categories',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda()],observedAt:at});const work=f.taxonomy.work();assert.equal(work.length,1);assert.equal(work[0].productKey,'oda:ODA_NO:10');const row=f.taxonomy.dossier(work[0].productKey),category=f.taxonomy.definition('284');
 assert.throws(()=>f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'999',reviewed:true,evidence:'Actual raw duck breast read against source categories.'}),/current native/);
 f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'284',categoryFingerprint:category.fingerprint,reviewed:true,evidence:'Actual Oda raw duck breast belongs in the native leaf And, under And and Kylling og fjærkre.'});assert.equal(f.taxonomy.work().length,0);assert.equal(f.taxonomy.reader().members('sesum-category:284')[0].unitPrice,130);
});
test('Oda price updates retain a placement, material product/category changes reopen it and stale/unavailable products stay parked',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda()],observedAt:at});const row=f.taxonomy.dossier('oda:ODA_NO:10');f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'284',categoryFingerprint:f.taxonomy.definition('284').fingerprint,reviewed:true,evidence:'Actual native Oda raw duck belongs to the precise existing leaf And category.'});
 f.advance(1000);f.catalogue.receiveOda({products:[oda(10,{price:'36.00',unitPrice:'120.00'})],observedAt:'2026-11-11T12:00:01Z'});assert.equal(f.taxonomy.work().length,0);assert.equal(f.taxonomy.reader().members('sesum-category:284')[0].unitPrice,120);
 f.catalogue.receiveOda({products:[oda(10,{description:'Changed actual prepared and flavoured duck product.'})],observedAt:'2026-11-11T12:00:01Z'});assert.equal(f.taxonomy.work().length,1);f.advance(15*86400000);assert.equal(f.taxonomy.work().length,0);
});
test('the 91 household records retain stocks and paid needs while their category links use exact native source categories',()=>{
 const f=fixture();f.catalogue.receiveSesum({products:[product()],fetchedAt:at});const families=Array.from({length:91},(_,i)=>({familyId:'basic-'+i,name:'Synthetic staple '+i,stockAmount:3,purchaseAmount:12,products:[{source:'sesum',id:'1',productKey:'sesum:KIWI:1',reviewCurrent:true}]})),before=structuredClone(families),links=f.taxonomy.watchLinks(families);
 assert.equal(links.length,91);assert.ok(links.every(l=>l.categoryId==='284'));assert.deepEqual(families,before);assert.equal(links[0].groupId,'sesum-category:284');
});
test('same category with mixed measurement units never ranks kilograms against litres as one cheapest price',()=>{
 const f=fixture();f.catalogue.receiveSesum({products:[product(),product(2,{weight:500,weightUnit:'ml',prices:[{storeCode:'KIWI',price:10,observedAt:at,source:'actual-native-receipt'}]})],fetchedAt:at});const read=f.taxonomy.reader();assert.equal(read.group('sesum-category:284').unit,null);assert.ok(read.members('sesum-category:284').every(m=>m.unitPrice===null));
 const {data}=buildExplorerData(read.index(),{imageRef:()=>null,chainName:x=>x,active:read.active,horizonDays:14}),model=prepareExplorer(data);assert.equal(model.familySource,'sesum');const result=explore(model,emptyFilters(),Date.parse(at)),family=familySummaries(model,result).find(f=>f.family.id==='sesum-category:284');assert.equal(family.min,null);assert.equal(family.offers.length,0);
});
test('scoped workers receive only an Oda placement and on-demand native category search, without the 91 family matrix',()=>{
 const state={},shop=shoppingStore(state,{save(){},now:()=>new Date(at),assortmentConfig:config});shop.settings({monitoringEnabled:true,stores:[]});shop.taxonomy.receive({categories,fetchedAt:at});
 for(let i=0;i<91;i++)shop.watch({id:'basic-'+i,name:'Synthetic staple '+i,unit:'kg',storage:'pantry'});
 // This test isolates the category contract; household-scoped production jobs
 // use reviewed native catalogue bindings rather than all search hits.
 for(let i=10;i<16;i++)shop.assortment.receiveOda({products:[oda(i)],observedAt:at});
 const all=Array.from({length:6},(_,i)=>{const row=shop.taxonomy.dossier('oda:ODA_NO:'+(i+10));return {do:'shopping-oda-category',productKey:row.productKey,assortmentFingerprint:row.sourceFingerprint,fingerprint:row.sourceFingerprint};});
 assert.equal(shoppingAgentJobs(all).length,6);assert.equal(planShoppingWorkers(all,3,{independent:true,limit:2}).batches.length,3);
});

test('household source-category association needs current requirements and never changes stock or authorizes a product',()=>{
 const families=[{familyId:'duck',name:'Duck breast',requirementsFingerprint:'requirements-1',stockAmount:4,purchaseAmount:8,products:[]}],state={},before=structuredClone(families);
 const taxonomy=createSesumTaxonomy(state,{now:()=>new Date(at),watchFamilies:()=>families});taxonomy.receive({categories,fetchedAt:at});
 const input={familyId:'duck',requirementsFingerprint:'requirements-1',categoryId:'284',categoryFingerprint:taxonomy.definition('284').fingerprint,reviewed:true,evidence:'The household needs duck breast; native Sesum leaf And holds actual raw duck products. This associates navigation only.'};
 taxonomy.linkWatch(input);assert.equal(taxonomy.watchLinks(families)[0].categoryId,'284');assert.deepEqual(families,before);assert.equal(taxonomy.work().length,0);
 families[0].requirementsFingerprint='requirements-2';assert.equal(taxonomy.watchLinks(families)[0].status,'needs-category');assert.throws(()=>taxonomy.linkWatch(input),/current household/);
});

test('Oda import accepts only official native Oda product URLs',()=>{
 const f=fixture();assert.throws(()=>f.catalogue.receiveOda({products:[oda(10,{url:'https://example.org/no/products/10-synthetic/'})],observedAt:at}),/URL and product ID/);assert.throws(()=>f.catalogue.receiveOda({products:[oda(10,{url:'https://oda.com/no/products/11-other/'})],observedAt:at}),/URL and product ID/);
});

test('an actual Oda metre quote compares metres without deriving a package or comparing roll counts',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda(10,{unitName:'meter',unitPrice:'0.50',description:'4 rolls, actual documented length is separate.'})],observedAt:at});const row=f.taxonomy.dossier('oda:ODA_NO:10');assert.equal(row.product.unit,'m');assert.equal(row.product.pack,null);assert.equal(row.product.quote.grossUnitPrice,.5);
});

test('three scoped workers finish actual Oda-category jobs through the coordinator and cannot create categories',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'family-oda-category-')),launches=[],state={runLease:{token:'synthetic-oda-lease'}};
 t.after(()=>{for(const launch of launches){assert.ok(launch.directory.startsWith(join(tmpdir(),'family-shopping-worker-')));rmSync(launch.directory,{recursive:true,force:true});}rmSync(directory,{recursive:true,force:true});});
 const shop=shoppingStore(state,{save(){},now:()=>new Date(at),assortmentConfig:config});shop.settings({monitoringEnabled:true,stores:[]});shop.watch({id:'duck',name:'Synthetic raw duck breast',unit:'kg',storage:'frozen'});shop.taxonomy.receive({categories,fetchedAt:at});
 for(let id=10;id<16;id++){
  const entry=shop.catalogObserve({watchId:'duck',products:[{id:String(id+100),store:'ODA_NO',name:'Synthetic raw duck breast',ingredients:'Raw duck breast',weight:300,weightUnit:'g',sourceUrl:oda(id).url,currentPrice:39,lastChecked:at}]}).entries[0];
  shop.catalogReview({watchId:'duck',id:entry.id,store:'ODA_NO',fingerprint:entry.fingerprint,status:'approved',packAmount:.3,unit:'kg',equivalenceEvidence:'Read actual synthetic raw duck breast contents and the exact fixed 300 g package.'});shop.assortment.receiveOda({products:[oda(id)],observedAt:at});
 }
 const queue=shop.queue().filter(i=>i.do==='shopping-oda-category'),plan=planShoppingWorkers(queue,3,{independent:true,limit:2});assert.equal(queue.length,6);
 const coordinator=createShoppingCoordinator({store:{shopping:shop,snapshot:()=>state,profile:()=>({timezone:'Europe/Oslo'})},root:directory,dataDir:directory,endpoint:'http://127.0.0.1:1/worker',clock:()=>Date.parse(at),alive:()=>true,shouldYield:()=>false,launch:input=>{launches.push(input);return {pid:111};}});coordinator.start({token:state.runLease.token,batches:plan.batches});assert.equal(launches.length,3);
 for(let index=0;index<3;index++){const launch=launches[index],call=(name,input)=>coordinator.handle(launch.workerId,launch.token,name,input),manifest=agentManifest(plan.batches[index]);
  for(const job of manifest.jobs){const header=await call('shopping_context',{refresh:true,focus:'all'});for(const [section,pages] of Object.entries(header.requiredPages))for(const page of pages)await call('shopping_context',{section,page});
   const found=await call('shopping_read',{kind:'group-search',query:'And'});assert.ok(found.items.some(c=>c.id==='284'));const packet=shop.agentContext(manifest);assert.ok(packet.products.find(p=>p.productKey===job.productKey).taxonomy.sourceObservation);
   const result=await call('shopping_propose',{proposalId:'oda-category-'+job.productKey.split(':').at(-1),contextFingerprint:packet.contextFingerprint,operation:'oda-category',input:{productKey:job.productKey,categoryId:'284',reviewed:true,evidence:'Actual native Oda product dossier identifies raw plain duck breast; source leaf And is below And and Kylling og fjærkre.'}});assert.equal(result.saved,true);
  }
 }
 assert.equal(shop.taxonomy.status().odaPlacedProducts,6);assert.equal(shop.taxonomy.work().length,0);assert.equal(shop.taxonomy.status().categories,4);
});


test('a newer unavailable Oda master receipt parks the older available Kassal alias of that same native product',()=>{
 const f=fixture();f.catalogue.receiveKassal({fetchedAt:at,data:[{id:77,name:'Synthetic old available duck',store:{code:'ODA_NO'},url:oda(10).url,current_price:{price:39,date:at}}]});
 f.advance(1000);f.catalogue.receiveOda({products:[oda(10,{availability:{isAvailable:false}})],observedAt:'2026-11-11T12:00:01Z'});assert.equal(f.taxonomy.dossier('oda:ODA_NO:10'),null);assert.equal(f.taxonomy.work().length,0);assert.equal(f.taxonomy.status().odaCurrentProducts,0);
});

test('category placement does not recompile the unchanged price catalogue',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda()],observedAt:at});const before=f.catalogue.overlay(null).index(),row=f.taxonomy.dossier('oda:ODA_NO:10');f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'284',categoryFingerprint:f.taxonomy.definition('284').fingerprint,reviewed:true,evidence:'Read actual raw duck product and native source category And.'});assert.equal(f.catalogue.overlay(null).index(),before);
 f.catalogue.receiveOda({products:[oda(10,{price:'30.00'})],observedAt:'2026-11-11T12:00:01Z'});assert.notEqual(f.catalogue.overlay(null).index(),before);
});

test('actual retired Oda page records an availability receipt without fabricating an MCP price',()=>{
 const f=fixture(),input={product:oda(10,{availability:{isAvailable:false}}),sourceReceipt:{url:oda(10).url,observedAt:at,evidence:'Actual native Oda product page explicitly says no longer available.'}};f.catalogue.receiveOdaAvailability(input);const row=f.catalogue.dossier('oda:ODA_NO:10');assert.equal(row.available,false);assert.equal(row.active,false);assert.equal(row.prices[0].receiptAt,null);assert.equal(row.prices[0].grossPackPrice,null);assert.equal(row.raw.sourceKind,'actual-oda-product-page');assert.equal(f.taxonomy.work().length,0);assert.throws(()=>f.catalogue.receiveOdaAvailability({...input,product:oda()}),/unavailable-product/);
});

test('native source shelves keep their exact names and broad root categories do not imply equivalence price gaps',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda()],observedAt:at});const row=f.taxonomy.dossier('oda:ODA_NO:10');f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'284',categoryFingerprint:f.taxonomy.definition('284').fingerprint,reviewed:true,evidence:'Actual raw duck dossier and existing native source category And.'});
 const reader=f.taxonomy.reader(),{data}=buildExplorerData(reader.index(),{imageRef:()=>null,chainName:x=>x,active:reader.active,horizonDays:14}),model=prepareExplorer(data),result=explore(model,emptyFilters(),Date.parse(at)),summaries=familySummaries(model,result);assert.equal(model.shelves[model.families.find(f=>f.id==='sesum-category:46').shelf].name,'Kylling og fjærkre');assert.equal(summaries.find(r=>r.family.id==='sesum-category:46').min,null);assert.equal(summaries.find(r=>r.family.id==='sesum-category:284').min,130);
});

test('a disabled native-category example never replaces the existing explorer or enables native worker jobs',()=>{
 const shop=shoppingStore({},{save(){},now:()=>new Date(at),assortmentConfig:{enabled:false,familySource:'sesum'}});assert.equal(shop.taxonomy,null);assert.deepEqual(shop.assortment.work(),[]);assert.equal(shop.assortment.status().enabled,false);
});

test('complete Sesum snapshots retire removed categories while partial receipts preserve unrelated definitions and history',()=>{
 const f=fixture();f.catalogue.receiveOda({products:[oda()],observedAt:at});const row=f.taxonomy.dossier('oda:ODA_NO:10');f.taxonomy.place({productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:'284',categoryFingerprint:f.taxonomy.definition('284').fingerprint,reviewed:true,evidence:'Actual raw duck product and the native source category And were read.'});
 f.taxonomy.receive({categories:[categories[0]],fetchedAt:at});assert.equal(f.taxonomy.status().categories,4);f.taxonomy.receive({categories:[categories[0]],completeTree:true,fetchedAt:at});assert.equal(f.taxonomy.status().categories,1);assert.equal(f.taxonomy.definition('284'),null);assert.equal(f.taxonomy.work().length,1);assert.equal(f.taxonomy.reader().group('sesum-category:284'),null);assert.ok(f.state.categories['284'].retiredAt);assert.ok(f.state.categoryPlacements['oda:ODA_NO:10']);
 assert.throws(()=>f.taxonomy.receive({categories:[categories[2]],completeTree:true,fetchedAt:at}),/Incomplete/);f.taxonomy.receive({categories,completeTree:true,fetchedAt:at});assert.equal(f.taxonomy.status().categories,4);assert.equal(f.taxonomy.work().length,0);
});
