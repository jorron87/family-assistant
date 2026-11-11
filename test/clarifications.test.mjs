import test from 'node:test';
import assert from 'node:assert/strict';
import {createClarifications} from '../src/clarifications.mjs';
const members=()=>[{id:'adult',name:'Forelder',role:'parent'},{id:'other',name:'Annen forelder',role:'parent'},{id:'child',name:'Barn',role:'child'}];
const question={key:'variant',subject:{type:'shopping-family',id:'coffee',label:'Kaffe'},question:'Hvilken form skal vi sammenligne?',reason:'Familiens valgte form er ikke oppgitt, og hele bønner og malt kaffe må holdes atskilt.',options:[{id:'whole',label:'Hele bønner'},{id:'ground',label:'Malt kaffe'},{id:'other',label:'Annet',allowText:true}],evidence:'Synthetic private source context that never appears in family data.'};
function fixture(){const state={},clock={at:Date.parse('2026-11-11T12:00:00Z')},api=createClarifications(state,{members,now:()=>new Date(clock.at)});return {state,clock,api};}
const answer=(api,q,optionId='whole',extra={})=>api.answer({id:q.id,expectedFingerprint:q.fingerprint,optionId,...extra},{senderMemberId:'adult'});
test('many product requests share one question and cannot replace its options or erase an answer',()=>{
 const {api}=fixture(),q=api.request(question);for(let i=0;i<100;i++){const again=api.request({...question,question:'Different worker wording '+i,options:[{id:'wrong',label:'Changed'}]});assert.equal(again.id,q.id);assert.equal(again.question,q.question);}
 assert.equal(api.list().total,1);assert.equal(api.ready().length,0);assert.equal(api.summary().requiredAwaitingAnswer,1);
 answer(api,q);assert.equal(api.request({...question,contextFingerprint:'new unrelated source receipt'}).status,'answered');assert.equal(api.ready().length,1);
 assert.equal(JSON.stringify(api.list()).includes(question.evidence),false);
});
test('answers are attributed to an actual parent, idempotent, and protected against stale concurrent choices',()=>{
 const {api}=fixture(),q=api.request(question);assert.throws(()=>api.answer({id:q.id,expectedFingerprint:q.fingerprint,optionId:'whole'},{senderMemberId:'child'}),/forelder/);
 const a=answer(api,q);assert.equal(a.answer.senderName,'Forelder');assert.equal(answer(api,q).replayed,true);assert.equal(api.ready().length,1);
 assert.throws(()=>answer(api,q,'ground'),/endret/);const corrected=answer(api,a,'ground');assert.equal(corrected.answer.optionId,'ground');assert.equal(api.detail(q.id).answerHistory.length,1);
 assert.throws(()=>api.review({id:q.id,answerFingerprint:api.detail(q.id).answerHistory[0].answer.fingerprint,status:'applied',evidence:'The earlier answer was supposedly applied.'}),/endret/);
});
test('answered work remains unresolved through deferred attempts and survives restart with bounded retries',()=>{
 const f=fixture(),q=f.api.request(question);answer(f.api,q);const [work]=f.api.ready();f.api.attempt([work]);assert.equal(f.api.ready().length,0);assert.equal(f.api.summary().pendingAnswers,1);assert.equal(f.api.summary().complete,false);
 const restored=createClarifications(JSON.parse(JSON.stringify(f.state)),{members,now:()=>new Date(f.clock.at)});f.clock.at+=300001;assert.equal(restored.ready().length,1);
 restored.review({id:q.id,answerFingerprint:work.answerFingerprint,status:'blocked',evidence:'Current source identity is still missing; no product approval was fabricated.',retryAt:new Date(f.clock.at+3600000).toISOString(),message:'Svaret er lagret. Produktopplysningene må fortsatt sjekkes.'});assert.equal(restored.ready().length,0);assert.equal(restored.summary().blockedAnswers,1);
 f.clock.at+=3600001;assert.equal(restored.ready().length,1);restored.review({id:q.id,answerFingerprint:work.answerFingerprint,status:'applied',evidence:'Actual current family receipt was saved and independently verified.'});assert.equal(restored.summary().complete,true);assert.equal(restored.list().total,0);assert.equal(restored.list({includeResolved:true}).items[0].status,'resolved');
});
test('explicit question replacement preserves old receipts and requires fresh owner input only for a real change',()=>{
 const {api}=fixture(),q=api.request(question),a=answer(api,q);assert.throws(()=>api.request({...question,replace:true,expectedFingerprint:q.fingerprint,question:'Changed actual requirement?'}),/endret/);
 const same=api.request({...question,replace:true,expectedFingerprint:a.fingerprint});assert.equal(same.status,'answered');const changed=api.request({...question,replace:true,expectedFingerprint:a.fingerprint,question:'Changed actual requirement?'});assert.equal(changed.status,'open');assert.equal(api.detail(q.id).history[0].answer.optionId,'whole');assert.equal(api.ready().length,0);
});
test('free text is explicit and pagination enumerates every question without rendering source markup',()=>{
 const {api}=fixture(),q=api.request(question);assert.throws(()=>answer(api,q,'whole',{text:'Unexpected text'}),/fritekst/);const a=answer(api,q,'other',{text:'<script>source data only</script>'});assert.equal(a.answer.text,'<script>source data only</script>');
 for(let n=0;n<205;n++)api.request({...question,subject:{...question.subject,type:'family'},key:'form-'+n});let offset=0,count=0;do{const p=api.list({offset,limit:100});count+=p.items.length;offset=p.nextOffset;}while(offset!==null);assert.equal(count,206);assert.throws(()=>api.request({...question,subject:{...question.subject,id:'another-family'},options:[{id:'same',label:'A'},{id:'same',label:'B'}]}),/ulike/);
});

test('obsolete questions can close with evidence without inventing an owner answer',()=>{
 const {api}=fixture(),q=api.request(question);assert.throws(()=>api.close({id:q.id,expectedFingerprint:'stale',evidence:'The current source has now supplied the missing fact.'}),/endret/);
 const closed=api.close({id:q.id,expectedFingerprint:q.fingerprint,evidence:'The family already stated its preference in a verified current profile receipt.'});assert.equal(closed.status,'withdrawn');assert.equal(closed.answer,null);assert.equal(api.summary().complete,true);assert.equal(api.list().total,0);assert.equal(api.ready().length,0);assert.equal(api.detail(q.id).withdrawn.evidence.includes('verified'),true);
 assert.throws(()=>answer(api,q),/allerede løst/);assert.equal(api.request(question).status,'withdrawn');
 const reopened=api.request({...question,replace:true,expectedFingerprint:closed.fingerprint,contextFingerprint:'actual-new-family-rules'});assert.equal(reopened.status,'open');assert.equal(api.detail(q.id).history[0].withdrawn.evidence.includes('verified'),true);
});

test('changed pages and per-product keys cannot silently generate another family question',()=>{
 const {api}=fixture(),q=api.request(question),page=api.list();assert.throws(()=>api.request({...question,key:'variant-for-product-42'}),/felles avklaringstema/);
 answer(api,q);assert.throws(()=>api.list({expectedFingerprint:page.fingerprint}),/endret/);assert.equal(api.list().total,1);
 assert.throws(()=>api.request({...question,subject:{...question.subject,id:'missing'},extraCommand:'untrusted'}),/felt/);
});
