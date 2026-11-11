// Keep source labels reusable while making old household/family reasoning
// explicitly historical. No research note is itself an equivalence approval.
export function researchNotesForFamilyContext(notes,currentFingerprint){
 return notes.map(note=>{
  const current=typeof note.familyContextFingerprint==='string'&&note.familyContextFingerprint===currentFingerprint;
  if(current)return {...structuredClone(note),familyContextCurrent:true};
  const {labelText,sourceReceipts,...historicalAssessment}=structuredClone(note);
  return {familyContextCurrent:false,familyContextReason:note.familyContextFingerprint?'family-criteria-changed':'legacy-family-context-unbound',instruction:'Preserve the complete label and actual primary receipts as source evidence. Historical family/household conclusions below cannot override current families or owner choices; assess those again against the current context. Do not repeat unchanged primary research merely because family criteria changed.',...(labelText!==undefined?{labelText}:{}),...(sourceReceipts!==undefined?{sourceReceipts}:{}),historicalAssessment};
 });
}
