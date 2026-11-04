import {createHash,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt,loadKey} from './crypto.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const SCOPES=['https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/calendar.events'];
const fileId=url=>{try{const u=new URL(url);return u.pathname.match(/\/d\/([^/]+)/)?.[1]??u.searchParams.get('id');}catch{return null;}};
const title=event=>(event.cancelled?'Avlyst: ':'')+(event.provisional?'[Foreløpig] ':'')+event.title;
export function calendarPayload(event,raws,timezone='Europe/Oslo') {
  const sources=raws.flatMap(raw=>[raw.sourceUrl,raw.driveUrl,...raw.attachments.filter(a=>!a.contentError).map(a=>a.driveUrl)]).filter(Boolean);
  const description=[`Gjelder: ${(event.members??[]).join(', ')}`,event.details,event.reason,event.timeNote,
    ...(event.task?.items??[]).map(item=>`☐ ${item.text}`),...(event.checklist??[]).map(text=>`☐ ${text}`),
    'Kilder:',...new Set(sources)].filter(Boolean).join('\n');
  const endpoint=value=>event.allDay?{date:value.slice(0,10)}:{dateTime:value,timeZone:timezone};
  return {summary:title(event),description,start:endpoint(event.start),end:endpoint(event.end),extendedProperties:{private:{familienEventId:event.id,familienFingerprint:event.fingerprint}},
    ...(event.canonicalKey?.startsWith('renovasjon:')?{reminders:{useDefault:false,overrides:[{method:'popup',minutes:360}]}}:{})};
}

export function createGooglePublisher({store,dataDir,config,fetcher=fetch,clock=Date.now,redirectUri='http://127.0.0.1:4318/api/google/callback'}) {
  const path=join(dataDir,'google-publisher.enc'),key=loadKey(dataDir);
  let state=existsSync(path)?JSON.parse(decrypt(readFileSync(path),key).toString('utf8')):{files:{}};
  state.files??={};state.deletedCalendarIds??={};let refreshing=null,busy=false;
  const save=()=>{writeFileSync(path+'.tmp',encrypt(Buffer.from(JSON.stringify(state)),key));renameSync(path+'.tmp',path);};
  const status=()=>({configured:!!state.client,connected:!!state.tokens?.refresh_token,running:busy,lastRunAt:state.lastRunAt??null,lastError:state.lastError??null,redirectUri,calendarId:config.calendar.id,folderId:config.drive.folderId});
  function configure(input){const client=input.installed??input.web??input;if(!client.client_id?.endsWith('.apps.googleusercontent.com'))throw Error('Google OAuth-klientens JSON kreves.');state.client={client_id:client.client_id,client_secret:client.client_secret};delete state.tokens;save();return status();}
  function authorize(){if(!state.client)throw Error('Importer en Google OAuth-klient med google-configure først.');const verifier=randomBytes(48).toString('base64url');state.auth={state:randomBytes(24).toString('hex'),verifier,expiresAt:clock()+10*60000};save();const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');for(const [key,value] of Object.entries({client_id:state.client.client_id,redirect_uri:redirectUri,response_type:'code',scope:SCOPES.join(' '),access_type:'offline',prompt:'consent',state:state.auth.state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value);return {url:url.href};}
  async function tokenRequest(params){const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...state.client,...params}),signal:AbortSignal.timeout(30000)});const data=await response.json();if(!response.ok)throw Error(`Google-innlogging feilet (${response.status}, ${data.error??'ukjent'}).`);return data;}
  async function callback({code,state:nonce,error}){const auth=state.auth;if(!auth||auth.state!==nonce||auth.expiresAt<clock())throw Error('Google-innloggingen er utløpt eller tilhører en annen forespørsel.');delete state.auth;save();if(error)throw Error('Google-tilgang ble ikke godkjent.');const tokens=await tokenRequest({code,code_verifier:auth.verifier,grant_type:'authorization_code',redirect_uri:redirectUri});state.tokens={...tokens,expiresAt:clock()+tokens.expires_in*1000};save();return status();}
  async function access(){if(!state.tokens?.refresh_token)throw Error('Direktepublisering venter på Google OAuth. Bruk eksisterende Google-verktøy inntil tilkobling.');if(state.tokens.expiresAt>clock()+60000)return state.tokens.access_token;if(!refreshing)refreshing=(async()=>{const tokens=await tokenRequest({grant_type:'refresh_token',refresh_token:state.tokens.refresh_token});state.tokens={...state.tokens,...tokens,expiresAt:clock()+tokens.expires_in*1000};save();return state.tokens.access_token;})().finally(()=>refreshing=null);return refreshing;}
  async function api(path,{method='GET',body,headers={},allow=[]}={}) {
    const response=await fetcher('https://www.googleapis.com'+path,{method,headers:{Authorization:`Bearer ${await access()}`,...(body&&typeof body==='object'&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:Buffer.isBuffer(body)||typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    if(allow.includes(response.status))return {statusCode:response.status};
    if(!response.ok)throw Error(`Google ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    return response.status===204?{}:response.json();
  }
  async function permissions(id){const {permissions=[]}=await api(`/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=permissions(id,type,role,emailAddress)`);return permissions;}
  async function privateFile(id,{share=false}={}) {
    let perms=await permissions(id);const allowed=new Set(config.drive.familyReaders.map(x=>x.toLowerCase()));
    if(perms.some(p=>p.role!=='owner'&&(p.type!=='user'||!allowed.has((p.emailAddress??'').toLowerCase()))))throw Error('Drive-filen har tilgang utenfor de konfigurerte familiekontoene. Kontroller mappen.');
    for(const email of allowed)if(!perms.some(p=>(p.emailAddress??'').toLowerCase()===email)){
      if(!share)throw Error('Familiekontoens tilgang til Drive-mappen mangler.');
      await api(`/drive/v3/files/${id}/permissions?sendNotificationEmail=false`,{method:'POST',body:{type:'user',role:'reader',emailAddress:email}});
    }
    perms=await permissions(id);
    if([...allowed].some(email=>!perms.some(p=>(p.emailAddress??'').toLowerCase()===email)))throw Error('Drive-deling kunne ikke verifiseres.');
  }
  async function upload(raw,attachment) {
    if(attachment&&store.getAttachment(raw.id,attachment.id).attachment.contentError)throw Error('Vedlegget er en feilsvarside, ikke originalfilen.');
    const jobKey=attachment?`sha:${attachment.sha256}`:`raw:${raw.id}`;
    let id=fileId(attachment?.driveUrl ?? (!attachment?raw.driveUrl:null))??state.files[jobKey];
    if(!id){const q=`'${config.drive.folderId}' in parents and trashed = false and appProperties has { key='familienKey' and value='${jobKey}' }`;const found=await api('/drive/v3/files?'+new URLSearchParams({q,fields:'files(id)',pageSize:'100'}));if(found.files.length>1)throw Error('Flere Drive-kopier har samme Familien-nøkkel; krever avstemming.');id=found.files[0]?.id;}
    let existing=false;
    if(id){const meta=await api(`/drive/v3/files/${id}?fields=id,parents,trashed`,{allow:[404]});existing=meta.statusCode!==404&&!meta.trashed;if(existing&&!meta.parents?.includes(config.drive.folderId))throw Error('Tilknyttet Drive-fil ligger utenfor familiemappen.');}
    if(!id||!existing){id=(await api('/drive/v3/files/generateIds?count=1&space=drive&type=files')).ids[0];state.files[jobKey]=id;save();}
    const bytes=attachment?store.getAttachment(raw.id,attachment.id).bytes:Buffer.from([`Tittel: ${raw.title}`,`Kilde: ${raw.source}`,`Kilde-ID: ${raw.externalId}`,`Publisert: ${raw.publishedAt??'ukjent'}`,`Personer: ${raw.memberIds.join(', ')}`,`Original: ${raw.sourceUrl??''}`,'',raw.body,'',...raw.attachments.map(a=>`${a.fileName} SHA-256 ${a.sha256}`)].join('\n'));
    const metadata={name:attachment?.fileName??`${raw.title}.txt`,appProperties:{familienKey:jobKey},...(!existing?{id,parents:[config.drive.folderId]}:{})};
    const boundary='familien'+randomBytes(12).toString('hex');
    const mediaType=attachment?.mimeType??'text/plain';
    const multipart=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mediaType}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    await api(`/upload/drive/v3/files${existing?'/'+id:''}?uploadType=multipart&fields=id,webViewLink`,{method:existing?'PATCH':'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body:multipart});
    await privateFile(id,{share:true});
    const check=await api(`/drive/v3/files/${id}?fields=id,trashed,webViewLink,parents`);if(check.trashed||!check.parents?.includes(config.drive.folderId))throw Error('Drive-opplastingen kunne ikke verifiseres.');
    if(store.snapshot().rawItems[raw.id]?.revision!==raw.revision)throw Error('Kilden ble endret under opplasting; ny revisjon publiseres neste gang.');
    store.linkDrive(raw.id,attachment?.id??null,check.webViewLink??`https://drive.google.com/file/d/${id}/view`);
  }
  async function calendar(event) {
    const base=`/calendar/v3/calendars/${encodeURIComponent(config.calendar.id)}/events`;
    const revision=event.visibility?.revision??0;
    const stillCurrent=()=>{const live=store.snapshot().events[event.id];if(live.fingerprint!==event.fingerprint||(live.visibility?.revision??0)!==revision)throw Error('Familievalg eller innhold ble endret under publisering.');};
    if(event.visibility?.hidden){if(event.visibility.sync?.status==='pending'&&event.calendar?.eventId){if(event.calendar.calendarId!==config.calendar.id)throw Error('Feil kalender i slettingskvittering.');await api(`${base}/${event.calendar.eventId}`,{method:'DELETE',allow:[404,410]});stillCurrent();store.calendarAction(event.id,{action:'removed',revision,googleEventId:event.calendar.eventId});}return;}
    const snapshot=store.snapshot();
    const raws=event.sourceRefs.map(ref=>snapshot.rawItems[ref]).filter(Boolean);
    if(store.completionReport().missingDrive.some(item=>item.kind==='source-original'&&event.sourceRefs.includes(item.rawId)))throw Error('En forventet kildeoriginal mangler.');
    if(!raws.length||raws.some(raw=>!raw.driveUrl||raw.driveRevision!==raw.revision||raw.profileReviewedRevision!==raw.revision||raw.attachments.some(a=>!a.contentError&&(!a.driveUrl||!store.documentStatus(a.sha256).receipt))))throw Error('Kildeoriginaler, lesing, profil og Drive må være fullført før kalenderen.');
    const payload=calendarPayload(event,raws,config.timezone);
    let id=!event.calendar?.removedAt?event.calendar?.eventId:null;
    if(event.calendar?.calendarId && event.calendar.calendarId!==config.calendar.id)throw Error('Oppføringen tilhører en annen kalender.');
    if(id){const linked=await api(`${base}/${id}`,{allow:[404,410]});if(linked.status==='cancelled'||linked.statusCode){state.deletedCalendarIds[event.id]=id;save();id=null;}}
    if(!id){const query=new URLSearchParams({privateExtendedProperty:`familienEventId=${event.id}`,showDeleted:'false',maxResults:'100'});const found=await api(`${base}?${query}`);if(found.items?.length>1)throw Error('Flere aktive kalenderoppføringer har samme Familien-ID.');id=found.items?.[0]?.id;}
    if(!id){const query=new URLSearchParams({timeMin:new Date(Date.parse(event.start)-86400000).toISOString(),timeMax:new Date(Date.parse(event.end)+86400000).toISOString(),singleEvents:'true',showDeleted:'false',maxResults:'2500'});const found=await api(`${base}?${query}`);if(found.nextPageToken)throw Error('Duplikatsøket krever flere sider.');const matches=(found.items??[]).filter(item=>item.summary===payload.summary&&(event.allDay?item.start.date===payload.start.date&&item.end.date===payload.end.date:Date.parse(item.start.dateTime)===Date.parse(payload.start.dateTime)&&Date.parse(item.end.dateTime)===Date.parse(payload.end.dateTime)));if(matches.length>1)throw Error('Flere mulige kalenderdubletter; avstem før publisering.');id=matches[0]?.id;}
    stillCurrent();
    if(id)await api(`${base}/${id}?sendUpdates=none`,{method:'PATCH',body:payload});
    else {id='f'+hash(event.id+':'+revision+':'+(event.calendar?.removedAt??'')+':'+(state.deletedCalendarIds[event.id]??'')).slice(0,40);await api(`${base}?sendUpdates=none`,{method:'POST',body:{id,...payload},allow:[409]});}
    let receipt=await api(`${base}/${id}`);
    if(receipt.status!=='cancelled'&&receipt.extendedProperties?.private?.familienEventId===event.id&&receipt.extendedProperties?.private?.familienFingerprint!==event.fingerprint){stillCurrent();await api(`${base}/${id}?sendUpdates=none`,{method:'PATCH',body:payload});receipt=await api(`${base}/${id}`);}
    if(!receipt.htmlLink||receipt.status==='cancelled'||receipt.extendedProperties?.private?.familienFingerprint!==event.fingerprint)throw Error('Kalenderendringen kunne ikke verifiseres.');
    stillCurrent();store.linkCalendar(event.id,{calendarId:config.calendar.id,eventId:id,eventUrl:receipt.htmlLink,fingerprint:event.fingerprint,visibilityRevision:revision});
  }
  async function publish(){if(busy)return {busy:true};if(!status().connected)return {...status(),needsOAuth:true};busy=true;const result={cards:0,attachments:0,events:0,errors:[]};try{
    await privateFile(config.drive.folderId);
    const report=store.completionReport(),ids=[...new Set(report.missingDrive.map(x=>x.rawId))];
    for(const id of ids){const raw=store.snapshot().rawItems[id];if(raw.profileReviewedRevision!==raw.revision)continue;try{
      for(const a of raw.attachments)if(!a.contentError&&!a.driveUrl&&store.documentStatus(a.sha256).receipt){await upload(raw,a);result.attachments++;}
      if(!raw.driveUrl||raw.driveRevision!==raw.revision){await upload(raw);result.cards++;}
    }catch(error){result.errors.push({rawId:id,error:error.message});}}
    for(const {eventId} of store.completionReport().unsyncedCalendar){try{await calendar(store.snapshot().events[eventId]);result.events++;}catch(error){result.errors.push({eventId,error:error.message});}}
    state.lastRunAt=new Date(clock()).toISOString();state.lastError=result.errors[0]?.error??null;save();return result;
  }catch(error){state.lastError=error.message;save();return {...result,errors:[...result.errors,{error:error.message}]};}finally{busy=false;}}
  return {status,configure,authorize,callback,publish};
}
