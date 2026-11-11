import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createShoppingCoordinator} from '../src/shopping-coordinator.mjs';
import {planShoppingWorkers} from '../src/shopping-worker-contract.mjs';
import {buildAgentContext} from '../src/shopping-agent-context.mjs';
import {workerFinalSchema} from '../src/shopping-worker-runtime.mjs';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'family-worker-finalization-test-')),launches=[],dead=new Set(),lease={token:'synthetic-owned-lease'},queue=Array.from({length:21},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+(i+1),sourceFingerprint:'a'.repeat(64)}));
 const facts={families:()=>[{familyId:'synthetic-beans',name:'Whole coffee beans',familyFingerprint:'b'.repeat(64)}],sources:sourceKey=>({sourceKey,observation:{sourceFingerprint:'a'.repeat(64)}}),products:()=>null};
 const store={snapshot:()=>({runLease:lease}),shopping:{agentContext:assignment=>buildAgentContext(queue,assignment,facts)}},options={store,root:dir,dataDir:dir,endpoint:'http://127.0.0.1:1',launch:input=>{launches.push(input);return {pid:100+launches.length};},alive:pid=>!dead.has(pid)},coordinator=createShoppingCoordinator(options),plan=planShoppingWorkers(queue,2);
 coordinator.start({token:lease.token,batches:plan.batches});
 const writeFinal=value=>writeFileSync(join(launches[0].directory,'result.json'),JSON.stringify(value));
 return {dir,store,options,lease,launches,dead,coordinator,plan,writeFinal,close(){for(const w of launches){assert.ok(w.directory.startsWith(join(tmpdir(),'family-shopping-worker-')));rmSync(w.directory,{recursive:true,force:true});}assert.ok(dir.startsWith(join(tmpdir(),'family-worker-finalization-test-')));rmSync(dir,{recursive:true,force:true});}};
}
async function assertStopped(f,coordinator=f.coordinator){
 const status=coordinator.status();assert.equal(status.running,false);assert.ok(status.attention);assert.equal(status.last.code,1);assert.equal(status.last.slots[0].status,'safety-stop');assert.equal(status.last.slots[1].status,'cancelled');assert.equal(f.lease.token,'synthetic-owned-lease');
 for(const w of f.launches)await assert.rejects(coordinator.handle(w.workerId,w.token,'heartbeat',{}),/revoked/);
 assert.throws(()=>coordinator.start({token:f.lease.token,batches:f.plan.batches}),/attention/);
 return status;
}

test('a schema-valid short safety-stop reason revokes the whole wave without throwing or rereading domain state',async()=>{
 const f=fixture();try{const final={outcome:'safety-stop',summary:'Explicit tool safety stop.',reason:'Blocked'};assert.equal(workerFinalSchema.properties.reason.type,'string');f.writeFinal(final);f.store.shopping.agentContext=()=>{throw Error('No further domain read is permitted after the stop.');};assert.doesNotThrow(()=>f.launches[0].onExit(0));const status=await assertStopped(f);assert.equal(status.attention.reason,'Blocked');assert.doesNotThrow(()=>f.launches[0].onExit(0),'duplicate close callbacks cannot reopen or reprocess the stop');}finally{f.close();}
});

test('empty, non-string and oversized safety-stop explanations are safely bounded while preserving the stop',async()=>{
 for(const reason of ['', '  ',undefined,null,42,false,[],{unsafe:'untrusted object'},'x'.repeat(70000)]){const f=fixture();try{
  f.writeFinal({outcome:'safety-stop',summary:'Explicit tool safety stop.',reason});assert.doesNotThrow(()=>f.launches[0].onExit(0));const status=await assertStopped(f);assert.ok(status.attention.reason.length>0);assert.ok(status.attention.reason.length<=6000);
 }finally{f.close();}}
});

test('recovery consumes a persisted malformed-reason stop once and retains the suspension across another restart',async()=>{
 const f=fixture();try{f.writeFinal({outcome:'safety-stop',summary:'Explicit tool safety stop.',reason:{unexpected:'shape'}});writeFileSync(join(f.launches[0].directory,'exit.json'),JSON.stringify({code:0}));f.dead.add(101);const recovered=createShoppingCoordinator(f.options);assert.doesNotThrow(()=>recovered.tick());const stopped=await assertStopped(f,recovered);assert.match(stopped.attention.reason,/without a usable reason/);const again=createShoppingCoordinator(f.options);assert.doesNotThrow(()=>again.tick());await assertStopped(f,again);assert.equal(again.status().attention.at,stopped.attention.at);}finally{f.close();}
});
