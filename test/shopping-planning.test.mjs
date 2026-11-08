import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore} from '../src/shopping.mjs';
import {annualNeed,dealTier,defaultShelfLifeMonths,estimateStock} from '../src/shopping-planning.mjs';

const NOW='2026-11-08T12:00:00Z';
function setup(at=NOW) {
 const state={},clock={at},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at)});
 shop.settings({historyFrom:'2025-11-08',stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/near',minSavings:0,chainCode:'NEAR'}]});
 return {state,shop,clock};
}
const history=(price=100)=>Array.from({length:30},(_,i)=>({date:new Date(Date.parse('2026-10-10T10:00:00Z')+i*86400000).toISOString(),price}));
const offer=(watchId,extra={})=>({watchId,storeId:'near',externalId:'o1',name:'Vare',price:70,packAmount:1,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'Avisside',comparable:true,comparisonNote:'Tilsvarende',...extra});
const watch=(shop,extra={})=>shop.watch({name:'Mel',unit:'kg',storage:'pantry',targetPrice:100,maxPacks:100,purchaseAmount:12,...extra});
const best=shop=>shop.view().opportunities[0];

test('an excellent deal targets a full year, limited by the product shelf life',()=>{
 const {shop}=setup();
 const flour=watch(shop);shop.offer(offer(flour.id));
 assert.equal(best(shop).packs,12);assert.equal(best(shop).recommendedKey,'full');assert.equal(best(shop).options.at(-1).label,'Et helt år');
 const salmon=setup().shop,fish=watch(salmon,{name:'Laksefilet',storage:'frozen'});salmon.offer(offer(fish.id));
 assert.equal(best(salmon).shelfMonths,3);assert.equal(best(salmon).packs,3);
 const milk=setup().shop,fresh=watch(milk,{name:'Lettmelk',storage:'chilled',purchaseAmount:120});milk.offer(offer(fresh.id));
 assert.equal(best(milk).packs,5);assert.equal(best(milk).options.at(-1).label,'Noen uker');
 const custom=setup().shop,long=watch(custom,{name:'Laksefilet',storage:'frozen',shelfLifeMonths:6});custom.offer(offer(long.id));
 assert.equal(best(custom).packs,6);
});
test('a merely good deal stops at three months, even when the product keeps for a year',()=>{
 const {shop}=setup();const flour=watch(shop);shop.offer(offer(flour.id,{price:85}));
 const deal=best(shop);assert.equal(deal.tier,'good');assert.equal(deal.packs,3);assert.deepEqual(deal.options.map(x=>x.label),['Neste tur','3 mnd']);assert.equal(deal.fullMonths,3);
 shop.pantry({watchId:flour.id,months:3});assert.equal(shop.view().opportunities.length,0);assert.equal(shop.familyView().covered.length,1);
 const fish=setup().shop,salmon=watch(fish,{name:'Lettmelk',storage:'chilled',purchaseAmount:120});fish.offer(offer(salmon.id,{price:85}));assert.equal(best(fish).packs,5);
});
test('short-dated offers cannot recommend more than their date allows',()=>{
 const {shop}=setup();const flour=watch(shop);shop.offer(offer(flour.id,{bestBefore:'2027-02-20'}));
 assert.equal(best(shop).shelfMonths,3);assert.equal(best(shop).packs,3);assert.equal(shop.familyView().deals[0].bestBefore,'2027-02-20');
 shop.offer(offer(flour.id,{bestBefore:'2026-10-17'}));assert.equal(best(shop).shelfMonths,.5);assert.equal(best(shop).packs,1);
 assert.throws(()=>shop.offer(offer(flour.id,{bestBefore:'snart'})),/dato/);
});
test('a marginal discount only covers the next trip',()=>{
 const {shop}=setup();const flour=watch(shop,{referenceCeiling:{price:100,checkedAt:'2026-11-08T10:00:00Z',sourceUrl:'https://example.com/current',evidence:'Fersk alternativpris'}});shop.offer(offer(flour.id,{price:99}));
 const deal=best(shop);assert.equal(deal.tier,'small');assert.equal(deal.packs,1);assert.deepEqual(deal.options.map(x=>x.label),['Neste tur']);
 assert.equal(shop.familyView().deals.length,0);assert.equal(shop.familyView().smallDeals.length,1);assert.equal(shop.familyView().summary.dealCount,0);
});
test('excellent is reached by the price limit or by a very deep discount',()=>{
 assert.equal(dealTier({unitPrice:80,excellentPrice:85,discountPct:10,referenceType:'market'}),'excellent');
 assert.equal(dealTier({unitPrice:70,excellentPrice:null,discountPct:30,referenceType:'market'}),'excellent');
 assert.equal(dealTier({unitPrice:90,excellentPrice:80,discountPct:10,referenceType:'market'}),'good');
 assert.equal(dealTier({unitPrice:95,excellentPrice:null,discountPct:5,referenceType:'market'}),'small');
 assert.equal(dealTier({unitPrice:19,excellentPrice:null,discountPct:5,referenceType:'target'}),'good');
});
test('packs larger than the need and multibuys stay visible, counting only usable savings',()=>{
 const big=setup().shop,flour=watch(big,{purchaseAmount:3,targetPrice:100,priceGuide:null});
 big.importOrders({orders:[{orderNumber:'o1',deliveryDate:'2026-10-01',currency:'NOK',grossAmount:300,linePricesVerified:true,products:[{product:{id:1,name:'Mel',description:'1 kg'},quantity:3,totalGrossAmount:'300.00'}]}]});
 big.watch({...big.view().watches[0],productKeys:['oda:1']});
 big.offer(offer(flour.id,{packAmount:5,price:350}));
 const deal=best(big);assert.equal(deal.tier,'excellent');assert.equal(deal.packs,1);assert.equal(deal.saving,90);
 const multi=setup().shop,item=watch(multi,{purchaseAmount:2});multi.offer(offer(item.id,{bundlePacks:3,price:80}));
 assert.equal(best(multi).packs,3);
});
test('stock lowers the quantity, burns down with use and demotes covered deals',()=>{
 const {shop,clock}=setup();const flour=watch(shop);shop.offer(offer(flour.id));
 shop.pantry({watchId:flour.id,months:4});assert.equal(best(shop).packs,8);
 shop.pantry({watchId:flour.id,months:12});assert.equal(shop.view().opportunities.length,0);
 const family=shop.familyView();assert.equal(family.covered.length,1);assert.equal(family.summary.dealCount,0);
 clock.at='2026-12-08T12:00:00Z';
 const later=shop.familyView().items[0];assert.ok(later.stock.months<11.1&&later.stock.months>10.9);
 const stock=estimateStock({stockAmount:10,stockCheckedAt:'2026-01-01T00:00:00Z'},1,Date.parse('2026-12-31T00:00:00Z'));assert.equal(stock.amount,0);assert.equal(stock.needsCheck,true);
 assert.throws(()=>shop.pantry({watchId:shop.watch({name:'Ukjent',unit:'stk',storage:'pantry'}).id,months:3}),/ukjent/i);
});
test('buying adds stock and records the saving; undo restores everything',()=>{
 const {shop}=setup();const flour=watch(shop),{id}=shop.offer(offer(flour.id));
 shop.dealAction({offerId:id,action:'bought',packs:5});
 let family=shop.familyView();assert.equal(family.items[0].stock.amount,5);assert.equal(family.saved.all,0);assert.equal(family.deals.length,0);assert.equal(family.purchases[0].packs,5);
 shop.dealAction({offerId:id,action:'undo'});family=shop.familyView();assert.equal(family.items[0].stock.known,false);assert.equal(family.purchases.length,0);assert.equal(family.deals.length,1);
 assert.throws(()=>shop.dealAction({offerId:id,action:'bought',packs:0}),/antall/);
 shop.dealAction({offerId:id,action:'snooze'});assert.equal(shop.view().opportunities.length,0);
 shop.offer(offer(flour.id,{price:60}));assert.equal(shop.view().opportunities.length,1);
});
test('manual limits survive calibration, and price history accumulates past the window',()=>{
 const {shop,state}=setup();const flour=watch(shop,{manualLimits:true,targetPrice:77});
 const products=[{id:1,store:'OTHER',unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme vare',lastChecked:'2026-11-08T10:00:00Z',currentPrice:100,history:history()}];
 assert.equal(shop.market({watchId:flour.id,products}).status,'ready');
 assert.equal(shop.view().watches[0].targetPrice,77);assert.equal(Object.keys(state.shopping.priceHistory[flour.id]).length,30);
 assert.equal(shop.item({id:flour.id,targetPrice:null}).manualLimits,false);
 shop.market({watchId:flour.id,products});assert.equal(shop.view().watches[0].targetPrice,100);
 assert.equal(shop.familyView().items[0].prices.good,92);
});
test('one stale product keeps a group visible; a wholly stale group is reported',()=>{
 const {shop,clock}=setup();const flour=watch(shop);
 const p={unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme vare',currentPrice:100,history:history()};
 shop.market({watchId:flour.id,products:[{...p,id:1,store:'OTHER',lastChecked:'2026-11-07T00:00:00Z'},{...p,id:2,store:'THIRD',lastChecked:'2026-11-08T11:00:00Z'}]});
 clock.at='2026-11-09T10:00:00Z';shop.offer(offer(flour.id));
 assert.equal(shop.view().opportunities.length,1);
 clock.at='2026-11-10T23:00:00Z';shop.offer(offer(flour.id,{validTo:'2026-11-20'}));
 const view=shop.view();assert.equal(view.opportunities.length,0);assert.equal(view.heldOffers[0].reason,'stale-prices');
});
test('deals below a store trip threshold stay visible but out of the headline',()=>{
 const {shop}=setup();shop.settings({stores:[{id:'near',name:'Langt unna',url:'https://example.com/near',minSavings:500}]});
 const flour=watch(shop,{referenceCeiling:{price:100,checkedAt:'2026-11-08T10:00:00Z',sourceUrl:'https://example.com/current',evidence:'Fersk pris'}});shop.offer(offer(flour.id,{price:85}));
 const family=shop.familyView();assert.equal(family.deals.length,0);assert.equal(family.belowTrip.length,1);assert.equal(family.summary.dealCount,0);
 assert.deepEqual(shop.view().offerCounts.byStore.near,{comparable:1,notComparable:0});
});
test('agents get a complete price table and a daily market refresh task',()=>{
 const {shop,clock}=setup();shop.settings({monitoringEnabled:true,stores:[]});
 const flour=watch(shop),paused=watch(shop,{name:'Pauset',enabled:false});
 assert.deepEqual(shop.checklist().map(x=>x.watchId),[flour.id]);assert.equal(shop.checklist()[0].good,100);assert.notEqual(paused.id,flour.id);
 assert.equal(shop.queue().filter(x=>x.do==='shopping-market-refresh').length,0);
 shop.market({watchId:flour.id,products:[{id:1,store:'OTHER',unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme vare',lastChecked:'2026-11-08T10:00:00Z',currentPrice:100,history:history()}]});
 assert.equal(shop.queue().filter(x=>x.do==='shopping-market-refresh').length,0);
 clock.at='2026-11-09T07:00:00Z';assert.equal(shop.queue().filter(x=>x.do==='shopping-market-refresh').length,1);
});
test('community group posts become feed work, then an acknowledged store review',()=>{
 const {state,shop,clock}=setup();
 shop.settings({monitoringEnabled:true,stores:[{id:'reko',name:'REKO',url:'https://example.com/group',minSavings:0,facebookGroup:'examplegroup'}]});
 state.collector={items:{a:{kind:'post',externalId:'facebook:post:1',shoppingStoreId:'reko',token:'t1',text:'Egg 18 stk 70 kr',postedAt:NOW,url:'https://example.com/p/1'},b:{kind:'post',externalId:'facebook:post:2',activitySourceId:'x',token:'t2',text:'Annet'}}};
 assert.deepEqual(shop.queue().map(x=>[x.do,x.unread]),[['shopping-feed-review',1]]);
 assert.equal(shop.feed({storeId:'reko'})[0].text,'Egg 18 stk 70 kr');
 assert.throws(()=>shop.feed({storeId:'reko',ack:true}),/Kontrollbelegg/);
 assert.equal(shop.feed({storeId:'reko',ack:true,evidence:'Lest ett innlegg, ingen treff'}).reviewed,1);
 assert.deepEqual(shop.queue(),[]);assert.equal(shop.view().reviews[0].status,'ok');
 state.collector.items.a.token='t3';assert.equal(shop.queue()[0].unread,1);
 clock.at='2026-12-20T12:00:00Z';assert.deepEqual(shop.queue().filter(x=>x.do==='shopping-feed-review'),[]);
 assert.throws(()=>shop.feed({storeId:'missing'}),/Ukjent/);
});
test('member-only offers are reported rather than silently dropped',()=>{
 const {shop}=setup();const flour=watch(shop);shop.offer(offer(flour.id,{memberOnly:true}));
 assert.equal(shop.familyView().deals.length,0);assert.equal(shop.familyView().held[0].reason,'member');
});
test('native Oda lines are queued for a reviewed link and refill counted stock',()=>{
 const {shop}=setup();shop.settings({monitoringEnabled:true,stores:[]});
 const flour=shop.watch({name:'Mel',unit:'kg',storage:'pantry',productKeys:['oda-ui:legacy'],purchaseAmount:12});
 shop.pantry({watchId:flour.id,amount:2});
 const order=(id,date)=>({orderNumber:id,deliveryDate:date,currency:'NOK',grossAmount:60,products:[{product:{id:5,name:'Hvetemel',description:'1 kg'},quantity:3,totalGrossAmount:'60.00'}]});
 shop.importOrders({orders:[order('a','2026-11-08')]});
 assert.deepEqual(shop.queue().filter(x=>x.do==='shopping-order-link').map(x=>x.productKey),['oda:5']);
 assert.equal(shop.familyView().items[0].stock.amount,2);
 assert.throws(()=>shop.link({productKey:'oda:5',watchId:flour.id}),/Koblingsbelegg/);
 shop.link({productKey:'oda:5',watchId:flour.id,evidence:'Samme hvetemel, 1 kg'});
 assert.equal(shop.queue().filter(x=>x.do==='shopping-order-link').length,0);
 shop.importOrders({orders:[order('b','2026-11-08')]});assert.equal(shop.familyView().items[0].stock.amount,5);
 shop.importOrders({orders:[order('b','2026-11-08')]});assert.equal(shop.familyView().items[0].stock.amount,5);
 shop.link({productKey:'oda:5',watchId:null,evidence:'Skal ikke følges'});
});
test('unverified order prices still document how much was bought',()=>{
 const {shop}=setup();const w=shop.watch({name:'Mel',unit:'kg',storage:'pantry',productKeys:['oda:1'],targetPrice:100});
 shop.importOrders({orders:[{orderNumber:'x',deliveryDate:'2026-10-01',currency:'NOK',grossAmount:100,products:[{product:{id:1,name:'Mel',description:'1 kg'},quantity:5,totalGrossAmount:'100.00'}]}]});
 const need=annualNeed(shop.view().watches[0],shop.analysis().products,366);assert.ok(need.amount>4.9&&need.amount<5.1);assert.equal(need.basis,'oda-lower-bound');assert.equal(shop.analysis().products[0].baselineUnitPrice,null);
 assert.equal(w.manualLimits,false);
});
test('a stated yearly need wins over documented purchases, and family edits keep their data',()=>{
 const {shop}=setup();const flour=watch(shop,{purchaseAmount:30});
 const edited=shop.item({id:flour.id,annualAmount:6,shelfLifeMonths:6});assert.equal(edited.monthlyUsage,.5);assert.equal(edited.purchaseAmount,null);assert.equal(edited.targetPrice,100);
 shop.offer(offer(flour.id));assert.equal(best(shop).packs,3);assert.equal(best(shop).quantityBasis,'household-estimate');
 assert.equal(shop.item({id:flour.id,enabled:false}).enabled,false);assert.equal(shop.view().opportunities.length,0);
 assert.equal(shop.item({name:'Ny vare',unit:'stk',storage:'pantry'}).name,'Ny vare');
 assert.throws(()=>shop.item({id:'missing'}),/Ukjent/);
});
test('shelf life defaults follow product type and storage',()=>{
 assert.equal(defaultShelfLifeMonths({name:'Kjøttdeig av storfe',storage:'frozen'}),4);
 assert.equal(defaultShelfLifeMonths({name:'Ostegrillpølser',storage:'frozen'}),3);
 assert.equal(defaultShelfLifeMonths({name:'Frosne bringebær',storage:'frozen'}),12);
 assert.equal(defaultShelfLifeMonths({name:'Grana Padano i bit',storage:'chilled'}),6);
 assert.equal(defaultShelfLifeMonths({name:'Tomater på boks',storage:'pantry'}),12);
});
