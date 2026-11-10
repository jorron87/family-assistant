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
function setup(t,{sourceName='New organic whole beans 500g'}={}){
  const dir=mkdtempSync(join(tmpdir(),'sesum-placement-'));t.after(()=>{if(!resolve(dir).startsWith(resolve(tmpdir(),'sesum-placement-')))throw Error('Unsafe test cleanup.');rmSync(dir,{recursive:true,force:true});});
  const A=definition('baseline-beans','Baseline organic whole beans'),B=definition('new-beans','New organic whole-bean variants');
  const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Baseline organic whole beans 500g',brand:'Baseline',ean:'1234567890123',ingredients:'Organic whole roasted coffee beans',description:'A reviewed plain organic roast',sourceUrl:'https://producer.example.test/baseline',canonicalPackAmount:.5,unit:'kg',packEvidence:'Read one actual fixed 500g bag.',rawPack:{weight:500,weightUnit:'g'},attributes:{organic:true},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[A],products:[p],memberships:[{groupId:A.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(A),equivalenceEvidence:'The actual plain organic whole beans match this group and brewing use.',qualityEvidence:'Read the full actual original ingredient declaration, form and organic label.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Read the original label and fixed 500g package.'}]}],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:NOW,availabilityScope:'chain',sourceUrl:p.sourceUrl}]};
  const file=join(dir,'library.json'),write=()=>writeFileSync(file,JSON.stringify(data));write();
  let state={},shop;const clock={at:NOW};
  const open=()=>{const provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)});shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});};open();
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
  f.register();assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));assert.equal(f.row().status,'pending','new researched metadata reopens the finite placement receipt');assert.ok(f.row().researchedFamilyIds.includes(f.target.id),'the valid researched target remains a hint while the full receipt is refreshed');
  assert.equal(f.shop.familyView().items.find(item=>item.id===f.target.id).prices.current,60,'a new registered group cannot approve an already built household family');
  f.review();f.link([f.A,f.B]);assert.ok(!f.familyWork().some(item=>item.familyId===f.target.id));assert.equal(f.shop.familyView().items.find(item=>item.id===f.target.id).prices.current,40);
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
    if(change==='registration'){assert.equal(f.placement().familySetFingerprint,set);assert.ok(f.row().researchedFamilyIds.includes(f.target.id),'a researched association is not lost merely because its source metadata review advanced');assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));}
    else assert.notEqual(f.placement().familySetFingerprint,set);
  }
});

test('a scoped wrong-search-family negative never hides all-family placement or its unhinted correct target',t=>{
  const f=setup(t);f.ingest();const wrong=f.candidate().families.find(item=>item.familyId===f.wrong.id);
  f.shop.sesumPriceReview({sourceKey:SOURCE,sourceFingerprint:f.candidate().sourceFingerprint,registrationFingerprint:null,status:'excluded',familyIds:[f.wrong.id],familyFingerprints:{[f.wrong.id]:wrong.requirementsFingerprint},equivalenceEvidence:'The actual source contains organic whole roasted coffee beans, no honey; only the honey hint is excluded.'});
  assert.equal(f.work().length,1);f.review();assert.ok(f.candidate().effectiveFamilyIds.includes(f.target.id));assert.deepEqual(f.candidate().familyIds,[f.wrong.id]);
  assert.ok(f.shop.queue().some(item=>['shopping-sesum-discovery','shopping-sesum-review'].includes(item.do)&&item.sourceKey===SOURCE&&item.familyIds.includes(f.target.id)));
  f.register();assert.ok(f.familyWork().some(item=>item.familyId===f.target.id));
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
