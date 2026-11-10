// An explicit per-source review in a full run is a source receipt too.
// Never infer full review from a collector probe or a change-only run.
const sources=new Set(['vigilo','spond','facebook','renovasjon']);
const health=new Set(['ok','partial','needs_login','error']);
const text=(value,max)=>String(value??'').trim().slice(0,max);
export function reconcileSourceReviews(status,runs,at=Date.now()){
 let changed=0;
 for(const run of [...runs].sort((a,b)=>Date.parse(a.finishedAt)-Date.parse(b.finishedAt))){
  const finished=Date.parse(run.finishedAt);
  if(run.scope!=='alle'||run.sourcePhase!=null||!health.has(run.outcome)||!run.id||!Number.isFinite(finished)||finished>at||!Array.isArray(run.sources))continue;
  for(const entry of run.sources){
   if(!entry||typeof entry!=='object'||!sources.has(entry.source)||!health.has(entry.health)||text(entry.details,3000).length<12)continue;
   if(run.sources.filter(row=>row?.source===entry.source).length!==1)continue;
   const previous=status[entry.source];
   if((Date.parse(previous?.checkedAt)||0)>=finished)continue;
   status[entry.source]={source:entry.source,health:entry.health,historicalOnly:false,checkedAt:run.finishedAt,
    scope:text(entry.scope??previous?.scope,2000),details:text(entry.details,3000),
    seenCount:Number.isInteger(entry.seenCount)&&entry.seenCount>=0?entry.seenCount:null,
    oldestCoveredAt:null,newestCoveredAt:null,reviewRunId:run.id};
   changed++;
  }
 }
 return changed;
}
