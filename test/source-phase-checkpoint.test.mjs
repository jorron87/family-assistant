import test from 'node:test';
import assert from 'node:assert/strict';
import {sourcePhaseFingerprint,currentSourcePhase} from '../src/source-phase-checkpoint.mjs';
const AT=Date.parse('2026-11-10T08:00:00Z');
const fixture=()=>({sourceStatus:{spond:{health:'partial',details:'One original remains blocked.',checkedAt:'2026-11-10T07:00:00Z'}},rawItems:{one:{revision:1,driveRevision:1,profileReviewedRevision:1}},events:{},reviewLedger:{},surfaces:{},profile:{members:[]},activities:{},activityFeed:{},phone:{inbox:{}},shopping:{stockIntakes:{}}});
test('a source phase ignores shopping price churn and keeps actual unresolved source outcomes',()=>{
  const state=fixture(),fingerprint=sourcePhaseFingerprint(state);
  state.sourcePhaseCheckpoint={version:1,fingerprint,startedAt:'2026-11-10T07:00:00Z',checkedAt:new Date(AT).toISOString(),runId:'source-run',blockers:['One original remains blocked.'],sources:[{source:'spond',health:'partial'}]};
  state.shopping.sesumPrices={revision:2000};state.shopping.catalog={revised:'new'};state.shopping.watches={one:{stockAmount:5}};state.runLease={startedAt:new Date(AT+1000).toISOString()};state.runs=[{outcome:'continued'}];state.sourceStatus.spond.checkedAt=new Date(AT+1000).toISOString();
  const phase=currentSourcePhase(state,AT+60000);assert.equal(phase.current,true);assert.equal(phase.fingerprint,fingerprint);assert.deepEqual(phase.checkpoint.blockers,['One original remains blocked.']);assert.equal(state.sourceStatus.spond.health,'partial');
  assert.equal(currentSourcePhase(state,AT+13*3600000).current,false);assert.equal(currentSourcePhase(state,AT-1).current,false);
});
test('new source semantics and family actions preempt source-phase reuse',()=>{
  for(const change of [s=>s.rawItems.one.revision++,s=>s.sourceStatus.spond.details='A different source blocker.',s=>s.phone.inbox.new={status:'done',rawId:'phone-new'},s=>s.shopping.stockIntakes.new={status:'reviewed'},s=>s.events.one={fingerprint:'new',visibility:{hidden:true}}]){
    const state=fixture();state.sourcePhaseCheckpoint={version:1,runId:'source-run',fingerprint:sourcePhaseFingerprint(state),startedAt:new Date(AT-1000).toISOString(),checkedAt:new Date(AT).toISOString()};change(state);assert.equal(currentSourcePhase(state,AT+1000).current,false);
  }
});
test('new activity holes preempt source reuse while repeated receipt timestamps do not',()=>{
  const state=fixture();state.activitySourceStatus={activities:{sourceId:'activities',health:'ok',details:'Actual current activity feed was read.',scanTo:'2026-12-10T23:00:00Z',nextPageHint:'Next ordinary daily read.',checkedAt:'2026-11-10T07:55:00Z',unresolvedItems:[]}};
  const fingerprint=sourcePhaseFingerprint(state);state.sourcePhaseCheckpoint={version:1,runId:'source-run',fingerprint,startedAt:'2026-11-10T07:00:00Z',checkedAt:new Date(AT).toISOString()};
  state.activitySourceStatus.activities.checkedAt='2026-11-10T08:00:30Z';state.activitySourceStatus.activities.lastSuccessfulCheckAt='2026-11-10T08:00:30Z';
  assert.equal(sourcePhaseFingerprint(state),fingerprint);assert.equal(currentSourcePhase(state,AT+60000).current,true);
  state.activitySourceStatus.activities.health='partial';state.activitySourceStatus.activities.unresolvedItems=[{externalId:'actual-new-post',reason:'A genuinely new linked original remains unreadable.',firstObservedAt:'2026-11-10T08:00:30Z',lastAttemptedAt:'2026-11-10T08:00:30Z'}];
  assert.notEqual(sourcePhaseFingerprint(state),fingerprint);assert.equal(currentSourcePhase(state,AT+60000).current,false);
  const blockedFingerprint=sourcePhaseFingerprint(state);state.activitySourceStatus.activities.unresolvedItems[0].lastAttemptedAt='2026-11-10T08:01:30Z';assert.equal(sourcePhaseFingerprint(state),blockedFingerprint,'an identical retry receipt does not manufacture changed source semantics');
});
test('the same page error preserves a source checkpoint but a changed actual error reopens it',()=>{
  const state=fixture();state.activityFeed.pages={page:{hash:'current-page',reviewedHash:'current-page',error:{at:'2026-11-10T07:55:00Z',message:'The same supplemental page timed out.'}}};
  const fingerprint=sourcePhaseFingerprint(state);state.sourcePhaseCheckpoint={version:1,runId:'source-run',fingerprint,startedAt:'2026-11-10T07:00:00Z',checkedAt:new Date(AT).toISOString()};
  state.activityFeed.pages.page.error.at='2026-11-10T08:00:30Z';assert.equal(sourcePhaseFingerprint(state),fingerprint);assert.equal(currentSourcePhase(state,AT+60000).current,true);
  state.activityFeed.pages.page.error.message='The source now explicitly requires a new login.';assert.notEqual(sourcePhaseFingerprint(state),fingerprint);assert.equal(currentSourcePhase(state,AT+60000).current,false);
});
