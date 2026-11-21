import {createHash} from 'node:crypto';
import {createIndexReader} from './shopping-library.mjs';
import {odaProductIdFromUrl} from './oda-product-identity.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const key=id=>'sesum-category:'+id;
const native=id=>{if(! /^[1-9]\d*$/.test(String(id))||!Number.isSafeInteger(Number(id)))throw Error('Invalid native Sesum category ID.');return String(id);};
const current=(receipt,at,days)=>Number.isFinite(Date.parse(receipt??''))&&at>=Date.parse(receipt)&&at-Date.parse(receipt)<=days*86400000;

/** Source taxonomy is the owner's selected organisation, not an assertion that
 * every product in a broad category substitutes for a specific household SKU. */
export function createSesumTaxonomy(state,{persist=null,save=()=>{},now=()=>new Date(),rows=()=>[],baseReader=()=>null,priceHorizonDays=14,odaScope=()=>null,watchFamilies=()=>[]}={}){
 state.categories??={};state.categoryPlacements??={};state.categoryWatchLinks??={};state.revision??=0;
 let cachedRevision=-1,cachedBase=null,cached=null,cachedOdaIndex=null,cachedOdaRows=[],leafRevision=-1,parentIds=new Set();
 const clock=()=>new Date(now()).getTime();
 const commit=patch=>{state.revision++;if(persist)persist({revision:state.revision,...patch});else save();};
 const definition=id=>Object.hasOwn(state.categories,id)&&!state.categories[id].retiredAt?state.categories[id]:null;
 function path(id){const seen=new Set(),out=[];while(id){if(seen.has(id))throw Error('Sesum category hierarchy contains a cycle.');seen.add(id);const row=definition(id);if(!row)break;out.unshift(row);id=row.parentId;}return out;}
 function receive(input){
  if(!Array.isArray(input.categories)||input.categories.length>20000||!current(input.fetchedAt,clock()+60000,36500))throw Error('Invalid native category receipt.');
  const next=new Map(),seen=new Set();
  for(const raw of input.categories){const id=native(raw.id),parentId=raw.parentId==null?null:native(raw.parentId);if(id===parentId||seen.has(id)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>1000)throw Error('Invalid/duplicate native category.');seen.add(id);
   const row={id,name:raw.name,parentId,sourceUrl:raw.sourceUrl??definition(id)?.sourceUrl??null};row.fingerprint=hash([id,row.name,parentId]);next.set(id,{...row,observedAt:input.fetchedAt});
  }
  const combined=input.completeTree===true?Object.fromEntries(next):{...state.categories,...Object.fromEntries(next)};
  for(const row of next.values()){const seen=new Set([row.id]);let parent=row.parentId;while(parent){if(seen.has(parent)||!Object.hasOwn(combined,parent))throw Error('Incomplete/cyclic native category tree.');seen.add(parent);parent=combined[parent].parentId;}}
  const changed=[...next].filter(([id,row])=>definition(id)?.fingerprint!==row.fingerprint||definition(id)?.sourceUrl!==row.sourceUrl);if(input.completeTree===true)for(const [id,row]of Object.entries(state.categories))if(!next.has(id)&&!row.retiredAt)changed.push([id,{...row,retiredAt:input.fetchedAt}]);if(changed.length){for(const [id,row]of changed)state.categories[id]=row;commit({categories:changed});}
  return {observed:next.size,changed:changed.length};
 }
 function isLeaf(id){if(leafRevision!==state.revision){parentIds=new Set(Object.values(state.categories).filter(c=>!c.retiredAt&&c.parentId).map(c=>c.parentId));leafRevision=state.revision;}return !!definition(id)&&!parentIds.has(String(id));}
 function sourceCategory(row){
  const own=row.raw?.categoryPathIds??[];
  const actual=own.length&&own.every((id,i)=>definition(id)&&(!i||definition(id).parentId===String(own[i-1])))?String(own.at(-1)):null;
  if(actual&&isLeaf(actual))return actual;
  const observed=(row.sourceCategories??row.raw?.sourceCategories??[]).map(c=>String(c.id)).filter(id=>definition(id)&&(!actual||path(id).some(c=>c.id===actual)));
  const deepest=[...new Set(observed)].filter(id=>!observed.some(other=>other!==id&&path(other).some(c=>c.id===id)));
  return deepest.length===1?deepest[0]:actual;
 }
 function odaRows(base=baseReader()){
  if(!base)return [];
  const index=base.index();if(cachedOdaIndex!==index){
  const found=new Map();for(const [productKey,p] of Object.entries(index.products))if(p.store==='ODA_NO'){
   const id=odaProductIdFromUrl(p.sourceUrl);if(!id)continue;const identity='oda:ODA_NO:'+id,previous=found.get(identity);
   // Oda's own catalogue owns placement facts. A price read on a Kassal
   // alias cannot replace its label fingerprint or revive a discontinued item.
   if(previous&&(previous.libraryKey===identity||productKey!==identity&&Date.parse(previous.product.quote.receiptAt)>=Date.parse(p.quote.receiptAt)))continue;
   found.set(identity,{productKey:identity,nativeId:id,libraryKey:productKey,product:p,sourceFingerprint:hash([id,p.name,p.brand,p.ean,p.reviewFacts??{},p.rawPack,p.pack,p.unit,p.metadataFingerprint])});
  }cachedOdaIndex=index;cachedOdaRows=[...found.values()];}
  return cachedOdaRows.filter(row=>row.product.available&&current(row.product.quote?.receiptAt,clock(),priceHorizonDays));
 }
 function placement(row){const p=state.categoryPlacements[row.productKey],category=p&&definition(p.categoryId);return category&&isLeaf(category.id)&&p.sourceFingerprint===row.sourceFingerprint&&p.categoryFingerprint===category.fingerprint?p:null;}
 function dossier(productKey){const row=odaRows().find(r=>r.productKey===productKey),owned=row&&rows().find(r=>r.metadata.source==='oda'&&String(r.metadata.id)===String(row.nativeId));return row?{...structuredClone(row),sourceObservation:structuredClone(owned?.raw??null),placement:structuredClone(placement(row)),authority:'Actual Oda native identity and current product facts. Choose an existing exact Sesum category; do not invent a category or replace the household product.'}:null;}
 function place(input){
  const row=odaRows().find(r=>r.productKey===input.productKey);if(!row||row.sourceFingerprint!==input.sourceFingerprint)throw Error('Oda product changed or no longer has a current price.');
  if(typeof input.evidence!=='string'||input.evidence.trim().length<20||input.evidence.length>6000)throw Error('Concrete product/category evidence required.');
  const category=definition(native(input.categoryId));if(!category||category.fingerprint!==input.categoryFingerprint)throw Error('Read the current native Sesum category.');
  if(!isLeaf(category.id))throw Error('Choose a concrete native leaf category.');
  if(input.reviewed!==true)throw Error('Explicit source-category placement required.');
  const prior=state.categoryPlacements[row.productKey];const record={productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,categoryId:category.id,categoryFingerprint:category.fingerprint,evidence:input.evidence,reviewedAt:new Date(clock()).toISOString()};
  state.categoryPlacements[row.productKey]=record;commit({categoryPlacements:[[row.productKey,record]],categoryPlacementHistory:prior?[prior]:[]});return structuredClone(record);
 }
 const scopedOda=()=>{const scope=odaScope();return odaRows().filter(row=>!scope||scope.has(Number(row.nativeId))||scope.has(String(row.nativeId)));};
 function work(){if(!Object.values(state.categories).some(c=>!c.retiredAt))return [];return scopedOda().filter(row=>!placement(row)).map(row=>({do:'shopping-oda-category',productKey:row.productKey,name:row.product.name,assortmentFingerprint:row.sourceFingerprint,fingerprint:row.sourceFingerprint,reason:'place-unassigned-oda-in-native-sesum-category'}));}
 function linkWatch(input){
  const family=watchFamilies().find(f=>f.familyId===input.familyId);
  if(!family||family.requirementsFingerprint!==input.requirementsFingerprint)throw Error('Read the current household requirements before category association.');
  const bindings=input.categories??[{id:input.categoryId,fingerprint:input.categoryFingerprint}];
  if(!Array.isArray(bindings)||!bindings.length||bindings.length>50)throw Error('Select concrete native subcategories.');
  const categories=bindings.map(binding=>{
   const category=definition(native(binding.id));
   if(!category||!isLeaf(category.id)||category.fingerprint!==binding.fingerprint)throw Error('Read the current native leaf category.');
   return {id:category.id,fingerprint:category.fingerprint};
  });
  if(new Set(categories.map(c=>c.id)).size!==categories.length)throw Error('Duplicate native subcategory.');
  if(input.reviewed!==true||typeof input.evidence!=='string'||input.evidence.trim().length<20||input.evidence.length>6000)throw Error('Concrete household/category association evidence required.');
  const references=input.odaReferences??[];
  if(!Array.isArray(references)||references.length>100)throw Error('Invalid reviewed Oda references.');
  const oda=new Map(odaRows().map(r=>[r.productKey,r]));
  const odaReferences=references.map(ref=>{
   const row=oda.get(ref.productKey),placed=row&&placement(row);
   if(!placed||ref.sourceFingerprint!==row.sourceFingerprint||!categories.some(c=>c.id===placed.categoryId)||typeof ref.evidence!=='string'||ref.evidence.trim().length<20)throw Error('Read the exact household Oda product and its current leaf placement.');
   return {productKey:row.productKey,sourceFingerprint:row.sourceFingerprint,evidence:ref.evidence};
  });
  const prior=state.categoryWatchLinks[family.familyId],record={familyId:family.familyId,requirementsFingerprint:family.requirementsFingerprint,categoryRequirementsFingerprint:family.categoryRequirementsFingerprint,...(categories.length===1?{categoryId:categories[0].id,categoryFingerprint:categories[0].fingerprint}:{}),categories,odaReferences,evidence:input.evidence,reviewedAt:new Date(clock()).toISOString()};
  state.categoryWatchLinks[family.familyId]=record;commit({categoryWatchLinks:[[family.familyId,record]],categoryWatchLinkHistory:prior?[prior]:[]});return structuredClone(record);
 }
 function watchLinks(families){
  const sourceRows=new Map(rows().filter(r=>r.metadata.source==='sesum').map(r=>[String(r.metadata.id),r])),oda=new Map(odaRows().map(r=>[String(r.nativeId),r]));
  return families.map(f=>{
   const explicit=state.categoryWatchLinks[f.familyId],receipts=[],ids=new Set(),odaReferenceIds=[];
   const bindings=explicit?.categories??(explicit?[{id:explicit.categoryId,fingerprint:explicit.categoryFingerprint}]:[]);
   const rulesCurrent=explicit?.categoryRequirementsFingerprint?explicit.categoryRequirementsFingerprint===f.categoryRequirementsFingerprint:explicit?.requirementsFingerprint===f.requirementsFingerprint;
   if(rulesCurrent&&bindings.length&&bindings.every(b=>isLeaf(b.id)&&definition(b.id).fingerprint===b.fingerprint)){
    for(const b of bindings)ids.add(b.id);
    for(const ref of explicit.odaReferences??[]){
     const row=oda.get(ref.productKey.split(':').at(-1));
     if(row&&placement(row)&&row.sourceFingerprint===ref.sourceFingerprint&&ids.has(placement(row).categoryId))odaReferenceIds.push(Number(row.nativeId));
    }
    receipts.push({source:'reviewed-household-category',...structuredClone(explicit)});
   }else{
    for(const product of f.products??[]){
     if(!product.reviewCurrent)continue;
     let id;
     if(product.source==='sesum'){const source=sourceRows.get(String(product.id));if(source)id=sourceCategory(source);}
     else if(product.store==='ODA_NO'){const row=oda.get(String(odaProductIdFromUrl(product.sourceUrl)));if(row)id=placement(row)?.categoryId;}
     if(id&&isLeaf(id)){ids.add(id);receipts.push({productKey:product.productKey,categoryId:id,source:product.source==='sesum'?'native-sesum-category':'reviewed-oda-category'});}
    }
   }
   const categories=[...ids].map(id=>({id,name:definition(id).name,groupId:key(id),path:path(id).map(c=>({id:c.id,name:c.name}))}));
   const single=categories.length===1?categories[0]:null;
   return {watchId:f.familyId,name:f.name,status:categories.length?'linked':'needs-category',categories,odaReferenceIds,categoryIds:[...ids],categoryId:single?.id??null,groupId:single?.groupId??null,categoryName:categories.map(c=>c.name).join(' / '),path:single?.path??[],receipts};
  });
 }
 function reader(){
  const base=baseReader();if(!base)return null;const index=base.index();
  if(cachedRevision!==state.revision||cachedBase!==index){
   const out={familySource:'sesum',groups:{},members:{},products:{},qualityNotes:{}},placements=new Map();
   for(const category of Object.values(state.categories).filter(c=>!c.retiredAt)){const ancestors=path(category.id);out.groups[key(category.id)]={name:category.name,category:ancestors[0]?.name??category.name,unit:null,fingerprint:category.fingerprint,sourceCategory:true,leaf:isLeaf(category.id),nativeCategoryId:category.id,parentId:category.parentId?key(category.parentId):null,path:ancestors.map(c=>c.name),inclusion:'Varer i Sesums kategori «'+category.name+'». Kategorien kan inneholde forskjellige varianter.',exclusions:[],qualityBasis:'Råvare- og næringsfakta vises når de er dokumentert.',comparisonBasis:'Pakningspriser og dokumenterte kg/l/stk-priser. Ulike enheter sammenlignes hver for seg.'};out.members[key(category.id)]=[];}
   for(const row of rows())if(row.metadata.source==='sesum'){const categoryId=sourceCategory(row);if(categoryId)for(const receipt of row.prices)placements.set(`sesum:${receipt.store}:${row.metadata.id}`,{categoryId,row,receipt});}
   for(const row of odaRows(base)){const p=placement(row);if(p)placements.set(row.libraryKey,{categoryId:p.categoryId});}
   for(const [productKey,{categoryId,row,receipt}]of placements){const original=index.products[productKey];if(!original)continue;const product={...original,quote:{...original.quote,reasons:[...original.quote.reasons]},assortmentPriceHorizonDays:priceHorizonDays};
    // The selected master publishes these native package/own-row unit facts.
    // Normalize explicit SI units only; no inferred count, density or ca-weight.
    if(row&&!product.packKnown&&row.metadata.soldByWeight===false){const units={g:['kg',.001],kg:['kg',1],ml:['l',.001],l:['l',1],stk:['stk',1],piece:['stk',1],m:['m',1]},measure=units[String(row.metadata.weightUnit).toLowerCase()];if(measure&&typeof row.metadata.weight==='number'&&row.metadata.weight>0){product.pack=row.metadata.weight*measure[1];product.unit=measure[0];product.packKnown=true;product.packEvidence=`Sesums native faste pakning: ${row.metadata.weight} ${row.metadata.weightUnit}`;}}
    if(row?.metadata.soldByWeight===true&&receipt.grossUnitPrice>0&&receipt.unitPriceEvidence){product.quote.grossPackPrice=null;product.quote.grossUnitPrice=receipt.grossUnitPrice;product.quote.unit=receipt.unit;product.quote.directUnitVerified=true;product.quote.unitPriceEvidence=receipt.unitPriceEvidence;product.unit=receipt.unit;product.quote.reasons=product.quote.reasons.filter(r=>!['unknown-gross-package-price','missing-unit-price-evidence','unknown-direct-unit'].includes(r));}
    out.products[productKey]=product;
    const quote=product.quote,price=current(quote.receiptAt,clock(),priceHorizonDays)&&!quote.reasons.length;
    const amount=product.pack,unitPrice=price&&product.packKnown&&typeof amount==='number'&&amount>0&&quote.grossPackPrice?quote.grossPackPrice/amount:price&&quote.directUnitVerified?quote.grossUnitPrice:null;
    for(const category of path(categoryId))out.members[key(category.id)].push({k:productKey,s:'approved',r:true,u:unitPrice,q:null,n:null,e:'Sesums native kategori eller eksplisitt plassering av en Oda-vare; ingen automatisk husholdningserstatning.'});
   }
   for(const [id,members]of Object.entries(out.members)){const units=new Set(members.map(m=>out.products[m.k].unit??out.products[m.k].quote.unit).filter(Boolean));out.groups[id].unit=units.size===1?[...units][0]:null;if(units.size>1)for(const member of members)member.u=null;}
   cachedRevision=state.revision;cachedBase=index;cached=createIndexReader(out,{horizonDays:priceHorizonDays});
  }return {...cached(clock()),cacheKey:`sesum-taxonomy:${state.revision}:${base.cacheKey??''}`};
 }
 function search(query,{offset=0,limit=20,expectedFingerprint=null}={}){
  if(typeof query!=='string'||query.trim().length<2||query.length>200||!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Use a category query and bounded pagination.');
  const terms=query.toLocaleLowerCase('nb-NO').split(/\s+/u),matches=Object.values(state.categories).filter(c=>!c.retiredAt).map(c=>({...c,groupId:key(c.id),groupFingerprint:c.fingerprint,leaf:isLeaf(c.id),path:path(c.id).map(p=>({id:p.id,name:p.name})),score:terms.reduce((n,t)=>n+(c.name.toLocaleLowerCase('nb-NO').includes(t)?10:0),0)})).filter(c=>c.score).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const fingerprint=hash(matches);if(expectedFingerprint&&expectedFingerprint!==fingerprint)throw Error('Category search changed; read a new result.');const items=matches.slice(offset,offset+limit),hasMore=offset+items.length<matches.length;return {items,total:matches.length,offset,limit,hasMore,nextOffset:hasMore?offset+items.length:null,fingerprint,authority:'Exact native Sesum taxonomy. Same names at different levels keep their different source IDs.'};
 }
 const status=()=>{const families=watchFamilies(),links=watchLinks(families),scope=odaScope(),owned=new Map(rows().filter(r=>r.metadata.source==='oda').map(r=>[String(r.metadata.id),r])),missing=scope?[...scope].filter(id=>!owned.has(String(id))):[];const source=rows().filter(r=>r.metadata.source==='sesum'),oda=odaRows(),scoped=scopedOda(),unplaced=scoped.filter(r=>!placement(r));return {familySource:'sesum',householdFamilies:families.length,householdCategoriesLinked:links.filter(l=>l.status==='linked').length,odaImportMissingProducts:missing.length,odaImportMissingIds:missing.map(String),odaUnavailableProducts:[...owned.values()].filter(r=>scope&&(scope.has(Number(r.metadata.id))||scope.has(String(r.metadata.id)))&&!r.available).length,categories:Object.values(state.categories).filter(c=>!c.retiredAt).length,sesumProducts:source.length,sesumCategorized:source.filter(r=>sourceCategory(r)).length,odaCurrentProducts:oda.length,odaPlacedProducts:oda.filter(r=>placement(r)).length,odaProductsInCurrentScope:scoped.length,remainingProducts:unplaced.length,queuedProducts:unplaced.length,complete:Object.values(state.categories).some(c=>!c.retiredAt)&&!unplaced.length&&!missing.length&&links.every(l=>l.status==='linked')};};
 function referenceRefreshPlan(){
  const scope=odaScope()??new Set();
  const refs=new Set([...scope].map(String));
  const enabled=new Set(watchFamilies().map(f=>f.familyId));
  for(const link of Object.values(state.categoryWatchLinks))if(enabled.has(link.familyId)){
   for(const ref of link.odaReferences??[])refs.add(ref.productKey.split(':').at(-1));
  }
  return rows().filter(r=>r.metadata.source==='oda'&&refs.has(String(r.metadata.id))&&r.raw?.name&&clock()-Date.parse(r.fetchedAt)>=86400000)
    .sort((a,b)=>Date.parse(a.fetchedAt)-Date.parse(b.fetchedAt)).map(r=>({id:Number(r.metadata.id),query:r.raw.name}));
 }
 return {referenceRefreshPlan,receive,place,linkWatch,work,dossier,search,reader,watchLinks,status,definition,isLeaf,sourceCategory};
}
