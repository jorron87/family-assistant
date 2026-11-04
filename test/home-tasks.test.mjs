import test from 'node:test';
import assert from 'node:assert/strict';
import { homeworkCards, isHomework, tasksDueOn, overdueTasks, attachTasks } from '../public/home-tasks.mjs';
import { mergeTask } from '../src/tasks.mjs';

const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const today = '2026-10-08';
const task = (id, title, members, dueDate, items, extra = {}) => ({ id, title, members, task: { visibleFrom: '2026-10-04', dueDate, items: items.map((done, i) => ({ key: `k${i}`, text: `${title} punkt ${i + 1}`, doneAt: done ? '2026-10-07T10:00:00Z' : null })), ...extra } });
const children = ['child1', 'child2', 'child3', 'child4'].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), role: 'child' }));

test('ett leksekort per barn: åpne lekser skrevet ut, ferdig barn får hake, barn uten lekser vises tydelig', () => {
  const tasks = [
    task('s41', 'Lekser og forberedelser for uke 41 – Barn En', ['child1'], '2026-10-09', [1, 1, 1, 1, 0, 0]),
    task('l41', 'Lekser uke 41 – Barn To', ['child2'], '2026-10-09', [1, 1, 1]),
    task('m41', '[Foreløpig] Lekser og forberedelser for uke 41 – Barn Tre', ['child3'], '2026-10-09', [0, 0, 0], { category: 'homework' }),
    task('s42', 'Uke 42-oppgaver – Barn En', ['child1'], '2026-10-16', [0, 0], { visibleFrom: '2026-10-12' })
  ];
  const cards = homeworkCards({ tasks, children, today });
  assert.deepEqual(cards.map((card) => card.state), ['open', 'done', 'open', 'none']);
  assert.equal(cards[0].event.id, 's41', 'neste ukes plan vises ikke før visibleFrom');
  assert.deepEqual([cards[0].done, cards[0].total], [4, 6]);
  assert.equal(cards[0].openItems.length, 2);
  assert.equal(cards[2].openItems[0], '[Foreløpig] Lekser og forberedelser for uke 41 – Barn Tre punkt 1');
});

test('passerte lekser med åpne punkter vises først og markeres', () => {
  const tasks = [
    task('a40', 'Lekser uke 40 – Barn Fire', ['child4'], '2026-10-02', [1, 0]),
    task('a41', 'Lekser uke 41 – Barn Fire', ['child4'], '2026-10-09', [0, 0])
  ];
  const [card] = homeworkCards({ tasks, children: [children[3]], today });
  assert.equal(card.state, 'overdue');
  assert.equal(card.event.id, 'a40');
  assert.equal(card.otherOpen, 1);
});

test('oppgaver bor på fristdagen; lekser holdes utenfor; ferdige kan bli stående på dagen', () => {
  const tasks = [
    task('mat', 'Pakk mat og drikke til pølsegrillingen', ['child3', 'child4'], '2026-10-27', [0]),
    task('ferdig', 'Ta med vann', ['child3'], '2026-10-27', [1]),
    task('hw', 'Lekser uke 43 – Barn En', ['child1'], '2026-10-27', [0]),
    task('annen', 'Finn barnevakt', ['parent1'], '2026-10-30', [0])
  ];
  assert.deepEqual(tasksDueOn(tasks, '2026-10-27').map((t) => t.id), ['mat']);
  assert.deepEqual(tasksDueOn(tasks, '2026-10-27', { includeDone: true }).map((t) => t.id), ['mat', 'ferdig']);
});

test('ikke gjort ennå: bare passerte og uferdige oppgaver, eldste først, uten lekser', () => {
  const tasks = [
    task('vann', 'Ta med vann hjemmefra', ['child3'], '2026-10-23', [0]),
    task('child1', 'Avklar oppfølging for Barn En', ['child1'], '2026-10-14', [1, 0, 0]),
    task('gjort', 'Gjort', ['child3'], '2026-10-20', [1]),
    task('hw', 'Lekser uke 42 – Barn Tre', ['child3'], '2026-10-20', [0]),
    task('snart', 'Snart', ['child3'], '2026-10-26', [0])
  ];
  assert.deepEqual(overdueTasks(tasks, '2026-10-25').map((t) => t.id), ['child1'], 'vannet gjaldt bare fredag og har utløpt');
});

test('forberedelser legges under riktig avtale: eksplisitt forEvent, ellers samme kilde og flest felles ord; uklart blir egen rad', () => {
  const ev = (id, title, members, refs, key = id) => ({ id, title, members, sourceRefs: refs, canonicalKey: key });
  const events = [ev('ute', 'Uteskole med 4. trinn', ['child3', 'child4'], ['plan']), ev('helse', 'Verdensdagen for psykisk helse', ['child3', 'child4'], ['plan']), ev('child1', 'Barn En – time i Asker', ['child1'], ['annet'])];
  const pack = { ...task('pack', 'Pakk uteskolematpakke', ['child3'], '2026-10-27', [0]), sourceRefs: ['plan'] };
  pack.task.items[0].text = 'Pakk matpakke og klær til uteskole';
  const explicit = { ...task('exp', 'Ta med gymtøy', ['child1'], '2026-10-27', [0]), sourceRefs: [] };
  explicit.task.forEvent = 'child1';
  const vague = { ...task('vague', 'Husk underskrift', ['child3'], '2026-10-27', [0]), sourceRefs: ['plan'] };
  const unrelated = { ...task('none', 'Svar på invitasjon', ['parent2'], '2026-10-27', [0]), sourceRefs: ['x'] };
  const { attached, loose } = attachTasks(events, [pack, explicit, vague, unrelated]);
  assert.deepEqual(attached.get('ute').map((t) => t.id), ['pack']);
  assert.deepEqual(attached.get('child1').map((t) => t.id), ['exp']);
  assert.deepEqual(loose.map((t) => t.id).sort(), ['none', 'vague'], 'to mulige avtaler uten ordtreff: egen rad i stedet for gjetning');
});

test('task.forEvent lagres, beholdes ved oppdatering og kan fjernes', () => {
  const base = { visibleFrom: '2026-10-25', dueDate: '2026-10-27', items: [{ key: 'a', text: 'Pakk mat' }] };
  const first = mergeTask({ ...base, forEvent: '2026-10-27:pølsegrill' }, null);
  assert.equal(first.forEvent, '2026-10-27:pølsegrill');
  assert.equal(mergeTask(base, first).forEvent, '2026-10-27:pølsegrill');
  assert.equal(mergeTask({ ...base, forEvent: null }, first).forEvent, undefined);
});

test('lekser gjenkjennes på kategori eller tittel', () => {
  assert.equal(isHomework({ title: 'Noe', task: { category: 'homework' } }), true);
  assert.equal(isHomework({ title: 'Uke 42-oppgaver – Barn En', task: {} }), true);
  assert.equal(isHomework({ title: 'Lekser og forberedelser for uke 41 – Barn Tre', task: {} }), true);
  assert.equal(isHomework({ title: 'Svar på bursdagsinvitasjonen fra Even', task: {} }), false);
});

test('dagsbundne oppgaver utløper ved passert frist; andre må gjøres og blir liggende', async () => {
  const { expiresAtDue, isExpired } = await import('../public/home-tasks.mjs');
  const vann = task('vann', 'Ta med vann hjemmefra til skolen', ['child3'], '2026-10-23', [0]);
  const child1 = task('child1', 'Avklar oppfølging for Barn En', ['child1'], '2026-10-14', [0]);
  const pakk = task('pakk', '[Foreløpig] Pakk mat og drikke til pølsegrillingen', ['child3'], '2026-10-24', [0]);
  const tvungen = task('tvungen', 'Husk å levere skjema', ['child3'], '2026-10-20', [0], { expires: false });
  const eksplisitt = task('eksplisitt', 'Kjøp gave', ['parent2'], '2026-10-20', [0], { expires: true });
  assert.deepEqual([vann, child1, pakk, tvungen, eksplisitt].map(expiresAtDue), [true, false, true, false, true]);
  assert.deepEqual(overdueTasks([vann, child1, pakk, tvungen, eksplisitt], '2026-10-25').map((t) => t.id), ['child1', 'tvungen']);
  assert.equal(isExpired(vann, '2026-10-25'), true);
  assert.equal(isExpired(vann, '2026-10-23'), false, 'gjelder hele fristdagen');
  const stored = mergeTask({ visibleFrom: '2026-10-22', dueDate: '2026-10-23', items: [{ key: 'v', text: 'Vann' }], expires: true }, null);
  assert.equal(stored.expires, true);
  assert.equal(mergeTask({ visibleFrom: '2026-10-22', dueDate: '2026-10-23', items: [{ key: 'v', text: 'Vann' }] }, stored).expires, true, 'beholdes ved oppdatering');
});
