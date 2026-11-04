import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../config/vigilo-keepalive/collector-main.js', import.meta.url), 'utf8');

function harness(hostname = 'spond.com') {
  let clock = Date.parse('2026-10-04T05:00:00Z'), scheduled;
  const listeners = new Map(), storage = new Map(), decisions = [];
  const window = {
    fetch: async () => ({ status: 200 }),
    addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    dispatchEvent() {},
    postMessage(message) {
      queueMicrotask(() => listeners.get('message').forEach(listener => listener({ source: window, data: {
        familienCollectorReply: true, id: message.id, ok: true,
        data: { enabled: true, supplemental: false, want: {} },
      } })));
    },
  };
  class XHR { open() {} setRequestHeader() {} }
  const context = {
    window, location: { hostname, origin: `https://${hostname}` },
    document: { visibilityState: 'visible', dispatchEvent() {} },
    navigator: { onLine: true }, XMLHttpRequest: XHR, Headers, Request,
    URL, Event, AbortSignal, Date: class extends Date { static now() { return clock; } },
    atob: value => Buffer.from(value, 'base64').toString('utf8'),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), length: 0 },
    sessionStorage: { length: 0 },
    setInterval(callback) { scheduled = callback; }, setTimeout() { return 1; }, clearTimeout() {},
    FamilienCollectorCore: {
      SOURCES: { spond: { origin: 'https://api.spond.com' }, vigilo: { origin: 'https://web-parent.prod.vigilo-oas.no' } },
      async runCycle(ctx) { decisions.push(Boolean(ctx.token())); return { reason: 'not_due' }; },
    },
  };
  runInNewContext(script, context);
  return {
    async capture(token) { await window.fetch(`${context.FamilienCollectorCore.SOURCES[hostname === 'spond.com' ? 'spond' : 'vigilo'].origin}/example`, { headers: { Authorization: `Bearer ${token}` } }); },
    async appFetch(url) { await window.fetch(url,{headers:{Authorization:'Bearer synthetic-page-credential-for-test'}}); },
    appXhr(url) { const xhr=new XHR();xhr.open('GET',url);xhr.setRequestHeader('Authorization','Bearer synthetic-page-credential-for-test'); },
    async tick() { scheduled(); await new Promise(resolve => setImmediate(resolve)); },
    advance(minutes) { clock += minutes * 60000; }, decisions,
  };
}

test('an idle Spond tab retains its opaque app credential until the server rejects it', async () => {
  const h = harness();
  await h.capture('synthetic-opaque-credential-for-test');
  await h.tick();
  h.advance(90);
  await h.tick();
  assert.deepEqual(h.decisions, [true, true]);
});

test('known JWT expiry is respected even for Spond', async () => {
  const h = harness();
  const payload = Buffer.from(JSON.stringify({ exp: Date.parse('2026-10-04T05:30:00Z') / 1000 })).toString('base64url');
  await h.capture(`synthetic.${payload}.signature-for-test`);
  await h.tick();
  h.advance(31);
  await h.tick();
  const expired = Buffer.from(JSON.stringify({ exp: 0 })).toString('base64url');
  await h.capture(`synthetic.${expired}.signature-for-test`);
  await h.tick();
  assert.deepEqual(h.decisions, [true, false, false]);
});

test('Vigilo keeps its existing fallback and opaque credential age limit', async () => {
  const h = harness('web-parent.prod.vigilo-oas.no');
  await h.capture('synthetic-opaque-credential-for-test');
  await h.tick();
  h.advance(46);
  await h.tick();
  assert.deepEqual(h.decisions, [true, false]);
});

test('Vigilo captures relative app fetch and XHR requests without accepting lookalike origins',async()=>{
  const h=harness('web-parent.prod.vigilo-oas.no');
  await h.appFetch('https://web-parent.prod.vigilo-oas.no.other.example/api/news-feed');
  await h.tick();assert.equal(h.decisions.at(-1),false);
  await h.appFetch('/api/news-feed');
  await h.tick();assert.equal(h.decisions.at(-1),true);
  h.advance(46);await h.tick();assert.equal(h.decisions.at(-1),false);
  h.appXhr('/api/posts/p/attachments/f');
  await h.tick();assert.equal(h.decisions.at(-1),true);
});
