import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {WebSocket as ProxyWebSocket,WebSocketServer} from 'ws';
import {encrypt,decrypt,loadKey} from './crypto.mjs';
import {createDoorbellSmtp} from './doorbell-smtp.mjs';
import {parseDoorbellMail} from './doorbell-mail.mjs';

export function acceptanceReady(report){
 const tested=list=>Array.isArray(list)&&list.filter(t=>t.physical===true&&t.haReceived===true&&Number.isFinite(t.firstFrameMs)&&t.firstFrameMs>=0&&t.firstFrameMs<30000).length>=10&&list.every(t=>t.haReceived===true)&&list.some(t=>t.fromSleep===true);
 return report?.enabled===true&&tested(report.personTests)&&tested(report.ringTests)&&report.uiVerified===true&&report.returnsToSleepVerified===true;
}
export function displayEnabled(report){return report?.enabled===true&&(acceptanceReady(report)||report.userEnabledBeforeTesting===true);}
export function eventAlarm(event,config,now=Date.now()){
 const {entity_id:id,old_state:old,new_state:next}=event?.data??{};const at=Date.parse(event?.time_fired);
 if(!next||next.attributes?.restored||!Number.isFinite(at)||now-at>5000||at>now+2000)return null;
 let kind;
 if(id===config.personEntity&&old?.state==='off'&&next.state==='on')kind='person';
 if(id===config.ringEntity&&next.attributes?.event_type==='press'&&next.state!==old?.state&&!['unknown','unavailable'].includes(next.state))kind='ring';
 if(id===config.localAlarmEntity&&['person','ring'].includes(next.attributes?.event_type)&&next.state!==old?.state)kind=next.attributes.event_type;
 return kind?{id:next.attributes?.id??randomUUID(),kind,at:new Date(at).toISOString(),source:id===config.localAlarmEntity?'smtp':'neolink'}:null;
}
export function createDoorbell({config,dataDir,homeAssistant,fetchImpl=fetch,now=()=>Date.now()}){
 const signals=new EventEmitter(),clients=new Set(),viewers=new Set(),seen=new Map();
 const directory=join(dataDir,'doorbell');mkdirSync(directory,{recursive:true});
 const receiptPath=join(dataDir,'doorbell-acceptance.json'),secretPath=join(dataDir,'doorbell-neolink.enc');
 let smtp=null,stopWatch=null,stopped=false,discoveryTimer=null,smtpRetry=null,haStatus='not_configured',smtpStatus='not_configured',lastAlarm=null,messages=0,unknown=0,neolinkSession=null,sessionPromise=null;
 const report=()=>{try{return JSON.parse(readFileSync(receiptPath));}catch{return {};}};
 const credentials=()=>JSON.parse(decrypt(readFileSync(secretPath),loadKey(dataDir)).toString());
 function trace(entry){try{const file=join(directory,'trace.log');const line=JSON.stringify({at:new Date(now()).toISOString(),...entry})+'\n';let old='';try{old=readFileSync(file,'utf8');}catch{}writeFileSync(file,(old.length>200000?old.slice(-100000):old)+line);}catch{}}
 function evidence(name,value){writeFileSync(join(directory,name+'.enc'),encrypt(Buffer.from(JSON.stringify(value)),loadKey(dataDir)));}
 async function session(){
  if(neolinkSession)return neolinkSession;
  if(sessionPromise)return sessionPromise;
  sessionPromise=(async()=>{const saved=credentials();const r=await fetchImpl(config.neolinkUrl+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:saved.username,password:saved.password}),signal:AbortSignal.timeout(8000),redirect:'error'});if(!r.ok)throw Error('Videobroen avviste innlogging.');const value=await r.json();if(typeof value.token!=='string')throw Error('Videobroen svarte ugyldig.');return neolinkSession=value.token;})().finally(()=>sessionPromise=null);return sessionPromise;
 }
 async function bridgeApi(path,method='GET'){
  for(let attempt=0;attempt<2;attempt++){const token=await session();const r=await fetchImpl(config.neolinkUrl+path,{method,headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000),redirect:'error'});if(r.status===401){neolinkSession=null;continue;}if(!r.ok)throw Error('Videobroen er utilgjengelig.');return r.json();}throw Error('Videotilgangen må fornyes.');
 }
 function alarm(value){
  if(seen.has(value.id))return;seen.set(value.id,now());for(const [id,at] of seen)if(now()-at>60000)seen.delete(id);
  // Native push and SMTP can describe the same physical alarm during video.
  if(lastAlarm?.kind===value.kind&&lastAlarm.source!==value.source&&Math.abs(Date.parse(lastAlarm.at)-Date.parse(value.at))<1500)return;
  lastAlarm=value;evidence('last-alarm',value);signals.emit('alarm',value);trace({event:'alarm',kind:value.kind,source:value.source,id:String(value.id).slice(0,8),sourceTime:value.eventAt??value.at,delivered:displayEnabled(report())});
  if(!displayEnabled(report()))return;
  for(const client of clients)client.write(`event: alarm\ndata: ${JSON.stringify(value)}\n\n`);
 }
 async function mail(raw){
  // Kameraets klokke kan gå feil, og mailen kan bruke mange sekunder: selve ankomsten på den lokale SMTP-serveren er alarmen, så Date-hodet får romslig margin.
  const value=await parseDoorbellMail(raw,{now:now(),maxAgeMs:600000,skewMs:600000});messages++;
  evidence('last-mail',{receivedAt:new Date(now()).toISOString(),...value});
  { // Kameraets egne tider i mailen: hendelsen (i emnet), mailen skrevet (Date) og ankomst her.
    const m=/(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2}):(\d{2})/.exec(value.subject??'');
    const eventMs=m?new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]),Number(m[5]),Number(m[6])).getTime():null;
    trace({event:'mail',kind:value.kind,subjectTime:m?.[0]??null,eventToArrivalSec:eventMs?Math.round((now()-eventMs)/1000):null,composedToArrivalSec:value.at?Math.round((now()-Date.parse(value.at))/1000):null});
  }
  if(!value.kind||!value.fresh||!value.validSender||!value.validRecipient||(!report().confirmedSmtpKinds?.includes(value.kind)&&report().userEnabledBeforeTesting!==true)){unknown++;return;}
  if(seen.has('mail:'+value.id))return;
  seen.set('mail:'+value.id,now());
  // Wake hints only follow an authenticated, type-verified, fresh camera alarm. Kameraet begynner å våkne mens skjermen allerede åpner.
  const wake=bridgeApi('/api/cameras/'+encodeURIComponent(config.cameraName)+'/wake-hint','POST').catch(()=>{});
  // Vis med en gang uten å vente på Home Assistant. Ekkoet fra HA har samme id og slås sammen av alarm().
  const arrivedAt=new Date(now()).toISOString();
  alarm({id:value.id,kind:value.kind,at:arrivedAt,eventAt:value.at,source:'smtp'});
  const published=homeAssistant.publishCameraAlarm({id:value.id,kind:value.kind,at:arrivedAt}).catch(()=>{});
  await Promise.all([wake,published]);
 }
 function discover(){homeAssistant.discoverCameraAlarms().catch(()=>{if(!stopped){discoveryTimer=setTimeout(discover,30000);discoveryTimer.unref();}});}
 async function start(){
  if(!existsSync(secretPath))return;
  stopWatch=homeAssistant.watchEntities({entityIds:[config.personEntity,config.ringEntity,config.localAlarmEntity],onStatus:value=>{haStatus=value;},onEvent:event=>{const value=eventAlarm(event,config,now());if(value)alarm(value);}});
  discover();
  const saved=credentials();if(!saved.smtp)return;
  const listen=async()=>{if(stopped)return;smtp=createDoorbellSmtp({...config.smtp,...saved.smtp,onMessage:mail});try{await smtp.listen();smtpStatus='listening';}catch{smtpStatus='error';smtp.close();smtpRetry=setTimeout(listen,15000);smtpRetry.unref();}};await listen();
 }
 async function status(){let camera=null;try{const all=await bridgeApi('/api/cameras');camera=all.find(c=>c.name===config.cameraName);}catch{}
  return {configured:existsSync(secretPath),automaticEnabled:displayEnabled(report()),testPending:!acceptanceReady(report()),enabledBeforePhysicalTesting:report().userEnabledBeforeTesting===true,haStatus,smtpStatus,messages,unverifiedMessages:unknown,cameraAsleep:camera?.asleep??null,activeVideoConnections:viewers.size,lastAlarm:lastAlarm?{kind:lastAlarm.kind,at:lastAlarm.at}:null,bridgeVersion:'1.1.0',batterySupport:'beta'};
 }
 function sse(req,res){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.write(': connected; no history replay\n\n');clients.add(res);const timer=setInterval(()=>res.write(': heartbeat\n\n'),15000);timer.unref();res.once('close',()=>{clearInterval(timer);clients.delete(res);});}
 const webSockets=new WebSocketServer({noServer:true,maxPayload:1024});
 function attach(server){server.on('upgrade',(req,socket,head)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path!=='/api/doorbell/video'||(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  webSockets.handleUpgrade(req,socket,head,client=>proxy(client));
 });}
 async function proxy(client){
  let upstream=null,timer=null,closed=false,initialized=false;
  const error=message=>{if(client.readyState===1)client.send(JSON.stringify({type:'error',message}));};
  const cleanup=()=>{if(closed)return;closed=true;clearTimeout(timer);signals.off('alarm',extend);viewers.delete(client);upstream?.terminate();if(client.readyState<2)client.close();};
  const expiry=()=>{clearTimeout(timer);timer=setTimeout(cleanup,(config.displaySeconds+2)*1000);timer.unref();};
  const extend=event=>{if(event.kind==='ring')expiry();};
  client.on('close',cleanup);client.on('error',cleanup);client.on('message',()=>client.close(1008,'Video only'));viewers.add(client);signals.on('alarm',extend);expiry();
  try{
   const token=await session();if(closed)return;
   const url=new URL('/api/stream',config.neolinkUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('path',config.streamPath);url.searchParams.set('token',token);
   upstream=new ProxyWebSocket(url,{handshakeTimeout:10000,maxPayload:4*1024*1024});
   upstream.on('message',(data,binary)=>{
    if(closed||client.readyState!==1)return;
    if(client.bufferedAmount>8*1024*1024){error('Videoforbindelsen er for treg.');cleanup();return;}
    if(binary){if(initialized)client.send(data,{binary:true});return;}
    let value;try{value=JSON.parse(data.toString());}catch{return;}
    if(value.type==='init'){initialized=true;client.send(JSON.stringify({type:'init',codec:value.codec,mime:value.mime,width:value.width,height:value.height}));}
    else if(value.type==='error'){error('Direktebildet er utilgjengelig.');cleanup();}
   });
   upstream.on('unexpected-response',(_req,res)=>{if(res.statusCode===401)neolinkSession=null;error('Videobroen avviste forbindelsen.');cleanup();});
   upstream.on('error',()=>{error('Får ikke kontakt med videobroen.');cleanup();});
   upstream.on('close',()=>{if(!closed)error('Videoforbindelsen ble brutt.');cleanup();});
  }catch{error('Får ikke kontakt med videobroen.');cleanup();}
 }
 function recordFrame(input){
  if(!['person','ring'].includes(input.kind)||!Number.isFinite(input.firstFrameMs)||input.firstFrameMs<0||input.firstFrameMs>60000)throw Error('Ugyldig bildemåling.');
  trace({event:'frame',kind:input.kind,firstFrameMs:Math.round(input.firstFrameMs),preview:input.preview===true});
  evidence('last-frame',{kind:input.kind,firstFrameMs:Math.round(input.firstFrameMs),at:new Date(now()).toISOString(),preview:input.preview===true});return {recorded:true};
 }
 function close(){stopped=true;clearTimeout(discoveryTimer);clearTimeout(smtpRetry);stopWatch?.();smtp?.close();for(const client of clients)client.end();clients.clear();for(const viewer of viewers)viewer.terminate();webSockets.close();}
 return {start,status,sse,attach,close,recordFrame,receiveMail:mail};
}
