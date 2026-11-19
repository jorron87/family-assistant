import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createServer} from 'node:http';
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
