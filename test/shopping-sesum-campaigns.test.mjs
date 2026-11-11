import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';
import {changeSignal} from '../src/ingestion-dispatch.mjs';

const NOW='2026-11-10T12:00:00Z',SOURCE='sesum:KIWI:71';
const PROMOTION={id:'synthetic-campaign',price:10,valid_from:'2026-11-09T00:00:00Z',valid_until:'2026-11-16T00:00:00Z',description:'A documented ordinary campaign'};
const termsEvidence={price:'The actual primary flyer announces 10 kroner per fixed 500g bag.',period:'The primary flyer announces 9 through 15 November inclusive.',membership:'The primary purchase terms state that membership is not required.',customerLimit:'All primary terms were read; no customer cap is announced.',bundle:'The actual announced price applies to one bag without a multibuy.',conditions:'All actual purchase conditions were read; no additional restrictions apply.'};
function setup(t){
  const dir=mkdtempSync(join(tmpdir(),'sesum-campaign-shopping-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const g={id:'whole-beans',name:'Whole coffee beans',category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted coffee beans',exclusions:['Ground coffee'],qualityBasis:'Same physical form and use',comparisonBasis:'Per kg'};
  const p={productKey:'kassal:KIWI:71',source:'kassal',store:'KIWI',id:'71',name:'Synthetic whole beans 500g',ean:'1234567890123',brand:'Synthetic',ingredients:'Whole roasted coffee beans',description:'Plain whole beans',sourceUrl:'https://producer.example.test/beans',canonicalPackAmount:.5,unit:'kg',packEvidence:'The actual original bag says 500g.',rawPack:{weight:500,weightUnit:'g'},attributes:{organic:true},nutrition:null};
  const alternative={...structuredClone(p),productKey:'kassal:COOP_EXTRA:72',store:'COOP_EXTRA',id:'72',name:'Other whole beans 500g',ean:'1234567890124',brand:'Other',sourceUrl:'https://producer.example.test/other-beans',attributes:{organic:false}};
  for(const product of [p,alternative])product.metadataFingerprint=productMetadataFingerprint(product);
  const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[g],products:[p,alternative],memberships:[p,alternative].map(product=>({groupId:g.id,productKey:product.productKey,status:'approved',reviewedFingerprint:product.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),equivalenceEvidence:'Actual whole roasted beans, same brewing use and documented package.',qualityEvidence:'Full original label read; brand differences retained.',reviewedAt:NOW,sourceReceipts:[{url:product.sourceUrl,observedAt:NOW,evidence:'Read the original ingredient declaration, form and 500g package.'}]})),prices:[{productKey:p.productKey,grossPackPrice:30,receiptAt:NOW,sourceUrl:p.sourceUrl,availabilityScope:'chain'},{productKey:alternative.productKey,grossPackPrice:35,receiptAt:NOW,sourceUrl:alternative.sourceUrl,availabilityScope:'chain'}]};
  const file=join(dir,'library.json');writeFileSync(file,JSON.stringify(data));
  const state={},clock={at:NOW},provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)}),shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi',minSavings:0},{id:'extra',name:'Extra',chainCode:'COOP_EXTRA',url:'https://shop.example.test/extra',minSavings:0}]});
  const w=shop.watch({id:'beans-followed',name:'Whole coffee beans',unit:'kg',storage:'pantry',purchaseAmount:10,stockAmount:1,targetPrice:50,excellentPrice:30,priceGuide:{referencePrice:80,checkedAt:NOW,evidence:'Conservative reviewed planning reference'}});
  const link=(extra={})=>shop.libraryLink({familyId:w.id,evidence:'Actual whole-bean use reviewed for this household family.',variants:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'All reviewed whole-bean variants match the household use.',...extra}]});link();
  const ingest=({price=30,observedAt=clock.at,promotion=PROMOTION,isPromo=false,familyIds=[w.id],productChanges={}}={})=>shop.sesumReceivePrices({familyIds,fetchedAt:clock.at,products:[{id:'71',name:p.name,brand:p.brand,ean:[p.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/71-synthetic-whole-beans-500g',...productChanges,prices:[{storeCode:'KIWI',price,observedAt,source:'actual_paid_receipt',isPromo,promotion:structuredClone(promotion)}]}]});
  const approve=(sourceKey=SOURCE)=>{const row=shop.sesumCandidates().find(row=>row.sourceKey===sourceKey),donor=row.donors.find(d=>d.productKey===p.productKey);return shop.sesumPriceReview({sourceKey:row.sourceKey,sourceFingerprint:row.sourceFingerprint,productKey:p.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'The actual bag GTIN, whole-bean form, brand and fixed package identify this reviewed physical variant.',packEvidence:'Both original fixed 500g package records were read.'});};
  const row=()=>shop.sesumOfferCandidates(w.id).items.find(row=>row.sourceKey===SOURCE);
  const primary=(extra={})=>({url:'https://cdn.example.test/primary-flyer',observedAt:clock.at,evidence:'Read the complete actual primary campaign price, announced days, package and purchase conditions.',...extra});
  const offer=(extra={})=>({storeId:'kiwi',externalId:'synthetic-campaign-offer',watchId:w.id,name:p.name,price:10,packAmount:.5,unit:'kg',validFrom:'2026-11-09',validTo:'2026-11-15',observedAt:clock.at,sourceUrl:'https://shop.example.test/primary-flyer',evidence:'Actual primary flyer: 10 kroner for one fixed 500g bag, 9 through 15 November.',comparisonNote:'The source variant has current reviewed membership of this household family.',conditions:'',memberOnly:false,maxPacks:null,bundlePacks:1,comparable:true,...extra});
  const review=(extra={})=>{const current=row();return shop.sesumOfferReview({sourceKey:current.sourceKey,sourceFingerprint:current.sourceFingerprint,familyId:current.familyId,familyFingerprint:current.familyFingerprint,campaignFingerprint:current.campaignFingerprint,status:'registered',offer:offer(),conditionsVerified:true,termsEvidence:structuredClone(termsEvidence),sourceReceipts:[primary()],evidence:'Read the actual primary flyer and verified all six campaign conditions for this physical variant.',...extra});};
  const work=()=>shop.queue().filter(item=>item.do==='shopping-sesum-offer-review');
  const signal=()=>changeSignal({snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:work}});
  const item=()=>shop.familyView().items.find(item=>item.id===w.id);
  return {state,clock,shop,w,p,g,alternative,data,provider,link,ingest,approve,row,primary,offer,review,work,signal,item};
}

test('an expiry resolution cannot close a known active campaign or invent an unknown final day',t=>{
  const f=setup(t);f.ingest();f.approve();
  const resolution={status:'not-actionable',reason:'expired',resolutionVerified:true,evidence:'The actual primary announced final day has passed.',sourceReceipts:[f.primary()]};
  assert.throws(()=>f.review(resolution),/ikke dokumentert utløpt/);assert.equal(f.work().length,1);
  f.ingest({promotion:{description:'The source does not state a final day.'}});
  assert.throws(()=>f.review(resolution),/resolvedValidTo/);assert.equal(f.work().length,1);
  f.review({...resolution,resolvedValidTo:'2026-11-09'});assert.equal(f.row().status,'not-actionable');
});

test('a nonnull promotion with a false flag queues only actual reviewed household families, independently of OR hints',t=>{
  const f=setup(t),unrelated=f.shop.watch({id:'honey',name:'Honey',unit:'kg',storage:'pantry'});
  f.ingest({familyIds:[unrelated.id]});assert.equal(f.work().length,0,'unapproved identity cannot approve a campaign');f.approve();
  assert.equal(f.work().length,1);assert.equal(f.work()[0].familyId,f.w.id,'actual family membership wins even without that search hint');
  assert.equal(f.shop.sesumOfferCandidates(unrelated.id).items.length,0,'an OR hint never establishes equivalence');
  assert.equal(f.row().receipt.isPromo,false);assert.ok(f.row().receipt.promotion);assert.equal(f.row().status,'pending');
  assert.equal(f.shop.queue().filter(item=>item.do==='shopping-sesum-review').length,0,'campaign conditions do not reopen unchanged product identity');
});

test('brand, required attributes and explicit donor/source exclusions constrain campaign family eligibility',t=>{
  const f=setup(t);f.ingest();f.approve();assert.equal(f.work().length,1);
  f.link({brands:['Other']});assert.equal(f.work().length,0);
  f.link({requires:['glutenFree']});assert.equal(f.work().length,0);
  f.link({requires:['organic']});assert.equal(f.work().length,1);
  f.link({excludeProductKeys:[f.p.productKey]});assert.equal(f.work().length,0,'a reviewed alias cannot bypass exclusion of its physical native donor');
  f.link({excludeProductKeys:[SOURCE]});assert.equal(f.work().length,0);
});

test('campaign review shares bounded read snapshots across many families while retaining every exclusion hold',t=>{
 const f=setup(t);f.ingest();f.approve();
 for(let i=0;i<90;i++){const w=f.shop.watch({id:'synthetic-unrelated-'+i,name:'Synthetic unrelated family '+i,unit:'kg',storage:'pantry'});(f.state.shopping.sesumFamilyReviews[SOURCE]??={})[w.id]={status:'excluded',holdExcluded:true,reason:'Synthetic explicit exclusion of this actual source from this unrelated family.'};}
 const original=f.provider.reader;let reads=0;f.provider.reader=(...args)=>{reads++;return original(...args);};
 f.review();const used=reads;assert.ok(used<=2,'campaign lookup and review must each share one current snapshot, actual reads='+used);
 assert.equal(f.row().status,'registered');assert.equal(f.shop.sesumOfferCandidates().items.length,1);assert.equal(Object.keys(f.state.shopping.sesumFamilyReviews[SOURCE]).length,90);
});

test('registration is atomic, idempotent and separate from the held source receipt',t=>{
  const f=setup(t);f.ingest();f.approve();const stock=structuredClone(f.state.shopping.watches[f.w.id]),beforePurchases=structuredClone(f.state.shopping.purchases);
  const result=f.review();assert.ok(result.offerId);assert.equal(Object.keys(f.state.shopping.offers).length,1);assert.equal(f.row().status,'registered');assert.equal(f.work().length,0);
  assert.equal(f.item().prices.current,20);assert.ok(f.shop.familyView().deals.some(deal=>deal.offerId===result.offerId));assert.ok(f.shop.view().opportunities.some(deal=>deal.id===result.offerId));
  assert.ok(f.shop.explorer.family(f.g.id).family.offers.some(offer=>offer.id===result.offerId));
  assert.equal(f.state.shopping.offers[result.offerId].sourceUrl,'https://shop.example.test/primary-flyer','primary campaign URLs need not be the aggregator URL');
  const source=f.shop.sesumCandidates().find(source=>source.sourceKey===SOURCE);assert.equal(source.status,'approved');assert.ok(source.price.reasons.includes('unverified-promotion-conditions'));
  assert.equal(f.shop.explorer.family(f.g.id).family.members.find(member=>member.key===SOURCE).unitPrice,null,'campaign acknowledgement never makes the source receipt an ordinary chain price');
  assert.equal(f.review().offerId,result.offerId);assert.equal(Object.keys(f.state.shopping.offers).length,1);
  assert.equal(f.state.shopping.watches[f.w.id].stockAmount,stock.stockAmount);assert.equal(f.state.shopping.watches[f.w.id].stockCheckedAt,stock.stockCheckedAt);assert.equal(f.state.shopping.watches[f.w.id].purchaseAmount,stock.purchaseAmount);assert.deepEqual(f.state.shopping.purchases,beforePurchases);
});

test('a raw Sesum offer cannot bypass conditions review, including previously stored unbound offers',t=>{
  const f=setup(t);f.ingest();f.approve();
  const input=f.offer({sourceUrl:'https://www.sesum.no/produkt/71-synthetic-whole-beans-500g'});
  assert.throws(()=>f.shop.offer(input),/shopping-sesum-offer-review/);assert.equal(Object.keys(f.state.shopping.offers).length,0);
  const ordinary=f.shop.offer(f.offer());
  f.state.shopping.offers[ordinary.id].sourceUrl=input.sourceUrl;
  assert.equal(f.shop.familyView().deals.some(d=>d.offerId===ordinary.id),false);assert.equal(f.item().prices.current,70);
});

test('a trailing-dot Sesum hostname still requires campaign review and never becomes primary evidence',t=>{
  const f=setup(t);f.ingest();f.approve();
  const sourceUrl='https://www.sesum.no./produkt/71-synthetic-whole-beans-500g';
  assert.throws(()=>f.shop.offer(f.offer({sourceUrl})),/shopping-sesum-offer-review/);
  const ordinary=f.shop.offer(f.offer());f.state.shopping.offers[ordinary.id].sourceUrl=sourceUrl;
  assert.equal(f.shop.familyView().deals.some(row=>row.offerId===ordinary.id),false);assert.equal(f.item().prices.current,70);
  assert.throws(()=>f.review({sourceReceipts:[f.primary({url:sourceUrl})]}),/primary|prim/i);
  assert.throws(()=>f.review({offer:undefined,status:'not-actionable',reason:'not-a-real-offer',resolutionVerified:true,sourceReceipts:[f.primary({url:sourceUrl})]}),/prim/i);
});

test('first source binding of an unchanged declined or bought ordinary offer preserves the household decision',t=>{
  for(const action of ['snooze','bought']){
    const f=setup(t);f.ingest();f.approve();const ordinary=f.shop.offer(f.offer());
    f.shop.dealAction({offerId:ordinary.id,action,packs:1});
    const decision=structuredClone(f.state.shopping.dealDecisions[ordinary.id]),purchases=structuredClone(f.state.shopping.purchases),watch=structuredClone(f.state.shopping.watches[f.w.id]);
    const result=f.review({offer:undefined,offerId:ordinary.id});assert.equal(result.offerId,ordinary.id);
    const bound=structuredClone(f.state.shopping.dealDecisions[ordinary.id]);
    assert.notEqual(bound.fingerprint,decision.fingerprint);assert.deepEqual({...bound,fingerprint:decision.fingerprint},decision);
    assert.equal(f.shop.familyView().deals.some(d=>d.offerId===ordinary.id),false);
    assert.deepEqual(f.state.shopping.purchases,purchases);assert.deepEqual(f.state.shopping.watches[f.w.id],watch);
    f.review({offer:undefined,offerId:ordinary.id});assert.deepEqual(f.state.shopping.dealDecisions[ordinary.id],bound);
    assert.deepEqual(f.state.shopping.purchases,purchases);assert.deepEqual(f.state.shopping.watches[f.w.id],watch);
  }
});

test('another approved source cannot steal an existing campaign offer or its household decision',t=>{
  const f=setup(t);f.ingest();f.approve();const result=f.review();
  f.shop.dealAction({offerId:result.offerId,action:'snooze'});
  const second='sesum:KIWI:73';
  f.ingest({productChanges:{id:'73',sourceUrl:'https://www.sesum.no/produkt/73-another-source-record'}});f.approve(second);
  const row=f.shop.sesumOfferCandidates(f.w.id).items.find(row=>row.sourceKey===second);
  const input={sourceKey:row.sourceKey,sourceFingerprint:row.sourceFingerprint,familyFingerprint:row.familyFingerprint,campaignFingerprint:row.campaignFingerprint};
  const before=structuredClone(f.state.shopping);
  assert.throws(()=>f.review({...input,offer:undefined,offerId:result.offerId}),/allerede bundet/);
  assert.throws(()=>f.review({...input,offer:f.offer()}),/allerede bundet/);
  assert.deepEqual(f.state.shopping,before,'failed rebinding leaves the original review, offer, decisions and purchases untouched');
  assert.equal(f.row().status,'registered');

  // A legacy inconsistent claim must not settle the original source merely
  // because its offer now happens to have a valid review for another source.
  const original=f.state.shopping.sesumOfferReviews[SOURCE+'\0'+f.w.id];
  f.state.shopping.sesumOfferReviews[second+'\0'+f.w.id]={...structuredClone(original),...input};
  f.state.shopping.offers[result.offerId].sesumCampaign={...input};
  assert.equal(f.shop.sesumOfferCandidates(f.w.id).items.find(row=>row.sourceKey===second).status,'registered');
  assert.equal(f.row().status,'pending');
});

test('ordinary sources enter campaign review when terms appear and linked offers remain held when terms disappear',t=>{
  const f=setup(t);f.ingest({promotion:null,isPromo:false});f.approve();
  assert.equal(f.shop.sesumOfferCandidates(f.w.id).items.length,0);assert.equal(f.work().length,0);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest();assert.equal(f.work().length,1);
  const result=f.review();assert.equal(f.row().status,'registered');assert.equal(f.item().prices.current,20);
  f.clock.at='2026-11-10T12:02:00Z';f.ingest({promotion:null,isPromo:false});
  assert.equal(f.row().status,'pending','an existing claim keeps the source in the resolver after campaign removal');
  assert.equal(f.work().length,1);assert.equal(f.shop.familyView().deals.some(deal=>deal.offerId===result.offerId),false);
  assert.equal(f.item().prices.current,60,'the new ordinary source receipt is usable, but the old 10 kroner campaign is held');
});

test('campaign and offer changes wake the same-count queue without treating receipt/fetch dates as new terms',t=>{
  const f=setup(t);f.ingest();f.approve();const first=f.signal(),fingerprint=f.row().campaignFingerprint;
  f.clock.at='2026-11-10T12:01:00Z';f.ingest();assert.equal(f.row().campaignFingerprint,fingerprint);assert.equal(f.signal().signature,first.signature);
  f.clock.at='2026-11-10T12:02:00Z';f.ingest({promotion:{...PROMOTION,description:'A materially changed campaign condition'}});
  assert.equal(f.signal().count,first.count);assert.notEqual(f.signal().signature,first.signature);const changed=f.signal();
  f.clock.at='2026-11-10T12:03:00Z';f.ingest({price:31,promotion:{...PROMOTION,description:'A materially changed campaign condition'}});assert.equal(f.signal().count,changed.count);assert.notEqual(f.signal().signature,changed.signature);
  assert.equal(f.shop.sesumCandidates().find(source=>source.sourceKey===SOURCE).status,'approved');
});

test('a material source campaign change immediately holds the old offer across prices, deals, explorer and open lists',t=>{
  const f=setup(t);f.ingest();f.approve();const result=f.review(),line=f.shop.list({action:'add',offerId:result.offerId,packs:2});assert.equal(f.item().prices.current,20);
  const beforeStock=f.state.shopping.watches[f.w.id].stockAmount,beforePurchases=structuredClone(f.state.shopping.purchases);
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({promotion:{...PROMOTION,price:11,description:'New price and revised conditions'}});
  const family=f.shop.familyView();assert.equal(f.row().status,'pending');assert.equal(f.item().prices.current,70,'only the independent Extra alternative remains actionable');
  assert.equal(f.shop.checklist().find(item=>item.watchId===f.w.id).cheapestNow,70);
  assert.ok(![...family.deals,...family.smallDeals,...family.belowTrip,...family.covered].some(deal=>deal.offerId===result.offerId));assert.ok(!f.shop.view().opportunities.some(deal=>deal.id===result.offerId));
  assert.ok(!f.shop.explorer.family(f.g.id).family.offers.some(offer=>offer.id===result.offerId));
  const open=family.list.open.find(item=>item.id===line.id);assert.equal(open.packs,2);assert.equal(open.unitPrice,null);assert.equal(open.saving,null);assert.ok(open.offerHeldReason);assert.deepEqual(open.others,[]);
  assert.throws(()=>f.shop.list({action:'add',offerId:result.offerId,packs:1}),/vilkår/);
  assert.equal(f.state.shopping.watches[f.w.id].stockAmount,beforeStock);assert.deepEqual(f.state.shopping.purchases,beforePurchases);
});

test('all current fingerprints and exact offer facts are checked before a nested offer can be stored',t=>{
  const f=setup(t);f.ingest();f.approve();
  for(const key of ['sourceFingerprint','familyFingerprint','campaignFingerprint'])assert.throws(()=>f.review({[key]:'b'.repeat(64)}));
  for(const extra of [{storeId:'extra'},{packAmount:.4},{unit:'l'},{price:9},{validTo:'2026-11-16'}])assert.throws(()=>f.review({offer:f.offer(extra)}));
  assert.throws(()=>f.review({conditionsVerified:false}));assert.throws(()=>f.review({sourceReceipts:[f.primary({url:'https://www.sesum.no/produkt/71-synthetic'})]}));
  assert.throws(()=>f.review({sourceReceipts:[f.primary({observedAt:'2026-11-08T10:00:00Z'})]}));
  assert.equal(Object.keys(f.state.shopping.offers).length,0,'failed validation cannot leave a partially registered actionable offer');assert.equal(Object.keys(f.state.shopping.sesumOfferReviews).length,0);
});

test('membership and multibuy requirements remain explicit and cannot be dropped during acknowledgement',t=>{
  const f=setup(t);f.ingest({promotion:{...PROMOTION,member_only:true,multi_buy_quantity:2,multi_buy_price:20,customer_limit:4}});f.approve();
  assert.throws(()=>f.review());
  assert.throws(()=>f.review({offer:f.offer({memberOnly:true,conditions:'Membership required.'})}));
  assert.throws(()=>f.review({offer:f.offer({memberOnly:true,bundlePacks:2,maxPacks:5,conditions:'Membership and two bags required.'})}));
  const result=f.review({offer:f.offer({memberOnly:true,bundlePacks:2,maxPacks:4,conditions:'Membership required; two bags for 20 kroner, maximum four per customer.'})});
  assert.equal(f.row().status,'registered');assert.equal(f.state.shopping.offers[result.offerId].memberOnly,true);assert.equal(f.state.shopping.offers[result.offerId].bundlePacks,2);assert.equal(f.state.shopping.offers[result.offerId].maxPacks,4);
  assert.notEqual(f.item().prices.current,20,'known conditions do not grant the household an unconfigured membership');
});

test('existing ordinary offer IDs can be bound, but later material edits invalidate the acknowledgement',t=>{
  const f=setup(t);f.ingest();f.approve();const ordinary=f.shop.offer(f.offer()),input={offer:undefined,offerId:ordinary.id};
  const result=f.review(input);assert.equal(result.offerId,ordinary.id);assert.equal(f.row().status,'registered');
  f.shop.offer({...f.state.shopping.offers[ordinary.id],price:9,evidence:'A different claim requires a new conditions review.'});
  assert.equal(f.row().status,'pending');assert.equal(f.item().prices.current,70);assert.ok(f.work().length);
});

test('native catalogue exclusion immediately revokes a registered source campaign without deleting its review',t=>{
  const f=setup(t);f.ingest();f.approve();const result=f.review();
  const entry=f.shop.catalogObserve({watchId:f.w.id,products:[{id:f.p.id,store:f.p.store,name:f.p.name,ean:f.p.ean,brand:f.p.brand,ingredients:f.p.ingredients,description:f.p.description,sourceUrl:f.p.sourceUrl,weight:500,weightUnit:'g',currentPrice:30,lastChecked:f.clock.at}]}).entries[0];
  f.shop.catalogReview({watchId:f.w.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'excluded',equivalenceEvidence:'The household explicitly excludes this concrete physical variant.'});
  assert.equal(f.row(),undefined);assert.ok(f.state.shopping.offers[result.offerId]);assert.equal(f.item().prices.current,70);assert.ok(!f.shop.explorer.family(f.g.id).family.offers.some(offer=>offer.id===result.offerId));
});

test('a future blocked retry leaves active dispatch work quiet while completion reports the unresolved campaign',t=>{
  const f=setup(t);f.ingest();f.approve();
  f.review({status:'blocked',offer:undefined,reason:'The primary customer limit is not yet documented.',retryAt:'2026-11-10T13:00:00Z'});
  assert.equal(f.row().status,'blocked');assert.equal(f.work().length,0);assert.equal(f.shop.completion().complete,false);assert.ok(f.shop.completion().blockedCampaigns.some(item=>item.sourceKey===SOURCE));
  f.clock.at='2026-11-10T13:00:01Z';assert.equal(f.work().length,1);assert.equal(Object.keys(f.state.shopping.offers).length,0);
});

test('a concrete not-actionable decision is campaign-specific and never excludes the physical SKU',t=>{
  const f=setup(t);f.ingest();f.approve();assert.throws(()=>f.review({status:'not-actionable',offer:undefined,reason:'not-a-real-offer',resolutionVerified:false}));
  f.review({status:'not-actionable',offer:undefined,reason:'not-a-real-offer',resolutionVerified:true,evidence:'The actual primary announcement proves this aggregator entry is not an announced campaign.'});
  assert.equal(f.row().status,'not-actionable');assert.equal(f.work().length,0);assert.equal(f.shop.sesumCandidates().find(source=>source.sourceKey===SOURCE).status,'approved');
  f.clock.at='2026-11-10T12:01:00Z';f.ingest({promotion:{...PROMOTION,id:'new-actual-campaign'}});assert.equal(f.work().length,1);
});

test('fresh source timestamps cannot renew stale primary proof, while an actual same-terms primary reread can',t=>{
  const f=setup(t);f.ingest();f.approve();const result=f.review(),oldCampaign=f.row().campaignFingerprint,oldAck=structuredClone(f.row().review);
  f.clock.at='2026-11-12T13:00:00Z';f.ingest();assert.equal(f.row().campaignFingerprint,oldCampaign);assert.equal(f.row().status,'pending');assert.notEqual(f.item().prices.current,20);
  const stored=structuredClone(f.state.shopping.offers[result.offerId]);
  assert.throws(()=>f.shop.offer({...stored,observedAt:f.clock.at,evidence:'Only the saved source timestamp was changed.'}),/prim|proof|kilde/i);
  assert.throws(()=>f.shop.offer({...stored,observedAt:f.clock.at,sourceReceipt:f.primary({url:stored.sourceUrl,observedAt:NOW})}),/prim|proof|kilde|fersk|fresh/i);
  f.shop.offer({...stored,observedAt:f.clock.at,sourceReceipt:f.primary({url:stored.sourceUrl}),evidence:'The actual primary flyer was reread; price and all material conditions are unchanged.'});
  assert.equal(f.row().status,'registered');assert.equal(f.work().length,0);assert.equal(f.item().prices.current,20);assert.deepEqual(f.row().review,oldAck,'same-terms primary freshness is a new actual read, not a repeated conditions decision');
});

test('campaign lifecycle changes never rewrite earlier actual purchases or counted stock',t=>{
  const f=setup(t),earlier=f.shop.offer(f.offer({storeId:'extra',externalId:'earlier-purchase',price:20,validTo:'2026-11-10'}));f.shop.dealAction({offerId:earlier.id,action:'bought',packs:1});
  const purchases=structuredClone(f.state.shopping.purchases),stock={amount:f.state.shopping.watches[f.w.id].stockAmount,at:f.state.shopping.watches[f.w.id].stockCheckedAt};
  f.clock.at='2026-11-11T12:00:00Z';f.ingest();f.approve();f.review();f.clock.at='2026-11-11T12:01:00Z';f.ingest({promotion:{...PROMOTION,price:11}});
  assert.deepEqual(f.state.shopping.purchases,purchases);assert.equal(f.state.shopping.watches[f.w.id].stockAmount,stock.amount);assert.equal(f.state.shopping.watches[f.w.id].stockCheckedAt,stock.at);
});

test('an explicitly verified last-second campaign registers an ordinary final-day offer and preserves its review across restart',t=>{
  const f=setup(t);f.ingest({promotion:{...PROMOTION,valid_until:'2026-11-15T22:59:59Z'}});f.approve();
  const before=structuredClone(f.state.shopping);assert.throws(()=>f.review(),/period/);assert.deepEqual(f.state.shopping,before,'omitting the new explicit proof keeps the conservative final-day rejection atomic');
  const result=f.review({inclusiveEndOfDayVerified:true});assert.equal(result.inclusiveEndOfDayVerified,true);assert.equal(f.row().status,'registered');assert.equal(f.work().length,0);
  const stored=f.state.shopping.offers[result.offerId],review=f.state.shopping.sesumOfferReviews[SOURCE+'\0'+f.w.id];
  assert.equal(stored.validFrom,'2026-11-09');assert.equal(stored.validTo,'2026-11-15');assert.equal(stored.price,10);assert.equal(stored.packAmount,.5);assert.equal(review.inclusiveEndOfDayVerified,true);assert.equal(f.item().prices.current,20);
  assert.ok(f.shop.sesumCandidates().find(row=>row.sourceKey===SOURCE).price.reasons.includes('unverified-promotion-conditions'),'the campaign review never reclassifies its paid source receipt as an ordinary current price');
  const saved=JSON.parse(JSON.stringify(f.state)),restarted=shoppingStore(saved,{save(){},now:()=>new Date(f.clock.at),libraryPrices:f.provider});
  assert.equal(restarted.sesumOfferCandidates(f.w.id).items.find(row=>row.sourceKey===SOURCE).status,'registered');assert.equal(saved.shopping.sesumOfferReviews[SOURCE+'\0'+f.w.id].inclusiveEndOfDayVerified,true);assert.equal(saved.shopping.offers[result.offerId].validTo,'2026-11-15');
  assert.equal(restarted.familyView().items.find(row=>row.id===f.w.id).prices.current,20);assert.equal(saved.shopping.watches[f.w.id].stockAmount,before.watches[f.w.id].stockAmount);assert.deepEqual(saved.shopping.purchases,before.purchases);
});

test('invalid inclusive reviews cannot create an ordinary offer or partial acknowledgement',t=>{
  const cases=[
    {flag:false},{flag:'true'},{flag:null},{flag:1},
    {flag:true,end:'2026-11-16T00:00:00Z'},
    {flag:true,end:'2026-11-15T12:00:00Z'},
    {flag:true,end:'2026-11-15T22:59:58Z'},
    {flag:true,end:'2026-11-15T22:59:59.0000001Z'},
    {flag:true,end:'2026-11-15'},
    {flag:true,noEnd:true},
    {flag:true,conflictingAlias:'2026-11-16'}
  ];
  for(const c of cases){
    const f=setup(t),promotion={...PROMOTION,valid_until:c.end??'2026-11-15T22:59:59Z'};if(c.noEnd)delete promotion.valid_until;if(c.conflictingAlias)promotion.endsAt=c.conflictingAlias;
    f.ingest({promotion});f.approve();const before=structuredClone(f.state.shopping);
    assert.throws(()=>f.review({inclusiveEndOfDayVerified:c.flag}),JSON.stringify(c));
    assert.equal(Object.keys(f.state.shopping.offers).length,0);assert.equal(Object.keys(f.state.shopping.sesumOfferReviews).length,0);assert.deepEqual(f.state.shopping,before,'failed inclusive proof leaves offers, acknowledgements, purchases and stock unchanged');assert.equal(f.row().status,'pending');
  }
});

test('the explicit final-second review still requires actual primary terms before an offer is committed',t=>{
  for(const change of [
    f=>({conditionsVerified:false}),
    f=>({termsEvidence:{...termsEvidence,period:''}}),
    f=>({sourceReceipts:[f.primary({url:'https://www.sesum.no/produkt/71-synthetic-whole-beans-500g'})]}),
    f=>({sourceReceipts:[f.primary({observedAt:'2026-11-08T11:00:00Z'})]})
  ]){
    const f=setup(t);f.ingest({promotion:{...PROMOTION,valid_until:'2026-11-15T22:59:59Z'}});f.approve();const before=structuredClone(f.state.shopping);
    assert.throws(()=>f.review({inclusiveEndOfDayVerified:true,...change(f)}));assert.deepEqual(f.state.shopping,before);assert.equal(Object.keys(f.state.shopping.offers).length,0);assert.equal(f.row().status,'pending');
  }
});
