import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {groupMetadataFingerprint,productMetadataFingerprint} from '../src/product-library.mjs';

const NOW='2026-11-10T12:00:00Z',KEY=id=>'sesum:KIWI:'+id;
const definition=(id,name)=>({id,name,category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted coffee beans with actual complete ingredients and form evidence.',exclusions:['Ground coffee','Added flavourings'],qualityBasis:'Actual complete ingredient and fixed-package declaration',comparisonBasis:'Per kg'});
function fixture(t,count=512,terms=null,maxAge=null){
 const dir=mkdtempSync(join(tmpdir(),'sesum-stages-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'sesum-stages-')));rmSync(dir,{recursive:true,force:true});});
 const a=definition('baseline-beans','Baseline whole beans'),b=definition('new-bean-variant','New reviewed whole-bean variant');
 const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Baseline whole beans 500g',brand:'Baseline',ean:'12345678',ingredients:'Whole roasted coffee beans',description:'Synthetic reviewed original label',sourceUrl:'https://producer.example.test/baseline-beans',canonicalPackAmount:.5,unit:'kg',packEvidence:'Actual synthetic fixed 500g original bag.',rawPack:{weight:500,weightUnit:'g'},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
 const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[a],products:[p],memberships:[{groupId:a.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(a),equivalenceEvidence:'Read the actual plain whole-bean original ingredients and form.',qualityEvidence:'The full synthetic primary label was read.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Actual original whole-bean declaration and fixed bag.'}]}],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:NOW,sourceUrl:p.sourceUrl,availabilityScope:'chain'}]};
 const file=join(dir,'library.json');writeFileSync(file,JSON.stringify(data),'utf8');let state={},shop;const clock={at:NOW};
 const open=()=>shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),sesumResearchTerms:()=>terms,sesumResearchMaxPriceAgeHours:()=>maxAge,libraryPrices:libraryPriceProvider(file,{now:()=>new Date(clock.at)})});open();
 shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI synthetic',chainCode:'KIWI',url:'https://shop.example.test/kiwi'}]});
 const target=shop.watch({id:'whole-bean-need',name:'Plain whole coffee beans',unit:'kg',storage:'pantry',purchaseAmount:12});
 const link=(groups=[a])=>shop.libraryLink({familyId:target.id,evidence:'Explicit household choice of actual plain whole-bean variants.',variants:groups.map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Actual plain whole-bean contents and use satisfy this current need.'}))});link();
 for(let n=0;n<90;n++){
  const w=shop.watch({id:'unrelated-'+n,name:'Exact non-food liquid formula '+n,unit:'l',storage:'other',note:'Only the exact synthetic non-food detergent formula '+n+'; no food or cleaning brushes.'});
  shop.libraryLink({familyId:w.id,variants:[],evidence:'An own exact non-food formula, never food or brushes.'});
 }
 const familyIds=Object.keys(state.shopping.watches),sources=Array.from({length:count},(_,n)=>({id:String(n+100),name:n===1?'Synthetic dishwashing brush 500g':'Synthetic new whole beans '+n+' 500g',brand:'New',ean:null,weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/'+(n+100)+'-synthetic'}));
 for(let n=0;n<count;n+=500)shop.sesumReceivePrices({familyIds,fetchedAt:clock.at,products:sources.slice(n,n+500).map(p=>({...p,prices:[{storeCode:'KIWI',price:20,observedAt:NOW,source:'synthetic_actual_source_receipt',isPromo:false}]}))});
 const sourceWork=id=>shop.queue().filter(row=>row.sourceKey===KEY(id));
 const place=(id,{status='reviewed',retryAt,targets=[target.id]}={})=>{const c=shop.sesumPlacement(KEY(id)),row=c.items[0];return shop.sesumPriceReview({kind:'placement',sourceKey:row.sourceKey,sourceFingerprint:row.sourceFingerprint,registrationFingerprint:row.registrationFingerprint,familySetFingerprint:c.familySetFingerprint,status,evidence:'Actual synthetic primary form and whole-bean label read against all91 current enabled family requirements.',...(status==='blocked'?{reason:'The actual synthetic primary label remains unreadable; identity must not proceed.',retryAt}: {reviewedAllFamilies:true,scopeEvidence:'Read the actual whole-bean or brush form against all91 enabled definitions. The coffee need accepts plain whole beans; all90 exact non-food liquid formulas exclude food and brushes.',targets:targets.map(id=>({familyId:id,familyFingerprint:c.families.find(f=>f.familyId===id).familyFingerprint,equivalenceEvidence:'Actual plain whole roasted beans match this specific food research need, never an automatic price or variant approval.'})),...(status==='no-active-family'?{noActiveFamilyVerified:true,reason:'The actual cleaning brush is neither whole beans nor any exact non-food liquid formula.'}:{})})});};
 const register=id=>{const c=shop.sesumCandidates(undefined,KEY(id))[0];return shop.sesumRegister({sourceKey:c.sourceKey,sourceFingerprint:c.sourceFingerprint,identityEvidence:'Read the actual New-brand physical whole-bean variant and complete original label; no recipe is inferred from EAN or name.',product:{ingredients:'Whole roasted coffee beans',description:'Separately reviewed synthetic plain roast',brand:'New'},packAmount:.5,unit:'kg',packEvidence:'The actual primary bag explicitly documents one fixed500g net package.',groups:[b],memberships:[{groupId:b.id,groupFingerprint:groupMetadataFingerprint(b),equivalenceEvidence:'Actual full whole-bean recipe and form match this reviewed group; household linking remains separate.',qualityEvidence:'Actual complete original ingredients and form were read.'}],sourceReceipts:[{url:'https://producer.example.test/new-beans-'+id,observedAt:clock.at,evidence:'Read actual complete whole-bean ingredients, physical brand/variant and fixed500g label.'}]});};
 return {get shop(){return shop;},get state(){return state;},clock,a,b,target,sources,familyIds,sourceWork,place,register,link,reload(){state=JSON.parse(JSON.stringify(state));open();}};
}

test('512 new products with91 broad OR hints each create only their first placement stage without losing a source',t=>{
 const f=fixture(t),before=JSON.stringify(f.state),work=f.shop.queue().filter(row=>row.sourceKey?.startsWith('sesum:'));
 assert.equal(work.length,512);assert.equal(new Set(work.map(row=>row.sourceKey)).size,512);assert.ok(work.every(row=>row.do==='shopping-sesum-placement-review'));
 assert.equal(JSON.stringify(f.state),before,'stage routing never rewrites raw hints, prices or reviews');assert.equal(f.shop.sesumCandidates(undefined,KEY(100))[0].familyIds.length,91);
 assert.equal(f.shop.familyView().items.find(row=>row.id===f.target.id).prices.current,60,'existing approved prices remain eligible');
 f.reload();assert.equal(f.shop.queue().filter(row=>row.do==='shopping-sesum-placement-review').length,512);
});

test('blocked/no-family placement and its retry never duplicate a downstream identity stage',t=>{
 const f=fixture(t,3);f.place(100,{status:'blocked',retryAt:'2026-11-10T13:00:00Z'});f.place(101,{status:'no-active-family',targets:[]});
 assert.deepEqual(f.sourceWork(100),[]);assert.deepEqual(f.sourceWork(101),[]);assert.equal(f.shop.completion().blockedPlacements.length,1);assert.equal(f.sourceWork(102)[0].do,'shopping-sesum-placement-review');
 f.reload();assert.equal(f.shop.completion().blockedPlacements.length,1);f.clock.at='2026-11-10T13:00:01Z';assert.deepEqual(f.sourceWork(100).map(row=>row.do),['shopping-sesum-placement-review']);
});

test('positive placement alone routes identity to actual targets, then current registered facts precede new family work',t=>{
 const f=fixture(t,3);f.place(100);let work=f.sourceWork(100);assert.deepEqual(work.map(row=>row.do),['shopping-sesum-discovery']);assert.deepEqual(work[0].familyIds,[f.target.id]);assert.equal(work[0].rawFamilyIds.length,91);
 f.register(100);assert.deepEqual(f.sourceWork(100).map(row=>row.do),['shopping-sesum-placement-review']);assert.equal(f.shop.familyView().items.find(row=>row.id===f.target.id).prices.current,60);
 f.place(100);assert.deepEqual(f.sourceWork(100).map(row=>[row.do,row.familyId]),[['shopping-sesum-family-review',f.target.id]],'none of90 rejected raw hints creates another family task');
 f.link([f.a,f.b]);assert.equal(f.shop.familyView().items.find(row=>row.id===f.target.id).prices.current,40,'an explicit actual family link preserves its price despite renewed whole-set research');assert.ok(!f.sourceWork(100).some(row=>row.do==='shopping-sesum-family-review'));
});

test('an exact source detail filter preserves full export and never broadens to another chain or partial ID',t=>{
 const f=fixture(t,3),all=f.shop.sesumCandidates();assert.equal(all.length,3);assert.deepEqual(f.shop.sesumCandidates(undefined,KEY(100)),all.filter(row=>row.sourceKey===KEY(100)));
 for(const key of ['sesum:KIWI:10','sesum:REMA_1000:100','sesum:KIWI:100-extra','',{}])assert.deepEqual(f.shop.sesumCandidates(undefined,key),[]);
 assert.equal(f.shop.sesumCandidates().length,3);assert.equal(f.shop.queue().filter(row=>row.do==='shopping-sesum-placement-review').length,3);
});

 test('targeted routing preserves observations and groups only identical unregistered chain metadata',t=>{
 const terms={'whole-bean-need':['beans']};for(let n=0;n<90;n++)terms['unrelated-'+n]=['detergent'];
 const f=fixture(t,2,terms);f.shop.settings({stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi'},{id:'rema',name:'REMA',chainCode:'REMA_1000',url:'https://shop.example.test/rema'}]});
 f.shop.sesumReceivePrices({familyIds:f.familyIds,fetchedAt:NOW,products:[{...f.sources[0],prices:[{storeCode:'REMA_1000',price:21,observedAt:NOW,source:'actual_synthetic_receipt',isPromo:false}]}]});
 const before=JSON.stringify(f.state),tasks=f.shop.queue().filter(x=>x.do==='shopping-sesum-placement-review');assert.equal(tasks.length,2);assert.equal(tasks[0].sourceCount,2);assert.equal(tasks[0].relatedSources.length,1);assert.equal(JSON.stringify(f.state),before);
 assert.equal(f.shop.sesumPlacement().items.length,3);assert.equal(f.shop.completion().researchScope.lowerPriorityNameCandidates,1);assert.equal(f.shop.completion().researchScope.unaccountedSourceRows,0);
 });

test('price age ranks discovery without hiding unfinished work or inventing metadata approvals',t=>{
 const terms={'whole-bean-need':['beans']};for(let n=0;n<90;n++)terms['unrelated-'+n]=['detergent'];const f=fixture(t,1,terms,48);f.clock.at='2026-11-13T12:00:00Z';assert.equal(f.shop.queue().filter(x=>x.do==='shopping-sesum-placement-review').length,1);assert.equal(f.shop.completion().researchScope.awaitingCurrentPrice,1);assert.equal(f.shop.completion().complete,false);assert.equal(f.shop.completion().researchScope.unaccountedSourceRows,0);
 f.shop.sesumReceivePrices({familyIds:f.familyIds,fetchedAt:f.clock.at,products:[{...f.sources[0],prices:[{storeCode:'KIWI',price:20,observedAt:f.clock.at,source:'actual_new_receipt',isPromo:false}]}]});assert.equal(f.shop.queue().filter(x=>x.do==='shopping-sesum-placement-review').length,1);assert.equal(f.shop.sesumCandidates(undefined,KEY(100))[0].registration,null);
});

test('a followed identity candidate survives missing category words without acquiring any equivalence rights',t=>{
 const terms={'whole-bean-need':['beans']};for(let n=0;n<90;n++)terms['unrelated-'+n]=['detergent'];const f=fixture(t,0,terms,48);
 f.shop.sesumReceivePrices({familyIds:[f.target.id],fetchedAt:NOW,products:[{id:'999',name:'Opaque new brand 500g',ean:['12345678'],weight:500,weightUnit:'g',sourceUrl:'https://www.sesum.no/produkt/999-opaque',prices:[{storeCode:'KIWI',price:10,observedAt:NOW,source:'actual_synthetic_receipt',isPromo:false}]}]});
 const row=f.shop.sesumPlacement(KEY(999)).items[0];assert.equal(row.discoveryScope.candidate,true);assert.equal(row.discoveryScope.reviewedIdentityCandidate,true);assert.equal(row.status,'pending');assert.equal(row.registrationFingerprint,null);assert.equal(f.shop.familyView().items.find(x=>x.id===f.target.id).prices.current,60);assert.equal(f.shop.completion().researchScope.unaccountedSourceRows,0);
});
test('basis-specific placement history survives a reversible family edit but explicit reopen stays open',t=>{
 const f=fixture(t,2),w=f.state.shopping.watches['unrelated-0'],original=w.note;
 f.place(101,{status:'no-active-family',targets:[]});
 w.note='Changed exact synthetic detergent requirement, still excluding cleaning brushes.';
 f.place(101,{status:'no-active-family',targets:[]});w.note=original;
 assert.equal(f.shop.sesumPlacement(KEY(101)).items[0].status,'no-active-family');
 const c=f.shop.sesumPlacement(KEY(101)),r=c.items[0];
 f.shop.sesumPriceReview({kind:'placement',sourceKey:r.sourceKey,sourceFingerprint:r.sourceFingerprint,registrationFingerprint:r.registrationFingerprint,familySetFingerprint:c.familySetFingerprint,status:'reopen',evidence:'Explicitly reopen this actual synthetic relevance decision for fresh research.'});
 assert.equal(f.shop.sesumPlacement(KEY(101)).items[0].status,'pending');
 w.note='Changed exact synthetic detergent requirement, still excluding cleaning brushes.';f.place(101,{status:'no-active-family',targets:[]});w.note=original;
 assert.equal(f.shop.sesumPlacement(KEY(101)).items[0].status,'pending','a newer exact-basis reopen tombstone prevents resurrecting the previous result');
});
