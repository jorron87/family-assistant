// Solhøyde uten nettverk (NOAA-forenklet, nøyaktig til under 1°). Brukes til å la kioskens tema følge solnedgang/soloppgang.
const rad = Math.PI / 180;

export function solarElevation(ms, lat, lon) {
  const days = ms / 86400000 + 2440587.5 - 2451545.0;
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const anomaly = (357.528 + 0.9856003 * days) % 360;
  const eclipticLon = meanLon + 1.915 * Math.sin(anomaly * rad) + 0.02 * Math.sin(2 * anomaly * rad);
  const obliquity = 23.439 - 0.0000004 * days;
  const declination = Math.asin(Math.sin(obliquity * rad) * Math.sin(eclipticLon * rad));
  const rightAscension = Math.atan2(Math.cos(obliquity * rad) * Math.sin(eclipticLon * rad), Math.cos(eclipticLon * rad)) / rad;
  const gmst = (280.46061837 + 360.98564736629 * days) % 360;
  const hourAngle = (gmst + lon - rightAscension) * rad;
  return Math.asin(Math.sin(lat * rad) * Math.sin(declination) + Math.cos(lat * rad) * Math.cos(declination) * Math.cos(hourAngle)) / rad;
}

// «Mørkt ute»: sola er mer enn ca. 3° under horisonten (rett etter solnedgang / like før soloppgang).
export const DARK_BELOW_DEGREES = -3;
export const isDarkOutside = (ms, lat, lon, threshold = DARK_BELOW_DEGREES) => solarElevation(ms, lat, lon) < threshold;
