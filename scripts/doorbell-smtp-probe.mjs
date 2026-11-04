// Bounded diagnostic: full alarm text is encrypted, terminal gets field names only.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {DATA_DIR} from '../src/store.mjs';
import {encrypt,decrypt,loadKey} from '../src/crypto.mjs';
import {createDoorbellSmtp} from '../src/doorbell-smtp.mjs';
const key=loadKey(DATA_DIR),path=join(DATA_DIR,'doorbell-neolink.enc');
const saved=JSON.parse(decrypt(readFileSync(path),key).toString());
if(!saved.smtp){saved.smtp={username:'camera@doorbell.local',password:randomBytes(24).toString('base64url')};writeFileSync(path,encrypt(Buffer.from(JSON.stringify(saved)),key));}
const directory=join(process.env.LOCALAPPDATA,'Familien','doorbell');mkdirSync(directory,{recursive:true});
const receiver=createDoorbellSmtp({...saved.smtp,onDiagnostic:d=>console.log(JSON.stringify({at:new Date().toISOString(),type:'smtp_protocol',...d})),onConnection:()=>console.log(JSON.stringify({at:new Date().toISOString(),type:'smtp_connection'})),onMessage:message=>{
 const file=join(directory,'smtp-'+Date.now()+'.enc');writeFileSync(file,encrypt(Buffer.from(JSON.stringify({receivedAt:new Date().toISOString(),message})),key));
 console.log(JSON.stringify({at:new Date().toISOString(),type:'smtp_message',bytes:Buffer.byteLength(message),savedEncrypted:true}));
}});
await receiver.listen();console.log(JSON.stringify({listening:true,port:2525,relay:false,automaticDashboardEnabled:false}));
const timer=setTimeout(()=>{receiver.close();console.log(JSON.stringify({finished:true}));},Math.min(3600,Math.max(30,Number(process.argv[2])||900))*1000);
process.on('SIGINT',()=>{clearTimeout(timer);receiver.close();});
