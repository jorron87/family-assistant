// One-time bridge from a tool sandbox's local encrypted archive to the
// durable Windows Scheduled Task service. All writes use the service API.
import { createStore } from "../src/store.mjs";

const base = "http://127.0.0.1:4318";
const local = createStore();
const state = local.snapshot();
async function request(path, method, body, headers = {}) {
  const response = await fetch(`${base}${path}`, { method, headers, body });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: ${result.error ?? response.status}`);
  return result;
}
const post = (path, value) => request(path, "POST", JSON.stringify(value), { "Content-Type":"application/json" });
const target = await request("/api/state", "GET");
if (Object.keys(target.rawItems).length) throw new Error("Måltjenesten har allerede rådata; avbryter engangsmigrering.");
let rawCount = 0, attachmentCount = 0, eventCount = 0;
for (const raw of Object.values(state.rawItems)) {
  const findings = Object.values(state.events).filter((event) => event.sourceRefs.includes(raw.id)).map((event) => ({
    canonicalKey:event.canonicalKey, title:event.title, kind:event.kind, start:event.start, end:event.end,
    allDay:event.allDay, provisional:event.provisional, members:event.members,
    checklist:event.checklist, details:event.details, reason:event.reason
  }));
  const imported = await post("/api/raw", {
    source:raw.source, externalId:raw.externalId, title:raw.title, body:raw.body,
    sourceUrl:raw.sourceUrl, groupName:raw.groupName, publishedAt:raw.publishedAt,
    memberIds:raw.memberIds, findings
  });
  if (imported.item.id !== raw.id) throw new Error("Rå-ID endret under migrering.");
  rawCount++;
  for (const attachment of raw.attachments) {
    const { bytes } = local.getAttachment(raw.id, attachment.id);
    const moved = await request(`/api/raw/${raw.id}/attachments`, "POST", bytes, {
      "Content-Type":attachment.mimeType, "X-File-Name":encodeURIComponent(attachment.fileName)
    });
    attachmentCount++;
    if (attachment.driveUrl) await post(`/api/raw/${raw.id}/drive`, { attachmentId:moved.id, url:attachment.driveUrl });
  }
  if (raw.driveUrl) await post(`/api/raw/${raw.id}/drive`, { url:raw.driveUrl });
}
const importedState = await request("/api/state", "GET");
for (const event of Object.values(state.events)) {
  const moved = importedState.events[event.id];
  if (!moved) throw new Error(`Hendelse mangler etter migrering: ${event.id}`);
  eventCount++;
  if (event.calendar) await post(`/api/events/${event.id}/calendar`, { ...event.calendar, fingerprint:moved.fingerprint });
}
console.log(JSON.stringify({ rawCount, attachmentCount, eventCount }));
