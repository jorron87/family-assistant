// Physical-event observation only. This does not change/enable the dashboard.
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {decrypt,loadKey} from '../src/crypto.mjs';
import {DATA_DIR} from '../src/store.mjs';
import {connectDoorbellHA} from './doorbell-ha-client.mjs';
const saved=JSON.parse(decrypt(readFileSync(join(DATA_DIR,'doorbell-neolink.enc')),loadKey(DATA_DIR)).toString());
const outputDir=join(process.env.LOCALAPPDATA,'Familien','doorbell');mkdirSync(outputDir,{recursive:true});
const output=join(outputDir,'preflight-'+new Date().toISOString().replaceAll(':','-')+'.jsonl');
const record=value=>{const line=JSON.stringify({observedAt:new Date().toISOString(),...value});appendFileSync(output,line+'\n');console.log(line);};
const duration=Number(process.argv[2]??900);
if(!Number.isFinite(duration)||duration<1||duration>3600)throw Error('Varighet må være 1–3600 sekunder.');
const diagnosticVideoSeconds=Number(process.argv.find(a=>a.startsWith('--video-seconds='))?.split('=')[1]??30);
if(!Number.isFinite(diagnosticVideoSeconds)||diagnosticVideoSeconds<1||diagnosticVideoSeconds>300)throw Error('Videotest må være 1–300 sekunder.');
const ha=await connectDoorbellHA();
const relevant=/^(binary_sensor\.inngang_(person|motion|visitor|asleep)|event\.inngang_doorbell|sensor\.inngang_battery)$/;
let activeStream=null,streamClosing=false;
function streamTest(trigger){
 if(activeStream){record({type:'video_already_open',trigger});return;}
 const started=Date.now();let chunks=0,bytes=0,first=null;
 streamClosing=false;
 const url=new URL('http://127.0.0.1:8655/api/stream');url.protocol='ws:';url.searchParams.set('path','/Inngang/subStream');url.searchParams.set('token',saved.token);
 const ws=new WebSocket(url);activeStream=ws;
 const timer=setTimeout(()=>{streamClosing=true;ws.close();},(trigger==='manual_video_test'?diagnosticVideoSeconds:30)*1000);
 ws.addEventListener('message',async({data})=>{
  if(typeof data==='string'){
   let m;try{m=JSON.parse(data);}catch{return;}
   if(m.type==='init')record({type:'video_format',codec:m.codec,width:m.width,height:m.height});
   if(m.type==='error')record({type:'video_error',message:'Neolink rapporterte en strømfeil.'});
  }else{chunks++;bytes+=data.size??data.byteLength??0;if(first===null){first=Date.now()-started;record({type:'first_video_fragment',trigger,latencyMs:first});}}
 });
 ws.addEventListener('error',()=>{if(!streamClosing)record({type:'video_error',message:'WebSocket-strømmen feilet.'});});
 ws.addEventListener('close',()=>{clearTimeout(timer);activeStream=null;record({type:'video_closed',trigger,chunks,bytes,firstFragmentMs:first});});
}
try{
 const states=await ha.rest('/api/states');record({type:'initial_states',states:states.filter(s=>relevant.test(s.entity_id)).map(s=>({id:s.entity_id,state:s.state}))});
 await ha.send({type:'subscribe_events',event_type:'state_changed'},{onEvent:event=>{
  const {entity_id:id,old_state:old,new_state:next}=event.data??{};
  if(!relevant.test(id??'')||!next)return;
  record({type:'ha_state',id,from:old?.state??null,to:next.state,eventType:next.attributes?.event_type??null,sourceTime:event.time_fired});
  // Registry discovery/initial values/reconnections do not count as events.
  if(old&&!['unknown','unavailable'].includes(old.state)&&id==='binary_sensor.inngang_person'&&old.state==='off'&&next.state==='on')streamTest('person');
  if(old&&id==='event.inngang_doorbell'&&next.attributes?.event_type==='press'&&next.state!==old.state&&!['unknown','unavailable'].includes(next.state))streamTest('ring');
 }});
 await ha.send({type:'mqtt/subscribe',topic:'familien-doorbell/inngang/#',qos:0},{onEvent:event=>{
  // Keep only alarm/sleep telemetry, not snapshots or arbitrary payloads.
  const label=event.topic?.split('/').at(-1);
  if(!['person','motion','visitor','doorbell','asleep','state','battery'].includes(label))return;
  record({type:'mqtt_message',topic:event.topic,payload:event.payload,retained:event.retain});
  if(label==='doorbell'&&!event.retain){
   let payload;try{payload=JSON.parse(event.payload);}catch{return;}
   if(payload.event_type==='press')streamTest('ring_mqtt');
  }
 }});
 record({type:'armed',durationSeconds:duration,automaticDashboardEnabled:false});
 if(process.argv.includes('--video'))streamTest('manual_video_test');
 await new Promise(resolve=>{const timer=setTimeout(resolve,duration*1000);process.once('SIGINT',()=>{clearTimeout(timer);resolve();});});
}finally{streamClosing=true;activeStream?.close();ha.close();record({type:'finished'});}
