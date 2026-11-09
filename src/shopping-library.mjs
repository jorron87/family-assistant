import {statSync} from 'node:fs';
import {readProductLibrary} from './product-library.mjs';

const text=value=>String(value??'').normalize('NFC').replace(/\s+/g,' ').trim();
// A general library class never approves a family watch. Only an already
// approved native watch/SKU with identical reviewed metadata may reuse a price.
export function libraryPriceProvider(file,{now=()=>new Date()}={}) {
 let cache=null,stamp=null,loadedAt=0;
 return entries=>{
  try{
   const info=statSync(file),next=`${info.mtimeMs}:${info.size}`,at=now().getTime();
   if(!cache||next!==stamp||at-loadedAt>=60000){cache=readProductLibrary(file,{now:now()});stamp=next;loadedAt=at;}
   const result=[];
   for(const e of entries){
    if(e.status!=='approved')continue;
    const q=cache.productQuote(`kassal:${e.store}:${e.id}`),p=q?.product;
    const direct=q?.price.directUnitVerified&&q.price.unit===e.unit&&p.canonicalPackAmount===null;
    if(!q?.reviewCurrent||!direct&&(p.canonicalPackAmount!==e.packAmount||p.unit!==e.unit))continue;
    if(['name','ean','brand','ingredients','description','sourceUrl'].some(k=>text(p[k])!==text(e[k])))continue;
    if(p.rawPack&&(p.rawPack.weight!==e.weight||text(p.rawPack.weightUnit)!==text(e.weightUnit)))continue;
    result.push({watchId:e.watchId,store:e.store,id:e.id,canonicalPackAmount:p.canonicalPackAmount,...q.price});
   }
   return {status:'ready',quotes:result};
  }catch(error){cache=null;return {status:error.code==='ENOENT'?'missing':'unavailable',quotes:[]};}
 };
}
