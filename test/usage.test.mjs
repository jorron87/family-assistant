import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createUsage, scanSession, sessionHeader } from '../src/usage.mjs';

const root = resolve('.');
const line = (value) => JSON.stringify(value);
function session(dir, name, { cwd = root, source = 'vscode', threadSource = 'automation', tokens = [1000, 3000], tools = 2 } = {}) {
  const day = join(dir, '2026', '09', '28');
  mkdirSync(day, { recursive: true });
  const rows = [line({ timestamp: '2026-09-28T10:00:00.000Z', type: 'session_meta', payload: { id: name, timestamp: '2026-09-28T10:00:00.000Z', cwd, source, thread_source: threadSource } }),
    line({ timestamp: '2026-09-28T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'high' } })];
  for (let i = 0; i < tools; i++) rows.push(line({ timestamp: '2026-09-28T10:00:02.000Z', type: 'response_item', payload: { type: i % 2 ? 'custom_tool_call' : 'function_call', name: 'x' } }), line({ timestamp: '2026-09-28T10:00:02.500Z', type: 'response_item', payload: { type: 'function_call_output', output: 'ok' } }));
  tokens.forEach((total, index) => rows.push(line({ timestamp: `2026-09-28T10:0${index + 1}:00.000Z`, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: total, cached_input_tokens: Math.round(total * 0.9), output_tokens: 10 * (index + 1), reasoning_output_tokens: 5, total_tokens: total + 10 * (index + 1) }, last_token_usage: { input_tokens: total / 2 } } } })));
  const file = join(day, `rollout-${name}.jsonl`);
  writeFileSync(file, rows.join('\n') + '\n');
  return file;
}

test('scanSession teller turer, verktøykall og siste totalsum uten å telle output-linjer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-usage-'));
  try {
    const file = session(dir, 'a', { tokens: [1000, 3000, 6000], tools: 4 });
    const result = await scanSession(file);
    assert.equal(result.turns, 3);
    assert.equal(result.toolCalls, 4);
    assert.equal(result.usage.input_tokens, 6000);
    assert.equal(result.model, 'gpt-6-luna');
    assert.equal(result.effort, 'high');
    assert.equal(result.contextPeak, 3000);
    assert.equal(sessionHeader(file).threadSource, 'automation');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('summary tar bare med prosjektets økter, cacher, og tåler ødelagte filer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-usage-'));
  try {
    session(dir, 'mine', { tokens: [2000, 5000] });
    session(dir, 'annet', { cwd: 'C:\\Andre\\Prosjekt' });
    writeFileSync(join(dir, '2026', '09', '28', 'rollout-korrupt.jsonl'), 'ikke json\n{"halv');
    const usage = createUsage({ root, dataDir: dir, sessionsDir: dir, now: () => Date.parse('2026-09-29T00:00:00Z') });
    const summary = await usage.summary(3);
    assert.equal(summary.sessions.length, 1);
    assert.equal(summary.sessions[0].id, 'mine');
    assert.equal(summary.sessions[0].kind, 'automation');
    assert.equal(summary.sessions[0].inputTokens, 5000);
    assert.equal(summary.sessions[0].uncachedInputTokens, 500);
    assert.equal(summary.sessions[0].tokensPerTurn, 2500);
    assert.equal(summary.totals.turns, 2);
    // Andre kall bruker cache og gir samme svar.
    assert.equal((await usage.summary(3)).totals.totalTokens, summary.totals.totalTokens);
    // Utenfor vinduet telles ikke.
    assert.equal((await createUsage({ root, dataDir: dir, sessionsDir: dir, now: () => Date.parse('2026-12-01T00:00:00Z') }).summary(3)).sessions.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manglende sessions-mappe gir tomt svar, ikke feil', async () => {
  const usage = createUsage({ root, sessionsDir: join(tmpdir(), 'finnes-ikke-familien') });
  assert.deepEqual((await usage.summary(2)).sessions, []);
});
