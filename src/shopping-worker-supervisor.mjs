import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,dirname} from 'node:path';
import {hostWorkGrace} from './shopping-worker-liveness.mjs';
const spec=JSON.parse(readFileSync(process.argv[2],'utf8')),directory=dirname(process.argv[2]),started=Date.now();
const metrics={model:spec.model,reasoningEffort:spec.reasoningEffort,promptBytes:Buffer.byteLength(spec.prompt),toolCalls:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningTokens:0};
let buffer='',stopped=false,lastHeartbeat=Date.now(),heartbeatBusy=false,errorNote=null,hostPid=spec.hostPid;
const child=spawn(spec.executable,spec.args,{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe'],env:process.env});
const stop=reason=>{if(stopped)return;stopped=true;errorNote=reason;child.kill();};
async function heartbeat(){
 if(heartbeatBusy||stopped)return;heartbeatBusy=true;
 try{const r=await fetch(process.env.FAMILIEN_WORKER_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Worker':process.env.FAMILIEN_WORKER_TOKEN},body:JSON.stringify({workerId:process.env.FAMILIEN_WORKER_ID,call:'heartbeat',input:{}}),signal:AbortSignal.timeout(4000)});if(!r.ok)stop('Worker capability revoked.');else{const pulse=await r.json();if(pulse.runId===spec.runId&&Number.isSafeInteger(pulse.hostPid)&&pulse.hostPid>0)hostPid=pulse.hostPid;lastHeartbeat=Date.now();}}
 catch{if(Date.now()-lastHeartbeat>30000){if(hostWorkGrace({file:spec.activityPath,runId:spec.runId,hostPid,lastHeartbeat}))metrics.hostBusyGraceUses=(metrics.hostBusyGraceUses??0)+1;else stop('Coordinator heartbeat unavailable.');}}finally{heartbeatBusy=false;}
}
child.stdout.on('data',chunk=>{buffer+=chunk.toString();const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){let e;try{e=JSON.parse(line);}catch{continue;}if(e.type==='item.completed'&&e.item?.type!=='agent_message'&&e.item?.type!=='reasoning')metrics.toolCalls++;if(e.type==='turn.completed')for(const [key,field]of [['inputTokens','input_tokens'],['cachedInputTokens','cached_input_tokens'],['outputTokens','output_tokens'],['reasoningTokens','reasoning_output_tokens']])if(Number.isSafeInteger(e.usage?.[field]))metrics[key]+=e.usage[field];if(e.type==='error'||e.type==='turn.failed')errorNote='Worker runtime reported an error.';}if(buffer.length>1000000)buffer='';});
child.stderr.resume();child.stdin.on('error',()=>{});
const closed=new Promise(resolve=>{child.once('error',()=>{errorNote='Worker could not start.';resolve(-1);});child.once('close',resolve);});
const pulse=setInterval(heartbeat,5000),deadline=setTimeout(()=>stop('Worker deadline reached.'),spec.deadlineMs);child.stdin.end(spec.prompt);await heartbeat();
const code=await closed;clearInterval(pulse);clearTimeout(deadline);
writeFileSync(join(directory,'exit.json'),JSON.stringify({code,error:errorNote,metrics:{...metrics,elapsedMs:Date.now()-started}}),'utf8');
process.exitCode=code===0&&!errorNote?0:1;
