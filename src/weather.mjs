import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Vær fra MET Norway (Yr): locationforecast for timeprognose og nowcast for de neste ~90 minuttene.
// Ingen LLM-kostnad; serveren henter, cacher og lager ferdige varsler til kiosk og mobil.

const TZ = 'Europe/Oslo';
const MIN_REFRESH_MS = 10 * 60000;
const HOUR = 3600000;

export function symbolKind(code = '') {
  const c = String(code);
  if (/thunder/.test(c)) return 'thunder';
  if (/sleet/.test(c)) return 'sleet';
  if (/snow/.test(c)) return 'snow';
  if (/rain/.test(c)) return 'rain';
  if (/fog/.test(c)) return 'fog';
  if (/^partlycloudy|^fair/.test(c)) return 'partly';
  if (/^clearsky/.test(c)) return 'clear';
  if (/cloud/.test(c)) return 'cloudy';
  return 'cloudy';
}
const wetKind = (kind) => ['rain', 'sleet', 'snow', 'thunder'].includes(kind);

const partsIn = (date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(date).map((p) => [p.type, p.value]));
export const osloDay = (date) => { const p = partsIn(date); return `${p.year}-${p.month}-${p.day}`; };
export const osloClock = (date) => { const p = partsIn(date); return `${p.hour}:${p.minute}`; };
const osloWeekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay();
const addDay = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// Oslo-klokkeslett på en dato til absolutt tid (håndterer sommertid).
export function osloAt(day, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  for (const offset of [1, 2]) {
    const candidate = guess - offset * HOUR;
    if (osloClock(new Date(candidate)) === hhmm && osloDay(new Date(candidate)) === day) return candidate;
  }
  return guess - HOUR;
}

const round1 = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

export function hourlyFromForecast(forecast) {
  return (forecast?.properties?.timeseries ?? []).map((entry) => {
    const details = entry.data?.instant?.details ?? {};
    const next = entry.data?.next_1_hours ?? entry.data?.next_6_hours;
    return {
      at: Date.parse(entry.time),
      temp: round1(details.air_temperature),
      wind: round1(details.wind_speed),
      precip: round1(entry.data?.next_1_hours?.details?.precipitation_amount ?? 0) ?? 0,
      symbol: next?.summary?.symbol_code ?? null,
      hourly: !!entry.data?.next_1_hours
    };
  }).filter((hour) => Number.isFinite(hour.at));
}

function nowcastSteps(nowcast) {
  return (nowcast?.properties?.timeseries ?? []).map((entry) => ({
    at: Date.parse(entry.time),
    rate: Number(entry.data?.instant?.details?.precipitation_rate ?? 0),
    temp: entry.data?.instant?.details?.air_temperature ?? null,
    symbol: entry.data?.next_1_hours?.summary?.symbol_code ?? null
  })).filter((step) => Number.isFinite(step.at));
}

const clock = (ms) => osloClock(new Date(ms));
const roundMinutes = (ms, step = 5) => Math.max(0, Math.round(ms / 60000 / step) * step);

// Kortsiktig varsel fra nowcast: regn om N minutter / opphold til klokkeslett.
export function nowcastAlert(nowcast, now, wetMmPerHour = 0.2) {
  const coverage = nowcast?.properties?.meta?.radar_coverage;
  const steps = nowcastSteps(nowcast).filter((step) => step.at >= now - 10 * 60000 && step.at <= now + 95 * 60000);
  if (!steps.length || (coverage && coverage !== 'ok')) return null;
  const wet = (step) => step.rate >= wetMmPerHour;
  const first = steps[0];
  if (wet(first)) {
    const dry = steps.find((step) => !wet(step));
    return dry ? { state: 'raining', text: `Regner nå – opphold ca. ${clock(dry.at)}`, until: dry.at } : { state: 'raining', text: 'Regner nå – ingen opphold på halvannen time', until: null };
  }
  const start = steps.find(wet);
  if (!start) return { state: 'dry', text: 'Opphold de neste 90 minuttene', until: null };
  const minutes = roundMinutes(start.at - now);
  return { state: 'rain-soon', text: minutes <= 5 ? 'Regn om noen få minutter' : `Regn om ca. ${minutes} min`, at: start.at };
}

// Regn i skolevei/hjemvei-vinduene. Kun det første relevante vinduet som starter innen 14 timer (eller pågår) varsles.
export function windowAlerts({ hours, now, windows, thresholdMm = 0.3 }) {
  const today = osloDay(new Date(now));
  const found = [];
  for (const dayOffset of [0, 1]) {
    const day = addDay(today, dayOffset);
    for (const win of windows) {
      if (!win.days.includes(osloWeekday(day))) continue;
      const from = osloAt(day, win.from), to = osloAt(day, win.to);
      if (to <= now || from > now + 14 * HOUR) continue;
      const wetHours = hours.filter((hour) => hour.hourly && hour.at < to && hour.at + HOUR > from && (hour.precip >= thresholdMm || wetKind(symbolKind(hour.symbol))));
      const inWindow = hours.filter((hour) => hour.at < to && hour.at + HOUR > from);
      const cold = inWindow.length ? Math.min(...inWindow.map((hour) => hour.temp ?? 99)) : null;
      const kinds = wetHours.map((hour) => symbolKind(hour.symbol));
      found.push({
        id: win.id, label: win.label, day, from, to, wet: wetHours.length > 0,
        wetFrom: wetHours.length ? Math.max(from, wetHours[0].at) : null,
        wetTo: wetHours.length ? Math.min(to, wetHours.at(-1).at + HOUR) : null,
        snow: kinds.some((kind) => kind === 'snow' || kind === 'sleet'),
        coldest: cold === 99 ? null : cold,
        precipMm: round1(wetHours.reduce((sum, hour) => sum + hour.precip, 0))
      });
    }
  }
  return found.sort((a, b) => a.from - b.from);
}

export function dressAdvice(win) {
  if (!win) return null;
  const tips = [];
  if (win.wet) tips.push(win.snow ? 'vintersko og varme klær' : 'regntøy');
  if (win.coldest !== null && win.coldest < 3) tips.push('lue og votter');
  return tips.length ? tips.join(' · ') : null;
}

export function summarizeWeather({ forecast, nowcast, now = Date.now(), config, updatedAt, stale = false }) {
  const hours = hourlyFromForecast(forecast);
  const upcoming = hours.filter((hour) => hour.at + HOUR > now);
  const current = upcoming[0] ?? null;
  const strip = upcoming.filter((hour) => hour.hourly).slice(0, 8).map((hour) => ({ at: hour.at, time: clock(hour.at), temp: hour.temp, precip: hour.precip, kind: symbolKind(hour.symbol), symbol: hour.symbol }));
  const today = osloDay(new Date(now));
  const todayHours = hours.filter((hour) => osloDay(new Date(hour.at)) === today && hour.temp !== null);
  const windows = windowAlerts({ hours, now, windows: config.windows ?? [], thresholdMm: config.rainThresholdMm ?? 0.3 });
  const shortTerm = nowcastAlert(nowcast, now, config.nowcastWetMmPerHour ?? 0.2);
  const nextWindow = windows[0] ?? null;
  const wetWindow = windows.find((win) => win.wet) ?? null;
  const tomorrow = addDay(today, 1);
  const morning = windows.find((win) => win.id === 'skolevei' && win.day === tomorrow) ?? null;
  let alert = null;
  if (wetWindow && (wetWindow === nextWindow || wetWindow.from - now < 14 * HOUR)) {
    const inProgress = wetWindow.from <= now && now < wetWindow.to;
    const when = `${clock(wetWindow.wetFrom)}–${clock(wetWindow.wetTo)}`;
    const dayLabel = wetWindow.day === today ? '' : ' i morgen';
    const advice = dressAdvice(wetWindow);
    alert = {
      level: wetWindow.snow ? 'snow' : 'rain', window: wetWindow.id, label: wetWindow.label, day: wetWindow.day,
      text: `${wetWindow.snow ? 'Snø/sludd' : 'Regn'} ${inProgress ? 'nå' : `meldt ${when}`}${dayLabel} – ${advice ?? 'ta med regntøy'}`,
      from: wetWindow.wetFrom, to: wetWindow.wetTo
    };
  } else if (shortTerm && shortTerm.state !== 'dry' && !nextWindow) {
    alert = { level: 'rain', window: null, text: shortTerm.text, from: shortTerm.at ?? now, to: shortTerm.until ?? null };
  }
  return {
    updatedAt, stale,
    place: config.place ?? null,
    location: Number.isFinite(config.lat) && Number.isFinite(config.lon) ? { lat: config.lat, lon: config.lon } : null,
    now: current ? { temp: current.temp, kind: symbolKind(current.symbol), symbol: current.symbol, wind: current.wind, night: /_night$/.test(current.symbol ?? '') } : null,
    nowcast: shortTerm,
    strip,
    today: todayHours.length ? { max: Math.round(Math.max(...todayHours.map((h) => h.temp))), min: Math.round(Math.min(...todayHours.map((h) => h.temp))) } : null,
    windows: windows.map((win) => ({ id: win.id, label: win.label, day: win.day, from: win.from, to: win.to, wet: win.wet, wetFrom: win.wetFrom, wetTo: win.wetTo, snow: win.snow, coldest: win.coldest, advice: dressAdvice(win) })),
    tomorrowMorning: morning ? { wet: morning.wet, from: morning.wetFrom, to: morning.wetTo, coldest: morning.coldest, advice: dressAdvice(morning) } : null,
    alert
  };
}

// Fast eksempeldata til visuell testing (?fixture=rain|dry|snow). Ingen nettverk.
export function fixtureWeather(kind, now, config) {
  const startHour = Math.floor(now / HOUR) * HOUR;
  const wet = kind === 'rain' || kind === 'snow';
  const day = osloDay(new Date(now));
  const targetDay = osloClock(new Date(now)) < '08:30' ? day : addDay(day, 1);
  const wetStart = osloAt(targetDay, '07:00');
  const series = Array.from({ length: 36 }, (_, index) => {
    const at = startHour + index * HOUR;
    const isWet = wet && at >= wetStart && at < wetStart + 3 * HOUR;
    const symbol = isWet ? (kind === 'snow' ? 'snow' : 'lightrain') : index % 5 === 0 ? 'partlycloudy_day' : 'cloudy';
    return { time: new Date(at).toISOString(), data: { instant: { details: { air_temperature: kind === 'snow' ? 0.5 : 6 + Math.sin(index / 4) * 3, wind_speed: 3 } }, next_1_hours: { summary: { symbol_code: symbol }, details: { precipitation_amount: isWet ? 0.8 : 0 } } } };
  });
  return summarizeWeather({ forecast: { properties: { timeseries: series } }, nowcast: null, now, config, updatedAt: new Date(now).toISOString() });
}

export function createWeather({ config, dataDir, fetchImpl = fetch, now = () => Date.now() }) {
  const cachePath = dataDir ? join(dataDir, 'weather-cache.json') : null;
  let cache = null, inflight = null, lastAttempt = 0;
  if (cachePath && existsSync(cachePath)) { try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = null; } }
  const coordinate = (value) => Number(value).toFixed(4);
  const headers = () => ({ 'User-Agent': config.userAgent, Accept: 'application/json' });

  async function conditional(url, previous) {
    const response = await fetchImpl(url, { headers: { ...headers(), ...(previous?.lastModified ? { 'If-Modified-Since': previous.lastModified } : {}) }, signal: AbortSignal.timeout(10000) });
    if (response.status === 304 && previous) return { ...previous, expires: Date.parse(response.headers.get('expires')) || now() + MIN_REFRESH_MS };
    if (!response.ok) throw new Error(`MET svarte ${response.status}`);
    return { data: await response.json(), lastModified: response.headers.get('last-modified'), expires: Date.parse(response.headers.get('expires')) || now() + MIN_REFRESH_MS };
  }

  async function fetchAll() {
    const query = `lat=${coordinate(config.lat)}&lon=${coordinate(config.lon)}`;
    const forecastDue = !cache?.forecast || now() >= cache.forecast.expires;
    const forecast = forecastDue ? await conditional(`https://api.met.no/weatherapi/locationforecast/2.0/compact?${query}`, cache?.forecast) : cache.forecast;
    // Nowcast dekker Norge og noen nabolandområder; feil her skal ikke ødelegge timeprognosen.
    let nowcast = cache?.nowcast ?? null;
    try { nowcast = await conditional(`https://api.met.no/weatherapi/nowcast/2.0/complete?${query}`, cache?.nowcast); } catch { if (nowcast && nowcast.expires < now() - 30 * 60000) nowcast = null; }
    cache = { forecast, nowcast, fetchedAt: new Date(now()).toISOString() };
    if (cachePath) { try { writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache)); renameSync(`${cachePath}.tmp`, cachePath); } catch { /* cache er valgfri */ } }
  }

  async function get() {
    if(config.enabled===false)return {unavailable:true,disabled:true};
    const time = now();
    const due = !cache
      || (time >= cache.forecast.expires && time - lastAttempt >= MIN_REFRESH_MS)
      || (cache.nowcast && time >= cache.nowcast.expires && time - lastAttempt >= 2 * 60000);
    if (due && !inflight) {
      lastAttempt = time;
      inflight = fetchAll().catch(() => { /* bruker cache som utløpt */ }).finally(() => { inflight = null; });
    }
    if (!cache) await inflight;
    if (!cache) return { unavailable: true };
    const stale = time - Date.parse(cache.fetchedAt) > 90 * 60000;
    return summarizeWeather({ forecast: cache.forecast.data, nowcast: cache.nowcast && cache.nowcast.expires > time - 30 * 60000 ? cache.nowcast.data : null, now: time, config, updatedAt: cache.fetchedAt, stale });
  }
  return { get };
}
