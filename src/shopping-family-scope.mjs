const subset=(a,b)=>a.every(value=>b.includes(value));
const brands=v=>(v.brands??[]).map(s=>s.normalize('NFKC').trim().toLocaleLowerCase('nb'));
const reviewedFingerprint=v=>Object.hasOwn(v,'reviewedGroupFingerprint')?v.reviewedGroupFingerprint:v.groupFingerprint;

// An explicit reviewed containment receipt, never name/prefix matching.
// Both definitions, reviewed links and household restrictions must stay current.
export function scopeCoverageCurrent(link,links,group){
 const proof=link.scopeCoverage;
 if(!proof||proof.reviewed!==true||typeof proof.evidence!=='string'||proof.evidence.trim().length<20||proof.evidence.length>6000)return false;
 const parent=links.find(v=>v.groupId===proof.groupId);
 if(!parent||parent===link||parent.scopeCoverage)return false;
 const childGroup=group(link.groupId),parentGroup=group(parent.groupId);
 if(!childGroup||!parentGroup||childGroup.unit!==parentGroup.unit)return false;
 if(proof.groupFingerprint!==parentGroup.fingerprint||proof.childGroupFingerprint!==childGroup.fingerprint||reviewedFingerprint(parent)!==parentGroup.fingerprint||reviewedFingerprint(link)!==childGroup.fingerprint)return false;
 const requiredBrands=brands(parent),childBrands=brands(link);
 return (!requiredBrands.length||childBrands.length>0&&subset(childBrands,requiredBrands))&&subset(parent.requires??[],link.requires??[])&&subset(parent.excludeProductKeys??[],link.excludeProductKeys??[]);
}

export function effectiveScopeVariants(links,group){
 return links.filter(v=>!scopeCoverageCurrent(v,links,group)).map(({scopeCoverage,scopeCoverageCurrent,...variant})=>variant);
}
