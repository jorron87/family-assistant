import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createGooglePublisher,calendarPayload} from '../src/google-publisher.mjs';
test('Google publisher writes private cards and genuine all-day events, updates IDs, deletes hidden events and encrypts OAuth',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-google-'));const calls=[],files={},events={};let seq=0;
  const raw={id:'raw1',source:'vigilo',externalId:'source1',title:'Plan',publishedAt:'2026-09-29',memberIds:['child3'],body:'Original text',sourceUrl:'https://school.example',revision:1,profileReviewedRevision:1,attachments:[]};
  const event={id:'event1',canonicalKey:'trip1',title:'Tur',start:'2026-10-01',end:'2026-10-02',allDay:true,members:['child3'],sourceRefs:['raw1'],fingerprint:'fp1',visibility:{hidden:false,revision:0,sync:{status:'done'}}};
  const store={snapshot:()=>({rawItems:{raw1:structuredClone(raw)},events:{event1:structuredClone(event)}}),completionReport:()=>({missingDrive:!raw.driveUrl||raw.driveRevision!==raw.revision?[{rawId:'raw1',kind:'raw-card'}]:[],unsyncedCalendar:!event.calendar||event.calendar.fingerprint!==event.fingerprint||event.visibility.sync.status==='pending'?[{eventId:'event1'}]:[]}),documentStatus:()=>({receipt:{}}),linkDrive:(_r,_a,url)=>{raw.driveUrl=url;raw.driveRevision=raw.revision;},linkCalendar:(_id,receipt)=>{event.calendar=receipt;},calendarAction:(_id,receipt)=>{assert.equal(receipt.revision,event.visibility.revision);event.calendar.removedAt='now';event.visibility.sync.status='done';}};
  const config={timezone:'Europe/Oslo',calendar:{id:'family-calendar'},drive:{folderId:'folder',familyReaders:['family@example.com']}};
  const fetcher=async(url,opts={})=>{const u=new URL(url),path=u.pathname;calls.push({path,method:opts.method,body:opts.body});const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
    if(u.hostname==='oauth2.googleapis.com')return json({refresh_token:'PRIVATE-REFRESH',access_token:'PRIVATE-ACCESS',expires_in:3600});
    assert.equal(opts.headers.Authorization,'Bearer PRIVATE-ACCESS');
    if(path.endsWith('/permissions'))return json({permissions:[{type:'user',role:'owner',emailAddress:'owner@example.com'},{type:'user',role:'reader',emailAddress:'family@example.com'}]});
    if(path==='/drive/v3/files/generateIds')return json({ids:['file'+(++seq)]});
    if(path==='/drive/v3/files')return json({files:[]});
    if(path.startsWith('/upload/drive/v3/files')){const metadata=JSON.parse(opts.body.toString().split('\r\n\r\n')[1].split('\r\n--')[0]);const id=metadata.id??path.split('/').at(-1);files[id]={id,parents:['folder'],webViewLink:`https://drive.google.com/file/d/${id}/view`};return json(files[id]);}
    if(path.startsWith('/drive/v3/files/'))return files[path.split('/').at(-1)]?json(files[path.split('/').at(-1)]):json({},404);
    if(path.endsWith('/events')){if(opts.method==='POST'){const payload=JSON.parse(opts.body);events[payload.id]={...payload,htmlLink:'https://calendar.google.com/calendar/event?eid='+payload.id};return json(events[payload.id]);}return json({items:[]});}
    if(path.includes('/events/')){const id=path.split('/').at(-1);if(opts.method==='DELETE'){delete events[id];return new Response(null,{status:204});}if(opts.method==='PATCH'){events[id]={...events[id],...JSON.parse(opts.body)};}return events[id]?json(events[id]):json({},404);}
    throw Error('Unexpected '+url);
  };
  try{const publisher=createGooglePublisher({store,dataDir:dir,config,fetcher});assert.equal((await publisher.publish()).needsOAuth,true);assert.equal(calls.length,0);publisher.configure({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'secret'}});const auth=new URL(publisher.authorize().url);await assert.rejects(publisher.callback({state:'wrong',code:'x'}),/annen/);await publisher.callback({state:auth.searchParams.get('state'),code:'code'});
    const result=await publisher.publish();assert.deepEqual(result,{cards:1,attachments:0,events:1,errors:[]});const id=event.calendar.eventId;assert.deepEqual(events[id].start,{date:'2026-10-01'});assert.equal(events[id].attendees,undefined);assert.equal(readFileSync(join(dir,'google-publisher.enc')).includes(Buffer.from('PRIVATE-REFRESH')),false);
    const noChange=await publisher.publish();assert.equal(noChange.cards+noChange.events,0);
    raw.attachments=[{id:'bad',contentError:'Innloggingsside',sha256:'bad',driveUrl:'https://drive.google.com/file/d/real-original/view'},{id:'restored',sha256:'real',driveUrl:'https://drive.google.com/file/d/real-original/view'}];
    event.fingerprint='fp2';event.title='Rettet tur';assert.equal((await publisher.publish()).events,1);assert.equal(event.calendar.eventId,id);assert.equal(events[id].summary,'Rettet tur');assert.doesNotMatch(events[id].description,/bad-HTML/);assert.match(events[id].description,/real-original/);
    event.visibility={hidden:true,revision:1,sync:{status:'pending'}};await publisher.publish();assert.equal(events[id],undefined);assert.ok(event.calendar.removedAt);
  }finally{assert.ok(dir.includes('familien-google-'));rmSync(dir,{recursive:true,force:true});}
});
test('calendar payload preserves confirmed date, time note and before-evening waste reminder',()=>{const p=calendarPayload({id:'e',fingerprint:'f',canonicalKey:'renovasjon:x',title:'Papir',start:'2026-10-02',end:'2026-10-03',allDay:true,provisional:false,timeNote:'Klokkeslett ikke oppgitt.'},[]);assert.equal(p.summary,'Papir');assert.deepEqual(p.reminders.overrides,[{method:'popup',minutes:360}]);assert.match(p.description,/Klokkeslett/);});
