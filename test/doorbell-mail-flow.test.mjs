import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDoorbell, eventAlarm } from '../src/doorbell.mjs';
import { loadKey } from '../src/crypto.mjs';

const config = { cameraName: 'Inngang', neolinkUrl: 'http://127.0.0.1:1', personEntity: 'binary_sensor.inngang_person', ringEntity: 'event.inngang_doorbell', localAlarmEntity: 'event.inngang_lokale_alarmer_inngang_lokal_alarm', displaySeconds: 30 };

const mail = (body, date) => `Date: ${date.toUTCString()}\r\nFrom: camera@doorbell.local\r\nTo: dashboard@doorbell.local\r\nSubject: Alarm\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'familien-doorbell-flow-'));
  loadKey(dir);
  writeFileSync(join(dir, 'doorbell-acceptance.json'), JSON.stringify({ enabled: true, userEnabledBeforeTesting: true }));
  const published = [];
  const homeAssistant = { watchEntities: () => () => {}, discoverCameraAlarms: async () => {}, publishCameraAlarm: async (alarm) => { published.push(alarm); } };
  const doorbell = createDoorbell({ config, dataDir: dir, homeAssistant, fetchImpl: async () => { throw new Error('ingen videobro i test'); } });
  const written = [];
  const client = { write: (chunk) => written.push(chunk), end() {}, once() {} };
  const events = [];
  doorbell.sse({ headers: {}, once() {} }, { writeHead() {}, write: (chunk) => events.push(chunk), end() {}, once() {} });
  return { dir, doorbell, published, events, client };
}
const alarms = (events) => events.filter((chunk) => chunk.startsWith('event: alarm')).map((chunk) => JSON.parse(chunk.split('data: ')[1]));

test('SMTP-alarm vises med en gang når mailen ankommer, uten å vente på Home Assistant, og med fersk tid selv om kameraklokka går feil', async () => {
  const { dir, doorbell, published, events } = setup();
  try {
    // Kameraklokka er 5 minutter etter: Date-hodet er gammelt, men mailen ankommer nå.
    await doorbell.receiveMail(mail('Alarm Event: Visitor', new Date(Date.now() - 5 * 60000)));
    const shown = alarms(events);
    assert.equal(shown.length, 1);
    assert.equal(shown[0].kind, 'ring');
    assert.equal(shown[0].source, 'smtp');
    assert.ok(Date.now() - Date.parse(shown[0].at) < 2000, 'klienten avviser alarmer eldre enn 5 s, så tiden må være ankomsttiden');
    assert.equal(published.length, 1, 'alarmen publiseres fortsatt til Home Assistant');
    assert.equal(published[0].id, shown[0].id);
  } finally { doorbell.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('ekkoet fra Home Assistant med samme id gir ikke en ny visning, og samme mail to ganger gir én alarm', async () => {
  const { dir, doorbell, events } = setup();
  try {
    const raw = mail('Alarm Event: Person', new Date());
    await doorbell.receiveMail(raw);
    await doorbell.receiveMail(raw);
    assert.equal(alarms(events).length, 1);
  } finally { doorbell.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('mail som ikke er en eksplisitt person/ringe-alarm vises ikke, uansett klokkeskjev', async () => {
  const { dir, doorbell, events, published } = setup();
  try {
    await doorbell.receiveMail(mail('Alarm Event: Motion', new Date()));
    await doorbell.receiveMail(mail('A person configured this test doorbell email', new Date()));
    assert.equal(alarms(events).length, 0);
    assert.equal(published.length, 0);
  } finally { doorbell.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HA-hendelsen fra den lokale alarmen gjenkjennes med riktig entitets-ID', () => {
  const now = Date.now();
  const next = { state: new Date(now).toISOString(), attributes: { event_type: 'ring', id: 'abc' } };
  const event = (id) => ({ time_fired: new Date(now).toISOString(), data: { entity_id: id, old_state: { state: 'unknown' }, new_state: next } });
  assert.equal(eventAlarm(event(config.localAlarmEntity), config, now).kind, 'ring');
  assert.equal(eventAlarm(event('event.inngang_lokal_alarm'), config, now), null, 'feil ID ga stille tap før');
});

test('tidsloggen får én linje for mail og én for alarm, med kameraets egne tider og uten hemmeligheter', async () => {
  const { dir, doorbell } = setup();
  try {
    const when = new Date(Date.now() - 20000);
    const stamp = `${when.getFullYear()}/${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}:${String(when.getSeconds()).padStart(2, '0')}`;
    await doorbell.receiveMail(`Date: ${new Date(Date.now() - 9000).toUTCString()}\r\nFrom: camera@doorbell.local\r\nTo: dashboard@doorbell.local\r\nSubject: Someone Rang the Inngang at ${stamp}\r\nContent-Type: text/plain\r\n\r\nAlarm Event: Visitor`);
    const lines = readFileSync(join(dir, 'doorbell', 'trace.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const mailLine = lines.find((line) => line.event === 'mail');
    assert.equal(mailLine.kind, 'ring');
    assert.ok(mailLine.eventToArrivalSec >= 19 && mailLine.eventToArrivalSec <= 22, String(mailLine.eventToArrivalSec));
    assert.ok(mailLine.composedToArrivalSec >= 8 && mailLine.composedToArrivalSec <= 11);
    assert.ok(lines.some((line) => line.event === 'alarm' && line.source === 'smtp' && line.delivered === true));
    assert.equal(JSON.stringify(lines).includes('dashboard@doorbell.local'), false);
  } finally { doorbell.close(); rmSync(dir, { recursive: true, force: true }); }
});
