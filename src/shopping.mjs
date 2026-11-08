import {createHash,randomUUID} from 'node:crypto';
import {validateNutrition,purchaseNutrition} from './shopping-nutrition.mjs';

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
  const orders=()=>Object.values(s.orders);
  const update=fn=>{const result=fn();save();return structuredClone(result);};
  function importOrders(input) {
    if(!Array.isArray(input.orders)||!input.orders.length||input.orders.length>1000)throw Error('Oppgi 1–1000 ordre.');
    const entries=input.orders.map(o=>o.text?parseOdaOrderText(o):normalizeOdaOrder(o));
    return update(()=>{for(const order of entries)s.orders[order.orderNumber]={...order,importedAt:now().toISOString()};return {imported:entries.length,total:orders().length};});
  }
  function settings(input) {
    const next={...s.settings};
    if(input.historyFrom!==undefined)next.historyFrom=day(input.historyFrom);
    if(input.monitoringEnabled!==undefined){if(typeof input.monitoringEnabled!=='boolean')throw Error('Ugyldig overvåkningsvalg.');next.monitoringEnabled=input.monitoringEnabled;}
    if(input.storageNote!==undefined)next.storageNote=text(input.storageNote,1500);
    if(input.stockUpDays!==undefined)next.stockUpDays=Math.min(365,positive(input.stockUpDays,'lagerhorisont'));
    if(input.stores!==undefined){if(!Array.isArray(input.stores)||input.stores.length>50)throw Error('Ugyldig butikkliste.');next.stores=input.stores.map(x=>({id:safeId(x.id,'Butikk-ID'),name:required(x.name,'Butikk'),url:url(x.url),minSavings:positive(x.minSavings??50,'minste besparelse',true),memberEligible:x.memberEligible===true,pricesIncludeVat:x.pricesIncludeVat!==false}));if(new Set(next.stores.map(x=>x.id)).size!==next.stores.length)throw Error('Butikk-ID må være unik.');}
    return update(()=>s.settings=next);
  }
  function watch(input) {
    const id=input.id===undefined?randomUUID():safeId(input.id,'overvåknings-ID');
    const next={id,name:required(input.name,'Varenavn'),enabled:input.enabled!==false,productKeys:[...new Set(input.productKeys??[])],unit:input.unit,storage:input.storage,maxPacks:positive(input.maxPacks??10,'maks antall'),monthlyUsage:input.monthlyUsage==null?null:positive(input.monthlyUsage,'samlet månedsforbruk'),minDiscountPct:positive(input.minDiscountPct??0,'minste rabatt',true),targetPrice:input.targetPrice==null?null:positive(input.targetPrice,'målpris'),stockAmount:input.stockAmount==null?null:positive(input.stockAmount,'lagerbeholdning',true),stockCheckedAt:input.stockAmount==null?null:now().toISOString(),note:text(input.note,1000)};
    if(!['kg','l','stk'].includes(next.unit)||!['frozen','pantry','chilled','other'].includes(next.storage)||!Number.isInteger(next.maxPacks)||next.minDiscountPct>100||next.productKeys.some(k=>typeof k!=='string'||k.length>200))throw Error('Ugyldig overvåkning.');
    if(s.watches[id]?.stockAmount===next.stockAmount&&input.stockConfirmed!==true)next.stockCheckedAt=s.watches[id].stockCheckedAt;
    return update(()=>s.watches[id]=next);
  }
  function offer(input) {
    const watch=s.watches[input.watchId];if(!watch)throw Error('Ukjent overvåkning.');
    const store=s.settings.stores.find(x=>x.id===input.storeId);if(!store)throw Error('Butikken er ikke valgt.');
    const entry={id:hash(`${required(input.storeId,'Butikk')}\0${required(input.externalId,'Tilbuds-ID')}`),externalId:input.externalId,storeId:input.storeId,watchId:watch.id,name:required(input.name,'Varenavn'),price:positive(input.price,'tilbudspris'),packAmount:positive(input.packAmount,'pakningsmengde'),unit:input.unit,validFrom:day(input.validFrom),validTo:day(input.validTo),observedAt:input.observedAt??now().toISOString(),sourceUrl:url(input.sourceUrl),evidence:required(input.evidence,'Kildebelegg'),conditions:text(input.conditions,1000),memberOnly:input.memberOnly===true,maxPacks:input.maxPacks==null?null:positive(input.maxPacks,'maks kundeantall'),bundlePacks:positive(input.bundlePacks??1,'antall i pakketilbud'),comparable:input.comparable===true,comparisonNote:required(input.comparisonNote,'Sammenligningsgrunnlag')};
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
      const row=byProduct.get(p.productKey)??{productKey:p.productKey,odaProductId:p.odaProductId??null,name:p.name,category:p.category,spent:0,quantity:0,orderIds:new Set(),orderAmounts:{},baselineTotal:0,baselineAmount:0,unit:p.pack?.unit??null};
      row.spent+=p.netTotal;row.quantity+=p.quantity;row.orderIds.add(order.orderNumber);
      if(p.baselineEligible&&p.pack){row.baselineTotal+=p.netTotal;row.baselineAmount+=p.quantity*p.pack.amount;row.orderAmounts[order.orderNumber]=(row.orderAmounts[order.orderNumber]??0)+p.quantity*p.pack.amount;}
      byProduct.set(p.productKey,row);byCategory.set(p.category,(byCategory.get(p.category)??0)+p.netTotal);
    }
    const products=[...byProduct.values()].map(p=>({...p,spent:round(p.spent),quantity:round(p.quantity),orders:p.orderIds.size,orderIds:undefined,baselineUnitPrice:p.baselineAmount>0?round(p.baselineTotal/p.baselineAmount):null})).sort((a,b)=>b.spent-a.spent);
    return {from,to:today,days:Math.max(1,(Date.parse(today)-Date.parse(from))/86400000+1),orderCount:selected.length,orderTotal:round(selected.reduce((n,o)=>n+o.grossAmount,0)),productTotal:round(selected.reduce((n,o)=>n+o.productAmount,0)),unallocatedDiscount:round(selected.reduce((n,o)=>n+(o.unallocatedDiscount??0),0)),categories:[...byCategory].map(([name,amount])=>({name,amount:round(amount)})).sort((a,b)=>b.amount-a.amount),products,orders:selected.map(({orderNumber,deliveryDate,grossAmount,sourceUrl,source,fees,discounts})=>({orderNumber,deliveryDate,grossAmount,sourceUrl,source,fees,discounts}))};
  }
  function opportunities(a=analysis()) {
    const today=shoppingDay(now()),horizon=shoppingDay(new Date(now().getTime()+7*86400000)),result=[];
    for(const o of Object.values(s.offers)) {
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId);
      if(!w||w.enabled===false||!store||!o.comparable||o.validFrom>horizon||o.validTo<today||now().getTime()-Date.parse(o.observedAt)>48*3600000||(o.memberOnly&&!store.memberEligible))continue;
      const rows=a.products.filter(p=>w.productKeys.includes(p.productKey)&&p.unit===w.unit&&p.baselineAmount>0);
      const paid=rows.reduce((n,p)=>n+p.baselineTotal,0),amount=rows.reduce((n,p)=>n+p.baselineAmount,0);
      const reference=amount>0?Math.min(...rows.map(p=>p.baselineTotal/p.baselineAmount)):w.targetPrice;if(!reference)continue;
      const unitPrice=o.price/o.packAmount,discountPct=(reference-unitPrice)/reference*100;
      if(discountPct<w.minDiscountPct||(w.targetPrice!==null&&unitPrice>w.targetPrice))continue;
      const stockKnown=w.stockAmount!==null&&now().getTime()-Date.parse(w.stockCheckedAt)<30*86400000;
      const bulk=['frozen','pantry'].includes(w.storage)&&(w.monthlyUsage!==null||new Set(rows.flatMap(p=>Object.keys(p.orderAmounts))).size>=2);
      const orderAmounts=new Map();for(const row of rows)for(const [id,n]of Object.entries(row.orderAmounts))orderAmounts.set(id,(orderAmounts.get(id)??0)+n);
      const quantities=[...orderAmounts.values()].filter(n=>n>0).sort((a,b)=>a-b);
      const typicalOrder=quantities.length?quantities[Math.floor((quantities.length-1)/2)]:0;
      // Sparse Oda orders and purchase caps do not measure annual consumption.
      // Without household usage, use a conservative observed big-shop quantity.
      const desiredAmount=w.monthlyUsage!==null?w.monthlyUsage/30.44*s.settings.stockUpDays:typicalOrder;
      let packs=bulk?Math.floor(Math.max(0,desiredAmount-(stockKnown?w.stockAmount:0))/o.packAmount):1;
      packs=Math.min(packs,w.maxPacks,o.maxPacks??Infinity);packs=Math.floor(packs/o.bundlePacks)*o.bundlePacks;
      const saving=round((reference-unitPrice)*packs*o.packAmount);
      if(!packs||saving<=0)continue;
      result.push({...o,watchName:w.name,storeName:store.name,unitPrice:round(unitPrice),referencePrice:round(reference),referenceType:amount>0?'paid':'target',discountPct:round(discountPct),packs,saving:amount>0?saving:null,bulk,checkStock:!stockKnown,quantityBasis:w.monthlyUsage!==null?'household-estimate':'oda-lower-bound',storage:w.storage});
    }
    const best=new Map();for(const o of result){const key=`${o.storeId}:${o.watchId}`;if(!best.has(key)||(o.saving??0)>(best.get(key).saving??0))best.set(key,o);}
    const candidates=[...best.values()];
    const totals=new Map();for(const o of candidates)totals.set(o.storeId,(totals.get(o.storeId)??0)+(o.saving??0));
    return candidates.filter(o=>o.referenceType==='target'||totals.get(o.storeId)>=s.settings.stores.find(x=>x.id===o.storeId).minSavings).sort((a,b)=>(b.saving??0)-(a.saving??0));
  }
  function queue() {
    if(!s.settings.monitoringEnabled)return [];
    const today=shoppingDay(now());
    return s.settings.stores.filter(x=>!s.reviews[x.id]||s.reviews[x.id].nextCheck<=today).map(x=>({do:'shopping-review',storeId:x.id,name:x.name,url:x.url,lastReview:s.reviews[x.id]??null}));
  }
  function nutrition(input){const entry=validateNutrition(input);if(!orders().some(o=>o.products.some(p=>p.productKey===entry.productKey)))throw Error('Ukjent produkt.');return update(()=>s.nutrition[entry.productKey]=entry);}
  function view() {const a=analysis();return {settings:structuredClone(s.settings),analysis:a,nutrition:purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),s.nutrition),watches:structuredClone(Object.values(s.watches)),opportunities:opportunities(a),reviews:structuredClone(Object.values(s.reviews)),queue:queue()};}
  function cartReceipt(id,patch) {return update(()=>s.cartReceipts[id]={...(s.cartReceipts[id]??{}),...patch,id,updatedAt:now().toISOString()});}
  return {importOrders,settings,watch,offer,review,nutrition,analysis,queue,view,cartReceipt,receipt:id=>structuredClone(s.cartReceipts[id]??null)};
}
