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

test('a running supervisor publishes bounded tool timings without child arguments or results',{timeout:35000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-worker-supervisor-test-')),secret='SYNTHETIC_PRIVATE_LABEL_AND_CAPABILITY';
 const server=createServer((req,res)=>{req.resume();res.end('{}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));let child,closed;const finishSignal=join(dir,'finish.signal');
 try{
  const fake=join(dir,'fake.mjs');writeFileSync(fake,`import {existsSync} from 'node:fs';const item={id:'synthetic-call',type:'mcp_tool_call',tool:'shopping_read',arguments:{kind:'page',sourceKey:${JSON.stringify(secret)}},result:{content:[{text:${JSON.stringify(secret)}}]}};console.log(JSON.stringify({type:'item.started',item}));setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item})),20);process.stdin.resume();setTimeout(()=>process.exit(2),18000);setInterval(()=>{if(existsSync(${JSON.stringify(finishSignal)}))process.exit(0);},25);`);
  const file=join(dir,'worker.json');writeFileSync(file,JSON.stringify({executable:process.execPath,args:[fake],prompt:secret,deadlineMs:20000,model:'synthetic',reasoningEffort:'high'}));
  child=spawn(process.execPath,[resolve('src/shopping-worker-supervisor.mjs'),file],{windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_WORKER_ENDPOINT:'http://127.0.0.1:'+server.address().port,FAMILIEN_WORKER_ID:'synthetic-worker',FAMILIEN_WORKER_TOKEN:secret}});
  closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});let live;const until=Date.now()+12000;
  while(Date.now()<until){try{live=JSON.parse(readFileSync(join(dir,'metrics.json'),'utf8'));if(live.toolActivity?.kinds['read:page']?.calls)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal(live?.toolActivity.kinds['read:page'].calls,1);assert.equal(JSON.stringify(live).includes(secret),false);assert.doesNotThrow(()=>process.kill(child.pid,0),'metrics are available while the actual process is still alive');
  // The fixture exits only after the liveness assertion. A busy test runner
  // cannot race a fixed child-exit timer and mistake final metrics for live ones.
  writeFileSync(finishSignal,'Live metrics and process verified.');
  assert.equal(await closed,0);const exit=JSON.parse(readFileSync(join(dir,'exit.json'),'utf8'));assert.equal(exit.metrics.toolCalls,1);assert.equal(exit.metrics.toolActivity.kinds['read:page'].timedCalls,1);assert.ok(exit.metrics.toolActivity.kinds['read:page'].totalMs>=10);assert.equal(JSON.stringify(exit).includes(secret),false);
 }finally{
  // Even a failed assertion must stop the fixture through its owned handshake
  // and wait for close; killing only the supervisor can orphan its child/CWD.
  writeFileSync(finishSignal,'Cleanup');if(closed)await closed;
  server.closeAllConnections();await new Promise(r=>server.close(r));assert.ok(dir.startsWith(join(tmpdir(),'family-worker-supervisor-test-')));rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});
