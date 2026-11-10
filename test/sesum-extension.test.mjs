import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const script=readFileSync(new URL('../config/vigilo-keepalive/background.js',import.meta.url),'utf8');
function harness({tabs=[],enabled=true,paused=false}={}) {
  const messages=[],injected=[],created=[],reloaded=[],requests=[],listeners=[];
  const chrome={
    alarms:{get:async()=>({periodInMinutes:1}),create:async()=>{},onAlarm:{addListener(){}}},
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener:fn=>listeners.push(fn)}},
    action:{onClicked:{addListener(){}}},
    tabs:{query:async()=>tabs,create:async value=>{created.push(value);},reload:async id=>reloaded.push(id),sendMessage:async(id,message)=>{messages.push({id,...message});return {ok:true};}},
    scripting:{executeScript:async input=>{injected.push(input);return [{result:false}];}},
  };
  const fetch=async(url,options={})=>{requests.push({url,...options});return {ok:true,json:async()=>url.includes('/work')?{enabled,runId:'run:1',jobs:[{id:'job:1'}],pauseUntil:paused?new Date(Date.now()+600000).toISOString():null}:{ok:true}};};
  const api=runInNewContext(script+'\n({sesumTick,sesumRelayAllowed})',{chrome,fetch,URL,AbortSignal,setTimeout,clearTimeout,Date});
  const relay=async(message,origin,frameId=0)=>new Promise(resolve=>{const handled=listeners[0]({type:'familien-collector',...message},{tab:{url:origin},frameId},resolve);if(!handled)resolve({ok:false});});
  return {...api,relay,messages,injected,created,reloaded,requests};
}
test('Sesum relay and school relay cannot cross their exact source/route boundaries',async()=>{
  const h=harness();
  for(const [origin,path,method,ok] of [
    ['https://www.sesum.no/','/api/shopping/sesum/work','GET',true],
    ['https://www.sesum.no/','/api/shopping/sesum/receive','POST',true],
    ['https://www.sesum.no/','/api/collector','POST',false],
    ['https://www.sesum.no/','/api/shopping/watch','POST',false],
    ['https://www.sesum.no/','/api/shopping/oda/line','POST',false],
    ['https://www.sesum.no/','/api/shopping/sesum/receive','GET',false],
    ['https://www.facebook.com/','/api/shopping/sesum/receive','POST',false],
    ['https://www.sesum.no.other.example/','/api/shopping/sesum/work','GET',false],
    ['https://web-parent.prod.vigilo-oas.no/news','/api/collector','POST',true],
  ])assert.equal((await h.relay({path,method,body:{}},origin)).ok,ok,origin+' '+path);
  assert.equal((await h.relay({path:'/api/shopping/sesum/work',method:'GET'},'https://www.sesum.no/',1)).ok,false,'subframes have no relay access');
});
test('an existing Sesum tab is reused without navigating or touching Vigilo',async()=>{
  const h=harness({tabs:[{id:1,url:'https://web-parent.prod.vigilo-oas.no/news'},{id:8,url:'https://www.sesum.no/produkt/123-synthetic',status:'complete'}]});
  await h.sesumTick();assert.equal(h.created.length,0);assert.equal(h.reloaded.length,0);assert.ok(h.messages.every(m=>m.id===8));
  assert.ok(h.requests[0].url.endsWith('/work?peek=1'),'preflight does not reserve jobs before the page asks for them');
  assert.ok(h.injected.some(i=>JSON.stringify(i.files)===JSON.stringify(['sesum-core.js','collector-sesum.js'])));
  assert.ok(h.injected.every(i=>i.target.tabId===8));
  const probe=h.injected.find(i=>i.func).func.toString();
  assert.equal(runInNewContext('('+probe+')()',{__familienSesumCollector:'sesum-collector-1.7.0'}),false,'the earlier same-version build is repaired');
  assert.equal(runInNewContext('('+probe+')()',{__familienSesumCollector:'sesum-collector-1.7.0',__familienSesumCollectorBuild:'sesum-collector-build-1.7.0-2'}),false,'the previous receipt build is replaced by the faster bounded scheduler');
  assert.equal(runInNewContext('('+probe+')()',{__familienSesumCollector:'sesum-collector-1.7.0',__familienSesumCollectorBuild:'sesum-collector-build-1.7.0-4'}),false,'the previous parser without explicit own unit labels is replaced');
  assert.equal(runInNewContext('('+probe+')()',{__familienSesumCollector:'sesum-collector-1.7.1',__familienSesumCollectorBuild:'sesum-collector-build-1.7.1-1'}),true);
});
test('only a missing Sesum tab creates a background Sesum tab',async()=>{
  const h=harness({tabs:[{id:1,url:'https://web-parent.prod.vigilo-oas.no/news'}]});await h.sesumTick();
  assert.equal(h.created.length,1);assert.equal(h.created[0].url,'https://www.sesum.no/');assert.equal(h.created[0].active,false);assert.equal(h.injected.length,0);
  for(const options of [{enabled:false},{paused:true}]){const off=harness(options);await off.sesumTick();assert.equal(off.created.length,0);assert.equal(off.injected.length,0);}
});
test('manifest grants only the exact Sesum site and no database or credential permissions',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../config/vigilo-keepalive/manifest.json',import.meta.url),'utf8'));
  assert.ok(manifest.host_permissions.includes('https://www.sesum.no/*'));
  assert.ok(manifest.host_permissions.every(value=>!value.includes('supabase')&&!value.includes('mcp.sesum')));
  assert.equal(manifest.permissions.includes('cookies'),false);
  const sesum=manifest.content_scripts.filter(entry=>entry.matches.includes('https://www.sesum.no/*'));
  assert.equal(sesum.length,2);assert.deepEqual(sesum.find(entry=>entry.world==='MAIN').js,['sesum-core.js','collector-sesum.js']);
});
