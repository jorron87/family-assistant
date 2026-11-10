import {sesumSourceFingerprint} from './sesum-prices.mjs';

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const stable=v=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,250}$/.test(v)&&!['__proto__','constructor','prototype'].includes(v);
const clone=v=>structuredClone(v);
const clean=(v,max,required=false)=>{if(v==null&&!required)return null;if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/u.test(v))throw Error('Invalid catalogue text.');const s=v.normalize('NFC').replace(/\s+/gu,' ').trim();if(required&&!s)throw Error('Missing catalogue text.');return s||null;};
const stamp=(v,at)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=at;
export function sesumCatalogueMetadata(p){
 if(!plain(p)||!/^[1-9]\d*$/.test(String(p.id))||!Number.isSafeInteger(Number(p.id)))throw Error('Invalid catalogue product.');
 const id=String(p.id),url=new URL(p.sourceUrl);
 if(url.origin!=='https://www.sesum.no'||url.username||url.password||url.search||url.hash||!new RegExp(`^/produkt/${id}(?:-[^/?#]+)?/?$`).test(url.pathname))throw Error('Invalid catalogue product URL.');
 const ean=p.ean==null?[]:Array.isArray(p.ean)?p.ean:[p.ean],nonEanCodes=p.nonEanCodes??[];
 if(ean.length>30||ean.some(v=>typeof v!=='string'||!/^\d{8,14}$/.test(v))||!Array.isArray(nonEanCodes)||nonEanCodes.length>30||nonEanCodes.some(v=>typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(v)||/^\d{8,14}$/.test(v)))throw Error('Invalid catalogue codes.');
 if(p.weight!=null&&(!Number.isFinite(p.weight)||p.weight<=0||p.weight>1e9)||p.soldByWeight!=null&&typeof p.soldByWeight!=='boolean')throw Error('Invalid catalogue package metadata.');
 return {id,name:clean(p.name,1000,true),brand:clean(p.brand,300),vendor:clean(p.vendor,300),ean:[...new Set(ean)].sort(),nonEanCodes:[...new Set(nonEanCodes)].sort(),weight:p.weight??null,weightUnit:clean(p.weightUnit,30),soldByWeight:p.soldByWeight??null,sourceUrl:url.href};
}
export const sesumCatalogueFingerprint=source=>sesumSourceFingerprint({...sesumCatalogueMetadata(source),store:null});

// These are age receipts, never quotes. In particular an off-scope chain cannot
// become an eligible price through this collection-neutral research registry.
export function sanitizeOwnReceiptSummary(summary,product,at){
 if(summary==null)return null;
 if(!plain(summary)||summary.kind!=='own-product-chain-receipts-v1'||summary.productId!==product.id||summary.sourceUrl!==product.sourceUrl||!Array.isArray(summary.receipts)||summary.receipts.length>100)throw Error('Invalid own-product receipt summary.');
 const receipts=summary.receipts.map(r=>{
  if(!plain(r)||typeof r.storeCode!=='string'||!/^[A-Z][A-Z\d_]{0,63}$/.test(r.storeCode)||!stamp(r.observedAt,at)||typeof r.source!=='string'||!r.source.trim())throw Error('Invalid own-product actual receipt.');
  const storeId=String(r.storeId??'');if(!/^[1-9]\d{0,29}$/.test(storeId))throw Error('Invalid own-product store.');
  return {storeCode:r.storeCode,storeId,source:clean(r.source,100,true),observedAt:r.observedAt};
 });
 return {kind:summary.kind,productId:product.id,sourceUrl:product.sourceUrl,receipts};
}
export function createSesumCatalogue(state,{save=()=>{},now=()=>new Date(),horizonDays=()=>183,knownOwnReceipts=()=>[]}={}){
 state.version??=1;state.products??={};state.revision??=0;if(state.version!==1||!plain(state.products))throw Error('Invalid catalogue registry.');
 const clock=()=>new Date(now()).getTime();
 function prepare(input){
  const at=clock();if(!plain(input)||!Array.isArray(input.familyIds)||input.familyIds.length>10000||input.familyIds.some(id=>!stable(id))||!Array.isArray(input.products)||input.products.length>500||!stamp(input.fetchedAt,at+60000))throw Error('Invalid catalogue observation.');
  const ids=new Set();return input.products.map(p=>{
   const source=sesumCatalogueMetadata(p),sourceKey='sesum-product:'+source.id,sourceFingerprint=sesumCatalogueFingerprint(source),previous=state.products[sourceKey];
   if(ids.has(source.id))throw Error('Duplicate catalogue product in observation.');ids.add(source.id);
   let summary=sanitizeOwnReceiptSummary(p.ownReceiptSummary,source,at);
   if(!summary){const receipts=[...(p.prices??[]),...(p.priceCandidates??[])].filter(r=>plain(r)&&stamp(r.observedAt,at)&&typeof r.source==='string'&&r.source.trim()&&/^[A-Z][A-Z\d_]{0,63}$/.test(r.storeCode??'')&&/^[1-9]\d{0,29}$/.test(String(r.storeId??''))).map(r=>({storeCode:r.storeCode,storeId:String(r.storeId),source:clean(r.source,100,true),observedAt:r.observedAt}));summary=sanitizeOwnReceiptSummary({kind:'own-product-chain-receipts-v1',productId:source.id,sourceUrl:source.sourceUrl,receipts},source,at);}
   if(previous&&Date.parse(input.fetchedAt)<Date.parse(previous.fetchedAt))return {...previous,familyIds:[...new Set([...previous.familyIds,...input.familyIds])]};
   const same=previous?.sourceFingerprint===sourceFingerprint,dates=summary.receipts.map(r=>Date.parse(r.observedAt));if(same&&previous.receiptAt)dates.push(Date.parse(previous.receiptAt));
   // Existing reviewed-chain inputs may legitimately predate storeId capture.
   // Their actual own source date remains age evidence, without inventing a
   // store identifier, summary row or eligible quote.
   for(const r of [...(p.prices??[]),...(p.priceCandidates??[])])if(plain(r)&&stamp(r.observedAt,at)&&typeof r.source==='string'&&r.source.trim()&&/^[A-Z][A-Z\d_]{0,63}$/.test(r.storeCode??''))dates.push(Date.parse(r.observedAt));
   // A legacy filtered catalogue row may have lost its age while the exact
   // unchanged own chain record still retains an actual receipt. This is age
   // evidence only; another variant's receipt cannot park this metadata.
   for(const own of knownOwnReceipts(source))if(plain(own?.source)&&sesumCatalogueFingerprint(own.source)===sourceFingerprint&&stamp(own.price?.observedAt,at)&&typeof own.price.source==='string'&&own.price.source.trim())dates.push(Date.parse(own.price.observedAt));
   const receiptAt=dates.length?new Date(Math.max(...dates)).toISOString():null;
   return {sourceKey,sourceFingerprint,source,familyIds:[...new Set([...(previous?.familyIds??[]),...input.familyIds])],fetchedAt:input.fetchedAt,receiptAt,ageStatus:receiptAt?'known':'unknown',ownReceiptSummary:summary,firstSeen:previous?.firstSeen??input.fetchedAt};
  });
 }
 function apply(rows){let changed=false;for(const row of rows){const old=state.products[row.sourceKey];if(JSON.stringify(old)!==JSON.stringify(row)){if(old&&old.sourceFingerprint!==row.sourceFingerprint)(state.history??=[]).push(clone(old));state.products[row.sourceKey]=row;changed=true;}}if(changed){state.revision++;save();}return {observed:rows.length};}
 const ingest=input=>apply(prepare(input));
 const record=key=>state.products[key]?clone(state.products[key]):null;
 const current=source=>{const row=state.products['sesum-product:'+source.id];return !row||row.sourceFingerprint===sesumCatalogueFingerprint(source);};
 const parked=row=>row.receiptAt!==null&&clock()-Date.parse(row.receiptAt)>Number(horizonDays()??183)*86400000;
 const researchable=source=>{const row=state.products['sesum-product:'+source.id];return current(source)&&(!row||!parked(row));};
 const summaries=()=>Object.values(state.products).map(({source,ownReceiptSummary,...row})=>({...clone(row),name:source.name,kind:'catalogue',parked:parked(row)}));
 const status=()=>{const rows=summaries();return {products:rows.length,unknownAge:rows.filter(row=>row.ageStatus==='unknown').length,parked:rows.filter(row=>row.parked).length};};
 return {prepare,apply,ingest,record,current,researchable,summaries,status,revision:()=>state.revision};
}
