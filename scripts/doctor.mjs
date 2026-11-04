import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const check=(name,ok)=>{console.log((ok?'OK ':'FIX ')+name);if(!ok)process.exitCode=1;};
check('Node.js 24+',Number(process.versions.node.split('.')[0])>=24);
check('Windows DPAPI (Windows host required)',process.platform==='win32');
for(const name of ['profile','sources','collector','activity-sources','activity-feeds','home-assistant','doorbell','phone-access','weather','agent']){const p=new URL('../config/'+name+'.json',import.meta.url);check('config/'+name+'.json',existsSync(p));if(existsSync(p))try{JSON.parse(readFileSync(p,'utf8'));}catch{check(name+' valid JSON',false);}}
const profilePath=new URL('../config/profile.json',import.meta.url);if(existsSync(profilePath)){const p=JSON.parse(readFileSync(profilePath));check('Stable unique member IDs',Array.isArray(p.members)&&p.members.length>0&&new Set(p.members.map(m=>m.id)).size===p.members.length);}
const configPath=new URL('../config/agent.json',import.meta.url);if(existsSync(configPath)){const a=JSON.parse(readFileSync(configPath));console.log('Agent automation: '+(a.enabled?'ENABLED; verify your executable, model and permission choices':'disabled'));}
