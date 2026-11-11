import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';
import {sesumDonorFingerprint} from '../src/sesum-prices.mjs';
import {workerManifest,applyWorkerProposal} from '../src/shopping-worker-contract.mjs';
import {shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';

const NOW='2026-11-10T12:00:00Z',SOURCE='sesum:KIWI:72';

test('one scoped product job follows real placement, native registration and additive household family approval',t=>{
 const f=setup(t);f.ingest();const assignment=workerManifest(shoppingAgentBatch(f.shop.queue().filter(i=>i.sourceKey===SOURCE))),store={shopping:f.shop,snapshot:()=>f.state},before=structuredClone(f.state.shopping.watches[f.w.id]);
 const packet=()=>f.shop.agentContext(assignment),apply=(operation,input,groupReads=new Map())=>applyWorkerProposal({store,assignment,packet:packet(),operation,input,groupReads}),place=()=>{const p=packet();return apply('placement',{scopeEvidence:'Every active family criterion was read against this actual original whole-bean label and fixed 500g bag.',reviewedAllFamilies:true,decisions:[{sourceKey:SOURCE,status:'reviewed',evidence:'Actual plain whole roasted beans and fixed 500g package were read.',targets:[{familyIndex:p.families.findIndex(x=>x.familyId===f.w.id),equivalenceEvidence:'Same whole-bean contents, plain roast, physical form, fixed package and household use.'}]}]});};
 place();assert.ok(packet().jobs.flatMap(j=>j.items).some(i=>i.do==='shopping-sesum-discovery'));
 const result=apply('source-register',{sourceKey:SOURCE,identityEvidence:'Actual source product and original label identify this specific whole-bean variant and fixed bag.',packAmount:.5,unit:'kg',packEvidence:'Actual original bag and matching source metadata show one fixed 500g net package.',product:{ingredients:'Whole roasted coffee beans',description:'Plain whole-bean roast',brand:f.source.brand,attributes:{organic:true}},groups:[f.B],memberships:[{groupId:f.B.id,equivalenceEvidence:'Actual complete plain whole-bean contents match these explicit reviewed group rules.',qualityEvidence:'Original ingredient label, whole-bean form and all declared differences were read.'}],sourceReceipts:[{url:'https://producer.example.test/new-original-label',observedAt:NOW,evidence:'Actual original whole-bean label and fixed 500g package read.'}]});
 assert.equal(result.registration.productKey,SOURCE);assert.ok(packet().sources[0].reviewedIdentity);if(packet().jobs.flatMap(j=>j.items).some(i=>i.do==='shopping-sesum-placement-review'))place();
 const g=f.shop.agentGroup(f.B.id);assert.equal(g.fingerprint,groupMetadataFingerprint(f.B));assert.ok(packet().jobs.flatMap(j=>j.items).some(i=>i.do==='shopping-sesum-family-review'));
 apply('family-add-variant',{sourceKey:SOURCE,familyId:f.w.id,evidence:'Actual new whole-bean subgroup matches this household need without changing previous variants or constraints.',variant:{groupId:f.B.id,brands:[],requires:[],excludeProductKeys:[],evidence:'Actual complete ingredients, physical form, use and fixed package satisfy this precise household family.'}},new Map([[g.groupId,g.fingerprint]]));
 if(packet().jobs.flatMap(j=>j.items).some(i=>i.do==='shopping-sesum-placement-review'))place();assert.equal(f.work().length,0);assert.deepEqual(f.state.shopping.watches[f.w.id].variants[0].groupId,before.variants[0].groupId);assert.equal(f.state.shopping.watches[f.w.id].stockAmount,before.stockAmount);assert.equal(f.state.shopping.watches[f.w.id].purchaseAmount,before.purchaseAmount);assert.equal(packet().assignmentChanges.length,0);
});
function group(id,name){return {id,name,category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted coffee beans with a separately reviewed physical variant.',exclusions:['Ground coffee','Added flavourings'],qualityBasis:'Actual whole-bean form and ingredients',comparisonBasis:'Per kg'};}
function setup(t,{linked=true,nativeIdentity=false,ordinaryBridge=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'sesum-family-flow-'));t.after(()=>{if(!resolve(dir).startsWith(resolve(tmpdir(),'sesum-family-flow-')))throw Error('Unsafe test cleanup.');rmSync(dir,{recursive:true,force:true});});
  const A=group('baseline-beans','Baseline reviewed whole beans'),B=group('additional-beans','Additional reviewed whole-bean variants'),C=group('unrelated-beans','Another reviewed baseline subgroup');
  const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Baseline whole beans 500g',brand:'Baseline',ean:'1234567890123',ingredients:'Whole roasted coffee beans',description:'Plain baseline roast',sourceUrl:'https://producer.example.test/baseline',canonicalPackAmount:.5,unit:'kg',packEvidence:'Read the actual fixed 500g package.',rawPack:{weight:500,weightUnit:'g'},attributes:{organic:false},nutrition:null};
  const q={...structuredClone(p),productKey:'kassal:KIWI:73',id:'73',name:'Other whole beans 500g',brand:'Other',ean:'1234567890124',description:'Another plain roast',sourceUrl:'https://producer.example.test/other'};
  for(const product of [p,q])product.metadataFingerprint=productMetadataFingerprint(product);
  const membership=(product,g)=>({groupId:g.id,productKey:product.productKey,status:'approved',reviewedFingerprint:product.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),equivalenceEvidence:'Actual whole roasted beans and fixed package reviewed against this group.',qualityEvidence:'The complete original ingredient declaration and form were read.',reviewedAt:NOW,sourceReceipts:[{url:product.sourceUrl,observedAt:NOW,evidence:'Read the actual original label and fixed 500g package.'}]});
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[A,C,...(ordinaryBridge?[B]:[])],products:[p,...(ordinaryBridge?[q]:[])],memberships:[membership(p,A),membership(p,C),...(ordinaryBridge?[membership(q,B)]:[])],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:NOW,availabilityScope:'chain',sourceUrl:p.sourceUrl},...(ordinaryBridge?[{productKey:q.productKey,grossPackPrice:25,receiptAt:NOW,availabilityScope:'chain',sourceUrl:q.sourceUrl}]:[])]};
  const file=join(dir,'library.json'),write=()=>writeFileSync(file,JSON.stringify(data));write();
  let state={},provider,shop;const clock={at:NOW};
  const open=()=>{provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)});shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});};open();
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi',minSavings:0},{id:'extra',name:'Extra',chainCode:'COOP_EXTRA',url:'https://shop.example.test/extra',minSavings:0}]});
  const w=shop.watch({id:'followed-beans',name:'Whole coffee beans',unit:'kg',storage:'pantry',purchaseAmount:10,stockAmount:2,targetPrice:50});
  const link=(groups=[A],extra={})=>shop.libraryLink({familyId:w.id,evidence:'Explicit household decision about these current reviewed variants.',variants:groups.map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Actual reviewed contents and use match the household requirement.',...extra}))});
  if(linked)link();
  const physical=ordinaryBridge?q:nativeIdentity?p:{name:'New organic whole beans 500g',brand:'New',ean:null};
  const source={id:'72',name:physical.name,brand:physical.brand,ean:physical.ean?[physical.ean]:null,weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-new-whole-beans-500g'};
  const ingest=({familyIds=[w.id],price=20,observedAt=clock.at,changes={}}={})=>shop.sesumReceivePrices({familyIds,fetchedAt:clock.at,products:[{...source,...changes,prices:[{storeCode:'KIWI',price,observedAt,source:'actual_price_receipt',isPromo:false}]}]});
  const candidate=()=>shop.sesumCandidates().find(row=>row.sourceKey===SOURCE);
  const work=()=>shop.queue().filter(row=>row.do==='shopping-sesum-family-review'&&row.sourceKey===SOURCE);
  const register=({g=B,details={}}={})=>{const row=candidate();return shop.sesumRegister({sourceKey:SOURCE,sourceFingerprint:row.sourceFingerprint,identityEvidence:'Read the actual physical source variant, original whole-bean form and fixed package; registration does not choose a household variant.',...(nativeIdentity?{nativeProductKey:p.productKey,nativeProductFingerprint:sesumDonorFingerprint(provider.reader().product(p.productKey)),nativeIdentityEvidence:'The actual same-chain native record and source bag identify the same physical brand, variant, GTIN and fixed package.'}:{}),product:{ingredients:'Whole roasted coffee beans',description:'A separately researched whole-bean roast',brand:source.brand,attributes:{organic:!nativeIdentity},...details},packAmount:.5,unit:'kg',packEvidence:'The actual original bag and source metadata show one fixed 500g pack.',groups:[g],memberships:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),equivalenceEvidence:'Actual plain whole roasted beans match this group; this is not automatic household approval.',qualityEvidence:'Read the complete ingredient label, whole-bean form and any declared differences.'}],sourceReceipts:[{url:'https://producer.example.test/new-original-label',observedAt:clock.at,evidence:'Read the actual original contents, whole-bean form and fixed 500g net package.'}]});};
  const bridge=()=>{const row=candidate(),donor=row.donors.find(d=>d.productKey===q.productKey);return shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:row.sourceFingerprint,productKey:q.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The actual original source bag and reviewed donor identify the same brand, variant, GTIN and fixed package.',packEvidence:'Both exact physical records document one fixed 500g bag.'});};
  const decide=(status,familyId=w.id,extra={})=>{const row=candidate(),family=row.families.find(f=>f.familyId===familyId);assert.ok(family.registrationFingerprint,'registered-family decisions need the current registration fingerprint');return shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:row.sourceFingerprint,status,familyIds:[familyId],familyFingerprints:{[familyId]:family.requirementsFingerprint},registrationFingerprint:family.registrationFingerprint,equivalenceEvidence:'Read the actual whole coffee beans and this specific current household family requirement.',...extra});};
  const native=(extra={})=>shop.catalogObserve({watchId:w.id,products:[{id:p.id,store:p.store,name:p.name,brand:p.brand,ean:p.ean,ingredients:p.ingredients,description:p.description,sourceUrl:p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:clock.at,...extra}]}).entries[0];
  const nativeReview=(entry,status='approved')=>shop.catalogReview({watchId:w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status,packAmount:.5,unit:'kg',equivalenceEvidence:'Read this exact current native whole-bean label, physical variant and fixed package for this household family.'});
  const place=(ids=[w.id])=>{const data=shop.sesumPlacement(SOURCE),row=data.items[0];return shop.sesumPriceReview({kind:'placement',sourceKey:SOURCE,sourceFingerprint:row.sourceFingerprint,registrationFingerprint:row.registrationFingerprint,familySetFingerprint:data.familySetFingerprint,status:'reviewed',reviewedAllFamilies:true,scopeEvidence:'Read every current enabled family ingredient, form, brand and property requirement against the actual synthetic whole-bean variant. Only the explicitly selected whole-bean needs fit; unrelated honey is not accepted.',evidence:'Actual full whole-bean contents and fixed bag read against the complete current enabled family set.',targets:ids.map(id=>({familyId:id,familyFingerprint:data.families.find(f=>f.familyId===id).familyFingerprint,equivalenceEvidence:'Actual plain whole roasted coffee beans match the documented whole-bean research target; this grants no household group choice.'}))});};
  return {get shop(){return shop;},get state(){return state;},clock,w,p,q,A,B,C,data,write,link,source,ingest,candidate,work,register,bridge,decide,native,nativeReview,place,reload(){state=JSON.parse(JSON.stringify(state));open();}};
}

test('registering a new group leaves durable family work even after source identity review disappears',t=>{
  const f=setup(t);f.ingest();assert.ok(f.shop.queue().some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE));f.place();assert.ok(f.shop.queue().some(row=>row.do==='shopping-sesum-discovery'&&row.sourceKey===SOURCE));f.register();f.place();
  assert.ok(!f.shop.queue().some(row=>['shopping-sesum-review','shopping-sesum-discovery'].includes(row.do)&&row.sourceKey===SOURCE));
  const [pending]=f.work();assert.ok(pending,'a new reviewed library group still needs a household family decision');assert.equal(pending.familyId,f.w.id);assert.ok(pending.registrationFingerprint);assert.ok(pending.familyFingerprint);assert.ok(pending.fingerprint);assert.equal(pending.status,'pending');
  f.reload();assert.equal(f.work()[0].fingerprint,pending.fingerprint,'restart cannot discard or invent a new family decision');
  f.clock.at='2026-11-10T12:01:00Z';f.link([f.A]);assert.equal(f.work().length,1,'repeating an old group link does not approve a new group');
  f.link([f.A,f.C]);f.place();assert.equal(f.work().length,1,'another unrelated variant cannot settle the new source');
  f.link([f.A,f.B]);assert.equal(f.work().length,0,'only an actual current family variant link settles the new source');
});

test('a normally bridged existing library product also needs family review when only its new subgroup is approved',t=>{
  const f=setup(t,{ordinaryBridge:true});f.ingest();f.bridge();f.place();assert.equal(f.candidate().registration,null);
  assert.equal(f.work().length,1,'the durable flow includes reviewed donor bridges, not just self registration');assert.ok(f.work()[0].registrationFingerprint);
  assert.ok(!f.shop.queue().some(row=>row.do==='shopping-sesum-review'&&row.sourceKey===SOURCE));
  f.link([f.A,f.B]);assert.equal(f.work().length,0);
});
test('registered chain bridges share placement research only on identical physical metadata and the same reviewed donor basis',t=>{
 const f=setup(t,{ordinaryBridge:true});f.ingest();f.bridge();
 f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:NOW,products:[{...f.source,prices:[{storeCode:'COOP_EXTRA',price:21,observedAt:NOW,source:'actual_extra_receipt',isPromo:false}]}]});
 const extra=f.shop.sesumCandidates(undefined,'sesum:COOP_EXTRA:72')[0],donor=extra.donors.find(x=>x.productKey===f.q.productKey);
 f.shop.sesumPriceReview({sourceKey:extra.sourceKey,sourceFingerprint:extra.sourceFingerprint,productKey:f.q.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Both independently read chain source records show the same physical whole-bean variant as this exact reviewed donor.',packEvidence:'Both source records and this reviewed donor show the same fixed500g bag.'});
 const before=JSON.stringify(f.state),work=f.shop.queue().filter(x=>x.do==='shopping-sesum-placement-review');
 assert.equal(work.length,1);assert.equal(work[0].relatedSources.length,1);assert.equal(new Set([work[0].registrationFingerprint,...work[0].relatedSources.map(x=>x.registrationFingerprint)]).size,2,'each chain retains its own registration proof');assert.equal(JSON.stringify(f.state),before);
});

test('own narrow, brand and required-attribute decisions cannot be replaced by source registration',t=>{
  const f=setup(t,{linked:false});f.ingest();f.register();f.place();assert.equal(f.work().length,1);
  f.link([]);f.place();assert.equal(f.work().length,1,'an own narrow family has not approved the newly discovered variant');
  f.link([f.B],{brands:['Baseline']});assert.equal(f.work().length,0);assert.ok(f.shop.queue().some(row=>row.sourceKey===SOURCE&&row.do==='shopping-sesum-placement-review'),'a changed brand requirement must first be researched across the current family set');assert.throws(()=>f.place(),/merke/);
  f.link([f.B],{requires:['glutenFree']});assert.equal(f.work().length,0);assert.throws(()=>f.place(),/egenskapskrav/,'an unknown required attribute is not true');
  f.link([f.B],{requires:['organic'],brands:['New']});assert.equal(f.work().length,0,'actual reviewed matching attributes and brand can support the explicit decision');
});

test('only a matching fixed same-chain native identity and current exact catalogue approval can settle the family',t=>{
  const f=setup(t,{nativeIdentity:true});f.ingest();f.register();f.place();assert.equal(f.work().length,1);
  f.nativeReview(f.native({store:'SPAR_NO'}));assert.equal(f.work().length,1,'an equal numeric ID in another chain is not the native counterpart');
  f.nativeReview(f.native({ingredients:'Ground coffee beans'}));assert.equal(f.work().length,1,'changed contents cannot approve the bound physical identity');
  let exact=f.native();f.nativeReview(exact);assert.equal(f.work().length,0);
  f.native({weight:1000});assert.equal(f.work().length,1,'a material raw package change reopens the family decision');
  exact=f.native();f.nativeReview(exact);assert.equal(f.work().length,0);
  f.nativeReview(exact,'excluded');assert.equal(f.work().length,1,'a native exclusion is not a positive family approval');
});

test('a scoped wrong-OR-family exclusion never hides the correct family or a later source hint',t=>{
  const f=setup(t),wrong=f.shop.watch({id:'honey',name:'Pure honey',unit:'kg',storage:'pantry'});f.ingest({familyIds:[f.w.id,wrong.id]});f.register();f.place();
  assert.deepEqual(f.work().map(row=>row.familyId),[f.w.id],'the reviewed whole-set placement never routes the raw honey hint into new family work');
  f.decide('excluded',wrong.id,{equivalenceEvidence:'The actual product is whole roasted coffee beans, with no honey; only the honey family is unsuitable.'});
  assert.deepEqual(f.work().map(row=>row.familyId),[f.w.id]);assert.equal(f.candidate().status,'approved','a wrong search hint never excludes global product identity');
  const late=f.shop.watch({id:'another-coffee-need',name:'Another coffee need',unit:'kg',storage:'pantry'});f.clock.at='2026-11-10T12:01:00Z';f.ingest({familyIds:[late.id]});assert.equal(f.work().length,0,'new family semantics reopen placement before new household research');f.place([f.w.id,late.id]);
  assert.deepEqual(new Set(f.work().map(row=>row.familyId)),new Set([f.w.id,late.id]));
  f.reload();assert.deepEqual(new Set(f.work().map(row=>row.familyId)),new Set([f.w.id,late.id]));
  assert.throws(()=>f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,status:'excluded',equivalenceEvidence:'A global exclusion would incorrectly hide other families.'}),/familyIds/);
});

test('a future blocked retry is durable, absent from active work and still blocks completion',t=>{
  const f=setup(t);f.ingest();f.register();f.place();const before=f.work()[0];
  f.decide('blocked',f.w.id,{reason:'The household variant requirement needs concrete source clarification.',retryAt:'2026-11-10T13:00:00Z'});
  assert.equal(f.work().length,0);const completion=f.shop.completion();assert.equal(completion.complete,false);assert.equal(completion.blockedFamilies.length,1);assert.equal(completion.blockedFamilies[0].sourceKey,SOURCE);
  assert.equal(f.candidate().families.find(row=>row.familyId===f.w.id).sourceDecision.status,'blocked');
  f.reload();assert.equal(f.work().length,0);assert.equal(f.shop.completion().blockedFamilies.length,1);
  f.shop.watch({id:'separate-liquid-need',name:'Separate exact non-food liquid formula',unit:'l',storage:'other',note:'Only this exact non-food liquid formula; whole coffee beans are excluded.'});
  assert.ok(!f.shop.queue().some(row=>row.sourceKey===SOURCE&&row.do==='shopping-sesum-placement-review'),'reviewed kg coffee cannot match a new litre-only family');
  assert.equal(f.shop.sesumPlacement(SOURCE).items[0].reviewDelta.codeExcludedFamilies[0].rule,'canonical-unit-mismatch-v1');
  assert.equal(f.shop.completion().blockedFamilies.length,1,'the code-resolved placement preserves the actual scoped future retry');
  f.clock.at='2026-11-10T13:00:01Z';assert.equal(f.work().length,1);assert.equal(f.work()[0].registrationFingerprint,before.registrationFingerprint);
});

test('scoped decisions bind current registered product and group rules while ordinary prices and receipt dates remain stable',t=>{
  for(const change of ['product','group']){
    const f=setup(t);f.ingest();f.register();f.place();const before=f.work()[0],sourceFingerprint=f.candidate().sourceFingerprint;
    f.decide('excluded',f.w.id,{equivalenceEvidence:'This current separately reviewed variant is outside the household family choice.'});assert.equal(f.work().length,0);
    f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:18});assert.equal(f.work().length,0,'new receipt prices/dates do not undo an unchanged variant decision');
    assert.equal(f.candidate().families.find(row=>row.familyId===f.w.id).registrationFingerprint,before.registrationFingerprint);
    if(change==='product')f.register({details:{description:'A materially revised actual roast declaration'}});
    else{const changed={...f.B,inclusionCriteria:'Plain whole roasted coffee beans with newly clarified review rules.'};f.data.groups.push(changed);f.write();f.register({g:changed});}
    assert.equal(f.candidate().sourceFingerprint,sourceFingerprint,'source identity is independent of researched product/group changes');
    assert.equal(f.work().length,1);assert.notEqual(f.work()[0].registrationFingerprint,before.registrationFingerprint);assert.notEqual(f.work()[0].fingerprint,before.fingerprint);
    assert.throws(()=>f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint,familyIds:[f.w.id],familyFingerprints:{[f.w.id]:before.familyFingerprint},registrationFingerprint:before.registrationFingerprint,status:'excluded',equivalenceEvidence:'A stale registered variant decision must never close new work.'}));
  }
});

test('known old source prices park unresolved family work and a genuinely new receipt revives the unchanged review',t=>{
  const f=setup(t);f.ingest();f.register();f.place();const fingerprint=f.work()[0].registrationFingerprint;
  f.clock.at=new Date(Date.parse(NOW)+184*86400000).toISOString();assert.equal(f.work().length,0,'183-day parked rows must not create research work');
  f.ingest();assert.equal(f.work().length,1);assert.equal(f.work()[0].registrationFingerprint,fingerprint,'new price freshness revives the same reviewed product/group facts');
});

for(const genericCoop of [false,true])test(`a scoped negative removes only its family's ${genericCoop?'Extra source, preserving the generic Coop donor':'source and documented same-chain native alias'}`,t=>{
  const f=setup(t,{nativeIdentity:!genericCoop});let otherKey;
  if(genericCoop){
    const previous=f.p.productKey;f.p.store='COOP_NO';f.p.productKey='kassal:COOP_NO:71';f.p.metadataFingerprint=productMetadataFingerprint(f.p);
    for(const member of f.data.memberships)if(member.productKey===previous){member.productKey=f.p.productKey;member.reviewedFingerprint=f.p.metadataFingerprint;}
    for(const price of f.data.prices)if(price.productKey===previous)price.productKey=f.p.productKey;
    otherKey=f.p.productKey;
  }else{
    const other={...structuredClone(f.p),productKey:'kassal:COOP_EXTRA:71',store:'COOP_EXTRA',sourceUrl:'https://producer.example.test/independent-chain'};other.metadataFingerprint=productMetadataFingerprint(other);
    f.data.products.push(other);f.data.memberships.push({...structuredClone(f.data.memberships[0]),productKey:other.productKey,reviewedFingerprint:other.metadataFingerprint,sourceReceipts:[{url:other.sourceUrl,observedAt:NOW,evidence:'Read this independent chain record; no cross-chain native identity is inferred.'}]});
    f.data.prices.push({productKey:other.productKey,grossPackPrice:25,receiptAt:NOW,availabilityScope:'chain',sourceUrl:other.sourceUrl});otherKey=other.productKey;
  }
  f.write();f.reload();
  if(genericCoop)f.shop.settings({stores:[...f.shop.view().settings.stores,{id:'generic-coop',name:'Generic Coop',chainCode:'COOP_NO',url:'https://shop.example.test/coop',minSavings:0}]});
  const second=f.shop.watch({id:'second-bean-family',name:'Second whole-bean need',unit:'kg',storage:'pantry',purchaseAmount:10,targetPrice:50});
  f.shop.libraryLink({familyId:second.id,evidence:'This second household need explicitly accepts the current broad whole-bean group.',variants:[{groupId:f.A.id,groupFingerprint:groupMetadataFingerprint(f.A),evidence:'Actual whole roasted beans are reviewed for this family too.'}]});
  f.nativeReview(f.native());
  const nativeSecond=f.shop.catalogObserve({watchId:second.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,brand:f.p.brand,ean:f.p.ean,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:NOW}]}).entries[0];
  f.shop.catalogReview({watchId:second.id,id:nativeSecond.id,store:nativeSecond.store,fingerprint:nativeSecond.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Read this exact native physical variant, contents and package for the second family.'});
  const key=genericCoop?'sesum:COOP_EXTRA:72':SOURCE;
  const receive=(price=20)=>genericCoop?f.shop.sesumReceivePrices({familyIds:[f.w.id,second.id],fetchedAt:f.clock.at,products:[{id:'72',name:f.p.name,brand:f.p.brand,ean:[f.p.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-native-beans',prices:[{storeCode:'EXTRA',price,observedAt:f.clock.at,source:'actual_price_receipt',isPromo:false}]}]}):f.ingest({familyIds:[f.w.id,second.id],price});
  f.clock.at='2026-11-10T12:01:00Z';receive();
  const candidate=()=>f.shop.sesumCandidates().find(row=>row.sourceKey===key);
  if(genericCoop){const row=candidate(),donor=row.donors.find(row=>row.productKey===f.p.productKey);f.shop.sesumPriceReview({sourceKey:key,sourceFingerprint:row.sourceFingerprint,productKey:f.p.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The actual Extra bag and reviewed generic Coop donor identify the same physical contents and fixed package, without treating Coop as an Extra chain receipt.',packEvidence:'Both exact fixed 500g package records were read.'});}
  else f.register({g:f.A,details:{description:f.p.description,attributes:f.p.attributes}});
  const item=id=>f.shop.familyView().items.find(row=>row.id===id),family=id=>candidate().families.find(row=>row.familyId===id);
  assert.equal(item(f.w.id).prices.current,40);assert.equal(item(second.id).prices.current,40);
  const before=family(f.w.id),registrationFingerprint=before.registrationFingerprint;
  f.shop.sesumPriceReview({sourceKey:key,sourceFingerprint:candidate().sourceFingerprint,status:'excluded',familyIds:[f.w.id],familyFingerprints:{[f.w.id]:before.requirementsFingerprint},registrationFingerprint,equivalenceEvidence:'After reading the actual source variant, this family explicitly excludes this source choice. The second family and independent chain variants retain their own decisions.'});
  const independentPrice=genericCoop?60:50;
  for(let i=0;i<3;i++){
    assert.equal(item(f.w.id).prices.current,independentPrice);assert.equal(item(second.id).prices.current,40);
    assert.equal(family(f.w.id).requirementsFingerprint,before.requirementsFingerprint,'applying a negative cannot change its own requirement fingerprint');
    assert.equal(family(f.w.id).sourceDecision.status,'excluded');
  }
  const detail=f.shop.explorer.family('followed:'+f.w.id).family.members;
  assert.ok(!detail.some(row=>row.key===key));assert.ok(detail.some(row=>row.key===otherKey&&row.unitPrice===independentPrice));
  if(!genericCoop)assert.ok(!detail.some(row=>row.key===f.p.productKey),'the documented same-chain native counterpart is also held');
  assert.ok(f.shop.explorer.family('followed:'+second.id).family.members.some(row=>row.key===key&&row.unitPrice===40));
  assert.ok(f.shop.explorer.family(f.A.id).family.members.some(row=>row.key===key&&row.unitPrice===40),'a scoped negative never mutates the shared product library');
  const line=f.shop.list({action:'add',watchId:f.w.id,storeName:'Another store',packAmount:.5,packs:1,unitPrice:100});
  const alternatives=f.shop.familyView().list.open.find(row=>row.id===line.id).others;
  assert.ok(alternatives.some(row=>row.productKey===otherKey));assert.ok(!alternatives.some(row=>row.productKey===key||!genericCoop&&row.productKey===f.p.productKey));
  f.clock.at='2026-11-10T12:02:00Z';receive(18);f.reload();
  assert.equal(item(f.w.id).prices.current,independentPrice);assert.equal(item(second.id).prices.current,36);assert.equal(family(f.w.id).sourceDecision.status,'excluded');assert.equal(family(f.w.id).registrationFingerprint,registrationFingerprint,'price/date changes do not undo a scoped decision');
  f.shop.watch({...f.shop.view().watches.find(row=>row.id===f.w.id),note:'The household explicitly expanded its accepted whole-bean variant requirement.'});
  assert.equal(family(f.w.id).sourceDecision,null);assert.equal(item(f.w.id).prices.current,independentPrice,'actual changed requirements reopen review while the prior explicit negative keeps a conservative price hold');
  assert.ok(f.shop.queue().some(row=>row.do==='shopping-sesum-family-review'&&row.sourceKey===key&&row.familyId===f.w.id));
  const current=family(f.w.id);f.shop.sesumPriceReview({sourceKey:key,sourceFingerprint:candidate().sourceFingerprint,status:'reopen',familyIds:[f.w.id],familyFingerprints:{[f.w.id]:current.requirementsFingerprint},registrationFingerprint:current.registrationFingerprint,equivalenceEvidence:'The current household requirement and actual source were explicitly reviewed; the earlier family exclusion is now reopened.'});
  assert.equal(item(f.w.id).prices.current,36,'only a concrete current scoped decision releases the earlier source/native hold');
});

test('a scoped native-alias exclusion quarantines only its derived market history and automatic guide',t=>{
  const f=setup(t,{ordinaryBridge:true});f.link([f.A,f.B]);
  const second=f.shop.watch({id:'second-market-family',name:'Second reviewed whole-bean need',unit:'kg',storage:'pantry',purchaseAmount:10,targetPrice:50});
  f.shop.libraryLink({familyId:second.id,evidence:'Both current reviewed bean subgroups are accepted for this independent household family.',variants:[f.A,f.B].map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'The actual reviewed whole-bean variants match this need.'}))});
  for(const familyId of [f.w.id,second.id]){
    const entry=f.shop.catalogObserve({watchId:familyId,products:[{id:f.q.id,store:f.q.store,name:f.q.name,brand:f.q.brand,ean:f.q.ean,ingredients:f.q.ingredients,description:f.q.description,sourceUrl:f.q.sourceUrl,weight:500,weightUnit:'g',currentPrice:25,lastChecked:NOW}]}).entries[0];
    f.shop.catalogReview({watchId:familyId,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The actual current native whole-bean variant and one fixed 500g package are approved for this exact family.'});
  }
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({familyIds:[f.w.id,second.id]});f.bridge();f.place();
  const product={id:f.q.id,store:f.q.store,name:f.q.name,unit:'kg',packAmount:.5,reviewed:true,equivalenceEvidence:'This current exact native variant is approved and has one documented fixed 500g package.',lastChecked:NOW,currentPrice:25,history:Array.from({length:30},(_,i)=>({date:new Date(Date.parse('2026-10-12T10:00:00Z')+i*86400000).toISOString(),price:25}))};
  for(const familyId of [f.w.id,second.id])assert.equal(f.shop.market({watchId:familyId,products:[product]}).status,'ready');
  const s=f.state.shopping,oldSeries=structuredClone(s.priceHistory[f.w.id]),oldBasis=structuredClone(s.priceHistoryBasis[f.w.id]),oldMarket=structuredClone(s.watches[f.w.id].marketCalibration),oldGuide={priceGuide:structuredClone(s.watches[f.w.id].priceGuide),targetPrice:s.watches[f.w.id].targetPrice,excellentPrice:s.watches[f.w.id].excellentPrice},rawCatalog=structuredClone(s.marketCatalog),otherSeries=structuredClone(s.priceHistory[second.id]),otherMarket=structuredClone(s.watches[second.id].marketCalibration),stock={amount:s.watches[f.w.id].stockAmount,at:s.watches[f.w.id].stockCheckedAt,purchaseAmount:s.watches[f.w.id].purchaseAmount};
  assert.equal(f.shop.familyView().items.find(row=>row.id===f.w.id).prices.historyDays,30);
  f.decide('excluded',f.w.id,{equivalenceEvidence:'This current source and its explicitly documented same-chain native variant are excluded for this specific family.'});
  const view=f.shop.familyView().items.find(row=>row.id===f.w.id);
  assert.equal(view.prices.normal,null);assert.equal(view.prices.historyDays,0);assert.equal(view.prices.lowestSeen,null);assert.equal(s.watches[f.w.id].marketCalibration.status,'needs-review');
  assert.equal(s.watches[f.w.id].priceGuide,null);assert.equal(s.watches[f.w.id].targetPrice,null);assert.equal(s.watches[f.w.id].excellentPrice,null);
  const archived=s.priceHistoryArchive[f.w.id].find(row=>row.reason==='scoped-family-exclusion');assert.ok(archived);assert.deepEqual(archived.series,oldSeries);assert.deepEqual(archived.basis,oldBasis);assert.deepEqual(archived.marketCalibration,oldMarket);assert.deepEqual(archived.automaticGuide,oldGuide);
  assert.deepEqual(s.marketCatalog,rawCatalog,'native metadata, actual gross prices and original receipt dates remain untouched');
  assert.deepEqual(s.priceHistory[second.id],otherSeries);assert.deepEqual(s.watches[second.id].marketCalibration,otherMarket,'another family keeps its own actual approved price history');
  assert.equal(s.watches[f.w.id].stockAmount,stock.amount);assert.equal(s.watches[f.w.id].stockCheckedAt,stock.at);assert.equal(s.watches[f.w.id].purchaseAmount,stock.purchaseAmount);
  const recalibrated=f.shop.market({watchId:f.w.id,products:[product]});assert.equal(recalibrated.status,'insufficient');assert.equal(recalibrated.products.length,0,'the old approved native alias cannot reenter via a later market payload');
  assert.equal(f.shop.familyView().items.find(row=>row.id===f.w.id).prices.historyDays,0);assert.equal(f.candidate().families.find(row=>row.familyId===f.w.id).sourceDecision.status,'excluded');assert.deepEqual(s.marketCatalog,rawCatalog);
});
