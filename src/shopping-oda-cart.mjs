// The Oda part of the shopping list is the real Oda cart. Family actions change
// it directly, each write is verified once, and an unclear write is never retried.
const FRESH_MS=15000;

export function createOdaCart({oda,shopping,now=Date.now}) {
 let cached=null;
 async function read(force=false) {
  if(!oda.status().connected)return {connected:false,lines:[],messages:[],total:'0.00',url:null};
  if(!force&&cached&&now()-cached.at<FRESH_MS)return cached.data;
  try{
   const data={connected:true,...shopping.cartReview(await oda.cart())};
   cached={at:now(),data};
   return data;
  }catch(error){
   if(cached)return {...cached.data,stale:true};
   throw error;
  }
 }
 async function change(input) {
  try{await oda.changeCart(input);}finally{cached=null;}
  return read(true);
 }
 async function swap(input) {
  try{await oda.swapInCart(input);}finally{cached=null;}
  if(input.watchId)shopping.list({action:'variant',watchId:input.watchId,productId:input.toProductId});
  return read(true);
 }
 /** Adds to the list; an item that belongs at Oda goes straight into the cart. */
 async function list(input) {
  const entry=shopping.list(input);
  if(!['add','route'].includes(input.action)||entry.storeName!=='Oda'||!entry.odaProductId||!oda.status().connected)return entry;
  const limit=shopping.odaLimit(entry.odaProductId),wanted=Math.max(1,Math.round(entry.packs??1)),quantity=Math.min(100,limit??100,wanted);
  try{
   await oda.addToCart({requestId:entry.id,productId:entry.odaProductId,quantity});
   shopping.list({action:'remove',id:entry.id});
   cached=null;
   return {...entry,inCart:true,packs:quantity};
  }catch(error){
   if(/pågår/.test(error.message))return entry;
   return shopping.list({action:'cartError',id:entry.id,message:'Kunne ikke bekrefte at varen kom i kurven. Sjekk kurven.'});
  }
 }
 return {read,change,swap,list};
}
