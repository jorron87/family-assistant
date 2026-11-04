import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertDisplayText,undoMojibake,prepareTextRepairs} from '../src/text-integrity.mjs';
import {createStore} from '../src/store.mjs';
import {encrypt,loadKey} from '../src/crypto.mjs';

test('display text rejects lossy imports but preserves questions and query URLs',()=>{
  for(const value of [{title:'Kropps?ving inne'},{task:{items:[{text:'Gj?r lekser p? arket.'}]}},{pitch:'GÃ¥ på skattejakt'},{checklist:['L?r ordene.']}])assert.throws(()=>assertDisplayText(value),/UTF-8/);
  for(const value of [{title:'Hva skjer rundt oss?'},{body:'Kan dere hjelpe? Se https://example.org/?q=c?t&next=p?x'},{text:'Oppgaven er å fylle inn c?t.'},{title:'Lørdag: øv på æ, ø og å'}])assert.doesNotThrow(()=>assertDisplayText(value));
});

test('mojibake inversion leaves intact Unicode and URLs unchanged',()=>{
  assert.equal(undoMojibake('GÃ¥ pÃ¥ tur â€“ Åse spør: blåbær? https://example.org/?q=1'),'Gå på tur – Åse spør: blåbær? https://example.org/?q=1');
  assert.equal(undoMojibake('æøå ÆØÅ café – 🎮'),'æøå ÆØÅ café – 🎮');
});

test('large unbroken extracts do not cause regex backtracking',()=>{
  assert.doesNotThrow(()=>assertDisplayText({body:'a'.repeat(1_000_000)}));
});

test('repair preparation rejects stale and non-text edits without mutating state',()=>{
  const state={events:{e:{title:'Sv?mming',start:'2026-11-05',task:{items:[{key:'stable',text:'Gj?r arket',doneAt:'2026-11-04'}]}}}};
  const change={collection:'events',id:'e',path:'title',before:'Sv?mming',after:'Svømming'};
  const prepared=prepareTextRepairs(state,[change]);assert.equal(prepared[0].record.title,'Svømming');assert.equal(state.events.e.title,'Sv?mming');
  assert.throws(()=>prepareTextRepairs(state,[change,{...change,path:'task.items.0.text',before:'stale',after:'rettet'}]),/endret/);
  assert.throws(()=>prepareTextRepairs(state,[{...change,path:'start'}]),/Ukjent/);
  assert.throws(()=>prepareTextRepairs(state,[{...change,after:'Ny svømmetime'}]),/restaurering/);
  assert.equal(state.events.e.title,'Sv?mming');
});

test('persisted repair preserves checks, identity and family choices and invalidates publishing receipts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'family-text-'));
  try {
    let store=createStore(dir);
    const raw=store.upsertRaw({source:'familie',externalId:'test-letter',title:'Ukeplan',body:'Gjør oppgaven.'}).item;
    const event=store.upsertFinding(raw.id,{canonicalKey:'test-homework',title:'Lekser',start:'2026-11-05T08:00:00Z',end:'2026-11-05T09:00:00Z'});
    const s=store.snapshot(),e=s.events[event.id],r=s.rawItems[raw.id];
    e.title='Gj?r lekser';e.checklist=['Gj?r arket'];e.task={visibleFrom:'2026-11-04',dueDate:'2026-11-05',items:[{key:'stable',text:'Gj?r arket',doneAt:'2026-11-04T09:00:00Z'}],history:[]};e.visibility={hidden:true,revision:3};e.calendar={eventId:'existing',fingerprint:e.fingerprint};
    r.body='Gj?r oppgaven.';r.driveRevision=r.revision;r.profileReviewedRevision=r.revision;
    writeFileSync(join(dir,'archive.json.enc'),encrypt(Buffer.from(JSON.stringify(s)),loadKey(dir)));store=createStore(dir);
    const before=store.snapshot(),token=store.beginRun().lease.token;
    const input={token,changes:[{collection:'events',id:e.id,path:'title',before:e.title,after:'Gjør lekser'},{collection:'events',id:e.id,path:'checklist.0',before:'Gj?r arket',after:'Gjør arket'},{collection:'events',id:e.id,path:'task.items.0.text',before:'Gj?r arket',after:'Gjør arket'},{collection:'rawItems',id:r.id,path:'body',before:r.body,after:'Gjør oppgaven.'}]};
    assert.throws(()=>store.repairText({...input,token:'wrong'}),/kjøringslås/);
    assert.equal(store.repairText({...input,dryRun:true}).dryRun,true);assert.equal(store.event(e.id).title,e.title);
    store.repairText(input);const after=createStore(dir).snapshot(),fixed=after.events[e.id];
    assert.equal(fixed.task.items[0].doneAt,e.task.items[0].doneAt);assert.equal(fixed.task.items[0].key,'stable');assert.deepEqual(fixed.visibility,e.visibility);assert.equal(fixed.calendar.eventId,'existing');assert.equal(fixed.canonicalKey,e.canonicalKey);assert.equal(fixed.start,e.start);
    assert.notEqual(fixed.fingerprint,fixed.calendar.fingerprint);assert.equal(after.rawItems[r.id].revision,r.revision+1);assert.equal(after.rawItems[r.id].profileReviewedRevision,r.revision+1);assert.equal(after.rawItems[r.id].driveRevision,r.revision);assert.deepEqual(after.documentReviews,before.documentReviews);
    assert.throws(()=>store.repairText(input),/endret/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
