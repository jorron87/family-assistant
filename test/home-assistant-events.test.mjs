import test from 'node:test';
import assert from 'node:assert/strict';
import {createHomeAssistant} from '../src/home-assistant.mjs';

test('persistent HA authentication and subscription discard stale/replayed/restored and unselected events across reconnect',()=>{
 let now=Date.now(),id=0;const timers=new Map(),connections=[];
 class Socket extends EventTarget{sent=[];constructor(){super();connections.push(this);}send(text){this.sent.push(JSON.parse(text));}emit(value){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)}));}close(){this.dispatchEvent(new Event('close'));}}
 const adapter=createHomeAssistant({config:{url:'http://homeassistant.test',entities:[]},dataDir:'unused',readToken:()=> 'server-secret',WebSocketImpl:Socket,now:()=>now,schedule:f=>{timers.set(++id,f);return id;},cancel:id=>timers.delete(id)});
 const events=[],states=[];const stop=adapter.watchEntities({entityIds:['binary_sensor.inngang_person'],onEvent:e=>events.push(e),onStatus:s=>states.push(s)});
 const auth=socket=>{socket.emit({type:'auth_required'});assert.deepEqual(socket.sent.at(-1),{type:'auth',access_token:'server-secret'});socket.emit({type:'auth_ok'});socket.emit({type:'result',id:1,success:true});};
 const event=(at,entity='binary_sensor.inngang_person',restored=false)=>({type:'event',id:1,event:{time_fired:new Date(at).toISOString(),data:{entity_id:entity,new_state:{state:'on',attributes:{restored}}}}});
 try{
  const first=connections[0];first.emit(event(now));assert.equal(events.length,0);auth(first);first.emit(event(now-1));first.emit(event(now,'other'));first.emit(event(now,undefined,true));assert.equal(events.length,0);
  first.emit(event(now));assert.equal(events.length,1);first.close();assert.equal(states.at(-1),'reconnecting');now+=10000;[...timers.values()].at(-1)();auth(connections[1]);
  connections[1].emit(event(now-10000));assert.equal(events.length,1);connections[1].emit(event(now));assert.equal(events.length,2);assert.equal(states.at(-1),'connected');
 }finally{stop();adapter.close();}
});
