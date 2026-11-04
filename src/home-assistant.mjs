import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt,loadKey} from './crypto.mjs';

const actions={cover:['open_cover','stop_cover','close_cover','set_cover_position'],media_player:['turn_on','turn_off','media_play_pause','volume_set'],vacuum:['start','pause','return_to_base'],switch:['turn_on','turn_off'],input_datetime:['set_datetime']};
export function createHomeAssistant({config,dataDir,fetchImpl=fetch,readToken,writeToken,now=()=>Date.now(),WebSocketImpl=WebSocket,schedule=setTimeout,cancel=clearTimeout}) {
 const secretPath=join(dataDir,'home-assistant.enc');let cached=null,inflight=null,lastAttempt=0;
 const tokenReader=readToken??(()=>existsSync(secretPath)?JSON.parse(decrypt(readFileSync(secretPath),loadKey(dataDir)).toString()).token:null);
 const tokenWriter=writeToken??(token=>{writeFileSync(secretPath+'.tmp',encrypt(Buffer.from(JSON.stringify({token})),loadKey(dataDir)));renameSync(secretPath+'.tmp',secretPath);});
 let token;try{token=tokenReader();}catch{token=null;}
 const names=new Map(config.entities.map(e=>[e.id,e]));
 const watchers=new Set();let socket=null,retry=null,heartbeat=null,authTimer=null,connectedAt=0,attempt=0,sequence=0,pongAt=0;
 const report=status=>{for(const watcher of watchers)watcher.onStatus?.(status);};
 function disconnect(){cancel(retry);cancel(authTimer);clearInterval(heartbeat);retry=null;heartbeat=null;const previous=socket;socket=null;previous?.close();connectedAt=0;}
 function openEvents(){
  if(socket||!watchers.size||!token)return;
  const current=new WebSocketImpl(config.url.replace(/^http/,'ws')+'/api/websocket');socket=current;
  const reconnect=()=>{if(socket!==current)return;socket=null;connectedAt=0;cancel(authTimer);clearInterval(heartbeat);report('reconnecting');if(watchers.size){retry=schedule(()=>{retry=null;openEvents();},Math.min(30000,1000*2**Math.min(attempt++,5)));retry?.unref?.();}};
  current.addEventListener('close',reconnect);current.addEventListener('error',()=>current.close());
  authTimer=schedule(()=>current.close(),15000);authTimer?.unref?.();
  current.addEventListener('message',({data})=>{
   if(socket!==current)return;let message;try{message=JSON.parse(data);}catch{return;}
   if(message.type==='auth_required')current.send(JSON.stringify({type:'auth',access_token:token}));
   if(message.type==='auth_invalid'){report('error');current.close();}
   if(message.type==='auth_ok'){current.send(JSON.stringify({id:1,type:'subscribe_events',event_type:'state_changed'}));}
   if(message.type==='result'&&message.id===1){
    if(!message.success){report('error');current.close();return;}
    cancel(authTimer);connectedAt=now();pongAt=now();attempt=0;sequence=1;report('connected');
    heartbeat=setInterval(()=>{if(now()-pongAt>45000){current.close();return;}current.send(JSON.stringify({id:++sequence,type:'ping'}));},20000);heartbeat.unref?.();
   }
   if(message.type==='pong')pongAt=now();
   if(message.type!=='event'||message.id!==1||!connectedAt)return;
   const event=message.event,{entity_id:id,new_state:next}=event?.data??{},at=Date.parse(event?.time_fired);
   // Initial/restored states and events queued before this subscription cannot open video.
   if(!next||next.attributes?.restored||!Number.isFinite(at)||at<connectedAt||at>now()+2000||now()-at>5000)return;
   for(const watcher of watchers)if(watcher.ids.has(id))watcher.onEvent(event);
  });
 }
 function watchEntities({entityIds,onEvent,onStatus}){const watcher={ids:new Set(entityIds),onEvent,onStatus};watchers.add(watcher);onStatus?.(!token?'not_configured':connectedAt?'connected':'connecting');openEvents();return ()=>{watchers.delete(watcher);if(!watchers.size)disconnect();};}
 async function publishCameraAlarm(alarm){
  if(!['person','ring'].includes(alarm.kind)||!Number.isFinite(Date.parse(alarm.at))||now()-Date.parse(alarm.at)>30000)throw Error('Ugyldig eller gammel kameraalarm.');
  await request('/api/services/mqtt/publish','POST',{topic:'familien-doorbell/local-alarm',payload:JSON.stringify({event_type:alarm.kind,at:alarm.at,id:alarm.id}),qos:0,retain:false});
 }
 async function discoverCameraAlarms(){
  await request('/api/services/mqtt/publish','POST',{topic:'homeassistant/event/familien_inngang_local_alarm/config',payload:JSON.stringify({name:'Inngang lokal alarm',unique_id:'familien_inngang_local_alarm',state_topic:'familien-doorbell/local-alarm',event_types:['person','ring'],device_class:'doorbell',device:{identifiers:['familien_inngang_local_alarm'],name:'Inngang lokale alarmer',manufacturer:'Reolink'}}),qos:0,retain:true});
 }
 async function request(path,method='GET',data,credential=token){
  if(!credential)throw Error('Home Assistant må kobles til først.');
  let response;try{response=await fetchImpl(config.url+path,{method,headers:{Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(8000),redirect:'error'});}catch{throw Error('Får ikke kontakt med Home Assistant.');}
  if(response.status===401||response.status===403)throw Error('Tilgangen til Home Assistant må fornyes.');
  if(!response.ok)throw Error(`Home Assistant svarte med feil ${response.status}.`);
  return response.json();
 }
 function project(entity){const definition=names.get(entity.entity_id);const a=entity.attributes??{};const attributes={};for(const key of ['unit_of_measurement','current_position','battery_level','volume_level','is_volume_muted','media_title','media_artist','source','supported_features','hour','minute','has_time','has_date'])if(a[key]!==undefined)attributes[key]=a[key];return {...definition,state:entity.state,attributes,lastUpdated:entity.last_updated,available:!['unknown','unavailable'].includes(entity.state)};}
 async function refresh(force=false){
  if(inflight)return inflight;
  if(!token)return {status:'not_configured',message:'Koble til Home Assistant for å se huset her.',entities:[],checkedAt:null,stale:true};
  if(!force&&cached&&now()-lastAttempt<15000)return cached;
  inflight=(async()=>{lastAttempt=now();try{const states=await request('/api/states');if(!Array.isArray(states))throw Error('Home Assistant ga et ugyldig svar.');const available=new Map(states.filter(e=>names.has(e.entity_id)).map(e=>[e.entity_id,project(e)]));cached={status:'ok',stale:false,checkedAt:new Date(now()).toISOString(),entities:config.entities.map(e=>available.get(e.id)??{...e,state:'unavailable',attributes:{},available:false})};}catch(error){cached={status:'error',stale:true,message:error.message,checkedAt:cached?.checkedAt??null,entities:cached?.entities??[]};}return cached;})().finally(()=>{inflight=null;});return inflight;
 }
 async function connect(value){if(typeof value!=='string'||value.length<20||value.length>4096||/\s/.test(value))throw Error('Ugyldig Home Assistant-nøkkel.');const states=await request('/api/states','GET',undefined,value);if(!Array.isArray(states))throw Error('Ugyldig svar fra Home Assistant.');tokenWriter(value);token=value;cached=null;disconnect();openEvents();return refresh(true);}
 async function command(input){
  if(input.action==='return_all'){
    const current=await refresh();const vacuums=config.entities.filter(e=>e.group==='vacuums');
    if(current.stale||!vacuums.length||vacuums.some(v=>!current.entities.find(e=>e.id===v.id)?.available))throw Error('En eller flere støvsugere er utilgjengelige.');
    await request('/api/services/vacuum/return_to_base','POST',{entity_id:vacuums.map(e=>e.id)});cached=null;return refresh(true);
  }
  const definition=names.get(input.entityId);if(!definition)throw Error('Denne enheten er ikke del av familiedashboardet.');
  const domain=input.entityId.split('.')[0];if(!actions[domain]?.includes(input.action))throw Error('Ugyldig handling for enheten.');
  const current=await refresh();if(current.stale||!current.entities.find(e=>e.id===input.entityId)?.available)throw Error('Enheten er utilgjengelig.');
  const data={entity_id:input.entityId};
  if(input.action==='volume_set'){if(typeof input.value!=='number'||!Number.isFinite(input.value)||input.value<0||input.value>1)throw Error('Lydnivå må være mellom 0 og 100 %.');data.volume_level=input.value;}
  if(input.action==='set_cover_position'){if(!Number.isInteger(input.value)||input.value<0||input.value>100)throw Error('Persienneposisjon må være mellom 0 og 100 %.');data.position=input.value;}
  if(input.action==='set_datetime'){if(typeof input.value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value))throw Error('Velg et gyldig klokkeslett.');data.time=input.value+':00';}
  await request(`/api/services/${domain}/${input.action}`,'POST',data);
  cached=null;return refresh(true);
 }
 return {refresh,connect,command,watchEntities,publishCameraAlarm,discoverCameraAlarms,close:()=>{watchers.clear();disconnect();}};
}
