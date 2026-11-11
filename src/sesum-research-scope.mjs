import {createHash} from 'node:crypto';

// Discovery routing only. Terms never approve identity, equivalence or prices.
const fold=s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('nb').replace(/ø/g,'o').replace(/æ/g,'ae');
export function researchScope(source,families,terms){
 return createResearchScope(families,terms)(source);
}
// Compile the same family terms once per synchronous read, not once for every
// term of every catalogue row. Do not retain a plan across changed requests.
export function createResearchScope(families,terms){
 if(!terms||families.some(f=>!Array.isArray(terms[f.familyId])||!terms[f.familyId].length))return ()=>({mode:'unrestricted',candidate:true});
 const prepared=families.map(f=>({familyId:f.familyId,terms:terms[f.familyId].filter(t=>typeof t==='string'&&t.trim().length>=3).map(t=>fold(t).trim())}));
 return source=>{
 const name=fold(source.name);
 const words=new Set(name.match(/[\p{L}\d]+/gu)??[]);
 const matches=prepared.filter(f=>f.terms.some(term=>term.length<=4?words.has(term):name.includes(term))).map(f=>f.familyId);
 return {mode:'targeted-discovery',candidate:matches.length>0,familyIds:matches,reason:matches.length?'category-term-candidate':'outside-configured-discovery-terms'};
 };
}
export function groupPlacementWork(rows,identity){
 const groups=new Map();
 for(const row of rows){const key=identity(row),prior=groups.get(key);if(prior)prior.relatedSources.push(row);else groups.set(key,{...row,relatedSources:[]});}
 return [...groups.values()].map(row=>row.relatedSources.length?{...row,sourceCount:row.relatedSources.length+1}:row);
}

// Reuse needs the same source/registration and current family semantics.
// Equivalent fingerprints come only from current, explicitly reviewed subgroup
// containment. Newer holds and explicit reopen tombstones always win.
export function familyBasisIndex(receipts){
 const result=new Map();
 for(const receipt of receipts){
  if(!receipt||result.has(receipt.familySetFingerprint)||receipt.familyProofVersion!==1||receipt.reviewedAllFamilies!==true||!['reviewed','no-active-family'].includes(receipt.status)||!Array.isArray(receipt.reviewedFamilies))continue;
  const rows=receipt.reviewedFamilies;
  if(rows.some(f=>!f||typeof f.familyId!=='string'||!f.familyId||typeof f.familyFingerprint!=='string'||!f.familyFingerprint)||new Set(rows.map(f=>f.familyId)).size!==rows.length)continue;
  const digest=createHash('sha256').update(JSON.stringify(rows.map(f=>[f.familyId,f.familyFingerprint]))).digest('hex').slice(0,24);
  if(digest===receipt.familySetFingerprint)result.set(digest,rows.map(({familyId,familyFingerprint})=>({familyId,familyFingerprint})));
 }
 return result;
}

export function placementDelta(source,registrationFingerprint,latest,families,bases=null){
 const valid=latest&&latest.sourceKey===source.sourceKey&&['reviewed','no-active-family'].includes(latest.status)&&latest.reviewedAllFamilies===true&&latest.sourceFingerprint===source.sourceFingerprint&&latest.registrationFingerprint===registrationFingerprint;
 // Another receipt can identify an exact historical criteria vector. It never
 // lends its product decision: this source still needs its own whole-set read.
 let recovered=valid&&latest.familyProofVersion===undefined&&typeof latest.scopeEvidence==='string'&&latest.scopeEvidence.trim().length>=20&&Array.isArray(latest.targets)&&(latest.status==='reviewed'?latest.targets.length>0:latest.noActiveFamilyVerified===true&&latest.targets.length===0)?bases?.get(latest.familySetFingerprint):null;
 if(recovered&&latest.targets.some(t=>!t||!recovered.some(f=>f.familyId===t.familyId&&f.familyFingerprint===t.familyFingerprint)||typeof t.equivalenceEvidence!=='string'||t.equivalenceEvidence.trim().length<20))recovered=null;
 const basis=valid?(latest.familyProofVersion===1&&Array.isArray(latest.reviewedFamilies)?latest.reviewedFamilies:recovered):null;
 const prior=new Map((basis??[]).map(f=>[f.familyId,f.familyFingerprint]));
 const retained=families.filter(f=>[f.familyFingerprint,...(f.equivalentFamilyFingerprints??[])].includes(prior.get(f.familyId))),ids=new Set(retained.map(f=>f.familyId)),current=new Map(retained.map(f=>[f.familyId,f.familyFingerprint]));
 // Only the domain supplies placementUnit from a current approved source
 // registration. Unknown/raw name-derived units cannot exclude anything.
 const codeExcludedFamilies=source.placementUnit&&['kg','l','stk','m'].includes(source.placementUnit)?families.filter(f=>f.unit&&f.unit!==source.placementUnit).map(f=>({familyId:f.familyId,familyFingerprint:f.familyFingerprint,rule:'canonical-unit-mismatch-v1',sourceUnit:source.placementUnit,familyUnit:f.unit})):[];
 const excluded=new Set(codeExcludedFamilies.map(f=>f.familyId));
 return {familiesToReview:families.filter(f=>!ids.has(f.familyId)&&!excluded.has(f.familyId)).map(f=>f.familyId),retainedFamilyIds:[...ids],retainedTargets:valid?(latest.targets??[]).filter(t=>ids.has(t.familyId)&&!excluded.has(t.familyId)).map(t=>({...t,familyFingerprint:current.get(t.familyId)})):[],...(recovered?{recoveredFamilyBasis:latest.familySetFingerprint}:{}),...(codeExcludedFamilies.length?{codeExcludedFamilies}:{})};
}
export function placementProof(source,familySetFingerprint,registrationFingerprint,latest,history=[],families=null,bases=null){
 const same=r=>r?.sourceKey===source.sourceKey&&r.sourceFingerprint===source.sourceFingerprint&&r.registrationFingerprint===registrationFingerprint&&r.familySetFingerprint===familySetFingerprint;
 if(same(latest))return latest;
 // A placement hold is unresolved work, not a family approval. A changed
 // checklist alone must not discard its bounded retry or wake external
 // research for unchanged source facts. Due holds remain visible/due normally.
 if(latest?.status==='blocked'&&latest.sourceKey===source.sourceKey&&latest.sourceFingerprint===source.sourceFingerprint&&latest.registrationFingerprint===registrationFingerprint&&Number.isFinite(Date.parse(latest.retryAt))&&typeof latest.reason==='string'&&latest.reason.trim().length>=20&&typeof latest.evidence==='string'&&latest.evidence.trim().length>=10)return latest;
 if(!latest||!['reviewed','no-active-family'].includes(latest.status)||latest.reviewedAllFamilies!==true||latest.sourceFingerprint!==source.sourceFingerprint||latest.registrationFingerprint!==registrationFingerprint)return null;
 if(families){const delta=placementDelta(source,registrationFingerprint,latest,families,bases);if(!delta.familiesToReview.length&&(latest.status==='no-active-family'||delta.retainedTargets.length))return {...latest,familySetFingerprint,targets:delta.retainedTargets,...(delta.recoveredFamilyBasis?{recoveredFamilyBasis:delta.recoveredFamilyBasis}:{}),...(delta.codeExcludedFamilies?{codeExcludedFamilies:delta.codeExcludedFamilies}:{})};}
 const previous=[...history].reverse().find(r=>r.historyProofVersion===2&&same(r));
 return previous?.reviewedAllFamilies===true&&['reviewed','no-active-family'].includes(previous.status)?previous:null;
}
