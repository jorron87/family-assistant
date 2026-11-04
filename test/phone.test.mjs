import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';
import {detectFile} from '../src/phone.mjs';

test('phone intake requires pairing, complete original upload and publication before done; retries do not duplicate',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-phone-test-'));
 try {
  const store=createStore(dir),invite=store.phone.invite();
  assert.throws(()=>store.phone.pair({code:'invalid'}),/utløpt eller ugyldig/);
  const paired=store.phone.pair({code:invite.code,name:'Testtelefon'}),device=store.phone.authenticate(paired.token);
  assert.equal(store.phone.authenticate('invalid'),null);
  const input={clientId:'9e71a037-026d-163e-be04-9a41044ef491',title:'Testbrev',text:'Dette er et testbrev',members:['child3'],fileCount:1};
  const item=store.phone.begin(input,device.id);
  assert.equal(store.phone.begin(input,device.id).id,item.id);
  assert.equal(store.completionReport().phonePending.length,0);
  assert.throws(()=>store.phone.submit(item.id,device.id),/Alle filer/);
  assert.throws(()=>store.phone.upload(item.id,0,{fileName:'bilde.jpg',bytes:Buffer.from('<html>bad</html>')},device.id),/Filtypen/);
  const bytes=Buffer.from('%PDF-1.7\nTestbrev'),file=store.phone.upload(item.id,0,{fileName:'brev.pdf',bytes},device.id);
  assert.throws(()=>store.phone.submit(item.id,'another-device'),/Ukjent/);
  assert.equal(store.phone.submit(item.id,device.id).status,'queued');
  assert.equal(store.phone.upload(item.id,0,{fileName:'brev.pdf',bytes},device.id).id,file.id);
  assert.equal(store.completionReport().phonePending.length,1);
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Ferdig'}),/Kildekopi/);
  store.linkDrive(item.rawId,null,'https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view');
  store.linkDrive(item.rawId,file.id,'https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view');
  store.reviewProfile(item.rawId,{note:'Ingen varige profilfakta.',facts:[]});
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Ingen avtaler'}),/dokumentkvittering/);
  store.reviewDocument(item.rawId,file.id,{pageCount:1,method:'visual',pages:[{page:1,text:'Testbrev uten avtale.'}]});
  assert.equal(store.phone.review(item.id,{status:'done',note:'Ingen avtaler eller oppgaver i testbrevet.',result:{type:'no_calendar',eventIds:[]}}).status,'done');
  const reopened=createStore(dir);assert.equal(reopened.phone.authenticate(paired.token).id,device.id);
  assert.equal(reopened.phone.list(device.id).length,1);assert.equal(reopened.phone.list('another-device').length,0);
  assert.equal(reopened.getAttachment(item.rawId,file.id).bytes.toString(),bytes.toString());
  assert.equal(readFileSync(join(dir,'archive.json.enc')).includes(Buffer.from('Testbrev')),false);
  reopened.phone.revokeDevices();assert.equal(reopened.phone.authenticate(paired.token),null);
 } finally {if(!resolve(dir).startsWith(resolve(tmpdir())+'\\'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}
});
test('mobile file signatures reject misleading extensions',()=>{
 assert.throws(()=>detectFile(Buffer.from('<svg onload="alert(1)">')),/Filtypen/);
 assert.equal(detectFile(Buffer.from([255,216,255,224,0,1])),'image/jpeg');
});

test('calendar correction cannot finish with only Google changed or an unrelated local event',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-phone-correction-'));
 try {
  const store=createStore(dir),device=store.phone.pair({code:store.phone.invite().code});
  const item=store.phone.begin({clientId:'2e5a8865-c02d-3afc-f85a-6b828302637b',title:'Rett valgfaget',text:'Barn En har Innsats for andre.',members:['child1'],fileCount:0},device.id);
  store.phone.submit(item.id,device.id);store.linkDrive(item.rawId,null,'https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view');store.reviewProfile(item.rawId,{facts:[],note:'Vurdert.'});
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Google rettet'}),/Ferdigmelding krever result/);
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Google rettet',result:{type:'calendar',eventIds:[]}}),/lokal oppføring/);
  const school=store.upsertRaw({source:'vigilo',externalId:'school-plan',title:'Skoleplan',body:'Valgfagsdag'}).item;
  const original=store.upsertFinding(school.id,{canonicalKey:'elective-day',title:'Design',start:'2026-10-13',end:'2026-10-14',allDay:true,members:['child1']});
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Google rettet',result:{type:'calendar',eventIds:[original.id]}}),/telefonkilden/);
  const corrected=store.upsertFinding(item.rawId,{canonicalKey:'elective-day',title:'Innsats for andre',start:'2026-10-13',end:'2026-10-14',allDay:true,members:['child1'],replacePrevious:true});
  assert.equal(corrected.id,original.id);
  assert.throws(()=>store.phone.review(item.id,{status:'done',note:'Lokalt rettet',result:{type:'calendar',eventIds:[corrected.id]}}),/synkronisert/);
  store.linkCalendar(corrected.id,{calendarId:'family',eventId:'google-existing',eventUrl:'https://calendar.google.com/calendar/event?eid=test'});
  const done=store.phone.review(item.id,{status:'done',note:'Lokalt og Google rettet',result:{type:'calendar',eventIds:[corrected.id]}});
  assert.deepEqual(done.result,{type:'calendar',eventIds:[corrected.id]});
  assert.equal(store.phone.list(device.id)[0].events[0].title,'Innsats for andre');
 }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});
