import test from 'node:test';
import assert from 'node:assert/strict';
import '../config/vigilo-keepalive/collector-core.js';

const core = globalThis.FamilienCollectorCore;
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.SUPERHEMMELIG-TOKEN-VERDI.signatur123';
const CHILD = '9e71a037-026d-163e-be04-9a41044ef491';
const CHILD2 = 'bf6ff549-3668-33fe-8a24-996cee8a4134';
const V = core.SOURCES.vigilo.origin, S = core.SOURCES.spond.origin;

function harness(source, { routes, config = {}, templates = {}, state = {}, start = Date.parse('2026-09-28T10:00:00Z') } = {}) {
  let clock = start;
  const calls = [], posts = [], sleeps = [];
  const ctx = {
    source, config, templates, state,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    token: () => TOKEN,
    fetchJson: async (url) => {
      calls.push({ url, at: clock });
      const handler = routes(new URL(url));
      return typeof handler === 'function' ? handler() : handler ?? { status: 404, json: null };
    },
    server: async (path, method, body) => { posts.push({ path, method, body }); return { ok: true }; }
  };
  return { ctx, calls, posts, sleeps, advance: (ms) => { clock += ms; }, get clock() { return clock; } };
}

const vigiloRoutes = (overrides = {}) => (url) => {
  const table = {
    '/api/count-of-posts': { status: 200, json: { unread: 3 } },
    '/api/children-counters': { status: 200, json: [{ childId: CHILD, unread: 1 }] },
    '/api/children/my': { status: 200, json: [{ id: CHILD, firstName: 'Barn Tre', lastName: 'Eksempel' }, { id: CHILD2, firstName: 'Barn Fire', lastName: 'Eksempel' }] },
    '/api/news-feed': { status: 200, json: [{ id: 'c7ef9824-c72d-7341-4e1b-17b48bd2c02f', posted: '2026-09-24T10:00:00Z', title: 'T', text: 'x', childIds: [CHILD], attachments: [], updated: null, editor: null, author: {} }] },
    '/api/message-threads': { status: 200, json: { count: 0, items: [] } },
    ...overrides
  };
  return table[url.pathname];
};

test('isAllowedRead: bare lesing mot faste endepunkter på riktig vert', () => {
  assert.equal(core.isAllowedRead('vigilo', `${V}/api/news-feed?childIds=x`), true);
  assert.equal(core.isAllowedRead('vigilo', `${V}/api/message-threads/9e71a037-026d-163e-be04-9a41044ef491?childPersonId=x`), true);
  assert.equal(core.isAllowedRead('vigilo', `${V}/api/current-user`), false);
  assert.equal(core.isAllowedRead('vigilo', 'https://evil.example/api/news-feed'), false);
  assert.equal(core.isAllowedRead('spond', `${S}/core/v1/posts?max=5`), true);
  assert.equal(core.isAllowedRead('spond', `${S}/core/v1/groups`), false);
  assert.equal(core.isAllowedRead('spond', `${V}/core/v1/posts`), false);
  assert.equal(core.isAllowedRead('spond', 'ikke-en-url'), false);
});

test('buildUrl bevarer appens parameterformat og bytter barn og vindu', () => {
  const now = Date.parse('2026-09-28T10:00:00Z');
  const isoTemplate = `${V}/api/news-feed?childIds=${CHILD2}&fromDate=2026-08-01T00:00:00.000Z&toDate=2026-09-28T00:00:00.000Z&extra=1`;
  const iso = new URL(core.buildUrl('news', { template: isoTemplate, childId: CHILD, now }));
  assert.equal(iso.searchParams.get('childIds'), CHILD);
  assert.match(iso.searchParams.get('fromDate'), /^2026-08-29T00:00:00\.000Z$/);
  assert.match(iso.searchParams.get('toDate'), /^2026-09-29T23:59:59\.000Z$/);
  assert.equal(iso.searchParams.get('extra'), '1');
  const dateTemplate = `${V}/api/news-feed?childIds=${CHILD2}&fromDate=2026-08-01&toDate=2026-09-28`;
  assert.equal(new URL(core.buildUrl('news', { template: dateTemplate, childId: CHILD, now })).searchParams.get('fromDate'), '2026-08-29');
  assert.equal(new URL(core.buildUrl('news', { childId: CHILD, now })).searchParams.get('toDate'), '2026-09-29');
  const norsk = `${V}/api/news-feed?childIds=x&fromDate=01.08.2026&toDate=28.09.2026`;
  assert.equal(new URL(core.buildUrl('news', { template: norsk, childId: CHILD, now })).searchParams.get('fromDate'), '29.08.2026');
  const events = new URL(core.buildUrl('events', { template: `${S}/core/v1/sponds?groupId=G&max=20&order=asc&minEndTimestamp=2026-01-01T00:00:00.000Z`, now, max: 100 }));
  assert.equal(events.searchParams.get('max'), '100');
  assert.equal(events.searchParams.has('groupId'), false, 'alltid på tvers av grupper');
  assert.equal(events.searchParams.get('minEndTimestamp'), '2026-09-27T10:00:00.000Z');
  assert.equal(new URL(core.buildUrl('posts', { now, max: 60 })).searchParams.get('type'), 'PLAIN');
});

test('full Vigilo-runde: tellere først, så barn, nyheter og tråder, med jevnt mellomrom og uten hemmeligheter', async () => {
  const h = harness('vigilo', { routes: vigiloRoutes() });
  const result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'full');
  const paths = h.calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, ['/api/count-of-posts', '/api/children-counters', '/api/children/my', '/api/news-feed', '/api/message-threads', '/api/news-feed', '/api/message-threads']);
  assert.deepEqual(h.posts.map((p) => p.body.kind), ['children', 'news', 'threads', 'news', 'threads', 'heartbeat', 'health']);
  for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 1500, 'minst 1,5 s mellom kall');
  assert.equal(JSON.stringify(h.posts).includes('SUPERHEMMELIG'), false);
  assert.equal(h.posts.at(-1).body.health, 'ok');
  assert.ok(h.posts.every((p) => p.path === '/api/collector' && p.method === 'POST'));
  assert.ok(h.calls.every((call) => core.isAllowedRead('vigilo', call.url)));
});

test('skånsomhet: ikke før intervallet, bare tellere når alt er uendret, full ved endring, refresh ved bestilling', async () => {
  const h = harness('vigilo', { routes: vigiloRoutes(), config: { vigilo: { probeMinutes: 15, fullMinutes: 60 } } });
  await core.runCycle(h.ctx);
  const first = h.calls.length;
  h.advance(3 * 60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'not_due');
  assert.equal(h.calls.length, first);
  h.advance(13 * 60000);
  const probeOnly = await core.runCycle(h.ctx);
  assert.equal(probeOnly.reason, 'unchanged');
  assert.equal(h.calls.length - first, 2, 'bare to tellerkall');
  // Ny teller-verdi gir full henting selv før fullMinutes.
  h.advance(16 * 60000);
  let unread = 4;
  const h2routes = vigiloRoutes({ '/api/count-of-posts': () => ({ status: 200, json: { unread } }) });
  h.ctx.fetchJson = async (url) => { h.calls.push({ url, at: h.clock }); const r = h2routes(new URL(url)); return typeof r === 'function' ? r() : r; };
  assert.equal((await core.runCycle(h.ctx)).reason, 'full');
  // Bestilt oppdatering fra serveren gir ny runde, men aldri tettere enn 2 minutter.
  h.advance(30 * 1000);
  h.ctx.config = { ...h.ctx.config, refreshRequestedAt: new Date(h.clock).toISOString() };
  assert.equal((await core.runCycle(h.ctx)).reason, 'too_soon');
  h.advance(2 * 60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'full');
  unread = 4;
});

test('fullMinutes: uendrede tellere gir likevel full henting etter en time', async () => {
  const h = harness('vigilo', { routes: vigiloRoutes() });
  await core.runCycle(h.ctx);
  h.advance(61 * 60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'full');
});

test('401 pauser og melder unauthorized; 429 gir backoff med Retry-After; ukjent format stopper uten å sende søppel', async () => {
  let h = harness('vigilo', { routes: vigiloRoutes({ '/api/count-of-posts': { status: 401, json: null } }) });
  let result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'unauthorized');
  assert.equal(h.posts.at(-1).body.health, 'unauthorized');
  h.advance(60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'paused');
  assert.equal(h.calls.length, 1, 'ingen nye kall mens pauset');

  h = harness('vigilo', { routes: vigiloRoutes({ '/api/count-of-posts': { status: 429, json: null, retryAfterMs: 2 * 3600000 } }) });
  result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'backoff');
  assert.ok(h.ctx.state.pausedUntil - h.clock >= 2 * 3600000);

  h = harness('vigilo', { routes: vigiloRoutes({ '/api/news-feed': { status: 200, json: { helt: 'annet' } } }) });
  result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'shape');
  assert.ok(!h.posts.some((p) => p.body.kind === 'news'));

  h = harness('vigilo', { routes: vigiloRoutes({ '/api/news-feed': { status: 400, json: null } }) });
  result = await core.runCycle(h.ctx);
  assert.equal(h.posts.at(-1).body.health, 'needs_template');
});

test('kallbudsjett stopper runden i stedet for å pepre API-et', async () => {
  const h = harness('vigilo', { routes: vigiloRoutes(), config: { limits: { cycleCalls: 4, minSpacingMs: 1500 } } });
  const result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'budget');
  assert.equal(h.calls.length, 4);
});

test('uten token gjøres ingenting', async () => {
  const h = harness('vigilo', { routes: vigiloRoutes() });
  h.ctx.token = () => null;
  assert.equal((await core.runCycle(h.ctx)).reason, 'no_token');
  assert.equal(h.calls.length, 0);
});

test('Spond server rejection still pauses collection and never forwards the app credential', async () => {
  const h = harness('spond', { routes: () => ({ status: 401, json: null }) });
  const result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'unauthorized');
  assert.equal(h.posts.at(-1).body.health, 'unauthorized');
  h.advance(60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'paused');
  assert.equal(h.calls.length, 1);
  assert.ok(!JSON.stringify(h.posts).includes(TOKEN));
});

test('detaljer hentes bare for tråder serveren ber om', async () => {
  const THREAD = '8c51b67e-3c1c-082d-b833-6397a34805b9';
  const h = harness('vigilo', {
    routes: vigiloRoutes({ [`/api/message-threads/${THREAD}`]: { status: 200, json: { messageThreadId: THREAD, title: 'T', messages: [{ id: THREAD, text: 'Hei', createdAt: '2026-09-21T08:00:00Z', attachments: [{ id: THREAD, name: 'a.pdf', mimeType: 'application/pdf', url: 'https://x/y?sig=hemmelig' }] }] } } }),
    config: { want: { threads: [{ id: THREAD, childId: CHILD }, { id: 'ikke-uuid', childId: CHILD }] } }
  });
  const cycle = await core.runCycle(h.ctx);
  assert.equal(cycle.reason, 'full', JSON.stringify(cycle) + JSON.stringify(h.posts.at(-1)));
  const detail = h.posts.find((p) => p.body.kind === 'thread-detail');
  assert.equal(detail.body.detail.messageThreadId, THREAD);
  assert.equal(JSON.stringify(detail).includes('hemmelig'), true, 'nedlastingslenken beholdes lokalt for originalhenting');
  assert.equal(h.calls.filter((call) => call.url.includes(THREAD)).length, 1);
  assert.equal(h.calls.some((call) => call.url.includes('ikke-uuid')), false);
});

test('Spond: badge-sjekk, så innlegg og arrangementer på tvers av grupper, og ufullstendig når vinduet ikke nås', async () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `A${String(i).padStart(31, '0')}`, type: 'PLAIN', groupId: 'G'.repeat(32), title: `p${i}`, body: 'b', timestamp: new Date(Date.parse('2026-09-28T00:00:00Z') - i * 3600000).toISOString(), comments: [], attachments: [] }));
  const h = harness('spond', {
    routes: (url) => {
      if (url.pathname === '/core/v1/posts/badge') return { status: 200, json: { unread: 2 } };
      if (url.pathname === '/core/v1/posts') return { status: 200, json: url.searchParams.get('max') === '150' ? Array.from({ length: 150 }, (_, i) => ({ ...many[i % 60], id: `B${String(i).padStart(31, '0')}` })) : many };
      if (url.pathname === '/core/v1/sponds') return { status: 200, json: [{ id: 'E'.repeat(32), heading: 'Trening', startTimestamp: '2026-10-06T15:00:00Z', endTimestamp: '2026-10-06T16:00:00Z', recipients: { group: { id: 'G'.repeat(32) } }, comments: [] }] };
    },
    templates: { posts: `${S}/core/v1/posts?type=PLAIN&includeComments=true&includeReadStatus=true&includeSeenCount=true&max=10` }
  });
  const result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'full');
  const paths = h.calls.map((call) => new URL(call.url).pathname);
  assert.deepEqual(paths, ['/core/v1/posts/badge', '/core/v1/posts', '/core/v1/posts', '/core/v1/sponds']);
  assert.equal(new URL(h.calls[1].url).searchParams.get('max'), '60');
  assert.equal(new URL(h.calls[2].url).searchParams.get('max'), '150', 'ber om mer når vinduet ikke er nådd');
  const postsPayload = h.posts.find((p) => p.body.kind === 'posts').body;
  assert.equal(postsPayload.items.length, 150);
  assert.equal(postsPayload.complete, false, 'fortsatt innenfor vinduet: aldri påstå komplett');
  assert.equal(h.posts.find((p) => p.body.kind === 'events').body.complete, true);
});

test('assertNoSecrets stopper token og Authorization i utgående data', () => {
  assert.throws(() => core.assertNoSecrets({ a: `x ${TOKEN} y` }, TOKEN), /payload_contains_secret/);
  assert.throws(() => core.assertNoSecrets({ headers: { Authorization: 'Bearer abcdefghijklmnop123' } }, TOKEN), /payload_contains_secret/);
  assert.doesNotThrow(() => core.assertNoSecrets({ title: 'Vanlig tekst om et token-spill' }, TOKEN));
});

test('stille timer gir lengre intervall, og grensene kan ikke skrus ned av konfigurasjon', () => {
  const cfg = { quiet: { from: '23:00', to: '05:30', factor: 4 }, vigilo: { probeMinutes: 15 } };
  assert.equal(core.quiet(Date.parse('2026-09-28T22:30:00Z'), cfg.quiet), true, '00:30 norsk tid');
  assert.equal(core.quiet(Date.parse('2026-09-28T10:00:00Z'), cfg.quiet), false);
  assert.equal(core.nextDelayMs(cfg, 'vigilo', Date.parse('2026-09-28T10:00:00Z')), 15 * 60000);
  assert.equal(core.nextDelayMs(cfg, 'vigilo', Date.parse('2026-09-28T22:30:00Z')), 60 * 60000);
  assert.equal(core.nextDelayMs({ vigilo: { probeMinutes: 0.1 } }, 'vigilo', Date.parse('2026-09-28T10:00:00Z')), core.HARD.minCycleGapMs);
  const limiter = core.createLimiter({ minSpacingMs: 1, cycleCalls: 9999, now: () => 0, sleep: async () => {} });
  assert.ok(limiter);
});

test('myk pause kan brytes av bestilt oppdatering, hard pause kan ikke, og gammel pause uten type ignoreres', async () => {
  const failing = { ...vigiloRoutes(), '/api/news-feed': () => { throw new Error('server: feil hos oss'); } };
  const h = harness('vigilo', { routes: (url) => { const r = vigiloRoutes()(url); return url.pathname === '/api/news-feed' ? (() => { throw new Error('boom'); }) : r; } });
  let result = await core.runCycle(h.ctx);
  assert.equal(result.reason, 'error');
  assert.equal(h.ctx.state.pauseKind, 'soft');
  h.advance(3 * 60000);
  assert.equal((await core.runCycle(h.ctx)).reason, 'paused');
  h.ctx.config = { refreshRequestedAt: new Date(h.clock).toISOString() };
  h.advance(2 * 60000);
  assert.notEqual((await core.runCycle(h.ctx)).reason, 'paused', 'bestilt oppdatering bryter myk pause');
  const hard = harness('vigilo', { routes: vigiloRoutes(), state: { pausedUntil: Date.parse('2026-09-28T11:00:00Z'), pauseKind: 'hard' }, config: { refreshRequestedAt: '2026-09-28T10:00:00Z' } });
  assert.equal((await core.runCycle(hard.ctx)).reason, 'paused');
  const legacy = harness('vigilo', { routes: vigiloRoutes(), state: { pausedUntil: Date.parse('2026-09-28T11:00:00Z') } });
  assert.equal((await core.runCycle(legacy.ctx)).reason, 'full', 'pause uten type fra eldre versjon ignoreres');
});

test('poll views and pagination cursors cannot narrow ordinary Spond coverage',()=>{
  const url=new URL(core.buildUrl('posts',{template:`${S}/core/v1/posts?type=POLL&prevId=OLD&maxTimestamp=2020-01-01&groupId=G&subGroupId=SG&includeComments=false`,now:Date.now(),max:60}));
  assert.equal(url.searchParams.get('type'),'PLAIN');
  assert.equal(url.searchParams.get('includeComments'),'true');
  for(const key of ['prevId','maxTimestamp','groupId','subGroupId'])assert.equal(url.searchParams.has(key),false);
  const events=new URL(core.buildUrl('events',{template:`${S}/core/v1/sponds?groupId=G&prevId=OLD&maxStartTimestamp=2020-01-01&scheduled=false&order=desc`,now:Date.now(),max:100}));
  assert.equal(events.searchParams.get('order'),'asc');assert.equal(events.searchParams.get('scheduled'),'true');
  for(const key of ['groupId','prevId','maxStartTimestamp'])assert.equal(events.searchParams.has(key),false);
});

test('a full collection also reports its actual counter check',async()=>{
  const h=harness('vigilo',{routes:vigiloRoutes()});
  assert.equal((await core.runCycle(h.ctx)).reason,'full');
  const probe=h.posts.find(p=>p.body.kind==='heartbeat');
  assert.equal(probe.body.lastFullAt,new Date(h.ctx.state.lastFullAt).toISOString());
});
