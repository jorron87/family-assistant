import { dtf } from "./dtf.mjs";
export const TIME_ZONE = "Europe/Oslo";

export function osloDay(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = dtf("en-GB", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addDays(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function mondayOf(day) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -(weekday === 0 ? 6 : weekday - 1));
}

export function weekDays(day) {
  const monday = mondayOf(day);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function monthDays(day) {
  const first = `${day.slice(0, 7)}-01`;
  const [year, month] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0, 12)).toISOString().slice(0, 10);
  const beginning = mondayOf(first);
  const end = addDays(mondayOf(last), 6);
  const count = Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${beginning}T12:00:00Z`)) / 86400000) + 1;
  return Array.from({ length: count }, (_, index) => addDays(beginning, index));
}

export function shiftMonth(day, amount) {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + amount, 1, 12)).toISOString().slice(0, 10);
}

export function eventStartDay(event) {
  if (!event.start) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(event.start) ? event.start : osloDay(event.start);
}

export function eventLastDay(event) {
  const first = eventStartDay(event);
  if (!first || !event.end) return first;
  if (event.allDay && /^\d{4}-\d{2}-\d{2}$/.test(event.end)) {
    return addDays(event.end, -1) < first ? first : addDays(event.end, -1);
  }
  const end = Date.parse(event.end);
  const start = Date.parse(event.start);
  return Number.isFinite(end) && end > start ? osloDay(new Date(end - 1)) : first;
}

export function eventsOnDay(events, day) {
  return events.filter((event) => {
    if (event.task) return !event.cancelled && event.task.items.some(item=>!item.doneAt) && event.task.visibleFrom <= day && day <= (event.task.dueDate > osloDay() ? event.task.dueDate : osloDay());
    const first = eventStartDay(event);
    const last = eventLastDay(event);
    return first && first <= day && day <= last;
  }).sort((a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title, "nb-NO"));
}
