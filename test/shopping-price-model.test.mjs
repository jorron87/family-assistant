import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore} from '../src/shopping.mjs';

const NOW='2026-11-09T12:00:00Z';
function setup(){
 const state={},clock={at:NOW},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at)});
 shop.settings({stores:[{id:'a',name:'Chain A',chainCode:'CHAIN_A',url:'https://example.com/a',minSavings:0}]});
 const w=shop.watch({name:'Whole bean test coffee',unit:'kg',storage:'pantry',purchaseAmount:12,targetPrice:240,excellentPrice:160,priceGuide:{referencePrice:240,checkedAt:NOW,evidence:'Reviewed historical baseline'}});
 const observe=(price,extra={})=>{const r=shop.catalogObserve({watchId:w.id,products:[{store:'ODA_NO',id:'1',name:'Whole bean test coffee 225g',sourceUrl:'https://oda.com/no/products/123-test/',currentPrice:price,lastChecked:clock.at,...extra}]});return r.entries[0];};
 const approve=e=>shop.catalogReview({watchId:w.id,store:e.store,id:e.id,fingerprint:e.fingerprint,status:'approved',packAmount:.225,unit:'kg',equivalenceEvidence:'Reviewed roasted whole beans, same use and package'});
 const offer=()=>shop.offer({watchId:w.id,storeId:'a',externalId:'coffee',name:'Test coffee 250g',unit:'kg',price:42.9,packAmount:.25,validFrom:'2026-11-09',validTo:'2026-11-15',sourceUrl:'https://example.com/flyer',evidence:'Reviewed flyer, whole beans',comparisonNote:'Same reviewed use',comparable:true});
 return {shop,state,w,clock,observe,approve,offer};
}

test('a later cheaper SKU immediately caps campaigns, draft tiers, inventory and checklist without recalibration',()=>{
 const {shop,w,observe,approve,offer,clock}=setup();
 const {id}=offer();assert.equal(shop.familyView().deals[0].tier,'excellent');
 shop.list({action:'add',offerId:id,packs:1});
 clock.at='2026-11-09T12:01:00Z';approve(observe(38.9));
 const family=shop.familyView(),row=family.odaDraft.items[0],all=[...family.deals,...family.smallDeals,...family.belowTrip];
 assert.equal(family.deals.length,0);assert.equal(all[0].tier,'small');assert.ok(all[0].discountPct<1);assert.equal(all[0].referencePrice,172.89);
 assert.equal(row.unitPrice,172.89);assert.equal(row.packPrice,38.9);assert.equal(row.tier,'small');assert.ok(row.wanted<=5,'under8% must not recommend twelve months');
 assert.equal(family.items[0].prices.current,171.6);assert.equal(shop.checklist()[0].cheapestNow,171.6);
 assert.equal(family.items[0].prices.good,157.87);assert.equal(family.items[0].prices.excellent,157.87,'displayed guide thresholds include the same minimum saving as recommendations');
 assert.ok(family.list.open[0].saving<2,'the displayed list saving is recomputed too');
 clock.at='2026-11-09T12:02:00Z';observe(30);
 const updated=shop.familyView();assert.equal(updated.deals.length,0);assert.equal(updated.items[0].prices.current,133.33);assert.equal(updated.items[0].prices.currentChain,'Oda');
 assert.equal(updated.list.open[0].cheaper.storeName,'Oda');assert.equal(updated.list.open[0].saving,0);
 const cart=shop.cartReview({groups:[{items:[{product:{id:123,name:'Test coffee'},quantity:1,totalGrossAmount:'30'}]}],validationMessages:[]});assert.equal(cart.lines[0].unitPrice,133.33);
 assert.equal(updated.items[0].id,w.id);
});

test('arrival order is irrelevant and an expired/future/unknown price never wins or resurrects older data',()=>{
 const {shop,observe,approve,offer,clock}=setup();approve(observe(38.9));offer();
 assert.equal(shop.familyView().deals.length,0);
 clock.at='2026-11-09T12:01:00Z';observe(null);assert.equal(shop.familyView().items[0].prices.current,171.6);
 clock.at='2026-11-09T12:02:00Z';observe(1,{lastChecked:'2026-11-09T12:02:01Z'});assert.equal(shop.familyView().items[0].prices.current,171.6);
 clock.at='2026-11-12T12:00:00Z';assert.equal(shop.familyView().items[0].prices.current,null);assert.equal(shop.familyView().odaDraft.items.length,0);
});

test('pending or excluded native metadata cannot act as a global price',()=>{
 const {shop,observe,approve,offer,w}=setup();approve(observe(38.9));offer();
 const changed=observe(1,{ingredients:'Ground coffee; changed form'});
 assert.equal(changed.status,'pending');assert.equal(shop.familyView().items[0].prices.current,171.6);
 shop.catalogReview({watchId:w.id,store:'ODA_NO',id:'1',fingerprint:changed.fingerprint,status:'excluded',equivalenceEvidence:'Ground form does not meet whole-bean requirement'});
 assert.equal(shop.familyView().items[0].prices.current,171.6);
});

test('all approved chain quotes participate without a pre-existing historical calibration',()=>{
 const {shop,w,observe,approve,offer}=setup();approve(observe(38.9));offer();
 const e=shop.catalogObserve({watchId:w.id,products:[{store:'CHAIN_A',id:'2',name:'Test whole beans 1kg',currentPrice:100,lastChecked:NOW,sourceUrl:'https://example.com/beans'}]}).entries[0];
 shop.catalogReview({watchId:w.id,store:'CHAIN_A',id:'2',fingerprint:e.fingerprint,status:'approved',packAmount:1,unit:'kg',equivalenceEvidence:'Reviewed same whole-bean use'});
 assert.equal(shop.familyView().items[0].prices.current,100);assert.equal(shop.checklist()[0].chain,'Chain A');assert.equal(shop.familyView().deals.length,0);
});

test('fresh calibration snapshots cannot override newer native unknown prices or metadata decisions',()=>{
 const {shop,state,w,observe,approve,clock}=setup();approve(observe(38.9));
 const saved=state.shopping.watches[w.id];
 saved.marketCalibration={status:'ready',referencePrice:240,coverage:{observedDays:30,chainCount:1},products:[{id:'1',store:'ODA_NO',name:'Older beans',packAmount:.225,unit:'kg',lastChecked:NOW,currentUnitPrice:38.9/.225}]};
 clock.at='2026-11-09T12:01:00Z';observe(null);assert.equal(shop.familyView().items[0].prices.current,null);
 clock.at='2026-11-09T12:02:00Z';observe(35);assert.equal(shop.familyView().items[0].prices.current,155.56);
 observe(1,{ingredients:'Different ground form'});assert.equal(shop.familyView().items[0].prices.current,null);
});
