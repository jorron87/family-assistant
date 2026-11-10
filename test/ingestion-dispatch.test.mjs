import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createIngestionDispatcher,changeSignal} from '../src/ingestion-dispatch.mjs';
import {createStore} from '../src/store.mjs';

test('same-count Sesum review changes wake dispatch by source identity, metadata and followed family',()=>{
  let rows=[{do:'shopping-sesum-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'metadata-a',familyIds:['family-b','family-a'],receiptAt:'2026-11-09T08:00:00Z'}];
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>rows}};
  const first=changeSignal(store);assert.equal(first.count,1);assert.equal(first.shoppingOnly,true);assert.ok(first.signature);
  rows[0].receiptAt='2026-11-09T10:00:00Z';rows[0].fetchedAt='2026-11-09T11:00:00Z';
  assert.equal(changeSignal(store).signature,first.signature,'ordinary price/fetch time alone does not reopen unchanged product review');
  rows[0].familyIds.reverse();assert.equal(changeSignal(store).signature,first.signature,'family ordering is not new work');
  rows[0].sourceFingerprint='metadata-b';const changedMetadata=changeSignal(store);assert.equal(changedMetadata.count,first.count);assert.notEqual(changedMetadata.signature,first.signature);
  rows[0].sourceKey='sesum:COOP_EXTRA:456';const changedSource=changeSignal(store);assert.equal(changedSource.count,first.count);assert.notEqual(changedSource.signature,changedMetadata.signature);
  rows[0].familyIds.push('newly-followed');assert.notEqual(changeSignal(store).signature,changedSource.signature,'new family association is meaningful even at the same pending row count');
  rows[0].do='shopping-sesum-discovery';assert.equal(changeSignal(store).shoppingOnly,true);assert.equal(changeSignal(store).count,1);
  rows=[];assert.equal(changeSignal(store).signature,null);
});

test('new Sesum discovery launches the existing shopping agent with research and registration instructions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-sesum-'));let lease=null,launch,rows=[{do:'shopping-sesum-discovery',sourceKey:'sesum:KIWI:123',sourceFingerprint:'current-source',familyIds:['family-a']}];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>rows},phone:{list:()=>[]},calendarActions:()=>[],beginRun:()=>({acquired:true,lease:lease={token:'test-owned-lease'}}),endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  try{
    const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>Date.parse('2026-11-09T12:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),alive:()=>true,launch:input=>{launch=input;return {pid:123};}});
    d.tick();assert.equal(d.status().workerScope,'handel');assert.match(launch.prompt,/shopping-sesum-discovery/);assert.match(launch.prompt,/shopping-sesum-register/);assert.match(launch.prompt,/shopping-sesum-catalog/);assert.match(launch.prompt,/familyFingerprints/);assert.match(launch.prompt,/Manglende EAN eller gjennomgått donor er aldri automatisk avslag/);assert.match(launch.prompt,/shopping-sesum-offer-review/);assert.match(launch.prompt,/conditionsVerified:true/);assert.match(launch.prompt,/bare arbeid som faktisk krever nettleseren/);assert.match(launch.prompt,/En faktisk eksplisitt sikkerhetsstopp/);
    assert.match(launch.prompt,/shopping-sesum-family-review/);assert.match(launch.prompt,/registrationFingerprint/);assert.match(launch.prompt,/vanlige web-\/søkeverktøy/);assert.match(launch.prompt,/aldri bare søkeutdrag/);
    assert.match(launch.prompt,/shopping-sesum-placement-review/);assert.match(launch.prompt,/reviewedAllFamilies:true/);assert.match(launch.prompt,/noActiveFamilyVerified:true/);
    rows=[];launch.onExit(0);assert.equal(lease,null);assert.equal(d.status().running,false);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-dispatch-sesum-')));rmSync(dir,{recursive:true,force:true});}
});

test('campaign and linked offer terms wake the shopping agent at the same count, while price-date-only replay does not',()=>{
  const row={do:'shopping-sesum-offer-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',watchId:'family',familyFingerprint:'family-a',campaignFingerprint:'campaign-a',offerTermsFingerprint:'offer-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.shoppingOnly,true);assert.equal(initial.count,1);
  row.observedAt='2026-11-10T00:00:00Z';row.fetchedAt='2026-11-10T01:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.campaignFingerprint='campaign-b';const changed=changeSignal(store);assert.equal(changed.count,1);assert.notEqual(changed.signature,initial.signature);
  row.offerTermsFingerprint='offer-b';const offer=changeSignal(store);assert.notEqual(offer.signature,changed.signature);
  row.familyFingerprint='family-b';assert.notEqual(changeSignal(store).signature,offer.signature);
});

test('new source family research changes wake dispatch while ordinary receipt replay does not',()=>{
  const row={do:'shopping-sesum-family-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',watchId:'family',familyFingerprint:'family-a',registrationFingerprint:'product-groups-a',fingerprint:'research-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.shoppingOnly,true);assert.equal(initial.count,1);
  row.observedAt='2026-11-10T12:00:00Z';row.fetchedAt='2026-11-10T13:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.registrationFingerprint='product-groups-b';row.fingerprint='research-b';const changed=changeSignal(store);assert.equal(changed.count,1);assert.notEqual(changed.signature,initial.signature);
  row.familyFingerprint='family-b';assert.notEqual(changeSignal(store).signature,changed.signature);
});

test('all-family placement wakes on semantic source/product/family-set change without price-date churn',()=>{
  const row={do:'shopping-sesum-placement-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',registrationFingerprint:null,familySetFingerprint:'set-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.count,1);assert.equal(initial.shoppingOnly,true);
  row.observedAt='2026-11-10T12:00:00Z';row.fetchedAt='2026-11-10T13:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.registrationFingerprint='current-reviewed-product-groups';const product=changeSignal(store);assert.notEqual(product.signature,initial.signature);
  row.familySetFingerprint='set-b';assert.notEqual(changeSignal(store).signature,product.signature);
});

test('an edit to an already pending source item changes the dispatch signal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));
  try{
    const store=createStore(dir);
    const base={source:'vigilo',surface:'child3:news',items:[{externalId:'vigilo:news:pending',title:'Ukeplan',sourceExcerpt:'Første versjon',publishedAt:new Date().toISOString()}]};
    store.observeListing(base);
    const first=changeSignal(store).signature;
    store.observeListing({...base,items:[{...base.items[0],sourceExcerpt:'Rettet versjon'}]});
    assert.notEqual(changeSignal(store).signature,first);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a newly fetched original wakes unchanged pending work while failed attempts do not',()=>{
  const externalId='vigilo:news:9ea103df0eca8729525880a879b129a6';
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[{source:'vigilo',externalId,listingHash:'same',reason:'new'}]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]})};
  const file={id:'pdf',source:'vigilo',refs:['vigilo:news:9ea103df-0eca-8729-5258-80a879b129a6'],status:'error',attempts:1};
  const resources={list:({status})=>file.status===status?[file]:[]};
  const initial=changeSignal(store,resources).signature;
  file.attempts++;assert.equal(changeSignal(store,resources).signature,initial);
  Object.assign(file,{status:'ready',sha256:'real-content'});
  assert.notEqual(changeSignal(store,resources).signature,initial,'bytes arriving need reading even if the source list is unchanged');
  const ready=changeSignal(store,resources).signature;
  file.attempts++;assert.equal(changeSignal(store,resources).signature,ready);
});

test('a daily full run can report the explicit alle scope',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));
  try{
    const store=createStore(dir);
    const run=store.recordRun({scope:'alle',outcome:'partial',blockers:['Facebook-gruppen krever ny innlogging for å lese innholdet.'],resumeHint:'Logg inn i gruppen og fortsett gjennomgangen.'});
    assert.equal(run.scope,'alle');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('change dispatcher owns one lease, preserves family priority, survives restart and bounds retries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.now(),lease=null,phones=[],launches=[],queue=[{source:'vigilo',externalId:'x',listingHash:'1',reason:'new'}];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>phones},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  const args={store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,minGapMinutes:15}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true};
  try{let d=createIngestionDispatcher(args);phones=[{status:'queued'}];d.tick();assert.equal(launches.length,0);phones=[];d.tick();assert.equal(launches.length,1);assert.match(launches[0].prompt,/kildeendringer/);d.tick();assert.equal(launches.length,1);const restored=createIngestionDispatcher(args);restored.tick();assert.equal(launches.length,1);launches[0].onExit(0);assert.equal(lease,null);d.tick();assert.equal(launches.length,1);clock+=31*60000;d.tick();assert.equal(launches.length,2);launches[1].onExit(1);clock+=121*60000;d.tick();assert.equal(launches.length,3);launches[2].onExit(1);clock+=86400000;d.tick();assert.equal(launches.length,3);queue[0].listingHash='2';d.tick();assert.equal(launches.length,4,'a real source edit wakes the worker');queue=[];launches[3].onExit(0);assert.equal(changeSignal(store).signature,null);
  }finally{assert.ok(dir.includes('familien-dispatch-'));rmSync(dir,{recursive:true,force:true});}
});

test('dispatcher waits for a blocked original instead of launching Luna for the same file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-09-29T07:00:00Z'),lease=null,launches=0,queue=[];
  const externalId='spond:files:native-file';
  const store={snapshot:()=>({runLease:lease,rawItems:{raw:{externalId,revision:1}},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:[{rawId:'raw',kind:'source-original',fileName:'Hallvakt.pdf (original)'}],unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun:()=>{}};
  const resources={list:()=>[{fileName:'Hallvakt.pdf',status:'error',retryAt:'2026-09-29T08:00:00Z'}]};
  const args={store,resources,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,minGapMinutes:15}),launch:()=>{launches++;return {pid:123};},alive:()=>true};
  try{
    const d=createIngestionDispatcher(args);d.tick();assert.equal(launches,0);assert.equal(d.status().retryAt,Date.parse('2026-09-29T08:00:00Z'));
    clock+=31*60000;d.tick();assert.equal(launches,0,'the normal dispatcher retry must not precede the resource retry');
    queue=[{source:'vigilo',externalId:'new',listingHash:'1',reason:'new'}];d.tick();assert.equal(launches,1,'new source work must still start immediately');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('multiple references to a known rejected Google original do not restart Luna, but new work and restored bytes do',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-known-auth-'));let lease=null,queue=[],extraMissing=[],launches=[];
  const raw={source:'vigilo',externalId:'vigilo:news:old',revision:1};
  const blocked={id:'doc',source:'vigilo',refs:[raw.externalId],url:'https://docs.google.com/document/d/EXAMPLE_DOCUMENT_ID/edit',fileName:'edit',status:'error',authRequired:true,attempts:13};
  const store={snapshot:()=>({runLease:lease,rawItems:{a:raw,b:raw},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:['a','b'].map(rawId=>({rawId,kind:'source-original',fileName:'Uke 44 (Google Dokument)'})).concat(extraMissing),unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun(){}};
  const resources={list:({status}={})=>!status||blocked.status===status?[blocked]:[]};
  const d=createIngestionDispatcher({store,resources,root:'.',dataDir:dir,clock:()=>Date.parse('2026-10-26T08:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
  try{
    d.tick();d.tick();assert.equal(launches.length,0);
    extraMissing=[{rawId:'a',kind:'source-original',fileName:'Ny ukeplan.pdf'}];d.tick();
    assert.equal(launches.length,1,'a new missing original must not be confused with the known Google failure');
    extraMissing=[];launches[0].onExit(0);d.tick();assert.equal(launches.length,1);
    queue=[{source:'vigilo',externalId:'new',listingHash:'1',reason:'new'}];d.tick();
    assert.equal(launches.length,2,'new source work is not blocked by the old document');
    queue=[];launches[1].onExit(0);d.tick();assert.equal(launches.length,2);
    Object.assign(blocked,{status:'ready',authRequired:false,sha256:'actual-bytes'});d.tick();
    assert.equal(launches.length,3,'restored original bytes wake the worker');
    launches[2].onExit(0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a preserved login response does not restart Luna, while restored original bytes still do',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-response-'));let lease=null,launches=[];
  const raw={source:'facebook',externalId:'facebook:post:1',revision:1,attachments:[{fileName:'file.docx',contentError:'Kilden returnerte en innloggingsside, ikke originalen.'}]};
  const resource={id:'f',source:'facebook',refs:[raw.externalId],fileName:'file.docx',status:'needs_browser',authRequired:true,attempts:1};
  const store={snapshot:()=>({runLease:lease,rawItems:{a:raw},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[{rawId:'a',kind:'source-original',fileName:'file.docx'}],unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun(){}};
  const resources={list:({status}={})=>!status||resource.status===status?[resource]:[]};
  try{
    const d=createIngestionDispatcher({store,resources,root:'.',dataDir:dir,clock:()=>Date.parse('2026-10-30T08:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
    d.tick();assert.equal(launches.length,0);
    Object.assign(resource,{status:'ready',authRequired:false,sha256:'real-original'});d.tick();assert.equal(launches.length,1);launches[0].onExit(0);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-dispatch-response-')));rmSync(dir,{recursive:true,force:true});}
});

test('missed 07 full run starts when the lease becomes free and is not duplicated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-09-29T05:14:00Z'),lease={token:'other'},launches=[],runs=[];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs,nextCursor:null}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  const args={store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true};
  try{
    const d=createIngestionDispatcher(args);
    d.tick();assert.equal(launches.length,0,'allow the scheduled 07 run to start first');
    clock+=60000;d.tick();assert.equal(launches.length,0,'another run owns the lease');
    lease=null;d.tick();assert.equal(launches.length,1);assert.match(launches[0].prompt,/daglige fulle kildekontrollen/);assert.equal(d.status().workerScope,'alle');
    runs=[{scope:'alle',outcome:'partial',startedAt:new Date(clock).toISOString()}];
    launches[0].onExit(0);d.tick();assert.equal(launches.length,1,'a partial full run still counts as the daily attempt');
    clock+=3600000;d.tick();assert.equal(launches.length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('confirmed ChatGPT login recovery retries a missed full run immediately',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-10-25T08:00:00Z'),lease=null;const launches=[],runs=[];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs,nextCursor:null}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:()=>{lease=null;},renewRun:()=>{}};
  const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:15}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
  try{
    assert.throws(()=>d.resumeAfterLogin(),/Ingen registrert/);
    d.tick();assert.equal(launches.length,1);
    launches[0].onExit(1,'ChatGPT eller en tilkoblet konto krever ny innlogging.');
    assert.equal(d.status().running,false);
    assert.ok(d.status().dailyFull.retryAt>clock);
    d.resumeAfterLogin();
    assert.equal(launches.length,2,'login recovery bypasses the retry time and minimum gap');
    assert.equal(d.status().workerScope,'alle');
    d.resumeAfterLogin();assert.equal(launches.length,2,'an active run is not duplicated');
    launches[1].onExit(1,'ChatGPT eller en tilkoblet konto krever ny innlogging.');
    runs.unshift({scope:'alle',outcome:'partial',startedAt:new Date(clock).toISOString(),finishedAt:new Date(clock+1000).toISOString()});
    assert.equal(d.status().lastError,null,'a newer full report clears the obsolete login error');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a completed morning check spanning 07 prevents a duplicate fallback in summer and winter time',()=>{
  for(const boundary of ['2026-10-24T05:00:00Z','2026-10-27T06:00:00Z']){
    const seven=Date.parse(boundary),iso=minutes=>new Date(seven+minutes*60000).toISOString();
    for(const [label,run,expected] of [
      ['early scheduled partial',{scope:'alle',outcome:'partial',startedAt:iso(-3),finishedAt:iso(12)},0],
      ['early scheduled ok',{scope:'alle',outcome:'ok',startedAt:iso(-3),finishedAt:iso(12)},0],
      ['earlier full check ends before 07',{scope:'alle',outcome:'partial',startedAt:iso(-30),finishedAt:iso(-10)},1],
      ['change scope crosses 07',{scope:'kildeendringer',outcome:'partial',startedAt:iso(-3),finishedAt:iso(12)},1],
      ['skipped check',{scope:'alle',outcome:'skipped',startedAt:iso(-3),finishedAt:iso(12)},1],
      ['missing finish',{scope:'alle',outcome:'partial',startedAt:iso(-3)},1],
      ['previous day',{scope:'alle',outcome:'partial',startedAt:iso(-1440),finishedAt:iso(-1430)},1]
    ]){
      const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-morning-'));let launches=0,lease=null;
      const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs:[run],nextCursor:null}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;}};
      try{
        const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>seven+15*60000,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:0}),launch:({prompt})=>{launches++;assert.match(prompt,/gjenbruk feilkontrollpunktet/);return {pid:123};},alive:()=>true});
        d.tick();assert.equal(launches,expected,`${boundary}: ${label}`);
      }finally{rmSync(dir,{recursive:true,force:true});}
    }
  }
});
