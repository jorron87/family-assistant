// Retailer identity comes from reviewed product metadata, never a price URL.
export function odaProductIdFromUrl(value){
  if(typeof value!=='string')return null;
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||!['oda.com','www.oda.com'].includes(url.hostname)||url.port||url.username||url.password)return null;
    const match=url.pathname.match(/^\/(?:no\/)?products\/([1-9]\d*)(?:-[^/]+)?\/?$/);
    const id=match?Number(match[1]):null;
    return Number.isSafeInteger(id)&&id>0?id:null;
  }catch{return null;}
}
