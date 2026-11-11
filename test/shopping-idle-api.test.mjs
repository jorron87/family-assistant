import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('real dispatcher HTTP requests remain idle without phantom run reports or absent-lease cleanup across restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-shopping-idle-')),config=join(dir,'config'),base='http://127.0.0.1:14920';let child,errors='';
 cpSync(resolve('test/config'),config,{recursive:true});
 const collector=JSON.parse(readFileSync(join(config,'collector.json')));collector.dispatch.enabled=true;writeFileSync(join(config,'collector.json'),JSON.stringify(collector));
 const start=async()=>{
  child=spawn(process.execPath,['src/server.mjs'],{env:{...process.env,FAMILIEN_CONFIG_DIR:config,FAMILIEN_DATA_DIR:join(dir,'data'),FAMILIEN_PORT:'14920',FAMILIEN_NO_DISPATCH:'1'},stdio:['ignore','ignore','pipe'],windowsHide:true});
  child.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-8000);});
  for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}
  throw Error('Isolated idle server failed to start: '+errors);
 };
 const stop=async()=>{const owned=child;child=null;if(owned?.exitCode===null&&owned.signalCode===null){const done=new Promise(r=>owned.once('exit',r));owned.kill();await done;}};
 try{
  for(let restart=0;restart<2;restart++){
   await start();const initial=await(await fetch(base+'/health')).json();
   for(let i=0;i<3;i++){
    const response=await fetch(base+'/api/ingestion/dispatcher/shopping',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:'{}'}),status=await response.json();
    assert.equal(response.status,200,JSON.stringify(status));assert.equal(status.enabled,true);assert.equal(status.running,false);
    assert.equal((await(await fetch(base+'/api/state')).json()).runLease??null,null);
    assert.deepEqual(await(await fetch(base+'/api/runs')).json(),[]);
    assert.equal((await(await fetch(base+'/health')).json()).pid,initial.pid);
   }
   await stop();
  }
 }finally{await stop();assert.ok(dir.startsWith(join(tmpdir(),'family-shopping-idle-')));rmSync(dir,{recursive:true,force:true});}
});
