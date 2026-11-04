import test from 'node:test';
import assert from 'node:assert/strict';
import { loginProblems, loginSummary } from '../public/login-status.mjs';

const now = Date.parse('2026-09-28T20:00:00Z');
const fresh = (health, extra = {}) => ({ health, checkedAt: new Date(now - 3600000).toISOString(), ...extra });
const allOk = { vigilo: fresh('ok'), spond: fresh('ok'), facebook: fresh('ok') };

test('ingen problemer når alt er innlogget og ferskt', () => {
  assert.deepEqual(loginProblems({ sourceStatus: allOk, session: { health: 'ok', checkedAt: new Date(now - 60000).toISOString(), stale: false }, now }), []);
});

test('Vigilo-øktkontroll needs_login gir «logget ut» først', () => {
  const problems = loginProblems({ sourceStatus: allOk, session: { health: 'needs_login', checkedAt: new Date(now - 30000).toISOString(), stale: false }, now });
  assert.equal(problems[0].level, 'login');
  assert.equal(problems[0].title, 'Vigilo er logget ut');
  assert.match(loginSummary(problems).text, /Vigilo er logget ut – nye ting hentes ikke/);
});

test('needs_login fra siste kjøring vises, men fersk «ok» fra øktkontrollen trumfer', () => {
  const status = { ...allOk, vigilo: { health: 'needs_login', checkedAt: new Date(now - 7200000).toISOString() } };
  assert.equal(loginProblems({ sourceStatus: status, session: null, now })[0].title, 'Vigilo er logget ut');
  const cleared = loginProblems({ sourceStatus: status, session: { health: 'ok', checkedAt: new Date(now - 60000).toISOString(), stale: false }, now });
  assert.equal(cleared.length, 0);
});

test('overflate med needs_login i Spond gir varsel og to kilder slås sammen i teksten', () => {
  const problems = loginProblems({
    sourceStatus: allOk,
    surfaces: { 'spond:group-1:posts': { source: 'spond', health: 'needs_login' }, 'facebook:g:posts': { source: 'facebook', health: 'partial' } },
    session: { health: 'needs_login', checkedAt: new Date(now - 30000).toISOString(), stale: false }, now
  });
  assert.deepEqual(problems.map((p) => p.source), ['vigilo', 'spond']);
  assert.equal(loginSummary(problems).text, 'Vigilo og Spond er logget ut – nye ting hentes ikke');
});

test('kilde uten kontroll på over 24 timer og stille øktkontroll gir varsel av lavere alvor', () => {
  const old = { ...allOk, spond: { health: 'ok', checkedAt: new Date(now - 30 * 3600000).toISOString() } };
  const problems = loginProblems({ sourceStatus: old, session: { health: 'ok', checkedAt: new Date(now - 3600000).toISOString(), stale: true }, now });
  assert.deepEqual(problems.map((p) => [p.source, p.level]), [['spond', 'stale'], ['vigilo', 'watch']]);
  assert.equal(loginSummary(problems).level, 'stale');
});

test('partial helse alene er ikke et innloggingsproblem', () => {
  const partial = { ...allOk, facebook: fresh('partial') };
  assert.deepEqual(loginProblems({ sourceStatus: partial, session: null, now }), []);
});

test('manglende kildestatus gir «ikke kontrollert» uten feil', () => {
  const problems = loginProblems({ sourceStatus: {}, surfaces: {}, session: null, now });
  assert.deepEqual(problems.map((p) => [p.source, p.level, p.since]), [['vigilo', 'stale', null], ['spond', 'stale', null], ['facebook', 'stale', null]]);
});
