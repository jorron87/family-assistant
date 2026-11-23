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
test('one odd unit in a category drops only its own unit price, never the whole category',()=>{
 const f=fixture(),odd=product(3,{weight:12,weightUnit:'ml',prices:[{storeCode:'KIWI',price:15,observedAt:at,source:'actual-native-receipt'}]}),loose=product(4,{weight:null,weightUnit:null});
 f.catalogue.receiveSesum({products:[product(),product(2,{weight:600,weightUnit:'g'}),odd,loose],fetchedAt:at});const read=f.taxonomy.reader();
 assert.equal(read.group('sesum-category:284').unit,'kg');const price=new Map(read.members('sesum-category:284').map(m=>[m.productKey,m.unitPrice]));
 assert.equal(price.get('sesum:KIWI:1'),100);assert.equal(price.get('sesum:KIWI:2'),50);assert.equal(price.get('sesum:KIWI:3'),null);assert.equal(price.get('sesum:KIWI:4'),null);
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

test('a household follows separate leaves without promoting their shared parent or a sibling',()=>{
 const state={},families=[{familyId:'staple',name:'Two forms',requirementsFingerprint:'rules',products:[]}];
 const taxonomy=createSesumTaxonomy(state,{now:()=>new Date(at),watchFamilies:()=>families});
 taxonomy.receive({categories,fetchedAt:at});
 const input={familyId:'staple',requirementsFingerprint:'rules',reviewed:true,evidence:'Two specific forms have been read against their distinct source category definitions.'};
 const bind=id=>({id,fingerprint:taxonomy.definition(id).fingerprint});
 state.categoryWatchLinks.staple={...input,categoryId:'283',categoryFingerprint:bind('283').fingerprint};
 assert.equal(taxonomy.watchLinks(families)[0].status,'needs-category');
 assert.throws(()=>taxonomy.linkWatch({...input,categories:[bind('283')]}),/leaf/);
 taxonomy.linkWatch({...input,categories:[bind('284'),bind('2112')]});
 assert.deepEqual(taxonomy.watchLinks(families)[0].categoryIds,['284','2112']);
 assert.equal(taxonomy.watchLinks(families)[0].groupId,null);
 const parent={raw:{categoryPathIds:['46','283']},sourceCategories:[{id:'284'}]};
 assert.equal(taxonomy.sourceCategory(parent),'284');
 parent.sourceCategories.push({id:'2112'});
 assert.equal(taxonomy.sourceCategory(parent),'283');
});

test('a fresh, reviewed shop pack earns one stock-up alert against the chosen Oda product',async()=>{
 const {subcategoryPrices}=await import('../src/shopping-subcategories.mjs');
 const url='https://oda.com/no/products/10-synthetic/',cat={id:'284',name:'And',groupId:'sesum-category:284'};
 const base={watchId:'duck',kind:'catalog',unit:'kg',packAmount:1,lastChecked:at};
 const options={reader:{members:()=>[{productKey:'sesum:KIWI:9',product:{name:'Different variant',store:'KIWI',unit:'kg',available:true,packKnown:true,pack:1},price:{reasons:[],fresh:true,grossPackPrice:1,receiptAt:at}}]},
  links:[{watchId:'duck',categories:[cat]}],families:[{familyId:'duck',unit:'kg',name:'Plain duck',products:[]}],
  quotes:[{...base,name:'Usual Oda pack',sourceUrl:url,price:100,unitPrice:100,store:'ODA_NO',storeName:'Oda'},
   {...base,name:'Reviewed shop pack',price:60,unitPrice:60,store:'KIWI',storeName:'KIWI'}],
  stores:[{id:'shop',chainCode:'KIWI',name:'KIWI',minSavings:10}],choice:()=>10,skipAlerts:new Set(),
  planning:()=>({need:{amount:12},stock:{amount:0,known:true},shelfMonths:3,maxPacks:10,referenceCap:90})};
 const result=subcategoryPrices(options);
 assert.equal(result.comparisons[0].store.unitPrice,1);
 assert.equal(result.alerts[0].productName,'Reviewed shop pack');
 assert.equal(result.alerts[0].packs,3);assert.equal(result.alerts[0].saving,90);
 const trip=result.storeFindings[0];
 assert.deepEqual(trip.totals,{count:1,cost:180,odaSaving:120,saving:90});
 assert.equal(trip.worthTrip,true);
 assert.equal(trip.families[0].items.find(p=>p.identity===trip.families[0].plannedIdentity).estimate.packs,3);
 const uncertain=subcategoryPrices({...options,planning:()=>({...options.planning(),stock:{amount:null,known:false}})}).storeFindings[0];
 assert.equal(uncertain.totals.count,0);assert.equal(uncertain.checkStock.odaSaving,120);
 const stocked=subcategoryPrices({...options,planning:()=>({...options.planning(),stock:{amount:12,known:true}})}).storeFindings[0];
 assert.equal(stocked.totals.count,0);assert.equal(stocked.families[0].items.find(p=>p.reviewed).estimate.status,'covered');
 assert.deepEqual(subcategoryPrices({...options,choice:()=>11}).alerts,[]);
 assert.deepEqual(subcategoryPrices({...options,planning:()=>({...options.planning(),stock:{amount:12,known:true}})}).alerts,[]);
 assert.deepEqual(subcategoryPrices({...options,stores:[{...options.stores[0],minSavings:100}]}).alerts,[]);
 const unreviewed=subcategoryPrices({...options,quotes:options.quotes.slice(0,1)});
 assert.deepEqual(unreviewed.alerts,[]);
 assert.deepEqual(unreviewed.signals,[],'a different product on the same shelf cannot trigger a dashboard alert');
 const shelfRow=(id,store,unitPrice)=>({productKey:'sesum:'+store+':'+id,product:{source:'sesum',sourceUrl:'https://www.sesum.no/produkt/'+id+'-test',name:'Shelf pack',store,unit:'kg',pack:0.4,packKnown:true,available:true},price:{fresh:true,reasons:[],receiptAt:at,grossPackPrice:0.4*unitPrice}});
 const lead=shelfRow(1,'KIWI',99.75),shelf={...options,quotes:[{...options.quotes[0],unitPrice:162.25}],reader:{members:()=>[lead]}};
 const kiwi=subcategoryPrices(shelf);
 assert.equal(kiwi.signals[0].diffPct,38.52);
 assert.equal(kiwi.signals[0].referenceBasis,'oda');
 assert.deepEqual(kiwi.signals[0].pack,{amount:0.4,price:39.9,difference:25});
 assert.equal(kiwi.signals[0].median,null);
 assert.deepEqual(kiwi.alerts,[]);
 assert.equal(kiwi.storeFindings[0].totals.count,0);
 const mincePlan={...shelf,planning:()=>({...options.planning(),need:{amount:24.56},maxPacks:null,shelfMonths:4,referenceCap:162.25})};
 const fourMonths=subcategoryPrices(mincePlan).storeFindings[0].families[0].items[0].estimate;
 assert.equal(fourMonths.packs,20);assert.equal(fourMonths.odaSaving,500);
 const minceTrip=subcategoryPrices(mincePlan).storeFindings[0];
 const smallDiscount={...mincePlan,planning:()=>({...mincePlan.planning(),need:{amount:2.4},shelfMonths:12}),reader:{members:()=>[shelfRow(8,'KIWI',157)]}};
 assert.equal(subcategoryPrices(smallDiscount).storeFindings[0].families[0].items[0].estimate.packs,1,'a long-lived pack can be used after the next shopping trip');
 const evidence='abc',withPrior={...shelf,families:[{...shelf.families[0],products:[{productKey:lead.productKey,reviewCurrent:true,unit:'kg',canonicalPackAmount:0.4,sourceFingerprint:evidence}]}]};
 assert.equal(subcategoryPrices(withPrior).storeFindings[0].totals.count,0);
 const exact=subcategoryPrices({...withPrior,reader:{members:()=>[{...lead,product:{...lead.product,catalogueSourceFingerprint:evidence}}]}}).storeFindings[0];
 assert.equal(exact.totals.count,1);
 const offers={...options,quotes:[options.quotes[0],{...options.quotes[1],kind:'offer',storeId:'shop',offerId:'bundle',bundlePacks:2,maxPacks:2,bestBefore:'2026-04-30'}],at:Date.parse('2026-04-01T10:00:00Z')};
 const bundle=subcategoryPrices(offers).storeFindings[0].families[0].items.find(p=>p.reviewed);
 assert.equal(bundle.estimate.status,'too-large','the entire bundle costs more than Oda for the usable amount before expiry');
 const secondStore={id:'next-shop',chainCode:'EXTRA',name:'Extra'};
 const otherPack=shelfRow(2,'KIWI',150),smallSaving=shelfRow(3,'EXTRA',161.5),equal=shelfRow(4,'EXTRA',162.25);
 const tripList={...shelf,stores:[...shelf.stores,secondStore],reader:{members:()=>[lead,otherPack,smallSaving,equal,{...lead,productKey:'stale',price:{...lead.price,fresh:false}}]}};
 const byStore=subcategoryPrices(tripList).storeFindings;
 assert.deepEqual(byStore.map(s=>s.storeName),['Extra','KIWI']);
 assert.deepEqual(byStore.map(s=>s.families.length),[1,1]);
 assert.deepEqual(byStore[1].families[0].items.map(p=>p.unitPrice),[99.75,150]);
 assert.equal(byStore[0].families[0].items[0].pack.saving,0.3);
 assert.equal(byStore[0].families[0].items.length,1);
 assert.equal(byStore[1].families[0].items[0].reviewed,false);
 const revised={...options.quotes[1],name:'Updated pack',productKey:lead.productKey,unitPrice:170,price:68,lastChecked:'2099-01-01T00:00:00Z'};
 assert.deepEqual(subcategoryPrices({...tripList,quotes:[...shelf.quotes,revised]}).storeFindings[1].families[0].items.map(p=>p.unitPrice),[150]);
 assert.deepEqual(subcategoryPrices({...tripList,quotes:[]}).storeFindings,[]);
 const peerRows=[shelfRow(2,'A',175),shelfRow(3,'A',300),shelfRow(4,'B',150),shelfRow(5,'C',200)];
 const market={...shelf,quotes:[],stores:[...options.stores,...['A','B','C'].map(code=>({id:code,chainCode:code,name:code}))],reader:{members:()=>[lead,...peerRows]}};
 const marketSignal=subcategoryPrices(market).signals[0];
 const medianStore=subcategoryPrices(market).storeFindings.find(s=>s.storeId==='shop');
 const [{identity,estimate,...medianFinding}]=medianStore.medianFindings;
 assert.deepEqual(medianFinding,marketSignal);assert.equal(identity,lead.productKey);
 assert.ok(estimate.packs>0);
 assert.equal(medianStore.totals.count,0);
 assert.equal(marketSignal.oda,null);
 assert.equal(marketSignal.referenceBasis,'chain-median');
 assert.deepEqual(marketSignal.median,{unitPrice:175,chains:3});
 assert.equal(marketSignal.diffPct,43);
 assert.deepEqual(subcategoryPrices({...market,reader:{members:()=>[lead,...peerRows.slice(0,3),{...peerRows[3],price:{...peerRows[3].price,fresh:false}}]}}).signals,[]);
 assert.deepEqual(subcategoryPrices({...market,quotes:[{...options.quotes[0],unitPrice:101}]}).signals,[],'a much cheaper available Oda alternative caps the reference');
 const corroborated={...options,quotes:options.quotes.slice(0,1),reader:{members:()=>options.reader.members().map(r=>({...r,product:{...r.product,ean:'1234567890123',brand:'Brand'}}))},families:[{...options.families[0],products:[{ean:'1234567890123',reviewCurrent:true,brand:'Brand',unit:'kg',canonicalPackAmount:1}]}]};
 assert.equal(subcategoryPrices(corroborated).signals[0].diffPct,99);
 assert.deepEqual(subcategoryPrices(corroborated).alerts,[]);
 assert.deepEqual(subcategoryPrices({...corroborated,excluded:()=>true}).signals,[]);
 assert.deepEqual(subcategoryPrices({...options,quotes:options.quotes.slice(0,1),excluded:()=>true}).signals,[]);
 const alternative={...options.quotes[1],store:'EXTRA',name:'Reviewed alternative',price:65,unitPrice:65};
 const otherShop={id:'extra',chainCode:'EXTRA',name:'Extra',minSavings:5};
 const trips=subcategoryPrices({...options,quotes:[...options.quotes,alternative],stores:[{...options.stores[0],minSavings:1000},otherShop]});
 assert.equal(trips.alerts.length,1);assert.equal(trips.alerts[0].storeId,'extra');
 const sibling={id:'285',groupId:'sesum-category:285',name:'Whole'};
 const odaRow=(id,unitPrice,time=at)=>({productKey:'oda:ODA_NO:'+id,product:{name:'Native '+id,sourceUrl:'https://oda.com/no/products/'+id+'-synthetic/',store:'ODA_NO',unit:'kg',available:true,packKnown:true,pack:1},price:{fresh:true,reasons:[],grossPackPrice:unitPrice,receiptAt:time}});
 const rows={ [cat.groupId]:[odaRow(10,100),{...options.reader.members()[0],productKey:'reviewed-shop-key',product:{...options.reader.members()[0].product,name:'Reviewed variant'},price:{...options.reader.members()[0].price,grossPackPrice:60}}],
  [sibling.groupId]:[odaRow(12,45)]};
 const multi={...options,choice:()=>null,reader:{members:k=>rows[k]},links:[{watchId:'duck',categories:[cat,sibling],odaReferenceIds:[10,12]}],
  quotes:[options.quotes[0],{...options.quotes[1],productKey:'reviewed-shop-key'}]};
 const siblingResult=subcategoryPrices(multi);
 const multiTrip=subcategoryPrices({...multi,reader:{members:k=>k===sibling.groupId?[odaRow(12,120)]:rows[k]}}).storeFindings[0];
 assert.deepEqual(multiTrip.families[0].items[0].categories,[{id:cat.id,name:cat.name}]);
 assert.equal(siblingResult.comparisons[0].oda.unitPrice,100);
 assert.equal(siblingResult.comparisons[1].oda.unitPrice,45);
 assert.deepEqual(siblingResult.alerts,[]);assert.deepEqual(siblingResult.signals,[]);
 const pack=odaRow(10,62.90);Object.assign(pack.product,{source:'oda',unit:'kg',description:'Medium, 18 stk',packKnown:false,pack:null});
 const perPiece={...options,links:[{watchId:'duck',categories:[cat]}],quotes:[],reader:{members:()=>[pack]},families:[{...options.families[0],unit:'stk',products:[{sourceUrl:url,store:'ODA_NO',reviewCurrent:true,unit:'stk',canonicalPackAmount:18}]}]};
 assert.equal(subcategoryPrices(perPiece).comparisons[0].oda.unitPrice,3.49);
 pack.product.description='12 stk';assert.equal(subcategoryPrices(perPiece).comparisons[0].oda,null);
 pack.product.name='18 stk';pack.product.description='1 kg';assert.equal(subcategoryPrices(perPiece).comparisons[0].oda,null);
 const net=odaRow(10,39.8);
 Object.assign(net.product,{source:'oda',description:'3pk, 681 g',pack:null,packKnown:false});
 Object.assign(net.price,{grossUnitPrice:94.76,unit:'kg',directUnitVerified:true});
 const netOptions={...options,reader:{members:()=>[net],odaNative:()=>net.product},quotes:[],families:[{...options.families[0],products:[{sourceUrl:url,store:'ODA_NO',reviewCurrent:true,unit:'kg',canonicalPackAmount:.681}]}]};
 assert.equal(subcategoryPrices(netOptions).comparisons[0].oda.unitPrice,58.44,'compare the full net pack, not the drained per-kg figure');
 netOptions.families[0].products[0].canonicalPackAmount=.42;
 assert.equal(subcategoryPrices({...netOptions,quotes:options.quotes}).comparisons[0].oda,null,'a conflicting approved pack cannot restore the incompatible quote');
 const householdSku={store:'ODA_NO',productKey:'kassal:ODA_NO:1',sourceUrl:url,watchId:'duck',unit:'kg',status:'approved',packAmount:.681};
 netOptions.families[0].products[0].productKey=householdSku.productKey;
 assert.equal(subcategoryPrices({...netOptions,nativeEntries:[householdSku]}).comparisons[0].oda.unitPrice,58.44,'the household net-pack review outranks a drained library membership');
 assert.equal(subcategoryPrices({...netOptions,nativeEntries:[{...householdSku,status:'pending'}]}).comparisons[0].oda,null);
 netOptions.families[0].products[0].canonicalPackAmount=.681;
 const pending={...householdSku,status:'pending'};
 assert.equal(subcategoryPrices({...netOptions,nativeEntries:[pending],retainReviewed:()=>true}).comparisons[0].oda.unitPrice,58.44,'keep a current reviewed library pack when the native pending row has compatible facts');
 assert.equal(subcategoryPrices({...netOptions,nativeEntries:[{...pending,reviewHold:{}}],retainReviewed:()=>true}).comparisons[0].oda,null);
 const newer=new Date(Date.parse(at)+60000).toISOString();
 assert.equal(subcategoryPrices({...multi,reader:{members:k=>k===cat.groupId?[odaRow(10,110,newer)]:[]}}).comparisons[0].oda.unitPrice,110);
 assert.equal(subcategoryPrices({...multi,reader:{members:k=>k===cat.groupId?[odaRow(10,110)]:[]}}).comparisons[0].oda,null);
 assert.equal(subcategoryPrices({...options,reader:{members:()=>[],odaNative:()=>({available:false})}}).comparisons[0].oda,null);
});

test('later compatible extension manifests retain catalogue work',async()=>{
 const {supportsSesumCatalogue}=await import('../src/assortment-collection.mjs');
 for(const v of ['1.9.1','1.9.2','1.10.0'])assert.ok(supportsSesumCatalogue(v));
 for(const v of [undefined,'1.8.9','1.9.0','1.9.2-beta','2.0.0'])assert.equal(supportsSesumCatalogue(v),false);
});

test('the family follows a native leaf category from Varer and can stop following it again',()=>{
 const state={},shop=shoppingStore(state,{save(){},now:()=>new Date(at),assortmentConfig:config});
 shop.settings({monitoringEnabled:true,stores:[]});shop.taxonomy.receive({categories,fetchedAt:at});shop.assortment.receiveSesum({products:[product()],fetchedAt:at});
 assert.throws(()=>shop.followCategory({groupId:'sesum-category:283',action:'follow'}),/underkategori/,'a parent shelf is too broad');
 const followed=shop.followCategory({groupId:'sesum-category:284',action:'follow'});
 assert.deepEqual(followed.watchIds,['category-284']);
 const w=state.shopping.watches['category-284'];
 assert.equal(w.name,'And');assert.equal(w.unit,'kg');assert.equal(w.enabled,true);assert.equal(w.purchaseAmount,null,'the need stays unknown');
 assert.deepEqual(shop.taxonomy.watchLinks([{familyId:'category-284',...shop.sesumFamilies('category-284')[0]}]).map(l=>l.categoryIds),[['284']]);
 assert.equal(shop.explorer.offers().followed.find(f=>f.id==='category-284').fromCategory,true);
 assert.equal(shop.followCategory({groupId:'sesum-category:284',action:'follow'}).following,true,'following twice is harmless');
 shop.followCategory({groupId:'sesum-category:284',action:'unfollow'});
 assert.equal(state.shopping.watches['category-284'].enabled,false);
 assert.equal(shop.explorer.offers().followed.some(f=>f.id==='category-284'),false);
 shop.followCategory({groupId:'sesum-category:284',action:'follow'});
 assert.equal(state.shopping.watches['category-284'].enabled,true,'following again restores the same family');
 assert.throws(()=>shop.followCategory({groupId:'sesum-category:2112',action:'unfollow'}),/ikke laget fra Varer/,'a family made elsewhere is changed in its own settings');
});
