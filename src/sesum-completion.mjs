// Collection proves source reading only. Product equivalence, actual price age
// and campaign terms keep their independent review contracts.
export function sesumCollectionCompletion(status,expectedFamilies=[]) {
  if(status?.enabled===false)return {enabled:false,complete:true,status:'disabled',pending:false,blocked:false};
  if(status?.enabled!==true)return {enabled:true,complete:false,status:'unavailable',pending:false,blocked:true,reason:'collector-status-unavailable'};
  const manifest=Array.isArray(status.manifest)?status.manifest:[],byId=new Map(manifest.map(f=>[f.familyId,f]));
  const changedFamilies=expectedFamilies.filter(f=>{
    const observed=byId.get(f.familyId);
    return !observed||f.requirementsFingerprint&&observed.fingerprint!==f.requirementsFingerprint;
  }).map(f=>f.familyId);
  const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
  const jobCounts=Object.fromEntries(['pending','partial','blocked'].map(key=>[key,count(status.jobCounts?.[key])]));
  const replayPendingCount=count(status.replayPendingCount),families=manifest.map(f=>({familyId:f.familyId,collectionStatus:f.collectionStatus,collectionOutcome:f.collectionOutcome}));
  const pending=changedFamilies.length>0||status.planCurrent===false||status.refreshDue===true||jobCounts.pending>0||replayPendingCount>0||['collecting','not_started'].includes(status.status)||families.some(f=>f.collectionStatus==='pending');
  const blocked=jobCounts.partial>0||jobCounts.blocked>0||status.status==='partial'||families.some(f=>['partial','blocked'].includes(f.collectionStatus));
  const complete=status.status==='complete'&&!pending&&!blocked&&families.every(f=>f.collectionStatus==='complete');
  // Unknown or contradictory terminal status is a rest, never a success.
  return {enabled:true,complete,status:status.status??'unavailable',runId:status.runId??null,pending,blocked:blocked||!complete&&!pending,jobCounts,replayPendingCount,changedFamilies,planCurrent:status.planCurrent??null,refreshDue:status.refreshDue===true,nextRefreshAt:status.nextRefreshAt??null,families,coverageNote:'Innhenting er kildekontroll, ikke godkjent ekvivalens, fersk prisdekning eller lokal lagerstatus.'};
}
