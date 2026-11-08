import {createHash} from 'node:crypto';

const VERSION=1,FRESH_MS=48*3600000,MAX_NUMBER=1e9;
const own=(value,key)=>Object.hasOwn(value,key);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const identity=(watchId,store,id)=>digest(JSON.stringify([watchId,store,id]));
const hashPattern=/^[a-f0-9]{64}$/;
const reserved=new Set(['__proto__','constructor','prototype']);
const compare=(a,b)=>a<b?-1:a>b?1:0;

function safeId(value,label,{numeric=false,max=200}={}) {
 if(numeric&&typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)value=String(value);
 if(typeof value!=='string')throw Error(`${label} must be a stable ID.`);
 const result=value.trim();
 if(!result||result.length>max||!/^[a-zA-Z0-9:_-]+$/.test(result)||reserved.has(result.toLowerCase()))throw Error(`Invalid ${label}.`);
 return result;
}
function text(value,label,max,{required=false}={}) {
 if(value==null){if(required)throw Error(`${label} is required.`);return null;}
 if(typeof value!=='string'||value.length>max)throw Error(`Invalid or oversized ${label}.`);
 const result=value.normalize('NFC').replace(/\s+/g,' ').trim();
 if(!result){if(required)throw Error(`${label} is required.`);return null;}
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result))throw Error(`Invalid ${label}.`);
 return result;
}
function number(value,label,{zero=false}={}) {
 if(value==null)return null;
 if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value.trim()))value=Number(value);
 if(typeof value!=='number'||!Number.isFinite(value)||value>MAX_NUMBER||value<0||(!zero&&value===0))throw Error(`Invalid ${label}.`);
 return value;
}
function timestamp(value,label) {
 if(value==null)return null;
 if(typeof value!=='string'||value.length>64||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error(`Invalid ${label}.`);
 return new Date(value).toISOString();
}
function sourceUrl(value) {
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value.length>2048)throw Error('Invalid source URL.');
 const parsed=new URL(value);
 if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('Source URL must use HTTPS without credentials.');
 return parsed.href;
}
function categories(value) {
 if(value==null)return [];
 if(!Array.isArray(value)||value.length>50)throw Error('Invalid product categories.');
 const items=value.map(item=>{
  if(typeof item==='string')return text(item,'category',300,{required:true});
  if(!record(item))throw Error('Invalid product category.');
  const id=item.id==null?null:safeId(item.id,'category ID',{numeric:true});
  const name=text(item.name,'category name',300);
  if(!id&&!name)throw Error('Product category needs an ID or name.');
  let depth=item.depth??null;
  if(typeof depth==='string'&&/^-?\d+$/.test(depth.trim()))depth=Number(depth);
  if(depth!==null&&(!Number.isInteger(depth)||depth< -100||depth>100))throw Error('Invalid category depth.');
  return {id,name,depth};
 });
 return [...new Map(items.map(item=>[JSON.stringify(item),item])).entries()].sort(([a],[b])=>compare(a,b)).map(([,item])=>item);
}
const metadataKeys=['name','ean','brand','ingredients','description','weight','weightUnit','sourceUrl','categories'];
function metadata(input,previous=null) {
 const get=key=>own(input,key)&&input[key]!==undefined?input[key]:previous?.[key]??null;
 const ean=get('ean');
 if(ean!=null&&(typeof ean!=='string'||!/^\d{1,32}$/.test(ean)))throw Error('EAN must be a digit string.');
 return {
  name:text(input.name,'product name',500,{required:true}),ean:ean??null,
  brand:text(get('brand'),'brand',200),ingredients:text(get('ingredients'),'ingredients',12000),description:text(get('description'),'description',16000),
  weight:number(get('weight'),'product weight',{zero:true}),weightUnit:text(get('weightUnit'),'weight unit',32)?.toLowerCase()??null,
  sourceUrl:sourceUrl(get('sourceUrl')),categories:categories(get('categories'))
 };
}
const fingerprint=entry=>digest(JSON.stringify(Object.fromEntries(metadataKeys.map(key=>[key,entry[key]]))));
function decision(input) {
 if(!record(input)||!hashPattern.test(input.fingerprint??'')||!['approved','excluded'].includes(input.status))throw Error('Invalid catalog decision.');
 const result={fingerprint:input.fingerprint,status:input.status,equivalenceEvidence:text(input.equivalenceEvidence,'equivalence evidence',4000,{required:true}),packAmount:null,unit:null,reviewedAt:timestamp(input.reviewedAt,'review time')};
 if(!result.reviewedAt)throw Error('Review time is required.');
 if(input.status==='approved'){
  result.packAmount=number(input.packAmount,'canonical pack amount');
  if(result.packAmount===null||!['kg','l','stk'].includes(input.unit))throw Error('Approval requires a positive canonical pack amount and kg/l/stk unit.');
  result.unit=input.unit;
 }
 return result;
}

/**
 * Persistent, explicitly reviewed SKU/chain mappings. Source strings are bounded
 * data only. No source text is interpreted as instructions or equivalence.
 * Omitted optional metadata retains known values; explicit null clears a value.
 */
export function createMarketCatalog(state,{now=()=>new Date(),save=()=>{}}={}) {
 if(!record(state)||![Object.prototype,null].includes(Object.getPrototypeOf(state)))throw Error('Catalog state must be a plain map.');
 if(typeof save!=='function')throw Error('Catalog save must be a function.');
 const clock=()=>{
  const result=new Date(typeof now==='function'?now():now);
  if(!Number.isFinite(result.getTime()))throw Error('Invalid catalog clock.');
  return result;
 };
 function read(key) {
  if(!hashPattern.test(key)||!own(state,key))return null;
  try{
   const raw=state[key];if(!record(raw)||raw.version!==VERSION||raw.key!==key)return null;
   const watchId=safeId(raw.watchId,'watch ID'),id=safeId(raw.id,'product ID',{numeric:true}),store=safeId(raw.store,'chain ID');
   if(identity(watchId,store,id)!==key)return null;
   const info=metadata(raw),fp=fingerprint(info);
   if(raw.fingerprint!==fp||!['pending','approved','excluded'].includes(raw.status))return null;
   const review=raw.review==null?null:decision(raw.review),previousReview=raw.previousReview==null?null:decision(raw.previousReview);
   if(raw.status==='pending'?review!==null:!review||review.status!==raw.status||review.fingerprint!==fp)return null;
   const firstSeen=timestamp(raw.firstSeen,'first observation'),lastSeen=timestamp(raw.lastSeen,'last observation'),metadataObservedAt=timestamp(raw.metadataObservedAt,'metadata observation');
   if(!firstSeen||!lastSeen||!metadataObservedAt)return null;
   const pendingSince=raw.status==='pending'?timestamp(raw.pendingSince,'pending time'):null;
   if(raw.status==='pending'&&!pendingSince)return null;
   return {version:VERSION,key,watchId,id,store,...info,fingerprint:fp,status:raw.status,firstSeen,lastSeen,metadataObservedAt,pendingSince,query:text(raw.query,'query',500),currentPrice:number(raw.currentPrice,'current package price'),lastChecked:timestamp(raw.lastChecked,'actual price receipt'),review,previousReview};
  }catch{return null;}
 }
 function snapshot(entry,at) {
  const age=entry.lastChecked===null?Infinity:at-Date.parse(entry.lastChecked),approved=entry.status==='approved';
  return structuredClone({...entry,reviewed:approved,packAmount:approved?entry.review.packAmount:null,unit:approved?entry.review.unit:null,equivalenceEvidence:entry.review?.equivalenceEvidence??null,priceFresh:entry.currentPrice!==null&&age>=-60000&&age<=FRESH_MS});
 }
 const sortEntries=rows=>rows.sort((a,b)=>compare(a.watchId,b.watchId)||compare(a.store,b.store)||compare(a.id,b.id));
 function entries(watchId) {
  if(watchId!=null)watchId=safeId(watchId,'watch ID');
  const at=clock().getTime();
  return sortEntries(Object.keys(state).map(read).filter(entry=>entry&&(watchId==null||entry.watchId===watchId))).map(entry=>snapshot(entry,at));
 }
 function pending() {
  return entries().filter(entry=>entry.status==='pending').sort((a,b)=>compare(a.pendingSince,b.pendingSince)||compare(a.watchId,b.watchId)||compare(a.store,b.store)||compare(a.id,b.id));
 }
 function observe(input) {
  if(!record(input))throw Error('Invalid catalog observation.');
  const watchId=safeId(input.watchId,'watch ID');
  if(!Array.isArray(input.products)||input.products.length>500)throw Error('Observe at most 500 products per call.');
  const date=clock(),at=date.getTime(),observedAt=date.toISOString(),query=own(input,'query')?text(input.query,'query',500):undefined;
  const staged=new Map(),changed=new Set();
  for(const product of input.products){
   if(!record(product))throw Error('Invalid catalog product.');
   const id=safeId(product.id,'product ID',{numeric:true}),store=safeId(product.store,'chain ID'),key=identity(watchId,store,id);
   const previous=staged.get(key)??read(key),info=metadata(product,previous),fp=fingerprint(info);
   if(staged.has(key)&&previous.fingerprint!==fp)throw Error('Conflicting metadata for the same product/chain in one observation.');
   const hasChanged=previous!==null&&previous.fingerprint!==fp;
   if(hasChanged)changed.add(key);
   let currentPrice=hasChanged?null:previous?.currentPrice??null,lastChecked=hasChanged?null:previous?.lastChecked??null;
   const hasPrice=own(product,'currentPrice')&&product.currentPrice!==undefined,hasDate=own(product,'lastChecked')&&product.lastChecked!==undefined;
   if(hasPrice||hasDate){
    const price=hasPrice?number(product.currentPrice,'current package price'):null,checked=hasDate?timestamp(product.lastChecked,'actual price receipt'):null;
    if(checked&&Date.parse(checked)>at+60000)throw Error('Actual price receipt cannot be in the future.');
    // Never combine a new price with an old timestamp, or refresh an old price
    // using only a new metadata observation. Older complete receipts lose.
    if(price===null||checked===null||lastChecked===null||Date.parse(checked)>=Date.parse(lastChecked)){
     currentPrice=price;lastChecked=checked;
    }
   }
   const status=hasChanged?'pending':previous?.status??'pending';
   staged.set(key,{version:VERSION,key,watchId,id,store,...info,fingerprint:fp,status,firstSeen:previous?.firstSeen??observedAt,lastSeen:observedAt,metadataObservedAt:observedAt,pendingSince:status==='pending'?(hasChanged?observedAt:previous?.pendingSince??observedAt):null,query:query===undefined?previous?.query??null:query,currentPrice,lastChecked,review:hasChanged?null:previous?.review??null,previousReview:hasChanged?previous.review??previous.previousReview:previous?.previousReview??null});
  }
  if(staged.size){for(const [key,entry] of staged)state[key]=entry;save();}
  const rows=sortEntries([...staged.values()]).map(entry=>snapshot(entry,at));
  return {observed:rows.length,changed:changed.size,pending:rows.filter(entry=>entry.status==='pending').length,approved:rows.filter(entry=>entry.status==='approved').length,excluded:rows.filter(entry=>entry.status==='excluded').length,entries:rows};
 }
 function review(input) {
  if(!record(input))throw Error('Invalid catalog review.');
  const watchId=safeId(input.watchId,'watch ID'),id=safeId(input.id,'product ID',{numeric:true}),store=safeId(input.store,'chain ID'),key=identity(watchId,store,id),entry=read(key);
  if(!entry)throw Error('Unknown catalog product/chain.');
  if(input.fingerprint!==entry.fingerprint)throw Error('Catalog metadata changed; review the current fingerprint.');
  const at=clock(),next=decision({...input,reviewedAt:at.toISOString()});
  const updated={...entry,status:next.status,pendingSince:null,review:next,previousReview:entry.review??entry.previousReview};
  state[key]=updated;save();return snapshot(updated,at.getTime());
 }
 return {observe,review,pending,entries};
}
