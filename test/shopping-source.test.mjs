import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceFetcher,flyerPage,publicHttps} from '../src/shopping-source.mjs';

const reply=(body,{type='application/pdf',status=200,url='https://example.com/x',length}={})=>({ok:status<400,status,url,headers:new Headers({'content-type':type,...(length?{'content-length':String(length)}:{})}),arrayBuffer:async()=>new TextEncoder().encode(body).buffer});

test('only public HTTPS sources can be fetched',()=>{
 assert.equal(publicHttps('https://example.com/a.pdf'),true);
 for(const url of ['http://example.com/a','https://localhost/a','https://127.0.0.1/a','https://[::1]/a','https://printer.local/a','https://user:pw@example.com/a','not a url'])assert.equal(publicHttps(url),false,url);
});
test('a PDF is recognized by its bytes, not its address, and is cached briefly',async()=>{
 let calls=0,clock=0;const source=createSourceFetcher({now:()=>clock,fetchImpl:async()=>{calls++;return reply('%PDF-1.7 flyer',{type:'application/octet-stream'});}});
 const first=await source.load('https://example.com/filer/abc');
 assert.equal(first.kind,'pdf');assert.equal(first.bytes.toString().slice(0,5),'%PDF-');
 await source.load('https://example.com/filer/abc');assert.equal(calls,1);
 clock=16*60000;await source.load('https://example.com/filer/abc');assert.equal(calls,2);
});
test('pages, failures, oversized files and unsafe redirects fall back to a link',async()=>{
 const kind=async(value,url='https://example.com/x')=>(await createSourceFetcher({fetchImpl:async()=>value}).load(url)).kind;
 assert.equal(await kind(reply('<html>',{type:'text/html; charset=utf-8'})),'page');
 assert.equal(await kind(reply('<html>',{type:'application/octet-stream'})),'page');
 assert.equal(await kind(reply('%PDF-',{status:404})),'page');
 assert.equal(await kind(reply('%PDF-',{length:70*1024*1024})),'page');
 assert.equal(await kind(reply('%PDF-',{url:'https://127.0.0.1/secret'})),'page');
 assert.equal((await createSourceFetcher({fetchImpl:async()=>{throw Error('nett');}}).load('https://example.com/x')).kind,'page');
 let called=false;await createSourceFetcher({fetchImpl:async()=>{called=true;return reply('%PDF-');}}).load('https://localhost/x');assert.equal(called,false);
});
test('a single page reference in the evidence opens that page',()=>{
 assert.equal(flyerPage('Kundeavis uke 46, side 23: Ali kaffe'),23);
 assert.equal(flyerPage('Alle sider lest'),null);
 assert.equal(flyerPage('Side 2 og side 9 viser varen'),null);
});
