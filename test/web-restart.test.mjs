import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
