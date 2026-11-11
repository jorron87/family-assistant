import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createShoppingHostActivity,hostWorkGrace} from '../src/shopping-worker-liveness.mjs';

function fixture(t){const dir=mkdtempSync(join(tmpdir(),'family-worker-liveness-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'family-worker-liveness-')));rmSync(dir,{recursive:true,force:true});});return dir;}

test('busy-host grace is tied to the exact run, live host and an absolute ninety-second limit',t=>{
 const dir=fixture(t);let at=100000;const activity=createShoppingHostActivity({dataDir:dir,pid:123,now:()=>at});activity.publish({runId:'synthetic-run',activeRequests:1});
 const args={file:activity.file,runId:'synthetic-run',hostPid:123,lastHeartbeat:100000,alive:()=>true};
 assert.equal(hostWorkGrace({...args,at:140000}),true);assert.equal(hostWorkGrace({...args,at:190001}),false);
 at=190000;activity.publish({runId:'synthetic-run',activeRequests:1});assert.equal(hostWorkGrace({...args,at:190001}),false,'a new busy record cannot extend the absolute limit');
 for(const patch of [{runId:'another-run'},{hostPid:456},{alive:()=>false},{file:join(dir,'missing')},{at:99999}])assert.equal(hostWorkGrace({...args,at:190000,...patch}),false);
 writeFileSync(activity.file,'invalid JSON');assert.equal(hostWorkGrace({...args,at:140000}),false);
});

test('recent completion gives pending real heartbeats a short turn; inactive or stale records do not keep workers alive',t=>{
 const dir=fixture(t);let at=100000;const activity=createShoppingHostActivity({dataDir:dir,pid:123,now:()=>at}),args={file:activity.file,runId:'synthetic-run',hostPid:123,lastHeartbeat:100000,alive:()=>true};activity.publish({runId:'synthetic-run',activeRequests:0});
 assert.equal(hostWorkGrace({...args,at:109999}),true);assert.equal(hostWorkGrace({...args,at:110001}),false);
 at=150000;activity.publish({runId:'synthetic-run',activeRequests:1});assert.equal(hostWorkGrace({...args,at:149999}),false);
 activity.slow({kind:'worker/shopping_propose/placement',startedAt:145000});const log=JSON.parse(readFileSync(join(dir,'shopping-worker-slow-operations.jsonl'),'utf8'));assert.equal(log.elapsedMs,5000);assert.deepEqual(Object.keys(log).sort(),['at','elapsedMs','kind','pid']);
});

async function supervisor(t,{revoke=false}={}){
 const dir=fixture(t),runId='synthetic-heartbeat-run',activity=createShoppingHostActivity({dataDir:dir});activity.publish({runId,activeRequests:1});
 let count=0;const pending=new Set(),server=createServer((req,res)=>{req.resume();count++;if(revoke){res.writeHead(403);res.end('{}');return;}if(count===1){res.end(JSON.stringify({active:true,hostPid:process.pid,runId}));return;}pending.add(res);res.once('close',()=>pending.delete(res));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const release=setTimeout(()=>{server.removeAllListeners('request');server.on('request',(req,res)=>{req.resume();res.end(JSON.stringify({active:true,hostPid:process.pid,runId}));});for(const res of pending)if(!res.destroyed)res.end(JSON.stringify({active:true,hostPid:process.pid,runId}));},36000);t.after(()=>clearTimeout(release));
 const spec={executable:process.execPath,args:['-e','process.stdin.resume();setTimeout(()=>process.exit(0),42000)'],prompt:'Synthetic liveness-only child, no product work.',deadlineMs:55000,model:'synthetic',reasoningEffort:'high',activityPath:activity.file,runId,hostPid:process.pid};writeFileSync(join(dir,'worker.json'),JSON.stringify(spec));
 const child=spawn(process.execPath,['src/shopping-worker-supervisor.mjs',join(dir,'worker.json')],{windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_WORKER_ENDPOINT:`http://127.0.0.1:${server.address().port}`,FAMILIEN_WORKER_ID:'synthetic-worker',FAMILIEN_WORKER_TOKEN:'synthetic-capability'}});t.after(()=>child.kill());
 const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});return {code,exit:JSON.parse(readFileSync(join(dir,'exit.json'),'utf8'))};
}

test('a real supervisor survives a thirty-six-second unresponsive host with verified active work',{timeout:60000},async t=>{const result=await supervisor(t);assert.equal(result.code,0);assert.equal(result.exit.error,null);assert.ok(result.exit.metrics.hostBusyGraceUses>0);});
test('an explicit capability revocation is immediate even when the host busy record is valid',{timeout:10000},async t=>{const result=await supervisor(t,{revoke:true});assert.notEqual(result.code,0);assert.equal(result.exit.error,'Worker capability revoked.');});
