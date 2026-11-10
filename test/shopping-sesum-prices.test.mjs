import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';
import {sesumDonorFingerprint} from '../src/sesum-prices.mjs';

const NOW='2026-11-09T12:00:00Z';
function setup(t,{donorStore='KIWI'}={}) {
  const dir=mkdtempSync(join(tmpdir(),'sesum-shopping-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'library.json'),g={id:'beans',name:'Whole coffee beans',category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Whole roasted beans',exclusions:['Ground coffee'],qualityBasis:'Same form and use',comparisonBasis:'Per kg'};
  const p={productKey:`kassal:${donorStore}:71`,source:'kassal',store:donorStore,id:'71',name:'Test whole beans 500g',ean:'1234567890123',brand:'Test',ingredients:'Whole roasted coffee beans',description:'Plain beans',sourceUrl:'https://example.test/beans',canonicalPackAmount:.5,unit:'kg',packEvidence:'Read 500g on the original package',rawPack:{weight:500,weightUnit:'g'},nutrition:null};
  p.metadataFingerprint=productMetadataFingerprint(p);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[g],products:[p],memberships:[{groupId:g.id,productKey:p.productKey,status:'approved',equivalenceEvidence:'Same whole beans and use',qualityEvidence:'Actual label read',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),reviewedAt:'2026-11-09T10:00:00Z',sourceReceipts:[{url:p.sourceUrl,observedAt:'2026-11-09T10:00:00Z',evidence:'Original label and package read'}]}],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:'2026-11-09T11:00:00Z',availabilityScope:'chain',sourceUrl:p.sourceUrl}]};
  const write=()=>writeFileSync(file,JSON.stringify(data));write();
  const clock={at:NOW},state={},provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)}),shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://example.test/kiwi',minSavings:0},{id:'extra',name:'Extra',chainCode:'COOP_EXTRA',url:'https://example.test/extra',minSavings:0}]});
  const w=shop.watch({name:'Whole coffee beans',unit:'kg',storage:'pantry',purchaseAmount:10,targetPrice:50});
  shop.libraryLink({familyId:w.id,evidence:'Reviewed whole-bean family',variants:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Same use, all brands allowed'}]});
  const ingest=(price=20,observedAt=clock.at,store='KIWI')=>shop.sesumReceivePrices({familyIds:[w.id],fetchedAt:clock.at,products:[{id:'71',name:p.name,brand:p.brand,vendor:'Test',ean:[p.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/71-test-whole-beans-500g',prices:[{storeCode:store,price,observedAt,source:'receipt_realtime',rawUnitPrice:999,isPromo:false,promotion:null}]}]});
  const approve=()=>{const row=shop.sesumCandidates(w.id)[0],donor=row.donors.find(d=>d.productKey===p.productKey);return shop.sesumPriceReview({sourceKey:row.sourceKey,sourceFingerprint:row.sourceFingerprint,productKey:p.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Same GTIN, brand, actual name and reviewed fixed 500g package; source price belongs to that exact product',packEvidence:'Both concrete records and original reviewed label document one fixed 500g pack'});};
  return {shop,state,w,p,g,data,clock,write,ingest,approve,provider};
}

test('all followed families enter the manifest and price observations require an explicit bridge',t=>{
  const f=setup(t);
  for(let i=0;i<100;i++)f.shop.watch({name:`Family ${i}`,unit:'kg',storage:'pantry'});
  const rows=f.shop.sesumFamilies();assert.equal(rows.length,101);assert.ok(rows.every(r=>r.familyId&&r.queries.length&&r.requirementsFingerprint));
  assert.equal(f.shop.familyView().items.find(i=>i.id===f.w.id).prices.current,60);
  f.ingest();assert.ok(f.shop.queue().some(q=>q.do==='shopping-sesum-placement-review'));assert.ok(!f.shop.queue().some(q=>q.do==='shopping-sesum-review'),'the full family placement is the first source research stage');
  assert.equal(f.shop.familyView().items.find(i=>i.id===f.w.id).prices.current,60,'observation never approves a source mapping');
  f.approve();assert.equal(f.shop.familyView().items.find(i=>i.id===f.w.id).prices.current,40,'500g pack price is recomputed, rawUnitPrice is ignored');
  assert.equal(f.shop.familyView().items.find(i=>i.id===f.w.id).prices.currentSourceUrl,'https://www.sesum.no/produkt/71-test-whole-beans-500g','the displayed price links to its actual source receipt while native metadata URLs remain unchanged');
  assert.ok(!f.shop.queue().some(q=>q.do==='shopping-sesum-review'));
});

test('newest mapped unknown price immediately blocks older same-chain library prices',t=>{
  const f=setup(t);f.ingest();f.approve();assert.equal(f.shop.checklist()[0].cheapestNow,40);
  f.clock.at='2026-11-09T12:01:00Z';f.ingest(null);
  assert.equal(f.shop.familyView().items[0].prices.current,null);
  assert.equal(f.shop.explorer.family(f.g.id).family.members.some(m=>m.fresh&&m.unitPrice!==null),false);
});

test('reviewed Extra bridge revives a parked donor without assigning its price to every Coop chain',t=>{
  const f=setup(t,{donorStore:'COOP_NO'});f.data.prices[0].receiptAt='2023-01-01T12:00:00Z';f.write();
  assert.equal(f.shop.familyView().items[0].prices.current,null);
  f.ingest(20,NOW,'COOP_EXTRA');f.approve();
  const item=f.shop.familyView().items[0];assert.equal(item.prices.current,40);assert.equal(item.prices.currentChain,'Extra');
  const family=f.shop.explorer.family(f.g.id).family;
  assert.ok(family.members.some(m=>m.key==='sesum:COOP_EXTRA:71'&&m.unitPrice===40));
  assert.ok(!family.members.some(m=>m.key==='kassal:COOP_NO:71'&&m.fresh));
});

test('native exclusion and changed donor label retain priority over a source bridge',t=>{
  const f=setup(t);f.ingest();f.approve();
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'excluded',equivalenceEvidence:'The family explicitly excludes this exact chain product'});
  assert.equal(f.shop.familyView().items[0].prices.current,null);
});

test('reopening a native approval also holds its already reviewed Sesum alias for only that family',t=>{
  const f=setup(t);f.ingest();f.approve();
  const seen=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:20,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:seen.id,store:seen.store,fingerprint:seen.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The current whole-bean variant and fixed package were explicitly reviewed.'});
  const second=f.shop.watch({name:'Second whole-bean household family',unit:'kg',storage:'pantry',purchaseAmount:2});
  f.shop.libraryLink({watchId:second.id,evidence:'Actual whole-bean use and variant allowed by this second family.',links:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),evidence:'Current recipe and form checked for this family.'}]});
  assert.equal(f.shop.familyView().items.find(x=>x.id===f.w.id).prices.current,40);
  const reopened=f.shop.catalogReview({watchId:f.w.id,id:seen.id,store:seen.store,fingerprint:seen.fingerprint,status:'reopen',reason:'The source review did not establish this family’s exact whole-bean subtype.'});
  let view=f.shop.familyView();assert.equal(view.items.find(x=>x.id===f.w.id).prices.current,null);
  assert.equal(view.items.find(x=>x.id===second.id).prices.current,40,'another family retains its independent explicit group approval');
  assert.ok(f.shop.queue().some(x=>x.do==='shopping-product-review'&&x.watchId===f.w.id&&x.productId===seen.id));
  assert.deepEqual(f.shop.explorer.family('followed:'+f.w.id).family.members,[],'followed-family alternatives cannot leak the held native/source alias');
  f.clock.at='2026-11-09T12:01:00Z';f.ingest(10);
  assert.equal(f.shop.familyView().items.find(x=>x.id===f.w.id).prices.current,null,'a new source price cannot settle native equivalence');
  f.shop.catalogReview({watchId:f.w.id,id:seen.id,store:seen.store,fingerprint:reopened.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The current exact whole-bean subtype and original fixed500g package now match this family.'});
  assert.equal(f.shop.familyView().items.find(x=>x.id===f.w.id).prices.current,20);
});

test('equal numeric source IDs never overwrite a different native product in displayed alternatives',t=>{
  const f=setup(t),other={...structuredClone(f.p),productKey:'kassal:SPAR_NO:72',store:'SPAR_NO',id:'72',name:'Other whole beans 500g',brand:'Other',ean:'1234567890124',sourceUrl:'https://example.test/other-beans'};
  other.metadataFingerprint=productMetadataFingerprint(other);f.data.products.push(other);f.data.memberships.push({...f.data.memberships[0],productKey:other.productKey,reviewedFingerprint:other.metadataFingerprint});f.data.prices.push({productKey:other.productKey,grossPackPrice:35,receiptAt:'2026-11-09T11:00:00Z',availabilityScope:'chain',sourceUrl:other.sourceUrl});f.write();
  f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:NOW,products:[{id:'71',name:other.name,brand:other.brand,vendor:'Other',ean:[other.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/71-other-whole-beans-500g',prices:[{storeCode:'KIWI',price:20,observedAt:NOW,source:'receipt_realtime',isPromo:false}]}]});
  const candidate=f.shop.sesumCandidates(f.w.id)[0],donor=candidate.donors.find(d=>d.productKey===other.productKey);
  f.shop.sesumPriceReview({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,productKey:other.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Other brand, GTIN and actual original label reviewed as that same product.',packEvidence:'Fixed 500g in both exact product records and original package.'});
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.5,packs:1,unitPrice:100});
  const alternatives=f.shop.familyView().list.open[0].others;
  assert.ok(alternatives.some(row=>row.productKey==='sesum:KIWI:71'&&row.unitPrice===40),'the Sesum product retains its source identity despite native KIWI ID71 being a different product');
  assert.ok(alternatives.some(row=>row.productKey===f.p.productKey&&row.unitPrice===60),'the distinct native product is also retained');
});

test('native exclusion also removes bridged products from raw family fallback alternatives',t=>{
  const f=setup(t);f.ingest();f.approve();
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'excluded',equivalenceEvidence:'Family explicitly excludes this exact product.'});
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.5,packs:1,unitPrice:100});
  assert.deepEqual(f.shop.familyView().list.open[0].others,[],'neither native nor its bridge may reappear through raw library family fallback');
  assert.deepEqual(f.shop.explorer.family('followed:'+f.w.id).family.members,[],'followed family details use the same native exclusions');
});

test('a native package-only metadata change blocks the old reviewed donor and its source bridge',t=>{
  const f=setup(t);f.ingest();f.approve();
  f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:1000,weightUnit:'g',currentPrice:30,lastChecked:NOW}]});
  assert.equal(f.shop.familyView().items[0].prices.current,null,'matching name/ingredients cannot override the newer conflicting native package');
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.5,packs:1,unitPrice:100});
  assert.deepEqual(f.shop.familyView().list.open[0].others,[],'the same package guard applies to displayed choices');
  assert.deepEqual(f.shop.explorer.family('followed:'+f.w.id).family.members,[],'a held package is also held in the followed-family detail');
});

test('canonical gram conversion roundoff preserves the same reviewed package but not a changed raw package',t=>{
  const f=setup(t);
  Object.assign(f.p,{name:'Test whole beans 350g',canonicalPackAmount:350*.001,rawPack:{weight:350,weightUnit:'g'}});
  f.p.metadataFingerprint=productMetadataFingerprint(f.p);
  f.data.memberships[0].reviewedFingerprint=f.p.metadataFingerprint;f.write();
  assert.notEqual(f.p.canonicalPackAmount,.35,'the fixture exercises real gram conversion roundoff');
  f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:NOW,products:[{id:'71',name:f.p.name,brand:f.p.brand,ean:[f.p.ean],weight:350,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/71-test-whole-beans-350g',prices:[{storeCode:'KIWI',price:20,observedAt:NOW,source:'receipt_realtime',isPromo:false}]}]});
  const candidate=f.shop.sesumCandidates(f.w.id)[0],donor=candidate.donors.find(d=>d.productKey===f.p.productKey);
  f.shop.sesumPriceReview({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,productKey:donor.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.35,unit:'kg',equivalenceEvidence:'Actual original product identity and the same fixed 350g package reviewed.',packEvidence:'The original package and both concrete records show one fixed 350g bag.'});
  const native={id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:350,weightUnit:'g',currentPrice:30,lastChecked:'2026-11-09T10:00:00Z'};
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[native]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',packAmount:.35,unit:'kg',equivalenceEvidence:'The concrete native label documents the same fixed 350g bag.'});
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.35,packs:1,unitPrice:100});
  const alternatives=()=>f.shop.familyView().list.open[0].others;
  const members=()=>f.shop.explorer.family('followed:'+f.w.id).family.members;
  assert.ok(alternatives().some(p=>Math.abs(p.packAmount-.35)<1e-12&&p.unitPrice===57.14),'the equivalent native/source choice retains the source receipt price');
  assert.ok(members().some(p=>p.key===candidate.sourceKey&&Math.abs(p.unitPrice-20/.35)<1e-10),'the followed-family detail preserves the same source package');
  f.shop.catalogObserve({watchId:f.w.id,products:[{...native,weight:1000,lastChecked:NOW}]});
  assert.deepEqual(alternatives(),[],'a real raw package change still holds the old native and source variants');
  assert.deepEqual(members(),[],'the followed-family detail also holds the genuinely changed package');
});

test('followed family details preserve the reviewed brand and attribute restrictions',t=>{
  const f=setup(t);f.ingest();f.approve();
  const family=f.shop.sesumFamilies()[0];assert.ok(family.queries.includes('Test whole beans'),'known concrete products remain discovery queries even without a broad alias');
  f.shop.libraryLink({familyId:f.w.id,evidence:'Exact brand preference',variants:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),evidence:'Restricted brand',brands:['Another brand']}]});
  assert.deepEqual(f.shop.explorer.family('followed:'+f.w.id).family.members,[]);
});

test('newer approved native receipts cap older Sesum prices in every family view',t=>{
  const f=setup(t);f.ingest(20,'2026-11-09T11:30:00Z');f.approve();
  const observed=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:35,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:observed.id,store:observed.store,fingerprint:observed.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Current native whole-bean label and fixed package reviewed.'});
  assert.equal(f.shop.familyView().items[0].prices.current,70);
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.5,packs:1,unitPrice:100});
  assert.ok(f.shop.familyView().list.open[0].others.every(p=>p.unitPrice===70),'older bridge cannot return through alternatives');
  const detail=f.shop.explorer.family('followed:'+f.w.id).family.members;
  assert.ok(detail.some(p=>p.unitPrice===70));
  assert.ok(detail.every(p=>p.unitPrice===null||p.unitPrice===70),'superseded source proof may remain visible, but cannot retain its older actionable price');
  f.clock.at='2026-11-09T12:01:00Z';
  f.shop.catalogObserve({watchId:f.w.id,products:[{...observed,currentPrice:null,lastChecked:f.clock.at}]});
  assert.equal(f.shop.familyView().items[0].prices.current,null,'newer unknown native price suppresses both older sources');
  assert.deepEqual(f.shop.familyView().list.open[0].others,[]);
  assert.ok(f.shop.explorer.family('followed:'+f.w.id).family.members.every(p=>p.unitPrice===null));
});

test('self-registered source identity follows newer same-chain native prices, unknowns and family exclusions',t=>{
  const f=setup(t),sourceKey='sesum:KIWI:72';
  const source={id:'72',name:f.p.name,brand:f.p.brand,ean:[f.p.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-test-whole-beans-500g'};
  const receive=(price,observedAt)=>f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:f.clock.at,products:[{...source,prices:[{storeCode:'KIWI',price,observedAt,source:'receipt_realtime',isPromo:false}]}]});
  receive(20,'2026-11-09T11:30:00Z');
  const candidate=f.shop.sesumCandidates(f.w.id).find(p=>p.sourceKey===sourceKey);
  f.shop.sesumRegister({sourceKey,sourceFingerprint:candidate.sourceFingerprint,identityEvidence:'Read the concrete source bag, GTIN, whole-bean form and fixed package. Its recipe is not supplied and remains unknown.',nativeProductKey:f.p.productKey,nativeProductFingerprint:sesumDonorFingerprint(f.provider.reader().product(f.p.productKey)),nativeIdentityEvidence:'The same-chain native KIWI record and source bag show the same physical GTIN, whole-bean form and one fixed 500g package.',product:{ingredients:null,description:'Recipe not supplied by this source',brand:f.p.brand},packAmount:.5,unit:'kg',packEvidence:'Actual source bag and native record document one fixed 500g package.',memberships:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),equivalenceEvidence:'The actual whole roasted beans have the same brewing use; recipe details remain unknown rather than copied.',qualityEvidence:'Whole-bean form read on the original bag. No recipe or nutrition is transferred from the identity relation.'}],sourceReceipts:[{url:'https://example.test/source-bag',observedAt:NOW,evidence:'Read the actual source bag identity, physical form and fixed package.'}]});
  assert.equal(f.shop.familyView().items[0].prices.current,40);
  const row=()=>f.shop.explorer.family('followed:'+f.w.id).family.members.find(m=>m.key===sourceKey);
  assert.equal(row().unitPrice,40);
  const observe=(price,extra={})=>f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:price,lastChecked:f.clock.at,...extra}]}).entries[0];
  const entry=observe(35);
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Current native contents and fixed package reviewed.'});
  assert.equal(f.shop.familyView().items[0].prices.current,70);
  assert.equal(row().unitPrice,70,'the self-registered source identity adopts the later native quote without requiring its own unknown recipe to equal the native recipe');
  f.shop.list({action:'add',watchId:f.w.id,storeName:'KIWI',packAmount:.5,packs:1,unitPrice:100});
  assert.ok(f.shop.familyView().list.open[0].others.every(p=>p.unitPrice===70));
  f.clock.at='2026-11-09T12:01:00Z';observe(null);
  assert.equal(f.shop.familyView().items[0].prices.current,null);assert.equal(row().unitPrice,null);
  assert.deepEqual(f.shop.familyView().list.open[0].others,[],'new native unknown price cannot expose an older self source receipt');
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'excluded',equivalenceEvidence:'The family explicitly excludes this physical variant.'});
  f.clock.at='2026-11-09T12:02:00Z';receive(15,f.clock.at);
  assert.equal(f.shop.familyView().items[0].prices.current,null,'a later own source price cannot bypass the native family exclusion');
  assert.deepEqual(f.shop.familyView().list.open[0].others,[]);
  assert.deepEqual(f.shop.explorer.family('followed:'+f.w.id).family.members,[]);
});

test('self-registration cannot use generic Coop identity to import its price or holds into Extra',t=>{
  const f=setup(t,{donorStore:'COOP_NO'});f.ingest(20,NOW,'COOP_EXTRA');
  const candidate=f.shop.sesumCandidates(f.w.id).find(p=>p.sourceKey==='sesum:COOP_EXTRA:71');
  assert.throws(()=>f.shop.sesumRegister({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,identityEvidence:'Concrete bag identity and package reviewed.',nativeProductKey:f.p.productKey,nativeProductFingerprint:sesumDonorFingerprint(f.provider.reader().product(f.p.productKey)),nativeIdentityEvidence:'Same physical bag claimed across generic Coop and Extra; this is not same-chain identity.',product:{ingredients:null,description:'Unknown source recipe'},packAmount:.5,unit:'kg',packEvidence:'One fixed 500g bag.',memberships:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),equivalenceEvidence:'Reviewed whole roasted beans and use.',qualityEvidence:'Actual whole-bean form read.'}],sourceReceipts:[{url:'https://example.test/source-bag',observedAt:NOW,evidence:'Original source package read.'}]}),/native product identity|chain/);
  assert.equal(f.shop.familyView().items[0].prices.current,null);
  assert.ok(f.shop.queue().some(q=>q.sourceKey===candidate.sourceKey),'rejected cross-chain identity remains unresolved research');
});

for(const actualPrice of [true,false])test(`an entirely new Sesum SKU with ${actualPrice?'actual':'unproven'} price enters discovery and joins a followed family only after explicit research`,t=>{
  const quote={storeCode:'KIWI',price:15,observedAt:actualPrice?NOW:null,source:actualPrice?'receipt_realtime':null,isPromo:false};
  const f=setup(t),newProduct={id:'72',name:'New brand whole beans 500g',brand:'New brand',ean:null,weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-new-brand-whole-beans-500g',prices:actualPrice?[quote]:[],priceCandidates:actualPrice?[]:[{...quote,reason:'missing_price_provenance'}]};
  f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:NOW,products:[newProduct]});
  assert.ok(f.shop.queue().some(q=>q.do==='shopping-sesum-placement-review'&&q.sourceKey==='sesum:KIWI:72'),'missing barcode and donor begin with complete family-placement research');
  assert.equal(f.shop.familyView().items[0].prices.current,60);
  const candidate=f.shop.sesumCandidates(f.w.id).find(p=>p.sourceKey==='sesum:KIWI:72');
  assert.deepEqual(candidate.donors,[]);
  assert.ok(candidate.families[0].groups.some(g=>g.groupId===f.g.id));
  const beforeDiscovery=f.shop.sesumFamilies()[0];
  const result=f.shop.sesumRegister({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,identityEvidence:'Read the actual New brand product and manufacturer label: whole roasted coffee beans, fixed 500g bag. Not ground coffee.',product:{ingredients:'Whole roasted coffee beans',description:'Plain roasted whole beans',brand:'New brand'},packAmount:.5,unit:'kg',packEvidence:'The actual original bag says 500g, one fixed bag.',memberships:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),equivalenceEvidence:'Whole plain roasted beans with the same brewing use; all brands allowed by this family.',qualityEvidence:'Actual ingredient label states whole coffee beans, roast differs and is preserved.'}],sourceReceipts:[{url:'https://example.test/new-brand-original-label',observedAt:NOW,evidence:'Read full ingredient list and 500g net package on the original label.'}]});
  assert.equal(result.bridge.productKey,'sesum:KIWI:72');
  const afterDiscovery=f.shop.sesumFamilies()[0];
  assert.deepEqual(afterDiscovery.queries,beforeDiscovery.queries,'registering a discovered SKU does not restart all source searches with its own name');
  assert.equal(afterDiscovery.requirementsFingerprint,beforeDiscovery.requirementsFingerprint);
  assert.equal(f.shop.familyView().items[0].prices.current,actualPrice?30:60,'metadata research cannot make an unproven quote actionable');
  assert.ok(!f.shop.queue().some(q=>q.sourceKey==='sesum:KIWI:72'&&q.do!=='shopping-sesum-placement-review'));
  assert.ok(f.shop.queue().some(q=>q.sourceKey==='sesum:KIWI:72'&&q.do==='shopping-sesum-placement-review'),'identity review does not certify research across the entire active family set');
  f.clock.at='2026-11-09T12:01:00Z';
  f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:f.clock.at,products:[{...newProduct,name:'New brand ground coffee 500g'}]});
  assert.equal(f.shop.familyView().items[0].prices.current,60,'changed source metadata withdraws the researched native membership and price');
  assert.ok(f.shop.queue().some(q=>q.do==='shopping-sesum-placement-review'&&q.sourceKey==='sesum:KIWI:72'));
});

test('a false-positive search match excludes only the reviewed family and reopens on changed requirements',t=>{
  const f=setup(t),other=f.shop.watch({name:'Another family',unit:'kg',storage:'pantry'});
  const product={id:'72',name:'A new product 500g',brand:'New',ean:null,weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-a-new-product-500g',prices:[{storeCode:'KIWI',price:15,observedAt:NOW,source:'receipt_realtime',isPromo:false}]};
  const observe=familyIds=>f.shop.sesumReceivePrices({familyIds,fetchedAt:f.clock.at,products:[product]});
  const work=()=>f.shop.queue().find(q=>q.sourceKey==='sesum:KIWI:72'&&q.do!=='shopping-sesum-placement-review');
  observe([f.w.id,other.id]);
  const candidate=f.shop.sesumCandidates()[0];
  const reject=familyIds=>f.shop.sesumPriceReview({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,status:'excluded',familyIds,familyFingerprints:Object.fromEntries(candidate.families.map(x=>[x.familyId,x.requirementsFingerprint])),equivalenceEvidence:'Read the source product: its contents are outside the requirements of these specific search families.'});
  assert.throws(()=>f.shop.sesumPriceReview({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,status:'excluded',equivalenceEvidence:'Wrong search match.'}),/familyIds/);
  reject([f.w.id]);assert.equal(work(),undefined,'raw OR hints do not start identity before complete placement');assert.equal(f.shop.sesumCandidates()[0].families.find(x=>x.familyId===f.w.id).sourceDecision.status,'excluded');
  const third=f.shop.watch({name:'A newly followed family',unit:'kg',storage:'pantry'});observe([third.id]);
  assert.equal(work(),undefined);assert.ok(f.shop.queue().some(q=>q.sourceKey==='sesum:KIWI:72'&&q.do==='shopping-sesum-placement-review'),'a newly followed family keeps complete placement active, never globally suppressed');
  reject([other.id]);
  const thirdCandidate=f.shop.sesumCandidates()[0];
  f.shop.sesumPriceReview({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,status:'excluded',familyIds:[third.id],familyFingerprints:{[third.id]:thirdCandidate.families.find(x=>x.familyId===third.id).requirementsFingerprint},equivalenceEvidence:'The actual product is also outside this third family.'});
  assert.equal(work(),undefined);
  assert.ok(f.shop.queue().some(q=>q.sourceKey==='sesum:KIWI:72'&&q.do==='shopping-sesum-placement-review'),'rejecting every wrong OR hint cannot close global family placement');
  f.shop.watch({...f.w,note:'The household changed this family requirement.'});
  assert.equal(work(),undefined);assert.ok(f.shop.queue().some(q=>q.sourceKey==='sesum:KIWI:72'&&q.do==='shopping-sesum-placement-review'),'changed requirements reopen the first research stage');
  assert.throws(()=>reject([f.w.id]),/endret/,'stale family requirements cannot suppress new research');
});
