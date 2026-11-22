import {existsSync,readFileSync,renameSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {configPath,readConfig} from '../src/config.mjs';
import {hashPin,PIN_PATTERN} from '../src/finance-access.mjs';

const file=configPath('finance.json');
const cfg=existsSync(file)?readConfig('finance.json'):{enabled:false,owners:[],monthlySavingsNok:null};
const url=new URL('/send/finance/',readConfig('phone-access.json').url);
if (url.protocol!=='https:') throw Error('Sett opp HTTPS for mobilvisningen først.');
const terminal=createInterface({input:stdin,output:stdout});
let muted=false;
const write=terminal._writeToOutput?.bind(terminal);
if (write) terminal._writeToOutput=text=>write(muted&&!/\n/.test(text)?'*'.repeat(text.length):text);
try {
  console.log('Registrer denne returadressen hos Enable Banking: '+url.href);
  console.log('Bruk applikasjonen og nøkkelen til kontoeieren du registrerer. Godkjente voksne får fullt felles innsyn i alle tilkoblede kontoer.');
  console.log('Trykk Enter for å beholde en eksisterende verdi.');
  const ask=async(label,current)=>{const answer=(await terminal.question(label+(current?' ['+current+']':'')+': ')).trim();return answer||current||'';};
  const id=await ask('Stabil voksen-ID (små bokstaver, tall eller bindestrek)');
  if (!/^[a-z0-9-]{1,64}$/.test(id)||Object.hasOwn(Object.prototype,id)) throw Error('Ugyldig voksen-ID.');
  const old=cfg.owners.find(o=>o.id===id)??{};
  const name=await ask('Visningsnavn',old.name);
  const deviceId=await ask('Enhets-ID for den voksnes egen telefon (Profiler → Familieøkonomi), eller tomt for bare PIN',old.deviceId);
  if (deviceId&&(!/^[a-f0-9]{24}$/.test(deviceId)||cfg.owners.some(o=>o.id!==id&&o.deviceId===deviceId))) throw Error('Ugyldig eller allerede tildelt enhet.');
  const applicationId=await ask('Enable Banking Application ID',old.applicationId);
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(applicationId)) throw Error('Ugyldig Application ID.');
  const privateKeyFile=await ask('Absolutt filsti til kontoeierens private RSA-nøkkel',old.privateKeyFile);
  if (!isAbsolute(privateKeyFile)||createPrivateKey(readFileSync(resolve(privateKeyFile))).asymmetricKeyType!=='rsa') throw Error('Velg en privat RSA-nøkkelfil.');
  muted=true;
  const pin=(await terminal.question('Ny PIN for økonomisiden på PC og andre nettlesere (6–12 sifre, tomt for å beholde): ')).trim();
  let pinHash=old.pinHash??null;
  if (pin) {
    const again=(await terminal.question('\nGjenta PIN: ')).trim();
    if (pin!==again) throw Error('PIN-kodene er ulike.');
    if (!PIN_PATTERN.test(pin)) throw Error('PIN-koden må være 6–12 sifre.');
    pinHash=hashPin(pin);
  }
  muted=false;console.log('');
  const agentNow=cfg.agent?.enabled===true;
  const agentAnswer=await ask('Skal økonomiagenten lese alle økonomidata og lage forslag? (JA/nei)',agentNow?'JA':'nei');
  const answer=await ask('Gi denne voksne fullt felles økonomiinnsyn og lagre? Skriv JA');
  if (answer==='JA') {
    const owner={id,name,...(deviceId?{deviceId}:{}),applicationId,privateKeyFile,...(pinHash?{pinHash}:{})};
    const next={...cfg,enabled:true,redirectUrl:url.href,agent:{...(cfg.agent??{}),enabled:agentAnswer==='JA'},owners:[...cfg.owners.filter(o=>o.id!==id),owner]};
    rmSync(file+'.new',{force:true});
    writeFileSync(file+'.new',JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(file+'.new',file);
    console.log('Lagret. Åpne Familieøkonomi på telefonen, eller http://127.0.0.1:4318/okonomi/ på PC-en, og koble til bankene.');
  }
} finally {terminal.close();}
