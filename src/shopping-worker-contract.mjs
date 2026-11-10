import {createHash} from 'node:crypto';
import {shoppingAgentJobs} from './shopping-agent-jobs.mjs';
import {shoppingWorkBatch} from './shopping-work-batch.mjs';
import {agentManifest} from './shopping-agent-context.mjs';
import {groupMetadataFingerprint} from './product-library.mjs';

const supported=new Set(['shopping-sesum-placement-review','shopping-sesum-discovery','shopping-sesum-review','shopping-sesum-family-review','shopping-sesum-catalog-review','shopping-sesum-offer-review','shopping-product-review']);
export const proposalHash=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
export function workerTaskSignature(items,keys){
 const fields=['do','sourceKey','productKey','watchId','familyId','familyIds','sourceFingerprint','registrationFingerprint','familySetFingerprint','familyFingerprint','campaignFingerprint','offerTermsFingerprint','fingerprint'];
 const rows=items.flatMap(i=>(i.sourceKey?[i,...(i.relatedSources??[])].filter(r=>keys.has(r.sourceKey)).map(r=>({...i,...r})):keys.has(i.productKey)?[i]:[]).map(i=>JSON.stringify(fields.map(k=>[k,Array.isArray(i[k])?[...i[k]].sort():i[k]??null]))));
 return proposalHash([...new Set(rows)].sort());
}
export const workerEligible=job=>!!(job.sourceKeys.length||job.productKey)&&job.items.length>0&&job.items.every(i=>supported.has(i.do));
export function workerBatch(jobs,queue=[]){
 const items=jobs.flatMap(j=>j.items),all=shoppingWorkBatch(queue,{limit:0}).summary,shown=shoppingWorkBatch(items,{full:true}).summary.total;
 return {jobs,items,summary:{...all,shown,remaining:Math.max(0,all.total-shown),agentJobs:{shown:jobs.length,total:shoppingAgentJobs(queue).length,remaining:Math.max(0,shoppingAgentJobs(queue).length-jobs.length)}}};
}
export function planShoppingWorkers(queue,workers=3){
 if(!Number.isInteger(workers)||workers<1||workers>3)throw Error('Use one to three shopping workers.');
 const jobs=[];for(const job of shoppingAgentJobs(queue)){if(!workerEligible(job)||jobs.length===workers*20)break;jobs.push(job);}
 if(jobs.length<2)return null;
 return {batch:workerBatch(jobs,queue),batches:Array.from({length:Math.ceil(jobs.length/20)},(_,i)=>workerBatch(jobs.slice(i*20,i*20+20),queue))};
}
export function workerManifest(batch){
 const manifest=agentManifest(batch);
 // A worker may refresh changed family criteria for the same frozen identities.
 // Every write still requires its current, completely served context fingerprint.
 for(const job of manifest.jobs)job.familySetFingerprints=[];
 return manifest;
}
const sourceKeys=assignment=>new Set(assignment.jobs.flatMap(j=>j.sourceKeys));
const sourceAt=(packet,key)=>packet.sources.find(s=>s.sourceKey===key);
function requireSource(assignment,packet,key){
 if(!sourceKeys(assignment).has(key)||!sourceAt(packet,key))throw Error('Source is outside this worker assignment.');
 return sourceAt(packet,key);
}
const sourceItems=(packet,key)=>packet.jobs.flatMap(j=>j.items).flatMap(i=>i.sourceKey===key?[i]:i.relatedSources?.some(r=>r.sourceKey===key)?[{...i,...i.relatedSources.find(r=>r.sourceKey===key)}]:[]);
function requireStage(packet,key,stages){if(!sourceItems(packet,key).some(i=>stages.includes(i.do)))throw Error('This operation has no current assigned stage.');}

// All functions below run synchronously in the one archive-owning server. A
// worker selects semantic actions; code binds exact fingerprints and scope.
export function applyWorkerProposal({store,assignment,packet,operation,input,groupReads=new Map()}){
 if(packet.assignmentChanges.length)throw Error('Assigned source changed; stop and request a new assignment.');
 const data=structuredClone(input??{}),shop=store.shopping;
 if(operation==='placement'){
  const rows=Array.isArray(data)?data:data.decisions;if(!Array.isArray(rows)||!rows.length)throw Error('Explicit placement decisions are required.');
  const decisions=rows.map(row=>{const keys=Array.isArray(row.sourceKeys)?row.sourceKeys:[row.sourceKey];if(!keys.length||keys.some(k=>typeof k!=='string'))throw Error('Placement requires explicit sourceKey or sourceKeys, never positional identity alone.');const indexes=keys.map(k=>{const i=packet.sources.findIndex(s=>s.sourceKey===k);if(i<0)throw Error('Placement source is outside the current worker frame.');return i;});if(row.sourceIndex!=null&&(indexes.length!==1||indexes[0]!==row.sourceIndex)||row.sourceIndexes!=null&&JSON.stringify(row.sourceIndexes)!==JSON.stringify(indexes))throw Error('Placement source key and source index disagree; read the actual source mapping.');return {...row,sourceIndex:undefined,sourceIndexes:indexes};});
  return shop.agentPlacement({assignment,contextFingerprint:packet.contextFingerprint,decisions:Array.isArray(data)?decisions:{...data,decisions}});
 }
 if(operation==='catalog-review'){
  const key=data.productKey;if(!assignment.jobs.some(j=>j.productKey===key))throw Error('Native product is outside this assignment.');
  const product=packet.products.find(p=>p.productKey===key),row=product?.entries.find(e=>e.watchId===(data.familyId??data.watchId));
  if(!row||!packet.jobs.some(j=>j.items.some(i=>i.do==='shopping-product-review'&&i.productKey===key&&i.watchId===row.watchId)))throw Error('No current assigned native review.');
  return shop.catalogReview({...data,watchId:row.watchId,id:row.id,store:row.store,fingerprint:row.fingerprint});
 }
 const source=requireSource(assignment,packet,data.sourceKey),key=data.sourceKey,candidate=Array.isArray(source.candidate)?source.candidate.find(c=>c.sourceKey===key):source.candidate;
 if(operation==='source-register'){
  requireStage(packet,key,['shopping-sesum-discovery','shopping-sesum-review']);
  const definitions=new Map((data.groups??[]).map(g=>[g.id,g]));
  data.memberships=(data.memberships??[]).map(m=>{const fp=definitions.has(m.groupId)?groupMetadataFingerprint(definitions.get(m.groupId)):groupReads.get(m.groupId);if(!fp)throw Error('Read the actual group before selecting its membership.');return {...m,groupFingerprint:fp};});
  return shop.sesumRegister({...data,sourceFingerprint:source.observation.sourceFingerprint});
 }
 if(operation==='source-review'){
  if(data.kind==='placement')throw Error('Use the placement operation with explicit source indexes.');
  requireStage(packet,key,data.kind==='catalogue'?['shopping-sesum-catalog-review']:['shopping-sesum-review','shopping-sesum-discovery','shopping-sesum-family-review']);
  data.sourceFingerprint=source.observation.sourceFingerprint;
  data.registrationFingerprint=source.placement?.registrationFingerprint??null;
  if(data.kind==='catalogue')data.familySetFingerprint=source.placement.familySetFingerprint;
  else if(['excluded','blocked','reopen'].includes(data.status)){
   const families=candidate?.families??[];
   data.familyFingerprints=Object.fromEntries((data.familyIds??[]).map(id=>{const f=families.find(f=>f.familyId===id);if(!f)throw Error('Read the current source-family decision before changing it.');return [id,f.requirementsFingerprint];}));
  }else{
   const donor=candidate?.donors?.find(d=>d.productKey===data.productKey);if(!donor)throw Error('Select a reviewed donor from the current source candidates.');data.productFingerprint=donor.productFingerprint;
  }
  return shop.sesumPriceReview(data);
 }
 if(operation==='source-offer-review'){
  const familyId=data.familyId??data.watchId,row=sourceItems(packet,key).find(i=>i.do==='shopping-sesum-offer-review'&&(i.familyId??i.watchId)===familyId);
  if(!row)throw Error('No current assigned source campaign for this family.');
  if(data.offer&&(data.offer.watchId??data.offer.familyId)!==familyId)throw Error('Offer must belong to the assigned source family.');
  return shop.sesumOfferReview({...data,familyId,sourceFingerprint:row.sourceFingerprint,familyFingerprint:row.familyFingerprint,campaignFingerprint:row.campaignFingerprint,offerTermsFingerprint:row.offerTermsFingerprint});
 }
 if(operation==='family-add-variant'){
  const familyId=data.familyId??data.watchId;
  if(!sourceItems(packet,key).some(i=>i.do==='shopping-sesum-family-review'&&(i.familyId??i.watchId)===familyId))throw Error('No current assigned source-family extension.');
  const family=packet.families.find(f=>f.familyId===familyId),watch=store.snapshot().shopping.watches[familyId],variant=data.variant;
  const sourceDecision=candidate?.families?.find(f=>f.familyId===familyId)?.sourceDecision;
  if(sourceDecision?.status==='excluded'||sourceDecision?.holdExcluded===true)throw Error('Preserve the explicit source-family exclusion hold before extending a family.');
  if(!watch||family?.decision?.kind!=='library'||!variant)throw Error('Own or narrow families require their ordinary explicit family review.');
  const identity=source.reviewedIdentity,group=identity?.groups.find(g=>g.groupId===variant.groupId);
  if(!group||!groupReads.has(group.groupId)||groupReads.get(group.groupId)!==group.groupFingerprint)throw Error('Read this source’s actual current reviewed group before adding it.');
  const links=watch.variants??[];
  if(links.some(v=>v.groupId===variant.groupId))throw Error('Existing variant requirements are preserved; use a separate family audit to change them.');
  if(!Array.isArray(variant.brands)||!Array.isArray(variant.requires)||!Array.isArray(variant.excludeProductKeys))throw Error('Explicit brand, attribute and exclusion decisions are required.');
  const restricted=links.filter(v=>v.brands?.length),brands=new Set(restricted.flatMap(v=>v.brands));
  if(restricted.length&&(!variant.brands.length||variant.brands.some(b=>!brands.has(b))))throw Error('A source job cannot broaden existing household brand requirements.');
  const common=(links[0]?.requires??[]).filter(r=>links.every(v=>v.requires?.includes(r)));
  if(common.some(r=>!variant.requires.includes(r)))throw Error('Preserve the family’s existing shared attribute requirements.');
  const keys=new Set([key,identity.productKey,source.registration?.nativeIdentity?.key].filter(Boolean));
  if(links.some(v=>v.excludeProductKeys?.some(k=>keys.has(k)))||identity.nativeFamilyReviews.some(r=>r.watchId===familyId&&['pending','excluded'].includes(r.status)))throw Error('Preserve the current native or family hold.');
  return shop.libraryLink({familyId,evidence:data.evidence,variants:[...links,{...variant,groupFingerprint:group.groupFingerprint}]});
 }
 throw Error('Operation is not available to a shopping worker.');
}

export const workerTools=[
 {name:'shopping_context',description:'Get the current frozen job context header, or one zero-based context page. Use sourceKey/productKey to focus the WHOLE assigned product job across chains; focus=all restores all assigned jobs. After compaction use reread:true to discard old delivery hints. Refresh after every saved action; read every required page before another proposal.',inputSchema:{type:'object',properties:{section:{type:'string'},page:{type:'integer',minimum:0},refresh:{type:'boolean'},reread:{type:'boolean'},sourceKey:{type:'string'},productKey:{type:'string'},focus:{type:'string',enum:['all']}},additionalProperties:false}},
 {name:'shopping_read',description:'Read existing product/group facts, unapproved research or the current assigned campaign. Large responses have readId/pages; retrieve all needed pages with kind=page. No mutation or cart tools.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['library-search','product','group','source-candidates','source-offers','profile','research','page']},query:{type:'string'},productKey:{type:'string'},groupId:{type:'string'},sourceKey:{type:'string'},readId:{type:'string'},page:{type:'integer',minimum:0}},required:['kind'],additionalProperties:false}},
 {name:'shopping_propose',description:'Submit one explicit proposed domain action. Only the coordinator validates and saves it. placement input: {scopeEvidence,reviewedAllFamilies:true,decisions:[{sourceKey OR sourceKeys:[...],status:reviewed|no-active-family|blocked,evidence,targets:[{familyIndex,equivalenceEvidence}],reason?,retryAt?,noActiveFamilyVerified?}]}. Use explicit source keys; code binds current indexes. reviewed requires at least one actually verified family target. no-active-family requires targets:[], reason and noActiveFamilyVerified:true. blocked requires targets:[], reason and future retryAt; unknown/conflicting facts are blocked. There is no excluded placement status. Before no-active-family, explicitly assess every plausibleFamiliesToAssess recall hint using negativeFamilyAssessments:[{familyIndex,evidence}]. Hints never approve anything; a name can mislead and label words can be negated. If the advertised family fails, independently find the family matching the ACTUAL label form and ingredients. Use a unique proposalId; same ID replays its real receipt. Stale contexts need refresh.',inputSchema:{type:'object',properties:{proposalId:{type:'string'},contextFingerprint:{type:'string'},operation:{type:'string',enum:['placement','source-register','source-review','source-offer-review','family-add-variant','catalog-review']},input:{type:'object',additionalProperties:true}},required:['proposalId','contextFingerprint','operation','input'],additionalProperties:false}},
 {name:'shopping_checkpoint',description:'Preserve concrete label research or a browser/serial handoff for an assigned source. It is not an approval or fresh price receipt.',inputSchema:{type:'object',properties:{sourceKey:{type:'string'},evidence:{type:'string'},labelText:{type:'string'},reason:{type:'string'},needsBrowser:{type:'boolean'},sourceReceipts:{type:'array',items:{type:'object',properties:{url:{type:'string'},observedAt:{type:'string'},evidence:{type:'string'}},required:['url','observedAt','evidence'],additionalProperties:false}}},required:['sourceKey','evidence'],additionalProperties:false}}
];
