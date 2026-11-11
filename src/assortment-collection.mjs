import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {encrypt,decrypt,loadKey} from './crypto.mjs';
import {assortmentConfig} from './shopping-assortment.mjs';
import {productResult,sesumUrl} from './shopping-sesum.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex'),unique=a=>[...new Set(a)];
const chains=['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA','JOKER_NO','BUNNPRIS','MATKROKEN'];
export function sesumCatalogueUrl(value){
 const u=new URL(value);if(u.origin!=='https://www.sesum.no'||u.username||u.password||u.hash||!/^\/kategori(?:\/[1-9]\d*(?:-[^/?#]+)?)?\/?$/.test(u.pathname))throw Error('Invalid Sesum public catalogue URL.');
 for(const [k,v] of u.searchParams)if(!['side','page','visning'].includes(k)||(k==='visning'?v!=='alle':! /^[1-9]\d{0,7}$/.test(v))||u.searchParams.getAll(k).length!==1)throw Error('Filtered/invalid Sesum catalogue URL.');
 if(u.searchParams.has('side')&&u.searchParams.has('page'))throw Error('Conflicting catalogue pagination parameters.');
 u.searchParams.sort();return u.href;
}
export function kassalNextPage(result,page){
 const rows=Array.isArray(result.data)?result.data:result.data?.products;if(!Array.isArray(rows)||rows.length>100)throw Error('Invalid Kassal page rows.');
 const links=result.links??result.data?.links,meta=result.meta??result.data?.meta;
 let next;
 if(links&&Object.hasOwn(links,'next')){
  if(links.next===null)next=null;
  else{const u=new URL(links.next);if(u.origin!=='https://kassal.app'||u.pathname!=='/api/v1/products'||u.username||u.password||u.hash)throw Error('Unexpected Kassal pagination URL.');
   for(const [key,value] of u.searchParams)if(!['page','size','unique','sort'].includes(key)||key==='unique'&&value!=='0'||key==='size'&&value!=='100'||key==='sort'&&value!=='date_asc')throw Error('Kassal pagination changed catalogue scope.');
   next=Number(u.searchParams.get('page'));if(next!==page+1)throw Error('Kassal pagination repeated/skipped a page.');}
 }else if(Number.isSafeInteger(meta?.last_page)&&Number.isSafeInteger(meta?.current_page)&&meta.current_page===page&&meta.last_page>=page)next=page===meta.last_page?null:page+1;
 else throw Error('Kassal has no explicit catalogue pagination/end receipt.');
 if(next!==null&&!rows.length)throw Error('Kassal empty intermediate page.');
 return {next,rows,total:Number.isSafeInteger(meta?.total)?meta.total:null};
}

/** Durable, bounded code-only enumeration; never starts an agent or a cart. */
export function createAssortmentCollection({dataDir,config={},kassal,receiveSesum,receiveKassal,receiveCategories=()=>{},reuseSesum=()=>[],now=()=>new Date(),encryptionKey}={}){
 config=assortmentConfig(config);const file=join(dataDir,'assortment-collection.json.enc'),journal=join(dataDir,'assortment-collection.transactions.enc.jsonl'),dirtyJobs=new Set();let state,key=encryptionKey,busy=false;
 const clock=()=>new Date(now()).getTime();
 function load(){
  if(state)return;key??=loadKey(dataDir);state=existsSync(file)?JSON.parse(decrypt(readFileSync(file),key)): {version:1,runId:null,sesum:{jobs:{}},kassal:{page:1,pages:{},complete:false},history:[],revision:0};if(state.version!==1)throw Error('Unknown assortment collection version.');state.revision??=0;
  if(existsSync(journal)){const bytes=readFileSync(journal,'utf8');if(bytes&&!bytes.endsWith('\n'))throw Error('Incomplete catalogue collection transaction; preserve for recovery.');for(const line of bytes.split('\n'))if(line){const patch=JSON.parse(decrypt(Buffer.from(line,'base64'),key));if(patch.revision<=state.revision)continue;if(patch.revision!==state.revision+1)throw Error('Catalogue collection transaction gap.');if(patch.meta.runId!==state.runId)state.sesum={jobs:{}};Object.assign(state,patch.meta);state.kassal=patch.kassal;state.history=patch.history;state.sesum.pauseUntil=patch.pauseUntil;Object.assign(state.sesum.jobs,patch.jobs);state.revision=patch.revision;}}
  if(state.planVersion!==2){
   state.planVersion=2;const changed=[];
   for(const job of Object.values(state.sesum.jobs))if(job.kind==='catalogue'&&job.category!=='index'){
    const u=new URL(job.url);u.searchParams.set('visning','alle');u.searchParams.sort();if(u.href===job.url)continue;
    (job.retryHistory??=[]).push({at:new Date(clock()).toISOString(),url:job.url,status:job.status,error:job.error??null,reason:'explicit-complete-category-list-v2'});job.url=u.href;
    if(job.error==='unrecognized_schema'){job.status='pending';job.retryAt=null;job.deliveredUntil=null;job.attempts=0;}changed.push(job);
   }
   if(state.runId)save(...changed);
  }
 }
 function save(...jobs){
  for(const job of jobs)dirtyJobs.add(job.id);
  const {runId,startedAt,paused,validationRemaining,planVersion,bootstrap}=state;
  const patch={revision:state.revision+1,meta:{runId,startedAt,paused,validationRemaining,planVersion,bootstrap},kassal:state.kassal,history:state.history,pauseUntil:state.sesum.pauseUntil??null,jobs:Object.fromEntries([...dirtyJobs].map(id=>[id,state.sesum.jobs[id]]))};
  mkdirSync(dataDir,{recursive:true});appendFileSync(journal,encrypt(Buffer.from(JSON.stringify(patch)),key).toString('base64')+'\n');state.revision++;dirtyJobs.clear();
 }
 function add(kind,url){url=kind==='catalogue'?sesumCatalogueUrl(url):sesumUrl(url,'product');const u=new URL(url),category=u.pathname.match(/^\/kategori\/(\d+)/)?.[1]??'index';if(kind==='catalogue'&&category!=='index'){u.searchParams.set('visning','alle');u.searchParams.sort();url=u.href;}const identity=kind==='product'?u.pathname.match(/^\/produkt\/(\d+)/)[1]:category+':'+(u.searchParams.get('side')??u.searchParams.get('page')??1),id=hash(kind+identity);if(!state.sesum.jobs[id]){state.sesum.jobs[id]={id,kind,url,...(kind==='catalogue'?{category}:{}),status:'pending',attempts:0};dirtyJobs.add(id);}return state.sesum.jobs[id];}
 function start({validationReads=null}={}){load();if(validationReads!==null&&(!Number.isInteger(validationReads)||validationReads<1||validationReads>8))throw Error('Validation must be bounded to 1–8 source reads.');if(!config.enabled)throw Error('Assortment mode disabled.');if(state.runId&&!status().collectionComplete)throw Error('Existing catalogue sweep is unfinished; resume it instead.');if(state.runId)state.history.push({runId:state.runId,startedAt:state.startedAt,sesumJobs:Object.keys(state.sesum.jobs).length,kassalPages:Object.keys(state.kassal.pages).length});state.runId='assortment-'+randomUUID();state.startedAt=new Date(clock()).toISOString();state.paused=false;state.validationRemaining=validationReads;state.sesum={jobs:{}};state.kassal={page:1,pages:{},complete:false};add('catalogue','https://www.sesum.no/kategori');save();return status();}
 const paused=()=>!config.enabled||!config.collectionEnabled||!state.runId||state.paused===true||state.validationRemaining===0;
 function bootstrap({productUrls=[],categoryUrls=[]}={}){
  load();if(!config.enabled||!Array.isArray(productUrls)||productUrls.length>500||!Array.isArray(categoryUrls)||categoryUrls.length>100)throw Error('Select at most 500 exact known Sesum product URLs.');
  const urls=unique(productUrls.map(url=>sesumUrl(url,'product')));if(!state.runId)start({validationReads:1});
  const root=add('catalogue','https://www.sesum.no/kategori'),jobs=[root,...urls.map(url=>add('product',url)),...unique(categoryUrls.map(sesumCatalogueUrl)).map(url=>add('catalogue',url))];
  for(const job of jobs)if(job.kind==='catalogue'?job.category==='index'?true:job.status!=='complete':!job.categoryReceipt){(job.receiptHistory??=[]).push({status:job.status,fetchedAt:job.fetchedAt??null,error:job.error??null,rescanReason:'native-category-bootstrap'});job.status='pending';job.attempts=0;job.retryAt=null;job.deliveredUntil=null;}
  state.bootstrap={mode:categoryUrls.length?'selected-categories':'representatives',jobIds:jobs.map(j=>j.id),startedAt:new Date(clock()).toISOString(),status:'collecting'};state.validationRemaining=null;state.paused=false;state.sesum.pauseUntil=null;finishBootstrap();save(...jobs);return status();
 }
 function pause(){load();state.paused=true;save();return status();}
 function resume(){load();if(!state.runId)throw Error('Start an explicit catalogue sweep first.');state.paused=false;state.validationRemaining=null;save();return status();}
 function validate({validationReads=1,jobIds=[]}={}){
  load();if(!state.runId||!Number.isInteger(validationReads)||validationReads<1||validationReads>8||!Array.isArray(jobIds)||jobIds.length>8||jobIds.some(id=>!Object.hasOwn(state.sesum.jobs,id)||state.sesum.jobs[id].status==='complete'))throw Error('Select a bounded validation budget and explicit unfinished source jobs.');
  const jobs=jobIds.map(id=>state.sesum.jobs[id]);for(const job of jobs){(job.retryHistory??=[]).push({at:new Date(clock()).toISOString(),error:job.error??null,errors:job.errors??[],attempts:job.attempts});job.status='pending';job.attempts=0;job.retryAt=null;job.deliveredUntil=null;}
  state.validationRemaining=validationReads;state.paused=false;state.sesum.pauseUntil=null;save(...jobs);return status();
 }
 function consumeRead(){if(state.validationRemaining!=null){state.validationRemaining=Math.max(0,state.validationRemaining-1);if(!state.validationRemaining)state.paused=true;}}
 function finishBootstrap(){if(state.bootstrap?.status==='collecting'&&state.bootstrap.jobIds.every(id=>state.sesum.jobs[id]?.status==='complete')){const missing=state.bootstrap.jobIds.filter(id=>{const j=state.sesum.jobs[id];return j.kind==='catalogue'?j.category==='index'&&!j.categoryTreeReceipt:!j.categoryReceipt;});state.bootstrap.status=missing.length?'category-metadata-missing':'complete';state.bootstrap.missingCategoryReceipts=missing;state.bootstrap.finishedAt=new Date(clock()).toISOString();state.paused=true;}}
 function work({peek=false}={}){
  load();if(paused())return {enabled:false,jobs:[],reason:'assortment-collection-paused'};
  const at=clock(),jobs=Object.values(state.sesum.jobs);if(jobs.some(j=>Date.parse(j.deliveredUntil)>at))return {enabled:true,runId:state.runId,jobs:[],reason:'active-source-batch'};
  if(Date.parse(state.sesum.pauseUntil)>at)return {enabled:true,runId:state.runId,jobs:[],pauseUntil:state.sesum.pauseUntil};
  const bootstrapKeys=state.bootstrap?.status==='collecting'?new Set(state.bootstrap.jobIds):null;
  const ready=jobs.filter(j=>(!bootstrapKeys||bootstrapKeys.has(j.id))&&j.status!=='complete'&&j.attempts<3&&!(Date.parse(j.retryAt)>at));
  // Enumerate and consume products together, rather than allowing either a
  // huge listing frontier or a product backlog to starve the other.
  const selected=[];if(bootstrapKeys)selected.push(...ready.filter(j=>j.kind==='catalogue'),...ready.filter(j=>j.kind==='product'));else for(const kind of ['catalogue','product'])selected.push(...ready.filter(j=>j.kind===kind).slice(0,2));selected.splice(state.validationRemaining??(bootstrapKeys?8:4));
  if(!peek&&selected.length){for(const j of selected)j.deliveredUntil=new Date(at+180000).toISOString();save(...selected);}
  return {enabled:true,runId:state.runId,jobs:selected.map(({id,kind,url})=>({id,kind,url,familyIds:[],publicCatalogue:true})),limits:{minSpacingMs:1500,cycleCalls:bootstrapKeys?8:4}};
 }
 async function receive(input){
  load();if(busy)throw Error('Assortment collection receipt in progress.');busy=true;
  try{
   if(input.runId!==state.runId||!Object.hasOwn(state.sesum.jobs,input.jobId))throw Error('Unknown assortment source job.');
   const job=state.sesum.jobs[input.jobId];if(job.status==='complete')return {accepted:true,duplicate:true};
   if(typeof input.fetchedAt!=='string'||!Number.isFinite(Date.parse(input.fetchedAt))||Date.parse(input.fetchedAt)>clock()+60000)throw Error('Invalid source fetch time.');
   const result=input.result;
   job.collectorVersion=typeof input.collectorVersion==='string'?input.collectorVersion.slice(0,100):null;job.collectorBuild=typeof input.collectorBuild==='string'?input.collectorBuild.slice(0,100):null;
   consumeRead();save(job);
   if(input.status!=='ok'||result?.ok!==true||result.kind!==job.kind){job.attempts++;job.status=job.attempts>=3?'blocked':'partial';job.error=input.error?.code??result?.errors?.[0]??'incomplete-source-receipt';job.errors=(result?.errors??[]).slice(0,20).map(s=>String(s).slice(0,500));job.retryAt=new Date(clock()+30*60000).toISOString();job.deliveredUntil=null;if(['auth_required','rate_limited'].includes(job.error))state.sesum.pauseUntil=job.retryAt;save(job);return {accepted:true,status:job.status};}
   if(job.kind==='catalogue'){
    if(sesumCatalogueUrl(result.sourceUrl)!==job.url||!Array.isArray(result.productUrls)||!Array.isArray(result.categoryUrls)||!Array.isArray(result.nextUrls)||result.filtersVerified!==true||result.errors?.length)throw Error('Unproven full Sesum catalogue receipt.');
    const products=unique(result.productUrls.map(u=>sesumUrl(u,'product'))),categories=unique(result.categoryUrls.map(sesumCatalogueUrl)),next=unique(result.nextUrls.map(sesumCatalogueUrl));
    if(products.length+categories.length+next.length>10000||!result.endReached&&!next.length)throw Error('Catalogue end is unproven.');
    for(const url of next){if(new URL(url).pathname!==new URL(job.url).pathname||Number(new URL(url).searchParams.get('side')??new URL(url).searchParams.get('page'))<=Number(new URL(job.url).searchParams.get('side')??new URL(job.url).searchParams.get('page')??1))throw Error('Catalogue pagination cycle/scope change.');}
    // Child category edges can legitimately return to ancestors. Native IDs
    // and URL jobs are deduplicated; category links never imply equivalence.
    job.productJobIds=products.map(u=>{const product=add('product',u);if(job.category!=='index'){product.sourceCategories??=[];if(!product.sourceCategories.some(c=>c.id===job.category)){product.sourceCategories.push({id:job.category,name:result.categoryName??null,url:job.url,observedAt:input.fetchedAt});dirtyJobs.add(product.id);}}return product.id;});job.childJobIds=unique([...categories,...next]).filter(u=>u!==job.url).map(u=>add('catalogue',u).id);job.endReached=result.endReached===true;job.total=result.total??null;
    if(state.bootstrap?.status==='collecting'&&state.bootstrap.mode==='selected-categories'&&state.bootstrap.jobIds.includes(job.id)&&job.category!=='index'){
     const nextIds=next.map(u=>add('catalogue',u).id);state.bootstrap.jobIds=unique([...state.bootstrap.jobIds,...job.productJobIds,...nextIds]);
     job.pendingMemberships={productIds:products.map(u=>new URL(u).pathname.match(/^\/produkt\/(\d+)/)[1]),category:{id:job.category,name:result.categoryName??null,url:job.url},observedAt:input.fetchedAt};save(job);
     await replayMemberships(job);
    }
    if(result.categories?.length){if(job.category==='index'&&result.categories.length!==result.total)throw Error('Incomplete native category tree.');job.pendingCategories={categories:result.categories,fetchedAt:input.fetchedAt,sourceUrl:job.url};save(job);await receiveCategories(job.pendingCategories);delete job.pendingCategories;job.categoryTreeReceipt=true;}
   }else{
    const product=productResult(result,job,chains,new Date(clock()));
    // Save the complete validated source receipt before callback. On failure
    // the same idempotent native observation is replayed, never refetched.
    job.pending={familyIds:[],fetchedAt:input.fetchedAt,products:[{...product,sourceCategories:job.sourceCategories??[]}]};save(job);
    await receiveSesum(job.pending);delete job.pending;
    job.categoryReceipt=Array.isArray(product.categoryPathIds)&&product.categoryPathIds.length>0;
   }
   job.status='complete';job.deliveredUntil=null;job.fetchedAt=input.fetchedAt;
   finishBootstrap();
   save(job);return {accepted:true,status:'complete'};
  }finally{busy=false;}
 }
 async function replayMemberships(job){
  const receipt=job.pendingMemberships,reused=new Set(await reuseSesum(receipt));
  for(const nativeId of reused){const product=state.sesum.jobs[hash('product'+nativeId)];if(product){product.status='complete';product.categoryReceipt=true;product.categoryObservedAt=receipt.observedAt;product.reusedObservation=true;product.deliveredUntil=null;dirtyJobs.add(product.id);}}
  delete job.pendingMemberships;save(job);
 }
 async function step(){
  load();if(busy)return {busy:true};busy=true;
  try{
   for(const job of Object.values(state.sesum.jobs))if(job.pendingMemberships){await replayMemberships(job);job.status='complete';job.deliveredUntil=null;finishBootstrap();save(job);return {replayedMemberships:true};}
   for(const job of Object.values(state.sesum.jobs))if(job.pendingCategories){const receipt=job.pendingCategories;await receiveCategories(receipt);delete job.pendingCategories;job.categoryTreeReceipt=true;job.status='complete';job.fetchedAt=receipt.fetchedAt;job.deliveredUntil=null;finishBootstrap();save(job);return {replayedCategories:true};}
   for(const job of Object.values(state.sesum.jobs))if(job.pending){const receipt=job.pending;await receiveSesum(receipt);job.categoryReceipt=receipt.products[0]?.categoryPathIds?.length>0;delete job.pending;job.status='complete';job.fetchedAt=receipt.fetchedAt;job.deliveredUntil=null;finishBootstrap();save(job);return {replayed:true};}
   const cursor=state.kassal;if(config.familySource==='sesum')return status();if(paused()&&!cursor.pending)return {paused:true};if(cursor.complete||!cursor.pending&&Date.parse(cursor.retryAt)>clock())return status();
   if(!kassal?.status().configured)return {blocked:true,reason:'kassal-not-configured'};
   try{
    let result=cursor.pending;if(!result){consumeRead();save();result=await kassal.catalogue({page:cursor.page,size:100});}const parsed=kassalNextPage(result,cursor.page),digest=hash(JSON.stringify(parsed.rows.map(r=>[r.store?.code,r.id])));
    if(parsed.rows.length&&Object.values(cursor.pages).some(r=>r.identityDigest===digest))throw Error('Repeated Kassal catalogue page; no cursor progress.');
    cursor.pending=result;save();await receiveKassal(result);
    cursor.pages[cursor.page]={identityDigest:digest,rows:parsed.rows.length,next:parsed.next,total:parsed.total,fetchedAt:result.fetchedAt};delete cursor.pending;delete cursor.error;delete cursor.retryAt;
    cursor.complete=parsed.next===null;if(parsed.next)cursor.page=parsed.next;save();return {page:cursor.page,complete:cursor.complete,observed:parsed.rows.length};
   }catch(error){cursor.error=String(error.message).slice(0,500);cursor.retryAt=new Date(clock()+30*60000).toISOString();save();return {blocked:true,reason:cursor.error,retryAt:cursor.retryAt};}
  }finally{busy=false;}
 }
 function status(){
  load();const jobs=Object.values(state.sesum.jobs),done=jobs.filter(j=>j.status==='complete'),categories=new Map();
  for(const job of jobs)if(job.kind==='catalogue'&&job.category!=='index'){const record=categories.get(job.category)??{totals:new Set(),products:new Set(),pending:false};if(Number.isSafeInteger(job.total))record.totals.add(job.total);for(const key of job.productJobIds??[])record.products.add(key);if(job.status!=='complete')record.pending=true;categories.set(job.category,record);}
  const countMismatches=[...categories].filter(([,r])=>!r.pending&&(r.totals.size!==1||!r.totals.has(r.products.size))).map(([category,r])=>({category,observedProducts:r.products.size,reportedTotals:[...r.totals]}));
  const sesumComplete=!!state.runId&&jobs.length>0&&done.length===jobs.length&&!jobs.some(j=>j.pending)&&!countMismatches.length,kassalComplete=state.kassal.complete===true;
  return {enabled:config.enabled,collectionEnabled:config.collectionEnabled,paused:paused(),bootstrap:state.bootstrap?{...state.bootstrap,jobIds:undefined,jobs:state.bootstrap.jobIds.length,remaining:state.bootstrap.jobIds.filter(id=>state.sesum.jobs[id]?.status!=='complete').length}:null,validationRemaining:state.validationRemaining??null,runId:state.runId,startedAt:state.startedAt??null,busy,sesum:{jobs:jobs.length,complete:done.length,remaining:jobs.length-done.length,blocked:jobs.filter(j=>j.status==='blocked').length,products:jobs.filter(j=>j.kind==='product').length,completeSweep:sesumComplete,countMismatches,issues:jobs.filter(j=>j.error&&j.status!=='complete').slice(0,8).map(j=>({id:j.id,kind:j.kind,url:j.url,status:j.status,error:j.error,errors:j.errors??[],collectorVersion:j.collectorVersion??null,collectorBuild:j.collectorBuild??null})),implementationReceipt:done.at(-1)?{collectorVersion:done.at(-1).collectorVersion,collectorBuild:done.at(-1).collectorBuild,kind:done.at(-1).kind,fetchedAt:done.at(-1).fetchedAt}:null,pauseUntil:state.sesum.pauseUntil??null},kassal:{page:state.kassal.page,pagesRead:Object.keys(state.kassal.pages).length,rowsObserved:Object.values(state.kassal.pages).reduce((n,r)=>n+r.rows,0),completeSweep:kassalComplete,error:state.kassal.error??null,retryAt:state.kassal.retryAt??null},collectionComplete:sesumComplete&&(config.familySource==='sesum'||kassalComplete),coverageNote:'A sweep exhausts the source-delivered public catalogue/API pages. It does not prove every retailer SKU, local stock or semantic review completion.'};
 }
 return {start,work,receive,step,status,pause,resume,validate,bootstrap};
}
