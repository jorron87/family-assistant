import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {createPhoneDispatcher} from '../src/phone-dispatch.mjs';
import {createIngestionDispatcher,changeSignal} from '../src/ingestion-dispatch.mjs';
import {shelfWithDate} from '../src/shopping-planning.mjs';

test('list routing stays queued without price monitoring and gives the third attempt real work',()=>{
 const state={};let at=Date.parse('2026-11-08T12:00:00Z');
 const shop=shoppingStore(state,{save(){},now:()=>new Date(at)}),entry=shop.list({action:'add',name:'Oppvaskbørste'});
 assert.equal(shop.queue()[0].do,'shopping-list-route');
 for(let i=1;i<=3;i++){shop.listRouteAttempt([entry.id]);assert.equal(shop.queue().length,1);assert.equal(shop.listRouteWork()[0].routeAttempts,i);shop.listRouteFinish([entry.id]);if(i<3){assert.ok(Date.parse(shop.listRouteWork()[0].routeRetryAt)>at);at+=301000;}}
 assert.equal(shop.queue().length,0);assert.equal(shop.completion().complete,false);assert.equal(shop.completion().blockedRoutes[0].id,entry.id);
 assert.equal(shop.familyView().list.open[0].routing,'blocked');
 shop.list({action:'remove',id:entry.id});assert.equal(shop.completion().complete,true);
});

test('a failed route backs off, survives restart, and never leaves a phantom synchronous worker',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-shopping-worker-'));let launch;
 try{
  const store=createStore(dir),entry=store.shopping.list({action:'add',name:'Børste'});
  let at=Date.now()+61000;
  const d=createPhoneDispatcher({store,root:dir,clock:()=>at,launch:input=>{launch=input;return {pid:2147483647};}});
  d.tick();assert.deepEqual(store.snapshot().phone.worker.routeIds,[entry.id]);
  const reopened=createStore(dir),restored=createPhoneDispatcher({store:reopened,root:dir,clock:()=>Date.now(),launch:()=>{throw Error('must back off');}});
  restored.tick();assert.equal(reopened.snapshot().runLease,null);assert.ok(reopened.shopping.listRouteWork()[0].routeRetryAt);
  // A launch failure callback can happen before launch returns its PID.
  const fresh=createStore(dir);fresh.shopping.list({action:'remove',id:entry.id});fresh.shopping.list({action:'add',name:'Ny børste'});
  const sync=createPhoneDispatcher({store:fresh,root:dir,clock:()=>at,launch:input=>{input.onExit(1);return {pid:1};}});
  sync.tick();assert.equal(sync.status().running,false);assert.equal(fresh.snapshot().phone.worker,null);assert.equal(fresh.snapshot().runLease,null);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('shopping wakes the shared dispatcher in its own scope and unfinished work cannot report ok',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-shopping-dispatch-'));let at=Date.now(),calls=[];
 try{
  const store=createStore(dir);store.shopping.settings({monitoringEnabled:true,stores:[{id:'shop',name:'Butikk',url:'https://example.com/flyer'}]});
  assert.equal(changeSignal(store).shoppingOnly,true);
  for(const scope of ['handel','kildeendringer','alle'])assert.throws(()=>store.recordRun({scope,outcome:'ok',summary:'Kontrollert'}),/restanser/);
  const d=createIngestionDispatcher({store,root:dir,dataDir:dir,clock:()=>at,readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{calls.push(input);return {pid:process.pid};}});
  d.tick();assert.equal(calls.length,1);assert.equal(d.status().workerScope,'handel');assert.match(calls[0].prompt,/shopping-product-review/);assert.match(calls[0].prompt,/completion.shopping/);
  store.shopping.review({storeId:'shop',status:'ok',evidence:'Gjennomgått alle sider i syntetisk avis',sourceUrl:'https://example.com/flyer',nextCheck:'2099-01-01'});
  store.recordRun({scope:'handel',outcome:'ok',summary:'Handel ferdig'});calls[0].onExit(0);assert.equal(store.snapshot().runLease,null);d.tick();assert.equal(calls.length,1);
  assert.equal(store.completionReport().shopping.complete,true);assert.equal(store.completionReport().complete,false,'shopping scope does not certify school coverage');
  store.shopping.review({storeId:'shop',status:'blocked',evidence:'Den eksterne avisen er utilgjengelig',sourceUrl:'https://example.com/flyer',nextCheck:'2099-01-01'});
  assert.throws(()=>store.recordRun({scope:'handel',outcome:'ok'}),/restanser/);
  store.shopping.settings({stores:[]});assert.equal(store.shopping.completion().complete,true,'removed stores do not block forever');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('feed receipts acknowledge only the versions actually read, including across restart',()=>{
 const state={collector:{items:{}}},shop=shoppingStore(state,{save(){}});
 shop.settings({monitoringEnabled:true,stores:[{id:'reko',name:'Gruppe',url:'https://example.com/group',facebookGroup:'synthetic'}]});
 const post=(id,token)=>({kind:'post',externalId:id,shoppingStoreId:'reko',token,text:'Egg',postedAt:new Date().toISOString()});
 state.collector.items.a=post('a','t1');const first=shop.feedFingerprint('reko');shop.feed({storeId:'reko'});
 state.collector.items.a.token='t2';assert.notEqual(shop.feedFingerprint('reko'),first,'same count with changed text must wake dispatch');state.collector.items.b=post('b','t1');
 const reopened=shoppingStore(structuredClone(state),{save(){}});
 assert.deepEqual(reopened.feed({storeId:'reko',ack:true,evidence:'Leste den første versjonen'}),{reviewed:0,remaining:2});
 assert.equal(reopened.view().reviews.length,0);reopened.feed({storeId:'reko'});assert.equal(reopened.feed({storeId:'reko',ack:true,evidence:'Leste begge gjeldende innlegg'}).remaining,0);
});

test('refreshing one group never clears other groups due today or changed approved metadata',()=>{
 let at=new Date('2026-11-08T12:00:00Z');const state={},shop=shoppingStore(state,{save(){},now:()=>at});
 shop.settings({monitoringEnabled:true,stores:[]});
 const a=shop.watch({name:'Mel',unit:'kg',storage:'pantry'}),b=shop.watch({name:'Sukker',unit:'kg',storage:'pantry'});
 state.shopping.watches[a.id].marketCalibration={checkedAt:at.toISOString(),status:'insufficient'};state.shopping.watches[b.id].marketCalibration={checkedAt:at.toISOString(),status:'insufficient'};
 at=new Date('2026-11-09T12:00:00Z');state.shopping.watches[a.id].marketCalibration.checkedAt=at.toISOString();
 assert.deepEqual(shop.queue().find(x=>x.do==='shopping-market-refresh').watchIds,[b.id]);
 state.shopping.watches[b.id].marketCalibration.checkedAt=at.toISOString();assert.equal(shop.queue().length,0);
 state.shopping.watches[b.id].marketCalibration.status='needs-review';assert.equal(shop.queue().length,1);
});

test('short-dated quantities cannot outlast the remaining days or resurrect expired goods',()=>{
 const at=Date.parse('2026-11-08T12:00:00Z');
 assert.equal(shelfWithDate(12,'2026-11-07',at),0);assert.ok(shelfWithDate(12,'2026-11-09',at)<.1);assert.equal(shelfWithDate(1,'2027-11-08',at),1);
});

test('new work arriving during the last attempt gets its own retry budget',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-shopping-new-work-'));let at=Date.now(),calls=[];
 try{
  const store=createStore(dir),one={id:'one',name:'Butikk en',url:'https://example.com/one'},two={id:'two',name:'Butikk to',url:'https://example.com/two'};
  store.shopping.settings({monitoringEnabled:true,stores:[one]});
  const d=createIngestionDispatcher({store,root:dir,dataDir:dir,clock:()=>at,readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{calls.push(input);return {pid:process.pid};}});
  for(let i=0;i<3;i++){d.tick();assert.equal(calls.length,i+1);if(i===2)store.shopping.settings({stores:[one,two]});calls[i].onExit(0);at+=121*60000;}
  d.tick();assert.equal(calls.length,4);calls[3].onExit(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
