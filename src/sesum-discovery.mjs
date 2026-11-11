import {createHash} from 'node:crypto';
import {createProductLibrary,groupMetadataFingerprint,productMetadataFingerprint} from './product-library.mjs';
import {createIndexReader} from './shopping-library.mjs';
import {sesumNativeIdentity} from './sesum-prices.mjs';
import {countedPackage} from './sesum-counted-package.mjs';

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const stable=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,250}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=1e9;
const near=(a,b)=>Math.abs(a-b)<=1e-6*Math.max(a,b);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fp=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const clone=v=>structuredClone(v);
const CHAINS=new Set(['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA']);
function text(value,label,max=6000,{required=false}={}){
 if(value==null){if(required)throw Error(`${label} is required.`);return null;}
 if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw Error(`Invalid ${label}.`);
 const result=value.normalize('NFC').trim();if(required&&!result)throw Error(`${label} is required.`);return result||null;
}
function https(value){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.href.length>4096)throw Error('Evidence must use HTTPS without credentials.');return u.href;}
function stamp(value,at){if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value)||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value))||Date.parse(value)>at)throw Error('Invalid or future evidence time.');return new Date(value).toISOString();}
function groupDefinition(input){
 if(!plain(input)||!stable(input.id))throw Error('Invalid product family.');
 if(!['kg','l','stk','m'].includes(input.canonicalUnit))throw Error('Invalid canonical family unit.');
 const criteria=input.inclusionCriteria;
 if(!(typeof criteria==='string'||Array.isArray(criteria)&&criteria.length>0&&criteria.length<=50&&criteria.every(v=>typeof v==='string')))throw Error('Invalid inclusion criteria.');
 if(!Array.isArray(input.exclusions)||input.exclusions.length>100)throw Error('Invalid product exclusions.');
 return {id:input.id,name:text(input.name,'family name',500,{required:true}),category:text(input.category,'category',500,{required:true}),canonicalUnit:input.canonicalUnit,inclusionCriteria:Array.isArray(criteria)?criteria.map(v=>text(v,'inclusion criterion',6000,{required:true})):text(criteria,'inclusion criterion',6000,{required:true}),exclusions:input.exclusions.map(v=>text(v,'exclusion',2000,{required:true})),qualityBasis:text(input.qualityBasis,'quality basis',6000,{required:true}),comparisonBasis:text(input.comparisonBasis,'comparison basis',6000,{required:true})};
}
const fullGroup=(id,g)=>groupDefinition({id,name:g.name,category:g.category,canonicalUnit:g.unit,inclusionCriteria:g.inclusion,exclusions:g.exclusions??[],qualityBasis:g.qualityBasis,comparisonBasis:g.comparisonBasis});
function packageOf(s){
 if(s.weight==null)return null;if(!positive(s.weight))throw Error('Invalid source package amount.');
 const unit=String(s.weightUnit??'').toLowerCase(),units={g:[.001,'kg'],kg:[1,'kg'],ml:[.001,'l'],l:[1,'l'],liter:[1,'l'],stk:[1,'stk'],pcs:[1,'stk'],m:[1,'m']},known=units[unit];
 if(!known)throw Error('The source package unit needs review.');return {amount:s.weight*known[0],unit:known[1]};
}
function nutritionOf(input,at){
 if(input==null)return null;if(!plain(input)||!['g','ml'].includes(input.basis)||!plain(input.per100))throw Error('Invalid reviewed nutrition.');
 const keys=['kcal','protein','fat','saturatedFat','carbs','sugars','fiber','salt'],per100={};
 for(const [key,value] of Object.entries(input.per100)){if(!keys.includes(key)||value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1e9))throw Error('Invalid nutrition fact.');per100[key]=value;}
 if(!Object.values(per100).some(v=>typeof v==='number'&&v>0))throw Error('Nutrition needs actual declared facts.');
 return {basis:input.basis,per100,sourceUrl:https(input.sourceUrl),evidence:text(input.evidence,'nutrition evidence',6000,{required:true}),...(input.observedAt?{observedAt:stamp(input.observedAt,at)}:{})};
}
function attributesOf(input){
 if(input==null)return null;if(!plain(input)||Object.keys(input).length>50)throw Error('Invalid reviewed product attributes.');
 const out={};for(const [key,value] of Object.entries(input)){if(!/^[A-Za-z][A-Za-z0-9_-]{0,60}$/.test(key)||!['boolean'].includes(typeof value)&&value!==null)throw Error('Invalid reviewed product attribute.');out[key]=value;}return out;
}

/** Explicit metadata research for a genuinely new Sesum SKU. It creates no
 * price receipt, household watch, family link, inventory count or cart action. */
export function createSesumDiscovery(state,{save=()=>{},now=()=>new Date(),reader=()=>null,source}={}){
 if(!plain(state)||typeof source!=='function')throw Error('Discovery requires a plain state and current source getter.');
 state.version??=1;state.records??={};state.groups??={};state.revision??=0;
 if(state.version!==1||!plain(state.records)||!plain(state.groups))throw Error('Invalid discovery state.');
 const clock=()=>{const date=new Date(typeof now==='function'?now():now);if(!Number.isFinite(date.getTime()))throw Error('Invalid discovery clock.');return date;};
 const raw=()=>typeof reader==='function'?reader():reader;
 const current=key=>{if(!stable(key))return null;const row=source(key);return row&&row.sourceKey===key&&fp(row.sourceFingerprint)&&plain(row.source)?row:null;};
 const groupAt=(id,base)=>base?.group(id)?fullGroup(id,base.group(id)):state.groups[id]??null;
 function register(input){
  if(!plain(input)||!stable(input.sourceKey)||!fp(input.sourceFingerprint))throw Error('Invalid discovery registration.');
  const observed=current(input.sourceKey),s=observed?.source,at=clock(),base=raw();
  if(!observed||observed.sourceFingerprint!==input.sourceFingerprint)throw Error('Sesum metadata changed; read the current product.');
  if(input.sourceKey!==`sesum:${s.store}:${s.id}`||!['string','number'].includes(typeof s.id)||!/^[1-9]\d*$/.test(String(s.id))||!Number.isSafeInteger(Number(s.id))||!CHAINS.has(s.store))throw Error('Invalid or unknown native Sesum chain/product identity.');
  const identityEvidence=text(input.identityEvidence,'identity evidence',6000,{required:true}),packEvidence=text(input.packEvidence,'package evidence',6000,{required:true});
  const direct=input.priceBasis==='direct-unit';let directEvidence=null,measure=null;
  if(direct&&input.countedPack!==undefined)throw Error('Variable unit prices cannot use a fixed counted package measurement.');
  if(direct){
   if(s.soldByWeight!==true||input.packAmount!==null||input.canonicalPackAmount!=null||!['kg','l'].includes(input.unit)||input.fixedPackVerified!=null||input.packBasis!=null||input.nativeProductKey!=null||input.nativeProductFingerprint!=null||input.nativeIdentityEvidence!=null)throw Error('Direct unit registration requires an actually variable product, explicit null package and kg/l without fixed/native package overrides.');
   directEvidence=Object.fromEntries(['variableWeightEvidence','unitPriceEvidence','vatEvidence'].map(key=>[key,text(input[key],key,6000,{required:true}).replace(/\s+/gu,' ')]));
   if(Object.values(directEvidence).some(value=>value.length<10))throw Error('Concrete actual variable, unit-price and VAT evidence is required.');
   if(input.priceIncludesVat!==true)throw Error('Direct unit registration requires explicitly reviewed gross consumer VAT.');
  }else{
  if(input.priceBasis!=null&&input.priceBasis!=='package')throw Error('Unsupported source price basis.');
  if(!positive(input.packAmount)||!['kg','l','stk','m'].includes(input.unit))throw Error('A documented canonical package is required.');
  if(s.soldByWeight!=null&&typeof s.soldByWeight!=='boolean')throw Error('Invalid source weight mode.');
  if(s.soldByWeight===true)throw Error('Variable-weight source products need a separate unit-price contract.');
  if(s.soldByWeight!==false&&input.fixedPackVerified!==true)throw Error('Unknown weight mode needs explicit fixed-package evidence.');
  const original=packageOf(s),drained=input.packBasis==='drained',basisEvidence=text(input.packBasisEvidence,'package-basis evidence',6000,{required:drained});
  if(input.packBasis!=null&&!['net','drained'].includes(input.packBasis))throw Error('Unsupported package basis.');
  if(drained&&(!original||original.unit!=='kg'||input.unit!=='kg'||input.packAmount>original.amount))throw Error('Drained mass must be documented and no larger than the source gross package mass.');
  measure=countedPackage(s,input.countedPack,{packAmount:input.packAmount,unit:input.unit,packBasis:input.packBasis,fixedPackVerified:input.fixedPackVerified,at:at.getTime()});
  if(!drained&&!measure&&original&&(original.unit!==input.unit||!near(original.amount,input.packAmount)))throw Error('Canonical and source package amounts disagree.'+(original.unit==='stk'&&['kg','l'].includes(input.unit)?' A fixed count needs countedPack with the whole net measurement and actual primary receipts; never derive it from the name.':''));
  if(!original&&input.fixedPackVerified!==true)throw Error('A missing source package needs explicit fixed-package verification.');
  }
  const drained=!direct&&input.packBasis==='drained',basisEvidence=drained?text(input.packBasisEvidence,'package-basis evidence',6000,{required:true}):null;
  let nativeIdentity=null,nativeIdentityEvidence=null;
  if(input.nativeProductKey!=null||input.nativeProductFingerprint!=null||input.nativeIdentityEvidence!=null){
   if(!stable(input.nativeProductKey)||!fp(input.nativeProductFingerprint))throw Error('Explicit native identity key and current fingerprint are required.');
   nativeIdentityEvidence=text(input.nativeIdentityEvidence,'native identity evidence',6000,{required:true});
   const native=base?.product(input.nativeProductKey);nativeIdentity=sesumNativeIdentity(input.nativeProductKey,native);
   if(native.store!==s.store||nativeIdentity.metadataFingerprint!==input.nativeProductFingerprint||nativeIdentity.unit!==input.unit||!near(nativeIdentity.pack,input.packAmount))throw Error('Native identity chain, metadata or canonical package changed; review its current fingerprint.');
  }
  if(!Array.isArray(input.sourceReceipts)||!input.sourceReceipts.length||input.sourceReceipts.length>40)throw Error('Original review receipts are required.');
  const receipts=input.sourceReceipts.map(r=>{if(!plain(r))throw Error('Invalid review receipt.');return {url:https(r.url),observedAt:stamp(r.observedAt,at.getTime()),evidence:text(r.evidence,'review receipt',6000,{required:true})};});
  const proposed={};if(input.groups!=null&&(!Array.isArray(input.groups)||input.groups.length>30))throw Error('Invalid new families.');
  for(const candidate of input.groups??[]){const g=groupDefinition(candidate),existing=groupAt(g.id,base);if(existing&&groupMetadataFingerprint(existing)!==groupMetadataFingerprint(g))throw Error('A new family cannot replace conflicting existing rules.');if(proposed[g.id])throw Error('Duplicate new family.');proposed[g.id]=g;}
  const details=input.product??{};if(!plain(details))throw Error('Invalid reviewed product metadata.');
  const codes=Array.isArray(s.ean)?s.ean:s.ean==null?[]:[s.ean];if(codes.some(v=>typeof v!=='string'||!/^\d{8,14}$/.test(v)))throw Error('Invalid source EAN.');
  const sourceUrl=https(s.sourceUrl),url=new URL(sourceUrl);if(url.origin!=='https://www.sesum.no'||!new RegExp(`^/produkt/${s.id}(?:-[^/?#]+)?/?$`).test(url.pathname)||url.search||url.hash)throw Error('Invalid source product page.');
  const product={productKey:input.sourceKey,source:'sesum',store:s.store,id:String(s.id),name:text(s.name,'source name',1000,{required:true}),ean:codes[0]??null,sourceEans:[...codes],brand:text(details.brand??s.brand,'reviewed brand',300),ingredients:text(details.ingredients,'reviewed ingredients',16000),description:text(details.description,'reviewed description',16000),sourceUrl,canonicalPackAmount:input.packAmount,unit:input.unit,packEvidence:drained?`${packEvidence} Avrent masse: ${basisEvidence}`:packEvidence,rawPack:{weight:s.weight??null,weightUnit:s.weightUnit??null},nutrition:nutritionOf(details.nutrition,at.getTime()),attributes:attributesOf(details.attributes),available:true};
  product.metadataFingerprint=productMetadataFingerprint(product);
  if(!Array.isArray(input.memberships)||!input.memberships.length||input.memberships.length>50)throw Error('Explicit reviewed family memberships are required.');
  const used=new Map(),seen=new Set(),memberships=input.memberships.map(m=>{
   if(!plain(m)||!stable(m.groupId)||seen.has(m.groupId))throw Error('Invalid or duplicate reviewed membership.');seen.add(m.groupId);
   const g=proposed[m.groupId]??groupAt(m.groupId,base);if(!g||groupMetadataFingerprint(g)!==m.groupFingerprint)throw Error('Product family changed; review its current rules.');used.set(g.id,g);
   return {groupId:g.id,productKey:product.productKey,status:'approved',equivalenceEvidence:text(m.equivalenceEvidence,'equivalence evidence',6000,{required:true}),qualityEvidence:text(m.qualityEvidence,'quality evidence',6000,{required:true}),reviewedFingerprint:product.metadataFingerprint,reviewedGroupFingerprint:m.groupFingerprint,reviewedAt:at.toISOString(),sourceReceipts:receipts};
  });
  const library={schemaVersion:1,createdAt:at.toISOString(),updatedAt:at.toISOString(),groups:[...used.values()],products:[product],memberships,prices:[]},validated=createProductLibrary(library,{now:at}),audit=validated.audit();
  if(!audit.ok||memberships.some(m=>used.get(m.groupId).canonicalUnit!==product.unit)||validated.productQuote(product.productKey)?.reviewCurrent!==true)throw Error('Reviewed discovery product does not satisfy the product-library contract.');
  const record={sourceKey:input.sourceKey,sourceFingerprint:input.sourceFingerprint,identityEvidence,product,groups:[...used.values()],memberships,...(measure?{countedPack:measure}:{}),...(direct?{priceBasis:'direct-unit',...directEvidence,priceIncludesVat:true}:{packBasis:drained?'drained':'net',packBasisEvidence:basisEvidence}),...(nativeIdentity?{nativeIdentity,nativeIdentityEvidence}:{}),registeredAt:at.toISOString()};
  state.records[input.sourceKey]=record;for(const [id,g] of Object.entries(proposed))if(!base?.group(id))state.groups[id]=g;state.revision++;save();
  return {sourceKey:input.sourceKey,sourceFingerprint:input.sourceFingerprint,productKey:product.productKey,productFingerprint:product.metadataFingerprint,groups:memberships.map(m=>({groupId:m.groupId,groupFingerprint:m.reviewedGroupFingerprint})),registeredAt:record.registeredAt};
 }
 function usable(record,base){
  const observed=current(record.sourceKey);if(!observed||observed.sourceFingerprint!==record.sourceFingerprint)return null;
  if(record.nativeIdentity){
   try{const native=base?.product(record.nativeIdentity.key);if(native?.store!==observed.source.store||!near(record.nativeIdentity.pack,record.product.canonicalPackAmount)||record.nativeIdentity.unit!==record.product.unit||JSON.stringify(sesumNativeIdentity(record.nativeIdentity.key,native))!==JSON.stringify(record.nativeIdentity))return null;}catch{return null;}
  }
  const memberships=record.memberships.filter(m=>{const g=groupAt(m.groupId,base);return g&&groupMetadataFingerprint(g)===m.reviewedGroupFingerprint;});
  return memberships.length?{...record,memberships,groups:record.groups.filter(g=>memberships.some(m=>m.groupId===g.id))}:null;
 }
 let compiledBase=null,compiledRevision=null,compiledStamp=null,compiled=null;const baseIds=new WeakMap();let nextId=0;
 function overlay(base=raw()){
  if(!base)return null;const index=base.index(),active=Object.values(state.records).map(r=>usable(r,base)).filter(Boolean),validation=digest(active.map(r=>[r.sourceKey,r.sourceFingerprint,r.product.metadataFingerprint,r.memberships.map(m=>[m.groupId,m.reviewedGroupFingerprint]),r.nativeIdentity?[r.nativeIdentity,base.product(r.nativeIdentity.key).quote,base.product(r.nativeIdentity.key).available]:null]));
  let id=baseIds.get(index);if(!id){id=++nextId;baseIds.set(index,id);}const cacheKey=[base.cacheKey??'','sesum-discovery',id,state.revision,validation].join('|');
  if(!active.length)return {...base,cacheKey};
  if(compiledBase!==index||compiledRevision!==state.revision||compiledStamp!==validation){
   const out={...index,groups:{...index.groups},products:{...index.products},members:Object.fromEntries(Object.entries(index.members).map(([key,rows])=>[key,[...rows]])),qualityNotes:{...index.qualityNotes}};
   for(const record of active){const generated=createProductLibrary({schemaVersion:1,createdAt:record.registeredAt,updatedAt:record.registeredAt,groups:record.groups,products:[record.product],memberships:record.memberships,prices:[]},{now:clock()}).shoppingIndex();
    // Re-registering an existing native key never inherits approvals bound to
    // the replaced metadata. Only the explicitly reviewed memberships remain.
    for(const groupId of Object.keys(out.members))out.members[groupId]=out.members[groupId].filter(m=>m.k!==record.sourceKey);
    for(const [groupId,g] of Object.entries(generated.groups)){if(!out.groups[groupId])out.groups[groupId]=g;out.members[groupId]=[...(out.members[groupId]??[]).filter(m=>m.k!==record.sourceKey),...generated.members[groupId]];}
    out.products[record.sourceKey]={...generated.products[record.sourceKey],nativeDiscovery:true,sourceFingerprint:record.sourceFingerprint,identityEvidence:record.identityEvidence,...(record.priceBasis==='direct-unit'?{variableWeightReviewed:true}:{}),...(record.nativeIdentity?{nativeIdentity:clone(record.nativeIdentity),nativeIdentityEvidence:record.nativeIdentityEvidence}:{})};Object.assign(out.qualityNotes,generated.qualityNotes);
   }
   compiledBase=index;compiledRevision=state.revision;compiledStamp=validation;compiled=createIndexReader(out,{horizonDays:base.horizonDays});
  }
  return {...compiled(clock().getTime()),cacheKey};
 }
 return {register,overlay,record:key=>{const found=Object.hasOwn(state.records,key)?usable(state.records[key],raw()):null;return found?clone(found):null;},status:()=>({registered:Object.keys(state.records).length,current:Object.values(state.records).filter(r=>usable(r,raw())).length,groups:Object.keys(state.groups).length,revision:state.revision})};
}
