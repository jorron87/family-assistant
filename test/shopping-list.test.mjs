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
test('the Oda draft shows the usual date but limits ordinary purchases to the next trip',()=>{
 const {shop}=setup();orders(shop);const w=flour(shop);odaItem(shop,w.id);
 const none=flour(shop,{name:'Annen vare'});
 let draft=shop.familyView().odaDraft;
 assert.equal(draft.nextAround,'2027-01-17');assert.deepEqual(draft.missing,['Annen vare']);assert.notEqual(none.id,w.id);
 assert.equal(draft.items[0].productId,555);assert.equal(draft.items[0].packs,1);assert.equal(draft.items[0].cost,20);assert.equal(draft.items[0].stockKnown,false);
 shop.pantry({watchId:w.id,amount:1});assert.equal(shop.familyView().odaDraft.items.length,0);
 shop.pantry({watchId:w.id,amount:null});shop.list({action:'add',watchId:w.id,packAmount:1});const merged=shop.familyView().odaDraft.items[0];assert.equal(merged.packs,1);assert.equal(merged.entryIds.length,1);
});
test('price level changes the Oda quantity, and full stock leaves the draft',()=>{
 const make=price=>{const {shop}=setup();orders(shop);const w=flour(shop,{priceGuide:{referencePrice:100,checkedAt:'2026-11-08T10:00:00Z',evidence:'Grunnlag'},excellentPrice:70});odaItem(shop,w.id,{price});return {shop,w};};
 let {shop,w}=make(60);assert.equal(shop.familyView().odaDraft.items[0].tier,'excellent');assert.equal(shop.familyView().odaDraft.items[0].packs,12);
 ({shop}=make(120));assert.equal(shop.familyView().odaDraft.items[0].tier,'dear');assert.equal(shop.familyView().odaDraft.items[0].packs,1);
 ({shop,w}=make(100));shop.pantry({watchId:w.id,amount:12});const draft=shop.familyView().odaDraft;assert.equal(draft.items.length,0);assert.equal(draft.covered,1);
});

const history=price=>Array.from({length:30},(_,i)=>({date:new Date(Date.parse('2026-10-10T10:00:00Z')+i*86400000).toISOString(),price}));
function withChain(shop,w,price) {shop.settings({stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/near',minSavings:0,chainCode:'SPAR_NO'}]});
 const seen=shop.catalogObserve({watchId:w.id,products:[{id:9,store:'SPAR_NO',name:'Mel',currentPrice:price,lastChecked:'2026-11-08T10:00:00Z'}]});shop.catalogReview({watchId:w.id,id:9,store:'SPAR_NO',fingerprint:seen.entries[0].fingerprint,status:'approved',packAmount:1,unit:'kg',equivalenceEvidence:'Samme vare'});shop.market({watchId:w.id,products:[{id:9,store:'SPAR_NO',unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme vare',lastChecked:'2026-11-08T10:00:00Z',currentPrice:price,history:history(price)}]});}
test('urgent items start at the nearest store and may still be routed',()=>{
 const {shop}=setup();const e=shop.list({action:'add',name:'Brokkoli',need:'now'});
 assert.equal(e.storeName,'Nærmeste butikk');assert.equal(e.routing,'pending');assert.equal(shop.listRouteWork()[0].need,'now');
});
test('unknown items wait for agent routing, and known items are placed at once',()=>{
 const {shop}=setup();shop.settings({monitoringEnabled:true,stores:[]});
 const e=shop.list({action:'add',name:'Oppvasktabletter'});assert.equal(e.routing,'pending');
 assert.equal(shop.queue().filter(x=>x.do==='shopping-list-route').length,1);
 assert.throws(()=>shop.list({action:'route',id:e.id,storeName:'Oda'}),/Begrunnelse/);
 shop.list({action:'route',id:e.id,storeName:'Oda',reason:'Oda er billigst',odaProductId:77,unitPrice:50,unit:'stk',packAmount:1,packs:2,matchedName:'Tabletter',comparison:{basis:'Samme tabletter',candidates:[{name:'Tabletter',storeName:'Oda',unitPrice:50,unit:'stk',chosen:true}]}});
 assert.equal(shop.listRouteWork().length,0);assert.equal(shop.familyView().odaDraft.items.find(x=>x.productId===77).packs,2);
 const w=flour(shop);odaItem(shop,w.id);
 const placed=shop.list({action:'add',name:'mel'});assert.equal(placed.storeName,'Oda');assert.equal(placed.odaProductId,555);assert.equal(placed.reason,'Oda er omtrent like billig');
});
test('routing only moves away from Oda on a meaningful difference',()=>{
 const run=chain=>{const {shop}=setup();orders(shop);const w=flour(shop);odaItem(shop,w.id,{price:30});withChain(shop,w,chain);return shop;};
 assert.equal(run(28).list({action:'add',name:'mel'}).storeName,'Oda');
 const moved=run(20).familyView().odaDraft.items[0];assert.equal(moved.elsewhere.storeName,'Nærbutikk');assert.equal(moved.elsewhere.diffPct,33);
 const shop=run(20);const entry=shop.list({action:'add',watchId:shop.familyView().items[0].id,packAmount:1});assert.equal(entry.storeName,'Oda');
 const big=run(5).list({action:'add',name:'mel'});assert.equal(big.storeName,'Nærbutikk');assert.match(big.reason,/billigere enn Oda/);
});
test('Oda limits cap the draft and are read from validation messages',()=>{
 const {shop}=setup();const w=flour(shop,{purchaseAmount:36});odaItem(shop,w.id,{productId:64921});
 shop.importOrders({orders:[{orderNumber:'a',deliveryDate:'2026-03-01',currency:'NOK',grossAmount:1,products:[{product:{id:1,name:'x',description:'1 kg'},quantity:1,totalGrossAmount:'1.00'}]},{orderNumber:'b',deliveryDate:'2026-06-07',currency:'NOK',grossAmount:1,products:[{product:{id:1,name:'x',description:'1 kg'},quantity:1,totalGrossAmount:'1.00'}]},{orderNumber:'c',deliveryDate:'2026-09-13',currency:'NOK',grossAmount:1,products:[{product:{id:1,name:'x',description:'1 kg'},quantity:1,totalGrossAmount:'1.00'}]}]});
 const limit=shop.recordOdaLimit({productId:64921,validationMessages:['Dessverre tilbyr vi maks 2 stk Hvetemel per person.'],line:{product:{name:'Vår Hvetemel 1 kg'}}});assert.equal(limit.max,2);
 const row=shop.familyView().odaDraft.items[0];assert.equal(row.packs,2);assert.equal(row.wanted,3);assert.equal(row.maxAtOda,2);
 assert.equal(shop.recordOdaLimit({productId:5,validationMessages:[],line:null}).max,null);
});
test('the cart review warns per line about limits and better places',()=>{
 const {shop}=setup();const w=flour(shop);odaItem(shop,w.id,{price:30});withChain(shop,w,10);
 const cart={groups:[{items:[{product:{id:555,name:'Hvetemel'},quantity:10,totalGrossAmount:'300.00'},{product:{id:9,name:'Noe annet'},quantity:1,totalGrossAmount:'10.00'}]}],validationMessages:['Dessverre tilbyr vi maks 2 stk Hvetemel per person.'],totalGrossAmount:'310.00'};
 const review=shop.cartReview(cart);
 assert.equal(review.lines.length,2);assert.equal(review.lines[0].elsewhere.storeName,'Nærbutikk');assert.match(review.lines[0].limit,/maks 2/);assert.equal(review.lines[1].elsewhere,null);assert.equal(review.lines[1].limit,null);
});

test('the cheapest Oda variant is the default and a chosen variant is remembered',()=>{
 const {shop}=setup();orders(shop);const w=flour(shop);odaItem(shop,w.id,{id:1,price:20,productId:555});odaItem(shop,w.id,{id:2,price:60,pack:2,productId:777});
 let row=shop.familyView().odaDraft.items[0];assert.equal(row.productId,555);assert.deepEqual(row.variants.map(x=>x.productId),[555,777]);
 const listed=shop.list({action:'add',name:'mel'});assert.equal(listed.odaProductId,555);
 shop.list({action:'variant',watchId:w.id,productId:777});
 row=shop.familyView().odaDraft.items[0];assert.equal(row.productId,777);assert.equal(row.entryIds.length,1);
 const entry=shop.familyView().list.open[0];assert.equal(entry.odaProductId,777);assert.equal(entry.packAmount,2);assert.equal(entry.variants.length,2);
 assert.throws(()=>shop.list({action:'variant',watchId:w.id,productId:999}),/Varianten/);
});
test('urgent items only move between nearby stores when the gain is clear',()=>{
 const make=price=>{const {shop}=setup();const w=flour(shop,{purchaseAmount:60});withChain(shop,w,price);shop.watch({...shop.view().watches[0],priceGuide:{referencePrice:100,checkedAt:'2026-11-08T10:00:00Z',evidence:'Grunnlag'}});return shop;};
 assert.equal(make(95).list({action:'add',name:'mel',need:'now'}).storeName,'Nærmeste butikk');
 const moved=make(50).list({action:'add',name:'mel',need:'now'});assert.equal(moved.storeName,'Nærmeste butikk');assert.equal(moved.routing,null,'a flat historical market low is not a special trip saving');
 const unknown=make(50).list({action:'add',name:'Brokkoli',need:'now'});assert.equal(unknown.storeName,'Nærmeste butikk');assert.equal(unknown.routing,'pending');
});
test('product photos never reopen a review and are only served from stored addresses',()=>{
 const {shop}=setup();const w=flour(shop);odaItem(shop,w.id);
 const entry=shop.catalogEntries(w.id)[0];
 shop.catalogObserve({watchId:w.id,products:[{id:1,store:'ODA_NO',name:entry.name,image:'https://images.example.com/mel.jpg'}]});
 const after=shop.catalogEntries(w.id)[0];assert.equal(after.status,'approved');assert.equal(after.fingerprint,entry.fingerprint);assert.equal(after.image,'https://images.example.com/mel.jpg');
 const row=shop.familyView().odaDraft.items;const id=row.length?row[0].image:null;
 assert.equal(shop.familyView().items.find(x=>x.id===w.id).image,id);
 assert.equal(shop.imageSource('notstored'),null);if(id)assert.equal(shop.imageSource(id),'https://images.example.com/mel.jpg');
});

test('each cart line shows a cheaper Oda variant and the lowest known price',()=>{
 const {shop}=setup();const w=flour(shop);odaItem(shop,w.id,{id:1,price:20,productId:555});odaItem(shop,w.id,{id:2,price:40,productId:777});withChain(shop,w,18);
 const cart=lineId=>({groups:[{items:[{product:{id:lineId,name:'Hvetemel'},quantity:1,totalGrossAmount:'40.00'}]}],validationMessages:[],totalGrossAmount:'40.00'});
 let line=shop.cartReview(cart(777)).lines[0];
 assert.equal(line.unitPrice,40);assert.equal(line.cheaperVariant.productId,555);assert.equal(line.cheaperVariant.diffPct,50);assert.deepEqual(line.cheapestKnown,{storeName:'Nærbutikk',unitPrice:18});
 line=shop.cartReview(cart(555)).lines[0];assert.equal(line.cheaperVariant,null);assert.equal(line.cheapestKnown.unitPrice,18);
});

test('a store that is simply cheap is shown when stock is low and the gain is real',()=>{
 const make=(cheap,extra={})=>{const {shop}=setup();shop.settings({stores:[{id:'near',name:'Nærbutikk – Kassal-kjedepriser',url:'https://example.com/near',minSavings:0,chainCode:'SPAR_NO'}]});const w=flour(shop,extra);
  const products=[['SPAR_NO',9,cheap],['MENY_NO',10,100]];
  for(const [store,id,price] of products){const seen=shop.catalogObserve({watchId:w.id,products:[{id,store,name:'Mel 1 kg',currentPrice:price,lastChecked:'2026-11-08T10:00:00Z'}]});shop.catalogReview({watchId:w.id,id,store,fingerprint:seen.entries[0].fingerprint,status:'approved',packAmount:1,unit:'kg',equivalenceEvidence:'Samme mel'});}
  shop.market({watchId:w.id,products:products.map(([store,id,price])=>({id,store,unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme mel',lastChecked:'2026-11-08T11:00:00Z',currentPrice:price,history:history(100)}))});
  return {shop,w};};
 let {shop,w}=make(30);let [row]=shop.familyView().steady;
 assert.equal(shop.familyView().summary.potential,840);assert.equal(shop.familyView().summary.dealCount,1);assert.equal(shop.familyView().summary.top,'Mel');
 assert.equal(row.storeName,'Nærbutikk');assert.equal(row.packs,12);assert.equal(row.referencePrice,100);assert.equal(row.diffPct,70);assert.equal(row.saving,840);
 shop.pantry({watchId:w.id,amount:6});assert.equal(shop.familyView().steady.length,0);
 shop.pantry({watchId:w.id,amount:1});assert.equal(shop.familyView().steady[0].packs,11);
 assert.equal(shop.list({action:'add',watchId:w.id,packAmount:1,storeName:'Nærbutikk',packs:11,unitPrice:30,saving:385}).reason,'Fast lav pris');assert.equal(shop.familyView().steady.length,0);
 assert.equal(make(95).shop.familyView().steady.length,0);
 assert.equal(make(30,{purchaseAmount:1}).shop.familyView().steady.length,0);
 const capped=make(30,{maxPacks:2});assert.equal(capped.shop.familyView().steady[0].packs,2);
 const lower=make(30,{referenceCeiling:{price:20,checkedAt:'2026-11-08T10:00:00Z',sourceUrl:'https://example.com/lower',evidence:'Lavere bekreftet alternativ'}});assert.equal(lower.shop.familyView().steady.length,0);
});

test('a flat cheap history does not manufacture savings from expensive chains',()=>{
 const {shop}=setup();const w=flour(shop);withChain(shop,w,30);
 shop.market({watchId:w.id,products:[['SPAR_NO',9,30],['MENY_NO',10,100]].map(([store,id,currentPrice])=>({id,store,unit:'kg',packAmount:1,reviewed:true,equivalenceEvidence:'Samme mel',lastChecked:'2026-11-08T10:00:00Z',currentPrice,history:history(currentPrice)}))});
 assert.equal(shop.familyView().steady.length,0);
});

test('list routing preserves chosen variants and refuses bought, urgent or malformed Oda writes atomically',()=>{
 const {shop}=setup();const w=flour(shop);odaItem(shop,w.id,{id:1,productId:555});odaItem(shop,w.id,{id:2,productId:777,price:25});
 shop.list({action:'variant',watchId:w.id,productId:777});assert.equal(shop.list({action:'add',name:'Mel'}).odaProductId,777);
 const e=shop.list({action:'add',name:'Ukjent'}),before=shop.familyView().list.open;
 assert.throws(()=>shop.list({action:'route',id:e.id,storeName:'Oda',reason:'Pris',odaProductId:9,packs:1.5}),/mengde/);
 assert.deepEqual(shop.familyView().list.open,before);
 shop.list({action:'check',id:e.id});assert.throws(()=>shop.list({action:'route',id:e.id,storeName:'Oda',reason:'Pris',odaProductId:9,packs:1}),/kjøpt/);
 const urgent=shop.list({action:'add',name:'Haster',need:'now'});assert.throws(()=>shop.list({action:'route',id:urgent.id,storeName:'Oda',reason:'Pris',odaProductId:9,packs:1}),/nærbutikk/);
});
