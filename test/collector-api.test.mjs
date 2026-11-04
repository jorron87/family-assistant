import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CHILD = '9e71a037-026d-163e-be04-9a41044ef491';

test('samler-API: krever lokal avsender, avviser fra kiosken, og gir agenten status og elementtekst', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-collector-api-'));
  const port = 14380;
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: resolve('.'), env: { ...process.env, FAMILIEN_PORT: String(port), FAMILIEN_DATA_DIR: dir, FAMILIEN_NO_DISPATCH: '1', CODEX_HOME: dir }, stdio: 'ignore' });
  const cli = async (...args) => JSON.parse((await run(process.execPath, ['src/cli.mjs', ...args], { cwd: resolve('.'), env: { ...process.env, FAMILIEN_API: api } })).stdout);
  const post = (path, body, headers = { 'Content-Type': 'application/json', 'X-Family-Request': '1' }, base = api) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${api}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    assert.equal((await post('/api/collector', { source: 'vigilo', kind: 'health', health: 'ok' }, { 'Content-Type': 'application/json' })).status, 403, 'uten X-Family-Request');
    assert.equal((await post('/api/collector', { source: 'vigilo', kind: 'health', health: 'ok' }, { 'Content-Type': 'text/plain', 'X-Family-Request': '1' })).status, 403, 'ikke JSON');
    assert.equal((await post('/api/collector', { source: 'vigilo', kind: 'health', health: 'ok' }, undefined, `http://127.0.0.1:${port + 1}`)).status, 405, 'kiosken kan ikke skrive');
    assert.equal((await post('/api/collector', { source: 'vigilo', kind: 'children', items: [{ id: CHILD, firstName: 'Barn Tre', lastName: 'Eksempel' }] })).status, 200);
    const response = await post('/api/collector', { source: 'vigilo', kind: 'news', childId: CHILD, complete: true, items: [{ id: 'c7ef9824-c72d-7341-4e1b-17b48bd2c02f', posted: new Date(Math.floor(Date.now() / 3600000) * 3600000 - 86400000).toISOString(), title: 'Omgangssyke', text: 'Omgangssyke på skolen. ' + 'Lang tekst. '.repeat(40) + 'SLUTTEN-AV-TEKSTEN', childIds: [CHILD], attachments: [] }] });
    assert.equal(response.status, 200);
    assert.equal((await post('/api/collector', { source: 'vigilo', kind: 'news', childId: 'ukjent', items: [] })).status, 422);

    const status = await (await fetch(`${api}/api/collector/status`)).json();
    assert.equal(status.sources.vigilo.pending, 1);
    const config = await (await fetch(`${api}/api/collector/config`)).json();
    assert.equal(config.enabled, true);
    assert.ok(config.limits.minSpacingMs >= 1000);

    const next = await cli('next');
    assert.equal(next.collector.vigilo.items, 1);
    assert.ok(next.work.some((entry) => entry.do === 'review' && entry.externalId.startsWith('vigilo:news:')));
    const item = await cli('collected', 'vigilo:news:c7ef9824-c72d-7341-4e1b-17b48bd2c02f');
    assert.ok(item.text.startsWith('Omgangssyke på skolen.') && item.text.endsWith('SLUTTEN-AV-TEKSTEN'), 'hele teksten, ikke bare utdraget');
    const list = await cli('collected-list', 'vigilo', 'child3:news');
    assert.equal(list.length, 1);
    assert.equal(list[0].externalId, item.externalId);
    assert.equal(list[0].needsReview, true);
    assert.equal(JSON.stringify(list).includes('SLUTTEN-AV-TEKSTEN'), false);
    assert.deepEqual(await cli('collected-list', 'vigilo', 'child1:news'), []);
    assert.equal(JSON.stringify(await (await fetch(`${api}/api/state`)).json()).includes('SLUTTEN-AV-TEKSTEN'), false, 'full samlertekst skal ikke ligge i /api/state');

    const before = (await (await fetch(`${api}/api/collector/status`)).json()).refreshRequestedAt;
    await cli('begin-run');
    const after = (await (await fetch(`${api}/api/collector/status`)).json()).refreshRequestedAt;
    assert.notEqual(after, before, 'begin-run bestiller ny observasjon');
  } finally {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await done;
    assert.ok(dir.startsWith(join(tmpdir(), 'familien-collector-api-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
