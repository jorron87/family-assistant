import { dtf } from "./dtf.mjs";
// Værvisning ved klokka: ikon, temperatur, regnvarsel for skolevei og en rolig timestripe.
const CLOUD = '<path d="M7 19a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 10a3.75 3.75 0 0 1 .5 9H7z"/>';
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>';
const MOON = '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>';
const ICONS = {
  clear: (night) => night ? MOON : SUN,
  partly: (night) => night ? `<path transform="translate(-3 -4) scale(.7)" d="${MOON.slice(9, -3)}"/><g transform="translate(2 3) scale(.8)">${CLOUD}</g>` : `<g transform="translate(-2 -4) scale(.65)">${SUN}</g><g transform="translate(3 3) scale(.8)">${CLOUD}</g>`,
  cloudy: () => CLOUD,
  fog: () => `<g transform="translate(0 -3)">${CLOUD}</g><path d="M4 20h16M6 23h12" transform="translate(0 -2)"/>`,
  rain: () => `<g transform="translate(0 -3)">${CLOUD}</g><path d="M8 20l-1 3M12 20l-1 3M16 20l-1 3"/>`,
  sleet: () => `<g transform="translate(0 -3)">${CLOUD}</g><path d="M8 20l-1 3M16 20l-1 3"/><circle cx="12" cy="21.5" r=".6"/>`,
  snow: () => `<g transform="translate(0 -3)">${CLOUD}</g><circle cx="8" cy="21" r=".7"/><circle cx="12" cy="22.5" r=".7"/><circle cx="16" cy="21" r=".7"/>`,
  thunder: () => `<g transform="translate(0 -3)">${CLOUD}</g><path d="M12.5 17l-2 3.5h3l-2 3.5"/>`
};
const LABELS = { clear: 'Klart', partly: 'Delvis skyet', cloudy: 'Skyet', fog: 'Tåke', rain: 'Regn', sleet: 'Sludd', snow: 'Snø', thunder: 'Torden' };

export function weatherIcon(kind, night = false, size = 40) {
  const holder = document.createElement('span');
  holder.className = `w-icon w-${kind}`;
  const inner = (ICONS[kind] ?? ICONS.cloudy)(night);
  holder.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  return holder;
}

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const clockOf = (ms) => dtf('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const hourOf = (ms) => clockOf(ms).slice(0, 2);

export function renderWeather(data, { temperature, now = Date.now(), compact = false, showAlert = true } = {}) {
  const root = el('div', undefined, `w-widget${compact ? ' compact' : ''}`);
  if (!data || data.unavailable || !data.now) return root;
  const night = data.now.night;
  const temp = Number.isFinite(temperature) ? temperature : data.now.temp;
  const head = el('div', undefined, 'w-head');
  head.append(weatherIcon(data.now.kind, night, compact ? 44 : 56));
  const values = el('div', undefined, 'w-values');
  values.append(el('strong', `${temp === null || temp === undefined ? '—' : new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 }).format(temp)}°`, 'w-temp'));
  const sub = [LABELS[data.now.kind]];
  if (data.today) sub.push(`${data.today.min}° til ${data.today.max}°`);
  values.append(el('span', sub.join(' · '), 'w-sub'));
  head.append(values);
  root.append(head);

  const nowcast = data.nowcast && data.nowcast.state !== 'dry' ? data.nowcast.text : null;
  if (data.alert && showAlert) {
    const card = el('div', undefined, `w-alert w-alert-${data.alert.level}`);
    card.setAttribute('role', 'status');
    card.append(weatherIcon(data.alert.level === 'snow' ? 'snow' : 'rain', false, 30), el('span', data.alert.text));
    root.append(card);
  } else if (nowcast) {
    root.append(el('p', nowcast, 'w-nowcast'));
  }
  if (nowcast && data.alert && showAlert) root.append(el('p', nowcast, 'w-nowcast'));

  if (!compact && data.strip?.length) {
    const strip = el('div', undefined, 'w-strip');
    const school = (data.windows ?? []).filter((win) => win.id === 'skolevei');
    for (const hour of data.strip.slice(0, 8)) {
      const cell = el('div', undefined, 'w-hour');
      if (school.some((win) => hour.at < win.to && hour.at + 3600000 > win.from)) cell.classList.add('in-school');
      cell.append(el('span', hourOf(hour.at), 'w-time'), weatherIcon(hour.kind, /night/.test(hour.symbol ?? ''), 24), el('span', `${Math.round(hour.temp ?? 0)}°`, 'w-h-temp'));
      const bar = el('i', undefined, 'w-bar');
      bar.style.height = `${Math.min(28, Math.round((hour.precip ?? 0) * 14))}px`;
      cell.append(bar);
      strip.append(cell);
    }
    root.append(strip);
  }
  if (data.stale) root.append(el('p', `Sist oppdatert ${clockOf(Date.parse(data.updatedAt))}`, 'w-stale'));
  return root;
}

export function createWeatherFeed({ onData, url = '/api/weather', interval = 5 * 60000 }) {
  let last = null;
  const params = new URLSearchParams(location.search);
  const fixture = params.get('weather');
  async function refresh() {
    if (document.hidden) return;
    try {
      const response = await fetch(fixture ? `${url}?fixture=${encodeURIComponent(fixture)}` : url);
      if (response.ok) { last = await response.json(); onData(last); }
    } catch { if (last) onData({ ...last, stale: true }); }
  }
  refresh();
  setInterval(refresh, interval);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  return { refresh, get: () => last };
}
