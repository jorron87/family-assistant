// Recall hints are questions, never product identity or equivalence approvals.
// No candidates are filtered out. All active family criteria still apply.
const words=s=>new Set((String(s??'').normalize('NFKC').toLocaleLowerCase('nb').match(/[\p{L}\p{N}]+/gu)??[]));
const qualifiers=new Set(['naturell','vanlig','plain','unflavoured','unflavored','fresh','frozen','kjølt','fryst','frosne','package','fixed','netto','butikkens']);
export function placementRecallHints(packet,research=[]){
 const notes=new Map(research.map(r=>[r.sourceKey,r]));
 return packet.sources.map((s,sourceIndex)=>{
  const facts=[s.reviewedIdentity?.product?.ingredients,s.reviewedIdentity?.product?.description,s.registration?.product?.ingredients,s.registration?.product?.description,...(notes.get(s.sourceKey)?.notes??[]).map(n=>n.labelText)].filter(Boolean).join('\n'),label=words(facts),name=words(s.observation?.source?.name);
  const hints=packet.families.flatMap((f,familyIndex)=>{const tokens=[...words(f.name)].filter(w=>w.length>=5&&!qualifiers.has(w));if(!tokens.length)return [];const labelMatch=tokens.every(t=>label.has(t)),nameMatch=tokens.every(t=>name.has(t));return labelMatch||nameMatch?[{familyId:f.familyId,familyIndex,name:f.name,matchedTokens:tokens,basis:labelMatch?'actual-label-text':'metadata-name-only',authority:'Plausible family to assess explicitly, not an approval. Tokens can be negated or refer to another ingredient. Read actual form, contents and package.'}]:[];});
  return {sourceKey:s.sourceKey,sourceIndex,hints};
 });
}
export function guardNegativePlacement(packet,input,recall){
 const rows=Array.isArray(input)?input:input?.decisions;if(!Array.isArray(rows))return input;
 const hints=new Map(recall.map(r=>[r.sourceKey,r.hints]));
 const decisions=rows.map(row=>{
  if(row.status!=='no-active-family')return row;
  const keys=row.sourceKeys??[row.sourceKey],required=new Map(keys.flatMap(k=>(hints.get(k)??[]).map(h=>[h.familyIndex,h]))),assessed=row.negativeFamilyAssessments??[];
  for(const [index,hint]of required){const a=assessed.find(a=>a.familyIndex===index);if(typeof a?.evidence!=='string'||a.evidence.trim().length<20)throw Error('Before no-active-family, explicitly assess the plausible family '+JSON.stringify(hint)+' using negativeFamilyAssessments:[{familyIndex,evidence}]. A misleading name or exclusion from one family does not exclude the actual product from another. Unknown facts must remain blocked.');}
  if(!required.size)return row;
  const extra=[...required].map(([index,h])=>h.name+': '+assessed.find(a=>a.familyIndex===index).evidence).join('\n');
  return {...row,evidence:String(row.evidence??'')+'\nExplicit label/family assessment:\n'+extra};
 });
 return Array.isArray(input)?decisions:{...input,decisions};
}
