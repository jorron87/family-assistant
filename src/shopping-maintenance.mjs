// Deterministic source work uses the same reviewed identity/pack contracts as
// manual refresh. It never needs a language-model decision or touches a cart.
export function createShoppingMaintenance({store,oda,enabled,clock=Date.now}) {
  let running=false,retryAt=0,lastResult=null,lastError=null;
  async function tick(){
    if(running||!enabled()||clock()<retryAt||store.snapshot().runLease||store.phone.list().some(x=>['queued','processing'].includes(x.status))||store.calendarActions().length||store.shopping.stockIntake?.work().some(x=>!x.retryAt||Date.parse(x.retryAt)<=clock()))return;
    const plans=store.shopping.odaRefreshPlan({automatic:true}).slice(0,10);if(!plans.length)return;
    const lease=store.beginRun();if(!lease.acquired)return;
    running=true;
    try{
      lastResult=await oda.refreshPrices({watchIds:plans.map(p=>p.watchId),maxPages:5});lastError=null;
      retryAt=clock()+(lastResult.deferred?5:1)*60000;
    }catch{lastError='Automatic reviewed Oda price refresh failed; existing price gaps remain.';retryAt=clock()+30*60000;}
    finally{running=false;if(store.snapshot().runLease?.token===lease.lease.token)store.endRun(lease.lease.token);}
  }
  return {tick,status:()=>({running,retryAt:retryAt?new Date(retryAt).toISOString():null,lastResult,lastError})};
}
