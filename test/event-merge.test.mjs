import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';
import {encrypt,decrypt,loadKey} from '../src/crypto.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('service backup includes live aliases, original objects and choices without changing the archive or exporting plaintext',()=>fixture((s,dir)=>{
 const {store,a,b}=legacy(s,dir);store.mergeEvents(request(store,a,b));store.setEventVisibility(b,{hidden:true});
 const archive=readFileSync(join(dir,'archive.json.enc'));
 const receipt=store.backupArchive({label:'after-merge'}),file=join(dir,'backups',receipt.fileName);
 assert(existsSync(file));assert.equal(receipt.currentEvents,1);assert.equal(receipt.archivedEvents,2);
 assert(readFileSync(file).equals(archive)===false);assert(readFileSync(join(dir,'archive.json.enc')).equals(archive));
 const state=JSON.parse(decrypt(readFileSync(file),loadKey(dir)).toString('utf8'));
 assert.equal(state.events[b].mergedInto,a);assert.equal(state.events[a].visibility.hidden,true);
 assert.equal(state.events[b].canonicalKey,'old-key');assert.equal(readFileSync(file).includes(Buffer.from('Samme avtale')),false);
 assert.throws(()=>store.backupArchive({label:'../outside'}),/Ugyldig/);
}));
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'familien-merge-'));try{fn(createStore(dir),dir);}finally{if(!resolve(dir).startsWith(resolve(tmpdir())+'\\'))throw Error('Utrygg opprydding');rmSync(dir,{recursive:true,force:true});}}
const base={title:'Samme avtale',members:['child1'],start:'2026-10-10T16:00:00+02:00',end:'2026-10-10T17:00:00+02:00'};
function legacy(store,dir,task=null){
  const r1=store.upsertRaw({source:'vigilo',externalId:'source1',title:'Original 1'}).item;
  const r2=store.upsertRaw({source:'telefon',externalId:'source2',title:'Original 2'}).item;
  const a=store.upsertFinding(r1.id,{...base,canonicalKey:'native-key',...(task?{kind:'task',task}:{})});
  const b=store.upsertFinding(r2.id,{...base,canonicalKey:'old-key',...(task?{kind:'task',task}:{})});
  store.linkCalendar(a.id,{calendarId:'family',eventId:'google1',eventUrl:'https://calendar.google.com/event?id=google1'});
  assert.throws(()=>store.linkCalendar(b.id,{calendarId:'family',eventId:'google1',eventUrl:'https://calendar.google.com/event?id=google1'}),/tilhører allerede/);
  const s=store.snapshot();s.events[b.id].calendar={...s.events[a.id].calendar,fingerprint:b.fingerprint};
  writeFileSync(join(dir,'archive.json.enc'),encrypt(Buffer.from(JSON.stringify(s)),loadKey(dir)));
  return {store:createStore(dir),a:a.id,b:b.id,r1:r1.id,r2:r2.id};
}
function request(store,a,b){return {targetId:a,eventIds:[b],googleEventId:'google1',expectedEvents:{[a]:digest(store.eventHistory(a)),[b]:digest(store.eventHistory(b))}};}
test('canonical aliases, receipts and raw references survive merge/restart/retry; old source key updates the keeper',()=>fixture((s,dir)=>{
  let {store,a,b,r1,r2}=legacy(s,dir);const input=request(store,a,b);
  const dry=store.mergeEvents({...input,dryRun:true});assert.equal(dry.dryRun,true);assert.equal(Object.keys(store.snapshot().events).length,2);
  store.mergeEvents(input);assert.equal(Object.keys(store.snapshot().events).length,1);
  assert.equal(store.event(b).id,a);assert.equal(store.eventHistory(b).canonicalKey,'old-key');
  assert.deepEqual(new Set(store.event(a).sourceRefs),new Set([r1,r2]));
  assert.deepEqual(store.snapshot().rawItems[r2].findingIds,[a]);assert.equal(store.event(a).calendar.eventId,'google1');
  store=createStore(dir);assert.equal(store.mergeEvents(input).alreadyMerged,true);
  const updated=store.upsertFinding(r2,{...base,canonicalKey:'old-key',title:'Rettet avtale',replacePrevious:true});
  assert.equal(updated.id,a);assert.equal(updated.canonicalKey,'native-key');assert.equal(updated.eventMerge.eventIds[0],b);
}));
test('alias hide/delete/reopen controls one Google event, preserves revision guard and forbids deleted ID reuse',()=>fixture((s,dir)=>{
  const {store,a,b}=legacy(s,dir);store.mergeEvents(request(store,a,b));
  const hidden=store.setEventVisibility(b,{hidden:true});assert.equal(store.calendarActions().length,1);
  store.calendarAction(b,{revision:hidden.visibility.revision,action:'removed',googleEventId:'google1'});
  assert.equal(store.event(a).calendar.removedAt,store.event(b).calendar.removedAt);
  const opened=store.setEventVisibility(b,{hidden:false});
  assert.throws(()=>store.linkCalendar(a,{calendarId:'family',eventId:'google1',eventUrl:'https://calendar.google.com/event?id=google1',visibilityRevision:opened.visibility.revision}),/slettet/);
  store.linkCalendar(b,{calendarId:'family',eventId:'google2',eventUrl:'https://calendar.google.com/event?id=google2',visibilityRevision:opened.visibility.revision});
  assert.equal(store.calendarActions().length,0);assert.equal(store.event(a).calendar.eventId,'google2');
}));
test('concurrent checks reject stale migration, exact text progress is preserved and unmatched open tasks are not dropped',()=>fixture((s,dir)=>{
  const task={visibleFrom:'2026-10-10',dueDate:'2026-10-10',items:[{key:'prepare',text:'Pakk sekk'}]};
  const {store,a,b}=legacy(s,dir,task);const input=request(store,a,b);
  assert.throws(()=>store.mergeEvents({...input,googleEventId:'different'}),/samme Google/);
  const other=store.upsertFinding(store.snapshot().rawItems[Object.keys(store.snapshot().rawItems)[0]].id,{...base,canonicalKey:'wrong-date',start:'2026-10-11T16:00:00+02:00',end:'2026-10-11T17:00:00+02:00'});
  assert.throws(()=>store.mergeEvents({...request(store,a,other.id),eventIds:[other.id]}),/Ulike datoer/);
  store.checkTask(b,'prepare',{expectedText:'Pakk sekk',done:true});
  assert.throws(()=>store.mergeEvents(input),/familievalg er endret/);
  store.mergeEvents(request(store,a,b));assert.ok(store.event(a).task.items[0].doneAt);
  assert.equal(store.eventHistory(b).task.items[0].doneAt,store.event(a).task.items[0].doneAt);
}));
test('latest explicit family choice wins over an older hide, and mismatched identity is rejected',()=>fixture((s,dir)=>{
  let {store,a,b}=legacy(s,dir);const state=store.snapshot();
  state.events[a].visibility={hidden:true,revision:1,changedAt:'2026-10-01T10:00:00Z',sync:{status:'done'}};
  state.events[b].visibility={hidden:false,revision:2,changedAt:'2026-10-02T10:00:00Z',sync:{status:'done'}};
  writeFileSync(join(dir,'archive.json.enc'),encrypt(Buffer.from(JSON.stringify(state)),loadKey(dir)));store=createStore(dir);
  store.mergeEvents(request(store,a,b));assert.equal(store.event(a).visibility.hidden,false);
  assert.equal(store.eventHistory(a).eventMerge.versions[0].visibility.hidden,true);
}));
