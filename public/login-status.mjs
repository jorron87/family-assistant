// Innlogging og ferskhet for kildene, til synlige varsler på dashboard og mobil. Ren funksjon (brukes også på serveren).
const NAMES = { vigilo: 'Vigilo', spond: 'Spond', facebook: 'Facebook', renovasjon: 'Min Renovasjon' };
const AFTER = {
  vigilo: 'Åpne Vigilo i Chrome på PC-en og logg inn (ID-porten). Nye skolebeskjeder og ukeplaner hentes ikke før dette er gjort.',
  spond: 'Åpne Spond i Chrome på PC-en og logg inn. Nye hallvakter, påmeldinger og beskjeder hentes ikke før dette er gjort.',
  facebook: 'Åpne Facebook i Chrome på PC-en og logg inn. Nye innlegg i gruppene hentes ikke før dette er gjort.',
  renovasjon: 'Kontroller Min Renovasjon.'
};
const STALE_HOURS = 24;

// Returnerer en liste sortert etter alvor: level 'login' (logget ut) foran 'stale' (uten kontroll) og 'watch' (øktkontroll svarer ikke).
export function loginProblems({ sourceStatus = {}, surfaces = {}, session = null, now = Date.now() } = {}) {
  const problems = [];
  const loggedOut = new Set();
  const sessionUsable = !!session && session.health !== 'not_configured' && !session.stale;

  // Vigilos Chrome-øktkontroll rapporterer hvert minutt og er fersk sannhet når den svarer.
  if (sessionUsable && session.health === 'needs_login') {
    problems.push({ source: 'vigilo', level: 'login', title: 'Vigilo er logget ut', detail: AFTER.vigilo, since: session.lastNeedsLoginAt ?? session.checkedAt });
    loggedOut.add('vigilo');
  } else if (sessionUsable && session.health === 'error') {
    problems.push({ source: 'vigilo', level: 'watch', title: 'Vigilo-fanen trenger tilsyn', detail: session.details, since: session.checkedAt });
  }
  const vigiloSessionSaysOk = sessionUsable && session.health === 'ok';

  for (const source of ['vigilo', 'spond', 'facebook']) {
    if (loggedOut.has(source)) continue;
    const status = sourceStatus[source];
    const surfaceOut = Object.values(surfaces).some((surface) => surface.source === source && surface.health === 'needs_login');
    const sourceOut = status?.health === 'needs_login';
    // En fersk «innlogget»-rapport fra øktkontrollen trumfer en eldre needs_login fra siste kjøring.
    if ((sourceOut || surfaceOut) && !(source === 'vigilo' && vigiloSessionSaysOk && Date.parse(session.checkedAt) > (status?.checkedAt ? Date.parse(status.checkedAt) : 0))) {
      problems.push({ source, level: 'login', title: `${NAMES[source]} er logget ut`, detail: AFTER[source], since: status?.checkedAt ?? null });
      loggedOut.add(source);
    }
  }
  for (const source of ['vigilo', 'spond', 'facebook']) {
    if (loggedOut.has(source)) continue;
    const checked = sourceStatus[source]?.checkedAt ? Date.parse(sourceStatus[source].checkedAt) : 0;
    if (!checked || now - checked > STALE_HOURS * 3600000) {
      problems.push({ source, level: 'stale', title: checked ? `${NAMES[source]}: siste fullførte kontroll er over ${STALE_HOURS} timer gammel` : `${NAMES[source]}: ingen fullført kontroll registrert`, detail: 'Nye data kan være hentet, men gjennomgangen er ikke bekreftet. Sjekk at PC-en og ChatGPT-appen kjører.', since: checked ? sourceStatus[source].checkedAt : null });
    }
  }
  // Vigilos øktkontroll er helt stille: Chrome/utvidelsen er trolig stoppet.
  if (session?.stale && !problems.some((p) => p.source === 'vigilo')) {
    problems.push({ source: 'vigilo', level: 'watch', title: 'Vigilo-øktkontrollen svarer ikke', detail: 'Chrome, PC-en eller utvidelsen kan være stoppet, så innloggingen kan ikke bekreftes.', since: session.checkedAt });
  }
  const order = { login: 0, stale: 1, watch: 2 };
  return problems.sort((a, b) => order[a.level] - order[b.level]);
}

// Kort tekst til bånd og mobil.
export function loginSummary(problems) {
  const out = problems.filter((problem) => problem.level === 'login');
  if (out.length) return { level: 'login', text: `${out.map((problem) => NAMES[problem.source]).join(' og ')} er logget ut – nye ting hentes ikke`, hint: out[0].detail };
  const other = problems[0];
  return other ? { level: other.level, text: other.title, hint: other.detail } : null;
}
