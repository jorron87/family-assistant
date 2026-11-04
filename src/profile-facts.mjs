import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const categories = new Set(["preference", "hobby", "role", "routine", "school", "relationship", "other"]);
export function normalizeProfile(profile) {
  for (const member of profile.members) if (member.schoolClass && !member.schoolClassValidTo) member.schoolClassValidTo = "2027-08-01";
  profile.facts = profile.facts.map((fact) => ({
    ...fact, id: fact.id ?? hash(`${fact.memberId}\0${fact.key ?? fact.text}\0${fact.text}`),
    key: fact.key ?? `legacy:${hash(fact.text)}`, category: fact.category ?? "other",
    confidence: fact.confidence ?? "confirmed", status: fact.status ?? "active", evidence: fact.evidence ?? []
  }));
  return profile;
}

export function validateFact(profile, input, raw) {
  if (input.memberId !== "family" && !profile.members.some((member) => member.id === input.memberId)) throw new Error("Ukjent familiemedlem i profilfaktum.");
  if (!input.key || input.key.length > 200 || !input.text?.trim() || input.text.length > 2000) throw new Error("Profilfaktum krever stabil key og text.");
  if (!categories.has(input.category) || !["confirmed", "inferred"].includes(input.confidence)) throw new Error("Ugyldig kategori eller sikkerhet for profilfaktum.");
  if (!raw && input.source !== "manual") throw new Error("Lært profilfaktum krever kildeelement.");
  if (raw && (!input.quote?.trim() || !raw.body.includes(input.quote.trim()))) throw new Error("Profilfaktum krever et ordrett quote som finnes i kildeteksten.");
  for (const field of ["validFrom", "validTo"]) if (input[field] && !Number.isFinite(Date.parse(input[field]))) throw new Error(`Ugyldig ${field} i profilfaktum.`);
  if (input.validFrom && input.validTo && Date.parse(input.validTo) <= Date.parse(input.validFrom)) throw new Error("Profilfaktums validTo må være etter validFrom.");
}

export function learnFact(profile, input, raw, at = new Date().toISOString()) {
  validateFact(profile, input, raw);
  const id = hash(`${input.memberId}\0${input.key}\0${input.text.trim()}`);
  const prior = profile.facts.find((fact) => fact.id === id);
  if (raw && prior?.source === "manual" && prior.status === "active") {
    const evidence = {rawId:raw.id,revision:raw.revision,quote:input.quote.trim(),observedAt:at};
    if (!prior.evidence.some(e=>e.rawId===raw.id&&e.revision===raw.revision&&e.quote===evidence.quote)) prior.evidence.push(evidence);
    return prior;
  }
  const current = profile.facts.filter((fact) => fact.memberId === input.memberId && fact.key === input.key && fact.status === "active" && fact.id !== id);
  const evidence = raw ? { rawId: raw.id, revision: raw.revision, quote: input.quote.trim(), observedAt: at } : { source: "manual", observedAt: at };
  const familyDecision = raw && profile.facts.some(f => f.memberId === input.memberId && f.key === input.key && (f.familyRemovedAt || (f.status === "active" && f.source === "manual")));
  const correctsPrevious = input.correctsPrevious && !familyDecision;
  const conflict = (current.length && !correctsPrevious) || familyDecision;
  if (correctsPrevious && input.confidence === "confirmed") for (const fact of current) { fact.status = "superseded"; fact.supersededBy = id; }
  const fact = {
    ...(prior ?? {}), id, memberId: input.memberId, key: input.key, text: input.text.trim(), category: input.category,
    confidence: prior?.confidence === "confirmed" ? "confirmed" : input.confidence,
    status: prior?.status === "active" && prior?.confidence === "confirmed" ? "active" : conflict || input.confidence === "inferred" ? "candidate" : "active",
    source: prior?.source === "manual" && prior.status === "active" ? "manual" : raw?.source ?? "manual", validFrom: input.validFrom ?? prior?.validFrom ?? null,
    validTo: input.validTo ?? prior?.validTo ?? null,
    createdAt: prior?.createdAt ?? at, lastConfirmedAt: at,
    evidence: [...(prior?.evidence ?? [])]
  };
  if (!fact.evidence.some((entry) => entry.rawId === evidence.rawId && entry.revision === evidence.revision && entry.quote === evidence.quote && entry.source === evidence.source)) fact.evidence.push(evidence);
  if (prior) Object.assign(prior, fact); else profile.facts.push(fact);
  return fact;
}

export function profileView(profile, at = Date.now()) {
  return { ...structuredClone(profile), activeFacts: profile.facts.filter((fact) => fact.status === "active" && fact.confidence === "confirmed" && (!fact.validFrom || Date.parse(fact.validFrom) <= at) && (!fact.validTo || Date.parse(fact.validTo) > at)), candidates: profile.facts.filter((fact) => fact.status === "candidate") };
}
