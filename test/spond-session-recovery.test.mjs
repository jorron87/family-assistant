import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const script=readFileSync(new URL('../config/vigilo-keepalive/background.js',import.meta.url),'utf8');
function harness({health='unauthorized',page={},down=false,saved={},age=60000,probeAge,enabled=true,tabs=[]}={}) {
  const storage={spondSessionRecovery:saved},reloads=[];
  const current={sources:{spond:{health:{health,at:new Date(Date.now()-age).toISOString()},...(probeAge===undefined?{}:{probeAt:new Date(Date.now()-probeAge).toISOString()}),maxProbeAgeMinutes:20}}};
  const updated=[],created=[],woken=[];
  const chrome={
    storage:{local:{get:async()=>storage,set:async value=>Object.assign(storage,value)}},
    tabs:{reload:async id=>reloads.push(id),query:async()=>tabs,update:async(id,value)=>updated.push({id,...value}),create:async value=>created.push(value),sendMessage:async(id)=>{woken.push(id);return {ok:true};}},
    scripting:{executeScript:async input=>[{result:input.world==='MAIN'?true:{authenticated:true,ready:true,online:true,focused:false,drafts:false,dialog:false,...page}}]},
    alarms:{get:async()=>({periodInMinutes:1}),onAlarm:{addListener(){}}},
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
  };
  const fetch=async url=>{if(down)throw Error('local unavailable');return {ok:true,json:async()=>url.endsWith('/config')?{enabled}:current};};
  const api=runInNewContext(script+'\n({recoverSpond,inspectSpondPage,spondKeeper})',{chrome,fetch,URL,AbortSignal,setTimeout,clearTimeout});
  return {...api,reloads,storage,current,updated,created,woken};
}
const tab={id:7,status:'complete'};
test('one idle authenticated reload per rejected episode, even if retries change failure timestamp',async()=>{
  const app=harness();await app.recoverSpond(tab);
  app.current.sources.spond.health.at=new Date().toISOString();await app.recoverSpond(tab);
  assert.deepEqual(app.reloads,[7]);assert.equal(app.storage.spondSessionRecovery.active,true);
});
test('real later success ends episode, while hourly limit still prevents a reload loop',async()=>{
  const app=harness();await app.recoverSpond(tab);
  app.current.sources.spond.health={health:'ok',at:new Date(Date.now()+1).toISOString()};await app.recoverSpond(tab);
  assert.equal(app.storage.spondSessionRecovery.active,false);
  app.current.sources.spond.health={health:'unauthorized',at:new Date().toISOString()};await app.recoverSpond(tab);
  assert.deepEqual(app.reloads,[7]);
});
test('healthy, old failures, service outage and real login screen never trigger recovery',async()=>{
  for(const options of [{health:'ok'},{age:31*60000},{down:true},{page:{authenticated:false}},{saved:{active:true,at:Date.now()-7200000}}]){
    const app=harness(options);await app.recoverSpond(tab);assert.deepEqual(app.reloads,[]);
  }
});
test('focused tab, drafts, dialogs and unfinished page remain intact',async()=>{
  for(const page of [{focused:true},{drafts:true},{dialog:true},{online:false},{ready:false}]){
    const app=harness({page});await app.recoverSpond(tab);assert.deepEqual(app.reloads,[]);
  }
  const app=harness();await app.recoverSpond({...tab,frozen:true});await app.recoverSpond({...tab,status:'loading'});assert.deepEqual(app.reloads,[]);
});

test('stale successful receipts authorize one recovery, not repeated reloads or false recovery',async()=>{
  const app=harness({health:'ok',age:5*86400000,probeAge:5*86400000});
  await app.recoverSpond(tab);await app.recoverSpond(tab);
  assert.deepEqual(app.reloads,[7]);assert.equal(app.storage.spondSessionRecovery.reason,'stale_probe');
  assert.equal(app.storage.spondSessionRecovery.active,true);
  app.current.sources.spond.health={health:'ok',at:new Date(Date.now()+1).toISOString()};
  app.current.sources.spond.probeAt=new Date().toISOString();await app.recoverSpond(tab);
  assert.equal(app.storage.spondSessionRecovery.active,false);
});

test('paused collection, unknown probe and fresh probe never authorize stale recovery',async()=>{
  for(const options of [{enabled:false,probeAge:7200000},{probeAge:undefined},{probeAge:60000}]){
    const app=harness({health:'ok',age:7200000,...options});await app.recoverSpond(tab);assert.deepEqual(app.reloads,[]);
  }
  for(const page of [{focused:true},{drafts:true},{dialog:true},{authenticated:false},{online:false},{ready:false}]){
    const app=harness({health:'ok',age:7200000,probeAge:7200000,page});await app.recoverSpond(tab);assert.deepEqual(app.reloads,[]);
  }
});

test('keeper chooses the app before a pinned login landing and never touches a login-only tab',async()=>{
  const app=harness({health:'ok',tabs:[{id:3,url:'https://spond.com/landing/login/',pinned:true},{id:7,url:'https://spond.com/client',pinned:false}]});
  await app.spondKeeper();assert.equal(app.updated[0].id,7);assert.ok(app.woken.every(id=>id===7));assert.deepEqual(app.reloads,[]);
  const login=harness({tabs:[{id:3,url:'https://spond.com/landing/login/',pinned:true}]});
  await login.spondKeeper();assert.deepEqual(login.updated,[]);assert.deepEqual(login.woken,[]);assert.deepEqual(login.created,[]);assert.deepEqual(login.reloads,[]);
});
