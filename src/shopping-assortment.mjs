import {odaProductIdFromUrl} from './oda-product-identity.mjs';
import {createHash} from 'node:crypto';
import {createProductLibrary,productMetadataFingerprint,groupMetadataFingerprint} from './product-library.mjs';
import {createIndexReader} from './shopping-library.mjs';
import {sesumCatalogueMetadata} from './sesum-catalogue.mjs';
import {sesumSourceFingerprint} from './sesum-prices.mjs';
import {sanitizeUnitPriceBasis} from './sesum-unit-basis.mjs';
import {countedPackage} from './sesum-counted-package.mjs';

const clone=structuredClone,hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const own=(m,k)=>Object.hasOwn(m,k)?m[k]:null;
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const text=(v,min=1,max=20000)=>{if(typeof v!=='string'||v.trim().length<min||v.length>max)throw Error('Invalid assortment evidence/text.');return v.trim();};
const https=v=>{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.hash)throw Error('Invalid assortment source URL.');return u.href;};
const stamp=(v,at)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=at;
const code=v=>{if(typeof v!=='string'||! /^[A-Z][A-Z0-9_]{1,63}$/.test(v))throw Error('Invalid assortment chain.');return v;};
const id=v=>{if(!/^[1-9]\d*$/.test(String(v))||!Number.isSafeInteger(Number(v)))throw Error('Invalid assortment native ID.');return String(v);};
const alias=v=>({EXTRA:'COOP_EXTRA',MENY:'MENY_NO',SPAR:'SPAR_NO',ODA:'ODA_NO',EUROPRIS:'EUROPRIS_NO',OBS:'COOP_OBS',PRIX:'COOP_PRIX',MEGA:'COOP_MEGA',JOKER:'JOKER_NO',BUNNPRIS:'BUNNPRIS',COOP_MARKED:'MATKROKEN'}[v]??v);
export function assortmentConfig(value={}){
 const priceHorizonDays=value.priceHorizonDays??14;
 if(!Number.isInteger(priceHorizonDays)||priceHorizonDays<1||priceHorizonDays>183)throw Error('Assortment priceHorizonDays must be 1–183.');
 const odaScope=value.odaScope??'household';if(!['household','all-current'].includes(odaScope))throw Error('Invalid Oda category scope.');
 const familySource=value.familySource??'reviewed-library';if(!['reviewed-library','sesum'].includes(familySource))throw Error('Invalid assortment familySource.');
 return {...value,familySource,odaScope,enabled:value.enabled===true,collectionEnabled:value.collectionEnabled===true,priceHorizonDays};
}
function pack(weight,unit){const u=String(unit??'').toLowerCase(),amount=Number(weight);return positive(amount)&&['g','kg','ml','l','stk','piece','m'].includes(u)?{amount:amount*(['g','ml'].includes(u)?.001:1),unit:['g','kg'].includes(u)?'kg':['ml','l'].includes(u)?'l':u==='piece'?'stk':u}:null;}
export function sesumAssortmentRows(input,at){
 if(!Array.isArray(input.products)||input.products.length>500||!stamp(input.fetchedAt,at+60000))throw Error('Invalid Sesum assortment observation.');
 return input.products.map(raw=>{
  const p=sesumCatalogueMetadata(raw),productKey='sesum:CATALOGUE:'+p.id;
  const metadata={...p,source:'sesum',store:'CATALOGUE',productKey,ingredients:null,description:null,rawPack:{weight:p.weight,weightUnit:p.weightUnit,soldByWeight:p.soldByWeight}};
  const prices=(raw.prices??[]).map(r=>{const basis=p.soldByWeight===true?sanitizeUnitPriceBasis(r.unitPriceBasis,{...r,productId:p.id,sourceUrl:p.sourceUrl}).basis:null;return {store:code(alias(r.storeCode)),observedPrice:positive(r.price)?r.price:null,grossPackPrice:p.soldByWeight===true?null:positive(r.price)?r.price:null,...(basis?{grossUnitPrice:basis.amount,unit:basis.unit,unitPriceEvidence:basis.label}:{}),receiptAt:stamp(r.observedAt,at)?r.observedAt:null,sourceUrl:p.sourceUrl,provenance:typeof r.source==='string'?r.source:null,isPromo:r.isPromo===true,promotion:clone(r.promotion??null),available:raw.available!==false&&!raw.delisted};});
  return {productKey,metadata,prices,sourceCategories:clone(raw.sourceCategories??[]),fetchedAt:input.fetchedAt,available:raw.available!==false&&raw.delisted!==true,raw:clone(raw)};
 });
}
export function kassalAssortmentRows(input,at){
 const rows=Array.isArray(input.data)?input.data:input.data?.products;
 if(!Array.isArray(rows)||rows.length>100||!stamp(input.fetchedAt,at+60000))throw Error('Invalid Kassal catalogue page.');
 return rows.map(raw=>{
  const nativeId=id(raw.id),store=code(raw.store?.code),productKey=`kassal:${store}:${nativeId}`,current=raw.current_price;
  // A history date may only date the same numeric quote; never attach an old
  // history date to a different current price or to product updated_at.
  const amount=typeof current==='object'?current?.price:current;
  const matchingDates=(raw.price_history??[]).filter(r=>r.price===amount&&stamp(r.date,at)).map(r=>r.date).sort((a,b)=>Date.parse(b)-Date.parse(a));
  const last=typeof current==='object'&&stamp(current?.date,at)?current.date:matchingDates[0]??null;
  let sourceUrl;try{sourceUrl=https(raw.url);}catch{sourceUrl=`https://kassal.app/api/v1/products/id/${nativeId}`;}
  const metadata={source:'kassal',store,id:nativeId,productKey,name:text(raw.name,1,1000),brand:typeof raw.brand==='string'?raw.brand:raw.brand?.name??null,ean:raw.ean??null,ingredients:raw.ingredients??null,description:raw.description??null,sourceUrl,rawPack:{weight:raw.weight??null,weightUnit:raw.weight_unit??null},allergens:raw.allergens??null,nutritionRaw:raw.nutrition??null};
  const available=raw.available!==false&&raw.is_available!==false&&raw.delisted!==true;
  return {productKey,metadata,prices:[{store,grossPackPrice:positive(amount)?amount:null,receiptAt:stamp(last,at)?last:null,sourceUrl,provenance:'kassal-current-price',available}],fetchedAt:input.fetchedAt,available,raw:clone(raw)};
 });
}
export function odaAssortmentRows(input,at){
 if(!Array.isArray(input.products)||input.products.length>200||!stamp(input.observedAt,at+60000))throw Error('Invalid actual Oda catalogue receipt.');
 const units={kilogram:'kg',kg:'kg',liter:'l',litre:'l',l:'l',stykk:'stk',stk:'stk',stykke:'stk',rull:'stk',roll:'stk',meter:'m',metre:'m',m:'m'};
 const decimal=v=>typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)?Number(v):typeof v==='number'?v:null;
 return input.products.map(raw=>{const nativeId=id(raw.id),productKey='oda:ODA_NO:'+nativeId,sourceUrl=https(raw.url),parsedId=odaProductIdFromUrl(sourceUrl);if(String(parsedId)!==nativeId)throw Error('Oda native URL and product ID disagree.');
  const price=decimal(raw.price),unitPrice=decimal(raw.unitPrice),unit=units[String(raw.unitName??'').toLowerCase()],available=raw.availability?.isAvailable===true;
  const metadata={source:'oda',store:'ODA_NO',id:nativeId,productKey,name:text(raw.name,1,1000),brand:typeof raw.brand==='string'?raw.brand:raw.brand?.name??null,ean:raw.ean??null,ingredients:typeof raw.ingredients==='string'?raw.ingredients:null,description:typeof raw.description==='string'?raw.description:null,sourceUrl,unit:unit??null,rawPack:{weight:null,weightUnit:null}};
  return {productKey,metadata,available,fetchedAt:input.observedAt,raw:clone(raw),prices:[{store:'ODA_NO',grossPackPrice:positive(price)?price:null,...(positive(unitPrice)&&unit?{grossUnitPrice:unitPrice,unit,unitPriceEvidence:`Actual Oda MCP unitPrice ${raw.unitPrice}; unitName ${raw.unitName}`,priceIncludesVat:true}:{}),receiptAt:input.observedAt,provenance:'actual-oda-mcp-current-price',sourceUrl,available}]};
 });
}
const groupDefinition=(id,g)=>({id,name:g.name,category:g.category,canonicalUnit:g.canonicalUnit??g.unit,inclusionCriteria:g.inclusionCriteria??g.inclusion,exclusions:g.exclusions,qualityBasis:g.qualityBasis,comparisonBasis:g.comparisonBasis});

/** Source catalogue, semantic reviews and quote readiness are independent.
 * No household watch, stock, annual need or cart is mutated by this module. */
export function createShoppingAssortment(state,{save=()=>{},persist=null,now=()=>new Date(),config={},reader=()=>null}={}){
 config=assortmentConfig(config);state.version??=1;state.products??={};state.groups??={};state.reviews??={};state.revision??=0;state.catalogueRevision??=state.revision;
 if(state.version!==1)throw Error('Unknown assortment state version.');
 let cachedIndex=null,cachedRevision=-1,cachedBase=null,compiled=null;
 const emptyIndex={groups:{},members:{},products:{},qualityNotes:{}},generatedCache=new Map();
 const clock=()=>new Date(now()).getTime();
 const group=(key,base=reader())=>base?.group(key)??own(state.groups,key);
 const currentReview=(row,base=reader())=>{const review=own(state.reviews,row.productKey);return review?.status==='reviewed'&&review.sourceFingerprint===row.sourceFingerprint&&review.memberships.every(m=>{const g=group(m.groupId,base);return g&&groupMetadataFingerprint(groupDefinition(m.groupId,g))===m.groupFingerprint;})?review:null;};
 const active=row=>row.available&&row.prices.some(p=>p.available!==false&&(positive(p.grossPackPrice)||positive(p.observedPrice))&&p.provenance&&stamp(p.receiptAt,clock())&&clock()-Date.parse(p.receiptAt)<=config.priceHorizonDays*86400000);
 function ingest(rows){
  if(!config.enabled)return {observed:0,disabled:true};
  const keys=new Set();for(const row of rows){if(keys.has(row.productKey))throw Error('Duplicate assortment native identity in one observation.');keys.add(row.productKey);}
  // Validate/construct everything before the first mutation.
  const prepared=rows.map(row=>{
   const sourceFingerprint=hash(row.metadata),previous=own(state.products,row.productKey);
   if(previous&&Date.parse(row.fetchedAt)<Date.parse(previous.fetchedAt))return previous;
   const same=previous?.sourceFingerprint===sourceFingerprint,prices=new Map();
   if(same)for(const p of previous.prices)prices.set(p.store,p);
   for(const price of row.prices){const prior=prices.get(price.store);if(!prior||!stamp(prior.receiptAt,clock())||stamp(price.receiptAt,clock())&&Date.parse(price.receiptAt)>=Date.parse(prior.receiptAt)){
    const conflict=prior?.receiptAt===price.receiptAt&&positive(prior.grossPackPrice)&&positive(price.grossPackPrice)&&prior.grossPackPrice!==price.grossPackPrice;
    prices.set(price.store,{...price,conflicting:conflict||prior?.receiptAt===price.receiptAt&&prior.conflicting===true});
   }}
   const priceKey=p=>hash([p.store,p.receiptAt,p.grossPackPrice,p.observedPrice,p.grossUnitPrice,p.unit,p.provenance,p.sourceFingerprint]),priceHistory=new Map((previous?.priceHistory??[]).map(p=>[priceKey(p),p]));
   for(const price of [...(previous?.prices??[]),...row.prices]){const observation={...price,sourceFingerprint:previous?.prices.includes(price)?previous.sourceFingerprint:sourceFingerprint};priceHistory.set(priceKey(observation),observation);}
   return {...row,prices:[...prices.values()],priceHistory:[...priceHistory.values()],sourceFingerprint,firstSeen:previous?.firstSeen??row.fetchedAt,...(previous&&!same?{history:[...(previous.history??[]),{metadata:previous.metadata,sourceFingerprint:previous.sourceFingerprint,fetchedAt:previous.fetchedAt,prices:previous.prices}]}:previous?.history?{history:previous.history}:{})};
  });
  const changedRows=[];for(const row of prepared)if(JSON.stringify(row)!==JSON.stringify(own(state.products,row.productKey))){state.products[row.productKey]=row;changedRows.push(row);}
  if(changedRows.length){state.revision++;state.catalogueRevision++;if(persist)persist({revision:state.revision,catalogueRevision:state.catalogueRevision,products:changedRows});else save();}return {observed:rows.length,changed:changedRows.length};
 }
 const receiveSesum=input=>ingest(sesumAssortmentRows(input,clock()));
 const importSesum=observations=>{if(!Array.isArray(observations)||observations.length>500)throw Error('Import at most 500 complete stored observations.');return ingest(observations.flatMap(row=>sesumAssortmentRows({products:[row.product],fetchedAt:row.fetchedAt},clock())));};
 const receiveKassal=input=>ingest(kassalAssortmentRows(input,clock()));
 const receiveOda=input=>ingest(odaAssortmentRows(input,clock()));
 function receiveOdaAvailability(input){
  const raw=input.product,receipt=input.sourceReceipt,nativeId=raw&&id(raw.id),sourceUrl=raw&&https(raw.url);
  if(!nativeId||odaProductIdFromUrl(sourceUrl)!==Number(nativeId)||raw.availability?.isAvailable!==false||receipt?.url!==sourceUrl||!stamp(receipt.observedAt,clock()+60000)||typeof receipt.evidence!=='string'||receipt.evidence.trim().length<20)throw Error('Actual official Oda unavailable-product receipt required.');
  const productKey='oda:ODA_NO:'+nativeId,metadata={source:'oda',store:'ODA_NO',id:nativeId,productKey,name:text(raw.name,1,1000),brand:raw.brand??null,ean:null,ingredients:null,description:typeof raw.description==='string'?raw.description:null,sourceUrl,unit:null,rawPack:{weight:null,weightUnit:null}};
  return ingest([{productKey,metadata,available:false,fetchedAt:receipt.observedAt,raw:{...clone(raw),sourceReceipt:clone(receipt),sourceKind:'actual-oda-product-page'},prices:[{store:'ODA_NO',grossPackPrice:null,receiptAt:null,sourceUrl,provenance:'actual-oda-product-page-availability',available:false}]}]);
 }
 function attachSesumCategories({productIds,category,observedAt}){
  if(!Array.isArray(productIds)||productIds.length>10000||!stamp(observedAt,clock()+60000)||!category||! /^[1-9]\d*$/.test(String(category.id)))throw Error('Invalid actual source-category membership receipt.');
  const changed=[],reused=[];for(const nativeId of new Set(productIds.map(id))){const key='sesum:CATALOGUE:'+nativeId,row=own(state.products,key);if(!row||!active(row))continue;
   reused.push(nativeId);const previous=row.sourceCategories??[],receipt={id:String(category.id),name:category.name??null,url:category.url,observedAt};
   if(previous.some(c=>c.id===receipt.id))continue;const next={...row,sourceCategories:[...previous,receipt]};state.products[key]=next;changed.push(next);
  }
  if(changed.length){state.revision++;if(persist)persist({revision:state.revision,products:changed});else save();}return reused;
 }
 function reuse(row,base){
  if(own(state.reviews,row.productKey))return null;
  const m=row.metadata,keys=m.source==='sesum'?row.prices.map(r=>`sesum:${r.store}:${m.id}`):[row.productKey];
  for(const key of keys){
   const p=base?.product(key);if(!p)continue;
   const exact=m.source==='sesum'?typeof p.sourceFingerprint==='string'&&p.sourceFingerprint===sesumSourceFingerprint({...m,store:p.store}):p.name===m.name&&(p.brand??null)===(m.brand??null)&&p.sourceUrl===m.sourceUrl&&JSON.stringify(p.rawPack??null)===JSON.stringify(m.rawPack??null)&&(p.reviewFacts?.ingredients??p.ingredients??null)===(m.ingredients??null)&&(p.reviewFacts?.description??p.description??null)===(m.description??null);
   if(!exact)continue;
   const memberships=base.groupsOf(key).filter(r=>r.s==='approved'&&r.r&&r.reviewFacts?.sourceReceipts?.length).map(r=>({groupId:r.groupId,groupFingerprint:base.group(r.groupId).fingerprint,...r.reviewFacts}));
   if(memberships.length)return {status:'reviewed',sourceFingerprint:row.sourceFingerprint,memberships,product:{canonicalPackAmount:p.pack,unit:p.unit,packEvidence:p.reviewFacts?.packEvidence??p.packEvidence,ingredients:p.reviewFacts?.ingredients??m.ingredients,description:p.reviewFacts?.description??m.description,nutrition:p.nutrition,attributes:p.attributes},reused:true,reusedProductKey:key};
  }
  return null;
 }
 function reviewOf(row,base){return currentReview(row,base)??reuse(row,base);}
 function work({all=false}={}){
  if(!config.enabled||config.familySource==='sesum')return [];
  const base=reader(),at=clock();return Object.values(state.products).filter(active).flatMap(row=>{
   if(reviewOf(row,base))return [];
   const review=own(state.reviews,row.productKey),blocked=review?.status==='blocked'&&review.sourceFingerprint===row.sourceFingerprint;
   if(blocked&&!all&&Date.parse(review.retryAt)>at)return [];
   return [{do:'shopping-assortment-review',productKey:row.productKey,name:row.metadata.name,assortmentFingerprint:row.sourceFingerprint,fingerprint:row.sourceFingerprint,status:blocked?'blocked':'pending',reason:blocked?review.reason:'classify-current-assortment',retryAt:blocked?review.retryAt:null}];
  });
 }
 function dossier(key){const row=own(state.products,key);return row?{...clone(row),active:active(row),priceHorizonDays:config.priceHorizonDays,review:clone(reviewOf(row,reader())??own(state.reviews,key)),authority:'Full native source metadata and separate actual prices. Names/EAN suggest candidates only. No household approval or local stock verification.'}:null;}
 function classify(input){
  if(!config.enabled||config.familySource==='sesum')throw Error('Independent family creation is disabled; use native Sesum categories.');
  const row=own(state.products,input.productKey);if(!row||!active(row)||input.sourceFingerprint!==row.sourceFingerprint)throw Error('Assortment source changed or is no longer current.');
  const evidence=text(input.evidence,20,6000),at=clock(),base=reader();
  if(input.status==='blocked'){
   if(!stamp(input.retryAt,at+7*86400000)||Date.parse(input.retryAt)<=at)throw Error('A concrete blocker needs a retry within seven days.');
   state.reviews[row.productKey]={status:'blocked',sourceFingerprint:row.sourceFingerprint,evidence,reason:text(input.reason,10,6000),retryAt:input.retryAt,reviewedAt:new Date(at).toISOString()};state.revision++;state.catalogueRevision++;if(persist)persist({revision:state.revision,catalogueRevision:state.catalogueRevision,reviews:[[row.productKey,state.reviews[row.productKey]]]});else save();return {productKey:row.productKey,status:'blocked'};
  }
  if(input.status!=='reviewed'||input.contentsReviewed!==true||input.groupSearchReviewed!==true)throw Error('Read actual contents/form and search the global library before classification.');
  const definitions=new Map(),knownGroups={...(base?.index().groups??{}),...state.groups},normalized=v=>String(v??'').normalize('NFC').toLocaleLowerCase('nb-NO').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
  for(const g of input.groups??[]){if(!object(g)||! /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(g.id??'')||definitions.has(g.id))throw Error('Invalid/duplicate group identity.');const existing=group(g.id,base);if(existing&&groupMetadataFingerprint(groupDefinition(g.id,existing))!==groupMetadataFingerprint(g))throw Error('Group already exists with different criteria; read and reuse it or choose a distinct family.');
   if(Object.entries({...knownGroups,...Object.fromEntries(definitions)}).some(([key,other])=>key!==g.id&&normalized(other.name)===normalized(g.name)&&(other.canonicalUnit??other.unit)===g.canonicalUnit))throw Error('An existing family has the same name and unit; read/reuse it or give a truly different family an explicit distinct name.');definitions.set(g.id,clone(g));}
  if(!Array.isArray(input.memberships)||!input.memberships.length||input.memberships.length>20)throw Error('Every current product needs an explicit family; no-active-household-family is not a classification.');
  const sourceReceipts=input.sourceReceipts;if(!Array.isArray(sourceReceipts)||!sourceReceipts.length||sourceReceipts.length>30)throw Error('Read primary contents/form evidence.');
  for(const r of sourceReceipts){https(r.url);if(!stamp(r.observedAt,at))throw Error('Invalid actual primary read time.');text(r.evidence,20,20000);}
  const facts=clone(input.product??{}),allowed=['ingredients','description','brand','attributes','nutrition','canonicalPackAmount','unit','packEvidence','priceBasis','variableWeightEvidence','unitPriceEvidence','vatEvidence','priceIncludesVat','countedPack','fixedPackVerified','packBasis','packBasisEvidence','packCorrectionEvidence'];
  if(Object.keys(facts).some(k=>!allowed.includes(k)))throw Error('Unsupported researched product fact.');
  if(facts.canonicalPackAmount!=null&&(!positive(facts.canonicalPackAmount)||!['kg','l','stk','m'].includes(facts.unit)||typeof facts.packEvidence!=='string'||facts.packEvidence.length<20))throw Error('A numeric pack requires actual reviewed pack evidence. Unknown packs remain null.');
  if(row.metadata.soldByWeight===true&&facts.canonicalPackAmount!=null)throw Error('A variable-weight source cannot acquire an invented fixed package.');
  if(facts.canonicalPackAmount!=null){
   const sourcePack=pack(row.metadata.rawPack?.weight,row.metadata.rawPack?.weightUnit),source={...row.metadata,weight:Number(row.metadata.rawPack?.weight),weightUnit:row.metadata.rawPack?.weightUnit};
   const measure=countedPackage(source,facts.countedPack,{packAmount:facts.canonicalPackAmount,unit:facts.unit,packBasis:facts.packBasis,fixedPackVerified:facts.fixedPackVerified,at});
   if(sourcePack&&sourcePack.unit!==facts.unit&&!measure&&!(facts.fixedPackVerified===true&&typeof facts.packCorrectionEvidence==='string'&&facts.packCorrectionEvidence.length>=40))throw Error('Source and canonical package units differ; use actual independent counted-pack proof or explicit same-pack primary metadata correction.');
   if(facts.packBasis==='drained')text(facts.packBasisEvidence,20,6000);
   if(sourcePack&&sourcePack.unit===facts.unit&&Math.abs(sourcePack.amount-facts.canonicalPackAmount)>1e-6*Math.max(sourcePack.amount,facts.canonicalPackAmount)&&facts.packBasis!=='drained'&&!(facts.fixedPackVerified===true&&typeof facts.packCorrectionEvidence==='string'&&facts.packCorrectionEvidence.length>=40))throw Error('Source and canonical package amounts conflict; verify a concrete primary correction.');
  }
  if(facts.priceBasis==='direct-unit'){
   if(row.metadata.soldByWeight!==true||facts.canonicalPackAmount!=null||facts.priceIncludesVat!==true||!row.prices.some(p=>positive(p.grossUnitPrice)))throw Error('Direct unit comparison needs actual own-row unit proof and reviewed gross VAT.');
   for(const field of ['variableWeightEvidence','unitPriceEvidence','vatEvidence'])text(facts[field],20,6000);
  }
  if(facts.canonicalPackAmount==null){facts.canonicalPackAmount=null;facts.unit=null;facts.packEvidence=null;}
  const product={...row.metadata,...facts,id:row.metadata.id,productKey:row.productKey,source:row.metadata.source,store:row.metadata.store,available:row.available};product.metadataFingerprint=productMetadataFingerprint(product);
  const seen=new Set(),memberships=input.memberships.map(m=>{
   if(seen.has(m.groupId))throw Error('Duplicate product family.');seen.add(m.groupId);
   const g=definitions.get(m.groupId)??group(m.groupId,base);if(!g)throw Error('Unknown global product family.');
   for(const price of row.prices)if(base?.groupsOf(`${row.metadata.source}:${price.store}:${row.metadata.id}`).some(prior=>prior.groupId===m.groupId&&prior.s==='excluded'))throw Error('Preserve the existing explicit membership exclusion; resolve it through its ordinary review first.');
   const fingerprint=groupMetadataFingerprint(groupDefinition(m.groupId,g));if(m.groupFingerprint!==fingerprint)throw Error('Group changed; read its complete current definition.');
   return {productKey:row.productKey,groupId:m.groupId,status:'approved',equivalenceEvidence:text(m.equivalenceEvidence,20,6000),qualityEvidence:text(m.qualityEvidence,20,6000),reviewedFingerprint:product.metadataFingerprint,reviewedGroupFingerprint:fingerprint,groupFingerprint:fingerprint,reviewedAt:new Date(at).toISOString(),sourceReceipts:clone(sourceReceipts)};
  });
  const groups=[...new Set(memberships.map(m=>m.groupId))].map(key=>definitions.get(key)??groupDefinition(key,group(key,base)));
  const check=createProductLibrary({schemaVersion:1,groups,products:[product],memberships,prices:[]},{now:new Date(at)}).audit();if(!check.ok)throw Error('Invalid semantic library review: '+check.issues.filter(i=>i.severity==='error').map(i=>i.code).join(', '));
  for(const [key,g] of definitions)state.groups[key]=g;
  const prior=own(state.reviews,row.productKey);if(prior)(state.reviewHistory??=[]).push({productKey:row.productKey,...clone(prior)});
  state.reviews[row.productKey]={status:'reviewed',sourceFingerprint:row.sourceFingerprint,evidence,product:clone(facts),memberships,reviewedAt:new Date(at).toISOString()};state.revision++;state.catalogueRevision++;if(persist)persist({revision:state.revision,catalogueRevision:state.catalogueRevision,reviews:[[row.productKey,state.reviews[row.productKey]]],groups:[...definitions],reviewHistory:prior?[{productKey:row.productKey,...clone(prior)}]:[]});else save();return {productKey:row.productKey,status:'reviewed',groups:memberships.map(m=>m.groupId),packKnown:positive(facts.canonicalPackAmount)};
 }
 function status(){const base=reader(),rows=Object.values(state.products),current=rows.filter(active),reviewed=current.filter(r=>reviewOf(r,base)),blocked=work({all:true}).filter(r=>r.status==='blocked');return {enabled:config.enabled,priceHorizonDays:config.priceHorizonDays,observedProducts:rows.length,currentProducts:current.length,parkedProducts:rows.length-current.length,classifiedProducts:reviewed.length,reusedReviews:reviewed.filter(r=>reviewOf(r,base)?.reused).length,remainingProducts:current.length-reviewed.length,blockedProducts:blocked.length,queuedProducts:work().length,newFamilies:Object.keys(state.groups).length,complete:current.length===reviewed.length,coverageNote:'Observed source catalogue only; collection coverage is separate. Recent actual chain price, not verified local stock. Household choices are separate.'};}
 function overlay(base){
  if(!config.enabled)return base;
  const index=base?.index()??emptyIndex;
  if(index!==cachedBase||state.catalogueRevision!==cachedRevision){
   const out={...index,groups:{...index.groups},members:Object.fromEntries(Object.entries(index.members).map(([k,v])=>[k,[...v]])),products:Object.fromEntries(Object.entries(index.products).map(([k,p])=>[k,['kassal','sesum'].includes(p.source)?{...p,assortmentPriceHorizonDays:config.priceHorizonDays}:p])),qualityNotes:{...index.qualityNotes}};
   const replaced=new Set(),addedMembers=new Map();
   for(const row of Object.values(state.products)){
    const hit=generatedCache.get(row.productKey);let generated;
    if(hit&&hit.row===row&&hit.base===index&&hit.review===own(state.reviews,row.productKey)&&hit.groupRefs.every(([key,value])=>group(key,base)===value)){
     generated=hit.value;for(const key of hit.replaced)replaced.add(key);
    }else{
    const review=reviewOf(row,base),groups=(review?.memberships??[]).map(m=>groupDefinition(m.groupId,group(m.groupId,base))),products=[],memberships=[],prices=[];
    const replacedKeys=[];
    for(const receipt of row.prices){
     const productKey=`${row.metadata.source}:${receipt.store}:${row.metadata.id}`;
     // A current observation invalidates old native approvals only when their
     // actual identity/label/pack facts differ; price-only changes retain them.
     const previous=index.products[productKey],same=previous&&previous.name===row.metadata.name&&(previous.brand??null)===(row.metadata.brand??null)&&previous.sourceUrl===row.metadata.sourceUrl&&JSON.stringify(previous.rawPack??null)===JSON.stringify(row.metadata.rawPack??null)&&(previous.reviewFacts?.ingredients??previous.ingredients??null)===(row.metadata.ingredients??null)&&(previous.reviewFacts?.description??previous.description??null)===(row.metadata.description??null);
     const priorFacts=same?{canonicalPackAmount:previous.pack,unit:previous.unit,packEvidence:previous.reviewFacts?.packEvidence??previous.packEvidence,ingredients:previous.reviewFacts?.ingredients??previous.ingredients,description:previous.reviewFacts?.description??previous.description,nutrition:previous.nutrition,attributes:previous.attributes}:{};
     const p={...row.metadata,...priorFacts,...review?.product,productKey,store:receipt.store,available:row.available&&receipt.available!==false};p.metadataFingerprint=productMetadataFingerprint(p);products.push(p);
     if(!same){replaced.add(productKey);replacedKeys.push(productKey);}
     memberships.push(...(review?.memberships??[]).map(m=>({...m,productKey,reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:m.groupFingerprint??m.reviewedGroupFingerprint})));
     prices.push({productKey,grossPackPrice:receipt.grossPackPrice,receiptAt:receipt.receiptAt,availabilityScope:'chain',sourceUrl:receipt.sourceUrl,currency:'NOK',...((review?.product?.priceBasis==='direct-unit'||row.metadata.source==='oda')&&positive(receipt.grossUnitPrice)?{grossUnitPrice:receipt.grossUnitPrice,unit:receipt.unit,unitPriceEvidence:receipt.unitPriceEvidence,priceIncludesVat:row.metadata.source==='oda'?receipt.priceIncludesVat===true:review.product.priceIncludesVat===true}:{}),...(receipt.conflicting?{priceIncludesVat:false}:{})});
    }
    if(!products.length)continue;
    generated=createProductLibrary({schemaVersion:1,groups,products,memberships,prices},{now:new Date(clock())}).shoppingIndex();
    const campaignKeys=new Set(row.prices.filter(r=>r.isPromo||r.promotion).map(r=>`${row.metadata.source}:${r.store}:${row.metadata.id}`));
    for(const key of campaignKeys)if(generated.products[key])generated.products[key].quote.reasons.push('unverified-promotion-conditions');
    for(const rows of Object.values(generated.members))for(const member of rows)if(campaignKeys.has(member.k))member.u=null;
    generatedCache.set(row.productKey,{row,base:index,review:own(state.reviews,row.productKey),groupRefs:(review?.memberships??[]).map(m=>[m.groupId,group(m.groupId,base)]),replaced:replacedKeys,value:generated});
    }
    for(const [key,g] of Object.entries(generated.groups)){out.groups[key]??=g;const rows=addedMembers.get(key)??[];rows.push(...generated.members[key]);addedMembers.set(key,rows);}
    for(const [key,p] of Object.entries(generated.products))out.products[key]={...p,assortmentPriceHorizonDays:config.priceHorizonDays};
   }
   for(const [key,rows] of Object.entries(out.members)){
    const additions=addedMembers.get(key)??[],newKeys=new Set(additions.map(m=>m.k));
    out.members[key]=[...rows.filter(m=>!newKeys.has(m.k)).map(m=>replaced.has(m.k)&&m.s==='approved'?{...m,r:false,u:null,qr:'native-assortment-metadata-changed'}:m),...additions];addedMembers.delete(key);
   }
   for(const [key,rows] of addedMembers)out.members[key]=rows;
   cachedBase=index;cachedRevision=state.catalogueRevision;cachedIndex=out;compiled=createIndexReader(cachedIndex,{horizonDays:base?.horizonDays??183});
  }
  return {...compiled(clock()),cacheKey:`assortment:${base?.cacheKey??''}:${state.catalogueRevision}`};
 }
 return {receiveOdaAvailability,attachSesumCategories,config,receiveSesum,importSesum,receiveKassal,receiveOda,classify,work,dossier,status,overlay};
}
