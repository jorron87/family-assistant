// Household stock-up planning. Only an excellent deal targets a full year of the
// known need; a merely good one targets a quarter. Shelf life limits both. Known
// need is a lower bound from documented purchases unless the household stated it.

export const HORIZON_MONTHS=12;
export const GOOD_DEAL_MONTHS=3;
export const TRIP_MONTHS=1;
export const BULK_MIN_DISCOUNT_PCT=8;
export const EXCELLENT_DISCOUNT_PCT=25;
const DAYS_PER_MONTH=30.44,DAY=86400000,STOCK_CHECK_DAYS=90;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;

// Quality-based planning defaults. Each can be overridden per product.
const SHELF_RULES={
 frozen:[[/laks|makrell|ørret|sild/i,3],[/kjøttdeig|karbonade|farse|kjøttkake/i,4],[/pølse|bacon|skinke/i,3],[/brød|baguett|rundstykk|flutes|bolle/i,4],[/gulost|norvegia|(^|[\s-])ost([\s-]|$)/i,6],[/smør|bremykt|margarin/i,9],[/svin/i,6],[/kylling|kalkun/i,9]],
 chilled:[[/grana|parmesan/i,6],[/gulost|norvegia|(^|[\s-])ost([\s-]|$)/i,2],[/bacon|skinke/i,2],[/poteter|løk|gulrøtter|ingefær|hvitløk/i,2],[/egg/i,1],[/laktosefri.*melk/i,1],[/melk|fløte|rømme|yoghurt/i,.5]],
 pantry:[[/nøtt|cashew/i,9]],
 other:[]
};
const SHELF_DEFAULT={frozen:12,chilled:1,pantry:12,other:6};

export function defaultShelfLifeMonths({name='',storage='other'}={}) {
 const rule=(SHELF_RULES[storage]??[]).find(([pattern])=>pattern.test(name));
 return rule?rule[1]:SHELF_DEFAULT[storage]??6;
}
export const shelfLifeMonths=watch=>watch.shelfLifeMonths??defaultShelfLifeMonths(watch);

/** A dated offer, such as short-dated surplus stock, cannot outlast its own date. */
export function shelfWithDate(months,bestBefore,at) {
 if(!bestBefore)return months;
 const left=(Date.parse(bestBefore+'T12:00:00Z')-at)/(DAYS_PER_MONTH*DAY);
 return Math.min(months,left<1?.5:Math.floor(left));
}

/** Yearly amount, in the watch's unit. Null means the need is genuinely unknown. */
export function annualNeed(watch,rows,historyDays,odaShare=1) {
 if(watch.monthlyUsage!=null)return {amount:watch.monthlyUsage*12,basis:'household-estimate'};
 const bought=rows.reduce((sum,row)=>sum+Math.max(0,row.purchasedAmount??0),0);
 // The household can state how much of its shopping the documented store covers.
 const registered=bought>0?bought*365/Math.max(historyDays,90)/odaShare:0;
 if(watch.purchaseAmount!=null&&watch.purchaseAmount>=registered)return {amount:watch.purchaseAmount,basis:'planned-amount'};
 if(registered>0)return {amount:registered,basis:odaShare<1?'oda-share-estimate':'oda-lower-bound'};
 return {amount:null,basis:'offer-pack'};
}

/** Counted stock burned down at the known rate since it was last counted. */
export function estimateStock(watch,monthlyRate,at) {
 if(watch.stockAmount==null||!watch.stockCheckedAt)return {known:false,amount:null,months:null,ageDays:null,needsCheck:false};
 const ageDays=Math.max(0,(at-Date.parse(watch.stockCheckedAt))/DAY);
 const amount=Math.max(0,watch.stockAmount-(monthlyRate??0)*ageDays/DAYS_PER_MONTH);
 return {known:true,amount:round(amount),months:monthlyRate?round(amount/monthlyRate):null,ageDays:Math.floor(ageDays),needsCheck:ageDays>STOCK_CHECK_DAYS};
}

const SAME_PACK=.12;
const samePack=(a,b)=>Math.abs(a-b)<=Math.max(a,b)*SAME_PACK;

/** The pack sizes a household actually thinks in, most bought first. */
export function commonPacks(rows,fallback=[],counted=[]) {
 const groups=[];
 for(const row of rows){
  if(!(row.quantity>0&&row.purchasedAmount>0))continue;
  const amount=row.purchasedAmount/row.quantity,group=groups.find(g=>samePack(g.amount,amount));
  if(group){group.quantity+=row.quantity;if(row.quantity>group.lead){group.lead=row.quantity;group.amount=amount;}}
  else groups.push({amount,quantity:row.quantity,lead:row.quantity});
 }
 const total=groups.reduce((n,g)=>n+g.quantity,0);
 const sizes=groups.filter(g=>g.quantity/total>=.15).sort((a,b)=>b.quantity-a.quantity).slice(0,3).map(g=>Math.round(g.amount*1000)/1000);
 const list=sizes.length?sizes:fallback.slice(0,2);
 const result=list.length?[...list]:[1];
 for(const size of counted)if(size>0&&!result.some(x=>samePack(x,size)))result.push(size);
 return result;
}

/** Counted packs, reduced to what the burned-down amount still covers. */
export function packBreakdown(sizes,counted,amount) {
 if(amount==null)return sizes.map(size=>({amount:size,count:0}));
 if(!counted)return sizes.map((size,index)=>({amount:size,count:index?0:Math.round(amount/size)}));
 let left=amount;const counts=new Map();
 for(const size of [...sizes].sort((a,b)=>b-a)){
  const key=Object.keys(counted).find(k=>samePack(Number(k),size)),have=key?counted[key]:0,count=Math.min(have,Math.floor(left/size+.25));
  counts.set(size,count);left=Math.max(0,left-count*size);
 }
 return sizes.map(size=>({amount:size,count:counts.get(size)}));
}

export function dealTier({unitPrice,excellentPrice,discountPct,referenceType}) {
 if((excellentPrice!=null&&unitPrice<=excellentPrice)||discountPct>=EXCELLENT_DISCOUNT_PCT)return 'excellent';
 if(referenceType==='target')return 'good';
 return discountPct>=BULK_MIN_DISCOUNT_PCT?'good':'small';
}

function packsFor(needed,{packAmount,bundlePacks,cap}) {
 if(needed<=0)return 0;
 // A tiny remainder does not justify another pack; any real need buys at least one.
 const wanted=Math.min(Math.max(1,Math.floor(needed/packAmount+.75)),cap);
 return Math.floor(wanted/bundlePacks)*bundlePacks||(cap>=bundlePacks?bundlePacks:0);
}

/**
 * Quantity choices for one offer. Stock always reduces the need. A pack larger
 * than the whole need stays visible, but only the usable part counts as saved.
 */
export function planQuantities({tier,need,shelfMonths,stock,offer,caps,unitSaving}) {
 const cap=Math.min(...caps.filter(n=>n!=null)),{packAmount,bundlePacks,price}=offer;
 const option=(key,label,months)=>{
  const target=need.amount/12*months,packs=packsFor(target-(stock.amount??0),{packAmount,bundlePacks,cap});
  const amount=round(packs*packAmount),usable=amount>target*1.5?target:amount;
  return {key,label,months,packs,amount,cost:round(price*packs),saving:round(unitSaving*usable)};
 };
 if(need.amount==null){
  const packs=cap>=bundlePacks?bundlePacks:0;
  const single={key:'pack',label:'Tilbudet',months:null,packs,amount:round(packs*packAmount),cost:round(price*packs),saving:round(unitSaving*packs*packAmount)};
  return {options:packs?[single]:[],recommended:packs?single:null,fullMonths:null,covered:false};
 }
 const fullMonths=Math.min(HORIZON_MONTHS,shelfMonths),limit=Math.min(fullMonths,tier==='excellent'?HORIZON_MONTHS:tier==='good'?GOOD_DEAL_MONTHS:TRIP_MONTHS);
 const fullLabel=limit>=HORIZON_MONTHS?'Et helt år':limit<1?'Noen uker':limit===1?'Neste tur':`${limit} mnd`;
 const points=[['trip','Neste tur',Math.min(TRIP_MONTHS,limit)],['quarter','3 mnd',Math.min(3,limit)],['full',fullLabel,limit]];
 const options=[];
 for(const point of points){
  const entry=option(...point);
  if(!entry.packs)continue;
  // The longest label wins when several horizons come to the same number of packs.
  if(options.at(-1)?.packs===entry.packs)options.pop();
  options.push(entry);
 }
 const covered=(stock.amount??0)>=need.amount/12*limit;
 return {options,recommended:options.at(-1)??null,fullMonths:limit,covered};
}

const CHAIN_NAMES={ODA_NO:'Oda',MENY_NO:'MENY',SPAR_NO:'SPAR',EUROPRIS_NO:'Europris',KIWI:'KIWI',REMA_1000:'REMA 1000',COOP_EXTRA:'Extra'};
export const chainName=code=>CHAIN_NAMES[code]??code;
const coverRank=stock=>!stock.known||stock.months==null?1:stock.months<TRIP_MONTHS?1.5:stock.months<3?1.2:.8;
export const dealScore=deal=>(deal.saving??0)*(deal.tier==='excellent'?1.5:deal.tier==='small'?.2:1)*coverRank(deal.stock);
