// Encrypted handoff of a newly approved UI-generated integration credential.
import {generateKeyPairSync,privateDecrypt,constants} from 'node:crypto';
import {readFileSync,writeFileSync,unlinkSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {encrypt,decrypt,loadKey} from '../src/crypto.mjs';
import {createHomeAssistant} from '../src/home-assistant.mjs';
import {DATA_DIR} from '../src/store.mjs';
const paths={public:resolve('artifacts/ha-handoff-public.pem'),private:resolve('artifacts/ha-handoff-private.enc'),sealed:resolve('artifacts/ha-handoff-sealed.bin')};
const key=loadKey(DATA_DIR);
if(process.argv[2]==='prepare'){
 mkdirSync(resolve('artifacts'),{recursive:true});
 const pair=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 writeFileSync(paths.public,pair.publicKey);writeFileSync(paths.private,encrypt(Buffer.from(pair.privateKey),key));process.stdout.write('Encrypted handoff ready.');
}else if(process.argv[2]==='connect'){
 try{
  const token=privateDecrypt({key:decrypt(readFileSync(paths.private),key),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},readFileSync(paths.sealed)).toString();
  const config=JSON.parse(readFileSync(resolve('config/home-assistant.json')));
  const adapter=createHomeAssistant({config,dataDir:DATA_DIR});const result=await adapter.connect(token);
  process.stdout.write(JSON.stringify({connected:result.status==='ok',available:result.entities.filter(e=>e.available).map(e=>({id:e.id,name:e.name,state:e.state})),unavailable:result.entities.filter(e=>!e.available).map(e=>e.id)}));
 }finally{for(const path of Object.values(paths))if(existsSync(path))unlinkSync(path);}
}else throw Error('Bruk prepare eller connect.');
