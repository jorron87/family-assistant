import {createHash,randomUUID} from 'node:crypto';
import {validateNutrition,purchaseNutrition} from './shopping-nutrition.mjs';
import {calibrateMarket} from './shopping-market.mjs';
import {createMarketCatalog} from './shopping-catalog.mjs';
import {createStockIntake} from './shopping-stock.mjs';
import {createLibraryExplorer,familyDetail} from './library-explorer.mjs';
import {withinPriceHorizon} from './shopping-library.mjs';
import {createSesumPrices} from './sesum-prices.mjs';
import {createSesumDiscovery} from './sesum-discovery.mjs';
import {createSesumCatalogue} from './sesum-catalogue.mjs';
import {sesumCollectionCompletion} from './sesum-completion.mjs';
import {campaignFingerprint,offerTermsFingerprint,validateCampaignOffer} from './sesum-campaigns.mjs';
import {productTextHash} from './product-library.mjs';
import {annualNeed,chainName,commonPacks,dealScore,packsFor,dealTier,defaultShelfLifeMonths,estimateStock,packBreakdown,planQuantities,shelfLifeMonths,shelfWithDate} from './shopping-planning.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const priceContextExclusions=Symbol('shopping-price-exclusions');
const catalogKey=p=>p.productKey??`kassal:${p.store}:${p.id}`;
const round=n=>Math.round((n+Number.EPSILON)*100)/100;
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
const required=(v,label)=>{const s=text(v);if(!s)throw Error(`${label} mangler.`);return s;};
const safeId=(v,label)=>{const s=required(v,label);if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(s)||['__proto__','constructor','prototype'].includes(s))throw Error(`Ugyldig ${label}.`);return s;};
const positive=(v,label,zero=false)=>{const n=Number(v);if(!Number.isFinite(n)||n<0||(!zero&&n===0))throw Error(`Ugyldig ${label}.`);return n;};
export const shoppingDay=(at=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
const day=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value??'')||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error('Ugyldig dato.');return value;};
const url=value=>{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password)throw Error('Kildelenken må bruke HTTPS.');return u.href;};
const isSesumSource=value=>{try{return /(^|\.)sesum\.no$/i.test(new URL(value).hostname.toLowerCase().replace(/\.$/,''));}catch{return false;}};
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

const NAME_NOISE=new Set(['g','kg','ml','cl','dl','l','stk','pk','pakke','pakning','x','av','med','og','i','original','classic']);
/** True when two names describe one product line and differ at most in brand words and pack size. */
export function sameProductLine(a,b,brand='') {
  const brandWords=new Set(normalized(brand).split(' '));
  const words=value=>normalized(value).split(' ').filter(w=>w&&!/\d/.test(w)&&!NAME_NOISE.has(w)&&!brandWords.has(w));
  const left=words(a),right=words(b),match=(x,y)=>x===y||x.length>=4&&y.length>=4&&(x.endsWith(y)||y.endsWith(x));
  return left.length>0&&right.length>0&&left.every(x=>right.some(y=>match(x,y)))&&right.every(y=>left.some(x=>match(x,y)));
}

/** Barcode when known, otherwise brand, name and pack. "x|" rows have nothing that proves a match. */
export const productIdentity=row=>{const ean=String(row.ean??'').replace(/^0+/,'');return ean?'e'+ean:(row.brand?'n|'+normalized(row.brand):'x|')+'|'+normalized(row.name)+'|'+row.packAmount;};
export const duplicateKey=(a,b)=>[a,b].sort().join('||');
/** Rows a machine cannot settle: same line and pack, but no shared identity to prove it. */
export function duplicatePairs(rows) {
  const byId=new Map();
  for(const row of rows){
    if(row.offer||row.odaProductId||!(row.packAmount>0))continue;
    const id=productIdentity(row),seen=byId.get(id)??{id,name:row.name,brand:row.brand??null,ean:row.ean??null,packAmount:row.packAmount,stores:[],sourceUrl:row.sourceUrl??null};
    if(!seen.stores.includes(row.storeName))seen.stores.push(row.storeName);
    byId.set(id,seen);
  }
  const list=[...byId.values()],pairs=[];
  for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
    const a=list[i],b=list[j];
    if(a.brand&&b.brand&&normalized(a.brand)!==normalized(b.brand))continue;
    if(Math.abs(a.packAmount-b.packAmount)>a.packAmount*.01)continue;
    if(sameProductLine(a.name,b.name,a.brand??b.brand??''))pairs.push({key:duplicateKey(a.id,b.id),a,b});
  }
  return pairs;
}

/** One row per physical product: the cheapest of the family's own stores, the rest as "also at". */
export function collapseSameProduct(rows,aliases={}) {
  const groups=new Map(),out=[];
  for(const row of rows){
    const id=productIdentity(row),key=aliases[id]??(id.startsWith('x|')?null:id);
    if(row.offer||row.odaProductId||!key){out.push({...row,alsoAt:[]});continue;}
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  for(const list of groups.values()){
    list.sort((a,b)=>a.unitPrice-b.unitPrice);
    const chosen=list.find(x=>x.own)??list[0];
    out.push({...chosen,alsoAt:list.filter(x=>x!==chosen).map(x=>({storeName:x.storeName,unitPrice:x.unitPrice,own:x.own}))});
  }
  return out;
}

export function shoppingStore(state,{save,now=()=>new Date(),files,libraryPrices,sesumCollectionStatus}={}) {
  state.shopping??={orders:{},watches:{},offers:{},reviews:{},cartReceipts:{},settings:{monitoringEnabled:false,historyFrom:null,stores:[],storageNote:'',stockUpDays:60}};
  const s=state.shopping;
  s.nutrition??={};
  s.marketCatalog??={};
  s.dealDecisions??={};
  s.purchases??=[];
  s.priceHistory??={};
  s.priceHistoryBasis??={};
  s.priceHistoryArchive??={};
  s.productLinks??={};
  s.feedReviewed??={};
  s.feedRead??={};
  s.shoppingList??=[];
  s.odaLimits??={};
  s.odaChoices??={};
  s.libraryAcks??={};s.listFamilies??={};s.sameProducts??={};s.sameProductDecisions??={};
  // One concept: a followed family holds the household's numbers and its variants.
  if(s.familySchema!==1){
    s.familyMigration??={at:now().toISOString(),before:{}};
    for(const w of Object.values(s.watches)){
      if(!('libraryLinks' in w)&&!('libraryDecision' in w))continue;
      s.familyMigration.before[w.id]={libraryLinks:w.libraryLinks??[],libraryDecision:w.libraryDecision??null};
      w.variants=w.libraryLinks??[];
      if(w.libraryDecision)w.family={kind:w.libraryDecision.status==='none'?'own':'library',evidence:w.libraryDecision.evidence,at:w.libraryDecision.at};
      delete w.libraryLinks;delete w.libraryDecision;
    }
    s.familySchema=1;
  }
  s.scanLog??=[];
  const catalog=createMarketCatalog(s.marketCatalog,{save,now});
  s.sesumPrices??={};
  s.sesumDiscovery??={};
  s.sesumFamilyReviews??={};
  s.sesumPlacementReviews??={};
  s.sesumPlacementTargets??={};
  s.sesumCatalogue??={};s.sesumCatalogueReviews??={};
  s.sesumOfferReviews??={};
  let sesumPrices;
  const sesumCatalogue=createSesumCatalogue(s.sesumCatalogue,{save,now,horizonDays:()=>libraryPrices?.reader?.()?.horizonDays??183,knownOwnReceipts:source=>Object.values(s.sesumPrices.products??{}).filter(row=>row.source.id===source.id).map(row=>({source:row.source,price:row.receipt}))});
  const discovery=createSesumDiscovery(s.sesumDiscovery,{save,now,reader:()=>libraryPrices?.reader?.()??null,source:key=>{const row=sesumPrices?.sourceRecord(key);return row&&sesumCatalogue.current(row.source)?row:null;}});
  const reviewedReader=()=>discovery.overlay(libraryPrices?.reader?.()??null);
  sesumPrices=createSesumPrices(s.sesumPrices,{save,now,reader:reviewedReader,nativeEntries:()=>catalog.entries(),sourceCurrent:source=>sesumCatalogue.current(source)});
  const orders=()=>Object.values(s.orders);
  const freshPrice=(time,at=now().getTime())=>Number.isFinite(Date.parse(time))&&at-Date.parse(time)>=0&&at-Date.parse(time)<=48*3600000;
  const variablePack=name=>/(?:^|\s)ca\.?\s*\d|cirka|omtrent|vektvare|\b(?:pr|per)\.?\s*kg\b/i.test(name??'');
  const libReader=()=>sesumPrices.overlay(reviewedReader());
  // Library groups lend products only to chains the family actually shops in;
  // short-dated and wholesale web shops stay out of everyday comparisons.
  const linkChains=()=>new Set(['ODA_NO',...s.settings.stores.filter(x=>x.chainCode&&!/nettbutikk/i.test(x.name)).map(x=>x.chainCode)]);
  const linkStates=(w,reader)=>(w.variants??[]).map(link=>{const group=reader?.group(link.groupId)??null;return {...link,group,state:!reader?'unavailable':!group?'missing':group.fingerprint!==link.groupFingerprint?'changed':group.unit!==w.unit?'unit':'ok'};});
  function linkedMembers(w,reader,{allChains=false,includeParked=false,ignoreScopedExclusions=false,excludedSet=null}={}) {
    const found=new Map(),chains=linkChains(),excluded=ignoreScopedExclusions?new Set():excludedSet??sesumScopedExclusions(w,reader);
    for(const link of linkStates(w,reader)){
      if(link.state!=='ok')continue;
      for(const m of reader.members(link.groupId,{all:includeParked})){
        if(m.status!=='approved'||!m.reviewCurrent||!allChains&&!chains.has(m.product.store)||found.has(m.productKey)||scopedProductHeld(excluded,m.product,m.productKey)||[m.productKey,m.product.nativeIdentity?.key,m.product.donorProductKey].some(key=>key&&link.excludeProductKeys?.includes(key)))continue;
        if(link.brands?.length&&!link.brands.some(b=>normalized(m.product.brand).includes(normalized(b))))continue;
        if((link.requires??[]).some(key=>m.product.attributes?.[key]!==true))continue;
        found.set(m.productKey,m);
      }
    }
    return found;
  }
  const nativeHoldsMember=(p,productKey,watchId,entries)=>{
    const identity=p.nativeIdentity??p,key=p.nativeIdentity?.key??p.donorProductKey??productKey;
    const samePack=(a,b)=>Number.isFinite(a)&&a>0&&Number.isFinite(b)&&b>0&&Math.abs(a-b)<=1e-6*Math.max(a,b);
    return entries.some(e=>e.watchId===watchId&&key===catalogKey(e)&&(e.status==='excluded'||identity.textHash!==productTextHash(e)||e.status==='approved'&&(!samePack(e.packAmount,identity.pack)||e.unit!==identity.unit)||identity.rawPack&&(identity.rawPack.weight!==e.weight||String(identity.rawPack.weightUnit??'').trim()!==String(e.weightUnit??'').trim())));
  };
  function currentPrices() {
    const at=now().getTime(),today=shoppingDay(now()),entries=catalog.entries(),native=new Map(),library=sesumPrices.provide(entries,libraryPrices?.(entries)??{status:'disabled',quotes:[]});
    const key=p=>`${p.watchId}|${catalogKey(p)}`;
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
      native.set(k,{...e,packAmount,price:valid&&packAmount>0?p.grossPackPrice??unitPrice*packAmount:null,unitPrice:valid?unitPrice:null,lastChecked:p.receiptAt,priceSource:'library',priceSourceUrl:p.sourceUrl??e.priceSourceUrl??e.sourceUrl});
    }
    // An explicit, reviewed group link adds its other products. Any native row
    // for the same product wins, so a family exclusion always holds.
    const reader=libReader(),exclusionsByFamily=new Map();
    const hasScopedExclusions=Object.values(s.sesumFamilyReviews).some(rows=>Object.values(rows).some(row=>row.status==='excluded'||row.holdExcluded===true));
    const approvedByKey=reader&&hasScopedExclusions?new Map(sesumPrices.approvedSources().map(source=>[source.sourceKey,source])):null;
    const exclusionsFor=w=>{if(!exclusionsByFamily.has(w.id))exclusionsByFamily.set(w.id,sesumScopedExclusions(w,reader,approvedByKey));return exclusionsByFamily.get(w.id);};
    if(reader)for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      for(const m of linkedMembers(w,reader,{excludedSet:exclusionsFor(w)}).values()){
        const p=m.product,k=key({watchId:w.id,store:p.store,id:p.id,productKey:m.productKey});
        if(nativeHoldsMember(p,m.productKey,w.id,entries))continue;
        if(!m.eligible||native.has(k)&&native.get(k).status!=='pending')continue; // An approved family member needs no second review.
        const packAmount=p.pack>0?p.pack:null;
        native.set(k,{watchId:w.id,store:p.store,id:p.id,productKey:m.productKey,name:p.name,ean:p.ean,brand:p.brand,sourceUrl:p.sourceUrl,status:'approved',approved:true,unit:w.unit,packAmount,price:packAmount?m.price.grossPackPrice??m.unitPrice*packAmount:null,unitPrice:m.unitPrice,lastChecked:m.price.receiptAt,priceSource:'library',priceSourceUrl:m.price.sourceUrl??p.sourceUrl,origin:'library',groupId:m.groupId,image:p.image??null});
      }
    }
    for(const p of native.values()){
      const w=s.watches[p.watchId];if(!w)continue;
      if(scopedProductHeld(exclusionsFor(w),reader?.product(catalogKey(p))??p,catalogKey(p)))Object.assign(p,{approved:false,status:'excluded',price:null,unitPrice:null});
    }
    const quotes=[],campaigns=Object.values(s.offers).some(o=>o.sesumCampaign)?sesumCampaignContexts():new Map();
    for(const p of native.values())if(p.approved&&(!variablePack(p.name)||p.priceSource==='library')&&p.unitPrice>0&&Number.isFinite(p.unitPrice)&&freshPrice(p.lastChecked,at)){
      const store=s.settings.stores.find(x=>x.chainCode===p.store);
      quotes.push({...p,storeId:store?.id??null,storeName:p.store==='ODA_NO'?'Oda':store?.name.replace(/\s*[–-]\s*Kassal.*$/,'')??chainName(p.store),chainCode:p.store,sourceUrl:p.priceSourceUrl??p.sourceUrl??null,kind:'catalog'});
    }
    for(const o of Object.values(s.offers)){
      const store=s.settings.stores.find(x=>x.id===o.storeId),w=s.watches[o.watchId];
      if(!store||!w||o.unit!==w.unit||!o.comparable||o.validFrom>today||o.validTo<today||o.bestBefore&&o.bestBefore<today||!freshPrice(o.observedAt,at)||o.memberOnly&&!store.memberEligible||campaignOfferState(o,campaigns))continue;
      quotes.push({...o,offerId:o.id,storeName:store.name,chainCode:store.chainCode??null,unitPrice:o.price/o.packAmount,lastChecked:o.observedAt,kind:'offer'});
    }
    return Object.defineProperty({entries:[...native.values()],reviewedNative:entries,quotes,libraryStatus:library.status,reader,campaigns,excluded:new Set([...native.values()].filter(e=>e.status==='excluded').map(key))},priceContextExclusions,{value:exclusionsFor});
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
    next.variants=s.watches[id]?.variants??[];
    next.family=s.watches[id]?.family??null;
    if(next.purchaseAmount!==null&&next.monthlyUsage!==null)throw Error('Planlagt mengde kan ikke kombineres med månedsforbruk.');
    if(!['kg','l','stk'].includes(next.unit)||!['frozen','pantry','chilled','other'].includes(next.storage)||!Number.isInteger(next.maxPacks)||next.minDiscountPct>100||next.productKeys.some(k=>typeof k!=='string'||k.length>200))throw Error('Ugyldig overvåkning.');
    if(s.watches[id]?.stockAmount===next.stockAmount&&input.stockConfirmed!==true)next.stockCheckedAt=s.watches[id].stockCheckedAt;
    return update(()=>s.watches[id]=next);
  }
  function buildOffer(input,{campaignReview=false}={}) {
    const watch=s.watches[input.watchId];if(!watch)throw Error('Ukjent overvåkning.');
    const store=s.settings.stores.find(x=>x.id===input.storeId);if(!store)throw Error('Butikken er ikke valgt.');
    const entry={id:hash(`${required(input.storeId,'Butikk')}\0${required(input.externalId,'Tilbuds-ID')}`),externalId:input.externalId,storeId:input.storeId,watchId:watch.id,name:required(input.name,'Varenavn'),price:positive(input.price,'tilbudspris'),packAmount:positive(input.packAmount,'pakningsmengde'),unit:input.unit,validFrom:day(input.validFrom),validTo:day(input.validTo),observedAt:input.observedAt??now().toISOString(),sourceUrl:url(input.sourceUrl),evidence:required(input.evidence,'Kildebelegg'),conditions:text(input.conditions,1000),memberOnly:input.memberOnly===true,bestBefore:input.bestBefore==null?null:day(input.bestBefore),maxPacks:input.maxPacks==null?null:positive(input.maxPacks,'maks kundeantall'),bundlePacks:positive(input.bundlePacks??1,'antall i pakketilbud'),comparable:input.comparable===true,comparisonNote:required(input.comparisonNote,'Sammenligningsgrunnlag')};
    if(entry.unit!==watch.unit||entry.validTo<entry.validFrom||!Number.isFinite(Date.parse(entry.observedAt))||Date.parse(entry.observedAt)>now().getTime()+60000||!Number.isInteger(entry.bundlePacks)||(entry.maxPacks!==null&&!Number.isInteger(entry.maxPacks)))throw Error('Ugyldig tilbudsperiode, mengde eller observasjon.');
    entry.quotedPriceIncludesVat=input.priceIncludesVat??store.pricesIncludeVat??true;
    if(typeof entry.quotedPriceIncludesVat!=='boolean')throw Error('Momsgrunnlag må oppgis som true eller false.');
    if(!entry.quotedPriceIncludesVat){const rate=positive(input.vatRate,'momssats');if(rate>1)throw Error('Oppgi momssats som andel, for eksempel 0.15.');entry.priceBeforeVat=entry.price;entry.vatRate=rate;entry.price=round(entry.price*(1+rate));}
    entry.priceIncludesVat=true;
    if(!campaignReview&&isSesumSource(entry.sourceUrl))throw Error('Sesum alene bekrefter ikke tilbudsvilkår; bruk shopping-sesum-offer-review med primærbelegg.');
    const previous=s.offers[entry.id];
    if(previous?.sesumCampaign){
      entry.sesumCampaign=structuredClone(previous.sesumCampaign);
      if(input.observedAt==null)entry.observedAt=previous.observedAt;
      if(previous.campaignFreshProof)entry.campaignFreshProof=structuredClone(previous.campaignFreshProof);
      if(!campaignReview&&input.observedAt&&Date.parse(entry.observedAt)>Date.parse(previous.observedAt)&&offerTermsFingerprint(entry,store.chainCode)===offerTermsFingerprint(previous,store.chainCode)){
        const receipt=input.sourceReceipt;
        if(!receipt||typeof receipt.evidence!=='string'||receipt.evidence.trim().length<10||receipt.evidence.length>6000||url(receipt.url)!==entry.sourceUrl||isSesumSource(receipt.url)||!freshPrice(receipt.observedAt)||Date.parse(entry.observedAt)>Date.parse(receipt.observedAt))throw Error('Ny prisferskhet for Sesum-tilbudet krever sourceReceipt fra faktisk primærlesing.');
        entry.campaignFreshProof={offerTermsFingerprint:offerTermsFingerprint(entry,store.chainCode),sourceUrl:entry.sourceUrl,observedAt:new Date(receipt.observedAt).toISOString(),evidence:receipt.evidence.trim()};
      }
    }
    return entry;
  }
  function offer(input) {const entry=buildOffer(input);return update(()=>s.offers[entry.id]=entry);}
  function review(input) {
    if(!s.settings.stores.some(x=>x.id===input.storeId)||!['ok','blocked'].includes(input.status))throw Error('Ugyldig butikkontroll.');
    const familySetFingerprint=sesumPlacementFamilies().familySetFingerprint;
    if(input.familySetFingerprint!==undefined&&input.familySetFingerprint!==familySetFingerprint)throw Error('Varefamilienes krav er endret; les gjeldende shopping-checklist før butikkontrollen kvitteres.');
    const entry={storeId:input.storeId,status:input.status,checkedAt:now().toISOString(),evidence:required(input.evidence,'Kontrollbelegg'),sourceUrl:url(input.sourceUrl),nextCheck:day(input.nextCheck),familySetFingerprint};
    if(entry.nextCheck<=shoppingDay(now()))throw Error('Neste kontroll må være i fremtiden.');
    return update(()=>s.reviews[entry.storeId]=entry);
  }
  // A source reading only covers the family criteria that were actually current
  // then. Prices and household quantities are not part of that semantic basis.
  function flyerReviewState(store,familySetFingerprint,today=shoppingDay(now())) {
    const review=s.reviews[store.id]??null;
    const requiresRescan=!store.facebookGroup&&review?.familySetFingerprint!==familySetFingerprint;
    const blocked=review?.status==='blocked',dateDue=!review||review.nextCheck<=today;
    return {review,requiresRescan,due:dateDue||requiresRescan&&!blocked,status:store.facebookGroup?review?.status??'unchecked':blocked?'blocked':!review||requiresRescan||dateDue?'unchecked':review.status};
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
  const offerFingerprint=o=>o.sesumCampaign?offerTermsFingerprint(o,o.sesumCampaign.sourceKey.split(':')[1])+'|'+o.sesumCampaign.campaignFingerprint:`${o.price}|${o.packAmount}|${o.validTo}`;
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
      const campaignHold=campaignOfferState(o,prices.campaigns);if(campaignHold){hold(campaignHold);continue;}
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
      const history=historyValues(w);
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
    for(const order of orders())if(order.source==='oda-mcp')for(const p of order.products)if(!linked.has(p.productKey)&&!s.productLinks[p.productKey]){const key=reader?.byOdaId(p.odaProductId),groups=key?reader.groupsOf(key).filter(m=>m.s==='approved'&&m.r).map(m=>m.groupId):[],watchIds=Object.values(s.watches).filter(w=>(w.variants??[]).some(l=>groups.includes(l.groupId))).map(w=>w.id);found.set(p.productKey,{do:'shopping-order-link',productKey:p.productKey,name:p.name,unit:p.pack?.unit??null,libraryGroups:groups,linkedWatchIds:watchIds});}
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
    const today=shoppingDay(now()),familySetFingerprint=sesumPlacementFamilies().familySetFingerprint;
    const reader=libReader(),familyMembers=new Map();
    const alreadyInFamily=p=>{const w=s.watches[p.watchId];if(!reader||!w)return false;if(!familyMembers.has(w.id))familyMembers.set(w.id,linkedMembers(w,reader,{allChains:true}));return familyMembers.get(w.id).has(`kassal:${p.store}:${p.id}`);};
    const named=x=>x.watchId?{...x,familyId:x.watchId,familyName:x.watchName}:x;
    const flyers=s.settings.stores.filter(x=>!x.facebookGroup).map(store=>({store,...flyerReviewState(store,familySetFingerprint,today)})).filter(x=>x.due).map(({store,review,requiresRescan})=>({do:'shopping-review',storeId:store.id,name:store.name,url:store.url,lastReview:review?structuredClone(review):null,familySetFingerprint,requiresRescan,reason:requiresRescan&&review?'family-checklist-changed':review?'check-due':'unreviewed',fingerprint:hash(JSON.stringify([store.id,familySetFingerprint]))}));
    return [...stock,...catalog.pending().filter(p=>s.watches[p.watchId]?.enabled!==false&&!priceTooOld(p)&&!alreadyInFamily(p)).map(p=>({do:'shopping-product-review',watchId:p.watchId,watchName:s.watches[p.watchId]?.name,productId:p.id,store:p.store,name:p.name,fingerprint:p.fingerprint,sourceUrl:p.sourceUrl})),...feedWork(),...flyers,...marketRefreshDue(today),...sesumWork(),...sesumPlacementWork(),...sesumCatalogueWork(),...sesumFamilyWork(),...sesumOfferWork(),...libraryWork(),...listFamilyWork(),...unlinkedOrderLines(),...routes].map(named);
  }
  function completion() {
    const work=queue(),familySetFingerprint=s.settings.monitoringEnabled?sesumPlacementFamilies().familySetFingerprint:null,blockedStores=s.settings.monitoringEnabled?s.settings.stores.filter(x=>s.reviews[x.id]?.status==='blocked').map(x=>({storeId:x.id,name:x.name,evidence:s.reviews[x.id].evidence,requiresRescan:flyerReviewState(x,familySetFingerprint).requiresRescan})):[];
    const blockedRoutes=[...s.shoppingList.filter(e=>!e.checkedAt&&(e.routing==='blocked'||e.cartError)).map(({id,name,reason,cartError})=>({id,name,reason:cartError??reason})),...stockIntake.blocked().map(x=>({id:x.id,name:'Lagertelling',reason:x.note}))];
    const blockedCampaigns=s.settings.monitoringEnabled?sesumOfferWork({all:true}).filter(item=>item.status==='blocked'):[];
    const blockedFamilies=s.settings.monitoringEnabled?sesumFamilyWork({all:true}).filter(item=>item.status==='blocked'):[];
    const blockedPlacements=s.settings.monitoringEnabled?sesumPlacementWork({all:true}).filter(item=>item.status==='blocked'):[];
    const blockedCatalogue=s.settings.monitoringEnabled?sesumCatalogueWork({all:true}).filter(item=>item.status==='blocked'):[];
    let collection;
    if(s.settings.monitoringEnabled&&typeof sesumCollectionStatus==='function'){
      let status;try{status=sesumCollectionStatus();}catch{status=null;}
      collection=sesumCollectionCompletion(status,status?.enabled?sesumFamilies():[]);
    }
    return {complete:!work.length&&!blockedStores.length&&!blockedRoutes.length&&!blockedCampaigns.length&&!blockedFamilies.length&&!blockedPlacements.length&&!blockedCatalogue.length&&collection?.complete!==false,work,blockedStores,blockedRoutes,blockedCampaigns,blockedFamilies,blockedPlacements,blockedCatalogue,...(collection?{collection}:{})};
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
  function historyBasis(w,products,approved){
    // Only semantic identity and reviewed normalization belong in this basis.
    // New prices, receipt dates and review prose do not redefine past prices.
    const basis={version:1,mode:w.catalogManaged?'catalog':'caller-reviewed',unit:w.unit,products:products.map(p=>({store:String(p.store),id:String(p.id),packAmount:p.packAmount,unit:p.unit,metadataFingerprint:w.catalogManaged?approved.get(`${p.store}\0${p.id}`).fingerprint:null})).sort((a,b)=>a.store<b.store?-1:a.store>b.store?1:a.id<b.id?-1:a.id>b.id?1:a.packAmount-b.packAmount||(a.unit<b.unit?-1:a.unit>b.unit?1:0))};
    return {...basis,fingerprint:createHash('sha256').update(JSON.stringify(basis)).digest('hex')};
  }
  function knownHistoryBasis(basis){
    if(!basis||basis.version!==1||!['catalog','caller-reviewed'].includes(basis.mode)||!['kg','l','stk'].includes(basis.unit)||!Array.isArray(basis.products))return false;
    if(basis.products.some(p=>!p||typeof p.store!=='string'||typeof p.id!=='string'||!Number.isFinite(p.packAmount)||p.packAmount<=0||p.unit!==basis.unit||(basis.mode==='catalog'?!/^[a-f0-9]{64}$/.test(p.metadataFingerprint??''):p.metadataFingerprint!==null)))return false;
    const {version,mode,unit,products}=basis;
    return basis.fingerprint===createHash('sha256').update(JSON.stringify({version,mode,unit,products})).digest('hex');
  }
  function historyValues(w){
    const basis=s.priceHistoryBasis[w.id];
    if(!knownHistoryBasis(basis)||basis.unit!==w.unit||basis.mode!==(w.catalogManaged?'catalog':'caller-reviewed'))return [];
    const excluded=sesumScopedExclusions(w,libReader());
    if(basis.products.some(p=>excluded.has(catalogKey(p))))return [];
    if(w.catalogManaged){
      const entries=new Map(catalog.entries(w.id).map(p=>[`${p.store}\0${p.id}`,p]));
      if(basis.products.some(p=>{const entry=entries.get(`${p.store}\0${p.id}`);return !entry||entry.status!=='approved'||entry.fingerprint!==p.metadataFingerprint||entry.packAmount!==p.packAmount||entry.unit!==p.unit;}))return [];
    }
    return Object.values(s.priceHistory[w.id]??{});
  }
  function market(input){
    const w=s.watches[input.watchId];if(!w)throw Error('Ukjent overvåkning.');
    if(!Array.isArray(input.products)||input.products.length>500||input.products.some(p=>p.reviewed===true&&!text(p.equivalenceEvidence)))throw Error('Markedsprodukter krever konkret sammenligningsbelegg.');
    const days=input.windowDays??90;if(!Number.isInteger(days)||days<1||days>90)throw Error('Markedsvindu må være1–90 dager.');
    const excluded=sesumScopedExclusions(w,libReader());
    const approved=new Map(catalog.entries(w.id).filter(p=>p.status==='approved'&&!excluded.has(catalogKey(p))).map(p=>[`${p.store}\0${p.id}`,p]));
    const products=input.products.map(p=>{
      if(excluded.has(catalogKey(p)))return {...p,reviewed:false};
      if(!w.catalogManaged)return p;
      const entry=approved.get(`${p.store}\0${p.id}`);
      return {...p,reviewed:p.reviewed===true&&!!entry&&entry.packAmount===p.packAmount&&entry.unit===p.unit,equivalenceEvidence:entry?.equivalenceEvidence??p.equivalenceEvidence};
    });
    const result=calibrateMarket({unit:w.unit,products,now:now(),windowDays:days});
    const basis=historyBasis(w,result.products,approved);
    const ceiling=w.referenceCeiling;
    if(result.status==='ready'&&ceiling&&now().getTime()-Date.parse(ceiling.checkedAt)<=48*3600000&&ceiling.price<result.goodPrice){
      result.goodPrice=ceiling.price;
      if(result.excellentPrice!==null&&result.excellentPrice>=result.goodPrice*.98)result.excellentPrice=null;
      result.verifiedCurrentAlternative=structuredClone(ceiling);
      result.warnings.push('lower-verified-current-alternative');
    }
    return update(()=>{
      const {dailyBest,rejectedObservations,...summary}=result;
      const previousBasis=s.priceHistoryBasis[w.id]??null;
      let series=s.priceHistory[w.id]??{};
      const basisChanged=!knownHistoryBasis(previousBasis)||previousBasis.fingerprint!==basis.fingerprint;
      const needsNewBasis=basisChanged&&result.status==='insufficient';
      const knownAutomatic=!!w.marketCalibration&&w.priceGuide?.evidence?.startsWith('Kassal-markedshistorikk:')===true;
      const quarantine=needsNewBasis&&!w.manualLimits&&knownAutomatic;
      const automaticGuide=quarantine?{priceGuide:structuredClone(w.priceGuide??null),targetPrice:w.targetPrice??null,excellentPrice:w.excellentPrice??null}:null;
      const reason=knownHistoryBasis(previousBasis)?'reviewed-product-basis-changed':'legacy-unbound-history';
      const fallback=needsNewBasis?{status:'needs-review',reason,automaticGuideQuarantined:quarantine||w.marketCalibration?.fallback?.automaticGuideQuarantined===true}:result.status==='insufficient'?w.marketCalibration?.fallback??null:null;
      if(basisChanged){
        if(Object.keys(series).length||automaticGuide&&Object.values(automaticGuide).some(value=>value!==null))(s.priceHistoryArchive[w.id]??=[]).push({archivedAt:now().toISOString(),reason,basis:structuredClone(previousBasis),series:structuredClone(series),replacedBy:basis.fingerprint,...(automaticGuide?{automaticGuide}:{})});
        series={};
      }
      // A requested window does not prove a complete response: some sources
      // return only their latest receipts. Preserve older actual observations
      // only when their semantic basis is unchanged.
      for(const point of dailyBest)series[point.day]=point.price;
      const oldest=shoppingDay(new Date(now().getTime()-400*86400000));
      for(const day of Object.keys(series))if(day<oldest)delete series[day];
      s.priceHistory[w.id]=series;s.priceHistoryBasis[w.id]=basis;
      if(quarantine){w.priceGuide=null;w.targetPrice=null;w.excellentPrice=null;}
      w.marketCalibration={...summary,rejectedObservationCount:rejectedObservations.length,...(fallback?{fallback}:{} )};
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
    const a=analysis(),at=now().getTime(),context=currentPrices(),familySetFingerprint=sesumPlacementFamilies().familySetFingerprint;
    return Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>itemView(w,a,at,new Map(),new Map(),context)).map(({id,name,unit,storage,prices,libraryGroups})=>({watchId:id,name,unit,storage,libraryGroups,normal:prices.normal,good:prices.good,excellent:prices.excellent,cheapestNow:prices.current,chain:prices.currentChain,familySetFingerprint}));
  }
  function view() {const a=analysis(),entries=catalog.entries(),found=deals(a);return {families:structuredClone(Object.values(s.watches)),settings:structuredClone(s.settings),analysis:a,nutrition:purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),nutritionRecords()),watches:structuredClone(Object.values(s.watches)),opportunities:found.opportunities,belowTripOffers:found.belowTrip,coveredOffers:found.covered,heldOffers:found.held,offerCounts:offerCounts(),reviews:structuredClone(Object.values(s.reviews)),queue:queue(),purchases:structuredClone(s.purchases),catalog:{total:entries.length,pending:entries.filter(p=>p.status==='pending').length,approved:entries.filter(p=>p.status==='approved').length,excluded:entries.filter(p=>p.status==='excluded').length}};}
  function catalogPackMap(prices=currentPrices()) {
    const byWatch=new Map();
    for(const e of prices.entries)if((e.status==='approved'||e.origin==='library')&&e.packAmount){const sizes=byWatch.get(e.watchId)??new Map();sizes.set(e.packAmount,(sizes.get(e.packAmount)??0)+1);byWatch.set(e.watchId,sizes);}
    return new Map([...byWatch].map(([id,sizes])=>[id,[...sizes].sort((x,y)=>y[1]-x[1]).map(([size])=>size)]));
  }
  function itemView(w,a,at,catalogPacks=new Map(),offerLow=new Map(),priceContext=currentPrices()) {
    const need=needOf(w,a),rate=rateOf(need),stock=estimateStock(w,rate,at),market=w.marketCalibration,rows=needRows(w,a);
    const normal=w.priceGuide?.referencePrice??null;
    const history=historyValues(w);
    const best=quotesFor(w,priceContext)[0]??null;
    const evaluationReference=comparisonReference(w,a,{kind:'input',unitPrice:Infinity},priceContext);
    // "Good" must be a real step below normal, or the guide just repeats itself.
    const good=w.targetPrice!=null?round(Math.min(w.targetPrice,normal?normal*.92:Infinity,evaluationReference?evaluationReference*.92:Infinity)):null;
    const excellent=w.excellentPrice!=null?round(Math.min(w.excellentPrice,good??Infinity,evaluationReference?evaluationReference*.92:Infinity)):null;
    const chains=market?.coverage?.chainCount;
    const basis=market?.status==='ready'?market.coverage.observedDays+' dager med priser fra '+chains+(chains===1?' kjede':' kjeder'):market?.status==='needs-review'?'En vare er endret og sjekkes på nytt':market?.fallback?.status==='needs-review'?'Endret varegrunnlag trenger nye prisdata':w.priceGuide?'Foreløpig, ut fra det dere har betalt':w.targetPrice?'Egen prisgrense':'For lite prisdata ennå';
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
    const familySetFingerprint=sesumPlacementFamilies().familySetFingerprint;
    const stores=s.settings.stores.map(x=>{const r=flyerReviewState(x,familySetFingerprint,today);return {id:x.id,name:x.name,status:r.status,checkedAt:r.review?.checkedAt??null,requiresRescan:r.requiresRescan};});
    const n=purchaseNutrition(orders().filter(o=>o.deliveryDate>=a.from&&o.deliveryDate<=a.to),nutritionRecords());
    const sum=list=>round(list.reduce((x,p)=>x+(p.saving??0),0));
    const stockImages=new Map(catalog.entries().filter(e=>e.status==='approved'&&e.image).map(e=>[e.watchId,imageRef(e.image)]));
    const inventoryOda=odaProducts(found.prices);
    for(const item of items){const options=inventoryOda.get(item.id),chosen=options?defaultOda(s.watches[item.id],options):null;item.image=imageRef(chosen?.image)??stockImages.get(item.id)??null;item.stockEvidence=structuredClone(s.watches[item.id].stockEvidence??null);}
    const stockReports=stockIntake.list().map(({baseStocks,appliedVersions,clientId,...item})=>({...item,result:item.result?{...item.result,changes:item.result.changes.map(({previous,...change})=>change)}:null}));
    const draft=odaDraft(a,today,at,found);
    const brandDeals=draft.items.flatMap(x=>{const place=x.places?.find(p=>p.sameBrand);return place?[{watchId:x.watchId,name:x.name,currentName:x.productName,currentUnit:x.unitPrice,unit:x.unit,place}]:[];}).sort((x,y)=>y.place.dropPct-x.place.dropPct);
    const body={brandDeals,stockReports,steady:steadyPrices(a,found,at),list:listView(today,found.prices,a),odaDraft:draft,monitoring:s.settings.monitoringEnabled===true,today,deals:main,smallDeals:small,belowTrip:found.belowTrip.map(d=>({...pick(d),alsoAt:[]})),covered:found.covered.map(pick),held:found.held,items,purchases:s.purchases.slice().reverse().slice(0,30).map(({previousStock,...p})=>p),saved:{year:sum(s.purchases.filter(p=>p.at.slice(0,4)===year)),all:sum(s.purchases)},stores,storesCheckedToday:stores.filter(x=>x.status==='ok'&&x.checkedAt&&shoppingDay(new Date(x.checkedAt))===today).length,analysis:{orderCount:a.orderCount,from:a.from,to:a.to,orderTotal:a.orderTotal,categories:a.categories,top:a.products.slice(0,15).map(p=>({name:p.name,spent:p.spent,orders:p.orders}))},nutrition:{spendPct:n.coverage.spendPct}};
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
    const campaignHeld=campaignOfferState(o,found.prices.campaigns),saving=!campaignHeld&&deal&&deal.referenceType!=='target'?round((deal.referencePrice-deal.unitPrice)*packs*o.packAmount):null;
    return update(()=>{
      const previousStock={amount:w.stockAmount,checkedAt:w.stockCheckedAt,packs:w.stockPacks?{...w.stockPacks}:null},stock=estimateStock(w,rateOf(needOf(w,a)),now().getTime());
      if(!stock.known)w.stockPacks={};
      if(w.stockPacks)addCounted(w,o.packAmount,packs);
      w.stockAmount=round((stock.amount??0)+packs*o.packAmount);w.stockCheckedAt=now().toISOString();
      s.dealDecisions[o.id]=decision;
      s.purchases.push({id:randomUUID(),offerId:o.id,watchId:w.id,name:w.name,storeId:o.storeId,packs,packAmount:o.packAmount,unit:o.unit,unitPrice:campaignHeld?null:round(o.price/o.packAmount),referencePrice:deal?.referencePrice??null,total:campaignHeld?null:round(o.price*packs),saving,previousStock,at:now().toISOString()});
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
    return shown.map(o=>{const named=o.name.match(/maks\s+(\d+)/i);return {productKey:catalogKey(o),productId:o.productId,name:o.name,packAmount:o.packAmount,packPrice:o.currentPrice,unitPrice:round(o.unitPrice),maxAtOda:s.odaLimits[o.productId]?.max??(named?Number(named[1]):null),image:imageRef(o.image),library:o.origin==='library',pills:o.pills??null,quality:shared&&o.quality?.key===shared?{score:o.quality.score,label:o.quality.label}:null};});
  }
  // The library family a product belongs to. A declined watch has none, and a
  // linked watch has exactly its reviewed links. Until a watch is decided, the
  // family is shown for comparison only and never becomes a price reference.
  function familyMembers(w,base,prices) {
    const reader=prices.reader;if(!reader||w?.family?.kind==='own')return [];
    if(w?.variants?.length)return [...linkedMembers(w,reader,{allChains:true,excludedSet:prices[priceContextExclusions]?.(w)??null}).values()];
    if(!base)return [];
    const seen=new Map(),excluded=w?(prices[priceContextExclusions]?.(w)??sesumScopedExclusions(w,reader)):new Set();
    for(const m of reader.groupsOf(catalogKey(base))){
      if(m.s!=='approved'||!m.r||w&&reader.group(m.groupId)?.unit!==w.unit)continue;
      for(const row of reader.members(m.groupId))if(row.status==='approved'&&row.reviewCurrent&&!seen.has(row.productKey)&&!scopedProductHeld(excluded,row.product,row.productKey))seen.set(row.productKey,row);
    }
    return [...seen.values()];
  }
  const cleanStore=name=>name.replace(/\s*[–-]\s*Kassal.*$/,'').replace(/\s*\(nettbutikk\)$/i,'');
  // What the same family costs at other chains, cheapest first. Every chain with
  // a fresh price is shown; only the family's own stores may steer a purchase.
  function variantBlock(w,options,keep,prices,base,currentUnit,{annual=null,excludeStore=null,odaOptions=[]}={}) {
    const reader=prices.reader,rows=new Map(),preferred=odaOptions.length?defaultOda(w,odaOptions):null;
    const identity=x=>{const p=x.store?reader?.product(catalogKey(x)):null;return {brand:x.brand??p?.brand??null,ean:x.ean??p?.ean??null};};
    // A line moved to another store must still be able to come back to Oda.
    for(const o of odaOptions)rows.set('oda|'+o.productId,{...identity(o),storeName:'Oda',own:true,online:false,name:o.name,packAmount:o.packAmount,packPrice:o.currentPrice,unitPrice:round(o.unitPrice),offer:false,offerId:null,maxPacks:null,image:imageRef(o.image),odaProductId:o.productId,productKey:catalogKey(o),pills:o.pills??null,pin:o===preferred,rawQuality:o.quality});
    if(w)for(const q of quotesFor(w,prices)){
      if(q.store==='ODA_NO'||q.chainCode==='ODA_NO')continue;
      const key=q.kind==='offer'?'offer:'+q.offerId:catalogKey(q);
      rows.set(key,{...(q.kind==='offer'?{brand:null,ean:null}:identity(q)),storeName:cleanStore(q.storeName),own:!!q.storeId,online:/nettbutikk/i.test(q.storeName),name:q.name,packAmount:q.packAmount??null,packPrice:q.price??null,unitPrice:round(q.unitPrice),offer:q.kind==='offer',offerId:q.offerId??null,maxPacks:q.maxPacks??null,image:imageRef(q.image??reader?.product(catalogKey(q))?.image),productKey:q.kind==='catalog'?catalogKey(q):null,pills:q.kind==='catalog'?reader?.pills(catalogKey(q))??null:null,rawQuality:q.kind==='catalog'?reader?.quality(catalogKey(q))??null:null});
    }
    const family=familyMembers(w,base,prices);
    for(const m of family){
      const p=m.product,key=m.productKey;
      if(!m.eligible||p.store==='ODA_NO'||rows.has(key)||w&&(prices.excluded.has(w.id+'|'+key)||p.donorProductKey&&prices.excluded.has(w.id+'|'+p.donorProductKey)||nativeHoldsMember(p,m.productKey,w.id,prices.reviewedNative??[])))continue;
      const store=s.settings.stores.find(x=>x.chainCode===p.store);
      rows.set(key,{...identity(p),storeName:store?cleanStore(store.name):chainName(p.store),own:!!store,online:!!store&&/nettbutikk/i.test(store.name),name:p.name,packAmount:p.pack>0?p.pack:null,packPrice:m.price.grossPackPrice??null,unitPrice:round(m.unitPrice),offer:false,offerId:null,maxPacks:null,image:imageRef(p.image),productKey:m.productKey,pills:reader.pills(m.productKey),rawQuality:m.quality});
    }
    const sorted=collapseSameProduct([...rows.values()],s.sameProducts).sort((a,b)=>a.unitPrice-b.unitPrice),perChain=new Set(),cheapest=sorted.filter(x=>!perChain.has(x.storeName)&&perChain.add(x.storeName));
    const head=[...new Set([...cheapest,...sorted.filter(x=>x.pin)])],shown=[...new Set([...head,...sorted])].slice(0,Math.max(12,head.length)).sort((a,b)=>a.unitPrice-b.unitPrice);
    const shared=sharedQuality([...options.map(o=>o.quality),...shown.map(x=>x.rawQuality)]);
    const others=shown.map(({rawQuality,pin,...row})=>({...row,quality:shared&&rawQuality?.key===shared?{score:rawQuality.score,label:rawQuality.label}:null}));
    // One line per chain that truly beats this price. Savings use a physical
    // store when one is cheaper, since web prices still lack freight.
    const seenChains=new Set(),cheaper=currentUnit>0?others.filter(x=>x.unitPrice<currentUnit*.99&&x.storeName!==excludeStore&&!seenChains.has(x.storeName)&&seenChains.add(x.storeName)):[];
    // The cheapest store brand must not hide a real drop on the brand actually bought.
    const baseBrand=normalized(base?.brand??(base?.store?reader?.product(`kassal:${base.store}:${base.id}`)?.brand:null)??'');
    const baseName=base?.name??(base?.store?reader?.product(`kassal:${base.store}:${base.id}`)?.name:null)??'';
    const sameBrand=x=>!!baseBrand&&(x.brand?normalized(x.brand)===baseBrand:` ${normalized(x.name)} `.includes(` ${baseBrand} `))&&sameProductLine(baseName,x.name,baseBrand);
    const brandDrop=currentUnit>0?others.find(x=>x.unitPrice<=currentUnit*.9&&sameBrand(x)&&x.own&&!x.online&&!x.odaProductId&&x.storeName!==excludeStore)??null:null;
    if(brandDrop){brandDrop.sameBrand=true;brandDrop.dropPct=Math.round((1-brandDrop.unitPrice/currentUnit)*100);brandDrop.annualSaving=annual>0?round((currentUnit-brandDrop.unitPrice)*annual):null;}
    const places=(brandDrop?[brandDrop,...cheaper.filter(x=>x!==brandDrop&&x.storeName!==brandDrop.storeName)]:cheaper).slice(0,3);
    const byPrice=[...places].sort((a,b)=>a.unitPrice-b.unitPrice),basis=byPrice.find(x=>!x.online)??byPrice[0]??null,perUnit=basis?currentUnit-basis.unitPrice:0;
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
      const list=byWatch.get(w.id);if(!list?.length||w.enabled===false||w.variants?.length||w.family?.kind==='own')continue;
      for(const m of familyMembers(w,list.find(x=>x.productId===s.odaChoices[w.id])??list[0],prices)){
        const p=m.product,oda=p.store==='ODA_NO'?p.sourceUrl?.match(/\/products\/(\d+)-/)?.[1]:null;
        if(!oda||!m.eligible||!(p.pack>0)||prices.excluded.has(w.id+'|'+m.productKey)||nativeHoldsMember(p,m.productKey,w.id,prices.reviewedNative??[])||list.some(x=>x.productId===Number(oda)))continue;
        list.push({watchId:w.id,store:p.store,id:p.id,productKey:m.productKey,name:p.name,sourceUrl:p.sourceUrl,unit:w.unit,packAmount:p.pack,price:m.price.grossPackPrice??m.unitPrice*p.pack,currentPrice:m.price.grossPackPrice??m.unitPrice*p.pack,unitPrice:m.unitPrice,productId:Number(oda),quality:m.quality,pills:prices.reader.pills(m.productKey),origin:'library',kind:'catalog',image:p.image??null});
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
      const campaignHeld=!entry.checkedAt&&o?campaignOfferState(o,priceContext.campaigns):null;
      if(campaignHeld)return {...entry,unitPrice:null,saving:null,cheaper:null,offerHeldReason:campaignHeld,variants:[],others:[],places:[],savings:null,odaReturn:null,image:entry.watchId?watchImage(entry.watchId,entry.storeName,byWatch):null,sourceUrl:o.sourceUrl,validTo:null,expired:false};
      const cheaper=!entry.checkedAt&&best&&entry.unitPrice>best.unitPrice?{storeName:best.storeName,unitPrice:round(best.unitPrice),sourceUrl:best.sourceUrl}:null;
      const reference=!entry.checkedAt&&w&&o?comparisonReference(w,a,{kind:'offer',offerId:o.id,chainCode:s.settings.stores.find(x=>x.id===o.storeId)?.chainCode,unitPrice:o.price/o.packAmount},priceContext):null;
      const saving=!entry.checkedAt&&o?reference===null?null:round(Math.max(0,reference-o.price/o.packAmount)*entry.packs*o.packAmount):entry.saving;
      const productKey=entry.productKey??(entry.odaProductId?priceContext.reader?.byOdaId(entry.odaProductId)??null:null);
      return {...entry,productKey,family:lineFamily(entry,priceContext.reader),pills:productKey?priceContext.reader?.pills(productKey)??null:null,saving,cheaper,image:imageUrl?imageRef(imageUrl):entry.watchId?watchImage(entry.watchId,entry.storeName,byWatch):null,...(()=>{const options=products.get(entry.watchId)??[],oda=entry.storeName==='Oda';return !entry.checkedAt&&w&&(oda?entry.unitPrice:true)?variantBlock(w,oda?options:[],entry.odaProductId,priceContext,options.find(x=>x.productId===entry.odaProductId)??options[0]??null,entry.unitPrice,{annual:needOf(w,a).amount,excludeStore:oda?null:entry.storeName,odaOptions:oda||entry.need==='now'?[]:options}):{variants:[],others:[],places:[],savings:null,odaReturn:null};})(),expired:!!o&&o.validTo<today,sourceUrl:o?.sourceUrl??entry.productUrl??httpsUrl(productKey?priceContext.reader?.product(productKey)?.sourceUrl:null),validTo:o?.validTo??null};};
    return {open:listOpen().map(decorate),done:s.shoppingList.filter(x=>x.checkedAt).sort((x,y)=>y.checkedAt.localeCompare(x.checkedAt)).slice(0,20).map(decorate)};
  }
  const lineProduct=(entry,reader)=>entry.productKey??(entry.odaProductId?reader.byOdaId(entry.odaProductId)??null:null);
  const approvedGroup=(key,reader)=>key?reader.groupsOf(key).find(m=>m.s==='approved'&&m.r)?.groupId??null:null;
  function lineFamily(entry,reader) {
    if(!reader||entry.watchId)return null;
    const decision=s.listFamilies[normalized(entry.name)];
    const groupId=decision?.status==='linked'&&reader.group(decision.groupId)?decision.groupId:approvedGroup(lineProduct(entry,reader),reader);
    if(!groupId)return null;
    const group=reader.group(groupId),rows=reader.members(groupId).filter(m=>m.status==='approved'&&m.reviewCurrent&&m.eligible).sort((a,b)=>a.unitPrice-b.unitPrice);
    return {groupId,name:group.name,unit:group.unit,total:rows.length,rows:rows.slice(0,8).map(m=>({name:m.product.name,storeName:chainName(m.product.store),unitPrice:round(m.unitPrice),productKey:m.productKey}))};
  }
  // Every line on a list should end up in a reviewed family. A watch's own link
  // decision, an approved product or an explicit reviewed decision settles it.
  function listLineSettled(entry,reader) {
    const w=entry.watchId?s.watches[entry.watchId]:null;
    if(w)return true; // A followed family has its own build task.
    if(approvedGroup(lineProduct(entry,reader),reader))return true;
    const decision=s.listFamilies[normalized(entry.name)];
    return decision?.status==='none'||decision?.status==='linked'&&!!reader.group(decision.groupId);
  }
  function listFamilyWork() {
    const reader=libReader();if(!reader)return [];
    const found=new Map();
    for(const entry of s.shoppingList){
      if(['pending','choose'].includes(entry.routing)||listLineSettled(entry,reader))continue;
      const key=normalized(entry.name);if(!key)continue;
      const item=found.get(key)??{do:'shopping-list-family',key,name:entry.name,detail:entry.detail??null,storeName:entry.storeName??null,lineIds:[],fingerprint:hash('list-family:'+key)};
      item.lineIds.push(entry.id);found.set(key,item);
    }
    return [...found.values()];
  }
  function listFamily(input) {
    const reader=libReader();if(!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    const key=normalized(input.key);
    if(!listFamilyWork().some(x=>x.key===key))throw Error('Linjen venter ikke på en varefamilie.');
    if(!['linked','none'].includes(input.status))throw Error('Status må være linked eller none.');
    const evidence=required(input.evidence,'Vurderingsbelegg').slice(0,2000),reviewed=input.candidatesReviewed,queries=input.queries;
    if(!Number.isInteger(reviewed)||reviewed<0||reviewed>5000)throw Error('Oppgi hvor mange kandidater som er vurdert.');
    if(!Array.isArray(queries)||!queries.length||queries.length>30||queries.some(x=>typeof x!=='string'||!x.trim()))throw Error('Oppgi søkene som ble brukt.');
    let entry={name:s.shoppingList.find(x=>normalized(x.name)===key).name,status:input.status,evidence,candidatesReviewed:reviewed,queries:queries.map(x=>x.slice(0,120)),at:now().toISOString()};
    if(input.status==='linked'){
      const g=reader.group(input.groupId);if(!g)throw Error('Ukjent bibliotekgruppe. Vent til biblioteket er bygget på nytt.');
      if(input.groupFingerprint!==g.fingerprint)throw Error('Bibliotekgruppen er endret. Vurder gjeldende fingeravtrykk.');
      const approved=reader.members(input.groupId).filter(m=>m.status==='approved'&&m.reviewCurrent);
      if(!approved.length)throw Error('Varefamilien har ingen godkjente varer med prisdata innenfor grensen.');
      if(reviewed<approved.length)throw Error('Antall vurderte kandidater er lavere enn antall godkjente varer.');
      if(input.productKey&&!approved.some(m=>m.productKey===input.productKey))throw Error('Valgt vare er ikke godkjent i varefamilien.');
      entry={...entry,groupId:input.groupId,groupFingerprint:g.fingerprint,groupName:g.name};
    }
    return update(()=>{s.listFamilies[key]=entry;if(input.status==='linked'&&input.productKey)for(const line of s.shoppingList)if(normalized(line.name)===key&&!line.watchId&&!line.productKey)line.productKey=input.productKey;return entry;});
  }
  function listAdd(input) {
    const base={need:input.need==='now'?'now':'later',routing:null,routeAttempts:0,reason:null,odaProductId:null,id:randomUUID(),addedAt:now().toISOString(),checkedAt:null,offerId:null,watchId:null,detail:null,storeId:null,storeName:null,packs:null,packAmount:null,unit:null,unitPrice:null,saving:null};
    if(input.offerId!=null){
      const o=s.offers[input.offerId];if(!o)throw Error('Tilbudet finnes ikke lenger.');
      if(campaignOfferState(o))throw Error('Tilbudsvilkårene må sjekkes på nytt før tilbudet kan legges til.');
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
    const chains=linkChains(),linked=new Set(watches.flatMap(w=>(w.variants??[]).map(l=>l.groupId)));
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
  const httpsUrl=value=>/^https:\/\//.test(value??'')?String(value).slice(0,1000):null;
  // A price claim on a free-text line must show what it was compared with.
  function routeComparison(input) {
    const c=input.comparison;
    if(!c||typeof c!=='object'||!Array.isArray(c.candidates)||!c.candidates.length||c.candidates.length>25)throw Error('Prisvalg krever comparison med basis og 1–25 sammenlignede varer.');
    const candidates=c.candidates.map(x=>{
      const receiptAt=x.receiptAt==null?null:String(x.receiptAt);
      if(receiptAt!==null&&!Number.isFinite(Date.parse(receiptAt)))throw Error('Ugyldig priskvittering i sammenligningen.');
      if(!['kg','l','stk'].includes(x.unit))throw Error('Ugyldig enhet i sammenligningen.');
      return {name:required(x.name,'Varenavn').slice(0,200),storeName:required(x.storeName,'Butikk').slice(0,80),unitPrice:positive(x.unitPrice,'enhetspris'),unit:x.unit,packPrice:x.packPrice==null?null:positive(x.packPrice,'pakkepris'),packAmount:x.packAmount==null?null:positive(x.packAmount,'pakning'),receiptAt,sourceUrl:/^https:\/\//.test(x.sourceUrl??'')?String(x.sourceUrl).slice(0,1000):null,chosen:x.chosen===true,note:x.note?String(x.note).slice(0,200):null};
    }).sort((a,b)=>a.unitPrice-b.unitPrice);
    const chosen=candidates.filter(x=>x.chosen);
    if(chosen.length!==1)throw Error('Marker nøyaktig én sammenlignet vare som valgt.');
    if(input.unitPrice!=null&&(chosen[0].unit!==input.unit||Math.abs(chosen[0].unitPrice-input.unitPrice)>Math.max(.01,input.unitPrice*.01)))throw Error('Valgt vare i sammenligningen stemmer ikke med registrert pris.');
    return {basis:required(c.basis,'Sammenligningsgrunnlag').slice(0,300),candidates,comparedAt:now().toISOString()};
  }
  function list(input) {
    const find=()=>{const entry=s.shoppingList.find(x=>x.id===input.id);if(!entry)throw Error('Finner ikke varen på listen.');return entry;};
    if(input.action==='add')return update(()=>listAdd(input));
    if(input.action==='route'){
      const entry=find(),storeName=required(input.storeName,'Butikk').slice(0,120),reason=required(input.reason,'Begrunnelse').slice(0,300);
      if(entry.checkedAt)throw Error('Varen er allerede kjøpt.');
      if(entry.need==='now'&&storeName==='Oda')throw Error('Trenger nå skal handles i en fysisk nærbutikk.');
      const odaProductId=input.odaProductId==null?null:Number(input.odaProductId);if(odaProductId!==null&&(!Number.isSafeInteger(odaProductId)||odaProductId<1))throw Error('Ugyldig Oda-vare.');
      const patch={imageUrl:/^https:\/\//.test(input.imageUrl??'')?String(input.imageUrl).slice(0,1000):entry.imageUrl??null,storeName,reason,routing:null,routeRetryAt:null,odaProductId,productUrl:httpsUrl(input.sourceUrl)??httpsUrl(input.comparison?.candidates?.find?.(x=>x.chosen===true)?.sourceUrl)??entry.productUrl??null,comparison:input.unitPrice==null&&input.comparison==null?entry.comparison??null:routeComparison(input),productKey:input.productKey&&libReader()?.product(input.productKey)?input.productKey:entry.productKey??null,detail:input.matchedName?String(input.matchedName).slice(0,200):entry.detail,unitPrice:input.unitPrice==null?entry.unitPrice:positive(input.unitPrice,'pris'),unit:input.unit??entry.unit,packAmount:input.packAmount==null?entry.packAmount:positive(input.packAmount,'pakning'),packs:input.packs==null?entry.packs:positive(input.packs,'antall')};
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
      items.push({...variantBlock(w,options,best.productId,found.prices,best,best.unitPrice,{annual:need.amount}),image:imageRef(best.image),pills:best.pills??null,productKey:catalogKey(best),watchId:w.id,name:w.name,productId:best.productId,productName:best.name,packAmount:best.packAmount,unit:w.unit,packs,wanted,maxAtOda:max,limitChecked:limit?.checkedAt??null,elsewhere,entryIds:[],packPrice:best.currentPrice,unitPrice:round(best.unitPrice),cost:round(best.currentPrice*packs),tier,stockKnown:stock.known,storage:w.storage});
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
    return {status:'ready',builtAt:reader.builtAt,findings,noGroup:enabled.filter(w=>!candidates.get(w.id).length&&!w.variants?.length).map(w=>({watchId:w.id,name:w.name})),multiGroup:enabled.filter(w=>candidates.get(w.id).length>1).map(w=>({watchId:w.id,name:w.name,groups:candidates.get(w.id).map(g=>g.name)})),links:{linked:enabled.filter(w=>w.family?.kind==='library').length,declined:enabled.filter(w=>w.family?.kind==='own').length,undecided:enabled.filter(w=>!w.family&&candidates.get(w.id).length).length}};
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
    return list.map(w=>({watchId:w.id,name:w.name,unit:w.unit,note:w.note??'',familyId:w.id,decision:w.family??null,links:linkStates(w,reader).map(({group,...link})=>link),excludedCatalogRows:catalog.entries(w.id).filter(e=>e.status==='excluded').map(e=>({productKey:`kassal:${e.store}:${e.id}`,name:e.name,reason:e.equivalenceEvidence})),candidates:linkCandidates(w,reader)}));
  }
  function libraryLink(input) {
    const w=s.watches[input.familyId??input.watchId];if(!w)throw Error('Ukjent varefamilie.');
    const evidence=required(input.evidence,'Koblingsbelegg'),variants=input.variants??input.links;
    if(!Array.isArray(variants)||variants.length>10)throw Error('Oppgi høyst ti varianter.');
    const reader=libReader();if(variants.length&&!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    const at=now().toISOString(),links=variants.map(link=>{
      const g=reader.group(link.groupId);if(!g)throw Error('Ukjent bibliotekgruppe.');
      if(link.groupFingerprint!==g.fingerprint)throw Error('Bibliotekgruppen er endret. Vurder gjeldende fingeravtrykk.');
      if(g.unit!==w.unit)throw Error('Bibliotekgruppens enhet stemmer ikke med varegruppen.');
      const requires=link.requires??[],brands=link.brands??[],excludeProductKeys=link.excludeProductKeys??[];
      if(!Array.isArray(requires)||requires.some(x=>!LINK_REQUIREMENTS.has(x))||!Array.isArray(brands)||brands.some(x=>!text(x))||!Array.isArray(excludeProductKeys)||excludeProductKeys.some(x=>!reader.product(x)))throw Error('Ugyldige krav i bibliotekkoblingen.');
      return {groupId:link.groupId,groupFingerprint:g.fingerprint,evidence:required(link.evidence,'Gruppebelegg'),requires,brands,excludeProductKeys,reviewedAt:at};
    });
    return update(()=>{w.variants=links;w.family={kind:links.length?'library':'own',evidence,at};return {watchId:w.id,familyId:w.id,decision:w.family,links};});
  }
  // Sends own, narrow families back to be built. The earlier reasoning stays with
  // them, so the agent can see why they were held out.
  function familyReopen(input) {
    const reason=required(input.evidence,'Begrunnelse').slice(0,1000),ids=input.familyIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>200)throw Error('Oppgi 1–200 varefamilier.');
    const rows=ids.map(id=>{const w=Object.hasOwn(s.watches,id)?s.watches[id]:null;if(!w)throw Error('Ukjent varefamilie: '+id);if(w.family?.kind!=='own')throw Error('Bare en egen, smal familie kan gjenåpnes: '+id);return w;});
    return update(()=>{const at=now().toISOString();for(const w of rows){w.familyReopened={previous:w.family,evidence:reason,at};delete w.family;}return {reopened:rows.map(w=>w.id)};});
  }
  function libraryWork() {
    const reader=libReader();if(!reader)return [];
    const audit=libraryAudit(),rows=groupRows(catalog.entries()),findings=new Map();for(const f of audit.findings){const list=findings.get(f.watchId)??[];list.push(f.id);findings.set(f.watchId,list);}
    const work=[...findings].map(([watchId,ids])=>({do:'shopping-library-audit',watchId,watchName:s.watches[watchId]?.name,findings:ids.length,fingerprint:hash(ids.sort().join())}));
    for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      const broken=linkStates(w,reader).filter(l=>l.state!=='ok');
      if(broken.length){work.push({do:'shopping-family-build',watchId:w.id,watchName:w.name,reason:'group-changed',groups:broken.map(l=>l.groupId),fingerprint:hash(broken.map(l=>l.groupId+l.state+(l.group?.fingerprint??'')).join())});continue;}
      if(w.family)continue;
      const candidates=linkCandidates(w,reader,rows.get(w.id)??[]);
      work.push({do:'shopping-family-build',watchId:w.id,watchName:w.name,reason:w.familyReopened?'reopened':'undecided',previousDecision:w.familyReopened?.previous.evidence??null,groups:candidates.map(g=>g.groupId),fingerprint:hash(w.id+candidates.map(g=>g.groupId+g.fingerprint).join())});
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
    return {available:true,watchName:w?.name??null,product:{key,name:p.name,brand:p.brand,ean:p.ean,storeName:p.store==='ODA_NO'?'Oda':store?cleanStore(store.name):chainName(p.store),packAmount:p.pack,unit:p.unit,packEvidence:p.packEvidence,ingredients:p.ingredients,description:p.description,labels:Object.entries(p.attributes??{}).filter(([,value])=>value===true).map(([name])=>name),nutrition:p.nutrition,sourceUrl:/^https:\/\//.test(p.sourceUrl??'')?p.sourceUrl:null,image:imageRef(p.image),pills:reader.pills(key),price:{grossPackPrice:price.grossPackPrice,grossUnitPrice:price.directUnitVerified?price.grossUnitPrice:null,unit:price.unit,fresh:price.fresh,receiptAt:price.receiptAt}},groups};
  }
  // A flyer offer is fresh evidence by itself, so it shows even when every library
  // row for that chain is parked. Only a watch's reviewed links place it in a family.
  function explorerOffers() {
    const today=shoppingDay(now()),reader=libReader(),campaigns=Object.values(s.offers).some(o=>o.sesumCampaign)?sesumCampaignContexts():new Map();
    return Object.values(s.offers).flatMap(o=>{
      const w=s.watches[o.watchId],store=s.settings.stores.find(x=>x.id===o.storeId);
      if(o.validFrom>today||o.validTo<today||!o.comparable||!w||w.enabled===false||!store||campaignOfferState(o,campaigns))return [];
      const linked=linkStates(w,reader).filter(l=>l.state==='ok').map(l=>l.groupId),groups=linked.length?linked:['followed:'+w.id];
      return [{id:o.id,name:o.name,storeName:store.chainCode?chainName(store.chainCode):cleanStore(store.name),price:o.price,packAmount:o.packAmount,unit:o.unit,unitPrice:round(o.price/o.packAmount),validTo:o.validTo,memberOnly:o.memberOnly,conditions:o.conditions??null,maxPacks:o.maxPacks,bundlePacks:o.bundlePacks,comparisonNote:o.comparisonNote,sourceUrl:o.sourceUrl,groups}];
    });
  }
  // The household's own numbers, shown on the family they belong to.
  function explorerFollowed() {
    const reader=libReader(),a=analysis(),at=now().getTime(),context=currentPrices();
    return Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>{
      const view=itemView(w,a,at,new Map(),new Map(),context),groups=linkStates(w,reader).filter(l=>l.state==='ok').map(l=>l.groupId);
      const excluded=sesumScopedExclusions(w,reader);
      return {id:w.id,name:w.name,unit:w.unit,kind:groups.length?'library':'own',groups,members:groups.length?[]:catalog.entries(w.id).filter(e=>e.status==='approved'&&!priceTooOld(e)&&!excluded.has(catalogKey(e))).map(e=>`kassal:${e.store}:${e.id}`),stock:{known:view.stock.known,amount:view.stock.amount,months:view.stock.months},annualAmount:view.annualAmount,prices:{good:view.prices.good,excellent:view.prices.excellent,normal:view.prices.normal,current:view.prices.current,currentChain:view.prices.currentChain},basis:view.prices.basis};
    });
  }
  function followedFamily(id) {
    const w=Object.hasOwn(s.watches,id.slice(9))?s.watches[id.slice(9)]:null,reader=libReader();
    if(!w||!reader)return null;
    const groups=linkStates(w,reader).filter(l=>l.state==='ok').map(l=>familyDetail(reader,l.groupId,{imageRef,chainName})).filter(Boolean);
    const seen=new Set(),members=[],allowed=linkedMembers(w,reader),native=catalog.entries(w.id),excluded=sesumScopedExclusions(w,reader);
    if(groups.length)for(const g of groups)for(const m of g.members){
      const member=allowed.get(m.key);
      if(!member||seen.has(m.key)||nativeHoldsMember(member.product,m.key,w.id,native))continue;
      seen.add(m.key);members.push({...m,variant:g.name});
    }
    if(!groups.length)for(const e of catalog.entries(w.id)){
      if(e.status==='pending'||priceTooOld(e)||excluded.has(catalogKey(e)))continue;
      const unitPrice=e.status==='approved'&&e.priceFresh&&e.currentPrice&&e.packAmount?round(e.currentPrice/e.packAmount):null;
      members.push({key:`kassal:${e.store}:${e.id}`,status:e.status,reviewCurrent:e.status==='approved',name:e.name,brand:e.brand,store:chainName(e.store),image:imageRef(e.image),pack:e.packAmount,unit:e.unit,packPrice:e.currentPrice,unitPrice,oldUnitPrice:unitPrice===null&&e.status==='approved'&&e.currentPrice&&e.packAmount?round(e.currentPrice/e.packAmount):null,fresh:!!e.priceFresh,receiptAt:e.lastChecked,quality:null,nutritionLevel:null,value:null,note:e.status==='excluded'?e.equivalenceEvidence:null});
    }
    const keys=new Set(groups.map(g=>g.sharedKey));
    return {id,name:w.name,category:groups[0]?.category??null,unit:w.unit,inclusion:groups.length?groups.map(g=>g.name+': '+(Array.isArray(g.inclusion)?g.inclusion.join(' '):g.inclusion)).join(' '):w.family?.evidence??w.note??'Varer dere har gjennomgått for denne familien.',exclusions:groups.flatMap(g=>g.exclusions??[]),qualityBasis:groups[0]?.qualityBasis??null,comparisonBasis:groups[0]?.comparisonBasis??null,sharedKey:keys.size===1?[...keys][0]:null,qualityNote:groups[0]?.qualityNote??[],members,offers:explorerOffers().filter(o=>o.groups.includes(id)||groups.some(g=>o.groups.includes(g.id)))};
  }
  const explorer=createLibraryExplorer({reader:libReader,imageRef,chainName,ownStores:()=>['ODA_NO',...s.settings.stores.map(x=>x.chainCode).filter(Boolean)],status:()=>libraryPrices?.status?.()??'disabled',activeOffers:explorerOffers,followed:explorerFollowed,followedFamily});
  function librarySearch(query,limit=30) {
    const reader=libReader();if(!reader)throw Error('Produktbiblioteket er ikke tilgjengelig.');
    return reader.search(String(query??'').slice(0,200),Math.min(200,Number(limit)||30)).map(({key,product,groups,price})=>({productKey:key,name:product.name,brand:product.brand,store:product.store,ean:product.ean,canonicalPackAmount:product.pack,unit:product.unit,packDocumented:product.packKnown,groups,grossPackPrice:price.grossPackPrice,grossUnitPrice:price.directUnitVerified?price.grossUnitPrice:null,receiptAt:price.receiptAt,priceFresh:price.fresh}));
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
  function sesumFamilies(familyId) {
    const reader=reviewedReader(),entries=catalog.entries();
    return Object.values(s.watches).filter(w=>w.enabled!==false&&(!familyId||w.id===familyId)).map(w=>{
      const members=reader?[...linkedMembers(w,reader,{allChains:true,includeParked:true,ignoreScopedExclusions:true}).values()]:[];
      const products=members.map(m=>({productKey:m.productKey,source:m.product.source??m.productKey.split(':')[0],store:m.product.store,id:m.product.id,name:m.product.name,brand:m.product.brand,ean:m.product.ean,canonicalPackAmount:m.product.pack,unit:m.product.unit,metadataFingerprint:m.product.metadataFingerprint??m.product.textHash,sourceUrl:m.product.sourceUrl,reviewCurrent:m.reviewCurrent,groupIds:reader.groupsOf(m.productKey).filter(g=>g.s==='approved'&&g.r).map(g=>g.groupId),rawPack:m.product.rawPack}));
      const native=entries.filter(e=>e.watchId===w.id&&e.status==='approved');
      for(const e of native)if(!products.some(p=>p.productKey===catalogKey(e)))products.push({productKey:catalogKey(e),source:'kassal',store:e.store,id:e.id,name:e.name,brand:e.brand,ean:e.ean,canonicalPackAmount:e.packAmount,unit:e.unit,metadataFingerprint:e.fingerprint,sourceUrl:e.sourceUrl,reviewCurrent:true,groupIds:[],rawPack:{weight:e.weight,weightUnit:e.weightUnit}});
      const concrete=products.filter(p=>p.source!=='sesum').map(p=>p.name.replace(/\b\d+\s*[x×]\s*/giu,' ').replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|ml|cl|dl|l|stk)\b/giu,' ').replace(/\s+/g,' ').trim());
      const queries=[...new Set([w.name,...(w.queries??[]),...members.map(m=>reader.group(m.groupId)?.name),...concrete].filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim()))];
      return {familyId:w.id,name:w.name,unit:w.unit,enabled:true,queries,requirementsFingerprint:hash(JSON.stringify([w.name,w.unit,w.variants??[],w.family??null,products.filter(p=>p.source!=='sesum').map(p=>[p.productKey,p.metadataFingerprint]).sort()])),products};
    });
  }
  function sesumPlacementFamilies(){
    const reader=libReader();
    const families=Object.values(s.watches).filter(w=>w.enabled!==false).map(w=>{
      const variants=(w.variants??[]).map(link=>{const group=reader?.group(link.groupId);return {groupId:link.groupId,groupFingerprint:group?.fingerprint??null,reviewedGroupFingerprint:link.groupFingerprint,requires:[...(link.requires??[])].sort(),brands:[...(link.brands??[])].map(normalized).sort(),excludeProductKeys:[...(link.excludeProductKeys??[])].sort(),group:group?{name:group.name,unit:group.unit,inclusion:group.inclusion,exclusions:group.exclusions,comparisonBasis:group.comparisonBasis}:null};}).sort((a,b)=>a.groupId.localeCompare(b.groupId));
      const decision=w.family?{kind:w.family.kind,...(w.family.kind==='own'?{evidence:w.family.evidence}:{} )}:null;
      const criteria={familyId:w.id,name:w.name,unit:w.unit,note:w.note??'',decision,variants};
      return {...criteria,familyFingerprint:hash(JSON.stringify(criteria))};
    }).sort((a,b)=>a.familyId.localeCompare(b.familyId));
    return {families,familySetFingerprint:hash(JSON.stringify(families.map(f=>[f.familyId,f.familyFingerprint])))};
  }
  function sesumResearchedFamilyIds(source,families=sesumPlacementFamilies().families){
    const current=new Map(families.map(f=>[f.familyId,f.familyFingerprint]));
    const own=s.sesumPlacementTargets[source.sourceKey],record=source.sourceKey.startsWith('sesum-product:')?null:sesumPrices.sourceRecord(source.sourceKey),neutral=record?sesumCatalogue.record('sesum-product:'+record.source.id):null;
    const reviews=[...(own?.sourceFingerprint===source.sourceFingerprint?[own]:[]),...(neutral&&sesumCatalogue.current(record.source)&&s.sesumPlacementTargets[neutral.sourceKey]?.sourceFingerprint===neutral.sourceFingerprint?[s.sesumPlacementTargets[neutral.sourceKey]]:[])];
    return [...new Set(reviews.flatMap(review=>review.targets.filter(target=>current.get(target.familyId)===target.familyFingerprint).map(target=>target.familyId)))];
  }
  function sesumEffectiveFamilyIds(source,families){const prior=Object.entries(s.sesumFamilyReviews[source.sourceKey]??{}).filter(([id,row])=>s.watches[id]?.enabled!==false&&s.watches[id]&&(row.status==='excluded'||row.holdExcluded===true)).map(([id])=>id);return [...new Set([...source.familyIds,...sesumResearchedFamilyIds(source,families),...prior])];}
  const sesumSubjectRecord=key=>key?.startsWith('sesum-product:')?sesumCatalogue.record(key):sesumPrices.sourceRecord(key);
  function sesumPlacementSubjects(reader,chains){
    const real=sesumPrices.sourceSummaries().filter(source=>chains.has(source.store)&&sesumCatalogue.researchable(sesumPrices.sourceRecord(source.sourceKey).source)&&(!source.receiptAt||withinPriceHorizon(source.receiptAt,now().getTime(),reader?.horizonDays)));
    const ids=new Set(real.map(source=>sesumPrices.sourceRecord(source.sourceKey).source.id));
    return [...real,...sesumCatalogue.summaries().filter(source=>!source.parked&&!ids.has(sesumCatalogue.record(source.sourceKey).source.id))];
  }
  function sesumPlacement(sourceKey){
    const semantic=sesumPlacementFamilies(),reader=libReader(),research=sesumResearches(reader),chains=linkChains(),items=[];
    for(const source of sesumPlacementSubjects(reader,chains)){
      if(sourceKey&&source.sourceKey!==sourceKey)continue;
      const receiptAt=reader?.quote(source.sourceKey)?.price.receiptAt??source.receiptAt;
      if(receiptAt&&!withinPriceHorizon(receiptAt,now().getTime(),reader?.horizonDays))continue;
      const registrationFingerprint=research.get(source.sourceKey)?.registrationFingerprint??null,review=s.sesumPlacementReviews[source.sourceKey];
      const current=review?.sourceFingerprint===source.sourceFingerprint&&review.registrationFingerprint===registrationFingerprint&&review.familySetFingerprint===semantic.familySetFingerprint;
      items.push({...source,rawFamilyIds:[...source.familyIds],researchedFamilyIds:sesumResearchedFamilyIds(source,semantic.families),registrationFingerprint,familySetFingerprint:semantic.familySetFingerprint,fingerprint:hash(JSON.stringify([source.sourceKey,source.sourceFingerprint,registrationFingerprint,semantic.familySetFingerprint])),status:current?review.status:'pending',reason:current?review.reason??null:'review-all-active-family-placement',retryAt:current?review.retryAt??null:null,review:review?structuredClone(review):null,...(sourceKey?{source:sesumSubjectRecord(source.sourceKey).source,registration:source.kind==='catalogue'?null:discovery.record(source.sourceKey)}:{})});
    }
    return {...semantic,items,total:items.length,hasMore:false,scope:{mode:sourceKey?'exact-source':'all-active-sources',sourceKey:sourceKey??null}};
  }
  function sesumPlacementWork({all=false}={}){
    return sesumPlacement().items.filter(item=>!['reviewed','no-active-family'].includes(item.status)&&(all||item.status!=='blocked'||!item.retryAt||Date.parse(item.retryAt)<=now().getTime())).map(({sourceKey,sourceFingerprint,registrationFingerprint,familySetFingerprint,fingerprint,status,reason,retryAt})=>({do:'shopping-sesum-placement-review',sourceKey,sourceFingerprint,registrationFingerprint,familySetFingerprint,fingerprint,status,reason,retryAt}));
  }
  function sesumPlacementReview(input){
    if(!['reviewed','no-active-family','blocked','reopen'].includes(input.status))throw Error('Ugyldig global familievurdering.');
    const data=sesumPlacement(input.sourceKey),source=data.items.find(item=>item.sourceKey===input.sourceKey);
    if(!source||input.sourceFingerprint!==source.sourceFingerprint||(input.registrationFingerprint??null)!==source.registrationFingerprint||input.familySetFingerprint!==data.familySetFingerprint)throw Error('Kildevare, produktgrunnlag eller aktivt familiesett er endret; les gjeldende plassering.');
    const checkedText=(value,label,min=20)=>{if(typeof value!=='string'||value.trim().length<min||value.length>6000)throw Error(`${label} krever konkret belegg på ${min}–6000 tegn.`);return value.trim();};
    const approved=source.kind==='catalogue'?null:sesumPrices.approvedSource(source.sourceKey),reader=libReader(),product=approved?reader?.product(source.sourceKey):null,raw=sesumSubjectRecord(source.sourceKey).source;
    const knownUnit=approved?.unit??({g:'kg',kg:'kg',ml:'l',l:'l',liter:'l',stk:'stk',pcs:'stk',m:'m'}[String(raw.weightUnit??'').toLowerCase()]??null);
    const record={sourceKey:source.sourceKey,sourceFingerprint:source.sourceFingerprint,registrationFingerprint:source.registrationFingerprint,familySetFingerprint:data.familySetFingerprint,status:input.status,evidence:checkedText(input.evidence,'Plasseringsvurderingen',10),reviewedAt:now().toISOString(),targets:[]};
    if(['reviewed','no-active-family'].includes(input.status)){
      if(input.reviewedAllFamilies!==true)throw Error('Hele det gjeldende aktive familiesettet må være faktisk gjennomgått.');
      record.reviewedAllFamilies=true;record.scopeEvidence=checkedText(input.scopeEvidence,'Hele familiesettet');
      if(!Array.isArray(input.targets)||input.targets.length>data.families.length)throw Error('Oppgi eksplisitt targets for det gjennomgåtte familiesettet.');
      const seen=new Set(),families=new Map(data.families.map(f=>[f.familyId,f]));
      record.targets=input.targets.map(target=>{
        const family=families.get(target?.familyId);if(!family||seen.has(family.familyId)||target.familyFingerprint!==family.familyFingerprint)throw Error('En valgt families faktiske kriterier er endret eller ukjent.');
        if(knownUnit&&knownUnit!==family.unit)throw Error('Kildens dokumenterte mengdeenhet stemmer ikke med forskningsfamilien.');
        if(sesumFamilyDecision(source,family.familyId,sesumRequirements(family.familyId),source.registrationFingerprint)?.status==='excluded')throw Error('Denne kildevaren har et gjeldende konkret familieavslag; vurder og gjenåpne det eksplisitt før ny positiv plassering.');
        if(product&&family.variants.length&&family.variants.every(variant=>(variant.brands.length&&!variant.brands.some(brand=>normalized(product.brand).includes(brand)))||variant.requires.some(key=>product.attributes?.[key]!==true)))throw Error('Gjeldende gjennomgått produkt oppfyller ikke familiens merke-/egenskapskrav; manglende fakta må avklares.');
        seen.add(family.familyId);return {familyId:family.familyId,familyFingerprint:family.familyFingerprint,equivalenceEvidence:checkedText(target.equivalenceEvidence,'Konkret ekvivalens mot familiens krav')};
      });
      if(input.status==='reviewed'&&!record.targets.length)throw Error('En positiv plassering krever minst én konkret gjennomgått familie.');
      if(input.status==='no-active-family'){
        if(record.targets.length||input.noActiveFamilyVerified!==true)throw Error('Ingen aktiv familie krever et eksplisitt bekreftet, tomt resultat.');
        if(approved){
          const native=catalog.entries();
          for(const family of data.families){
            const w=s.watches[family.familyId],anchor=product.nativeIdentity?.key??product.donorProductKey??approved.productKey,entry=native.find(e=>e.watchId===w.id&&catalogKey(e)===anchor),held=nativeHoldsMember(product,source.sourceKey,w.id,entry?[entry]:[])||scopedProductHeld(sesumScopedExclusions(w,reader),product,source.sourceKey);
            const own=entry?.status==='approved'&&entry.store===approved.source.store&&entry.unit===w.unit&&Math.abs(entry.packAmount-approved.packAmount)<=1e-6*Math.max(entry.packAmount,approved.packAmount);
            if(!held&&(linkedMembers(w,reader,{includeParked:true}).has(source.sourceKey)||own))throw Error('Kildevaren er allerede faktisk godkjent i en aktiv familie; ingen-aktiv-familie er ikke et gyldig resultat.');
          }
        }
        record.noActiveFamilyVerified=true;record.reason=checkedText(input.reason,'Påvist fravær av relevant aktiv familie');
      }
    }else if(input.status==='blocked'){
      record.reason=checkedText(input.reason,'Manglende plasseringsbelegg');record.retryAt=input.retryAt??new Date(now().getTime()+6*3600000).toISOString();
      if(!Number.isFinite(Date.parse(record.retryAt))||Date.parse(record.retryAt)<=now().getTime()||Date.parse(record.retryAt)>now().getTime()+7*86400000)throw Error('Ny plasseringsvurdering må være innen sju dager og i fremtiden.');
    }
    return update(()=>{
      const previous=s.sesumPlacementReviews[source.sourceKey],same=value=>JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='reviewedAt')));
      if(previous&&input.status!=='reopen'&&same(previous)===same(record))return structuredClone(previous);
      if(previous)(s.sesumPlacementReviewHistory??=[]).push(structuredClone(previous));
      if(input.status==='reopen')delete s.sesumPlacementReviews[source.sourceKey];else s.sesumPlacementReviews[source.sourceKey]=record;
      if(['reviewed','no-active-family'].includes(input.status))s.sesumPlacementTargets[source.sourceKey]={sourceFingerprint:source.sourceFingerprint,targets:structuredClone(record.targets)};
      return record;
    });
  }
  const sesumRequirements=familyId=>new Map(sesumPlacementFamilies().families.filter(f=>!familyId||f.familyId===familyId).map(f=>[f.familyId,f.familyFingerprint]));
  function sesumCatalogueWork({all=false}={}){
    return sesumPlacement().items.filter(item=>item.kind==='catalogue'&&item.status==='reviewed'&&item.researchedFamilyIds.length).map(item=>{
      const fingerprint=hash(JSON.stringify([item.sourceFingerprint,item.familySetFingerprint,item.review.targets])),prior=s.sesumCatalogueReviews[item.sourceKey],current=prior?.fingerprint===fingerprint;
      return {do:'shopping-sesum-catalog-review',sourceKey:item.sourceKey,sourceFingerprint:item.sourceFingerprint,familySetFingerprint:item.familySetFingerprint,fingerprint,familyIds:[...item.researchedFamilyIds],rawFamilyIds:[...item.rawFamilyIds],ageStatus:item.ageStatus,receiptAt:item.receiptAt,status:current&&prior.status==='pending'?'pending':'blocked',reason:current?prior.reason:'missing-configured-chain-price',retryAt:current?prior.retryAt:new Date(Date.parse(item.review.reviewedAt)+6*3600000).toISOString()};
    }).filter(item=>all||item.status!=='blocked'||Date.parse(item.retryAt)<=now().getTime());
  }
  function sesumCatalogueReview(input){
    const item=sesumCatalogueWork({all:true}).find(row=>row.sourceKey===input.sourceKey);
    if(!item||item.sourceFingerprint!==input.sourceFingerprint||item.familySetFingerprint!==input.familySetFingerprint||!['blocked','reopen'].includes(input.status))throw Error('Katalogvarens metadata, familiesett eller kjedegrunnlag er endret; les gjeldende plassering.');
    if(typeof input.evidence!=='string'||input.evidence.trim().length<20||input.evidence.length>6000||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>6000)throw Error('Konkret faktisk forskningsbelegg og manglende kjede-/prisgrunnlag kreves.');
    const retryAt=input.status==='reopen'?null:input.retryAt??new Date(now().getTime()+6*3600000).toISOString();
    if(retryAt!==null&&(!Number.isFinite(Date.parse(retryAt))||Date.parse(retryAt)<=now().getTime()||Date.parse(retryAt)>now().getTime()+7*86400000))throw Error('Nytt katalogforsøk må være innen sju dager og i fremtiden.');
    return update(()=>s.sesumCatalogueReviews[item.sourceKey]={sourceKey:item.sourceKey,sourceFingerprint:item.sourceFingerprint,familySetFingerprint:item.familySetFingerprint,fingerprint:item.fingerprint,status:input.status==='reopen'?'pending':'blocked',reason:input.reason.trim(),evidence:input.evidence.trim(),retryAt,reviewedAt:now().toISOString()});
  }
  function sesumReceivePrices(input){const metadata=sesumCatalogue.prepare(input),result=sesumPrices.ingest(input);sesumCatalogue.apply(metadata);return {...result,catalogueObserved:metadata.length};}
  function scopedProductHeld(excluded,p,key){
    return [key,...[p.nativeIdentity?.key,p.donorProductKey].filter(alias=>alias?.split(':')[1]===p.store)].some(alias=>excluded.has(alias));
  }
  function sesumScopedExclusions(w,reader,approvedByKey=null){
    const reviews=Object.entries(s.sesumFamilyReviews).filter(([,rows])=>rows[w.id]?.status==='excluded'||rows[w.id]?.holdExcluded===true),excluded=new Set();
    if(!reviews.length||!reader)return excluded;
    for(const [sourceKey] of reviews){
      const approved=approvedByKey?approvedByKey.get(sourceKey):sesumPrices.approvedSource(sourceKey),source=approved??sesumPrices.sourceRecord(sourceKey);if(!source)continue;
      excluded.add(sourceKey);
      const actualAt=source.price?.observedAt??source.receipt?.observedAt;
      if(!approved&&actualAt&&!withinPriceHorizon(actualAt,now().getTime(),reader.horizonDays))continue;
      const p=reader.product(sourceKey),reference=sesumPrices.identityReference(sourceKey),registered=s.sesumDiscovery.records?.[sourceKey];
      for(const alias of [p?.nativeIdentity?.key,p?.donorProductKey,reference?.productKey,registered?.nativeIdentity?.key])if(alias?.split(':')[1]===source.source.store)excluded.add(alias);
    }
    return excluded;
  }
  function quarantineScopedMarket(w,excluded){
    const basis=s.priceHistoryBasis[w.id],market=w.marketCalibration;
    if(![...(basis?.products??[]),...(market?.products??[])].some(p=>excluded.has(catalogKey(p))))return;
    const series=s.priceHistory[w.id]??{},automatic=!w.manualLimits&&w.priceGuide?.evidence?.startsWith('Kassal-markedshistorikk:')===true;
    const automaticGuide=automatic?{priceGuide:structuredClone(w.priceGuide),targetPrice:w.targetPrice??null,excellentPrice:w.excellentPrice??null}:null;
    if(Object.keys(series).length||automaticGuide)(s.priceHistoryArchive[w.id]??=[]).push({archivedAt:now().toISOString(),reason:'scoped-family-exclusion',basis:structuredClone(basis??null),series:structuredClone(series),marketCalibration:structuredClone(market??null),...(automaticGuide?{automaticGuide}:{})});
    s.priceHistory[w.id]={};delete s.priceHistoryBasis[w.id];
    if(automatic){w.priceGuide=null;w.targetPrice=null;w.excellentPrice=null;}
    if(market)w.marketCalibration={...market,status:'needs-review',fallback:{status:'needs-review',reason:'scoped-family-exclusion',automaticGuideQuarantined:automatic}};
  }
  function sesumResearch(source,reader){
    const groups=reader.groupsOf(source.sourceKey).filter(m=>m.s==='approved'&&m.r).map(m=>({groupId:m.groupId,groupFingerprint:reader.group(m.groupId).fingerprint})).sort((a,b)=>a.groupId.localeCompare(b.groupId));
    const registrationFingerprint=hash(JSON.stringify([source.sourceFingerprint,source.productKey,source.productFingerprint,groups]));
    return {...source,groups,registrationFingerprint};
  }
  function sesumResearches(reader=libReader()){
    if(!reader)return new Map();
    return new Map(sesumPrices.approvedSources().map(source=>[source.sourceKey,sesumResearch(source,reader)]));
  }
  function sesumFamilyContexts(){
    const reader=libReader(),sources=sesumResearches(reader),requirements=sesumRequirements(),native=catalog.entries(),semantic=sesumPlacementFamilies().families,result=[];
    if(!reader||!sources.size)return result;
    const nativeByKey=new Map(native.map(e=>[e.watchId+'\0'+catalogKey(e),e])),chains=linkChains(),membersByFamily=new Map(),exclusionsByFamily=new Map();
    for(const source of sources.values()){
      if(!sesumCatalogue.researchable(source.source))continue;
      const p=reader.product(source.sourceKey),receiptAt=reader.quote(source.sourceKey)?.price.receiptAt??source.receipt.observedAt;
      if(!p||!chains.has(source.source.store)||receiptAt&&!withinPriceHorizon(receiptAt,now().getTime(),reader.horizonDays))continue;
      for(const familyId of sesumEffectiveFamilyIds(source,semantic)){
        const w=s.watches[familyId];if(!w||w.enabled===false)continue;
        const decision=sesumFamilyDecision(source,familyId,requirements,source.registrationFingerprint);
        if(decision?.status==='excluded')continue;
        if(!exclusionsByFamily.has(familyId))exclusionsByFamily.set(familyId,sesumScopedExclusions(w,reader,sources));
        if(!membersByFamily.has(familyId))membersByFamily.set(familyId,linkedMembers(w,reader,{includeParked:true,excludedSet:exclusionsByFamily.get(familyId)}));
        const anchor=p.nativeIdentity?.key??p.donorProductKey??source.productKey,entry=nativeByKey.get(familyId+'\0'+anchor),held=nativeHoldsMember(p,source.sourceKey,familyId,entry?[entry]:[])||scopedProductHeld(exclusionsByFamily.get(familyId),p,source.sourceKey);
        const own=entry?.status==='approved'&&entry.store===source.source.store&&entry.unit===w.unit&&Math.abs(entry.packAmount-source.packAmount)<=1e-6*Math.max(entry.packAmount,source.packAmount);
        if(!held&&(membersByFamily.get(familyId).has(source.sourceKey)||own))continue;
        result.push({do:'shopping-sesum-family-review',sourceKey:source.sourceKey,sourceFingerprint:source.sourceFingerprint,registrationFingerprint:source.registrationFingerprint,watchId:familyId,watchName:w.name,familyId,familyName:w.name,familyFingerprint:requirements.get(familyId),fingerprint:hash(JSON.stringify([source.registrationFingerprint,requirements.get(familyId)])),groups:source.groups,status:decision?.status==='blocked'?'blocked':'pending',reason:decision?.reason??(held?'review-prior-family-exclusion':'review-new-family-membership'),retryAt:decision?.retryAt??null});
      }
    }
    return result;
  }
  function sesumFamilyWork({all=false}={}){
    return sesumFamilyContexts().filter(item=>all||item.status!=='blocked'||!item.retryAt||Date.parse(item.retryAt)<=now().getTime());
  }
  const campaignKey=(sourceKey,familyId)=>sourceKey+'\0'+familyId;
  function sesumCampaignContexts(){
    const claimedSources=new Set(Object.values(s.offers).map(offer=>offer.sesumCampaign?.sourceKey).filter(Boolean));
    const reader=libReader(),requirements=sesumRequirements(),native=catalog.entries(),sources=[...sesumResearches(reader).values()].filter(source=>source.packAmount>0&&(source.receipt.isPromo===true||source.receipt.promotion!=null||claimedSources.has(source.sourceKey))),result=new Map();
    if(!reader)return result;
    const nativeByKey=new Map(native.map(e=>[e.watchId+'\0'+catalogKey(e),e]));
    for(const w of Object.values(s.watches)){
      if(w.enabled===false)continue;
      const members=linkedMembers(w,reader);
      for(const source of sources){
        const p=reader.product(source.sourceKey),stores=s.settings.stores.filter(store=>store.chainCode===source.source.store);
        if(!p||!stores.length||p.unit!==w.unit||reader.active?.(source.sourceKey)===false||sesumFamilyDecision(source,w.id,requirements,source.registrationFingerprint)?.status==='excluded')continue;
        const anchor=p.nativeIdentity?.key??p.donorProductKey??source.productKey,entry=nativeByKey.get(w.id+'\0'+anchor);
        if(nativeHoldsMember(p,source.sourceKey,w.id,entry?[entry]:[])||scopedProductHeld(sesumScopedExclusions(w,reader),p,source.sourceKey))continue;
        const own=entry?.status==='approved'&&entry.store===source.source.store&&entry.unit===w.unit&&Math.abs(entry.packAmount-source.packAmount)<=1e-6*Math.max(entry.packAmount,source.packAmount);
        if(!members.has(source.sourceKey)&&!own)continue;
        const context={...source,familyId:w.id,familyName:w.name,familyFingerprint:requirements.get(w.id),storeIds:stores.map(store=>store.id)};
        context.campaignFingerprint=campaignFingerprint(context);result.set(campaignKey(source.sourceKey,w.id),context);
      }
    }
    return result;
  }
  const currentCampaignReview=(review,context)=>review&&review.sourceFingerprint===context.sourceFingerprint&&review.familyFingerprint===context.familyFingerprint&&review.campaignFingerprint===context.campaignFingerprint;
  function campaignOfferState(offer,contexts){
    const claim=offer.sesumCampaign;if(!claim)return isSesumSource(offer.sourceUrl)?'sesum-offer-needs-review':null;
    const context=(contexts??sesumCampaignContexts()).get(campaignKey(claim.sourceKey,offer.watchId)),review=s.sesumOfferReviews[campaignKey(claim.sourceKey,offer.watchId)];
    if(!context||claim.sourceFingerprint!==context.sourceFingerprint||claim.familyFingerprint!==context.familyFingerprint||claim.campaignFingerprint!==context.campaignFingerprint)return 'sesum-campaign-changed';
    const store=s.settings.stores.find(s=>s.id===offer.storeId);
    if(!currentCampaignReview(review,context)||review.status!=='registered'||review.offerId!==offer.id||!store||store.chainCode!==context.source.store||review.offerTermsFingerprint!==offerTermsFingerprint(offer,store.chainCode))return 'sesum-offer-needs-review';
    const freshProof=offer.campaignFreshProof?.offerTermsFingerprint===review.offerTermsFingerprint&&offer.campaignFreshProof.sourceUrl===offer.sourceUrl?Date.parse(offer.campaignFreshProof.observedAt):0;
    if(!Number.isFinite(Date.parse(review.latestPrimaryReadAt))||Date.parse(offer.observedAt)>Math.max(Date.parse(review.latestPrimaryReadAt),freshProof))return 'sesum-offer-missing-primary-proof';
    if(!freshPrice(offer.observedAt))return 'stale-sesum-offer-proof';
    if(offer.memberOnly&&!store.memberEligible)return 'member';
    return null;
  }
  function sesumOfferCandidates(familyId){
    const contexts=sesumCampaignContexts(),today=shoppingDay(now()),items=[];
    for(const context of contexts.values()){
      if(familyId&&context.familyId!==familyId)continue;
      const review=s.sesumOfferReviews[campaignKey(context.sourceKey,context.familyId)],linked=Object.values(s.offers).filter(o=>o.watchId===context.familyId&&o.sesumCampaign?.sourceKey===context.sourceKey);
      if(context.receipt.isPromo!==true&&context.receipt.promotion==null&&!linked.length)continue;
      const current=currentCampaignReview(review,context),offer=current&&review.offerId?s.offers[review.offerId]:null,hold=offer?campaignOfferState(offer,contexts):null,claim=offer?.sesumCampaign;
      const bound=claim?.sourceKey===context.sourceKey&&offer.watchId===context.familyId&&claim.sourceFingerprint===context.sourceFingerprint&&claim.familyFingerprint===context.familyFingerprint&&claim.campaignFingerprint===context.campaignFingerprint;
      const settled=current&&(review.status==='not-actionable'||review.status==='registered'&&offer&&bound&&(offer.validTo<today||hold===null||hold==='member'));
      const chain=offer?s.settings.stores.find(s=>s.id===offer.storeId)?.chainCode:null;
      items.push({...structuredClone(context),status:settled?review.status:current&&review.status==='blocked'?'blocked':'pending',reason:settled?null:hold??(current&&review.status==='blocked'?review.reason:'review-campaign-conditions'),review:review?structuredClone(review):null,offerId:offer?.id??null,offerTermsFingerprint:offer&&chain===context.source.store?offerTermsFingerprint(offer,chain):null});
    }
    return {items};
  }
  function sesumOfferWork({all=false}={}){
    const at=now().getTime();
    return sesumOfferCandidates().items.filter(item=>!['registered','not-actionable'].includes(item.status)&&(all||item.status!=='blocked'||!item.review.retryAt||Date.parse(item.review.retryAt)<=at)).map(item=>({do:'shopping-sesum-offer-review',watchId:item.familyId,familyId:item.familyId,familyName:item.familyName,sourceKey:item.sourceKey,sourceFingerprint:item.sourceFingerprint,familyFingerprint:item.familyFingerprint,campaignFingerprint:item.campaignFingerprint,offerTermsFingerprint:item.offerTermsFingerprint,status:item.status,reason:item.reason,retryAt:item.review?.retryAt??null}));
  }
  function sesumOfferReview(input){
    if(!input||!['registered','not-actionable','blocked'].includes(input.status))throw Error('Ugyldig Sesum-tilbudsvurdering.');
    const context=sesumCampaignContexts().get(campaignKey(input.sourceKey,input.familyId));
    if(!context||input.sourceFingerprint!==context.sourceFingerprint||input.familyFingerprint!==context.familyFingerprint||input.campaignFingerprint!==context.campaignFingerprint)throw Error('Sesum-kampanjen, varen eller familiens godkjenning er endret; les gjeldende belegg.');
    if(typeof input.evidence!=='string'||input.evidence.length>6000||input.evidence.trim().length<10)throw Error('Konkret kampanjebelegg på 10–6000 tegn kreves.');
    const evidence=input.evidence.trim();
    const key=campaignKey(context.sourceKey,context.familyId),previous=s.sesumOfferReviews[key],record={sourceKey:context.sourceKey,familyId:context.familyId,sourceFingerprint:context.sourceFingerprint,familyFingerprint:context.familyFingerprint,campaignFingerprint:context.campaignFingerprint,status:input.status,evidence,reviewedAt:now().toISOString()};
    let entry=null;
    if(input.status==='registered'){
      if(!!input.offer===!!input.offerId)throw Error('Oppgi enten et eksisterende offerId eller ett fullstendig tilbud.');
      entry=input.offer?buildOffer(input.offer,{campaignReview:true}):s.offers[input.offerId];
      if(!entry||entry.watchId!==context.familyId||entry.comparable!==true)throw Error('Tilbudet må gjelde den faktisk godkjente varefamilien.');
      const existing=s.offers[entry.id];
      if(existing?.sesumCampaign&&(existing.sesumCampaign.sourceKey!==context.sourceKey||existing.watchId!==context.familyId))throw Error('Tilbudet er allerede bundet til en annen Sesum-kilde eller varefamilie; bruk et eget externalId.');
      const store=s.settings.stores.find(s=>s.id===entry.storeId);
      const proof=validateCampaignOffer({campaign:context,offer:entry,chainCode:store?.chainCode,conditionsVerified:input.conditionsVerified,termsEvidence:input.termsEvidence,sourceReceipts:input.sourceReceipts,now:now()});
      record.offerId=entry.id;record.offerTermsFingerprint=offerTermsFingerprint(entry,store.chainCode);record.termsEvidence=proof.termsEvidence;record.sourceReceipts=proof.sourceReceipts;record.latestPrimaryReadAt=proof.latestPrimaryReadAt;
      entry={...entry,sesumCampaign:{sourceKey:context.sourceKey,sourceFingerprint:context.sourceFingerprint,familyFingerprint:context.familyFingerprint,campaignFingerprint:context.campaignFingerprint}};
    }else if(input.status==='blocked'){
      record.reason=required(input.reason,'Uavklart kampanjevilkår');
      record.retryAt=input.retryAt??new Date(now().getTime()+6*3600000).toISOString();
      if(!Number.isFinite(Date.parse(record.retryAt))||Date.parse(record.retryAt)<=now().getTime()||Date.parse(record.retryAt)>now().getTime()+7*86400000)throw Error('Ny vurdering må være innen sju dager og i fremtiden.');
    }else{
      if(!['expired','wrong-variant','not-a-real-offer'].includes(input.reason)||input.resolutionVerified!==true)throw Error('Et faktisk påvist avslagsgrunnlag kreves; ukjente vilkår må blokkeres.');
      if(!Array.isArray(input.sourceReceipts)||!input.sourceReceipts.length||input.sourceReceipts.length>20||input.sourceReceipts.some(r=>!r||typeof r.evidence!=='string'||r.evidence.trim().length<10||r.evidence.length>6000||!Number.isFinite(Date.parse(r.observedAt))||Date.parse(r.observedAt)>now().getTime()||!freshPrice(r.observedAt)||!/^https:\/\//.test(r.url??'')))throw Error('Et konkret, ferskt kildebelegg for avslaget kreves.');
      if(!input.sourceReceipts.some(r=>!isSesumSource(url(r.url))))throw Error('Et primært kildebelegg må avklare kampanjen.');
      if(input.reason==='expired'){
        const ends=['endsAt','ends_at','endDate','end_date','validTo','valid_to','validUntil','valid_until'].map(key=>context.receipt.promotion?.[key]).filter(value=>value!==null&&value!==undefined);
        if(ends.length){
          if(ends.some(value=>typeof value!=='string'||!Number.isFinite(Date.parse(value))||(/^\d{4}-\d\d-\d\d$/.test(value)?day(value)>=shoppingDay(now()):Date.parse(value)>now().getTime())))throw Error('Kampanjens kjente slutt er ikke dokumentert utløpt.');
        }else if(!input.resolvedValidTo||day(input.resolvedValidTo)>=shoppingDay(now()))throw Error('Ukjent slutt må avklares med primærbelegg og resolvedValidTo før utløp kan registreres.');
        if(input.resolvedValidTo)record.resolvedValidTo=day(input.resolvedValidTo);
      }
      record.reason=input.reason;record.resolutionVerified=true;record.sourceReceipts=input.sourceReceipts.map(r=>({url:url(r.url),observedAt:new Date(r.observedAt).toISOString(),evidence:text(r.evidence,6000)}));
    }
    return update(()=>{
      const same=r=>JSON.stringify(Object.fromEntries(Object.entries(r).filter(([key])=>key!=='reviewedAt')));
      if(previous&&same(previous)===same(record)&&(!entry||JSON.stringify(entry)===JSON.stringify(s.offers[entry.id])))return structuredClone(previous);
      if(previous)(s.sesumOfferReviewHistory??=[]).push(structuredClone(previous));
      if(entry){
        const prior=s.offers[entry.id],decision=s.dealDecisions[entry.id],chain=s.settings.stores.find(store=>store.id===entry.storeId)?.chainCode;
        // Adding reviewed source provenance alone must not undo a household's
        // existing decline or purchase of the unchanged ordinary offer.
        if(prior&&!prior.sesumCampaign&&decision?.fingerprint===offerFingerprint(prior)&&offerTermsFingerprint(prior,chain)===offerTermsFingerprint(entry,chain))s.dealDecisions[entry.id]={...decision,fingerprint:offerFingerprint(entry)};
        s.offers[entry.id]=entry;
      }
      s.sesumOfferReviews[key]=record;
      return {...record,offerId:entry?.id??null};
    });
  }
  const sesumFamilyDecision=(p,id,requirements,registrationFingerprint=null)=>{
    const row=s.sesumFamilyReviews[p.sourceKey]?.[id];
    return row?.sourceFingerprint===p.sourceFingerprint&&row.familyFingerprint===requirements.get(id)&&(row.registrationFingerprint??null)===registrationFingerprint?row:null;
  };
  function sesumWork(){
    const pending=sesumPrices.pending().filter(row=>sesumCatalogue.researchable(sesumPrices.sourceRecord(row.sourceKey).source));if(!pending.length)return [];
    const requirements=sesumRequirements(),semantic=sesumPlacementFamilies().families,research=sesumResearches();
    return pending.map(p=>({...p,rawFamilyIds:[...p.familyIds],researchedFamilyIds:sesumResearchedFamilyIds(p,semantic),familyIds:sesumEffectiveFamilyIds(p,semantic).filter(id=>s.watches[id]?.enabled!==false&&s.watches[id]&&sesumFamilyDecision(p,id,requirements,research.get(p.sourceKey)?.registrationFingerprint??null)?.status!=='excluded')})).filter(p=>p.familyIds.length||p.basisReviewNeeded).map(p=>({...p,do:p.basisReviewNeeded||p.hasReviewedDonor?'shopping-sesum-review':'shopping-sesum-discovery',reason:p.basisReviewNeeded?'review-direct-unit-basis':p.hasReviewedDonor?'review-source-bridge':'new-product-needs-family-research'}));
  }
  function sesumCandidates(familyId){
    const reader=reviewedReader(),requirements=sesumRequirements(),research=sesumResearches(),placement=sesumPlacement(),work=new Map(sesumFamilyContexts().map(item=>[item.sourceKey+'\0'+item.familyId,item])),placements=new Map(placement.items.map(item=>[item.sourceKey,item]));
    return sesumPrices.candidates().filter(p=>!familyId||sesumEffectiveFamilyIds(p,placement.families).includes(familyId)).map(p=>{const registrationFingerprint=research.get(p.sourceKey)?.registrationFingerprint??null,researchedFamilyIds=sesumResearchedFamilyIds(p,placement.families),effectiveFamilyIds=sesumEffectiveFamilyIds(p,placement.families);return {...p,researchedFamilyIds,effectiveFamilyIds,placement:placements.get(p.sourceKey)??null,registration:discovery.record(p.sourceKey),registrationFingerprint,families:effectiveFamilyIds.filter(id=>s.watches[id]).map(id=>{const w=s.watches[id];return {familyId:id,name:w.name,unit:w.unit,note:w.note??null,requirementsFingerprint:requirements.get(id),registrationFingerprint,sourceDecision:sesumFamilyDecision(p,id,requirements,registrationFingerprint),priorSourceDecision:s.sesumFamilyReviews[p.sourceKey]?.[id]?structuredClone(s.sesumFamilyReviews[p.sourceKey][id]):null,familyReview:work.get(p.sourceKey+'\0'+id)??null,family:w.family??null,variants:w.variants??[],groups:linkStates(w,reader).filter(l=>l.state==='ok').map(l=>({groupId:l.groupId,...reader.group(l.groupId)}))};})};});
  }
  function sesumPriceReview(input){
    if(input?.kind==='placement')return sesumPlacementReview(input);
    if(input?.kind==='catalogue')return sesumCatalogueReview(input);
    if(!['excluded','reopen','blocked'].includes(input.status))return sesumPrices.review(input);
    const source=sesumPrices.sourceRecord(input.sourceKey),requirements=sesumRequirements();
    if(!source||source.sourceFingerprint!==input.sourceFingerprint)throw Error('Sesum-kilden er endret; les gjeldende fingerprint.');
    if(!Array.isArray(input.familyIds)||!input.familyIds.length||new Set(input.familyIds).size!==input.familyIds.length||!input.familyFingerprints||typeof input.familyFingerprints!=='object')throw Error('Familieavslag krever familyIds og gjeldende familyFingerprints; søketreff er bare spor.');
    if(typeof input.equivalenceEvidence!=='string'||!input.equivalenceEvidence.trim()||input.equivalenceEvidence.length>6000)throw Error('Konkret familiebelegg på høyst 6000 tegn kreves.');
    const evidence=input.equivalenceEvidence.trim(),registrationFingerprint=sesumResearches().get(input.sourceKey)?.registrationFingerprint??null;
    if((input.registrationFingerprint??null)!==registrationFingerprint)throw Error('Produktets gjennomgåtte metadata eller gruppemedlemskap er endret; les gjeldende registrationFingerprint.');
    const effectiveFamilyIds=sesumEffectiveFamilyIds(source);
    for(const id of input.familyIds)if(!effectiveFamilyIds.includes(id)||!requirements.has(id)||!Object.hasOwn(input.familyFingerprints,id)||input.familyFingerprints[id]!==requirements.get(id))throw Error('Varefamilien er endret eller ukjent; les gjeldende krav før vurdering.');
    let reason=null,retryAt=null;
    if(input.status==='blocked'){
      const open=new Set(sesumFamilyContexts().filter(item=>item.sourceKey===source.sourceKey).map(item=>item.familyId));
      if(!registrationFingerprint||input.familyIds.some(id=>!open.has(id)))throw Error('Blokkering krever en aktuell uløst familievurdering for en godkjent kildeidentitet.');
      if(typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>6000)throw Error('Oppgi det konkrete manglende familiebelegget som reason.');
      reason=input.reason.trim();retryAt=input.retryAt??new Date(now().getTime()+6*3600000).toISOString();
      if(!Number.isFinite(Date.parse(retryAt))||Date.parse(retryAt)<=now().getTime()||Date.parse(retryAt)>now().getTime()+7*86400000)throw Error('Ny familievurdering må være innen sju dager og i fremtiden.');
    }
    return update(()=>{
      s.sesumFamilyReviews[input.sourceKey]??={};
      for(const id of input.familyIds){
        const previous=s.sesumFamilyReviews[input.sourceKey][id],priorExclusion=previous?.status==='excluded'?previous:previous?.previousExclusion;
        if(input.status==='reopen')delete s.sesumFamilyReviews[input.sourceKey][id];else s.sesumFamilyReviews[input.sourceKey][id]={status:input.status,sourceFingerprint:source.sourceFingerprint,familyFingerprint:requirements.get(id),registrationFingerprint,evidence,...(input.status==='blocked'?{reason,retryAt,...(priorExclusion?{holdExcluded:true,previousExclusion:structuredClone(priorExclusion)}:{})}:{}),reviewedAt:now().toISOString()};
      }
      if(input.status==='excluded'){
        const reader=libReader();
        for(const id of input.familyIds)quarantineScopedMarket(s.watches[id],sesumScopedExclusions(s.watches[id],reader));
      }
      return {sourceKey:input.sourceKey,status:input.status,familyIds:[...input.familyIds]};
    });
  }
  function sesumRegister(input){
    const registration=discovery.register(input);
    const bridge=sesumPrices.review({...input,status:'approved',productKey:registration.productKey,productFingerprint:registration.productFingerprint,equivalenceEvidence:input.identityEvidence});
    return {registration,bridge};
  }
  // Translate only an exact current legacy basis. Unknown/stale negatives stay
  // conservative price holds and create current review work until an explicit
  // decision; changing the fingerprint domain never makes a product eligible.
  if(Object.keys(s.sesumFamilyReviews).length){
    const semantic=sesumRequirements(),legacy=new Map(sesumFamilies().map(f=>[f.familyId,hash(JSON.stringify([f.requirementsFingerprint,s.watches[f.familyId]?.note??null]))])),research=sesumResearches();
    for(const [sourceKey,rows] of Object.entries(s.sesumFamilyReviews)){
      const source=sesumPrices.sourceRecord(sourceKey),registrationFingerprint=research.get(sourceKey)?.registrationFingerprint??null;
      for(const [id,row] of Object.entries(rows))if(source&&row.sourceFingerprint===source.sourceFingerprint&&(row.registrationFingerprint??null)===registrationFingerprint&&semantic.has(id)&&row.familyFingerprint===legacy.get(id))rows[id]={...row,legacyFamilyFingerprint:row.familyFingerprint,familyFingerprint:semantic.get(id)};
    }
  }
  return {sesumFamilies,sesumPlacement,sesumReceivePrices,sesumReceiveMetadata:input=>sesumCatalogue.ingest(input),sesumCandidates,sesumRegister,sesumPriceReview,sesumOfferCandidates,sesumOfferReview,sesumPriceStatus:()=>({...sesumPrices.status(),discovery:discovery.status(),catalogue:sesumCatalogue.status()}),familyReopen,listFamily,listFamilyWork,explorer,productInfo,libraryAudit,libraryAuditAck,libraryLink,libraryLinkCandidates,librarySearch,stockScan,stockIntake,feedFingerprint,completion,odaLimit:id=>s.odaLimits[id]?.max??null,imageSource,cartReview,recordOdaLimit,listRouteWork,listRouteAttempt,listRouteFinish,list,offerSource,feed,checklist,familyView,familySummary,pantry,item,dealAction,link,importOrders,settings,watch,offer,review,nutrition,market,catalogObserve,catalogReview,catalogEntries:watchId=>catalog.entries(watchId),analysis,queue,view,cartReceipt,receipt:id=>structuredClone(s.cartReceipts[id]??null)};
}
