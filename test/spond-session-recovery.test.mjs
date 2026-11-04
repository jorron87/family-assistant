import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const script=readFileSync(new URL('../config/vigilo-keepalive/background.js',import.meta.url),'utf8');
function harness({health='unauthorized',page={},down=false,saved={},age=60000}={}) {
  const storage={spondSessionRecovery:saved},reloads=[];
  const current={sources:{spond:{health:{health,at:new Date(Date.now()-age).toISOString()}}}};
  const chrome={
    storage:{local:{get:async()=>storage,set:async value=>Object.assign(storage,value)}},
    tabs:{reload:async id=>reloads.push(id)},
    scripting:{executeScript:async()=>[{result:{authenticated:true,ready:true,online:true,focused:false,drafts:false,dialog:false,...page}}]},
    alarms:{get:async()=>({periodInMinutes:1}),onAlarm:{addListener(){}}},
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
  };
  const fetch=async()=>{if(down)throw Error('local unavailable');return {ok:true,json:async()=>current};};
  const api=runInNewContext(script+'\n({recoverSpond,inspectSpondPage})',{chrome,fetch,URL,AbortSignal,setTimeout,clearTimeout});
  return {...api,reloads,storage,current};
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
