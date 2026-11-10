import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {groupMetadataFingerprint,productMetadataFingerprint} from '../src/product-library.mjs';
import {changeSignal} from '../src/ingestion-dispatch.mjs';

const NOW='2026-11-10T12:00:00Z',STORE='synthetic-store';
function fixture(t,{withFamily=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shopping-flyer-review-')),file=path.join(dir,'library.json');
  t.after(()=>{const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('shopping-flyer-review-'))throw Error('Unexpected test directory.');fs.rmSync(resolved,{recursive:true,force:true});});
  const group=(id,name)=>({id,name,category:'Synthetic groceries',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted beans of the documented class.',exclusions:['Ground coffee','Added flavourings'],qualityBasis:'Read actual ingredients and whole-bean form.',comparisonBasis:'Per actual kg'});
  const a=group('plain-beans','Plain whole beans'),b=group('organic-beans','Organic whole beans');b.inclusionCriteria='Plain whole roasted beans with an explicit organic declaration.';
  const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Synthetic whole beans 500g',ean:'7000000000071',brand:'Synthetic',ingredients:'Whole roasted coffee beans',description:'The documented plain whole-bean roast.',canonicalPackAmount:.5,unit:'kg',rawPack:{weight:500,weightUnit:'g'},packEvidence:'Read one actual fixed 500g bag.',sourceUrl:'https://producer.example.test/label/71',attributes:{organic:true},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[a,b],products:[p],memberships:[{groupId:a.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(a),equivalenceEvidence:'Read the actual plain whole roasted bean ingredients and form.',qualityEvidence:'Original ingredient declaration, physical form and fixed consumer package read.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Read the actual original label and fixed package.'}]}],prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:'2026-11-10T11:00:00Z',sourceUrl:p.sourceUrl,availabilityScope:'chain'}]};
  let stamp=0;const write=()=>{fs.writeFileSync(file,JSON.stringify(data));const date=new Date(Date.UTC(2030,0,1)+1000*++stamp);fs.utimesSync(file,date,date);};write();
  const clock={at:NOW};let state={},shop;
  const open=()=>{const provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)});shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});};open();
  shop.settings({monitoringEnabled:true,stores:[{id:STORE,name:'Synthetic physical store',chainCode:'KIWI',url:'https://retailer.example.test/flyer',minSavings:0}]});
  const addFamily=(id='beans',extra={})=>shop.watch({id,name:'Plain whole coffee beans '+id,unit:'kg',storage:'pantry',purchaseAmount:10,stockAmount:2,note:'Plain whole roasted beans; no ground coffee or added flavours.',...extra});
  const link=(extra={},groups=[a])=>shop.libraryLink({familyId:'beans',evidence:'Current explicit household variant decision.',variants:groups.map(g=>({groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Read actual whole-bean contents, original form and current household criteria.',...extra}))});
  if(withFamily){addFamily();link();}
  const updateFamily=extra=>shop.watch({...state.shopping.watches.beans,...extra});
  const review=(extra={})=>shop.review({storeId:STORE,status:'ok',evidence:'Read every advertised page against all current enabled household families.',sourceUrl:'https://retailer.example.test/flyer',nextCheck:'2026-11-17',...extra});
  const work=()=>shop.queue().filter(row=>row.do==='shopping-review'&&row.storeId===STORE),store=()=>shop.familyView().stores.find(row=>row.id===STORE);
  return {get shop(){return shop;},get state(){return state;},clock,a,b,p,data,write,addFamily,link,updateFamily,review,work,store,reload(){state=JSON.parse(JSON.stringify(state));open();}};
}

test('an acknowledged flyer reopens for added, disabled and reenabled household families before its scheduled date',t=>{
  const f=fixture(t);f.review();assert.equal(f.work().length,0);assert.equal(f.store().status,'ok');assert.equal(f.shop.familyView().storesCheckedToday,1);
  const second=f.addFamily('second');assert.equal(f.work().length,1);assert.equal(f.store().status,'unchecked');assert.equal(f.store().requiresRescan,true);assert.equal(f.shop.familyView().storesCheckedToday,0);
  f.review();assert.equal(f.work().length,0);f.shop.watch({...second,enabled:false});assert.equal(f.work().length,1,'removing an enabled semantic need changes the reviewed scope');
  f.review();assert.equal(f.work().length,0);f.shop.watch({...second,enabled:true});assert.equal(f.work().length,1,'reenabling a need cannot reuse the intervening narrower receipt');
  f.review();f.reload();assert.equal(f.work().length,0);assert.equal(f.store().requiresRescan,false);assert.equal(f.store().status,'ok');
});

test('actual family criteria, variant choices and brand or attribute limits each require a new flyer review',t=>{
  const f=fixture(t),mutations=[
    ()=>f.updateFamily({note:'Only this explicitly selected plain organic roast is now acceptable.'}),
    ()=>f.link({},[f.a,f.b]),
    ()=>f.link({brands:['Synthetic']}),
    ()=>f.link({requires:['organic']}),
    ()=>f.link({excludeProductKeys:[f.p.productKey]}),
    ()=>{f.a.inclusionCriteria='A newly narrowed whole-bean ingredient and preparation requirement.';f.write();}
  ];
  for(const change of mutations){f.review();assert.equal(f.work().length,0);change();assert.equal(f.work().length,1);assert.equal(f.store().status,'unchecked');assert.equal(f.shop.familyView().storesCheckedToday,0);}
});

test('price receipts, stock, demand, quantities and equivalent review timestamps do not require rereading the same flyer',t=>{
  const f=fixture(t);const observed=f.shop.catalogObserve({watchId:'beans',products:[{id:f.p.id,store:f.p.store,name:f.p.name,brand:f.p.brand,ean:f.p.ean,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:'2026-11-10T11:00:00Z'}]}).entries[0];
  f.shop.catalogReview({watchId:'beans',id:observed.id,store:observed.store,fingerprint:observed.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Read the exact current plain whole-bean variant and fixed original package.'});
  const receipt=f.review();f.clock.at='2026-11-10T13:00:00Z';
  f.updateFamily({stockAmount:7,stockConfirmed:true,purchaseAmount:20,maxPacks:40,targetPrice:45,excellentPrice:35});f.link();
  f.data.prices[0].grossPackPrice=25;f.data.prices[0].receiptAt='2026-11-10T12:30:00Z';f.data.memberships[0].reviewedAt='2026-11-10T12:45:00Z';f.data.updatedAt=f.clock.at;f.write();
  f.shop.catalogObserve({watchId:'beans',products:[{id:f.p.id,store:f.p.store,name:f.p.name,brand:f.p.brand,ean:f.p.ean,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:24,lastChecked:'2026-11-10T12:40:00Z'}]});
  assert.equal(f.work().length,0);assert.equal(f.store().status,'ok');assert.equal(f.store().requiresRescan,false);assert.equal(f.shop.familyView().storesCheckedToday,1);
  assert.equal(f.state.shopping.reviews[STORE].checkedAt,receipt.checkedAt,'data refreshes must not invent a new actual flyer reading receipt');f.reload();assert.equal(f.work().length,0);
});

test('an old unstamped successful review remains stale until an actual review records the current semantic scope',t=>{
  const f=fixture(t);const receipt=f.review();assert.ok(receipt.familySetFingerprint,'the server stamps an opaque current scope on an actual reading');
  delete f.state.shopping.reviews[STORE].familySetFingerprint;const legacy=structuredClone(f.state.shopping.reviews[STORE]);f.reload();
  assert.equal(f.work().length,1);assert.equal(f.store().status,'unchecked');assert.equal(f.store().requiresRescan,true);assert.equal(f.shop.familyView().storesCheckedToday,0);
  assert.deepEqual(f.state.shopping.reviews[STORE],legacy,'reading stale legacy evidence cannot silently turn it into a new review');
  f.review();assert.equal(f.work().length,0);f.reload();assert.equal(f.work().length,0);assert.equal(f.store().status,'ok');
});

test('a caller cannot acknowledge a changed family set using a stale or forged scope fingerprint',t=>{
  const f=fixture(t),old=f.review();f.addFamily('new-need');const original=structuredClone(f.state.shopping.reviews[STORE]);assert.equal(f.work().length,1);
  for(const familySetFingerprint of [old.familySetFingerprint,'forged-family-scope']){
    assert.throws(()=>f.review({familySetFingerprint,evidence:'A mismatched caller scope cannot claim that the new household needs were read.'}));
    assert.deepEqual(f.state.shopping.reviews[STORE],original,'a rejected review must preserve the old actual evidence and scope atomically');assert.equal(f.work().length,1);
  }
  const current=f.work()[0].familySetFingerprint;assert.ok(f.shop.checklist().every(row=>row.familySetFingerprint===current),'the actual checklist and queued scope share the same review basis');
  const accepted=f.review({familySetFingerprint:current});assert.equal(accepted.familySetFingerprint,current);assert.equal(f.work().length,0);assert.equal(f.store().status,'ok');
});

test('a blocked flyer preserves its evidence and future retry when the family scope changes',t=>{
  const f=fixture(t);f.review({status:'blocked',evidence:'The selected current flyer is unavailable; no page was claimed read.',nextCheck:'2026-11-12'});
  const blocked=structuredClone(f.state.shopping.reviews[STORE]);assert.equal(f.store().status,'blocked');assert.equal(f.store().requiresRescan,false);assert.equal(f.work().length,0);
  f.addFamily('new-need');assert.equal(f.store().status,'blocked');assert.equal(f.store().requiresRescan,true);assert.equal(f.work().length,0,'a semantic mismatch cannot bypass a real source retry pause');
  assert.deepEqual(f.state.shopping.reviews[STORE],blocked);const completion=f.shop.completion();assert.equal(completion.complete,false);assert.equal(completion.blockedStores.length,1);assert.equal(completion.blockedStores[0].requiresRescan,true);assert.equal(f.shop.familyView().storesCheckedToday,0);
  f.clock.at='2026-11-12T12:00:00Z';const work=f.work();assert.equal(work.length,1);assert.equal(work[0].lastReview.status,'blocked');assert.equal(work[0].lastReview.evidence,blocked.evidence);assert.equal(work[0].lastReview.nextCheck,blocked.nextCheck);
  assert.ok(work[0].familySetFingerprint);assert.notEqual(work[0].familySetFingerprint,blocked.familySetFingerprint);assert.deepEqual(f.state.shopping.reviews[STORE],blocked,'queueing a due retry never rewrites the original blocker receipt');
});

test('an empty enabled family set is stable while disabled needs change, and enabling one reopens the flyer',t=>{
  const f=fixture(t,{withFamily:false});f.review();assert.equal(f.work().length,0);
  const disabled=f.addFamily('disabled',{enabled:false});assert.equal(f.work().length,0);f.shop.watch({...disabled,note:'Changed requirements for a still disabled household need.'});assert.equal(f.work().length,0);f.reload();assert.equal(f.work().length,0);
  f.shop.watch({...disabled,enabled:true});assert.equal(f.work().length,1);f.review();f.shop.watch({...disabled,enabled:false});assert.equal(f.work().length,1);f.review();f.reload();assert.equal(f.work().length,0);assert.equal(f.store().status,'ok');
});

test('monitoring stays opt-in even when a stored flyer receipt has an outdated family scope',t=>{
  const f=fixture(t);f.review();f.updateFamily({note:'A genuinely changed whole-bean variant requirement.'});assert.equal(f.work().length,1);
  f.shop.settings({monitoringEnabled:false});assert.deepEqual(f.shop.queue(),[]);assert.equal(f.store().status,'unchecked');assert.equal(f.shop.familyView().storesCheckedToday,0);
  f.shop.settings({monitoringEnabled:true});assert.equal(f.work().length,1);
});

test('changed flyer criteria wake dispatch at the same pending-store count without price or quantity churn',t=>{
  const f=fixture(t);f.review();
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:f.work}};
  assert.equal(changeSignal(store).signature,null);
  f.updateFamily({note:'Only the explicitly selected organic whole-bean class.'});const first=changeSignal(store);assert.equal(first.count,1);assert.equal(first.shoppingOnly,true);
  f.updateFamily({note:'A different actually reviewed whole-bean requirement.'});const changed=changeSignal(store);assert.equal(changed.count,1);assert.notEqual(changed.signature,first.signature);
  f.updateFamily({stockAmount:6,purchaseAmount:20,targetPrice:40});f.data.prices[0].grossPackPrice=26;f.data.prices[0].receiptAt='2026-11-10T11:30:00Z';f.write();assert.equal(changeSignal(store).signature,changed.signature);
  f.review();assert.equal(changeSignal(store).signature,null);
});
