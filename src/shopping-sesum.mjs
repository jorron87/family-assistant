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
  const product={id:String(p.id),name:text(p.name,1000),brand:field(p.brand,'merke',300),vendor:field(p.vendor,'leverandør',300),ean:p.ean??null,weight:p.weight??null,weightUnit:field(p.weightUnit,'vektenhet',30),soldByWeight:typeof p.soldByWeight==='boolean'?p.soldByWeight:null,sourceUrl:job.url};
  if(product.weight!==null&&(!Number.isFinite(product.weight)||product.weight<=0||product.weight>1e9))throw Error('Ugyldig Sesum-vekt.');
  if(p.soldByWeight!=null&&typeof p.soldByWeight!=='boolean')throw Error('Ugyldig Sesum-vektgrunnlag.');
  if(product.ean!==null){const eans=Array.isArray(product.ean)?product.ean:[product.ean];if(eans.length>30||!eans.every(ean=>typeof ean==='string'&&/^\d{8,14}$/.test(ean)))throw Error('Ugyldig Sesum-strekkode.');}
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
  function addJob(run,kind,url,familyIds,generation=0){
    const canonical=sesumUrl(url,kind),id=jobId(kind,canonical,generation);
    if(run.jobs[id]){
      const job=run.jobs[id],added=familyIds.some(f=>!job.familyIds.includes(f));
      job.familyIds=unique([...job.familyIds,...familyIds]);
      if(added&&job.kind==='product'&&job.status!=='pending'){job.status='pending';job.deliveredUntil=null;job.retryAt=null;}
      return job;
    }
    return run.jobs[id]={id,kind,url:canonical,generation,familyIds:[...familyIds],status:'pending',attempts:0,createdAt:now().toISOString()};
  }
  function start(snapshot){
    if(state.run)for(const job of Object.values(state.run.jobs))if(job.productObservation)state.observations[job.productObservation.id]=mergeObservation(state.observations[job.productObservation.id],observation(state.run,job));
    if(state.run)state.history=[{id:state.run.id,startedAt:state.run.startedAt,finishedAt:state.run.finishedAt??null,status:state.run.status,familyCount:state.run.families.length},...state.history].slice(0,7);
    const run={id:randomUUID(),startedAt:now().toISOString(),finishedAt:null,status:'collecting',fingerprint:digest(snapshot),families:snapshot,chainCodes:chains,revision:0,plannerVersion:2,jobs:{}};
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
      }
      run.revision=(run.revision??0)+1;
      const seeds=new Set();for(const job of Object.values(run.jobs))if(job.kind==='search'){const url=new URL(job.url);if([...url.searchParams.keys()].every(k=>k==='q'))for(const id of job.familyIds)seeds.add(JSON.stringify([id,url.searchParams.get('q')]));}
      for(const family of currentSnapshot)for(const query of family.queries)if(!seeds.has(JSON.stringify([family.familyId,query]))){const url=new URL('/sok',ORIGIN);url.searchParams.set('q',query);addJob(run,'search',url.href,[family.familyId],run.revision);}
      run.families=currentSnapshot;run.fingerprint=digest(currentSnapshot);run.plannerVersion=2;run.finishedAt=null;run.status='collecting';finish(run);save();
    }
    return run;
  }
  function refresh(){if(!enabled)return status();load();start(snapshot());return status();}
  function fairSelection(run,ready){
    const scheduler={nextKind:'product',searchAfterFamilyId:null,productAfterFamilyId:null,...run.scheduler},selected=[],used=new Set();
    const familyIds=run.families.map(f=>f.familyId),byKind={search:new Map(),product:new Map()};
    for(const job of ready)for(const familyId of job.familyIds){const list=byKind[job.kind].get(familyId)??[];list.push(job);byKind[job.kind].set(familyId,list);}
    function choose(kind){
      const start=familyIds.indexOf(scheduler[kind+'AfterFamilyId']);
      for(let step=1;step<=familyIds.length;step++){
        const familyId=familyIds[(start+step)%familyIds.length],job=byKind[kind].get(familyId)?.find(j=>!used.has(j.id));
        if(job){scheduler[kind+'AfterFamilyId']=familyId;return job;}
      }
      return null;
    }
    for(let slot=0;slot<cycleCalls;slot++){
      const job=choose(scheduler.nextKind)??choose(scheduler.nextKind==='product'?'search':'product');
      if(!job)break;selected.push(job);used.add(job.id);scheduler.nextKind=job.kind==='product'?'search':'product';
    }
    return {selected,scheduler};
  }
  function work({peek=false}={}){
    if(!enabled)return {enabled:false,jobs:[],limits:{minSpacingMs,cycleCalls}};
    const run=ensure(),at=now().getTime();
    if(state.pauseUntil&&Date.parse(state.pauseUntil)>at)return {enabled:true,runId:run.id,jobs:[],pauseUntil:state.pauseUntil,limits:{minSpacingMs,cycleCalls}};
    const ready=Object.values(run.jobs).filter(j=>j.status==='pending'&&(!j.retryAt||Date.parse(j.retryAt)<=at)&&(!j.deliveredUntil||Date.parse(j.deliveredUntil)<=at)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    const {selected:jobs,scheduler}=fairSelection(run,ready);
    if(!peek){for(const job of jobs)job.deliveredUntil=new Date(at+5*60000).toISOString();if(jobs.length){run.scheduler=scheduler;save();}}
    return {enabled:true,runId:run.id,jobs:jobs.map(({id,kind,url,familyIds})=>({id,kind,url,familyIds})),limits:{minSpacingMs,cycleCalls}};
  }
  function finish(run){
    const jobs=Object.values(run.jobs);
    if(jobs.every(j=>j.status!=='pending')){const proven=run.families.every(f=>!(f.queryPlan??[]).some(p=>p.unsearchableTerms.length)&&f.queries.every(q=>jobs.some(j=>j.kind==='search'&&j.familyIds.includes(f.familyId)&&new URL(j.url).searchParams.get('q')===q&&j.endReached===true)));run.status=jobs.some(j=>j.status!=='complete')||!proven?'partial':'complete';run.finishedAt=now().toISOString();}
  }
  async function receive(input){
    if(!enabled)throw Error('Sesum-innhenting er ikke aktivert.');
    load();const run=state.run;
    if(!run||input.runId!==run.id||!Object.hasOwn(run.jobs,input.jobId))throw Error('Ukjent eller utgått Sesum-jobb.');
    const job=run.jobs[input.jobId];
    if(job.status!=='pending')return {accepted:true,duplicate:true,runId:run.id,jobId:job.id};
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
      for(const url of products)addJob(run,'product',url,job.familyIds,job.generation);
      job.nextJobIds=next.map(url=>addJob(run,'search',url,job.familyIds,job.generation).id);
      job.errors=Array.isArray(result.errors)?result.errors.slice(0,20).map(e=>String(e).slice(0,500)):[];
      job.discovered=products.length;job.nextPages=next.length;job.endReached=result.endReached===true&&input.status==='ok'&&!job.errors.length;
      job.status=input.status==='ok'&&!job.errors.length&&(job.endReached||next.length>0)?'complete':'partial';
    }else{
      const product=productResult(result,job,chains,now());
      job.productObservation=product;job.observationFetchedAt=input.fetchedAt;job.observationError=null;
      try{applied=await receivePrices({runId:run.id,jobId:job.id,familyIds:[...job.familyIds],products:[product],fetchedAt:input.fetchedAt});}
      catch(error){job.observationError=text(error?.message,500)??'Priskvitteringen kunne ikke registreres.';save();throw error;}
      job.priceCount=product.prices.length;job.freshPriceCount=product.prices.filter(p=>p.price!==null&&p.observedAt&&now()-Date.parse(p.observedAt)<=48*3600000).length;
      job.priceChains=unique(product.prices.map(p=>p.storeCode));job.priceReceipts=product.prices.map(({storeCode,price,observedAt})=>({storeCode,price,observedAt}));
      job.review=applied;job.status=input.status==='ok'?'complete':'partial';
    }
    job.fetchedAt=input.fetchedAt;job.completedAt=now().toISOString();job.deliveredUntil=null;
    if(collectorVersion&&job.status==='complete')state.implementationReceipt={collectorVersion,collectorBuild,runId:run.id,jobId:job.id,kind:job.kind,acceptedAt:job.completedAt,fetchedAt:input.fetchedAt,sourceUrl:job.url};
    finish(run);save();return {accepted:true,runId:run.id,jobId:job.id,status:job.status,applied};
  }
  function status(){
    if(!enabled)return {enabled:false,status:'disabled',familyCount:0,chainCodes:chains};
    load();const run=state.run;
    if(!run)return {enabled:true,status:'not_started',familyCount:0,chainCodes:chains};
    const jobs=Object.values(run.jobs),freshChains=job=>unique((job.priceReceipts??[]).filter(p=>p.price!==null&&p.observedAt&&now()-Date.parse(p.observedAt)<=48*3600000).map(p=>p.storeCode)),manifest=run.families.map(f=>{
      const own=jobs.filter(j=>j.familyIds.includes(f.familyId)),search=own.filter(j=>j.kind==='search'),products=own.filter(j=>j.kind==='product');
      const unsearchableTerms=(f.queryPlan??[]).flatMap(p=>p.unsearchableTerms),collectionStatus=own.some(j=>j.status==='blocked')?'blocked':own.some(j=>j.status==='pending')?'pending':own.some(j=>j.status==='partial')||unsearchableTerms.length?'partial':'complete';
      const completedZeroMatchQueries=f.queries.filter(q=>{const pages=search.filter(j=>new URL(j.url).searchParams.get('q')===q);return pages.length&&pages.every(j=>j.status==='complete'&&j.discovered===0)&&pages.some(j=>j.endReached);});
      const collectionOutcome=collectionStatus!=='complete'?collectionStatus:products.length?'matches_collected':'no_matches';
      return {familyId:f.familyId,name:f.name,unit:f.unit,fingerprint:f.fingerprint,collectionStatus,collectionOutcome,requestedQueries:f.requestedQueries??f.queries,queryPlan:f.queryPlan??null,queries:f.queries,completedZeroMatchQueries,searchPages:search.length,productCount:products.length,productsCollected:products.filter(j=>j.status==='complete').length,unresolvedItems:[...own.filter(j=>j.status!=='complete').map(j=>({jobId:j.id,kind:j.kind,status:j.status,url:j.url,reason:j.error??j.errors??null})),...unsearchableTerms.map(term=>({kind:'query',status:'partial',term,reason:'single-term-exceeds-source-limit-64'}))],chains:chains.map(code=>({chainCode:code,collectionStatus,collectionOutcome:collectionStatus!=='complete'?collectionStatus:!products.length?'no_matches':products.some(j=>j.priceChains?.includes(code))?'prices_collected':'no_chain_prices',observedProducts:products.filter(j=>j.priceChains?.includes(code)).length,freshProducts:products.filter(j=>freshChains(j).includes(code)).length,reviewStatus:products.length?'see_price_integration':'no_candidates',freshnessStatus:products.some(j=>freshChains(j).includes(code))?'has_fresh_candidates':'missing_fresh_price'}))};
    });
    return {enabled:true,status:run.status,runId:run.id,startedAt:run.startedAt,finishedAt:run.finishedAt,pauseUntil:state.pauseUntil,implementationReceipt:state.implementationReceipt??null,familyCount:manifest.length,familyCounts:Object.fromEntries(['pending','partial','blocked','matches_collected','no_matches'].map(outcome=>[outcome,manifest.filter(f=>f.collectionOutcome===outcome).length])),chainCodes:chains,jobCounts:Object.fromEntries(['pending','complete','partial','blocked'].map(status=>[status,jobs.filter(j=>j.status===status).length])),jobCountsByKind:Object.fromEntries(['search','product'].map(kind=>[kind,Object.fromEntries(['pending','complete','partial','blocked'].map(status=>[status,jobs.filter(j=>j.kind===kind&&j.status===status).length]))])),manifest,coverageNote:'Fullførte søk beskriver innhentingen, ikke komplett kjedesortiment, godkjent ekvivalens eller lokal lagerstatus.'};
  }
  function catalog({familyId=null}={}){
    if(familyId!==null&&!text(familyId,200))throw Error('Ugyldig Sesum-varefamilie.');
    if(!enabled)return {enabled:false,runId:null,items:[]};
    load();const rows=new Map(Object.entries(state.observations));
    if(state.run)for(const job of Object.values(state.run.jobs))if(job.productObservation){const row=observation(state.run,job);rows.set(job.productObservation.id,mergeObservation(rows.get(job.productObservation.id),row));}
    const items=[...rows.values()].filter(row=>familyId===null||row.familyIds.includes(familyId)).sort((a,b)=>a.sourceUrl.localeCompare(b.sourceUrl));
    return {enabled:true,runId:state.run?.id??null,items:structuredClone(items),coverageNote:'Registrerte kildeobservasjoner, inkludert uavklarte priser og separate tilsvarende-forslag. Ingen produktgodkjenning, ny prisdato eller lokal lagerstatus følger av innhentingen.'};
  }
  return {work,receive,refresh,status,catalog};
}
