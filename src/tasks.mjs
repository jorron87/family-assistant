import { createHash } from "node:crypto";
const day = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
export function mergeTask(input, previous) {
  if (!input) return previous ?? null;
  if (!day(input.visibleFrom) || !day(input.dueDate) || input.dueDate < input.visibleFrom || !Array.isArray(input.items) || !input.items.length) throw new Error("Oppgave krever gyldig visibleFrom, dueDate og deloppgaver.");
  const keys = new Set();
  const items = input.items.map(item => {
    const text = String(item.text ?? "").trim();
    const key = String(item.key ?? createHash("sha256").update(text.toLocaleLowerCase("nb-NO")).digest("hex").slice(0,24));
    if (!text || text.length > 1000 || !/^[a-zA-Z0-9:_-]{1,100}$/.test(key) || keys.has(key)) throw new Error("Deloppgaver krever tekst og unike stabile nøkler.");
    keys.add(key);
    const old = previous?.items.find(entry=>entry.key===key);
    // A material text change needs a fresh check even when its stable key is retained.
    return {key,text,doneAt:old?.text === text ? old.doneAt : null};
  });
  const history = [...(previous?.history ?? [])];
  for (const old of previous?.items ?? []) if (!items.some(item=>item.key===old.key && item.text===old.text)) history.push({...old,removedAt:new Date().toISOString()});
  const category = input.category ?? previous?.category;
  if (category != null && category !== 'homework') throw new Error('Ukjent oppgavekategori.');
  // Valgfri kobling fra en forberedelse (matpakke, utstyr) til avtalen den gjelder, med avtalens canonicalKey.
  const forEvent = input.forEvent === undefined ? previous?.forEvent : (input.forEvent ? String(input.forEvent).slice(0, 300) : null);
  // expires:true = gjelder bare fram til fristen (ta med vann en bestemt dag); expires:false = må gjøres selv om fristen er passert.
  const expires = typeof input.expires === 'boolean' ? input.expires : previous?.expires;
  return {visibleFrom:input.visibleFrom,dueDate:input.dueDate,items,history,...(category ? {category} : {}),...(forEvent ? {forEvent} : {}),...(typeof expires === 'boolean' ? {expires} : {})};
}
