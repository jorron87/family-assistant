// Setup/preflight tools use the existing dedicated HA key; never export it.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {decrypt,loadKey} from '../src/crypto.mjs';
import {DATA_DIR} from '../src/store.mjs';
export async function connectDoorbellHA(){
 const config=JSON.parse(readFileSync(new URL('../config/home-assistant.json',import.meta.url)));
 const {token}=JSON.parse(decrypt(readFileSync(join(DATA_DIR,'home-assistant.enc')),loadKey(DATA_DIR)).toString());
 const ws=new WebSocket(config.url.replace(/^http/,'ws')+'/api/websocket');
 const pending=new Map();let nextId=1;
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.close();reject(Error('Home Assistant svarte ikke på innlogging.'));},15000);
  ws.addEventListener('error',()=>reject(Error('Home Assistant WebSocket utilgjengelig.')),{once:true});
  ws.addEventListener('message',({data})=>{
   const m=JSON.parse(data);
   if(m.type==='auth_required')ws.send(JSON.stringify({type:'auth',access_token:token}));
   if(m.type==='auth_ok'){clearTimeout(timer);resolve();}
   if(m.type==='auth_invalid'){clearTimeout(timer);ws.close();reject(Error('Home Assistant avviste eksisterende nøkkel.'));}
   if(m.type==='result'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.success?p.resolve(m.result):p.reject(Error(`HA ${p.type}: ${m.error?.code??'error'}`));}}
   if(m.type==='event')pending.get(m.id)?.onEvent?.(m.event);
  });
 });
 function send(command,{timeout=20000,onEvent}={}){
  const id=nextId++;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('Home Assistant forespørsel tok for lang tid.'));},timeout);
   pending.set(id,{resolve,reject,timer,onEvent,type:command.type});ws.send(JSON.stringify({id,...command}));
  }).then(result=>{if(onEvent)pending.set(id,{onEvent});return result;});
 }
 async function rest(path,method='GET',body){
  const response=await fetch(config.url+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error(`Home Assistant ${path}: ${response.status}`);
  return response.json();
 }
 return {send,rest,close:()=>ws.close(),supervisor:(endpoint,method='get',data,timeout=20000)=>send({type:'supervisor/api',endpoint,method,...(data?{data}:{}),timeout},{timeout:timeout+2000})};
}
