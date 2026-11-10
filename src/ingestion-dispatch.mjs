import {readConfig as readDeploymentConfig} from './config.mjs';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt,loadKey} from './crypto.mjs';
import {launchLuna} from './phone-dispatch.mjs';
import {sourceIdentity} from './source-identity.mjs';
import {shoppingWorkBatch} from './shopping-work-batch.mjs';
import {activitySourcePhaseRows} from './source-phase-checkpoint.mjs';

const shoppingSignalRows=(store,items,{perFamily=false}={})=>items
  .flatMap(item=>perFamily&&item.do==='shopping-market-refresh'&&Array.isArray(item.watchIds)&&item.watchIds.length?[...new Set(item.watchIds)].map(id=>({...item,watchIds:[id]})):[item])
  .filter(item=>!['shopping-list-route','shopping-stock-review'].includes(item.do))
  .map(item=>['shopping',item.do,item.storeId,item.watchId,item.productId,item.productKey,item.fingerprint,item.lastReview?.checkedAt,item.watchIds,item.do==='shopping-feed-review'?store.shopping.feedFingerprint(item.storeId):null,item.sourceKey,item.sourceFingerprint,Array.isArray(item.familyIds)?[...item.familyIds].sort():null,item.familyFingerprint,item.campaignFingerprint,item.offerTermsFingerprint,item.registrationFingerprint,item.familySetFingerprint]);
function shoppingCohortSignal(store,items){
  const rows=shoppingSignalRows(store,items,{perFamily:true}).map(row=>JSON.stringify(row)).sort();
  return {items:rows,signature:rows.length?createHash('sha256').update(JSON.stringify(rows)).digest('hex'):null};
}

export function changeSignal(store,resources,{shoppingOnly=false,sourceOnly=false}={}) {
  const report=store.completionReport(), queue=store.reviewQueue(), feed=store.activityFeedStatus(),state=store.snapshot();
  const waiting=[...queue.items,...report.missingDrive.map(item=>state.rawItems[item.rawId]).filter(Boolean)];
  const originals=resources?.list({status:'ready'}).filter(item=>waiting.some(raw=>raw.source===item.source &&
    item.refs?.some(ref=>sourceIdentity(item.source,ref)===sourceIdentity(raw.source,raw.externalId))))??[];
  const allRows=[
    ...queue.items.map(item=>['review',item.source,item.surface,item.externalId,item.listingHash,item.reason]),
    ...report.profileReviews.map(item=>['profile',item.rawId,item.revision]),
    ...report.missingDrive.map(item=>['drive',item.rawId,state.rawItems[item.rawId]?.revision,item.attachmentId,item.kind]),
    ...report.unsyncedCalendar.map(item=>['calendar',item.eventId,state.events[item.eventId]?.fingerprint]),
    ...originals.map(item=>['ready-original',item.id,item.sha256]),
    ...store.activityFacebook().map(item=>['facebook-activity',item.externalId,item.token]),
    ...Object.values(state.activities??{}).filter(item=>!item.mergedInto && item.plan?.status==='pending').map(item=>['activity-plan',item.id,item.plan.requestedAt]),
    ...activitySourcePhaseRows(state).filter(row=>row.health!=='ok'||row.unresolvedItems.length).map(row=>['activity-source',row.sourceId,row.health,row.details,row.scanTo,row.nextPageHint,row.unresolvedItems]),
    ...(feed.changedPages ?? []).map(id=>['activity-page',id,feed.pages?.find(page=>page.id===id)?.hash]),
    ...(feed.hsia?.candidates?store.activityFeedCandidates({limit:10000}).items.map(item=>['activity-candidate',item.url,item.hash]):[]),
    ...shoppingSignalRows(store,store.shopping?.queue()??[])
  ].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const rows=allRows.filter(row=>shoppingOnly?row[0]==='shopping':sourceOnly?row[0]!=='shopping':true);
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
      // A scheduled 07 run can start a few minutes early. Only an ok full
      // check spanning 07 counts as the completed daily check.
      const finishedAt=Date.parse(run.finishedAt);
      const finished=Number.isFinite(finishedAt)&&finishedAt>=at?osloDayAndHour(finishedAt):null;
      if(local.day===day && (local.hour>=7 || finished?.day===day&&finished.hour>=7) && run.scope==='alle' && run.outcome==='ok')return true;
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
    const report=store.completionReport(),sourcePhase=report.sourcePhase;
    const sourceSignal=sourcePhase?.current?changeSignal(store,resources,{sourceOnly:true}):null;
    const resumeSourcePhase=sourcePhase?.current===true&&state.sourcePhaseRunId===sourcePhase.checkpoint.runId&&state.sourcePhaseSignal===sourceSignal.signature;
    const dailyPending=cfg.dailyFullFallback===true && (local.hour>7 || local.hour===7&&local.minute>=15) && !fullRunRecorded(store,local.day);
    const dailyReady=state.daily.attempts<3&&(!state.daily.retryAt||state.daily.retryAt<=clock());
    const finalizeFull=!!(dailyPending&&dailyReady&&resumeSourcePhase&&report.complete);
    const fullDue=finalizeFull||dailyPending&&dailyReady&&!resumeSourcePhase;
    const work=fullDue?null:changeSignal(store,resources,resumeSourcePhase?{shoppingOnly:true}:{});
    if(!fullDue&&!work.signature)return;
    if(!fullDue){
      // A repeatedly rejected unchanged original is checked by the daily full
      // run or after new data/access. Do not start Luna just to rediscover it.
      if(knownBlockedOriginalsOnly(work)){if(state.retryAt!==null){state.retryAt=null;save();}return;}
      const wait=resourceWait(work);
      if(wait){if(!state.retryAt||state.retryAt<wait){state.retryAt=wait;save();}return;}
    }
    const shoppingOnly=!fullDue&&work.shoppingOnly;
    const shoppingQueue=shoppingOnly?(store.shopping?.queue()??[]).filter(item=>!['shopping-list-route','shopping-stock-review'].includes(item.do)):null;
    const currentShopping=shoppingOnly?new Set(shoppingCohortSignal(store,shoppingQueue).items):null;
    const heldCohort=shoppingOnly&&state.shoppingCohort?.signals?.length&&state.shoppingCohort.signals.every(item=>currentShopping.has(item))?state.shoppingCohort:null;
    const plannedBatch=shoppingOnly?shoppingWorkBatch(shoppingQueue):null;
    const retryBatch=heldCohort?{items:heldCohort.items,summary:shoppingWorkBatch(shoppingQueue,{limit:heldCohort.shown}).summary}:plannedBatch;
    const assignedSignal=shoppingOnly?shoppingCohortSignal(store,retryBatch.items):null;
    const dispatchSignature=shoppingOnly?assignedSignal.signature:work?.signature;
    const changed=!fullDue&&dispatchSignature!==state.lastSignature;
    if(!retryAfterLogin&&clock()-(state.lastStartedAt??0)<(cfg.minGapMinutes??15)*60000)return;
    if(!fullDue&&!changed && (!state.retryAt || state.retryAt>clock() || (state.attempts??0)>=3))return;
    const lease=store.beginRun();if(!lease.acquired)return;
    retryAfterLogin=false;
    const token=lease.lease.token;running=true;
    const scope=fullDue?'alle':work.shoppingOnly?'handel':'kildeendringer';
    const shoppingBatch=scope!=='kildeendringer'?structuredClone(retryBatch??shoppingWorkBatch((store.shopping?.queue()??[]).filter(item=>!['shopping-list-route','shopping-stock-review'].includes(item.do)))):null;
    if(fullDue){state.daily.attempts++;state.daily.retryAt=null;}
    else{state.lastSignature=dispatchSignature;state.attempts=changed?1:(state.attempts??0)+1;state.retryAt=null;}
    if(shoppingOnly)state.shoppingCohort={items:structuredClone(shoppingBatch.items),signals:assignedSignal.items,shown:shoppingBatch.summary.shown};
    state.lastStartedAt=clock();save();
    const prompt=fullDue?`Gjør den daglige fulle kildekontrollen for Familien. Den planlagte kl. 07-kjøringen ble ikke registrert som utført; dette er reservekjøringen. Les AGENTS.md, config/sources.json, familieprofilen, relevante deler av docs/runbook.md og docs/aktiviteter.md. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run; forny og frigjør bare denne låsen.
Start med next, behandle telefoninnboks og kalenderhandlinger, kjør waste-refresh og kontroller faktisk 30-dagersdekning og kommende avtaler for alle konfigurerte barna, Vigilo-tilleggsflater, Spond, konfigurerte Facebook-grupper og aktivitetskilder. Prioriter kommende 14 dager. Bruk samlerdata, ressursuttrekk og dokumentkvitteringer før nettleser; les alle sider og relevante lenker i nye/endrede vedlegg uansett filformat. Vurder profil, publiser originaler/råkort privat til Drive og synkroniser Calendar med faktiske kvitteringer og familiens varige skjulvalg. Bruk publish hvis Google direktepublisering er koblet til, ellers tilgjengelige Google-verktøy. Ingen kjøp, påmeldinger eller meldinger til andre.
Fortsett til completion er true, eller registrer konkrete eksterne blockers og resumeHint ved faktisk utilgjengelige deler. Avslutt med run scope:"alle" og end-run ${token} i finally. Vær stille når alt er uendret og dekket; varsle nye betydelige funn, tapt innlogging og ny eller forverret manglende dekning.`:`Behandle nye/endrede kildeelementer og ventende publisering i Familien. Dette er en avgrenset kjøring med scope:"kildeendringer", ikke daglig full kildekontroll. Les AGENTS.md, config/sources.json, profile og runbookens nye avsnitt om datahenting. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run; forny og frigjør bare denne låsen.
Start med next. Les collected ID og ressursuttrekk (resource ID) før nettleser. API-overflatene er allerede observert; ikke gjenta uendrede lister eller dokumenter. Nye lenker og vedlegg er ikke begrenset til PDF: følg relevante lenker videre, les alle sider, behold originale filer. Bruk resource-fetch, resource-follow, resource-export og resource-attach. Et maskinuttrekk er ikke en dokumentkvittering. Vurder datoer, barn, oppgaver og profil; arkiver/publiser ekte råkort og originaler privat til Drive, synkroniser Google Calendar med stabile ID-er, faktisk kvittering og familiens varige valg. Bruk publish når Google direktepublisering er tilkoblet; ellers de tilgjengelige Google-verktøyene. Ingen kjøp/påmeldinger eller meldinger til andre.
Behandle review-queue, profilvurderinger, manglende originaler/Drive og kalenderendringer samt nye aktivitetskandidater/endret sidetekst. Bevar aktivitetsforslag som forslag uten automatisk kalenderføring. Nettleser brukes ved dokumenterte hull i data/kommentarer eller tilgang, ikke bare fordi global dekning har eldre åpne flater. Gjenbruk kildefaner. Ikke kontroller alle kildeoversikter på nytt og ikke endre udekkede overflater/kildestatus til ok. Daglig kontroll ivaretar dekningsvinduene.
Sjekk change-completion før avslutning. outcome:"ok" med scope:"kildeendringer" krever complete:true for endringsarbeidet, og betyr aldri at alle kildeoverflater er dekket. Ved ekstern blokkering gjør resten ferdig og registrer partial med konkrete blockers og resumeHint. Frigjør ${token} i finally. Vær stille ved uendret allerede varslet blokkering; varsle nye viktige funn eller endret feil.`;
    const originalReuse='Kjente uendrede dokumentavslag: gjenbruk feilkontrollpunktet under docs/drift og eksisterende ressurs-/dokumentkvitteringer. Ikke gjenta Drive-metadata, Docs-lesing, nettleseråpning, nedlasting eller PDF-rendering bare fordi samme gamle originalrestanse fortsatt inngår i completion. Kravet om et konkret Google-forsøk gjelder første diagnose av et tilgangsproblem og nye publiseringshandlinger, ikke hvert senere avgrensede run. Kontroller på nytt ved faktisk ny tilgang, rettet lenke, ny versjon eller nye bytes. Behandle alle nye kilder/handlinger som vanlig; behold det uløste originalhullet og rapporter partial uten ny identisk tilgangskontroll.';
    const shoppingPrompt=`Handel: behandle bare den frosne arbeidskohorten nedenfor; ikke utvid den i denne kjøringen. Les AGENTS.md, .local/AGENTS.md hvis den finnes, familieprofilen og handelsavsnittene i docs/runbook.md. Bruk gjeldende lokalt dokumentert discovery-/prisoppdatering; aldri en statisk whitelist som erstatning for nye varianter. Start med next, prioriter telefon og kalenderhandlinger, og behandle shopping-sesum-review, shopping-product-review, shopping-market-refresh, shopping-review, shopping-feed-review, shopping-order-link, shopping-family-build og shopping-list-family. Varefamilie er eneste begrep: shopping-family-build betyr at en familie dere følger mangler bibliotekvarianter eller at en variant er endret; bruk shopping-family-candidates og registrer med shopping-family-set. shopping-list-family betyr at en vare på handlelisten mangler varefamilie: søk bredt etter alle kandidater på tvers av merker og butikker, ikke bare den billigste, gjennomgå faktisk innhold og pakning, bygg eller utvid varefamilien i produktbiblioteket og registrer med shopping-list-family etter runbooken. Sesum: les shopping-sesum og hent bare den konkrete kilderaden med shopping-sesum-candidates --source SOURCEKEY; bruk shopping-sesum-review med gjeldende sourceFingerprint og productFingerprint, konkret identitetsbelegg og dokumentert pakning før en priskobling godkjennes. Navn eller EAN alene er aldri tilstrekkelig. Prisinnhenting for alle fulgte familier og faktisk frisk prisdekning rapporteres separat. Nye eller endrede produkter må gjennomgås på gjeldende fingerprint før markedskalibrering. Oppdater de tildelte forfalte varegruppene; én fersk gruppe beviser ikke at resten er kontrollert. Hold hver kundeavisside mot shopping-checklist og registrer alle reelle treff eller konkrete comparable:false-begrunnelser. Send familiegrunnlaget familySetFingerprint fra den faktisk leste gjeldende sjekklisten i shopping-review; ved endrede familier eller krav må den fortsatt gjeldende originalen vurderes mot hele den nye sjekklisten før ny kvittering. Kjedepriser beviser ikke lokal lagerstatus eller kundevilkår. Les shopping-feed før kvittering og fortsett hvis nye/endrede innlegg gjenstår. Behandle shopping-list-route bare når den er klar for nytt forsøk; ikke overstyr familiens avkrysning eller fjernede varer. Ingen bestillinger, meldinger, grensetester eller selvstendige Oda-kurvhandlinger. Bare tjenestens normale sortering av en familieopprettet listevare kan legge varen i kurven, med verifisert kvittering. Uklar kurvskriving skal aldri gjentas. Kontroller shopping-queue og completion.shopping før slutt. Ved eksterne blokkeringer gjør resten ferdig og registrer partial med konkrete blockers og resumeHint; aldri ok med handlearbeid igjen.`;
    const sesumDiscoveryPrompt='Sesum-discovery: Behandle shopping-sesum-discovery som aktiv research av nye varianter utenfor eksisterende produktkoblinger. Behandle bare discovery-trinnet som er tildelt i den frosne kohorten. Les den eksakte kilderaden med shopping-sesum-candidates --source SOURCEKEY og faktisk kildetekst; finn konkret ingrediens-/etikett-/pakningsbelegg hos produsent eller annen primærkilde og søk bredt i bibliotek/Kassal på tvers av merker. Manglende EAN eller gjennomgått donor er aldri automatisk avslag. Bruk shopping-sesum-register med gjeldende sourceFingerprint, identityEvidence, dokumenterte product-fakta/pakning, memberships med gjeldende groupFingerprint og konkret ekvivalens-/kvalitetsbelegg, samt faktiske sourceReceipts. Følg runbookens registerkontrakt; opprett en ny bibliotekgruppe når beviset tilsier det, men koble den aldri automatisk til en fulgt familie. Bevar requires, merkekrav og eksakte varianter gjennom ordinær shopping-family-set. Ukjente ingredienser, egenskaper eller mengder forblir eksplisitte restanser; avslag krever et faktisk påvist avvik. Registreringen fornyer ingen prisdato eller årsbehov og endrer ingen kurv. Nye nedstrømstrinn rutes bare fra gjeldende positive placement-targets og går til neste launch; rå OR-hint gir ikke slik rett. Bevar tidligere eksplisitte scoped blocked/excluded som selvstendige restanser/hold. Kontroller både discovery-/reviewkø og Sesums faktiske innhentingsmanifest før ferdigstatus; kildeinnhenting og godkjent fersk prisdekning er ulike forhold.';
    const sesumCatalogPrompt='Sesums bevarte varebelegg: les shopping-sesum-catalog [FAMILIE] før gjentatt nettleserhenting. Katalogen beholder kildeproduktets sanerte metadata og faktiske fetchedAt selv uten brukbar pris eller etter en mislykket priskvittering. Bruk metadata som forskningsspor og les deretter den aktuelle ingrediens-/pakningsetiketten hos kilde/produsent; saved metadata er ingen produktgodkjenning eller dokumentkvittering. Prices, priceCandidates og andre varers relatedProducts er separate. Uten faktisk priskilde, prisdato eller en konfigurert målkjede finnes ingen fersk sammenligningspris; ikke oppfinn en kjede eller lån prisen til et relatert produkt. Eldre observasjoner beholder gammel hentetid og prisalder. En lest vare med null prisrader kan fortsatt være et viktig shopping-sesum-discovery-funn.';
    const sesumFamilyPrompt='Sesums familiedekning: behandle shopping-sesum-family-review også etter godkjent priskobling eller shopping-sesum-register. Godkjent produktidentitet er ikke en ny familiebeslutning. Les gjeldende registrationFingerprint og familiens requirementsFingerprint/familyReview i shopping-sesum-candidates, og vurder de konkrete gjennomgåtte produktgruppene opp mot husholdningens eksakt-, merke- og egenskapskrav. Bruk ordinær shopping-family-set med faktiske gjeldende gruppefingerprints og bevar øvrige gyldige varianter og krav; et søkehint godkjenner aldri en gruppe. En faktisk gjeldende familielink eller eksakt gjennomgått native variant kan avslutte oppgaven. Påvist avvik krever scoped shopping-sesum-review status:excluded med familyIds, familyFingerprints og registrationFingerprint; manglende fakta krever status:blocked med de samme feltene, konkret equivalenceEvidence/reason og retryAt, aldri et oppfunnet avvik. Fremtidig retry er fortsatt en blokkert fullføringsrestanse. Kontroller både identitets-, familie- og kampanjearbeid før handel rapporteres ferdig; en prisdato eller registrering alene avslutter ingen familievurdering.';
    const sesumExclusionPrompt='Sesums familyIds er bare søkehint: OR-søk kan gi en faktisk vare til helt feil familie. Et feil hint er ikke grunn til global SKU-eksklusjon. Avvis bare konkrete berørte familier med shopping-sesum-review {sourceKey,sourceFingerprint,status:"excluded",familyIds:[...],familyFingerprints:{familieId:requirementsFingerprint,...},registrationFingerprint,equivalenceEvidence}; les gjeldende requirementsFingerprint og registrationFingerprint i shopping-sesum-candidates.families. En hel kylling i filetsøket er eksempelvis bare uegnet for filet-familien. Nye familiehint eller endrede kilde-, produkt-, gruppe- eller familiekrav skal kunne vurderes på nytt. Faktisk produktidentitet, godkjente bibliotekgrupper og familiens egne eksakt-/merke-/egenskapskrav avgjør sammenligning, aldri at varen ble funnet av et søk. Manglende EAN eller donor er fortsatt discovery, ikke avslag.';
    const sesumCampaignPrompt='Sesum-kampanjer: behandle shopping-sesum-offer-review separat fra produktidentitet. Les shopping-sesum-offers [FAMILIE], og kontroller faktiske primære butikk-/annonsevilkår for riktig variant, pakning, bruttopris, periode, medlemskap, kundegrense og flerpakning. Søkehint godkjenner aldri en familie, og en kildebro frigir aldri kampanjevilkår. Registrer med shopping-sesum-offer-review på gjeldende sourceFingerprint, familyFingerprint og campaignFingerprint, helst atomisk med et vanlig offer-objekt; offerId kan brukes bare når akkurat dette tilbudet består samme kontroll. Oppgi conditionsVerified:true, alle seks termsEvidence og faktiske sourceReceipts fra primærlesingen. Raw kvitteringspris er ikke nødvendigvis annonsert kampanjepris; ikke gjett sluttens inklusive kalenderdag fra valid_until ved midnatt. Bruk inclusiveEndOfDayVerified:true bare ved faktisk fersk primærannonse som uttrykkelig bekrefter hele siste tilbudsdag, med konkret manuelt belegg i termsEvidence.period; hver levert slutt-timestamp må være nøyaktig 23:59:59.000 i Europe/Oslo. Tidsformat alene beviser ingenting, og midnatt eller andre klokkeslett gir aldri denne utvidelsen. Ukjente vilkår blir status:blocked med konkret reason, retryAt og belegg, aldri not-actionable. not-actionable krever faktisk påvist utløp, feil kampanjevariant eller at det ikke er et reelt pristilbud, med primærbelegg; lav gevinst avgjøres av serveren og er ingen avslagsgrunn. Endrede vilkår holder tidligere tilbud tilbake på alle prisflater til ny vurdering. Oppdatering av uendrede koblede tilbud gjennom shopping-offer krever sourceReceipt fra faktisk ny primærlesing før observedAt kan fornyes. Bevar familiens listevalg, avslag, kjøp, lager og behov; ingen automatisk bestilling.';
    const browserDependencyPrompt='Nettleseravhengighet: en vanlig Chrome-/browser-host-tilgjengelighetsfeil stopper bare arbeid som faktisk krever nettleseren. Gjør uavhengig arbeid ferdig fra shopping-sesum-catalog/candidates, gjeldende gjennomgått native metadata, kanonisk pakning og kildekvitteringer, Kassal og allerede leste primærressurser når identitetsbeviset faktisk er tilstrekkelig. Tilgjengelige vanlige web-/søkeverktøy kan også brukes til ny lesing av offentlige produsent-/butikkprimærkilder; dokumenter faktisk lest etikett og pakning med kildebelegg, aldri bare søkeutdrag. Uendret sourceFingerprint krever ikke en ny Sesumsidehenting. Nye etikett-/ingrediensmangler forblir konkrete restanser; ikke konkluder global utlogging eller blokkert handelsarbeid fra ett utilgjengelig nettlesergrensesnitt. En vanlig tilgjengelighetsfeil er ikke en eksplisitt safety-stop. En faktisk eksplisitt sikkerhetsstopp fra verktøyet avslutter fortsatt den turen: ikke bytt nettleser, verktøy eller mekanisme for å omgå den. Ikke endre runtime, modell eller tillatelser.';
    const odaPricePrompt='Behandle shopping-oda-refresh med oda-refresh-plan og oda-refresh FIL i avgrensede kall (høyst10familier/5sider). Dette bruker bare lesende Oda MCP product_search. Bevar eksakt kjent SKU, gjennomgått pakning og familiens eksplisitte variantvalg. Et resultat med deferred:true og oda-busy betyr utsatt kildearbeid, ikke en feil eller manglende vare. Bevar planen og kvitteringene, fortsett andre tildelte oppgaver og ikke gjenta busy-kall i løkke. En gammel/manglende pris blir prisrestanse, aldri automatisk dyrere erstatning eller et krav om ny manuell familiemapping. Nye eller endrede produkter trenger egen konkret ingrediens-/form-/variantreview før familiebruk. Manglende treff, enhets-/pakningskonflikt og tilgangsfeil beholdes i blockedOda; ikke skriv fersk pris eller gjenta force i løkke. Ingen kurvhandling er autorisert av prisoppfriskning.';
    const sesumPlacementPrompt='Prisfrie Sesumvarer: ved metadataReplayPendingCount kjør shopping-sesum-metadata-import i endelige lokale deler til rest er0 eller konkret lokalfeil; kommandoen henter ingen kildesider. sesum-product:ID er en kjedenøytral katalogidentitet, aldri en pris eller butikkgodkjenning. Behandle også disse gjennom hele familiesettet. Et relevant mål uten faktisk konfigurert kjedepris blir shopping-sesum-catalog-review; bevar konkret blocked restanse med kind:catalogue, gjeldende sourceFingerprint/familySetFingerprint, reason/evidence og retryAt, eller reopen for eksplisitt nytt forskningsforsøk. Ukjent prisalder er aldri fersk og metadatahenting reaktiverer ikke en kjent gammel vare. Forskede mål kan brukes som researchhint når en virkelig kjederad senere kommer; vanlig identitets-, pakke- og familiegodkjenning kreves fortsatt. Sesums globale plassering: behandle bare den eksakte SOURCEKEY som er tildelt i den frosne kohorten, med shopping-sesum-placement-review én gang per aktuell kildevare mot HELE det gjeldende aktiverte familiesettet, også familier som mangler i OR-søkehintene. Les shopping-sesum-placement SOURCEKEY og alle faktiske familie-/gruppekrav. Registrer shopping-sesum-review med kind:placement, gjeldende sourceFingerprint, registrationFingerprint (null før identityreview), familySetFingerprint, status:reviewed, reviewedAllFamilies:true, konkret scopeEvidence/evidence og targets:[{familyId,familyFingerprint,equivalenceEvidence}]. Et positivt mål må dokumenteres mot aktuelle eksakt-/merke-/egenskapskrav, ikke navn/EAN alene. Forskede mål er bare separate researchhint; de muterer ikke rawFamilyIds og godkjenner ingen metadata, familiekobling eller pris. For denne eksakte kilden ruter bare gjeldende positive placement-targets nytt identitets-/discovery- og familiearbeid til neste launch. Rå OR-hint og effectiveFamilyIds godkjenner ikke nytt nedstrømsarbeid. Bevar tidligere eksplisitte scoped blocked/excluded som selvstendige restanser/hold og alle eksisterende krav ved family-set. no-active-family krever eksplisitt tom targets, noActiveFamilyVerified:true og faktisk begrunnet full vurdering av alle aktive familier; et feil OR-hint eller manglende etikett er ikke slikt bevis. Uferdig research bruker status:blocked med konkret reason/evidence og retryAt; den forblir en fullføringsrestanse. Nye semantiske familiekrav åpner én ny kvittering; uendret reviewtid og prisdato gjør det ikke. En gjeldende konkret familienegativ må vurderes og gjenåpnes eksplisitt før motsatt positiv plassering. Kontroller global plassering separat fra kildeinnhenting, identitetsgodkjenning, familiebruk og kampanjevilkår.';
    const catalogReviewPrompt='Native produktgjennomgang: les HELE den konkrete ingredienslisten/INCI, faktisk form, variant, egenskaper og dokumentert kanonisk pakning mot dagens familiekrav for hvert produkt. En generisk setning om at produktnavnet navngir varetypen er aldri ekvivalensbevis; navn, EAN eller likt tall alene godkjenner ikke innhold, fastvekt eller masse/volum. Ved en gammel godkjenning uten tilstrekkelig belegg, bruk shopping-catalog-review med gjeldende fingerprint, status:reopen og konkret equivalenceEvidence eller reason. Dette bevarer gammel review og faktisk priskvittering, men setter varig reviewHold og shopping-product-review også når varen allerede ligger i en koblet bibliotekgruppe. Ny pris/dato eller metadata avslutter ikke holdet; gi bare ny approved med konkret lest belegg og kanonisk pakning, eller excluded ved faktisk påvist avvik for denne familien. Ukjent oppskrift/form/pakning er researchrestanse, ikke et oppfunnet avslag. Bevar parkering av eldre faktiske priskvitteringer.';
    const scopedPrompt=scope==='handel'?`Gjør en avgrenset handelskjøring med scope:"handel", ikke skole-/aktivitetskontroll. Kjøringslåsen er allerede tatt: ${token}. Ikke kall begin-run. Forny og frigjør bare denne låsen med end-run i finally. ${shoppingPrompt} Registrer run med scope:"handel".`:prompt+(scope==='alle'?'\n'+shoppingPrompt:'');
    const shoppingBatchPrompt=shoppingBatch?`Frosset handelsbolk: ${JSON.stringify(shoppingBatch)}
Behandle bare de konkret oppførte oppgavene med disse nøklene og fingerprintene, høyst20 arbeidsenheter. Hver watchId i en market-refresh teller som én enhet; ikke utvid watchIds. Les nåværende belegg før en beslutning. Et endret fingerprint eller en ny kilde-stage er arbeid for NESTE launch, ikke en utvidelse av denne kohorten. next og shopping-queue viser også øvrig arbeid; ikke legg det til denne bolken. Ikke bruk --full for å utvide oppdraget.
Kontroller faktisk lagrede kvitteringer og completion før avslutning. Påstå aldri at en oppgave er ferdig bare fordi den var tildelt. Når tilgjengelig handelsarbeid faktisk gjenstår, ${scope==='handel'?'registrer run med scope:"handel", outcome:"continued", konkret summary og resumeHint som angir neste arbeid':'registrer run med scope:"alle", outcome:"continued" og det eksplisitte kildefasekontrollpunktet beskrevet nedenfor, med konkret summary og resumeHint'}; tjenesten beregner selv remaining/blocked. Dette er et kontrollpunkt, aldri fullført handel eller en ekstern blocker. Når bare konkrete blockers gjenstår, bruk ordinær partial med faktiske blockers og resumeHint. Bruk ok bare dersom hele completion.shopping er complete:true. Frigjør egen lease i finally; dispatcheren fortsetter neste bolk med vanlige pause- og prioritetsregler.`:'';
    const sourcePhasePrompt=scope==='alle'?(finalizeFull?`Avsluttende fullføringskontroll: gjenbruk bare det fortsatt gyldige kildefasekontrollpunktet ${sourcePhase.checkpoint.runId}. Det beviser ikke at tidligere konkrete kildeblockers er løst. Ikke gjør en ny full kildegjennomgang av uendrede flater. Les completion og activity-queue; scope:alle/outcome:ok krever faktisk global complete:true. Ny kildesak, familiehandling eller ugyldig/utløpt kildefase betyr at grunnlaget må vurderes på nytt.`:`Denne fulle kjøringen har en avgrenset handelsbolk. Gjennomfør den faktiske kildefasen først, med konkrete utfall for alle kilder og faktiske lagrede source-status-kvitteringer; behold ekte uleste originaler og flater som ufullstendige. Behandle deretter bare den frosne handelsbolken. Dersom aktivt handelsarbeid fortsatt gjenstår, kan du registrere scope:"alle",outcome:"continued" med sourcePhaseReviewed:true, sourcePhaseFingerprint fra den faktisk leste gjeldende completion.sourcePhase.fingerprint, konkret sourcePhaseEvidence, sources:[{source,health,details}] for alle konfigurerte kilder, faktiske bevarte kildeblockers og konkret resumeHint. Dette er bare et fingerprintbundet kildefasekontrollpunkt, aldri global dekning eller en fullført dagskontroll. En kilde som fortsatt har en reell blocker er fortsatt ufullstendig. Nye kildesaker/familiehandlinger eller utløpt kildeferskhet preempter senere handel. Dispatcheren fortsetter uavhengig handel uten å gjenta uendret kildefase; et endret kildegrunnlag må leses på nytt. Bare faktisk full completion tillater scope:alle/outcome:ok.`):'';
    const researchPrompts=scope==='kildeendringer'?'':[shoppingBatchPrompt,odaPricePrompt,catalogReviewPrompt,sesumDiscoveryPrompt,sesumCatalogPrompt,sesumPlacementPrompt,sesumFamilyPrompt,sesumExclusionPrompt,sesumCampaignPrompt,browserDependencyPrompt,sourcePhasePrompt].join('\n');
    let finished=false;
    const finish=(code,error)=>{
      if(finished)return;finished=true;
      state.lastFinishedAt=clock();state.lastError=error ?? (code!==0?'Agenten avsluttet med feil.':null);
      if(fullDue){
        const phase=store.completionReport().sourcePhase;
        if(phase?.current&&phase.checkpoint.runId!==sourcePhase?.checkpoint?.runId&&Date.parse(phase.checkpoint.checkedAt)>=state.lastStartedAt){state.sourcePhaseRunId=phase.checkpoint.runId;state.sourcePhaseSignal=changeSignal(store,resources,{sourceOnly:true}).signature;}
        state.daily.retryAt=!fullRunRecorded(store,state.daily.day)&&state.daily.attempts<3?clock()+[0,30,120][state.daily.attempts]*60000:null;
      }else{
        const phase=store.completionReport().sourcePhase;
        const left=changeSignal(store,resources,phase?.current&&state.sourcePhaseRunId===phase.checkpoint.runId?{shoppingOnly:true}:{});
        if(shoppingOnly){
          const actual=new Set(shoppingCohortSignal(store,store.shopping?.queue()??[]).items),progress=assignedSignal.items.some(item=>!actual.has(item));
          if(progress){state.attempts=0;state.shoppingCohort=null;state.lastSignature=null;}
          else state.lastSignature=assignedSignal.signature;
        }else{
          const leftItems=new Set(left.items),beforeItems=new Set(work.items);
          if(work.items.some(item=>!leftItems.has(item))||left.items.some(item=>!beforeItems.has(item)))state.attempts=0;
          state.lastSignature=left.signature;
        }
        state.retryAt=left.count && state.attempts<3?clock()+[0,30,120][state.attempts]*60000:null;
        const wait=resourceWait(left);if(wait)state.retryAt=Math.max(state.retryAt??0,wait);
      }
      state.worker=null;release(token);running=false;save();
    };
    try{const child=launch({root,prompt:scopedPrompt+'\n'+researchPrompts+'\n'+originalReuse,onExit:finish});if(!finished&&child?.pid){state.worker={pid:child.pid,token,scope,startedAt:clock(),...(shoppingBatch?{shoppingBatch}:{} )};save();}}catch(error){finish(-1,error.message);}
  }
  function renew(){if(running&&state.worker&&store.snapshot().runLease?.token===state.worker.token)store.renewRun(state.worker.token);}
  const status=()=>{clearRecoveredLoginError();return {enabled:config().enabled===true,running,workerScope:state.worker?.scope??null,shoppingBatch:state.worker?.shoppingBatch??null,attempts:state.attempts??0,dailyFullFallback:config().dailyFullFallback===true,dailyFull:state.daily??null,lastStartedAt:state.lastStartedAt??null,lastFinishedAt:state.lastFinishedAt??null,retryAt:state.retryAt??null,lastError:state.lastError??null};};
  function resumeAfterLogin(){
    if(!/innlogging/.test(state.lastError??''))throw Error('Ingen registrert ChatGPT-innloggingsfeil å gjenoppta.');
    if(running)return status();
    state.retryAt=null;state.attempts=0;
    if(state.daily?.day===osloDayAndHour(clock()).day){state.daily.retryAt=null;state.daily.attempts=0;}
    save();retryAfterLogin=true;tick();return status();
  }
  return {tick,renew,resumeAfterLogin,status};
}
