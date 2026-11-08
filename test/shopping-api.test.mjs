import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('shopping stays private, kiosk actions are limited, and order state survives restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-shopping-api-')),port=14440,base=`http://127.0.0.1:${port}`;let child;
 async function start(){child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,FAMILIEN_CONFIG_DIR:resolve('test/config'),FAMILIEN_DATA_DIR:dir,FAMILIEN_PORT:String(port),FAMILIEN_NO_DISPATCH:'1'},stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server did not start');}
 const post=(url,input,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1',...headers},body:JSON.stringify(input)});
 try{
  await start();const input={orders:[{orderNumber:'synthetic-private-order',deliveryDate:'2026-10-01',currency:'NOK',grossAmount:80,products:[{product:{id:2,name:'Eksempelmat',description:'400 g'},quantity:2,totalGrossAmount:'80.00'}]}]};
  assert.equal((await post(base+'/api/shopping/orders',input,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await post(base+'/api/shopping/orders',input)).status,200);
  const summary=await (await fetch(base+'/api/shopping')).json();assert.equal(summary.analysis.orderCount,1);assert.equal(summary.oda.connected,false);
  const state=await (await fetch(base+'/api/state')).json();assert.equal(state.shopping,undefined);
  const kiosk=`http://127.0.0.1:${port+1}`,mobile=`http://127.0.0.1:${port+2}`;
  for(const path of ['/shopping-setup','/api/shopping/oda/callback','/api/shopping/orders'])assert.ok([403,405].includes((await fetch(kiosk+path)).status));
  for(const path of ['settings','orders','offer','review','nutrition','market','oda/connect','kassal/configure','kassal/search','kassal/stores','kassal/ean','kassal/product','kassal/history'])assert.equal((await post(kiosk+'/api/shopping/'+path,{})).status,405);
  assert.equal((await post(base+'/api/shopping/kassal/configure',{apiKey:'synthetic-test-kassal-token'},{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await post(base+'/api/shopping/kassal/configure',{apiKey:'synthetic-test-kassal-token'})).status,200);
  assert.ok(!JSON.stringify(await(await fetch(base+'/api/shopping')).json()).includes('synthetic-test-kassal-token'));
  assert.notEqual((await fetch(mobile+'/api/shopping')).status,200);
  for(const path of ['/shopping-view.mjs','/shopping.css'])assert.equal((await fetch(kiosk+path)).status,200);
  assert.equal((await post(kiosk+'/api/shopping/watch',{name:'Følg pris',productKeys:[],unit:'stk',storage:'other',targetPrice:100})).status,200);
  const exited=new Promise(r=>child.once('exit',r));assert.equal((await post(base+'/api/maintenance/restart',{})).status,202);await exited;await start();
  assert.equal((await (await fetch(base+'/api/shopping')).json()).analysis.orderCount,1);
  assert.equal((await (await fetch(base+'/api/shopping')).json()).kassal.configured,true);
 }finally{if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}assert.ok(dir.startsWith(join(tmpdir(),'family-shopping-api-')));rmSync(dir,{recursive:true,force:true});}
});
