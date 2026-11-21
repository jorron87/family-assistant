// Deterministic source work uses the same reviewed identity/pack contracts as
// manual refresh. It never needs a language-model decision or touches a cart.
// External reads do not own the agent lease. Domain writes stay synchronous in
// the archive-owning server and revalidate their reviewed basis after I/O.
import {refreshReviewedMarket} from './shopping-market-refresh.mjs';
export function createShoppingMaintenance({store,oda,kassal,enabled,clock=Date.now}) {
  let running=false,retryAt=0,lastResult=null,lastError=null;
  const referenceRetries=new Map();
  const marketPlan=()=>kassal?.status().configured?store.shopping.marketRefreshPlan():[];
  async function runMarket(watchIds=marketPlan().slice(0,3)){
    if(running)return {deferred:true,reason:'busy'};
    const allowed=new Set(marketPlan());
    if(!Array.isArray(watchIds)||watchIds.length>10||watchIds.some(id=>!allowed.has(id)))throw Error('Select at most ten currently reviewable market families.');
    running=true;
    try{const results=[];for(const watchId of new Set(watchIds)){results.push(await refreshReviewedMarket({shopping:store.shopping,kassal,watchId}));}lastResult={kind:'market',results};lastError=null;return lastResult;}
    catch(error){lastError='Reviewed market refresh failed; unresolved work remains.';retryAt=clock()+30*60000;throw error;}
    finally{running=false;}
  }
  async function tick(){
    if(running||!enabled()||clock()<retryAt||store.phone.list().some(x=>['queued','processing'].includes(x.status))||store.calendarActions().length||store.shopping.stockIntake?.work().some(x=>!x.retryAt||Date.parse(x.retryAt)<=clock()))return;
    const shopping=store.shopping;
    if(shopping.assortment?.config.reviewedPriceRefreshEnabled&&oda?.status?.().connected&&lastResult?.kind!=='oda-references'){
      const due=shopping.taxonomy?.referenceRefreshPlan().filter(p=>(referenceRetries.get(p.id)??0)<=clock()).slice(0,10)??[];
      if(due.length){
        running=true;
        try{
          let pending=due;
          const found=new Set();
          for(let page=1;page<=5&&pending.length;page++){
            const response=await oda.readCatalog({queries:[...new Set(pending.map(p=>p.query))],page});
            const more=new Set(),products=new Map();
            for(const row of response.result){
              if(row.hasMore)more.add(row.query);
              for(const product of row.products)if(pending.some(p=>p.id===product.id)){products.set(product.id,product);found.add(product.id);}
            }
            if(products.size)shopping.assortment.receiveOda({products:[...products.values()],observedAt:response.observedAt});
            pending=pending.filter(p=>!found.has(p.id)&&more.has(p.query));
          }
          for(const p of due)if(!found.has(p.id))referenceRetries.set(p.id,clock()+86400000);
          lastResult={kind:'oda-references',requested:due.length,found:found.size};lastError=null;
        }catch{lastError='Oda reference refresh failed.';retryAt=clock()+30*60000;}
        finally{running=false;}
        return;
      }
    }
    const plans=oda?.status?.().connected===false?[]:store.shopping.odaRefreshPlan({automatic:true}).slice(0,10);
    if(!plans.length||lastResult?.kind==='oda'){const ids=marketPlan();if(ids.length){await runMarket(ids.slice(0,3));return;}if(!plans.length){lastResult=null;return;}}
    running=true;
    try{
      lastResult={kind:'oda',...await oda.refreshPrices({watchIds:plans.map(p=>p.watchId),maxPages:5})};lastError=null;
      retryAt=clock()+(lastResult.deferred?5:1)*60000;
    }catch{lastError='Automatic reviewed Oda price refresh failed; existing price gaps remain.';retryAt=clock()+30*60000;}
    finally{running=false;}
  }
  return {tick,runMarket,marketPlan,status:()=>({running,retryAt:retryAt?new Date(retryAt).toISOString():null,lastResult,lastError})};
}
