import {odaProductIdFromUrl} from './oda-product-identity.mjs';
import {dealTier,planQuantities} from './shopping-planning.mjs';

const rounded=n=>Math.round(n*100)/100;
const cheapest=list=>list.reduce((best,row)=>!best||row.unitPrice<best.unitPrice?row:best,null);
const productId=p=>odaProductIdFromUrl(p.productSourceUrl??p.sourceUrl);
const keyOf=p=>p.productKey??`kassal:${p.store}:${p.id}`;
const display=p=>p?{name:p.name,storeName:p.storeName,unitPrice:rounded(p.unitPrice),receiptAt:p.lastChecked,sourceUrl:p.sourceUrl}:null;

// Oda's per-kg price may use drained weight, while the household compares
// the whole labelled net pack. Take an explicit total from its native size
// field. Never multiply a per-item weight or estimate a variable pack.
const packUnits={g:['kg',0.001],kg:['kg',1],ml:['l',0.001],cl:['l',0.01],dl:['l',0.1],l:['l',1],stk:['stk',1],ruller:['stk',1]};
function declaredAmount(product,unit){
 if(product?.source!=='oda'||typeof product.description!=='string')return null;
 const amounts=new Set();
 for(const field of product.description.split(/,\s+/)){
  const m=field.trim().match(/^(\d+(?:[,.]\d+)?)\s*(kg|g|ml|cl|dl|l|stk\.?|ruller)$/iu);
  if(!m)continue;
  const [basis,factor]=packUnits[m[2].toLowerCase().replace('.','')];
  const amount=Number(m[1].replace(',','.'))*factor;
  if(basis===unit&&amount>0)amounts.add(amount);
 }
 return amounts.size===1?[...amounts][0]:null;
}
function contradictsPack(amount,unit,products,id){
 return amount!=null&&products.some(p=>productId(p)===id&&p.unit===unit&&p.canonicalPackAmount>0&&Math.abs(p.canonicalPackAmount-amount)>1e-6);
}
function comparableUnitPrice(row,unit,odaProducts){
 const p=row.product,quote=row.price,id=productId(p),amount=declaredAmount(p,unit);
 if(contradictsPack(amount,unit,odaProducts,id))return null;
 if(amount&&quote.grossPackPrice>0){
  // Count-based households can use a second measure only when their reviewed
  // pack independently confirms the same piece/roll count.
  if(p.unit!==unit&&!odaProducts.some(a=>productId(a)===id&&a.unit===unit&&Math.abs(a.canonicalPackAmount-amount)<1e-6))return null;
  return quote.grossPackPrice/amount;
 }
 if(p.unit!==unit)return null;
 if(p.packKnown&&p.pack>0&&quote.grossPackPrice>0)return quote.grossPackPrice/p.pack;
 return quote.directUnitVerified&&quote.unit===unit?quote.grossUnitPrice:null;
}

// A barcode can point out a shelf pack to check. It never grants household
// equivalence or a purchase quantity. Require a previously reviewed pack,
// matching brand and measurement as well as the native category.
function reviewedPackHint(p,products){
 if(!p.packKnown||!(p.pack>0)||!p.brand||!/^\d{8,14}$/.test(String(p.ean??'')))return false;
 return products.some(other=>other.reviewCurrent&&String(other.ean)===String(p.ean)&&other.brand?.trim().toLowerCase()===p.brand.trim().toLowerCase()&&other.unit===p.unit&&Math.abs(other.canonicalPackAmount-p.pack)<1e-6);
}

function currentOdaQuotes(list){
 const grouped=new Map();
 for(const row of list){
  const id=row.productId??productId(row);
  if(!id)continue;
  const time=Date.parse(row.lastChecked),prior=grouped.get(id);
  if(!prior||time>prior.time)grouped.set(id,{row,time,conflict:false});
  else if(time===prior.time&&rounded(row.unitPrice)!==rounded(prior.row.unitPrice))prior.conflict=true;
 }
 return [...grouped.values()].filter(p=>!p.conflict).map(p=>p.row);
}

// Compare the remaining baskets after each selected store trip. A pack can
// contribute to a trip threshold only once and only at the store selling it.
function shoppingTrips(candidates,stores){
 const byStore=new Map(),alerts=[],assigned=new Set();
 for(const row of candidates){
  if(!byStore.has(row.storeId))byStore.set(row.storeId,new Map());
  const basket=byStore.get(row.storeId),prev=basket.get(row.watchId);
  if(!prev||row.saving>prev.saving)basket.set(row.watchId,row);
 }
 while(byStore.size){
  let best=null;
  for(const [storeId,basket] of byStore){
   const rows=[...basket.values()].filter(r=>!assigned.has(r.watchId));
   const total=rounded(rows.reduce((acc,r)=>acc+r.saving,0));
   if(rows.length&&total>=(stores.find(s=>s.id===storeId)?.minSavings??0)&&(!best||total>best.total))best={storeId,rows,total};
  }
  if(!best)break;
  byStore.delete(best.storeId);
  for(const r of best.rows){alerts.push(r);assigned.add(r.watchId);}
 }
 return alerts.sort((a,b)=>b.saving-a.saving);
}

// A category price describes what the store sells. Only a separately reviewed
// household alternative can support a stock-up quantity.
export function subcategoryPrices({reader,links,families,quotes,nativeEntries=[],retainReviewed,stores,choice,planning,skipAlerts,excluded}){
 const comparisons=[],candidates=[],signals=[];
 const byFamily=new Map(families.map(f=>[f.familyId,f]));
 const physical=new Map(stores.filter(s=>s.chainCode&&s.chainCode!=='ODA_NO'&&!/nettbutikk/i.test(s.name)).map(s=>[s.chainCode,s]));
 const members=new Map(),nativeByWatch=new Map();
 for(const entry of nativeEntries){
  if(!nativeByWatch.has(entry.watchId))nativeByWatch.set(entry.watchId,[]);
  nativeByWatch.get(entry.watchId).push(entry);
 }
 for(const link of links){
  const f=byFamily.get(link.watchId),chosen=choice(f.familyId);
  const reviewed=quotes.filter(p=>p.watchId===f.familyId&&p.kind==='catalog'&&p.unit===f.unit);
  // A household catalogue review owns its exact SKU and measurement. The
  // general library can describe the same can by a different (drained) weight.
  const byKey=new Map(f.products.filter(p=>p.reviewCurrent).map(p=>[keyOf(p),p]));
  for(const e of nativeByWatch.get(f.familyId)??[]){
   if(e.status==='approved')byKey.set(keyOf(e),{...e,reviewCurrent:true,canonicalPackAmount:e.packAmount});
   else if(e.status!=='pending'||e.reviewHold||!byKey.has(keyOf(e))||!retainReviewed?.(e,keyOf(e)))byKey.delete(keyOf(e));
  }
  const products=[...byKey.values()],odaProducts=products.filter(p=>p.store==='ODA_NO');
  const approvedOda=new Set([...(link.odaReferenceIds??[]),...odaProducts.map(productId).filter(Boolean)]);
  const odb=reviewed.filter(p=>p.store==='ODA_NO'&&(!chosen||productId(p)===chosen));
  const eligibleStores=reviewed.filter(p=>physical.has(p.store));
  const alternatives=[],familyBaselines=[],categoryLows=[],placements=new Map(),barcodes=new Map();
  for(const cat of link.categories){
   if(!members.has(cat.id))members.set(cat.id,reader?.members(cat.groupId)??[]);
   for(const row of members.get(cat.id)){
    const p=row.product;
    if(p.store==='ODA_NO')placements.set(productId(p),cat.id);
    if(p.ean&&p.packKnown&&p.pack>0){
     const signature=JSON.stringify([String(p.ean),p.unit,rounded(p.pack*1000000)]);
     if(!barcodes.has(signature))barcodes.set(signature,new Set());
     barcodes.get(signature).add(cat.id);
    }
   }
  }
  for(const cat of link.categories){
   const rows=members.get(cat.id),odaIds=new Set(),keys=new Set(),oda=[],shops=[];
   for(const row of rows){
    const p=row.product;
    keys.add(row.productKey);
    if(p.store==='ODA_NO')odaIds.add(productId(p));
    if(excluded?.(f.familyId,p,row.productKey)||!row.price.fresh||row.price.reasons.length||!p.available)continue;
    const unitPrice=comparableUnitPrice(row,f.unit,odaProducts);
    if(!(unitPrice>0))continue;
    const q={name:p.name,store:p.store,productId:productId(p),unitPrice,lastChecked:row.price.receiptAt,sourceUrl:p.sourceUrl,storeName:physical.get(p.store)?.name??'Oda'};
    if(p.store==='ODA_NO'&&approvedOda.has(productId(p))&&(!chosen||productId(p)===chosen))oda.push(q);
    else if(physical.has(p.store))shops.push({...q,reviewedPackHint:reviewedPackHint(p,products)});
   }
   const only=link.categories.length===1;
   // Reviewed household quotes can also come from Kassalapp or Oda MCP.
   // With several leaves a native membership is needed to assign a quote.
   const belongs=p=>{
    if(keys.has(keyOf(p)))return true;
    // This assigns an already approved shop quote to a shelf. It never imports
    // another SKU's price, eligibility, or package.
    const ids=barcodes.get(JSON.stringify([String(p.ean),p.unit,rounded(p.packAmount*1000000)]));
    if(ids?.size===1)return ids.has(cat.id);
    return only;
   };
   const currentReviewed=odb.filter(p=>{
    const id=productId(p),native=reader?.odaNative?.(id);
    if(native&&(!native.available||contradictsPack(declaredAmount(native,f.unit),f.unit,odaProducts,id)))return false;
    if(native&&Date.parse(native.quote?.receiptAt)>=Date.parse(p.lastChecked)&&native.quote?.reasons?.length)return false;
    return odaIds.has(id)||only&&!placements.has(id)&&!native;
   });
   const baseline=cheapest(currentOdaQuotes([...currentReviewed,...oda]));
   const approved=eligibleStores.filter(belongs);
   const lowest=cheapest([...approved,...shops]);
   comparisons.push({watchId:f.familyId,name:f.name,categoryId:cat.id,categoryName:cat.name,unit:f.unit,oda:display(baseline),store:display(lowest),differencePct:baseline&&lowest?rounded((1-lowest.unitPrice/baseline.unitPrice)*100):null});
   if(!baseline)continue;
   familyBaselines.push(baseline);
   if(skipAlerts.has(f.familyId))continue;
   // A shelf observation can flag a variant to check, even without reviewed
   // evidence that this pack can satisfy the household need.
   const lead=cheapest([...approved,...shops.filter(p=>p.reviewedPackHint)]);
   if(lead)categoryLows.push({cat,lowest:lead,reviewed:approved.includes(lead)});
   for(const p of approved)if(p.packAmount>0&&p.price>0&&p.unitPrice<baseline.unitPrice)alternatives.push({p,cat});
  }
  const baseline=cheapest(familyBaselines);
  if(!baseline||!categoryLows.length&&!alternatives.length)continue;
  const {need,stock,shelfMonths,excellentPrice,maxPacks,minDiscountPct,referenceCap,referenceFor}=planning(f.familyId);
  for(const {cat,lowest,reviewed} of categoryLows){
   const diff=(1-lowest.unitPrice/baseline.unitPrice)*100;
   if(diff>=Math.max(20,minDiscountPct??0))signals.push({watchId:f.familyId,categoryId:cat.id,categoryName:cat.name,unit:f.unit,reviewed,store:display(lowest),oda:display(baseline),diffPct:rounded(diff)});
  }
  for(const {p,cat} of alternatives){
   const reference=Math.min(baseline.unitPrice,referenceCap??Infinity,referenceFor?.(p)??Infinity);
   const diff=(1-p.unitPrice/baseline.unitPrice)*100,conservative=(1-p.unitPrice/reference)*100;
   if(diff<Math.max(20,minDiscountPct??0)||conservative<8)continue;
   const tier=dealTier({unitPrice:p.unitPrice,excellentPrice,discountPct:conservative,referenceType:'market'});
   const {recommended,covered}=planQuantities({tier,need,stock,shelfMonths,offer:{packAmount:p.packAmount,bundlePacks:1,price:p.price},caps:[100,maxPacks],unitSaving:reference-p.unitPrice});
   if(covered||!recommended?.saving)continue;
   const store=physical.get(p.store);
   candidates.push({watchId:f.familyId,name:f.name,categoryName:cat.name,storeId:store.id,storeName:store.name,productName:p.name,unit:f.unit,unitPrice:rounded(p.unitPrice),oda:display(baseline),diffPct:rounded(diff),packs:recommended.packs,packAmount:p.packAmount,saving:recommended.saving,stockKnown:stock.known,receiptAt:p.lastChecked,sourceUrl:p.sourceUrl});
  }
 }
 const alerts=shoppingTrips(candidates,stores);
 const alerted=new Set(alerts.map(a=>a.watchId));
 return {comparisons,alerts,signals:signals.filter(s=>!alerted.has(s.watchId)).sort((a,b)=>b.diffPct-a.diffPct)};
}
