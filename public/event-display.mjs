// Felles visningsspråk for kiosk og mobil: rene funksjoner uten DOM.

const SOURCE_META = /kildekort|kildebrev|kildebelagt|kildeoppgitt|rådata|privat familie|drive|kilden (oppgir|viser)|ikke oppgitt i (ukeplanen|kilden)|assistentpåminnelse|valgt påminnelse/i;

export const cleanTitle = (title = '') => String(title).replace(/^\s*\[\s*foreløpig\s*\]\s*/i, '').trim();

// Assistentens egne oppfølgingspåminnelser er ikke avtaler med klokkeslett.
export function isFollowUp(event) {
  if (event.task) return false;
  if (event.kind === 'task') return true;
  if (!event.provisional || event.allDay || !event.start || !event.end) return false;
  return Date.parse(event.end) - Date.parse(event.start) <= 30 * 60000;
}

export const isWaste = (event) => String(event.canonicalKey ?? '').startsWith('renovasjon:');

export function timeLabel(event, day, { clockOf, startDayOf }) {
  if (event.task) return `${event.task.items.filter((item) => item.doneAt).length}/${event.task.items.length}`;
  if (event.allDay) return 'Hele dagen';
  if (isFollowUp(event)) return 'Følg opp';
  if (startDayOf(event) !== day) return 'Pågår';
  return clockOf(event.start);
}

const truncate = (text, max) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// Kort «husk»-linje fra pakkeliste/sjekkliste, ellers første lesbare detaljlinje uten kildemetadata.
export function noteFor(event, max = 90) {
  const items = (event.checklist ?? []).map((item) => String(item).trim()).filter((item) => item && !SOURCE_META.test(item));
  const unique = [...new Set(items)];
  if (unique.length) return truncate(unique.slice(0, 2).join(' · '), max);
  const sentences = String(event.details ?? '').split('\n').flatMap((line) => line.trim().split(/(?<=[.!?])\s+/)).map((text) => text.trim()).filter((text) => text && !SOURCE_META.test(text));
  return sentences.length ? truncate(sentences.slice(0, 2).join(' '), max) : '';
}

const FRACTIONS = [
  [/restavfall/i, 'rest', 'Rest', '#6b716c'],
  [/papir/i, 'papir', 'Papir', '#5f86b5'],
  [/^mat|matavfall/i, 'mat', 'Mat', '#8a6d4b'],
  [/glass|metall/i, 'glass', 'Glass/metall', '#4d9a92'],
  [/plast/i, 'plast', 'Plast', '#a0679d'],
  [/farlig|elektr|tekstil/i, 'annet', 'Annet', '#b58a3f']
];

export function wasteFractions(event) {
  const raw = String(event.title ?? '').split(/[–—-]\s+/).slice(1).join(' ');
  const parts = raw.split(/,\s*/).map((part) => part.trim()).filter(Boolean);
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const match = FRACTIONS.find(([pattern]) => pattern.test(part));
    const entry = match ? { key: match[1], label: match[2], color: match[3] } : { key: part.toLowerCase(), label: part, color: '#8a908b' };
    if (!seen.has(entry.key)) { seen.add(entry.key); result.push(entry); }
  }
  return result;
}

// Nattpanelets og «I morgen»-radens minne: første punkter fra pakkelister.
export function packingItems(events, limit = 3) {
  const items = [];
  for (const event of events) for (const item of event.checklist ?? []) {
    const text = String(item).trim();
    if (text && !SOURCE_META.test(text) && !items.includes(text)) items.push(text);
  }
  return items.slice(0, limit).map((text) => truncate(text, 70));
}

export const isNight = (minutes, from = 21 * 60 + 30, to = 6 * 60 + 30) => minutes >= from || minutes < to;

export function minutesOfClock(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + m;
}
