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
test('MCP historical product prices do not substitute for paid line totals',()=>{
 const {shop}=fixture(),input=order('mcp','2026-10-01');input.linePricesVerified=false;input.products[0].product.price='1.00';
 shop.importOrders({orders:[input]});assert.equal(shop.analysis().products[0].spent,600);assert.equal(shop.analysis().products[0].baselineUnitPrice,null);
});
test('nutrition reports coverage and never treats unknown foods or volume as zero nutrients',()=>{
 const entry=validateNutrition({productKey:'oda:1',basis:'g',per100:{kcal:160,protein:20,fat:8,carbs:2},sourceUrl:'https://example.com/label',evidence:'Næringsinnhold per 100 g'});
 const orders=[{products:[{productKey:'oda:1',name:'Mat',category:'Mat',netTotal:40,quantity:2,pack:{amount:.4,unit:'kg'}},{productKey:'unknown',category:'Mat',netTotal:20,quantity:1,pack:{amount:1,unit:'l'}},{productKey:'soap',category:'Hus og hjem',netTotal:100,quantity:1}]}];
 const n=purchaseNutrition(orders,{'oda:1':entry});assert.equal(n.totals.protein,160);assert.equal(n.totals.kcal,1280);assert.equal(n.coverage.spendPct,66.7);assert.equal(n.coverage.foodLines,2);assert.deepEqual(n.coverage.missingProductKeys,['unknown']);assert.equal(n.proteinCosts[0].per100gProtein,25);
 assert.throws(()=>validateNutrition({...entry,per100:{protein:20}}));assert.throws(()=>validateNutrition({...entry,per100:{kcal:300,protein:80,fat:80,carbs:1}}));
});
