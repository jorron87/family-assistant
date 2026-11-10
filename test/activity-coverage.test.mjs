import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCoverage, validateActivityRun } from '../src/activity-coverage.mjs';

const config = { dailyLookaheadDays: 30, weeklyLookaheadDays: 90,
  sources: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };

test('Sunday event horizon does not expand discussion history and partial cannot advance its checkpoint', () => {
  const cfg={...config,sources:[{id:'activity-1'}]};
  const result=activityCoverage(cfg,{'activity-1':{health:'partial',checkedAt:'2026-11-01T06:18:00Z',lastSuccessfulCheckAt:'2026-10-31T08:04:55Z',scanTo:'2026-10-31T23:59:59+01:00'}},new Date('2026-11-01T08:00:00Z'));
  assert.equal(result.targetThrough,'2027-01-30');
  assert.equal(result.pending[0].discussionFrom,'2026-10-28T08:04:55.000Z');
  assert.equal(result.pending[0].reason,'partial');
  assert.equal(result.complete,false);
  for(const lastSuccessfulCheckAt of [null,'bad','2027-01-01T00:00:00Z']) {
    const pending=activityCoverage(cfg,{'activity-1':{health:'partial',lastSuccessfulCheckAt}},new Date('2026-11-01T08:00:00Z')).pending[0];
    assert.equal(pending.discussionFrom,'2026-10-02T08:00:00.000Z');
  }
});

test('requires actual current-day coverage through the lookahead date', () => {
  const at = new Date('2026-09-28T06:00:00Z');
  const result = activityCoverage(config, {
    a: { health: 'ok', checkedAt: '2026-09-28T05:00:00Z', scanTo: '2026-10-28T22:00:00Z' },
    b: { health: 'partial', checkedAt: '2026-09-28T05:00:00Z', scanTo: '2026-09-28T05:00:00Z' },
  }, at);
  assert.equal(result.targetThrough, '2026-10-28');
  assert.equal(result.pendingCount, 1);
  assert.equal(result.pending[0].sourceId, 'b');
  assert.equal(result.pending[0].reason, 'partial');
});

test('unresolved item IDs remain visible even beside a reported successful list scan',()=>{
  const item={externalId:'facebook:post:1',reason:'Actual content unavailable'};
  const result=activityCoverage(config,{a:{health:'ok',checkedAt:'2026-11-03T06:00:00Z',scanTo:'2026-12-10',unresolvedItems:[item]}},new Date('2026-11-03T08:00:00Z'));
  assert.equal(result.pending[0].reason,'partial');
  assert.deepEqual(result.pending[0].unresolvedItems,[item]);
  assert.equal(result.complete,false);
});

test('Sunday requires 90 days and previous-day checks are stale', () => {
  const result = activityCoverage(config, {
    a: { health: 'ok', checkedAt: '2026-09-26T18:00:00Z', scanTo: '2026-12-30T22:00:00Z' },
    b: { health: 'ok', checkedAt: '2026-09-27T06:00:00Z', scanTo: '2026-10-27T22:00:00Z' },
  }, new Date('2026-09-27T06:00:00Z'));
  assert.equal(result.targetThrough, '2026-12-26');
  assert.deepEqual(result.pending.map(x => x.reason), ['stale', 'short_window']);
});

test('ordinary run cannot silently leave activity sources unfinished', () => {
  const coverage = activityCoverage(config, {}, new Date('2026-09-28T06:00:00Z'));
  assert.throws(() => validateActivityRun(coverage, { outcome: 'ok' }), /ikke ferdig/);
  assert.throws(() => validateActivityRun(coverage, { outcome: 'partial', blockers: ['Vigilo trenger innlogging'] }), /activity-source|Aktivitetskilder/);
  assert.throws(() => validateActivityRun(coverage, { scope:'alle',outcome: 'continued', blockers: ['Vigilo trenger innlogging'] }), /activity-source|Aktivitetskilder/,'a source checkpoint cannot bypass unread activity sources');
  assert.throws(() => validateActivityRun(coverage, { outcome: 'partial', blockers: ['a: ekstern feil', 'b: ekstern feil'] }), /Manglende besøk/);
  const attempted = activityCoverage(config, {a:{health:'error'},b:{health:'needs_login'}}, new Date('2026-09-28T06:00:00Z'));
  assert.doesNotThrow(() => validateActivityRun(attempted, { outcome: 'partial', blockers: ['a: nettleserverktøyet feiler ved åpning', 'b: innloggingssiden krever familiehandling'] }));
  assert.doesNotThrow(() => validateActivityRun(coverage, { scope: 'familiehandlinger', outcome: 'ok' }));
});

test('listing stale source IDs as blockers cannot replace doing the daily review', () => {
  const cfg={dailyLookaheadDays:30,weeklyLookaheadDays:90,sources:[{id:'activity-1'},{id:'activity-12'},{id:'activity-26'}]};
  const prior=Object.fromEntries(cfg.sources.map(s=>[s.id,{health:'ok',checkedAt:'2026-10-28T08:00:00Z',scanTo:'2026-12-06T23:59:59+01:00'}]));
  const coverage=activityCoverage(cfg,prior,new Date('2026-10-29T06:08:00Z'));
  assert.throws(()=>validateActivityRun(coverage,{scope:'alle',outcome:'partial',blockers:['activity-1, activity-12 og activity-26 mangler dagens kontroll av Upcoming-liste og søk']}),/Manglende besøk/);
  const short=activityCoverage(config,{a:{health:'ok',checkedAt:'2026-10-29T06:00:00Z',scanTo:'2026-11-14T00:00:00Z'},b:{health:'partial',checkedAt:'2026-10-29T06:00:00Z'}},new Date('2026-10-29T07:00:00Z'));
  assert.throws(()=>validateActivityRun(short,{outcome:'partial',blockers:['a: listen gjenstår etter 14.11','b: faktisk feil']}),/a/);
  const knownFailure=activityCoverage(config,{a:{health:'partial',checkedAt:'2026-10-28T06:00:00Z'},b:{health:'error',checkedAt:'2026-10-28T06:00:00Z'}},new Date('2026-10-29T07:00:00Z'));
  assert.doesNotThrow(()=>validateActivityRun(knownFailure,{outcome:'partial',blockers:['a: kjent vedvarende Facebook-pagineringsfeil, kontrollpunkt gjenbrukt','b: kjent ekstern HTTP-feil, ingen ny informasjon']}));
});
