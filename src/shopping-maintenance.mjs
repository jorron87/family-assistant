// Deterministic source work uses the same reviewed identity/pack contracts as
// manual refresh. It never needs a language-model decision or touches a cart.
// External reads do not own the agent lease. Domain writes stay synchronous in
// the archive-owning server and revalidate their reviewed basis after I/O.
import {refreshReviewedMarket} from './shopping-market-refresh.mjs';
export function createShoppingMaintenance({store,oda,kassal,enabled,clock=Date.now}) {
  let running=false,retryAt=0,lastResult=null,lastError=null;
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
    const plans=oda?.status?.().connected===false?[]:store.shopping.odaRefreshPlan({automatic:true}).slice(0,10);
    if(!plans.length){if(marketPlan().length)await runMarket();return;}
    running=true;
    try{
      lastResult=await oda.refreshPrices({watchIds:plans.map(p=>p.watchId),maxPages:5});lastError=null;
      retryAt=clock()+(lastResult.deferred?5:1)*60000;
    }catch{lastError='Automatic reviewed Oda price refresh failed; existing price gaps remain.';retryAt=clock()+30*60000;}
    finally{running=false;}
  }
  return {tick,runMarket,marketPlan,status:()=>({running,retryAt:retryAt?new Date(retryAt).toISOString():null,lastResult,lastError})};
}
