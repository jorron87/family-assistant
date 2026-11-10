import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {createOda} from '../src/oda.mjs';
import {checkedOdaPrice,odaPriceRefreshPlan,createOdaPriceOverlay} from '../src/oda-price-refresh.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {productTextHash} from '../src/product-library.mjs';

const NOW='2026-11-10T12:00:00Z',OLD='2026-11-07T12:00:00Z';
const product=(id=701)=>({id,name:'Synthetic plain oil',description:'1 l',price:'29.00',unitPrice:'29.00',unitName:'liter',url:`https://oda.com/no/products/${id}-synthetic/`,availability:{isAvailable:true,code:'available'}});
function fixture(){
 const state={},clock={at:NOW},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),odaConnected:()=>true});
 shop.settings({monitoringEnabled:true,stores:[]});shop.watch({id:'plain-oil',name:'Plain oil',unit:'l',storage:'pantry',purchaseAmount:12});
 const row=shop.catalogObserve({watchId:'plain-oil',query:'plain oil',products:[{id:'51',store:'ODA_NO',name:'Synthetic plain oil 1 l',brand:'Synthetic',ingredients:'Refined oil',weight:1,weightUnit:'l',sourceUrl:'https://oda.com/no/products/701-synthetic/',currentPrice:30,lastChecked:OLD}]}).entries[0];
 shop.catalogReview({watchId:'plain-oil',id:'51',store:'ODA_NO',fingerprint:row.fingerprint,status:'approved',packAmount:1,unit:'l',equivalenceEvidence:'Complete synthetic refined oil ingredients and fixed litre package.'});
 return {shop,state,clock};
}
test('known Oda products with old prices create agent refresh work rather than manual family choice',()=>{
 const {shop,state}=fixture(),before=shop.catalogEntries()[0],view=shop.familyView();
 assert.equal(view.odaDraft.items.length,0);assert.deepEqual(view.odaDraft.missing,[]);assert.equal(view.odaDraft.refresh[0].watchId,'plain-oil');
 assert.ok(shop.queue().some(x=>x.do==='shopping-oda-refresh'&&x.watchId==='plain-oil'));
 const plan=shop.odaRefreshPlan()[0],result=shop.odaRefreshReceive({plan,receipts:[{product:product(),observedAt:NOW}],observedAt:NOW,searchComplete:false});
 assert.equal(result.refreshed,1);assert.deepEqual(result.unresolved,[]);assert.equal(shop.catalogEntries()[0].fingerprint,before.fingerprint);assert.deepEqual(shop.catalogEntries()[0].review,before.review,'a price refresh never rewrites product metadata or its equivalence review');assert.equal(shop.catalogEntries()[0].currentPrice,29);assert.equal(Date.parse(shop.catalogEntries()[0].lastChecked),Date.parse(NOW));
 const after=shop.familyView().odaDraft;assert.equal(after.items[0].productId,701);assert.equal(after.items[0].unitPrice,29);assert.deepEqual(after.missing,[]);assert.deepEqual(after.refresh,[]);assert.equal(shop.odaRefreshPlan().length,0);
});
test('related hits, unavailable products, failed reads and missing exact SKUs remain explicit blockers without new prices',()=>{
 for(const [products,error] of [[[product(999)],null],[[{...product(),availability:{isAvailable:false}}],null],[[],'Read failed']]){
  const {shop,state}=fixture(),plan=shop.odaRefreshPlan()[0];
  const result=shop.odaRefreshReceive({plan,receipts:products.map(product=>({product,observedAt:NOW})),observedAt:error?null:NOW,searchComplete:!error,searchError:error});
  assert.equal(result.unresolved.length,1);assert.equal(shop.familyView().odaDraft.items.length,0);assert.equal(shop.familyView().odaDraft.missing.length,0);assert.equal(shop.odaRefreshPlan().length,0,'a future retry is quiet');
  assert.equal(shop.completion().blockedOda.length,1,'a quiet retry is still incomplete');
  if(error||products[0].id===999)assert.equal(Object.keys(state.shopping.odaPriceReceipts).length,0);
 }
});
test('price receipt timestamps expire normally and metadata/family races invalidate a refresh plan',()=>{
 const {shop,clock,state}=fixture(),plan=shop.odaRefreshPlan()[0];
 shop.odaRefreshReceive({plan,receipts:[{product:product(),observedAt:NOW}],observedAt:NOW,searchComplete:true});
 clock.at='2026-11-13T12:00:00Z';assert.equal(shop.familyView().odaDraft.items.length,0);assert.equal(shop.familyView().odaDraft.refresh.length,1);
 const next=shop.odaRefreshPlan()[0];state.shopping.watches['plain-oil'].note='A newly selected exact variant is required.';
 assert.throws(()=>shop.odaRefreshReceive({plan:next,receipts:[],observedAt:clock.at,searchComplete:true}),/endret/);
});
test('a remembered variant with a stale price is not silently replaced by a dearer fresh native SKU',()=>{
 const {shop,state}=fixture(),row=shop.catalogObserve({watchId:'plain-oil',products:[{id:'52',store:'ODA_NO',name:'Synthetic alternative oil 1 l',sourceUrl:'https://oda.com/no/products/702-alternative/',currentPrice:80,lastChecked:NOW}]}).entries[0];
 shop.catalogReview({watchId:'plain-oil',id:'52',store:'ODA_NO',fingerprint:row.fingerprint,status:'approved',packAmount:1,unit:'l',equivalenceEvidence:'Synthetic reviewed alternative with the same ingredients and use.'});
 state.shopping.odaChoices['plain-oil']=701;
 assert.equal(shop.familyView().odaDraft.items.length,0);assert.equal(shop.familyView().odaDraft.refresh[0].reason,'chosen-variant-needs-refresh');assert.equal(state.shopping.odaChoices['plain-oil'],701);
 const plan=shop.odaRefreshPlan()[0];shop.odaRefreshReceive({plan,receipts:[{product:product(),observedAt:NOW}],observedAt:NOW,searchComplete:true});
 assert.equal(shop.familyView().odaDraft.items[0].productId,701);
});
test('refresh selection retains parking and explicit metadata approvals',()=>{
 const entry={watchId:'oil',id:'51',store:'ODA_NO',status:'approved',fingerprint:'fixture',name:'Oil',sourceUrl:'https://oda.com/no/products/701-oil/',packAmount:1,unit:'l',lastChecked:OLD,currentPrice:30};
 const args={entries:[entry],watches:[{id:'oil',name:'Oil',unit:'l'}],prices:[],at:Date.parse(NOW)};
 assert.equal(odaPriceRefreshPlan(args).length,1);
 assert.equal(odaPriceRefreshPlan({...args,horizonDays:2}).length,0);
 for(const patch of [{status:'excluded'},{status:'pending'},{store:'KIWI'},{lastChecked:'2025-01-01T00:00:00Z'},{sourceUrl:'https://prices.example.test/products/701-oil/'}])assert.equal(odaPriceRefreshPlan({...args,entries:[{...entry,...patch}]}).length,0);
 assert.equal(odaPriceRefreshPlan({...args,watches:[{...args.watches[0],enabled:false}]}).length,0);
});
test('MCP prices require exact identity, reviewed package arithmetic, matching units and explicit availability',()=>{
 const expected={odaProductId:701,packAmount:1,unit:'l',sourceUrl:'https://oda.com/no/products/701-oil/'};
 assert.equal(checkedOdaPrice(expected,product()).ok,true);
 for(const patch of [{id:999},{url:'https://oda.com/no/products/999-wrong/'},{url:'https://other.example.test/products/701-oil/'},{price:'NaN'},{unitName:'kilogram'},{unitPrice:'14.50'},{availability:null}])assert.equal(checkedOdaPrice(expected,{...product(),...patch}).ok,false,JSON.stringify(patch));
});
test('Oda MCP refresh paginates actual searches, targets known IDs only and never calls cart tools',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'oda-price-refresh-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'oda-price-refresh-')));rmSync(dir,{recursive:true,force:true});});
 const {shop}=fixture(),calls=[],client={connect:async()=>{},close:async()=>{},callTool:async({name,arguments:args})=>{
  calls.push({name,args});assert.equal(name,'product_search');
  return {structuredContent:{result:[{query:'plain oil',hasMore:args.page===1,products:args.page===1?[product(999)]:[product()]}]}};
 }};
 const oda=createOda({dataDir:dir,shopping:shop,redirectUrl:'http://127.0.0.1:1/callback',now:()=>new Date(NOW),makeClient:()=>client,makeTransport:()=>({})});
 await oda.authorize();try{const result=await oda.refreshPrices();assert.equal(result.families,1);assert.equal(result.results[0].refreshed,1);assert.deepEqual(calls.map(c=>c.args.page),[1,2]);assert.equal(shop.familyView().odaDraft.items[0].productId,701);}finally{await oda.close();}
});
test('an Oda MCP read failure records a bounded retry and cannot create a fresh price',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'oda-price-failure-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'oda-price-failure-')));rmSync(dir,{recursive:true,force:true});});
 const {shop,state}=fixture(),client={connect:async()=>{},close:async()=>{},callTool:async()=>{throw Error('Synthetic connection error');}};
 const oda=createOda({dataDir:dir,shopping:shop,redirectUrl:'http://127.0.0.1:1/callback',now:()=>new Date(NOW),makeClient:()=>client,makeTransport:()=>({})});
 await oda.authorize();try{const result=await oda.refreshPrices();assert.ok(result.results[0].searchError);assert.equal(shop.completion().blockedOda.length,1);assert.equal(Object.keys(state.shopping.odaPriceReceipts).length,0);}finally{await oda.close();}
});
test('an old failed refresh stops blocking when newer actual price evidence resolves its gap',()=>{
 const {shop}=fixture(),plan=shop.odaRefreshPlan()[0];
 shop.odaRefreshReceive({plan,receipts:[],observedAt:NOW,searchComplete:true});assert.equal(shop.completion().blockedOda.length,1);
 shop.catalogObserve({watchId:'plain-oil',products:[{id:'51',store:'ODA_NO',name:'Synthetic plain oil 1 l',currentPrice:28,lastChecked:NOW}]});
 assert.equal(shop.odaRefreshPlan().length,0);assert.equal(shop.completion().blockedOda.length,0);assert.equal(shop.familyView().odaDraft.items[0].unitPrice,28);
});
test('equal-time conflicting prices or availability stay held until a genuinely newer receipt',()=>{
 for(const change of [{price:'28.00',unitPrice:'28.00'},{availability:{isAvailable:false}}]){
  const {shop,clock}=fixture(),plan=shop.odaRefreshPlan()[0];
  shop.odaRefreshReceive({plan,receipts:[{product:product(),observedAt:NOW}],observedAt:NOW,searchComplete:true});
  const next=shop.odaRefreshPlan({force:true})[0],result=shop.odaRefreshReceive({plan:next,receipts:[{product:{...product(),...change},observedAt:NOW}],observedAt:NOW,searchComplete:true});
  assert.equal(result.unresolved[0].reason,'conflicting-latest-prices');assert.equal(shop.familyView().odaDraft.items.length,0);
  clock.at='2026-11-10T12:01:00Z';const newer=shop.odaRefreshPlan({force:true})[0];shop.odaRefreshReceive({plan:newer,receipts:[{product:product(),observedAt:clock.at}],observedAt:clock.at,searchComplete:true});
  assert.equal(shop.familyView().odaDraft.items[0].unitPrice,29);assert.equal(shop.completion().blockedOda.length,0);
 }
});
test('superseded available or unavailable receipts cannot change the effective result or retry',()=>{
 for(const available of [true,false]){
  const {shop}=fixture(),plan=shop.odaRefreshPlan()[0];
  shop.odaRefreshReceive({plan,receipts:[{product:{...product(),availability:{isAvailable:available}},observedAt:NOW}],observedAt:NOW,searchComplete:true});
  const prior=shop.completion().blockedOda[0]?.retryAt??null,next=shop.odaRefreshPlan({force:true})[0];
  const result=shop.odaRefreshReceive({plan:next,receipts:[{product:{...product(),availability:{isAvailable:!available}},observedAt:'2026-11-10T11:59:00Z'}],observedAt:NOW,searchComplete:true});
  assert.equal(result.refreshed,0);assert.equal(result.unresolved.length,available?0:1);assert.equal(shop.completion().blockedOda[0]?.retryAt??null,prior);
  assert.equal(shop.familyView().odaDraft.items.length,available?1:0);
 }
});
test('multiple search pages use the newest actual receipt and ignore JSON property order',()=>{
 const {shop}=fixture(),plan=shop.odaRefreshPlan()[0],same=Object.fromEntries(Object.entries(product()).reverse());
 const result=shop.odaRefreshReceive({plan,receipts:[{product:{...product(),price:'20.00',unitPrice:'20.00'},observedAt:'2026-11-10T11:59:00Z'},{product:product(),observedAt:NOW},{product:same,observedAt:NOW}],observedAt:NOW,searchComplete:true});
 assert.equal(result.refreshed,1);assert.deepEqual(result.unresolved,[]);assert.equal(shop.familyView().odaDraft.items[0].unitPrice,29);
 const entry=shop.catalogEntries()[0];shop.catalogReview({watchId:entry.watchId,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',packAmount:1.0000000000000002,unit:'l',equivalenceEvidence:'The same fixed litre package with harmless floating point noise.'});
 assert.equal(shop.familyView().odaDraft.items[0].unitPrice,29);
});
test('shared library prices use the verified Oda receipt with tolerant canonical packs and strict metadata guards',()=>{
 const {shop,state,clock}=fixture(),entry=shop.catalogEntries()[0],key='kassal:ODA_NO:51';
 const p={store:'ODA_NO',id:'51',name:entry.name,brand:entry.brand,ingredients:entry.ingredients,sourceUrl:entry.sourceUrl,pack:1.0000000000000002,unit:'l',textHash:productTextHash(entry),rawPack:{weight:entry.weight,weightUnit:entry.weightUnit},available:true,quote:{grossPackPrice:30,grossUnitPrice:null,receiptAt:OLD,reasons:[],sourceUrl:entry.sourceUrl}};
 const index={builtAt:NOW,products:{[key]:p},groups:{oil:{name:'Synthetic oil',unit:'l'}},members:{oil:[{k:key,u:30,s:'approved',r:true,q:null}]}};
 const read=createIndexReader(index),records={};records[entry.key]={fingerprint:entry.fingerprint,odaProductId:701,packAmount:1,unit:'l',observedAt:NOW,price:29,available:true,sourceUrl:entry.sourceUrl};
 const overlay=createOdaPriceOverlay({receipts:()=>records,entries:()=>shop.catalogEntries(),now:()=>new Date(clock.at)});
 assert.equal(overlay(read(Date.parse(NOW))).quote(key).price.grossPackPrice,29);assert.equal(overlay(read(Date.parse(NOW))).members('oil')[0].unitPrice,29/p.pack);
 p.rawPack.weight=2;assert.equal(overlay(read(Date.parse(NOW))).quote(key).price.grossPackPrice,30,'real source package mismatches cannot borrow a price');p.rawPack.weight=1;
 records[entry.key].available=false;assert.equal(overlay(read(Date.parse(NOW))).members('oil')[0].eligible,false);
 clock.at='2026-11-13T12:00:00Z';assert.equal(overlay(read(Date.parse(clock.at))).quote(key).price.fresh,false);
 assert.deepEqual(state.shopping.odaChoices,{});
});

test('a busy Oda connection defers background refresh without a failed price or extra tool call',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'oda-price-busy-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'oda-price-busy-')));rmSync(dir,{recursive:true,force:true});});
 const {shop,state}=fixture();let release,started,calls=0;
 const entered=new Promise(resolve=>{started=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
 const client={connect:async()=>{},close:async()=>{},callTool:async()=>{calls++;started();await waiting;return {structuredContent:{result:[{query:'plain oil',hasMore:false,products:[product()]}]}};}};
 const oda=createOda({dataDir:dir,shopping:shop,redirectUrl:'http://127.0.0.1:1/callback',now:()=>new Date(NOW),makeClient:()=>client,makeTransport:()=>({})});
 await oda.authorize();try{
  const first=oda.search({query:'plain oil'});await entered;
  assert.deepEqual(await oda.refreshPrices(),{families:0,results:[],deferred:true,reason:'oda-busy',retryAfterMs:1000});
  assert.equal(calls,1);assert.equal(Object.keys(state.shopping.odaPriceReceipts).length,0);assert.equal(Object.keys(state.shopping.odaRefreshAttempts).length,0);
  release();await first;
 }finally{release();await oda.close();}
});
