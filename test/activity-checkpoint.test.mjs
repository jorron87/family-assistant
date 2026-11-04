import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createStore} from '../src/store.mjs';

test('failed activity checks retain the real successful checkpoint across restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-activity-checkpoint-'));
  try {
    const store=createStore(dir);
    const input={sourceId:'activity-1',details:'actually checked',scanTo:'2027-01-30T23:59:59+01:00'};
    const ok=store.activitySource({...input,health:'ok'});
    const partial=store.activitySource({...input,health:'partial',lastSuccessfulCheckAt:'2099-01-01T00:00:00Z'});
    assert.equal(partial.lastSuccessfulCheckAt,ok.checkedAt);
    const reopened=createStore(dir);
    const failed=reopened.activitySource({...input,health:'error'});
    assert.equal(failed.lastSuccessfulCheckAt,ok.checkedAt);
    assert.equal(failed.health,'error');
    const never=reopened.activitySource({...input,sourceId:'activity-12',health:'partial'});
    assert.equal(never.lastSuccessfulCheckAt,null);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a new successful list check cannot silently discard unresolved source items',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-activity-checkpoint-'));
  try {
    const store=createStore(dir);
    const input={sourceId:'activity-1',details:'actually checked',scanTo:'2027-01-30T23:59:59+01:00'};
    const ok=store.activitySource({...input,health:'ok'});
    store.activitySource({...input,health:'partial',unresolvedItems:[
      {externalId:'facebook:post:1',reason:'Source returned content unavailable'},
      {externalId:'facebook:post:2',reason:'Full post text unavailable'},
    ]});
    const reopened=createStore(dir);
    const stillPartial=reopened.activitySource({...input,health:'ok'});
    assert.equal(stillPartial.health,'partial');
    assert.equal(stillPartial.unresolvedItems.length,2);
    assert.equal(stillPartial.lastSuccessfulCheckAt,ok.checkedAt);
    assert.throws(()=>reopened.activitySource({...input,health:'ok',resolvedItems:[{externalId:'facebook:post:1',resolution:'read'}]}),/evidence/);
    assert.equal(reopened.snapshot().activitySourceStatus['activity-1'].unresolvedItems.length,2);
    const one=reopened.activitySource({...input,health:'ok',resolvedItems:[{externalId:'facebook:post:1',resolution:'read',evidence:'Actual post and comments read after access recovery.'}]});
    assert.equal(one.health,'partial');
    assert.deepEqual(one.unresolvedItems.map(x=>x.externalId),['facebook:post:2']);
    const done=reopened.activitySource({...input,health:'ok',resolvedItems:[{externalId:'facebook:post:2',resolution:'removed',evidence:'Source explicitly confirmed removal of this post.'}]});
    assert.equal(done.health,'ok');
    assert.deepEqual(done.unresolvedItems,[]);
    assert.equal(done.lastSuccessfulCheckAt,done.checkedAt);
    assert.deepEqual(createStore(dir).snapshot().activitySourceStatus['activity-1'].resolutionHistory.map(x=>x.externalId),['facebook:post:1','facebook:post:2']);
  } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));
    rmSync(dir,{recursive:true,force:true});
  }
});
