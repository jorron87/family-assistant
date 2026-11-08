import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createKassal,kassalQuotes} from '../src/kassal.mjs';

test('Kassal price freshness uses the price receipt, never product updated_at',()=>{
 const now=new Date('2026-11-08T12:00:00Z');
 const item={id:1,name:'Synthetic staple',current_price:50,weight:500,weight_unit:'g',store:{code:'MENY_NO'},updated_at:now.toISOString(),price_history:[{price:50,date:'2024-01-01'}]};
 assert.equal(kassalQuotes({data:[item]},now)[0].fresh,false);
 const [fresh]=kassalQuotes({data:{ean:'12345678',products:[{...item,current_price:{price:40,date:'2026-11-08T10:00:00Z'}}]}},now);
 assert.equal(fresh.fresh,true);assert.equal(fresh.price,40);assert.equal(fresh.ean,'12345678');assert.deepEqual(fresh.pack,{amount:.5,unit:'kg'});assert.equal(fresh.scope,'chain');assert.equal(fresh.localAvailabilityVerified,false);
 assert.equal(kassalQuotes({data:[{...item,price_history:[]}]},now)[0].fresh,false);
});

test('Kassal credentials remain encrypted, fixed-origin requests do not follow redirects, and errors hide secrets',async()=>{
 const dataDir=mkdtempSync(join(tmpdir(),'family-kassal-test-')),encryptionKey=Buffer.alloc(32,7),token='synthetic-test-kassal-token';let request;
 try{
  const fetchImpl=async(url,options)=>{request={url,options};return {ok:true,json:async()=>({data:[],meta:{current_page:1,last_page:1}})};};
  const client=createKassal({dataDir,encryptionKey,fetchImpl});client.configure({apiKey:token});
  assert.ok(!readFileSync(join(dataDir,'kassal-api.json.enc')).includes(Buffer.from(token)));
  const restored=createKassal({dataDir,encryptionKey,fetchImpl});await restored.search({query:'Synthetic item',page:2});
  assert.equal(request.url.origin,'https://kassal.app');assert.equal(request.url.searchParams.get('unique'),'0');assert.equal(request.url.searchParams.get('page'),'2');assert.equal(request.options.redirect,'error');assert.equal(request.options.headers.Authorization,'Bearer '+token);
  assert.ok(!JSON.stringify(restored.status()).includes(token));
  assert.throws(()=>restored.ean({ean:'../bad'}),/EAN/);assert.throws(()=>restored.product({id:-1}),/ID/);
  const rejected=createKassal({dataDir,encryptionKey,fetchImpl:async()=>({ok:false,status:401})});await assert.rejects(rejected.search({query:'Synthetic'}),/avviste/);
  assert.ok(!JSON.stringify(rejected.status()).includes(token));
 }finally{assert.ok(dataDir.startsWith(join(tmpdir(),'family-kassal-test-')));rmSync(dataDir,{recursive:true,force:true});}
});
