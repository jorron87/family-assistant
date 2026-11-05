import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {loadKey,encrypt,decrypt} from '../src/crypto.mjs';
import {changeSignal} from '../src/ingestion-dispatch.mjs';

const input={canonicalKey:'original',title:'Verksted',reason:'Familieverksted',evidence:'Dato og innhold fra arrangøren',
  start:'2030-10-19T17:00:00+02:00',end:'2030-10-19T19:00:00+02:00',sourceId:'activity-1',
  sourceUrl:'https://www.facebook.com/events/9675750046998519/',members:['child3','child4'],checkedAt:'2026-10-08T07:00:00Z'};
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'familien-activity-identity-'));
  t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});});
  return {dir,store:createStore(dir)};
}
function seedLegacy(dir,base,rows) {
  const file=join(dir,'archive.json.enc'),key=loadKey(dir);
  const state=JSON.parse(decrypt(readFileSync(file),key).toString('utf8'));
  for(const row of rows) {
    const id=createHash('sha256').update(row.canonicalKey).digest('hex').slice(0,24);
    state.activities[id]={...base,...row,id};
  }
  writeFileSync(file,encrypt(Buffer.from(JSON.stringify(state)),key));
  return createStore(dir);
}
test('native Facebook identity survives a new title/key and preserves hiding and old aliases',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  store.activityReaction(first.id,{action:'hidden'});
  const second=store.upsertActivity({...input,canonicalKey:'reworded',title:'Halloween-verksted',sourceUrl:input.sourceUrl+'?acontext=changed'});
  assert.equal(second.id,first.id);assert.equal(second.canonicalKey,'original');assert.equal(second.reaction,'hidden');
  assert.ok(second.canonicalAliases.includes('reworded'));
  const restarted=createStore(dir);
  assert.equal(restarted.upsertActivity({...input,canonicalKey:'reworded',sourceUrl:'https://example.org/changed'}).id,first.id);
});
test('different occurrences and non-Facebook URLs are not merged on title or URL similarity',t=>{
  const {store}=fixture(t);const first=store.upsertActivity(input);
  const other=store.upsertActivity({...input,canonicalKey:'next-occurrence',start:'2030-10-20T17:00:00+02:00',end:'2030-10-20T19:00:00+02:00'});
  assert.notEqual(first.id,other.id);
  const third=store.upsertActivity({...input,canonicalKey:'other-site',sourceUrl:'https://example.org/events/9675750046998519/'});
  assert.notEqual(first.id,third.id);
});

test('explicit native keys and aliases preserve identity when the source link changes to the organizer',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  store.activityReaction(first.id,{action:'hidden'});
  const nativeKey='facebook:event:9675750046998519:2030-10-19';
  const onWebsite=store.upsertActivity({...input,canonicalKey:nativeKey,sourceUrl:'https://example.org/workshop'});
  assert.equal(onWebsite.id,first.id);assert.equal(onWebsite.canonicalKey,first.canonicalKey);assert.equal(onWebsite.reaction,'hidden');
  assert.ok(onWebsite.canonicalAliases.includes(nativeKey));
  const restored=createStore(dir),fromFacebook=restored.upsertActivity({...input,canonicalKey:'new-heading'});
  assert.equal(fromFacebook.id,first.id);assert.equal(fromFacebook.reaction,'hidden');
  const next=restored.upsertActivity({...input,canonicalKey:'facebook:event:9675750046998519:2030-10-20',sourceUrl:'https://example.org/workshop',start:'2030-10-20T17:00:00+02:00',end:'2030-10-20T19:00:00+02:00'});
  assert.notEqual(next.id,first.id);
});
test('legacy duplicates retain original fields and old IDs route family actions to the surviving card',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  const seeded=seedLegacy(dir,first,[{canonicalKey:'second',title:'Second',reaction:'hidden'},{canonicalKey:'third',title:'Third'}]);
  const before=seeded.snapshot().activities;
  const result=seeded.upsertActivity(input),after=seeded.snapshot().activities;
  assert.equal(result.id,first.id);assert.equal(result.reaction,'hidden');
  assert.equal(Object.values(after).filter(x=>!x.mergedInto).length,1);
  for(const old of Object.values(before).filter(x=>x.id!==first.id)) {
    assert.deepEqual(Object.fromEntries(Object.entries(after[old.id]).filter(([key])=>!['mergedInto','mergedAt'].includes(key))),old);
    assert.equal(createStore(dir).activityReaction(old.id,{action:'restore'}).id,first.id);
  }
});
test('conflicting family choices reject the merge without changing the archive',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  store.activityReaction(first.id,{action:'interested'});
  const seeded=seedLegacy(dir,first,[{canonicalKey:'second',reaction:'hidden'}]);
  const before=seeded.snapshot();assert.throws(()=>seeded.upsertActivity(input),/motstridende/);
  assert.deepEqual(seeded.snapshot(),before);
});
test('a chosen calendar plan keeps its original identity and counts only once',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  const chosen={status:'pending',requestedAt:'2026-10-08T07:00:00Z',members:['child3','child4']};
  const seeded=seedLegacy(dir,first,[{canonicalKey:'chosen',plan:chosen}]);
  const result=seeded.upsertActivity(input);
  assert.equal(result.canonicalKey,'chosen');assert.deepEqual(result.plan,chosen);
  assert.equal(seeded.changeCompletion().counts.activityPlans,1);
  assert.equal(changeSignal(seeded).count,1,'archived plans cannot wake a second worker');
  assert.equal(seeded.activityReaction(first.id,{action:'cancel-plan'}).id,result.id);
});
test('invalid source input cannot partially mark existing duplicates as merged',t=>{
  const {dir,store}=fixture(t),first=store.upsertActivity(input);
  const seeded=seedLegacy(dir,first,[{canonicalKey:'second'}]),before=seeded.snapshot();
  assert.throws(()=>seeded.upsertActivity({...input,checkedAt:'2099-01-01T00:00:00Z'}),/fremtiden/);
  assert.deepEqual(seeded.snapshot(),before);
});
