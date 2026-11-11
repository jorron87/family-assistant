import { readFileSync } from "node:fs";
import { collectorIsFresh } from './collector.mjs';
import { shoppingWorkBatch, shoppingWorkCount, filterShoppingWork } from './shopping-work-batch.mjs';

// FILE-argumenter kan være en fil, `-` (stdin) eller inline JSON. Det sparer agenten for midlertidige filer.
export function readJsonArg(arg, stdin = () => readFileSync(0, "utf8")) {
  if (arg === undefined) throw new Error("JSON mangler: oppgi fil, - for stdin eller inline JSON.");
  const text = arg === "-" ? stdin() : /^\s*[\[{]/.test(arg) ? arg : readFileSync(arg, "utf8");
  // Windows PowerShell Set-Content -Encoding utf8 writes a BOM. It is a
  // transport marker, not source content, and must not trigger agent retries.
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error(`Ugyldig JSON (${arg === "-" ? "stdin" : /^\s*[\[{]/.test(arg) ? "inline" : arg}): ${error.message}`); }
}

const LIST_LIMIT = 20;
const cap = (list) => Array.isArray(list) && list.length > LIST_LIMIT ? [...list.slice(0, LIST_LIMIT), { truncated: list.length - LIST_LIMIT }] : list;

// Keep queue counts authoritative without sending thousands of review
// fingerprints into every agent turn. This is a view, never a queue mutation.
export function shoppingOverview(queue = [], { full = false, type = null, id = null } = {}) {
  const { items: shopping, summary: shoppingSummary } = shoppingWorkBatch(filterShoppingWork(queue,{type,id}), { full });
  return { shopping, shoppingSummary };
}

// completion uten historikk (blokkerer aldri) og med kappede lister; counts er alltid fullstendig.
export function slimCompletion(report, { history = false, full = false } = {}) {
  if (full) return report;
  const { historicalMissingDrive, historicalSurfaces, historicalItems, ...rest } = report;
  const slim = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, Array.isArray(value) ? cap(value) : value]));
  if (rest.shopping && Array.isArray(rest.shopping.work)) {
    const { shopping: work, shoppingSummary } = shoppingOverview(rest.shopping.work);
    slim.shopping = { ...rest.shopping, work, workCount: shoppingSummary.total, moreWork: shoppingSummary.remaining };
  }
  if (history) return { ...slim, historicalMissingDrive, historicalSurfaces, historicalItems };
  return { ...slim, historical: { missingDrive: historicalMissingDrive?.length ?? 0, surfaces: historicalSurfaces?.length ?? 0, items: historicalItems?.length ?? 0, note: "Bruk --history for detaljer." } };
}

const surfaceOpen = (surface) => surface.health !== "ok" || surface.nextPageHint || surface.currentComplete === false;

// review-queue uten ferdige overflater. Overflater med arbeid eller neste side beholdes.
export function slimReviewQueue(queue, { full = false } = {}) {
  if (full) return queue;
  const surfaces = Object.fromEntries(Object.entries(queue.surfaces ?? {}).filter(([, surface]) => surfaceOpen(surface)));
  return { ...queue, surfaces, surfaceCount: Object.keys(queue.surfaces ?? {}).length, vigiloCoverage: (queue.vigiloCoverage ?? []).filter((entry) => entry.issues.length) };
}

// Kort, prioritert arbeidsliste som erstatter 4-5 separate lesninger.
export function collectorSummary(collector, now = Date.now()) {
  if (!collector) return null;
  const out = {};
  for (const [source, info] of Object.entries(collector.sources ?? {})) {
    const age = info.oldestSweepAt ? Math.round((now - Date.parse(info.oldestSweepAt)) / 60000) : null;
    const probe = info.probeAt ? Math.max(0, (now - Date.parse(info.probeAt)) / 60000) : Infinity;
    const fresh = collectorIsFresh(info, now);
    out[source] = { fresh, ageMinutes: age, probeAgeMinutes: Number.isFinite(probe) ? Math.round(probe) : null, coveredKinds: info.coveredKinds, health: info.health?.health ?? null, pending: info.pending, items: info.items };
  }
  return out;
}

export function buildNext({ phone, calendarActions, completion, queue, activities, collector, feed, shopping = [], clarificationAnswers = [], now = Date.now() }) {
  const work = [];
  const phoneItems = (Array.isArray(phone) ? phone : phone?.items ?? []).filter((item) => ["queued", "processing", "blocked"].includes(item.status));
  for (const item of phoneItems) work.push({ do: "phone", id: item.id, title: item.title, status: item.status, note: item.note ?? undefined });
  for (const action of calendarActions ?? []) work.push({ do: "calendar-action", eventId: action.eventId ?? action.id, action: action.action ?? action.type, title: action.title });
  for(const item of clarificationAnswers)work.push({do:'clarification-answer',id:item.id,answerFingerprint:item.answerFingerprint,subject:item.subject,question:item.question});
  const soon = now + 14 * 86400000;
  const queueItems = [...(queue?.items ?? [])].sort((a, b) => String(a.reason).localeCompare(String(b.reason)));
  for (const item of queueItems) work.push({ do: "review", source: item.source, surface: item.surface, externalId: item.externalId, title: item.title, reason: item.reason, rawId: item.rawId });
  for (const raw of completion?.profileReviews ?? []) if (raw.rawId) work.push({ do: "profile-review", rawId: raw.rawId, title: raw.title });
  for (const item of completion?.missingDrive ?? []) if (item.rawId) work.push({ do: "drive", rawId: item.rawId, kind: item.kind, attachmentId: item.attachmentId, fileName: item.fileName, title: item.title });
  for (const event of completion?.unsyncedCalendar ?? []) if (event.eventId) work.push({ do: "calendar", eventId: event.eventId, title: event.title });
  for (const surface of completion?.incompleteSurfaces ?? []) if (surface.source) work.push({ do: "surface", source: surface.source, surface: surface.surface, health: surface.health, nextPageHint: surface.nextPageHint ?? undefined });
  for (const source of completion?.incompleteSources ?? []) if (source.source) work.push({ do: "source-status", source: source.source, health: source.health });
  for (const issue of completion?.vigiloIssues ?? []) work.push({ do: "vigilo", surface: issue.surface, issues: issue.issues });
  if (feed?.hsia?.candidates) work.push({ do: 'activity-candidates', count: feed.hsia.candidates, hint: 'node src/cli.mjs activity-candidates, deretter --ack' });
  for(const id of new Set((feed?.facebookActivities??[]).map(item=>item.sourceId)))work.push({do:'activity-facebook',id,hint:'node src/cli.mjs activity-facebook '+id});
  for (const id of feed?.changedPages ?? []) work.push({ do: 'activity-page', id, hint: 'node src/cli.mjs activity-page ' + id });
  for (const source of activities?.pending ?? []) work.push({ do: "activity-source", id: source.sourceId, name: source.name, reason: source.reason });
  const remaining = work.length + shoppingWorkCount(shopping);
  const visible = work.slice(0, 40);
  const batch = shoppingWorkBatch(shopping, { limit: Math.min(LIST_LIMIT, Math.max(0, 40 - visible.length)) });
  visible.push(...batch.items);
  const collectorGaps=Object.entries(collector?.supplemental??{}).filter(([,status])=>status.health!=='ok').map(([surface,status])=>({surface,...status}));
  return { complete: completion?.complete === true && !remaining, collector: collectorSummary(collector, now),collectorGaps,counts: completion?.counts, remaining, work: visible, moreWork: Math.max(0, remaining - shoppingWorkCount(visible)), horizon: new Date(soon).toISOString().slice(0, 10) };
}

// ---- Kompakte svar. Skrivekommandoene trenger en kvittering, ikke hele objektet tilbake i konteksten. `--full` gir alt. ----

const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined && object[key] !== null).map((key) => [key, object[key]]));

export function slimEvent(event) {
  const calendar = event.calendar ? pick(event.calendar, ['calendarId', 'eventId', 'eventUrl', 'fingerprint', 'removedAt']) : null;
  return {
    ...pick(event, ['id', 'canonicalKey', 'title', 'kind', 'start', 'end', 'allDay', 'provisional', 'dateConfirmed', 'cancelled', 'fingerprint']),
    members: event.members,
    ...(event.task ? { task: { visibleFrom: event.task.visibleFrom, dueDate: event.task.dueDate, items: event.task.items.map((item) => ({ key: item.key, done: !!item.doneAt })) } } : {}),
    calendar,
    needsCalendar: !event.visibility?.hidden && (!event.cancelled || calendar) && (!calendar || !!calendar.removedAt || calendar.fingerprint !== event.fingerprint)
  };
}

export function slimRaw(raw) {
  return {
    ...pick(raw, ['id', 'source', 'externalId', 'title', 'revision', 'driveUrl', 'driveRevision', 'profileReviewedRevision']),
    needsCard: !raw.driveUrl || raw.driveRevision !== raw.revision,
    attachments: (raw.attachments ?? []).map((file) => pick(file, ['id', 'fileName', 'sha256', 'driveUrl', 'contentError'])),
    findingIds: raw.findingIds
  };
}

const looksLikeEvent = (value) => value && typeof value === 'object' && value.id && Array.isArray(value.sourceRefs);
const looksLikeRaw = (value) => value && typeof value === 'object' && value.id && Array.isArray(value.attachments) && 'body' in value;

export function slimResult(result, { full = false } = {}) {
  if (full || !result || typeof result !== 'object') return result;
  if (result.item && looksLikeRaw(result.item) && Array.isArray(result.findings)) {
    const { item, findings, ...rest } = result;
    return { ...rest, item: slimRaw(item), findings: findings.map((entry) => looksLikeEvent(entry) ? slimEvent(entry) : entry) };
  }
  if (looksLikeEvent(result)) return slimEvent(result);
  if (looksLikeRaw(result)) return slimRaw(result);
  return result;
}

// profile: bare det agenten faktisk bruker (aktive fakta og kandidater). Historikken (`facts`) dupliserer aktive fakta.
export function slimProfile(profile, { full = false } = {}) {
  if (full || !profile?.activeFacts) return profile;
  const { facts, activeFacts, members, ...rest } = profile;
  return {
    ...rest,
    members: members.map((member) => pick(member, ['id', 'name', 'role', 'schoolClass', 'aliases'])),
    activeFacts: activeFacts.map((fact) => pick(fact, ['memberId', 'key', 'text', 'category', 'confidence', 'validFrom', 'validTo'])),
    history: { facts: facts?.length ?? 0, note: 'Bruk --full for hele historikken.' }
  };
}

// phone-inbox: ferdige og avbrutte innsendinger skjules (samme listeform som før), med mindre --all.
export function slimPhone(list, { all = false } = {}) {
  if (all || !Array.isArray(list)) return list;
  return list.filter((item) => !['done', 'cancelled'].includes(item.status));
}
