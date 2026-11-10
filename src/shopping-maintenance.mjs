// Deterministic source work uses the same reviewed identity/pack contracts as
// manual refresh. It never needs a language-model decision or touches a cart.
import {refreshReviewedMarket} from './shopping-market-refresh.mjs';
export function createShoppingMaintenance({store,oda,kassal,enabled,clock=Date.now}) {
  let running=false,retryAt=0,lastResult=null,lastError=null;
  const marketPlan=()=>kassal?.status().configured?store.shopping.marketRefreshPlan():[];
  async function runMarket(watchIds=marketPlan().slice(0,3)){
    if(running||store.snapshot().runLease)return {deferred:true,reason:'busy'};
    const allowed=new Set(marketPlan());
    if(!Array.isArray(watchIds)||watchIds.length>10||watchIds.some(id=>!allowed.has(id)))throw Error('Select at most ten currently reviewable market families.');
    const lease=store.beginRun();if(!lease.acquired)return {deferred:true,reason:'busy'};
    running=true;
    try{const results=[];for(const watchId of new Set(watchIds)){if(store.snapshot().runLease?.token!==lease.lease.token)throw Error('Market refresh lease changed.');store.renewRun?.(lease.lease.token);results.push(await refreshReviewedMarket({shopping:store.shopping,kassal,watchId}));}lastResult={kind:'market',results};lastError=null;return lastResult;}
    catch(error){lastError='Reviewed market refresh failed; unresolved work remains.';retryAt=clock()+30*60000;throw error;}
    finally{running=false;if(store.snapshot().runLease?.token===lease.lease.token)store.endRun(lease.lease.token);}
  }
  async function tick(){
    if(running||!enabled()||clock()<retryAt||store.snapshot().runLease||store.phone.list().some(x=>['queued','processing'].includes(x.status))||store.calendarActions().length||store.shopping.stockIntake?.work().some(x=>!x.retryAt||Date.parse(x.retryAt)<=clock()))return;
    const plans=oda?.status?.().connected===false?[]:store.shopping.odaRefreshPlan({automatic:true}).slice(0,10);
    if(!plans.length){if(marketPlan().length)await runMarket();return;}
    const lease=store.beginRun();if(!lease.acquired)return;
    running=true;
    try{
      lastResult=await oda.refreshPrices({watchIds:plans.map(p=>p.watchId),maxPages:5});lastError=null;
      retryAt=clock()+(lastResult.deferred?5:1)*60000;
    }catch{lastError='Automatic reviewed Oda price refresh failed; existing price gaps remain.';retryAt=clock()+30*60000;}
    finally{running=false;if(store.snapshot().runLease?.token===lease.lease.token)store.endRun(lease.lease.token);}
  }
  return {tick,runMarket,marketPlan,status:()=>({running,retryAt:retryAt?new Date(retryAt).toISOString():null,lastResult,lastError})};
}
