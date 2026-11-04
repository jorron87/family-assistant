import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProfile, learnFact, profileView } from "../src/profile-facts.mjs";

const fixture = () => normalizeProfile({ members:[{ id:"child3" }], facts:[] });
const raw = { id:"source-1", revision:1, source:"spond", body:"Barn Tre går på turn. Barn Tre har sluttet på turn." };
const fact = { memberId:"child3", key:"hobby:turn", category:"hobby", confidence:"confirmed", text:"Barn Tre går på turn.", quote:"Barn Tre går på turn." };

test("learned facts deduplicate, retain source revisions and reject ungrounded quotes", () => {
  const profile = fixture();
  learnFact(profile, fact, raw);
  learnFact(profile, fact, raw);
  learnFact(profile, fact, { ...raw, revision:2 });
  assert.equal(profile.facts.length, 1);
  assert.equal(profile.facts[0].evidence.length, 2);
  assert.throws(() => learnFact(profile, { ...fact, quote:"Barn Tre liker håndball" }, raw), /quote/);
  assert.throws(() => learnFact(profile, { ...fact, memberId:"unknown" }, raw), /familiemedlem/);
});

test("conflicting and inferred facts do not replace confirmed knowledge; explicit correction preserves history", () => {
  const profile = fixture();
  const old = learnFact(profile, fact, raw);
  const changed = { ...fact, text:"Barn Tre har sluttet på turn.", quote:"Barn Tre har sluttet på turn." };
  assert.equal(learnFact(profile, changed, raw).status, "candidate");
  assert.equal(profileView(profile).activeFacts[0].id, old.id);
  learnFact(profile, { ...changed, correctsPrevious:true }, raw);
  assert.equal(old.status, "superseded");
  assert.equal(profileView(profile).activeFacts[0].text, changed.text);
  learnFact(profile, { ...changed, confidence:"inferred" }, raw);
  assert.equal(profileView(profile).activeFacts.length, 1);
});

test("temporary roles expire instead of remaining permanent relevance rules", () => {
  const profile = fixture();
  learnFact(profile, { memberId:"child3", key:"role:class", category:"role", confidence:"confirmed", source:"manual", text:"Klassekontakt dette skoleåret", validFrom:"2026-08-01", validTo:"2027-08-01" }, null);
  assert.equal(profileView(profile, Date.parse("2026-09-26")).activeFacts.length, 1);
  assert.equal(profileView(profile, Date.parse("2027-09-26")).activeFacts.length, 0);
  assert.equal(profile.facts.length, 1);
});

test("source corrections cannot replace the family's own confirmed preference", () => {
  const profile=fixture();
  const manual=learnFact(profile,{...fact,source:'manual',text:'Barn Tre liker gaming.'},null);
  const suggestion=learnFact(profile,{...fact,correctsPrevious:true},raw);
  assert.equal(manual.status,'active');assert.equal(suggestion.status,'candidate');
  assert.equal(profileView(profile).activeFacts[0].text,'Barn Tre liker gaming.');
  manual.status='superseded';manual.familyRemovedAt=new Date().toISOString();
  learnFact(profile,{...fact,correctsPrevious:true},raw);
  assert.equal(profileView(profile).activeFacts.length,0);
});
