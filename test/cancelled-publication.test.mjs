import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
test('cancelled unpublished mistakes need no Google event, but an existing appointment must be updated',()=>{
  const directory=mkdtempSync(join(tmpdir(),'familien-cancellation-'));
  try {
    const store=createStore(directory);
    const raw=store.upsertRaw({source:'vigilo',externalId:'test-cancellation',title:'Skoleplan'});
    const finding={canonicalKey:'local-mistake',title:'Skoleløp',start:'2030-10-10',end:'2030-10-11',members:['child3','child4']};
    const local=store.upsertFinding(raw.item.id,finding);
    assert.ok(store.completionReport().unsyncedCalendar.some(item=>item.eventId===local.id));
    store.upsertFinding(raw.item.id,{...finding,cancelled:true});
    assert.ok(!store.completionReport().unsyncedCalendar.some(item=>item.eventId===local.id));
    assert.equal(store.event(local.id).calendar,null);
    const published=store.upsertFinding(raw.item.id,{...finding,canonicalKey:'published-appointment'});
    store.linkCalendar(published.id,{calendarId:'family',eventId:'existing-google',fingerprint:published.fingerprint});
    store.upsertFinding(raw.item.id,{...finding,canonicalKey:'published-appointment',cancelled:true});
    assert.ok(store.completionReport().unsyncedCalendar.some(item=>item.eventId===published.id));
  } finally {rmSync(directory,{recursive:true,force:true});}
});
