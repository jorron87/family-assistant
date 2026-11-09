import {createHash} from 'node:crypto';
import {createIndexReader} from './shopping-library.mjs';
import {productTextHash} from './product-library.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const stable=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,250}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value??null;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone=value=>structuredClone(value);
const near=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const normalize=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim();
const lower=value=>normalize(value).toLocaleLowerCase('nb');
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
 return hash(Object.fromEntries(['id','store','name','brand','vendor','ean','weight','weightUnit','soldByWeight','sourceUrl'].map(key=>[key,source[key]??null])));
}
export function sesumDonorFingerprint(product){
 if(typeof product?.metadataFingerprint==='string'&&/^[a-f0-9]{64}$/.test(product.metadataFingerprint))return product.metadataFingerprint;
 return hash(Object.fromEntries(['store','id','name','ean','brand','ingredients','description','textHash','pack','packKnown','unit','packEvidence','rawPack','sourceUrl','attributes','nutrition'].map(key=>[key,product?.[key]??null])));
}
function normalizedRows(products,fetchedAt,at){
 if(!Array.isArray(products)||products.length>500)throw Error('Observe at most 500 Sesum products.');
 const rows=[];
 for(const input of products){
  if(!plain(input)||!/^([1-9]\d*)$/.test(String(input.id))||!Number.isSafeInteger(Number(input.id)))throw Error('Invalid Sesum source product.');
  const id=String(input.id),weight=input.weight??null;
  if(weight!==null&&(!positive(weight)||weight>1e9))throw Error('Invalid Sesum product weight.');
  if(input.soldByWeight!=null&&typeof input.soldByWeight!=='boolean')throw Error('Invalid Sesum weight mode.');
  const product={id,name:text(input.name,'Sesum product name',1000,{required:true}),brand:text(input.brand,'brand',300),vendor:text(input.vendor,'vendor',300),ean:eans(input.ean),weight,weightUnit:text(input.weightUnit,'weight unit',30),soldByWeight:input.soldByWeight??null,sourceUrl:productUrl(input.sourceUrl,id)};
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
   rows.push({sourceKey:`sesum:${store}:${id}`,source,fingerprint,fetchedAt,receipt:{price,observedAt,source:priceSource,sourceStoreCode:text(inputPrice.sourceStoreCode??inputPrice.storeCode,'source chain',100),isPromo:inputPrice.isPromo===true,promotion:promo(inputPrice.promotion),reasons:[...(observedAt?[]:['missing-price-receipt']),...(priceSource?[]:['missing-price-source']),...(price!==null?[]:['unknown-gross-package-price']),...(inputPrice.isPromo===true?['unverified-promotion-conditions']:[])]}});
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
   rows.push({sourceKey:`sesum:${store}:${id}`,source,fingerprint,fetchedAt,receipt:{price:null,observedAt,source:priceSource,sourceStoreCode,isPromo:candidate.isPromo,promotion,candidate,
    reasons:['unproven-price-candidate','unknown-gross-package-price',...(observedAt?[]:['missing-price-receipt']),...(priceSource?[]:['missing-price-source']),...(candidate.isPromo?['unverified-promotion-conditions']:[])]}});
  }
 }
 return rows;
}
function newerReceipt(previous,incoming){
 if(!previous)return incoming;
 if(incoming.reasons.includes('unproven-price-candidate')&&previous.observedAt&&previous.source&&!previous.reasons.includes('unproven-price-candidate')){
  // Keep a real receipt (and its original age) when the same page also contains
  // an unproven alternative. The alternative remains available for research.
  return {...previous,candidate:incoming.candidate,candidateReasons:[...incoming.reasons]};
 }
 if(previous.reasons.includes('unproven-price-candidate')&&incoming.observedAt&&incoming.source&&!incoming.reasons.includes('unproven-price-candidate'))return {...incoming,candidate:previous.candidate,candidateReasons:[...previous.reasons]};
 const oldTime=Date.parse(previous.observedAt),newTime=Date.parse(incoming.observedAt);
 if(!Number.isFinite(newTime))return incoming;
 if(Number.isFinite(oldTime)&&newTime<oldTime)return previous;
 if(Number.isFinite(oldTime)&&newTime===oldTime){
  const signature=p=>JSON.stringify([p.price,p.isPromo,p.promotion]);
  if(previous.reasons.includes('conflicting-latest-prices')||signature(previous)!==signature(incoming))return {...incoming,price:null,reasons:[...new Set([...previous.reasons,...incoming.reasons,'conflicting-latest-prices'])]};
 }
 return incoming;
}
const currentGroups=(reader,key)=>(reader?.groupsOf(key)??[]).filter(row=>row.s==='approved'&&row.r&&reader.group(row.groupId));
const donorAllowed=(row,key,donor)=>!key.startsWith('sesum:')||key===row.sourceKey&&donor?.source==='sesum'&&donor.nativeDiscovery===true&&donor.sourceFingerprint===row.fingerprint&&!donor.donorProductKey;
function quoteOf(row,bridge){
 const receipt=row.receipt,reasons=[...receipt.reasons];
 if(!positive(bridge.packAmount))reasons.push('unknown-canonical-pack-amount');
 return {grossPackPrice:receipt.price,grossUnitPrice:null,unit:bridge.unit,directUnitVerified:false,receiptAt:receipt.observedAt,reasons,sourceUrl:row.source.sourceUrl,availabilityScope:'chain',priceIncludesVat:true,priceSource:'sesum',sourceProductKey:row.sourceKey};
}
function chooseQuote(previous,incoming){
 if(!previous)return incoming;
 const a=Date.parse(previous?.receiptAt),b=Date.parse(incoming?.receiptAt);
 const unproven=quote=>quote.reasons.some(reason=>['unproven-price-candidate','missing-price-source','missing-price-receipt'].includes(reason));
 if(unproven(incoming)&&Number.isFinite(a)&&!unproven(previous))return previous;
 if(unproven(previous)&&Number.isFinite(b)&&!unproven(incoming))return incoming;
 if(!Number.isFinite(b)||Number.isFinite(a)&&b<a)return previous;
 if(Number.isFinite(a)&&a===b&&previous.grossPackPrice!==incoming.grossPackPrice)return {...incoming,grossPackPrice:null,reasons:[...new Set([...(previous.reasons??[]),...incoming.reasons,'conflicting-latest-prices'])]};
 return incoming;
}

/** Explicit reviewed bridges from Sesum public prices to compact library SKUs.
 * Source text is data. Nothing here approves a family watch or changes a cart.
 */
export function createSesumPrices(state,{save=()=>{},now=()=>new Date(),reader=()=>null,nativeEntries=()=>[]}={}){
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
  if(!row||!bridge||bridge.status!=='approved'||bridge.sourceFingerprint!==row.fingerprint)return false;
  const donor=base?.product(bridge.productKey);
  return !!donor&&donorAllowed(row,bridge.productKey,donor)&&sesumDonorFingerprint(donor)===bridge.productFingerprint&&currentGroups(base,bridge.productKey).length>0&&donor.packKnown&&near(donor.pack,bridge.packAmount)&&donor.unit===bridge.unit;
 }
 function ingest(input){
  if(!plain(input)||!Array.isArray(input.familyIds)||input.familyIds.length>10000||input.familyIds.some(id=>!stable(id)))throw Error('Invalid Sesum family IDs.');
  const at=clock().getTime(),fetchedAt=time(input.fetchedAt,'Sesum fetch time');if(Date.parse(fetchedAt)>at+60000)throw Error('Sesum fetch time cannot be in the future.');
  const rows=normalizedRows(input.products,fetchedAt,at),staged=new Map();
  for(const item of rows){
   const previous=staged.get(item.sourceKey)??sourceRow(item.sourceKey),changed=previous&&previous.fingerprint!==item.fingerprint;
   if(previous&&Date.parse(item.fetchedAt)<Date.parse(previous.fetchedAt))continue;
   staged.set(item.sourceKey,{...item,familyIds:[...new Set([...(previous?.familyIds??[]),...input.familyIds])],firstSeen:previous?.firstSeen??fetchedAt,receipt:changed?item.receipt:newerReceipt(previous?.receipt,item.receipt)});
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
   return {sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,source:clone(source),price:clone(row.receipt),familyIds:[...row.familyIds],status:current?'approved':bridge?.status==='excluded'&&bridge.sourceFingerprint===row.fingerprint?'excluded':'pending',bridge:bridge?clone(bridge):null,donors};
  });
 }
 function review(input){
  if(!plain(input)||!['approved','excluded'].includes(input.status))throw Error('Invalid Sesum bridge decision.');
  const row=sourceRow(input.sourceKey);if(!row||input.sourceFingerprint!==row.fingerprint)throw Error('Sesum source metadata changed; review its current fingerprint.');
  const equivalenceEvidence=text(input.equivalenceEvidence,'equivalence evidence',6000,{required:true}),packEvidence=text(input.packEvidence,'package evidence',6000,{required:input.status==='approved'}),base=rawReader();
  const next={sourceKey:input.sourceKey,sourceFingerprint:row.fingerprint,status:input.status,productKey:input.productKey??null,productFingerprint:input.productFingerprint??null,packAmount:null,unit:null,equivalenceEvidence,packEvidence,reviewedAt:clock().toISOString()};
  if(input.status==='approved'){
   const donor=stable(input.productKey)?base?.product(input.productKey):null;
   if(!donor||!donorAllowed(row,input.productKey,donor)||sesumDonorFingerprint(donor)!==input.productFingerprint)throw Error('Donor metadata changed; review its current fingerprint.');
   if(!currentGroups(base,input.productKey).length)throw Error('A donor needs a current reviewed product family.');
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
   const row=sourceRow(bridge.sourceKey),donor=base.product(bridge.productKey),key=bridge.productKey+'|'+row.source.store;
   let group=peers.get(key);
   if(!group){
    const quotes=donor.store===row.source.store?(nativeByProduct.get(bridge.productKey)??[]).filter(entry=>compatibleNative(entry,donor)).map(nativeQuote).filter(Boolean):[];
    let selected=donor.store===row.source.store?donor.quote:null;
    for(const quote of quotes)selected=chooseQuote(selected,quote);
    group={donor,productKey:bridge.productKey,store:row.source.store,selected,nativeQuotes:quotes};peers.set(key,group);
   }
   group.selected=chooseQuote(group.selected,quoteOf(row,bridge));
  }
  const validation=hash([...peers.values()].map(group=>[group.productKey,group.store,sesumDonorFingerprint(group.donor),group.donor.quote,group.nativeQuotes,group.donor.available,currentGroups(base,group.productKey).map(m=>[m.groupId,base.group(m.groupId).fingerprint,m.q,m.n])]));
  if(overlayIndex===index&&overlayRevision===state.revision&&overlayValidation===validation&&overlayFactory)return versioned(overlayFactory(clock().getTime()),index,validation);
  const out={...index,products:{...index.products},members:Object.fromEntries(Object.entries(index.members).map(([key,rows])=>[key,[...rows]]))};
  for(const bridge of active){
   const row=sourceRow(bridge.sourceKey);
   const group=peers.get(bridge.productKey+'|'+row.source.store),donor=group.donor,original=quoteOf(row,bridge),selected=group.selected;
   let quote=original;
   const ownTime=Date.parse(original.receiptAt),selectedTime=Date.parse(selected?.receiptAt);
   if(Number.isFinite(ownTime)&&Number.isFinite(selectedTime)){
    if(ownTime<selectedTime)quote={...original,reasons:[...new Set([...original.reasons,'superseded-price-receipt'])]};
    else if(ownTime===selectedTime&&(selected.reasons.includes('conflicting-latest-prices')||selected.grossPackPrice!==original.grossPackPrice))quote={...original,grossPackPrice:null,reasons:[...new Set([...original.reasons,...selected.reasons,'conflicting-latest-prices'])]};
   }
   const product={...donor,store:row.source.store,id:row.source.id,source:'sesum',productKey:row.sourceKey,sourceUrl:row.source.sourceUrl,ean:row.source.ean[0]??donor.ean??null,available:donor.store!==row.source.store||donor.available!==false,donorProductKey:bridge.productKey,sourceFingerprint:row.fingerprint,metadataFingerprint:hash([row.fingerprint,bridge.productFingerprint]),quote};
   out.products[row.sourceKey]=product;
   for(const m of currentGroups(base,bridge.productKey)){
    const member={...m,k:row.sourceKey,u:positive(quote.grossPackPrice)&&!quote.reasons.length?quote.grossPackPrice/bridge.packAmount:null};
    if(out.members[m.groupId].some(existing=>existing.k===row.sourceKey))out.members[m.groupId]=out.members[m.groupId].map(existing=>existing.k===row.sourceKey?member:existing);
    else out.members[m.groupId].push(member);
   }
   if(donor.store===row.source.store){
    const previous=out.products[bridge.productKey];
    if(selected!==previous.quote){
     out.products[bridge.productKey]={...previous,quote:selected};
     for(const groupId of Object.keys(out.members))out.members[groupId]=out.members[groupId].map(m=>m.k===bridge.productKey?{...m,u:positive(selected.grossPackPrice)&&!selected.reasons.length?selected.grossPackPrice/bridge.packAmount:null}:m);
    }
   }
  }
  overlayIndex=index;overlayRevision=state.revision;overlayValidation=validation;overlayFactory=createIndexReader(out,{horizonDays:base.horizonDays});
  return versioned(overlayFactory(clock().getTime()),index,validation);
 }
 function provide(entries,baseResult={status:'disabled',quotes:[]}){
  const over=overlay(),result=new Map((baseResult.quotes??[]).map(q=>[`${q.watchId}|${q.store}|${q.id}`,q]));
  if(!over)return baseResult;
  for(const entry of entries){
   if(entry.status!=='approved')continue;
   const key=`kassal:${entry.store}:${entry.id}`,q=over.quote(key),p=q?.product;
   if(!q?.reviewCurrent||!['sesum','native-catalog'].includes(q.price.priceSource)||p.unit!==entry.unit||!near(p.pack,entry.packAmount)||p.textHash!==productTextHash(entry))continue;
   if(p.rawPack&&(p.rawPack.weight!==entry.weight||normalize(p.rawPack.weightUnit)!==normalize(entry.weightUnit)))continue;
   result.set(`${entry.watchId}|${entry.store}|${entry.id}`,{watchId:entry.watchId,store:entry.store,id:entry.id,canonicalPackAmount:p.pack,...q.price});
  }
  return {status:baseResult.status==='disabled'?'ready':baseResult.status,quotes:[...result.values()]};
 }
 function pending(){
  const base=rawReader(),at=clock().getTime(),horizon=base?.horizonDays??183;
  return Object.values(state.products).filter(row=>!validBridge(row,state.bridges[row.sourceKey],base)&&!(state.bridges[row.sourceKey]?.status==='excluded'&&state.bridges[row.sourceKey].sourceFingerprint===row.fingerprint)&&(!row.receipt.observedAt||at-Date.parse(row.receipt.observedAt)<=horizon*86400000)).map(row=>({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,name:row.source.name,familyIds:[...row.familyIds],receiptAt:row.receipt.observedAt,hasReviewedDonor:findDonors(base,row.source).some(key=>donorAllowed(row,key,base?.product(key))&&currentGroups(base,key).length>0)}));
 }
 function sourceRecord(key){const row=sourceRow(key);return row?clone({sourceKey:row.sourceKey,sourceFingerprint:row.fingerprint,source:row.source,price:row.receipt,familyIds:row.familyIds}):null;}
 return {ingest,candidates,review,overlay,provide,pending,work:pending,sourceRecord,revision:()=>state.revision,status:()=>({products:Object.keys(state.products).length,bridges:Object.keys(state.bridges).length,revision:state.revision})};
}
