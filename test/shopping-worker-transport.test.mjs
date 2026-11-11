import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerToolCaller} from '../src/shopping-worker-transport.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';
const result=r=>JSON.parse(r.content[0].text);
const options={endpoint:'http://127.0.0.1:1/worker',workerId:'worker-one',token:'synthetic-capability'};

test('read transport failures get one bounded retry with the same scoped request',async()=>{
 for(const name of ['shopping_context','shopping_read']){
  const calls=[],call=createWorkerToolCaller({...options,fetchRequest:async(endpoint,args)=>{calls.push({endpoint,...args});if(calls.length===1)throw new TypeError('Network failure');return {ok:true,json:async()=>({requiredPages:{},saved:false})};}});
  const r=await call(name,{kind:'group',groupId:'read-group'});assert.equal(calls.length,2);assert.equal(calls[0].body,calls[1].body);assert.deepEqual(result(r),{requiredPages:{},saved:false});assert.equal(r.isError,undefined);
 }
});

test('lost proposal/checkpoint responses never replay writes and never invent a policy stop',async()=>{
 for(const name of ['shopping_propose','shopping_checkpoint']){
  let calls=0;const call=createWorkerToolCaller({...options,fetchRequest:async()=>{calls++;throw Object.assign(new TypeError('secret-capability must not leak'),{cause:{code:'ECONNRESET'}});}});
  const r=await call(name,{proposalId:'proposal-original'}),d=result(r);assert.equal(calls,1);assert.equal(r.isError,true);assert.equal(d.error,'coordinator-result-unconfirmed');assert.equal(d.outcome,'unconfirmed');assert.equal(d.proposalId,'proposal-original');assert.equal(d.diagnostic.code,'ECONNRESET');assert.ok(!r.content[0].text.includes('secret-capability'));assert.ok(d.next.includes('Do not assume success or retry'));
 }
});

test('explicit domain denials and genuine safety decisions are returned verbatim without retry',async()=>{
 let calls=0;const denied={error:'Explicit tool safety stop',safetyStop:true},call=createWorkerToolCaller({...options,fetchRequest:async()=>{calls++;return {ok:false,status:403,json:async()=>denied};}});
 const r=await call('shopping_read',{kind:'group'});assert.equal(calls,1);assert.equal(r.isError,true);assert.deepEqual(result(r),denied);
});

test('exhausted read failures and malformed JSON stay bounded and carry no invented receipt',async()=>{
 let calls=0;const call=createWorkerToolCaller({...options,fetchRequest:async()=>{calls++;return {ok:true,json:async()=>{throw new SyntaxError('Invalid upstream response');}};}});
 const d=result(await call('shopping_context'));assert.equal(calls,2);assert.equal(d.error,'coordinator-read-unavailable');assert.equal(d.attempts,2);assert.equal(d.saved,undefined);assert.equal(d.outcome,undefined);
});

test('a real disconnected HTTP write is not repeated after the server commits it',async()=>{
 let writes=0;const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;assert.equal(JSON.parse(body).call,'shopping_propose');writes++;res.destroy();});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const call=createWorkerToolCaller({...options,endpoint:'http://127.0.0.1:'+server.address().port+'/worker'}),d=result(await call('shopping_propose',{proposalId:'committed-once'}));assert.equal(writes,1);assert.equal(d.error,'coordinator-result-unconfirmed');assert.equal(d.proposalId,'committed-once');assert.equal(d.saved,undefined);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('a real disconnected read retries once while an explicit policy response is preserved',async()=>{
 let reads=0;const server=createServer(async(req,res)=>{for await(const chunk of req){}reads++;if(reads===1){res.destroy();return;}res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Explicit tool safety stop',safetyStop:true}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const call=createWorkerToolCaller({...options,endpoint:'http://127.0.0.1:'+server.address().port+'/worker'}),r=await call('shopping_context');assert.equal(reads,2);assert.deepEqual(result(r),{error:'Explicit tool safety stop',safetyStop:true});assert.equal(r.isError,true);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
