import test from 'node:test';
import assert from 'node:assert/strict';
import { doorbellController } from '../public/doorbell-view.mjs';

function harness() {
  let clock = 0, next = 0;
  const timers = new Map(), titles = [];
  const controller = doorbellController({
    open: () => {}, close: () => {}, setTitle: (title, kind) => titles.push([title, kind]), now: () => clock,
    schedule: (f, ms) => { timers.set(++next, { f, at: clock + ms }); return next; }, cancel: (id) => timers.delete(id)
  });
  return { controller, titles, timers, advance: (ms) => { clock += ms; } };
}

test('tittelen får alarmtypen, slik at visningen kan velge kompakt kort for person og stort vindu for ringing', () => {
  const { controller, titles } = harness();
  controller.alarm({ kind: 'person' });
  controller.alarm({ kind: 'ring' });
  assert.deepEqual(titles, [['Person ved døren', 'person'], ['Noen ringer på', 'ring']]);
});

test('extend gir 30 s til med nøyaktig én aktiv timer, og gjør ingenting når vinduet er lukket', () => {
  const { controller, timers, advance } = harness();
  assert.equal(controller.extend(), false, 'ingen åpen visning');
  controller.alarm({ kind: 'ring' });
  advance(25000);
  assert.equal(controller.remainingMs(), 5000);
  assert.equal(controller.extend(), true);
  assert.equal(controller.remainingMs(), 30000);
  assert.equal(controller.durationMs, 30000);
  assert.equal(timers.size, 1);
  controller.dismiss();
  assert.equal(controller.extend(), false);
  assert.equal(controller.remainingMs(), 0);
});
