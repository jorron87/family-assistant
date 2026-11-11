import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';

const NOW='2026-11-10T12:00:00Z',SOURCE='sesum:KIWI:72';
const definition=(id,name)=>({id,name,category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted coffee beans with an explicitly verified organic declaration.',exclusions:['Ground coffee','Added flavourings'],qualityBasis:'Actual ingredients, whole-bean form and organic declaration',comparisonBasis:'Per kg'});
function setup(t,{sourceName='New organic whole beans 500g',onLibraryRead}={}){
  const dir=mkdtempSync(join(tmpdir(),'sesum-placement-'));t.after(()=>{if(!resolve(dir).startsWith(resolve(tmpdir(),'sesum-placement-')))throw Error('Unsafe test cleanup.');rmSync(dir,{recursive:true,force:true});});
  const A=definition('baseline-beans','Baseline organic whole beans'),B=definition('new-beans','New organic whole-bean variants');
  const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Baseline organic whole beans 500g',brand:'Baseline',ean:'1234567890123',ingredients:'Organic whole roasted coffee beans',description:'A reviewed plain organic roast',sourceUrl:'https://producer.example.test/baseline',canonicalPackAmount:.5,unit:'kg',packEvidence:'Read one actual fixed 500g bag.',rawPack:{weight:500,weightUnit:'g'},attributes:{organic:true},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[A],products:[p],memberships:[{groupId:A.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(A),equivalenceEvidence:'The actual plain organic whole beans match this group and brewing use.',qualityEvidence:'Read the full actual original ingredient declaration, form and organic label.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Read the original label and fixed 500g package.'}]}],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:NOW,availabilityScope:'chain',sourceUrl:p.sourceUrl}]};
  const file=join(dir,'library.json'),write=()=>writeFileSync(file,JSON.stringify(data));write();
  let state={},shop;const clock={at:NOW};
  const open=()=>{const provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)});if(onLibraryRead){const read=provider.reader;provider.reader=()=>{onLibraryRead();return read();};}shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});};open();
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi',minSavings:0}]});
  const target=shop.watch({id:'target-beans',name:'Organic whole coffee beans',unit:'kg',storage:'pantry',purchaseAmount:10,stockAmount:2,targetPrice:50,note:'Plain whole roasted organic beans; accepted brands are Baseline and New.'});
  const wrong=shop.watch({id:'wrong-honey-hint',name:'Pure honey',unit:'kg',storage:'pantry',note:'Honey only; no coffee or added ingredients.'});
  const own=shop.watch({id:'own-exact-litter',name:'Exact litter formula',unit:'l',storage:'pantry',note:'Only the exact unscented paw-friendly litter formula; no other products.'});
  const disabled=shop.watch({id:'disabled-family',name:'Disabled need',unit:'kg',storage:'pantry',enabled:false});
  shop.libraryLink({familyId:own.id,variants:[],evidence:'This is an own narrow family with an exact formula requirement.'});
  const link=(groups=[A],extra={})=>shop.libraryLink({familyId:target.id,evidence:'Current explicit household variant decision.',variants:groups.map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Actual plain organic whole-bean contents match the household need.',brands:['Baseline','New'],requires:['organic'],...extra}))});link();
  const source={id:'72',name:sourceName,brand:'New',ean:null,weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-new-source-variant'};
  const ingest=({price=20,observedAt=clock.at,changes={}}={})=>shop.sesumReceivePrices({familyIds:[wrong.id],fetchedAt:clock.at,products:[{...source,...changes,prices:[{storeCode:'KIWI',price,observedAt,source:'actual_source_receipt',isPromo:false}]}]});
  const placement=()=>shop.sesumPlacement(SOURCE),row=()=>placement().items.find(item=>item.sourceKey===SOURCE),candidate=()=>shop.sesumCandidates().find(item=>item.sourceKey===SOURCE);
  const work=()=>shop.queue().filter(item=>item.do==='shopping-sesum-placement-review'&&item.sourceKey===SOURCE);
  const familyWork=()=>shop.queue().filter(item=>item.do==='shopping-sesum-family-review'&&item.sourceKey===SOURCE);
  const review=(extra={})=>{const context=placement(),current=row(),family=context.families.find(f=>f.familyId===target.id);return shop.sesumPriceReview({kind:'placement',sourceKey:SOURCE,sourceFingerprint:current.sourceFingerprint,registrationFingerprint:current.registrationFingerprint,familySetFingerprint:context.familySetFingerprint,status:'reviewed',reviewedAllFamilies:true,scopeEvidence:'Read every current enabled family definition, including whole-bean ingredients/form/brand requirements, honey-only ingredients and the exact non-food litter formula. The actual new organic whole-bean source is relevant only to the coffee family.',targets:[{familyId:target.id,familyFingerprint:family.familyFingerprint,equivalenceEvidence:'The actual original source label documents plain organic whole roasted beans, an accepted New brand and fixed package; this is a research association, not a household variant approval.'}],evidence:'Read the actual new source variant and primary label against the complete current enabled household family set.',...extra});};
  const register=(details={})=>{const current=candidate();return shop.sesumRegister({sourceKey:SOURCE,sourceFingerprint:current.sourceFingerprint,identityEvidence:'Read the actual New brand organic whole-bean variant and original fixed package; the missing barcode is kept unknown.',product:{ingredients:'Organic whole roasted coffee beans',description:'A separately researched plain organic whole-bean roast',brand:'New',attributes:{organic:true},...details},packAmount:.5,unit:'kg',packEvidence:'Read one actual fixed 500g bag on the original source label.',groups:[B],memberships:[{groupId:B.id,groupFingerprint:groupMetadataFingerprint(B),equivalenceEvidence:'Actual plain organic whole roasted beans satisfy this current group; household linking is separate.',qualityEvidence:'The complete actual original ingredient list, whole-bean form and organic declaration were read.'}],sourceReceipts:[{url:'https://producer.example.test/new-original-label',observedAt:clock.at,evidence:'Read the actual original contents, organic declaration and fixed 500g bag.'}]});};
  return {get shop(){return shop;},get state(){return state;},clock,A,B,p,data,write,target,wrong,own,disabled,link,source,ingest,placement,row,candidate,work,familyWork,review,register,reload(){state=JSON.parse(JSON.stringify(state));open();}};
}

test('all enabled semantic definitions can research an unhinted target without approving metadata, membership or prices',t=>{
  const f=setup(t);f.ingest();const initial=f.placement();
  assert.deepEqual(new Set(initial.families.map(f=>f.familyId)),new Set([f.target.id,f.wrong.id,f.own.id]));assert.ok(initial.familySetFingerprint);assert.equal(initial.items.length,1);assert.equal(f.row().registrationFingerprint,null);assert.equal(f.work().length,1);
  const target=initial.families.find(item=>item.familyId===f.target.id),serialized=JSON.stringify(target);for(const fact of [f.A.inclusionCriteria,...f.A.exclusions,'Baseline','New','organic'])assert.ok(serialized.includes(fact),fact);
  assert.equal(initial.families.find(item=>item.familyId===f.own.id).note,f.own.note);assert.equal(f.candidate().source.ean.length,0,'missing EAN never suppresses placement research');
  f.review();assert.equal(f.row().status,'reviewed');assert.deepEqual(f.row().rawFamilyIds,[f.wrong.id]);assert.deepEqual(f.row().researchedFamilyIds,[f.target.id]);
  assert.deepEqual(f.candidate().familyIds,[f.wrong.id]);assert.ok(f.candidate().effectiveFamilyIds.includes(f.target.id));assert.ok(f.candidate().families.some(item=>item.familyId===f.target.id));
  assert.ok(f.shop.queue().some(item=>['shopping-sesum-discovery','shopping-sesum-review'].includes(item.do)&&item.sourceKey===SOURCE&&item.familyIds.includes(f.target.id)));
  assert.equal(f.shop.familyView().items.find(item=>item.id===f.target.id).prices.current,60,'routing is not identity approval or a fresh price bridge');
  f.register();assert.equal(f.familyWork().length,0,'new product facts require the current placement stage before new family research');assert.equal(f.row().status,'pending','new researched metadata reopens the finite placement receipt');assert.ok(f.row().researchedFamilyIds.includes(f.target.id),'the valid researched target remains a hint while the full receipt is refreshed');
  assert.equal(f.shop.familyView().items.find(item=>item.id===f.target.id).prices.current,60,'a new registered group cannot approve an already built household family');
  f.review();assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));f.link([f.A,f.B]);assert.ok(!f.familyWork().some(item=>item.familyId===f.target.id));assert.equal(f.shop.familyView().items.find(item=>item.id===f.target.id).prices.current,40);
  assert.equal(f.row().status,'pending','the materially changed current family set needs one explicit placement rereview');f.review();assert.equal(f.row().status,'reviewed');assert.equal(f.work().length,0);f.reload();assert.equal(f.work().length,0);
  assert.deepEqual(f.candidate().familyIds,[f.wrong.id],'raw source hints are never rewritten to manufacture family approval');
});

test('terminal placement decisions require whole-current-set proof, current fingerprints and valid explicit targets',t=>{
  const f=setup(t);f.ingest();const target=f.placement().families.find(item=>item.familyId===f.target.id),good={familyId:target.familyId,familyFingerprint:target.familyFingerprint,equivalenceEvidence:'Concrete actual whole-bean source form and declared organic ingredients match this research target.'};
  for(const extra of [{reviewedAllFamilies:false},{scopeEvidence:''},{evidence:''},{sourceFingerprint:'b'.repeat(64)},{registrationFingerprint:'stale-registration'},{familySetFingerprint:'stale-family-set'},{targets:[]},{targets:[{...good,familyId:'missing-family'}]},{targets:[{...good,familyFingerprint:'stale-target'}]},{targets:[good,good]}])assert.throws(()=>f.review(extra));
  assert.equal(f.row().status,'pending');assert.deepEqual(f.row().researchedFamilyIds,[],'failed writes cannot partially route an unreviewed source');
  f.review();assert.equal(f.row().status,'reviewed');f.review({status:'reopen',targets:[]});assert.equal(f.row().status,'pending');
});

test('explicit no-active-family resolution differs from a durable blocked unfinished placement',t=>{
  const none=setup(t,{sourceName:'Dishwashing brush 500g'});none.ingest();
  assert.throws(()=>none.review({status:'no-active-family',targets:[],reason:'The actual non-food cleaning brush matches none of the current needs.'}));
  none.review({status:'no-active-family',targets:[],noActiveFamilyVerified:true,reason:'The actual cleaning brush is neither honey, organic whole coffee beans nor the exact litter formula.',scopeEvidence:'Read all current enabled definitions and actual primary brush material/form; no current family accepts this cleaning tool.'});
  assert.equal(none.row().status,'no-active-family');assert.equal(none.work().length,0);assert.equal(none.candidate().status,'pending','none resolution never approves source identity or price');none.reload();assert.equal(none.row().status,'no-active-family');
  const blocked=setup(t,{sourceName:'Unknown labelled product 500g'});blocked.ingest();blocked.review({status:'blocked',reviewedAllFamilies:false,targets:[],reason:'The actual label contents and physical form are unavailable, so placement cannot yet be researched.',retryAt:'2026-11-10T13:00:00Z'});
  assert.equal(blocked.row().status,'blocked');assert.equal(blocked.work().length,0);assert.deepEqual(blocked.row().researchedFamilyIds,[]);assert.equal(blocked.shop.completion().complete,false);assert.ok(blocked.shop.completion().blockedPlacements.some(item=>item.sourceKey===SOURCE));
  blocked.reload();assert.equal(blocked.work().length,0);blocked.clock.at='2026-11-10T13:00:01Z';assert.equal(blocked.work().length,1);
});

const identityWork=f=>f.shop.queue().filter(row=>row.sourceKey===SOURCE&&['shopping-sesum-discovery','shopping-sesum-review'].includes(row.do));
const noFamily=f=>f.review({status:'no-active-family',targets:[],noActiveFamilyVerified:true,
  reason:'The actual primary-labelled dishwashing brush is a cleaning tool, not honey, whole coffee beans or the exact litter formula.',
  scopeEvidence:'Read the complete current enabled family definitions, ingredient/form/organic/brand requirements and exact litter formula against the actual brush materials and use; no current need accepts this product.'});

test('legacy whole-set receipts recover exact criteria and code handles incompatible changed units after reload',t=>{
 const f=setup(t);f.ingest();f.review();f.register();f.review();
 const state=f.state.shopping,original=structuredClone(state.sesumPlacementReviews[SOURCE]);
 (state.sesumPlacementReviewHistory??=[]).push({...structuredClone(original),historyProofVersion:2});
 delete state.sesumPlacementReviews[SOURCE].familyProofVersion;delete state.sesumPlacementReviews[SOURCE].reviewedFamilies;
 const legacy=structuredClone(state.sesumPlacementReviews[SOURCE]);
 f.shop.watch({...f.own,note:f.own.note+' An actual narrower litter attribute is now required.'});
 assert.equal(f.work().length,0,'a reviewed kg source cannot match this changed litre-only family');
 assert.equal(f.row().status,'reviewed');assert.equal(f.row().review.reviewedAt,original.reviewedAt);assert.equal(f.row().review.recoveredFamilyBasis,original.familySetFingerprint);
 assert.deepEqual(f.row().reviewDelta.familiesToReview,[]);assert.deepEqual(f.row().reviewDelta.codeExcludedFamilies.map(f=>f.familyId),[f.own.id]);
 assert.deepEqual(state.sesumPlacementReviews[SOURCE],legacy,'read-time reuse never rewrites the original source receipt');
 f.reload();assert.equal(f.work().length,0);assert.equal(f.row().review.reviewedAt,original.reviewedAt);
 f.shop.watch({...f.target,note:f.target.note+' A materially changed roasting requirement must be read.'});
 assert.equal(f.work().length,1);assert.deepEqual(f.row().reviewDelta.familiesToReview,[f.target.id]);
 assert.deepEqual(f.row().reviewDelta.retainedTargets,[],'a genuinely changed positive requirement is not retained');
 assert.equal(f.shop.completion().complete,false);
});

test('source holds stay visible across unrelated family edits, become due normally and reopen on new facts',t=>{
 const f=setup(t);f.ingest();f.review({status:'blocked',targets:[],reason:'The primary original label is not readable; ingredients remain unknown.',retryAt:'2026-11-10T13:00:00Z'});
 const original=structuredClone(f.state.shopping.sesumPlacementReviews[SOURCE]);
 f.shop.watch({...f.wrong,note:f.wrong.note+' A new honey production requirement.'});
 assert.equal(f.work().length,0);assert.equal(f.row().status,'blocked');assert.equal(f.row().retryAt,original.retryAt);assert.deepEqual(f.row().review,original);
 const report=f.shop.completion();assert.ok(report.blockedPlacements.some(p=>p.sourceKey===SOURCE&&p.retryAt===original.retryAt));assert.equal(report.complete,false);
 f.reload();assert.equal(f.work().length,0);f.clock.at='2026-11-10T13:00:01Z';assert.equal(f.work().length,1);assert.equal(f.row().status,'blocked');
 f.ingest({changes:{name:'A materially changed actual product label 500g'}});assert.equal(f.row().status,'pending');assert.equal(f.row().retryAt,null);assert.equal(f.work().length,1);
});

test('unknown native units cannot acquire code exclusions from an unreviewed pack or source name',t=>{
 const f=setup(t);f.ingest();const before=f.row();assert.equal(before.reviewDelta.codeExcludedFamilies,undefined);
 f.review();f.register();const registered=f.row();assert.ok(registered.reviewDelta.codeExcludedFamilies.some(x=>x.familyId===f.own.id));
 f.ingest({changes:{name:'A changed actual source variant 500g'}});assert.equal(f.row().reviewDelta.codeExcludedFamilies,undefined,'a stale registered pack never lends a unit to changed source facts');
});

test('a counted package needs primary net-measure evidence before research, registration and price comparison can proceed',t=>{
 const f=setup(t,{sourceName:'Eight fixed whole-bean portions 500g'});f.ingest({changes:{weight:8,weightUnit:'stk'}});
 const source=structuredClone(f.row().source),receiptAt=f.row().receiptAt;
 assert.throws(()=>f.review(),/mengdeenhet/,'the source name and eight pieces cannot invent a canonical mass');
 const countedPack={reviewed:true,wholePack:true,sourceCount:8,packAmount:.5,unit:'kg',evidence:'Read the actual original eight-portion consumer bag. All eight portions together have a declared total net mass of 500 g, not 500 g per portion.',sourceReceipts:[{url:'https://producer.example.test/eight-whole-bean-portions',observedAt:f.clock.at,evidence:'Actual original full ingredients and whole eight-portion bag with total net 500 g were read.'}]};
 f.review({countedPack});assert.equal(f.row().status,'reviewed');assert.equal(f.row().review.targets[0].countedPackReviewed,true);assert.deepEqual(f.row().source,source);
 assert.equal(f.candidate().status,'pending');assert.equal(f.shop.familyView().items.find(x=>x.id===f.target.id).prices.current,60,'a package review and research target approve no identity or price');
 assert.throws(()=>f.register(),/package amounts disagree/);
 f.shop.sesumRegister({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,identityEvidence:'Read this exact original organic whole-bean product, its eight portions and the complete 500 g consumer package.',product:{ingredients:'Organic whole roasted coffee beans',description:'Eight fixed portions of plain whole roasted beans',brand:'New',attributes:{organic:true}},packAmount:.5,unit:'kg',packEvidence:'The eight actual portions together are one fixed consumer bag of 500 g.',countedPack,groups:[f.B],memberships:[{groupId:f.B.id,groupFingerprint:groupMetadataFingerprint(f.B),equivalenceEvidence:'Read actual whole roasted bean ingredients and physical form matching this current organic group.',qualityEvidence:'Read the original ingredient list and organic declaration on the actual full consumer pack.'}],sourceReceipts:countedPack.sourceReceipts});
 assert.equal(f.row().status,'pending','registered identity is new facts, not automatic old placement approval');
 f.review({countedPack});f.link([f.A,f.B]);f.review({countedPack});
 assert.equal(f.shop.familyView().items.find(x=>x.id===f.target.id).prices.current,40,'20 currency units apply to one whole 0.5 kg bag, never eight times that amount');
 assert.throws(()=>f.review({countedPack:{...countedPack,packAmount:.4}}),/produktgrunnlag/,'a placement cannot change an already registered physical pack');
 assert.equal(f.row().receiptAt,receiptAt);assert.deepEqual(f.row().source,source);assert.equal(f.candidate().families.find(x=>x.familyId===f.target.id).sourceDecision,null);
 f.reload();assert.equal(f.row().status,'reviewed');assert.equal(f.row().review.countedPack.packAmount,.5);
 f.ingest({changes:{weight:9,weightUnit:'stk'}});assert.equal(f.row().status,'pending');assert.throws(()=>f.review({countedPack}),/count must match/);
});

test('queue and completion each reuse one library snapshot without retaining it between invocations',t=>{
  let reads=0;const f=setup(t,{onLibraryRead:()=>reads++});f.ingest();
  reads=0;const queue=f.shop.queue();assert.equal(reads,1,'all derived work within one queue uses one base reader');
  reads=0;const report=f.shop.completion();assert.equal(reads,1,'queue and blocked computations in completion share the same base reader');assert.deepEqual(report.work,queue);
  reads=0;assert.deepEqual(f.shop.queue(),queue);assert.equal(reads,1,'a subsequent invocation must obtain a fresh reader');
});

test('shared completion reads preserve future blocked retries and notice due time and changed source facts on the next call',t=>{
  const f=setup(t);f.ingest();f.review({status:'blocked',targets:[],reason:'The actual primary label is unreadable; its organic form remains unresolved.',retryAt:'2026-11-10T12:01:00Z'});
  const before=f.shop.completion();assert.equal(f.work().length,0);assert.equal(before.blockedPlacements.length,1);assert.equal(before.complete,false);assert.equal(before.blockedPlacements[0].retryAt,'2026-11-10T12:01:00Z');
  f.clock.at='2026-11-10T12:01:01Z';const due=f.shop.completion();assert.equal(due.blockedPlacements.length,1);assert.ok(due.work.some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE));
  f.ingest({changes:{name:'A materially changed actual ground-coffee variant 500g'}});const changed=f.shop.completion();assert.equal(changed.blockedPlacements.length,0);assert.ok(changed.work.some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE&&row.status==='pending'));
});

test('a changed actual library group reopens placement between reads without reusing the preceding semantic snapshot',t=>{
  const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest();noFamily(f);const before=f.shop.completion();assert.ok(!before.work.some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE));
  const fingerprint=f.placement().familySetFingerprint;f.data.groups[0].inclusionCriteria+=' Changed explicit household-relevant ingredient and form criteria.';f.write();
  const after=f.shop.completion();assert.notEqual(f.placement().familySetFingerprint,fingerprint);assert.ok(after.work.some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE));assert.equal(identityWork(f).length,0,'new semantics first reopen placement');assert.ok(after.work.some(row=>row.do==='shopping-family-build'&&row.reason==='group-changed'));
});

test('a failed queue read always discards its invocation context before a later read or metadata change',t=>{
  let fail=false,reads=0;const f=setup(t,{sourceName:'Dishwashing brush 500g',onLibraryRead:()=>{reads++;if(fail)throw Error('Synthetic unavailable reader.');}});f.ingest();
  fail=true;assert.throws(()=>f.shop.queue(),/Synthetic unavailable reader/);fail=false;reads=0;f.shop.queue();assert.equal(reads,1);
  noFamily(f);assert.equal(identityWork(f).length,0);f.shop.watch({...f.target,note:'A newly specified actual form now requires explicit source research.'});reads=0;assert.ok(f.shop.queue().some(row=>row.do==='shopping-sesum-placement-review'&&row.sourceKey===SOURCE));assert.equal(reads,1,'the successful call after an error must not leave a persistent cache either');
});

test('a current whole-set no-family review removes redundant discovery from the actual queue without approving identity',t=>{
  const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest();assert.equal(identityWork(f).length,0,'placement precedes identity even before an explicit no-family result');assert.equal(f.work().length,1);
  const before=f.shop.familyView().items.find(row=>row.id===f.target.id).prices.current;noFamily(f);
  assert.equal(f.work().length,0);assert.equal(identityWork(f).length,0,'raw OR-search hints cannot recreate identity research after every active need was explicitly ruled out');
  assert.equal(f.candidate().status,'pending');assert.deepEqual(f.candidate().familyIds,[f.wrong.id]);assert.equal(f.shop.catalogEntries().length,0);
  assert.equal(f.shop.familyView().items.find(row=>row.id===f.target.id).prices.current,before);
  f.reload();assert.equal(identityWork(f).length,0);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:18});
  f.shop.sesumReceivePrices({familyIds:[f.target.id],fetchedAt:f.clock.at,products:[{...f.source,prices:[{storeCode:'KIWI',price:18,observedAt:f.clock.at,source:'actual_source_receipt',isPromo:false}]}]});
  assert.equal(f.row().status,'no-active-family');assert.equal(identityWork(f).length,0,'capture, receipt and raw-hint changes alone do not alter the reviewed family semantics');
  assert.deepEqual(new Set(f.candidate().familyIds),new Set([f.wrong.id,f.target.id]));
});

test('source, enabled-family, semantic and explicit reopen changes restore identity research after no-family',t=>{
  for(const change of ['source','new-enabled-family','family-note','reopen']){
    const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest();noFamily(f);assert.equal(identityWork(f).length,0);
    if(change==='source')f.ingest({changes:{name:'A materially changed actual source variant 500g'}});
    else if(change==='new-enabled-family')f.shop.watch({...f.disabled,enabled:true});
    else if(change==='family-note')f.shop.watch({...f.target,note:'Current household needs now include a different explicitly specified actual product form.'});
    else f.review({status:'reopen',targets:[]});
    assert.equal(f.row().status,'pending',change);assert.equal(f.work().length,1,change);assert.equal(identityWork(f).length,0,change);
    f.reload();assert.equal(f.work().length,1,change);assert.equal(identityWork(f).length,0,change);
  }
});

test('a suggested reviewed donor does not recreate identity-review work after current whole-set no-family research',t=>{
  const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest({changes:{ean:f.p.ean}});
  assert.ok(f.candidate().donors.length>0,'a barcode coincidence remains only a donor suggestion');assert.equal(identityWork(f).length,0,'a suggested donor cannot bypass placement');
  noFamily(f);assert.equal(identityWork(f).length,0);assert.equal(f.candidate().status,'pending');assert.equal(f.shop.catalogEntries().length,0);
  f.reload();assert.equal(identityWork(f).length,0);
});

test('a no-family verdict on an old priced identity never hides changed own metadata received without chain prices',t=>{
  const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest();noFamily(f);const prior=f.row();assert.equal(identityWork(f).length,0);
  f.clock.at='2026-11-10T12:01:00Z';f.shop.sesumReceivePrices({familyIds:[f.wrong.id],fetchedAt:f.clock.at,products:[{...f.source,name:'New actual organic whole-bean variant 500g',prices:[]}]});
  const key='sesum-product:72',current=f.shop.sesumPlacement(key).items.find(row=>row.sourceKey===key);
  assert.ok(current,'the new actual metadata keeps its own chain-neutral placement subject');assert.equal(current.status,'pending');assert.notEqual(current.sourceFingerprint,prior.sourceFingerprint);
  assert.ok(f.shop.queue().some(row=>row.sourceKey===key&&row.do==='shopping-sesum-placement-review'));
  assert.equal(f.state.shopping.sesumPlacementReviews[SOURCE].sourceFingerprint,prior.sourceFingerprint,'the old decision stays historical and cannot settle different actual metadata');
  assert.equal(identityWork(f).length,0,'an unchanged older quote does not supply a price for the new variant');
  f.reload();assert.ok(f.shop.queue().some(row=>row.sourceKey===key&&row.do==='shopping-sesum-placement-review'));
});

test('no-family research is bound to the exact source and never drops scoped exclusions or independent source work',t=>{
  const f=setup(t,{sourceName:'Dishwashing brush 500g'});f.ingest();
  f.shop.sesumReceivePrices({familyIds:[f.target.id],fetchedAt:f.clock.at,products:[{...f.source,prices:[{storeCode:'KIWI',price:20,observedAt:f.clock.at,source:'actual_source_receipt',isPromo:false}]}]});
  const wrong=f.candidate().families.find(row=>row.familyId===f.wrong.id);
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:null,status:'excluded',familyIds:[f.wrong.id],familyFingerprints:{[f.wrong.id]:wrong.requirementsFingerprint},equivalenceEvidence:'Read the actual cleaning brush materials and use; this specific honey-family hint is incompatible.'});
  const excluded=structuredClone(f.state.shopping.sesumFamilyReviews[SOURCE][f.wrong.id]);noFamily(f);assert.equal(identityWork(f).length,0);
  f.shop.settings({stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi'},{id:'rema',name:'REMA',chainCode:'REMA_1000',url:'https://shop.example.test/rema'}]});
  f.shop.sesumReceivePrices({familyIds:[f.wrong.id],fetchedAt:f.clock.at,products:[{...f.source,prices:[{storeCode:'REMA_1000',price:21,observedAt:f.clock.at,source:'actual_source_receipt',isPromo:false}]}]});
  assert.equal(identityWork(f).length,0);assert.ok(f.shop.queue().some(row=>row.sourceKey==='sesum:REMA_1000:72'&&row.do==='shopping-sesum-placement-review'),'another chain has its own first research stage, never an inferred native alias');
  assert.deepEqual(f.state.shopping.sesumFamilyReviews[SOURCE][f.wrong.id],excluded);
  f.review({status:'reopen',targets:[]});assert.equal(identityWork(f).length,0);assert.equal(f.work().length,1);assert.equal(f.candidate().families.find(row=>row.familyId===f.wrong.id).sourceDecision.status,'excluded','the still-current explicit scoped negative remains in force while placement is researched');
});

test('new explicit product registration reopens placement and family work instead of inheriting a prior no-family result',t=>{
  const f=setup(t,{sourceName:'New coffee 500g'});f.ingest();f.review({status:'no-active-family',targets:[],noActiveFamilyVerified:true,reason:'Prior primary research identified ground coffee, which none of the current enabled families accept.',scopeEvidence:'Reviewed all enabled families: the coffee need accepts organic whole beans only, honey accepts actual honey and the exact litter need accepts only its non-food formula.'});assert.equal(identityWork(f).length,0);
  f.register();assert.equal(f.row().status,'pending');assert.equal(f.work().length,1);assert.equal(f.familyWork().length,0,'new reviewed facts first require the current placement');
  f.reload();assert.equal(f.row().status,'pending');assert.equal(f.familyWork().length,0);f.review();assert.ok(f.familyWork().length>0,'current placement opens the actual ordinary family decision');
});

test('price, receipt dates, planning quantities and repeated identical family decisions do not churn semantic placement',t=>{
  const f=setup(t);f.ingest();f.review();const fingerprint=f.row().fingerprint,setFingerprint=f.placement().familySetFingerprint;
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:18});f.link();
  f.shop.watch({...f.shop.view().watches.find(item=>item.id===f.target.id),targetPrice:45,stockAmount:3,purchaseAmount:12});
  assert.equal(f.placement().familySetFingerprint,setFingerprint);assert.equal(f.row().fingerprint,fingerprint);assert.equal(f.row().status,'reviewed');assert.equal(f.work().length,0);
  f.reload();assert.equal(f.row().fingerprint,fingerprint);assert.equal(f.row().status,'reviewed');
});

test('enabled semantic-set and registered fact changes reopen placement without dropping still-valid research hints',t=>{
  for(const change of ['enabled-family','group-rule','registration']){
    const f=setup(t);f.ingest();f.register();f.review();const before=f.row().fingerprint,set=f.placement().familySetFingerprint;
    if(change==='enabled-family'){f.shop.watch({...f.disabled,enabled:true});}
    else if(change==='group-rule'){f.A.inclusionCriteria='Plain whole roasted coffee beans with newly clarified actual organic review criteria.';f.write();}
    else f.register({description:'A materially revised actual roast declaration from current product research'});
    assert.equal(f.row().status,'pending');assert.notEqual(f.row().fingerprint,before);
    if(change==='registration'){assert.equal(f.placement().familySetFingerprint,set);assert.ok(f.row().researchedFamilyIds.includes(f.target.id),'a researched association is not lost merely because its source metadata review advanced');assert.equal(f.familyWork().length,0);f.review();assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));}
    else assert.notEqual(f.placement().familySetFingerprint,set);
  }
});

test('a scoped wrong-search-family negative never hides all-family placement or its unhinted correct target',t=>{
  const f=setup(t);f.ingest();const wrong=f.candidate().families.find(item=>item.familyId===f.wrong.id);
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:null,status:'excluded',familyIds:[f.wrong.id],familyFingerprints:{[f.wrong.id]:wrong.requirementsFingerprint},equivalenceEvidence:'The actual source contains organic whole roasted coffee beans, no honey; only the honey hint is excluded.'});
  assert.equal(f.work().length,1);f.review();assert.ok(f.candidate().effectiveFamilyIds.includes(f.target.id));assert.deepEqual(f.candidate().familyIds,[f.wrong.id]);
  assert.ok(f.shop.queue().some(item=>['shopping-sesum-discovery','shopping-sesum-review'].includes(item.do)&&item.sourceKey===SOURCE&&item.familyIds.includes(f.target.id)));
  f.register();assert.ok(!f.familyWork().some(item=>item.familyId===f.target.id),'only the earlier explicit negative may remain independent debt before placement');f.review();assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({changes:{name:'New ground coffee 500g'}});assert.equal(f.row().status,'pending');assert.deepEqual(f.row().researchedFamilyIds,[],'actual changed source identity invalidates the old positive research hint');
});

test('known 183-day-old receipts park pending placement and a real newer receipt revives the same semantic task',t=>{
  const f=setup(t);f.ingest();const fingerprint=f.row().fingerprint;assert.equal(f.work().length,1);
  f.clock.at=new Date(Date.parse(NOW)+184*86400000).toISOString();assert.equal(f.work().length,0,'old actual prices never trigger new parked-product research');
  f.ingest();assert.equal(f.work().length,1);assert.equal(f.row().fingerprint,fingerprint,'price freshness is independent of the product/family semantic review');
  const unknown=setup(t);unknown.ingest({observedAt:null});assert.equal(unknown.work().length,1,'a new observation with no known actual price date is explicit research, not silently parked');
});

test('placement cannot contradict known units, reviewed requirements or an actual current family membership',t=>{
  const f=setup(t);f.ingest();let own=f.placement().families.find(family=>family.familyId===f.own.id);
  assert.throws(()=>f.review({targets:[{familyId:own.familyId,familyFingerprint:own.familyFingerprint,equivalenceEvidence:'A known mass package cannot be placed in the exact litter volume family.'}]}),/mengdeenhet/);
  f.register({attributes:{organic:false}});assert.throws(()=>f.review(),/egenskapskrav/);
  f.register({attributes:{organic:true}});f.link([f.A,f.B]);
  assert.throws(()=>f.review({status:'no-active-family',targets:[],noActiveFamilyVerified:true,reason:'A claimed empty result cannot replace the actually reviewed current coffee family.'}),/allerede faktisk godkjent/);
});

test('an identical family-link rereview preserves a scoped negative and changed criteria require an explicit fresh decision',t=>{
  const f=setup(t);f.ingest();f.review();f.register();f.link([f.A,f.B]);f.review();
  const item=()=>f.shop.familyView().items.find(item=>item.id===f.target.id),family=()=>f.candidate().families.find(item=>item.familyId===f.target.id);
  assert.equal(item().prices.current,40,'the registered source has actual current household membership before the explicit exclusion');
  const before=family(),setFingerprint=f.placement().familySetFingerprint;
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:before.registrationFingerprint,status:'excluded',familyIds:[f.target.id],familyFingerprints:{[f.target.id]:before.requirementsFingerprint},equivalenceEvidence:'The actual researched source roast is excluded for this specific household need despite its broad library group membership.'});
  assert.equal(item().prices.current,60);assert.equal(family().sourceDecision.status,'excluded');
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:18});f.link([f.A,f.B]);
  assert.equal(f.placement().familySetFingerprint,setFingerprint);assert.equal(family().requirementsFingerprint,before.requirementsFingerprint,'review timestamps are not new household requirements');
  assert.equal(family().sourceDecision.status,'excluded');assert.equal(item().prices.current,60,'fresh source price and an identical group-link decision cannot restore the excluded source');
  f.reload();assert.equal(family().sourceDecision.status,'excluded');assert.equal(item().prices.current,60);
  f.shop.watch({...f.shop.view().watches.find(item=>item.id===f.target.id),note:'The household explicitly broadened its acceptable plain organic whole-bean roast requirement.'});
  const changed=f.placement().families.find(item=>item.familyId===f.target.id);
  assert.notEqual(changed.familyFingerprint,before.requirementsFingerprint);assert.equal(family().sourceDecision,null,'the old negative no longer counts as a current reviewed decision');
  assert.equal(family().familyReview.status,'pending');assert.ok(f.familyWork().some(row=>row.familyId===f.target.id),'historical explicit negative routing keeps the unhinted family reachable for a fresh decision');
  assert.equal(item().prices.current,60,'changed requirements cannot silently make a previously excluded price actionable');
  assert.equal(f.row().status,'pending','the changed current semantic family set still requires its finite placement rereview');
  const decide=status=>{const current=family();return f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:current.registrationFingerprint,status,familyIds:[f.target.id],familyFingerprints:{[f.target.id]:current.requirementsFingerprint},equivalenceEvidence:'Read the actual source against the changed household criteria; the prior exclusion remains held until this explicit current decision.',...(status==='blocked'?{reason:'The changed household roast requirement needs concrete confirmation before restoring this source.',retryAt:'2026-11-10T13:00:00Z'}:{})});};
  decide('blocked');assert.equal(item().prices.current,60);assert.ok(!f.familyWork().some(row=>row.familyId===f.target.id));assert.equal(f.shop.completion().complete,false);assert.ok(f.shop.completion().blockedFamilies.some(row=>row.familyId===f.target.id));
  f.reload();assert.equal(item().prices.current,60);assert.equal(family().sourceDecision.status,'blocked');
  decide('reopen');assert.equal(item().prices.current,36,'only an explicit current scoped decision can release the old price hold');
});

test('an exact current legacy family fingerprint migrates without losing its scoped exclusion or original basis',t=>{
  const f=setup(t);f.ingest();f.review();f.register();f.link([f.A,f.B]);f.review();
  const family=()=>f.candidate().families.find(row=>row.familyId===f.target.id),item=()=>f.shop.familyView().items.find(row=>row.id===f.target.id),before=family();
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:before.registrationFingerprint,status:'excluded',familyIds:[f.target.id],familyFingerprints:{[f.target.id]:before.requirementsFingerprint},equivalenceEvidence:'The actual reviewed roast is explicitly excluded for this household family even though it belongs to the broad linked group.'});
  const plan=f.shop.sesumFamilies().find(row=>row.familyId===f.target.id),watch=f.shop.view().watches.find(row=>row.id===f.target.id);
  const legacy=createHash('sha256').update(JSON.stringify([plan.requirementsFingerprint,watch.note??null])).digest('hex').slice(0,24);
  const saved=f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id];saved.familyFingerprint=legacy;const original=structuredClone(saved);
  assert.notEqual(legacy,before.requirementsFingerprint);f.reload();
  const migrated=f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id];
  assert.deepEqual(migrated,{...original,familyFingerprint:before.requirementsFingerprint,legacyFamilyFingerprint:legacy},'only the fingerprint domain changes and the exact original basis remains recorded');
  assert.equal(family().sourceDecision.status,'excluded');assert.ok(!f.familyWork().some(row=>row.familyId===f.target.id));assert.equal(item().prices.current,60);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({price:18});f.link([f.A,f.B]);f.reload();
  assert.equal(family().requirementsFingerprint,before.requirementsFingerprint);assert.equal(family().sourceDecision.status,'excluded');assert.equal(item().prices.current,60);assert.equal(f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id].legacyFamilyFingerprint,legacy);
});

test('an approved source with an unbound old family exclusion stays held and pending until explicit current reopen',t=>{
  const f=setup(t);f.ingest();f.review();f.register();f.link([f.A,f.B]);f.review();
  const family=()=>f.candidate().families.find(row=>row.familyId===f.target.id),item=()=>f.shop.familyView().items.find(row=>row.id===f.target.id),before=family();
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:before.registrationFingerprint,status:'excluded',familyIds:[f.target.id],familyFingerprints:{[f.target.id]:before.requirementsFingerprint},equivalenceEvidence:'This actual reviewed roast remains excluded for the specific household use pending explicit current source review.'});
  f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id].registrationFingerprint=null;f.reload();
  assert.ok(f.candidate().registrationFingerprint);assert.equal(family().sourceDecision,null,'an unbound negative cannot masquerade as a current registered-product decision');
  assert.equal(family().familyReview.status,'pending');assert.ok(f.familyWork().some(row=>row.familyId===f.target.id));assert.equal(item().prices.current,60,'an upgrade must not silently restore an old excluded price');
  assert.equal(f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id].registrationFingerprint,null,'migration cannot invent missing product-review proof');
  const current=family();f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:current.registrationFingerprint,status:'reopen',familyIds:[f.target.id],familyFingerprints:{[f.target.id]:current.requirementsFingerprint},equivalenceEvidence:'Read the current registered source and actual household criteria and explicitly reopen the previous unbound family exclusion.'});
  assert.equal(item().prices.current,40);assert.equal(f.state.shopping.sesumFamilyReviews[SOURCE][f.target.id],undefined);f.reload();assert.equal(item().prices.current,40);
});

test('placement summaries enumerate every active source and exact-source reads never broaden the selection',t=>{
  const f=setup(t);f.ingest();
  f.shop.sesumReceivePrices({familyIds:[f.wrong.id],fetchedAt:NOW,products:[{...f.source,id:'73',sourceUrl:'https://www.sesum.no/produkt/73-another-public-source',prices:[{storeCode:'KIWI',price:21,observedAt:NOW,source:'actual_source_receipt',isPromo:false}]}]});
  const all=f.shop.sesumPlacement();assert.equal(all.total,2);assert.equal(all.items.length,2);assert.equal(all.hasMore,false);assert.equal(all.scope.mode,'all-active-sources');assert.ok(all.items.every(item=>item.source===undefined),'enumeration returns summaries, not every full product label');
  const exact=f.shop.sesumPlacement(SOURCE);assert.equal(exact.total,1);assert.equal(exact.items[0].sourceKey,SOURCE);assert.ok(exact.items[0].source);assert.equal(exact.scope.mode,'exact-source');assert.equal(exact.hasMore,false);
  assert.equal(f.shop.sesumPlacement('sesum:KIWI:7').total,0,'an unknown or partial identifier never returns a broader source selection');
});
