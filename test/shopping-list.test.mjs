import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore} from '../src/shopping.mjs';

const NOW='2026-11-08T12:00:00Z';
function setup() {
 const state={},clock={at:NOW},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at)});
 shop.settings({historyFrom:'2025-11-08',stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/near',minSavings:0}]});
 return {state,shop,clock};
}
const flour=(shop,extra={})=>shop.watch({name:'Mel',unit:'kg',storage:'pantry',targetPrice:100,purchaseAmount:12,...extra});
const offer=(watchId,extra={})=>({watchId,storeId:'near',externalId:'o1',name:'Hvetemel 1 kg',price:70,packAmount:1,unit:'kg',validFrom:'2026-11-08',validTo:'2026-11-14',sourceUrl:'https://example.com/flyer',evidence:'Avis',comparable:true,comparisonNote:'Tilsvarende',...extra});
function odaItem(shop,watchId,{id=1,price=20,pack=1,productId=555}={}) {
 const seen=shop.catalogObserve({watchId,products:[{id,store:'ODA_NO',name:'Hvetemel',sourceUrl:`https://oda.com/no/products/${productId}-hvetemel/`,currentPrice:price,lastChecked:'2026-11-08T10:00:00Z'}]});
 shop.catalogReview({watchId,id,store:'ODA_NO',fingerprint:seen.entries[0].fingerprint,status:'approved',packAmount:pack,unit:'kg',equivalenceEvidence:'Samme mel'});
}
const orders=shop=>shop.importOrders({orders:['2026-03-29','2026-07-05','2026-10-11'].map((deliveryDate,i)=>({orderNumber:'o'+i,deliveryDate,currency:'NOK',grossAmount:10,products:[{product:{id:900+i,name:'Annet',description:'1 kg'},quantity:1,totalGrossAmount:'10.00'}]}))});

test('ticking a listed deal buys it, and unticking undoes the stock and saving',()=>{
 const {shop}=setup();const w=flour(shop),{id}=shop.offer(offer(w.id));
 const entry=shop.list({action:'add',offerId:id,packs:4});
 let family=shop.familyView();assert.equal(family.list.open[0].storeName,'Nærbutikk');assert.equal(family.deals[0].onList,true);
 assert.equal(shop.list({action:'add',offerId:id,packs:6}).id,entry.id);assert.equal(shop.familyView().list.open.length,1);
 shop.list({action:'check',id:entry.id});family=shop.familyView();
 assert.equal(family.items[0].stock.amount,6);assert.equal(family.purchases[0].packs,6);assert.equal(family.list.done.length,1);assert.equal(family.deals.length,0);
 shop.list({action:'uncheck',id:entry.id});family=shop.familyView();
 assert.equal(family.items[0].stock.known,false);assert.equal(family.purchases.length,0);assert.equal(family.list.open.length,1);assert.equal(family.deals.length,1);
 shop.list({action:'remove',id:entry.id});assert.equal(shop.familyView().list.open.length,0);
 assert.throws(()=>shop.list({action:'check',id:'missing'}),/Finner ikke/);assert.throws(()=>shop.list({action:'add',offerId:id,packs:0}),/antall/);
});
test('free items and low-stock items work, and an expired offer is flagged',()=>{
 const {shop,clock}=setup();const w=flour(shop);
 const free=shop.list({action:'add',name:'Bursdagslys'});assert.equal(free.watchId,null);
 shop.list({action:'check',id:free.id});assert.equal(shop.familyView().list.done[0].name,'Bursdagslys');
 shop.list({action:'clear'});assert.equal(shop.familyView().list.done.length,0);
 const low=shop.list({action:'add',watchId:w.id,packAmount:.5});assert.equal(low.packs,2);
 shop.list({action:'check',id:low.id});assert.equal(shop.familyView().items[0].packs.some(p=>p.count===2),true);
 shop.list({action:'uncheck',id:low.id});assert.equal(shop.familyView().items[0].stock.known,false);
 const {id}=shop.offer(offer(w.id));shop.list({action:'add',offerId:id,packs:2});
 clock.at='2026-11-20T12:00:00Z';assert.equal(shop.familyView().list.open.find(x=>x.offerId===id).expired,true);
 assert.throws(()=>shop.list({action:'add',name:' '}),/Varenavn/);assert.throws(()=>shop.list({action:'nope'}),/Ukjent/);
});
test('the Oda draft covers the usual gap, subtracts stock and listed items, and extends on good prices',()=>{
 const {shop}=setup();orders(shop);const w=flour(shop);odaItem(shop,w.id);
 const none=flour(shop,{name:'Annen vare'});
 let draft=shop.familyView().odaDraft;
 assert.equal(draft.nextAround,'2027-01-17');assert.deepEqual(draft.missing,['Annen vare']);assert.notEqual(none.id,w.id);
 assert.equal(draft.items[0].productId,555);assert.equal(draft.items[0].packs,3);assert.equal(draft.items[0].cost,60);assert.equal(draft.items[0].stockKnown,false);
 shop.pantry({watchId:w.id,amount:1});assert.equal(shop.familyView().odaDraft.items[0].packs,2);
 shop.pantry({watchId:w.id,amount:null});shop.list({action:'add',watchId:w.id,packAmount:1});assert.equal(shop.familyView().odaDraft.items[0].packs,2);
});
test('price level changes the Oda quantity, and full stock leaves the draft',()=>{
 const make=price=>{const {shop}=setup();orders(shop);const w=flour(shop,{priceGuide:{referencePrice:100,checkedAt:'2026-11-08T10:00:00Z',evidence:'Grunnlag'},excellentPrice:70});odaItem(shop,w.id,{price});return {shop,w};};
 let {shop,w}=make(60);assert.equal(shop.familyView().odaDraft.items[0].tier,'excellent');assert.equal(shop.familyView().odaDraft.items[0].packs,12);
 ({shop}=make(120));assert.equal(shop.familyView().odaDraft.items[0].tier,'dear');assert.equal(shop.familyView().odaDraft.items[0].packs,1);
 ({shop,w}=make(100));shop.pantry({watchId:w.id,amount:12});const draft=shop.familyView().odaDraft;assert.equal(draft.items.length,0);assert.equal(draft.covered,1);
});
