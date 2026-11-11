import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createStore} from '../src/store.mjs';
import {createPhoneDispatcher} from '../src/phone-dispatch.mjs';
import {buildNext,slimCompletion} from '../src/cli-lib.mjs';

const input={key:'variant',subject:{type:'shopping-family',id:'coffee',label:'Kaffe'},question:'Hele bønner eller malt kaffe?',reason:'Kaffens form må avklares før andre varianter kan sammenlignes.',options:[{id:'whole',label:'Hele bønner'},{id:'ground',label:'Malt kaffe'}],evidence:'SYNTHETIC PRIVATE AGENT EVIDENCE'};
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'family-clarification-flow-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'family-clarification-flow-')));rmSync(dir,{recursive:true,force:true});});const store=createStore(dir);store.shopping.watch({id:'coffee',name:'Kaffe',unit:'kg',storage:'pantry'});return {dir,store};}
test('unanswered questions do not launch agents; actual answers use the shared lease and remain current across corrections',t=>{
 const {dir,store}=fixture(t),calls=[],dispatch=createPhoneDispatcher({store,root:dir,launch:args=>{calls.push(args);return {pid:999999};}}),parent=store.profile().members.find(m=>m.role==='parent');
 const q=store.clarifications.request(input);dispatch.tick();assert.equal(calls.length,0);assert.equal(store.clarifications.summary().awaitingAnswer,1);
 const foreign=store.beginRun();store.clarifications.answer({id:q.id,expectedFingerprint:q.fingerprint,optionId:'whole'},{senderMemberId:parent.id});dispatch.tick();assert.equal(calls.length,0);store.endRun(foreign.lease.token);dispatch.tick();assert.equal(calls.length,1);
 const lease=store.runLease(),first=store.clarifications.detail(q.id).answer.fingerprint;assert.match(calls[0].prompt,/scope:"familiehandlinger"/);assert.ok(calls[0].prompt.includes(first));assert.equal(calls[0].prompt.includes(input.evidence),false,'source content is fetched as data, not embedded as runtime instructions');
 const current=store.clarifications.familyRow(q.id);store.clarifications.answer({id:q.id,expectedFingerprint:current.fingerprint,optionId:'ground'},{senderMemberId:parent.id});assert.throws(()=>store.clarifications.review({id:q.id,answerFingerprint:first,status:'applied',evidence:'An older answer must not resolve a new household choice.'}),/endret/);
 calls[0].onExit(0);assert.equal(store.runLease(),null);dispatch.tick();assert.equal(calls.length,2);const next=store.clarifications.detail(q.id).answer;
 const fact=store.profileFact({memberId:'family',key:'preference:coffee-form',text:'Velger malt kaffe i denne syntetiske familien.',category:'preference',confidence:'confirmed',source:'manual'});assert.equal(fact.status,'active');store.clarifications.review({id:q.id,answerFingerprint:next.fingerprint,status:'applied',evidence:'The confirmed preference was actually saved as profile fact '+fact.id});calls[1].onExit(0);assert.equal(store.clarifications.summary().complete,true);assert.equal(store.runLease(),null);assert.equal(lease.token.length>0,true);
 const reopened=createStore(dir);assert.equal(reopened.clarifications.list({includeResolved:true}).items[0].status,'resolved');assert.equal(reopened.profile().activeFacts.find(f=>f.id===fact.id).text,fact.text);
});

test('answer work appears in next while source coverage remains separate, and family completion cannot hide it',t=>{
 const {store}=fixture(t),parent=store.profile().members.find(m=>m.role==='parent'),before=store.sourceCompletionReport(),q=store.clarifications.request(input);
 assert.deepEqual(store.sourceCompletionReport().counts,before.counts);assert.equal(store.completionReport().clarifications.requiredAwaitingAnswer,1);store.clarifications.answer({id:q.id,expectedFingerprint:q.fingerprint,optionId:'whole'},{senderMemberId:parent.id});
 const next=buildNext({phone:[],calendarActions:[],completion:store.completionReport(),queue:[],clarificationAnswers:store.clarifications.ready()});assert.equal(next.work[0].do,'clarification-answer');assert.equal(next.work[0].id,q.id);assert.throws(()=>store.recordRun({scope:'familiehandlinger',outcome:'ok',summary:'All family actions are supposedly complete.'}),/restanser/);
 assert.equal(store.clarifications.ready().length,1);assert.equal(slimCompletion(store.completionReport()).clarifications?.pendingAnswers,1);
});

test('real agent, kiosk and paired phone routes preserve private evidence and replay one answer safely',{timeout:20000},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'family-clarification-http-')),port=15710,base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:resolve('.'),windowsHide:true,stdio:'ignore',env:{...process.env,FAMILIEN_CONFIG_DIR:resolve('test/config'),FAMILIEN_DATA_DIR:dir,FAMILIEN_PORT:String(port),FAMILIEN_NO_DISPATCH:'1',CODEX_HOME:dir}});
 t.after(async()=>{child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('close',r));assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'family-clarification-http-')));rmSync(dir,{recursive:true,force:true});});
 let started=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){started=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(started,true);
 const post=(path,data,host=base,headers={})=>fetch(host+path,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1',...headers},body:JSON.stringify(data)});
 assert.equal((await post('/api/shopping/watch',{id:'coffee',name:'Kaffe',unit:'kg',storage:'pantry'})).status,200);
 assert.equal((await post('/api/clarifications/request',input,base,{Origin:'https://untrusted.example.test'})).status,403);
 const q=await(await post('/api/clarifications/request',input)).json();assert.ok(q.id);const kiosk='http://127.0.0.1:'+(port+1),mobile='http://127.0.0.1:'+(port+2);
 assert.equal((await fetch(kiosk+'/api/clarifications/agent')).status,403);assert.equal((await post('/api/clarifications/request',input,kiosk)).status,405);
 const family=await(await fetch(kiosk+'/api/clarifications')).json();assert.equal(JSON.stringify(family).includes(input.evidence),false);assert.equal(family.items.length,1);const senderMemberId=family.members[0].id;
 for(const host of [base,kiosk]){const state=await(await fetch(host+'/api/state?view=dashboard')).json();assert.equal('clarifications'in state,false);assert.equal(JSON.stringify(state).includes(input.evidence),false,'private question context never enters dashboard state');}
 assert.equal((await fetch(mobile+'/send/api/clarifications')).status,401);const invite=await(await post('/api/phone/invite',{})).json(),pair=await post('/send/api/pair',{code:invite.code},mobile),cookie=pair.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(mobile+'/send/api/clarifications',{headers:{Cookie:cookie}})).status,200);
 const payload={id:q.id,expectedFingerprint:q.fingerprint,optionId:'whole',senderMemberId};const answered=await(await post('/send/api/clarifications/answer',payload,mobile,{Cookie:cookie})).json();assert.equal(answered.status,'answered');const replay=await(await post('/api/clarifications/answer',payload,kiosk)).json();assert.equal(replay.replayed,true);
 const agent=await(await fetch(base+'/api/clarifications/agent')).json();assert.equal(agent.work.length,1);assert.equal(agent.work[0].answer.senderMemberId,senderMemberId);const detail=await(await fetch(base+'/api/clarifications/agent/'+q.id)).json();assert.equal(detail.evidence,input.evidence);
 for(const asset of ['/clarifications.css','/clarifications-view.mjs'])assert.equal((await fetch(kiosk+asset)).status,200);for(const asset of ['/send/clarifications.css','/send/clarifications-view.mjs'])assert.equal((await fetch(mobile+asset)).status,200);
});
