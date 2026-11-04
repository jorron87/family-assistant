import {readConfig} from './config.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { crawlBarnasAsker, crawlHsia, cultureProgramSnapshot, cultureProgramUrl, fetchText as defaultFetch, pageSnapshot, parseHsiaDetail } from './activity-feeds.mjs';
import {crawlLibrary} from './library-feed.mjs';

// Kjører innhentingen av aktivitetskilder i tjenesten: sjelden, sekvensielt og med pauser mellom kall.
const HOUR = 3600000;
const RETRY_HOURS = 2;
const osloDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function createFeedRunner({ store, root, fetchText = defaultFetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, spacingMs = 1200 }) {
  let running = null;
  const readJson = readConfig;

  function plan() {
    const sources = readJson('activity-sources.json');
    const feeds = readJson('activity-feeds.json');
    const today = osloDay(now());
    const sunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
    const days = sunday ? sources.weeklyLookaheadDays : sources.dailyLookaheadDays;
    const covers = feeds.hsia.covers ?? [];
    const skip = new Set(feeds.skip ?? []);
    const pages = sources.sources.filter((source) => !covers.includes(source.id) && !skip.has(source.id) && !/facebook\.com/.test(source.url)).map((source) => ({ id: source.id, url: feeds.pageUrls?.[source.id] ?? source.url }));
    return { today, days, to: addDays(today, days), covers, locations: feeds.hsia.locations ?? [], pages, hsiaEveryHours: feeds.hsiaEveryHours ?? 6, pageEveryHours: feeds.pageEveryHours ?? 12 };
  }

  async function runHsia(p) {
    const swept = await crawlHsia({ fetchText, sleep, from: p.today, to: p.to, locations: p.locations, spacingMs });
    const result = store.activityFeedHsia({ items: swept.items, complete: swept.complete, total: swept.total, window: { from: p.today, to: `${p.to}T12:00:00.000Z` }, covers: p.covers });
    // Detaljer (beskrivelse, pris, påmelding) bare for nye og endrede aktiviteter.
    let details = 0;
    for (const href of store.activityFeedNeedsDetail(40)) {
      try {
        await sleep(spacingMs);
        const reply = await fetchText(new URL(href, 'https://www.hvaskjeriasker.no').toString());
        if (reply.status === 200) { store.activityFeedDetail(href, parseHsiaDetail(reply.html)); details++; }
      } catch { /* detaljer er en bonus */ }
    }
    return { ...result, pages: swept.pages, details };
  }

  async function runPage(source, p) {
    if(source.id==='activity-22')return store.activityFeedPage(source.id,await crawlLibrary({from:p.today,to:p.to,sleep}),{targetThrough:`${p.to}T12:00:00.000Z`});
    if(source.id==='activity-24')return store.activityFeedPage(source.id,await crawlBarnasAsker({fetchText,sleep,to:p.to,spacingMs}),{targetThrough:`${p.to}T12:00:00.000Z`});
    const reply = await fetchText(source.id === 'activity-11' ? cultureProgramUrl(source.url) : source.url);
    if (reply.status !== 200) throw new Error(`HTTP ${reply.status}`);
    const snapshot = source.id === 'activity-11' ? cultureProgramSnapshot(reply.html) : pageSnapshot(reply.html);
    if (snapshot.chars < 200 && source.id !== 'activity-11') throw new Error('nesten tom side (krever kanskje nettleser)');
    return store.activityFeedPage(source.id, snapshot, { targetThrough: `${p.to}T12:00:00.000Z` });
  }

  async function run({ force = false, sourceId } = {}) {
    if (readJson('activity-sources.json').enabled===false)return {disabled:true};
    if (running) return running;
    running = (async () => {
      const p = plan();
      const status = store.activityFeedStatus();
      const attempt = (id) => { const page = status.pages.find((entry) => entry.id === id); return [page?.checkedAt, page?.errorAt].filter(Boolean).sort().at(-1); };
      const out = { hsia: null, pages: {}, errors: [] };
      const due = (at, hours) => force || !at || now() - Date.parse(at) >= hours * HOUR;
      if ((!sourceId || sourceId==='hsia' || p.covers.includes(sourceId)) && due(status.hsia.errorAt && status.hsia.errorAt > (status.hsia.sweepAt ?? '') ? status.hsia.errorAt : status.hsia.sweepAt, status.hsia.errorAt && status.hsia.errorAt > (status.hsia.sweepAt ?? '') ? RETRY_HOURS : p.hsiaEveryHours)) {
        try { out.hsia = await runHsia(p); }
        catch (error) { store.activityFeedError('hsia', null, error.message); out.errors.push(`hsia: ${error.message}`); }
        await sleep(spacingMs);
      }
      for (const source of p.pages) {
        if(sourceId&&source.id!==sourceId)continue;
        const page = status.pages.find((entry) => entry.id === source.id);
        const failed = page?.errorAt && page.errorAt > (page.checkedAt ?? '');
        if (!due(attempt(source.id), failed ? RETRY_HOURS : p.pageEveryHours)) continue;
        try { out.pages[source.id] = await runPage(source, p); }
        catch (error) { store.activityFeedError('page', source.id, error.message); out.errors.push(`${source.id}: ${error.message}`); }
        await sleep(spacingMs);
      }
      return out;
    })().finally(() => { running = null; });
    return running;
  }
  return { run, plan };
}
