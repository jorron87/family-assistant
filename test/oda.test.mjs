import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOda,cartQuantity} from '../src/oda.mjs';
import {shoppingStore} from '../src/shopping.mjs';

test('Oda cart additions are verified, idempotent and never replayed after an ambiguous failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-oda-'));const state={};const shop=shoppingStore(state,{save:()=>{}});let qty=2,mutations=0,fail=false;
 const cart=()=>({groups:[{items:[{product:{id:7},quantity:qty}]}],url:'https://oda.com/no/cart/'});
 const client={connect:async()=>{},close:async()=>{},callTool:async({name,arguments:args})=>{
  if(name==='get_cart')return {structuredContent:cart()};
  if(name==='manipulate_cart'){mutations++;qty+=args.operations[0].quantity;if(fail)throw Error('Timed out after delivery');return {structuredContent:cart()};}
  throw Error('Unexpected tool');
 }};
 const oda=createOda({dataDir:dir,shopping:shop,redirectUrl:'http://127.0.0.1:1/callback',makeClient:()=>client,makeTransport:()=>({})});
 try{
  await assert.rejects(oda.callback({state:'wrong',code:'x'}),/utløpt/);await oda.authorize();
  const input={requestId:'synthetic-request-001',productId:7,quantity:3};
  const result=await oda.addToCart(input);assert.equal(result.status,'confirmed');assert.equal(qty,5);
  assert.equal((await oda.addToCart(input)).status,'confirmed');assert.equal(mutations,1);
  await assert.rejects(oda.addToCart({...input,quantity:4}),/allerede brukt/);
  fail=true;const second={...input,requestId:'synthetic-request-002'};await assert.rejects(oda.addToCart(second),/ikke bekreftes/);await assert.rejects(oda.addToCart(second),/kontrolleres/);assert.equal(mutations,2);assert.equal(shop.receipt(second.requestId).status,'uncertain');
  assert.equal(cartQuantity(cart(),7),8);
 }finally{await oda.close();assert.ok(dir.startsWith(join(tmpdir(),'family-oda-')));rmSync(dir,{recursive:true,force:true});}
});
