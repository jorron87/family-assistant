// Physical tests are entered deliberately; previews never count as acceptance.
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DATA_DIR} from '../src/store.mjs';
import {acceptanceReady,displayEnabled} from '../src/doorbell.mjs';
import {decrypt,loadKey} from '../src/crypto.mjs';
const path=join(DATA_DIR,'doorbell-acceptance.json');
const report=existsSync(path)?JSON.parse(readFileSync(path)): {enabled:false,personTests:[],ringTests:[],confirmedSmtpKinds:[],uiVerified:false,returnsToSleepVerified:false};
const command=process.argv[2]??'status';let changed=false;
if(command==='record'){
 const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);const sample=JSON.parse(Buffer.concat(chunks).toString());
 if(!['person','ring'].includes(sample.kind)||sample.physical!==true||sample.preview===true||typeof sample.haReceived!=='boolean'||typeof sample.fromSleep!=='boolean'||!Number.isFinite(Date.parse(sample.at)))throw Error('En test må angi fysisk handling, tidspunkt, hvile og faktisk HA-mottak. Forhåndsvisning teller ikke.');
 if(sample.haReceived&&!Number.isFinite(sample.firstFrameMs))throw Error('Registrer faktisk tid til synlig bilde.');
 report[sample.kind+'Tests'].push({at:sample.at,physical:true,fromSleep:sample.fromSleep,haReceived:sample.haReceived,firstFrameMs:sample.firstFrameMs??null,note:String(sample.note??'').slice(0,500)});if(!report.userEnabledBeforeTesting)report.enabled=false;changed=true;
}else if(command==='confirm-mail'){
 const kind=process.argv[3];const mail=JSON.parse(decrypt(readFileSync(join(DATA_DIR,'doorbell','last-mail.enc')),loadKey(DATA_DIR)).toString());
 if(!['person','ring'].includes(kind)||mail.kind!==kind||!mail.validSender||!mail.validRecipient||!mail.fresh)throw Error('Den siste ekte kamerameldingen bekrefter ikke denne alarmtypen.');
 if(!process.argv.includes('--physical'))throw Error('Bekreft at denne meldingen svarer til en faktisk fysisk test med --physical.');
 report.confirmedSmtpKinds=[...new Set([...report.confirmedSmtpKinds,kind])];if(!report.userEnabledBeforeTesting)report.enabled=false;changed=true;
}else if(command==='verify-ui'||command==='verify-sleep'){
 if(!process.argv.includes('--verified'))throw Error('Bruk --verified bare etter faktisk kontroll.');
 report[command==='verify-ui'?'uiVerified':'returnsToSleepVerified']=true;changed=true;
}else if(command==='enable'){
 if(process.argv.includes('--allow-untested')){report.userEnabledBeforeTesting=true;report.userEnabledAt=new Date().toISOString();}
 else if(!acceptanceReady({...report,enabled:true}))throw Error('Mangler bestått fysisk testserie, hjemmeskjermtest eller bekreftet retur til hvile.');
 report.enabled=true;changed=true;
}else if(command==='disable'){report.enabled=false;changed=true;}
else if(command!=='status')throw Error('Bruk status, record, confirm-mail, verify-ui, verify-sleep, enable eller disable.');
if(changed){report.updatedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify({automaticEnabled:displayEnabled(report),physicalAcceptancePassed:acceptanceReady(report),enabledBeforePhysicalTesting:report.userEnabledBeforeTesting===true,personTests:report.personTests.length,ringTests:report.ringTests.length,personMissed:report.personTests.filter(t=>!t.haReceived).length,ringMissed:report.ringTests.filter(t=>!t.haReceived).length,confirmedSmtpKinds:report.confirmedSmtpKinds,uiVerified:report.uiVerified,returnsToSleepVerified:report.returnsToSleepVerified}));
