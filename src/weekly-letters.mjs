// A read-only index over preserved originals; selecting a letter never reviews
// it, completes tasks or creates a calendar entry.
const dayMs = 86400000;
const iso = date => date.toISOString().slice(0, 10);
const monday = value => { const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return iso(d); };
function weekStart(year, week) {
  const d = new Date(monday(`${year}-01-04`) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7);
  return iso(d);
}
const weekOf = text => Number(String(text).match(/(?:uke(?:plan|brev)?|lekseplan|week)[\s_.-]*(?:for\s+uke\s*)?(\d{1,2})(?![\dA-Za-z])/i)?.[1]) || null;
const planTitle = text => /ukebrev|ukeplan|lekseplan|weekly\s*(?:letter|plan)/i.test(text);

export function normalizeWeeklyLetter(value) {
  if (value === null) return null;
  if (!value || !Number.isInteger(value.week) || value.week < 1 || value.week > 53 || !Number.isInteger(value.year) || value.year < 2020 || value.year > 2100) throw Error('weeklyLetter krever kildebelagt week (1–53) og year.');
  return { week: value.week, year: value.year, attachmentId: value.attachmentId ? String(value.attachmentId) : null };
}

export function weeklyLetters(snapshot, today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo' }).format(new Date())) {
  const current = monday(today), weekend = new Date(today + 'T12:00:00Z').getUTCDay() % 6 === 0;
  const next = iso(new Date(Date.parse(current + 'T12:00:00Z') + 7 * dayMs));
  const candidates = [];
  for (const raw of Object.values(snapshot.rawItems ?? {})) {
    if (raw.discarded || (!raw.weeklyLetter && (raw.source !== 'vigilo' || !planTitle(raw.title)))) continue;
    const files = raw.attachments ?? [];
    const week = raw.weeklyLetter?.week ?? weekOf(raw.title) ?? files.map(file => weekOf(file.fileName)).find(Boolean);
    if (!week || week > 53) continue;
    const anchor = new Date(raw.publishedAt || raw.firstSeenAt || raw.observedAt || today + 'T12:00:00Z');
    if (!Number.isFinite(anchor.getTime())) continue;
    const yearHint = Number(raw.title.match(/\b(20\d{2})\b/)?.[1]);
    const year = raw.weeklyLetter?.year ?? (yearHint || [anchor.getUTCFullYear() - 1, anchor.getUTCFullYear(), anchor.getUTCFullYear() + 1].sort((a, b) => Math.abs(Date.parse(weekStart(a, week)) - anchor.getTime()) - Math.abs(Date.parse(weekStart(b, week)) - anchor.getTime()))[0]);
    const from = weekStart(year, week);
    if (from > next) continue; // Do not promote a distant plan over this week.
    let attachment = files.find(file => file.id === raw.weeklyLetter?.attachmentId);
    if (!raw.weeklyLetter?.attachmentId) {
      attachment ??= files.find(file => weekOf(file.fileName) === week && !/meny|foreldremøte|invitasjon/i.test(file.fileName));
      attachment ??= files.find(file => new RegExp(`^_?${week}(?:\\s*\\(\\d+\\))?\\.pdf$`, 'i').test(file.fileName));
      attachment ??= files.find(file => planTitle(file.fileName) && !weekOf(file.fileName));
      attachment ??= files.length === 1 && !/meny|foreldremøte|invitasjon/i.test(files[0].fileName) ? files[0] : null;
    }
    const priority = from === next && weekend ? 4 : from === current ? 3 : from === next ? 2 : 1;
    candidates.push({ rawId: raw.id, title: raw.title, memberIds: raw.memberIds ?? [], week, year, from,
      attachmentId: attachment?.id ?? null, fileName: attachment?.fileName ?? null,
      status: from < current ? 'previous' : from > current ? 'upcoming' : 'current',
      priority, revisionAt: raw.updatedAt || raw.observedAt || raw.publishedAt || '' });
  }
  candidates.sort((a, b) => b.priority - a.priority || b.from.localeCompare(a.from) || b.revisionAt.localeCompare(a.revisionAt) || a.rawId.localeCompare(b.rawId));
  return (snapshot.profile?.members ?? []).filter(member => member.role === 'child').flatMap(member => {
    const chosen = candidates.find(item => item.memberIds.includes(member.id));
    if (!chosen) return [];
    const { priority, revisionAt, memberIds, ...letter } = chosen;
    return [{ ...letter, memberId: member.id }];
  });
}
