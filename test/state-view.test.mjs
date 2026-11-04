import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('/api/state?view=dashboard er slank og svarer 304 når ingenting er endret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-state-view-'));
  const port = 14390, api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: resolve('.'), env: { ...process.env, FAMILIEN_PORT: String(port), FAMILIEN_DATA_DIR: dir, FAMILIEN_NO_DISPATCH: '1', CODEX_HOME: dir }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${api}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const slim = await fetch(`${api}/api/state?view=dashboard`);
    assert.equal(slim.status, 200);
    const body = await slim.json();
    for (const key of ['events', 'profile', 'activities', 'surfaces', 'sourceStatus']) assert.ok(key in body, key);
    assert.deepEqual(body.reviewLedger, {});
    assert.deepEqual(body.documentReviews, {});
    assert.deepEqual(body.runs, []);
    const etag = slim.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{20}"$/);
    const again = await fetch(`${api}/api/state?view=dashboard`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal((await again.text()), '');
    const full = await (await fetch(`${api}/api/state`)).json();
    assert.ok('reviewLedger' in full && 'runs' in full);
  } finally { child.kill(); await new Promise((r) => setTimeout(r, 300)); rmSync(dir, { recursive: true, force: true }); }
});
