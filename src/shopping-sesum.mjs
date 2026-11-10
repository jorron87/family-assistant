import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {decrypt,encrypt,loadKey} from './crypto.mjs';

const ORIGIN='https://www.sesum.no';
const CHAIN_CODES=new Set(['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA']);
const chainCode=code=>({EXTRA:'COOP_EXTRA',MENY:'MENY_NO',SPAR:'SPAR_NO',ODA:'ODA_NO',EUROPRIS:'EUROPRIS_NO',OBS:'COOP_OBS',PRIX:'COOP_PRIX',MEGA:'COOP_MEGA'}[code]??code);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const unique=items=>[...new Set(items)];
const text=(value,max=250)=>typeof value==='string'&&value.trim()&&value.length<=max?value.trim():null;

export function sesumQueryPlan(requestedQueries){
  return requestedQueries.map(requestedQuery=>{
    if(!text(requestedQuery,4000))throw Error('Ugyldig Sesum-søketekst.');
    const normalizedQuery=requestedQuery.normalize('NFC').replace(/\s+/gu,' ').trim();
    const [coreQuery,...descriptorNotes]=normalizedQuery.split(/\s*·\s*/u),actualQueries=[],unsearchableTerms=[];
    if(!coreQuery)throw Error('Sesum-søket mangler varenavn før kvalifikatorene.');
    let chunk='';
    const flush=()=>{if(chunk){actualQueries.push(chunk);chunk='';}};
    for(const word of coreQuery.split(' ').filter(Boolean)){
      if(word.length>64){flush();unsearchableTerms.push(word);continue;}
      if(chunk&&chunk.length+1+word.length>64)flush();
      chunk=chunk?chunk+' '+word:word;
    }
    flush();
    return {requestedQuery,normalizedQuery,coreQuery,descriptorNotes,actualQueries,unsearchableTerms};
  });
}

// This source can request only its ordinary public search and product pages.
export function sesumUrl(value,kind){
  if(typeof value!=='string'||value.length>4096)throw Error('Ugyldig Sesum-adresse.');
  const url=new URL(value);
  if(url.origin!==ORIGIN||url.username||url.password||url.hash)throw Error('Ugyldig Sesum-adresse.');
  if(kind==='product'){
    if(!/^\/produkt\/[1-9]\d*(?:-[^/?#]+)?\/?$/.test(url.pathname)||url.search)throw Error('Ugyldig Sesum-vareadresse.');
  }else if(kind==='search'){
    if(url.pathname!=='/sok'||!text(url.searchParams.get('q'),64)||url.searchParams.getAll('q').length!==1)throw Error('Ugyldig Sesum-søk: høyst 64 tegn.');
    for(const [key,val] of url.searchParams){
      if(!new Set(['q','page','side','offset','limit','cursor']).has(key)||val.length>2000)throw Error('Ukjent Sesum-søkeside.');
      if(['page','side','offset','limit'].includes(key)&&!/^\d{1,9}$/.test(val))throw Error('Ugyldig Sesum-paginering.');
    }
    url.searchParams.sort();
  }else throw Error('Ukjent Sesum-jobbtype.');
  return url.href;
}

export function sesumSenderAllowed(headers,{extension=false,write=false}={}){
  try{const local=new URL('http://'+headers.host);if(local.username||local.password||!['127.0.0.1','localhost','[::1]'].includes(local.hostname))return false;}catch{return false;}
  if(write&&headers['x-family-request']!=='1')return false;
  if(!headers.origin)return true;
  try{
    const origin=new URL(headers.origin);
    if(extension&&origin.protocol==='chrome-extension:'&&/^[a-p]{32}$/.test(origin.hostname)&&['','/'].includes(origin.pathname)&&!origin.search&&!origin.hash)return true;
    return origin.protocol==='http:'&&origin.host===headers.host&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  }catch{return false;}
}

function familySnapshot(input){
  if(!Array.isArray(input))throw Error('Sesum mangler varefamilier.');
  const families=input.filter(f=>f.enabled!==false).map(f=>{
    const familyId=text(f.familyId??f.id,200),name=text(f.name),unit=text(f.unit,10);
    if(!familyId||!name||!unit)throw Error('Ugyldig Sesum-varefamilie.');
    const requestedQueries=unique((Array.isArray(f.queries)&&f.queries.length?f.queries:[name]).map(q=>{if(!text(q,4000))throw Error('Ugyldig Sesum-søketekst.');return q.trim();}));
    const queryPlan=sesumQueryPlan(requestedQueries),queries=unique(queryPlan.flatMap(p=>p.actualQueries));
    const products=(f.products??[]).map(p=>({productKey:p.productKey,metadataFingerprint:p.metadataFingerprint,reviewCurrent:p.reviewCurrent,groupIds:p.groupIds,canonicalPackAmount:p.canonicalPackAmount,unit:p.unit}));
    const fingerprint=f.requirementsFingerprint??f.fingerprint??digest({name,unit,products});
    const legacyFingerprint=f.requirementsFingerprint??f.fingerprint??digest({name,unit,queries:requestedQueries,products});
    return {familyId,name,unit,queries,requestedQueries,queryPlan,fingerprint,legacyFingerprint};
  });
  if(new Set(families.map(f=>f.familyId)).size!==families.length)throw Error('Duplikat Sesum-varefamilie.');
  return families.sort((a,b)=>a.familyId.localeCompare(b.familyId));
}

function productResult(result,job,chains,now){
  if(!result||result.kind!=='product'||result.ok!==true||sesumUrl(result.sourceUrl,'product')!==job.url)throw Error('Sesum-varekvitteringen passer ikke jobben.');
  const p=result.product;
  if(!p||!['string','number'].includes(typeof p.id)||!/^[1-9]\d*$/.test(String(p.id))||!Number.isSafeInteger(Number(p.id))||String(p.id)!==new URL(job.url).pathname.match(/^\/produkt\/(\d+)/)?.[1]||!text(p.name,1000)||!Array.isArray(result.prices)||result.prices.length>100)throw Error('Ufullstendig Sesum-varekvittering.');
  const field=(value,label,max)=>{if(value==null)return null;if(typeof value!=='string'||value.length>max)throw Error('Ugyldig Sesum-'+label+'.');return text(value,max);};
  const product={id:String(p.id),name:text(p.name,1000),brand:field(p.brand,'merke',300),vendor:field(p.vendor,'leverandør',300),ean:p.ean??null,nonEanCodes:p.nonEanCodes??[],weight:p.weight??null,weightUnit:field(p.weightUnit,'vektenhet',30),soldByWeight:typeof p.soldByWeight==='boolean'?p.soldByWeight:null,sourceUrl:job.url};
  if(product.weight!==null&&(!Number.isFinite(product.weight)||product.weight<=0||product.weight>1e9))throw Error('Ugyldig Sesum-vekt.');
  if(p.soldByWeight!=null&&typeof p.soldByWeight!=='boolean')throw Error('Ugyldig Sesum-vektgrunnlag.');
  if(product.ean!==null){const eans=Array.isArray(product.ean)?product.ean:[product.ean];if(eans.length>30||!eans.every(ean=>typeof ean==='string'&&/^\d{8,14}$/.test(ean)))throw Error('Ugyldig Sesum-strekkode.');}
  if(!Array.isArray(product.nonEanCodes)||product.nonEanCodes.length>30||product.nonEanCodes.some(code=>typeof code!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(code)||/^\d{8,14}$/.test(code)))throw Error('Ugyldig lokal Sesum-kode.');
  product.nonEanCodes=unique(product.nonEanCodes);
  const safePromotion=value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return null;
    const keys=['id','title','description','startsAt','endsAt','startDate','endDate','validFrom','validTo','valid_from','valid_to','valid_until','validUntil','memberOnly','member_only','memberProgram','member_program','customerLimit','customer_limit','limit','quantity','price','multi_buy_quantity','multi_buy_price','multi_buy_pay_for','conditions'];
    return Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,typeof value[k]==='string'?text(value[k],2000):typeof value[k]==='boolean'||Number.isFinite(value[k])?value[k]:null]));
  };
  const safePrice=(price,reason)=>({storeCode:chainCode(price.storeCode),sourceStoreCode:text(price.storeCode,100),storeId:typeof price.storeId==='string'?text(price.storeId,100):Number.isSafeInteger(price.storeId)?price.storeId:null,price:Number.isFinite(price.price)&&price.price>0?price.price:null,rawUnitPrice:Number.isFinite(price.rawUnitPrice)?price.rawUnitPrice:null,source:text(price.source,100),observedAt:text(price.observedAt,100),isPromo:price.isPromo===true,promotion:safePromotion(price.promotion),sourceUrl:job.url,...(reason?{reason}:{})});
  const prices=[],priceCandidates=Array.isArray(result.priceCandidates)?result.priceCandidates.filter(p=>p&&chains.includes(chainCode(p.storeCode))).map(p=>safePrice(p,text(p.reason,150)??'unproven_price')):[];
  const relatedProducts=Array.isArray(result.candidates)?result.candidates.filter(p=>p&&typeof p==='object'&&['string','number'].includes(typeof p.id)&&/^[1-9]\d*$/.test(String(p.id))&&Number.isSafeInteger(Number(p.id))).map(p=>{
    let sourceUrl=null;
    if(p.sourceUrl!=null){try{sourceUrl=sesumUrl(p.sourceUrl,'product');if(new URL(sourceUrl).pathname.match(/^\/produkt\/(\d+)/)?.[1]!==String(p.id))sourceUrl=null;}catch{/* A broken suggestion never invalidates the own product receipt. */}}
    return {id:String(p.id),name:text(p.name,1000),sourceUrl,reason:text(p.reason,150)};
  }):[];
  for(const price of result.prices){
    if(!price||typeof price!=='object'||Array.isArray(price))throw Error('Ugyldig Sesum-priskvittering.');
    const code=chainCode(price.storeCode);
    if(!chains.includes(code))continue;
    if(price.price!==null&&(!Number.isFinite(price.price)||price.price<=0||price.price>1e9))throw Error('Ugyldig Sesum-pakkepris.');
    if(price.observedAt!==null&&price.observedAt!==undefined&&(!iso(price.observedAt)||Date.parse(price.observedAt)>now.getTime()))throw Error('Ugyldig faktisk Sesum-prisdato.');
    if(!price.observedAt||!text(price.source,100)){priceCandidates.push(safePrice(price,'missing_price_provenance'));continue;}
    prices.push(safePrice(price));
  }
  return {...product,prices,priceCandidates,relatedProducts};
}

/** Public-page work queue. Progress is separate from reviewed, usable prices. */
export function createSesumCollector({dataDir,config={},families,receivePrices,now=()=>new Date(),encryptionKey}={}){
  const enabled=config.enabled===true;
  const chains=unique((config.chainCodes??['KIWI','REMA_1000','COOP_EXTRA']).map(chainCode));
  if(chains.some(c=>!CHAIN_CODES.has(c)))throw Error('Ukjent Sesum-kjedekode.');
  const minSpacingMs=Math.max(1500,Number(config.minSpacingMs)||1500),cycleCalls=Math.max(1,Math.min(8,Number(config.cycleCalls)||4));
  const refreshHours=Math.max(1,Number(config.refreshHours)||24);
  const snapshot=()=>familySnapshot(families().map(f=>{
    const id=f.familyId??f.id;
    if(!config.queryOverrides||!Object.hasOwn(config.queryOverrides,id))return f;
    const queries=config.queryOverrides[id];
    if(!Array.isArray(queries)||!queries.length||queries.some(q=>!text(q,4000)))throw Error('Ugyldige lokale Sesum-søk.');
    return {...f,queries:unique([...(Array.isArray(f.queries)&&f.queries.length?f.queries:[f.name]),...queries])};
  }));
  const path=join(dataDir,'sesum-collector.json.enc');
  let key=encryptionKey,state={schemaVersion:1,run:null,history:[],pauseUntil:null,observations:{}},loaded=false;
  function load(){
    if(loaded)return;
    key??=loadKey(dataDir);loaded=true;
    if(existsSync(path)){state=JSON.parse(decrypt(readFileSync(path),key));if(state.schemaVersion!==1)throw Error('Ukjent Sesum-køversjon.');}
    state.observations??={};
  }
  function save(){mkdirSync(dataDir,{recursive:true});const temp=path+'.tmp';writeFileSync(temp,encrypt(Buffer.from(JSON.stringify(state)),key));renameSync(temp,path);}
  const jobId=(kind,url,generation=0)=>digest(kind+url+':'+generation);
  const resolvedId=(run,id)=>{const seen=new Set();while(run.productAliases&&Object.hasOwn(run.productAliases,id)&&!seen.has(id)){seen.add(id);id=run.productAliases[id];}return id;};
  let indexedRun=null,productIndex=new Map(),replayTask=null;
  function indexProducts(run){
    if(indexedRun!==run){indexedRun=run;productIndex=new Map(Object.values(run.jobs).filter(j=>j.kind==='product').map(j=>[j.url,j.id]));}
    return productIndex;
  }
  function checkedObservation(job){
    const fetchedAt=job.observationFetchedAt??job.fetchedAt,p=job.productObservation;
    if(!p||!iso(fetchedAt))return null;
    try{
      const product=productResult({ok:true,kind:'product',sourceUrl:job.url,product:p,prices:p.prices??[],priceCandidates:p.priceCandidates??[],candidates:p.relatedProducts??[]},job,chains,now());
      for(const price of [...product.prices,...product.priceCandidates]){
        const previous=[...(p.prices??[]),...(p.priceCandidates??[])].find(old=>chainCode(old.storeCode)===price.storeCode&&old.observedAt===price.observedAt&&old.price===price.price);
        if(previous&&chainCode(previous.sourceStoreCode)===price.storeCode)price.sourceStoreCode=previous.sourceStoreCode;
      }
      return {product,fetchedAt};
    }catch{return null;}
  }
  function reusable(job){
    if(job.status!=='complete'||job.observationError||job.callbackPending)return null;
    const checked=checkedObservation(job);if(!checked)return null;
    return {...checked,appliedFamilyIds:[...(job.appliedFamilyIds??job.familyIds)]};
  }
  function queueReplay(job){
    const receipt=reusable(job);if(!receipt)return;
    const missing=job.familyIds.filter(id=>!receipt.appliedFamilyIds.includes(id));
    if(missing.length){job.appliedFamilyIds=receipt.appliedFamilyIds;job.replayFamilyIds=unique([...(job.replayFamilyIds??[]),...missing]);}
  }
  function propagateFamilies(run,job,familyIds,seen=new Set()){
    if(seen.has(job.id))return;seen.add(job.id);
    const added=familyIds.filter(id=>!job.familyIds.includes(id));
    if(job.kind==='product'&&added.length&&job.status==='complete'&&!job.appliedFamilyIds)job.appliedFamilyIds=[...job.familyIds];
    job.familyIds=unique([...job.familyIds,...familyIds]);
    if(job.kind==='product'){
      if(added.length&&job.status==='complete'&&!reusable(job)){job.status='pending';job.deliveredUntil=null;job.retryAt=null;job.replayFamilyIds=[];job.rescanReason='missing-validated-product-observation';}
      queueReplay(job);return;
    }
    if(!added.length)return;
    if(!Array.isArray(job.productJobIds)&&job.discovered!==0&&job.status==='complete'){
      // Legacy search receipts do not record their product edges. Re-read the
      // search instead of inventing which old products belonged to its result.
      job.status='pending';job.deliveredUntil=null;job.retryAt=null;job.rescanReason='missing-search-product-edges';
    }
    for(const id of [...(job.productJobIds??[]),...(job.nextJobIds??[])]){
      const child=run.jobs[resolvedId(run,id)];if(child)propagateFamilies(run,child,added,seen);
    }
  }
  function migrateProducts(run){
    if(run.productDedupeVersion===1)return false;
    const byUrl=new Map(),priority=new Set((run.repairPriority??[]).map(id=>resolvedId(run,id)));
    for(const job of Object.values(run.jobs))if(job.kind==='product'){
      if(job.observationError&&!job.callbackPending){const receipt=checkedObservation(job);if(receipt){job.callbackPending={...receipt,sourceStatus:job.observationStatus??'partial',familyIds:[...job.familyIds]};job.priceChains=[];job.priceReceipts=[];}}
      const rows=byUrl.get(job.url)??[];rows.push(job);byUrl.set(job.url,rows);
    }
    for(const rows of byUrl.values()){
      if(rows.length<2)continue;
      const time=j=>Math.max(Date.parse(j.observationFetchedAt)||0,Date.parse(j.fetchedAt)||0,Date.parse(j.createdAt)||0);
      const sorted=[...rows].sort((a,b)=>time(b)-time(a)),successful=sorted.find(reusable);
      const changed=sorted.find(j=>(j.callbackPending||j.observationError||j.status==='partial')&&(!successful||time(j)>time(successful)));
      const selectedRepair=sorted.find(j=>priority.has(j.id)),winner=changed??selectedRepair??successful??sorted.find(j=>j.status==='pending')??sorted[0];
      if(selectedRepair&&winner!==selectedRepair){
        winner.mergedRepairIds=unique([...(winner.mergedRepairIds??[]),selectedRepair.id]);
        if(['partial','blocked'].includes(winner.status)){winner.status='pending';winner.deliveredUntil=null;winner.retryAt=null;winner.attempts=0;}
      }
      if(winner.status==='complete'&&!winner.appliedFamilyIds)winner.appliedFamilyIds=[...winner.familyIds];
      winner.familyIds=unique(rows.flatMap(j=>j.familyIds));
      run.productAliases??={};run.mergedProductJobs??={};
      for(const old of rows)if(old!==winner){run.mergedProductJobs[old.id]={job:structuredClone(old),mergedInto:winner.id,mergedAt:now().toISOString()};run.productAliases[old.id]=winner.id;delete run.jobs[old.id];}
      for(const id of Object.keys(run.productAliases))run.productAliases[id]=resolvedId(run,run.productAliases[id]);
      if(winner.observationError&&!winner.callbackPending){
        const receipt=checkedObservation(winner);
        if(receipt){winner.callbackPending={...receipt,sourceStatus:winner.observationStatus??'partial',familyIds:[...winner.familyIds]};winner.priceChains=[];winner.priceReceipts=[];}
      }
      queueReplay(winner);
    }
    if(run.repairPriority)run.repairPriority=unique(run.repairPriority.map(id=>resolvedId(run,id)));
    run.productDedupeVersion=1;indexedRun=null;return true;
  }
  function addJob(run,kind,url,familyIds,generation=0){
    const canonical=sesumUrl(url,kind),id=kind==='product'?indexProducts(run).get(canonical)??jobId(kind,canonical,generation):jobId(kind,canonical,generation);
    if(run.jobs[id]){
      const job=run.jobs[id];propagateFamilies(run,job,familyIds);
      return job;
    }
    const job=run.jobs[id]={id,kind,url:canonical,generation,familyIds:[...familyIds],status:'pending',attempts:0,createdAt:now().toISOString()};
    if(kind==='product')indexProducts(run).set(canonical,id);return job;
  }
  function start(snapshot){
    if(state.run)for(const job of Object.values(state.run.jobs))if(job.productObservation)state.observations[job.productObservation.id]=mergeObservation(state.observations[job.productObservation.id],observation(state.run,job));
    if(state.run)state.history=[{id:state.run.id,startedAt:state.run.startedAt,finishedAt:state.run.finishedAt??null,status:state.run.status,familyCount:state.run.families.length},...state.history].slice(0,7);
    const run={id:randomUUID(),startedAt:now().toISOString(),finishedAt:null,status:'collecting',fingerprint:digest(snapshot),families:snapshot,chainCodes:chains,revision:0,plannerVersion:2,productDedupeVersion:1,jobs:{}};
    for(const family of snapshot)for(const query of family.queries){const url=new URL('/sok',ORIGIN);url.searchParams.set('q',query);addJob(run,'search',url.href,[family.familyId]);}
    finish(run);
    state.run=run;state.pauseUntil=null;save();return run;
  }
  function observation(run,job){
    const p=job.productObservation,{prices=[],priceCandidates=[],relatedProducts=[],...metadata}=p;
    return {runId:run.id,jobId:job.id,familyIds:[...job.familyIds],sourceUrl:job.url,fetchedAt:job.observationFetchedAt??job.fetchedAt,collectionStatus:job.status,callbackError:job.observationError??null,productObservationFingerprint:digest(metadata),product:structuredClone(p),parsedPriceCount:prices.length,unprovenPriceCount:priceCandidates.length,relatedProductCount:relatedProducts.length};
  }
  function mergeObservation(previous,incoming){
    if(!previous)return incoming;
    const latest=Date.parse(incoming.fetchedAt)>=Date.parse(previous.fetchedAt)?incoming:previous;
    return {...latest,familyIds:unique([...previous.familyIds,...incoming.familyIds])};
  }
  function ensure(){
    load();const currentSnapshot=snapshot();
    const run=state.run;
    if(!run||JSON.stringify(run.chainCodes)!==JSON.stringify(chains)||(run.finishedAt&&now()-Date.parse(run.finishedAt)>=refreshHours*3600000))return start(currentSnapshot);
    const migrated=migrateProducts(run);
    if(run.fingerprint!==digest(currentSnapshot)){
      const current=new Map(currentSnapshot.map(f=>[f.familyId,f])),before=new Map(run.families.map(f=>[f.familyId,f]));
      const changed=currentSnapshot.filter(f=>{const old=before.get(f.familyId);return !old||old.name!==f.name||old.unit!==f.unit||!(old.fingerprint===f.fingerprint||!old.queryPlan&&old.fingerprint===f.legacyFingerprint);}),changedIds=new Set(changed.map(f=>f.familyId));
      for(const [id,job] of Object.entries(run.jobs)){
        if(job.productObservation)state.observations[job.productObservation.id]=mergeObservation(state.observations[job.productObservation.id],observation(run,job));
        job.familyIds=job.familyIds.filter(id=>current.has(id)&&!changedIds.has(id));
        if(job.kind==='search'&&new URL(job.url).searchParams.get('q')?.length>64){
          run.supersededSearches??={};run.supersededSearches[id]={id,url:job.url,status:job.status,familyIds:[...job.familyIds],reason:'source-query-limit-64',fetchedAt:job.fetchedAt??null};
          delete run.jobs[id];
        }else if(!job.familyIds.length)delete run.jobs[id];
        if(job.appliedFamilyIds)job.appliedFamilyIds=job.appliedFamilyIds.filter(id=>current.has(id)&&!changedIds.has(id));
        if(job.replayFamilyIds)job.replayFamilyIds=job.replayFamilyIds.filter(id=>current.has(id)&&!changedIds.has(id));
      }
      indexedRun=null;
      run.revision=(run.revision??0)+1;
      const seeds=new Set();for(const job of Object.values(run.jobs))if(job.kind==='search'){const url=new URL(job.url);if([...url.searchParams.keys()].every(k=>k==='q'))for(const id of job.familyIds)seeds.add(JSON.stringify([id,url.searchParams.get('q')]));}
      for(const family of currentSnapshot)for(const query of family.queries)if(!seeds.has(JSON.stringify([family.familyId,query]))){const url=new URL('/sok',ORIGIN);url.searchParams.set('q',query);addJob(run,'search',url.href,[family.familyId],run.revision);}
      run.families=currentSnapshot;run.fingerprint=digest(currentSnapshot);run.plannerVersion=2;run.finishedAt=null;run.status='collecting';finish(run);save();
    }else if(migrated){finish(run);save();}
    return run;
  }
  function refresh(){if(!enabled)return status();load();start(snapshot());return status();}
  function retry(input){
    if(!enabled)throw Error('Sesum-innhenting er ikke aktivert.');
    load();const run=state.run,evidence=text(input?.evidence,2000),ids=input?.jobIds;
    if(!run||input?.runId!==undefined&&input.runId!==run.id)throw Error('Ukjent eller utgått Sesum-kjøring.');
    if(!evidence||!Array.isArray(ids)||!ids.length||ids.length>10000)throw Error('Oppgi Sesum-jobber og konkret begrunnelse.');
    const selected=unique(ids).map(id=>{
      if(!text(id,200)||!Object.hasOwn(run.jobs,resolvedId(run,id)))throw Error('Ukjent Sesum-jobb.');
      const job=run.jobs[resolvedId(run,id)];if(!['partial','blocked'].includes(job.status))throw Error('Bare partial/blocked Sesum-jobber kan prøves på nytt.');
      return job;
    });
    const requestedAt=now().toISOString();
    for(const job of selected){
      job.retryHistory=[...(job.retryHistory??[]),{requestedAt,evidence,previousStatus:job.status,previousAttempts:job.attempts,previousError:job.error??null,previousErrors:job.errors??[],previousObservationError:job.observationError??null,previousCallbackPending:job.callbackPending??null,previousCompletedAt:job.completedAt??null}].slice(-20);
      job.status='pending';job.attempts=0;job.deliveredUntil=null;job.retryAt=null;job.error=null;job.errors=[];job.completedAt=null;job.observationError=null;job.callbackPending=null;job.replayFamilyIds=[];job.replayError=null;job.replayRetryAt=null;
    }
    run.repairPriority=unique([...selected.map(job=>job.id),...(run.repairPriority??[])]);
    run.scheduler={...run.scheduler,repairNormalSlots:0};
    run.status='collecting';run.finishedAt=null;save();
    return {runId:run.id,retried:selected.map(job=>job.id),count:selected.length,pauseUntil:state.pauseUntil??null};
  }
  function fairSelection(run,ready){
    const scheduler={nextKind:'product',searchAfterFamilyId:null,productAfterFamilyId:null,repairNormalSlots:0,...run.scheduler},selected=[],used=new Set();
    const priority=unique(run.repairPriority??[]).filter(id=>run.jobs[id]?.status==='pending'),priorityIds=new Set(priority),readyById=new Map(ready.map(job=>[job.id,job]));
    const familyIds=run.families.map(f=>f.familyId),byKind={search:new Map(),product:new Map()};
    for(const job of ready)if(!priorityIds.has(job.id))for(const familyId of job.familyIds){const list=byKind[job.kind].get(familyId)??[];list.push(job);byKind[job.kind].set(familyId,list);}
    function choose(kind){
      const start=familyIds.indexOf(scheduler[kind+'AfterFamilyId']);
      for(let step=1;step<=familyIds.length;step++){
        const familyId=familyIds[(start+step)%familyIds.length],job=byKind[kind].get(familyId)?.find(j=>!used.has(j.id));
        if(job){scheduler[kind+'AfterFamilyId']=familyId;return job;}
      }
      return null;
    }
    const chooseRepair=()=>priority.map(id=>readyById.get(id)).find(job=>job&&!used.has(job.id))??null;
    for(let slot=0;slot<cycleCalls;slot++){
      let repair=false,job=null;
      if(scheduler.repairNormalSlots<=0){job=chooseRepair();repair=!!job;}
      if(!job)job=choose(scheduler.nextKind)??choose(scheduler.nextKind==='product'?'search':'product');
      if(!job){job=chooseRepair();repair=!!job;}
      if(!job)break;selected.push(job);used.add(job.id);
      if(repair)scheduler.repairNormalSlots=3;
      else{scheduler.repairNormalSlots=Math.max(0,scheduler.repairNormalSlots-1);scheduler.nextKind=job.kind==='product'?'search':'product';}
    }
    return {selected,scheduler};
  }
  function work({peek=false}={}){
    if(!enabled)return {enabled:false,jobs:[],limits:{minSpacingMs,cycleCalls}};
    const run=ensure(),at=now().getTime();
    if(state.pauseUntil&&Date.parse(state.pauseUntil)>at)return {enabled:true,runId:run.id,jobs:[],pauseUntil:state.pauseUntil,limits:{minSpacingMs,cycleCalls}};
    const active=config.requireSingleBatch===true?Object.values(run.jobs).filter(j=>j.status==='pending'&&j.deliveredUntil&&Date.parse(j.deliveredUntil)>at):[];
    if(active.length)return {enabled:true,runId:run.id,jobs:[],reason:'active-source-batch',retryAt:active.map(j=>j.deliveredUntil).sort()[0],limits:{minSpacingMs,cycleCalls}};
    const ready=Object.values(run.jobs).filter(j=>j.status==='pending'&&!j.callbackPending&&(!j.retryAt||Date.parse(j.retryAt)<=at)&&(!j.deliveredUntil||Date.parse(j.deliveredUntil)<=at)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const {selected:jobs,scheduler}=fairSelection(run,ready);
    if(!peek){for(const job of jobs)job.deliveredUntil=new Date(at+5*60000).toISOString();if(jobs.length){run.scheduler=scheduler;save();}}
    return {enabled:true,runId:run.id,jobs:jobs.map(({id,kind,url,familyIds})=>({id,kind,url,familyIds})),limits:{minSpacingMs,cycleCalls}};
  }
  function finish(run){
    if(run.repairPriority)run.repairPriority=run.repairPriority.filter(id=>run.jobs[id]?.status==='pending');
    const jobs=Object.values(run.jobs);
    if(jobs.some(j=>j.callbackPending||j.replayFamilyIds?.length)){run.status='collecting';run.finishedAt=null;return;}
    if(jobs.every(j=>j.status!=='pending')){const proven=run.families.every(f=>!(f.queryPlan??[]).some(p=>p.unsearchableTerms.length)&&f.queries.every(q=>jobs.some(j=>j.kind==='search'&&j.familyIds.includes(f.familyId)&&new URL(j.url).searchParams.get('q')===q&&j.endReached===true)));run.status=jobs.some(j=>j.status!=='complete')||!proven?'partial':'complete';run.finishedAt=now().toISOString();}
  }
  const callbackInFlight=new Set();
  async function applyObservation(run,job,receipt,{replayOnly=false}={}){
    const familyIds=unique(receipt.familyIds.filter(id=>job.familyIds.includes(id)));
    if(!familyIds.length){if(replayOnly)job.replayFamilyIds=[];else job.callbackPending=null;return null;}
    callbackInFlight.add(job);
    try{
      const applied=await receivePrices({runId:run.id,jobId:job.id,familyIds,products:[structuredClone(receipt.product)],fetchedAt:receipt.fetchedAt});
      job.review=applied;job.appliedFamilyIds=unique([...(replayOnly?job.appliedFamilyIds??[]:[]),...familyIds]);
      job.replayFamilyIds=(job.replayFamilyIds??[]).filter(id=>!familyIds.includes(id));job.replayError=null;job.replayRetryAt=null;
      if(!replayOnly){
        job.observationError=null;job.callbackPending=null;job.status=receipt.sourceStatus==='ok'?'complete':'partial';
        job.priceCount=receipt.product.prices.length;job.freshPriceCount=receipt.product.prices.filter(p=>p.price!==null&&p.observedAt&&now()-Date.parse(p.observedAt)<=48*3600000).length;
        job.priceChains=unique(receipt.product.prices.map(p=>p.storeCode));job.priceReceipts=receipt.product.prices.map(({storeCode,price,observedAt})=>({storeCode,price,observedAt}));
      }
      queueReplay(job);return applied;
    }catch(error){
      const message=text(error?.message,500)??'Priskvitteringen kunne ikke registreres.';
      job.replayError=message;job.replayRetryAt=new Date(now().getTime()+60000).toISOString();job.replayAttempts=(job.replayAttempts??0)+1;
      if(!replayOnly){job.observationError=message;job.status='pending';}
      save();throw error;
    }finally{callbackInFlight.delete(job);}
  }
  async function replayPending(){
    if(!enabled)return {applied:0,failed:0,pending:0};
    if(replayTask)return replayTask;
    replayTask=(async()=>{
      const run=ensure(),at=now().getTime();let applied=0,failed=0;
      const jobs=Object.values(run.jobs).filter(j=>!callbackInFlight.has(j)&&(j.callbackPending||j.replayFamilyIds?.length)&&(!j.replayRetryAt||Date.parse(j.replayRetryAt)<=at)).slice(0,cycleCalls);
      for(const job of jobs){
        const own=job.callbackPending,checked=own??reusable(job);
        if(!checked)continue;
        const receipt=own?{...own,familyIds:unique([...own.familyIds,...job.familyIds])}:{...checked,familyIds:[...job.replayFamilyIds]};
        try{await applyObservation(run,job,receipt,{replayOnly:!own});applied++;}catch{failed++;}
      }
      finish(run);if(jobs.length)save();
      return {applied,failed,pending:Object.values(run.jobs).filter(j=>j.callbackPending||j.replayFamilyIds?.length).length};
    })();
    try{return await replayTask;}finally{replayTask=null;}
  }
  let receiveTask=Promise.resolve();
  function receive(input){
    const next=receiveTask.catch(()=>{}).then(async()=>{if(replayTask)await replayTask;return receiveNow(input);});
    receiveTask=next;return next;
  }
  async function receiveNow(input){
    if(!enabled)throw Error('Sesum-innhenting er ikke aktivert.');
    load();const run=state.run;
    if(!run||input.runId!==run.id||!Object.hasOwn(run.jobs,resolvedId(run,input.jobId)))throw Error('Ukjent eller utgått Sesum-jobb.');
    const job=run.jobs[resolvedId(run,input.jobId)],alias=job.id!==input.jobId;
    const newerAlias=alias&&job.kind==='product'&&input.status!=='error'&&input.result?.ok===true&&iso(input.fetchedAt)&&Date.parse(input.fetchedAt)>Date.parse(job.observationFetchedAt??job.fetchedAt??0);
    if(job.kind==='product'&&job.productObservation&&iso(input.fetchedAt)&&Date.parse(input.fetchedAt)<Date.parse(job.observationFetchedAt??job.fetchedAt??0))return {accepted:true,duplicate:true,runId:run.id,jobId:job.id};
    if(job.status!=='pending'&&!newerAlias){
      if(alias&&iso(input.fetchedAt)&&['partial','error'].includes(input.status)&&run.mergedProductJobs?.[input.jobId]){
        (run.mergedProductJobs[input.jobId].lateReceipts??=[]).push({status:input.status,fetchedAt:input.fetchedAt,code:text(input.error?.code,80),message:text(input.error?.message,500),errors:Array.isArray(input.result?.errors)?input.result.errors.slice(0,20).map(e=>String(e).slice(0,500)):[]});save();
      }
      return {accepted:true,duplicate:true,runId:run.id,jobId:job.id};
    }
    if(!iso(input.fetchedAt)||Date.parse(input.fetchedAt)>now().getTime()+60000)throw Error('Ugyldig Sesum-hentetid.');
    const collectorVersion=input.collectorVersion??null;
    if(collectorVersion!==null&&(typeof collectorVersion!=='string'||!/^sesum-collector-\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(collectorVersion)))throw Error('Ugyldig Sesum-samlerversjon.');
    const collectorBuild=input.collectorBuild??null;
    if(collectorBuild!==null&&(typeof collectorBuild!=='string'||!/^sesum-collector-build-\d{1,3}\.\d{1,3}\.\d{1,3}-\d{1,6}$/.test(collectorBuild)))throw Error('Ugyldig Sesum-samlerbygg.');
    if(!['ok','partial','error'].includes(input.status))throw Error('Ukjent Sesum-resultatstatus.');
    if(input.status==='error'){
      const code=text(input.error?.code,80)??'fetch_error';
      const requestedDelay=Math.min(24*3600000,Math.max(0,Number(input.error?.retryAfterMs)||0));
      const delay=code==='rate_limited'||code==='auth_required'?Math.max(10*60000,requestedDelay):Math.max(60000,requestedDelay);
      job.attempts++;job.error={code,message:text(input.error?.message,500)??'Kilden kunne ikke leses.'};
      job.deliveredUntil=null;job.retryAt=new Date(now().getTime()+delay).toISOString();
      if(code==='rate_limited'||code==='auth_required'||requestedDelay>0&&(['network_error','unexpected_content_type','unexpected_response_url','oversized_response'].includes(code)||/^http_5\d\d$/.test(code)))state.pauseUntil=new Date(Math.max(Date.parse(state.pauseUntil)||0,Date.parse(job.retryAt))).toISOString();
      if(job.attempts>=3)job.status='blocked';
      finish(run);save();return {accepted:true,runId:run.id,jobId:job.id,status:job.status,retryAt:job.retryAt};
    }
    const result=input.result;
    if(input.status==='partial'&&result?.ok===false&&result.kind===job.kind&&sesumUrl(result.sourceUrl,job.kind)===job.url){
      if(job.callbackPending){(job.unappliedObservationHistory??=[]).push({...structuredClone(job.callbackPending),callbackError:job.observationError??null});job.callbackPending=null;}
      job.replayFamilyIds=[];
      job.status='partial';job.fetchedAt=input.fetchedAt;job.completedAt=now().toISOString();job.deliveredUntil=null;
      job.errors=Array.isArray(result.errors)?result.errors.slice(0,20).map(e=>String(e).slice(0,500)):['Kildens format kunne ikke leses.'];
      finish(run);save();return {accepted:true,runId:run.id,jobId:job.id,status:job.status};
    }
    let applied=null;
    if(job.kind==='search'){
      if(!result||result.kind!=='search'||result.ok!==true||sesumUrl(result.sourceUrl,'search')!==job.url||!Array.isArray(result.productUrls)||!Array.isArray(result.nextUrls))throw Error('Sesum-søkeresultatet passer ikke jobben.');
      const products=unique(result.productUrls.map(url=>sesumUrl(url,'product'))),next=unique(result.nextUrls.map(url=>sesumUrl(url,'search')));
      if(next.some(url=>new URL(url).searchParams.get('q')!==new URL(job.url).searchParams.get('q')||url===job.url))throw Error('Sesum-pagineringen endret søket eller gjentok samme side.');
      function reaches(from,to,seen=new Set()){
        if(from===to)return true;if(seen.has(from))return false;seen.add(from);
        return (run.jobs[from]?.nextJobIds??[]).some(id=>reaches(id,to,seen));
      }
      if(next.some(url=>reaches(jobId('search',url,job.generation),job.id))){
        job.status='partial';job.errors=['pagination_cycle'];job.fetchedAt=input.fetchedAt;job.deliveredUntil=null;finish(run);save();return {accepted:true,runId:run.id,jobId:job.id,status:'partial'};
      }
      job.productJobIds=products.map(url=>addJob(run,'product',url,job.familyIds,job.generation).id);
      job.nextJobIds=next.map(url=>addJob(run,'search',url,job.familyIds,job.generation).id);
      job.errors=Array.isArray(result.errors)?result.errors.slice(0,20).map(e=>String(e).slice(0,500)):[];
      job.discovered=products.length;job.nextPages=next.length;job.endReached=result.endReached===true&&input.status==='ok'&&!job.errors.length;
      job.status=input.status==='ok'&&!job.errors.length&&(job.endReached||next.length>0)?'complete':'partial';
    }else{
      const product=productResult(result,job,chains,now());
      if(job.productObservation)(job.observationHistory??=[]).push({product:structuredClone(job.productObservation),fetchedAt:job.observationFetchedAt??job.fetchedAt,status:job.status,callbackError:job.observationError??null});
      job.productObservation=product;job.observationFetchedAt=input.fetchedAt;job.observationStatus=input.status;job.observationError=null;
      job.priceChains=[];job.priceReceipts=[];job.deliveredUntil=null;job.callbackPending={product:structuredClone(product),fetchedAt:input.fetchedAt,sourceStatus:input.status,familyIds:[...job.familyIds]};
      save();applied=await applyObservation(run,job,job.callbackPending);
    }
    job.fetchedAt=input.fetchedAt;job.completedAt=now().toISOString();job.deliveredUntil=null;
    if(collectorVersion&&job.status==='complete')state.implementationReceipt={collectorVersion,collectorBuild,runId:run.id,jobId:job.id,kind:job.kind,acceptedAt:job.completedAt,fetchedAt:input.fetchedAt,sourceUrl:job.url};
    finish(run);save();await replayPending();return {accepted:true,runId:run.id,jobId:job.id,status:job.status,applied};
  }
  function status(){
    if(!enabled)return {enabled:false,status:'disabled',familyCount:0,chainCodes:chains};
    load();const run=state.run;
    if(!run)return {enabled:true,status:'not_started',familyCount:0,chainCodes:chains};
    const planCurrent=run.fingerprint===digest(snapshot())&&JSON.stringify(run.chainCodes)===JSON.stringify(chains),nextRefreshAt=run.finishedAt?new Date(Date.parse(run.finishedAt)+refreshHours*3600000).toISOString():null,refreshDue=nextRefreshAt!==null&&now()>=Date.parse(nextRefreshAt);
    const jobs=Object.values(run.jobs),freshChains=job=>unique((job.priceReceipts??[]).filter(p=>p.price!==null&&p.observedAt&&now()-Date.parse(p.observedAt)<=48*3600000).map(p=>p.storeCode)),manifest=run.families.map(f=>{
      const own=jobs.filter(j=>j.familyIds.includes(f.familyId)),search=own.filter(j=>j.kind==='search'),products=own.filter(j=>j.kind==='product');
      const unsearchableTerms=(f.queryPlan??[]).flatMap(p=>p.unsearchableTerms),collectionStatus=own.some(j=>j.status==='blocked')?'blocked':own.some(j=>j.status==='pending'||j.callbackPending||j.replayFamilyIds?.includes(f.familyId))?'pending':own.some(j=>j.status==='partial')||unsearchableTerms.length?'partial':'complete';
      const completedZeroMatchQueries=f.queries.filter(q=>{const pages=search.filter(j=>new URL(j.url).searchParams.get('q')===q);return pages.length&&pages.every(j=>j.status==='complete'&&j.discovered===0)&&pages.some(j=>j.endReached);});
      const collectionOutcome=collectionStatus!=='complete'?collectionStatus:products.length?'matches_collected':'no_matches';
      return {familyId:f.familyId,name:f.name,unit:f.unit,fingerprint:f.fingerprint,collectionStatus,collectionOutcome,requestedQueries:f.requestedQueries??f.queries,queryPlan:f.queryPlan??null,queries:f.queries,completedZeroMatchQueries,searchPages:search.length,productCount:products.length,productsCollected:products.filter(j=>j.status==='complete'&&!j.replayFamilyIds?.includes(f.familyId)).length,unresolvedItems:[...own.filter(j=>j.status!=='complete').map(j=>({jobId:j.id,kind:j.kind,status:j.status,url:j.url,reason:j.observationError??j.error??j.errors??null})),...own.filter(j=>j.replayFamilyIds?.includes(f.familyId)).map(j=>({jobId:j.id,kind:'replay',status:'pending',url:j.url,reason:j.replayError??'family-observation-replay-pending'})),...unsearchableTerms.map(term=>({kind:'query',status:'partial',term,reason:'single-term-exceeds-source-limit-64'}))],chains:chains.map(code=>({chainCode:code,collectionStatus,collectionOutcome:collectionStatus!=='complete'?collectionStatus:!products.length?'no_matches':products.some(j=>j.priceChains?.includes(code))?'prices_collected':'no_chain_prices',observedProducts:products.filter(j=>j.priceChains?.includes(code)).length,freshProducts:products.filter(j=>!j.replayFamilyIds?.includes(f.familyId)&&freshChains(j).includes(code)).length,reviewStatus:products.length?'see_price_integration':'no_candidates',freshnessStatus:products.some(j=>!j.replayFamilyIds?.includes(f.familyId)&&freshChains(j).includes(code))?'has_fresh_candidates':'missing_fresh_price'}))};
    });
    return {enabled:true,status:run.status,runId:run.id,startedAt:run.startedAt,finishedAt:run.finishedAt,planCurrent,nextRefreshAt,refreshDue,pauseUntil:state.pauseUntil,implementationReceipt:state.implementationReceipt??null,replayPendingCount:jobs.filter(j=>j.callbackPending||j.replayFamilyIds?.length).length,replayPendingFamilyCount:jobs.reduce((n,j)=>n+(j.callbackPending?.familyIds.length??j.replayFamilyIds?.length??0),0),familyCount:manifest.length,familyCounts:Object.fromEntries(['pending','partial','blocked','matches_collected','no_matches'].map(outcome=>[outcome,manifest.filter(f=>f.collectionOutcome===outcome).length])),chainCodes:chains,jobCounts:Object.fromEntries(['pending','complete','partial','blocked'].map(status=>[status,jobs.filter(j=>j.status===status).length])),jobCountsByKind:Object.fromEntries(['search','product'].map(kind=>[kind,Object.fromEntries(['pending','complete','partial','blocked'].map(status=>[status,jobs.filter(j=>j.kind===kind&&j.status===status).length]))])),manifest,coverageNote:'Fullførte søk beskriver innhentingen, ikke komplett kjedesortiment, godkjent ekvivalens eller lokal lagerstatus.'};
  }
  function catalog({familyId=null}={}){
    if(familyId!==null&&!text(familyId,200))throw Error('Ugyldig Sesum-varefamilie.');
    if(!enabled)return {enabled:false,runId:null,items:[]};
    load();const rows=new Map(Object.entries(state.observations));
    if(state.run)for(const job of Object.values(state.run.jobs))if(job.productObservation){const row=observation(state.run,job);rows.set(job.productObservation.id,mergeObservation(rows.get(job.productObservation.id),row));}
    const items=[...rows.values()].filter(row=>familyId===null||row.familyIds.includes(familyId)).sort((a,b)=>a.sourceUrl.localeCompare(b.sourceUrl));
    return {enabled:true,runId:state.run?.id??null,items:structuredClone(items),coverageNote:'Registrerte kildeobservasjoner, inkludert uavklarte priser og separate tilsvarende-forslag. Ingen produktgodkjenning, ny prisdato eller lokal lagerstatus følger av innhentingen.'};
  }
  return {work,receive,refresh,retry,status,catalog,replayPending};
}
