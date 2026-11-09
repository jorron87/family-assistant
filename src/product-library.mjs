import {createHash} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {isUtf8} from 'node:buffer';
import {scoreProductQuality} from './product-quality.mjs';
import {scoreFamilyNutrition} from './product-nutrition.mjs';

const UNITS=new Set(['kg','l','stk','m']);
const FRESH_MS=48*3600000;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const stableId=value=>nonempty(value)&&value.length<=300&&!/[\u0000-\u001f\u007f]/u.test(value);
const hashPattern=/^[a-f0-9]{64}$/;
function timestamp(value) {
 if(typeof value!=='string')return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!m||Number(m[2])<1||Number(m[2])>12||Number(m[3])<1||Number(m[3])>new Date(Date.UTC(Number(m[1]),Number(m[2]),0)).getUTCDate()||Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)return null;
 const result=Date.parse(value);return Number.isFinite(result)?result:null;
}
const https=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}};
const round=value=>Math.round((value+Number.EPSILON)*10000)/10000;
const terms=value=>nonempty(value)||Array.isArray(value)&&value.length>0&&value.every(nonempty);
const compareText=(a,b)=>String(a).localeCompare(String(b),'nb');

function canonical(value) {
 if(value===undefined||value===null)return null;
 if(typeof value==='string')return value.normalize('NFC');
 if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
 if(Array.isArray(value))return value.map(canonical);
 if(plain(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 throw Error('Product metadata must contain only finite JSON values.');
}

// An explicit shared recipe. Prices, availability and review times are separate
// observations and cannot refresh a metadata approval or a price receipt.
export function productMetadataFingerprint(product) {
 if(!plain(product))throw Error('Product metadata must be an object.');
 const keys=['source','store','id','name','ean','brand','ingredients','description','sourceUrl','canonicalPackAmount','unit','packEvidence','rawPack','nutrition','nutritionObservation'];
 const metadata=Object.fromEntries(keys.map(key=>[key,product[key]??null]));
 return createHash('sha256').update(JSON.stringify(canonical(metadata))).digest('hex');
}

export function groupMetadataFingerprint(group) {
 if(!plain(group))throw Error('Group metadata must be an object.');
 const keys=['id','name','category','canonicalUnit','inclusionCriteria','exclusions','qualityBasis','comparisonBasis'];
 return createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(keys.map(key=>[key,group[key]??null]))))).digest('hex');
}

// Identity text a catalogue row must share with a library product before it may
// reuse the library's evidence. A digest keeps long labels out of the read model.
export function productTextHash(product) {
 const norm=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim();
 return createHash('sha256').update(JSON.stringify(['name','ean','brand','ingredients','description','sourceUrl'].map(key=>norm(product[key])))).digest('hex').slice(0,24);
}

export function readProductLibrary(file,options={}) {
 if(typeof file!=='string'||!file.trim())throw Error('An explicit product-library JSON file is required.');
 const info=statSync(file);
 if(!info.isFile()||info.size>128*1024*1024)throw Error('Read a JSON file no larger than 128 MB.');
 let data;
 try{const bytes=readFileSync(file);if(!isUtf8(bytes))throw Error('Invalid UTF-8');data=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u,''));}
 catch{throw Error('The product-library file is not valid UTF-8 JSON.');}
 return createProductLibrary(data,options);
}

/** Read-only snapshot of a researched library; never opens a store or a URL. */
export function createProductLibrary(input,{now=new Date()}={}) {
 if(!plain(input)||input.schemaVersion!==1)throw Error('Unsupported product-library schemaVersion; expected 1.');
 for(const key of ['groups','products','memberships','prices'])if(!Array.isArray(input[key])||input[key].length>1000000)throw Error(`Library ${key} must be an array of at most 1000000 rows.`);
 const at=new Date(now).getTime();if(!Number.isFinite(at))throw Error('Invalid comparison time.');
 const data=structuredClone(input),issues=[],groups=new Map(),products=new Map(),memberships=new Map(),prices=new Map();
 const addIssue=(severity,code,context={})=>issues.push({severity,code,...context});
 for(const field of ['createdAt','updatedAt'])if(timestamp(data[field])===null)addIssue('warning','missing-or-invalid-library-timestamp',{field});
 const index=(rows,key,type,target)=>{
  const duplicates=new Set();
  rows.forEach((row,rowIndex)=>{
   const id=plain(row)?row[key]:null;
   if(!stableId(id)){addIssue('error','invalid-'+type+'-identity',{row:rowIndex});return;}
   if(target.has(id)||duplicates.has(id)){target.delete(id);duplicates.add(id);addIssue('error','duplicate-'+type+'-identity',{[key]:id,row:rowIndex});return;}
   target.set(id,row);
  });
 };
 index(data.groups,'id','group',groups);index(data.products,'productKey','product',products);
 const invalidGroups=new Set(),invalidProducts=new Set(),badFingerprints=new Set();
 for(const [id,g] of groups){
  if(!nonempty(g.name)||!nonempty(g.category)||!UNITS.has(g.canonicalUnit)||!terms(g.inclusionCriteria)||!nonempty(g.qualityBasis)||!nonempty(g.comparisonBasis)||!Array.isArray(g.exclusions)||!g.exclusions.every(nonempty)){
   invalidGroups.add(id);addIssue('error','invalid-group-definition',{groupId:id});
  }
 }
 for(const [productKey,p] of products){
  if(!stableId(p.source)||!stableId(p.store)||!stableId(p.id)||productKey!==`${p.source}:${p.store}:${p.id}`||!nonempty(p.name)){
   invalidProducts.add(productKey);addIssue('error','invalid-product-definition',{productKey});
  }
  let fingerprint=null;try{fingerprint=productMetadataFingerprint(p);}catch{}
  if(!hashPattern.test(p.metadataFingerprint??'')||p.metadataFingerprint!==fingerprint){badFingerprints.add(productKey);addIssue('error','metadata-fingerprint-mismatch',{productKey});}
  if(p.canonicalPackAmount!=null&&!positive(p.canonicalPackAmount))addIssue('error','invalid-canonical-pack-amount',{productKey});
  else if(p.canonicalPackAmount==null)addIssue('warning','unknown-canonical-pack-amount',{productKey});
  if(p.unit!=null&&!UNITS.has(p.unit))addIssue('error','invalid-product-unit',{productKey});
  if(!nonempty(p.packEvidence))addIssue('warning','missing-pack-evidence',{productKey});
  if(!https(p.sourceUrl))addIssue('warning','missing-product-source',{productKey});
  if(p.nutrition==null)addIssue('warning','missing-nutrition',{productKey});
  else{
   const n=p.nutrition,values=plain(n.per100)?Object.values(n.per100):[];
   if(!['g','ml'].includes(n.basis)||!plain(n.per100)||!https(n.sourceUrl)||!nonempty(n.evidence)||!values.length||values.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0))||!values.some(v=>typeof v==='number'&&v>0))addIssue('warning','unverified-nutrition',{productKey});
  }
 }
 const duplicateMemberships=new Set();
 data.memberships.forEach((m,row)=>{
  if(!plain(m)||!stableId(m.groupId)||!stableId(m.productKey)||!['approved','excluded','unknown'].includes(m.status)){addIssue('error','invalid-membership',{row});return;}
  const key=JSON.stringify([m.groupId,m.productKey]);
  if(memberships.has(key)||duplicateMemberships.has(key)){memberships.delete(key);duplicateMemberships.add(key);addIssue('error','duplicate-membership',{groupId:m.groupId,productKey:m.productKey});return;}
  memberships.set(key,m);
 });
 const membershipReasons=m=>{
  const p=products.get(m.productKey),g=groups.get(m.groupId),reasons=[];
  if(!p||invalidProducts.has(m.productKey))reasons.push('missing-or-invalid-product');
  if(!g||invalidGroups.has(m.groupId))reasons.push('missing-or-invalid-group');
  if(m.status!=='approved'){reasons.push(m.status==='excluded'?'excluded-membership':'unreviewed-membership');return reasons;}
  if(!nonempty(m.equivalenceEvidence)||!nonempty(m.qualityEvidence))reasons.push('missing-review-evidence');
  if(timestamp(m.reviewedAt)===null||timestamp(m.reviewedAt)>at)reasons.push('invalid-review-time');
  if(!Array.isArray(m.sourceReceipts)||!m.sourceReceipts.length||m.sourceReceipts.some(r=>!plain(r)||!https(r.url)||timestamp(r.observedAt)===null||timestamp(r.observedAt)>at||!nonempty(r.evidence)))reasons.push('missing-or-invalid-review-receipts');
  if(p&&(badFingerprints.has(m.productKey)||m.reviewedFingerprint!==p.metadataFingerprint))reasons.push('reviewed-metadata-changed');
  if(g&&m.reviewedGroupFingerprint!==groupMetadataFingerprint(g))reasons.push('reviewed-group-changed');
  return reasons;
 };
 const byGroup=new Map(),byProduct=new Map();
 for(const m of memberships.values()){
  const groupRows=byGroup.get(m.groupId)??[];groupRows.push(m);byGroup.set(m.groupId,groupRows);
  const productRows=byProduct.get(m.productKey)??[];productRows.push(m);byProduct.set(m.productKey,productRows);
  for(const code of membershipReasons(m))addIssue(m.status==='approved'||code.startsWith('missing-or-invalid-')?'error':'warning',code,{groupId:m.groupId,productKey:m.productKey});
  const p=products.get(m.productKey),g=groups.get(m.groupId);
  if(p&&g&&p.unit!==g.canonicalUnit)addIssue('warning',p.unit==null?'unknown-product-unit':'unit-mismatch',{groupId:m.groupId,productKey:m.productKey});
 }
 data.prices.forEach((p,row)=>{
  if(!plain(p)||!stableId(p.productKey)){addIssue('error','invalid-price-observation',{row});return;}
  if(!products.has(p.productKey))addIssue('error','price-for-unknown-product',{productKey:p.productKey,row});
  if(timestamp(p.receiptAt)===null){addIssue('warning','missing-or-invalid-price-receipt',{productKey:p.productKey,row});return;}
  const rows=prices.get(p.productKey)??[];rows.push(p);prices.set(p.productKey,rows);
 });
 function priceOf(productKey,{ageless=false}={}) {
  const rows=prices.get(productKey)??[];
  if(!rows.length)return {grossPackPrice:null,grossUnitPrice:null,unit:null,unitPriceEvidence:null,directUnitVerified:false,directUnitReasons:[],receiptAt:null,fresh:false,ageHours:null,availabilityScope:null,sourceUrl:null,reasons:['missing-price-receipt']};
  const latest=rows.reduce((max,p)=>Math.max(max,timestamp(p.receiptAt)),-Infinity),current=rows.filter(p=>timestamp(p.receiptAt)===latest),p=current.find(p=>https(p.sourceUrl))??current[0];
  const reasons=[],age=at-latest,fresh=age>=0&&age<=FRESH_MS;
  const comparableSignature=p=>JSON.stringify([p.grossPackPrice??null,p.grossUnitPrice??null,p.unit??null,nonempty(p.unitPriceEvidence),p.currency??'NOK',p.availabilityScope,p.priceIncludesVat!==false,p.grossUnitPrice==null?null:p.priceIncludesVat===true,p.available!==false&&p.delisted!==true]);
  if(new Set(current.map(comparableSignature)).size>1)reasons.push('conflicting-latest-prices');
  const directUnitReasons=[],hasDirectQuote=Object.hasOwn(p,'grossUnitPrice');
  if(hasDirectQuote){
   if(!positive(p.grossUnitPrice))directUnitReasons.push('unknown-gross-unit-price');
   if(!UNITS.has(p.unit))directUnitReasons.push('unknown-direct-unit');
   if(!nonempty(p.unitPriceEvidence))directUnitReasons.push('missing-unit-price-evidence');
   if(p.priceIncludesVat!==true)directUnitReasons.push('unverified-unit-price-vat');
  }
  const directUnitVerified=hasDirectQuote&&!directUnitReasons.length;
  if(!positive(p.grossPackPrice)&&!directUnitVerified)reasons.push(...(hasDirectQuote?directUnitReasons:['unknown-gross-package-price']));
  if(p.priceIncludesVat===false)reasons.push('unverified-gross-price');
  if(p.currency!=null&&p.currency!=='NOK')reasons.push('unsupported-currency');
  if(p.availabilityScope!=='chain')reasons.push('unknown-price-scope');
  if(p.available===false||p.delisted===true)reasons.push('unavailable-product');
  if(!https(p.sourceUrl))reasons.push('missing-price-source');
  if(!fresh&&!ageless)reasons.push(age<0?'future-price-receipt':'stale-price-receipt');
  return {grossPackPrice:positive(p.grossPackPrice)?p.grossPackPrice:null,grossUnitPrice:positive(p.grossUnitPrice)?p.grossUnitPrice:null,unit:p.unit??null,unitPriceEvidence:p.unitPriceEvidence??null,priceIncludesVat:p.priceIncludesVat??null,directUnitVerified,directUnitReasons,quotedPrice:structuredClone(p.quotedPrice??null),receiptAt:p.receiptAt,fresh,ageHours:round(age/3600000),availabilityScope:p.availabilityScope??null,sourceUrl:p.sourceUrl??null,currency:p.currency??'NOK',reasons};
 }
 for(const [productKey] of prices){const quote=priceOf(productKey);for(const code of new Set([...quote.reasons,...quote.directUnitReasons]))addIssue(code==='conflicting-latest-prices'?'error':'warning',code,{productKey});}
 const productView=p=>structuredClone({productKey:p.productKey,source:p.source,store:p.store,id:p.id,name:p.name,ean:p.ean??null,brand:p.brand??null,ingredients:p.ingredients??null,description:p.description??null,sourceUrl:p.sourceUrl??null,canonicalPackAmount:p.canonicalPackAmount??null,unit:p.unit??null,packEvidence:p.packEvidence??null,rawPack:p.rawPack??null,nutrition:p.nutrition??null,nutritionObservation:p.nutritionObservation??null,metadataFingerprint:p.metadataFingerprint,metadataCurrent:!badFingerprints.has(p.productKey)});
 function assess(m,group,options={}) {
   const p=products.get(m.productKey),reviewReasons=membershipReasons(m),price=priceOf(m.productKey,options),reasons=[...reviewReasons,...price.reasons];
   const packVerified=!!p&&positive(p.canonicalPackAmount)&&nonempty(p.packEvidence)&&p.unit===group.canonicalUnit&&positive(price.grossPackPrice);
   const directVerified=price.directUnitVerified&&price.unit===group.canonicalUnit;
   if(!packVerified&&!directVerified){
    if(!p||!positive(p.canonicalPackAmount)||!nonempty(p.packEvidence))reasons.push('unverified-canonical-pack');
    if(p&&p.unit!==group.canonicalUnit)reasons.push('unit-mismatch');
    if(price.directUnitVerified&&price.unit!==group.canonicalUnit)reasons.push('direct-unit-mismatch');
   }
   if(p?.canonicalPackAmount!=null&&!positive(p.canonicalPackAmount))reasons.push('invalid-canonical-pack-amount');
   if(p?.unit!=null&&!UNITS.has(p.unit))reasons.push('invalid-product-unit');
   if(p?.available===false||p?.delisted===true)reasons.push('unavailable-product');
   const packUnitPrice=packVerified?price.grossPackPrice/p.canonicalPackAmount:null;
   // A displayed unit price may be rounded to an øre. A larger discrepancy is
   // contradictory evidence, never a reason to select whichever price is lower.
   if(packVerified&&directVerified&&Math.abs(packUnitPrice-price.grossUnitPrice)>.005+Number.EPSILON*Math.max(1,packUnitPrice,price.grossUnitPrice))reasons.push('conflicting-price-bases');
   const unitPriceBasis=packVerified?'package':directVerified?'direct-unit':null;
   const rawUnitPrice=!reasons.length?(packVerified?packUnitPrice:directVerified?price.grossUnitPrice:null):null;
   if(rawUnitPrice!==null&&!Number.isFinite(rawUnitPrice))reasons.push('invalid-normalized-price');
   const reviewCurrent=m.status==='approved'&&!reviewReasons.length;
   return {productKey:m.productKey,reviewCurrent,quality:scoreProductQuality(p?{...p,sourceUrl:p.sourceUrl??m.sourceReceipts?.[0]?.url}:p,{groupId:group.id,reviewCurrent}),price,eligible:!reasons.length&&rawUnitPrice!==null,unitPrice:!reasons.length?rawUnitPrice:null,unitPriceBasis,reasons:[...new Set(reasons)]};
 }
 for(const m of memberships.values()){const g=groups.get(m.groupId);if(g&&assess(m,g).reasons.includes('conflicting-price-bases'))addIssue('error','conflicting-price-bases',{groupId:m.groupId,productKey:m.productKey});}
 function rowsFor(groupId) {
  const group=groups.get(groupId);if(!group||invalidGroups.has(groupId))throw Error('Unknown or invalid product-library group.');
  return (byGroup.get(groupId)??[]).map(m=>({...assess(m,group),product:products.has(m.productKey)?productView(products.get(m.productKey)):null,membership:structuredClone(m)})).sort((a,b)=>Number(b.eligible)-Number(a.eligible)||(a.unitPrice??Infinity)-(b.unitPrice??Infinity)||compareText(a.productKey,b.productKey));
 }
 function compare(groupId) {
  const rows=rowsFor(groupId),eligible=rows.filter(r=>r.eligible),low=eligible[0]?.unitPrice??null;
  return {group:structuredClone(groups.get(groupId)),asOf:new Date(at).toISOString(),currency:'NOK',scope:'chain prices; local stock, memberships and customer limits unverified',rows,cheapest:low===null?null:{unitPrice:low,unit:groups.get(groupId).canonicalUnit,productKeys:eligible.filter(r=>r.unitPrice===low).map(r=>r.productKey)},counts:{memberships:rows.length,reviewed:rows.filter(r=>r.reviewCurrent).length,currentComparable:eligible.length,held:rows.length-eligible.length}};
 }
 function summary() {
  const categoryGroups=new Map(),chainProducts=new Map(),linked=new Set(),currentApproved=new Set(),currentComparable=new Set();
  const groupStats=[];
  for(const g of groups.values()){
   if(invalidGroups.has(g.id))continue;
   const category=categoryGroups.get(g.category)??{groups:new Set(),products:new Set(),reviewedProducts:new Set()};category.groups.add(g.id);categoryGroups.set(g.category,category);
   const rows=(byGroup.get(g.id)??[]).map(m=>{if(products.has(m.productKey)&&!invalidProducts.has(m.productKey))category.products.add(m.productKey);const row=assess(m,g);if(row.reviewCurrent)category.reviewedProducts.add(m.productKey);if(row.eligible)currentComparable.add(m.productKey);return row;});
   groupStats.push({groupId:g.id,category:g.category,memberships:rows.length,reviewed:rows.filter(r=>r.reviewCurrent).length,currentComparable:rows.filter(r=>r.eligible).length,held:rows.filter(r=>!r.eligible).length});
  }
  for(const p of products.values()){const set=chainProducts.get(p.store)??new Set();set.add(p.productKey);chainProducts.set(p.store,set);}
  const statuses={approved:0,excluded:0,unknown:0,currentApproved:0};
  for(const m of memberships.values()){linked.add(m.productKey);statuses[m.status]++;if(m.status==='approved'&&!membershipReasons(m).length){statuses.currentApproved++;currentApproved.add(m.productKey);}}
  return {schemaVersion:1,asOf:new Date(at).toISOString(),createdAt:data.createdAt??null,updatedAt:data.updatedAt??null,counts:{groups:data.groups.length,products:data.products.length,memberships:data.memberships.length,priceObservations:data.prices.length,indexedGroups:groups.size,indexedProducts:products.size},memberships:statuses,
   actualCoverage:{categories:[...categoryGroups].map(([category,sets])=>({category,groups:sets.groups.size,products:sets.products.size,reviewedProducts:sets.reviewedProducts.size})).sort((a,b)=>compareText(a.category,b.category)),chains:[...chainProducts].map(([store,keys])=>({store,products:keys.size,reviewedProducts:[...keys].filter(k=>currentApproved.has(k)).length,currentComparableProducts:[...keys].filter(k=>currentComparable.has(k)).length,withFreshPrice:[...keys].filter(k=>{const p=priceOf(k);return p.fresh&&!p.reasons.length;}).length})).sort((a,b)=>compareText(a.store,b.store)),groups:groupStats,researchGaps:{unassignedProducts:[...products.keys()].filter(k=>!linked.has(k)).length,unreviewedMemberships:statuses.unknown,nonCurrentApprovedMemberships:statuses.approved-statuses.currentApproved,unknownPackAmounts:[...products.values()].filter(p=>!positive(p.canonicalPackAmount)).length,missingNutrition:[...products.values()].filter(p=>p.nutrition==null).length,unverifiedNutrition:issues.filter(i=>i.code==='unverified-nutrition').length}},reportedCoverage:structuredClone(data.coverage??null),coverageNote:'Counts describe this file and its reviewed rows, not complete category or chain assortments.',audit:{errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length}};
 }
 function search(query,{limit=50}={}) {
  if(!nonempty(query)||query.length>300)throw Error('Search requires 1–300 characters.');
  if(!Number.isInteger(limit)||limit<1||limit>500)throw Error('Search limit must be 1–500.');
  const needle=query.normalize('NFC').toLocaleLowerCase('nb-NO');
  const found=[...products.values()].filter(p=>[p.name,p.brand,p.ingredients,...(byProduct.get(p.productKey)??[]).map(m=>groups.get(m.groupId)?.name)].some(v=>typeof v==='string'&&v.normalize('NFC').toLocaleLowerCase('nb-NO').includes(needle))).sort((a,b)=>compareText(a.name,b.name)||compareText(a.productKey,b.productKey));
  return {query,total:found.length,limit,items:found.slice(0,limit).map(p=>({product:productView(p),memberships:(byProduct.get(p.productKey)??[]).map(m=>({groupId:m.groupId,status:m.status,reviewCurrent:m.status==='approved'&&!membershipReasons(m).length})),price:priceOf(p.productKey)}))};
 }
 function audit({limit=100}={}) {
  if(!Number.isInteger(limit)||limit<1||limit>10000)throw Error('Audit limit must be 1–10000.');
  const errors=issues.filter(i=>i.severity==='error'),warnings=issues.filter(i=>i.severity==='warning'),ordered=[...errors,...warnings];
  return {ok:errors.length===0,errors:errors.length,warnings:warnings.length,totalIssues:issues.length,issues:structuredClone(ordered.slice(0,limit)),moreIssues:Math.max(0,issues.length-limit),coverage:summary().actualCoverage};
 }
 function productQuote(productKey) {
  const p=products.get(productKey);
  if(!p||invalidProducts.has(productKey)||badFingerprints.has(productKey))return null;
  const reviewed=(byProduct.get(productKey)??[]).some(m=>m.status==='approved'&&!membershipReasons(m).length);
  const price=priceOf(productKey);
  if(p.available===false||p.delisted===true)price.reasons.push('unavailable-product');
  return {product:productView(p),reviewCurrent:reviewed,price};
 }
 /** Compact, time-independent read model for the shopping views. Price age is
  * judged by the reader at use, so the large source never loads in the server. */
 function shoppingIndex() {
  const out={groups:{},members:{},products:{},qualityNotes:{}};
  const short=(value,max)=>nonempty(value)?value.trim().slice(0,max):null;
  for(const [id,g] of groups){
   if(invalidGroups.has(id))continue;
   out.groups[id]={name:g.name,category:g.category,unit:g.canonicalUnit,fingerprint:groupMetadataFingerprint(g),inclusion:g.inclusionCriteria,exclusions:g.exclusions,qualityBasis:g.qualityBasis,comparisonBasis:g.comparisonBasis};
   const listed=(byGroup.get(id)??[]).filter(m=>products.has(m.productKey)&&!invalidProducts.has(m.productKey)&&!badFingerprints.has(m.productKey));
   const nutrition=scoreFamilyNutrition(listed.filter(m=>m.status==='approved'&&assess(m,g,{ageless:true}).reviewCurrent).map(m=>{const p=products.get(m.productKey),per100=p.nutrition?.per100??null;return {key:m.productKey,basis:p.nutrition?.basis??null,per100:per100&&p.nutritionObservation?.fiberConflict?{...per100,fiber:null}:per100};}).filter(row=>row.per100));
   out.members[id]=listed.map(m=>{
    const a=assess(m,g,{ageless:true}),q=a.quality;
    if(q.status==='scored')out.qualityNotes[q.comparisonKey]=q.limitations;
    return {k:m.productKey,s:m.status,r:a.reviewCurrent,u:a.eligible?a.unitPrice:null,q:q.status==='scored'?{score:q.score,key:q.comparisonKey,label:q.label,criterion:q.criterion,value:q.measurement?.value??null,unit:q.measurement?.unit??null,evidence:short(q.measurement?.evidence?.[0]?.text,200)}:null,n:nutrition.get(m.productKey)??null,qs:q.status,qr:q.reasons?.[0]??null,e:short(m.equivalenceEvidence,400),qe:short(m.qualityEvidence,300)};
   });
  }
  for(const [key,p] of products){
   if(invalidProducts.has(key)||badFingerprints.has(key))continue;
   const q=priceOf(key,{ageless:true}),n=p.nutrition;
   out.products[key]={store:p.store,id:p.id,name:p.name,ean:p.ean??null,brand:p.brand??null,ingredients:short(p.ingredients,2000),description:short(p.description,800),packEvidence:short(p.packEvidence,160),textHash:productTextHash(p),pack:positive(p.canonicalPackAmount)?p.canonicalPackAmount:null,packKnown:nonempty(p.packEvidence),unit:p.unit??null,rawPack:p.rawPack?{weight:p.rawPack.weight??null,weightUnit:p.rawPack.weightUnit??null}:null,sourceUrl:p.sourceUrl??null,attributes:p.attributes??null,available:p.available!==false&&p.delisted!==true,nutrition:n?{basis:n.basis,per100:n.per100,sourceUrl:n.sourceUrl??null,...(p.nutritionObservation?.fiberConflict?{fiberConflict:true}:{})}:null,
    quote:{grossPackPrice:q.grossPackPrice,grossUnitPrice:q.grossUnitPrice,unit:q.unit,directUnitVerified:q.directUnitVerified,receiptAt:q.receiptAt,reasons:q.reasons,sourceUrl:q.sourceUrl}};
  }
  return out;
 }
 return {summary,search,compare,audit,productQuote,shoppingIndex};
}
