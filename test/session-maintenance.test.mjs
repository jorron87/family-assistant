import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSessionMaintenance} from '../src/session-maintenance.mjs';

function fixture(t){
  const dataDir=mkdtempSync(join(tmpdir(),'familien-session-test-'));
  t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  let time=Date.parse('2026-09-28T15:00:00Z');
  return {dataDir,now:()=>time,advance:ms=>{time+=ms;}};
}
const ok={health:'ok',code:'authenticated',version:'1.2.0',intervalSeconds:60,keeperProtected:true};

test('history survives restart and preserves a login-loss transition',t=>{
  const f=fixture(t),first=createSessionMaintenance(f);
  first.record(ok);const at=first.snapshot().checkedAt;
  f.advance(60000);first.record({health:'needs_login',code:'login_required',version:'1.2.0',intervalSeconds:60});
  const restarted=createSessionMaintenance(f);
  assert.equal(restarted.snapshot().lastAuthenticatedAt,at);
  assert.equal(restarted.snapshot().health,'needs_login');
  assert.equal(restarted.history().events.length,2);
  assert.equal(restarted.snapshot().continuousSince,null);
});

test('stale ok cannot hide a stopped browser and the reporting gap is retained',t=>{
  const f=fixture(t),store=createSessionMaintenance(f);store.record(ok);
  f.advance(181000);assert.equal(store.snapshot().health,'error');assert.equal(store.snapshot().stale,true);
  store.record(ok);assert.equal(store.snapshot().reportGapMs,181000);
  assert.equal(store.snapshot().continuousSince,store.snapshot().checkedAt);
});

test('only allowed diagnostics are persisted, never arbitrary text or URLs',t=>{
  const f=fixture(t),store=createSessionMaintenance(f);
  store.record({...ok,details:'PRIVATE',url:'PRIVATE',token:'PRIVATE',code:'PRIVATE',version:'PRIVATE',probeGapMs:NaN});
  assert(!readFileSync(join(f.dataDir,'vigilo-session-health.json'),'utf8').includes('PRIVATE'));
  assert.equal(store.snapshot().upgradeRequired,true);
});

test('ordinary minute probes are sampled in history while latest stays fresh',t=>{
  const f=fixture(t),store=createSessionMaintenance(f);store.record(ok);
  for(let i=0;i<16;i++){f.advance(60000);store.record(ok);}
  assert.equal(store.history().events.length,2);
  assert.equal(store.snapshot().checkedAt,new Date(f.now()).toISOString());
  assert.equal(store.snapshot().stale,false);
});
