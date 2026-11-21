import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {createPrivateKey} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {configPath,readConfig} from '../src/config.mjs';

const file=configPath('finance.json');
const cfg=existsSync(file)?readConfig('finance.json'):{enabled:false,owners:[],monthlySavingsNok:null};
const url=new URL('/send/finance/',readConfig('phone-access.json').url);
if (url.protocol!=='https:') throw Error('Sett opp HTTPS for mobilvisningen først.');
const terminal=createInterface({input:stdin,output:stdout});
try {
  console.log('Registrer denne returadressen hos Enable Banking: '+url.href);
  console.log('Bruk applikasjonen og nøkkelen til kontoeieren du registrerer. Godkjente voksentelefoner får fullt felles innsyn.');
  const ask=async label=>(await terminal.question(label+': ')).trim();
  const id=await ask('Stabil voksen-ID (små bokstaver, tall eller bindestrek)');
  if (!/^[a-z0-9-]{1,64}$/.test(id)||Object.hasOwn(Object.prototype,id)) throw Error('Ugyldig voksen-ID.');
  const name=await ask('Visningsnavn');
  const deviceId=await ask('Enhets-ID vist på den voksnes egen telefon under Profiler → Familieøkonomi');
  if (!/^[a-f0-9]{24}$/.test(deviceId)||cfg.owners.some(o=>o.id!==id&&o.deviceId===deviceId)) throw Error('Ugyldig eller allerede tildelt enhet.');
  const applicationId=await ask('Enable Banking Application ID');
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(applicationId)) throw Error('Ugyldig Application ID.');
  const privateKeyFile=await ask('Absolutt filsti til kontoeierens private RSA-nøkkel');
  if (!isAbsolute(privateKeyFile)||createPrivateKey(readFileSync(resolve(privateKeyFile))).asymmetricKeyType!=='rsa') throw Error('Velg en privat RSA-nøkkelfil.');
  const answer=await ask('Gi denne telefonen felles økonomiinnsyn og lagre? Skriv JA');
  if (answer==='JA') {
    const owner={id,name,deviceId,applicationId,privateKeyFile};
    const next={...cfg,enabled:true,redirectUrl:url.href,owners:[...cfg.owners.filter(o=>o.id!==id),owner]};
    writeFileSync(file+'.new',JSON.stringify(next,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(file+'.new',file);
    console.log('Lagret. Åpne Familieøkonomi på telefonen og velg Koble til.');
  }
} finally {terminal.close();}
