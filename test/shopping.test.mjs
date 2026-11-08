import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore,parseOdaOrderText,packSize,shoppingMoney} from '../src/shopping.mjs';
import {purchaseNutrition,validateNutrition} from '../src/shopping-nutrition.mjs';

const capture={orderNumber:'example-order',deliveryDate:'2026-10-02',sourceUrl:'https://oda.com/no/account/orders/example-order/',text:`Bestilling example-order
Levert
Bestilte varer
Kylling og kjøtt
Eksempel Kjøttdeig 400 g
-20%
5
MVA 15%
300,00 kr
Eksempel Kjøttdeig premium 400 g
2
MVA 15%
160,00 kr
Frukt og grønt
Eksempel Frukt 1 kg
2
MVA 15%
40,00 kr
Eksempel Frukt 1 kg
Refundert
-1
MVA 15%
−20,00 kr
Bonus
8 varer
480,00 kr
-20%: Kjøttdeig
−60,00 kr
Levering
20,00 kr
Total inkl. MVA
440,00 kr`};
const order=(id,date)=>({orderNumber:id,deliveryDate:date,currency:'NOK',grossAmount:600,linePricesVerified:true,products:[{product:{id:1,name:'Eksempel kjøttdeig',description:'400 g'},quantity:10,totalGrossAmount:'600.00',category:'Kylling og kjøtt'}]});
function fixture(){const state={};let saves=0;const shop=shoppingStore(state,{save:()=>saves++,now:()=>new Date('2026-11-08T12:00:00Z')});shop.settings({historyFrom:'2025-11-08',stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/offers',minSavings:20},{id:'far',name:'Lenger unna',url:'https://example.com/far',minSavings:200}]});return {state,shop,saves:()=>saves};}
test('order import reconciles refunds, fees, Unicode and discounts, and is idempotent',()=>{
 const {shop,saves}=fixture();const parsed=parseOdaOrderText(capture);
 assert.equal(parsed.productAmount,420);assert.equal(parsed.grossAmount,440);
 assert.equal(parsed.products.at(-1).quantity,-1);
 shop.importOrders({orders:[capture]});shop.importOrders({orders:[capture]});assert.equal(shop.analysis().orderCount,1);assert.equal(shop.analysis().orderTotal,440);
 const before=saves();assert.throws(()=>shop.importOrders({orders:[capture,{...capture,orderNumber:'wrong'}]}));assert.equal(saves(),before);
 assert.throws(()=>parseOdaOrderText({...capture,text:capture.text.replace('440,00 kr','441,00 kr')}),/stemmer ikke/);
 assert.equal(shoppingMoney('1\u00a0234,50 kr'),1234.5);assert.deepEqual(packSize('10x100g, 1 kg'),{amount:1,unit:'kg'});
});
test('offers honor unit, evidence, stock, membership, dates, freshness, multibuy and travel threshold',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Kjøttdeig',productKeys:['oda:1'],unit:'kg',storage:'frozen',monthlyUsage:4,maxPacks:20,minDiscountPct:20,stockAmount:1});
 const offer={watchId:w.id,storeId:'near',externalId:'flyer-1',name:'Tilsvarende kjøttdeig',price:32,packAmount:.4,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'400 g, 32 kr, gjelder denne uken',comparable:true,comparisonNote:'Samme type og fettandel',maxPacks:10,bundlePacks:2};
 shop.offer(offer);let result=shop.view().opportunities;assert.equal(result.length,1);assert.equal(result[0].packs,10);assert.equal(result[0].saving,280);assert.equal(result[0].quantityBasis,'household-estimate');
 shop.offer({...offer,memberOnly:true});assert.equal(shop.view().opportunities.length,0);
 shop.offer({...offer,observedAt:'2026-11-01T00:00:00Z'});assert.equal(shop.view().opportunities.length,0);
 shop.offer({...offer,validTo:'2026-11-07',validFrom:'2026-11-01'});assert.equal(shop.view().opportunities.length,0);
 shop.offer({...offer,comparable:false});assert.equal(shop.view().opportunities.length,0);
 assert.throws(()=>shop.offer({...offer,unit:'l'}));assert.throws(()=>shop.offer({...offer,sourceUrl:'javascript:alert(1)'}));assert.throws(()=>shop.offer({...offer,observedAt:'2026-11-09T00:00:00Z'}));
 shop.offer({...offer,storeId:'far',maxPacks:2,bundlePacks:1});assert.equal(shop.view().opportunities.length,0);
 shop.watch({...w,stockAmount:20});shop.offer(offer);assert.equal(shop.view().opportunities.length,0);
});
test('monitoring is opt-in and source receipts do not imply a working collector',()=>{
 const {shop}=fixture();assert.deepEqual(shop.queue(),[]);shop.settings({monitoringEnabled:true});assert.equal(shop.queue().length,2);
 shop.review({storeId:'near',status:'blocked',sourceUrl:'https://example.com/offers',evidence:'Innlogging kreves',nextCheck:'2026-11-09'});assert.equal(shop.queue().length,1);assert.equal(shop.view().reviews[0].status,'blocked');
});
test('sparse capped Oda history uses observed shopping quantities, and basket savings count once',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Kjøttdeig',productKeys:['oda:1'],unit:'kg',storage:'frozen',maxPacks:20,minDiscountPct:0});
 const offer={watchId:w.id,storeId:'near',externalId:'next-week',name:'Kjøttdeig',price:50,packAmount:.4,unit:'kg',validFrom:'2026-11-09',validTo:'2026-11-15',sourceUrl:'https://example.com/flyer',evidence:'Neste ukes lokale avis',comparable:true,comparisonNote:'Tilsvarende vare'};
 shop.offer(offer);const first=shop.view().opportunities[0];assert.equal(first.packs,10);assert.equal(first.saving,100);assert.equal(first.quantityBasis,'oda-lower-bound');
 shop.offer({...offer,externalId:'duplicate-offer'});assert.equal(shop.view().opportunities.length,1);
 const changed=shop.watch({...w,stockAmount:3});shop.watch({...changed,enabled:false});assert.equal(shop.view().opportunities.length,0);
});
test('wholesale quotes require VAT and compare gross prices with household purchases',()=>{
 const {shop}=fixture();shop.settings({stores:[{id:'wholesale',name:'Engrosbutikk',url:'https://example.com/wholesale',minSavings:0,pricesIncludeVat:false}]});
 shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Matvare',productKeys:['oda:1'],unit:'kg',storage:'frozen',maxPacks:20,minDiscountPct:0});
 const offer={watchId:w.id,storeId:'wholesale',externalId:'food',name:'Matvare',price:100,packAmount:1,unit:'kg',validFrom:'2026-11-09',validTo:'2026-11-14',sourceUrl:'https://example.com/wholesale',evidence:'100 kr eks. mva per kg',comparable:true,comparisonNote:'Samme matvare'};
 assert.throws(()=>shop.offer(offer),/momssats/);assert.throws(()=>shop.offer({...offer,vatRate:15}),/andel/);
 shop.offer({...offer,vatRate:.15});const result=shop.view().opportunities[0];assert.equal(result.price,115);assert.equal(result.unitPrice,115);assert.equal(result.priceBeforeVat,100);assert.equal(result.saving,140);
 shop.offer({...offer,vatRate:.25});assert.equal(shop.view().opportunities[0].price,125);
});

test('explicit bulk plans can exceed a typical shop but still honor stock and customer limits',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Stock-up category',productKeys:['oda:1'],unit:'kg',storage:'pantry',purchaseAmount:20,maxPacks:100,stockAmount:2});
 const offer={watchId:w.id,storeId:'near',externalId:'bulk',name:'Equivalent goods',price:50,packAmount:.4,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/offer',evidence:'Current 400 g price',comparable:true,comparisonNote:'Same product',bundlePacks:2};
 shop.offer(offer);const planned=shop.view().opportunities[0];assert.equal(planned.packs,44);assert.equal(planned.saving,440);assert.equal(planned.quantityBasis,'planned-amount');assert.equal(shop.view().watches[0].monthlyUsage,null);
 shop.offer({...offer,maxPacks:8});assert.equal(shop.view().opportunities[0].packs,8);
 shop.watch({...w,stockAmount:20});assert.equal(shop.view().opportunities.length,0);
 assert.throws(()=>shop.watch({...w,monthlyUsage:3}),/månedsforbruk/);
 assert.throws(()=>shop.watch({...w,storage:'chilled'}),/lagringsvare/);
});
test('MCP historical product prices do not substitute for paid line totals',()=>{
 const {shop}=fixture(),input=order('mcp','2026-10-01');input.linePricesVerified=false;input.products[0].product.price='1.00';
 shop.importOrders({orders:[input]});assert.equal(shop.analysis().products[0].spent,600);assert.equal(shop.analysis().products[0].baselineUnitPrice,null);
});

test('a lower current alternative reduces savings and stale alternative evidence requires a new check',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Staple',productKeys:['oda:1'],unit:'kg',storage:'pantry',maxPacks:20,referenceCeiling:{price:125,checkedAt:'2026-11-08T10:00:00Z',sourceUrl:'https://example.com/current',evidence:'Equivalent current alternative price'}});
 const offer={watchId:w.id,storeId:'near',externalId:'current',name:'Staple',price:50,packAmount:.4,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'Current flyer',comparable:true,comparisonNote:'Equivalent'};
 shop.offer(offer);assert.equal(shop.view().opportunities.length,0);
 shop.offer({...offer,price:40});assert.equal(shop.view().opportunities[0].saving,100);assert.equal(shop.view().opportunities[0].referenceType,'alternative');
 shop.watch({...w,referenceCeiling:{...w.referenceCeiling,checkedAt:'2026-11-01T10:00:00Z'}});assert.equal(shop.view().opportunities.length,0);
 assert.throws(()=>shop.watch({...w,referenceCeiling:{...w.referenceCeiling,checkedAt:'2026-11-09T10:00:00Z'}}),/kontrolltid/);
});

test('a target-price watch without purchase history does not invent consumption or paid savings',()=>{
 const {shop}=fixture();const w=shop.watch({name:'Exact household item',productKeys:[],unit:'l',storage:'pantry',targetPrice:20,maxPacks:1});
 shop.offer({watchId:w.id,storeId:'near',externalId:'delivered-bundle',name:'Exact item 3 x 10 l',price:570,packAmount:30,unit:'l',validFrom:'2026-11-08',validTo:'2026-11-08',sourceUrl:'https://example.com/item',evidence:'Three boxes, shipping included',comparable:true,comparisonNote:'Exact variant, delivered price'});
 const [o]=shop.view().opportunities;assert.equal(o.packs,1);assert.equal(o.quantityBasis,'offer-pack');assert.equal(o.referenceType,'target');assert.equal(o.saving,null);assert.equal(o.unitPrice,19);
 shop.offer({...o,externalId:'better-delivered-bundle',name:'Exact item 4 x 10 l',price:720,packAmount:40});
 assert.equal(shop.view().opportunities.length,1);assert.equal(shop.view().opportunities[0].unitPrice,18);
});

test('price guides persist their basis and distinguish good and excellent thresholds',()=>{
 const {shop}=fixture();const w=shop.watch({name:'Staple',unit:'kg',storage:'pantry',targetPrice:100,excellentPrice:80,priceGuide:{referencePrice:120,checkedAt:'2026-11-08T10:00:00Z',evidence:'Conservative historical paid price; thresholds are planning choices'}});
 assert.equal(shop.view().watches[0].excellentPrice,80);assert.equal(w.priceGuide.referencePrice,120);
 assert.throws(()=>shop.watch({...w,excellentPrice:110}),/Svært bra/);
 assert.throws(()=>shop.watch({...w,priceGuide:{...w.priceGuide,evidence:''}}),/grunnlag/);
});

test('market calibration drives thresholds and savings independently of historic household spend',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 const w=shop.watch({name:'Staple',productKeys:['oda:1'],unit:'kg',storage:'pantry',maxPacks:20,targetPrice:120});
 const history=Array.from({length:30},(_,i)=>({date:new Date(Date.parse('2026-10-10T10:00:00Z')+i*86400000).toISOString(),price:50}));
 const products=[{id:1,ean:'12345678',store:'SYNTHETIC',unit:'kg',packAmount:.5,reviewed:true,equivalenceEvidence:'Same synthetic staple and pack',lastChecked:'2026-11-08T10:00:00Z',currentPrice:50,history}];
 const result=shop.market({watchId:w.id,products});assert.equal(result.status,'ready');assert.equal(shop.view().watches[0].targetPrice,100);assert.equal(shop.view().watches[0].excellentPrice,null);
 const offer={watchId:w.id,storeId:'near',externalId:'market',name:'Staple',price:45,packAmount:.4,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'Current flyer',comparable:true,comparisonNote:'Equivalent'};
 shop.offer(offer);assert.equal(shop.view().opportunities.length,0);
 shop.offer({...offer,price:35});const [o]=shop.view().opportunities;assert.equal(o.referenceType,'market');assert.equal(o.referencePrice,100);assert.equal(o.saving,50);
 shop.watch({...shop.view().watches[0],enabled:false});assert.equal(shop.view().watches[0].marketCalibration.status,'ready');
 assert.throws(()=>shop.market({watchId:w.id,products:[{...products[0],equivalenceEvidence:''}]}),/sammenligningsbelegg/);
 const current=shop.watch({...shop.view().watches[0],referenceCeiling:{price:80,checkedAt:'2026-11-08T10:00:00Z',sourceUrl:'https://example.com/current',evidence:'Verified cheaper equivalent outside the returned history'}});
 const capped=shop.market({watchId:current.id,products});assert.equal(capped.goodPrice,80);assert.equal(shop.view().watches[0].targetPrice,80);assert.equal(shop.view().watches[0].referenceCeiling.price,80);
});
test('a campaign already in Kassal is compared with other chains rather than itself',()=>{
 const {shop}=fixture();shop.importOrders({orders:[order('one','2026-01-01'),order('two','2026-10-01')]});
 shop.settings({stores:shop.view().settings.stores.map(s=>({...s,chainCode:s.id==='near'?'CAMPAIGN':'OTHER'}))});
 const w=shop.watch({name:'Staple',productKeys:['oda:1'],unit:'kg',storage:'pantry',maxPacks:20,purchaseAmount:4});
 const history=Array.from({length:30},(_,i)=>({date:new Date(Date.parse('2026-10-10T10:00:00Z')+i*86400000).toISOString(),price:100}));
 const p={id:1,unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Same reviewed staple',lastChecked:'2026-11-08T11:00:00Z',history};
 shop.market({watchId:w.id,products:[{...p,store:'CAMPAIGN',currentPrice:60},{...p,store:'OTHER',currentPrice:90}]});
 shop.offer({watchId:w.id,storeId:'near',externalId:'campaign',name:'Staple',price:60,packAmount:1,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'Current flyer',comparable:true,comparisonNote:'Same staple'});
 const [o]=shop.view().opportunities;assert.equal(o.referencePrice,90);assert.equal(o.saving,120);
 shop.settings({stores:shop.view().settings.stores.map(({chainCode,...s})=>s)});assert.equal(shop.view().opportunities.length,0);
});

test('nutrition reports coverage and never treats unknown foods or volume as zero nutrients',()=>{
 const entry=validateNutrition({productKey:'oda:1',basis:'g',per100:{kcal:160,protein:20,fat:8,carbs:2},sourceUrl:'https://example.com/label',evidence:'Næringsinnhold per 100 g'});
 const orders=[{products:[{productKey:'oda:1',name:'Mat',category:'Mat',netTotal:40,quantity:2,pack:{amount:.4,unit:'kg'}},{productKey:'unknown',category:'Mat',netTotal:20,quantity:1,pack:{amount:1,unit:'l'}},{productKey:'soap',category:'Hus og hjem',netTotal:100,quantity:1}]}];
 const n=purchaseNutrition(orders,{'oda:1':entry});assert.equal(n.totals.protein,160);assert.equal(n.totals.kcal,1280);assert.equal(n.coverage.spendPct,66.7);assert.equal(n.coverage.foodLines,2);assert.deepEqual(n.coverage.missingProductKeys,['unknown']);assert.equal(n.proteinCosts[0].per100gProtein,25);
 assert.throws(()=>validateNutrition({...entry,per100:{protein:20}}));assert.throws(()=>validateNutrition({...entry,per100:{kcal:300,protein:80,fat:80,carbs:1}}));
});
