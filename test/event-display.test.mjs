import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, isFollowUp, isWaste, isNight, minutesOfClock, noteFor, packingItems, timeLabel, wasteFractions } from '../public/event-display.mjs';

const helpers = { clockOf: (value) => value.slice(11, 16), startDayOf: (event) => event.start.slice(0, 10) };

test('cleanTitle fjerner ledende [Foreløpig]', () => {
  assert.equal(cleanTitle('[Foreløpig] Sjekk invitasjon'), 'Sjekk invitasjon');
  assert.equal(cleanTitle('[foreløpig]Sjekk'), 'Sjekk');
  assert.equal(cleanTitle('Teatertur 5A'), 'Teatertur 5A');
});

test('oppfølgingspåminnelser vises som «Følg opp», ikke som klokkeslett', () => {
  const reminder = { kind: 'task', start: '2026-09-25T20:00:00+02:00', end: '2026-09-25T20:15:00+02:00', provisional: true };
  assert.equal(isFollowUp(reminder), true);
  assert.equal(timeLabel(reminder, '2026-09-25', helpers), 'Følg opp');
  const shortProvisional = { kind: 'event', provisional: true, start: '2026-09-28T08:00:00+02:00', end: '2026-09-28T08:15:00+02:00' };
  assert.equal(isFollowUp(shortProvisional), true);
  const confirmed = { kind: 'event', provisional: false, start: '2026-09-28T09:00:00+02:00', end: '2026-09-28T10:00:00+02:00' };
  assert.equal(timeLabel(confirmed, '2026-09-28', helpers), '09:00');
  assert.equal(timeLabel({ allDay: true, start: '2026-10-06', end: '2026-10-07' }, '2026-10-06', helpers), 'Hele dagen');
  assert.equal(timeLabel({ task: { items: [{ doneAt: 'x' }, {}] } }, '2026-10-06', helpers), '1/2');
});

test('noteFor foretrekker pakkeliste og skjuler kildemetadata', () => {
  assert.equal(noteFor({ checklist: ['Ta med god matpakke'], details: 'Kildekort i privat familie-Drive' }), 'Ta med god matpakke');
  assert.equal(noteFor({ checklist: [], details: 'Kildekort i privat familie-Drive.\nGymtøy og drikkeflaske.' }), 'Gymtøy og drikkeflaske.');
  assert.equal(noteFor({ checklist: [], details: 'Sted: Kirkeveien 206 A. Kildebrev datert 15.07.2026.' }), 'Sted: Kirkeveien 206 A.');
  assert.equal(noteFor({ checklist: ['Lang '.repeat(40)] }).endsWith('…'), true);
});

test('søppelfraksjoner får korte navn og farger', () => {
  const event = { canonicalKey: 'renovasjon:1:2:3:2026-10-06', title: 'Søppelhenting – Restavfall, Papir, Mat, Glass- og metallemballasje, Plastemballasje' };
  assert.equal(isWaste(event), true);
  assert.deepEqual(wasteFractions(event).map((f) => f.key), ['rest', 'papir', 'mat', 'glass', 'plast']);
  assert.deepEqual(wasteFractions({ title: 'Søppelhenting – Restavfall, Mat' }).map((f) => f.label), ['Rest', 'Mat']);
});

test('packingItems samler unike punkter', () => {
  assert.deepEqual(packingItems([{ checklist: ['Gymtøy', 'Matpakke'] }, { checklist: ['Gymtøy', 'Regntøy', 'Lue'] }], 3), ['Gymtøy', 'Matpakke', 'Regntøy']);
});

test('isNight dekker 21:30–06:30', () => {
  assert.equal(isNight(minutesOfClock('22:45')), true);
  assert.equal(isNight(minutesOfClock('03:00')), true);
  assert.equal(isNight(minutesOfClock('06:29')), true);
  assert.equal(isNight(minutesOfClock('06:30')), false);
  assert.equal(isNight(minutesOfClock('21:29')), false);
  assert.equal(isNight(minutesOfClock('21:30')), true);
});
