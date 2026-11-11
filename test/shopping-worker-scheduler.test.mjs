import test from 'node:test';
import assert from 'node:assert/strict';
import {createShoppingWorkerScheduler} from '../src/shopping-worker-scheduler.mjs';

test('a burst of worker requests gives heartbeats and other event-loop callbacks a turn',async()=>{
 const scheduler=createShoppingWorkerScheduler(),events=[];
 const jobs=Array.from({length:80},(_,i)=>scheduler.run({execute:()=>{events.push('work-'+i);return i;}}));
 const pulse=new Promise(resolve=>setImmediate(()=>{events.push('incoming-heartbeat');scheduler.run({heartbeat:true,execute:()=>{events.push('heartbeat-served');resolve();}});}));
 await pulse;assert.equal(events.filter(x=>x.startsWith('work-')).length,1);assert.ok(events.indexOf('heartbeat-served')<events.indexOf('work-2')||!events.includes('work-2'));
 assert.deepEqual(await Promise.all(jobs),Array.from({length:80},(_,i)=>i));
});

test('a disconnected queued write never runs, and failures do not poison later requests',async()=>{
 const callbacks=[],scheduler=createShoppingWorkerScheduler({defer:fn=>callbacks.push(fn)});let connected=true,revoked=false,writes=0;
 const gone=scheduler.run({isConnected:()=>connected,execute:()=>{writes++;}});connected=false;
 const stopped=scheduler.run({execute:()=>{if(revoked)throw Error('Capability revoked');writes++;}});revoked=true;
 const next=scheduler.run({execute:()=>42});
 const noWrite=assert.rejects(gone,/disconnected/),noRevokedWrite=assert.rejects(stopped,/revoked/);
 await callbacks.shift()();await noWrite;await callbacks.shift()();await noRevokedWrite;await callbacks.shift()();
 assert.equal(await next,42);assert.equal(writes,0);
});

test('queue backpressure never queues a rejected operation and heartbeats bypass it',async()=>{
 const callbacks=[],scheduler=createShoppingWorkerScheduler({defer:fn=>callbacks.push(fn),maxQueued:1});let rejectedRan=false;
 const first=scheduler.run({execute:()=>1});
 await assert.rejects(scheduler.run({execute:()=>{rejectedRan=true;}}),/busy/);
 assert.equal(await scheduler.run({heartbeat:true,execute:()=>true}),true);
 await callbacks.shift()();assert.equal(await first,1);assert.equal(rejectedRan,false);
});
