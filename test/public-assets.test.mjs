import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hver modul/stil som en side importerer må serveres, ellers dør hele siden (uten synlig feil på serveren).
const relativeImports = (file) => [...readFileSync(join('public', file), 'utf8').matchAll(/(?:from\s+|import\s*\(\s*)["']\.\/([\w.-]+?)(?:\?[^"']*)?["']/g)].map((match) => match[1]);
const linked = (html) => [...html.matchAll(/(?:href|src)="\/(?!send\/)([\w.-]+\.(?:css|js|mjs))"/g)].map((match) => match[1]);

test('alle importerte og lenkede filer i dashboard og mobilside serveres', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-assets-'));
  const port = 14360;
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, FAMILIEN_PORT: String(port), FAMILIEN_DATA_DIR: dir, FAMILIEN_NO_DISPATCH: '1' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const dashboardFiles = new Set(['app.js', 'kiosk.mjs', 'kiosk-home.mjs', 'home-view.mjs', 'weather-widget.mjs', 'event-display.mjs', 'login-status.mjs', 'calendar-data.mjs', 'profile-editor.mjs']);
    const wanted = new Set(linked(readFileSync('public/index.html', 'utf8')));
    for (const file of dashboardFiles) for (const name of relativeImports(file)) wanted.add(name);
    for (const name of wanted) {
      const response = await fetch(`http://127.0.0.1:${port}/${name}`);
      assert.equal(response.status, 200, `Dashboardet mangler rute for /${name}`);
    }
    const phoneWanted = new Set();
    for (const file of ['phone.js', 'phone-family.js']) for (const name of relativeImports(file)) phoneWanted.add(name);
    for (const name of phoneWanted) {
      const response = await fetch(`http://127.0.0.1:${port + 2}/send/${name}`);
      assert.equal(response.status, 200, `Mobilsiden mangler rute for /send/${name}`);
    }
    assert.ok(wanted.has('kiosk-home.mjs') && wanted.has('login-status.mjs'), 'testen fant importene');
  } finally {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await done;
    assert.ok(dir.startsWith(join(tmpdir(), 'familien-assets-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
