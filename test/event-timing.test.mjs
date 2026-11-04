import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createStore} from '../src/store.mjs';
test('known date and unknown duration do not make an appointment provisional; date conflicts remain provisional',()=>{
 const dir=mkdtempSync(join(tmpdir(),'familien-date-test-'));
 try{
 const store=createStore(dir),a=store.upsertRaw({source:'vigilo',externalId:'date-test',title:'Plan'}).item;
 const event=store.upsertFinding(a.id,{canonicalKey:'known-date',title:'Legetime',start:'2026-10-01T09:00:00+02:00',end:'2026-10-01T10:00:00+02:00',provisional:true,dateConfirmed:true,timeNote:'Sluttid er anslått.'});
 assert.equal(event.provisional,false);assert.equal(event.timeNote,'Sluttid er anslått.');
 const day=store.upsertFinding(a.id,{canonicalKey:'school-day',title:'Uteskole',allDay:true,start:'2026-10-08',end:'2026-10-09',dateConfirmed:true,provisional:false});assert.equal(day.provisional,false);assert.equal(day.allDay,true);
 const b=store.upsertRaw({source:'spond',externalId:'conflict',title:'Endring'}).item;
 const conflict=store.upsertFinding(b.id,{canonicalKey:'known-date',title:'Legetime',start:'2026-10-02T09:00:00+02:00',end:'2026-10-02T10:00:00+02:00',dateConfirmed:false});assert.equal(conflict.provisional,true);
 }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}
});
