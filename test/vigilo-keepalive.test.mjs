import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../config/vigilo-keepalive/background.js', import.meta.url), 'utf8');
const news = 'https://web-parent.prod.vigilo-oas.no/news';

function extension({ tabs = [], probes = {}, localDown = false, queryFails = false, alarmMissing = false } = {}) {
  const updated = [];
  const reloaded = [];
  const reports = [];
  const badges = [];
  const alarms = [];
  const chrome = {
    alarms: {get:async()=>alarmMissing?undefined:{periodInMinutes:1},create:async(...args)=>alarms.push(args),onAlarm:{addListener(){}}},
    runtime: {getManifest:()=>({version:'1.2.0'}),onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    action: {setBadgeText:async value=>badges.push(value.text),setTitle:async()=>{},onClicked:{addListener(){}}},
    tabs: {
      query: async () => {if(queryFails)throw Error('query failed');return tabs;},
      update: async (id,input) => {updated.push({id,...input});Object.assign(tabs.find(tab=>tab.id===id),input);},
      reload: async (id) => { reloaded.push(id); },
    },
    scripting: {executeScript:async input=>{
      const probe=probes[input.target.tabId];if(probe instanceof Error)throw probe;
      return [{result:{authenticated:true,ready:true,online:true,focused:false,...probe}}];
    }},
  };
  const fetch = async (_url, options) => {
    assert.equal(options.method,'POST','must not depend on local GET/run lock before protecting tab');
    if(localDown)throw Error('service unavailable');
    reports.push(JSON.parse(options.body));return {ok:true};
  };
  const api=runInNewContext(`${script}\n({tick:requestTick,pageKind,inspectPage,inspectLoginLanding})`,{chrome,fetch,URL,AbortSignal,setTimeout,clearTimeout});
  return {...api,updated,reloaded,reports,badges,alarms};
}

test('preserves the real session tab instead of creating or repeatedly reloading a new tab', async () => {
  const app=extension({tabs:[{id:1,url:news+'?view=list',pinned:false}]});
  await app.tick();
  await app.tick();
  assert.deepEqual(app.updated,[{id:1,pinned:true,autoDiscardable:false}]);
  assert.deepEqual(app.reloaded,[]);
  assert.equal(app.reports.at(-1).health,'ok');
  assert.equal(app.reports.at(-1).keeperTabId,1);
});

test('an obsolete pinned tab does not hide a usable authenticated tab',async()=>{
  const app=extension({tabs:[{id:1,url:news,pinned:true},{id:2,url:news,pinned:false}],probes:{1:{authenticated:false}}});
  await app.tick();
  assert.deepEqual(app.updated,[{id:2,pinned:true,autoDiscardable:false}]);
  assert.equal(app.reports[0].health,'ok');
});

test('leaves focused content intact and keeps protection working when the web service is down',async()=>{
  const focused=extension({tabs:[{id:2,url:news,pinned:true}],probes:{2:{focused:true}},localDown:true});
  await focused.tick();
  assert.deepEqual(focused.reloaded,[]);
  assert.equal(focused.updated[0].autoDiscardable,false);
  assert.equal(focused.badges.at(-1),'?');
});

test('restoring discarded content is not reported as a successful login',async()=>{
  const app=extension({tabs:[{id:1,url:news,pinned:true,discarded:true}]});
  await app.tick();
  assert.deepEqual(app.reloaded,[1]);
  assert.equal(app.reports[0].health,'checking');
  assert.equal(app.reports[0].code,'restoring_discarded');
});

test('login redirect, loading and inspection failures stay distinguishable',async()=>{
  for(const [tab,probe,health,code] of [
    [{id:1,url:news.replace('/news','/login/sso-token/')},null,'needs_login','login_required'],
    [{id:1,url:news,status:'loading'},null,'checking','loading'],
    [{id:1,url:news,frozen:true},null,'error','tab_frozen'],
    [{id:1,url:news.replace('/news','/settings')},null,'checking','other_page'],
    [{id:1,url:news},new Error('sensitive exception must not be recorded'),'error','inspection_failed'],
    [{id:1,url:news},{authenticated:false},'error','unrecognized_page'],
  ]){
    const app=extension({tabs:[tab],probes:{1:probe}});await app.tick();
    assert.equal(app.reports[0].health,health);assert.equal(app.reports[0].code,code);
    assert(!JSON.stringify(app.reports).includes('sensitive'));
  }
});

test('an explicitly signed-in login landing returns to news once and verifies the app on the next tick',async()=>{
  const tabs=[{id:1,url:news.replace('/news','/login?redirect=%2Fnews')}];
  const app=extension({tabs,probes:{1:{signedIn:true,form:false}}});
  await app.tick();
  assert.deepEqual(app.updated,[{id:1,url:news,pinned:true,autoDiscardable:false}]);
  assert.equal(app.reports.at(-1).health,'checking');
  assert.equal(app.reports.at(-1).code,'returning_to_content');
  await app.tick();
  assert.equal(app.reports.at(-1).health,'ok');
  tabs[0].url=news.replace('/news','/login');
  await app.tick();
  assert.equal(app.updated.length,1,'a redirect back must not create a navigation loop');
  assert.equal(app.reports.at(-1).health,'needs_login');
});

test('real login forms, offline/loading pages and SSO callbacks are never navigated away',async()=>{
  for(const [tab,probe] of [
    [{id:1,url:news.replace('/news','/login')},{signedIn:false,form:true}],
    [{id:1,url:news.replace('/news','/login')},{signedIn:true,form:true}],
    [{id:1,url:news.replace('/news','/login')},{signedIn:true,form:false,online:false}],
    [{id:1,url:news.replace('/news','/login'),status:'loading'},{signedIn:true,form:false}],
    [{id:1,url:news.replace('/news','/login/sso-token/')},{signedIn:true,form:false}],
  ]){
    const app=extension({tabs:[tab],probes:{1:probe}});await app.tick();
    assert.equal(app.updated.length,0);assert.equal(app.reloaded.length,0);
    assert.notEqual(app.reports.at(-1).health,'ok');
  }
});

test('login landing detection requires the visible success notice and returns no text or credentials',()=>{
  const app=extension();
  const inspect=app.inspectLoginLanding;
  const run=text=>runInNewContext(`(${inspect.toString()})()`,{
    document:{body:{innerText:text},readyState:'complete',querySelectorAll:()=>[]},navigator:{onLine:true}
  });
  assert.equal(run('Vigilo\nDu er pålogget.').signedIn,true);
  assert.equal(run('Vigilo\nDu er ikke pålogget.').signedIn,false);
  assert.deepEqual(Object.keys(run('Vigilo\nDu er pålogget.')),['signedIn','form','ready','online']);
});

test('missing alarms are recreated and errors are visible',async()=>{
  const app=extension({queryFails:true,alarmMissing:true});await app.tick();
  assert(app.alarms.some(([,options])=>options.periodInMinutes===1));
  assert.equal(app.reports.at(-1).code,'extension_error');
});

test('simultaneous triggers share a single tick',async()=>{
  const app=extension({tabs:[{id:1,url:news}]});
  await Promise.all([app.tick(),app.tick()]);
  assert.equal(app.reports.length,1);
});

test('an extension reload repairs an orphaned bridge in the existing tab without reloading the portal',async()=>{
  const injected=[],messages=[];
  const chrome={
    alarms:{get:async()=>({periodInMinutes:1})},runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}}},
    action:{onClicked:{addListener(){}}},
    tabs:{sendMessage:async(id,message)=>{messages.push({id,type:message.type});if(message.type==='familien-collector-ping')throw Error('No receiver');return {ok:true};}},
    scripting:{executeScript:async input=>{if(input.files)injected.push(input);return [{result:true}];}}
  };
  // Alarm listeners are unused here; only exercise the upgrade recovery path.
  chrome.alarms.onAlarm={addListener(){}};
  const recover=runInNewContext(`${script}\nwakeCollector`,{chrome,URL,AbortSignal,setTimeout,clearTimeout});
  await recover(123);
  assert.equal(injected.length,1);assert.deepEqual(Array.from(injected[0].files),['collector-bridge.js']);
  assert.equal(injected[0].target.tabId,123);
  assert.equal(messages.at(-1).type,'familien-collector-wake');
});

test('a page lacking both scripts receives one bridge and one MAIN collector, with no new tabs',async()=>{
  const injected=[];
  const chrome={
    alarms:{get:async()=>({periodInMinutes:1}),onAlarm:{addListener(){}}},
    runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}}},action:{onClicked:{addListener(){}}},
    tabs:{sendMessage:async(_id,message)=>message.type==='familien-collector-ping'?undefined:{ok:true}},
    scripting:{executeScript:async input=>{if(input.files)injected.push(input);return [{result:false}];}}
  };
  const recover=runInNewContext(`${script}\nwakeCollector`,{chrome,URL,AbortSignal,setTimeout,clearTimeout});
  await recover(123);
  assert.deepEqual(injected.map(row=>Array.from(row.files)),[['collector-bridge.js'],['collector-core.js','collector-extra.js','collector-main.js']]);
  assert.equal(injected[1].world,'MAIN');
});

test('reinjecting a live bridge never duplicates relays or wake listeners',()=>{
  const bridge=readFileSync(new URL('../config/vigilo-keepalive/collector-bridge.js',import.meta.url),'utf8');
  const windowListeners=new Set(),chromeListeners=new Set();let calls=0;
  const window={addEventListener:(_event,cb)=>windowListeners.add(cb),removeEventListener:(_event,cb)=>windowListeners.delete(cb),postMessage(){}};
  const chrome={runtime:{onMessage:{addListener:cb=>chromeListeners.add(cb),removeListener:cb=>chromeListeners.delete(cb)},sendMessage:(_message,reply)=>{calls++;reply({ok:true});}}};
  const ctx={window,chrome,location:{origin:'https://spond.com'},setTimeout,clearTimeout};
  runInNewContext(bridge,ctx);runInNewContext(bridge,ctx);
  assert.equal(windowListeners.size,1);assert.equal(chromeListeners.size,1);
  for(const cb of windowListeners)cb({source:window,data:{familienCollector:true,id:'id',path:'/api/collector/config',method:'GET'}});
  assert.equal(calls,1);
});
