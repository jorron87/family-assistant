// Routine calibration refreshes only existing reviewed native identities. The
// catalogue observes fresh source metadata first; changed metadata opens review
// and prevents this job from carrying an old approval into a new variant.
export async function refreshReviewedMarket({shopping,kassal,watchId}) {
  const entries=shopping.catalogEntries(watchId);
  if(!entries.length||entries.some(e=>e.status==='pending'))return {watchId,deferred:true,reason:'product-review-required'};
  const approved=entries.filter(e=>e.status==='approved');
  if(!approved.length)return {watchId,deferred:true,reason:'no-reviewed-products'};
  const products=[];
  for(const expected of approved){
    const response=await kassal.product({id:Number(expected.id)}),p=response.data;
    if(!p||String(p.id)!==expected.id||p.store?.code!==expected.store)throw Error('Market source identity changed.');
    const current=typeof p.current_price==='object'?p.current_price?.price:p.current_price;
    const receiptAt=(typeof p.current_price==='object'?p.current_price?.date:null)??p.price_history?.[0]?.date;
    shopping.catalogObserve({watchId,query:'Automatic reviewed market refresh',products:[{id:p.id,store:p.store.code,name:p.name,ean:p.ean??null,brand:p.brand??null,ingredients:p.ingredients??null,description:p.description??null,weight:p.weight??null,weightUnit:p.weight_unit??null,sourceUrl:p.url??null,categories:p.category??[],image:p.image,...(Number(current)>0&&receiptAt?{currentPrice:Number(current),lastChecked:receiptAt}:{})}]});
    const checked=shopping.catalogEntries(watchId).find(e=>e.id===expected.id&&e.store===expected.store);
    if(checked?.status!=='approved'||checked.fingerprint!==expected.fingerprint)return {watchId,deferred:true,reason:'source-metadata-changed'};
    products.push({id:checked.id,ean:checked.ean,name:checked.name,store:checked.store,unit:checked.unit,packAmount:checked.packAmount,reviewed:true,equivalenceEvidence:checked.equivalenceEvidence,currentPrice:Number(current)>0?Number(current):null,lastChecked:receiptAt??null,history:Array.isArray(p.price_history)?p.price_history:[]});
  }
  // Recheck every approval after asynchronous I/O, including reviews changed by
  // a manual action during the fetch. market() applies scoped exclusions too.
  const latest=shopping.catalogEntries(watchId);
  if(approved.some(e=>!latest.some(p=>p.id===e.id&&p.store===e.store&&p.status==='approved'&&p.fingerprint===e.fingerprint)))return {watchId,deferred:true,reason:'review-changed-during-refresh'};
  return {watchId,deferred:false,products:products.length,calibration:shopping.market({watchId,windowDays:90,products})};
}
