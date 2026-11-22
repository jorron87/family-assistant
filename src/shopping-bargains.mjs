import {dealTier,planQuantities,shelfWithDate} from './shopping-planning.mjs';

// One list of good buys across every store the household uses, Oda included.
// A good buy does not have to be a campaign: any fresh price clearly below
// what the household would otherwise pay counts. Every candidate is held
// against the same conservative reference and planned with the same
// quantity rules, so a flyer offer, an ordinary shelf price and a cheap Oda
// price read alike. Unreviewed shelf variants stay visibly marked, and only
// reviewed rows count towards a store's trip total.

export const GOOD_PCT=8;
// An unreviewed variant needs a clear gap below the conservative reference,
// and a very large one is far more often another pack, form or unit.
export const CHECK_MIN_PCT=15;
export const CHECK_MAX_PCT=60;
// A few kroner is not worth reading about; it stays in the minor list.
export const MIN_SAVING=15;
// Cheaper than the household's own Oda product, without being a market low.
export const SWITCH_MIN_PCT=10;
export const CHECK_SWITCH_PCT=20;

const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const TIER_WEIGHT={excellent:1.5,good:1,switch:.7,small:.2};
const score=row=>(row.saving??0)*(TIER_WEIGHT[row.tier]??1)*(row.reviewed?1:.6)+row.discountPct/100;

// An unreviewed shelf row only shares a broad native category with the
// family. Before it is shown as a variant to check it must name the same kind
// of product, keep strong dietary qualifiers and not contradict the family's
// colour, shell or form. A reviewed household link already proved all this.
const QUALIFIERS=[['laktosefri',/laktosefri|\blf\b|laktosefritt/i],['glutenfri',/glutenfri/i],['sukkerfri',/sukkerfri|uten\s+sukker|zero/i],['økologisk',/økologisk|\bøko\b/i]];
const EXCLUSIVE=[
 [/\bgrønn(e)?\b/i,/\bsort(e)?\b|\bsvart(e)?\b/i],
 [/\bmed\s+skall\b/i,/kjerner?\b|uten\s+skall/i],
 [/hele\s+bønner|\bbønner\b/i,/\bmalt\b|filtermalt|kokmalt|pressmalt|instant/i],
 [/\bskive(t|r)?\b/i,/\bblokk\b|\bbit\b|\brevet\b/i],
 [/\bdijon/i,/pølsesennep|amerikansk|søt\s*&?\s*sterk|grov/i]
];
const STOP=new Set(['uten','med','dokumentert','dokumenterte','frysemerking','naturell','naturelle','vanlig','vanlige','type','ordinær','ordinære','eller','samme','andre','annen','produkter','variant','varianter','varer','fryselagring','fryses','pakning','norge','norsk','klasse','prosent']);
const words=text=>String(text).toLocaleLowerCase('nb-NO').split(/[^a-zæøå]+/).filter(w=>w.length>=4&&!STOP.has(w));
const related=(a,b)=>a===b||a.length>=5&&b.length>=5&&a.slice(0,5)===b.slice(0,5);
export function fitsFamily(family,product) {
 const name=String(product?.name??''),terms=family.terms??[],familyName=terms[0]??'',groups=terms.slice(1);
 // A qualifier is required when the family itself, or every one of its
 // variants, carries it; one organic sub-variant does not make all organic.
 for(const [word,pattern] of QUALIFIERS)if((familyName.includes(word)||groups.length&&groups.every(t=>t.includes(word)))&&!pattern.test(name))return false;
 const own=terms.join(' ');
 // A reduced-fat or light variant is another product unless the family is one.
 if(/\blett\b|\blight\b|\bmager\b/i.test(name)&&!/\blett|light|mager/i.test(own))return false;
 for(const [a,b] of EXCLUSIVE)if(a.test(own)&&!b.test(own)&&b.test(name)||b.test(own)&&!a.test(own)&&a.test(name))return false;
 const mine=words(own),theirs=words(name);
 if(mine.length&&!theirs.some(w=>mine.some(m=>related(w,m))))return false;
 const variants=family.variants??[];
 if(!variants.length)return true;
 const brand=String(product?.brand??'').trim().toLowerCase();
 return variants.some(v=>(!v.brands?.length||(brand&&v.brands.some(b=>brand.includes(String(b).trim().toLowerCase()))))&&(v.requires??[]).every(key=>product?.attributes?.[key]===true));
}

function planFor(c,f,tier,reference,at) {
 if(c.plan)return c.plan;
 if(!(c.packAmount>0&&c.packPrice>0))return null;
 const shelfMonths=shelfWithDate(f.shelfMonths,c.bestBefore??null,at);
 const plan=planQuantities({tier,need:f.need,shelfMonths,stock:f.stock,offer:{packAmount:c.packAmount,bundlePacks:c.bundlePacks??1,price:c.packPrice},caps:[f.maxPacks,c.maxPacks],unitSaving:Math.max(0,reference-c.unitPrice)});
 return {options:plan.options,recommendedKey:plan.recommended?.key??null,fullMonths:plan.fullMonths,covered:plan.covered};
}

/**
 * candidates: priced rows from offers, reviewed shelf prices and unreviewed
 * shelf observations. Each carries its own reference {price,basis,storeName}.
 * families: Map watchId -> {name,unit,need,stock,shelfMonths,excellentPrice,
 * maxPacks,minDiscountPct,terms,variants}. stores: [{key,name,minSavings,oda,online}].
 */
// "Passer ikke" removes a product name from one family's suggestions in every
// store; "Ikke nå" hides one store's row until its price changes or for two
// weeks. Neither approves or excludes anything for prices or other families.
const normalName=name=>String(name??'').toLocaleLowerCase('nb-NO').replace(/\s+/g,' ').trim();
export const bargainHideKeys=row=>({mismatch:`${row.watchId}|name:${normalName(row.productName)}`,snooze:`${row.watchId}|${row.storeKey}|${row.productKey??row.offerId??normalName(row.productName)}`});
export function hiddenBargain(hides,row,at) {
 const keys=bargainHideKeys(row),snooze=hides?.[keys.snooze];
 if(hides?.[keys.mismatch])return true;
 return !!snooze&&snooze.unitPrice===row.unitPrice&&at-Date.parse(snooze.at)<14*86400000;
}

// A price is judged against the market first. Only a clear market low is a
// good buy that may justify stocking up. Otherwise a price clearly below the
// household's own Oda product is still worth knowing as a cheaper place to
// buy, for the next trip only; that never makes it a campaign or a stock-up.
function judge(c,f) {
 const reference=c.reference?.price;
 let market=null;
 // A reviewed offer at the family's own price limit already passed its tier.
 if(reference>0&&(c.unitPrice<reference||c.unitPrice===reference&&c.tier)){
  const discountPct=round((reference-c.unitPrice)/reference*100);
  const admitted=c.reviewed?discountPct>=(f.minDiscountPct??0):discountPct>=Math.max(CHECK_MIN_PCT,f.minDiscountPct??0)&&discountPct<=CHECK_MAX_PCT;
  if(admitted)market={reference,referenceBasis:c.reference.basis,referenceStore:c.reference.storeName??null,discountPct,tier:c.tier??(discountPct<GOOD_PCT?'small':dealTier({unitPrice:c.unitPrice,excellentPrice:c.reviewed?f.excellentPrice:null,discountPct,referenceType:'market'}))};
 }
 if(market&&market.tier!=='small')return market;
 const oda=c.odaPrice;
 if(c.kind!=='offer'&&c.storeKey!=='oda'&&oda>0&&c.unitPrice<oda){
  const discountPct=round((oda-c.unitPrice)/oda*100);
  if(c.reviewed?discountPct>=SWITCH_MIN_PCT:discountPct>=CHECK_SWITCH_PCT&&discountPct<=CHECK_MAX_PCT)return {reference:oda,referenceBasis:'oda',referenceStore:'Oda',discountPct,tier:'switch'};
 }
 return market;
}

export function buildBargains({candidates,families,stores,hides={},at=Date.now()}) {
 const best=new Map(),minor=[],covered=[];let hidden=0;
 for(const c of candidates){
  const f=families.get(c.watchId);
  if(!f||!(c.unitPrice>0))continue;
  const judged=judge(c,f);if(!judged)continue;
  const {reference,referenceBasis,referenceStore,discountPct,tier}=judged;
  const plan=planFor(c,f,tier==='switch'?'small':tier,reference,at);
  const option=plan?.options?.find(o=>o.key===plan.recommendedKey)??plan?.options?.at(-1)??null;
  const row={key:`${c.storeKey}|${c.watchId}|${c.kind}|${c.productKey??c.offerId??c.productName}`,watchId:c.watchId,familyName:f.name,unit:f.unit,storage:f.storage??null,
   storeKey:c.storeKey,storeId:c.storeId??null,storeName:c.storeName,oda:c.storeKey==='oda',online:c.online===true,
   kind:c.kind,reviewed:c.reviewed===true,productName:c.productName,productKey:c.productKey??null,offerId:c.offerId??null,odaProductId:c.odaProductId??null,
   unitPrice:round(c.unitPrice),packAmount:c.packAmount??null,packPrice:c.packPrice!=null?round(c.packPrice):null,bundlePacks:c.bundlePacks??1,maxPacks:c.maxPacks??null,
   referencePrice:round(reference),referenceBasis,referenceStore,discountPct,tier,
   validFrom:c.validFrom??null,validTo:c.validTo??null,bestBefore:c.bestBefore??null,memberOnly:c.memberOnly===true,conditions:c.conditions??null,
   receiptAt:c.receiptAt??null,sourceUrl:c.sourceUrl??null,image:c.image??null,
   stock:f.stock,annualAmount:f.need?.amount==null?null:round(f.need.amount),quantityBasis:f.need?.basis??null,
   options:plan?.options??[],recommendedKey:option?.key??null,fullMonths:plan?.fullMonths??null,
   packs:option?.packs??null,cost:option?.cost??null,saving:option?.saving??null};
  if(row.kind!=='offer'&&hiddenBargain(hides,row,at)){hidden++;continue;}
  if(plan?.covered){covered.push({...row,packs:0,saving:null,options:[]});continue;}
  if(tier==='small'||row.saving!=null&&row.saving<MIN_SAVING){minor.push(row);continue;}
  const k=row.storeKey+'|'+row.watchId,prev=best.get(k);
  if(!prev||score(row)>score(prev))best.set(k,row);
 }
 // One shelf pack can only answer one household need in a store.
 const byProduct=new Map();
 for(const row of best.values()){
  const k=row.storeKey+'|'+(row.productKey??row.offerId??row.productName),prev=byProduct.get(k);
  if(!prev||score(row)>score(prev))byProduct.set(k,row);
 }
 const rows=[...byProduct.values()].sort((a,b)=>Number(b.reviewed)-Number(a.reviewed)||score(b)-score(a));
 const storeRows=stores.map(s=>{
  const list=rows.filter(r=>r.storeKey===s.key),sure=list.filter(r=>r.reviewed),check=list.filter(r=>!r.reviewed);
  const saving=round(sure.reduce((n,r)=>n+(r.saving??0),0)),checkSaving=round(check.reduce((n,r)=>n+(r.saving??0),0));
  return {key:s.key,name:s.name,oda:s.oda===true,online:s.online===true,minSavings:s.minSavings??0,count:sure.length,checkCount:check.length,saving,checkSaving,
   worthTrip:s.oda?null:saving>0&&saving>=(s.minSavings??0)};
 }).filter(s=>s.count||s.checkCount).sort((a,b)=>b.saving-a.saving||b.checkSaving-a.checkSaving||a.name.localeCompare(b.name,'nb'));
 // A family's need is bought once, so the headline takes its best store only.
 const perFamily=new Map();
 for(const r of rows)if(r.reviewed&&(r.saving??0)>(perFamily.get(r.watchId)??0))perFamily.set(r.watchId,r.saving);
 const total=round([...perFamily.values()].reduce((n,x)=>n+x,0));
 const minorBest=new Map();
 for(const row of minor){const k=row.storeKey+'|'+row.watchId,prev=minorBest.get(k);if(!best.has(k)&&(!prev||score(row)>score(prev)))minorBest.set(k,row);}
 return {rows,stores:storeRows,minor:[...minorBest.values()].sort((a,b)=>(b.saving??0)-(a.saving??0)||b.discountPct-a.discountPct),covered,total,hidden};
}
