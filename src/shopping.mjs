import {createHash,randomUUID} from 'node:crypto';
import {validateNutrition,purchaseNutrition} from './shopping-nutrition.mjs';
import {calibrateMarket} from './shopping-market.mjs';
import {createMarketCatalog} from './shopping-catalog.mjs';
import {annualNeed,chainName,commonPacks,dealScore,packsFor,dealTier,defaultShelfLifeMonths,estimateStock,packBreakdown,planQuantities,shelfLifeMonths,shelfWithDate} from './shopping-planning.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const required=(v,label)=>{const s=text(v);if(!s)throw Error(`${label} mangler.`);return s;};
const safeId=(v,label)=>{const s=required(v,label);if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(s)||['__proto__','constructor','prototype'].includes(s))throw Error(`Ugyldig ${label}.`);return s;};
const positive=(v,label,zero=false)=>{const n=Number(v);if(!Number.isFinite(n)||n<0||(!zero&&n===0))throw Error(`Ugyldig ${label}.`);return n;};
export const shoppingDay=(at=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const day=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value??'')||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('Ugyldig dato.');return value;};
const url=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error('Kildelenken må bruke HTTPS.');return u.href;};
export function shoppingMoney(value) {
  if(typeof value==='number'&&Number.isFinite(value))return value;
  const s=String(value??'').replace(/[\s\u00a0\u202f]/g,'').replace(/kr$/i,'').replace(/−/g,'-').replace(',','.');
  if(!/^-?\d+(?:\.\d+)?$/.test(s))throw Error('Ukjent prisformat.');return Number(s);
}
export function packSize(name) {
  const found=[...String(name).matchAll(/(?:^|[\s,])(\d+(?:[.,]\d+)?)\s*(kg|g|ml|dl|l|stk)\b/gi)].at(-1);
  if(!found)return null;
  const n=Number(found[1].replace(',','.')),unit=found[2].toLowerCase();
  return {amount:n*({g:.001,ml:.001,dl:.1}[unit]??1),unit:['kg','g'].includes(unit)?'kg':['ml','dl','l'].includes(unit)?'l':'stk'};
}
const categories=new Set(['Hus og hjem','Hygiene og skjønnhet','Bakeri og konditori','Meieri, ost og egg','Baby og barn','Frukt og grønt','Bakeingredienser','Middager og tilbehør','Kylling og kjøtt','Pålegg','Drikke','Fisk og sjømat','Frokostblandinger og müsli','Sjokolade, snacks og godteri','Iskrem, dessert og kjeks','Blomster og planter','Bursdag og fest']);

// UI capture is a fallback import, with the original text retained privately.
// A name fingerprint is explicitly distinct from an Oda native product ID.
export function parseOdaOrderText(input) {
  const raw=text(input.text,500000),id=safeId(input.orderNumber,'Ordrenummer');
  const sourceUrl=new URL(url(input.sourceUrl));if(sourceUrl.hostname!=='oda.com'||sourceUrl.pathname!==`/no/account/orders/${id}/`)throw Error('Ordrelenken stemmer ikke med Oda-ordren.');
  if(!raw.includes(`Bestilling ${id}`)||!raw.includes('Levert'))throw Error('Ordren må være levert og ha riktig ordrenummer.');
  const start=raw.indexOf('Bestilte varer\n'),end=raw.indexOf('\nBonus\n',start);
  if(start<0||end<0)throw Error('Fant ikke hele varelisten og oppsummeringen.');
  const lines=raw.slice(start+15,end).split('\n').map(s=>s.trim()).filter(Boolean);
  const products=[];let category=null,block=[];
  for(let i=0;i<lines.length;i++) {
    if(categories.has(lines[i])&&!block.length){category=lines[i];continue;}
    if(/^MVA \d+%$/.test(lines[i])) {
      if(!category||block.length<2||i+1>=lines.length)throw Error('Ufullstendig varelinje.');
      const quantity=shoppingMoney(block.at(-1)),name=block[0],amount=shoppingMoney(lines[++i]);
      if(!quantity||quantity*amount<0)throw Error('Ugyldig antall eller beløp i varelinjen.');
      const weight=block.join(' ').match(/Vektvare\s+([\d.]+)\s+kg/);
      const pack=weight?{amount:Number(weight[1])/Math.abs(quantity),unit:'kg'}:packSize(name);
      products.push({productKey:`oda-ui:${hash(name.toLocaleLowerCase('nb-NO'))}`,name,category,quantity,total:amount,pack,promotion:block.slice(1,-1).join(' '),discount:0});block=[];
    }else block.push(lines[i]);
  }
  if(block.length||!products.length)throw Error('Varelisten kunne ikke leses fullstendig.');
  const summary=raw.slice(end).split('\n').map(s=>s.trim()).filter(Boolean);
  let discounts=0,unallocatedDiscount=0;
  for(let i=0;i<summary.length;i++)if(/^[−-]\d[\d\s.,]*\s*kr$/.test(summary[i])) {
    const amount=-shoppingMoney(summary[i]),label=summary[i-1].split(':').at(-1).trim().toLocaleLowerCase('nb-NO');
    discounts+=amount;
    const allocation=input.discountAllocations?.find(x=>x.label===summary[i-1]);
    if(allocation&&(!allocation.evidence||!Array.isArray(allocation.productNames)||!allocation.productNames.length||allocation.productNames.some(name=>!products.some(p=>p.name===name))))throw Error('Rabattfordeling mangler konkret belegg eller kjent vare.');
    let matched=products.filter(p=>p.quantity>0&&(allocation?allocation.productNames.includes(p.name):p.name.toLocaleLowerCase('nb-NO').includes(label)));
    const percent=summary[i-1].match(/^(-\d+%)/)?.[1];
    if(percent&&matched.some(p=>p.promotion.includes(percent)))matched=matched.filter(p=>p.promotion.includes(percent));
    const total=matched.reduce((s,p)=>s+p.total,0);
    if(!total)unallocatedDiscount+=amount;
    else for(const p of matched)p.discount+=amount*p.total/total;
  }
  const totalIndex=summary.indexOf('Total inkl. MVA');
  if(totalIndex<0)throw Error('Ordretotal mangler.');
  const grossAmount=shoppingMoney(summary[totalIndex+1]);
  const fees=['Levering','Leveringsemballasje','Pant'].reduce((s,label)=>{const i=summary.indexOf(label);return s+(i>=0?shoppingMoney(summary[i+1]):0);},0);
  const productAmount=products.reduce((s,p)=>s+p.total,0)-discounts;
  if(Math.abs(productAmount+fees-grossAmount)>.1)throw Error(`Varelinjer, rabatter og gebyrer stemmer ikke med ordretotalen (${id}: ${round(productAmount+fees)} mot ${grossAmount}).`);
  return {orderNumber:id,deliveryDate:day(input.deliveryDate),currency:'NOK',grossAmount,productAmount:round(productAmount),fees:round(fees),discounts:round(discounts),unallocatedDiscount:round(unallocatedDiscount),sourceUrl:url(input.sourceUrl),source:'oda-ui',originalText:raw,products:products.map(p=>({...p,netTotal:round(p.total-p.discount),baselineEligible:unallocatedDiscount<.01}))};
}
export function normalizeOdaOrder(input) {
  if(input.currency!=='NOK')throw Error('Bare NOK støttes.');
  if(!Array.isArray(input.products)||!input.products.length)throw Error('Ordren mangler varelinjer.');
  const products=input.products.map(line=>{
    const p=line.product;if(!Number.isSafeInteger(p?.id)||p.id<1)throw Error('Oda-produktet mangler native ID.');
    const quantity=shoppingMoney(line.quantity),total=shoppingMoney(line.totalGrossAmount);
    if(!quantity||quantity*total<0)throw Error('Ugyldig ordrelinje.');
    return {productKey:`oda:${p.id}`,odaProductId:p.id,name:required(p.name,'Varenavn'),category:text(line.category)||'Uklassifisert',quantity,total,netTotal:total,pack:packSize(p.description),baselineEligible:input.linePricesVerified===true};
  });
  // MCP documents products as excluding order-level discounts and fees.
  // Do not call these historical net prices without reconciliation evidence.
  return {orderNumber:safeId(input.orderNumber,'Ordrenummer'),deliveryDate:day(input.deliveryDate),currency:'NOK',grossAmount:positive(input.grossAmount,'ordretotal',true),productAmount:round(products.reduce((s,p)=>s+p.total,0)),fees:null,discounts:null,unallocatedDiscount:null,source:'oda-mcp',products};
}

export function shoppingStore(state,{save,now=()=>new Date()}={}) {
  state.shopping??={orders:{},watches:{},offers:{},reviews:{},cartReceipts:{},settings:{monitoringEnabled:false,historyFrom:null,stores:[],storageNote:'',stockUpDays:60}};
  const s=state.shopping;
  s.nutrition??={};
  s.marketCatalog??={};
  s.dealDecisions??={};
  s.purchases??=[];
  s.priceHistory??={};
  s.productLinks??={};
  s.feedReviewed??={};
  s.shoppingList??=[];
  const catalog=createMarketCatalog(s.marketCatalog,{save,now});
  const orders=()=>Object.values(s.orders);
  const update=fn=>{const result=fn();save();return structuredClone(result);};
  const needRows=(w,a)=>a.products.filter(p=>w.productKeys.includes(p.productKey)&&p.unit===w.unit);
  const needOf=(w,a)=>annualNeed(w,needRows(w,a),a.days,s.settings.odaShare??1);
  const rateOf=need=>need.amount==null?null:need.amount/12;
  const addCounted=(w,size,count)=>{const key=String(Math.round(size*1000)/1000);w.stockPacks[key]=(w.stockPacks[key]??0)+count;};
  // A delivered order refills counted stock; uncounted stock stays unknown.
  function receiveOrder(order,a) {
    for(const w of Object.values(s.watches)){
      if(w.stockAmount==null||!w.stockCheckedAt||order.deliveryDate<w.stockCheckedAt.slice(0,10))continue;
      const added=order.products.filter(p=>w.productKeys.includes(p.productKey)&&p.pack?.unit===w.unit).reduce((sum,p)=>sum+p.quantity*p.pack.amount,0);
      if(added<=0)continue;
      const stock=estimateStock(w,rateOf(needOf(w,a)),now().getTime());
      w.stockAmount=round(stock.amount+added);w.stockCheckedAt=now().toISOString();
      if(w.stockPacks)for(const p of order.products)if(w.productKeys.includes(p.productKey)&&p.pack?.unit===w.unit)addCounted(w,p.pack.amount,p.quantity);
    }
  }
  function importOrders(input) {
    if(!Array.isArray(input.orders)||!input.orders.length||input.orders.length>1000)throw Error('Oppgi 1–1000 ordre.');
    const entries=input.orders.map(o=>o.text?parseOdaOrderText(o):normalizeOdaOrder(o));
    return update(()=>{const fresh=entries.filter(order=>!s.orders[order.orderNumber]);for(const order of entries)s.orders[order.orderNumber]={...order,importedAt:now().toISOString()};if(fresh.length){const a=analysis();for(const order of fresh)receiveOrder(order,a);}return {imported:entries.length,total:orders().length};});
  }
  function settings(input) {
    const next={...s.settings};
    if(input.historyFrom!==undefined)next.historyFrom=day(input.historyFrom);
    if(input.monitoringEnabled!==undefined){if(typeof input.monitoringEnabled!=='boolean')throw Error('Ugyldig overvåkningsvalg.');next.monitoringEnabled=input.monitoringEnabled;}
    if(input.odaShare!==undefined){const share=input.odaShare===null?1:Number(input.odaShare);if(!Number.isFinite(share)||share<.1||share>1)throw Error('Oda-andelen må være mellom 0,1 og 1.');next.odaShare=share;}
    if(input.storageNote!==undefined)next.storageNote=text(input.storageNote,1500);
    if(input.stockUpDays!==undefined)next.stockUpDays=Math.min(365,positive(input.stockUpDays,'lagerhorisont'));
    if(input.stores!==undefined){if(!Array.isArray(input.stores)||input.stores.length>50)throw Error('Ugyldig butikkliste.');next.stores=input.stores.map(x=>({id:safeId(x.id,'Butikk-ID'),name:required(x.name,'Butikk'),url:url(x.url),minSavings:positive(x.minSavings??50,'minste besparelse',true),memberEligible:x.memberEligible===true,pricesIncludeVat:x.pricesIncludeVat!==false,chainCode:x.chainCode==null?null:safeId(x.chainCode,'Kjedekode'),facebookGroup:x.facebookGroup==null?null:safeId(x.facebookGroup,'Facebook-gruppe')}));if(new Set(next.stores.map(x=>x.id)).size!==next.stores.length)throw Error('Butikk-ID må være unik.');}
    return update(()=>s.settings=next);
  }
  function watch(input) {
    const id=input.id===undefined?randomUUID():safeId(input.id,'overvåknings-ID');
    const next={id,name:required(input.name,'Varenavn'),enabled:input.enabled!==false,productKeys:[...new Set(input.productKeys??[])],unit:input.unit,storage:input.storage,maxPacks:positive(input.maxPacks??100,'maks antall'),monthlyUsage:input.monthlyUsage==null?null:positive(input.monthlyUsage,'samlet månedsforbruk'),minDiscountPct:positive(input.minDiscountPct??0,'minste rabatt',true),targetPrice:input.targetPrice==null?null:positive(input.targetPrice,'målpris'),stockAmount:input.stockAmount==null?null:positive(input.stockAmount,'lagerbeholdning',true),stockCheckedAt:input.stockAmount==null?null:now().toISOString(),note:text(input.note,1000)};
    next.purchaseAmount=input.purchaseAmount==null?null:positive(input.purchaseAmount,'planlagt innkjøpsmengde');
    next.excellentPrice=input.excellentPrice==null?null:positive(input.excellentPrice,'svært bra pris');
    if(next.excellentPrice!==null&&(next.targetPrice===null||next.excellentPrice>next.targetPrice))throw Error('Svært bra pris må være lik eller lavere enn målprisen.');
    next.priceGuide=null;
    next.marketCalibration=s.watches[id]?.marketCalibration??null;
    next.catalogManaged=s.watches[id]?.catalogManaged===true;
    if(input.priceGuide!=null){const g=input.priceGuide;next.priceGuide={referencePrice:g.referencePrice==null?null:positive(g.referencePrice,'prisguidens referanse'),checkedAt:g.checkedAt,evidence:required(g.evidence,'prisguidens grunnlag')};if(!Number.isFinite(Date.parse(g.checkedAt))||Date.parse(g.checkedAt)>now().getTime()+60000)throw Error('Ugyldig kontrolltid for prisguide.');}
    next.referenceCeiling=null;
    if(input.referenceCeiling!=null){const r=input.referenceCeiling;next.referenceCeiling={price:positive(r.price,'aktuell alternativpris'),checkedAt:r.checkedAt,sourceUrl:url(r.sourceUrl),evidence:required(r.evidence,'alternativprisens kildebelegg')};if(!Number.isFinite(Date.parse(r.checkedAt))||Date.parse(r.checkedAt)>now().getTime()+60000)throw Error('Ugyldig kontrolltid for alternativpris.');}
    next.shelfLifeMonths=input.shelfLifeMonths==null?null:positive(input.shelfLifeMonths,'holdbarhet');
    if(next.shelfLifeMonths!==null&&next.shelfLifeMonths>24)throw Error('Ugyldig holdbarhet.');
    next.manualLimits=(input.manualLimits??s.watches[id]?.manualLimits)===true;
    next.stockPacks=s.watches[id]?.stockPacks??null;
    if(next.purchaseAmount!==null&&next.monthlyUsage!==null)throw Error('Planlagt mengde kan ikke kombineres med månedsforbruk.');
    if(!['kg','l','stk'].includes(next.unit)||!['frozen','pantry','chilled','other'].includes(next.storage)||!Number.isInteger(next.maxPacks)||next.minDiscountPct>100||next.productKeys.some(k=>typeof k!=='string'||k.length>200))throw Error('Ugyldig overvåkning.');
    if(s.watches[id]?.stockAmount===next.stockAmount&&input.stockConfirmed!==true)next.stockCheckedAt=s.watches[id].stockCheckedAt;
    return update(()=>s.watches[id]=next);
  }
  function offer(input) {
    const watch=s.watches[input.watchId];if(!watch)throw Error('Ukjent overvåkning.');
    const store=s.settings.stores.find(x=>x.id===input.storeId);if(!store)throw Error('Butikken er ikke valgt.');
    const entry={id:hash(`${required(input.storeId,'Butikk')}\0${required(input.externalId,'Tilbuds-ID')}`),externalId:input.externalId,storeId:input.storeId,watchId:watch.id,name:required(input.name,'Varenavn'),price:positive(input.price,'tilbudspris'),packAmount:positive(input.packAmount,'pakningsmengde'),unit:input.unit,validFrom:day(input.validFrom),validTo:day(input.validTo),observedAt:input.observedAt??now().toISOString(),sourceUrl:url(input.sourceUrl),evidence:required(input.evidence,'Kildebelegg'),conditions:text(input.conditions,1000),memberOnly:input.memberOnly===true,bestBefore:input.bestBefore==null?null:day(input.bestBefore),maxPacks:input.maxPacks==null?null:positive(input.maxPacks,'maks kundeantall'),bundlePacks:positive(input.bundlePacks??1,'antall i pakketilbud'),comparable:input.comparable===true,comparisonNote:required(input.comparisonNote,'Sammenligningsgrunnlag')};
    if(entry.unit!==watch.unit||entry.validTo<entry.validFrom||!Number.isFinite(Date.parse(entry.observedAt))||Date.parse(entry.observedAt)>now().getTime()+60000||!Number.isInteger(entry.bundlePacks)||(entry.maxPacks!==null&&!Number.isInteger(entry.maxPacks)))throw Error('Ugyldig tilbudsperiode, mengde eller observasjon.');
    entry.quotedPriceIncludesVat=input.priceIncludesVat??store.pricesIncludeVat??true;
    if(typeof entry.quotedPriceIncludesVat!=='boolean')throw Error('Momsgrunnlag må oppgis som true eller false.');
    if(!entry.quotedPriceIncludesVat){const rate=positive(input.vatRate,'momssats');if(rate>1)throw Error('Oppgi momssats som andel, for eksempel 0.15.');entry.priceBeforeVat=entry.price;entry.vatRate=rate;entry.price=round(entry.price*(1+rate));}
    entry.priceIncludesVat=true;
    return update(()=>s.offers[entry.id]=entry);
  }
  function review(input) {
    if(!s.settings.stores.some(x=>x.id===input.storeId)||!['ok','blocked'].includes(input.status))throw Error('Ugyldig butikkontroll.');
    const entry={storeId:input.storeId,status:input.status,checkedAt:now().toISOString(),evidence:required(input.evidence,'Kontrollbelegg'),sourceUrl:url(input.sourceUrl),nextCheck:day(input.nextCheck)};
    if(entry.nextCheck<=shoppingDay(now()))throw Error('Neste kontroll må være i fremtiden.');
    return update(()=>s.reviews[entry.storeId]=entry);
  }
  function analysis() {
    const today=shoppingDay(now()),from=s.settings.historyFrom??`${Number(today.slice(0,4))-1}${today.slice(4)}`;
    const selected=orders().filter(o=>o.deliveryDate>=from&&o.deliveryDate<=today);
    const byProduct=new Map(),byCategory=new Map();
    for(const order of selected)for(const p of order.products){
      const row=byProduct.get(p.productKey)??{productKey:p.productKey,odaProductId:p.odaProductId??null,name:p.name,category:p.category,spent:0,quantity:0,orderIds:new Set(),orderAmounts:{},baselineTotal:0,baselineAmount:0,purchasedAmount:0,unit:p.pack?.unit??null};
      row.spent+=p.netTotal;row.quantity+=p.quantity;row.orderIds.add(order.orderNumber);
      // Amounts bought are known even when the line price cannot be a savings baseline.
      if(p.pack)row.purchasedAmount+=p.quantity*p.pack.amount;
      if(p.baselineEligible&&p.pack){row.baselineTotal+=p.netTotal;row.baselineAmount+=p.quantity*p.pack.amount;row.orderAmounts[order.orderNumber]=(row.orderAmounts[order.orderNumber]??0)+p.quantity*p.pack.amount;}
      byProduct.set(p.productKey,row);byCategory.set(p.category,(byCategory.get(p.category)??0)+p.netTotal);
    }
    const products=[...byProduct.values()].map(p=>({...p,spent:round(p.spent),quantity:round(p.quantity),orders:p.orderIds.size,orderIds:undefined,baselineUnitPrice:p.baselineAmount>0?round(p.baselineTotal/p.baselineAmount):null})).sort((a,b)=>b.spent-a.spent);
    return {from,to:today,days:Math.max(1,(Date.parse(today)-Date.parse(from))/86400000+1),orderCount:selected.length,orderTotal:round(selected.reduce((n,o)=>n+o.grossAmount,0)),productTotal:round(selected.reduce((n,o)=>n+o.productAmount,0)),unallocatedDiscount:round(selected.reduce((n,o)=>n+(o.unallocatedDiscount??0),0)),categories:[...byCategory].map(([name,amount])=>({name,amount:round(amount)})).sort((a,b)=>b.amount-a.amount),products,orders:selected.map(({orderNumber,deliveryDate,grossAmount,sourceUrl,source,fees,discounts})=>({orderNumber,deliveryDate,grossAmount,sourceUrl,source,fees,discounts}))};
  }
  const offerFingerprint=o=>`${o.price}|${o.packAmount}|${o.validTo}`;
  function deals(a=analysis()) {
    const at=now().getTime(),today=shoppingDay(now()),horizon=shoppingDay(new Date(at+7*86400000)),result=[],covered=[],held=[];
    const approvedWatches=new Set(catalog.entries().filter(p=>p.status==='approved').map(p=>p.watchId));
    const fresh=time=>at-Date.parse(time)<=48*3600000;
    for(const o of Object.values(s.offers)) {
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId);
      if(!w||w.enabled===false||!store||!o.comparable||o.validFrom>horizon||o.validTo<today||!fresh(o.observedAt))continue;
      const decision=s.dealDecisions[o.id];
      if(decision&&decision.fingerprint===offerFingerprint(o))continue;
      const hold=reason=>held.push({offerId:o.id,watchId:w.id,watchName:w.name,storeName:store.name,name:o.name,reason});
      if(o.memberOnly&&!store.memberEligible){hold('member');continue;}
      if(w.marketCalibration?.status==='needs-review'){hold('needs-review');continue;}
      if(w.catalogManaged&&!approvedWatches.has(w.id)){hold('needs-review');continue;}
      const rows=a.products.filter(p=>w.productKeys.includes(p.productKey)&&p.unit===w.unit&&p.baselineAmount>0);
      const amount=rows.reduce((n,p)=>n+p.baselineAmount,0);
      const market=w.marketCalibration?.status==='ready'?w.marketCalibration:null;
      // One stale SKU must not hide a group; a wholly stale group is reported.
      const freshProducts=market?.products.filter(p=>fresh(p.lastChecked))??[];
      if(market&&!freshProducts.length){hold('stale-prices');continue;}
      const ceiling=w.referenceCeiling;
      if(ceiling&&!fresh(ceiling.checkedAt)){hold('stale-prices');continue;}
      const paidReference=amount>0?Math.min(...rows.map(p=>p.baselineTotal/p.baselineAmount)):null;
      // Compare a campaign with other chains, so its own current price does not
      // erase the saving. Without a reviewed chain mapping, use all alternatives.
      const alternatives=freshProducts.filter(p=>!store.chainCode||p.store!==store.chainCode).map(p=>p.currentUnitPrice).filter(p=>Number.isFinite(p)&&p>0);
      const marketReference=market?Math.min(market.referencePrice,paidReference??Infinity,...alternatives):null;
      const reference=marketReference!==null?Math.min(marketReference,ceiling?.price??Infinity):ceiling?Math.min(paidReference??Infinity,ceiling.price):paidReference??w.targetPrice;if(!reference)continue;
      const alternative=!!ceiling&&(paidReference===null||ceiling.price<paidReference);
      const unitPrice=o.price/o.packAmount,discountPct=(reference-unitPrice)/reference*100;
      if(discountPct<w.minDiscountPct||(w.targetPrice!==null&&unitPrice>w.targetPrice))continue;
      const referenceType=market?'market':alternative?'alternative':amount>0?'paid':'target';
      const need=needOf(w,a),stock=estimateStock(w,rateOf(need),at),shelfMonths=shelfWithDate(shelfLifeMonths(w),o.bestBefore,at);
      const tier=dealTier({unitPrice,excellentPrice:w.excellentPrice,discountPct,referenceType});
      const hasSaving=amount>0||alternative||!!market;
      if(hasSaving&&reference<=unitPrice)continue;
      const plan=planQuantities({tier,need,shelfMonths,stock,offer:o,caps:[w.maxPacks,o.maxPacks],unitSaving:Math.max(0,reference-unitPrice)});
      const history=Object.values(s.priceHistory[w.id]??{});
      const deal={...o,watchName:w.name,storeName:store.name,unitPrice:round(unitPrice),referencePrice:round(reference),referenceType,referenceSourceUrl:market?'https://kassal.app/api':alternative?ceiling.sourceUrl:null,discountPct:round(discountPct),tier,storage:w.storage,quantityBasis:need.basis,annualAmount:need.amount===null?null:round(need.amount),shelfMonths,fullMonths:plan.fullMonths,stock,checkStock:!stock.known||stock.needsCheck,lowestSeen:history.length>=30&&unitPrice<=Math.min(...history)};
      if(plan.covered){covered.push({...deal,saving:null,packs:0,options:[]});continue;}
      if(!plan.recommended||(hasSaving&&plan.recommended.saving<=0))continue;
      const options=plan.options.map(x=>({...x,saving:hasSaving?x.saving:null}));
      result.push({...deal,bulk:plan.recommended.months>1,packs:plan.recommended.packs,recommendedKey:plan.recommended.key,saving:hasSaving?plan.recommended.saving:null,options});
    }
    const best=new Map();for(const o of result){const key=o.storeId+':'+o.watchId,previous=best.get(key);if(!previous||(o.saving??0)>(previous.saving??0)||((o.saving??0)===(previous.saving??0)&&o.unitPrice<previous.unitPrice))best.set(key,o);}
    const candidates=[...best.values()];
    const totals=new Map();for(const o of candidates)totals.set(o.storeId,(totals.get(o.storeId)??0)+(o.saving??0));
    const worthTrip=o=>o.referenceType==='target'||totals.get(o.storeId)>=s.settings.stores.find(x=>x.id===o.storeId).minSavings;
    const opportunities=candidates.filter(worthTrip).sort((x,y)=>dealScore(y)-dealScore(x));
    return {opportunities,belowTrip:candidates.filter(o=>!worthTrip(o)).sort((x,y)=>dealScore(y)-dealScore(x)),covered,held};
  }
  function unlinkedOrderLines() {
    const linked=new Set(Object.values(s.watches).flatMap(w=>w.productKeys)),found=new Map();
    for(const order of orders())if(order.source==='oda-mcp')for(const p of order.products)if(!linked.has(p.productKey)&&!s.productLinks[p.productKey])found.set(p.productKey,{do:'shopping-order-link',productKey:p.productKey,name:p.name,unit:p.pack?.unit??null});
    return [...found.values()];
  }
  // Seller posts in community buying groups are collected like other Facebook
  // sources, but they stay out of family activities and only feed offer review.
  const feedPosts=storeId=>Object.values(state.collector?.items??{}).filter(item=>item.shoppingStoreId===storeId&&item.kind==='post');
  const feedUnread=storeId=>{const seen=s.feedReviewed[storeId]??{},cutoff=now().getTime()-21*86400000;return feedPosts(storeId).filter(item=>seen[item.externalId]!==item.token&&(!item.postedAt||Date.parse(item.postedAt)>=cutoff));};
  function feedWork() {
    return s.settings.stores.filter(x=>x.facebookGroup).flatMap(x=>{const unread=feedUnread(x.id).length;return unread?[{do:'shopping-feed-review',storeId:x.id,name:x.name,unread}]:[];});
  }
  function feed(input) {
    const store=s.settings.stores.find(x=>x.id===input.storeId&&x.facebookGroup);if(!store)throw Error('Ukjent gruppekilde.');
    const items=feedUnread(store.id);
    if(input.ack!==true)return structuredClone(items.map(({externalId,url,author,text:body,postedAt,attachments,comments,token})=>({externalId,url,author,text:body,postedAt,attachments,comments,token})));
    const evidence=required(input.evidence,'Kontrollbelegg');
    return update(()=>{const seen=s.feedReviewed[store.id]??={};for(const item of items)seen[item.externalId]=item.token;s.reviews[store.id]={storeId:store.id,status:'ok',checkedAt:now().toISOString(),evidence,sourceUrl:store.url,nextCheck:shoppingDay(new Date(now().getTime()+86400000))};return {reviewed:items.length};});
  }
  function marketRefreshDue(today) {
    const calibrated=Object.values(s.watches).filter(w=>w.enabled!==false&&w.marketCalibration?.checkedAt);
    if(!calibrated.length)return [];
    const newest=calibrated.map(w=>w.marketCalibration.checkedAt).sort().at(-1);
    return shoppingDay(new Date(newest))===today?[]:[{do:'shopping-market-refresh',groups:calibrated.length,lastCheckedAt:newest}];
  }
  function queue() {
    if(!s.settings.monitoringEnabled)return [];
    const today=shoppingDay(now());
    return [...catalog.pending().filter(p=>s.watches[p.watchId]?.enabled!==false).map(p=>({do:'shopping-product-review',watchId:p.watchId,watchName:s.watches[p.watchId]?.name,productId:p.id,store:p.store,name:p.name,fingerprint:p.fingerprint,sourceUrl:p.sourceUrl})),...feedWork(),...s.settings.stores.filter(x=>!x.facebookGroup&&(!s.reviews[x.id]||s.reviews[x.id].nextCheck<=today)).map(x=>({do:'shopping-review',storeId:x.id,name:x.name,url:x.url,lastReview:s.reviews[x.id]??null})),...marketRefreshDue(today),...unlinkedOrderLines()];
  }
  function catalogObserve(input){
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent overvåkning.');
    const result=catalog.observe(input);w.catalogManaged=true;
    const pending=catalog.pending().filter(p=>p.watchId===w.id);
    if(w.marketCalibration?.status==='ready'&&pending.some(p=>w.marketCalibration.products.some(old=>String(old.id)===String(p.id)&&old.store===p.store)))w.marketCalibration={...w.marketCalibration,status:'needs-review'};
    save();return result;
  }
  function catalogReview(input){
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent overvåkning.');
    if(input.status==='approved'&&input.unit!==w.unit)throw Error('Katalogens enhet stemmer ikke med overvåkningen.');
    const entry=catalog.review(input);
    if(w.marketCalibration?.status==='ready'&&w.marketCalibration.products.some(p=>String(p.id)===entry.id&&p.store===entry.store)){w.marketCalibration={...w.marketCalibration,status:'needs-review'};save();}
    return entry;
  }
  function nutrition(input){const entry=validateNutrition(input);if(!orders().some(o=>o.products.some(p=>p.productKey===entry.productKey)))throw Error('Ukjent produkt.');return update(()=>s.nutrition[entry.productKey]=entry);}
  function market(input){
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent overvåkning.');
    if(!Array.isArray(input.products)||input.products.length>500||input.products.some(p=>p.reviewed===true&&!text(p.equivalenceEvidence)))throw Error('Markedsprodukter krever konkret sammenligningsbelegg.');
    const days=input.windowDays??90;if(!Number.isInteger(days)||days<1||days>90)throw Error('Markedsvindu må være1–90 dager.');
    const approved=new Map(catalog.entries(w.id).filter(p=>p.status==='approved').map(p=>[`${p.store}\0${p.id}`,p]));
    const products=input.products.map(p=>{
      if(!w.catalogManaged)return p;
      const entry=approved.get(`${p.store}\0${p.id}`);
      return {...p,reviewed:p.reviewed===true&&!!entry&&entry.packAmount===p.packAmount&&entry.unit===p.unit,equivalenceEvidence:entry?.equivalenceEvidence??p.equivalenceEvidence};
    });
    const result=calibrateMarket({unit:w.unit,products,now:now(),windowDays:days});
    const ceiling=w.referenceCeiling;
    if(result.status==='ready'&&ceiling&&now().getTime()-Date.parse(ceiling.checkedAt)<=48*3600000&&ceiling.price<result.goodPrice){
      result.goodPrice=ceiling.price;
      if(result.excellentPrice!==null&&result.excellentPrice>=result.goodPrice*.98)result.excellentPrice=null;
      result.verifiedCurrentAlternative=structuredClone(ceiling);
      result.warnings.push('lower-verified-current-alternative');
    }
    return update(()=>{
      const {dailyBest,rejectedObservations,...summary}=result;
      const series=s.priceHistory[w.id]??={};
      for(const point of dailyBest)series[point.day]=point.price;
      const oldest=shoppingDay(new Date(now().getTime()-400*86400000));
      for(const day of Object.keys(series))if(day<oldest)delete series[day];
      w.marketCalibration={...summary,rejectedObservationCount:rejectedObservations.length};
      if(result.status==='ready'){
        // A limit the family set by hand survives the daily recalibration.
        if(!w.manualLimits){w.targetPrice=result.goodPrice;w.excellentPrice=result.excellentPrice;}
        w.priceGuide={referencePrice:result.referencePrice,checkedAt:result.checkedAt,evidence:`Kassal-markedshistorikk: ${result.coverage.observedDays} observerte dager, ${result.coverage.chainCount} kjeder, ${result.coverage.products} gjennomgåtte produkt/kjede-koblinger. Normalreferanse er median av dagens billigste sammenlignbare kjedepris i historikken. Bra kjøp er nedre kvartil, begrenset av faktisk aktuell markedspris. Svært bra krever gjentatt/vedvarende lavpris. Ingen utfylling av manglende dager. ${result.warnings.join(', ')}`};
        // A fresh reviewed market alternative may supersede a dearer legacy ceiling.
        if(w.referenceCeiling&&result.currentBestPrice<=w.referenceCeiling.price)w.referenceCeiling=null;
      }
      return {watchId:w.id,...result};
    });
  }
  function offerCounts() {
    const today=shoppingDay(now()),current=Object.values(s.offers).filter(o=>o.validTo>=today),byStore={};
    for(const o of current){const entry=byStore[o.storeId]??={comparable:0,notComparable:0};entry[o.comparable?'comparable':'notComparable']++;}
    return {current:current.length,byStore};
  }
  // The price table an agent holds each flyer page against. Keep it complete: the
  // server, not the reader, decides what is worth a trip or how much to buy.
  function checklist() {
    const a=analysis(),at=now().getTime();
    return Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>itemView(w,a,at)).map(({id,name,unit,storage,prices})=>({watchId:id,name,unit,storage,normal:prices.normal,good:prices.good,excellent:prices.excellent,cheapestNow:prices.current,chain:prices.currentChain}));
  }
  function view() {const a=analysis(),entries=catalog.entries(),found=deals(a);return {settings:structuredClone(s.settings),analysis:a,nutrition:purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),s.nutrition),watches:structuredClone(Object.values(s.watches)),opportunities:found.opportunities,belowTripOffers:found.belowTrip,coveredOffers:found.covered,heldOffers:found.held,offerCounts:offerCounts(),reviews:structuredClone(Object.values(s.reviews)),queue:queue(),purchases:structuredClone(s.purchases),catalog:{total:entries.length,pending:entries.filter(p=>p.status==='pending').length,approved:entries.filter(p=>p.status==='approved').length,excluded:entries.filter(p=>p.status==='excluded').length}};}
  function catalogPackMap() {
    const byWatch=new Map();
    for(const e of catalog.entries())if(e.status==='approved'&&e.packAmount){const sizes=byWatch.get(e.watchId)??new Map();sizes.set(e.packAmount,(sizes.get(e.packAmount)??0)+1);byWatch.set(e.watchId,sizes);}
    return new Map([...byWatch].map(([id,sizes])=>[id,[...sizes].sort((x,y)=>y[1]-x[1]).map(([size])=>size)]));
  }
  function itemView(w,a,at,catalogPacks=new Map(),offerLow=new Map()) {
    const need=needOf(w,a),rate=rateOf(need),stock=estimateStock(w,rate,at),market=w.marketCalibration,rows=needRows(w,a);
    const normal=w.priceGuide?.referencePrice??null,freshProducts=market?.status==='ready'?market.products.filter(p=>at-Date.parse(p.lastChecked)<=48*3600000):[];
    const cheapest=[...freshProducts].sort((x,y)=>x.currentUnitPrice-y.currentUnitPrice)[0]??null;
    const history=Object.values(s.priceHistory[w.id]??{}),offer=offerLow.get(w.id);
    const offerWins=!!offer&&(!cheapest||offer.unitPrice<cheapest.currentUnitPrice);
    // "Good" must be a real step below normal, or the guide just repeats itself.
    const good=normal&&w.targetPrice?round(Math.min(w.targetPrice,normal*.92)):w.targetPrice;
    const chains=market?.coverage?.chainCount;
    const basis=market?.status==='ready'?market.coverage.observedDays+' dager med priser fra '+chains+(chains===1?' kjede':' kjeder'):market?.status==='needs-review'?'En vare er endret og sjekkes på nytt':w.priceGuide?'Foreløpig, ut fra det dere har betalt':w.targetPrice?'Egen prisgrense':'For lite prisdata ennå';
    const sizes=commonPacks(rows,catalogPacks.get(w.id)??[],Object.keys(w.stockPacks??{}).map(Number));
    return {packs:packBreakdown(sizes,stock.known?w.stockPacks??null:null,stock.amount),id:w.id,name:w.name,unit:w.unit,storage:w.storage,enabled:w.enabled!==false,manualLimits:w.manualLimits===true,annualAmount:need.amount===null?null:round(need.amount),annualBasis:need.basis,shelfLifeMonths:shelfLifeMonths(w),shelfCustom:w.shelfLifeMonths!=null,shelfDefault:defaultShelfLifeMonths(w),stock,spent:round(rows.reduce((n,p)=>n+p.spent,0)),prices:{normal,good,excellent:w.excellentPrice,targetPrice:w.targetPrice,current:offerWins?offer.unitPrice:cheapest?.currentUnitPrice??null,currentChain:offerWins?offer.storeName.replace(/\s*\(nettbutikk\)$/i,' (+ frakt)'):cheapest?chainName(cheapest.store):null,lowestSeen:history.length>=30?Math.min(...history):null,historyDays:history.length,basis}};
  }
  const summaryOf=main=>({dealCount:main.length,excellentCount:main.filter(d=>d.tier==='excellent').length,potential:round(main.reduce((n,d)=>n+(d.saving??0),0)),top:main[0]?.watchName??null});
  function familyView() {
    const a=analysis(),at=now().getTime(),today=shoppingDay(now()),year=today.slice(0,4),found=deals(a);
    const onList=new Set(listOpen().map(x=>x.offerId));
    const pick=d=>({onList:onList.has(d.id),evidence:d.evidence,bestBefore:d.bestBefore,offerId:d.id,watchId:d.watchId,watchName:d.watchName,storeId:d.storeId,storeName:d.storeName,name:d.name,tier:d.tier,lowestSeen:d.lowestSeen,unit:d.unit,price:d.price,unitPrice:d.unitPrice,referencePrice:d.referencePrice,referenceType:d.referenceType,discountPct:d.discountPct,packAmount:d.packAmount,bundlePacks:d.bundlePacks,maxPacks:d.maxPacks,validFrom:d.validFrom,validTo:d.validTo,memberOnly:d.memberOnly,conditions:d.conditions,comparisonNote:d.comparisonNote,sourceUrl:d.sourceUrl,storage:d.storage,annualAmount:d.annualAmount,quantityBasis:d.quantityBasis,shelfMonths:d.shelfMonths,fullMonths:d.fullMonths,stock:d.stock,saving:d.saving,recommendedKey:d.recommendedKey,options:d.options});
    const byWatch=new Map();for(const d of found.opportunities){const list=byWatch.get(d.watchId)??[];list.push(d);byWatch.set(d.watchId,list);}
    const primary=[...byWatch.values()].map(list=>({...pick(list[0]),alsoAt:list.slice(1).map(x=>({storeName:x.storeName,unitPrice:x.unitPrice}))}));
    const main=primary.filter(d=>d.tier!=='small'),small=primary.filter(d=>d.tier==='small');
    const offerLow=new Map();for(const d of [...found.opportunities,...found.belowTrip,...found.covered])if(d.validFrom<=today&&(!offerLow.has(d.watchId)||d.unitPrice<offerLow.get(d.watchId).unitPrice))offerLow.set(d.watchId,d);
    const catalogPacks=catalogPackMap(),items=Object.values(s.watches).map(w=>itemView(w,a,at,catalogPacks,offerLow)).sort((x,y)=>y.spent-x.spent);
    const reviews=Object.values(s.reviews);
    const stores=s.settings.stores.map(x=>{const r=reviews.find(y=>y.storeId===x.id);return {id:x.id,name:x.name,status:r?.status??'unchecked',checkedAt:r?.checkedAt??null};});
    const n=purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),s.nutrition);
    const sum=list=>round(list.reduce((x,p)=>x+(p.saving??0),0));
    const body={list:listView(today),odaDraft:odaDraft(a,today,at),monitoring:s.settings.monitoringEnabled===true,today,deals:main,smallDeals:small,belowTrip:found.belowTrip.map(d=>({...pick(d),alsoAt:[]})),covered:found.covered.map(pick),held:found.held,items,purchases:s.purchases.slice().reverse().slice(0,30).map(({previousStock,...p})=>p),saved:{year:sum(s.purchases.filter(p=>p.at.slice(0,4)===year)),all:sum(s.purchases)},stores,storesCheckedToday:stores.filter(x=>x.status==='ok'&&x.checkedAt&&shoppingDay(new Date(x.checkedAt))===today).length,analysis:{orderCount:a.orderCount,from:a.from,to:a.to,orderTotal:a.orderTotal,categories:a.categories,top:a.products.slice(0,15).map(p=>({name:p.name,spent:p.spent,orders:p.orders}))},nutrition:{spendPct:n.coverage.spendPct}};
    return {...body,rev:hash(JSON.stringify(body)),summary:summaryOf(main)};
  }
  function offerSource(id){const o=s.offers[id];if(!o)throw Error('Tilbudet finnes ikke lenger.');return {sourceUrl:o.sourceUrl,evidence:o.evidence};}
  function familySummary(){const f=familyView();return {rev:f.rev,...f.summary};}
  function pantry(input) {
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent vare.');
    let amount,packs=null;
    if(Array.isArray(input.packs)){
      if(!input.packs.length||input.packs.length>10)throw Error('Ugyldig pakkeliste.');
      packs={};amount=0;
      for(const p of input.packs){const size=positive(p.amount,'pakningsstørrelse'),count=Number(p.count);if(!Number.isInteger(count)||count<0||count>9999)throw Error('Ugyldig antall pakker.');if(count){packs[String(size)]=count;amount+=size*count;}}
      amount=round(amount);
    }
    else if(input.amount===null)amount=null;
    else if(input.months!=null){const rate=rateOf(needOf(w,analysis())),months=positive(input.months,'antall måneder',true);if(months>36)throw Error('Ugyldig antall måneder.');if(rate===null&&months>0)throw Error('Forbruket er ukjent. Oppgi mengden i stedet.');amount=months?round(months*rate):0;}
    else amount=positive(input.amount,'beholdning',true);
    return update(()=>{w.stockAmount=amount;w.stockCheckedAt=amount===null?null:now().toISOString();w.stockPacks=packs;return {saved:true,item:itemView(w,analysis(),now().getTime(),catalogPackMap())};});
  }
  function item(input) {
    const w=input.id===undefined?null:s.watches[input.id];if(input.id!==undefined&&!w)throw Error('Ukjent vare.');
    const has=key=>input[key]!==undefined,next={...(w??{productKeys:[],maxPacks:100,storage:'pantry',unit:'stk'})};
    for(const key of ['name','unit','storage','enabled','shelfLifeMonths'])if(has(key))next[key]=input[key];
    if(has('annualAmount')){next.purchaseAmount=null;next.monthlyUsage=input.annualAmount===null?null:positive(input.annualAmount,'årsbehov')/12;}
    if(has('targetPrice')||has('excellentPrice')){if(has('targetPrice'))next.targetPrice=input.targetPrice;if(has('excellentPrice'))next.excellentPrice=input.excellentPrice;next.manualLimits=next.targetPrice!=null;}
    return watch(next);
  }
  function dealAction(input) {
    const o=s.offers[input.offerId];
    if(input.action==='undo'){
      const index=s.purchases.findLastIndex(p=>p.offerId===input.offerId);
      return update(()=>{if(index>=0){const [entry]=s.purchases.splice(index,1),w=s.watches[entry.watchId];if(w){w.stockAmount=entry.previousStock.amount;w.stockCheckedAt=entry.previousStock.checkedAt;w.stockPacks=entry.previousStock.packs??null;}}delete s.dealDecisions[input.offerId];return {saved:true};});
    }
    if(!o)throw Error('Tilbudet finnes ikke lenger.');
    const decision={status:input.action,fingerprint:offerFingerprint(o),validTo:o.validTo,at:now().toISOString()};
    if(input.action==='snooze')return update(()=>{s.dealDecisions[o.id]=decision;return {saved:true};});
    if(input.action!=='bought')throw Error('Ukjent valg.');
    const packs=Number(input.packs);if(!Number.isInteger(packs)||packs<1||packs>1000||(o.maxPacks!==null&&packs>o.maxPacks))throw Error('Ugyldig antall pakker.');
    const a=analysis(),found=deals(a),deal=[...found.opportunities,...found.covered].find(d=>d.id===o.id),w=s.watches[o.watchId];
    if(!w)throw Error('Ukjent vare.');
    const saving=deal&&deal.referenceType!=='target'?round((deal.referencePrice-deal.unitPrice)*packs*o.packAmount):null;
    return update(()=>{
      const previousStock={amount:w.stockAmount,checkedAt:w.stockCheckedAt,packs:w.stockPacks?{...w.stockPacks}:null},stock=estimateStock(w,rateOf(needOf(w,a)),now().getTime());
      if(!stock.known)w.stockPacks={};
      if(w.stockPacks)addCounted(w,o.packAmount,packs);
      w.stockAmount=round((stock.amount??0)+packs*o.packAmount);w.stockCheckedAt=now().toISOString();
      s.dealDecisions[o.id]=decision;
      s.purchases.push({id:randomUUID(),offerId:o.id,watchId:w.id,name:w.name,storeId:o.storeId,packs,packAmount:o.packAmount,unit:o.unit,unitPrice:round(o.price/o.packAmount),referencePrice:deal?.referencePrice??null,total:round(o.price*packs),saving,previousStock,at:now().toISOString()});
      const cutoff=shoppingDay(new Date(now().getTime()-30*86400000));
      for(const [id,entry] of Object.entries(s.dealDecisions))if(entry.validTo<cutoff)delete s.dealDecisions[id];
      return {saved:true,saving};
    });
  }
  const listOpen=()=>s.shoppingList.filter(x=>!x.checkedAt);
  function listView(today) {
    const decorate=({undoStock,boughtOffer,...entry})=>{const o=entry.offerId?s.offers[entry.offerId]:null;return {...entry,expired:!!o&&o.validTo<today,sourceUrl:o?.sourceUrl??null,validTo:o?.validTo??null};};
    return {open:listOpen().map(decorate),done:s.shoppingList.filter(x=>x.checkedAt).sort((x,y)=>y.checkedAt.localeCompare(x.checkedAt)).slice(0,20).map(decorate)};
  }
  function listAdd(input) {
    const base={id:randomUUID(),addedAt:now().toISOString(),checkedAt:null,offerId:null,watchId:null,detail:null,storeId:null,storeName:null,packs:null,packAmount:null,unit:null,unitPrice:null,saving:null};
    if(input.offerId!=null){
      const o=s.offers[input.offerId];if(!o)throw Error('Tilbudet finnes ikke lenger.');
      const packs=Number(input.packs);if(!Number.isInteger(packs)||packs<1||packs>1000||(o.maxPacks!==null&&packs>o.maxPacks))throw Error('Ugyldig antall pakker.');
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId),found=deals(),deal=[...found.opportunities,...found.belowTrip,...found.covered].find(d=>d.id===o.id);
      const saving=deal&&deal.referenceType!=='target'?round((deal.referencePrice-deal.unitPrice)*packs*o.packAmount):null;
      const existing=listOpen().find(x=>x.offerId===o.id);
      if(existing){existing.packs=packs;existing.saving=saving;return existing;}
      const entry={...base,offerId:o.id,watchId:o.watchId,name:w?.name??o.name,detail:o.name,storeId:o.storeId,storeName:store?.name??null,packs,packAmount:o.packAmount,unit:o.unit,unitPrice:round(o.price/o.packAmount),saving};
      s.shoppingList.push(entry);return entry;
    }
    if(input.watchId!=null){
      const w=s.watches[input.watchId];if(!w)throw Error('Ukjent vare.');
      const size=positive(input.packAmount,'pakningsstørrelse'),rate=rateOf(needOf(w,analysis()));
      const existing=listOpen().find(x=>x.watchId===w.id&&!x.offerId);if(existing)return existing;
      const entry={...base,watchId:w.id,name:w.name,packs:rate?Math.max(1,Math.ceil(rate/size)):1,packAmount:size,unit:w.unit};
      s.shoppingList.push(entry);return entry;
    }
    const entry={...base,name:required(input.name,'Varenavn').slice(0,120)};
    s.shoppingList.push(entry);return entry;
  }
  function list(input) {
    const find=()=>{const entry=s.shoppingList.find(x=>x.id===input.id);if(!entry)throw Error('Finner ikke varen på listen.');return entry;};
    if(input.action==='add')return update(()=>listAdd(input));
    if(input.action==='check'){
      const entry=find();if(entry.checkedAt)return structuredClone(entry);
      if(entry.offerId&&s.offers[entry.offerId]){dealAction({offerId:entry.offerId,action:'bought',packs:entry.packs});entry.boughtOffer=true;}
      else if(entry.watchId&&entry.packAmount&&s.watches[entry.watchId]){
        const w=s.watches[entry.watchId],stock=estimateStock(w,rateOf(needOf(w,analysis())),now().getTime());
        entry.undoStock={amount:w.stockAmount,checkedAt:w.stockCheckedAt,packs:w.stockPacks?{...w.stockPacks}:null};
        if(!stock.known)w.stockPacks={};
        if(w.stockPacks)addCounted(w,entry.packAmount,entry.packs);
        w.stockAmount=round((stock.amount??0)+entry.packs*entry.packAmount);w.stockCheckedAt=now().toISOString();
      }
      return update(()=>{entry.checkedAt=now().toISOString();const cutoff=new Date(now().getTime()-14*86400000).toISOString();s.shoppingList=s.shoppingList.filter(x=>!x.checkedAt||x.checkedAt>=cutoff);return entry;});
    }
    if(input.action==='uncheck'){
      const entry=find();
      if(entry.boughtOffer)dealAction({offerId:entry.offerId,action:'undo'});
      else if(entry.undoStock&&s.watches[entry.watchId]){const w=s.watches[entry.watchId];w.stockAmount=entry.undoStock.amount;w.stockCheckedAt=entry.undoStock.checkedAt;w.stockPacks=entry.undoStock.packs;}
      return update(()=>{entry.checkedAt=null;delete entry.boughtOffer;delete entry.undoStock;return entry;});
    }
    if(input.action==='remove'){find();return update(()=>{s.shoppingList=s.shoppingList.filter(x=>x.id!==input.id);return {removed:true};});}
    if(input.action==='clear')return update(()=>{s.shoppingList=listOpen();return {cleared:true};});
    throw Error('Ukjent listevalg.');
  }
  // A proposed cart for the next big delivery. It only ever suggests; adding to
  // the real cart stays a separate, explicit family action.
  function odaDraft(a,today,at) {
    const dates=[...new Set(orders().map(o=>o.deliveryDate))].sort(),gaps=dates.slice(1).map((day,i)=>(Date.parse(day)-Date.parse(dates[i]))/86400000).sort((x,y)=>x-y);
    const gapDays=gaps.length>=2?gaps[Math.floor((gaps.length-1)/2)]:s.settings.stockUpDays??60,gapMonths=gapDays/30.44;
    const estimated=dates.length?shoppingDay(new Date(Date.parse(dates.at(-1))+gapDays*86400000)):today;
    const listed=new Map();for(const e of listOpen())if(e.watchId&&e.packAmount)listed.set(e.watchId,(listed.get(e.watchId)??0)+e.packs*e.packAmount);
    const odaItems=new Map();for(const e of catalog.entries()){const id=e.status==='approved'&&e.store==='ODA_NO'&&e.priceFresh&&e.packAmount?e.sourceUrl?.match(/\/products\/(\d+)-/)?.[1]:null;if(id){const list=odaItems.get(e.watchId)??[];list.push({...e,productId:Number(id),unitPrice:e.currentPrice/e.packAmount});odaItems.set(e.watchId,list);}}
    const items=[],missing=[];let covered=0;
    for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      const need=needOf(w,a);if(need.amount===null)continue;
      const options=odaItems.get(w.id);if(!options){missing.push(w.name);continue;}
      const best=[...options].sort((x,y)=>x.unitPrice-y.unitPrice)[0],normal=w.priceGuide?.referencePrice??null,discountPct=normal?(normal-best.unitPrice)/normal*100:0;
      const dear=!!normal&&best.unitPrice>normal*1.05,tier=dear?'dear':normal?dealTier({unitPrice:best.unitPrice,excellentPrice:w.excellentPrice,discountPct,referenceType:'market'}):'small';
      const shelf=shelfLifeMonths(w),months=Math.min(shelf,dear?Math.min(1,gapMonths):tier==='excellent'?12:tier==='good'?Math.max(3,gapMonths):gapMonths);
      const stock=estimateStock(w,rateOf(need),at),needed=need.amount/12*months-(stock.amount??0)-(listed.get(w.id)??0);
      if(needed<=0){covered++;continue;}
      const packs=packsFor(needed,{packAmount:best.packAmount,bundlePacks:1,cap:100});
      items.push({watchId:w.id,name:w.name,productId:best.productId,productName:best.name,packAmount:best.packAmount,unit:w.unit,packs,packPrice:best.currentPrice,unitPrice:round(best.unitPrice),cost:round(best.currentPrice*packs),tier,stockKnown:stock.known,storage:w.storage});
    }
    items.sort((x,y)=>y.cost-x.cost);
    return {nextAround:estimated<today?today:estimated,items,missing,covered,total:round(items.reduce((n,x)=>n+x.cost,0))};
  }
  function link(input) {
    const key=required(input.productKey,'Produktnøkkel');if(!orders().some(o=>o.products.some(p=>p.productKey===key)))throw Error('Ukjent produkt.');
    const w=input.watchId==null?null:s.watches[input.watchId];if(input.watchId!=null&&!w)throw Error('Ukjent overvåkning.');
    const evidence=required(input.evidence,'Koblingsbelegg');
    return update(()=>{s.productLinks[key]={watchId:w?.id??null,evidence,at:now().toISOString()};if(w&&!w.productKeys.includes(key))w.productKeys.push(key);return s.productLinks[key];});
  }
  function cartReceipt(id,patch) {return update(()=>s.cartReceipts[id]={...(s.cartReceipts[id]??{}),...patch,id,updatedAt:now().toISOString()});}
  return {list,offerSource,feed,checklist,familyView,familySummary,pantry,item,dealAction,link,importOrders,settings,watch,offer,review,nutrition,market,catalogObserve,catalogReview,catalogEntries:watchId=>catalog.entries(watchId),analysis,queue,view,cartReceipt,receipt:id=>structuredClone(s.cartReceipts[id]??null)};
}
