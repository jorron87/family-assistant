import { createHash, randomBytes } from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
export function phoneStore(state,{save,upsertRaw,addAttachment}) {
  state.phone ??= {inbox:{},devices:{},invites:{}};
  const now=()=>new Date().toISOString();
  const requireItem=id=>{const item=state.phone.inbox[id];if(!item)throw Error('Ukjent innsending.');return item;};
  function invite() {
    const code=randomBytes(24).toString('base64url');
    state.phone.invites[digest(code)]={expiresAt:new Date(Date.now()+86400000).toISOString(),uses:0};save();
    return {code,expiresInHours:24};
  }
  function pair({code,name}) {
    const invitation=state.phone.invites[digest(String(code??''))];
    if(!invitation || Date.parse(invitation.expiresAt)<=Date.now() || invitation.uses>=10) throw Error('Lenken er utløpt eller ugyldig. Be om en ny familielenke.');
    const token=randomBytes(32).toString('base64url'),id=randomBytes(12).toString('hex');
    state.phone.devices[digest(token)]={id,name:String(name||'Familietelefon').slice(0,100),createdAt:now(),expiresAt:new Date(Date.now()+180*86400000).toISOString()};
    invitation.uses++;save();return {token,id};
  }
  function authenticate(token) {const device=state.phone.devices[digest(String(token??''))];return device && Date.parse(device.expiresAt)>Date.now()?device:null;}
  function identity(deviceId,{memberId}) {
    if(!state.profile.members.some(m=>m.id===memberId))throw Error('Velg hvem som bruker telefonen.');
    const device=Object.values(state.phone.devices).find(d=>d.id===deviceId);
    if(!device)throw Error('Ukjent telefon.');
    device.memberId=memberId;save();return {memberId};
  }
  function revokeDevices() {state.phone.devices={};state.phone.invites={};save();return {revoked:true};}
  function logout(token) {delete state.phone.devices[digest(String(token??''))];save();return {loggedOut:true};}
  function cancel(id,deviceId) {const item=requireItem(id);if(item.deviceId!==deviceId||item.status!=='uploading')throw Error('Bare en uferdig opplasting kan avbrytes.');item.status='cancelled';item.note='Opplastingen ble avbrutt. Ikke sendt til Luna.';item.updatedAt=now();save();return item;}
  function begin(input,deviceId,{senderMemberId}={}) {
    if(!/^[a-f0-9-]{36}$/i.test(input.clientId??'') || !Number.isInteger(input.fileCount) || input.fileCount<0 || input.fileCount>12)throw Error('Ugyldig innsending. Maks 12 filer.');
    const text=String(input.text??'').trim(),title=String(input.title??'').trim().slice(0,300);
    if(text.length>20000 || (!input.fileCount&&!text))throw Error('Legg ved et bilde, en fil eller en beskjed.');
    const members=[...new Set(input.members??[])];
    if(members.some(id=>!state.profile.members.some(member=>member.id===id)))throw Error('Ukjent familiemedlem.');
    const id=digest(`${deviceId}:${input.clientId}`).slice(0,24);
    const previous=state.phone.inbox[id];
    if(previous)return previous;
    const senderId=senderMemberId??Object.values(state.phone.devices).find(d=>d.id===deviceId)?.memberId??null;
    const sender=state.profile.members.find(m=>m.id===senderId);
    if(senderId&&!sender)throw Error('Ukjent avsender.');
    const submittedText=text||'Bilder/dokumenter sendt av familien. Kildetekst må leses i vedleggene.';
    const raw=upsertRaw({source:'telefon',externalId:id,title:title||(text?text.slice(0,90):'Sendt fra telefon'),body:(sender?`Avsender: ${sender.name} (${sender.id}).\n\n`:'')+submittedText,memberIds:members,publishedAt:now()}).item;
    const item={id,rawId:raw.id,deviceId,senderMemberId:sender?.id??null,senderName:sender?.name??null,title:raw.title,members,text,expectedFiles:input.fileCount,files:{},status:'uploading',createdAt:now(),updatedAt:now(),note:'Opplasting pågår.'};
    state.phone.inbox[id]=item;save();return item;
  }
  function upload(id,index,file,deviceId) {
    const item=requireItem(id);
    if(item.deviceId!==deviceId)throw Error('Innsendingen kan ikke endres.');
    if(!Number.isInteger(index)||index<0||index>=item.expectedFiles)throw Error('Ugyldig filnummer.');
    const {bytes}=file;
    const mime=detectFile(bytes);
    const old=item.files[index];
    if(old) {if(old.sha256!==digest(bytes))throw Error('Filnummeret er allerede brukt til en annen fil.');return old;}
    if(item.status!=='uploading')throw Error('Innsendingen kan ikke endres.');
    if(Object.values(item.files).reduce((sum,entry)=>sum+entry.size,0)+bytes.length>100*1024*1024)throw Error('Maks 100 MB per innsending.');
    const name=String(file.fileName||'bilde').replace(/[\\/\x00-\x1f]/g,'_').slice(0,180);
    const attachment=addAttachment(item.rawId,{fileName:name,mimeType:mime,bytes});
    item.files[index]=attachment;item.updatedAt=now();save();return attachment;
  }
  function submit(id,deviceId) {
    const item=requireItem(id);if(item.deviceId!==deviceId)throw Error('Ukjent innsending.');
    if(item.status!=='uploading')return item;
    if(Object.keys(item.files).length!==item.expectedFiles)throw Error('Alle filer må være lastet opp før innsendingen sendes.');
    item.status='queued';item.note='Mottatt. Luna starter så snart gjeldende gjennomgang er ledig.';item.submittedAt=now();item.updatedAt=now();save();return item;
  }
  function review(id,input) {
    const item=requireItem(id);
    if(item.status==='uploading')throw Error('Innsendingen er ikke ferdig lastet opp.');
    if(!['processing','done','blocked'].includes(input.status)||!String(input.note??'').trim())throw Error('Gjennomgang krever status og forklaring.');
    if(input.status==='done') {
      const raw=state.rawItems[item.rawId];
      if(raw.profileReviewedRevision!==raw.revision || !raw.driveUrl || raw.driveRevision!==raw.revision)throw Error('Kildekopi i Drive og profilvurdering må være fullført.');
      for(const file of raw.attachments) {
        if(!file.driveUrl)throw Error('Originalene må ha tilgjengelige Drive-kopier.');
        if(!state.documentReviews?.[file.sha256])throw Error('Alle originaler må være lest og ha dokumentkvittering.');
      }
      const result=input.result;
      if(!result || !['calendar','no_calendar'].includes(result.type) || !Array.isArray(result.eventIds) || result.eventIds.length>100 || new Set(result.eventIds).size!==result.eventIds.length)throw Error('Ferdigmelding krever result:{type:"calendar"|"no_calendar",eventIds:[LOKALE_IDER]}.');
      if(result.type==='calendar' && !result.eventIds.length)throw Error('Kalenderretting krever en lokal oppføring knyttet til telefonkilden. Oppdater finding/intake før Google og done.');
      if(result.type==='no_calendar' && result.eventIds.length)throw Error('no_calendar kan ikke oppgi kalenderhendelser.');
      if(result.eventIds.length!==raw.findingIds.length || result.eventIds.some(id=>!raw.findingIds.includes(id) || !state.events[id]?.sourceRefs.includes(raw.id)))throw Error('Resultatet må vise alle lokale kalenderfunn knyttet til telefonkilden; en Google-ID alene er ikke nok.');
      if(raw.findingIds.some(eventId=>{const event=state.events[eventId];return event.visibility?.hidden ? event.visibility.sync?.status!=='done' : !event.calendar?.eventUrl || !!event.calendar.removedAt || event.calendar.fingerprint!==event.fingerprint;}))throw Error('Alle kalenderfunn må være synkronisert.');
      item.result={type:result.type,eventIds:[...result.eventIds]};
    }
    item.status=input.status;item.note=String(input.note).slice(0,3000);item.updatedAt=now();save();return item;
  }
  function list(deviceId) {return Object.values(state.phone.inbox).filter(item=>!deviceId||item.deviceId===deviceId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(item=>({...item,events:(state.rawItems[item.rawId]?.findingIds??[]).map(id=>({id,title:state.events[id].title,start:state.events[id].start,hidden:!!state.events[id].visibility?.hidden,url:state.events[id].calendar?.removedAt?null:state.events[id].calendar?.eventUrl??null}))}));}
  function dispatch(id,input) {
    const item=requireItem(id);
    if(!['queued','processing'].includes(item.status))return item;
    item.dispatch={...item.dispatch,...input,updatedAt:now()};
    if(input.note)item.note=String(input.note).slice(0,3000);
    save();return item;
  }
  function worker(input) {state.phone.worker=input;save();}
  return {invite,pair,authenticate,identity,revokeDevices,logout,cancel,begin,upload,submit,review,list,dispatch,worker};
}

export function detectFile(bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>20*1024*1024)throw Error('Hver fil må være mellom 1 byte og 20 MB.');
  if(bytes.subarray(0,5).toString()==='%PDF-')return 'application/pdf';
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff)return 'image/jpeg';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(bytes.subarray(4,8).toString()==='ftyp'&&['heic','heix','hevc','hevx','mif1','msf1'].includes(bytes.subarray(8,12).toString()))return 'image/heic';
  throw Error('Bruk JPEG, PNG, WebP, HEIC eller PDF. Filtypen ble ikke gjenkjent.');
}
