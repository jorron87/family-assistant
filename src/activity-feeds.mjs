import { createHash } from 'node:crypto';
import { osloAt } from './weather.mjs';

// Innhenting av aktivitetskilder direkte over HTTP, uten nettleser og scrolling.
//  - Hva skjer i Asker (Episerver): søkesiden er serverrendret med sidetall, så alle kort kan hentes med vanlige GET-kall.
//  - Øvrige kilder: renset sidetekst med hash. Uendret side betyr uendret dekning; endret side gir agenten bare de nye linjene.

export const UA = 'Mozilla/5.0 (compatible; FamilienDashboard/1.0; privat hjemmedashboard)';
const HSIA = 'https://www.hvaskjeriasker.no';
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
export const short = (value) => sha(value).slice(0, 12);

// The search window is copied into every detail link. It is not an event ID.
export function hsiaHref(value) {
  const url = new URL(decode(value), HSIA);
  if (url.origin !== HSIA) return value;
  url.searchParams.delete('from');
  url.searchParams.delete('to');
  url.searchParams.sort();
  url.hash = '';
  return url.pathname + url.search;
}
export function hsiaOccurrenceToken(item, occurrence) {
  return short(JSON.stringify([item.title,item.bubble,item.venue,item.area,item.audience,occurrence.start,occurrence.end]));
}

export const decode = (text) => String(text ?? '')
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'");

const oneLine = (value) => decode(String(value ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export async function fetchText(url, { timeoutMs = 25000, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  const html = await response.text();
  if (html.length > 3_000_000) throw new Error('for stor side');
  return { status: response.status, html, url: response.url };
}

// ---- Sidetekst ----
export function cleanText(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  const text = main
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<svg[\s\S]*?<\/svg>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<\/(p|div|li|h\d|tr|dd|dt|article|section|br|address)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decode(text).split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// Next.js-sider (Spond-klubb, Kystbyen) legger innholdet i __NEXT_DATA__; ta med pageProps så endringer der oppdages.
export function nextPageProps(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;
  try { return JSON.stringify(JSON.parse(match[1]).props?.pageProps ?? null); } catch { return null; }
}

export function pageSnapshot(html) {
  const lines = cleanText(html);
  const props = nextPageProps(html);
  const extra = props ? JSON.stringify(JSON.parse(props),null,2).split('\n').filter(line=>line.trim()) : [];
  const all = [...lines, ...extra];
  return { lines: all, lineHashes: all.map((line) => short(line).slice(0, 8)), hash: short(all.join('\n')), chars: all.join('\n').length, hasNextData: !!props };
}

// Kulturhuset serverer hele programmet når GET-filteret øker sidegrensen.
// Sammenlign faktisk antall kort med serverens total før et vindu kvitteres.
export function cultureProgramUrl(baseUrl, limit = 1000) {
  const url = new URL(baseUrl);
  url.searchParams.set('Filter.MaxItemsToShow', String(limit));
  return url.toString();
}

export function cultureProgramSnapshot(html) {
  const shown = Number(html.match(/id="itemsShowing">\s*(\d+)/)?.[1]);
  const total = Number(html.match(/id="maxItemsPossibleToShow">\s*(\d+)/)?.[1]);
  const cards = [...html.matchAll(/<article class="teaser teaser--[\s\S]*?<\/article>/g)].map(([card]) => {
    const href = card.match(/<a href="([^"]+)"/)?.[1];
    const title = oneLine(card.match(/<h3 class="teaser__heading">([\s\S]*?)<\/h3>/)?.[1]);
    const category = oneLine(card.match(/<div class="teaser__category">([\s\S]*?)<\/div>/)?.[1]);
    const when = card.match(/<time datetime="([^"]+)"/)?.[1]?.replace(/Z$/, '');
    if (!href || !title || !when) throw new Error('kulturhus-kort mangler lenke, tittel eller dato');
    return `${when} | ${category} | ${title} | ${href}`;
  });
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(shown) || shown !== total || cards.length !== total) {
    throw new Error(`kulturhus-program ufullstendig: ${cards.length} kort, viser ${shown}, totalt ${total}`);
  }
  return { lines: cards, lineHashes: cards.map((line) => short(line).slice(0, 8)), hash: short(cards.join('\n')), chars: cards.join('\n').length, total };
}

// BarnasNorges kommune-side viser kun en kort arrangementsmodul. Den nasjonale
// kalenderen er serverrendret, datert og paginert; filtreringen er klientsidig.
export function parseBarnasCalendarPage(html) {
  const list = html.match(/<div fs-list-showquery="true" fs-list-element="list"[\s\S]*?<div role="navigation" aria-label="List"/i)?.[0];
  if (!list) throw new Error('BarnasNorge: fant ikke datert arrangementsliste');
  const fragments = list.split('<div role="listitem" class="event-time_item w-dyn-item">').slice(1);
  const items = fragments.map((part) => {
    const date = part.match(/fs-list-field="Dato" class="filter-dato">(\d{4}-\d{2}-\d{2})/)?.[1];
    const municipality = oneLine(part.match(/fs-list-field="Kommune" class="filter-kommune">([^<]+)/)?.[1]);
    const title = oneLine(part.match(/class="event-item_title">([^<]+)/)?.[1]);
    const href = part.match(/href="(\/arrangementer\/[^" ]+)/)?.[1];
    const time = part.match(/data-date="(\d{4}-\d{2}-\d{2} \d{2}:\d{2})"/)?.[1];
    if (!date || !municipality || !title || !href || !time || time.slice(0, 10) !== date) throw new Error('BarnasNorge: ufullstendig arrangementskort');
    return { date, municipality, title, href, time };
  });
  const count = html.match(/aria-label="Page (\d+) of (\d+)"/)?.slice(1).map(Number);
  if (!count || count.some((n) => !Number.isSafeInteger(n)) || count[0] > count[1]) throw new Error('BarnasNorge: mangler sidetall');
  const next = html.match(/href="([^"]+)" aria-label="Next Page" class="w-pagination-next/)?.[1] ?? null;
  if (count[0] < count[1] && !next) throw new Error('BarnasNorge: neste side mangler');
  return { items, page: count[0], pages: count[1], next };
}

export async function crawlBarnasAsker({ fetchText: get = fetchText, sleep, to, spacingMs = 1200, maxPages = 60 }) {
  let url = 'https://www.barnasnorge.no/arrangementer-for-barn';
  let lastDate = null;
  const lines = [];
  const visited = new Set();
  let pages = 0, seen = 0;
  while (url && pages < maxPages) {
    if (visited.has(url)) throw new Error('BarnasNorge: pagineringssløyfe');
    visited.add(url);
    const { status, html } = await get(url);
    if (status !== 200) throw new Error(`BarnasNorge: HTTP ${status}`);
    const page = parseBarnasCalendarPage(html);
    if (page.page !== pages + 1) throw new Error(`BarnasNorge: ventet side ${pages + 1}, fikk ${page.page}`);
    if (!page.items.length && page.next) throw new Error('BarnasNorge: tom side før siste side');
    for (const item of page.items) {
      if (lastDate && item.date < lastDate) throw new Error('BarnasNorge: datoene er ikke sortert');
      lastDate = item.date; seen++;
      if (item.municipality === 'Asker' && item.date <= to) lines.push(`${item.time} | ${item.title} | ${item.href}`);
    }
    pages++;
    if (lastDate && lastDate > to) break;
    if (!page.next) break;
    url = new URL(page.next.replace(/&amp;/g, '&'), url).toString();
    if (new URL(url).origin !== 'https://www.barnasnorge.no') throw new Error('BarnasNorge: neste side har uventet domene');
    await sleep(spacingMs);
  }
  if (pages >= maxPages && lastDate <= to) throw new Error('BarnasNorge: sidegrense nådd før kontrollvinduets slutt');
  if (!lastDate) throw new Error('BarnasNorge: ingen daterte kort');
  if (!lines.length) lines.push(`Ingen daterte arrangementer i Asker til og med ${to}.`);
  return { lines, lineHashes: lines.map((line) => short(line).slice(0, 8)), hash: short(lines.join('\n')), chars: lines.join('\n').length, pages, seen, lastDate, matches: lines.length === 1 && lines[0].startsWith('Ingen ') ? 0 : lines.length };
}

// Linjer som er nye siden forrige gjennomgåtte utgave (bare selve teksten sendes til agenten).
export function addedLines(current, reviewedHashes) {
  const known = new Set(reviewedHashes ?? []);
  return current.lines.filter((line, index) => !known.has(current.lineHashes[index]));
}

// ---- Hva skjer i Asker ----
export function hsiaSearchUrl({ from, to, locations = [], page = 1 }) {
  const url = new URL('/sok/', HSIA);
  url.searchParams.set('q', ''); url.searchParams.set('from', from); url.searchParams.set('to', to);
  for (const location of locations) url.searchParams.append('location', location);
  if (page > 1) { url.searchParams.set('p', String(page)); url.searchParams.set('page', String(page)); }
  return url.toString();
}

const localIso = (day, hhmm) => new Date(osloAt(day, hhmm)).toISOString();

export function parseHsiaCards(html) {
  const cards = html.split('<div class="teaser teaser--').slice(1);
  const total = Number((html.match(/av totalt (\d+) aktiviteter/) ?? [])[1] ?? NaN);
  const items = [];
  for (const card of cards) {
    const href = (card.match(/href="([^"]+)"/) ?? [])[1];
    const title = oneLine((card.match(/<h3 class="teaser__heading">([\s\S]*?)<\/h3>/) ?? [])[1]);
    if (!href || !title) continue;
    const time = card.match(/<time datetime="(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})[^"]*">([\s\S]*?)<\/time>/);
    const timeText = oneLine(time?.[3]);
    const range = timeText.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
    const startDay = time?.[1] ?? null;
    const startTime = time?.[2] ?? null;
    const endTime = range?.[2] ?? null;
    let end = null;
    if (startDay && endTime) end = localIso(startDay, endTime);
    const address = (card.match(/<address>([\s\S]*?)<\/address>/) ?? [])[1] ?? '';
    const [venue, area] = address.split(/<br\s*\/?>/i).map(oneLine);
    const audience = [...(card.match(/icon-details__item--suitable-for[\s\S]*?<\/div>/)?.[0].matchAll(/<dd>([\s\S]*?)<\/dd>/g) ?? [])].map((match) => oneLine(match[1]));
    items.push({
      href, title, bubble: oneLine((card.match(/<div class="bubble">([\s\S]*?)<\/div>/) ?? [])[1]) || null,
      start: startDay && startTime ? localIso(startDay, startTime) : null, end, timeText, venue: venue || null, area: area || null, audience
    });
  }
  return { items, total: Number.isFinite(total) ? total : null };
}

export function parseHsiaDetail(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  const lines = cleanText(html);
  const own = lines.slice(0, Math.max(lines.findIndex((line) => /^Lignende aktiviteter/i.test(line)), 1));
  const text = own.join(' ');
  const description = text.split(/Nøkkelinformasjon/)[0].replace(/^.*?Foto:?\s*/, '').slice(0, 1500).trim();
  const prices = [...text.matchAll(/(Ordinær|Honnør|Barn|Student|Voksen|Ledsager)\s*:?\s*kr\s*([\d ]+)/gi)].slice(0, 6).map((match) => `${match[1]} kr ${match[2].replace(/\s+/g, '')}`);
  const register = (main.match(/<a[^>]*href="([^"]+)"[^>]*>\s*Meld meg p/i) ?? [])[1] ?? null;
  const ics = (main.match(/download-calendar\?activityPageId=\d+/) ?? [])[0] ?? null;
  const props = html.match(/data-component="ActivityDates"[^>]*data-props="([^"]+)"/)?.[1];
  let schedule = null;
  if (props) {
    try {
      const parsed = JSON.parse(decode(props));
      schedule = { activityId: parsed.activityId ?? null, recurrence: parsed.recurrence ?? null,
        occurrences: (parsed.activityDates ?? []).map((entry) => ({ start: entry.startTime, durationMinutes: entry.activityDuration })) };
    } catch { /* Eventuelt endret struktur; vanlig detaljtekst beholdes. */ }
  }
  return { description, prices, registrationUrl: register, icsUrl: ics ? `${HSIA}/api/${ics}` : null, recurring: /Gjentas/.test(text), schedule };
}

// Henter alle sider for vinduet og gruppere kort per aktivitetsside (gjentakelser blir forekomster).
export async function crawlHsia({ fetchText: get = fetchText, sleep, from, to, locations, maxPages = 60, spacingMs = 1200, onPage }) {
  const byHref = new Map();
  let total = null, pages = 0, complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const { status, html } = await get(hsiaSearchUrl({ from, to, locations, page }));
    if (status !== 200) throw Object.assign(new Error(`HTTP ${status}`), { code: 'http' });
    const parsed = parseHsiaCards(html);
    if (!parsed.items.length && page === 1 && !/Ingen (treff|aktiviteter)|0 aktiviteter/i.test(html)) throw Object.assign(new Error('ingen kort funnet (endret oppsett?)'), { code: 'shape' });
    total ??= parsed.total;
    pages = page;
    let fresh = 0;
    for (const card of parsed.items) {
      const href = hsiaHref(card.href);
      const item = byHref.get(href) ?? { href, title: card.title, bubble: card.bubble, venue: card.venue, area: card.area, audience: card.audience, occurrences: [] };
      const key = `${card.start}|${card.end}`;
      if (!item.occurrences.some((occurrence) => occurrence.key === key)) { item.occurrences.push({ key, start: card.start, end: card.end, timeText: card.timeText }); fresh++; }
      byHref.set(href, item);
    }
    onPage?.(page, parsed.items.length);
    const seen = [...byHref.values()].reduce((sum, item) => sum + item.occurrences.length, 0);
    if (!parsed.items.length || (total !== null && seen >= total) || (fresh === 0 && page > 1) || !/Vis flere resultater/.test(html)) { complete = !parsed.items.length || /Vis flere resultater/.test(html) === false || (total !== null && seen >= total); break; }
    await sleep(spacingMs);
  }
  const items = [...byHref.values()].map((item) => ({ ...item, occurrences: item.occurrences.sort((a, b) => String(a.start).localeCompare(String(b.start))).map(({ key, ...rest }) => rest) }));
  for (const item of items) item.hash = short(JSON.stringify([item.title, item.bubble, item.venue, item.area, item.audience, item.occurrences.map((o) => [o.start, o.end])]));
  return { items, total, pages, complete };
}
