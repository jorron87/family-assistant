import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

test('graceful web restart preserves active ingestion and family edits',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-restart-'));
 let child;
 const start=async()=>{
  child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,FAMILIEN_PORT:'14318',FAMILIEN_DATA_DIR:dir},stdio:'ignore'});
  for(let i=0;i<100;i++){
   try{const r=await fetch('http://127.0.0.1:14318/health');if(r.ok)return;}catch{}
   await new Promise(r=>setTimeout(r,100));
  }
  throw Error('Test server did not start');
 };
 try{
  const lease=createStore(dir).beginRun().lease;
  await start();
  const base='http://127.0.0.1:14318';
  const session=await (await fetch(base+'/api/session-maintenance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({health:'ok',code:'authenticated',version:'1.2.0',intervalSeconds:60,keeperTabId:42})})).json();
  assert.equal(session.keeperTabId,42);
  assert.equal((await fetch(base+'/api/profile/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'saveFact',memberId:'family',text:'Test under innhenting',category:'routine'})})).status,200);
  assert.equal((await fetch('http://127.0.0.1:14319/api/maintenance/restart',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/maintenance/restart',{method:'POST'})).status,403);
  const exited=new Promise(r=>child.once('exit',r));
  const restartResponse=await fetch(base+'/api/maintenance/restart',{method:'POST',headers:{'X-Family-Request':'1'}});
  const restartBody=await restartResponse.json();
  assert.equal(restartResponse.status,202,JSON.stringify(restartBody));
  await exited;
  await start();
  const sessionHistory=await (await fetch(base+'/api/session-maintenance/history')).json();
  assert.equal(sessionHistory.status.checkedAt,session.checkedAt);
  assert.equal(sessionHistory.events.length,1);
  assert.equal(sessionHistory.status.upgradeRequired,false);
  const state=await (await fetch(base+'/api/state')).json();
  assert.equal(state.runLease.token,lease.token);
  assert.ok(state.profile.facts.some(f=>f.text==='Test under innhenting'));
  assert.equal((await (await fetch(base+'/api/run-lock',{method:'POST'})).json()).acquired,false);
 }finally{
  if(child?.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
  assert.ok(dir.startsWith(join(tmpdir(),'familien-restart-')));rmSync(dir,{recursive:true,force:true});
 }
});

async function launch(t,port,env) {
 const dir=mkdtempSync(join(tmpdir(),'familien-restart-')),child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,FAMILIEN_PORT:String(port),FAMILIEN_DATA_DIR:dir,FAMILIEN_NO_DISPATCH:'1',...env},stdio:'ignore'}),exited=new Promise(r=>child.once('exit',r));
 t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;
 for(let i=0;i<300;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const restart=()=>fetch(base+'/api/maintenance/restart',{method:'POST',headers:{'X-Family-Request':'1'}});
 const hang=()=>new Promise(resolve=>{const socket=net.connect(port,'127.0.0.1',()=>{socket.write('POST /api/shopping/review HTTP/1.1\r\nHost: x\r\nX-Family-Request: 1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{');resolve(socket);});socket.on('error',()=>{});});
 return {base,child,exited,restart,hang};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const within=(promise,ms)=>Promise.race([promise.then(()=>true),sleep(ms).then(()=>false)]);

test('a slow request postpones a restart and the service keeps running',async t=>{
 const s=await launch(t,14351,{FAMILIEN_RESTART_BUSY_MS:'200'}),socket=await s.hang();
 await sleep(500);
 const refused=await s.restart();assert.equal(refused.status,409);assert.equal((await refused.json()).busy,1);
 assert.equal((await fetch(s.base+'/health')).status,200,'nothing has been closed');
 socket.destroy();await sleep(200);
 assert.equal((await s.restart()).status,202);assert.equal(await within(s.exited,8000),true);
});

test('a client that keeps sending requests over one socket cannot hold the drain open',async t=>{
 const s=await launch(t,14354,{FAMILIEN_RESTART_DRAIN_MS:'60000'}),agent=new http.Agent({keepAlive:true,maxSockets:1});let running=true;
 t.after(()=>{running=false;agent.destroy();});
 const once=()=>new Promise(resolve=>{const req=http.get(s.base+'/health',{agent},res=>{res.resume();res.on('end',resolve);});req.on('error',resolve);});
 (async()=>{while(running){await once();await sleep(20);}})();
 await sleep(300);
 assert.equal((await s.restart()).status,202);
 assert.equal(await within(s.exited,8000),true);
});

test('a request that never ends cannot hold an accepted restart open',async t=>{
 const s=await launch(t,14357,{FAMILIEN_RESTART_BUSY_MS:'60000',FAMILIEN_RESTART_DRAIN_MS:'400'}),socket=await s.hang();
 t.after(()=>socket.destroy());
 await sleep(100);
 assert.equal((await s.restart()).status,202);
 assert.equal(await within(s.exited,8000),true);
});
