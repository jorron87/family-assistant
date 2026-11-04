import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('cli: intake med markReviewed/profileReview og observe-list med surfaceStatus i ett kall hver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-cli-'));
  const port = 14340;
  const api = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, FAMILIEN_PORT: String(port), FAMILIEN_DATA_DIR: dir, CODEX_HOME: dir }, stdio: 'ignore' });
  const cli = async (...args) => JSON.parse((await run(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, FAMILIEN_API: api } })).stdout);
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${api}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const observed = await cli('observe-list', JSON.stringify({
      source: 'facebook', surface: 'group-1:posts',
      items: [{ externalId: 'fb:post:1', title: 'Loppis', summary: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1', publishedAt: new Date().toISOString() }],
      surfaceStatus: { health: 'ok', complete: true, details: 'Test' }
    }));
    assert.equal(observed.decisions[0].needsReview, true);
    assert.match(observed.warning, /partial/);
    assert.equal(observed.surfaceStatus.health, 'partial');

    const intake = await cli('intake', JSON.stringify({
      source: 'facebook', externalId: 'fb:post:1', title: 'Loppis', body: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1',
      publishedAt: new Date().toISOString(), memberIds: ['child3'],
      profileReview: { note: 'Ingen varig informasjon.', facts: [] },
      markReviewed: [{ surface: 'group-1:posts', relevance: 'relevant' }]
    }));
    assert.ok(intake.item.id);
    assert.equal(intake.profileReview.rawId, intake.item.id);
    assert.equal(intake.markReviewed.length, 1);

    const again = await cli('observe-list', JSON.stringify({
      source: 'facebook', surface: 'group-1:posts',
      items: [{ externalId: 'fb:post:1', title: 'Loppis', summary: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1', publishedAt: observed.decisions.length ? new Date().toISOString() : null }],
    }));
    assert.equal(again.decisions.length, 1);

    const batch = await cli('surface', JSON.stringify([
      { source: 'facebook', surface: 'group-1:posts', health: 'partial', details: 'a' },
      { source: 'facebook', surface: 'group-2:posts', health: 'partial', details: 'b' }
    ]));
    assert.equal(batch.length, 2);

    const batched = await cli('batch', JSON.stringify([
      { cmd: 'surface', input: { source: 'facebook', surface: 'group-3:posts', health: 'partial', details: 'c' } },
      { cmd: 'completion' },
      { cmd: 'usage', args: ['1'] }
    ]));
    assert.equal(batched.ok, true);
    assert.equal(batched.ran, 3);
    assert.equal(batched.results[0].result.surface, 'group-3:posts');
    assert.ok(batched.results[1].result.counts);
    assert.ok(Array.isArray(batched.results[2].result.sessions));
    // Første feil stopper resten og gir exit-kode 1.
    let failed;
    try { await cli('batch', JSON.stringify([{ cmd: 'mark-reviewed', input: { source: 'facebook', externalId: 'finnes-ikke' } }, { cmd: 'completion' }])); }
    catch (error) { failed = JSON.parse(error.stdout); }
    assert.equal(failed.ok, false);
    assert.equal(failed.ran, 1);
    assert.equal(failed.of, 2);

    const completion = await cli('completion');
    assert.equal(completion.historicalItems, undefined);
    assert.ok(completion.counts);
    assert.ok(Array.isArray((await cli('next')).work));

    // PowerShell's default UTF-8 file must pass through the CLI and HTTP API on
    // the first attempt, before the agent releases its observed start time.
    const {lease}=await cli('begin-run');
    const reportFile=join(dir,'run-bom.json');
    writeFileSync(reportFile,'\uFEFF'+JSON.stringify({scope:'kildeendringer',outcome:'partial',summary:'Kjøringen fant et kildehull.',blockers:['Originalen var utilgjengelig fra kildens server.'],resumeHint:'Prøv igjen ved ny kildeinformasjon.'}),'utf8');
    try {
      const recorded=await cli('run',reportFile);
      assert.equal(recorded.startedAt,lease.startedAt);
      assert.equal(recorded.summary,'Kjøringen fant et kildehull.');
      assert.ok(recorded.durationMs>=0);
      assert.equal((await cli('runs')).filter(item=>item.summary==='Kjøringen fant et kildehull.').length,1);
    } finally { await cli('end-run',lease.token); }
  } finally {
    const done = new Promise((r) => child.once('exit', r));
    child.kill();
    await done;
    assert.ok(dir.startsWith(join(tmpdir(), 'familien-cli-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
