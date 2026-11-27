import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('CLI help succeeds offline and advertises installed shopping interfaces to unattended agents',()=>{
 for(const args of [['--help'],['help'],[]]){const r=spawnSync(process.execPath,['src/cli.mjs',...args],{encoding:'utf8',windowsHide:true,env:{...process.env,FAMILIEN_API:'http://127.0.0.1:1'}});assert.equal(r.status,0,r.stderr);const h=JSON.parse(r.stdout);for(const command of ['shopping-agent-context','shopping-agent-guide','shopping-catalog','shopping-catalog-review','shopping-sesum-register','next','begin-run','run'])assert.ok(h.commands.includes(command),command);assert.ok(h.shoppingCommands.length>20);assert.match(h.shoppingStart,/commands are installed/);}
});

test('run help is specific, offline and cannot become a report write, including in a batch',async()=>{
 let requests=0;
 const server=createServer((req,res)=>{requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'unexpected-report'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cli=promisify(execFile),env={...process.env,FAMILIEN_API:'http://127.0.0.1:'+server.address().port};
 try{
  for(const args of [['run','--help'],['help','run'],['run','missing-input.json','--help']]){
   const h=JSON.parse((await cli(process.execPath,['src/cli.mjs',...args],{env,windowsHide:true})).stdout);
   assert.equal(h.usage,'node src/cli.mjs run FILE');assert.equal(h.reportSaved,false);assert.equal(h.id,undefined);
   assert.ok(h.required.includes('summary'));assert.match(h.scopes.kildeendringer,/never certifies global/);assert.match(h.lifecycle,/returned report id/);assert.equal(h.commands,undefined);
  }
  const batch=JSON.parse((await cli(process.execPath,['src/cli.mjs','batch',JSON.stringify([{cmd:'run',args:['--help']}])],{env,windowsHide:true})).stdout);
  assert.equal(batch.ok,true);assert.equal(batch.results[0].result.reportSaved,false);assert.equal(requests,0);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('source-item distinguishes archived raw reads from collected contents and rejects missing source before I/O',async()=>{
 const requests=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({url:req.url,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end('{}');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cli=promisify(execFile),env={...process.env,FAMILIEN_API:'http://127.0.0.1:'+server.address().port};
 try {
  for(const args of [['source-item','--help'],['help','source-item']]) {
   const h=JSON.parse((await cli(process.execPath,['src/cli.mjs',...args],{env,windowsHide:true})).stdout);
   assert.match(h.usage,/SOURCE EXTERNAL_ID/);assert.match(h.reads,/Previously imported raw/);assert.match(h.current,/collected EXTERNAL_ID/);
  }
  const batch=JSON.parse((await cli(process.execPath,['src/cli.mjs','batch',JSON.stringify([{cmd:'source-item',args:['--help']}])],{env,windowsHide:true})).stdout);
  assert.match(batch.results[0].result.current,/collected EXTERNAL_ID/);
  for(const args of [[],['spond:post:sample'],['spond','spond:post:sample','extra']])await assert.rejects(cli(process.execPath,['src/cli.mjs','source-item',...args],{env,windowsHide:true}),error=>/SOURCE EXTERNAL_ID/.test(error.stderr)&&/collected EXTERNAL_ID/.test(error.stderr));
  assert.equal(requests.length,0);
  await cli(process.execPath,['src/cli.mjs','source-item','spond','spond:post:sample'],{env,windowsHide:true});
  assert.deepEqual(requests,[{url:'/api/source-items',body:{source:'spond',externalIds:['spond:post:sample']}}]);
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('review and lease help are read-only, and malformed review invocations cannot acknowledge work',async()=>{
 const requests=[];
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,url:req.url,body:body?JSON.parse(body):null});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'actual-review-receipt'}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cli=promisify(execFile),env={...process.env,FAMILIEN_API:'http://127.0.0.1:'+server.address().port},dir=mkdtempSync(join(tmpdir(),'family-cli-review-'));
 try{
  for(const cmd of ['mark-reviewed','begin-run','renew-run','end-run']){
   for(const args of [[cmd,'--help'],['help',cmd]]){
    const h=JSON.parse((await cli(process.execPath,['src/cli.mjs',...args],{env,windowsHide:true})).stdout);
    assert.match(h.usage,new RegExp(cmd));assert.equal(h.commands,undefined);assert.equal(h.id,undefined);
    assert.equal(cmd==='mark-reviewed'?h.reviewSaved:h.leaseChanged,false);
   }
   const b=JSON.parse((await cli(process.execPath,['src/cli.mjs','batch',JSON.stringify([{cmd,args:['--help']}])],{env,windowsHide:true})).stdout);
   assert.equal(b.ok,true);assert.equal(cmd==='mark-reviewed'?b.results[0].result.reviewSaved:b.results[0].result.leaseChanged,false);
  }
  for(const args of [[],['vigilo','vigilo:news:example'],['-','{"source":"vigilo"}'],['missing.json']])await assert.rejects(cli(process.execPath,['src/cli.mjs','mark-reviewed',...args],{env,windowsHide:true}),e=>/help mark-reviewed/.test(e.stderr));
  assert.equal(requests.length,0);
  const item={source:'vigilo',surface:'example:news',externalId:'vigilo:news:example',rawId:'example-raw',relevance:'relevant',reviewNote:'Actually read and imported synthetic source.'},file=join(dir,'review.json');
  writeFileSync(file,'\uFEFF'+JSON.stringify([item]),'utf8');
  const receipt=JSON.parse((await cli(process.execPath,['src/cli.mjs','mark-reviewed',file],{env,windowsHide:true})).stdout);
  assert.equal(receipt[0].id,'actual-review-receipt');assert.deepEqual(requests,[{method:'POST',url:'/api/mark-reviewed',body:item}]);
 }finally{rmSync(dir,{recursive:true,force:true});await new Promise(resolve=>server.close(resolve));}
});

test('new-source intake guidance is offline and a real import returns the raw identity without implicit review',async()=>{
 const requests=[];const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({url:req.url,body:JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({item:{id:'imported-example',source:'vigilo',externalId:'vigilo:news:example',revision:1}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const cli=promisify(execFile),env={...process.env,FAMILIEN_API:'http://127.0.0.1:'+server.address().port},dir=mkdtempSync(join(tmpdir(),'family-cli-intake-'));
 try{
  for(const args of [['help','intake'],['intake','--help']]){const h=JSON.parse((await cli(process.execPath,['src/cli.mjs',...args],{env,windowsHide:true})).stdout);assert.equal(h.rawSaved,false);assert.equal(h.commands,undefined);assert.match(h.receipts,/item.id/);assert.deepEqual(h.example.findings,[]);}
  const b=JSON.parse((await cli(process.execPath,['src/cli.mjs','batch',JSON.stringify([{cmd:'intake',args:['--help']}])],{env,windowsHide:true})).stdout);assert.equal(b.ok,true);assert.equal(b.results[0].result.rawSaved,false);assert.equal(requests.length,0);
  const item={source:'vigilo',externalId:'vigilo:news:example',title:'Synthetic reminder',body:'Completely read synthetic source text',findings:[]},file=join(dir,'intake.json');writeFileSync(file,'\uFEFF'+JSON.stringify(item),'utf8');
  const saved=JSON.parse((await cli(process.execPath,['src/cli.mjs','intake',file],{env,windowsHide:true})).stdout);assert.equal(saved.item.id,'imported-example');assert.deepEqual(requests,[{url:'/api/raw',body:item}]);
 }finally{rmSync(dir,{recursive:true,force:true});await new Promise(resolve=>server.close(resolve));}
});
