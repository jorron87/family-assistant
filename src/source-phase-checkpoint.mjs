import {createHash} from 'node:crypto';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value??null;
const entries=(value,map)=>Object.entries(value??{}).sort(([a],[b])=>a.localeCompare(b)).map(([key,row])=>[key,map(row)]);
export function activitySourcePhaseRows(state){
  return Object.entries(state.activitySourceStatus??{}).sort(([a],[b])=>a.localeCompare(b)).map(([sourceId,row])=>({sourceId,health:row.health??null,details:row.details??null,scanTo:row.scanTo??null,nextPageHint:row.nextPageHint??null,unresolvedItems:(row.unresolvedItems??[]).map(item=>({externalId:item.externalId,reason:item.reason})).sort((a,b)=>a.externalId.localeCompare(b.externalId))}));
}
// Only source and family-action semantics belong here. Shopping prices, product
// reviews, fetch timestamps, run logs and a new lease must not reopen a source
// phase. Actual new/changed source content or a family action must reopen it.
export function sourcePhaseFingerprint(state){
  const basis={
    sources:entries(state.sourceStatus,row=>[row.health,row.scope,row.details,row.historicalOnly]),
    surfaces:entries(state.surfaces,row=>[row.source,row.surface,row.health,row.blocker,row.nextPageHint,row.currentComplete,row.historicalGap,row.scanTo,row.listingHash]),
    raw:entries(state.rawItems,row=>[row.revision,row.discardedAt,row.driveUrl,row.driveRevision,row.profileReviewedRevision,row.expectedOriginals,(row.attachments??[]).map(a=>[a.id,a.sha256,a.driveUrl,a.contentError])]),
    reviews:entries(state.reviewLedger,row=>[row.source,row.surface,row.externalId,row.listingHash,row.reviewedHash,row.needsReview,row.relevance]),
    events:entries(state.events,row=>[row.fingerprint,row.visibility,row.calendar,row.mergedInto]),
    profile:state.profile,
    activities:state.activities,
    activitySources:activitySourcePhaseRows(state),
    activityPages:entries(state.activityFeed?.pages,row=>[row.hash,row.reviewedHash,typeof row.error==='object'?row.error?.message:row.error]),
    activityCandidates:entries(state.activityFeed?.hsia?.items,row=>[row.hash,row.reviewedHash,row.reviewedOccurrences,row.removedOccurrences]),
    phone:entries(state.phone?.inbox,row=>[row.rawId,row.status,row.submittedAt,row.result]),
    stock:entries(state.shopping?.stockIntakes,row=>[row.status,row.submittedAt,row.reviewedAt,row.result])
  };
  return createHash('sha256').update(JSON.stringify(canonical(basis))).digest('hex');
}

export function currentSourcePhase(state,at=Date.now()){
  const fingerprint=sourcePhaseFingerprint(state),checkpoint=state.sourcePhaseCheckpoint;
  const checked=Date.parse(checkpoint?.checkedAt),started=Date.parse(checkpoint?.startedAt),day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const current=checkpoint?.version===1&&typeof checkpoint.runId==='string'&&checkpoint.runId.length>0&&checkpoint.fingerprint===fingerprint&&Number.isFinite(started)&&Number.isFinite(checked)&&started<=checked&&at>=checked&&at-checked<=12*3600000&&day(at)===day(checked);
  return {fingerprint,current,checkpoint:current?structuredClone(checkpoint):null};
}
