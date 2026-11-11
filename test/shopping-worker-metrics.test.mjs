import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerToolMetrics} from '../src/shopping-worker-metrics.mjs';

test('timings distinguish internal reads from overlapping web work without summing parallel time twice',()=>{
 let at=0;const m=createWorkerToolMetrics({now:()=>at}),event=(type,id,kind,extra={})=>m.consume({type,item:{id,type:kind,...extra}});
 at=100;event('item.started','read','mcp_tool_call',{tool:'shopping_read',arguments:{kind:'research'}});
 at=200;event('item.started','web','web_search');at=400;event('item.completed','read','mcp_tool_call',{tool:'shopping_read',arguments:{kind:'research'}});
 at=500;event('item.completed','web','web_search');at=600;event('item.completed','write','mcp_tool_call',{tool:'shopping_propose',arguments:{operation:'placement'}});
 const s=m.snapshot();assert.equal(s.firstToolAfterMs,100);assert.equal(s.toolWallMs,400);assert.equal(s.pendingTimedCalls,0);
 assert.deepEqual(s.kinds['read:research'],{calls:1,errors:0,timedCalls:1,totalMs:300,maxMs:300});assert.equal(s.kinds.web.totalMs,300);assert.equal(s.kinds['propose:placement'].timedCalls,0,'completion without start is explicitly untimed');
});

test('source text and arbitrary item/tool names cannot become telemetry keys or values',()=>{
 let at=0;const m=createWorkerToolMetrics({now:()=>at}),secret='SYNTHETIC_PRIVATE_SOURCE_CONTENT';
 for(const type of ['item.started','item.completed'])for(const item of [{id:'a',type:'mcp_tool_call',tool:'shopping_context',arguments:{section:secret,sourceKey:secret}},{id:'b',type:'mcp_tool_call',tool:secret,arguments:{[secret]:secret},error:{message:secret}},{id:'c',type:secret,text:secret},{id:'d',type:'constructor',arguments:{kind:secret}},{id:'e',type:'mcp_tool_call',tool:'shopping_read',arguments:{kind:secret}},{id:'f',type:'mcp_tool_call',tool:'shopping_propose',arguments:{operation:secret}}]){at++;m.consume({type,item:{...item,result:{content:[{text:secret}]}}});}
 const s=m.snapshot(),encoded=JSON.stringify(s);assert.equal(encoded.includes(secret),false);assert.deepEqual(Object.keys(s.kinds).sort(),['context:page:other','mcp:other','other','propose:other','read:other'].sort());assert.equal(s.kinds['mcp:other'].errors,1);
});

test('repeated starts and completions do not inflate paired timings and messages are not tools',()=>{
 let at=0;const m=createWorkerToolMetrics({now:()=>at}),item={id:'same',type:'mcp_tool_call',tool:'shopping_checkpoint'};
 at=10;m.consume({type:'item.started',item});at=20;m.consume({type:'item.started',item});at=30;m.consume({type:'item.completed',item});at=50;m.consume({type:'item.completed',item});
 for(const type of ['agent_message','reasoning'])m.consume({type:'item.completed',item:{id:type,type}});
 assert.equal(m.snapshot().kinds.checkpoint.calls,1);assert.equal(m.snapshot().kinds.checkpoint.totalMs,20);assert.equal(m.snapshot().toolWallMs,20);
});

test('live snapshots preserve open-call uncertainty and cannot mutate future counters',()=>{
 let at=0;const m=createWorkerToolMetrics({now:()=>at}),item={id:'open',type:'mcp_tool_call',tool:'shopping_context',arguments:{refresh:true}};
 at=10;m.consume({type:'item.started',item});at=40;const live=m.snapshot();assert.equal(live.pendingTimedCalls,1);assert.equal(live.toolWallMs,30);assert.deepEqual(live.kinds,{});
 at=60;m.consume({type:'item.completed',item:{...item,result:{isError:true}}});const s=m.snapshot();s.kinds['context:refresh'].calls=999;assert.equal(m.snapshot().kinds['context:refresh'].calls,1);assert.equal(m.snapshot().kinds['context:refresh'].errors,1);assert.equal(m.snapshot().toolWallMs,50);
});
