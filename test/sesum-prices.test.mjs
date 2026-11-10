import test from 'node:test';
import assert from 'node:assert/strict';
import {createSesumPrices,sesumDonorFingerprint} from '../src/sesum-prices.mjs';
import {createSesumDiscovery} from '../src/sesum-discovery.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {productTextHash,groupMetadataFingerprint} from '../src/product-library.mjs';
import {createLibraryExplorer} from '../src/library-explorer.mjs';

const NOW='2026-11-09T12:10:00Z',OLD='2026-05-01T10:00:00Z',RECEIPT='2026-11-09T12:05:00Z';
function fixture({store='KIWI',old=false}={}){
 const productKey=`kassal:${store}:8`,p={store,id:'8',name:'Hakkede tomater 390 g',ean:'7030000000001',brand:'Synthetic',ingredients:'Tomater, tomatjuice',description:'Naturelle hermetiske tomater',sourceUrl:`https://shop.example/${store}/8`,pack:.39,unit:'kg',packKnown:true,packEvidence:'Read 390 g original label',rawPack:{weight:390,weightUnit:'g'},attributes:{organic:false},available:true,nutrition:{basis:'g',per100:{kcal:25}},quote:{grossPackPrice:15,grossUnitPrice:null,unit:'kg',directUnitVerified:false,receiptAt:old?OLD:'2026-11-09T12:00:00Z',reasons:[],sourceUrl:'https://shop.example/receipt'}};
 p.textHash=productTextHash(p);
 const index={builtAt:NOW,groups:{tomatoes:{name:'Hakkede tomater',unit:'kg',fingerprint:'a'.repeat(64)}},members:{tomatoes:[{k:productKey,s:'approved',r:true,u:15/.39,q:{score:100,key:'tomato-share',label:'Tomatandel'},n:null}]},products:{[productKey]:p},qualityNotes:{}};
 const state={},clock={at:NOW},native=[];let saves=0;
 const reader=()=>createIndexReader(index)(Date.parse(clock.at));
 const prices=createSesumPrices(state,{reader,save:()=>{saves++;},now:()=>new Date(clock.at),nativeEntries:()=>native});
 const source=(overrides={})=>({id:'123',name:p.name,brand:p.brand,vendor:'Synthetic vendor',ean:[p.ean],weight:390,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/123-hakkede-tomater',prices:[{storeCode:store==='COOP_NO'?'COOP_EXTRA':store,price:7.9,rawUnitPrice:7.9,source:'RECEIPT',observedAt:RECEIPT,isPromo:false,promotion:null}],...overrides});
 const ingest=(input=source())=>prices.ingest({familyIds:['family:tomatoes'],products:[input],fetchedAt:clock.at});
 const approve=(patch={})=>{const c=prices.candidates()[0];return prices.review({sourceKey:c.sourceKey,sourceFingerprint:c.sourceFingerprint,productKey,productFingerprint:sesumDonorFingerprint(p),status:'approved',packAmount:.39,unit:'kg',equivalenceEvidence:'Exact reviewed native variant, brand, EAN and contents; source package matched to label.',packEvidence:'Sesum 390 g and the original 390 g donor label agree.',...patch});};
 const nativeEntry=(patch={})=>({watchId:'family:tomatoes',store:p.store,id:p.id,status:'approved',name:p.name,ean:p.ean,brand:p.brand,ingredients:p.ingredients,description:p.description,sourceUrl:p.sourceUrl,weight:390,weightUnit:'g',packAmount:.39,unit:'kg',lastChecked:'2026-11-09T12:06:00Z',currentPrice:12,...patch});
 return {prices,state,clock,index,p,productKey,reader,source,ingest,approve,native,nativeEntry,saves:()=>saves};
}
test('matching names, EAN and brand only suggest donors; they never approve a source',()=>{
 const f=fixture();f.ingest();const [candidate]=f.prices.candidates('family:tomatoes');
 assert.equal(candidate.status,'pending');assert.equal(candidate.donors.length,1);assert.deepEqual(candidate.donors[0].match,{ean:true,name:true,brand:true,pack:true});
 assert.equal(f.prices.overlay().product(candidate.sourceKey),null);assert.equal(f.prices.overlay().quote(f.productKey).price.grossPackPrice,15);
 assert.equal(f.prices.candidates('family:other').length,0);
});

test('short source codes are preserved separately and never become barcode donor matches',()=>{
 const f=fixture();f.p.ean='4073';
 f.ingest(f.source({name:'Unmapped produce',brand:null,ean:[],nonEanCodes:['4073']}));
 const first=f.prices.candidates()[0];
 assert.deepEqual(first.source.nonEanCodes,['4073']);assert.deepEqual(first.source.ean,[]);assert.deepEqual(first.donors,[]);
 f.ingest(f.source({name:'Unmapped produce',brand:null,ean:[],nonEanCodes:['4074']}));
 assert.notEqual(f.prices.candidates()[0].sourceFingerprint,first.sourceFingerprint,'changed local identifiers require a new review');
 for(const code of ['https://example.test/id','bad code','bad\ncode',123,'x'.repeat(201),'7035620060182'])assert.throws(()=>f.ingest(f.source({nonEanCodes:[code]})),/non-EAN/);
});
test('opaque native source identifiers survive with real EANs but never become donor barcode matches',()=>{
 const f=fixture(),opaque='KIWI-v-tservietter-plastfri-64stk-lillego';f.p.ean=opaque;
 f.ingest(f.source({name:'Separate source item',brand:null,ean:['7035620060182'],nonEanCodes:[opaque]}));
 const row=f.prices.candidates()[0];assert.deepEqual(row.source.ean,['7035620060182']);assert.deepEqual(row.source.nonEanCodes,[opaque]);assert.equal(row.donors.length,0);assert.equal(row.price.price,7.9);
});
test('a reviewed bridge recomputes the unit price from package price and revives parked source rows',()=>{
 const f=fixture({old:true});f.ingest();f.approve();const key=f.prices.candidates()[0].sourceKey,over=f.prices.overlay();
 assert.equal(over.active(key),true);assert.equal(over.product(key).donorProductKey,f.productKey);assert.equal(over.product(key).source,'sesum');
 assert.equal(over.quote(key).price.grossPackPrice,7.9);assert.equal(over.members('tomatoes').find(r=>r.productKey===key).unitPrice,7.9/.39,'rawUnitPrice 7.9 is not trusted as kr/kg');
 assert.equal(over.quote(f.productKey).price.grossPackPrice,7.9,'same chain newer receipt supersedes old native price');
 assert.equal(f.p.quote.grossPackPrice,15,'the base compact library and original receipts are unchanged');
 assert.equal(over.index().products[key].sourceUrl,'https://www.sesum.no/produkt/123-hakkede-tomater');
});
test('price/date changes preserve a bridge; changed source metadata invalidates it',()=>{
 const f=fixture();f.ingest();f.approve();const before=f.prices.candidates()[0].sourceFingerprint;
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:7,observedAt:'2026-11-09T12:06:00Z',source:'RECEIPT'}]}));
 assert.equal(f.prices.candidates()[0].sourceFingerprint,before);assert.equal(f.prices.candidates()[0].status,'approved');assert.equal(f.prices.overlay().quote(f.productKey).price.grossPackPrice,7);
 f.ingest(f.source({name:'Krydrede tomater 390 g'}));assert.equal(f.prices.candidates()[0].status,'pending');assert.equal(f.prices.overlay().product('sesum:KIWI:123'),null);
 assert.throws(()=>f.approve({sourceFingerprint:before}),/source metadata changed/);
});
test('changed donor metadata or a noncurrent donor membership cannot lend identity or prices',()=>{
 const f=fixture();f.ingest();f.approve();const donorFingerprint=sesumDonorFingerprint(f.p);
 f.p.ingredients='Tomater, sukker';f.p.textHash=productTextHash(f.p);
 assert.equal(f.prices.candidates()[0].status,'pending');assert.equal(f.prices.overlay().product('sesum:KIWI:123'),null);
 assert.throws(()=>f.approve({productFingerprint:donorFingerprint}),/Donor metadata changed/);
 f.approve();f.index.members.tomatoes[0].r=false;
 assert.equal(f.prices.overlay().product('sesum:KIWI:123'),null);assert.throws(()=>f.approve(),/current reviewed product family/);
});
test('review requires explicit evidence and the same canonical package, with no variable-weight guess',()=>{
 const f=fixture();f.ingest();
 for(const patch of [{equivalenceEvidence:''},{packEvidence:''},{packAmount:.4},{unit:'l'}])assert.throws(()=>f.approve(patch));
 f.p.pack=.4;assert.throws(()=>f.approve({packAmount:.4}),/package amounts disagree/);
 const variable=fixture();variable.ingest(variable.source({soldByWeight:true}));assert.throws(()=>variable.approve(),/Variable-weight/);
});
test('a newer unknown or conflicting actual receipt suppresses older native and source prices',()=>{
 const f=fixture();f.ingest();f.approve();
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:null,observedAt:'2026-11-09T12:06:00Z',source:'RECEIPT'}]}));
 let over=f.prices.overlay();assert.equal(over.quote(f.productKey).price.grossPackPrice,null);assert.equal(over.quote('sesum:KIWI:123').price.grossPackPrice,null);assert.equal(over.members('tomatoes').filter(m=>m.eligible).length,0);
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:6,observedAt:'2026-11-09T12:07:00Z',source:'RECEIPT'}]}));
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:8,observedAt:'2026-11-09T12:07:00Z',source:'RECEIPT'}]}));
 over=f.prices.overlay();assert.equal(over.quote(f.productKey).price.grossPackPrice,null);assert.ok(over.quote(f.productKey).price.reasons.includes('conflicting-latest-prices'));
 f.ingest();assert.equal(f.prices.overlay().quote(f.productKey).price.grossPackPrice,null,'an older receipt cannot revive a pre-conflict price');
});
test('undated prices never become fresh when fetched and no future receipt is accepted',()=>{
 const f=fixture();f.ingest(f.source({prices:[{storeCode:'KIWI',price:6,observedAt:null}]}));f.approve();
 assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.fresh,false);assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.receiptAt,null);
 const revision=f.prices.revision();assert.throws(()=>f.ingest(f.source({prices:[{storeCode:'KIWI',price:6,observedAt:'2026-11-10T12:00:00Z'}]})),/future/);assert.equal(f.prices.revision(),revision);
});
test('COOP_NO can lend reviewed identity to Extra without changing generic Coop or other chains',()=>{
 const f=fixture({store:'COOP_NO',old:true});f.ingest();f.approve();const over=f.prices.overlay();
 assert.equal(over.product('sesum:COOP_EXTRA:123').store,'COOP_EXTRA');assert.equal(over.quote('sesum:COOP_EXTRA:123').price.grossPackPrice,7.9);
 assert.equal(over.quote(f.productKey).price.grossPackPrice,15);assert.equal(over.quote(f.productKey).price.receiptAt,OLD);assert.equal(over.product('sesum:COOP_PRIX:123'),null);
});
test('promotional prices with unverified conditions are held, and only bounded source fields are retained',()=>{
 const f=fixture();f.ingest(f.source({token:'secret-token',cookies:'secret-cookie',prices:[{storeCode:'KIWI',price:5,observedAt:RECEIPT,source:'RECEIPT',isPromo:true,promotion:{title:'Member campaign',member_only:true,accessToken:'secret-promotion-token'}}]}));f.approve();
 const quote=f.prices.overlay().quote('sesum:KIWI:123').price;assert.ok(quote.reasons.includes('unverified-promotion-conditions'));assert.equal(f.prices.overlay().members('tomatoes').filter(m=>m.eligible).length,0);
 assert.equal(JSON.stringify(f.state).includes('secret'),false);assert.equal(f.prices.candidates()[0].price.promotion.member_only,true);
});
test('native provider overrides require the existing native approval and exact text/package guards',()=>{
 const f=fixture();f.ingest();f.approve();
 const native={watchId:'family:tomatoes',store:f.p.store,id:f.p.id,status:'approved',name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:390,weightUnit:'g',packAmount:.39,unit:'kg'};
 let result=f.prices.provide([native],{status:'ready',quotes:[]});assert.equal(result.quotes.length,1);assert.equal(result.quotes[0].grossPackPrice,7.9);
 for(const patch of [{status:'excluded'},{name:'Another variant'},{packAmount:1},{weight:400}])assert.equal(f.prices.provide([{...native,...patch}],{status:'ready',quotes:[]}).quotes.length,0);
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:null,observedAt:'2026-11-09T12:06:00Z',source:'RECEIPT'}]}));
 result=f.prices.provide([native],{status:'ready',quotes:[{watchId:native.watchId,store:native.store,id:native.id,grossPackPrice:15,receiptAt:'2026-11-09T12:00:00Z'}]});assert.equal(result.quotes.length,1);assert.equal(result.quotes[0].grossPackPrice,null);
});
test('source exclusions remain explicit, no name-only decision is created, and price age expires live',()=>{
 const f=fixture();f.ingest();const candidate=f.prices.candidates()[0];
 f.prices.review({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,status:'excluded',equivalenceEvidence:'Different variant, do not compare.'});assert.equal(f.prices.candidates()[0].status,'excluded');assert.equal(f.prices.overlay().product(candidate.sourceKey),null);
 f.approve();f.clock.at='2026-11-12T12:00:00Z';assert.equal(f.prices.overlay().quote(candidate.sourceKey).price.fresh,false);assert.equal(f.prices.overlay().members('tomatoes').filter(m=>m.eligible).length,0);
});
test('unknown weight mode remains null and requires an explicit fixed-package review',()=>{
 const f=fixture();f.ingest(f.source({soldByWeight:null}));assert.equal(f.prices.candidates()[0].source.soldByWeight,null);
 assert.throws(()=>f.approve(),/Unknown Sesum weight mode/);
 f.approve({fixedPackVerified:true});assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.grossPackPrice,7.9);
});
test('pending is lightweight, omits parked receipts, and a compiled overlay is reused while freshness decays',()=>{
 const f=fixture();f.ingest();assert.deepEqual(Object.keys(f.prices.pending()[0]),['sourceKey','sourceFingerprint','name','familyIds','receiptAt','hasReviewedDonor']);
 f.approve();assert.equal(f.prices.pending().length,0);const index=f.prices.overlay().index();assert.equal(f.prices.overlay().index(),index,'compiled compact index is reused across views');
 f.clock.at='2026-11-12T12:00:00Z';assert.equal(f.prices.overlay().index(),index);assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.fresh,false,'clock is applied per reader call');
 const old=fixture();old.ingest(old.source({prices:[{storeCode:'KIWI',price:6,observedAt:'2026-01-01T12:00:00Z'}]}));assert.equal(old.prices.pending().length,0);
});

test('newer same-chain library receipts supersede older source prices without rewriting their evidence',()=>{
 const f=fixture();f.ingest();f.approve();const sourceKey=f.prices.candidates()[0].sourceKey,original=f.prices.sourceRecord(sourceKey);
 const before=f.prices.overlay().index();
 f.p.quote={...f.p.quote,grossPackPrice:14,receiptAt:'2026-11-09T12:06:00Z'};
 let over=f.prices.overlay();assert.notEqual(over.index(),before);
 assert.equal(over.quote(f.productKey).price.grossPackPrice,14);
 const oldSource=over.members('tomatoes').find(m=>m.productKey===sourceKey);
 assert.equal(oldSource.eligible,false);assert.ok(oldSource.price.reasons.includes('superseded-price-receipt'));
 assert.equal(over.members('tomatoes').filter(m=>m.eligible).every(m=>m.price.grossPackPrice===14),true);
 assert.deepEqual(f.prices.sourceRecord(sourceKey),original,'original Sesum receipt is retained separately from current-price reconciliation');
 f.p.quote={...f.p.quote,grossPackPrice:null,receiptAt:'2026-11-09T12:07:00Z',reasons:['unknown-gross-package-price']};
 over=f.prices.overlay();assert.equal(over.members('tomatoes').some(m=>m.eligible),false,'newer native unknown must not leave an older source price actionable');
});

test('newer compatible catalog receipts and conflicts cap all duplicate rows and invalidate the overlay cache',()=>{
 const f=fixture();f.ingest();f.approve();const sourceKey=f.prices.candidates()[0].sourceKey,before=f.prices.overlay().index();
 const native=f.nativeEntry();f.native.push(native);
 let over=f.prices.overlay();assert.notEqual(over.index(),before);assert.equal(over.quote(f.productKey).price.grossPackPrice,12);
 assert.equal(over.members('tomatoes').find(m=>m.productKey===sourceKey).eligible,false);
 assert.equal(f.prices.provide([native],{status:'ready',quotes:[]}).quotes[0].grossPackPrice,12);
 native.currentPrice=null;native.lastChecked='2026-11-09T12:07:00Z';
 over=f.prices.overlay();assert.equal(over.members('tomatoes').some(m=>m.eligible),false);
 native.currentPrice=9;native.lastChecked=RECEIPT;
 over=f.prices.overlay();assert.equal(over.members('tomatoes').some(m=>m.eligible),false,'different prices at the same actual time remain a conflict');
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:6,observedAt:'2026-11-09T12:08:00Z',source:'receipt'}]}));
 over=f.prices.overlay();assert.equal(over.quote(f.productKey).price.grossPackPrice,6);
 assert.equal(over.members('tomatoes').find(m=>m.productKey===sourceKey).eligible,true,'a genuinely newer source receipt wins in the opposite direction');
 assert.equal(native.currentPrice,9,'catalog originals are never rewritten');
});

test('incompatible or undated catalog metadata never lends a newer package or price',()=>{
 for(const patch of [{status:'pending'},{status:'excluded'},{name:'Different recipe'},
   {packAmount:.4},{weight:400},{lastChecked:null},{lastChecked:'2026-11-10T12:00:00Z'}]){
  const f=fixture();f.ingest();f.approve();f.native.push(f.nativeEntry(patch));
  assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.grossPackPrice,7.9);
  assert.equal(f.prices.overlay().members('tomatoes').find(m=>m.productKey==='sesum:KIWI:123').eligible,true);
 }
});

test('same-chain unavailability is preserved while another chain remains independent',()=>{
 const same=fixture();same.ingest();same.approve();same.p.available=false;
 assert.equal(same.prices.overlay().members('tomatoes').some(m=>m.eligible),false);
 const other=fixture({store:'COOP_NO'});other.ingest();other.approve();other.p.available=false;
 assert.equal(other.prices.overlay().members('tomatoes').find(m=>m.productKey==='sesum:COOP_EXTRA:123').eligible,true);
});

test('drained canonical kg needs explicit original-label evidence and never changes the quoted gross pack',()=>{
 const f=fixture();f.p.pack=.23;f.p.rawPack={weight:380,weightUnit:'g'};
 f.ingest(f.source({weight:380}));
 assert.throws(()=>f.approve({packAmount:.23}),/package amounts disagree/);
 assert.throws(()=>f.approve({packAmount:.23,packBasis:'drained'}),/drained package evidence/);
 const bridge=f.approve({packAmount:.23,packBasis:'drained',packBasisEvidence:'The actual original can states 380 g net and 230 g drained beans.'});
 assert.equal(bridge.packBasis,'drained');assert.equal(f.prices.sourceRecord('sesum:KIWI:123').source.weight,380);
 assert.equal(f.prices.overlay().members('tomatoes').find(m=>m.productKey==='sesum:KIWI:123').unitPrice,7.9/.23);
 const tooLarge=fixture();tooLarge.p.pack=.5;tooLarge.ingest();
 assert.throws(()=>tooLarge.approve({packAmount:.5,packBasis:'drained',packBasisEvidence:'Synthetic evidence'}),/at least as large/);
 const wrongUnit=fixture();wrongUnit.p.unit='l';wrongUnit.ingest();
 assert.throws(()=>wrongUnit.approve({unit:'l',packBasis:'drained',packBasisEvidence:'Synthetic evidence'}),/known gross kg/);
});

test('new reviewed native Sesum products can be their own donor without duplicate memberships or recursive overlay approval',()=>{
 const f=fixture(),selfKey='sesum:KIWI:123';f.ingest();
 const record=f.prices.sourceRecord(selfKey),native={...f.p,source:'sesum',id:'123',sourceUrl:record.source.sourceUrl,
  nativeDiscovery:true,sourceFingerprint:record.sourceFingerprint};
 delete f.index.products[f.productKey];f.index.products[selfKey]=native;f.index.members.tomatoes[0].k=selfKey;
 const [candidate]=f.prices.candidates();assert.equal(candidate.donors.some(d=>d.productKey===selfKey),true);
 const approve=()=>f.prices.review({status:'approved',sourceKey:selfKey,sourceFingerprint:record.sourceFingerprint,
  productKey:selfKey,productFingerprint:sesumDonorFingerprint(native),packAmount:.39,unit:'kg',
  equivalenceEvidence:'The actual new source product and original contents were explicitly reviewed into this family.',packEvidence:'Original fixed 390 g package read.'});
 approve();let over=f.prices.overlay();assert.equal(over.members('tomatoes').filter(m=>m.productKey===selfKey).length,1);
 assert.equal(over.quote(selfKey).price.grossPackPrice,7.9);
 const snapshot=f.prices.sourceRecord(selfKey);snapshot.source.name='Caller mutation';assert.notEqual(f.prices.sourceRecord(selfKey).source.name,snapshot.source.name);
 native.sourceFingerprint='b'.repeat(64);assert.throws(approve,/Donor metadata changed/);
 native.sourceFingerprint=record.sourceFingerprint;native.donorProductKey='kassal:KIWI:8';assert.throws(approve,/Donor metadata changed/);
 delete native.donorProductKey;native.nativeDiscovery=false;assert.throws(approve,/Donor metadata changed/);
});

test('self registration uses the explicitly bound same-chain latest price inside its new narrow family',()=>{
 const f=fixture(),state={},native=[],selfKey='sesum:KIWI:123',narrow={id:'narrow-source-family',name:'Narrow source family',category:'Synthetic',canonicalUnit:'kg',inclusionCriteria:'The specifically researched plain variant',exclusions:['Other variants'],qualityBasis:'Actual independently read contents',comparisonBasis:'Per kg'};
 let discovery;
 const prices=createSesumPrices(state,{now:()=>new Date(f.clock.at),reader:()=>discovery?.overlay(f.reader())??f.reader(),nativeEntries:()=>native});
 discovery=createSesumDiscovery({}, {now:()=>new Date(f.clock.at),reader:f.reader,source:key=>prices.sourceRecord(key)});
 prices.ingest({familyIds:['family:narrow'],products:[f.source()],fetchedAt:NOW});
 const source=prices.sourceRecord(selfKey);
 discovery.register({sourceKey:selfKey,sourceFingerprint:source.sourceFingerprint,identityEvidence:'Actual source SKU, brand, physical form and fixed package researched.',nativeProductKey:f.productKey,nativeProductFingerprint:sesumDonorFingerprint(f.p),nativeIdentityEvidence:'The same physical brand/variant and fixed 390 g pack was explicitly verified in both primary sources.',product:{ingredients:null,description:'Source contents are independent; no native recipe was copied.'},packAmount:.39,unit:'kg',packEvidence:'Original fixed 390 g source package read.',groups:[narrow],memberships:[{groupId:narrow.id,groupFingerprint:groupMetadataFingerprint(narrow),equivalenceEvidence:'This specific source variant satisfies the narrow rules.',qualityEvidence:'Actual source form and label reviewed independently.'}],sourceReceipts:[{url:'https://shop.example/original-label',observedAt:RECEIPT,evidence:'Actual fixed package and physical identity were read.'}]});
 const self=discovery.overlay().product(selfKey);
 prices.review({sourceKey:selfKey,sourceFingerprint:source.sourceFingerprint,status:'approved',productKey:selfKey,productFingerprint:sesumDonorFingerprint(self),packAmount:.39,unit:'kg',equivalenceEvidence:'The independently registered source product is approved for its narrow family.',packEvidence:'Actual fixed 390 g package verified.'});
 assert.equal(prices.overlay().quote(selfKey).price.grossPackPrice,7.9);
 const before=prices.overlay().index();
 f.index.products[f.productKey]={...f.p,quote:{...f.p.quote,grossPackPrice:20,receiptAt:'2026-11-09T12:06:00Z'}};
 let over=prices.overlay();assert.notEqual(over.index(),before);assert.equal(over.quote(selfKey).price.grossPackPrice,20);assert.equal(over.quote(selfKey).price.receiptAt,'2026-11-09T12:06:00Z');
 assert.equal(over.members(narrow.id).filter(m=>m.eligible).length,1,'latest physical native quote remains usable in the source-only narrow family');
 assert.equal(over.product(selfKey).ingredients,null);assert.equal(over.product(selfKey).nutrition,null);
 assert.equal(over.product(selfKey).nativeIdentity.key,f.productKey);assert.equal(over.product(selfKey).nativeIdentity.textHash,f.p.textHash);
 assert.equal(prices.sourceRecord(selfKey).price.price,7.9);assert.equal(prices.sourceRecord(selfKey).price.observedAt,new Date(RECEIPT).toISOString(),'stored original Sesum receipt is never rewritten');
 native.push(f.nativeEntry({lastChecked:'2026-11-09T12:07:00Z',currentPrice:null}));
 over=prices.overlay();assert.equal(over.quote(selfKey).price.grossPackPrice,null);assert.ok(over.quote(selfKey).price.reasons.includes('unknown-gross-package-price'));assert.equal(over.members(narrow.id).some(m=>m.eligible),false);
 native[0]=f.nativeEntry({lastChecked:'2026-11-09T12:07:00Z',currentPrice:22});
 prices.ingest({familyIds:['family:narrow'],products:[f.source({prices:[{storeCode:'KIWI',price:7.9,source:'RECEIPT',observedAt:'2026-11-09T12:07:00Z'}]})],fetchedAt:NOW});
 over=prices.overlay();assert.equal(over.quote(selfKey).price.grossPackPrice,null);assert.ok(over.quote(selfKey).price.reasons.includes('conflicting-latest-prices'));assert.equal(over.members(narrow.id).some(m=>m.eligible),false);
 f.index.products[f.productKey]={...f.index.products[f.productKey],ingredients:'Changed physical native contents'};
 assert.equal(discovery.record(selfKey),null);assert.equal(prices.overlay().product(selfKey),null,'native identity changes cannot lend their old reviewed relation');
});

test('explicit source identity may lend a fresh quote to an approved native row without copying family memberships',()=>{
 const f=fixture(),selfKey='sesum:KIWI:123';f.ingest();
 const source=f.prices.sourceRecord(selfKey),self={...structuredClone(f.p),source:'sesum',id:'123',sourceUrl:source.source.sourceUrl,nativeDiscovery:true,sourceFingerprint:source.sourceFingerprint,ingredients:null,nutrition:null,nativeIdentity:{key:f.productKey,metadataFingerprint:sesumDonorFingerprint(f.p),textHash:f.p.textHash,rawPack:structuredClone(f.p.rawPack),pack:.39,unit:'kg'}};
 self.textHash=productTextHash(self);
 f.index.products[selfKey]=self;f.index.members.tomatoes=[{k:selfKey,s:'approved',r:true,u:null,q:null,n:null}];
 f.prices.review({status:'approved',sourceKey:selfKey,sourceFingerprint:source.sourceFingerprint,productKey:selfKey,productFingerprint:sesumDonorFingerprint(self),packAmount:.39,unit:'kg',equivalenceEvidence:'Explicitly registered source-only narrow family and native identity.',packEvidence:'Actual same fixed package read.'});
 const entry=f.nativeEntry({lastChecked:'2026-11-09T12:04:00Z',currentPrice:15});
 const result=f.prices.provide([entry],{status:'ready',quotes:[]});assert.equal(result.quotes.length,1);assert.equal(result.quotes[0].grossPackPrice,7.9);
 assert.equal(f.prices.overlay().groupsOf(f.productKey).length,0,'price reconciliation adds no native family membership');
 for(const patch of [{status:'excluded'},{name:'Different native variant'},{packAmount:1}])assert.equal(f.prices.provide([{...entry,...patch}],{status:'ready',quotes:[]}).quotes.length,0);
});

test('candidate-only products retain safe research evidence without inventing a usable price or chain',()=>{
 const f=fixture();f.ingest(f.source({id:'124',name:'Unseen brand plain beans',brand:'Unseen',ean:null,
  sourceUrl:'https://www.sesum.no/produkt/124-unseen-beans',prices:[],priceCandidates:[
   {storeCode:'EXTRA',storeId:10,price:6.9,observedAt:null,source:null,reason:'missing_price_provenance',accessToken:'secret-candidate',promotion:{title:'Unproven',token:'secret-promotion'}},
   {storeCode:null,price:2,source:'unknown-chain'}]}));
 const key='sesum:COOP_EXTRA:124',record=f.prices.sourceRecord(key);
 assert.equal(f.prices.status().products,1);assert.equal(record.price.price,null);assert.equal(record.price.candidate.price,6.9);
 assert.equal(record.price.observedAt,null);assert.ok(record.price.reasons.includes('unproven-price-candidate'));
 assert.ok(record.price.reasons.includes('missing-price-receipt'));assert.ok(record.price.reasons.includes('missing-price-source'));
 assert.equal(f.prices.pending().length,1);assert.equal(f.prices.pending()[0].hasReviewedDonor,false);
 assert.equal(JSON.stringify(f.state).includes('secret'),false);
 assert.equal(f.prices.overlay().product(key),null,'research evidence never approves membership or price');
});

test('invalid candidate dates remain unknown and explicit bridge review never turns their quoted price into a receipt',()=>{
 for(const observedAt of [null,'not-a-date','2026-11-10T12:00:00Z']){
  const f=fixture();f.ingest(f.source({prices:[],priceCandidates:[{storeCode:'KIWI',price:1,observedAt,source:'unproven',reason:'unproven'}]}));
  const record=f.prices.sourceRecord('sesum:KIWI:123');assert.equal(record.price.observedAt,null);assert.equal(record.price.candidate.observedAt,null);
  f.approve();const quote=f.prices.overlay().quote('sesum:KIWI:123');
  assert.equal(quote.price.grossPackPrice,null);assert.equal(quote.price.fresh,false);assert.ok(quote.price.reasons.includes('unproven-price-candidate'));
  assert.equal(f.prices.overlay().quote(f.productKey).price.grossPackPrice,15,'an unproven candidate cannot wipe a valid native receipt');
 }
 const dated=fixture();dated.ingest(dated.source({prices:[],priceCandidates:[{storeCode:'KIWI',price:1,observedAt:RECEIPT,source:'unproven'}]}));dated.approve();
 assert.equal(dated.prices.overlay().quote('sesum:KIWI:123').price.grossPackPrice,null);
 assert.equal(dated.prices.overlay().members('tomatoes').find(m=>m.productKey==='sesum:KIWI:123').eligible,false);
 assert.equal(dated.prices.overlay().quote(dated.productKey).price.grossPackPrice,15);
});

test('actual source receipts outrank duplicate unproven candidates in the payload and later refreshes',()=>{
 const f=fixture(),candidate={storeCode:'KIWI',price:1,observedAt:'2026-11-09T12:09:00Z',source:null};
 f.ingest(f.source({priceCandidates:[candidate]}));f.approve();
 let record=f.prices.sourceRecord('sesum:KIWI:123');assert.equal(record.price.price,7.9);assert.equal(record.price.candidate.price,1);
 assert.equal(record.price.observedAt,'2026-11-09T12:05:00.000Z');assert.equal(f.prices.overlay().quote('sesum:KIWI:123').price.grossPackPrice,7.9);
 f.ingest(f.source({prices:[],priceCandidates:[{...candidate,observedAt:null}]}));
 record=f.prices.sourceRecord('sesum:KIWI:123');assert.equal(record.price.price,7.9);assert.equal(record.price.observedAt,'2026-11-09T12:05:00.000Z');
 assert.equal(record.price.candidate.observedAt,null);assert.equal(f.prices.overlay().members('tomatoes').find(m=>m.productKey==='sesum:KIWI:123').eligible,true);
 const replaced=fixture();replaced.ingest(replaced.source({prices:[],priceCandidates:[{...candidate,observedAt:'2026-11-09T12:09:00Z'}]}));
 replaced.ingest();replaced.approve();assert.equal(replaced.prices.sourceRecord('sesum:KIWI:123').price.price,7.9,'a real receipt also outranks a newer timestamp on an unproven prior candidate');
});
test('explorer bundles invalidate on bridge review, actual price change, exclusion and donor invalidation',async()=>{
 const f=fixture(),explorer=createLibraryExplorer({reader:()=>f.prices.overlay(),imageRef:()=>null,chainName:code=>code,ownStores:()=>['KIWI']});
 const sourceKey='sesum:KIWI:123',hasSource=bundle=>JSON.parse(bundle.json).items.some(item=>item.p.some(post=>post[0]===sourceKey));
 const sourcePrice=bundle=>JSON.parse(bundle.json).items.flatMap(item=>item.p).find(post=>post[0]===sourceKey)?.[2];
 const originalBuilt=f.reader().builtAt,initial=await explorer.bundle();assert.equal(hasSource(initial),false);
 f.ingest();const observed=await explorer.bundle();assert.notEqual(observed.key,initial.key);assert.equal(hasSource(observed),false,'observation alone never adds an approved row');
 f.approve();const approved=await explorer.bundle();assert.notEqual(approved.key,observed.key);assert.equal(sourcePrice(approved),7.9);assert.equal(approved.built,originalBuilt);
 assert.equal(await explorer.bundle(),approved,'an unchanged semantic revision still uses the compressed cache');
 f.ingest(f.source({prices:[{storeCode:'KIWI',price:7,observedAt:'2026-11-09T12:06:00Z',source:'RECEIPT'}]}));
 const repriced=await explorer.bundle();assert.notEqual(repriced.etag,approved.etag);assert.equal(sourcePrice(repriced),7);assert.equal(repriced.built,originalBuilt);
 const candidate=f.prices.candidates()[0];f.prices.review({sourceKey,sourceFingerprint:candidate.sourceFingerprint,status:'excluded',equivalenceEvidence:'Explicitly withdrawn source identity.'});
 const excluded=await explorer.bundle();assert.notEqual(excluded.key,repriced.key);assert.equal(hasSource(excluded),false,'returning to the base reader cannot reuse the old overlay bundle');
 f.approve();const restored=await explorer.bundle();assert.equal(hasSource(restored),true);const revision=f.prices.revision();
 f.p.ingredients='Changed source label';f.p.textHash=productTextHash(f.p);
 const changed=await explorer.bundle();assert.equal(f.prices.revision(),revision,'the donor can change without a new Sesum observation');assert.notEqual(changed.key,restored.key);assert.equal(hasSource(changed),false);assert.equal(changed.built,originalBuilt);
 assert.equal(f.state.products[sourceKey].receipt.observedAt,'2026-11-09T12:06:00.000Z','cache revisions never manufacture newer price receipts');
});
