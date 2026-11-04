import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {reconcileSourceReviews} from '../src/source-reviews.mjs';
import {createStore} from '../src/store.mjs';
import {loginProblems} from '../public/login-status.mjs';
const now=Date.parse('2026-11-04T19:00:00Z');
const report={id:'synthetic-full-review',scope:'alle',outcome:'partial',finishedAt:'2026-11-04T06:30:00Z',sources:[{source:'spond',health:'ok',details:'Posts, events, files and polls reviewed completely.'},{source:'facebook',health:'partial',details:'Group feed reviewed; one original remains unavailable.'}]};
test('full source receipts repair the stale banner with their actual original time',()=>{
 const status={spond:{health:'ok',checkedAt:'2026-11-03T06:00:00Z'}};
 assert.ok(loginProblems({sourceStatus:status,now}).some(p=>p.source==='spond'));
 assert.equal(reconcileSourceReviews(status,[report],now),2);
 assert.equal(status.spond.checkedAt,report.finishedAt);assert.equal(status.spond.reviewRunId,report.id);
 assert.equal(status.facebook.health,'partial');
 assert.ok(!loginProblems({sourceStatus:status,now}).some(p=>p.source==='spond'));
 assert.equal(reconcileSourceReviews(status,[report],now),0,'restart does not move the receipt to now');
});
test('change scopes, strings, vague reports and future reports do not claim full source coverage',()=>{
 for(const override of [{scope:'kildeendringer'},{scope:'familiehandlinger'},{outcome:'skipped'},{scope:undefined},{sources:['spond']},{sources:[{source:'spond',health:'ok',details:'ok'}]},{finishedAt:'2099-01-01T00:00:00Z'}]){
  const status={};assert.equal(reconcileSourceReviews(status,[{...report,...override}],now),0);assert.deepEqual(status,{});
 }
 const newer={spond:{health:'needs_login',checkedAt:'2026-11-04T18:00:00Z'}};
 reconcileSourceReviews(newer,[report],now);assert.equal(newer.spond.health,'needs_login','newer real failures remain visible');
});
test('a full report persists explicit source receipts without changing unread surfaces',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-source-review-'));
 try{
  const store=createStore(dir);store.updateSurface({source:'spond',surface:'still-unread',health:'partial',nextPageHint:'Unread details remain'});
  const run=store.recordRun({...report,blockers:['One unavailable original still needs attention.'],resumeHint:'Continue only after access changes.'});
  assert.equal(store.snapshot().sourceStatus.spond.checkedAt,run.finishedAt);
  assert.equal(store.snapshot().surfaces['spond:still-unread'].health,'partial');
  const restarted=createStore(dir);assert.equal(restarted.snapshot().sourceStatus.spond.checkedAt,run.finishedAt);
  restarted.recordRun({...report,scope:'kildeendringer',sources:[{source:'spond',health:'ok',details:'Only changed items were reviewed.'}],blockers:['One unavailable original still needs attention.'],resumeHint:'Wait for new access.'});
  assert.equal(restarted.snapshot().sourceStatus.spond.reviewRunId,run.id);
 }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'family-source-review-')));rmSync(dir,{recursive:true,force:true});}
});
