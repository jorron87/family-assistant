import test from 'node:test';
import assert from 'node:assert/strict';
import {createShoppingMaintenance} from '../src/shopping-maintenance.mjs';

function fixture(kind='oda') {
  let finish,entered,reads=0;
  const waiting=new Promise(resolve=>{finish=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const lease={token:'another-agent-owns-this'},rows=[{id:'1',store:'KIWI',status:'approved',fingerprint:'current',packAmount:1,unit:'kg',equivalenceEvidence:'Actual fixed pack reviewed'}];
  const fail=()=>assert.fail('Deterministic reads must never acquire, renew or release an agent lease');
  const store={snapshot:()=>({runLease:lease}),beginRun:fail,renewRun:fail,endRun:fail,phone:{list:()=>[]},calendarActions:()=>[],shopping:{stockIntake:{work:()=>[]},odaRefreshPlan:()=>kind==='oda'?[{watchId:'beans'}]:[],marketRefreshPlan:()=>['beans'],catalogEntries:()=>structuredClone(rows),catalogObserve:()=>{},market:()=>({status:'ready'})}};
  const read=async()=>{reads++;entered();await waiting;};
  const oda={refreshPrices:async()=>{await read();return {families:1,results:[{refreshed:1}]};}};
  const kassal={status:()=>({configured:true}),product:async()=>{await read();return {data:{id:1,store:{code:'KIWI'},current_price:{price:25,date:'2026-11-10T12:00:00Z'}}};}};
  const maintenance=createShoppingMaintenance({store,oda,kassal,enabled:()=>true});
  return {store,lease,maintenance,started,finish,get reads(){return reads;}};
}

for(const kind of ['oda','market'])test(`${kind} maintenance proceeds beside an agent lease and prevents duplicate maintenance`,async()=>{
  const f=fixture(kind),running=f.maintenance.tick();await f.started;
  try {
    assert.equal(f.maintenance.status().running,true);
    await f.maintenance.tick();assert.deepEqual(await f.maintenance.runMarket(),{deferred:true,reason:'busy'});
    assert.equal(f.reads,1);assert.equal(f.store.snapshot().runLease,f.lease);
  } finally {f.finish();await running;}
  assert.equal(f.maintenance.status().running,false);assert.equal(f.maintenance.status().lastError,null);
  assert.equal(f.store.snapshot().runLease,f.lease);
  assert.equal(kind==='oda'?f.maintenance.status().lastResult.families:f.maintenance.status().lastResult.results[0].deferred,kind==='oda'?1:false);
});

test('automatic maintenance retains phone, calendar and stock priority',async()=>{
  for(const priority of ['phone','calendar','stock']){
    const f=fixture();
    if(priority==='phone')f.store.phone.list=()=>[{status:'queued'}];
    if(priority==='calendar')f.store.calendarActions=()=>[{}];
    if(priority==='stock')f.store.shopping.stockIntake.work=()=>[{}];
    await f.maintenance.tick();assert.equal(f.reads,0);assert.equal(f.maintenance.status().running,false);
  }
});
