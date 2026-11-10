// Discovery routing only. Terms never approve identity, equivalence or prices.
const fold=s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('nb').replace(/ø/g,'o').replace(/æ/g,'ae');
export function researchScope(source,families,terms){
 if(!terms||families.some(f=>!Array.isArray(terms[f.familyId])||!terms[f.familyId].length))return {mode:'unrestricted',candidate:true};
 const name=fold(source.name);
 const matches=families.filter(f=>terms[f.familyId].some(t=>typeof t==='string'&&t.trim().length>=3&&name.includes(fold(t).trim()))).map(f=>f.familyId);
 return {mode:'targeted-discovery',candidate:matches.length>0,familyIds:matches,reason:matches.length?'category-term-candidate':'outside-configured-discovery-terms'};
}
export function groupPlacementWork(rows,identity){
 const groups=new Map();
 for(const row of rows){const key=identity(row),prior=groups.get(key);if(prior)prior.relatedSources.push(row);else groups.set(key,{...row,relatedSources:[]});}
 return [...groups.values()].map(row=>row.relatedSources.length?{...row,sourceCount:row.relatedSources.length+1}:row);
}
