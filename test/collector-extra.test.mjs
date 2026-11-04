import test from 'node:test';import assert from 'node:assert/strict';
import '../config/vigilo-keepalive/collector-extra.js';
const extra=globalThis.FamilienCollectorExtra;

test('server can restore a previously dropped child task without repeating healthy supplemental lists',async()=>{
  let clock=Date.now();const state={queue:[],finishedAt:clock-1000},paths=[];
  const wanted={source:'vigilo',section:'meetings',childId:'child',requestedAt:new Date(clock).toISOString()};
  const options={source:'vigilo',state,config:{vigiloConsents:false,want:{supplementalRetries:[wanted]}},now:()=>clock,sleep:async ms=>clock+=ms,server:async()=>{},fetchJson:async p=>{paths.push(p);return {status:200,json:[]};}};
  await extra.run(options);
  assert.equal(paths.length,1);assert.ok(paths[0].endsWith('/forms/meetings/invitations/child'));
  await extra.run(options);assert.equal(paths.length,1,'same request does not trigger repeated fetch');
});

test('mid-round credential expiry preserves unfinished child tasks through auth pause and resumes',async()=>{
  const tasks=[{path:'/forms/meetings/invitations/child',section:'meetings',childId:'child'},{path:'/forms/registrations/invitations/child',section:'registrations',childId:'child'}];
  const state={queue:structuredClone(tasks)},posts=[];let clock=Date.now(),available=false,calls=0;
  const options={source:'vigilo',state,config:{vigiloConsents:false},now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async()=>{calls++;if(!available)throw Object.assign(Error('unauthorized'),{code:'unauthorized'});return {status:200,json:[]};}};
  await extra.run(options);
  assert.deepEqual(state.queue,tasks);
  assert.equal(state.finishedAt,undefined);
  assert.equal(state.retryAt-clock,10*60000);
  assert.equal(posts.length,1);
  assert.equal(posts[0].implementation,'extra-auth-queue-2026-11-04');
  available=true;await extra.run(options);assert.equal(calls,1,'auth pause respected');
  clock=state.retryAt+1;await extra.run(options);
  assert.equal(state.queue.length,0);
  assert.equal(posts.filter(p=>p.kind==='supplemental').length,2);
  assert.ok(state.finishedAt);
});
test('disabled Vigilo consents are not requested, including tasks left in the saved queue',async()=>{
  const posts=[],paths=[],state={queue:[{path:'/consent-forms?childId=c',section:'consents',childId:'c'},{path:'/forms/meetings/invitations/c',section:'meetings',childId:'c'}]};let clock=Date.now();
  await extra.run({source:'vigilo',state,config:{vigiloConsents:false},now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>{paths.push(url);return {status:200,json:{items:[]}};}});
  assert.equal(paths.some(path=>path.includes('/consent-forms')),false);
  assert.equal(posts.some(post=>['consents','consent-counts'].includes(post.section)),false);
  assert.ok(posts.some(post=>post.section==='meetings'));
});
test('supplemental Vigilo follows source child scopes and strips credentials only',async()=>{
  const posts=[],paths=[],state={};let clock=Date.now();await extra.run({source:'vigilo',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>{paths.push(url);return {status:200,json:url.endsWith('/children/my')?[{id:'c',organizationalUnits:[{id:'u'}]}]:url.includes('counts')?{pending:1}:{items:[{id:'form',title:'Samtykke',token:'NEVER',url:'https://school.example/info'}]}};}});
  assert.ok(paths.some(p=>p.includes('/forms/meetings/invitations/c')));assert.ok(paths.some(p=>p.includes('organizationalUnitId=u')));assert.equal(JSON.stringify(posts).includes('NEVER'),false);assert.ok(posts.some(p=>p.section==='required-actions'));assert.ok(state.finishedAt);
});
test('Vigilo consent response uses consentForms and preserves its eight forms',async()=>{
  const posts=[],state={};let clock=Date.now();
  await extra.run({source:'vigilo',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>({status:200,json:url.endsWith('/children/my')?[{id:'c',organizationalUnits:[{id:'u'}]}]:url.includes('/consent-forms?')?{consentInformation:'Info',consentForms:Array.from({length:8},(_,i)=>({id:String(i),description:`Consent ${i}`,legalGuardians:[]}))}:url.includes('/consent-forms/counts')?{consentFormsTotalCount:8}:{items:[]}})});
  const consent=posts.find(p=>p.section==='consents'&&p.kind==='supplemental');
  assert.equal(consent.items.length,8);
  assert.equal(consent.complete,true);
  assert.equal(posts.some(p=>p.section==='consents'&&p.kind==='supplemental-error'),false);
});
test('Spond polls paginate and nested folders are discovered; denied source remains queued',async()=>{
  const posts=[],paths=[],state={};let clock=Date.now(),denied=false;
  await extra.run({source:'spond',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>{paths.push(url);if(denied)return {status:401};if(url.endsWith('/groups'))return {status:200,json:[{id:'G'}]};if(url.includes('/folders/G'))return {status:200,json:{resources:[],folders:[{id:'F'}]}};if(url.includes('/folders/F')){denied=true;return {status:401};}if(url.includes('type=POLL')&&!url.includes('prevId'))return {status:200,json:Array.from({length:100},(_,i)=>({id:String(i),timestamp:'2026-09-28T12:00:00Z'}))};return {status:200,json:[]};}});
  assert.ok(state.retryAt>clock);assert.ok(state.queue.some(t=>t.folderId==='F'));assert.ok(paths.some(p=>p.includes('prevId=99')));assert.ok(posts.some(p=>p.kind==='supplemental-error'&&p.section==='files'));
});
test('Spond empty resource root with itemCount zero is a complete empty list',async()=>{
  const posts=[],state={};let clock=Date.now();
  await extra.run({source:'spond',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>({status:200,json:url.endsWith('/groups')?[{id:'G'}]:url.includes('/resources/folders/G')?{id:'G',itemCount:0,systemFolder:true}:[]})});
  const files=posts.find(p=>p.section==='files'&&p.kind==='supplemental');
  assert.equal(files.items.length,0);
  assert.equal(files.complete,true);
  assert.equal(posts.some(p=>p.section==='files'&&p.kind==='supplemental-error'),false);
});

test('Spond originals resolve with page-local files token; token itself never leaves the page',async()=>{
  const posts=[],paths=[],state={};let clock=Date.now();
  await extra.run({source:'spond',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>{paths.push(url);const json=url.endsWith('/groups')?[{id:'G'}]:url.endsWith('/filesToken')?{value:'LOCAL_ONLY'}:url.includes('/storage/upload/group/')?{url:'https://files.example/original.docx'}:url.includes('/folders/')?{resources:[{id:'F',type:'PDF',name:'original.docx',url:'https://spond.com/storage/upload/group/F'}],folders:[]}:[];return {status:200,json};}});
  assert.ok(paths.some(p=>p==='https://api.spond.com/storage/upload/group/F?auth=LOCAL_ONLY'));assert.equal(JSON.stringify(posts).includes('LOCAL_ONLY'),false);assert.equal(JSON.stringify(state).includes('LOCAL_ONLY'),false);assert.ok(posts.some(p=>p.items?.[0]?.url==='https://files.example/original.docx'));
  assert.ok(posts.some(p=>p.items?.[0]?.url===null),'unresolved portal URL is not reported as a downloadable original');
});

test('the last poll page carries the entire list, including groups absent from that page',async()=>{
  const posts=[],state={};let clock=Date.now();
  const first=Array.from({length:100},(_,i)=>({id:String(i),groupId:'A',timestamp:'2026-10-03T10:00:00Z'}));
  await extra.run({source:'spond',state,now:()=>clock,sleep:async ms=>clock+=ms,server:async(_p,_m,b)=>posts.push(b),fetchJson:async url=>({status:200,json:url.endsWith('/groups')?[{id:'A'},{id:'B'}]:url.includes('/resources/folders/')?{itemCount:0}:url.includes('type=POLL')?(url.includes('prevId')?[{id:'last',groupId:'B',timestamp:'2026-10-02T10:00:00Z'}]:first):[]})});
  const polls=posts.filter(p=>p.section==='polls'&&p.kind==='supplemental');
  assert.equal(polls[0].complete,false);
  assert.equal(polls.at(-1).complete,true);
  assert.equal(polls.at(-1).items.length,101);
  assert.ok(polls.at(-1).items.some(item=>item.groupId==='A'));
});
