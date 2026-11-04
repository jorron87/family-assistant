import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStore } from '../src/store.mjs';
import { addedLines, crawlBarnasAsker, crawlHsia, cultureProgramSnapshot, cultureProgramUrl, hsiaSearchUrl, pageSnapshot, parseBarnasCalendarPage, parseHsiaCards, parseHsiaDetail } from '../src/activity-feeds.mjs';
import { createFeedRunner } from '../src/activity-feed-runner.mjs';

const search = readFileSync('test/fixtures/hsia-search.html', 'utf8');
const detail = readFileSync('test/fixtures/hsia-detail.html', 'utf8');

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'familien-feed-'));
  try { return fn(createStore(dir), dir); }
  finally { assert.ok(dir.startsWith(join(tmpdir(), 'familien-feed-'))); rmSync(dir, { recursive: true, force: true }); }
}

test('parseHsiaCards: tittel, sted, målgruppe, pris og lokal tid regnes om riktig', () => {
  const { items, total } = parseHsiaCards(search);
  assert.equal(items.length, 12);
  assert.equal(total, 591);
  const card = items.find((item) => item.title.startsWith('Asker Aliens'));
  assert.equal(card.href, '/arrangorer/asker-aliens-basket/asker-aliens-apen-hall-i-hostferien/');
  assert.equal(card.bubble, 'Gratis');
  assert.equal(card.start, '2026-09-29T07:00:00.000Z', '09:00 norsk sommertid');
  assert.equal(card.end, '2026-09-29T15:00:00.000Z');
  assert.equal(card.area, 'Asker sentrum og Borgen');
  assert.deepEqual(card.audience, ['For større barn', 'For ungdom']);
});

test('parseHsiaDetail: beskrivelse, pris, påmelding og kalenderfil, uten «lignende aktiviteter»', () => {
  const parsed = parseHsiaDetail(detail);
  assert.match(parsed.description, /Bli med på tre kreative/);
  assert.deepEqual(parsed.prices, ['Ordinær kr 2900']);
  assert.match(parsed.registrationUrl, /^https:\/\/www\.somykunst\.com\//);
  assert.equal(parsed.icsUrl, 'https://www.hvaskjeriasker.no/api/download-calendar?activityPageId=195104');
  assert.equal(parsed.description.includes('Seniorteater'), false);
});

test('parseHsiaDetail leser publiserte, strukturerte forekomster når kilden tilbyr dem', () => {
  const html = '<main><p>Klubben er åpen</p><div data-component="ActivityDates" data-props="{&quot;activityId&quot;:&quot;192588&quot;,&quot;recurrence&quot;:&quot;Weekly&quot;,&quot;activityDates&quot;:[{&quot;startTime&quot;:&quot;2026-10-01T14:00:00+02:00&quot;,&quot;activityDuration&quot;:180}]}"></div></main>';
  assert.deepEqual(parseHsiaDetail(html).schedule, { activityId:'192588', recurrence:'Weekly', occurrences:[{start:'2026-10-01T14:00:00+02:00',durationMinutes:180}] });
});

test('hsiaSearchUrl bruker vindu, flere steder og sidetall (p og page)', () => {
  const url = new URL(hsiaSearchUrl({ from: '2026-09-28', to: '2026-10-28', locations: ['Slemmestad', 'Spikkestad og Røyken'], page: 3 }));
  assert.deepEqual(url.searchParams.getAll('location'), ['Slemmestad', 'Spikkestad og Røyken']);
  assert.equal(url.searchParams.get('p'), '3');
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('from'), '2026-09-28');
});

test('crawlHsia: går gjennom sidene, samler gjentakelser per aktivitetsside og stopper uten «Vis flere»', async () => {
  const pageFor = (n) => {
    let html = search.replaceAll('/arrangorer/', `/arrangorer/side${n}-`);
    if (n === 3) html = html.replace(/Vis flere resultater/g, 'Ingen flere');
    if (n === 2) html = html.replace('av totalt 591', 'av totalt 30');
    return html;
  };
  const urls = [];
  const get = async (url) => { urls.push(url); const n = Number(new URL(url).searchParams.get('page') ?? 1); return { status: 200, html: pageFor(n) }; };
  const result = await crawlHsia({ fetchText: get, sleep: async () => {}, from: '2026-09-28', to: '2026-10-28', locations: [] });
  assert.equal(result.pages, 3);
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 36);
  assert.ok(result.items.every((item) => item.hash && item.occurrences.length));
  // Samme aktivitetsside med flere datoer blir én aktivitet med flere forekomster.
  const twice = async (url) => ({ status: 200, html: search.replace(/Vis flere resultater/g, 'slutt') });
  const single = await crawlHsia({ fetchText: twice, sleep: async () => {}, from: 'a', to: 'b', locations: [] });
  assert.equal(single.items.length, 12);
});

test('crawlHsia: uventet side uten kort gir feil i stedet for tomt resultat', async () => {
  const get = async () => ({ status: 200, html: '<html><main>Noe helt annet</main></html>' });
  await assert.rejects(crawlHsia({ fetchText: get, sleep: async () => {}, from: 'a', to: 'b', locations: [] }), /ingen kort/);
  await assert.rejects(crawlHsia({ fetchText: async () => ({ status: 503, html: '' }), sleep: async () => {}, from: 'a', to: 'b', locations: [] }), /HTTP 503/);
});

test('sidetekst: stabil hash, og bare nye linjer vises etter endring', () => {
  const before = pageSnapshot('<main><h1>Program</h1><p>Loppemarked 10. oktober</p><p>Barneteater 12. oktober</p></main>');
  assert.equal(pageSnapshot('<main><h1>Program</h1><p>Loppemarked 10. oktober</p><p>Barneteater 12. oktober</p></main>').hash, before.hash);
  const after = pageSnapshot('<main><h1>Program</h1><p>Loppemarked 10. oktober</p><p>Barneteater 12. oktober</p><p>Gamingkveld 20. oktober</p></main>');
  assert.notEqual(after.hash, before.hash);
  assert.deepEqual(addedLines(after, before.lineHashes), ['Gamingkveld 20. oktober']);
});

test('kulturhus: fullt program kreves, og kortene gir stabile datolinjer', () => {
  assert.equal(new URL(cultureProgramUrl('https://www.askerkulturhus.no/program/')).searchParams.get('Filter.MaxItemsToShow'), '1000');
  const card = '<article class="teaser teaser--bg-colors"><a href="/program/test/"><div class="teaser__category">Barn</div><h3 class="teaser__heading">Barnas dag</h3><time datetime="2026-10-17 11:00:00Z">lørdag 17. oktober</time></a></article>';
  const html = `${card}<span id="itemsShowing">1</span><span id="maxItemsPossibleToShow">1</span>`;
  assert.deepEqual(cultureProgramSnapshot(html).lines, ['2026-10-17 11:00:00 | Barn | Barnas dag | /program/test/']);
  assert.throws(() => cultureProgramSnapshot(html.replace('id="itemsShowing">1', 'id="itemsShowing">12')), /ufullstendig/);
  assert.throws(() => cultureProgramSnapshot(html.replace('id="maxItemsPossibleToShow">1', 'id="maxItemsPossibleToShow">75')), /ufullstendig/);
});

test('BarnasNorge: paginert kalender kontrolleres til etter vinduet, ikke bare kommunesidens helgemodul', async () => {
  const item = (date, kommune) => `<div role="listitem" class="event-time_item w-dyn-item"><a href="/arrangementer/test-${date}"><div data-date="${date} 12:00"></div><h2 class="event-item_title">Barnas dag</h2><div fs-list-field="Kommune" class="filter-kommune">${kommune}</div><div fs-list-field="Dato" class="filter-dato">${date}</div></a></div>`;
  const page = (n, card) => `<div fs-list-showquery="true" fs-list-element="list">${card}</div><div role="navigation" aria-label="List">${n===1?'<a href="?8e773ef3_page=2" aria-label="Next Page" class="w-pagination-next"></a>':''}<div aria-label="Page ${n} of 2"></div></div>`;
  const html1 = page(1, item('2026-10-01', 'Asker'));
  const html2 = page(2, item('2026-11-01', 'Oslo'));
  assert.equal(parseBarnasCalendarPage(html1).items[0].municipality, 'Asker');
  const urls = [];
  const snapshot = await crawlBarnasAsker({ fetchText: async (url) => { urls.push(url); return {status:200,html:urls.length===1?html1:html2}; }, sleep: async () => {}, to:'2026-10-29', spacingMs:0 });
  assert.equal(snapshot.pages, 2);
  assert.equal(snapshot.matches, 1);
  assert.match(snapshot.lines[0], /2026-10-01 12:00/);
  assert.throws(() => parseBarnasCalendarPage('<main>Ingen resultater</main>'), /fant ikke/);
});

const sweep = (items, over = {}) => ({ items, complete: true, total: items.length, window: { from: '2026-09-28', to: '2026-10-28T12:00:00.000Z' }, covers: ['activity-3', 'activity-4'], ...over });
const item = (n, over = {}) => ({ href: `/arrangorer/a/${n}/`, title: `Aktivitet ${n}`, bubble: null, venue: 'Hallen', area: 'Slemmestad', audience: ['For alle'], occurrences: [{ start: '2099-10-01T10:00:00.000Z', end: '2099-10-01T11:00:00.000Z', timeText: 'ons. 1. oktober' }], hash: `h${n}`, ...over });

test('hsia i arkivet: første sveip er utgangspunkt, bare nye og endrede blir kandidater, ack tømmer køen', () => fixture((store) => {
  const first = store.activityFeedHsia(sweep([item(1), item(2)]));
  assert.equal(first.new, 0);
  assert.equal(store.activityFeedCandidates().total, 0);
  const second = store.activityFeedHsia(sweep([item(1), item(2, { hash: 'endret', title: 'Aktivitet 2 (ny tid)' }), item(3)]));
  assert.deepEqual([second.new, second.changed], [1, 1]);
  const candidates = store.activityFeedCandidates();
  assert.deepEqual(candidates.items.map((entry) => entry.title).sort(), ['Aktivitet 2 (ny tid)', 'Aktivitet 3']);
  assert.equal(store.activityFeedCandidates({ ack: true }).acked, true);
  assert.equal(store.activityFeedCandidates().total, 0);
  store.activityFeedHsia(sweep([item(1), item(2, { hash: 'endret', title: 'Aktivitet 2 (ny tid)' }), item(3)]));
  assert.equal(store.activityFeedCandidates().total, 0, 'uendret etter ack');
  assert.equal(store.snapshot().activityFeed, undefined, 'ikke i /api/state');
}));

test('avsluttede aktiviteter blir ikke kandidater, og kildestatus oppdateres bare for ok-kilder', () => fixture((store) => {
  store.activitySource({ sourceId: 'activity-3', health: 'ok', details: 'agent', scanTo: '2026-10-01T12:00:00.000Z' });
  store.activitySource({ sourceId: 'activity-4', health: 'partial', details: 'åpen sak: avklar med arrangør', nextPageHint: 'Avklar ukedag' });
  store.activityFeedHsia(sweep([item(1)]));
  store.activityFeedHsia(sweep([item(1), item(9, { occurrences: [{ start: '2020-01-01T10:00:00.000Z', end: '2020-01-01T11:00:00.000Z', timeText: 'gammel' }] })]));
  assert.equal(store.activityFeedCandidates().total, 0, 'utløpt forekomst');
  const statuses = store.snapshot().activitySourceStatus;
  assert.equal(statuses['activity-3'].health, 'ok');
  assert.match(statuses['activity-3'].details, /Automatisk/);
  assert.equal(statuses['activity-3'].scanTo, '2026-10-28T12:00:00.000Z');
  assert.equal(statuses['activity-4'].health, 'partial', 'agentens åpne sak røres ikke');
  assert.equal(statuses['activity-4'].nextPageHint, 'Avklar ukedag');
  store.activityFeedHsia(sweep([item(1)], { complete: false }));
  assert.match(store.snapshot().activitySourceStatus['activity-3'].details, /Automatisk/);
}));

test('automatic unchanged-page refresh preserves unresolved items and resolution evidence',()=>fixture(store=>{
  const page=pageSnapshot('<main><p>Known event</p></main>');
  const target={targetThrough:'2026-12-03T23:59:59+01:00'};
  const base={sourceId:'activity-9',details:'Checked source',scanTo:target.targetThrough};
  store.activitySource({...base,health:'ok'});
  store.activityFeedPage('activity-9',page,target);
  store.activitySource({...base,health:'partial',unresolvedItems:[{externalId:'source:1',reason:'Unavailable source attachment'}]});
  store.activityFeedPage('activity-9',page,target);
  assert.equal(store.snapshot().activitySourceStatus['activity-9'].health,'partial');
  store.activitySource({...base,health:'ok',resolvedItems:[{externalId:'source:1',resolution:'read',evidence:'Actual original recovered and read in full.'}]});
  store.activityFeedPage('activity-9',page,target);
  const status=store.snapshot().activitySourceStatus['activity-9'];
  assert.equal(status.health,'ok');
  assert.equal(status.resolutionHistory[0].evidence,'Actual original recovered and read in full.');
}));

test('sidekilder: utgangspunkt fra ok-status, endring gir kun nye linjer, agentens ok kvitterer, uendret side gir automatisk ok', () => fixture((store) => {
  const v1 = pageSnapshot('<main><p>Kurs A 5. oktober</p><p>Kurs B 6. oktober</p></main>');
  const v2 = pageSnapshot('<main><p>Kurs A 5. oktober</p><p>Kurs B 6. oktober</p><p>Kurs C 9. oktober</p></main>');
  const target = { targetThrough: '2026-10-28T12:00:00.000Z' };
  store.activitySource({ sourceId: 'activity-9', health: 'ok', details: 'agent', scanTo: '2026-10-01T12:00:00.000Z' });
  assert.equal(store.activityFeedPage('activity-9', v1, target).changed, false, 'første utgave = utgangspunkt');
  assert.equal(store.snapshot().activitySourceStatus['activity-9'].scanTo, '2026-10-28T12:00:00.000Z');
  assert.equal(store.activityFeedPage('activity-9', v2, target).changed, true);
  const text = store.activityFeedPageText('activity-9');
  assert.deepEqual(text.addedLines, ['Kurs C 9. oktober']);
  assert.equal(store.activityFeedStatus().changedPages.includes('activity-9'), true);
  store.activitySource({ sourceId: 'activity-9', health: 'ok', details: 'agenten leste endringen', scanTo: '2026-10-28T12:00:00.000Z' });
  assert.equal(store.activityFeedStatus().changedPages.length, 0, 'agentens ok kvitterer gjeldende utgave');
  assert.equal(store.activityFeedPage('activity-9', v2, target).changed, false);
  // Kilde uten ok-status og uten kvittering forblir åpen.
  assert.equal(store.activityFeedPage('activity-2', v1, target).changed, true);
  assert.equal(store.activityFeedPageText('activity-2').neverReviewed, true);
}));

test('runner: henter bare det som er forfalt, registrerer feil uten å røre kildestatus', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-feed-'));
  try {
    const store = createStore(dir);
    for (const id of ['activity-2', 'activity-9']) store.activitySource({ sourceId: id, health: 'ok', details: 'agent', scanTo: '2026-10-01T12:00:00.000Z' });
    const requested = [];
    const fetchText = async (url) => {
      requested.push(url);
      if (url.includes('hvaskjeriasker.no/sok')) return { status: 200, html: search.replace(/Vis flere resultater/g, 'slutt') };
      if (url.includes('/arrangorer/')) return { status: 200, html: detail };
      if (url.includes('dnt.no')) return { status: 500, html: '' };
      return { status: 200, html: `<main><h1>Program</h1>${'<p>Arrangement på siden nå og fremover i høst.</p>'.repeat(8)}</main>` };
    };
    let clock = Date.now();
    const runner = createFeedRunner({ store, root: resolve('.'), fetchText, sleep: async () => {}, now: () => clock, spacingMs: 0 });
    const first = await runner.run();
    assert.ok(first.hsia && first.hsia.items >= 12);
    assert.match(first.errors.join(' '), /activity-9: HTTP 500/, 'feil registreres');
    assert.equal(store.snapshot().activitySourceStatus['activity-9'].details, 'agent', 'kildestatus røres ikke ved feil');
    assert.ok(store.activityFeedStatus().pages.find((page) => page.id === 'activity-9').error);
    const count = requested.length;
    clock += 3600000;
    const again = await runner.run();
    assert.equal(again.hsia, null);
    assert.equal(requested.length, count, 'ikke forfalt: ingen nye kall');
    clock += 13 * 3600000;
    assert.ok((await runner.run()).hsia, 'forfalt etter 6 og 12 timer');
    assert.equal(requested.filter((url) => /facebook\.com/.test(url)).length, 0, 'Facebook hentes ikke av tjenesten');
    assert.equal(requested.some((url) => url.includes('/arrangorer/organizer')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
