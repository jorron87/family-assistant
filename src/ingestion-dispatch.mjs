import {readConfig as readDeploymentConfig} from './config.mjs';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt,loadKey} from './crypto.mjs';
import {launchLuna} from './phone-dispatch.mjs';
import {sourceIdentity} from './source-identity.mjs';

export function changeSignal(store,resources) {
  const report=store.completionReport(), queue=store.reviewQueue(), feed=store.activityFeedStatus(),state=store.snapshot();
  const waiting=[...queue.items,...report.missingDrive.map(item=>state.rawItems[item.rawId]).filter(Boolean)];
  const originals=resources?.list({status:'ready'}).filter(item=>waiting.some(raw=>raw.source===item.source &&
    item.refs?.some(ref=>sourceIdentity(item.source,ref)===sourceIdentity(raw.source,raw.externalId))))??[];
  const rows=[
    ...queue.items.map(item=>['review',item.source,item.surface,item.externalId,item.listingHash,item.reason]),
    ...report.profileReviews.map(item=>['profile',item.rawId,item.revision]),
    ...report.missingDrive.map(item=>['drive',item.rawId,state.rawItems[item.rawId]?.revision,item.attachmentId,item.kind]),
    ...report.unsyncedCalendar.map(item=>['calendar',item.eventId,state.events[item.eventId]?.fingerprint]),
    ...originals.map(item=>['ready-original',item.id,item.sha256]),
    ...store.activityFacebook().map(item=>['facebook-activity',item.externalId,item.token]),
    ...Object.values(state.activities??{}).filter(item=>!item.mergedInto && item.plan?.status==='pending').map(item=>['activity-plan',item.id,item.plan.requestedAt]),
    ...(feed.changedPages ?? []).map(id=>['activity-page',id,feed.pages?.find(page=>page.id===id)?.hash]),
    ...(feed.hsia?.candidates?store.activityFeedCandidates({limit:10000}).items.map(item=>['activity-candidate',item.url,item.hash]):[]),
    ...(store.shopping?.queue()??[]).filter(item=>!['shopping-list-route','shopping-stock-review'].includes(item.do)).map(item=>['shopping',item.do,item.storeId,item.watchId,item.productId,item.productKey,item.fingerprint,item.lastReview?.checkedAt,item.watchIds,item.do==='shopping-feed-review'?store.shopping.feedFingerprint(item.storeId):null,item.sourceKey,item.sourceFingerprint,Array.isArray(item.familyIds)?[...item.familyIds].sort():null])
  ].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {signature:rows.length?createHash('sha256').update(JSON.stringify(rows)).digest('hex'):null,count:rows.length,items:rows.map(row=>JSON.stringify(row)),
    shoppingOnly:rows.length>0&&rows.every(row=>row[0]==='shopping'),originalsOnly:rows.length>0&&rows.every(row=>row[0]==='ready-original'||row[0]==='drive'&&row[4]==='source-original')};
}

function osloDayAndHour(timestamp) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(timestamp).map(part=>[part.type,part.value]));
  return {day:`${parts.year}-${parts.month}-${parts.day}`,hour:Number(parts.hour),minute:Number(parts.minute)};
}

function fullRunRecorded(store,day) {
  let before=null;
  do {
    const page=store.runHistory(before);
    for(const run of page.runs){
      const at=Date.parse(run.startedAt);
      if(!Number.isFinite(at))continue;
      const local=osloDayAndHour(at);
      if(local.day<day)return false;
      // A scheduled 07 run can start a few minutes early. A completed full
      // check spanning 07 is the daily check too, even when it stays partial.
      const finishedAt=Date.parse(run.finishedAt);
      const finished=Number.isFinite(finishedAt)&&finishedAt>=at?osloDayAndHour(finishedAt):null;
      if(local.day===day && (local.hour>=7 || finished?.day===day&&finished.hour>=7) && run.scope==='alle' && run.outcome!=='skipped')return true;
    }
    before=page.nextCursor;
  } while(before);
  return false;
}

export function createIngestionDispatcher({store,resources,root,dataDir,launch=launchLuna,clock=Date.now,readConfig,alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}) {
  const file=join(dataDir,'ingestion-dispatch.enc'),key=loadKey(dataDir);
  let state=existsSync(file)?JSON.parse(decrypt(readFileSync(file),key).toString('utf8')):{};
  let running=!!state.worker;
  let retryAfterLogin=false;
  const config=readConfig ?? (()=>readDeploymentConfig('collector.json').dispatch ?? {});
  const save=()=>{writeFileSync(file+'.tmp',encrypt(Buffer.from(JSON.stringify(state)),key));renameSync(file+'.tmp',file);};
  const clearRecoveredLoginError=()=>{
    if(!/innlogging/.test(state.lastError??'')||typeof store.runHistory!=='function')return;
    const latest=store.runHistory().runs.find(run=>run.scope==='alle'&&run.outcome!=='skipped');
    if(latest&&Date.parse(latest.finishedAt)> (state.lastFinishedAt??0)){state.lastError=null;save();}
  };
  const release=token=>{if(store.snapshot().runLease?.token===token)store.endRun(token);};
  function knownBlockedOriginalsOnly(work) {
    if(!resources || !work.originalsOnly)return false;
    const missing=store.completionReport().missingDrive,raws=store.snapshot().rawItems;
    if(!missing.length)return false;
    return missing.every(entry=>{
      const raw=raws[entry.rawId];if(!raw?.externalId)return false;
      return resources.list({externalId:raw.externalId}).some(item=>{
        const rejectedResponse=item.status==='needs_browser'&&item.authRequired&&raw.attachments?.some(a=>a.contentError&&a.fileName===entry.fileName&&a.fileName===item.fileName);
        if(!rejectedResponse&&(item.status!=='error'||!item.authRequired||!(item.attempts>=3)))return false;
        const named=item.fileName && entry.fileName?.toLowerCase().includes(item.fileName.toLowerCase());
        const googleDocument=/google.*dokument/i.test(entry.fileName??'') && /^https:\/\/docs\.google\.com\/document\//i.test(item.url??'');
        return named||googleDocument;
      });
    });
  }
  function resourceWait(work) {
    if(!resources || work.count!==1)return null;
    const missing=store.completionReport().missingDrive;
    if(missing.length!==1 || missing[0].kind!=='source-original')return null;
    const raw=store.snapshot().rawItems[missing[0].rawId];
    if(!raw?.externalId)return null;
    const blocked=resources.list({externalId:raw.externalId}).find(item=>
      item.status==='error' && item.fileName && missing[0].fileName?.toLowerCase().includes(item.fileName.toLowerCase()) &&
      Number.isFinite(Date.parse(item.retryAt)) && Date.parse(item.retryAt)>clock());
    return blocked?Date.parse(blocked.retryAt):null;
  }
  function tick() {
    clearRecoveredLoginError();
    if(state.worker){
      if(alive(state.worker.pid))return;
      release(state.worker.token);
      if(state.worker.scope==='alle')state.daily.retryAt=clock()+30*60000;
      else state.retryAt=clock()+30*60000;
      state.worker=null;running=false;state.lastError='Agentprosessen ble avbrutt; arbeidet er bevart.';save();
    }
    const cfg=config();if(running||cfg.enabled!==true)return;
    // Family-submitted work has priority over automatically discovered work.
    if(store.phone.list().some(item=>['queued','processing'].includes(item.status))||store.calendarActions().length)return;
    if(store.shopping?.stockIntake?.work().some(item=>!item.retryAt||Date.parse(item.retryAt)<=clock()))return;
    const local=osloDayAndHour(clock());
    if(state.daily?.day!==local.day){state.daily={day:local.day,attempts:0,retryAt:null};save();}
    const fullDue=cfg.dailyFullFallback===true && (local.hour>7 || local.hour===7&&local.minute>=15) && !fullRunRecorded(store,local.day) && state.daily.attempts<3 && (!state.daily.retryAt||state.daily.retryAt<=clock());
    const work=fullDue?null:changeSignal(store,resources);
    if(!fullDue&&!work.signature)return;
    if(!fullDue){
      // A repeatedly rejected unchanged original is checked by the daily full
      // run or after new data/access. Do not start Luna just to rediscover it.
      if(knownBlockedOriginalsOnly(work)){if(state.retryAt!==null){state.retryAt=null;save();}return;}
      const wait=resourceWait(work);
      if(wait){if(!state.retryAt||state.retryAt<wait){state.retryAt=wait;save();}return;}
    }
    const changed=!fullDue&&work.signature!==state.lastSignature;
    if(!retryAfterLogin&&clock()-(state.lastStartedAt??0)<(cfg.minGapMinutes??15)*60000)return;
    if(!fullDue&&!changed && (!state.retryAt || state.retryAt>clock() || (state.attempts??0)>=3))return;
    const lease=store.beginRun();if(!lease.acquired)return;
    retryAfterLogin=false;
    const token=lease.lease.token;running=true;
    const scope=fullDue?'alle':work.shoppingOnly?'handel':'kildeendringer';
    if(fullDue){state.daily.attempts++;state.daily.retryAt=null;}
    else{state.lastSignature=work.signature;state.attempts=changed?1:(state.attempts??0)+1;state.retryAt=null;}
    state.lastStartedAt=clock();save();
    const prompt=fullDue?`Gjør den daglige fulle kildekontrollen for Familien. Den planlagte kl. 07-kjøringen ble ikke registrert som utført; dette er reservekjøringen. Les AGENTS.md, config/sources.json, familieprofilen, relevante deler av docs/runbook.md og docs/aktiviteter.md. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run; forny og frigjør bare denne låsen.
Start med next, behandle telefoninnboks og kalenderhandlinger, kjør waste-refresh og kontroller faktisk 30-dagersdekning og kommende avtaler for alle konfigurerte barna, Vigilo-tilleggsflater, Spond, konfigurerte Facebook-grupper og aktivitetskilder. Prioriter kommende 14 dager. Bruk samlerdata, ressursuttrekk og dokumentkvitteringer før nettleser; les alle sider og relevante lenker i nye/endrede vedlegg uansett filformat. Vurder profil, publiser originaler/råkort privat til Drive og synkroniser Calendar med faktiske kvitteringer og familiens varige skjulvalg. Bruk publish hvis Google direktepublisering er koblet til, ellers tilgjengelige Google-verktøy. Ingen kjøp, påmeldinger eller meldinger til andre.
Fortsett til completion er true, eller registrer konkrete eksterne blockers og resumeHint ved faktisk utilgjengelige deler. Avslutt med run scope:"alle" og end-run ${token} i finally. Vær stille når alt er uendret og dekket; varsle nye betydelige funn, tapt innlogging og ny eller forverret manglende dekning.`:`Behandle nye/endrede kildeelementer og ventende publisering i Familien. Dette er en avgrenset kjøring med scope:"kildeendringer", ikke daglig full kildekontroll. Les AGENTS.md, config/sources.json, profile og runbookens nye avsnitt om datahenting. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run; forny og frigjør bare denne låsen.
Start med next. Les collected ID og ressursuttrekk (resource ID) før nettleser. API-overflatene er allerede observert; ikke gjenta uendrede lister eller dokumenter. Nye lenker og vedlegg er ikke begrenset til PDF: følg relevante lenker videre, les alle sider, behold originale filer. Bruk resource-fetch, resource-follow, resource-export og resource-attach. Et maskinuttrekk er ikke en dokumentkvittering. Vurder datoer, barn, oppgaver og profil; arkiver/publiser ekte råkort og originaler privat til Drive, synkroniser Google Calendar med stabile ID-er, faktisk kvittering og familiens varige valg. Bruk publish når Google direktepublisering er tilkoblet; ellers de tilgjengelige Google-verktøyene. Ingen kjøp/påmeldinger eller meldinger til andre.
Behandle review-queue, profilvurderinger, manglende originaler/Drive og kalenderendringer samt nye aktivitetskandidater/endret sidetekst. Bevar aktivitetsforslag som forslag uten automatisk kalenderføring. Nettleser brukes ved dokumenterte hull i data/kommentarer eller tilgang, ikke bare fordi global dekning har eldre åpne flater. Gjenbruk kildefaner. Ikke kontroller alle kildeoversikter på nytt og ikke endre udekkede overflater/kildestatus til ok. Daglig kontroll ivaretar dekningsvinduene.
Sjekk change-completion før avslutning. outcome:"ok" med scope:"kildeendringer" krever complete:true for endringsarbeidet, og betyr aldri at alle kildeoverflater er dekket. Ved ekstern blokkering gjør resten ferdig og registrer partial med konkrete blockers og resumeHint. Frigjør ${token} i finally. Vær stille ved uendret allerede varslet blokkering; varsle nye viktige funn eller endret feil.`;
    const originalReuse='Kjente uendrede dokumentavslag: gjenbruk feilkontrollpunktet under docs/drift og eksisterende ressurs-/dokumentkvitteringer. Ikke gjenta Drive-metadata, Docs-lesing, nettleseråpning, nedlasting eller PDF-rendering bare fordi samme gamle originalrestanse fortsatt inngår i completion. Kravet om et konkret Google-forsøk gjelder første diagnose av et tilgangsproblem og nye publiseringshandlinger, ikke hvert senere avgrensede run. Kontroller på nytt ved faktisk ny tilgang, rettet lenke, ny versjon eller nye bytes. Behandle alle nye kilder/handlinger som vanlig; behold det uløste originalhullet og rapporter partial uten ny identisk tilgangskontroll.';
    const shoppingPrompt=`Handel: behandle alle tilgjengelige oppgaver i shopping-queue. Les AGENTS.md, .local/AGENTS.md hvis den finnes, familieprofilen og handelsavsnittene i docs/runbook.md. Bruk gjeldende lokalt dokumentert discovery-/prisoppdatering; aldri en statisk whitelist som erstatning for nye varianter. Start med next, prioriter telefon og kalenderhandlinger, og behandle shopping-sesum-review, shopping-product-review, shopping-market-refresh, shopping-review, shopping-feed-review, shopping-order-link, shopping-family-build og shopping-list-family. Varefamilie er eneste begrep: shopping-family-build betyr at en familie dere følger mangler bibliotekvarianter eller at en variant er endret; bruk shopping-family-candidates og registrer med shopping-family-set. shopping-list-family betyr at en vare på handlelisten mangler varefamilie: søk bredt etter alle kandidater på tvers av merker og butikker, ikke bare den billigste, gjennomgå faktisk innhold og pakning, bygg eller utvid varefamilien i produktbiblioteket og registrer med shopping-list-family etter runbooken. Sesum: les shopping-sesum og shopping-sesum-candidates; bruk shopping-sesum-review med gjeldende sourceFingerprint og productFingerprint, konkret identitetsbelegg og dokumentert pakning før en priskobling godkjennes. Navn eller EAN alene er aldri tilstrekkelig. Prisinnhenting for alle fulgte familier og faktisk frisk prisdekning rapporteres separat. Nye eller endrede produkter må gjennomgås på gjeldende fingerprint før markedskalibrering. Oppdater alle forfalte varegrupper; én fersk gruppe beviser ikke at resten er kontrollert. Hold hver kundeavisside mot shopping-checklist og registrer alle reelle treff eller konkrete comparable:false-begrunnelser. Kjedepriser beviser ikke lokal lagerstatus eller kundevilkår. Les shopping-feed før kvittering og fortsett hvis nye/endrede innlegg gjenstår. Behandle shopping-list-route bare når den er klar for nytt forsøk; ikke overstyr familiens avkrysning eller fjernede varer. Ingen bestillinger, meldinger, grensetester eller selvstendige Oda-kurvhandlinger. Bare tjenestens normale sortering av en familieopprettet listevare kan legge varen i kurven, med verifisert kvittering. Uklar kurvskriving skal aldri gjentas. Kontroller shopping-queue og completion.shopping før slutt. Ved eksterne blokkeringer gjør resten ferdig og registrer partial med konkrete blockers og resumeHint; aldri ok med handlearbeid igjen.`;
    const sesumDiscoveryPrompt='Sesum-discovery: Behandle shopping-sesum-discovery som aktiv research av nye varianter utenfor eksisterende produktkoblinger. Les shopping-sesum-candidates og faktisk kildetekst; finn konkret ingrediens-/etikett-/pakningsbelegg hos produsent eller annen primærkilde og søk bredt i bibliotek/Kassal på tvers av merker. Manglende EAN eller gjennomgått donor er aldri automatisk avslag. Bruk shopping-sesum-register med gjeldende sourceFingerprint, identityEvidence, dokumenterte product-fakta/pakning, memberships med gjeldende groupFingerprint og konkret ekvivalens-/kvalitetsbelegg, samt faktiske sourceReceipts. Følg runbookens registerkontrakt; opprett en ny bibliotekgruppe når beviset tilsier det, men koble den aldri automatisk til en fulgt familie. Bevar requires, merkekrav og eksakte varianter gjennom ordinær shopping-family-set. Ukjente ingredienser, egenskaper eller mengder forblir eksplisitte restanser; avslag krever et faktisk påvist avvik. Registreringen fornyer ingen prisdato eller årsbehov og endrer ingen kurv. Kontroller både discovery-/reviewkø og Sesums faktiske innhentingsmanifest før ferdigstatus; kildeinnhenting og godkjent fersk prisdekning er ulike forhold.';
    const sesumCatalogPrompt='Sesums bevarte varebelegg: les shopping-sesum-catalog [FAMILIE] før gjentatt nettleserhenting. Katalogen beholder kildeproduktets sanerte metadata og faktiske fetchedAt selv uten brukbar pris eller etter en mislykket priskvittering. Bruk metadata som forskningsspor og les deretter den aktuelle ingrediens-/pakningsetiketten hos kilde/produsent; saved metadata er ingen produktgodkjenning eller dokumentkvittering. Prices, priceCandidates og andre varers relatedProducts er separate. Uten faktisk priskilde, prisdato eller en konfigurert målkjede finnes ingen fersk sammenligningspris; ikke oppfinn en kjede eller lån prisen til et relatert produkt. Eldre observasjoner beholder gammel hentetid og prisalder. En lest vare med null prisrader kan fortsatt være et viktig shopping-sesum-discovery-funn.';
    const scopedPrompt=scope==='handel'?`Gjør en avgrenset handelskjøring med scope:"handel", ikke skole-/aktivitetskontroll. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run. Forny og frigjør bare denne låsen med end-run i finally. ${shoppingPrompt} Registrer run med scope:"handel".`:prompt+'\n'+shoppingPrompt;
    let finished=false;
    const finish=(code,error)=>{
      if(finished)return;finished=true;
      state.lastFinishedAt=clock();state.lastError=error ?? (code!==0?'Agenten avsluttet med feil.':null);
      if(fullDue){
        state.daily.retryAt=!fullRunRecorded(store,state.daily.day)&&state.daily.attempts<3?clock()+[0,30,120][state.daily.attempts]*60000:null;
      }else{
        const left=changeSignal(store,resources);
        if(left.items.some(item=>!work.items.includes(item)))state.attempts=0;
        state.lastSignature=left.signature;
        state.retryAt=left.count && state.attempts<3?clock()+[0,30,120][state.attempts]*60000:null;
        const wait=resourceWait(left);if(wait)state.retryAt=Math.max(state.retryAt??0,wait);
      }
      state.worker=null;release(token);running=false;save();
    };
    try{const child=launch({root,prompt:scopedPrompt+'\n'+sesumDiscoveryPrompt+'\n'+sesumCatalogPrompt+'\n'+originalReuse,onExit:finish});if(!finished&&child?.pid){state.worker={pid:child.pid,token,scope,startedAt:clock()};save();}}catch(error){finish(-1,error.message);}
  }
  function renew(){if(running&&state.worker&&store.snapshot().runLease?.token===state.worker.token)store.renewRun(state.worker.token);}
  const status=()=>{clearRecoveredLoginError();return {enabled:config().enabled===true,running,workerScope:state.worker?.scope??null,attempts:state.attempts??0,dailyFullFallback:config().dailyFullFallback===true,dailyFull:state.daily??null,lastStartedAt:state.lastStartedAt??null,lastFinishedAt:state.lastFinishedAt??null,retryAt:state.retryAt??null,lastError:state.lastError??null};};
  function resumeAfterLogin(){
    if(!/innlogging/.test(state.lastError??''))throw Error('Ingen registrert ChatGPT-innloggingsfeil å gjenoppta.');
    if(running)return status();
    state.retryAt=null;state.attempts=0;
    if(state.daily?.day===osloDayAndHour(clock()).day){state.daily.retryAt=null;state.daily.attempts=0;}
    save();retryAfterLogin=true;tick();return status();
  }
  return {tick,renew,resumeAfterLogin,status};
}
