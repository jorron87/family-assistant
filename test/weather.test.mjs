import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeather, fixtureWeather, nowcastAlert, osloAt, summarizeWeather, symbolKind } from '../src/weather.mjs';

const config = {
  userAgent: 'test', lat: 59.7, lon: 10.4, place: 'Test', rainThresholdMm: 0.3, nowcastWetMmPerHour: 0.2,
  windows: [
    { id: 'skolevei', label: 'Skoleveien', days: [1, 2, 3, 4, 5], from: '07:15', to: '08:30' },
    { id: 'hjemvei', label: 'Hjemveien', days: [1, 2, 3, 4, 5], from: '13:30', to: '16:00' }
  ]
};
const HOUR = 3600000;

function forecastFor(startMs, hours, wetAt = () => false, temp = () => 8) {
  return {
    properties: {
      timeseries: Array.from({ length: hours }, (_, i) => {
        const at = startMs + i * HOUR;
        const wet = wetAt(at);
        return { time: new Date(at).toISOString(), data: { instant: { details: { air_temperature: temp(at), wind_speed: 2 } }, next_1_hours: { summary: { symbol_code: wet ? 'rain' : 'cloudy' }, details: { precipitation_amount: wet ? 1.2 : 0 } } } };
      })
    }
  };
}

test('osloAt håndterer sommer- og vintertid', () => {
  assert.equal(new Date(osloAt('2026-09-29', '07:15')).toISOString(), '2026-09-29T05:15:00.000Z');
  assert.equal(new Date(osloAt('2026-12-01', '07:15')).toISOString(), '2026-12-01T06:15:00.000Z');
});

test('symbolKind grupperer MET-symboler', () => {
  assert.equal(symbolKind('lightrainshowers_day'), 'rain');
  assert.equal(symbolKind('heavysleet'), 'sleet');
  assert.equal(symbolKind('clearsky_night'), 'clear');
  assert.equal(symbolKind('rainandthunder'), 'thunder');
});

test('regn i morgendagens skolevei gir varsel med klesråd', () => {
  const now = osloAt('2026-09-28', '21:40'); // mandag kveld
  const start = Math.floor(now / HOUR) * HOUR;
  const wetFrom = osloAt('2026-09-29', '07:00'), wetTo = osloAt('2026-09-29', '09:00');
  const summary = summarizeWeather({ forecast: forecastFor(start, 30, (at) => at >= wetFrom && at < wetTo), nowcast: null, now, config, updatedAt: 'x' });
  assert.equal(summary.alert.level, 'rain');
  assert.equal(summary.alert.window, 'skolevei');
  assert.match(summary.alert.text, /Regn meldt 07:15–08:30 i morgen – regntøy/);
  assert.equal(summary.tomorrowMorning.wet, true);
});

test('opphold i skoleveien gir ingen varsel', () => {
  const now = osloAt('2026-09-28', '21:40');
  const summary = summarizeWeather({ forecast: forecastFor(Math.floor(now / HOUR) * HOUR, 30), nowcast: null, now, config, updatedAt: 'x' });
  assert.equal(summary.alert, null);
  assert.equal(summary.tomorrowMorning.wet, false);
});

test('kulde gir lue og votter, snø gir vintersko', () => {
  const now = osloAt('2026-09-28', '21:40');
  const summary = summarizeWeather({ forecast: forecastFor(Math.floor(now / HOUR) * HOUR, 30, () => false, () => 1), nowcast: null, now, config, updatedAt: 'x' });
  assert.equal(summary.tomorrowMorning.advice, 'lue og votter');
  const snow = fixtureWeather('snow', now, config);
  assert.equal(snow.alert.level, 'snow');
  assert.match(snow.alert.text, /vintersko/);
});

test('helg gir ikke skolevei-varsel', () => {
  const now = osloAt('2026-10-03', '21:00'); // lørdag kveld, søndag morgen
  const wetFrom = osloAt('2026-10-04', '07:00');
  const summary = summarizeWeather({ forecast: forecastFor(Math.floor(now / HOUR) * HOUR, 30, (at) => at >= wetFrom && at < wetFrom + 3 * HOUR), nowcast: null, now, config, updatedAt: 'x' });
  assert.equal(summary.alert, null);
});

test('nowcast: regn om ca. N min, opphold og regner nå', () => {
  const now = Date.parse('2026-09-28T06:00:00Z');
  const make = (rates) => ({ properties: { meta: { radar_coverage: 'ok' }, timeseries: rates.map((rate, i) => ({ time: new Date(now + i * 5 * 60000).toISOString(), data: { instant: { details: { precipitation_rate: rate } } } })) } });
  assert.equal(nowcastAlert(make([0, 0, 0, 0.5, 0.5]), now).text, 'Regn om ca. 15 min');
  assert.equal(nowcastAlert(make([0, 0, 0]), now).state, 'dry');
  const raining = nowcastAlert(make([1, 1, 0, 0]), now);
  assert.equal(raining.state, 'raining');
  assert.match(raining.text, /Regner nå – opphold ca\. \d\d:\d\d/);
  assert.equal(nowcastAlert({ properties: { meta: { radar_coverage: 'no coverage' }, timeseries: make([1]).properties.timeseries } }, now), null);
});

test('createWeather respekterer Expires og bruker cache uten nytt nettverkskall', async () => {
  let calls = 0;
  let clock = Date.parse('2026-09-28T19:00:00Z');
  const forecast = forecastFor(Math.floor(clock / HOUR) * HOUR, 30);
  const fetchImpl = async (url) => {
    calls++;
    const body = url.includes('nowcast') ? { properties: { meta: { radar_coverage: 'ok' }, timeseries: [{ time: new Date(clock).toISOString(), data: { instant: { details: { precipitation_rate: 0 } } } }] } } : forecast;
    return { ok: true, status: 200, headers: new Map([['expires', new Date(clock + 3600000).toUTCString()], ['last-modified', new Date(clock).toUTCString()]]), json: async () => body };
  };
  const weather = createWeather({ config, fetchImpl, now: () => clock });
  const first = await weather.get();
  assert.equal(calls, 2);
  assert.ok(first.now);
  clock += 60000;
  await weather.get();
  assert.equal(calls, 2, 'ingen nytt kall før Expires');
  const failing = createWeather({ config, fetchImpl: async () => { throw new Error('nede'); }, now: () => clock });
  assert.equal((await failing.get()).unavailable, true);
});
