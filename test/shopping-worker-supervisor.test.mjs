import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
test('a supervisor revokes only its own child when the coordinator rejects its capability',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-worker-supervisor-test-'));let heartbeats=0;
 const server=createServer((req,res)=>{heartbeats++;assert.equal(req.headers['x-family-worker'],'synthetic-private-capability');res.writeHead(403);res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const file=join(dir,'worker.json');writeFileSync(file,JSON.stringify({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],prompt:'Synthetic isolated heartbeat test',deadlineMs:5000,model:'synthetic',reasoningEffort:'high'}));const child=spawn(process.execPath,[resolve('src/shopping-worker-supervisor.mjs'),file],{windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_WORKER_ENDPOINT:'http://127.0.0.1:'+server.address().port,FAMILIEN_WORKER_ID:'synthetic-worker',FAMILIEN_WORKER_TOKEN:'synthetic-private-capability'}}),code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,1);assert.ok(heartbeats>0);const text=readFileSync(join(dir,'exit.json'),'utf8'),exit=JSON.parse(text);assert.equal(exit.error,'Worker capability revoked.');assert.equal(text.includes('synthetic-private-capability'),false);assert.ok(exit.metrics.elapsedMs<10000);
 }finally{await new Promise(r=>server.close(r));assert.ok(dir.startsWith(join(tmpdir(),'family-worker-supervisor-test-')));rmSync(dir,{recursive:true,force:true});}
});
