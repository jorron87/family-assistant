import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHomeAssistant} from '../src/home-assistant.mjs';
const config=JSON.parse(readFileSync(new URL('./config/home-assistant.json',import.meta.url)));
function fixture(){let at=Date.now(),failed=false,saved=null;const calls=[];
 const states=config.entities.map(e=>({entity_id:e.id,state:e.group==='weather'?'10.8':e.group==='presence'?'home':e.group==='schedule'?'09:45:00':e.group==='vacuums'?'docked':'off',attributes:{latitude:59,longitude:10,battery_level:80,unit_of_measurement:'°C'}}));
 const fetchImpl=async(url,options)=>{calls.push({url,options});if(failed)throw Error('NETWORK FAILURE SECRET');return new Response(JSON.stringify(url.endsWith('/api/states')?states:[]),{status:200,headers:{'Content-Type':'application/json'}});};
 const adapter=createHomeAssistant({config,dataDir:'unused',readToken:()=> 'test-existing-key',writeToken:t=>{saved=t;},fetchImpl,now:()=>at});
 return {adapter,calls,fail(){failed=true;at+=16000;},advance(){at+=16000;},get saved(){return saved;}};
}
test('Home Assistant returns only selected entities and safe attributes; failures keep stale state',async()=>{
 const f=fixture();const state=await f.adapter.refresh();assert.equal(state.status,'ok');assert.equal(state.entities.length,12);assert.ok(!JSON.stringify(state).includes('latitude'));assert.ok(!JSON.stringify(state).includes('test-existing-key'));
 await f.adapter.refresh();assert.equal(f.calls.length,1);
 f.fail();const offline=await f.adapter.refresh();assert.equal(offline.stale,true);assert.equal(offline.entities.length,12);assert.equal(offline.checkedAt,state.checkedAt);assert.ok(!offline.message.includes('SECRET'));
 await assert.rejects(()=>f.adapter.command({entityId:'cover.forste_etasje',action:'open_cover'}),/utilgjengelig/);
});
test('Home Assistant service calls are restricted to configured entities and validated values',async()=>{
 const f=fixture();await f.adapter.refresh();
 await assert.rejects(()=>f.adapter.command({entityId:'lock.front_door',action:'unlock'}),/ikke del/);
 await assert.rejects(()=>f.adapter.command({entityId:'cover.forste_etasje',action:'unlock'}),/Ugyldig handling/);
 await assert.rejects(()=>f.adapter.command({entityId:'media_player.kino',action:'volume_set',value:2}),/Lydnivå/);
 await assert.rejects(()=>f.adapter.command({entityId:'input_datetime.stovsuging_pa_hverdager',action:'set_datetime',value:'25:99'}),/klokkeslett/);
 assert.equal(f.calls.length,1);
 await f.adapter.command({entityId:'media_player.kino',action:'volume_set',value:0.3,data:{entity_id:'lock.front_door'}});
 const request=f.calls.find(c=>c.options.method==='POST');assert.deepEqual(JSON.parse(request.options.body),{entity_id:'media_player.kino',volume_level:0.3});
 await f.adapter.command({action:'return_all'});const bulk=f.calls.find(c=>c.url.endsWith('/vacuum/return_to_base'));assert.deepEqual(JSON.parse(bulk.options.body).entity_id,config.entities.filter(e=>e.group==='vacuums').map(e=>e.id));
});
test('Home Assistant credential is checked before being saved and never returned to the browser',async()=>{
 const f=fixture();const credential='a-new-test-key-not-a-real-secret';const result=await f.adapter.connect(credential);assert.equal(f.saved,credential);assert.ok(!JSON.stringify(result).includes(credential));
 await assert.rejects(()=>f.adapter.connect('bad'),/Ugyldig/);
});
