import {createHash} from 'node:crypto';
import {createIndexReader} from './shopping-library.mjs';
import {productTextHash} from './product-library.mjs';
import {sanitizeUnitPriceBasis,unitPriceBasisFingerprint} from './sesum-unit-basis.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const stable=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,250}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value??null;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone=value=>structuredClone(value);
const near=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const normalize=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim();
const lower=value=>normalize(value).toLocaleLowerCase('nb');
const variableNative=entry=>/(?:^|\s)ca\.?\s*\d|cirka|omtrent|vektvare|\b(?:pr|per)\.?\s*(?:kg|l)\b/i.test(entry.name??'');
function text(value,label,max=2000,{required=false}={}){
 if(value===undefined||value===null){if(required)throw Error(`${label} is required.`);return null;}
 if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw Error(`Invalid ${label}.`);
 const result=normalize(value);if(required&&!result)throw Error(`${label} is required.`);return result||null;
}
function time(value,label,{nullable=false}={}){
 if(nullable&&value==null)return null;
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value)||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error(`Invalid ${label}.`);
 return new Date(value).toISOString();
}
function eans(value){
 if(value==null)return [];
 const result=Array.isArray(value)?value:[value];
 if(result.length>30||result.some(item=>typeof item!=='string'||!/^\d{8,14}$/.test(item)))throw Error('Invalid Sesum EAN.');
 return [...new Set(result)].sort();
}
function productUrl(value,id){
 const url=new URL(value);
 if(url.origin!=='https://www.sesum.no'||url.username||url.password||url.hash||url.search||!new RegExp(`^/produkt/${id}(?:-[^/?#]+)?/?$`).test(url.pathname))throw Error('Invalid Sesum product URL.');
 return url.href;
}
function promo(value){
 if(value==null)return null;
 if(!plain(value))throw Error('Invalid Sesum promotion.');
 const allowed=['id','title','description','startsAt','endsAt','startDate','endDate','validFrom','validTo','validUntil','valid_from','valid_to','valid_until','memberOnly','member_only','memberProgram','member_program','customerLimit','customer_limit','limit','quantity','price','multi_buy_quantity','multi_buy_price','multi_buy_pay_for','conditions'];
 const out={};for(const key of allowed)if(Object.hasOwn(value,key)){
  const item=value[key];if(item!==null&&!['string','number','boolean'].includes(typeof item))throw Error('Invalid Sesum promotion field.');
  if(typeof item==='string')out[key]=text(item,'promotion field',2000);
  else if(typeof item==='number'){if(!Number.isFinite(item))throw Error('Invalid promotion number.');out[key]=item;}
  else out[key]=item;
 }
 return out;
}
const receiptReasons=receipt=>[...new Set([...receipt.reasons,...(receipt.isPromo===true||receipt.promotion!=null?['unverified-promotion-conditions']:[])])];
const alias=code=>({EXTRA:'COOP_EXTRA',MENY:'MENY_NO',SPAR:'SPAR_NO',ODA:'ODA_NO',EUROPRIS:'EUROPRIS_NO',OBS:'COOP_OBS',PRIX:'COOP_PRIX',MEGA:'COOP_MEGA'}[code]??code);
const CHAINS=new Set(['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA']);
function packOf(source){
 if(source.soldByWeight!==false)return null;
 const weight=source.weight,unit=lower(source.weightUnit);
 if(!positive(weight))return null;
 if(unit==='g')return {amount:weight/1000,unit:'kg'};
 if(unit==='kg')return {amount:weight,unit:'kg'};
 if(unit==='ml')return {amount:weight/1000,unit:'l'};
 if(['l','liter'].includes(unit))return {amount:weight,unit:'l'};
 if(['stk','pcs','st','stykk'].includes(unit))return {amount:weight,unit:'stk'};
 return null;
}
export function sesumSourceFingerprint(source){
 return hash(Object.fromEntries(['id','store','name','brand','vendor','ean','weight','weightUnit','soldByWeight','sourceUrl',...(source.nonEanCodes?.length?['nonEanCodes']:[])].map(key=>[key,source[key]??null])));
}
export function sesumDonorFingerprint(product){
 if(typeof product?.metadataFingerprint==='string'&&/^[a-f0-9]{64}$/.test(product.metadataFingerprint))return product.metadataFingerprint;
 return hash(Object.fromEntries(['store','id','name','ean','brand','ingredients','description','textHash','pack','packKnown','unit','packEvidence','rawPack','sourceUrl','attributes','nutrition'].map(key=>[key,product?.[key]??null])));
}
export function sesumNativeIdentity(key,product){
 if(!stable(key)||!product||key!==`kassal:${product.store}:${product.id}`||!CHAINS.has(product.store)||!product.packKnown||!positive(product.pack)||!['kg','l','stk','m'].includes(product.unit))throw Error('A current fixed native product identity is required.');
 return {key,metadataFingerprint:sesumDonorFingerprint(product),textHash:product.textHash??productTextHash(product),rawPack:product.rawPack?{weight:product.rawPack.weight??null,weightUnit:product.rawPack.weightUnit??null}:null,pack:product.pack,unit:product.unit};
}
function boundNativeIdentity(donor,base,store){
 if(donor.nativeIdentity==null)return null;
 const identity=donor.nativeIdentity,native=plain(identity)&&stable(identity.key)?base?.product(identity.key):null;
 try{
  if(!native||native.store!==store||native.unit!==donor.unit||!near(native.pack,donor.pack)||hash(sesumNativeIdentity(identity.key,native))!==hash(identity))return false;
 }catch{return false;}
 return {...identity,product:native};
}
function normalizedRows(products,fetchedAt,at){
 if(!Array.isArray(products)||products.length>500)throw Error('Observe at most 500 Sesum products.');
 const rows=[];
 for(const input of products){
  if(!plain(input)||!/^([1-9]\d*)$/.test(String(input.id))||!Number.isSafeInteger(Number(input.id)))throw Error('Invalid Sesum source product.');
  const id=String(input.id),weight=input.weight??null;
  if(weight!==null&&(!positive(weight)||weight>1e9))throw Error('Invalid Sesum product weight.');
  if(input.soldByWeight!=null&&typeof input.soldByWeight!=='boolean')throw Error('Invalid Sesum weight mode.');
  const nonEanCodes=input.nonEanCodes??[];
  if(!Array.isArray(nonEanCodes)||nonEanCodes.length>30||nonEanCodes.some(code=>typeof code!=='string'||!(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/).test(code)||/^\d{8,14}$/.test(code)))throw Error('Invalid Sesum non-EAN code.');
  const product={id,name:text(input.name,'Sesum product name',1000,{required:true}),brand:text(input.brand,'brand',300),vendor:text(input.vendor,'vendor',300),ean:eans(input.ean),...(nonEanCodes.length?{nonEanCodes:[...new Set(nonEanCodes)].sort()}:{}),weight,weightUnit:text(input.weightUnit,'weight unit',30),soldByWeight:input.soldByWeight??null,sourceUrl:productUrl(input.sourceUrl,id)};
  const ownPrices=input.prices??(Array.isArray(input.priceCandidates)?[]:null);
  if(!Array.isArray(ownPrices)||ownPrices.length>100)throw Error('Invalid Sesum chain prices.');
  if(input.priceCandidates!=null&&(!Array.isArray(input.priceCandidates)||input.priceCandidates.length>100))throw Error('Invalid Sesum price candidates.');
  for(const inputPrice of ownPrices){
   if(!plain(inputPrice))throw Error('Invalid Sesum chain price.');
   const store=alias(inputPrice.storeCode);if(!CHAINS.has(store))throw Error('Unsupported Sesum chain.');
   const price=inputPrice.price??null;if(price!==null&&(!positive(price)||price>1e9))throw Error('Invalid Sesum package price.');
   const observedAt=time(inputPrice.observedAt,'actual Sesum price receipt',{nullable:true});
   if(observedAt&&Date.parse(observedAt)>at)throw Error('Actual Sesum price receipt cannot be in the future.');
   const source={...product,store},fingerprint=sesumSourceFingerprint(source),priceSource=text(inputPrice.source,'price source',100);
   const checked=sanitizeUnitPriceBasis(inputPrice.unitPriceBasis,{productId:id,sourceUrl:product.sourceUrl,storeCode:store,storeId:inputPrice.storeId,price,source:inputPrice.source,observedAt:inputPrice.observedAt});
   const storeId=typeof inputPrice.storeId==='string'&&/^[1-9]\d{0,29}$/.test(inputPrice.storeId)?inputPrice.storeId:Number.isSafeInteger(inputPrice.storeId)&&inputPrice.storeId>0?String(inputPrice.storeId):null;
   rows.push({sourceKey:`sesum:${store}:${id}`,source,fingerprint,fetchedAt,receipt:{price,observedAt,source:priceSource,sourceStoreCode:text(inputPrice.sourceStoreCode??inputPrice.storeCode,'source chain',100),storeId,rawUnitPrice:typeof inputPrice.rawUnitPrice==='number'&&Number.isFinite(inputPrice.rawUnitPrice)?inputPrice.rawUnitPrice:null,isPromo:inputPrice.isPromo===true,promotion:promo(inputPrice.promotion),...(product.soldByWeight===true?{variableWeight:true,unitPriceBasis:checked.basis,unitPriceBasisFingerprint:unitPriceBasisFingerprint(checked.basis,{sourceFingerprint:fingerprint,fetchedAt}),unitPriceBasisError:checked.reason}:{}),reasons:[...(observedAt?[]:['missing-price-receipt']),...(priceSource?[]:['missing-price-source']),...(price!==null?[]:['unknown-gross-package-price']),...(product.soldByWeight===true&&checked.reason?[checked.reason]:[]),...(inputPrice.isPromo===true?['unverified-promotion-conditions']:[])]}});
  }
  for(const inputPrice of input.priceCandidates??[]){
   if(!plain(inputPrice))continue;
   const store=alias(inputPrice.storeCode);if(!CHAINS.has(store))continue; // A catalogue hit never invents a chain.
   const safeText=(value,max)=>{try{return text(value,'unproven source field',max);}catch{return null;}};
   let observedAt=null;try{observedAt=time(inputPrice.observedAt,'candidate date',{nullable:true});if(observedAt&&Date.parse(observedAt)>at)observedAt=null;}catch{ /* invalid candidate dates stay unknown */ }
   let promotion=null;try{promotion=promo(inputPrice.promotion);}catch{ /* malformed optional terms cannot discard other valid rows */ }
   const priceSource=safeText(inputPrice.source,100),sourceStoreCode=alias(inputPrice.sourceStoreCode)===store?inputPrice.sourceStoreCode:inputPrice.storeCode;
   const candidate={storeCode:store,sourceStoreCode,storeId:Number.isSafeInteger(inputPrice.storeId)&&inputPrice.storeId>0?inputPrice.storeId:typeof inputPrice.storeId==='string'&&/^\d{1,30}$/.test(inputPrice.storeId)?inputPrice.storeId:null,
    price:positive(inputPrice.price)&&inputPrice.price<=1e9?inputPrice.price:null,rawUnitPrice:typeof inputPrice.rawUnitPrice==='number'&&Number.isFinite(inputPrice.rawUnitPrice)?inputPrice.rawUnitPrice:null,
    source:priceSource,observedAt,isPromo:inputPrice.isPromo===true,promotion,sourceUrl:product.sourceUrl,reason:safeText(inputPrice.reason,300)??'unproven-price-candidate'};
   const source={...product,store},fingerprint=sesumSourceFingerprint(source);
   rows.push({sourceKey:`sesum:${store}:${id}`,source,fingerprint,fetchedAt,receipt:{price:null,observedAt,source:priceSource,sourceStoreCode,isPromo:candidate.isPromo,promotion,candidate,...(product.soldByWeight===true?{variableWeight:true,unitPriceBasis:null,unitPriceBasisFingerprint:null,unitPriceBasisError:'unproven-own-unit-price-basis'}:{}),
    reasons:['unproven-price-candidate','unknown-gross-package-price',...(product.soldByWeight===true?['unproven-own-unit-price-basis']:[]),...(observedAt?[]:['missing-price-receipt']),...(priceSource?[]:['missing-price-source']),...(candidate.isPromo?['unverified-promotion-conditions']:[])]}});
  }
 }
 return rows;
}
function newerReceipt(previous,incoming){
 if(!previous)return incoming;
 const oldTime=Date.parse(previous.observedAt),newTime=Date.parse(incoming.observedAt);
 if((previous.variableWeight||incoming.variableWeight)&&Number.isFinite(oldTime)&&Number.isFinite(newTime)&&newTime<oldTime)return previous;
 if(incoming.variableWeight&&incoming.reasons.includes('unproven-price-candidate')&&Number.isFinite(newTime)&&(!Number.isFinite(oldTime)||newTime>=oldTime))return incoming;
 if(incoming.reasons.includes('unproven-price-candidate')&&previous.observedAt&&previous.source&&!previous.reasons.includes('unproven-price-candidate')){
  // Keep a real receipt (and its original age) when the same page also contains
  // an unproven alternative. The alternative remains available for research.
  return {...previous,candidate:incoming.candidate,candidateReasons:[...incoming.reasons]};
 }
 if(previous.reasons.includes('unproven-price-candidate')&&incoming.observedAt&&incoming.source&&!incoming.reasons.includes('unproven-price-candidate'))return {...incoming,candidate:previous.candidate,candidateReasons:[...previous.reasons]};
 if(!Number.isFinite(newTime))return incoming;
 if(Number.isFinite(oldTime)&&newTime<oldTime)return previous;
 if(Number.isFinite(oldTime)&&newTime===oldTime){
  const variable=previous.variableWeight||incoming.variableWeight;
  const signature=p=>JSON.stringify([p.price,p.isPromo,p.promotion,...(variable?[p.source??null,alias(p.sourceStoreCode)??null]:[])]);
  if(previous.reasons.includes('conflicting-latest-prices')||signature(previous)!==signature(incoming))return {...incoming,price:null,reasons:[...new Set([...previous.reasons,...incoming.reasons,'conflicting-latest-prices'])]};
  if(previous.unitPriceBasis&&incoming.unitPriceBasis&&(previous.unitPriceBasis.unit!==incoming.unitPriceBasis.unit||previous.unitPriceBasis.amount!==incoming.unitPriceBasis.amount))return {...incoming,price:null,reasons:[...new Set([...previous.reasons,...incoming.reasons,'conflicting-latest-prices'])]};
 }
 return incoming;
}
// Legacy receipts did not have variableWeight. A prior comparison between
// signatures of different lengths could therefore hold a pure label amendment.
// Recover only an exact, fully evidenced ordinary tuple; never erase raw history.
function effectiveReceipt(row){
 const raw=row.receipt,basis=raw.unitPriceBasis,at=Date.parse(raw.observedAt);
 if(raw.price!==null||raw.variableWeight!==true||!basis||raw.isPromo===true||raw.promotion!=null||raw.reasons.length!==1||raw.reasons[0]!=='conflicting-latest-prices'||!Number.isFinite(at)||Date.parse(basis.observedAt)!==at||alias(raw.sourceStoreCode)!==row.source.store)return raw;
 const checked=sanitizeUnitPriceBasis(basis,{productId:row.source.id,sourceUrl:row.source.sourceUrl,storeCode:row.source.store,storeId:raw.storeId,price:basis.amount,source:raw.source,observedAt:basis.observedAt});
 if(!checked.basis)return raw;
 const terms=p=>JSON.stringify([p.isPromo===true,p.promotion??null,p.source??null,alias(p.sourceStoreCode)??null]);
 const events=row.receiptHistory??[],legacy=e=>{
  const p=e.receipt;return e.sourceFingerprint===row.fingerprint&&Date.parse(p.observedAt)===at&&p.variableWeight!==true&&!p.unitPriceBasis&&p.price===basis.amount&&!p.reasons.length&&terms(p)===terms(raw)&&!p.candidate;
 },first=events.findIndex(legacy);
 if(first<0)return raw;
 for(let i=0;i<events.length;i++){
  const p=events[i].receipt,date=Date.parse(p.observedAt);if(i<first&&date<at)continue;
  if(events[i].sourceFingerprint!==row.fingerprint||date!==at||terms(p)!==terms(raw)||p.candidate||p.storeId!=null&&String(p.storeId)!==String(raw.storeId))return raw;
  const proof=p.unitPriceBasis;
  if(proof&&(proof.amount!==basis.amount||proof.unit!==basis.unit||Date.parse(proof.observedAt)!==date||!sanitizeUnitPriceBasis(proof,{productId:row.source.id,sourceUrl:row.source.sourceUrl,storeCode:row.source.store,storeId:p.storeId,price:proof.amount,source:p.source,observedAt:proof.observedAt}).basis))return raw;
  if(p.price===basis.amount&&!p.reasons.length){if(p.variableWeight===true&&!proof)return raw;continue;}
  if(p.price!==null||!proof||p.reasons.length!==1||p.reasons[0]!=='conflicting-latest-prices')return raw;
 }
 return {...raw,price:basis.amount,reasons:[],unitPriceBasisAmendment:{kind:'legacy-own-row-label-v1',sourceFingerprint:row.fingerprint,observedAt:raw.observedAt,rawReasons:[...raw.reasons]}};
}
const currentGroups=(reader,key)=>(reader?.groupsOf(key)??[]).filter(row=>row.s==='approved'&&row.r&&reader.group(row.groupId));
const donorAllowed=(row,key,donor)=>!key.startsWith('sesum:')||key===row.sourceKey&&donor?.source==='sesum'&&donor.nativeDiscovery===true&&donor.sourceFingerprint===row.fingerprint&&!donor.donorProductKey;
function quoteOf(row,bridge){
 const receipt=effectiveReceipt(row),reasons=receiptReasons(receipt);
 if(bridge.priceBasis==='direct-unit'){
  const basis=receipt.unitPriceBasis,verified=!!basis&&basis.unit===bridge.unit&&positive(receipt.price)&&bridge.priceIncludesVat===true;
  if(!basis)reasons.push(receipt.unitPriceBasisError??'missing-own-unit-price-basis');
  else if(basis.unit!==bridge.unit)reasons.push('direct-unit-review-mismatch');
  return {grossPackPrice:null,grossUnitPrice:verified?basis.amount:null,unit:bridge.unit,directUnitVerified:verified,priceBasis:'direct-unit',unitPriceEvidence:verified?`${bridge.unitPriceEvidence} ${basis.label}; ${basis.rowControl}; ${bridge.vatEvidence}`:null,unitPriceBasisFingerprint:receipt.unitPriceBasisFingerprint??null,priceIncludesVat:bridge.priceIncludesVat===true,receiptAt:receipt.observedAt,reasons:[...new Set(reasons)],sourceUrl:row.source.sourceUrl,availabilityScope:'chain',priceSource:'sesum',sourceProductKey:row.sourceKey,isPromo:receipt.isPromo,promotion:receipt.promotion};
 }
 if(!positive(bridge.packAmount))reasons.push('unknown-canonical-pack-amount');
 return {grossPackPrice:receipt.price,grossUnitPrice:null,unit:bridge.unit,directUnitVerified:false,receiptAt:receipt.observedAt,reasons,sourceUrl:row.source.sourceUrl,availabilityScope:'chain',priceIncludesVat:true,priceSource:'sesum',sourceProductKey:row.sourceKey};
}
const quoteSignature=q=>{const direct=q.directUnitVerified||q.grossUnitPrice!=null||q.priceBasis==='direct-unit';return JSON.stringify([q.grossPackPrice??null,q.grossUnitPrice??null,direct?q.unit??null:null,...(direct?[q.isPromo===true,q.promotion??null]:[])]);};
const normalizedQuote=(quote,pack,unit)=>!quote||quote.reasons.length?null:positive(quote.grossPackPrice)&&positive(pack)?quote.grossPackPrice/pack:quote.directUnitVerified&&quote.unit===unit&&positive(quote.grossUnitPrice)?quote.grossUnitPrice:null;
function chooseQuote(previous,incoming){
 if(!previous)return incoming;
 const a=Date.parse(previous?.receiptAt),b=Date.parse(incoming?.receiptAt);
 const unproven=quote=>quote.reasons.some(reason=>['unproven-price-candidate','missing-price-source','missing-price-receipt'].includes(reason));
 if(previous.priceBasis==='direct-unit'&&Number.isFinite(a)&&Number.isFinite(b)&&b<a)return previous;
 if(incoming.priceBasis==='direct-unit'&&Number.isFinite(b)&&(!Number.isFinite(a)||b>a))return incoming;
 if(unproven(incoming)&&Number.isFinite(a)&&!unproven(previous))return previous;
 if(unproven(previous)&&Number.isFinite(b)&&!unproven(incoming))return incoming;
 if(!Number.isFinite(b)||Number.isFinite(a)&&b<a)return previous;
 if(Number.isFinite(a)&&a===b&&quoteSignature(previous)!==quoteSignature(incoming))return {...incoming,grossPackPrice:null,grossUnitPrice:null,directUnitVerified:false,reasons:[...new Set([...(previous.reasons??[]),...incoming.reasons,'conflicting-latest-prices'])]};
 if(Number.isFinite(a)&&a===b)return {...incoming,reasons:[...new Set([...previous.reasons,...incoming.reasons])]};
 return incoming;
}

/** Explicit reviewed bridges from Sesum public prices to compact library SKUs.
 * Source text is data. Nothing here approves a family watch or changes a cart.
 */
export function createSesumPrices(state,{save=()=>{},now=()=>new Date(),reader=()=>null,nativeEntries=()=>[],sourceCurrent=()=>true}={}){
 if(!plain(state))throw Error('Sesum price state must be a plain map.');
 state.version??=1;if(state.version!==1)throw Error('Unsupported Sesum price state.');
 state.products??={};state.bridges??={};state.revision??=0;
 if(!plain(state.products)||!plain(state.bridges))throw Error('Invalid Sesum price maps.');
 const clock=()=>{const date=new Date(typeof now==='function'?now():now);if(!Number.isFinite(date.getTime()))throw Error('Invalid Sesum price clock.');return date;};
 const rawReader=()=>typeof reader==='function'?reader():reader;
 const compatibleNative=(entry,donor)=>entry.status==='approved'&&entry.unit===donor.unit&&near(entry.packAmount,donor.pack)&&donor.textHash===productTextHash(entry)&&(!donor.rawPack||donor.rawPack.weight===entry.weight&&normalize(donor.rawPack.weightUnit)===normalize(entry.weightUnit));
 function nativeQuote(entry){
  // An undated observation cannot establish precedence over a dated receipt.
  let receiptAt;try{receiptAt=time(entry.lastChecked,'actual native price receipt');}catch{return null;}
  if(Date.parse(receiptAt)>clock().getTime())return null;
  const price=positive(entry.currentPrice)?entry.currentPrice:null;
  return {grossPackPrice:price,grossUnitPrice:null,unit:entry.unit,directUnitVerified:false,receiptAt,
   reasons:price===null?['unknown-gross-package-price']:[],sourceUrl:entry.sourceUrl??null,
   availabilityScope:'chain',priceIncludesVat:true,priceSource:'native-catalog'};
 }
 let donorIndex=null,donorEans=new Map(),donorNames=new Map(),overlayIndex=null,overlayRevision=null,overlayValidation=null,overlayFactory=null;
 const baseIndexIds=new WeakMap();let nextBaseIndexId=0;
 function versioned(read,index,validation){
  let id=baseIndexIds.get(index);if(id===undefined){id=++nextBaseIndexId;baseIndexIds.set(index,id);}
  // A semantic read-model revision is separate from source/receipt timestamps.
  // The empty overlay also has a revision, so withdrawing a bridge invalidates
  // consumers that cached an earlier overlay over this same base library.
  return {...read,cacheKey:[read.cacheKey??'','sesum',id,state.revision,validation].join('|')};
 }
 function findDonors(base,source){
  const index=base?.index();if(!index)return [];
  if(donorIndex!==index){
   donorIndex=index;donorEans=new Map();donorNames=new Map();
   const add=(map,key,value)=>{if(!key)return;const keys=map.get(key)??[];keys.push(value);map.set(key,keys);};
   for(const [key,p] of Object.entries(index.products))if(!key.startsWith('sesum:')){add(donorEans,String(p.ean??''),key);add(donorNames,lower(p.name),key);}
  }
  const sourceKey=`sesum:${source.store}:${source.id}`,self=base.product(sourceKey);
  return [...new Set([...(donorAllowed({sourceKey,fingerprint:sesumSourceFingerprint(source)},sourceKey,self)?[sourceKey]:[]),...source.ean.flatMap(ean=>donorEans.get(ean)??[]),...(donorNames.get(lower(source.name))??[])])];
 }
 const sourceRow=key=>stable(key)&&Object.hasOwn(state.products,key)?state.products[key]:null;
 function validBridge(row,bridge,base){
  if(!row||!sourceCurrent(row.source)||!bridge||bridge.status!=='approved'||bridge.sourceFingerprint!==row.fingerprint)return false;
  const donor=base?.product(bridge.productKey);
  const identity=!!donor&&donorAllowed(row,bridge.productKey,donor)&&sesumDonorFingerprint(donor)===bridge.productFingerprint&&currentGroups(base,bridge.productKey).length>0&&donor.unit===bridge.unit&&boundNativeIdentity(donor,base,row.source.store)!==false;
  if(!identity)return false;
  if(bridge.priceBasis==='direct-unit')return row.source.soldByWeight===true&&bridge.packAmount===null&&donor.pack===null&&!donor.nativeIdentity&&['kg','l'].includes(bridge.unit)&&bridge.priceIncludesVat===true&&!!bridge.vatEvidence&&!!bridge.variableWeightEvidence&&!!bridge.unitPriceEvidence&&(donor.variableWeightReviewed===true||bridge.variableDonorVerified===true)&&Array.isArray(bridge.reviewedGroups)&&bridge.reviewedGroups.length>0&&bridge.reviewedGroups.every(g=>base.group(g.groupId)?.fingerprint===g.groupFingerprint&&currentGroups(base,bridge.productKey).some(m=>m.groupId===g.groupId));
  return donor.packKnown&&near(donor.pack,bridge.packAmount);
 }
 function ingest(input){
  if(!plain(input)||!Array.isArray(input.familyIds)||input.familyIds.length>10000||input.familyIds.some(id=>!stable(id)))throw Error('Invalid Sesum family IDs.');
  const at=clock().getTime(),fetchedAt=time(input.fetchedAt,'Sesum fetch time');if(Date.parse(fetchedAt)>at+60000)throw Error('Sesum fetch time cannot be in the future.');
  const rows=normalizedRows(input.products,fetchedAt,at),staged=new Map();
  for(const item of rows){
   const previous=staged.get(item.sourceKey)??sourceRow(item.sourceKey),changed=previous&&previous.fingerprint!==item.fingerprint;
   if(previous&&Date.parse(item.fetchedAt)<Date.parse(previous.fetchedAt)){
    // A replay can discover another family without being a newer source read.
    // Keep the latest complete source evidence, including changed metadata and
    // unknown/conflicting prices; only append the newly discovered hints.
    const familyIds=[...new Set([...previous.familyIds,...input.familyIds])];
    if(familyIds.length!==previous.familyIds.length)staged.set(item.sourceKey,{...previous,familyIds});
    continue;
   }
   const receipt=changed?item.receipt:newerReceipt(previous?effectiveReceipt(previous):null,item.receipt),receiptHistory=[...(previous?.receiptHistory??[])];
   if(previous&&hash(previous.receipt)!==hash(receipt))receiptHistory.push({fetchedAt:previous.fetchedAt,sourceFingerprint:previous.fingerprint,receipt:clone(previous.receipt)});
   staged.set(item.sourceKey,{...item,familyIds:[...new Set([...(previous?.familyIds??[]),...input.familyIds])],firstSeen:previous?.firstSeen??fetchedAt,receipt,...(receiptHistory.length?{receiptHistory}:{} )});
  }
  if(staged.size){for(const [key,row] of staged)state.products[key]=row;state.revision++;save();}
  return {observed:staged.size,reviewed:[...staged.values()].filter(row=>validBridge(row,state.bridges[row.sourceKey],rawReader())).length,pending:[...staged.values()].filter(row=>!validBridge(row,state.bridges[row.sourceKey],rawReader())).length};
 }
 function candidates(familyId=null){
  if(familyId!==null&&!stable(familyId))throw Error('Invalid Sesum family ID.');
  const base=rawReader(),products=base?.index().products??{};
  return Object.values(state.products).filter(row=>familyId===null||row.familyIds.includes(familyId)).map(row=>{
   const source=row.source,sourcePack=packOf(source),donors=[];
   for(const productKey of findDonors(base,source)){
    const p=products[productKey];
    if(!donorAllowed(row,productKey,p)||!currentGroups(base,productKey).length)continue;
    const ean=!!p.ean&&source.ean.includes(String(p.ean)),name=lower(source.name)===lower(p.name),brand=!!source.brand&&lower(source.brand)===lower(p.brand),pack=!!sourcePack&&sourcePack.unit===p.unit&&near(sourcePack.amount,p.pack);
    if(productKey!==row.sourceKey&&!ean&&!name)continue;
    donors.push({productKey,productFingerprint:sesumDonorFingerprint(p),product:clone(p),groups:currentGroups(base,productKey).map(m=>({groupId:m.groupId,groupFingerprint:base.group(m.groupId).fingerprint})),match:{ean,name,brand,pack}});
   }
   donors.sort((a,b)=>(Number(b.match.ean)+Number(b.match.name)+Number(b.match.brand)+Number(b.match.pack))-(Number(a.match.ean)+Number(a.match.name)+Number(a.match.brand)+Number(a.match.pack))||a.productKey.localeCompare(b.productKey));
   const bridge=state.bridges[row.sourceKey]??null,current=validBridge(row,bridge,base);
   return {sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,sourceMetadataCurrent:sourceCurrent(row.source),source:clone(source),price:{...clone(effectiveReceipt(row)),reasons:receiptReasons(effectiveReceipt(row))},basisReviewNeeded:current&&bridge.priceBasis==='direct-unit'&&!!row.receipt.unitPriceBasis&&row.receipt.unitPriceBasis.unit!==bridge.unit,familyIds:[...row.familyIds],status:current?'approved':bridge?.status==='excluded'&&bridge.sourceFingerprint===row.fingerprint?'excluded':'pending',bridge:bridge?clone(bridge):null,donors};
  });
 }
 function review(input){
  if(!plain(input)||!['approved','excluded'].includes(input.status))throw Error('Invalid Sesum bridge decision.');
  const row=sourceRow(input.sourceKey);if(!row||!sourceCurrent(row.source)||input.sourceFingerprint!==row.fingerprint)throw Error('Sesum source metadata changed; review its current fingerprint.');
  const equivalenceEvidence=text(input.equivalenceEvidence,'equivalence evidence',6000,{required:true}),packEvidence=text(input.packEvidence,'package evidence',6000,{required:input.status==='approved'}),base=rawReader();
  const next={sourceKey:input.sourceKey,sourceFingerprint:row.fingerprint,status:input.status,productKey:input.productKey??null,productFingerprint:input.productFingerprint??null,packAmount:null,unit:null,equivalenceEvidence,packEvidence,reviewedAt:clock().toISOString()};
  if(input.status==='approved'){
   const donor=stable(input.productKey)?base?.product(input.productKey):null;
   if(!donor||!donorAllowed(row,input.productKey,donor)||sesumDonorFingerprint(donor)!==input.productFingerprint)throw Error('Donor metadata changed; review its current fingerprint.');
   if(boundNativeIdentity(donor,base,row.source.store)===false)throw Error('Native identity metadata changed; review its current fingerprint.');
   if(!currentGroups(base,input.productKey).length)throw Error('A donor needs a current reviewed product family.');
   if(input.priceBasis==='direct-unit'){
    if(row.source.soldByWeight!==true||input.packAmount!==null||input.canonicalPackAmount!=null||!['kg','l'].includes(input.unit)||donor.pack!==null||donor.unit!==input.unit||donor.nativeIdentity||input.fixedPackVerified!=null||input.packBasis!=null||input.nativeProductKey!=null)throw Error('Direct unit review requires a genuinely variable source and donor, null package and matching kg/l; fixed/native package overrides are forbidden.');
    const receipts=(value,label)=>{
     if(!Array.isArray(value)||!value.length||value.length>40)throw Error(`${label} actual primary receipts are required.`);
     return value.map(r=>{if(!plain(r))throw Error(`Invalid ${label} receipt.`);const u=new URL(r.url),at=time(r.observedAt,'actual primary review receipt');if(u.protocol!=='https:'||u.username||u.password||u.href.length>4096||Date.parse(at)>clock().getTime())throw Error(`Invalid ${label} primary receipt.`);return {url:u.href,observedAt:at,evidence:text(r.evidence,label+' evidence',6000,{required:true})};});
    };
    next.priceBasis='direct-unit';next.unit=input.unit;next.packAmount=null;
    next.variableWeightEvidence=text(input.variableWeightEvidence,'actual variable form evidence',6000,{required:true});next.unitPriceEvidence=text(input.unitPriceEvidence,'unit-price evidence',6000,{required:true});next.vatEvidence=text(input.vatEvidence,'gross consumer VAT evidence',6000,{required:true});
    if([next.variableWeightEvidence,next.unitPriceEvidence,next.vatEvidence].some(v=>v.length<10))throw Error('Concrete actual variable, unit-price and VAT evidence is required.');
    if(input.priceIncludesVat!==true)throw Error('Direct unit prices require explicitly reviewed gross consumer VAT.');next.priceIncludesVat=true;next.sourceReceipts=receipts(input.sourceReceipts,'source');
    if(donor.variableWeightReviewed!==true){
     if(input.variableDonorVerified!==true)throw Error('A null unknown package is not evidence of an actually variable donor.');
     next.variableDonorVerified=true;next.donorVariableWeightEvidence=text(input.donorVariableWeightEvidence,'actual donor variable form evidence',6000,{required:true});next.donorSourceReceipts=receipts(input.donorSourceReceipts,'donor');
     if(next.donorVariableWeightEvidence.length<10||!next.donorSourceReceipts.some(r=>!/(^|\.)sesum\.no$/i.test(new URL(r.url).hostname.replace(/\.$/,''))))throw Error('The donor variable form needs separate actual primary evidence, not the Sesum row label alone.');
    }
    const groups=input.reviewedGroups??input.memberships;
    if(!Array.isArray(groups)||!groups.length||groups.length>50||new Set(groups.map(g=>g?.groupId)).size!==groups.length)throw Error('Direct unit review requires explicit current group fingerprints.');
    next.reviewedGroups=groups.map(g=>{if(!stable(g?.groupId)||base.group(g.groupId)?.fingerprint!==g.groupFingerprint||base.group(g.groupId)?.unit!==input.unit||!currentGroups(base,input.productKey).some(m=>m.groupId===g.groupId))throw Error('Direct unit product group changed; review current group rules and unit.');return {groupId:g.groupId,groupFingerprint:g.groupFingerprint};});
   }else{
   if(input.priceBasis!=null&&input.priceBasis!=='package')throw Error('Unknown Sesum price basis.');
   if(!positive(input.packAmount)||!['kg','l','stk','m'].includes(input.unit)||!donor.packKnown||!near(donor.pack,input.packAmount)||donor.unit!==input.unit)throw Error('The bridge requires the donor\'s current documented canonical package.');
   if(row.source.soldByWeight)throw Error('Variable-weight Sesum products need a separate verified unit-price contract.');
   if(row.source.soldByWeight===null&&input.fixedPackVerified!==true)throw Error('Unknown Sesum weight mode needs explicit fixedPackVerified and package evidence.');
   const sourcePack=packOf({...row.source,soldByWeight:false});
   if(input.packBasis!=null&&!['net','drained'].includes(input.packBasis))throw Error('Unsupported Sesum package basis.');
   if(input.packBasis==='drained'){
    if(sourcePack?.unit!=='kg'||input.unit!=='kg'||input.packAmount>sourcePack.amount&&!near(input.packAmount,sourcePack.amount))throw Error('A drained package needs known gross kg at least as large as the reviewed drained kg.');
    next.packBasis='drained';next.packBasisEvidence=text(input.packBasisEvidence,'drained package evidence',6000,{required:true});
   }else{
    if(sourcePack&&(sourcePack.unit!==input.unit||!near(sourcePack.amount,input.packAmount)))throw Error('Sesum and donor package amounts disagree.');
    if(input.packBasis==='net')next.packBasis='net';
   }
   next.packAmount=input.packAmount;next.unit=input.unit;
   next.fixedPackVerified=row.source.soldByWeight===false||input.fixedPackVerified===true;
   }
  }
  state.bridges[input.sourceKey]=next;state.revision++;save();return clone(next);
 }
 function overlay(base=rawReader()){
  if(!base)return null;
  const active=Object.values(state.bridges).filter(bridge=>validBridge(sourceRow(bridge.sourceKey),bridge,base)),index=base.index();
  if(!active.length)return versioned(base,index,'none');
  const entries=typeof nativeEntries==='function'?nativeEntries():nativeEntries;
  if(!Array.isArray(entries))throw Error('Native price entries must be an array.');
  const nativeByProduct=new Map();
  for(const entry of entries){const key=`kassal:${entry.store}:${entry.id}`,rows=nativeByProduct.get(key)??[];rows.push(entry);nativeByProduct.set(key,rows);}
  const peers=new Map();
  for(const bridge of active){
   const row=sourceRow(bridge.sourceKey),donor=base.product(bridge.productKey),identity=boundNativeIdentity(donor,base,row.source.store),anchorKey=identity?.key??bridge.productKey,anchor=identity?.product??donor,key=anchorKey+'|'+row.source.store;
   let group=peers.get(key);
   if(!group){
    const quotes=anchor.store===row.source.store?(nativeByProduct.get(anchorKey)??[]).filter(entry=>compatibleNative(entry,anchor)).map(nativeQuote).filter(Boolean):[];
    let selected=anchor.store===row.source.store?bridge.priceBasis==='direct-unit'?{...anchor.quote,priceBasis:'direct-unit'}:anchor.quote:null;
    for(const quote of quotes)selected=chooseQuote(selected,quote);
    group={donor:anchor,productKey:anchorKey,store:row.source.store,selected,nativeQuotes:quotes,explicitNativeIdentity:!!identity};peers.set(key,group);
   }
   if(identity)group.explicitNativeIdentity=true;
   group.selected=chooseQuote(group.selected,quoteOf(row,bridge));
  }
  const validation=hash([...peers.values()].map(group=>[group.productKey,group.store,sesumDonorFingerprint(group.donor),group.donor.quote,group.nativeQuotes,group.donor.available,currentGroups(base,group.productKey).map(m=>[m.groupId,base.group(m.groupId).fingerprint,m.q,m.n])]));
  if(overlayIndex===index&&overlayRevision===state.revision&&overlayValidation===validation&&overlayFactory)return versioned(overlayFactory(clock().getTime()),index,validation);
  const out={...index,products:{...index.products},members:Object.fromEntries(Object.entries(index.members).map(([key,rows])=>[key,[...rows]]))};
  for(const bridge of active){
   const row=sourceRow(bridge.sourceKey);
   const donor=base.product(bridge.productKey),identity=boundNativeIdentity(donor,base,row.source.store),group=peers.get((identity?.key??bridge.productKey)+'|'+row.source.store),original=quoteOf(row,bridge),selected=group.selected;
   let quote=identity?selected:original;
   const ownTime=Date.parse(original.receiptAt),selectedTime=Date.parse(selected?.receiptAt);
   if(!identity&&Number.isFinite(ownTime)&&Number.isFinite(selectedTime)){
    if(ownTime<selectedTime)quote={...original,reasons:[...new Set([...original.reasons,'superseded-price-receipt'])]};
    else if(ownTime===selectedTime&&(selected.reasons.includes('conflicting-latest-prices')||quoteSignature(selected)!==quoteSignature(original)))quote={...original,grossPackPrice:null,grossUnitPrice:null,directUnitVerified:false,reasons:[...new Set([...original.reasons,...selected.reasons,'conflicting-latest-prices'])]};
    else if(ownTime===selectedTime)quote={...original,reasons:[...new Set([...original.reasons,...selected.reasons])]};
   }
   const product={...donor,store:row.source.store,id:row.source.id,source:'sesum',productKey:row.sourceKey,sourceUrl:row.source.sourceUrl,ean:row.source.ean[0]??donor.ean??null,available:group.donor.store!==row.source.store||group.donor.available!==false,donorProductKey:bridge.productKey,sourceFingerprint:row.fingerprint,metadataFingerprint:hash([row.fingerprint,bridge.productFingerprint]),quote};
   out.products[row.sourceKey]=product;
   for(const m of currentGroups(base,bridge.productKey)){
    const member={...m,k:row.sourceKey,u:normalizedQuote(quote,bridge.packAmount,bridge.unit)};
    if(out.members[m.groupId].some(existing=>existing.k===row.sourceKey))out.members[m.groupId]=out.members[m.groupId].map(existing=>existing.k===row.sourceKey?member:existing);
    else out.members[m.groupId].push(member);
   }
   if(group.donor.store===row.source.store){
    const previous=out.products[group.productKey];
    if(selected!==previous.quote){
     out.products[group.productKey]={...previous,quote:selected,...(group.explicitNativeIdentity?{sesumIdentityReviewed:true}:{})};
     for(const groupId of Object.keys(out.members))out.members[groupId]=out.members[groupId].map(m=>m.k===group.productKey?{...m,u:normalizedQuote(selected,group.donor.pack,group.donor.unit)}:m);
    }
    else if(group.explicitNativeIdentity)out.products[group.productKey]={...previous,sesumIdentityReviewed:true};
   }
  }
  overlayIndex=index;overlayRevision=state.revision;overlayValidation=validation;overlayFactory=createIndexReader(out,{horizonDays:base.horizonDays});
  return versioned(overlayFactory(clock().getTime()),index,validation);
 }
 function provide(entries,baseResult={status:'disabled',quotes:[]}){
  const over=overlay(),result=new Map((baseResult.quotes??[]).map(q=>[`${q.watchId}|${q.store}|${q.id}`,q]));
  if(!over)return baseResult;
  const base=rawReader(),directDonors=new Set(Object.values(state.bridges).filter(bridge=>bridge.priceBasis==='direct-unit'&&validBridge(sourceRow(bridge.sourceKey),bridge,base)&&base.product(bridge.productKey).store===sourceRow(bridge.sourceKey).source.store).map(bridge=>bridge.productKey));
  for(const entry of entries){
   if(entry.status!=='approved')continue;
   const key=`kassal:${entry.store}:${entry.id}`,q=over.quote(key),p=q?.product;
   if(directDonors.has(key)&&p?.pack===null&&!variableNative(entry)){
    const old=result.get(`${entry.watchId}|${entry.store}|${entry.id}`);if(old?.directUnitVerified&&old.canonicalPackAmount===null)result.delete(`${entry.watchId}|${entry.store}|${entry.id}`);
    continue; // A documented fixed native package outranks this variable source relation.
   }
   const direct=q?.price.directUnitVerified&&p?.pack===null&&q.price.unit===entry.unit&&variableNative(entry);
   if(!(q?.reviewCurrent||p?.sesumIdentityReviewed===true)||!['sesum','native-catalog'].includes(q.price.priceSource)||p.unit!==entry.unit||!direct&&!near(p.pack,entry.packAmount)||p.textHash!==productTextHash(entry))continue;
   if(p.rawPack&&(p.rawPack.weight!==entry.weight||normalize(p.rawPack.weightUnit)!==normalize(entry.weightUnit)))continue;
   result.set(`${entry.watchId}|${entry.store}|${entry.id}`,{watchId:entry.watchId,store:entry.store,id:entry.id,canonicalPackAmount:p.pack,...q.price});
  }
  return {status:baseResult.status==='disabled'?'ready':baseResult.status,quotes:[...result.values()]};
 }
 function pending(){
  const base=rawReader(),at=clock().getTime(),horizon=base?.horizonDays??183;
  return Object.values(state.products).filter(row=>sourceCurrent(row.source)).filter(row=>(!validBridge(row,state.bridges[row.sourceKey],base)||state.bridges[row.sourceKey]?.priceBasis==='direct-unit'&&row.receipt.unitPriceBasis&&row.receipt.unitPriceBasis.unit!==state.bridges[row.sourceKey].unit)&&!(state.bridges[row.sourceKey]?.status==='excluded'&&state.bridges[row.sourceKey].sourceFingerprint===row.fingerprint)&&(!row.receipt.observedAt||at-Date.parse(row.receipt.observedAt)<=horizon*86400000)).map(row=>({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,name:row.source.name,familyIds:[...row.familyIds],receiptAt:row.receipt.observedAt,basisReviewNeeded:!!(validBridge(row,state.bridges[row.sourceKey],base)&&state.bridges[row.sourceKey].priceBasis==='direct-unit'&&row.receipt.unitPriceBasis&&row.receipt.unitPriceBasis.unit!==state.bridges[row.sourceKey].unit),hasReviewedDonor:findDonors(base,row.source).some(key=>donorAllowed(row,key,base?.product(key))&&currentGroups(base,key).length>0)}));
 }
 function sourceRecord(key){const row=sourceRow(key);return row?clone({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,source:row.source,price:row.receipt,familyIds:row.familyIds}):null;}
 function sourceSummaries(){return Object.values(state.products).map(row=>({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,name:row.source.name,store:row.source.store,familyIds:[...row.familyIds],receiptAt:row.receipt.observedAt}));}
 function identityReference(key){const bridge=state.bridges[key];return bridge?.status==='approved'?{productKey:bridge.productKey}:null;}
 function approvedSource(key,base=rawReader()){const row=sourceRow(key),bridge=state.bridges[key];return validBridge(row,bridge,base)?clone({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,source:row.source,receipt:row.receipt,familyIds:row.familyIds,packAmount:bridge.packAmount,unit:bridge.unit,productKey:bridge.productKey,productFingerprint:bridge.productFingerprint}):null;}
 function approvedSources(){const base=rawReader();return Object.keys(state.products).map(key=>approvedSource(key,base)).filter(Boolean);}
 return {ingest,candidates,review,overlay,provide,pending,work:pending,sourceRecord,sourceSummaries,identityReference,approvedSource,approvedSources,revision:()=>state.revision,status:()=>({products:Object.keys(state.products).length,bridges:Object.keys(state.bridges).length,revision:state.revision})};
}
