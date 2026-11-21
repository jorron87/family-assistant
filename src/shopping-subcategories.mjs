import {odaProductIdFromUrl} from './oda-product-identity.mjs';
import {dealTier,planQuantities} from './shopping-planning.mjs';

const rounded=n=>Math.round(n*100)/100;
const cheapest=list=>list.reduce((best,row)=>!best||row.unitPrice<best.unitPrice?row:best,null);
const productId=p=>odaProductIdFromUrl(p.productSourceUrl??p.sourceUrl);
const keyOf=p=>p.productKey??`kassal:${p.store}:${p.id}`;
const display=p=>p?{name:p.name,storeName:p.storeName,unitPrice:rounded(p.unitPrice),receiptAt:p.lastChecked,sourceUrl:p.sourceUrl}:null;

// A category price describes what the store sells. Only a separately reviewed
// household alternative can support a stock-up quantity.
export function subcategoryPrices({reader,links,families,quotes,stores,choice,planning,skipAlerts}){
 const comparisons=[],candidates=[];
 const byFamily=new Map(families.map(f=>[f.familyId,f]));
 const physical=new Map(stores.filter(s=>s.chainCode&&s.chainCode!=='ODA_NO'&&!/nettbutikk/i.test(s.name)).map(s=>[s.chainCode,s]));
 const members=new Map();
 for(const link of links){
  const f=byFamily.get(link.watchId),chosen=choice(f.familyId);
  const reviewed=quotes.filter(p=>p.watchId===f.familyId&&p.kind==='catalog'&&p.unit===f.unit);
  const approvedOda=new Set([...(link.odaReferenceIds??[]),...f.products.filter(p=>p.store==='ODA_NO'&&p.reviewCurrent).map(productId).filter(Boolean)]);
  const odb=reviewed.filter(p=>p.store==='ODA_NO'&&(!chosen||productId(p)===chosen));
  const eligibleStores=reviewed.filter(p=>physical.has(p.store));
  const alternatives=[],placements=new Map(),barcodes=new Map();
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
    if(!row.price.fresh||row.price.reasons.length||!p.available||p.unit!==f.unit)continue;
    const unitPrice=p.packKnown&&p.pack>0&&row.price.grossPackPrice>0?row.price.grossPackPrice/p.pack:row.price.directUnitVerified&&row.price.unit===f.unit?row.price.grossUnitPrice:null;
    if(!(unitPrice>0))continue;
    const q={name:p.name,productId:productId(p),unitPrice,lastChecked:row.price.receiptAt,sourceUrl:p.sourceUrl,storeName:physical.get(p.store)?.name??'Oda'};
    if(p.store==='ODA_NO'&&approvedOda.has(productId(p))&&(!chosen||productId(p)===chosen))oda.push(q);
    else if(physical.has(p.store))shops.push(q);
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
   const baseline=cheapest([...odb.filter(p=>odaIds.has(productId(p))||only&&!placements.has(productId(p))),...oda.filter(p=>!odb.some(other=>productId(other)===p.productId&&Date.parse(other.lastChecked)>=Date.parse(p.lastChecked)))]);
   const approved=eligibleStores.filter(belongs);
   const lowest=cheapest([...shops,...approved]);
   comparisons.push({watchId:f.familyId,name:f.name,categoryId:cat.id,categoryName:cat.name,unit:f.unit,oda:display(baseline),store:display(lowest),differencePct:baseline&&lowest?rounded((1-lowest.unitPrice/baseline.unitPrice)*100):null});
   if(!baseline||skipAlerts.has(f.familyId))continue;
   for(const p of approved)if(p.packAmount>0&&p.price>0&&p.unitPrice<baseline.unitPrice)alternatives.push({p,baseline,cat});
  }
  if(!alternatives.length)continue;
  const {need,stock,shelfMonths,excellentPrice,maxPacks,minDiscountPct,referenceCap}=planning(f.familyId);
  for(const {p,baseline,cat} of alternatives){
   const reference=Math.min(baseline.unitPrice,referenceCap??Infinity);
   const diff=(1-p.unitPrice/baseline.unitPrice)*100,conservative=(1-p.unitPrice/reference)*100;
   if(diff<Math.max(20,minDiscountPct??0)||conservative<8)continue;
   const tier=dealTier({unitPrice:p.unitPrice,excellentPrice,discountPct:conservative,referenceType:'market'});
   const {recommended,covered}=planQuantities({tier,need,stock,shelfMonths,offer:{packAmount:p.packAmount,bundlePacks:1,price:p.price},caps:[100,maxPacks],unitSaving:reference-p.unitPrice});
   if(covered||!recommended?.saving)continue;
   const store=physical.get(p.store);
   candidates.push({watchId:f.familyId,name:f.name,categoryName:cat.name,storeId:store.id,storeName:store.name,productName:p.name,unit:f.unit,unitPrice:rounded(p.unitPrice),oda:display(baseline),diffPct:rounded(diff),packs:recommended.packs,packAmount:p.packAmount,saving:recommended.saving,stockKnown:stock.known,receiptAt:p.lastChecked,sourceUrl:p.sourceUrl});
  }
 }
 // Count each household need once; several leaves or shops never multiply demand.
 candidates.sort((a,b)=>b.saving-a.saving||a.unitPrice-b.unitPrice);
 const best=new Map();
 for(const row of candidates)if(!best.has(row.watchId))best.set(row.watchId,row);
 const totals=new Map();
 for(const r of best.values())totals.set(r.storeId,(totals.get(r.storeId)??0)+r.saving);
 const alerts=[...best.values()].filter(r=>totals.get(r.storeId)>=(stores.find(s=>s.id===r.storeId)?.minSavings??0));
 return {comparisons,alerts};
}
