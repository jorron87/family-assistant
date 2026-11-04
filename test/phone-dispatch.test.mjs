import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createPhoneDispatcher} from '../src/phone-dispatch.mjs';
import {phoneHandler} from '../src/phone-server.mjs';
import {createServer} from 'node:http';

test('successful HTTP submit immediately wakes dispatcher; an unfinished upload never does',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-submit-test-'));let server;
 try {
  const store=createStore(dir),device=store.phone.pair({code:store.phone.invite().code});let starts=0;
  const dispatch=createPhoneDispatcher({store,root:dir,launch:()=>{starts++;}});
  const handle=phoneHandler({store,root:dir,onQueued:()=>dispatch.tick(),send:(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));},json:async req=>{let value='';for await(const chunk of req)value+=chunk;return JSON.parse(value);}});
  server=createServer(handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}/send/api`;
  const headers={'Content-Type':'application/json','X-Family-Request':'1',Cookie:`familien_phone=${device.token}`};
  const response=await fetch(`${base}/inbox`,{method:'POST',headers,body:JSON.stringify({clientId:'bf6ff549-3668-33fe-8a24-996cee8a4134',text:'Test',fileCount:1})});
  const item=await response.json();assert.equal(response.status,200);assert.equal(starts,0);
  const incomplete=await fetch(`${base}/inbox/${item.id}/submit`,{method:'POST',headers,body:'{}'});assert.equal(incomplete.status,422);assert.equal(starts,0);
  store.phone.upload(item.id,0,{fileName:'test.pdf',bytes:Buffer.from('%PDF-1.7 test')},device.id);
  const complete=await fetch(`${base}/inbox/${item.id}/submit`,{method:'POST',headers,body:'{}'});assert.equal(complete.status,200);assert.equal(starts,1);
  const retry=await fetch(`${base}/inbox/${item.id}/submit`,{method:'POST',headers,body:'{}'});assert.equal(retry.status,200);assert.equal(starts,1);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});

test('phone dispatch waits for shared lock, coalesces uploads, retries interruption and resumes persisted queue',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-test-'));
 try {
  const store=createStore(dir),invite=store.phone.invite(),device=store.phone.pair({code:invite.code});
  const input={title:'Test uten avtale',text:'Test',members:[],fileCount:0};
  const a=store.phone.begin({...input,clientId:'9e71a037-026d-163e-be04-9a41044ef491'},device.id);
  const lock=store.beginRun();
  let time=Date.now(),calls=[];
  const launch=options=>{calls.push(options);};
  const dispatcher=createPhoneDispatcher({store,root:dir,launch,clock:()=>time});
  dispatcher.tick();assert.equal(calls.length,0); // Uploading is not ready.
  store.phone.submit(a.id,device.id);dispatcher.tick();assert.equal(calls.length,0);
  store.endRun(lock.lease.token);dispatcher.tick();assert.equal(calls.length,1);
  assert.match(calls[0].prompt,/scope:"familiehandlinger"/);assert.ok(store.snapshot().runLease);
  const b=store.phone.begin({...input,clientId:'8c51b67e-3c1c-082d-b833-6397a34805b9'},device.id);
  store.phone.submit(b.id,device.id);dispatcher.tick();assert.equal(calls.length,1);
  calls[0].onExit(1);assert.equal(store.snapshot().runLease,null);
  assert.ok(store.phone.list().find(x=>x.id===a.id).dispatch.retryAt);
  // Fresh dispatcher reconstructs pending work from durable encrypted state.
  const reopened=createStore(dir),restored=createPhoneDispatcher({store:reopened,root:dir,launch,clock:()=>time});
  restored.tick();assert.equal(calls.length,2);assert.match(calls[1].prompt,new RegExp(b.id));
  reopened.phone.review(b.id,{status:'blocked',note:'Originalen er uleselig; familien må sende ny kopi.'});
  calls[1].onExit(0);assert.equal(reopened.snapshot().runLease,null);
  time+=61000;restored.tick();assert.equal(calls.length,3);
  calls[2].onExit(1);time+=301000;restored.tick();assert.equal(calls.length,4);
  calls[3].onExit(1);assert.equal(reopened.phone.list().find(x=>x.id===a.id).status,'blocked');
 } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});

test('family hides persist across source corrections and reload; phone-only report cannot hide its unfinished intake',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-visibility-test-'));
 try {
  const store=createStore(dir),raw=store.upsertRaw({source:'vigilo',externalId:'hide-test',title:'Invitasjon',body:'Prøveaktivitet',publishedAt:new Date().toISOString()}).item;
  const finding={canonicalKey:'test-invitasjon',title:'Vurder aktiviteten',start:'2026-10-01T16:00:00+02:00',end:'2026-10-01T17:00:00+02:00',members:['child3']};
  const event=store.upsertFinding(raw.id,finding),fingerprint=event.fingerprint;
  store.setEventVisibility(event.id,{hidden:true});assert.equal(store.snapshot().events[event.id].fingerprint,fingerprint);
  store.upsertFinding(raw.id,{...finding,title:'Rettet invitasjon'});
  const reopened=createStore(dir);assert.equal(reopened.snapshot().events[event.id].visibility.hidden,true);
  reopened.setEventVisibility(event.id,{hidden:false});reopened.linkCalendar(event.id,{calendarId:"test",eventId:"test",eventUrl:"https://calendar.google.com/calendar/event?eid=test",visibilityRevision:2});assert.equal(reopened.snapshot().events[event.id].visibility.hidden,false);
  assert.equal(reopened.snapshot().events[event.id].visibility.history.length,2);
  assert.equal(reopened.recordRun({scope:'telefon',outcome:'ok',summary:'Mobilinnboksen er tom.'}).scope,'telefon');
  assert.throws(()=>reopened.recordRun({outcome:'ok',summary:'Alle kilder dekket'}),/restanser/);
  const device=reopened.phone.pair({code:reopened.phone.invite().code});
  const item=reopened.phone.begin({clientId:'2e5a8865-c02d-3afc-f85a-6b828302637b',title:'Test',text:'Test',fileCount:0},device.id);
  reopened.phone.submit(item.id,device.id);
  assert.throws(()=>reopened.recordRun({scope:'telefon',outcome:'ok',summary:'Ferdig'}),/restanser/);
 } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});

test('calendar hide/delete/restore requires current family revision and keeps historical IDs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-calendar-choice-test-'));
 try {
  const store=createStore(dir),raw=store.upsertRaw({source:'spond',externalId:'choice',title:'Invitasjon',body:'Test'}).item;
  const event=store.upsertFinding(raw.id,{canonicalKey:'choice',title:'Vurder prøveaktivitet',start:'2026-10-01T16:00:00+02:00',end:'2026-10-01T17:00:00+02:00'});
  store.linkCalendar(event.id,{calendarId:'family',eventId:'original',eventUrl:'https://calendar.google.com/calendar/event?eid=original'});
  store.setEventVisibility(event.id,{hidden:true});assert.equal(store.calendarActions()[0].action,'remove');
  assert.throws(()=>store.linkCalendar(event.id,{calendarId:'family',eventId:'new'}),/skjult/);
  assert.throws(()=>store.calendarAction(event.id,{revision:0,action:'removed',googleEventId:'original'}),/endret/);
  store.calendarAction(event.id,{revision:1,action:'removed',googleEventId:'original'});
  assert.equal(store.calendarActions().length,0);assert.ok(store.snapshot().events[event.id].calendar.removedAt);
  store.upsertFinding(raw.id,{canonicalKey:'choice',title:'Rettet tekst',start:event.start,end:event.end});assert.equal(store.calendarActions().length,0);
  assert.ok(!store.completionReport().unsyncedCalendar.some(x=>x.eventId===event.id));
  store.setEventVisibility(event.id,{hidden:false});assert.equal(store.calendarActions()[0].action,'restore');
  assert.throws(()=>store.linkCalendar(event.id,{calendarId:'family',eventId:'original',eventUrl:'https://calendar.google.com/calendar/event?eid=original',visibilityRevision:2}),/Google-ID-en er slettet/);
  assert.throws(()=>store.linkCalendar(event.id,{calendarId:'family',eventId:'new',eventUrl:'https://calendar.google.com/calendar/event?eid=new',visibilityRevision:1}),/gjeldende/);
  store.linkCalendar(event.id,{calendarId:'family',eventId:'new',eventUrl:'https://calendar.google.com/calendar/event?eid=new',visibilityRevision:2});
  assert.equal(store.calendarActions().length,0);assert.equal(store.snapshot().events[event.id].calendarHistory[0].eventId,'original');
 } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});

test('restart keeps a live worker lease and releases only its own dead worker lease',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-worker-restart-test-'));
 try {
  const store=createStore(dir),device=store.phone.pair({code:store.phone.invite().code});
  const item=store.phone.begin({clientId:'06db3ff5-decf-7b9d-10ea-b5092df3bcea',text:'Test',fileCount:0},device.id);store.phone.submit(item.id,device.id);
  const lease=store.beginRun();store.phone.worker({pid:process.pid,token:lease.lease.token});let calls=0;
  createPhoneDispatcher({store,root:dir,launch:()=>{calls++;}}).tick();assert.equal(calls,0);assert.equal(store.snapshot().runLease.token,lease.lease.token);
  store.phone.worker({pid:2147483647,token:lease.lease.token});
  createPhoneDispatcher({store,root:dir,launch:()=>{calls++;}}).tick();assert.equal(calls,1);assert.notEqual(store.snapshot().runLease.token,lease.lease.token);
 } finally {assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});
