// Give timers, incoming heartbeats and family requests a turn between expensive
// synchronous worker reads. Promise microtasks alone can starve the event loop.
export function createShoppingWorkerScheduler({defer=setImmediate,maxQueued=256}={}) {
  const queue=[];let busy=false;
  function pump(){
    if(busy||!queue.length)return;busy=true;
    defer(async()=>{
      const job=queue.shift();
      try{if(!job.isConnected())throw Error('Worker requester disconnected before execution; nothing was applied.');job.resolve(await job.execute());}
      catch(error){job.reject(error);}
      finally{busy=false;pump();}
    });
  }
  function run({execute,heartbeat=false,isConnected=()=>true}){
    if(heartbeat)return Promise.resolve().then(execute);
    if(queue.length>=maxQueued)return Promise.reject(Error('Worker request queue is busy; no operation was applied.'));
    return new Promise((resolve,reject)=>{queue.push({execute,isConnected,resolve,reject});pump();});
  }
  return {run};
}
