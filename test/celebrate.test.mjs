import test from 'node:test';
import assert from 'node:assert/strict';
import { celebrationFor } from '../public/celebrate.mjs';

const items = [{ key: 'a', doneAt: '2026-10-08T10:00:00Z' }, { key: 'b', doneAt: null }, { key: 'c', doneAt: null }];

test('liten fest for et punkt, stor fest bare når siste punkt krysses av, ingen fest ved å fjerne en hake', () => {
  assert.deepEqual(celebrationFor({ items, key: 'b', checked: true }), { done: 2, total: 3, complete: false });
  assert.deepEqual(celebrationFor({ items: items.map((item) => item.key === 'b' ? { ...item, doneAt: 'x' } : item), key: 'c', checked: true }), { done: 3, total: 3, complete: true });
  assert.equal(celebrationFor({ items, key: 'a', checked: false }), null);
});
