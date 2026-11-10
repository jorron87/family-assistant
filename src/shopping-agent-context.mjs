import {createHash} from 'node:crypto';
import {shoppingAgentJobs} from './shopping-agent-jobs.mjs';
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Assignments freeze identities, not a stale copy of their next stage. A packet
// can follow those identities downstream, but cannot absorb a newly related SKU.
export function agentManifest(batch){
  return {version:1,jobs:batch.jobs.map(job=>({id:job.id,sourceKeys:job.sourceKeys,productKey:job.productKey,stages:[...new Set(job.items.map(i=>i.do))],sourceFingerprints:job.items.flatMap(i=>[i,...(i.relatedSources??[])]).filter(i=>i.sourceKey&&i.sourceFingerprint).map(i=>[i.sourceKey,i.sourceFingerprint]),familySetFingerprints:[...new Set(job.items.map(i=>i.familySetFingerprint).filter(Boolean))],taskFingerprints:job.items.filter(i=>!i.sourceKey&&!i.productKey).map(fingerprint)}))};
}
export function buildAgentContext(queue,assignment,{families,sources,products}){
  if(assignment?.version!==1||!Array.isArray(assignment.jobs)||!assignment.jobs.length||assignment.jobs.length>20)throw Error('Select one to twenty assigned product jobs.');
  const allowedSources=new Set(),allowedProducts=new Set(),ids=new Set(),tasks=new Set();
  for(const job of assignment.jobs){
    if(typeof job.id!=='string'||ids.has(job.id)||!Array.isArray(job.sourceKeys)||job.sourceKeys.length>100||job.sourceKeys.some(k=>typeof k!=='string'||!/^sesum(?:-product:|:[A-Z0-9_]+:)\d+$/.test(k))||job.productKey!=null&&(typeof job.productKey!=='string'||!/^kassal:[A-Z0-9_]+:\d+$/.test(job.productKey)))throw Error('Invalid frozen job identity.');
    if(!Array.isArray(job.taskFingerprints)||job.taskFingerprints.some(fp=>typeof fp!=='string'||!/^[a-f0-9]{64}$/.test(fp)))throw Error('Invalid frozen task fingerprints.');
    ids.add(job.id);for(const fp of job.taskFingerprints)tasks.add(fp);for(const key of job.sourceKeys)allowedSources.add(key);if(job.productKey)allowedProducts.add(job.productKey);
  }
  const jobs=shoppingAgentJobs(queue).flatMap(job=>{
    const sourceKeys=job.sourceKeys.filter(k=>allowedSources.has(k));
    if(!sourceKeys.length&&!allowedProducts.has(job.productKey)&&!job.items.some(i=>tasks.has(fingerprint(i))))return [];
    const items=job.items.flatMap(i=>{
      if(!i.sourceKey)return (i.productKey?allowedProducts.has(i.productKey):tasks.has(fingerprint(i)))?[i]:[];
      const selected=[i,...(i.relatedSources??[])].filter(r=>allowedSources.has(r.sourceKey));if(!selected.length)return [];
      const [first,...relatedSources]=selected;return [{...i,...first,relatedSources,sourceCount:selected.length}];
    });
    return [{id:sourceKeys.length?'source:'+sourceKeys[0]:job.id,sourceKeys,productKey:allowedProducts.has(job.productKey)?job.productKey:null,items}];
  });
  const data={version:1,jobs,families:families(),sources:[...allowedSources].map(sources).filter(Boolean),products:[...allowedProducts].map(products).filter(Boolean)};
  const assignmentChanges=[];
  for(const job of assignment.jobs){
    for(const [key,fp] of job.sourceFingerprints??[]){const current=data.sources.find(s=>s.sourceKey===key);if(!current||current.observation?.sourceFingerprint!==fp)assignmentChanges.push({sourceKey:key,reason:'source-metadata-changed'});}
    if(job.familySetFingerprints?.length)for(const key of job.sourceKeys){const current=data.sources.find(s=>s.sourceKey===key)?.placement;if(current&&!job.familySetFingerprints.includes(current.familySetFingerprint))assignmentChanges.push({sourceKey:key,reason:'family-requirements-changed'});}
  }
  data.assignmentChanges=assignmentChanges;
  // Hash the semantic inputs, not a new fetchedAt. This is a reading aid only;
  // mutation endpoints still enforce their own current source/family fingerprints.
  return {...data,contextFingerprint:createHash('sha256').update(JSON.stringify(data)).digest('hex'),activeStagesEmpty:jobs.length===0,completionAuthority:'Check completion and all deferred/blocked work; an empty active packet is not completion.'};
}

export function agentContextPages(packet,maxCharacters=8000){
 if(packet?.version!==1||!Number.isInteger(maxCharacters)||maxCharacters<1000||maxCharacters>12000)throw Error('Invalid context page.');
 const familyIndex=new Map(packet.families.map((f,i)=>[f.familyId,i]));
 const sources=packet.sources.map((source,sourceIndex)=>{
  const placement=source.placement?structuredClone(source.placement):null;
  // The old complete fingerprint matrix is machine bookkeeping, not new
  // evidence. Keep every decision/evidence field and expose its verified delta.
  if(placement?.review)delete placement.review.reviewedFamilies;
  if(placement?.reviewDelta){const d=placement.reviewDelta;placement.reviewScope={allFamiliesToReview:d.familiesToReview.length===packet.families.length,familyIndexesToReview:d.familiesToReview.length===packet.families.length?null:d.familiesToReview.map(id=>familyIndex.get(id)),retainedTargets:d.retainedTargets};delete placement.reviewDelta;}
  return {...source,sourceIndex,placement};
 });
 const sections={jobs:packet.jobs,families:packet.families.map((f,familyIndex)=>({...f,familyIndex})),sources,products:packet.products},out={};
 for(const [section,rows] of Object.entries(sections)){
  const pages=[];let items=[],size=0;
  const flush=()=>{if(items.length){pages.push({items});items=[];size=0;}};
  for(let index=0;index<rows.length;index++){
   const text=JSON.stringify(rows[index]);
   if(text.length>maxCharacters){flush();for(let offset=0;offset<text.length;offset+=Math.floor(maxCharacters/2))pages.push({rowIndex:index,continuation:true,offset,totalCharacters:text.length,text:text.slice(offset,offset+Math.floor(maxCharacters/2))});}
   else{if(size+text.length+2>maxCharacters)flush();items.push(rows[index]);size+=text.length+1;}
  }
  flush();out[section]=pages;
 }
 return out;
}

// Fill only technical bindings. All semantic decisions and attestations remain
// explicit agent input; ordinary domain validators check the complete result.
export function bindPlacementDecisions(packet,decisions){
 if(packet.assignmentChanges?.length)throw Error('Frozen assignment changed; checkpoint and obtain a new assignment.');
 const shared=Array.isArray(decisions)?{}:{scopeEvidence:decisions?.scopeEvidence,reviewedAllFamilies:decisions?.reviewedAllFamilies};
 const rows=Array.isArray(decisions)?decisions:decisions?.decisions;
 if(!Array.isArray(rows)||!rows.length||rows.length>100)throw Error('Supply bounded placement decisions.');
 decisions=rows.flatMap(row=>{
  if(row.sourceIndexes!==undefined){if(row.sourceIndex!==undefined||!Array.isArray(row.sourceIndexes)||!row.sourceIndexes.length||row.sourceIndexes.length>100)throw Error('Select explicit source indexes.');return row.sourceIndexes.map(sourceIndex=>({...shared,...row,sourceIndex}));}
  return [{...shared,...row}];
 });
 if(decisions.length>100)throw Error('At most one hundred explicit source decisions per packet.');
 const seen=new Set();
 return decisions.map(d=>{
  if(!Number.isInteger(d.sourceIndex)||!packet.sources[d.sourceIndex]||seen.has(d.sourceIndex))throw Error('Invalid or duplicate source index.');seen.add(d.sourceIndex);
  const source=packet.sources[d.sourceIndex],p=source.placement;
  if(!['reviewed','no-active-family','blocked'].includes(d.status))throw Error('Invalid agent placement decision.');
  if(!p||!packet.jobs.some(j=>j.items.some(i=>i.do==='shopping-sesum-placement-review'&&(i.sourceKey===source.sourceKey||i.relatedSources?.some(r=>r.sourceKey===source.sourceKey)))))throw Error('Source has no assigned current placement stage.');
  if(!Array.isArray(d.targets))throw Error('Explicit target decisions required.');
  const targets=d.targets.map(t=>{const f=Number.isInteger(t.familyIndex)?packet.families[t.familyIndex]:null;if(!f)throw Error('Invalid family index.');return {familyId:f.familyId,familyFingerprint:f.familyFingerprint,equivalenceEvidence:t.equivalenceEvidence};});
  const input={kind:'placement',sourceKey:source.sourceKey,sourceFingerprint:p.sourceFingerprint,registrationFingerprint:p.registrationFingerprint,familySetFingerprint:p.familySetFingerprint,status:d.status,evidence:d.evidence,scopeEvidence:d.scopeEvidence,reviewedAllFamilies:d.reviewedAllFamilies,noActiveFamilyVerified:d.noActiveFamilyVerified,reason:d.reason,retryAt:d.retryAt,targets};
  if(['reviewed','no-active-family'].includes(d.status))input.reviewedFamilyIds=p.reviewDelta.familiesToReview;
  return input;
 });
}
