import {createHash} from 'node:crypto';
import {shoppingAgentJobs} from './shopping-agent-jobs.mjs';
import {shoppingWorkBatch} from './shopping-work-batch.mjs';
import {agentManifest} from './shopping-agent-context.mjs';
import {groupMetadataFingerprint} from './product-library.mjs';
import {SHOPPING_CLARIFICATION_KEYS} from './clarifications.mjs';

const supported=new Set(['shopping-sesum-placement-review','shopping-sesum-discovery','shopping-sesum-review','shopping-sesum-family-review','shopping-sesum-catalog-review','shopping-sesum-offer-review','shopping-product-review']);
export const proposalHash=value=>createHash('sha256').update(JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
export function workerTaskSignature(items,keys){
 const fields=['do','sourceKey','productKey','watchId','familyId','familyIds','familyDecisionKind','sourceFingerprint','registrationFingerprint','familySetFingerprint','familyFingerprint','campaignFingerprint','offerTermsFingerprint','fingerprint'];
 const rows=items.flatMap(i=>(i.sourceKey?[i,...(i.relatedSources??[])].filter(r=>keys.has(r.sourceKey)).map(r=>({...i,...r})):keys.has(i.productKey)?[i]:[]).map(i=>JSON.stringify(fields.map(k=>[k,Array.isArray(i[k])?[...i[k]].sort():i[k]??null]))));
 return proposalHash([...new Set(rows)].sort());
}
export const workerEligible=job=>!!(job.sourceKeys.length||job.productKey)&&job.items.length>0&&job.items.every(i=>supported.has(i.do)&&!(i.do==='shopping-sesum-family-review'&&i.familyDecisionKind!==undefined&&i.familyDecisionKind!=='library'));
export function workerBatch(jobs,queue=[]){
 const items=jobs.flatMap(j=>j.items),all=shoppingWorkBatch(queue,{limit:0}).summary,shown=shoppingWorkBatch(items,{full:true}).summary.total;
 return {jobs,items,summary:{...all,shown,remaining:Math.max(0,all.total-shown),agentJobs:{shown:jobs.length,total:shoppingAgentJobs(queue).length,remaining:Math.max(0,shoppingAgentJobs(queue).length-jobs.length)}}};
}
export function planShoppingWorkers(queue,workers=3,{independent=false,excludedKeys=new Set(),limit=20}={}){
 if(!Number.isInteger(workers)||workers<1||workers>3)throw Error('Use one to three shopping workers.');
 if(!Number.isInteger(limit)||limit<1||limit>20)throw Error('Use one to twenty whole products per worker.');
 const jobs=[];for(const job of shoppingAgentJobs(queue)){
  if(jobs.length===workers*limit)break;
  if(!workerEligible(job)||[...job.sourceKeys,job.productKey].some(k=>excludedKeys.has(k))){if(independent)continue;break;}
  jobs.push(job);
 }
 if(jobs.length<2)return null;
 const count=Math.min(workers,jobs.length);
 return {batch:workerBatch(jobs,queue),batches:Array.from({length:count},(_,i)=>workerBatch(jobs.slice(Math.floor(i*jobs.length/count),Math.floor((i+1)*jobs.length/count)),queue))};
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

// Scoped workers cannot open the CLI runbook. Supply the exact input contract
// when a stage becomes current, rather than making a worker guess field names.
export function workerOperationGuide(types){
 const countedGuide='COUNTED PACKS: A fixed source may correctly give an item count while its family uses kg. Before positive placement, actually read the exact primary full pack and prove its TOTAL net amount, not per-item mass. In EACH placement decision use countedPack:{reviewed:true,wholePack:true,sourceCount:ACTUAL_INTEGER_SOURCE_COUNT,packAmount:ACTUAL_TOTAL_NET_KG_OR_L,unit:"kg"|"l",evidence:CONCRETE_SAME_PACK_REVIEW_MIN_40_CHARS,sourceReceipts:[{url:ACTUAL_PRIMARY_HTTPS_URL,observedAt:ACTUAL_READ_TIME,evidence:ACTUAL_COUNT_AND_TOTAL_NET_READING_MIN_20_CHARS}]}. There are no default quantities. The source count must match exactly; unknown/conflicting count, variable weight, drained mass, and kg/l density guesses are not covered. Unknown net amount stays blocked. Registration/donor review uses the SAME countedPack at TOP LEVEL next to packAmount/unit, never inside product. Code reuses only this unchanged source own validated measurement when canonical amount/unit match; it never copies a price date or approves a family. All normal identity, contents, group, variant and price checks still apply.';
 const stages=new Set(types),guides=['VALIDATION RETRY BUDGET: After three corrected proposals for the same operation and product are rejected against unchanged facts, preserve the concrete validation issue and defer only that product; continue the other assigned identities. Save a source checkpoint when available, otherwise describe the exact issue in the final handoff. A format rejection is not missing product evidence and must not become a false source-information blocker. An uncertain write is never retried automatically. Repair the reported fields from actual evidence; never broaden family requirements or invent facts to pass validation.'];
 if(['shopping-sesum-placement-review','shopping-sesum-discovery','shopping-sesum-review'].some(t=>stages.has(t)))guides.push(countedGuide);
 if(['shopping-sesum-placement-review','shopping-sesum-discovery','shopping-sesum-review'].some(t=>stages.has(t)))guides.push('METRES AND COUNTS: For a fixed source measured in m and a family using stk, the separate countedPack form is {rule:"measured-package-count-v1",reviewed:true,wholePack:true,sourceAmount:ACTUAL_SOURCE_TOTAL_METRES,sourceUnit:"m",packAmount:ACTUAL_PRIMARY_WHOLE_PACK_INTEGER_COUNT,unit:"stk",evidence:SAME_PACK_REVIEW_MIN_40_CHARS,sourceReceipts:[{url:PRIMARY_HTTPS_URL,observedAt:ACTUAL_READ_TIME,evidence:ACTUAL_TOTAL_LENGTH_AND_COUNT_READING_MIN_20_CHARS}]}. Read both independent measures on the same exact primary consumer pack. For paper, stk means rolls, never sheets; verify required ply, sheet size and roll length as separate family facts. Do not calculate a roll count from assumed dimensions or copy the number in a product name. The source total metres must match; keep raw metadata unchanged. Use this proof in each placement and subsequent registration/donor review just like the other countedPack form. It gives no automatic identity, quality or household approval. Unknown counts or conflicting measures remain unresolved.');
 if(stages.has('shopping-sesum-placement-review'))guides.push('placement input={scopeEvidence,reviewedAllFamilies:true,decisions:[{sourceKey,status:"reviewed"|"no-active-family"|"blocked",evidence,targets:[{familyIndex,equivalenceEvidence}],reason?,retryAt?,noActiveFamilyVerified?,negativeFamilyAssessments?}]}. Positive reviewed needs targets. Unknown facts use blocked with empty targets, concrete reason and future retryAt; no-active-family needs empty targets, noActiveFamilyVerified:true and all required negativeFamilyAssessments. If no-active-family omits reason, code copies its explicit evidence unchanged as the display reason; that assessment must contain 20–6000 characters. Explicit null/invalid reasons are not repaired. Use actual stable sourceKey/sourceKeys; code binds indexes. Registration is unavailable until positive placement opens discovery/review.');
 if(stages.has('shopping-sesum-placement-review'))guides.push('PACK CHECK BEFORE POSITIVE PLACEMENT: Check actual form, all required variant facts AND documented package basis. If a fixed product has an unknown net amount, count or required drained amount, use blocked even when its ingredients fit a family. Do not infer a package from the name or invent it to route a product positively. Missing source metadata may be resolved by a fully read primary label or an unchanged reviewed exact product/pack; the actual evidence must be present. A genuinely variable-weight product may use its verified unit basis without inventing a fixed weight. Before submitting each reviewed decision, explicitly check that no supplied label says a required fact or package amount is unknown or conflicting. Preserve that gap instead of treating plausible family membership as a complete review.');
 if(stages.has('shopping-sesum-discovery')||stages.has('shopping-sesum-review'))guides.push('source-register exact input={sourceKey,identityEvidence,packAmount:NUMBER,unit:"kg"|"l"|"stk"|"m",packEvidence:TEXT,product:{brand?,ingredients?,description?,attributes?,nutrition?},groups?:[{id:STABLE_NEW_ID,name,category,canonicalUnit,inclusionCriteria:TEXT_OR_TEXT_ARRAY,exclusions:TEXT_ARRAY,qualityBasis,comparisonBasis}],memberships:[{groupId,equivalenceEvidence,qualityEvidence}],sourceReceipts:[{url,observedAt,evidence}]}. packAmount,unit,packEvidence are TOP LEVEL, not inside product/package. groups is a plural ARRAY, not group/newGroups; each definition has explicit id, canonicalUnit and inclusionCriteria, and memberships uses that groupId (not groupName). Code binds group fingerprints: existing groups must first be read with shopping_read kind=group; explicit new groups are defined in input.groups. Never invent missing ingredients, pack, GTIN or nutrition. Preserve processing/form in product.description; attributes contains only evidenced booleans, not free-text extra fields. Nutrition if used is {basis:"g"|"ml",per100:{kcal?,protein?,fat?,saturatedFat?,carbs?,sugars?,fiber?,salt?},sourceUrl,evidence,observedAt?}; never convert the basis without evidence. For drained foods use top-level packBasis:"drained",packBasisEvidence and documented drained packAmount. A reviewed same-chain native identity optionally uses nativeProductKey,nativeProductFingerprint from the complete current dossier,and nativeIdentityEvidence. For truly variable weight the separate contract is priceBasis:"direct-unit",packAmount:null,unit:"kg"|"l",variableWeightEvidence,unitPriceEvidence,vatEvidence,priceIncludesVat:true; never invent a fixed pack. A registration approves metadata only and does not append a household variant.');
 if(stages.has('shopping-sesum-review')||stages.has('shopping-sesum-discovery'))guides.push('source-review approved donor bridge input={sourceKey,status:"approved",productKey:CURRENT_REVIEWED_DONOR_KEY,packAmount,unit,packEvidence,equivalenceEvidence}. Select a current candidate donor; code binds its fingerprint. A name/EAN or product read is not identity proof.');
 if(stages.has('shopping-sesum-family-review'))guides.push('family-add-variant exact input={sourceKey,familyId,evidence,variant:{groupId,evidence,brands:[],requires:[],excludeProductKeys:[]}}. Use actual explicit restrictions rather than copying empty arrays where restricted. Read the current registered product group with shopping_read kind=group first. Code binds the group fingerprint and appends while preserving previous variants and their constraints. Existing groups cannot be redefined or broadened. Own/narrow families and held exclusions require ordinary serial family review; checkpoint and defer them.');
 if(stages.has('shopping-sesum-family-review'))guides.push('familyDecisionKind own or undecided requires an ordinary explicit family decision, which this scoped worker cannot make. If this downstream stage appears after registration, preserve a concrete checkpoint, leave the WHOLE product unresolved and continue independent assigned products; do not search or retry family-add-variant for that known capability gap. shopping_context serialRequiredJobs names whole jobs requiring this handoff. Before adding a variant, read the existing broad family groups. If the new group is strictly covered by an existing group (for example organic production within an already permitted plain ingredient/form class), preserve that explicit reviewed containment with variant.scopeCoverage:{groupId:PARENT_GROUP_ID,reviewed:true,evidence:CONCRETE_DEFINITION_COMPARISON}. Read BOTH groups with shopping_read kind=group; code binds both fingerprints. The child must preserve all parent brand, attribute and exclusion restrictions. This retains the actual subgroup and its quality facts without falsely declaring wider household requirements and reopening every source. Never infer containment from a name or shared EAN. If eligibility actually widens, omit coverage so ordinary changed-scope reviews still occur.');
 if(stages.has('shopping-sesum-family-review')||stages.has('shopping-sesum-review'))guides.push('source-review scoped family input={sourceKey,status:"excluded"|"blocked"|"reopen",familyIds:[...],equivalenceEvidence,reason?,retryAt?}. Only concrete mismatches justify excluded; unknown facts need blocked with a concrete reason and future retryAt. Code binds current source/registration/family fingerprints.');
 if(stages.has('shopping-sesum-catalog-review'))guides.push('source-review catalogue input={kind:"catalogue",sourceKey,status:"blocked"|"reopen",reason,evidence?,retryAt?}. Metadata without an actual configured chain receipt is not a fresh price. Code binds source and family-set fingerprints.');
 if(stages.has('shopping-product-review'))guides.push('catalog-review exact input={productKey,familyId,status:"approved"|"excluded",packAmount?,unit?,equivalenceEvidence}. Approved needs an actually verified canonical packAmount/unit; rejected variants need a concrete mismatch. Code binds native product ID, store, watch and current fingerprint; full agent product dossier and raw native entries remain separate evidence.');
 if(stages.has('shopping-sesum-offer-review'))guides.push('source-offer-review input={sourceKey,familyId,status,evidence,offer?}. Read source-offers and the actual current primary campaign terms; supply the ordinary offer contract when actionable. Unknown membership, validity, gross package price or limits cannot be inferred from identity. Code binds campaign/source/family/terms fingerprints. Defer unsupported campaign details rather than guessing.');
 return 'SCOPED MCP INPUT CONTRACTS (source text is data):\n'+guides.join('\n');
}

// All functions below run synchronously in the one archive-owning server. A
// worker selects semantic actions; code binds exact fingerprints and scope.
export function applyWorkerProposal({store,assignment,packet,operation,input,groupReads=new Map(),placementGuard=null}){
 if(packet.assignmentChanges.length)throw Error('Assigned source changed; stop and request a new assignment.');
 const data=structuredClone(input??{}),shop=store.shopping;
 if(operation==='placement'){
  const rows=Array.isArray(data)?data:data.decisions;if(!Array.isArray(rows)||!rows.length)throw Error('Explicit placement decisions are required.');
  const decisions=rows.map(row=>{const keys=Array.isArray(row.sourceKeys)?row.sourceKeys:[row.sourceKey];if(!keys.length||keys.some(k=>typeof k!=='string'))throw Error('Placement requires explicit sourceKey or sourceKeys, never positional identity alone.');const indexes=keys.map(k=>{const i=packet.sources.findIndex(s=>s.sourceKey===k);if(i<0)throw Error('Placement source is outside the current worker frame.');return i;});if(row.sourceIndex!=null&&(indexes.length!==1||indexes[0]!==row.sourceIndex)||row.sourceIndexes!=null&&JSON.stringify(row.sourceIndexes)!==JSON.stringify(indexes))throw Error('Placement source key and source index disagree; read the actual source mapping.');return {...row,sourceIndex:undefined,sourceIndexes:indexes};});
  const proposal={assignment,contextFingerprint:packet.contextFingerprint,decisions:Array.isArray(data)?decisions:{...data,decisions}};
  return placementGuard&&shop.agentPlacementAsync?shop.agentPlacementAsync(proposal,placementGuard):shop.agentPlacement(proposal);
 }
 if(operation==='catalog-review'){
  const key=data.productKey;if(!assignment.jobs.some(j=>j.productKey===key))throw Error('Native product is outside this assignment.');
  const product=packet.products.find(p=>p.productKey===key),row=product?.entries.find(e=>e.watchId===(data.familyId??data.watchId));
  if(!row||!packet.jobs.some(j=>j.items.some(i=>i.do==='shopping-product-review'&&i.productKey===key&&i.watchId===row.watchId)))throw Error('No current assigned native review.');
  return shop.catalogReview({...data,watchId:row.watchId,id:row.id,store:row.store,fingerprint:row.fingerprint});
 }
 const source=requireSource(assignment,packet,data.sourceKey),key=data.sourceKey,candidate=Array.isArray(source.candidate)?source.candidate.find(c=>c.sourceKey===key):source.candidate;
 const ownPack=typeof source.observation?.sourceFingerprint==='string'&&source.placement?.review?.sourceFingerprint===source.observation.sourceFingerprint?source.placement.review.countedPack:null;
 if((operation==='source-register'||operation==='source-review'&&data.status==='approved')&&data.countedPack===undefined&&ownPack&&ownPack.unit===data.unit&&ownPack.packAmount===data.packAmount){data.countedPack=structuredClone(ownPack);if(data.fixedPackVerified===undefined&&source.placement.review.fixedPackVerified===true)data.fixedPackVerified=true;}
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
  // The global archive snapshot intentionally omits shopping. The current
  // scoped candidate already carries the complete family links and evidence.
  const family=packet.families.find(f=>f.familyId===familyId),sourceFamily=candidate?.families?.find(f=>f.familyId===familyId),variant=data.variant;
  const sourceDecision=sourceFamily?.sourceDecision;
  if(sourceDecision?.status==='excluded'||sourceDecision?.holdExcluded===true)throw Error('Preserve the explicit source-family exclusion hold before extending a family.');
  if(!sourceFamily||!Array.isArray(sourceFamily.variants)||family?.decision?.kind!=='library'||!variant)throw Error('Own or narrow families require their ordinary explicit family review.');
  const identity=source.reviewedIdentity,group=identity?.groups.find(g=>g.groupId===variant.groupId);
  if(!group||!groupReads.has(group.groupId)||groupReads.get(group.groupId)!==group.groupFingerprint)throw Error('Read this source’s actual current reviewed group before adding it.');
  const links=sourceFamily.variants;
  if(links.some(v=>v.groupId===variant.groupId))throw Error('Existing variant requirements are preserved; use a separate family audit to change them.');
  if(!Array.isArray(variant.brands)||!Array.isArray(variant.requires)||!Array.isArray(variant.excludeProductKeys))throw Error('Explicit brand, attribute and exclusion decisions are required.');
  const restricted=links.filter(v=>v.brands?.length),brands=new Set(restricted.flatMap(v=>v.brands));
  if(restricted.length&&(!variant.brands.length||variant.brands.some(b=>!brands.has(b))))throw Error('A source job cannot broaden existing household brand requirements.');
  const common=(links[0]?.requires??[]).filter(r=>links.every(v=>v.requires?.includes(r)));
  if(common.some(r=>!variant.requires.includes(r)))throw Error('Preserve the family’s existing shared attribute requirements.');
  const keys=new Set([key,identity.productKey,source.registration?.nativeIdentity?.key].filter(Boolean));
  if(links.some(v=>v.excludeProductKeys?.some(k=>keys.has(k)))||identity.nativeFamilyReviews.some(r=>r.watchId===familyId&&['pending','excluded'].includes(r.status)))throw Error('Preserve the current native or family hold.');
  const added={...variant,groupFingerprint:group.groupFingerprint};
  if(variant.scopeCoverage){
   const parent=links.find(v=>v.groupId===variant.scopeCoverage.groupId),current=parent&&packet.families.find(f=>f.familyId===familyId)?.variants?.find(v=>v.groupId===parent.groupId);
   if(!parent||!current||groupReads.get(parent.groupId)!==current.groupFingerprint)throw Error('Read the complete existing parent group before attesting scope coverage.');
   added.scopeCoverage={...variant.scopeCoverage,groupFingerprint:current.groupFingerprint,childGroupFingerprint:group.groupFingerprint};
  }
  return shop.libraryLink({familyId,evidence:data.evidence,variants:[...links,added]});
 }
 throw Error('Operation is not available to a shopping worker.');
}

export const workerTools=[
 {name:'shopping_context',description:'Get the current frozen job context header, or one zero-based context page. Use sourceKey/productKey to focus the WHOLE assigned product job across chains; focus=all restores all assigned jobs. After compaction use reread:true to discard old delivery hints. Refresh after every saved action; read every required page before another proposal.',inputSchema:{type:'object',properties:{section:{type:'string'},page:{type:'integer',minimum:0},refresh:{type:'boolean'},reread:{type:'boolean'},sourceKey:{type:'string'},productKey:{type:'string'},focus:{type:'string',enum:['all']}},additionalProperties:false}},
 {name:'shopping_read',description:'Read complete agent product/group facts, unapproved research or the current assigned campaign. product returns full preserved labels, current productFingerprint, membership receipts and explicit completeTextAvailable/textCompleteness; incomplete/unknown facts need primary research. library-search returns items,total,parked,offset,nextOffset,hasMore,fingerprint: continue with nextOffset and expectedFingerprint until hasMore=false. This search paging differs from large-response readId pages. Large responses have readId/pages; retrieve all needed pages with kind=page. No mutation or cart tools.',inputSchema:{type:'object',properties:{kind:{type:'string',enum:['library-search','product','group','source-candidates','source-offers','profile','research','page']},query:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},expectedFingerprint:{type:'string'},productKey:{type:'string'},groupId:{type:'string'},sourceKey:{type:'string'},readId:{type:'string'},page:{type:'integer',minimum:0}},required:['kind'],additionalProperties:false}},
 {name:'shopping_propose',description:'Submit one explicit proposed domain action. Only the coordinator validates and saves it. placement input: {scopeEvidence,reviewedAllFamilies:true,decisions:[{sourceKey OR sourceKeys:[...],status:reviewed|no-active-family|blocked,evidence,targets:[{familyIndex,equivalenceEvidence}],reason?,retryAt?,noActiveFamilyVerified?}]}. Use explicit source keys; code binds current indexes. reviewed requires at least one actually verified family target. no-active-family requires targets:[], reason and noActiveFamilyVerified:true. blocked requires targets:[], reason and future retryAt; unknown/conflicting facts are blocked. There is no excluded placement status. Before no-active-family, explicitly assess every plausibleFamiliesToAssess recall hint using negativeFamilyAssessments:[{familyIndex,evidence}]. Hints never approve anything; a name can mislead and label words can be negated. If the advertised family fails, independently find the family matching the ACTUAL label form and ingredients. Use a unique proposalId; same ID replays its real receipt. Stale contexts need refresh.',inputSchema:{type:'object',properties:{proposalId:{type:'string'},contextFingerprint:{type:'string'},operation:{type:'string',enum:['placement','source-register','source-review','source-offer-review','family-add-variant','catalog-review']},input:{type:'object',additionalProperties:true}},required:['proposalId','contextFingerprint','operation','input'],additionalProperties:false}},
 {name:'shopping_checkpoint',description:'Preserve concrete label research or a browser/serial handoff for an assigned source. It is not an approval or fresh price receipt. For a real household preference missing from a current researched family, clarification creates one dashboard question per family/topic with 2–6 short options. Reuse its stable key across all products; never ask the family for facts obtainable from labels, prices or code. The answer is not an SKU approval or permission for external actions.',inputSchema:{type:'object',properties:{sourceKey:{type:'string'},evidence:{type:'string'},labelText:{type:'string'},reason:{type:'string'},needsBrowser:{type:'boolean'},clarification:{type:'object',additionalProperties:false,properties:{familyId:{type:'string'},key:{type:'string',enum:SHOPPING_CLARIFICATION_KEYS},question:{type:'string',maxLength:350},reason:{type:'string',minLength:10,maxLength:1200},options:{type:'array',minItems:2,maxItems:6,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},label:{type:'string',maxLength:160},description:{type:'string',maxLength:350},allowText:{type:'boolean'}},required:['id','label']}}},required:['familyId','key','question','reason','options']},sourceReceipts:{type:'array',items:{type:'object',properties:{url:{type:'string'},observedAt:{type:'string'},evidence:{type:'string'}},required:['url','observedAt','evidence'],additionalProperties:false}}},required:['sourceKey','evidence'],additionalProperties:false}}
];
