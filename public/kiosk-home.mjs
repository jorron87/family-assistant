import { dtf } from "./dtf.mjs";
// Stue-modus: forsiden på kiosken (Nå · I dag/I morgen · Lekser · Ikke gjort ennå/Kommende) og nattvisning. Ingen scrollbarer på forsiden.
import { cleanTitle, isFollowUp, isNight, isWaste, minutesOfClock, noteFor, packingItems, timeLabel, wasteFractions } from './event-display.mjs';
import { isDarkOutside } from './sun.mjs';
import { homeworkCards, tasksDueOn, overdueTasks, attachTasks, isHomework } from './home-tasks.mjs';
import { createWeatherFeed, renderWeather } from './weather-widget.mjs';

const params = new URLSearchParams(location.search);
// ?at=22:45 fremskynder/forsinker visningsklokken for testing av tema og nattvisning.
const atParam = /^\d{1,2}:\d{2}$/.test(params.get('at') ?? '') ? params.get('at') : null;
const clockOffset = (() => {
  if (!atParam) return 0;
  const [h, m] = atParam.split(':').map(Number);
  const now = new Date();
  const target = new Date(now);
  const oslo = dtf('en-GB', { timeZone: 'Europe/Oslo', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(now).split(':').map(Number);
  target.setTime(now.getTime() + ((h * 60 + m) - (oslo[0] * 60 + oslo[1])) * 60000);
  return target.getTime() - now.getTime();
})();
export const displayNow = () => Date.now() + clockOffset;
const osloClock = (ms = displayNow()) => dtf('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const osloDate = (ms = displayNow()) => dtf('nb-NO', { timeZone: 'Europe/Oslo', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(ms));

const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };

let current = null;         // referanser til elementer som oppdateres uten full tegning
let weatherData = null;
let homeData = null;
let awake = false;
let lastRefresh = null;
let onWake = () => {};

// Røyken (fallback til MET-posisjonen fra /api/weather).
const HOME = { lat: 59.7372, lon: 10.4039 };
// Nattvisning (bare klokka): fast leggetid 21:30–06:30.
export function night() { return isNight(minutesOfClock(osloClock())); }
// Mørkt tema: følger solnedgang/soloppgang, og alltid mørkt i nattvisningen.
export function darkTheme() {
  const place = weatherData?.location ?? HOME;
  return night() || isDarkOutside(displayNow(), place.lat, place.lon);
}

function haTemperature() {
  const sensor = homeData?.entities?.find((entity) => entity.group === 'weather');
  const value = Number(sensor?.state);
  return sensor?.available && Number.isFinite(value) ? value : null;
}

function renderPresence(holder) {
  holder.replaceChildren();
  const people = (homeData?.entities ?? []).filter((entity) => entity.group === 'presence');
  if (!people.length || homeData?.status === 'not_configured') return;
  for (const person of people) {
    const chip = el('span', undefined, `k-person${person.state === 'home' ? ' is-home' : ''}`);
    chip.append(el('i'), el('strong', person.name), el('small', person.state === 'home' ? 'Hjemme' : person.state === 'not_home' ? 'Borte' : ''));
    holder.append(chip);
  }
  if (homeData.stale) holder.append(el('small', 'Sist kjente status', 'k-dim'));
}

function renderWeatherInto(holder, compact = false) {
  holder.replaceChildren(renderWeather(weatherData, { temperature: haTemperature(), compact, showAlert: false }));
}

export function setHome(data) {
  homeData = data;
  if (!current) return;
  renderPresence(current.presence);
  renderWeatherInto(current.weather);
  renderWeatherInto(current.nightWeather, true);
  fitNow();
}

export function setLastRefresh(iso) { lastRefresh = iso; }

export function wake() { awake = true; current?.root.classList.remove('k-home--night'); fitAll(); }
export function sleep() { awake = false; if (current) tick(); }

const startDayOf = (ctx) => (event) => ctx.eventStartDay(event);

function row(ctx, event, day, { large = false } = {}) {
  const button = el('button', undefined, `k-row${large ? ' k-row--large' : ''}${event.cancelled ? ' is-cancelled' : ''}`);
  button.type = 'button';
  const label = timeLabel(event, day, { clockOf: (value) => osloClock(Date.parse(value)), startDayOf: startDayOf(ctx) });
  button.append(el('span', label, `k-time${label === 'Følg opp' || label === 'Hele dagen' ? ' k-time--soft' : ''}`));
  const main = el('span', undefined, 'k-main');
  const line = el('span', undefined, 'k-title-line');
  line.append(ctx.dots(event.members), el('strong', cleanTitle(event.title)));
  if (event.cancelled) line.append(el('em', 'Avlyst', 'k-badge k-badge--cancel'));
  else if (event.provisional && !isFollowUp(event)) line.append(el('em', 'ikke bekreftet', 'k-badge'));
  main.append(line);
  const note = noteFor(event);
  if (note) main.append(el('span', note, 'k-note'));
  button.append(main);
  button.onclick = () => ctx.openEvent(event, day);
  button.setAttribute('aria-label', `Vis ${cleanTitle(event.title)}`);
  return button;
}

// ---- Én samlet dag: avtaler og oppgaver med frist på dagen, forberedelser under avtalen de gjelder ----

// Avkrysningsring: reagerer med en gang (hake og fest), lagrer i bakgrunnen og ruller tilbake ved feil.
function ring(ctx, event, item, pulse) {
  const button = el('button', undefined, `k-ring${item.doneAt ? ' is-checked' : ''}`);
  button.type = 'button';
  button.setAttribute('aria-label', `${item.doneAt ? 'Fjern haken' : 'Kryss av'}: ${item.text}`);
  button.onclick = async (click) => {
    click.stopPropagation();
    const done = !button.classList.contains('is-checked');
    button.classList.toggle('is-checked', done);
    pulse?.classList.toggle('is-done', done);
    button.disabled = true;
    try { await ctx.toggleTask(event, item, done, { anchor: button, pulse }); }
    catch (error) {
      button.classList.toggle('is-checked', !done);
      pulse?.classList.toggle('is-done', !done);
      alert(`Kunne ikke lagre avkryssingen: ${error.message}`);
    } finally { button.disabled = false; }
  };
  return button;
}

function checkChip(ctx, event, item) {
  const chip = el('span', undefined, `k-check${item.doneAt ? ' is-done' : ''}`);
  chip.append(ring(ctx, event, item, chip), el('span', item.text, 'k-check-text'));
  return chip;
}

const MAX_CHIPS = 4;
function checks(ctx, task, cls = 'k-checks') {
  const box = el('div', undefined, cls);
  const items = task.task.items;
  const open = items.filter((item) => !item.doneAt);
  // Viser åpne punkter først; ferdige blir stående overstreket så lenge det er plass.
  for (const item of [...open, ...items.filter((item) => item.doneAt)].slice(0, MAX_CHIPS)) box.append(checkChip(ctx, task, item));
  if (items.length > MAX_CHIPS) box.append(el('span', `+${items.length - MAX_CHIPS}`, 'k-check-more'));
  return box;
}

// En oppgave som egen rad. Ett punkt: ringen står der klokkeslettet ellers står. Flere punkter: telling og ringer per punkt.
function taskRow(ctx, task, day, { due = null } = {}) {
  const items = task.task.items;
  const open = items.filter((item) => !item.doneAt).length;
  const single = items.length === 1;
  const wrap = el('div', undefined, `k-item k-task-row is-task${open ? '' : ' is-done'}`);
  const lead = el('span', undefined, 'k-lead');
  const main = el('button', undefined, 'k-task-main');
  main.type = 'button';
  const line = el('span', undefined, 'k-title-line');
  line.append(ctx.dots(task.members), el('strong', cleanTitle(task.title)));
  main.append(line);
  if (due) main.append(el('span', due, 'k-task-due'));
  main.onclick = () => ctx.openEvent(task, day);
  if (single) lead.append(ring(ctx, task, items[0], wrap));
  else lead.append(el('span', `${items.length - open}/${items.length}`, 'k-count'));
  wrap.append(lead, main);
  if (!single) wrap.append(checks(ctx, task));
  return wrap;
}

// Avtalen med sine forberedelser («Husk») rett under.
function entry(ctx, event, day, tasks) {
  const button = row(ctx, event, day);
  if (!tasks?.length) { button.classList.add('k-item'); return button; }
  const wrap = el('div', undefined, 'k-item k-entry is-task');
  const husk = el('div', undefined, 'k-checks k-husk');
  husk.append(el('span', 'Husk', 'k-husk-label'));
  for (const task of tasks) for (const chip of checks(ctx, task).children) husk.append(chip);
  wrap.append(button, husk);
  return wrap;
}

function dayItems(ctx, day, events, tasks, { includeDone }) {
  const rows = ctx.eventsOnDay(events, day).sort((a, b) => Number(isFollowUp(a)) - Number(isFollowUp(b)));
  const { attached, loose } = attachTasks(rows, tasksDueOn(tasks, day, { includeDone }));
  return [...rows.map((event) => entry(ctx, event, day, attached.get(event.id))), ...loose.map((task) => taskRow(ctx, task, day))];
}

function dayPanel(ctx, title, day, events, cls, tasks) {
  const panel = el('section', undefined, `k-day ${cls}`);
  const head = el('header', undefined, 'k-head');
  head.append(el('h2', title), el('span', ctx.displayDay(day, { weekday: 'long', day: 'numeric', month: 'long' }), 'k-sub'));
  const list = el('div', undefined, 'k-list');
  const items = dayItems(ctx, day, events, tasks, { includeDone: true });
  if (!items.length) list.append(el('p', `Ingenting ${title === 'I dag' ? 'i dag' : 'i morgen'}`, 'k-empty'));
  const group = el('div', undefined, 'k-group');
  for (const item of items) group.append(item);
  list.append(group);
  panel.append(head, list);
  return panel;
}

function laterPanel(ctx, events, tasks, fromDay, toDay) {
  const panel = el('section', undefined, 'k-later');
  const head = el('header', undefined, 'k-head');
  head.append(el('h2', 'Kommende'), el('span', 'Neste dager', 'k-sub'));
  const list = el('div', undefined, 'k-list');
  const days = new Set([
    ...events.map((event) => ctx.eventStartDay(event)),
    ...tasks.filter((task) => !isHomework(task)).map((task) => task.task.dueDate)
  ].filter((day) => day >= fromDay && day <= toDay));
  if (!days.size) list.append(el('p', 'Ingenting planlagt de nærmeste dagene', 'k-empty'));
  for (const day of [...days].sort()) {
    const starting = events.filter((event) => ctx.eventStartDay(event) === day);
    const items = dayItems(ctx, day, starting, tasks, { includeDone: false });
    if (!items.length) continue;
    const group = el('div', undefined, 'k-group');
    group.append(el('h3', ctx.displayDay(day, { weekday: 'long', day: 'numeric', month: 'short' }), 'k-day-label'));
    for (const item of items) group.append(item);
    list.append(group);
  }
  panel.append(head, list);
  return panel;
}

// «Ikke gjort ennå»: passerte, uferdige oppgaver øverst i høyre kolonne. Vises bare når det finnes noen.
const OVERDUE_ROWS = 4;
function overduePanel(ctx) {
  const today = ctx.osloDay();
  const tasks = overdueTasks(ctx.allTasks(), today);
  if (!tasks.length) return null;
  const box = el('section', undefined, 'k-overdue');
  const head = el('header', undefined, 'k-head');
  head.append(el('h2', 'Ikke gjort ennå'), el('span', tasks.length === 1 ? 'Fristen er passert' : `${tasks.length} med passert frist`, 'k-sub'));
  const list = el('div', undefined, 'k-overdue-list');
  for (const task of tasks.slice(0, OVERDUE_ROWS)) list.append(taskRow(ctx, task, today, { due: `frist ${dueLabel(ctx, task.task.dueDate, today)}` }));
  box.append(head, list);
  if (tasks.length > OVERDUE_ROWS) { const more = el('button', `+${tasks.length - OVERDUE_ROWS} til · Alle oppgaver →`, 'k-link'); more.type = 'button'; more.onclick = () => ctx.setTab('tasks'); box.append(more); }
  return box;
}

function dueLabel(ctx, day, today) {
  if (day < today) return `passert ${ctx.displayDay(day, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  if (day === today) return 'i dag';
  if (day === ctx.addDays(today, 1)) return 'i morgen';
  return ctx.displayDay(day, { weekday: 'short', day: 'numeric', month: 'short' });
}

// Lekser: alltid synlig på forsiden, ett kort per barn med de åpne leksene skrevet ut.
function todoPanel(ctx, cards) {
  const today = ctx.osloDay();
  const panel = el('section', undefined, 'k-todo');
  if (cards.length) {
    const head = el('header', undefined, 'k-head');
    head.append(el('h2', 'Lekser'));
    const week = cards.find((card) => card.event)?.event;
    if (week) head.append(el('span', `til ${ctx.displayDay(week.task.dueDate, { weekday: 'long', day: 'numeric', month: 'short' })}`, 'k-sub'));
    const list = el('div', undefined, 'k-hw-list');
    for (const card of cards) list.append(homeworkCard(ctx, card, today));
    panel.append(head, list);
  }
  return panel;
}

function homeworkCard(ctx, card, today) {
  const button = el('button', undefined, `k-hw is-${card.state}`);
  button.type = 'button';
  const head = el('span', undefined, 'k-hw-head');
  head.append(ctx.dots([card.child.id]), el('strong', card.child.name));
  if (card.state === 'none') {
    head.append(el('span', 'Ingen lekser registrert', 'k-hw-status'));
    button.append(head);
    button.disabled = true;
    return button;
  }
  if (card.state === 'done') {
    head.append(el('span', 'Alt gjort ✓', 'k-hw-status'));
    button.append(head);
  } else {
    head.append(el('span', dueLabel(ctx, card.event.task.dueDate, today), 'k-hw-due'), el('span', `${card.done}/${card.total}`, 'k-hw-count'));
    const bar = el('span', undefined, 'k-progress'); const fill = el('i'); fill.style.width = `${card.total ? Math.round(card.done / card.total * 100) : 0}%`; bar.append(fill);
    const items = el('ul', undefined, 'k-hw-items');
    for (const text of card.openItems) items.append(el('li', text));
    button.append(head, bar, items, el('span', '', 'k-hw-more'));
  }
  button.onclick = () => ctx.openEvent(card.event);
  button.setAttribute('aria-label', `Lekser for ${card.child.name}`);
  return button;
}

// Forsiden kutter ikke først: radene trykkes sammen i trinn (uten undertekst, så mindre skrift). «+N til» er siste utvei.
const DENSITY = ['', 'is-dense', 'is-tight'];
function overflowing(column) { return [...column.querySelectorAll('.k-list')].some((list) => list.scrollHeight > list.clientHeight + 1) || column.scrollHeight > column.clientHeight + 1; }
function compact(column) {
  if (!column) return;
  column.classList.remove(...DENSITY.filter(Boolean));
  for (const level of DENSITY) {
    if (level) column.classList.add(level);
    if (!overflowing(column)) return;
  }
}

// Leksekortene viser så mange åpne lekser som får plass; kort med flest punkter kortes ned først.
function fitTodo(column) {
  if (!column || !column.clientHeight) return;
  const cards = [...column.querySelectorAll('.k-hw')];
  const most = Math.max(0, ...cards.map((card) => card.querySelectorAll('.k-hw-items li').length));
  const show = (limit) => {
    for (const card of cards) {
      const items = [...card.querySelectorAll('.k-hw-items li')];
      items.forEach((item, index) => { item.hidden = index >= limit; });
      const more = card.querySelector('.k-hw-more');
      if (more) { const rest = items.length - Math.min(limit, items.length); more.textContent = rest ? `+${rest} til` : ''; }
    }
  };
  // Først hele teksten over to linjer, så én linje per lekse, og til slutt færre punkter per kort.
  column.classList.remove('is-dense');
  let limit = most;
  show(limit);
  if (column.scrollHeight > column.clientHeight + 1) column.classList.add('is-dense');
  while (limit > 1 && column.scrollHeight > column.clientHeight + 1) show(--limit);
}

function wastePanel(ctx, wasteEvents) {
  const today = ctx.osloDay();
  const next = wasteEvents.filter((event) => !event.cancelled && ctx.eventStartDay(event) >= today).sort((a, b) => ctx.eventStartDay(a).localeCompare(ctx.eventStartDay(b)))[0];
  if (!next) return null;
  const day = ctx.eventStartDay(next);
  const box = el('button', undefined, 'k-waste');
  box.type = 'button';
  const distance = day === today ? 'I dag' : day === ctx.addDays(today, 1) ? 'I morgen' : ctx.displayDay(day, { weekday: 'long', day: 'numeric', month: 'short' });
  const urgent = day === today || day === ctx.addDays(today, 1);
  box.classList.toggle('is-urgent', urgent);
  box.append(el('span', urgent ? `Søppel ${distance.toLowerCase()}${day === ctx.addDays(today, 1) ? ' – sett frem i kveld' : ''}` : `Neste søppeltømming · ${distance}`, 'k-waste-title'));
  const chips = el('span', undefined, 'k-fractions');
  for (const fraction of wasteFractions(next)) { const chip = el('span', undefined, 'k-fraction'); const dot = el('i'); dot.style.background = fraction.color; chip.append(dot, fraction.label); chips.append(chip); }
  box.append(chips);
  box.onclick = () => ctx.openEvent(next, day);
  return box;
}

function nightPanel(ctx, appointments) {
  const panel = el('section', undefined, 'k-night');
  const evening = minutesOfClock(osloClock()) >= 12 * 60;
  const day = evening ? ctx.addDays(ctx.osloDay(), 1) : ctx.osloDay();
  const inner = el('div', undefined, 'k-night-inner');
  const clock = el('div', undefined, 'k-night-clock');
  const time = el('strong', osloClock()); const date = el('span', osloDate());
  clock.append(time, date);
  const weather = el('div', undefined, 'k-night-weather');
  renderWeatherInto(weather, true);
  // Følg opp-påminnelser er ekte gjøremål og skal ikke skjules; de sorteres bare etter avtalene.
  const events = ctx.eventsOnDay(appointments, day).sort((x, y) => Number(isFollowUp(x)) - Number(isFollowUp(y)));
  const tasks = ctx.upcomingTasks().sort((x, y) => x.task.dueDate.localeCompare(y.task.dueDate));
  const list = el('div', undefined, 'k-night-list');
  list.append(el('h2', evening ? 'I morgen' : 'I dag'));
  if (!events.length) list.append(el('p', tasks.length ? 'Ingen avtaler' : 'Ingenting planlagt', 'k-empty'));
  for (const event of events.slice(0, 4)) list.append(row(ctx, event, day, { large: true }));
  if (events.length > 4) list.append(el('p', `+${events.length - 4} til`, 'k-more'));
  const dueTasks = tasksDueOn(ctx.allTasks(), day).flatMap((task) => task.task.items.filter((item) => !item.doneAt).map((item) => item.text));
  const pack = [...packingItems(events, 3), ...dueTasks].slice(0, 5);
  if (pack.length) list.append(el('p', `Husk: ${pack.join(' · ')}`, 'k-night-pack'));
  if (tasks.length) {
    const next = tasks[0];
    list.append(el('p', `${tasks.length} åpne oppgavegrupper · neste frist ${ctx.displayDay(next.task.dueDate, { weekday: 'short', day: 'numeric', month: 'short' })}`, 'k-night-tasks'));
  }
  inner.append(clock, weather, list);
  panel.append(inner);
  panel.onpointerdown = () => { wake(); onWake(); };
  return { panel, time, date, weather };
}

export function fitAll() {
  if (!current) return;
  for (const column of current.root.querySelectorAll('.k-days, .k-right')) { reset(column); compact(column); }
  for (const list of current.root.querySelectorAll('.k-list')) fit(list);
  fitTodo(current.root.querySelector('.k-todo'));
  fitNow();
}
function reset(column) {
  column.querySelectorAll('.k-more').forEach((node) => node.remove());
  for (const hidden of column.querySelectorAll('.k-item[hidden], .k-group[hidden]')) hidden.hidden = false;
}

// «Nå»-sonen skal aldri klippes: mindre viktige deler skjules når høyden ikke rekker (f.eks. med to varselbånd).
function fitNow() {
  const now = current.root.querySelector('.k-now');
  const optional = [now.querySelector('.k-nearby'), now.querySelector('.w-strip'), now.querySelector('.k-presence')].filter(Boolean);
  for (const part of optional) part.hidden = false;
  if (!now.clientHeight) return;
  for (const part of optional) {
    if (now.scrollHeight <= now.clientHeight + 1) break;
    part.hidden = true;
  }
}

// Kutter fra bunnen til innholdet får plass, og viser «+N til». Tegner aldri scrollbar på forsiden.
function fit(list) {
  list.querySelectorAll('.k-more').forEach((node) => node.remove());
  for (const hidden of list.querySelectorAll('[hidden]')) hidden.hidden = false;
  const over = () => list.scrollHeight > list.clientHeight + 1;
  if (!list.clientHeight || !over()) return;
  const more = el('div', '', 'k-more');
  list.append(more);
  const items = [...list.querySelectorAll('.k-item')];
  // Listene er kronologiske: kutt nedenfra, så det nærmeste (også oppgaver med frist snart) alltid står igjen.
  const order = [...items].reverse();
  let hidden = 0;
  for (const item of order) {
    if (!over()) break;
    item.hidden = true; hidden++;
    more.textContent = `+${hidden} til`;
    const group = item.closest('.k-group');
    if (group && ![...group.querySelectorAll('.k-item')].some((entry) => !entry.hidden) && group.querySelector('.k-day-label')) group.hidden = true;
  }
  if (!hidden) more.remove();
}

export function render(ctx) {
  const today = ctx.osloDay();
  const appointments = ctx.events.filter((event) => !event.task && !isWaste(event));
  const wasteEvents = ctx.events.filter(isWaste);
  onWake = () => {};
  const root = el('div', undefined, 'k-home');

  const now = el('section', undefined, 'k-now');
  const clock = el('div', undefined, 'k-clock');
  const time = el('strong', osloClock());
  const date = el('span', osloDate());
  clock.append(time, date);
  const weather = el('div', undefined, 'k-weather');
  renderWeatherInto(weather);
  const presence = el('div', undefined, 'k-presence');
  renderPresence(presence);
  const stale = el('p', '', 'k-stale');
  now.append(clock, weather);
  const waste = wastePanel(ctx, wasteEvents);
  if (waste) now.append(waste);
  now.append(presence);
  if(ctx.clarificationsSummary)now.append(ctx.clarificationsSummary);
  const suggestions = ctx.activityChoices(true).slice(0, 2);
  if (suggestions.length) {
    const nearby = el('button', undefined, 'k-nearby'); nearby.type = 'button';
    nearby.append(el('strong', 'Hva skjer rundt oss? →'), el('span', suggestions.map((item) => item.title).join(' · ')));
    nearby.onclick = () => ctx.setTab('nearby');
    now.append(nearby);
  }
  now.append(stale);

  const days = el('div', undefined, 'k-days');
  const tasks = ctx.allTasks();
  days.append(dayPanel(ctx, 'I dag', today, appointments, 'k-today', tasks), dayPanel(ctx, 'I morgen', ctx.addDays(today, 1), appointments, 'k-tomorrow', tasks));

  const cards = homeworkCards({ tasks, children: ctx.children(), today });
  const todo = todoPanel(ctx, cards);
  const later = el('div', undefined, 'k-right');
  const overdue = overduePanel(ctx);
  if (overdue) later.append(overdue);
  later.append(laterPanel(ctx, appointments, tasks, ctx.addDays(today, 2), ctx.addDays(today, 30)));

  const nightBits = nightPanel(ctx, appointments);
  root.append(now, days, todo, later, nightBits.panel);
  onWake = () => {};
  resizeObserver?.observe(root);
  current = { root, time, date, presence, weather, stale, nightWeather: nightBits.weather, nightTime: nightBits.time, nightDate: nightBits.date, nightPanel: nightBits.panel };
  tick();
  return root;
}

let shiftMinute = -1;
let resizeObserver = null;
export function tick() {
  const isNightNow = night();
  document.body.dataset.theme = darkTheme() ? 'night' : 'day';
  if (!isNightNow) awake = false;
  if (!current) return;
  const clock = osloClock(), date = osloDate();
  current.time.textContent = clock; current.date.textContent = date;
  current.nightTime.textContent = clock; current.nightDate.textContent = date;
  const simple = isNightNow && !awake;
  const changed = current.root.classList.contains('k-home--night') !== simple;
  current.root.classList.toggle('k-home--night', simple);
  // Mot innbrenning: nattvisningen flyttes noen få piksler hvert 10. minutt.
  const minute = Math.floor(Date.now() / 600000);
  if (minute !== shiftMinute) {
    shiftMinute = minute;
    const step = minute % 5;
    current.nightPanel.style.setProperty('--shift-x', `${(step - 2) * 6}px`);
    current.nightPanel.style.setProperty('--shift-y', `${((step * 3) % 5 - 2) * 5}px`);
  }
  const age = lastRefresh ? Date.now() - Date.parse(lastRefresh) : 0;
  current.stale.textContent = age > 2 * 60000 ? `Ingen kontakt med PC-en · sist oppdatert ${osloClock(Date.parse(lastRefresh))}` : '';
  current.stale.classList.toggle('is-disconnected',age > 2 * 60000);
  if (changed && !simple) fitAll();
}

let feed = null;
export function start({ onWeather } = {}) {
  if (feed) return;
  feed = createWeatherFeed({ onData: (data) => { weatherData = data; if (current) { renderWeatherInto(current.weather); renderWeatherInto(current.nightWeather, true); fitNow(); } onWeather?.(data); } });
  // Følg selve forsideflaten (varselbånd og vindusendringer endrer den uten at body endres), og tilpass på nytt hvert minutt.
  resizeObserver = new ResizeObserver(() => fitAll());
  resizeObserver.observe(document.body);
  if (current) resizeObserver.observe(current.root);
  window.addEventListener('resize', () => fitAll());
  setInterval(() => { if (current && !current.root.classList.contains('k-home--night')) fitAll(); }, 60000);
}
