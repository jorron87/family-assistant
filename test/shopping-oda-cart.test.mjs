import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOda} from '../src/oda.mjs';
import {createOdaCart} from '../src/shopping-oda-cart.mjs';
import {shoppingStore} from '../src/shopping.mjs';

function harness({drop=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'family-oda-cart-')),state={},shop=shoppingStore(state,{save(){}}),lines=new Map();let writes=0,reads=0;
 const cart=()=>({groups:[{items:[...lines].map(([id,quantity])=>({product:{id,name:'Vare '+id},quantity,totalGrossAmount:'10.00'}))}],validationMessages:[],totalGrossAmount:'10.00',url:'https://oda.com/no/cart/'});
 const client={connect:async()=>{},close:async()=>{},callTool:async({name,arguments:args})=>{
  if(name==='get_cart'){reads++;return {structuredContent:cart()};}
  if(name==='manipulate_cart'){writes++;if(drop)return {structuredContent:cart()};for(const op of args.operations){const next=Math.max(0,(lines.get(op.productId)??0)+op.quantity);if(next)lines.set(op.productId,next);else lines.delete(op.productId);}return {structuredContent:cart()};}
  throw Error('Unexpected tool');
 }};
 const oda=createOda({dataDir:dir,shopping:shop,redirectUrl:'http://127.0.0.1:1/cb',makeClient:()=>client,makeTransport:()=>({})});
 const live=createOdaCart({oda:Object.assign(Object.create(oda),{status:()=>({connected:true}),cart:oda.cart,changeCart:oda.changeCart,swapInCart:oda.swapInCart,addToCart:oda.addToCart}),shopping:shop});
 return {dir,shop,oda,live,lines,counts:()=>({writes,reads}),done:async()=>{await oda.close();rmSync(dir,{recursive:true,force:true});}};
}
const id=n=>'synthetic-request-'+String(n).padStart(4,'0');

test('the list shows the real cart and changes it both ways',async()=>{
 const h=harness();
 try{
  await h.oda.authorize();
  h.lines.set(7,2);
  let view=await h.live.read(true);assert.equal(view.connected,true);assert.deepEqual(view.lines.map(x=>[x.productId,x.quantity]),[[7,2]]);
  view=await h.live.change({requestId:id(1),productId:7,delta:3});assert.equal(h.lines.get(7),5);assert.equal(view.lines[0].quantity,5);
  view=await h.live.change({requestId:id(2),productId:7,delta:-5});assert.equal(h.lines.has(7),false);assert.equal(view.lines.length,0);
  h.lines.set(8,1);assert.equal((await h.live.read(true)).lines[0].productId,8);
  view=await h.live.swap({requestId:id(3),fromProductId:8,toProductId:9,quantity:2});assert.equal(h.lines.has(8),false);assert.equal(h.lines.get(9),2);
 }finally{await h.done();}
});
test('a repeated request does not write twice, and a change that does not land is never retried',async()=>{
 const ok=harness();
 try{
  await ok.oda.authorize();ok.lines.set(7,1);
  await ok.oda.changeCart({requestId:id(4),productId:7,delta:1});const before=ok.counts().writes;
  await ok.oda.changeCart({requestId:id(4),productId:7,delta:1});assert.equal(ok.counts().writes,before);assert.equal(ok.lines.get(7),2);
  await assert.rejects(ok.oda.changeCart({requestId:id(4),productId:8,delta:1}),/allerede brukt/);
  await assert.rejects(ok.oda.addToCart({requestId:id(4),productId:7,quantity:1}),/allerede brukt/);assert.equal(ok.counts().writes,before);
  await assert.rejects(ok.oda.changeCart({requestId:id(5),productId:7,delta:0}),/Ugyldig/);
 }finally{await ok.done();}
 const bad=harness({drop:true});
 try{
  await bad.oda.authorize();
  await assert.rejects(bad.oda.changeCart({requestId:id(6),productId:7,delta:1}),/bekreftes/);
  await assert.rejects(bad.oda.changeCart({requestId:id(6),productId:7,delta:1}),/kontrolleres/);
  assert.equal(bad.counts().writes,1);
 }finally{await bad.done();}
});
test('a list item that belongs at Oda goes into the cart instead of staying on the list',async()=>{
 const h=harness();
 try{
  await h.oda.authorize();
  h.shop.settings({stores:[]});
  const entry=h.shop.list({action:'add',name:'Oppvasktabletter'});
  const routed=await h.live.list({action:'route',id:entry.id,storeName:'Oda',reason:'Billigst',odaProductId:77,packs:2,packAmount:1,unit:'stk'});
  assert.equal(routed.inCart,true);assert.equal(h.lines.get(77),2);assert.equal(h.shop.familyView().list.open.length,0);
  const local=await h.live.list({action:'add',name:'Lys',need:'now'});assert.equal(local.inCart,undefined);assert.equal(h.shop.familyView().list.open.length,1);
  h.shop.recordOdaLimit({productId:88,validationMessages:['Dessverre tilbyr vi maks 2 stk Vare per person.'],line:{product:{name:'Vare 88'}}});
  const capped=h.shop.list({action:'add',name:'Sorteres'});
  assert.equal((await h.live.list({action:'route',id:capped.id,storeName:'Oda',reason:'Billigst',odaProductId:88,packs:9})).packs,2);assert.equal(h.lines.get(88),2);
 }finally{await h.done();}
});
test('an unconfirmed cart write stays visible on the list for the family to check',async()=>{
 const h=harness({drop:true});
 try{
  await h.oda.authorize();
  const entry=h.shop.list({action:'add',name:'Oppvasktabletter'});
  const result=await h.live.list({action:'route',id:entry.id,storeName:'Oda',reason:'Billigst',odaProductId:77,packs:1});
  assert.match(result.cartError,/Sjekk kurven/);assert.equal(h.shop.familyView().list.open[0].cartError,result.cartError);
 }finally{await h.done();}
});

test('a quantity probe restores only what actually changed and preserves existing cart contents',async()=>{
 for(const drop of [false,true]){
  const h=harness({drop});
  try{await h.oda.authorize();h.lines.set(7,2);const result=await h.oda.probeLimit({productId:7,quantity:10});assert.equal(h.lines.get(7),2);assert.equal(result.restored,true);assert.equal(h.counts().writes,drop?1:2);}
  finally{await h.done();}
 }
});
