// LAN-only alarm intake. This server never relays or sends mail.
import {createServer} from 'node:net';
import {timingSafeEqual} from 'node:crypto';

const same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export function createDoorbellSmtp({host='127.0.0.1',port=2525,cameraIp='192.0.2.28',username,password,recipient='dashboard@doorbell.local',onMessage,onConnection=()=>{},onDiagnostic=()=>{}}){
 const sockets=new Set();
 const server=createServer(socket=>{
  if(socket.remoteAddress?.replace(/^::ffff:/,'')!==cameraIp){socket.end('554 Camera only\r\n');return;}
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(20000,()=>socket.destroy());
  onConnection();let pending='',phase='command',user='',authenticated=false,sender=false,rcpt=false,lines=[],size=0;
  const reply=value=>{onDiagnostic({reply:value.slice(0,3),phase});socket.write(value+'\r\n');};
  const reset=()=>{sender=false;rcpt=false;lines=[];size=0;};
  const login=(u,p)=>{authenticated=same(u,username)&&same(p,password);phase='command';reply(authenticated?'235 Authentication successful':'535 Authentication failed');};
  reply('220 doorbell.local ESMTP alarm intake');
  socket.on('data',chunk=>{
   pending+=chunk.toString('utf8');if(pending.length>65536){socket.destroy();return;}
   for(let at;(at=pending.indexOf('\r\n'))>=0;){
    const line=pending.slice(0,at);pending=pending.slice(at+2);
    if(phase==='data'){
     if(line==='.'){
      phase='command';const message=lines.join('\r\n');reset();
      // A failed local delivery asks the camera to retry, never claims success.
      phase='delivering';Promise.resolve().then(()=>onMessage(message)).then(()=>{phase='command';reply('250 Alarm accepted');},()=>{phase='command';reply('451 Alarm intake unavailable');});
     }else{size+=Buffer.byteLength(line)+2;if(size>1024*1024){reply('552 Alarm too large');socket.destroy();return;}lines.push(line.startsWith('..')?line.slice(1):line);}
     continue;
    }
    if(phase==='delivering'){reply('503 Delivery in progress');continue;}
    if(phase==='auth-user'){user=Buffer.from(line,'base64').toString();phase='auth-pass';reply('334 UGFzc3dvcmQ6');continue;}
    if(phase==='auth-pass'){login(user,Buffer.from(line,'base64').toString());continue;}
    if(phase==='auth-plain'){const fields=Buffer.from(line,'base64').toString().split('\0');login(fields.at(-2)??'',fields.at(-1)??'');continue;}
    const [verb,...rest]=line.split(' '),arg=rest.join(' ');
    onDiagnostic({command:verb.toUpperCase(),phase,...(verb.toUpperCase()==='AUTH'?{authType:rest[0]}:{})});
    switch(verb.toUpperCase()){
     case 'EHLO':reply('250-doorbell.local\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 1048576');break;
     case 'HELO':reply('250 doorbell.local');break;
     case 'AUTH':{
      const [type,value]=arg.split(' ');
      if(type?.toUpperCase()==='LOGIN'){if(value){user=Buffer.from(value,'base64').toString();phase='auth-pass';reply('334 UGFzc3dvcmQ6');}else{phase='auth-user';reply('334 VXNlcm5hbWU6');}}
      else if(type?.toUpperCase()==='PLAIN'){if(value){const fields=Buffer.from(value,'base64').toString().split('\0');login(fields.at(-2)??'',fields.at(-1)??'');}else{phase='auth-plain';reply('334');}}
      else reply('504 Unsupported authentication');break;
     }
     case 'MAIL':if(!authenticated)reply('530 Authentication required');else if(/^FROM:/i.test(arg)){reset();sender=true;reply('250 Sender accepted');}else reply('501 Invalid sender');break;
     case 'RCPT':{
      const path=arg.match(/^TO:\s*(?:<([^<>]+)>|([^\s<>]+))(?:\s+.*)?$/i);
      if(sender&&((path?.[1]??path?.[2])?.toLowerCase()===recipient.toLowerCase())){rcpt=true;reply('250 Recipient accepted');}else reply('550 Local recipient only');break;
     }
     case 'DATA':if(authenticated&&sender&&rcpt){phase='data';reply('354 End with dot');}else reply('503 MAIL and RCPT required');break;
     case 'RSET':reset();phase='command';reply('250 Reset');break;
     case 'NOOP':reply('250 OK');break;
     case 'QUIT':socket.end('221 Bye\r\n');break;
     default:reply('502 Unsupported command');
    }
   }
  });
 });
 return {listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);}),close:()=>{for(const socket of sockets)socket.destroy();server.close();},address:()=>server.address()};
}
