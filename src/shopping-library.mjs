import {statSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {readProductLibrary,productTextHash} from './product-library.mjs';

const INDEX_VERSION=1,FRESH_MS=48*3600000,RETRY_MS=60000;
const low=value=>String(value??'').normalize('NFC').toLocaleLowerCase('nb-NO');
const script=fileURLToPath(new URL('../scripts/product-library.mjs',import.meta.url));
const stampOf=file=>{const info=statSync(file);return `${info.mtimeMs}:${info.size}`;};
// Product photos live in an optional sidecar so a new photo never touches the
// reviewed library. They are display data and prove nothing about a product.
const imagesFile=file=>join(dirname(file),'product-images.json');
const sourceStamp=file=>{let images='';try{images=stampOf(imagesFile(file));}catch{}return stampOf(file)+'|'+images;};
function withImages(index,file) {
 let images={};
 try{images=JSON.parse(readFileSync(imagesFile(file),'utf8'));}catch{}
 for(const [key,product] of Object.entries(index.products))if(/^https:\/\//.test(images[key]??''))product.image=images[key];
 return index;
}
const words=value=>low(value).replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(' ').filter(Boolean);

export function writeShoppingIndex(file,output) {
 const source=sourceStamp(file),index=withImages(readProductLibrary(file).shoppingIndex(),file),temp=`${output}.${process.pid}.tmp`;
 const body={version:INDEX_VERSION,builtAt:new Date().toISOString(),source,...index};
 try{writeFileSync(temp,JSON.stringify(body));renameSync(temp,output);}finally{rmSync(temp,{force:true});}
 return {output,source,groups:Object.keys(index.groups).length,products:Object.keys(index.products).length};
}

// Reader over one compiled index. Lookups are built once; price age is judged at
// each use, so a stale receipt stops counting without loading anything again.
export function createIndexReader(index) {
 const byEan=new Map(),byOda=new Map(),memberships=new Map(),haystacks=new Map();
 const ean=value=>String(value??'').replace(/^0+/,'');
 for(const [key,p] of Object.entries(index.products)){
  if(p.ean){const rows=byEan.get(ean(p.ean))??[];rows.push(key);byEan.set(ean(p.ean),rows);}
  const oda=p.store==='ODA_NO'?p.sourceUrl?.match(/\/products\/(\d+)-/)?.[1]:null;
  if(oda)byOda.set(Number(oda),key);
 }
 for(const [groupId,rows] of Object.entries(index.members))for(const row of rows){const list=memberships.get(row.k)??[];list.push({groupId,...row});memberships.set(row.k,list);}
 for(const [key,p] of Object.entries(index.products))haystacks.set(key,` ${words([p.name,p.brand,...(memberships.get(key)??[]).filter(m=>m.s==='approved').map(m=>index.groups[m.groupId]?.name)].join(' ')).join(' ')} `);
 const match=(haystack,terms)=>terms.every(term=>haystack.includes(' '+term));
 return at=>{
  const fresh=receiptAt=>{const age=at-Date.parse(receiptAt);return age>=0&&age<=FRESH_MS;};
  const priceOf=p=>{
   const q=p.quote,ok=!!q.receiptAt&&fresh(q.receiptAt);
   const reasons=[...q.reasons];if(!p.available)reasons.push('unavailable-product');if(q.receiptAt&&!ok)reasons.push(at<Date.parse(q.receiptAt)?'future-price-receipt':'stale-price-receipt');
   return {...q,fresh:ok,reasons};
  };
  const rowOf=(row,groupId)=>{const product=index.products[row.k],price=priceOf(product);return {productKey:row.k,groupId,status:row.s,reviewCurrent:row.r,product,price,unitPrice:row.u,eligible:row.u!==null&&price.fresh&&!price.reasons.length,quality:row.q};};
  const members=groupId=>(index.members[groupId]??[]).map(row=>rowOf(row,groupId));
  const groupsOf=key=>memberships.get(key)??[];
  return {
   builtAt:index.builtAt,
   group:id=>index.groups[id]??null,
   product:key=>index.products[key]??null,
   imageUrls:()=>Object.values(index.products).map(p=>p.image).filter(Boolean),
   members,groupsOf,
   quote(key){const product=index.products[key];if(!product)return null;return {product,reviewCurrent:groupsOf(key).some(m=>m.s==='approved'&&m.r),price:priceOf(product)};},
   byEan:value=>byEan.get(ean(value))??[],
   byOdaId:id=>byOda.get(Number(id))??null,
   quality:(key,groupIds)=>{const rows=groupsOf(key).filter(m=>m.s==='approved'&&m.q&&(!groupIds||groupIds.includes(m.groupId)));return rows[0]?.q??null;},
   search(query,limit=30){const terms=words(query);if(!terms.length)return [];const found=[];for(const [key,haystack] of haystacks){if(!match(haystack,terms))continue;found.push(key);}return found.slice(0,5000).map(key=>({key,product:index.products[key],groups:groupsOf(key).map(m=>({groupId:m.groupId,status:m.s,name:index.groups[m.groupId]?.name})),price:priceOf(index.products[key])})).sort((a,b)=>Number(b.price.fresh)-Number(a.price.fresh)||a.product.name.localeCompare(b.product.name,'nb')).slice(0,limit);},
   searchGroups(query,limit=5){
    const terms=words(query);if(!terms.length)return [];
    // A Norwegian compound ends in what it is: tomatketchup is a ketchup, while
    // melkesjokolade is no milk. Word starts are only a fallback.
    const rows=Object.entries(index.groups).map(([id,g])=>[id,g,words(g.name)]);
    let found=rows.filter(([,,parts])=>terms.every(term=>parts.some(part=>part===term||term.length>=4&&part.endsWith(term))));
    if(!found.length)found=rows.filter(([,,parts])=>terms.every(term=>parts.some(part=>part.startsWith(term))));
    return found.sort((a,b)=>a[2].length-b[2].length).slice(0,limit).map(([id,g])=>({id,...g}));
   }
  };
 };
}

function backgroundBuild(file,indexFile,done) {
 const child=spawn(process.execPath,[script,file,'shopping-index',indexFile],{stdio:'ignore',windowsHide:true});
 child.on('error',()=>done(false));child.on('exit',code=>done(code===0));
}

// A general library class never approves a family watch. Only an already
// approved native watch/SKU with identical reviewed metadata may reuse a price.
// With indexFile set, the server reads a compact index built in a child process.
export function libraryPriceProvider(file,{now=()=>new Date(),indexFile=null,build=backgroundBuild}={}) {
 let reader=null,stamp=null,indexStamp=null,builtFrom=null,building=false,retryAt=0,status='missing';
 const hashes=new Map();
 function loadDirect() {
  const next=sourceStamp(file);
  if(!reader||next!==stamp){reader=createIndexReader({builtAt:now().toISOString(),...withImages(readProductLibrary(file,{now:now()}).shoppingIndex(),file)});stamp=next;}
  status='ready';return reader;
 }
 function loadIndexed() {
  const want=sourceStamp(file);
  try{const next=stampOf(indexFile);if(next!==indexStamp){const parsed=JSON.parse(readFileSync(indexFile,'utf8'));if(parsed.version===INDEX_VERSION){reader=createIndexReader(parsed);builtFrom=parsed.source;}indexStamp=next;}}catch(error){if(error.code!=='ENOENT')throw error;}
  if(builtFrom!==want&&!building&&Date.now()>=retryAt){building=true;build(file,indexFile,ok=>{building=false;if(!ok)retryAt=Date.now()+RETRY_MS;});}
  // Receipts in a slightly older index still expire on their own 48 hours.
  status=reader?'ready':'building';return reader;
 }
 function current() {
  try{return (indexFile?loadIndexed:loadDirect)();}
  catch(error){if(!indexFile)reader=null;status=error.code==='ENOENT'?'missing':'unavailable';return indexFile?reader:null;}
 }
 const readerNow=()=>{const load=current();return load?load(now().getTime()):null;};
 const textHash=e=>{let value=hashes.get(e.fingerprint);if(!value){value=productTextHash(e);hashes.set(e.fingerprint,value);}return value;};
 const near=(a,b)=>a!==null&&b!==null&&Math.abs(a-b)<=1e-6*Math.max(Math.abs(a),Math.abs(b));
 const text=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim();
 function provide(entries) {
  const read=readerNow();if(!read)return {status,quotes:[]};
  const result=[];
  for(const e of entries){
   if(e.status!=='approved')continue;
   const q=read.quote(`kassal:${e.store}:${e.id}`),p=q?.product;if(!q?.reviewCurrent)continue;
   const direct=q.price.directUnitVerified&&q.price.unit===e.unit&&p.pack===null;
   if(!direct&&(!near(p.pack,e.packAmount)||p.unit!==e.unit))continue;
   if(p.textHash!==textHash(e))continue;
   if(p.rawPack&&(p.rawPack.weight!==e.weight||text(p.rawPack.weightUnit)!==text(e.weightUnit)))continue;
   result.push({watchId:e.watchId,store:e.store,id:e.id,canonicalPackAmount:p.pack,...q.price});
  }
  return {status:'ready',quotes:result};
 }
 provide.reader=readerNow;
 provide.status=()=>status;
 return provide;
}
