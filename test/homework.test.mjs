import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';

function fixture(fn) {
  const dir=mkdtempSync(join(tmpdir(),'familien-homework-'));
  try {fn(createStore(dir),dir);} finally {
    if(!resolve(dir).startsWith(resolve(tmpdir())+'\\')) throw Error('Utrygg testopprydding.');
    rmSync(dir,{recursive:true,force:true});
  }
}
const task={visibleFrom:'2026-10-05',dueDate:'2026-10-09',items:[{key:'math',text:'Gjør matte'},{key:'reading',text:'Les boka'}]};
const finding={canonicalKey:'2026-W41:3A:weekwork',title:'Forberedelser – Barn Tre og Barn Fire',members:['child3','child4'],kind:'task',start:'2026-10-04T18:00:00+02:00',end:'2026-10-04T18:15:00+02:00',task};

test('homework is personal while family preparation may remain shared',()=>fixture(store=>{
  const raw=store.upsertRaw({source:'vigilo',externalId:'week41',title:'Ukeplan'}).item;
  assert.throws(()=>store.upsertFinding(raw.id,{...finding,title:'Lekser – Barn Tre og Barn Fire'}),/ett barn/);
  assert.throws(()=>store.upsertFinding(raw.id,{...finding,task:{...task,category:'homework'}}),/ett barn/);
  assert.ok(store.upsertFinding(raw.id,finding),'joint family preparation is supported');
  const max=store.upsertFinding(raw.id,{...finding,canonicalKey:'homework:max',title:'Lekser – Barn Tre',members:['child3']});
  assert.equal(max.task.category,'homework');
  assert.throws(()=>store.upsertFinding(raw.id,{...max,members:['child4'],replacePrevious:true}),/annet barn/);
}));

test('splitting preserves original evidence and makes checks independent across siblings and retries',()=>fixture((store,dir)=>{
  const raw=store.upsertRaw({source:'vigilo',externalId:'week41',title:'Ukeplan'}).item;
  const parent=store.upsertFinding(raw.id,finding);
  store.linkCalendar(parent.id,{calendarId:'family',eventId:'shared-google',eventUrl:'https://www.google.com/calendar/event?eid=shared',fingerprint:parent.fingerprint});
  store.checkTask(parent.id,'math',{done:true,expectedText:'Gjør matte'});
  const before=store.snapshot().events[parent.id];
  const input={expectedFingerprint:before.fingerprint,expectedItems:before.task.items,completedFor:{math:['child3']}};
  const result=store.splitHomework(parent.id,input);
  const [maxId,alexId]=result.eventIds;
  const state=store.snapshot();
  assert.equal(state.events[maxId].title,'Forberedelser – Barn Tre');
  assert.deepEqual(state.events[maxId].members,['child3']);
  assert.deepEqual(state.events[alexId].members,['child4']);
  assert.deepEqual(state.events[maxId].sourceRefs,[raw.id]);
  assert.ok(state.events[maxId].task.items[0].doneAt);
  assert.equal(state.events[alexId].task.items[0].doneAt,null);
  assert.ok(state.events[parent.id].task.items[0].doneAt,'old completion receipt preserved');
  assert.equal(state.events[parent.id].visibility.hidden,true);
  assert.equal(store.calendarActions()[0].calendar.eventId,'shared-google');
  store.checkTask(alexId,'reading',{done:true,expectedText:'Les boka'});
  assert.equal(store.snapshot().events[maxId].task.items[1].doneAt,null);
  assert.equal(store.splitHomework(parent.id,input).alreadySplit,true);
  assert.ok(store.snapshot().events[alexId].task.items[1].doneAt,'retry retains new progress');
  assert.throws(()=>store.upsertFinding(raw.id,finding),/erstattet/);
  assert.throws(()=>store.setEventVisibility(parent.id,{hidden:false}),/erstattet/);
  const max=store.snapshot().events[maxId];
  store.upsertFinding(raw.id,{...max,replacePrevious:true,task:{...max.task,items:[...max.task.items,{key:'new',text:'Ny oppgave'}]}});
  assert.ok(store.snapshot().events[maxId].task.items[0].doneAt,'source update retains check');
  assert.ok(createStore(dir).snapshot().events[alexId].task.items[1].doneAt,'independent progress survives restart');
}));

test('splitting rejects stale checkbox state atomically and does not assume unknown shared checks belong to both',()=>fixture(store=>{
  const raw=store.upsertRaw({source:'vigilo',externalId:'week41',title:'Ukeplan'}).item;
  const parent=structuredClone(store.upsertFinding(raw.id,finding));
  store.checkTask(parent.id,'math',{done:true,expectedText:'Gjør matte'});
  assert.throws(()=>store.splitHomework(parent.id,{expectedFingerprint:parent.fingerprint,expectedItems:parent.task.items}),/endret/);
  assert.equal(Object.keys(store.snapshot().events).length,1);
  const current=store.snapshot().events[parent.id];
  const result=store.splitHomework(parent.id,{expectedFingerprint:current.fingerprint,expectedItems:current.task.items});
  assert.deepEqual(result.unassignedChecks,['math']);
  for(const id of result.eventIds) assert.equal(store.snapshot().events[id].task.items[0].doneAt,null);
  assert.ok(store.snapshot().events[parent.id].task.items[0].doneAt);
}));

test('splitting an already hidden family list preserves its hidden choice',()=>fixture(store=>{
  const raw=store.upsertRaw({source:'vigilo',externalId:'week41',title:'Ukeplan'}).item;
  const parent=store.upsertFinding(raw.id,finding);
  store.setEventVisibility(parent.id,{hidden:true});
  const current=store.snapshot().events[parent.id];
  const result=store.splitHomework(parent.id,{expectedFingerprint:current.fingerprint,expectedItems:current.task.items});
  for(const id of result.eventIds) assert.equal(store.snapshot().events[id].visibility.hidden,true);
  assert.equal(store.calendarActions().length,0);
}));
