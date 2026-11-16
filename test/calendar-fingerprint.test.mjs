import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createStore} from '../src/store.mjs';

function fixture(run){
 const dir=mkdtempSync(join(tmpdir(),'family-calendar-fingerprint-'));
 try{run(createStore(dir),dir);}finally{
  assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));
  rmSync(dir,{recursive:true,force:true});
 }
}
const pickup={canonicalKey:'renovasjon:synthetic:street:1:2026-12-01',title:'Waste pickup',start:'2026-12-01',end:'2026-12-02',allDay:true,members:[],details:'Paper and food',checklist:['Put bins out'],replacePrevious:true,correctsPrevious:true};
const source={source:'renovasjon',externalId:'synthetic:street:1',title:'Synthetic waste calendar',body:'Upcoming dates: December 1 and 15',memberIds:[]};

test('a rolling waste horizon keeps unchanged pickup receipts, but real pickup and source-link changes invalidate them',()=>fixture((store,dir)=>{
 const raw=store.upsertRaw({...source,findings:[pickup]}).item;
 const event=Object.values(store.snapshot().events)[0];
 store.linkCalendar(event.id,{calendarId:'synthetic',eventId:'pickup',eventUrl:'https://www.google.com/calendar/event?eid=synthetic',fingerprint:event.fingerprint});
 const receipt=store.snapshot().events[event.id].calendar;
 store.upsertRaw({...source,body:'Upcoming dates: December 1 and 29',findings:[pickup]});
 assert.equal(store.snapshot().events[event.id].fingerprint,receipt.fingerprint);
 assert.equal(store.snapshot().rawItems[raw.id].revision,2,'archive still retains the current source revision');
 assert.equal(createStore(dir).snapshot().events[event.id].fingerprint,receipt.fingerprint,'restart keeps the same basis');
 store.upsertFinding(raw.id,{...pickup,details:'Paper only',title:'Paper pickup'});
 assert.notEqual(store.snapshot().events[event.id].fingerprint,receipt.fingerprint);
 const changed=store.snapshot().events[event.id].fingerprint;
 store.upsertFinding(raw.id,{...pickup,details:'Paper only',title:'Paper pickup',cancelled:true});
 assert.notEqual(store.snapshot().events[event.id].fingerprint,changed);
 const cancelled=store.snapshot().events[event.id].fingerprint;
 store.linkDrive(raw.id,null,'https://drive.google.com/file/d/synthetic/view');
 assert.notEqual(store.snapshot().events[event.id].fingerprint,cancelled);
}));

test('ordinary reviewed sources and non-adapter findings remain bound to raw revision',()=>fixture(store=>{
 for(const input of [{...source,source:'vigilo',externalId:'synthetic-news'},{...source}]){
  const key=input.source==='vigilo'?'school:synthetic':'manual:synthetic';
  const raw=store.upsertRaw({...input,findings:[{...pickup,canonicalKey:key}]}).item;
  const before=Object.values(store.snapshot().events).find(e=>e.canonicalKey===key).fingerprint;
  store.upsertRaw({...input,body:'Materially changed source content'});
  assert.notEqual(Object.values(store.snapshot().events).find(e=>e.canonicalKey===key).fingerprint,before);
 }
}));
