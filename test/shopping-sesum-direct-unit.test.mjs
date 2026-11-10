import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';
import {sesumDonorFingerprint} from '../src/sesum-prices.mjs';

const NOW='2026-11-10T12:00:00Z',SOURCE='sesum:KIWI:999',URL='https://www.sesum.no/produkt/999-fresh-whole-ginger-root';
const group=(id,name)=>({id,name,category:'Produce',canonicalUnit:'kg',inclusionCriteria:'Plain fresh whole ginger root; fixed bags and variable-weight roots may be compared per kg.',exclusions:['Ground dried ginger','Prepared sweetened ginger'],qualityBasis:'Actual ingredient declaration and fresh whole-root form',comparisonBasis:'Per kg'});
function fixture(t,{variableDonor=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'sesum-direct-unit-'));t.after(()=>{if(!resolve(dir).startsWith(resolve(tmpdir(),'sesum-direct-unit-')))throw Error('Unsafe test cleanup');rmSync(dir,{recursive:true,force:true});});
  const A=group('ginger','Fresh whole ginger'),B=group('new-ginger','New researched whole ginger variants');
  const product=(store,id,price)=>{const p={productKey:`kassal:${store}:${id}`,source:'kassal',store,id,name:'Fresh whole ginger 500g fixed bag',brand:'Baseline',ean:null,ingredients:'Fresh ginger root',description:'Plain whole fresh roots',attributes:{organic:false},sourceUrl:store==='ODA_NO'?'https://oda.com/no/products/451-fixed-ginger/':`https://shop.example.test/${store}/${id}`,canonicalPackAmount:.5,unit:'kg',packEvidence:'Read one actual fixed 500g bag, not an approximate weight.',rawPack:{weight:500,weightUnit:'g'},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);return {p,q:{productKey:p.productKey,grossPackPrice:price,receiptAt:NOW,sourceUrl:p.sourceUrl,availabilityScope:'chain'}};};
  const oda=product('ODA_NO','71',120),spar=product('SPAR_NO','72',100);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[A],products:[oda.p,spar.p],prices:[oda.q,spar.q],memberships:[]};
  const membership=p=>({groupId:A.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(A),equivalenceEvidence:'Read the actual plain fresh whole ginger roots and their unchanged kitchen use.',qualityEvidence:'Read the complete actual original ingredient declaration and fresh whole-root form.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Read the actual label, whole-root form and package.'}]});
  data.memberships.push(...data.products.map(membership));
  let donor=null;
  if(variableDonor){donor={...oda.p,productKey:'kassal:KIWI:73',store:'KIWI',id:'73',name:'Fresh whole ginger root',brand:'New',sourceUrl:'https://shop.example.test/kiwi/loose-ginger',canonicalPackAmount:null,packEvidence:'The original source sells whole roots by actual variable weight; no fixed package.',rawPack:{weight:null,weightUnit:null}};donor.metadataFingerprint=productMetadataFingerprint(donor);data.products.push(donor);data.memberships.push(membership(donor));data.prices.push({productKey:donor.productKey,grossPackPrice:null,grossUnitPrice:250,unit:'kg',unitPriceEvidence:'The actual own primary source quotes 250 NOK per kg for loose fresh whole ginger.',priceIncludesVat:true,receiptAt:'2026-11-10T11:59:00Z',sourceUrl:donor.sourceUrl,availabilityScope:'chain'});}
  const file=join(dir,'library.json'),write=()=>writeFileSync(file,JSON.stringify(data),'utf8');write();
  let state={},shop,provider;const clock={at:NOW},open=()=>{provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)});shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});};open();
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi',minSavings:0},{id:'spar',name:'SPAR',chainCode:'SPAR_NO',url:'https://shop.example.test/spar',minSavings:0},{id:'extra',name:'Extra',chainCode:'COOP_EXTRA',url:'https://shop.example.test/extra',minSavings:0}]});
  const w=shop.watch({id:'ginger-family',name:'Fresh whole ginger',unit:'kg',storage:'chilled',purchaseAmount:24,stockAmount:.5,stockCheckedAt:NOW,targetPrice:220,excellentPrice:150,priceGuide:{referencePrice:240,checkedAt:NOW,evidence:'Explicit conservative planning reference from prior purchases.'},note:'Plain fresh whole ginger roots; organic is not required.'});
  const link=(groups=[A],extra={})=>shop.libraryLink({familyId:w.id,evidence:'Current explicit household decision for plain fresh whole ginger.',variants:groups.map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Actual plain fresh whole-root form and kitchen use match.',...extra}))});link();
  const source={id:'999',name:'Fresh whole ginger root',brand:'New',ean:null,weight:null,weightUnit:null,soldByWeight:true,sourceUrl:URL};
  const ingest=({price=109,observedAt=clock.at,basis=true,unit='kg',promotion=null,isPromo=false,sourceChanges={},proofChanges={},priceSource='actual_paid_receipt',asCandidate=false}={})=>{
    const row={storeId:'4',storeCode:'KIWI',price,rawUnitPrice:999,observedAt,source:priceSource,isPromo,promotion};
    if(basis)row.unitPriceBasis={kind:'own-chain-row-label-v1',productId:'999',sourceUrl:URL,storeId:'4',storeCode:'KIWI',rowControl:'kjederad-4',label:`${Number(price).toFixed(2).replace('.',',')} kr/${unit}`,amount:price,unit,observedAt,source:row.source,...proofChanges};
    return shop.sesumReceivePrices({familyIds:[w.id],fetchedAt:clock.at,products:[{...source,...sourceChanges,prices:asCandidate?[]:[row],...(asCandidate?{priceCandidates:[{...row,reason:'missing_price_provenance'}]}:{})}]});
  };
  const candidate=()=>shop.sesumCandidates(w.id).find(p=>p.sourceKey===SOURCE),item=()=>shop.familyView().items.find(p=>p.id===w.id),member=()=>shop.explorer.family('followed:'+w.id).family.members.find(p=>p.key===SOURCE);
  const basisReview={priceBasis:'direct-unit',packAmount:null,unit:'kg',variableWeightEvidence:'The actual own product is sold by weight and has no fixed package or assumed one-kg bag.',unitPriceEvidence:'Read the actual own KIWI chain row, kjederad-4, explicitly labelled 109,00 kr/kg and bound to its own actual receipt.',priceIncludesVat:true,vatEvidence:'The actual primary source explicitly confirms a gross consumer price including VAT.',packEvidence:'Read the original loose whole roots and explicit sold-by-weight presentation; there is no fixed package.'};
  const register=(extra={})=>shop.sesumRegister({sourceKey:SOURCE,sourceFingerprint:candidate().sourceFingerprint,identityEvidence:'Read the actual New-brand plain fresh whole ginger roots and primary label; no EAN or organic claim is invented.',product:{ingredients:'Fresh ginger root',description:'Plain fresh whole roots, sold by actual variable weight',brand:'New',attributes:{organic:false}},...basisReview,groups:[B],memberships:[{groupId:B.id,groupFingerprint:groupMetadataFingerprint(B),equivalenceEvidence:'The actual fresh whole ginger root ingredient and kitchen use match this current reviewed group.',qualityEvidence:'Read the complete actual original fresh whole-root label; organic status is explicitly not claimed.'}],sourceReceipts:[{url:'https://producer.example.test/new-ginger-label',observedAt:clock.at,evidence:'Read the actual original whole-root label, variable-weight presentation and gross consumer kg price basis.'}],...extra});
  const bridge=(p=donor,extra={})=>shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:candidate().sourceFingerprint,status:'approved',productKey:p.productKey,productFingerprint:sesumDonorFingerprint(provider.reader().product(p.productKey)),equivalenceEvidence:'Read both actual records and primary contents: the same plain fresh whole ginger roots, variable sale mode and gross kg-price basis.',...basisReview,variableDonorVerified:true,donorVariableWeightEvidence:'Read the actual original donor primary label: whole roots sold by actual variable weight, with no fixed pack.',reviewedGroups:[{groupId:A.id,groupFingerprint:groupMetadataFingerprint(A)}],donorSourceReceipts:[{url:p.sourceUrl,observedAt:clock.at,evidence:'Read the actual primary donor product label confirming variable-weight whole roots and no fixed package.'}],sourceReceipts:[{url:'https://producer.example.test/new-ginger-label',observedAt:clock.at,evidence:'Read the actual own source label, variable-weight roots and gross consumer kg price basis.'}],...extra});
  return {get shop(){return shop;},get state(){return state;},get provider(){return provider;},clock,data,write,A,B,w,oda:oda.p,spar:spar.p,donor,ingest,candidate,item,member,register,bridge,link,reload(){state=JSON.parse(JSON.stringify(state));open();}};
}

test('a new variable source joins the household only through actual group choice and supplies no invented package or need',t=>{
  const f=fixture(t),before=structuredClone(f.state.shopping.watches[f.w.id]);f.ingest();assert.equal(f.item().prices.current,200);f.register();assert.equal(f.item().prices.current,200,'researching a new group cannot extend an existing family');
  f.link([f.A,f.B]);assert.equal(f.item().prices.current,109);assert.equal(f.item().prices.evaluationReference,109);assert.equal(f.item().prices.historyDays,0);assert.equal(f.item().prices.lowestSeen,null);
  assert.equal(f.member().unitPrice,109);assert.equal(f.member().pack,null);
  f.shop.list({action:'add',watchId:f.w.id,storeName:'Oda',odaProductId:451,packAmount:.5,packs:2,unitPrice:240});
  const view=f.shop.familyView(),source=view.list.open[0].others.find(p=>p.productKey===SOURCE);assert.equal(source.unitPrice,109);assert.equal(source.packAmount,null);assert.equal(source.packPrice,null);assert.equal(source.odaProductId,undefined);
  const draft=view.odaDraft.items.find(p=>p.watchId===f.w.id);assert.equal(draft.productId,451);assert.equal(draft.packAmount,.5);assert.ok(draft.others.some(p=>p.productKey===SOURCE&&p.packAmount===null&&p.packPrice===null));assert.equal(draft.elsewhere.unitPrice,109);assert.equal(draft.elsewhere.packAmount,null);
  const cart=f.shop.cartReview({groups:[{items:[{product:{id:451,name:f.oda.name},quantity:2,totalGrossAmount:240}]}],validationMessages:[]});assert.deepEqual(cart.lines[0].cheapestKnown,{storeName:'KIWI',unitPrice:109});assert.equal(cart.lines[0].packAmount,.5);
  assert.ok(view.steady.every(row=>row.productKey!==SOURCE&&row.packAmount>0),'a nullable unit quote cannot become a bulk pack');
  for(const field of ['stockAmount','stockCheckedAt','stockPacks','purchaseAmount','monthlyUsage','priceGuide','marketCalibration'])assert.deepEqual(f.state.shopping.watches[f.w.id][field],before[field],field);assert.equal(f.state.shopping.purchases.length,0);assert.equal(f.state.shopping.orders&&Object.keys(f.state.shopping.orders).length,0);
  assert.ok(!f.item().packs.some(p=>p.amount===1),'no one-kg source package is invented');f.reload();assert.equal(f.item().prices.current,109);assert.equal(f.member().pack,null);
});

test('the direct unit quote caps an ordinary fixed-pack offer and its pantry and bulk comparisons',t=>{
  const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);
  const offer=f.shop.offer({watchId:f.w.id,storeId:'extra',externalId:'ginger-fixed-flyer',name:'Fresh whole ginger fixed 500g bag',price:50,packAmount:.5,unit:'kg',validFrom:'2026-11-10',validTo:'2026-11-16',observedAt:NOW,comparable:true,comparisonNote:'Read the actual plain fresh whole roots and fixed 500g bag against the household family.',sourceUrl:'https://shop.example.test/flyer/ginger',evidence:'Read the actual fixed 500g bag and all current primary campaign terms.'});
  const view=f.shop.familyView(),deal=[...view.deals,...view.smallDeals,...view.belowTrip,...view.covered].find(d=>d.offerId===offer.id);assert.ok(deal);assert.equal(deal.referencePrice,109);assert.equal(deal.unitPrice,100);assert.equal(deal.packAmount,.5);assert.ok(deal.options.every(option=>option.saving<=9*option.packs*.5+.01));
  assert.equal(view.items.find(p=>p.id===f.w.id).prices.current,100);assert.equal(f.state.shopping.watches[f.w.id].stockAmount,.5);assert.equal(f.state.shopping.watches[f.w.id].purchaseAmount,24);
});

test('only an actually reviewed variable donor can bridge a variable unit source',t=>{
  const fixed=fixture(t);fixed.ingest();assert.throws(()=>fixed.bridge(fixed.oda),/variable|package|direct|pack/i);assert.equal(fixed.item().prices.current,200);
  const variable=fixture(t,{variableDonor:true});variable.ingest();assert.throws(()=>variable.bridge(undefined,{variableDonorVerified:false}),/variable donor|variable/i);assert.throws(()=>variable.bridge(undefined,{reviewedGroups:[{groupId:variable.A.id,groupFingerprint:'0'.repeat(64)}]}),/group|famil/i);variable.bridge();assert.equal(variable.item().prices.current,109);assert.equal(variable.member().pack,null);
  const native=variable.shop.explorer.family('followed:'+variable.w.id).family.members.find(p=>p.key===variable.donor.productKey);assert.ok(!native||native.unitPrice!==250,'a bridge reconciles only the documented exact native alias, not an unrelated old quote');
  const missing=fixture(t);missing.ingest();for(const patch of [{packAmount:1},{priceIncludesVat:false},{vatEvidence:''},{unitPriceEvidence:''},{variableWeightEvidence:''},{unit:'stk'},{fixedPackVerified:true},{packBasis:'net'},{nativeProductKey:missing.oda.productKey,nativeProductFingerprint:sesumDonorFingerprint(missing.provider.reader().product(missing.oda.productKey)),nativeIdentityEvidence:'A variable source cannot adopt an existing fixed native identity.'}])assert.throws(()=>missing.register(patch));
  assert.equal(missing.item().prices.current,200);
});

test('newer missing, unknown, wrong-unit or campaign-held own receipts never revive an old unit quote or native alias',t=>{
  for(const update of [{basis:false,price:90},{basis:false,price:null},{price:90,unit:'l'},{price:90,isPromo:false,promotion:{member_only:true,description:'Unreviewed actual campaign terms'}}]){
    const f=fixture(t,{variableDonor:true});f.ingest();f.bridge();const fingerprint=f.candidate().sourceFingerprint;assert.equal(f.item().prices.current,109);f.clock.at='2026-11-10T12:01:00Z';f.ingest(update);
    assert.equal(f.candidate().sourceFingerprint,fingerprint,'price basis and campaign changes do not manufacture a metadata change');assert.equal(f.candidate().status,'approved');assert.equal(f.item().prices.current,200,'the independent SPAR chain remains available');
    assert.ok(!f.member()||f.member().unitPrice===null);assert.ok(!f.shop.explorer.family('followed:'+f.w.id).family.members.some(p=>p.key===f.donor.productKey&&p.unitPrice===250));f.reload();assert.equal(f.item().prices.current,200);
  }
});

test('changed direct units remain source-level review work when every raw family hint is explicitly excluded',t=>{
  const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);
  const before=f.candidate(),family=before.families.find(row=>row.familyId===f.w.id);
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:before.sourceFingerprint,registrationFingerprint:family.registrationFingerprint,status:'excluded',familyIds:[f.w.id],familyFingerprints:{[f.w.id]:family.requirementsFingerprint},equivalenceEvidence:'This exact actual variant is explicitly excluded from this household family; its discovery hint is not an equivalence approval.'});
  const watch=structuredClone(f.state.shopping.watches[f.w.id]),registration=structuredClone(f.candidate().registration),bridge=structuredClone(f.candidate().bridge);
  assert.ok(!f.shop.queue().some(row=>row.sourceKey===SOURCE&&['shopping-sesum-review','shopping-sesum-discovery'].includes(row.do)));
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:90,unit:'l'});
  const work=f.shop.queue().find(row=>row.sourceKey===SOURCE&&row.do==='shopping-sesum-review');
  assert.ok(work);assert.equal(work.reason,'review-direct-unit-basis');assert.equal(work.basisReviewNeeded,true);assert.deepEqual(work.familyIds,[]);assert.deepEqual(work.rawFamilyIds,[f.w.id]);
  assert.equal(f.candidate().status,'approved');assert.equal(f.candidate().sourceFingerprint,before.sourceFingerprint);assert.deepEqual(f.candidate().registration,registration);assert.deepEqual(f.candidate().bridge,bridge);assert.deepEqual(f.state.shopping.watches[f.w.id],watch);
  assert.equal(f.item().prices.current,200);assert.ok(!f.member());f.reload();
  const resumed=f.shop.queue().find(row=>row.sourceKey===SOURCE&&row.do==='shopping-sesum-review');assert.equal(resumed?.reason,'review-direct-unit-basis');assert.deepEqual(resumed.familyIds,[]);assert.equal(f.item().prices.current,200);
});

test('same-time conflicting direct prices, units or campaign terms are held even though both pack prices are null',t=>{
  for(const update of [{price:119},{unit:'l'},{promotion:{member_only:true,description:'Actual campaign terms differ at the same source time'}}]){
    const f=fixture(t,{variableDonor:true});f.ingest();f.bridge();f.ingest(update);assert.equal(f.item().prices.current,200);assert.ok(!f.member()||f.member().unitPrice===null);f.reload();assert.equal(f.item().prices.current,200);
  }
  const f=fixture(t);f.ingest({basis:false});f.register();f.link([f.A,f.B]);assert.equal(f.item().prices.current,200);f.ingest();assert.equal(f.item().prices.current,109,'only exact same raw-row proof enrichment may establish a previously missing basis');
});

test('direct price evidence never supplies organic, brand, exact-family, group or scoped membership approval',t=>{
  for(const limits of [{brands:['Baseline']},{requires:['organic']}]){const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B],limits);assert.notEqual(f.item().prices.current,109);}
  const own=fixture(t);own.ingest();own.register();own.shop.libraryLink({familyId:own.w.id,variants:[],evidence:'This exact narrow household family remains separate from broad whole-root groups.'});assert.notEqual(own.item().prices.current,109);
  const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);const family=f.candidate().families.find(p=>p.familyId===f.w.id);f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:family.registrationFingerprint,status:'excluded',familyIds:[f.w.id],familyFingerprints:{[f.w.id]:family.requirementsFingerprint},equivalenceEvidence:'The household explicitly excludes this actual source variant for this family despite its generic whole-root group.'});assert.equal(f.item().prices.current,200);assert.ok(!f.member());
  const stale=fixture(t);stale.ingest();stale.register();stale.link([stale.A,stale.B]);stale.data.groups.push({...stale.B,inclusionCriteria:'New material whole-root requirement that has not been rereviewed'});stale.write();assert.notEqual(stale.item().prices.current,109);
});

test('a newly captured label never refreshes an old actual receipt or creates calibrated unit history',t=>{
  const f=fixture(t);f.ingest({observedAt:'2026-11-07T12:00:00Z'});f.register();f.link([f.A,f.B]);assert.equal(f.item().prices.current,200);assert.equal(f.item().prices.historyDays,0);assert.equal(f.item().prices.lowestSeen,null);assert.equal(f.state.shopping.watches[f.w.id].marketCalibration,null);
  const source=f.shop.explorer.family(f.B.id).family.members.find(p=>p.key===SOURCE);assert.ok(source);assert.equal(source.fresh,false);assert.ok(source.lastChecked?.startsWith('2026-11-07')||source.receiptAt?.startsWith('2026-11-07'));
});

test('a source-only unit comparison leaves unknown household demand, stock and all buyable packs unknown',t=>{
  const f=fixture(t);f.shop.watch({...f.shop.view().watches.find(w=>w.id===f.w.id),purchaseAmount:null,monthlyUsage:null,stockAmount:null});f.shop.libraryLink({familyId:f.w.id,variants:[],evidence:'No documented household package is selected before actual source research.'});const emptyInventorySizes=f.item().packs;f.ingest();f.register();f.link([f.B]);
  const view=f.shop.familyView(),item=view.items.find(w=>w.id===f.w.id);assert.equal(item.prices.current,109);assert.equal(item.annualAmount,null);assert.equal(item.stock.known,false);assert.deepEqual(item.packs,emptyInventorySizes,'source research adds no documented size to the existing generic inventory input');assert.equal(f.member().pack,null);assert.equal(f.member().packPrice,null);
  assert.ok(!view.odaDraft.items.some(row=>row.watchId===f.w.id));assert.ok(!view.steady.some(row=>row.watchId===f.w.id));assert.deepEqual(view.list.open,[]);assert.deepEqual(view.purchases,[]);assert.equal(f.state.shopping.watches[f.w.id].stockAmount,null);assert.equal(f.state.shopping.watches[f.w.id].purchaseAmount,null);
});

test('a native family exclusion outranks its variable source bridge and every later direct receipt',t=>{
  const f=fixture(t,{variableDonor:true});f.ingest();f.bridge();assert.equal(f.item().prices.current,109);
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.donor.id,store:f.donor.store,name:f.donor.name,brand:f.donor.brand,ean:f.donor.ean,ingredients:f.donor.ingredients,description:f.donor.description,sourceUrl:f.donor.sourceUrl,weight:null,weightUnit:null,currentPrice:250,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'excluded',equivalenceEvidence:'The household explicitly excludes this exact current native whole-root variant; its documented source alias cannot bypass that decision.'});
  assert.equal(f.item().prices.current,200);assert.ok(!f.member());f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:90});assert.equal(f.item().prices.current,200);assert.ok(!f.member());
  f.reload();assert.equal(f.item().prices.current,200);assert.ok(!f.shop.explorer.family('followed:'+f.w.id).family.members.some(row=>[SOURCE,f.donor.productKey].includes(row.key)));
});

test('a newer incompatible native unit cannot become a kg quote through source alias normalization',t=>{
  const f=fixture(t,{variableDonor:true});f.ingest();f.bridge();assert.equal(f.item().prices.current,109);
  f.clock.at='2026-11-10T12:01:00Z';f.data.prices.push({productKey:f.donor.productKey,grossPackPrice:null,grossUnitPrice:75,unit:'l',unitPriceEvidence:'Actual incompatible litre quote is retained as source evidence, not converted to kg.',priceIncludesVat:true,receiptAt:f.clock.at,sourceUrl:f.donor.sourceUrl,availabilityScope:'chain'});f.write();
  assert.equal(f.item().prices.current,200);assert.ok(!f.member()||f.member().unitPrice===null);assert.ok(!f.shop.explorer.family('followed:'+f.w.id).family.members.some(member=>member.key===f.donor.productKey&&member.unitPrice===75));
});

test('variable promotions stay held without entering the fixed-package campaign builder and per-quote proof never changes identity',t=>{
  const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);const first=f.candidate(),at=first.price.observedAt;
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({observedAt:at});const next=f.candidate();assert.equal(next.sourceFingerprint,first.sourceFingerprint);assert.equal(next.status,'approved');assert.notEqual(next.price.unitPriceBasisFingerprint,first.price.unitPriceBasisFingerprint);assert.equal(next.price.observedAt,at);
  f.clock.at='2026-11-10T12:02:00Z';f.ingest({price:90,isPromo:false,promotion:{description:'Unreviewed consumer membership conditions',member_only:true}});
  assert.doesNotThrow(()=>f.shop.queue());assert.doesNotThrow(()=>f.shop.sesumOfferCandidates());assert.equal(f.item().prices.current,200);assert.ok(f.candidate().price.reasons.includes('unverified-promotion-conditions'));
  f.clock.at='2026-11-10T12:03:00Z';f.ingest({price:90,unit:'l'});assert.equal(f.candidate().basisReviewNeeded,true);assert.ok(f.shop.queue().some(item=>item.do==='shopping-sesum-review'&&item.sourceKey===SOURCE));
});

test('a newer dated variable own row without provenance holds old source and native unit prices, while fetch time alone does not',t=>{
  for(const asCandidate of [false,true]){
    const f=fixture(t,{variableDonor:true});f.ingest();f.bridge();const fingerprint=f.candidate().sourceFingerprint;assert.equal(f.item().prices.current,109);
    f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:90,priceSource:null,asCandidate});
    assert.equal(f.candidate().status,'approved');assert.equal(f.candidate().sourceFingerprint,fingerprint);assert.equal(f.item().prices.current,200,'SPAR stays independent while an unresolved newer own KIWI row blocks older prices');
    const members=f.shop.explorer.family('followed:'+f.w.id).family.members;assert.ok(!members.some(row=>[SOURCE,f.donor.productKey].includes(row.key)&&[109,250].includes(row.unitPrice)),'neither own nor native alias may revive its earlier direct quote');assert.ok(!f.member()||f.member().unitPrice===null);
    f.reload();assert.equal(f.item().prices.current,200);f.clock.at='2026-11-10T12:02:00Z';f.ingest({price:120});assert.equal(f.item().prices.current,120,'a genuinely newer own row with valid proof can become usable again without metadata rereview');
    const older=fixture(t,{variableDonor:true});older.ingest();older.bridge();older.clock.at='2026-11-10T12:01:00Z';older.ingest({price:90,priceSource:null,asCandidate,observedAt:'2026-11-10T11:58:00Z'});assert.equal(older.item().prices.current,109,'a newer fetch cannot promote an older actual receipt over the reviewed noon price');
  }
  const fixed=fixture(t),fixedSource={name:fixed.oda.name,brand:fixed.oda.brand,soldByWeight:false,weight:500,weightUnit:'g'};fixed.ingest({price:60,basis:false,sourceChanges:fixedSource});
  fixed.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:fixed.candidate().sourceFingerprint,status:'approved',productKey:fixed.oda.productKey,productFingerprint:sesumDonorFingerprint(fixed.provider.reader().product(fixed.oda.productKey)),packAmount:.5,unit:'kg',packEvidence:'Read the actual unchanged fixed 500g original bag in both source records.',equivalenceEvidence:'The actual fixed source bag has the same reviewed plain fresh roots, brand and fixed package.'});assert.equal(fixed.item().prices.current,120);
  fixed.clock.at='2026-11-10T12:01:00Z';fixed.ingest({price:20,basis:false,priceSource:null,asCandidate:true,sourceChanges:fixedSource});assert.equal(fixed.item().prices.current,120,'the existing fixed-pack unproven-candidate policy is unchanged');
});

test('a reviewed fixed native 500g row cannot acquire a null-pack direct quote, while another linked family can compare the independent source',t=>{
  for(const nativeReceiptAt of ['2026-11-10T11:59:30Z','2026-11-10T11:58:00Z']){
  const f=fixture(t,{variableDonor:true});Object.assign(f.donor,{name:'Fresh whole ginger root 500g',rawPack:null});f.donor.metadataFingerprint=productMetadataFingerprint(f.donor);f.data.memberships.find(row=>row.productKey===f.donor.productKey).reviewedFingerprint=f.donor.metadataFingerprint;f.write();
  f.ingest();f.bridge();assert.equal(f.item().prices.current,109);
  const other=f.shop.watch({id:'independent-ginger-family',name:'Another plain whole ginger need',unit:'kg',storage:'chilled',note:'All reviewed plain whole fresh-root forms are accepted; no fixed package requirement.'});
  f.shop.libraryLink({familyId:other.id,evidence:'Explicit actual household group choice for the independently researched source.',variants:[{groupId:f.A.id,groupFingerprint:groupMetadataFingerprint(f.A),evidence:'Actual reviewed plain fresh whole-root contents satisfy this separate household need.'}]});
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.donor.id,store:f.donor.store,name:f.donor.name,brand:f.donor.brand,ean:f.donor.ean,ingredients:f.donor.ingredients,description:f.donor.description,sourceUrl:f.donor.sourceUrl,weight:null,weightUnit:null,currentPrice:120,lastChecked:nativeReceiptAt}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The actual original 500g sealed bag is a fixed native package for this household family, not a loose-weight root.'});
  assert.equal(f.item().prices.current,200,'the fixed family retains its independent SPAR alternative and never gets unit109 through its native fixed row');
  f.shop.list({action:'add',watchId:f.w.id,storeName:'Oda',odaProductId:451,packAmount:.5,packs:1,unitPrice:240});const line=f.shop.familyView().list.open.find(row=>row.watchId===f.w.id),native=line.others.find(row=>row.productKey===f.donor.productKey);
  assert.ok(native);assert.equal(native.unitPrice,240);assert.equal(native.packAmount,.5);assert.equal(native.packPrice,120);assert.ok(!line.others.some(row=>row.productKey===SOURCE));
  assert.ok(!f.shop.explorer.family('followed:'+f.w.id).family.members.some(row=>row.key===SOURCE));const otherView=()=>f.shop.familyView().items.find(row=>row.id===other.id);assert.equal(otherView().prices.current,109);assert.ok(f.shop.explorer.family('followed:'+other.id).family.members.some(row=>row.key===SOURCE&&row.unitPrice===109&&row.pack===null));
  f.reload();assert.equal(f.item().prices.current,200);assert.equal(otherView().prices.current,109);
  }
});

test('a real legacy raw own row accepts only an identical same-time source-bound unit-label amendment',t=>{
  const f=fixture(t);f.ingest({basis:false});const row=f.state.shopping.sesumPrices.products[SOURCE];
  for(const key of ['variableWeight','unitPriceBasis','unitPriceBasisFingerprint','unitPriceBasisError'])delete row.receipt[key];row.receipt.reasons=[];
  const legacy=structuredClone(row.receipt);f.register();f.link([f.A,f.B]);assert.equal(f.item().prices.current,200);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({observedAt:NOW});assert.equal(f.item().prices.current,109);assert.equal(f.candidate().price.price,109);assert.deepEqual(row.receipt,legacy,'ingestion preserves its prior immutable object in history');
  const current=f.state.shopping.sesumPrices.products[SOURCE];assert.ok(current.receiptHistory.some(event=>event.receipt.price===109&&!event.receipt.variableWeight));assert.equal(current.receipt.observedAt,'2026-11-10T12:00:00.000Z');
});

test('only a provably false legacy-marker conflict can be amended on read, with raw history retained',t=>{
  const f=fixture(t);f.clock.at='2026-11-10T12:00:01Z';f.ingest({observedAt:'2026-11-10T13:00:00.123605+01:00'});f.register();f.link([f.A,f.B]);const row=f.state.shopping.sesumPrices.products[SOURCE],actual=row.receipt.observedAt;
  const legacy={price:109,observedAt:actual,source:row.receipt.source,sourceStoreCode:'KIWI',isPromo:false,promotion:null,reasons:[]};
  row.receiptHistory=[{fetchedAt:'2026-11-10T11:59:00Z',sourceFingerprint:row.fingerprint,receipt:legacy}];row.receipt={...row.receipt,price:null,reasons:['conflicting-latest-prices']};
  const before=structuredClone(row);f.reload();assert.equal(f.candidate().price.price,109);assert.equal(f.candidate().price.unitPriceBasisAmendment.kind,'legacy-own-row-label-v1');assert.equal(f.item().prices.current,109);assert.deepEqual(f.state.shopping.sesumPrices.products[SOURCE],before,'a derived amendment never rewrites raw receipt or history');f.reload();assert.equal(f.item().prices.current,109);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({observedAt:actual});assert.equal(f.candidate().price.price,109);assert.equal(f.item().prices.current,109);assert.ok(f.state.shopping.sesumPrices.products[SOURCE].receiptHistory.some(event=>event.receipt.price===null&&event.receipt.reasons.includes('conflicting-latest-prices')));
});

test('legacy proof amendment never resolves real price, unknown, unit, terms, provenance or metadata conflicts',t=>{
  const mutations=[
    event=>{event.receipt.price=119;},event=>{event.receipt.price=null;event.receipt.reasons=['conflicting-latest-prices'];},
    event=>{event.receipt.source=null;},event=>{event.receipt.promotion={member_only:true};},event=>{event.receipt.isPromo=true;},
    event=>{event.receipt.sourceStoreCode='COOP_EXTRA';},event=>{event.receipt.observedAt='2026-11-10T12:01:00Z';},event=>{event.sourceFingerprint='0'.repeat(64);},
    event=>{event.receipt.unitPriceBasis={unit:'l',amount:109};},event=>{event.receipt.variableWeight=true;}
  ];
  for(const mutate of mutations){const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);const row=f.state.shopping.sesumPrices.products[SOURCE],legacy={fetchedAt:NOW,sourceFingerprint:row.fingerprint,receipt:{price:109,observedAt:row.receipt.observedAt,source:row.receipt.source,sourceStoreCode:'KIWI',isPromo:false,promotion:null,reasons:[]}};mutate(legacy);row.receiptHistory=[legacy];row.receipt={...row.receipt,price:null,reasons:['conflicting-latest-prices']};f.reload();assert.equal(f.candidate().price.price,null);assert.equal(f.item().prices.current,200);}
  for(const later of [{price:null,source:null,reasons:['missing-price-source']},{price:null,reasons:['conflicting-latest-prices']},{price:119,reasons:[]},{price:109,promotion:{member_only:true},reasons:[]}]){
    const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);const row=f.state.shopping.sesumPrices.products[SOURCE],legacy={price:109,observedAt:row.receipt.observedAt,source:row.receipt.source,sourceStoreCode:'KIWI',isPromo:false,promotion:null,reasons:[]};row.receiptHistory=[{fetchedAt:NOW,sourceFingerprint:row.fingerprint,receipt:legacy},{fetchedAt:NOW,sourceFingerprint:row.fingerprint,receipt:{...legacy,...later}}];row.receipt={...row.receipt,price:null,reasons:['conflicting-latest-prices']};f.reload();assert.equal(f.item().prices.current,200,'a later unresolved or genuinely changed quote cannot be laundered by a valid label');
  }
});

test('legacy amendment checks every later metadata event and every known own store and historical proof field',t=>{
  for(const variant of ['later-metadata','known-store','raw-chain','foreign-product-proof','different-date-proof','different-source-proof','foreign-control-proof','invalid-label-proof']){
    const f=fixture(t);f.ingest();f.register();f.link([f.A,f.B]);const row=f.state.shopping.sesumPrices.products[SOURCE],legacy={price:109,observedAt:row.receipt.observedAt,source:row.receipt.source,sourceStoreCode:'KIWI',isPromo:false,promotion:null,reasons:[]};
    row.receiptHistory=[{fetchedAt:NOW,sourceFingerprint:row.fingerprint,receipt:legacy}];
    if(variant==='known-store')legacy.storeId='9';
    else if(variant==='raw-chain'){legacy.sourceStoreCode='COOP_EXTRA';row.receipt.sourceStoreCode='COOP_EXTRA';}
    else {const later={fetchedAt:NOW,sourceFingerprint:row.fingerprint,receipt:structuredClone(row.receipt)};row.receiptHistory.push(later);
      if(variant==='later-metadata'){later.sourceFingerprint='0'.repeat(64);later.receipt.price=119;}
      else if(variant==='foreign-product-proof')later.receipt.unitPriceBasis.productId='123';
      else if(variant==='different-date-proof')later.receipt.unitPriceBasis.observedAt='2026-11-10T11:59:59Z';
      else if(variant==='different-source-proof')later.receipt.unitPriceBasis.source='other_provenance';
      else if(variant==='foreign-control-proof')later.receipt.unitPriceBasis.rowControl='kjederad-9';
      else later.receipt.unitPriceBasis.label='119,00 kr/kg';
    }
    row.receipt={...row.receipt,price:null,reasons:['conflicting-latest-prices']};f.reload();assert.equal(f.candidate().price.price,null,variant);assert.equal(f.item().prices.current,200,variant);
  }
});
