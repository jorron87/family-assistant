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

test('a running supervisor publishes bounded tool timings without child arguments or results',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-worker-supervisor-test-')),secret='SYNTHETIC_PRIVATE_LABEL_AND_CAPABILITY';
 const server=createServer((req,res)=>{req.resume();res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let child;
 try{
  const fake=join(dir,'fake.mjs');writeFileSync(fake,`const item={id:'synthetic-call',type:'mcp_tool_call',tool:'shopping_read',arguments:{kind:'page',sourceKey:${JSON.stringify(secret)}},result:{content:[{text:${JSON.stringify(secret)}}]}};console.log(JSON.stringify({type:'item.started',item}));setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item})),20);process.stdin.resume();setTimeout(()=>process.exit(0),6200);`);
  const file=join(dir,'worker.json');writeFileSync(file,JSON.stringify({executable:process.execPath,args:[fake],prompt:secret,deadlineMs:10000,model:'synthetic',reasoningEffort:'high'}));
  child=spawn(process.execPath,[resolve('src/shopping-worker-supervisor.mjs'),file],{windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_WORKER_ENDPOINT:'http://127.0.0.1:'+server.address().port,FAMILIEN_WORKER_ID:'synthetic-worker',FAMILIEN_WORKER_TOKEN:secret}});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});let live;
  for(let i=0;i<60;i++){try{live=JSON.parse(readFileSync(join(dir,'metrics.json'),'utf8'));if(live.toolActivity?.kinds['read:page']?.calls)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(live?.toolActivity.kinds['read:page'].calls,1);assert.equal(JSON.stringify(live).includes(secret),false);assert.doesNotThrow(()=>process.kill(child.pid,0),'metrics are available while the actual process is still alive');
  assert.equal(await closed,0);const exit=JSON.parse(readFileSync(join(dir,'exit.json'),'utf8'));assert.equal(exit.metrics.toolCalls,1);assert.equal(exit.metrics.toolActivity.kinds['read:page'].timedCalls,1);assert.ok(exit.metrics.toolActivity.kinds['read:page'].totalMs>=10);assert.equal(JSON.stringify(exit).includes(secret),false);
 }finally{if(child?.exitCode===null)child.kill();server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(dir.startsWith(join(tmpdir(),'family-worker-supervisor-test-')));rmSync(dir,{recursive:true,force:true});}
});
