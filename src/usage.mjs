import { createReadStream, existsSync, openSync, readSync, closeSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

// Måler hva hver agentkjøring koster ved å lese Codex' egne øktlogger (kun tall, aldri innhold).
// Alt er «best effort»: uleselige filer hoppes over, og ingenting her påvirker selve innhentingen.

export const defaultSessionsDir = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
const norm = (path) => resolve(String(path ?? '')).toLowerCase();

function firstLine(file) {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.indexOf('\n');
    return end < 0 ? text : text.slice(0, end);
  } finally { closeSync(fd); }
}

export function sessionHeader(file) {
  try {
    const entry = JSON.parse(firstLine(file));
    if (entry.type !== 'session_meta') return null;
    const p = entry.payload ?? {};
    return { id: p.id ?? p.session_id ?? null, startedAt: p.timestamp ?? entry.timestamp ?? null, cwd: p.cwd ?? null, source: p.source ?? null, threadSource: p.thread_source ?? null };
  } catch { return null; }
}

// Leser én øktlogg linje for linje. Bare linjer som trengs blir JSON-parset, så 100 MB-filer går raskt.
export async function scanSession(file) {
  const result = { turns: 0, toolCalls: 0, model: null, effort: null, startedAt: null, endedAt: null, usage: null, contextPeak: 0 };
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.includes('"type":"function_call"') || line.includes('"type":"custom_tool_call"')) { result.toolCalls++; continue; }
    if (!result.model && line.includes('"type":"turn_context"')) {
      try { const p = JSON.parse(line).payload ?? {}; result.model = p.model ?? null; result.effort = p.effort ?? p.reasoning_effort ?? null; } catch { /* ignoreres */ }
      continue;
    }
    if (!line.includes('"type":"token_count"')) continue;
    try {
      const entry = JSON.parse(line);
      const info = entry.payload?.info;
      if (!info?.total_token_usage) continue;
      result.turns++;
      result.usage = info.total_token_usage;
      result.contextPeak = Math.max(result.contextPeak, info.last_token_usage?.input_tokens ?? 0);
      result.startedAt ??= entry.timestamp;
      result.endedAt = entry.timestamp;
    } catch { /* ignoreres */ }
  }
  return result;
}

function listSessionFiles(dir, sinceMs) {
  const files = [];
  const walk = (folder, depth) => {
    let names;
    try { names = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { if (statSync(path).mtimeMs >= sinceMs) files.push(path); } catch { /* forsvant under skanning */ }
      }
    }
  };
  walk(dir, 0);
  return files;
}

export function createUsage({ root, dataDir, sessionsDir = defaultSessionsDir(), now = Date.now }) {
  const cachePath = dataDir ? join(dataDir, 'usage-cache.json') : null;
  let cache = {};
  if (cachePath && existsSync(cachePath)) { try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { cache = {}; } }
  const projectRoot = norm(root);
  let inflight = null;

  async function collect(days) {
    const since = now() - days * 86400000;
    const rows = [];
    let changed = false;
    for (const file of listSessionFiles(sessionsDir, since)) {
      let stats;
      try { stats = statSync(file); } catch { continue; }
      const key = file;
      const cached = cache[key];
      let row = cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size ? cached.row : undefined;
      if (row === undefined) {
        const header = sessionHeader(file);
        if (!header || norm(header.cwd) !== projectRoot) row = null;            // andre prosjekter: aldri åpnet
        else {
          try { row = { ...header, ...(await scanSession(file)) }; } catch { row = null; }
        }
        cache[key] = { mtimeMs: stats.mtimeMs, size: stats.size, row };
        changed = true;
      }
      if (row?.usage) rows.push(row);
    }
    if (changed && cachePath) { try { writeFileSync(`${cachePath}.tmp`, JSON.stringify(cache)); renameSync(`${cachePath}.tmp`, cachePath); } catch { /* cache er valgfri */ } }
    return rows.filter((row) => Date.parse(row.endedAt ?? row.startedAt) >= since);
  }

  const view = (row) => {
    const usage = row.usage;
    const cached = usage.cached_input_tokens ?? 0;
    return {
      id: row.id, kind: row.threadSource ?? row.source ?? 'ukjent', startedAt: row.startedAt ?? row.endedAt, endedAt: row.endedAt,
      minutes: row.startedAt && row.endedAt ? Math.round((Date.parse(row.endedAt) - Date.parse(row.startedAt)) / 60000) : null,
      model: row.model, effort: row.effort, turns: row.turns, toolCalls: row.toolCalls,
      inputTokens: usage.input_tokens ?? 0, cachedInputTokens: cached, uncachedInputTokens: (usage.input_tokens ?? 0) - cached,
      outputTokens: usage.output_tokens ?? 0, reasoningTokens: usage.reasoning_output_tokens ?? 0, totalTokens: usage.total_tokens ?? 0,
      contextPeak: row.contextPeak, tokensPerTurn: row.turns ? Math.round((usage.input_tokens ?? 0) / row.turns) : 0
    };
  };

  async function summary(days = 7) {
    inflight ??= collect(days).finally(() => { inflight = null; });
    const sessions = (await inflight).map(view).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    const sum = (key) => sessions.reduce((total, item) => total + (item[key] ?? 0), 0);
    return { days, sessions, totals: { sessions: sessions.length, turns: sum('turns'), toolCalls: sum('toolCalls'), inputTokens: sum('inputTokens'), uncachedInputTokens: sum('uncachedInputTokens'), outputTokens: sum('outputTokens'), totalTokens: sum('totalTokens') } };
  }
  return { summary };
}
