import test from 'node:test';import assert from 'node:assert/strict';import {crawlLibrary} from '../src/library-feed.mjs';
test('library widget uses public config, reads all pages and includes cancellations and descriptions',async()=>{
  const starts=[];const fetchImpl=async(url,options={})=>{
    const u=new URL(url);if(u.pathname==='/events')return new Response('getScopeGroupId:function(){return"123"}');
    if(u.pathname==='/api/jsonws/invoke'){assert.equal(options.method,'POST');assert.match(options.body.get('cmd'),/get-calendar-config/);return Response.json({calendarApiEndpoint:'https://api.axiell.com/event/api',customerId:'customer'});}
    const start=Number(u.searchParams.get('start'));starts.push(start);return Response.json({totalHits:101,hits:Array.from({length:start===0?100:1},(_,i)=>({event:{id:String(start+i),title:'Event '+(start+i),startDate:'2026-10-01T10:00:00Z',endDate:'2026-10-01T11:00:00Z',status:i===0?'CANCELLED':'PUBLISHED',description:'<p>Full original description</p>'}}))});
  };const result=await crawlLibrary({from:'2026-09-29',to:'2026-10-29',fetchImpl,sleep:async()=>{}});assert.deepEqual(starts,[0,100]);assert.equal(result.total,101);assert.ok(result.complete);assert.ok(result.lines.some(l=>l.includes('CANCELLED')));assert.ok(result.lines.includes('Full original description'));
});
test('library empty HTML and broken pagination never count as full coverage',async()=>{await assert.rejects(crawlLibrary({from:'2026-09-29',to:'2026-10-29',fetchImpl:async()=>new Response('Loading')}),/endret/);});
