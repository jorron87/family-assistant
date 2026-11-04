import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';

test('gateway preserves family requests, serves camera assets and gates automatic display',async()=>{
 const data=await mkdtemp(join(tmpdir(),'familien-doorbell-'));
 let familyPid=12345;
 const family=createServer(async(req,res)=>{const body=[];for await(const part of req)body.push(part);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/health'?{ok:true,service:'Familien',pid:familyPid}:{path:req.url,method:req.method,body:Buffer.concat(body).toString()}));});
 await new Promise(resolve=>family.listen(0,'127.0.0.1',resolve));
 const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const child=spawn(process.execPath,['scripts/doorbell-gateway.mjs'],{env:{...process.env,FAMILIEN_DATA_DIR:data,FAMILIEN_DOORBELL_PORT:String(port),FAMILIEN_DASHBOARD_PORT:String(family.address().port)},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let attempt=0;attempt<100;attempt++){try{ready=(await fetch(base+'/health')).ok;if(ready)break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.equal(ready,true,output);
  assert.equal((await (await fetch(base+'/health')).json()).pid,12345);
  familyPid=54321;
  assert.equal((await (await fetch(base+'/health')).json()).pid,54321,'kiosk detects family deployments through an unchanged gateway');
  assert.deepEqual(await (await fetch(base+'/api/state?view=dashboard')).json(),{path:'/api/state?view=dashboard',method:'GET',body:''});
  const post=await fetch(base+'/api/tasks/example',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"done":true}'});assert.equal((await post.json()).body,'{"done":true}');
  assert.match(await (await fetch(base+'/doorbell-view.mjs')).text(),/playDoorbellVideo/);
  assert.match(await (await fetch(base+'/doorbell.css')).text(),/doorbell-dialog/);
  const status=await (await fetch(base+'/api/doorbell/status')).json();assert.equal(status.automaticEnabled,false);assert.equal(status.activeVideoConnections,0);assert.equal(status.configured,false);
  assert.equal((await fetch(base+'/api/doorbell/frame',{method:'POST',body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/doorbell/unknown')).status,404);
 }finally{child.kill();await once(child,'exit');await new Promise(resolve=>family.close(resolve));await rm(data,{recursive:true,force:true});}
});
