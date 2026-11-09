import {createHash,randomUUID} from 'node:crypto';
import {validateNutrition,purchaseNutrition} from './shopping-nutrition.mjs';
import {calibrateMarket} from './shopping-market.mjs';
import {createMarketCatalog} from './shopping-catalog.mjs';
import {createStockIntake} from './shopping-stock.mjs';
import {createLibraryExplorer} from './library-explorer.mjs';
import {withinPriceHorizon} from './shopping-library.mjs';
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
// A package size in the product name that a review contradicts is almost always
// a typing mistake. Multipacks and approximate weights are left to the reviewer.
const NAMED_PACK_UNCLEAR=/\d\s*[x×]\s*\d|\d\s*-?\s*pk\b|\bca\.?\s*\d|cirka|\b(?:pr|per)\.?\s*kg\b/i;
export function namedPackConflict(name,packAmount,unit) {
  if(NAMED_PACK_UNCLEAR.test(name??'')||!(packAmount>0))return null;
  const named=packSize(name);
  return named&&named.unit===unit&&Math.abs(named.amount-packAmount)/named.amount>.05?named.amount:null;
}
const normalized=value=>String(value??'').normalize('NFC').toLocaleLowerCase('nb-NO').replace(/[^\p{L}\p{N}%]+/gu,' ').trim();
const LINK_REQUIREMENTS=new Set(['frozen','organic','lactoseFree','glutenFree']);
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

export function shoppingStore(state,{save,now=()=>new Date(),files,libraryPrices}={}) {
  state.shopping??={orders:{},watches:{},offers:{},reviews:{},cartReceipts:{},settings:{monitoringEnabled:false,historyFrom:null,stores:[],storageNote:'',stockUpDays:60}};
  const s=state.shopping;
  s.nutrition??={};
  s.marketCatalog??={};
  s.dealDecisions??={};
  s.purchases??=[];
  s.priceHistory??={};
  s.productLinks??={};
  s.feedReviewed??={};
  s.feedRead??={};
  s.shoppingList??=[];
  s.odaLimits??={};
  s.odaChoices??={};
  s.libraryAcks??={};
  s.scanLog??=[];
  const catalog=createMarketCatalog(s.marketCatalog,{save,now});
  const orders=()=>Object.values(s.orders);
  const freshPrice=(time,at=now().getTime())=>Number.isFinite(Date.parse(time))&&at-Date.parse(time)>=0&&at-Date.parse(time)<=48*3600000;
  const variablePack=name=>/(?:^|\s)ca\.?\s*\d|cirka|omtrent|vektvare|\b(?:pr|per)\.?\s*kg\b/i.test(name??'');
  const libReader=()=>libraryPrices?.reader?.()??null;
  // Library groups lend products only to chains the family actually shops in;
  // short-dated and wholesale web shops stay out of everyday comparisons.
  const linkChains=()=>new Set(['ODA_NO',...s.settings.stores.filter(x=>x.chainCode&&!/nettbutikk/i.test(x.name)).map(x=>x.chainCode)]);
  const linkStates=(w,reader)=>(w.libraryLinks??[]).map(link=>{const group=reader?.group(link.groupId)??null;return {...link,group,state:!reader?'unavailable':!group?'missing':group.fingerprint!==link.groupFingerprint?'changed':group.unit!==w.unit?'unit':'ok'};});
  function linkedMembers(w,reader,{allChains=false,includeParked=false}={}) {
    const found=new Map(),chains=linkChains();
    for(const link of linkStates(w,reader)){
      if(link.state!=='ok')continue;
      for(const m of reader.members(link.groupId,{all:includeParked})){
        if(m.status!=='approved'||!m.reviewCurrent||!allChains&&!chains.has(m.product.store)||found.has(m.productKey)||link.excludeProductKeys?.includes(m.productKey))continue;
        if(link.brands?.length&&!link.brands.some(b=>normalized(m.product.brand).includes(normalized(b))))continue;
        if((link.requires??[]).some(key=>m.product.attributes?.[key]!==true))continue;
        found.set(m.productKey,m);
      }
    }
    return found;
  }
  function currentPrices() {
    const at=now().getTime(),today=shoppingDay(now()),entries=catalog.entries(),native=new Map(),library=libraryPrices?.(entries)??{status:'disabled',quotes:[]};
    const key=p=>`${p.watchId}|${p.store}|${p.id}`;
    // Catalogue metadata decisions supersede a historical calibration, even
    // when the newest decision/receipt is pending, excluded or price unknown.
    for(const w of Object.values(s.watches))if(w.marketCalibration?.status==='ready')for(const p of w.marketCalibration.products??[])native.set(key({...p,watchId:w.id}),{...p,watchId:w.id,lastChecked:p.lastChecked,price:p.currentUnitPrice*p.packAmount,unitPrice:p.currentUnitPrice,approved:!w.catalogManaged});
    for(const e of entries){const k=key(e),old=native.get(k),newer=old&&Date.parse(old.lastChecked)>Date.parse(e.lastChecked??0),variable=variablePack(e.name);native.set(k,{...e,approved:e.status==='approved'&&e.unit===s.watches[e.watchId]?.unit,packAmount:variable?null:e.packAmount,price:variable?null:newer?old.price:e.currentPrice,unitPrice:variable?null:newer?old.unitPrice:e.currentPrice/e.packAmount,lastChecked:newer?old.lastChecked:e.lastChecked});}
    for(const p of library.quotes){
      const k=key(p),e=native.get(k);if(!e||!p.receiptAt||Date.parse(p.receiptAt)<Date.parse(e.lastChecked??0))continue;
      const packAmount=p.canonicalPackAmount??null;
      const unitPrice=p.grossPackPrice!=null&&packAmount>0?p.grossPackPrice/packAmount:p.directUnitVerified&&p.unit===e.unit?p.grossUnitPrice:null;
      const conflict=Date.parse(p.receiptAt)===Date.parse(e.lastChecked)&&e.unitPrice>0&&unitPrice>0&&Math.abs(e.unitPrice-unitPrice)>1e-8;
      const valid=p.fresh&&!p.reasons.length&&!conflict;
      native.set(k,{...e,packAmount,price:valid&&packAmount>0?p.grossPackPrice??unitPrice*packAmount:null,unitPrice:valid?unitPrice:null,lastChecked:p.receiptAt,priceSource:'library'});
    }
    // An explicit, reviewed group link adds its other products. Any native row
    // for the same product wins, so a family exclusion always holds.
    const reader=libReader();
    if(reader)for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      for(const m of linkedMembers(w,reader).values()){
        const p=m.product,k=key({watchId:w.id,store:p.store,id:p.id});
        if(!m.eligible||native.has(k))continue;
        const packAmount=p.pack>0?p.pack:null;
        native.set(k,{watchId:w.id,store:p.store,id:p.id,name:p.name,ean:p.ean,brand:p.brand,sourceUrl:p.sourceUrl,status:'approved',approved:true,unit:w.unit,packAmount,price:packAmount?m.price.grossPackPrice??m.unitPrice*packAmount:null,unitPrice:m.unitPrice,lastChecked:m.price.receiptAt,priceSource:'library',origin:'library',groupId:m.groupId,image:p.image??null});
      }
    }
    const quotes=[];
    for(const p of native.values())if(p.approved&&(!variablePack(p.name)||p.priceSource==='library')&&p.unitPrice>0&&Number.isFinite(p.unitPrice)&&freshPrice(p.lastChecked,at)){
      const store=s.settings.stores.find(x=>x.chainCode===p.store);
      quotes.push({...p,storeId:store?.id??null,storeName:p.store==='ODA_NO'?'Oda':store?.name.replace(/\s*[–-]\s*Kassal.*$/,'')??chainName(p.store),chainCode:p.store,sourceUrl:p.sourceUrl??null,kind:'catalog'});
    }
    for(const o of Object.values(s.offers)){
      const store=s.settings.stores.find(x=>x.id===o.storeId),w=s.watches[o.watchId];
      if(!store||!w||o.unit!==w.unit||!o.comparable||o.validFrom>today||o.validTo<today||o.bestBefore&&o.bestBefore<today||!freshPrice(o.observedAt,at)||o.memberOnly&&!store.memberEligible)continue;
      quotes.push({...o,offerId:o.id,storeName:store.name,chainCode:store.chainCode??null,unitPrice:o.price/o.packAmount,lastChecked:o.observedAt,kind:'offer'});
    }
    return {entries:[...native.values()],quotes,libraryStatus:library.status,reader,excluded:new Set([...native.values()].filter(e=>e.status==='excluded').map(key))};
  }
  const quotesFor=(w,prices=currentPrices())=>prices.quotes.filter(p=>p.watchId===w.id&&p.unit===w.unit).sort((a,b)=>a.unitPrice-b.unitPrice||String(a.storeName).localeCompare(String(b.storeName)));
  function comparisonReference(w,a,candidate,prices=currentPrices()) {
    const paid=needRows(w,a).filter(p=>p.baselineAmount>0).map(p=>p.baselineTotal/p.baselineAmount);
    const history=w.marketCalibration?.status==='ready'?w.marketCalibration.referencePrice:w.priceGuide?.referencePrice;
    const alternatives=quotesFor(w,prices).filter(p=>{
      if(candidate.kind==='offer'&&p.kind==='offer'&&p.offerId===candidate.offerId)return false;
      if(candidate.kind!=='offer'&&p.kind==='catalog'&&p.store===candidate.store&&String(p.id)===String(candidate.id))return false;
      // A campaign's own chain price is no independent savings baseline. A
      // genuinely cheaper same-chain variant still caps a dearer campaign.
      if(candidate.chainCode&&p.chainCode===candidate.chainCode)return p.unitPrice<candidate.unitPrice;
      return true;
    }).map(p=>p.unitPrice);
    const ceiling=freshPrice(w.referenceCeiling?.checkedAt)?w.referenceCeiling.price:null;
    const values=[history,...paid,ceiling,...alternatives].filter(x=>Number.isFinite(x)&&x>0);
    return values.length?Math.min(...values):null;
  }
  const update=fn=>{const result=fn();save();return structuredClone(result);};
  const needRows=(w,a)=>a.products.filter(p=>w.productKeys.includes(p.productKey)&&p.unit===w.unit);
  const boughtElsewhere=(w,a)=>s.purchases.filter(p=>p.watchId===w.id&&p.unit===w.unit&&p.at.slice(0,10)>=a.from&&p.at.slice(0,10)<=a.to).reduce((n,p)=>n+p.packs*p.packAmount,0);
  const needOf=(w,a)=>annualNeed(w,needRows(w,a),a.days,s.settings.odaShare??1,{elsewhere:boughtElsewhere(w,a),at:now().getTime()});
  const rateOf=need=>need.amount==null?null:need.amount/12;
  const stockIntake=createStockIntake(s,{save,now,files,watches:()=>s.watches,currentStock:w=>estimateStock(w,rateOf(needOf(w,analysis())),now().getTime()),apply:(w,amount)=>{w.stockAmount=amount;w.stockCheckedAt=now().toISOString();w.stockPacks=null;}});
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
    if(s.watches[id]?.stockEvidence&&s.watches[id].stockAmount===next.stockAmount)next.stockEvidence=s.watches[id].stockEvidence;
    next.libraryLinks=s.watches[id]?.libraryLinks??[];
    next.libraryDecision=s.watches[id]?.libraryDecision??null;
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
    const at=now().getTime(),today=shoppingDay(now()),horizon=shoppingDay(new Date(at+7*86400000)),result=[],covered=[],held=[],prices=currentPrices();
    const approvedWatches=new Set(catalog.entries().filter(p=>p.status==='approved').map(p=>p.watchId));
    const fresh=time=>freshPrice(time,at);
    for(const o of Object.values(s.offers)) {
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId);
      if(!w||w.enabled===false||!store||!o.comparable||o.validFrom>horizon||o.validTo<today||o.bestBefore&&o.bestBefore<today||!fresh(o.observedAt))continue;
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
      if(market&&!quotesFor(w,prices).some(p=>p.kind==='catalog')){hold('stale-prices');continue;}
      const ceiling=w.referenceCeiling;
      if(ceiling&&!fresh(ceiling.checkedAt)){hold('stale-prices');continue;}
      const paidReference=amount>0?Math.min(...rows.map(p=>p.baselineTotal/p.baselineAmount)):null;
      // Compare a campaign with other chains, so its own current price does not
      // erase the saving. Without a reviewed chain mapping, use all alternatives.
      const globalReference=comparisonReference(w,a,{kind:'offer',offerId:o.id,chainCode:store.chainCode,unitPrice:o.price/o.packAmount},prices);
      const reference=globalReference??paidReference??w.targetPrice;if(!reference)continue;
      const alternative=!!ceiling&&(paidReference===null||ceiling.price<paidReference);
      const unitPrice=o.price/o.packAmount,discountPct=(reference-unitPrice)/reference*100;
      if(discountPct<w.minDiscountPct||(w.targetPrice!==null&&unitPrice>w.targetPrice))continue;
      const referenceType=market?'market':alternative||globalReference!==null&&amount===0?'alternative':amount>0?'paid':'target';
      const need=needOf(w,a),stock=estimateStock(w,rateOf(need),at),shelfMonths=shelfWithDate(shelfLifeMonths(w),o.bestBefore,at);
      const tier=discountPct<8&&referenceType!=='target'?'small':dealTier({unitPrice,excellentPrice:w.excellentPrice,discountPct,referenceType});
      const hasSaving=amount>0||alternative||!!market||globalReference!==null;
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
    return {opportunities,belowTrip:candidates.filter(o=>!worthTrip(o)).sort((x,y)=>dealScore(y)-dealScore(x)),covered,held,prices};
  }
  // A row just observed without any price stays reviewable; only a receipt that
  // is known to be old parks it, and a newer receipt brings it back.
  const priceTooOld=entry=>entry.lastChecked!=null&&!withinPriceHorizon(entry.lastChecked,now().getTime(),libraryPrices?.horizonDays);
  const listRouteWork=()=>s.shoppingList.filter(e=>!e.checkedAt&&e.routing==='pending');
  function unlinkedOrderLines() {
    const linked=new Set(Object.values(s.watches).flatMap(w=>w.productKeys)),found=new Map(),reader=libReader();
    for(const order of orders())if(order.source==='oda-mcp')for(const p of order.products)if(!linked.has(p.productKey)&&!s.productLinks[p.productKey]){const key=reader?.byOdaId(p.odaProductId),groups=key?reader.groupsOf(key).filter(m=>m.s==='approved'&&m.r).map(m=>m.groupId):[],watchIds=Object.values(s.watches).filter(w=>(w.libraryLinks??[]).some(l=>groups.includes(l.groupId))).map(w=>w.id);found.set(p.productKey,{do:'shopping-order-link',productKey:p.productKey,name:p.name,unit:p.pack?.unit??null,libraryGroups:groups,linkedWatchIds:watchIds});}
    return [...found.values()];
  }
  // Seller posts in community buying groups are collected like other Facebook
  // sources, but they stay out of family activities and only feed offer review.
  const feedPosts=storeId=>Object.values(state.collector?.items??{}).filter(item=>item.shoppingStoreId===storeId&&item.kind==='post');
  const feedUnread=storeId=>{const seen=s.feedReviewed[storeId]??{},cutoff=now().getTime()-21*86400000;return feedPosts(storeId).filter(item=>seen[item.externalId]!==item.token&&(!item.postedAt||Date.parse(item.postedAt)>=cutoff));};
  const feedFingerprint=storeId=>hash(JSON.stringify(feedUnread(storeId).map(({externalId,token})=>[externalId,token]).sort()));
  function feedWork() {
    return s.settings.stores.filter(x=>x.facebookGroup).flatMap(x=>{const unread=feedUnread(x.id).length;return unread?[{do:'shopping-feed-review',storeId:x.id,name:x.name,unread}]:[];});
  }
  function feed(input) {
    const store=s.settings.stores.find(x=>x.id===input.storeId&&x.facebookGroup);if(!store)throw Error('Ukjent gruppekilde.');
    const items=feedUnread(store.id);
    if(input.ack!==true)return update(()=>{s.feedRead[store.id]=Object.fromEntries(items.map(item=>[item.externalId,item.token]));return items.map(({externalId,url,author,text:body,postedAt,attachments,comments,token})=>({externalId,url,author,text:body,postedAt,attachments,comments,token}));});
    const evidence=required(input.evidence,'Kontrollbelegg');
    if(!s.feedRead[store.id])throw Error('Les shopping-feed før gjennomgangen kvitteres.');
    return update(()=>{const seen=s.feedReviewed[store.id]??={},read=s.feedRead[store.id],reviewed=items.filter(item=>read[item.externalId]===item.token);for(const item of reviewed)seen[item.externalId]=item.token;const remaining=feedUnread(store.id).length;if(!remaining)s.reviews[store.id]={storeId:store.id,status:'ok',checkedAt:now().toISOString(),evidence,sourceUrl:store.url,nextCheck:shoppingDay(new Date(now().getTime()+86400000))};delete s.feedRead[store.id];return {reviewed:reviewed.length,remaining};});
  }
  function marketRefreshDue(today) {
    const approved=new Set(catalog.entries().filter(p=>p.status==='approved').map(p=>p.watchId));
    const calibrated=Object.values(s.watches).filter(w=>w.enabled!==false&&(w.marketCalibration?.checkedAt||w.catalogManaged&&approved.has(w.id)));
    if(!calibrated.length)return [];
    const due=calibrated.filter(w=>!w.marketCalibration?.checkedAt||w.marketCalibration.status==='needs-review'||shoppingDay(new Date(w.marketCalibration.checkedAt))!==today);
    return due.length?[{do:'shopping-market-refresh',groups:due.length,watchIds:due.map(w=>w.id).sort(),lastCheckedAt:due.map(w=>w.marketCalibration?.checkedAt).filter(Boolean).sort()[0]??null}]:[];
  }
  function queue() {
    const routes=listRouteWork().map(e=>({do:'shopping-list-route',id:e.id,name:e.name,need:e.need,addedAt:e.addedAt,retryAt:e.routeRetryAt??null}));
    const stock=stockIntake.work().map(x=>({do:'shopping-stock-review',id:x.id,text:x.text,location:x.location,images:x.images.length,submittedAt:x.submittedAt,retryAt:x.retryAt}));
    if(!s.settings.monitoringEnabled)return [...stock,...routes];
    const today=shoppingDay(now());
    return [...stock,...catalog.pending().filter(p=>s.watches[p.watchId]?.enabled!==false&&!priceTooOld(p)).map(p=>({do:'shopping-product-review',watchId:p.watchId,watchName:s.watches[p.watchId]?.name,productId:p.id,store:p.store,name:p.name,fingerprint:p.fingerprint,sourceUrl:p.sourceUrl})),...feedWork(),...s.settings.stores.filter(x=>!x.facebookGroup&&(!s.reviews[x.id]||s.reviews[x.id].nextCheck<=today)).map(x=>({do:'shopping-review',storeId:x.id,name:x.name,url:x.url,lastReview:s.reviews[x.id]??null})),...marketRefreshDue(today),...libraryWork(),...unlinkedOrderLines(),...routes];
  }
  function completion() {
    const work=queue(),blockedStores=s.settings.monitoringEnabled?s.settings.stores.filter(x=>s.reviews[x.id]?.status==='blocked').map(x=>({storeId:x.id,name:x.name,evidence:s.reviews[x.id].evidence})):[];
    const blockedRoutes=[...s.shoppingList.filter(e=>!e.checkedAt&&(e.routing==='blocked'||e.cartError)).map(({id,name,reason,cartError})=>({id,name,reason:cartError??reason})),...stockIntake.blocked().map(x=>({id:x.id,name:'Lagertelling',reason:x.note}))];
    return {complete:!work.length&&!blockedStores.length&&!blockedRoutes.length,work,blockedStores,blockedRoutes};
  }
  function listRouteAttempt(ids) {return update(()=>{for(const e of listRouteWork())if(ids.includes(e.id)){e.routeAttempts=(e.routeAttempts??0)+1;e.routeRetryAt=null;}return true;});}
  function listRouteFinish(ids,note) {return update(()=>{for(const e of listRouteWork())if(ids.includes(e.id)){if(e.routeAttempts>=3){e.routing='blocked';e.storeName??=NEAREST;e.reason=note??'Kunne ikke sorteres automatisk. Velg butikk selv eller legg varen inn på nytt.';}else e.routeRetryAt=new Date(now().getTime()+(e.routeAttempts>=2?300000:60000)).toISOString();}return true;});}
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
    if(input.status==='approved'&&!text(input.packConflictEvidence)){const seen=catalog.entries(w.id).find(e=>String(e.id)===String(input.id)&&e.store===input.store),named=seen?namedPackConflict(seen.name,Number(input.packAmount),input.unit):null;if(named!==null)throw Error(`Varenavnet viser ${named} ${input.unit}, ikke ${input.packAmount}. Rett mengden, eller forklar avviket i packConflictEvidence.`);}
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
    const a=analysis(),at=now().getTime(),context=currentPrices();
    return Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>itemView(w,a,at,new Map(),new Map(),context)).map(({id,name,unit,storage,prices,libraryGroups})=>({watchId:id,name,unit,storage,libraryGroups,normal:prices.normal,good:prices.good,excellent:prices.excellent,cheapestNow:prices.current,chain:prices.currentChain}));
  }
  function view() {const a=analysis(),entries=catalog.entries(),found=deals(a);return {settings:structuredClone(s.settings),analysis:a,nutrition:purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),nutritionRecords()),watches:structuredClone(Object.values(s.watches)),opportunities:found.opportunities,belowTripOffers:found.belowTrip,coveredOffers:found.covered,heldOffers:found.held,offerCounts:offerCounts(),reviews:structuredClone(Object.values(s.reviews)),queue:queue(),purchases:structuredClone(s.purchases),catalog:{total:entries.length,pending:entries.filter(p=>p.status==='pending').length,approved:entries.filter(p=>p.status==='approved').length,excluded:entries.filter(p=>p.status==='excluded').length}};}
  function catalogPackMap(prices=currentPrices()) {
    const byWatch=new Map();
    for(const e of prices.entries)if((e.status==='approved'||e.origin==='library')&&e.packAmount){const sizes=byWatch.get(e.watchId)??new Map();sizes.set(e.packAmount,(sizes.get(e.packAmount)??0)+1);byWatch.set(e.watchId,sizes);}
    return new Map([...byWatch].map(([id,sizes])=>[id,[...sizes].sort((x,y)=>y[1]-x[1]).map(([size])=>size)]));
  }
  function itemView(w,a,at,catalogPacks=new Map(),offerLow=new Map(),priceContext=currentPrices()) {
    const need=needOf(w,a),rate=rateOf(need),stock=estimateStock(w,rate,at),market=w.marketCalibration,rows=needRows(w,a);
    const normal=w.priceGuide?.referencePrice??null;
    const history=Object.values(s.priceHistory[w.id]??{});
    const best=quotesFor(w,priceContext)[0]??null;
    const evaluationReference=comparisonReference(w,a,{kind:'input',unitPrice:Infinity},priceContext);
    // "Good" must be a real step below normal, or the guide just repeats itself.
    const good=w.targetPrice!=null?round(Math.min(w.targetPrice,normal?normal*.92:Infinity,evaluationReference?evaluationReference*.92:Infinity)):null;
    const excellent=w.excellentPrice!=null?round(Math.min(w.excellentPrice,good??Infinity,evaluationReference?evaluationReference*.92:Infinity)):null;
    const chains=market?.coverage?.chainCount;
    const basis=market?.status==='ready'?market.coverage.observedDays+' dager med priser fra '+chains+(chains===1?' kjede':' kjeder'):market?.status==='needs-review'?'En vare er endret og sjekkes på nytt':w.priceGuide?'Foreløpig, ut fra det dere har betalt':w.targetPrice?'Egen prisgrense':'For lite prisdata ennå';
    const sizes=commonPacks(rows,catalogPacks.get(w.id)??[],Object.keys(w.stockPacks??{}).map(Number));
    const links=linkStates(w,priceContext.reader).filter(link=>link.state==='ok');
    return {libraryCategory:links[0]?.group.category??null,libraryGroups:links.map(link=>link.group.name),packs:packBreakdown(sizes,stock.known?w.stockPacks??null:null,stock.amount),id:w.id,name:w.name,unit:w.unit,storage:w.storage,enabled:w.enabled!==false,manualLimits:w.manualLimits===true,annualAmount:need.amount===null?null:round(need.amount),annualBasis:need.basis,shelfLifeMonths:shelfLifeMonths(w),shelfCustom:w.shelfLifeMonths!=null,shelfDefault:defaultShelfLifeMonths(w),stock,spent:round(rows.reduce((n,p)=>n+p.spent,0)),prices:{normal,evaluationReference,good,excellent,targetPrice:w.targetPrice,current:best?round(best.unitPrice):null,currentChain:best?.storeName.replace(/\s*\(nettbutikk\)$/i,' (+ frakt)')??null,currentSourceUrl:best?.sourceUrl??null,currentCheckedAt:best?.lastChecked??null,lowestSeen:history.length>=30?Math.min(...history):null,historyDays:history.length,basis}};
  }
  const summaryOf=(main,steady=[])=>({dealCount:main.length+steady.length,excellentCount:main.filter(d=>d.tier==='excellent').length,potential:round([...main,...steady].reduce((n,d)=>n+(d.saving??0),0)),top:main[0]?.watchName??steady[0]?.name??null});
  function familyView() {
    const a=analysis(),at=now().getTime(),today=shoppingDay(now()),year=today.slice(0,4),found=deals(a);
    const onList=new Set(listOpen().map(x=>x.offerId));
    const pick=d=>({onList:onList.has(d.id),evidence:d.evidence,bestBefore:d.bestBefore,offerId:d.id,watchId:d.watchId,watchName:d.watchName,storeId:d.storeId,storeName:d.storeName,name:d.name,tier:d.tier,lowestSeen:d.lowestSeen,unit:d.unit,price:d.price,unitPrice:d.unitPrice,referencePrice:d.referencePrice,referenceType:d.referenceType,discountPct:d.discountPct,packAmount:d.packAmount,bundlePacks:d.bundlePacks,maxPacks:d.maxPacks,validFrom:d.validFrom,validTo:d.validTo,memberOnly:d.memberOnly,conditions:d.conditions,comparisonNote:d.comparisonNote,sourceUrl:d.sourceUrl,storage:d.storage,annualAmount:d.annualAmount,quantityBasis:d.quantityBasis,shelfMonths:d.shelfMonths,fullMonths:d.fullMonths,stock:d.stock,saving:d.saving,recommendedKey:d.recommendedKey,options:d.options});
    const byWatch=new Map();for(const d of found.opportunities){const list=byWatch.get(d.watchId)??[];list.push(d);byWatch.set(d.watchId,list);}
    const primary=[...byWatch.values()].map(list=>({...pick(list[0]),alsoAt:list.slice(1).map(x=>({storeName:x.storeName,unitPrice:x.unitPrice}))}));
    const main=primary.filter(d=>d.tier!=='small'),small=primary.filter(d=>d.tier==='small');
    const offerLow=new Map();for(const d of [...found.opportunities,...found.belowTrip,...found.covered])if(d.validFrom<=today&&(!offerLow.has(d.watchId)||d.unitPrice<offerLow.get(d.watchId).unitPrice))offerLow.set(d.watchId,d);
    const catalogPacks=catalogPackMap(found.prices),items=Object.values(s.watches).map(w=>itemView(w,a,at,catalogPacks,offerLow,found.prices)).sort((x,y)=>y.spent-x.spent);
    const reviews=Object.values(s.reviews);
    const stores=s.settings.stores.map(x=>{const r=reviews.find(y=>y.storeId===x.id);return {id:x.id,name:x.name,status:r?.status??'unchecked',checkedAt:r?.checkedAt??null};});
    const n=purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),nutritionRecords());
    const sum=list=>round(list.reduce((x,p)=>x+(p.saving??0),0));
    const stockImages=new Map(catalog.entries().filter(e=>e.status==='approved'&&e.image).map(e=>[e.watchId,imageRef(e.image)]));
    const inventoryOda=odaProducts(found.prices);
    for(const item of items){const options=inventoryOda.get(item.id),chosen=options?defaultOda(s.watches[item.id],options):null;item.image=imageRef(chosen?.image)??stockImages.get(item.id)??null;item.stockEvidence=structuredClone(s.watches[item.id].stockEvidence??null);}
    const stockReports=stockIntake.list().map(({baseStocks,appliedVersions,clientId,...item})=>({...item,result:item.result?{...item.result,changes:item.result.changes.map(({previous,...change})=>change)}:null}));
    const body={stockReports,steady:steadyPrices(a,found,at),list:listView(today,found.prices,a),odaDraft:odaDraft(a,today,at,found),monitoring:s.settings.monitoringEnabled===true,today,deals:main,smallDeals:small,belowTrip:found.belowTrip.map(d=>({...pick(d),alsoAt:[]})),covered:found.covered.map(pick),held:found.held,items,purchases:s.purchases.slice().reverse().slice(0,30).map(({previousStock,...p})=>p),saved:{year:sum(s.purchases.filter(p=>p.at.slice(0,4)===year)),all:sum(s.purchases)},stores,storesCheckedToday:stores.filter(x=>x.status==='ok'&&x.checkedAt&&shoppingDay(new Date(x.checkedAt))===today).length,analysis:{orderCount:a.orderCount,from:a.from,to:a.to,orderTotal:a.orderTotal,categories:a.categories,top:a.products.slice(0,15).map(p=>({name:p.name,spent:p.spent,orders:p.orders}))},nutrition:{spendPct:n.coverage.spendPct}};
    return {...body,rev:hash(JSON.stringify(body)),summary:summaryOf(main,body.steady)};
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
    return update(()=>{w.stockAmount=amount;w.stockCheckedAt=amount===null?null:now().toISOString();w.stockPacks=packs;delete w.stockEvidence;return {saved:true,item:itemView(w,analysis(),now().getTime(),catalogPackMap())};});
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
  const NEAREST='Nærmeste butikk',MOVE_MIN_PCT=15,MOVE_MIN_KR=25;
  const imageRef=url=>url?hash(url):null;
  let imageIndex={at:0,map:new Map()};
  function imageSource(id) {
    if(now().getTime()-imageIndex.at>60000){
      const map=new Map();
      for(const e of catalog.entries())if(e.image)map.set(imageRef(e.image),e.image);
      for(const e of s.shoppingList)if(e.imageUrl)map.set(imageRef(e.imageUrl),e.imageUrl);
      for(const url of libReader()?.imageUrls()??[])map.set(imageRef(url),url);
      imageIndex={at:now().getTime(),map};
    }
    return imageIndex.map.get(id)??null;
  }
  // Quality numbers are shown only between options measured the same way.
  const sharedQuality=rows=>{const counts=new Map();for(const q of rows)if(q)counts.set(q.key,(counts.get(q.key)??0)+1);return [...counts].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1])[0]?.[0]??null;};
  function variantsOf(options,keep=null,shared=sharedQuality(options.map(o=>o.quality))) {
    const best=shared?options.filter(o=>o.quality?.key===shared).sort((a,b)=>b.quality.score-a.quality.score)[0]:null;
    const shown=[...new Set([...options.slice(0,6),best,options.find(o=>o.productId===keep),...options.slice(6,8)].filter(Boolean))].slice(0,8).sort((a,b)=>a.unitPrice-b.unitPrice);
    return shown.map(o=>{const named=o.name.match(/maks\s+(\d+)/i);return {productKey:`kassal:${o.store}:${o.id}`,productId:o.productId,name:o.name,packAmount:o.packAmount,packPrice:o.currentPrice,unitPrice:round(o.unitPrice),maxAtOda:s.odaLimits[o.productId]?.max??(named?Number(named[1]):null),image:imageRef(o.image),library:o.origin==='library',pills:o.pills??null,quality:shared&&o.quality?.key===shared?{score:o.quality.score,label:o.quality.label}:null};});
  }
  // The library family a product belongs to. A declined watch has none, and a
  // linked watch has exactly its reviewed links. Until a watch is decided, the
  // family is shown for comparison only and never becomes a price reference.
  function familyMembers(w,base,prices) {
    const reader=prices.reader;if(!reader||w?.libraryDecision?.status==='none')return [];
    if(w?.libraryLinks?.length)return [...linkedMembers(w,reader,{allChains:true}).values()];
    if(!base)return [];
    const seen=new Map();
    for(const m of reader.groupsOf(`kassal:${base.store}:${base.id}`)){
      if(m.s!=='approved'||!m.r||w&&reader.group(m.groupId)?.unit!==w.unit)continue;
      for(const row of reader.members(m.groupId))if(row.status==='approved'&&row.reviewCurrent&&!seen.has(row.productKey))seen.set(row.productKey,row);
    }
    return [...seen.values()];
  }
  const cleanStore=name=>name.replace(/\s*[–-]\s*Kassal.*$/,'').replace(/\s*\(nettbutikk\)$/i,'');
  // What the same family costs at other chains, cheapest first. Every chain with
  // a fresh price is shown; only the family's own stores may steer a purchase.
  function variantBlock(w,options,keep,prices,base,currentUnit,{annual=null,excludeStore=null,odaOptions=[]}={}) {
    const reader=prices.reader,rows=new Map(),preferred=odaOptions.length?defaultOda(w,odaOptions):null;
    // A line moved to another store must still be able to come back to Oda.
    for(const o of odaOptions)rows.set('oda|'+o.productId,{storeName:'Oda',own:true,online:false,name:o.name,packAmount:o.packAmount,packPrice:o.currentPrice,unitPrice:round(o.unitPrice),offer:false,offerId:null,maxPacks:null,image:imageRef(o.image),odaProductId:o.productId,productKey:`kassal:${o.store}:${o.id}`,pills:o.pills??null,pin:o===preferred,rawQuality:o.quality});
    if(w)for(const q of quotesFor(w,prices)){
      if(q.store==='ODA_NO'||q.chainCode==='ODA_NO')continue;
      const key=q.kind==='offer'?'offer:'+q.offerId:q.store+'|'+q.id;
      rows.set(key,{storeName:cleanStore(q.storeName),own:!!q.storeId,online:/nettbutikk/i.test(q.storeName),name:q.name,packAmount:q.packAmount??null,packPrice:q.price??null,unitPrice:round(q.unitPrice),offer:q.kind==='offer',offerId:q.offerId??null,maxPacks:q.maxPacks??null,image:imageRef(q.image??reader?.product(`kassal:${q.store}:${q.id}`)?.image),productKey:q.kind==='catalog'?`kassal:${q.store}:${q.id}`:null,pills:q.kind==='catalog'?reader?.pills(`kassal:${q.store}:${q.id}`)??null:null,rawQuality:q.kind==='catalog'?reader?.quality(`kassal:${q.store}:${q.id}`)??null:null});
    }
    const family=familyMembers(w,base,prices);
    for(const m of family){
      const p=m.product,key=p.store+'|'+p.id;
      if(!m.eligible||p.store==='ODA_NO'||rows.has(key)||w&&prices.excluded.has(w.id+'|'+p.store+'|'+p.id))continue;
      const store=s.settings.stores.find(x=>x.chainCode===p.store);
      rows.set(key,{storeName:store?cleanStore(store.name):chainName(p.store),own:!!store,online:!!store&&/nettbutikk/i.test(store.name),name:p.name,packAmount:p.pack>0?p.pack:null,packPrice:m.price.grossPackPrice??null,unitPrice:round(m.unitPrice),offer:false,offerId:null,maxPacks:null,image:imageRef(p.image),productKey:m.productKey,pills:reader.pills(m.productKey),rawQuality:m.quality});
    }
    const sorted=[...rows.values()].sort((a,b)=>a.unitPrice-b.unitPrice),perChain=new Set(),cheapest=sorted.filter(x=>!perChain.has(x.storeName)&&perChain.add(x.storeName));
    const head=[...new Set([...cheapest,...sorted.filter(x=>x.pin)])],shown=[...new Set([...head,...sorted])].slice(0,Math.max(12,head.length)).sort((a,b)=>a.unitPrice-b.unitPrice);
    const shared=sharedQuality([...options.map(o=>o.quality),...shown.map(x=>x.rawQuality)]);
    const others=shown.map(({rawQuality,pin,...row})=>({...row,quality:shared&&rawQuality?.key===shared?{score:rawQuality.score,label:rawQuality.label}:null}));
    // One line per chain that truly beats this price. Savings use a physical
    // store when one is cheaper, since web prices still lack freight.
    const seenChains=new Set(),places=currentUnit>0?others.filter(x=>x.unitPrice<currentUnit*.99&&x.storeName!==excludeStore&&!seenChains.has(x.storeName)&&seenChains.add(x.storeName)).slice(0,3):[];
    const basis=places.find(x=>!x.online)??places[0]??null,perUnit=basis?currentUnit-basis.unitPrice:0;
    const savings=basis?{perUnit,annual:annual>0?round(perUnit*annual):null,storeName:basis.storeName,online:basis.online}:null;
    return {odaReturn:preferred?{productId:preferred.productId,name:preferred.name,unitPrice:round(preferred.unitPrice)}:null,variants:variantsOf(options,keep,shared),others,places,savings,familyUnit:w?.unit??(family[0]?reader.group(family[0].groupId)?.unit??null:null)};
  }
  // A linked group may hold cheaper brands. They are offered, never swapped in.
  const defaultOda=(w,options)=>options.find(x=>x.productId===s.odaChoices[w.id])??options.find(x=>x.origin!=='library')??options[0];
  function localBest(w,amount,found,at) {
    const normal=w.priceGuide?.referencePrice??null;
    if(!normal)return null;
    const candidates=quotesFor(w,found.prices).filter(p=>p.store!=='ODA_NO'&&p.chainCode&&!/nettbutikk/i.test(p.storeName));
    const best=candidates.sort((x,y)=>x.unitPrice-y.unitPrice)[0];
    if(!best)return null;
    const reference=comparisonReference(w,analysis(),best,found.prices)??normal;
    const diffPct=(reference-best.unitPrice)/reference*100,saving=(reference-best.unitPrice)*amount;
    return diffPct>=MOVE_MIN_PCT&&saving>=MOVE_MIN_KR?{storeName:best.storeName,unitPrice:round(best.unitPrice),diffPct:Math.round(diffPct),saving:round(saving)}:null;
  }
  function watchImage(watchId,storeName,byWatch) {
    const list=byWatch.get(watchId);
    if(!list)return null;
    const code=storeName==='Oda'?'ODA_NO':s.settings.stores.find(x=>storeName&&x.name.startsWith(storeName))?.chainCode;
    return imageRef((list.find(e=>e.store===code)??list[0]).image);
  }
  function odaProducts(prices=currentPrices()) {
    const byWatch=new Map();
    for(const e of prices.quotes){const id=e.kind==='catalog'&&e.store==='ODA_NO'&&e.packAmount?e.sourceUrl?.match(/\/products\/(\d+)-/)?.[1]:null;if(id){const list=byWatch.get(e.watchId)??[];list.push({...e,currentPrice:e.price,productId:Number(id),quality:prices.reader?.quality(`kassal:ODA_NO:${e.id}`)??null,pills:prices.reader?.pills(`kassal:ODA_NO:${e.id}`)??null});byWatch.set(e.watchId,list);}}
    for(const list of byWatch.values())list.sort((x,y)=>x.unitPrice-y.unitPrice);
    // Undecided watches can still choose among their family's Oda products. These
    // rows stay out of the quotes, so they never move a price reference.
    if(prices.reader)for(const w of Object.values(s.watches)){
      const list=byWatch.get(w.id);if(!list?.length||w.enabled===false||w.libraryLinks?.length||w.libraryDecision?.status==='none')continue;
      for(const m of familyMembers(w,list.find(x=>x.productId===s.odaChoices[w.id])??list[0],prices)){
        const p=m.product,oda=p.store==='ODA_NO'?p.sourceUrl?.match(/\/products\/(\d+)-/)?.[1]:null;
        if(!oda||!m.eligible||!(p.pack>0)||prices.excluded.has(w.id+'|'+p.store+'|'+p.id)||list.some(x=>x.productId===Number(oda)))continue;
        list.push({watchId:w.id,store:p.store,id:p.id,name:p.name,sourceUrl:p.sourceUrl,unit:w.unit,packAmount:p.pack,price:m.price.grossPackPrice??m.unitPrice*p.pack,currentPrice:m.price.grossPackPrice??m.unitPrice*p.pack,unitPrice:m.unitPrice,productId:Number(oda),quality:m.quality,pills:prices.reader.pills(m.productKey),origin:'library',kind:'catalog',image:p.image??null});
      }
      list.sort((x,y)=>x.unitPrice-y.unitPrice);
    }
    return byWatch;
  }
  // Another place only wins when the difference is worth acting on.
  function offersElsewhere(w,found,at) {
    return quotesFor(w,found.prices).filter(p=>p.store!=='ODA_NO').map(p=>({...p,offerId:p.offerId??null,online:/nettbutikk/i.test(p.storeName),minSavings:s.settings.stores.find(x=>x.id===p.storeId)?.minSavings??0}));
  }
  function betterThanOda(w,odaUnit,amount,found,at) {
    const best=offersElsewhere(w,found,at)[0];
    if(!best)return null;
    const diffPct=(odaUnit-best.unitPrice)/odaUnit*100,saving=(odaUnit-best.unitPrice)*amount;
    if(diffPct<MOVE_MIN_PCT||saving<Math.max(MOVE_MIN_KR,best.online?best.minSavings:0))return null;
    return {storeName:best.storeName,unitPrice:round(best.unitPrice),offerId:best.offerId,packAmount:best.packAmount??null,maxPacks:best.maxPacks??null,diffPct:Math.round(diffPct),saving:round(saving)};
  }
  function placeEntry(entry,w,odaOption,amount,found,at) {
    const better=betterThanOda(w,odaOption.unitPrice,amount,found,at);
    if(better){entry.storeName=better.storeName;entry.unitPrice=better.unitPrice;entry.saving=better.saving;entry.reason=better.diffPct+' % billigere enn Oda';entry.routing=null;return better;}
    entry.storeName='Oda';entry.odaProductId=odaOption.productId;entry.detail=odaOption.name;entry.unitPrice=round(odaOption.unitPrice);entry.reason='Oda er omtrent like billig';entry.routing=null;return null;
  }
  function recordOdaLimit(result) {
    const name=(result.line?.product?.name??'').toLocaleLowerCase('nb-NO');
    const match=(result.validationMessages??[]).map(text=>({text,found:text.match(/maks\s+(\d+)\s*stk\s+(.+?)\s+per\s+person/i)})).find(x=>x.found&&name.includes(x.found[2].toLocaleLowerCase('nb-NO')));
    if(!match&&s.odaLimits[result.productId])return structuredClone(s.odaLimits[result.productId]);
    return update(()=>s.odaLimits[result.productId]={max:match?Number(match.found[1]):null,message:match?.text??null,checkedAt:now().toISOString()});
  }
  // A cart line outside every watch can still sit in a reviewed library group.
  function libraryAlternative(productId,reader) {
    const key=reader?.byOdaId(productId);if(!key)return null;
    let found=null;
    for(const m of reader.groupsOf(key)){
      if(m.s!=='approved'||!m.r)continue;
      const rows=reader.members(m.groupId),own=rows.find(x=>x.productKey===key);if(!own?.eligible)continue;
      const cheaper=rows.filter(x=>x.status==='approved'&&x.eligible&&x.product.store==='ODA_NO'&&x.product.pack>0&&x.product.sourceUrl?.match(/\/products\/\d+-/)&&x.unitPrice<own.unitPrice*.95).sort((x,y)=>x.unitPrice-y.unitPrice)[0];
      if(!cheaper||found&&found.unitPrice<=cheaper.unitPrice)continue;
      const group=reader.group(m.groupId),shared=own.quality&&cheaper.quality&&own.quality.key===cheaper.quality.key;
      found={productId:Number(cheaper.product.sourceUrl.match(/\/products\/(\d+)-/)[1]),name:cheaper.product.name,unit:group.unit,unitPrice:round(cheaper.unitPrice),ownUnitPrice:round(own.unitPrice),packAmount:cheaper.product.pack,linePackAmount:own.product.pack,packPrice:cheaper.price.grossPackPrice,diffPct:Math.round((own.unitPrice-cheaper.unitPrice)/own.unitPrice*100),groupName:group.name,quality:shared?{label:own.quality.label,own:own.quality.score,other:cheaper.quality.score}:null};
    }
    return found;
  }
  function cartReview(cart) {
    const lines=[],at=now().getTime(),a=analysis(),found=deals(a),products=odaProducts(found.prices),byProduct=new Map(),reader=found.prices.reader;
    for(const [watchId,list] of products)for(const p of list)if(!byProduct.has(p.productId))byProduct.set(p.productId,{watchId,product:p});
    const walk=value=>{if(!value||typeof value!=='object')return;if(value.product&&typeof value.quantity==='number'){lines.push(value);return;}for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);};
    walk(cart.groups);
    const messages=cart.validationMessages??[];
    return {url:cart.url??null,total:cart.totalGrossAmount,messages,lines:lines.map(line=>{
      const hit=byProduct.get(line.product.id),w=hit&&s.watches[hit.watchId],limit=s.odaLimits[line.product.id]?.max??null;
      const lower=line.product.name.toLocaleLowerCase('nb-NO'),message=messages.find(text=>{const m=text.match(/maks\s+\d+\s*stk\s+(.+?)\s+per\s+person/i);return m&&lower.includes(m[1].toLocaleLowerCase('nb-NO'));})??null;
      const over=limit!=null&&line.quantity>limit?'Oda tillater maks '+limit+'.':null;
      const better=w?betterThanOda(w,hit.product.unitPrice,line.quantity*hit.product.packAmount,found,at):null;
      const lineUnit=hit?hit.product.unitPrice:null,cheapestVariant=hit?products.get(hit.watchId)[0]:null;
      const cheaperVariant=cheapestVariant&&cheapestVariant.productId!==line.product.id&&cheapestVariant.unitPrice<lineUnit?{productId:cheapestVariant.productId,name:cheapestVariant.name,unitPrice:round(cheapestVariant.unitPrice),packPrice:cheapestVariant.currentPrice,packAmount:cheapestVariant.packAmount,diffPct:Math.round((lineUnit-cheapestVariant.unitPrice)/lineUnit*100)}:null;
      const knownLow=w?quotesFor(w,found.prices)[0]:null,cheapestKnown=knownLow&&knownLow.unitPrice<(cheaperVariant?.unitPrice??lineUnit)?{storeName:knownLow.storeName,unitPrice:round(knownLow.unitPrice)}:null;
      const outsideKey=hit?null:reader?.byOdaId(line.product.id),outside=outsideKey?reader.product(outsideKey):null,block=hit?variantBlock(w,products.get(hit.watchId),line.product.id,found.prices,hit.product,lineUnit,{annual:needOf(w,a).amount}):variantBlock(null,[],null,found.prices,outside?{store:outside.store,id:outside.id}:null,outside&&outside.pack>0&&outside.quote.grossPackPrice?outside.quote.grossPackPrice/outside.pack:null);
      return {...block,productKey:hit?`kassal:ODA_NO:${hit.product.id}`:outsideKey??null,pills:hit?hit.product.pills??null:outsideKey?reader.pills(outsideKey):null,libraryAlternative:hit?null:libraryAlternative(line.product.id,reader),unitPrice:lineUnit===null?null:round(lineUnit),cheaperVariant,cheapestKnown,productId:line.product.id,name:line.product.name,quantity:line.quantity,total:line.totalGrossAmount,limit:message??over,elsewhere:better,watchId:hit?.watchId??null,unit:w?.unit??null,packAmount:hit?.product.packAmount??outside?.pack??null,image:imageRef(hit?.product.image??outside?.image)};
    })};
  }
  const listOpen=()=>s.shoppingList.filter(x=>!x.checkedAt);
  function listView(today,priceContext=currentPrices(),a=analysis()) {
    const byWatch=new Map();for(const e of catalog.entries())if(e.status==='approved'&&e.image){const list=byWatch.get(e.watchId)??[];list.push(e);byWatch.set(e.watchId,list);}
    const products=odaProducts(priceContext);
    const decorate=({undoStock,boughtOffer,imageUrl,...entry})=>{const o=entry.offerId?s.offers[entry.offerId]:null,w=s.watches[entry.watchId],best=w?quotesFor(w,priceContext)[0]:null;
      const cheaper=!entry.checkedAt&&best&&entry.unitPrice>best.unitPrice?{storeName:best.storeName,unitPrice:round(best.unitPrice),sourceUrl:best.sourceUrl}:null;
      const reference=!entry.checkedAt&&w&&o?comparisonReference(w,a,{kind:'offer',offerId:o.id,chainCode:s.settings.stores.find(x=>x.id===o.storeId)?.chainCode,unitPrice:o.price/o.packAmount},priceContext):null;
      const saving=!entry.checkedAt&&o?reference===null?null:round(Math.max(0,reference-o.price/o.packAmount)*entry.packs*o.packAmount):entry.saving;
      const productKey=entry.productKey??(entry.odaProductId?priceContext.reader?.byOdaId(entry.odaProductId)??null:null);
      return {...entry,productKey,pills:productKey?priceContext.reader?.pills(productKey)??null:null,saving,cheaper,image:imageUrl?imageRef(imageUrl):entry.watchId?watchImage(entry.watchId,entry.storeName,byWatch):null,...(()=>{const options=products.get(entry.watchId)??[],oda=entry.storeName==='Oda';return !entry.checkedAt&&w&&(oda?entry.unitPrice:true)?variantBlock(w,oda?options:[],entry.odaProductId,priceContext,options.find(x=>x.productId===entry.odaProductId)??options[0]??null,entry.unitPrice,{annual:needOf(w,a).amount,excludeStore:oda?null:entry.storeName,odaOptions:oda||entry.need==='now'?[]:options}):{variants:[],others:[],places:[],savings:null,odaReturn:null};})(),expired:!!o&&o.validTo<today,sourceUrl:o?.sourceUrl??null,validTo:o?.validTo??null};};
    return {open:listOpen().map(decorate),done:s.shoppingList.filter(x=>x.checkedAt).sort((x,y)=>y.checkedAt.localeCompare(x.checkedAt)).slice(0,20).map(decorate)};
  }
  function listAdd(input) {
    const base={need:input.need==='now'?'now':'later',routing:null,routeAttempts:0,reason:null,odaProductId:null,id:randomUUID(),addedAt:now().toISOString(),checkedAt:null,offerId:null,watchId:null,detail:null,storeId:null,storeName:null,packs:null,packAmount:null,unit:null,unitPrice:null,saving:null};
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
    const pickedImage=input.imageId==null?null:imageSource(String(input.imageId));
    const chosenKey=input.productKey==null?null:text(input.productKey,300);
    const chosenReason=input.alternative===true?'Billigere enn på Oda':'Fast lav pris';
    if(input.watchId==null&&input.alternative===true){
      if(input.unit!=null&&!['kg','l','stk'].includes(input.unit))throw Error('Ugyldig enhet.');
      const size=input.packAmount==null?null:positive(input.packAmount,'pakningsstørrelse'),storeName=required(input.storeName,'Butikk').slice(0,120),name=required(input.name,'Varenavn').slice(0,120);
      const same=listOpen().find(x=>!x.watchId&&x.name===name&&x.storeName===storeName);if(same)return same;
      const entry={...base,name,detail:input.detail==null?null:text(input.detail,200),storeName,packs:size?positive(input.packs??1,'antall'):null,packAmount:size,unit:input.unit??null,unitPrice:input.unitPrice==null?null:positive(input.unitPrice,'pris'),saving:input.saving==null?null:positive(input.saving,'gevinst',true),reason:chosenReason,imageUrl:pickedImage,productKey:chosenKey};
      s.shoppingList.push(entry);return entry;
    }
    if(input.watchId!=null){
      const w=s.watches[input.watchId];if(!w)throw Error('Ukjent vare.');
      const size=input.packAmount==null&&input.storeName?null:positive(input.packAmount,'pakningsstørrelse'),rate=rateOf(needOf(w,analysis()));
      const existing=listOpen().find(x=>x.watchId===w.id&&!x.offerId&&(!input.storeName||x.storeName===String(input.storeName).slice(0,120)));if(existing)return existing;
      if(input.storeName){
        const packs=size?positive(input.packs??1,'antall'):null,entry={...base,watchId:w.id,name:w.name,detail:input.detail==null?null:text(input.detail,200),storeName:required(input.storeName,'Butikk').slice(0,120),packs,packAmount:size,unit:w.unit,unitPrice:input.unitPrice==null?null:positive(input.unitPrice,'pris'),saving:input.saving==null?null:positive(input.saving,'gevinst',true),reason:chosenReason,imageUrl:pickedImage,productKey:chosenKey};
        s.shoppingList.push(entry);return entry;
      }
      const entry={...base,watchId:w.id,name:w.name,packs:rate?Math.max(1,Math.ceil(rate/size)):1,packAmount:size,unit:w.unit};
      const options=odaProducts().get(w.id),option=options?defaultOda(w,options):null;
      if(option)placeEntry(entry,w,option,entry.packs*size,deals(),now().getTime());
      s.shoppingList.push(entry);return entry;
    }
    const entry={...base,name:required(input.name,'Varenavn').slice(0,120)},key=normalized(entry.name);
    const exact=key.length<2?[]:Object.values(s.watches).filter(w=>w.enabled!==false&&normalized(w.name)===key);
    if(exact.length===1){const replaced=placeOnWatch(entry,exact[0]);if(replaced)return replaced;s.shoppingList.push(entry);return entry;}
    if(entry.need==='now')entry.storeName=NEAREST;
    // Anything short of an exact name is a guess, and a guess must never reach
    // the real cart. The family picks; only an unknown word needs the agent.
    const suggestions=freeTextSuggestions(entry.name,entry.need);
    if(suggestions.length){entry.routing='choose';entry.suggestions=suggestions;}else entry.routing='pending';
    s.shoppingList.push(entry);return entry;
  }
  // Places a free-text entry on a known watch. Returns a replacement entry when
  // a concrete offer elsewhere took over.
  function placeOnWatch(entry,w) {
    entry.routing=null;entry.suggestions=null;
    if(entry.need==='now'){
      const a=analysis(),rate=rateOf(needOf(w,a)),local=rate?localBest(w,rate,deals(a),now().getTime()):null;
      entry.storeName=NEAREST;entry.watchId=w.id;entry.name=w.name;entry.unit=w.unit;
      if(local){entry.storeName=local.storeName;entry.unitPrice=local.unitPrice;entry.saving=local.saving;entry.reason=local.diffPct+' % under vanlig pris';}
      return null;
    }
    const a=analysis(),found=deals(a),options=odaProducts(found.prices).get(w.id);
    entry.name=w.name;
    if(!options){entry.routing='pending';return null;}
    const option=defaultOda(w,options),rate=rateOf(needOf(w,a)),packs=rate?Math.max(1,Math.ceil(rate/option.packAmount)):1;
    Object.assign(entry,{watchId:w.id,packs,packAmount:option.packAmount,unit:w.unit});
    const better=placeEntry(entry,w,option,packs*option.packAmount,found,now().getTime());
    if(better?.offerId){const offerPacks=Math.max(1,Math.ceil(packs*option.packAmount/better.packAmount));return listAdd({offerId:better.offerId,packs:better.maxPacks?Math.min(better.maxPacks,offerPacks):offerPacks});}
    return null;
  }
  function freeTextSuggestions(name,need) {
    const terms=normalized(name).split(' ').filter(Boolean);if(terms.join('').length<3)return [];
    const rank=w=>{const parts=normalized(w.name).split(' '),hit=t=>parts.some(p=>p.startsWith(t)||t.length>=4&&p.includes(t));if(!terms.every(hit))return 0;return terms.reduce((n,t)=>n+(parts[0]===t?4:parts[0].startsWith(t)?3:parts.includes(t)?2:1),0);};
    const watches=Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>({w,score:rank(w)})).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.w.name.localeCompare(b.w.name,'nb')).slice(0,5).map(({w})=>w);
    const result=watches.map(w=>({type:'watch',watchId:w.id,name:w.name,unit:w.unit}));
    const reader=libReader();if(!reader)return result;
    const chains=linkChains(),linked=new Set(watches.flatMap(w=>(w.libraryLinks??[]).map(l=>l.groupId)));
    for(const g of reader.searchGroups(name,8)){
      if(result.length>=6)break;
      if(linked.has(g.id))continue;
      const rows=reader.members(g.id).filter(m=>m.status==='approved'&&m.eligible&&chains.has(m.product.store)&&m.product.pack>0&&(need!=='now'||m.product.store!=='ODA_NO')).sort((x,y)=>x.unitPrice-y.unitPrice);
      const best=(need==='now'?null:rows.find(m=>m.product.store==='ODA_NO'&&/\/products\/\d+-/.test(m.product.sourceUrl??'')))??rows.find(m=>m.product.store!=='ODA_NO');
      if(!best||result.some(x=>x.productKey===best.productKey))continue;
      const oda=best.product.store==='ODA_NO',store=s.settings.stores.find(x=>x.chainCode===best.product.store);
      result.push({type:'library',productKey:best.productKey,name:best.product.name,groupName:g.name,storeName:oda?'Oda':store?.name.replace(/\s*[–-]\s*Kassal.*$/,'')??chainName(best.product.store),odaProductId:oda?Number(best.product.sourceUrl.match(/\/products\/(\d+)-/)[1]):null,unit:g.unit,unitPrice:round(best.unitPrice),packAmount:best.product.pack,packPrice:best.price.grossPackPrice});
    }
    return result;
  }
  function list(input) {
    const find=()=>{const entry=s.shoppingList.find(x=>x.id===input.id);if(!entry)throw Error('Finner ikke varen på listen.');return entry;};
    if(input.action==='add')return update(()=>listAdd(input));
    if(input.action==='route'){
      const entry=find(),storeName=required(input.storeName,'Butikk').slice(0,120),reason=required(input.reason,'Begrunnelse').slice(0,300);
      if(entry.checkedAt)throw Error('Varen er allerede kjøpt.');
      if(entry.need==='now'&&storeName==='Oda')throw Error('Trenger nå skal handles i en fysisk nærbutikk.');
      const odaProductId=input.odaProductId==null?null:Number(input.odaProductId);if(odaProductId!==null&&(!Number.isSafeInteger(odaProductId)||odaProductId<1))throw Error('Ugyldig Oda-vare.');
      const patch={imageUrl:/^https:\/\//.test(input.imageUrl??'')?String(input.imageUrl).slice(0,1000):entry.imageUrl??null,storeName,reason,routing:null,routeRetryAt:null,odaProductId,detail:input.matchedName?String(input.matchedName).slice(0,200):entry.detail,unitPrice:input.unitPrice==null?entry.unitPrice:positive(input.unitPrice,'pris'),unit:input.unit??entry.unit,packAmount:input.packAmount==null?entry.packAmount:positive(input.packAmount,'pakning'),packs:input.packs==null?entry.packs:positive(input.packs,'antall')};
      if(patch.packs!==null&&(!Number.isInteger(patch.packs)||patch.packs>1000)||patch.unit!==null&&!['kg','l','stk'].includes(patch.unit))throw Error('Ugyldig mengde eller enhet.');
      if(storeName==='Oda'&&(!odaProductId||!patch.packs))throw Error('Oda-valg krever produkt-ID og antall pakker.');
      return update(()=>{Object.assign(entry,patch);return entry;});
    }
    if(input.action==='toOda'){
      const entry=find(),w=s.watches[entry.watchId];
      if(entry.checkedAt)throw Error('Varen er allerede kjøpt.');
      if(entry.need==='now')throw Error('Trenger nå skal handles i en fysisk nærbutikk.');
      const choice=w?odaProducts().get(w.id)?.find(x=>x.productId===Number(input.productId)):null;if(!choice)throw Error('Varianten finnes ikke.');
      return update(()=>{
        const wanted=entry.packs&&entry.packAmount?entry.packs*entry.packAmount:0;
        s.odaChoices[w.id]=choice.productId;
        Object.assign(entry,{storeName:'Oda',storeId:null,offerId:null,odaProductId:choice.productId,detail:choice.name,packAmount:choice.packAmount,packs:wanted?Math.max(1,Math.ceil(wanted/choice.packAmount-.001)):1,unit:w.unit,unitPrice:round(choice.unitPrice),saving:null,reason:'Flyttet til Oda',routing:null,imageUrl:null,productKey:null});
        return entry;
      });
    }
    if(input.action==='choose'){
      const entry=find();
      if(entry.checkedAt||entry.routing!=='choose')throw Error('Varen venter ikke på et valg.');
      if(input.agent===true)return update(()=>{entry.routing='pending';entry.suggestions=null;return entry;});
      const option=(entry.suggestions??[]).find(x=>input.watchId?x.watchId===input.watchId:x.productKey===input.productKey);
      if(!option)throw Error('Forslaget finnes ikke lenger.');
      if(option.type==='watch'){
        const w=s.watches[option.watchId];if(!w)throw Error('Ukjent vare.');
        return update(()=>{const replaced=placeOnWatch(entry,w);if(replaced){s.shoppingList=s.shoppingList.filter(x=>x!==entry);return replaced;}return entry;});
      }
      const quote=libReader()?.quote(option.productKey);
      if(!quote?.price.fresh||quote.price.reasons.length)throw Error('Prisen er ikke lenger fersk. Velg en annen vare.');
      return update(()=>{Object.assign(entry,{suggestions:null,routing:null,storeName:option.storeName,odaProductId:option.odaProductId,detail:option.name,unit:option.unit,packAmount:option.packAmount,packs:1,unitPrice:option.unitPrice,reason:'Valgt fra produktbiblioteket'});return entry;});
    }
    if(input.action==='check'){
      const entry=find();if(entry.checkedAt)return structuredClone(entry);
      if(entry.offerId&&s.offers[entry.offerId]){dealAction({offerId:entry.offerId,action:'bought',packs:entry.packs});entry.boughtOffer=true;}
      else if(entry.watchId&&entry.packAmount&&s.watches[entry.watchId]){
        const w=s.watches[entry.watchId],stock=estimateStock(w,rateOf(needOf(w,analysis())),now().getTime());
        entry.undoStock={amount:w.stockAmount,checkedAt:w.stockCheckedAt,packs:w.stockPacks?{...w.stockPacks}:null};
        // Oda purchases come back through the delivered order instead.
        if(entry.storeName!=='Oda')s.purchases.push({id:randomUUID(),offerId:null,listEntryId:entry.id,watchId:w.id,name:w.name,storeId:null,packs:entry.packs,packAmount:entry.packAmount,unit:entry.unit,unitPrice:entry.unitPrice,referencePrice:null,total:entry.unitPrice?round(entry.unitPrice*entry.packAmount*entry.packs):null,saving:null,previousStock:entry.undoStock,at:now().toISOString()});
        if(!stock.known)w.stockPacks={};
        if(w.stockPacks)addCounted(w,entry.packAmount,entry.packs);
        w.stockAmount=round((stock.amount??0)+entry.packs*entry.packAmount);w.stockCheckedAt=now().toISOString();
      }
      return update(()=>{entry.checkedAt=now().toISOString();const cutoff=new Date(now().getTime()-14*86400000).toISOString();s.shoppingList=s.shoppingList.filter(x=>!x.checkedAt||x.checkedAt>=cutoff);return entry;});
    }
    if(input.action==='uncheck'){
      const entry=find();
      if(entry.boughtOffer)dealAction({offerId:entry.offerId,action:'undo'});
      else if(entry.undoStock&&s.watches[entry.watchId]){const w=s.watches[entry.watchId];w.stockAmount=entry.undoStock.amount;w.stockCheckedAt=entry.undoStock.checkedAt;w.stockPacks=entry.undoStock.packs;s.purchases=s.purchases.filter(p=>p.listEntryId!==entry.id);}
      return update(()=>{entry.checkedAt=null;delete entry.boughtOffer;delete entry.undoStock;return entry;});
    }
    if(input.action==='variant'){
      const w=s.watches[input.watchId];if(!w)throw Error('Ukjent vare.');
      const choice=odaProducts().get(w.id)?.find(x=>x.productId===Number(input.productId));if(!choice)throw Error('Varianten finnes ikke.');
      return update(()=>{
        s.odaChoices[w.id]=choice.productId;
        for(const e of listOpen())if(e.watchId===w.id&&e.storeName==='Oda'){const wanted=(e.packs??1)*(e.packAmount??choice.packAmount);Object.assign(e,{odaProductId:choice.productId,detail:choice.name,unitPrice:round(choice.unitPrice),packAmount:choice.packAmount,packs:Math.max(1,Math.round(wanted/choice.packAmount))});}
        return {saved:true};
      });
    }
    if(input.action==='cartError'){const entry=find();return update(()=>{entry.cartError=String(input.message??'').slice(0,200);return entry;});}
    if(input.action==='remove'){find();return update(()=>{s.shoppingList=s.shoppingList.filter(x=>x.id!==input.id);return {removed:true};});}
    if(input.action==='clear')return update(()=>{s.shoppingList=listOpen();return {cleared:true};});
    throw Error('Ukjent listevalg.');
  }
  // A proposed cart for the next big delivery. It only ever suggests; adding to
  // the real cart stays a separate, explicit family action.
  // A store can simply be cheap without a campaign. When its everyday price sits
  // well below the other chains and the family is running low, it is worth a trip.
  function steadyPrices(a,found,at) {
    const FRESH=48*3600000,campaign=new Set(found.opportunities.map(d=>d.watchId)),listed=new Set(listOpen().map(e=>e.watchId)),entries=new Map();
    for(const e of catalog.entries())if(e.status==='approved')entries.set(e.watchId+'|'+e.store+'|'+e.id,e);
    const result=[];
    for(const w of Object.values(s.watches)){
      const market=w.marketCalibration?.status==='ready'?w.marketCalibration:null;
      if(w.enabled===false||!market||campaign.has(w.id)||listed.has(w.id))continue;
      const cheapest=new Map();
      for(const p of quotesFor(w,found.prices))if(!cheapest.has(p.chainCode??p.storeId))cheapest.set(p.chainCode??p.storeId,{...p,currentUnitPrice:p.unitPrice});
      if(cheapest.size<2)continue;
      const prices=[...cheapest.values()],best=prices.sort((x,y)=>x.currentUnitPrice-y.currentUnitPrice)[0];
      const store=s.settings.stores.find(x=>x.chainCode===best.store);
      if(!store||/nettbutikk/i.test(store.name)||best.kind!=='catalog'||!(best.packAmount>0))continue;
      if(w.referenceCeiling&&at-Date.parse(w.referenceCeiling.checkedAt)>FRESH)continue;
      const paid=needRows(w,a).filter(p=>p.baselineAmount>0).map(p=>p.baselineTotal/p.baselineAmount);
      const referencePrice=comparisonReference(w,a,best,found.prices);
      if(referencePrice===null)continue;
      const diffPct=(referencePrice-best.currentUnitPrice)/referencePrice*100;
      if(diffPct<20)continue;
      const need=needOf(w,a);if(need.amount===null)continue;
      const stock=estimateStock(w,rateOf(need),at);
      if(stock.known&&stock.months!=null&&stock.months>=3)continue;
      const tier=dealTier({unitPrice:best.currentUnitPrice,excellentPrice:w.excellentPrice,discountPct:diffPct,referenceType:'market'});
      const plan=planQuantities({tier,need,shelfMonths:shelfLifeMonths(w),stock,offer:{packAmount:best.packAmount,bundlePacks:1,price:best.currentUnitPrice*best.packAmount},caps:[100,w.maxPacks],unitSaving:Math.max(0,referencePrice-best.currentUnitPrice)});
      const recommended=plan.recommended;
      if(plan.covered||!recommended||recommended.saving<Math.max(100,store.minSavings))continue;
      const {months,packs,saving}=recommended;
      const entry=entries.get(w.id+'|'+best.store+'|'+best.id);
      result.push({watchId:w.id,name:w.name,productName:best.name,storeName:store.name.replace(/\s*[–-]\s*Kassal.*$/,''),unit:w.unit,unitPrice:round(best.currentUnitPrice),referencePrice:round(referencePrice),diffPct:Math.round(diffPct),packs,packAmount:best.packAmount,cost:recommended.cost,saving,months,stock,sourceUrl:entry?.sourceUrl??best.sourceUrl??null,image:imageRef(entry?.image)});
    }
    const rank=x=>x.stock.known?0:1;
    return result.sort((x,y)=>rank(x)-rank(y)||y.saving-x.saving).slice(0,8);
  }
  function odaDraft(a,today,at,found) {
    const dates=[...new Set(orders().map(o=>o.deliveryDate))].sort(),gaps=dates.slice(1).map((day,i)=>(Date.parse(day)-Date.parse(dates[i]))/86400000).sort((x,y)=>x-y);
    const gapDays=gaps.length>=2?gaps[Math.floor((gaps.length-1)/2)]:s.settings.stockUpDays??60,gapMonths=gapDays/30.44;
    const estimated=dates.length?shoppingDay(new Date(Date.parse(dates.at(-1))+gapDays*86400000)):today;
    const fromList=listOpen().filter(e=>e.storeName==='Oda'&&e.odaProductId);
    const listed=new Map();for(const e of listOpen())if(e.watchId&&e.packAmount&&!(e.storeName==='Oda'&&e.odaProductId))listed.set(e.watchId,(listed.get(e.watchId)??0)+e.packs*e.packAmount);
    const odaItems=odaProducts(found.prices);
    const items=[],missing=[];let covered=0;
    for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      const need=needOf(w,a);if(need.amount===null)continue;
      const options=odaItems.get(w.id);if(!options){missing.push(w.name);continue;}
      const best=defaultOda(w,options),normal=w.priceGuide?.referencePrice??null,reference=comparisonReference(w,a,best,found.prices),discountPct=reference?(reference-best.unitPrice)/reference*100:0;
      const dear=!!normal&&best.unitPrice>normal*1.05,tier=dear?'dear':reference&&discountPct>=8?dealTier({unitPrice:best.unitPrice,excellentPrice:w.excellentPrice,discountPct,referenceType:'market'}):'small';
      const shelf=shelfLifeMonths(w),months=Math.min(shelf,dear?Math.min(1,gapMonths):tier==='excellent'?12:tier==='good'?3:Math.min(1,gapMonths));
      const stock=estimateStock(w,rateOf(need),at),needed=need.amount/12*months-(stock.amount??0)-(listed.get(w.id)??0);
      if(needed<=0){covered++;continue;}
      const wanted=packsFor(needed,{packAmount:best.packAmount,bundlePacks:1,cap:100}),limit=s.odaLimits[best.productId]??null,nameLimit=best.name.match(/maks\s+(\d+)/i),max=limit?.max??(nameLimit?Number(nameLimit[1]):null),packs=max!=null?Math.min(max,wanted):wanted;
      const elsewhere=betterThanOda(w,best.unitPrice,Math.max(wanted*best.packAmount,need.amount/12*Math.min(shelf,gapMonths)),found,at);
      items.push({...variantBlock(w,options,best.productId,found.prices,best,best.unitPrice,{annual:need.amount}),image:imageRef(best.image),pills:best.pills??null,productKey:`kassal:${best.store}:${best.id}`,watchId:w.id,name:w.name,productId:best.productId,productName:best.name,packAmount:best.packAmount,unit:w.unit,packs,wanted,maxAtOda:max,limitChecked:limit?.checkedAt??null,elsewhere,entryIds:[],packPrice:best.currentPrice,unitPrice:round(best.unitPrice),cost:round(best.currentPrice*packs),tier,stockKnown:stock.known,storage:w.storage});
    }
    for(const e of fromList){
      const row=items.find(x=>(e.watchId&&x.watchId===e.watchId)||x.productId===e.odaProductId),count=e.packs??1;
      if(row){row.wanted=Math.max(row.wanted,count);row.packs=Math.max(row.packs,row.maxAtOda!=null?Math.min(row.maxAtOda,count):count);row.cost=round(row.packPrice*row.packs);row.entryIds.push(e.id);continue;}
      const limit=s.odaLimits[e.odaProductId]?.max??null;
      items.push({variants:[],image:e.imageUrl?imageRef(e.imageUrl):null,watchId:e.watchId??'list:'+e.id,name:e.name,productId:e.odaProductId,productName:e.detail??e.name,packAmount:e.packAmount,unit:e.unit,packs:limit!=null?Math.min(limit,count):count,wanted:count,maxAtOda:limit,limitChecked:s.odaLimits[e.odaProductId]?.checkedAt??null,elsewhere:null,entryIds:[e.id],packPrice:e.unitPrice&&e.packAmount?round(e.unitPrice*e.packAmount):0,unitPrice:e.unitPrice,cost:e.unitPrice&&e.packAmount?round(e.unitPrice*e.packAmount*count):0,tier:'small',stockKnown:true,storage:null});
    }
    items.sort((x,y)=>y.cost-x.cost);
    return {nextAround:estimated<today?today:estimated,items,missing,covered,total:round(items.reduce((n,x)=>n+x.cost,0))};
  }
  function link(input) {
    const key=required(input.productKey,'Produktnøkkel');if(!orders().some(o=>o.products.some(p=>p.productKey===key)))throw Error('Ukjent produkt.');
    const w=input.watchId==null?null:s.watches[input.watchId];if(input.watchId!=null&&!w)throw Error('Ukjent overvåkning.');
    const evidence=required(input.evidence,'Koblingsbelegg');
    return update(()=>{s.productLinks[key]={watchId:w?.id??null,evidence,at:now().toISOString()};if(w&&!w.productKeys.includes(key)){w.productKeys.push(key);refillLinked(w,key);}return s.productLinks[key];});
  }
  // A line delivered before it was linked still belongs in counted stock. The
  // count time stays, since the burn-down still starts from that count.
  function refillLinked(w,key) {
    if(w.stockAmount==null||!w.stockCheckedAt)return;
    for(const order of orders()){
      if(order.deliveryDate<w.stockCheckedAt.slice(0,10))continue;
      for(const p of order.products)if(p.productKey===key&&p.pack?.unit===w.unit){w.stockAmount=round(w.stockAmount+p.quantity*p.pack.amount);if(w.stockPacks)addCounted(w,p.pack.amount,p.quantity);}
    }
  }
  function nutritionRecords() {
    const reader=libReader(),derived={};
    if(reader)for(const order of orders())for(const p of order.products){
      if(!p.odaProductId||derived[p.productKey])continue;
      const key=reader.byOdaId(p.odaProductId),n=key?reader.product(key)?.nutrition:null;
      if(!n||!reader.quote(key).reviewCurrent)continue;
      try{derived[p.productKey]={...validateNutrition({productKey:p.productKey,basis:n.basis,per100:n.per100,sourceUrl:n.sourceUrl,evidence:'Gjennomgått etikett for samme Oda-produkt i produktbiblioteket.'}),origin:'library'};}catch{}
    }
    return {...derived,...s.nutrition};
  }
  function linkCandidates(w,reader,rows=catalog.entries(w.id)) {
    const votes=new Map();
    for(const e of rows)if(e.status==='approved')for(const m of reader.groupsOf(`kassal:${e.store}:${e.id}`))if(m.s==='approved'&&m.r)votes.set(m.groupId,(votes.get(m.groupId)??0)+1);
    return [...votes].sort((a,b)=>b[1]-a[1]).flatMap(([groupId,count])=>{const members=reader.members(groupId).filter(m=>m.status==='approved').length;if(!members)return [];const g=reader.group(groupId);return [{groupId,name:g.name,category:g.category,unit:g.unit,fingerprint:g.fingerprint,inclusion:g.inclusion,exclusions:g.exclusions,matchingApproved:count,members}];});
  }
  const groupRows=entries=>{const map=new Map();for(const e of entries){const list=map.get(e.watchId)??[];list.push(e);map.set(e.watchId,list);}return map;};
  function libraryAudit() {
    const reader=libReader();
    if(!reader)return {status:libraryPrices?.status?.()??'disabled',findings:[],noGroup:[],multiGroup:[],links:null};
    const findings=[],entries=catalog.entries(),byWatch=groupRows(entries);
    const add=(kind,e,detail,signature)=>{const id=hash(JSON.stringify([kind,e.watchId,e.store,e.id,e.fingerprint,signature]));if(!s.libraryAcks[id])findings.push({id,kind,watchId:e.watchId,watchName:s.watches[e.watchId]?.name,store:e.store,productId:e.id,name:e.name,fingerprint:e.fingerprint,...detail});};
    for(const e of entries){
      if(e.status!=='approved'||s.watches[e.watchId]?.enabled===false)continue;
      const key=`kassal:${e.store}:${e.id}`,inLibrary=reader.active(key);
      if(priceTooOld(e)&&!inLibrary)continue;
      const named=namedPackConflict(e.name,e.packAmount,e.unit);
      if(named!==null)add('name-pack-conflict',e,{reviewedPack:e.packAmount,namedPack:named,unit:e.unit},named);
      const p=reader.product(key);if(!p||!inLibrary)continue;
      const rows=reader.groupsOf(key);
      if(rows.length&&!rows.some(m=>m.s==='approved'&&m.r))add('library-not-approved',e,{libraryStatus:rows.map(m=>({groupId:m.groupId,group:reader.group(m.groupId)?.name,status:m.s}))},rows.map(m=>m.groupId+':'+m.s).sort());
      else if(p.pack>0&&(p.unit!==e.unit||Math.abs(p.pack-e.packAmount)>p.pack*.01))add('library-pack-conflict',e,{reviewedPack:e.packAmount,reviewedUnit:e.unit,libraryPack:p.pack,libraryUnit:p.unit},[p.pack,p.unit]);
    }
    const enabled=Object.values(s.watches).filter(w=>w.enabled!==false),candidates=new Map(enabled.map(w=>[w.id,linkCandidates(w,reader,byWatch.get(w.id)??[])]));
    return {status:'ready',builtAt:reader.builtAt,findings,noGroup:enabled.filter(w=>!candidates.get(w.id).length&&!w.libraryLinks?.length).map(w=>({watchId:w.id,name:w.name})),multiGroup:enabled.filter(w=>candidates.get(w.id).length>1).map(w=>({watchId:w.id,name:w.name,groups:candidates.get(w.id).map(g=>g.name)})),links:{linked:enabled.filter(w=>w.libraryDecision?.status==='linked').length,declined:enabled.filter(w=>w.libraryDecision?.status==='none').length,undecided:enabled.filter(w=>!w.libraryDecision&&candidates.get(w.id).length).length}};
  }
  function libraryAuditAck(input) {
    if(!Array.isArray(input.items)||!input.items.length||input.items.length>500)throw Error('Oppgi 1–500 funn.');
    const open=new Map(libraryAudit().findings.map(x=>[x.id,x]));
    const rows=input.items.map(x=>{if(!open.has(x.id))throw Error('Ukjent eller allerede behandlet funn.');return [x.id,{evidence:required(x.evidence,'Vurderingsbelegg'),at:now().toISOString()}];});
    return update(()=>{for(const [id,entry] of rows)s.libraryAcks[id]=entry;return {acknowledged:rows.length};});
  }
  function libraryLinkCandidates(watchId) {
    const reader=libReader();if(!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    const list=watchId?[s.watches[watchId]]:Object.values(s.watches).filter(w=>w.enabled!==false);
    if(list.some(w=>!w))throw Error('Ukjent overvåkning.');
    return list.map(w=>({watchId:w.id,name:w.name,unit:w.unit,note:w.note??'',decision:w.libraryDecision??null,links:linkStates(w,reader).map(({group,...link})=>link),excludedCatalogRows:catalog.entries(w.id).filter(e=>e.status==='excluded').map(e=>({productKey:`kassal:${e.store}:${e.id}`,name:e.name,reason:e.equivalenceEvidence})),candidates:linkCandidates(w,reader)}));
  }
  function libraryLink(input) {
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent overvåkning.');
    const evidence=required(input.evidence,'Koblingsbelegg');
    if(!Array.isArray(input.links)||input.links.length>10)throw Error('Oppgi høyst ti koblinger.');
    const reader=libReader();if(input.links.length&&!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    const at=now().toISOString(),links=input.links.map(link=>{
      const g=reader.group(link.groupId);if(!g)throw Error('Ukjent bibliotekgruppe.');
      if(link.groupFingerprint!==g.fingerprint)throw Error('Bibliotekgruppen er endret. Vurder gjeldende fingeravtrykk.');
      if(g.unit!==w.unit)throw Error('Bibliotekgruppens enhet stemmer ikke med varegruppen.');
      const requires=link.requires??[],brands=link.brands??[],excludeProductKeys=link.excludeProductKeys??[];
      if(!Array.isArray(requires)||requires.some(x=>!LINK_REQUIREMENTS.has(x))||!Array.isArray(brands)||brands.some(x=>!text(x))||!Array.isArray(excludeProductKeys)||excludeProductKeys.some(x=>!reader.product(x)))throw Error('Ugyldige krav i bibliotekkoblingen.');
      return {groupId:link.groupId,groupFingerprint:g.fingerprint,evidence:required(link.evidence,'Gruppebelegg'),requires,brands,excludeProductKeys,reviewedAt:at};
    });
    return update(()=>{w.libraryLinks=links;w.libraryDecision={status:links.length?'linked':'none',evidence,at};return {watchId:w.id,decision:w.libraryDecision,links};});
  }
  function libraryWork() {
    const reader=libReader();if(!reader)return [];
    const audit=libraryAudit(),rows=groupRows(catalog.entries()),findings=new Map();for(const f of audit.findings){const list=findings.get(f.watchId)??[];list.push(f.id);findings.set(f.watchId,list);}
    const work=[...findings].map(([watchId,ids])=>({do:'shopping-library-audit',watchId,watchName:s.watches[watchId]?.name,findings:ids.length,fingerprint:hash(ids.sort().join())}));
    for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      const broken=linkStates(w,reader).filter(l=>l.state!=='ok');
      if(broken.length){work.push({do:'shopping-library-link',watchId:w.id,watchName:w.name,reason:'group-changed',groups:broken.map(l=>l.groupId),fingerprint:hash(broken.map(l=>l.groupId+l.state+(l.group?.fingerprint??'')).join())});continue;}
      if(w.libraryDecision)continue;
      const candidates=linkCandidates(w,reader,rows.get(w.id)??[]);
      if(candidates.length)work.push({do:'shopping-library-link',watchId:w.id,watchName:w.name,reason:'undecided',groups:candidates.map(g=>g.groupId),fingerprint:hash(candidates.map(g=>g.groupId+g.fingerprint).join())});
    }
    return work;
  }
  // Everything the library knows about one product, for the family's item card.
  // Labels are shown as data; a score is only ranked against the same measurement.
  function productInfo(input) {
    const reader=libReader(),w=input.watchId&&Object.hasOwn(s.watches,input.watchId)?s.watches[input.watchId]:null;
    if(!reader)return {available:false,product:null,groups:[],watchName:w?.name??null};
    let key=input.key&&reader.product(input.key)?input.key:null;
    if(!key&&w){const options=odaProducts().get(w.id);if(options){const o=defaultOda(w,options),found=`kassal:${o.store}:${o.id}`;if(reader.product(found))key=found;}}
    if(!key)return {available:true,product:null,groups:[],watchName:w?.name??null};
    const p=reader.product(key),price=reader.quote(key).price,store=s.settings.stores.find(x=>x.chainCode===p.store);
    const peersOf=m=>{
      if(!m.q)return {rank:null,of:null,peers:[]};
      const best=new Map();
      for(const x of reader.members(m.groupId)){
        if(x.quality?.key!==m.q.key||x.status!=='approved'||!x.reviewCurrent)continue;
        const name=x.product.name.toLocaleLowerCase('nb-NO'),seen=best.get(name),row={name:x.product.name,score:x.quality.score,own:x.productKey===key,unitPrice:x.eligible?round(x.unitPrice):null};
        if(!seen||row.own||!seen.own&&(row.unitPrice??Infinity)<(seen.unitPrice??Infinity))best.set(name,row);
      }
      const ranked=[...best.values()].sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'nb')),mine=ranked.find(x=>x.own);
      // Equal scores share a place, so a tie never reads as a worse product.
      return {rank:mine?ranked.filter(x=>x.score>mine.score).length+1:null,of:ranked.length,peers:[...new Set([...ranked.slice(0,6),...ranked.filter(x=>x.own)])]};
    };
    const readable=value=>value?value.replace(/\s*Kildens per100-verdier:\s*\{[^}]*\}?\.?/g,'').trim():null;
    const groups=reader.groupsOf(key).map(m=>{const g=reader.group(m.groupId);return {name:g.name,category:g.category,status:m.s,inclusion:g.inclusion,comparisonBasis:g.comparisonBasis,qualityBasis:g.qualityBasis,equivalenceEvidence:readable(m.e),qualityEvidence:m.qe,quality:m.q?{score:m.q.score,label:m.q.label,criterion:m.q.criterion,value:m.q.value,unit:m.q.unit,evidence:m.q.evidence,limitations:reader.qualityNote(m.q.key),...peersOf(m)}:null,nutrition:m.n??null,value:reader.valueDetail(key,m.groupId),qualityStatus:m.qs,qualityReason:m.qr};}).sort((a,b)=>Number(b.status==='approved')-Number(a.status==='approved')||Number(!!b.quality)-Number(!!a.quality));
    return {available:true,watchName:w?.name??null,product:{key,name:p.name,brand:p.brand,ean:p.ean,storeName:p.store==='ODA_NO'?'Oda':store?cleanStore(store.name):chainName(p.store),packAmount:p.pack,unit:p.unit,packEvidence:p.packEvidence,ingredients:p.ingredients,description:p.description,labels:Object.entries(p.attributes??{}).filter(([,value])=>value===true).map(([name])=>name),nutrition:p.nutrition,sourceUrl:/^https:\/\//.test(p.sourceUrl??'')?p.sourceUrl:null,image:imageRef(p.image),pills:reader.pills(key),price:{grossPackPrice:price.grossPackPrice,fresh:price.fresh,receiptAt:price.receiptAt}},groups};
  }
  // A flyer offer is fresh evidence by itself, so it shows even when every library
  // row for that chain is parked. Only a watch's reviewed links place it in a family.
  function explorerOffers() {
    const today=shoppingDay(now()),reader=libReader();
    return Object.values(s.offers).flatMap(o=>{
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId);
      if(o.validFrom>today||o.validTo<today||!o.comparable||!w||w.enabled===false||!store)return [];
      const groups=linkStates(w,reader).filter(l=>l.state==='ok').map(l=>l.groupId);
      return groups.length?[{id:o.id,name:o.name,storeName:store.chainCode?chainName(store.chainCode):cleanStore(store.name),price:o.price,packAmount:o.packAmount,unit:o.unit,unitPrice:round(o.price/o.packAmount),validTo:o.validTo,memberOnly:o.memberOnly,conditions:o.conditions??null,maxPacks:o.maxPacks,bundlePacks:o.bundlePacks,comparisonNote:o.comparisonNote,sourceUrl:o.sourceUrl,groups}]:[];
    });
  }
  const explorer=createLibraryExplorer({reader:libReader,imageRef,chainName,ownStores:()=>['ODA_NO',...s.settings.stores.map(x=>x.chainCode).filter(Boolean)],status:()=>libraryPrices?.status?.()??'disabled',activeOffers:explorerOffers});
  function librarySearch(query,limit=30) {
    const reader=libReader();if(!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    return reader.search(String(query??'').slice(0,200),Math.min(200,Number(limit)||30)).map(({key,product,groups,price})=>({productKey:key,name:product.name,brand:product.brand,store:product.store,ean:product.ean,canonicalPackAmount:product.pack,unit:product.unit,packDocumented:product.packKnown,groups,grossPackPrice:price.grossPackPrice,receiptAt:price.receiptAt,priceFresh:price.fresh}));
  }
  // Barcode lookups only name products the family's own review or an explicit
  // group link already covers. A scan is the family's action; nothing is guessed.
  function scanLookup(code) {
    const ean=String(code??'').replace(/\D/g,'');if(!/^\d{8,14}$/.test(ean))throw Error('Ugyldig strekkode.');
    const plain=ean.replace(/^0+/,''),found=new Map(),reader=libReader();
    const add=(w,packAmount,productName)=>{if(!(packAmount>0))return;const key=w.id+'|'+packAmount;if(!found.has(key))found.set(key,{watchId:w.id,name:w.name,unit:w.unit,packAmount,productName});};
    for(const e of catalog.entries())if(e.status==='approved'&&e.ean?.replace(/^0+/,'')===plain&&s.watches[e.watchId]&&!variablePack(e.name))add(s.watches[e.watchId],e.packAmount,e.name);
    let known=null;
    if(reader)for(const key of reader.byEan(ean)){
      const p=reader.product(key);known??=p.name;
      if(variablePack(p.name))continue;
      // A scanned product is in the family's hands; an old price says nothing about that.
      for(const w of Object.values(s.watches))if(linkedMembers(w,reader,{includeParked:true}).has(key)&&p.unit===w.unit)add(w,p.pack,p.name);
    }
    return {ean,options:[...found.values()],knownProduct:known};
  }
  function stockScan(input) {
    if(input.action==='undo'){
      const entry=s.scanLog.find(x=>x.id===input.id),w=entry&&s.watches[entry.watchId];if(!w)throw Error('Finner ikke skanningen.');
      if(w.stockAmount!==entry.after.amount||w.stockCheckedAt!==entry.after.checkedAt)throw Error('Lageret er endret etter skanningen. Juster varen direkte.');
      return update(()=>{w.stockAmount=entry.previous.amount;w.stockCheckedAt=entry.previous.checkedAt;w.stockPacks=entry.previous.packs;s.scanLog=s.scanLog.filter(x=>x!==entry);return {undone:true};});
    }
    const result=scanLookup(input.ean);
    if(input.action!=='apply')return result;
    const repeated=input.clientId&&s.scanLog.find(x=>x.clientId===input.clientId);if(repeated)return {saved:true,id:repeated.id,amount:repeated.after.amount};
    const option=result.options.find(x=>x.watchId===input.watchId&&x.packAmount===input.packAmount);if(!option)throw Error('Skanningen passer ikke denne varen.');
    const count=Number(input.count);if(!Number.isInteger(count)||!count||Math.abs(count)>24)throw Error('Ugyldig antall.');
    const w=s.watches[option.watchId],stock=estimateStock(w,rateOf(needOf(w,analysis())),now().getTime());
    if(count<0&&!stock.known)throw Error('Denne varen er ikke talt ennå. Tell den først.');
    return update(()=>{
      const previous={amount:w.stockAmount,checkedAt:w.stockCheckedAt,packs:w.stockPacks?{...w.stockPacks}:null};
      if(!stock.known)w.stockPacks={};
      if(w.stockPacks){addCounted(w,option.packAmount,count);const size=String(Math.round(option.packAmount*1000)/1000);if(w.stockPacks[size]<=0)delete w.stockPacks[size];}
      w.stockAmount=Math.max(0,round((stock.amount??0)+count*option.packAmount));w.stockCheckedAt=now().toISOString();delete w.stockEvidence;
      const id=randomUUID();s.scanLog.push({id,clientId:input.clientId??null,watchId:w.id,previous,after:{amount:w.stockAmount,checkedAt:w.stockCheckedAt},at:now().toISOString()});s.scanLog=s.scanLog.slice(-30);
      return {saved:true,id,amount:w.stockAmount,name:w.name,unit:w.unit};
    });
  }
  function cartReceipt(id,patch) {return update(()=>s.cartReceipts[id]={...(s.cartReceipts[id]??{}),...patch,id,updatedAt:now().toISOString()});}
  return {explorer,productInfo,libraryAudit,libraryAuditAck,libraryLinkCandidates,libraryLink,librarySearch,stockScan,stockIntake,feedFingerprint,completion,odaLimit:id=>s.odaLimits[id]?.max??null,imageSource,cartReview,recordOdaLimit,listRouteWork,listRouteAttempt,listRouteFinish,list,offerSource,feed,checklist,familyView,familySummary,pantry,item,dealAction,link,importOrders,settings,watch,offer,review,nutrition,market,catalogObserve,catalogReview,catalogEntries:watchId=>catalog.entries(watchId),analysis,queue,view,cartReceipt,receipt:id=>structuredClone(s.cartReceipts[id]??null)};
}
