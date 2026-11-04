import test from 'node:test';
import assert from 'node:assert/strict';
import { solarElevation, isDarkOutside } from '../public/sun.mjs';

const roeyken = { lat: 59.7372, lon: 10.4039 };
const elevation = (iso) => solarElevation(Date.parse(iso), roeyken.lat, roeyken.lon);

test('solhøyden stemmer med kjente verdier for Røyken', () => {
  // Sommersolverv, solhøyde ved middag ≈ 90 − 59.74 + 23.44 = 53.7°.
  assert.ok(Math.abs(elevation('2026-06-21T10:50:00Z') - 53.7) < 1.2);
  // Vintersolverv ≈ 90 − 59.74 − 23.44 = 6.8°.
  assert.ok(Math.abs(elevation('2026-12-21T11:15:00Z') - 6.8) < 1.2);
  // Solnedgang 29.09.2026 er ca. 18:55 lokal tid (16:55 UTC): sola rett under horisonten.
  assert.ok(Math.abs(elevation('2026-09-29T16:55:00Z')) < 2);
});

test('mørkt tema følger årstiden', () => {
  const dark = (iso) => isDarkOutside(Date.parse(iso), roeyken.lat, roeyken.lon);
  assert.equal(dark('2026-09-29T10:00:00Z'), false);   // 12:00 om høsten
  assert.equal(dark('2026-09-29T16:00:00Z'), false);   // rett før solnedgang
  assert.equal(dark('2026-09-29T17:30:00Z'), true);    // 19:30, mørkt
  assert.equal(dark('2026-12-21T15:30:00Z'), true);    // 16:30 midtvinters er mørkt
  assert.equal(dark('2026-12-21T09:30:00Z'), false);   // 10:30 midtvinters er lyst
  assert.equal(dark('2026-06-21T18:00:00Z'), false);   // 20:00 midtsommer er lyst
  assert.equal(dark('2026-06-21T22:00:00Z'), true);    // midnatt midtsommer er (så vidt) mørkt
});
