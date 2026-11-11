import {createHash} from 'node:crypto';
import {odaProductIdFromUrl} from './oda-product-identity.mjs';
import {createIndexReader} from './shopping-library.mjs';
import {productTextHash} from './product-library.mjs';

const DAY=86400000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const near=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const decimal=value=>typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
const units=new Map([['kilogram','kg'],['kg','kg'],['liter','l'],['litre','l'],['l','l'],['stykk','stk'],['stk','stk'],['stykke','stk'],['rull','stk'],['roll','stk']]);

// A refresh targets previously reviewed identities. Search hits never become
// product approvals, replacements, or household preferences.
export function odaPriceRefreshPlan({entries,watches,prices,attempts={},at,force=false,ignoreRetry=false,watchId=null,horizonDays=183}) {
  const latest=new Map(prices.map(p=>[p.watchId+'|'+p.store+'|'+p.id,p]));
  const grouped=new Map();
  for(const entry of entries){
    const watch=watches.find(w=>w.id===entry.watchId);
    if(entry.store!=='ODA_NO'||entry.status!=='approved'||!watch||watch.enabled===false||watchId&&watch.id!==watchId)continue;
    const odaProductId=odaProductIdFromUrl(entry.sourceUrl);
    if(!odaProductId||!positive(entry.packAmount)||entry.unit!==watch.unit)continue;
    const current=latest.get(entry.watchId+'|'+entry.store+'|'+entry.id)??entry;
    const receipt=Date.parse(current.lastChecked),age=at-receipt;
    // Known old catalogue products remain parked. An unknown receipt is a gap,
    // rather than evidence that a product was recently priced.
    if(Number.isFinite(age)&&age>horizonDays*DAY)continue;
    const currentPrice=Object.hasOwn(current,'unitPrice')?current.unitPrice:current.currentPrice;
    const due=force||!Number.isFinite(age)||age<0||age>=DAY||!positive(currentPrice)||current.odaAvailable===false;
    const row={id:entry.id,odaProductId,fingerprint:entry.fingerprint,name:entry.name,brand:entry.brand??null,sourceUrl:entry.sourceUrl,packAmount:entry.packAmount,unit:entry.unit,needsRefresh:due};
    const list=grouped.get(watch.id)??{watchId:watch.id,name:watch.name,query:watch.name,products:[],due:false};
    list.due||=due;
    // A short, existing catalogue query is usually better than a display label.
    const query=entry.query?.split('|')[0]?.trim();
    // Older exact-ID maintenance overwrote this field with an operation label.
    // That label is not a product query; use the real household family name.
    if(query&&query.length<=200&&!/manually reviewed|initial catalogue|^automatic reviewed market refresh$/i.test(query.replace(/\s+/gu,' ')))list.query=query;
    list.products.push(row);grouped.set(watch.id,list);
  }
  return [...grouped.values()].filter(group=>group.due).map(({due,...group})=>{
    group.products.sort((a,b)=>a.odaProductId-b.odaProductId||a.id.localeCompare(b.id));
    const watch=watches.find(w=>w.id===group.watchId);
    // A failed search applies only to that actual query and reviewed basis.
    // A repaired query gets one normal attempt; identical failures still wait.
    group.fingerprint=hash([1,group.query,watch.name,watch.unit,watch.note??null,watch.family?.kind??null,(watch.variants??[]).map(v=>[v.groupId,v.groupFingerprint,v.requires,v.brands,v.excludeProductKeys]),group.products.map(p=>[p.id,p.odaProductId,p.fingerprint,p.packAmount,p.unit])]);
    const prior=attempts[group.watchId];
    return {...group,retryAt:prior?.fingerprint===group.fingerprint?prior.retryAt??null:null};
  }).filter(group=>force||ignoreRetry||!group.retryAt||Date.parse(group.retryAt)<=at);
}

export function mergeOdaPriceReceipt(previous,incoming) {
  if(!previous||Date.parse(incoming.observedAt)>Date.parse(previous.observedAt))return {receipt:incoming,status:'stored'};
  if(Date.parse(incoming.observedAt)<Date.parse(previous.observedAt))return {receipt:previous,status:'superseded'};
  if(previous.conflicting||incoming.conflicting||Math.abs(previous.price-incoming.price)>1e-8||previous.available!==incoming.available)return {receipt:{...previous,conflicting:true,conflictingReceipts:[...(previous.conflictingReceipts??[{price:previous.price,available:previous.available,observedAt:previous.observedAt}]),{price:incoming.price,available:incoming.available,observedAt:incoming.observedAt}].slice(-10)},status:'conflict'};
  return {receipt:previous,status:'duplicate'};
}

export function checkedOdaPrice(expected,product) {
  if(!product||product.id!==expected.odaProductId)return {ok:false,reason:'missing-exact-product'};
  if(product.url!=null&&odaProductIdFromUrl(product.url)!==expected.odaProductId)return {ok:false,reason:'product-url-identity-conflict'};
  const price=decimal(product.price),unitPrice=decimal(product.unitPrice),unit=units.get(typeof product.unitName==='string'?product.unitName.trim().toLowerCase():'');
  if(!positive(price)||!positive(unitPrice)||unit!==expected.unit)return {ok:false,reason:'missing-or-conflicting-price-unit'};
  // The canonical pack was reviewed before this request. Unit-price arithmetic
  // is only a consistency guard, never the source of a new pack amount.
  if(Math.abs(price/expected.packAmount-unitPrice)>.021)return {ok:false,reason:'canonical-pack-price-conflict'};
  if(typeof product.availability?.isAvailable!=='boolean')return {ok:false,reason:'unknown-availability'};
  return {ok:true,price,available:product.availability.isAvailable,unitPrice:price/expected.packAmount,sourceUrl:product.url??expected.sourceUrl,productName:String(product.name??'').slice(0,500),description:String(product.description??'').slice(0,1000)};
}

// The same verified receipt is visible in library/family details as in cart
// checks and planning. Metadata and membership decisions remain untouched.
export function createOdaPriceOverlay({receipts,entries,now}) {
  let priorIndex=null,priorSignature=null,factory=null;
  return base=>{
    if(!base)return base;
    const records=receipts();if(!Object.keys(records).length)return base;
    const index=base.index(),selected=new Map(),at=now().getTime();
    for(const entry of entries()){
      const receipt=records[entry.key],key=`kassal:ODA_NO:${entry.id}`,p=entry.store==='ODA_NO'?base.product(key):null;
      if(entry.status!=='approved'||!receipt||!p||receipt.fingerprint!==entry.fingerprint||receipt.odaProductId!==odaProductIdFromUrl(entry.sourceUrl)||!near(receipt.packAmount,entry.packAmount)||receipt.unit!==entry.unit||!near(p.pack,entry.packAmount)||p.unit!==entry.unit||p.textHash!==productTextHash(entry)||p.rawPack&&(p.rawPack.weight!==entry.weight||String(p.rawPack.weightUnit??'').trim()!==String(entry.weightUnit??'').trim())||typeof receipt.available!=='boolean'||!positive(receipt.price)||!Number.isFinite(Date.parse(receipt.observedAt))||Date.parse(receipt.observedAt)>at)continue;
      const previous=selected.get(key)??p.quote;
      if(previous?.receiptAt&&Date.parse(previous.receiptAt)>Date.parse(receipt.observedAt))continue;
      const sameTime=previous?.receiptAt&&Date.parse(previous.receiptAt)===Date.parse(receipt.observedAt);
      const conflict=receipt.conflicting||sameTime&&(previous.reasons?.includes('conflicting-latest-prices')||previous.grossPackPrice!=null&&Math.abs(previous.grossPackPrice-receipt.price)>1e-8||typeof previous.odaAvailable==='boolean'&&previous.odaAvailable!==receipt.available);
      selected.set(key,{grossPackPrice:conflict?null:receipt.price,grossUnitPrice:null,unit:null,directUnitVerified:false,receiptAt:receipt.observedAt,sourceUrl:receipt.sourceUrl,reasons:conflict?['conflicting-latest-prices']:receipt.available?[]:['unavailable-product'],availabilityScope:'account',currency:'NOK',odaAvailable:receipt.available});
    }
    if(!selected.size)return base;
    const signature=hash([...selected]);
    if(index===priorIndex&&signature===priorSignature&&factory)return factory(at);
    const out={...index,products:{...index.products},members:{...index.members}};
    for(const [key,quote] of selected)out.products[key]={...out.products[key],available:quote.odaAvailable,quote};
    for(const [groupId,rows] of Object.entries(index.members))if(rows.some(m=>selected.has(m.k)))out.members[groupId]=rows.map(m=>selected.has(m.k)?{...m,u:selected.get(m.k).grossPackPrice!=null?selected.get(m.k).grossPackPrice/out.products[m.k].pack:null}:m);
    priorIndex=index;priorSignature=signature;factory=createIndexReader(out,{horizonDays:base.horizonDays});
    return factory(at);
  };
}
