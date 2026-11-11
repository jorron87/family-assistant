import test from 'node:test';
import assert from 'node:assert/strict';
import {researchNotesForFamilyContext} from '../src/shopping-research-context.mjs';
const note={evidence:'The former own family lacks an owner choice.',reason:'Old household decision is unresolved.',labelText:'Complete actual source declaration æøå '.repeat(1000),sourceReceipts:[{url:'https://example.test/primary',observedAt:'2026-11-01T12:00:00Z',evidence:'Actual full package declaration.'}],recordedAt:'2026-11-01T12:01:00Z',digest:'saved-original'};
test('legacy or changed-family research cannot present historical household advice as current evidence',()=>{
 for(const original of [note,{...note,familyContextFingerprint:'old-family-basis'}]){
  const before=structuredClone(original),[view]=researchNotesForFamilyContext([original],'current-family-basis');assert.equal(view.familyContextCurrent,false);assert.equal(view.evidence,undefined);assert.equal(view.reason,undefined);assert.equal(view.historicalAssessment.evidence,original.evidence);assert.equal(view.historicalAssessment.reason,original.reason);assert.equal(view.labelText,original.labelText);assert.deepEqual(view.sourceReceipts,original.sourceReceipts);assert.deepEqual(original,before);
  const {labelText,sourceReceipts,...rest}=original;assert.deepEqual(view.historicalAssessment,rest,'all original assessment fields remain complete and separate');
 }
});
test('current-family research stays explicitly unapproved, detached and bound to the exact family basis',()=>{
 const current={...note,familyContextFingerprint:'current-family-basis'},[view]=researchNotesForFamilyContext([current],'current-family-basis');assert.equal(view.familyContextCurrent,true);assert.equal(view.evidence,note.evidence);view.sourceReceipts[0].evidence='changed local copy';assert.equal(current.sourceReceipts[0].evidence,note.sourceReceipts[0].evidence);assert.equal(researchNotesForFamilyContext([current],'new-owner-choice')[0].familyContextCurrent,false);
});
