// Discovery routing only. Terms never approve identity, equivalence or prices.
const fold=s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('nb').replace(/ø/g,'o').replace(/æ/g,'ae');
export function researchScope(source,families,terms){
 if(!terms||families.some(f=>!Array.isArray(terms[f.familyId])||!terms[f.familyId].length))return {mode:'unrestricted',candidate:true};
 const name=fold(source.name);
 const words=new Set(name.match(/[\p{L}\d]+/gu)??[]);
 const matches=families.filter(f=>terms[f.familyId].some(t=>{if(typeof t!=='string'||t.trim().length<3)return false;const term=fold(t).trim();return term.length<=4?words.has(term):name.includes(term);})).map(f=>f.familyId);
 return {mode:'targeted-discovery',candidate:matches.length>0,familyIds:matches,reason:matches.length?'category-term-candidate':'outside-configured-discovery-terms'};
}
export function groupPlacementWork(rows,identity){
 const groups=new Map();
 for(const row of rows){const key=identity(row),prior=groups.get(key);if(prior)prior.relatedSources.push(row);else groups.set(key,{...row,relatedSources:[]});}
 return [...groups.values()].map(row=>row.relatedSources.length?{...row,sourceCount:row.relatedSources.length+1}:row);
}

// A review is reusable only on the exact same source, registration and whole
// family basis. Newer holds and explicit reopen tombstones always win.
export function placementProof(source,familySetFingerprint,registrationFingerprint,latest,history=[]){
 const same=r=>r?.sourceKey===source.sourceKey&&r.sourceFingerprint===source.sourceFingerprint&&r.registrationFingerprint===registrationFingerprint&&r.familySetFingerprint===familySetFingerprint;
 if(same(latest))return latest;
 if(!latest||!['reviewed','no-active-family'].includes(latest.status)||latest.reviewedAllFamilies!==true||latest.sourceFingerprint!==source.sourceFingerprint||latest.registrationFingerprint!==registrationFingerprint)return null;
 const previous=[...history].reverse().find(r=>r.historyProofVersion===2&&same(r));
 return previous?.reviewedAllFamilies===true&&['reviewed','no-active-family'].includes(previous.status)?previous:null;
}
