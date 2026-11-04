// Hva forsiden skal vise av oppgaver. Ren logikk, testes i test/home-tasks.test.mjs.
// Regel: alt bor på dagen sin. Oppgaver vises på fristdagen sammen med avtalene, forberedelser legges under avtalen de
// gjelder, og passerte uferdige oppgaver løftes opp i «Ikke gjort ennå». Ukelekser har egen kolonne (homeworkCards).
import { cleanTitle } from './event-display.mjs';

const remaining = (event) => event.task.items.filter((item) => !item.doneAt).length;
export const isHomework = (event) => event.task?.category === 'homework' || /\blekse|ukeplan|ukeoppgave|uke\s*\d+\s*[-–]?\s*oppgaver/i.test(event.title ?? '');

// Per barn: åpen lekse med tidligst frist (passerte først), ellers sist fullførte for inneværende periode, ellers ingenting.
// Gjelder bare grupper som er synlige nå; neste ukes plan dukker opp når visibleFrom er nådd.
export function homeworkCards({ tasks, children, today }) {
  return children.map((child) => {
    const mine = tasks.filter((event) => isHomework(event) && event.members?.includes(child.id) && event.task.visibleFrom <= today);
    const open = mine.filter((event) => remaining(event) > 0).sort((a, b) => a.task.dueDate.localeCompare(b.task.dueDate));
    if (open.length) {
      const event = open[0];
      const items = event.task.items;
      return {
        child, event, state: event.task.dueDate < today ? 'overdue' : 'open',
        done: items.length - remaining(event), total: items.length,
        openItems: items.filter((item) => !item.doneAt).map((item) => item.text),
        otherOpen: open.length - 1
      };
    }
    const finished = mine.filter((event) => event.task.dueDate >= today).sort((a, b) => b.task.dueDate.localeCompare(a.task.dueDate))[0];
    if (finished) return { child, event: finished, state: 'done', done: finished.task.items.length, total: finished.task.items.length, openItems: [], otherOpen: 0 };
    return { child, event: null, state: 'none', done: 0, total: 0, openItems: [], otherOpen: 0 };
  });
}

// Oppgaver (ikke lekser) med frist på dagen. Med includeDone blir ferdige stående (overstreket), så en hake ikke får
// raden til å forsvinne under fingeren.
export function tasksDueOn(tasks, day, { includeDone = false } = {}) {
  return tasks.filter((event) => !isHomework(event) && event.task.dueDate === day && (includeDone || remaining(event) > 0));
}

// Noen oppgaver gjelder bare en bestemt dag («Ta med vann til skolen»): når fristen er passert, er det ingen vits lenger.
// Agenten angir det med task.expires. Uten angivelse regnes «Pakk/Ta med/Ha med/Husk …» som dagsbundet; alt annet må gjøres.
export const expiresAtDue = (event) => typeof event.task?.expires === 'boolean' ? event.task.expires : /^(pakk|ta med|ha med|husk)\b/i.test(cleanTitle(event.title ?? ''));
export const isExpired = (event, today) => Boolean(event.task) && !isHomework(event) && event.task.dueDate < today && expiresAtDue(event);

// Passerte, uferdige oppgaver som fortsatt må gjøres: det som aldri skal kunne overses.
export function overdueTasks(tasks, today) {
  return tasks.filter((event) => !isHomework(event) && remaining(event) > 0 && event.task.dueDate < today && !expiresAtDue(event))
    .sort((a, b) => a.task.dueDate.localeCompare(b.task.dueDate));
}

const words = (text) => new Set(cleanTitle(text ?? '').toLocaleLowerCase('nb-NO').match(/[\p{L}\d]{4,}/gu) ?? []);
const shares = (a, b) => !a?.length || !b?.length || a.some((member) => b.includes(member));

// Knytter forberedelser til avtalen de gjelder (samme dag). Eksplisitt task.forEvent (avtalens canonicalKey) vinner.
// Ellers: samme kildeinnlegg og felles person, og blant flere kandidater den med flest felles ord i tittel/punkter.
// Uklare tilfeller blir egne rader i stedet for å havne under feil avtale.
export function attachTasks(events, tasks) {
  const attached = new Map(), loose = [];
  for (const task of tasks) {
    let target = task.task.forEvent ? events.find((event) => event.canonicalKey === task.task.forEvent) : null;
    if (!target) {
      const candidates = events.filter((event) => (event.sourceRefs ?? []).some((ref) => (task.sourceRefs ?? []).includes(ref)) && shares(event.members, task.members));
      const taskWords = words([task.title, ...task.task.items.map((item) => item.text)].join(' '));
      const scored = candidates.map((event) => ({ event, score: [...words(event.title)].filter((word) => taskWords.has(word)).length })).sort((a, b) => b.score - a.score);
      if (scored[0]?.score > 0 && scored[0].score > (scored[1]?.score ?? 0)) target = scored[0].event;
      else if (candidates.length === 1) target = candidates[0];
    }
    if (target) { if (!attached.has(target.id)) attached.set(target.id, []); attached.get(target.id).push(task); }
    else loose.push(task);
  }
  return { attached, loose };
}
