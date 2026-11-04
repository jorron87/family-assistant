import test from 'node:test';
import assert from 'node:assert/strict';
import {createRefresh,fetchTimed,fetchOptional} from '../public/kiosk.mjs';

test('polls serialize, a queued force reload survives, and failure permits recovery',async()=>{
 const calls=[];let release;
 const refresh=createRefresh(async({force})=>{calls.push(force);if(calls.length===1)await new Promise(r=>release=r);});
 const first=refresh();assert.equal(refresh(),first);assert.equal(refresh({force:true}),first);
 assert.deepEqual(calls,[false]);release();await first;
 assert.deepEqual(calls,[false,true]);await refresh();assert.deepEqual(calls,[false,true,false]);
 let attempts=0;
 const failing=createRefresh(async()=>{if(++attempts===1)throw Error('offline');});
 await assert.rejects(failing(),/offline/);await failing();assert.equal(attempts,2);
});

test('requests have a timeout and optional diagnostics cannot reject the calendar refresh',async()=>{
 const previous=globalThis.fetch;
 try{
  globalThis.fetch=async(url,options)=>{assert.ok(options.signal instanceof AbortSignal);assert.equal(options.headers?.['If-None-Match'],'old');return {ok:true};};
  assert.equal((await fetchTimed('/api/state',{headers:{'If-None-Match':'old'}})).ok,true);
  globalThis.fetch=async()=>{throw Error('offline');};
  await assert.rejects(fetchTimed('/api/state'),/offline/);
  assert.equal(await fetchOptional('/api/session-maintenance'),null);
 }finally{globalThis.fetch=previous;}
});
