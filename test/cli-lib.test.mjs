import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonArg, slimCompletion, slimReviewQueue, slimResult, slimProfile, slimPhone, buildNext } from '../src/cli-lib.mjs';

test('readJsonArg leser inline JSON, stdin og gir tydelig feil', () => {
  assert.deepEqual(readJsonArg('{"a":1}'), { a: 1 });
  assert.deepEqual(readJsonArg('[1,2]'), [1, 2]);
  assert.deepEqual(readJsonArg('-', () => '{"b":2}'), { b: 2 });
  assert.throws(() => readJsonArg('{oops'), /Ugyldig JSON \(inline\)/);
  assert.throws(() => readJsonArg(undefined), /JSON mangler/);
});

test('readJsonArg accepts PowerShell UTF-8 BOM files and stdin without losing Norwegian text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-json-'));
  try {
    const file = join(dir, 'run.json');
    const report = {scope:'kildeendringer', outcome:'ok', summary:'Gjennomgått rådata og kalender.'};
    const text = '\uFEFF' + JSON.stringify(report);
    writeFileSync(file, text, 'utf8');
    assert.deepEqual(readJsonArg(file), report);
    assert.deepEqual(readJsonArg('-', () => text), report);
    assert.throws(() => readJsonArg('-', () => '\uFEFF{oops'), /Ugyldig JSON/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('slimCompletion dropper historikk, kapper lister og bevarer counts', () => {
  const report = {
    complete: false, counts: { missingDrive: 30 }, missingDrive: Array.from({ length: 30 }, (_, i) => ({ rawId: String(i) })),
    historicalItems: [1, 2, 3], historicalMissingDrive: [1], historicalSurfaces: [], cutoffAt: 'x'
  };
  const slim = slimCompletion(report);
  assert.equal(slim.counts.missingDrive, 30);
  assert.equal(slim.missingDrive.length, 21);
  assert.deepEqual(slim.missingDrive[20], { truncated: 10 });
  assert.equal(slim.historicalItems, undefined);
  assert.equal(slim.historical.items, 3);
  assert.equal(slimCompletion(report, { history: true }).historicalItems.length, 3);
  assert.equal(slimCompletion(report, { full: true }), report);
});

test('slimReviewQueue beholder bare åpne overflater og Vigilo-problemer', () => {
  const queue = {
    surfaces: { a: { health: 'ok' }, b: { health: 'partial' }, c: { health: 'ok', nextPageHint: 'side 2' }, d: { health: 'ok', currentComplete: false } },
    vigiloCoverage: [{ issues: [] }, { issues: ['x'] }], items: [{ externalId: '1' }]
  };
  const slim = slimReviewQueue(queue);
  assert.deepEqual(Object.keys(slim.surfaces), ['b', 'c', 'd']);
  assert.equal(slim.surfaceCount, 4);
  assert.equal(slim.vigiloCoverage.length, 1);
  assert.equal(slim.items.length, 1);
});

test('buildNext prioriterer telefon og kalenderhandling og er ferdig bare uten arbeid', () => {
  const next = buildNext({
    phone: [{ id: 'p1', title: 'Brev', status: 'queued' }, { id: 'p2', status: 'done' }],
    calendarActions: [{ eventId: 'e1', action: 'remove', title: 'Skjult' }],
    completion: { complete: false, counts: {}, profileReviews: [{ rawId: 'r1', title: 'T' }], missingDrive: [], unsyncedCalendar: [], incompleteSurfaces: [{ source: 'spond', surface: 's', health: 'partial' }] },
    queue: { items: [{ source: 'vigilo', surface: 'child3:news', externalId: 'v1', reason: 'new' }] },
    activities: { pending: [{ sourceId: 'activity-3', name: 'Asker', reason: 'stale' }] }
  });
  assert.deepEqual(next.work.map((w) => w.do), ['phone', 'calendar-action', 'review', 'profile-review', 'surface', 'activity-source']);
  assert.equal(next.complete, false);
  const done = buildNext({ phone: [], calendarActions: [], completion: { complete: true, counts: {} }, queue: { items: [] }, activities: { pending: [] } });
  assert.equal(done.complete, true);
  assert.equal(done.remaining, 0);
});

test('slimProfile beholder aktive fakta og kandidater, dropper duplisert historikk', () => {
  const profile = { familyName: 'F', members: [{ id: 'child3', name: 'Barn Tre', role: 'child', extra: 'x' }], facts: [{}, {}, {}], activeFacts: [{ memberId: 'child3', key: 'k', text: 't', category: 'hobby', confidence: 'confirmed', evidence: ['lang'], id: 'i', source: 's' }], candidates: [] };
  const slim = slimProfile(profile);
  assert.equal(slim.facts, undefined);
  assert.deepEqual(slim.activeFacts[0], { memberId: 'child3', key: 'k', text: 't', category: 'hobby', confidence: 'confirmed' });
  assert.equal(slim.history.facts, 3);
  assert.deepEqual(slim.candidates, []);
  assert.equal(slimProfile(profile, { full: true }), profile);
});

test('slimPhone gir samme listeform, uten ferdige innsendinger', () => {
  const list = [{ id: 'a', status: 'done' }, { id: 'b', status: 'blocked' }, { id: 'c', status: 'cancelled' }, { id: 'd', status: 'queued' }];
  assert.deepEqual(slimPhone(list).map((item) => item.id), ['b', 'd']);
  assert.equal(slimPhone(list, { all: true }).length, 4);
});

test('slimResult gir kvittering for intake og hendelse, med fingerprint og needsCalendar', () => {
  const event = { id: 'e1', canonicalKey: 'k', title: 'T', kind: 'event', start: '2026-10-01', end: '2026-10-02', allDay: true, members: ['child3'], details: 'lang tekst', sourceRefs: ['r1'], fingerprint: 'f2', calendar: { calendarId: 'c', eventId: 'g', eventUrl: 'u', fingerprint: 'f1' } };
  const raw = { id: 'r1', source: 'vigilo', externalId: 'x', title: 'T', revision: 2, body: 'HELE KILDETEKSTEN', attachments: [{ id: 'a1', fileName: 'p.pdf', sha256: 's', bytes: 'stor' }], driveUrl: 'd', driveRevision: 1 };
  const result = slimResult({ item: raw, changed: true, findings: [event] });
  assert.equal(JSON.stringify(result).includes('HELE KILDETEKSTEN'), false);
  assert.equal(result.item.needsCard, true);
  assert.equal(result.findings[0].needsCalendar, true);
  assert.equal(result.findings[0].calendar.fingerprint, 'f1');
  assert.equal(result.findings[0].details, undefined);
  assert.equal(slimResult(event).id, 'e1');
  const synced = slimResult({ ...event, calendar: { ...event.calendar, fingerprint: 'f2' } });
  assert.equal(synced.needsCalendar, false);
  assert.equal(slimResult({ a: 1 }).a, 1);
  assert.equal(slimResult(event, { full: true }), event);
});
