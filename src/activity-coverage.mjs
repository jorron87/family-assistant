function osloDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

export function activityCoverage(config, statuses, at = new Date()) {
  const today = osloDate(at);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const days = weekday === 0 ? config.weeklyLookaheadDays : config.dailyLookaheadDays;
  const targetThrough = addDays(today, days);
  const pending = [];
  for (const source of config.sources ?? []) {
    const status = statuses[source.id];
    let reason = null;
    if (!status) reason = 'never_checked';
    else if (status.health === 'ok' && status.unresolvedItems?.length) reason = 'partial';
    else if (status.health !== 'ok') reason = status.health;
    else if (!status.checkedAt || osloDate(status.checkedAt) !== today) reason = 'stale';
    else if (!status.scanTo || osloDate(status.scanTo) < targetThrough) reason = 'short_window';
    const feedCheckpoint = status?.lastSuccessfulCheckAt ?? (status?.health === 'ok' ? status.checkedAt : null);
    const checkpointMs = Date.parse(feedCheckpoint);
    const atMs = new Date(at).getTime();
    // Forward event horizon and backward discussion overlap are independent.
    // Guidance only: this never acknowledges unread content or clears partial.
    const discussionFrom = new Date(Number.isFinite(checkpointMs) && checkpointMs <= atMs
      ? Math.max(atMs - 30 * 86400000, checkpointMs - 72 * 3600000)
      : atMs - 30 * 86400000).toISOString();
    if (reason) pending.push({sourceId: source.id, name: source.name, reason,
      checkedAt: status?.checkedAt ?? null, scanTo: status?.scanTo ?? null,
      nextPageHint: status?.nextPageHint ?? '',
      ...(status?.unresolvedItems?.length ? {unresolvedItems: status.unresolvedItems} : {}),
      ...(source.id === 'activity-1' ? {discussionFrom, lastSuccessfulCheckAt: feedCheckpoint,
        discussionRule:'Discussion: les nye innlegg tilbake til discussionFrom. targetThrough gjelder bare kommende arrangementer; behold ulest dekning ved faktisk feil.'} : {})});
  }
  return {complete: pending.length === 0, today, targetThrough, sourceCount: (config.sources ?? []).length,
    pendingCount: pending.length, pending};
}

export function validateActivityRun(coverage, report) {
  if (report.outcome === 'skipped' || ['telefon', 'familiehandlinger'].includes(report.scope)) return;
  if (report.outcome === 'ok' && !coverage.complete) {
    throw new Error(`Aktivitetsgjennomgangen er ikke ferdig: ${coverage.pendingCount} av ${coverage.sourceCount} kilder gjenstår. Kjør activity-queue.`);
  }
  if (['partial', 'needs_login', 'error', 'continued'].includes(report.outcome)) {
    // An untouched or too short successful checkpoint is unfinished work,
    // not evidence that the source is externally blocked. Record the actual
    // failed attempt on that source before reporting a blocked full run.
    const unattempted = coverage.pending.filter(source => ['never_checked', 'stale', 'short_window'].includes(source.reason));
    if (unattempted.length) throw new Error(`Aktivitetskilder er fortsatt ikke ferdig kontrollert: ${unattempted.map(source => source.sourceId).join(', ')}. Manglende besøk er ikke en ekstern blokkering. Fortsett kontrollen; ved faktisk feil registrer kilde, forsøkt metode og konkret feil med activity-source før run. Ikke merk ulest innhold ok.`);
    const blockers = report.blockers ?? [];
    const missing = coverage.pending.filter(source => {
      const escaped = source.sourceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const exactId = new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`);
      return !blockers.some(blocker => exactId.test(blocker));
    });
    if (missing.length) throw new Error(`Aktivitetskilder uten konkret kildeblokkering: ${missing.map(source => source.sourceId).join(', ')}. Fortsett dem før run; ved ekstern feil angi kilde-ID og årsak i blockers.`);
  }
}
