import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const script=readFileSync(new URL('../config/vigilo-keepalive/collector-sesum.js',import.meta.url),'utf8');
const module={exports:{}};
runInNewContext(script,{module,URL,AbortSignal,TextEncoder,TextDecoder,setTimeout,Date});
const collector=module.exports,ORIGIN=collector.ORIGIN;
const search=id=>({id:`search:${id}`,kind:'search',url:`${ORIGIN}/sok?q=family${id}`});
const product={id:'detail:1',kind:'product',url:`${ORIGIN}/produkt/123-synthetic-tomatoes`};
const htmlResponse=(extra={})=>({ok:true,url:product.url,headers:{get:key=>key==='content-type'?'text/html; charset=utf-8':null},text:async()=>'<html>synthetic source only</html>',...extra});
function harness({jobs=[product],fetchPage,core}={}) {
  let at=Date.parse('2026-11-09T12:00:00Z');
  const receipts=[],calls=[],state={},queue=[...jobs];
  const parser=core??{parseProduct:(_html,sourceUrl)=>({ok:true,kind:'product',sourceUrl,product:{id:123},prices:[]}),parseSearch:(_html,sourceUrl)=>({ok:true,kind:'search',sourceUrl,productUrls:[],nextUrls:[],endReached:true})};
  const server=async(path,method,body)=>{
    if(path===collector.WORK){assert.equal(method,'GET');return {enabled:true,runId:'run:1',jobs:queue.slice(0,4),limits:{cycleCalls:4,minSpacingMs:2000}};}
    assert.equal(path,collector.RECEIVE);assert.equal(method,'POST');receipts.push(structuredClone(body));
    const index=queue.findIndex(job=>job.id===body.jobId);if(index>=0)queue.splice(index,1);return {ok:true};
  };
  const run=()=>collector.runCycle({core:parser,server,state,now:()=>at,sleep:async ms=>{at+=ms;},fetchPage:async(url,options)=>{calls.push({url,options,at});return fetchPage?fetchPage(url,options):htmlResponse({url});}});
  return {run,receipts,calls,state,queue,advance:ms=>{at+=ms;}};
}
test('all followed families resume across bounded ticks without a pilot or product cap',async()=>{
  const h=harness({jobs:Array.from({length:91},(_,i)=>search(i+1))});
  let ticks=0;while(h.queue.length){const result=await h.run();assert.ok(result.calls<=4);ticks++;}
  assert.equal(ticks,23);assert.equal(h.receipts.length,91);assert.equal(new Set(h.receipts.map(r=>r.jobId)).size,91);
  for(let i=1;i<h.calls.length;i++)assert.ok(h.calls[i].at-h.calls[i-1].at>=2000,'server spacing applies across faster page ticks');
  for(const {options} of h.calls){assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'error');assert.deepEqual(Object.keys(options.headers),['Accept']);}
  assert.ok(h.receipts.every(r=>r.status==='ok'&&r.result.endReached===true));
  assert.ok(h.receipts.every(r=>r.collectorVersion==='sesum-collector-1.7.0'),'successful browser work identifies its actual installed collector');
  assert.ok(h.receipts.every(r=>r.collectorBuild==='sesum-collector-build-1.7.0-3'));
  assert.equal(JSON.stringify(h.receipts).includes('synthetic source only'),false,'raw HTML is never relayed');
});
test('only exact Sesum product and ordinary search routes are fetched',async()=>{
  for(const [url,kind] of [[ORIGIN+'/sok?q=tomat','search'],[product.url,'product']])assert.equal(collector.allowedUrl(url,kind),true);
  for(const url of ['https://sesum.no/sok?q=x','https://www.sesum.no.other.example/sok?q=x',ORIGIN+'/api/admin',ORIGIN+'/sok',ORIGIN+'/sok?q=x#secret',ORIGIN+'/sok?q=x&q=y',ORIGIN+'/sok?q=x&admin=1',ORIGIN+'/sok?q=x&side=-1',Object.assign(new URL('https://www.sesum.no/sok?q=x'),{username:'synthetic-user',password:'synthetic-password'}).href,'http://www.sesum.no/sok?q=x'])assert.equal(collector.allowedUrl(url,'search'),false,url);
  assert.equal(collector.allowedUrl(ORIGIN+'/sok?q=x&side=2','search'),true);assert.equal(collector.allowedUrl(ORIGIN+'/produkt/0-invalid','product'),false);assert.equal(collector.allowedUrl(product.url+'?private=1','product'),false);
  const h=harness({jobs:[{...product,url:'https://evil.example/produkt/123-secret'}]});await h.run();
  assert.equal(h.calls.length,0);assert.equal(h.receipts[0].error.code,'invalid_job');
  assert.equal(h.receipts[0].collectorVersion,'sesum-collector-1.7.0');
  assert.equal(h.receipts[0].collectorBuild,'sesum-collector-build-1.7.0-3');
});
test('authentication rejection stops the cycle and pauses ordinary reads',async()=>{
  const h=harness({jobs:[product,search(2)],fetchPage:async()=>htmlResponse({ok:false,status:403})});
  const result=await h.run();assert.equal(result.reason,'auth_required');assert.equal(h.calls.length,1);assert.equal(h.receipts[0].error.retryAfterMs,600000);
  assert.equal((await h.run()).reason,'paused');assert.equal(h.calls.length,1);
  h.advance(600001);await h.run();assert.equal(h.calls.length,2);
});
test('rate limiting respects Retry-After without automatic retry',async()=>{
  const h=harness({fetchPage:async()=>htmlResponse({ok:false,status:429,headers:{get:key=>key==='retry-after'?'3600':null}})});
  await h.run();assert.equal(h.receipts[0].error.code,'rate_limited');assert.equal(h.receipts[0].error.retryAfterMs,3600000);
  await h.run();assert.equal(h.calls.length,1);
});
test('unknown schemas and non-HTML responses cannot certify complete search or prices',async()=>{
  const h=harness({jobs:[search(1)],core:{parseSearch:()=>({ok:false,kind:'search',errors:['ambiguous pagination'],endReached:false})}});
  await h.run();assert.equal(h.receipts[0].status,'partial');assert.equal(h.receipts[0].error.code,'unrecognized_schema');assert.equal(h.receipts[0].result.endReached,false);
  const bad=harness({fetchPage:async()=>htmlResponse({headers:{get:()=> 'application/json'}})});await bad.run();assert.equal(bad.receipts[0].status,'error');assert.equal(bad.receipts[0].error.code,'unexpected_content_type');
});
test('a failed localhost receipt never guesses cursor progress or repeats remote reads inside the cycle',async()=>{
  let reads=0;const state={};
  await assert.rejects(collector.runCycle({core:{parseProduct:()=>({ok:true,kind:'product'})},state,fetchPage:async()=>{reads++;return htmlResponse();},server:async(path)=>{if(path===collector.WORK)return {enabled:true,runId:'run:1',jobs:[product,search(2)]};throw Error('local unavailable');}}),/local unavailable/);
  assert.equal(reads,1);
});
test('an oversized parsed receipt is reported without truncating a list or retrying the read',async()=>{
  const h=harness({jobs:[search(1)],core:{parseSearch:(_html,sourceUrl)=>({ok:true,kind:'search',sourceUrl,products:[{name:'x'.repeat(6*1024*1024)}],productUrls:[],nextUrls:[],endReached:true})}});
  const result=await h.run();assert.equal(result.reason,'oversized_receipt');assert.equal(h.receipts[0].status,'error');assert.equal(h.receipts[0].error.code,'oversized_receipt');assert.equal(Object.hasOwn(h.receipts[0],'result'),false);
  assert.equal(h.receipts[0].collectorBuild,collector.BUILD);
  await h.run();assert.equal(h.calls.length,1);
});
test('HTTP response limits stop before a declared oversized page is read',async()=>{
  let read=false;const h=harness({fetchPage:async()=>htmlResponse({headers:{get:key=>key==='content-length'?String(13*1024*1024):'text/html'},text:async()=>{read=true;return 'not read';}})});
  await h.run();assert.equal(read,false);assert.equal(h.receipts[0].error.code,'oversized_response');
});
test('ordinary-page reinjection replaces the earlier same-version build once without navigation',()=>{
  const listeners=new Map(),timers=[],cadences=[];let oldStops=0,intervals=0;
  const root={location:{origin:ORIGIN},FamilienSesumCore:{},__familienSesumCollector:collector.VERSION,__familienSesumStop:()=>{oldStops++;},fetch:async()=>{throw Error('not scheduled in this test');},navigator:{onLine:true},addEventListener:(name,fn)=>{listeners.set(fn,name);},removeEventListener:(_name,fn)=>listeners.delete(fn),setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length;},clearTimeout(){},setInterval:(_fn,delay)=>{cadences.push(delay);return ++intervals;},clearInterval(){},postMessage(){}};
  collector.install(root);assert.equal(oldStops,1);assert.equal(root.__familienSesumCollectorBuild,collector.BUILD);assert.equal(root.__familienSesumCollector,collector.VERSION);assert.equal(intervals,1);assert.equal(listeners.size,2);
  assert.equal(collector.TICK_MS,20000);assert.deepEqual(cadences,[20000],'the page advances bounded batches every twenty seconds');
  collector.install(root);assert.equal(oldStops,1);assert.equal(intervals,1,'the identical build never duplicates its timer or listeners');
  root.__familienSesumStop();assert.equal(listeners.size,0);assert.equal(root.__familienSesumCollectorBuild,undefined);assert.equal(root.location.origin,ORIGIN);
});
