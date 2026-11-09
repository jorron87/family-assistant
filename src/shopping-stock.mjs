import {createHash,randomUUID} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const text=(value,max=2000)=>String(value??'').normalize('NFC').trim().slice(0,max);
const required=(value,label)=>{const result=text(value);if(!result)throw Error(`${label} mangler.`);return result;};
const stockVersion=w=>hash(JSON.stringify([w.stockAmount,w.stockCheckedAt,w.stockPacks]));
const mimeOf=bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;

// Inventory submissions have their own encrypted originals and receipts. They
// never become calendar submissions or silently create shopping/cart actions.
export function createStockIntake(state,{save,now,files,watches,currentStock,apply}) {
 state.stockIntakes??={};
 const all=()=>Object.values(state.stockIntakes);
 const find=id=>{if(typeof id!=='string'||!Object.hasOwn(state.stockIntakes,id))throw Error('Ukjent lagertelling.');return state.stockIntakes[id];};
 const update=fn=>{const result=fn();save();return structuredClone(result);};
 const summary=item=>{const {baseStocks,clientId,...rest}=item;return structuredClone(rest);};
 const work=()=>all().filter(x=>x.status==='queued');
 function begin(input) {
  const clientId=required(input.clientId,'Innsendings-ID');if(!/^[a-zA-Z0-9-]{16,100}$/.test(clientId))throw Error('Ugyldig innsending.');
  const body=text(input.text),location=text(input.location,120),count=input.fileCount??0;
  const existing=all().find(x=>x.clientId===clientId);if(existing){if(existing.text!==body||existing.location!==location||existing.fileCount!==count||existing.mode!==(input.mode??'minimum'))throw Error('Innsendings-ID er allerede brukt med annet innhold. Tøm skjemaet og send på nytt.');return summary(existing);}
  if(!Number.isInteger(count)||count<0||count>8||(!body&&!count))throw Error('Skriv hva du har, eller velg opptil åtte bilder.');
  if(!['minimum','replace'].includes(input.mode??'minimum'))throw Error('Ugyldig tellemetode.');
  const item={id:randomUUID(),clientId,text:body,location,mode:input.mode??'minimum',senderMemberId:input.senderMemberId??null,fileCount:count,images:[],status:'uploading',createdAt:now().toISOString(),submittedAt:null,attempts:0,retryAt:null,note:null,result:null};
  return update(()=>{state.stockIntakes[item.id]=item;return summary(item);});
 }
 function upload(id,slot,{bytes,fileName}) {
  const item=find(id);if(item.status!=='uploading')throw Error('Tellingen er allerede sendt.');
  if(!Number.isInteger(slot)||slot<0||slot>=item.fileCount||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>10*1024*1024)throw Error('Ugyldig bilde eller bildestørrelse (maks 10 MB).');
  const mimeType=mimeOf(bytes);if(!mimeType)throw Error('Bruk JPG, PNG eller WebP. Eksporter HEIC som JPG først.');
  const sha256=hash(bytes),previous=item.images.find(x=>x.slot===slot);
  if(previous){if(previous.sha256!==sha256)throw Error('Bildeplassen er allerede brukt.');return structuredClone(previous);}
  if(item.images.reduce((n,x)=>n+x.size,0)+bytes.length>40*1024*1024)throw Error('Bildene kan samlet være høyst 40 MB.');
  if(!files)throw Error('Bildelagring er ikke konfigurert.');
  const image={id:randomUUID(),slot,fileName:text(fileName,180)||'lagerbilde',mimeType,sha256,size:bytes.length};
  files.write(image.id,bytes);
  return update(()=>{item.images.push(image);return image;});
 }
 function submit(id) {
  const item=find(id);if(item.status!=='uploading')return summary(item);
  if(item.images.length!==item.fileCount)throw Error('Vent til alle bildene er lastet opp.');
  return update(()=>{item.status='queued';item.submittedAt=now().toISOString();item.baseStocks=Object.fromEntries(Object.values(watches()).map(w=>[w.id,stockVersion(w)]));return summary(item);});
 }
 function image(id,imageId) {
  const item=find(id),attachment=item.images.find(x=>x.id===imageId);if(!attachment||!files)throw Error('Ukjent lagerbilde.');
  return {attachment:structuredClone(attachment),bytes:files.read(attachment.id)};
 }
 function review(input) {
  const item=find(input.id);if(item.result)return summary(item);
  if(!['queued','needs_input'].includes(item.status))throw Error('Tellingen er ikke klar for gjennomgang.');
  const evidence=required(input.evidence,'Gjennomgangsbelegg'),imageIds=input.imageIds;
  if(!Array.isArray(imageIds)||new Set(imageIds).size!==imageIds.length||imageIds.length!==item.images.length||item.images.some(x=>!imageIds.includes(x.id)))throw Error('Alle bildene må leses før lagertellingen kvitteres.');
  const observations=input.observations??[],unmatched=input.unmatched??[];
  if(!Array.isArray(observations)||observations.length>200||!Array.isArray(unmatched)||unmatched.length>200||!observations.length&&!unmatched.length)throw Error('Registrer observasjoner eller hva som må avklares.');
  const groups=new Map();
  for(const o of observations){
   const w=Object.hasOwn(watches(),o.watchId)?watches()[o.watchId]:null;if(!w)throw Error('Ukjent varegruppe i lagertelling.');
   if(typeof o.amount!=='number'||!Number.isFinite(o.amount)||o.amount<0||o.amount>100000||o.unit!==w.unit||!['certain','estimated'].includes(o.confidence))throw Error('Oppgi en begrunnet mengde i varegruppens enhet.');
   const location=required(o.location||item.location,'Plassering'),collectionKey=required(o.collectionKey,'Samling'),reason=required(o.evidence,'Mengde- og koblingsbelegg');
   if(!Array.isArray(o.imageIds)||o.imageIds.some(id=>!imageIds.includes(id))||item.images.length&&!o.imageIds.length&&!item.text)throw Error('Observasjonen må vise hvilke bilder eller innsendt tekst den bygger på.');
   const key=JSON.stringify([o.watchId,location.toLocaleLowerCase('nb-NO'),collectionKey.toLocaleLowerCase('nb-NO')]),previous=groups.get(key);
   const next={watchId:w.id,name:w.name,amount:o.amount,unit:w.unit,confidence:o.confidence,location,collectionKey,evidence:reason,imageIds:[...new Set(o.imageIds)]};
   if(previous){next.amount=Math.max(previous.amount,next.amount);next.imageIds=[...new Set([...previous.imageIds,...next.imageIds])];next.evidence=previous.evidence+' '+reason;if(previous.confidence==='estimated')next.confidence='estimated';}
   groups.set(key,next);
  }
  const missing=unmatched.map(x=>({description:required(x.description,'Uavklart vare'),reason:required(x.reason,'Avklaringsgrunn')}));
  const totals=new Map();for(const o of groups.values())totals.set(o.watchId,(totals.get(o.watchId)??0)+o.amount);
  const changes=[];
  for(const [watchId,amount] of totals){
   const w=watches()[watchId];
   if(item.baseStocks[watchId]!==undefined?item.baseStocks[watchId]!==stockVersion(w):w.stockAmount!=null)throw Error('Beholdningen er endret siden innsending. Bevar familiens nye telling og be om en ny lagertelling.');
   const current=currentStock(w),next=item.mode==='minimum'?Math.max(current.amount??0,amount):amount;
   changes.push({watchId,name:w.name,unit:w.unit,observedAmount:amount,amount:Math.round(next*1000)/1000,previous:{stockAmount:w.stockAmount,stockCheckedAt:w.stockCheckedAt,stockPacks:w.stockPacks?structuredClone(w.stockPacks):null,stockEvidence:structuredClone(w.stockEvidence??null)}});
  }
  return update(()=>{
   for(const change of changes){const w=watches()[change.watchId];apply(w,change.amount);w.stockEvidence={intakeId:item.id,estimated:[...groups.values()].some(o=>o.watchId===w.id&&o.confidence==='estimated'),evidence,at:now().toISOString()};}
   item.result={evidence,observations:[...groups.values()],changes,unmatched:missing};item.status=missing.length?'needs_input':'done';item.note=missing.length?'Noen varer trenger avklaring. Kjente mengder er registrert.':'Lageret er oppdatert.';item.finishedAt=now().toISOString();item.appliedVersions=Object.fromEntries(changes.map(c=>[c.watchId,stockVersion(watches()[c.watchId])]));return summary(item);
  });
 }
 function action(input) {
  const item=find(input.id);
  if(input.action==='cancel')return update(()=>{if(item.result?.changes.length)throw Error('Tellingen har oppdatert lageret. Bruk Angre.');item.status='cancelled';return summary(item);});
  if(input.action==='dismiss')return update(()=>{if(item.status!=='needs_input')throw Error('Ingen avklaring å lukke.');item.status='acknowledged';return summary(item);});
  if(input.action==='undo'){
   if(!item.result||item.status==='undone')throw Error('Ingen lagertelling å angre.');
   for(const c of item.result.changes)if(!watches()[c.watchId]||stockVersion(watches()[c.watchId])!==item.appliedVersions[c.watchId])throw Error('Lageret er endret etter tellingen. Juster varen direkte.');
   return update(()=>{for(const c of item.result.changes){const w=watches()[c.watchId];Object.assign(w,c.previous);}item.status='undone';return summary(item);});
  }
  throw Error('Ukjent valg for lagertelling.');
 }
 const attempt=ids=>update(()=>{for(const item of work())if(ids.includes(item.id)){item.attempts++;item.retryAt=null;}return true;});
 const finish=(ids,note)=>update(()=>{for(const item of work())if(ids.includes(item.id)){if(item.attempts>=3){item.status='needs_input';item.note=note??'Lagertellingen kunne ikke fullføres automatisk. Se over teksten og bildene, og send på nytt.';}else item.retryAt=new Date(now().getTime()+(item.attempts>=2?300000:60000)).toISOString();}return true;});
 const list=()=>all().filter(x=>!['cancelled','undone'].includes(x.status)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,30).map(summary);
 const blocked=()=>all().filter(x=>x.status==='needs_input').map(summary);
 return {get:id=>summary(find(id)),begin,upload,submit,image,review,action,attempt,finish,list,work:()=>work().map(summary),blocked};
}
