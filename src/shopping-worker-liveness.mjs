import {readFileSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';

// This is a bounded liveness hint, never a capability or domain receipt. The
// ordinary authenticated endpoint still checks every actual read and write.
export function hostWorkGrace({file,runId,hostPid,lastHeartbeat,at=Date.now(),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}){
 if(!file||!runId||!Number.isSafeInteger(hostPid)||hostPid<=0||at<lastHeartbeat||at-lastHeartbeat>90000)return false;
 try{
  const work=JSON.parse(readFileSync(file,'utf8')),age=at-work.at;
  return work.version===1&&work.pid===hostPid&&work.runId===runId&&Number.isSafeInteger(work.at)&&Number.isFinite(age)&&age>=0&&age<=90000&&(work.active===true||work.active===false&&age<=10000)&&alive(hostPid);
 }catch{return false;}
}

export function createShoppingHostActivity({dataDir,now=Date.now,pid=process.pid}){
 const file=join(dataDir,'shopping-worker-activity.json'),log=join(dataDir,'shopping-worker-slow-operations.jsonl');let last=null,lastGapMs=0,recording=true;
 function publish({runId,activeRequests}){
  const at=now();if(last&&at-last.at>1000)lastGapMs=at-last.at;
  last={version:1,pid,runId:runId??null,at,active:activeRequests>0,activeRequests};
  try{writeFileSync(file+'.tmp',JSON.stringify(last));renameSync(file+'.tmp',file);recording=true;}catch{recording=false;}
 }
 function slow({kind,startedAt}){const elapsedMs=now()-startedAt;if(elapsedMs<1000)return;try{appendFileSync(log,JSON.stringify({at:new Date(now()).toISOString(),kind,elapsedMs,pid})+'\n');}catch{recording=false;}}
 return {file,publish,slow,status:()=>({recording,lastPublishedAt:last?.at??null,lastGapMs})};
}
