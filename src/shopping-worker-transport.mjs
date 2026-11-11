// A transport failure is not a policy decision. Reads may be retried once;
// writes are never replayed when their result could have been lost.
export function createWorkerToolCaller({endpoint,workerId,token,fetchRequest=fetch,timeoutMs=60000}){
 return async function call(name,input={}){
  const readOnly=name==='shopping_context'||name==='shopping_read',attempts=readOnly?2:1;
  let diagnostic;
  for(let attempt=0;attempt<attempts;attempt++){
   try{
    const response=await fetchRequest(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Worker':token},body:JSON.stringify({workerId,call:name,input}),signal:AbortSignal.timeout(timeoutMs)});
    const data=await response.json();
    return {content:[{type:'text',text:JSON.stringify(data)}],...(!response.ok?{isError:true}:{})};
   }catch(error){diagnostic={type:String(error?.name??'Error').replace(/[^a-zA-Z0-9_]/g,'').slice(0,60),...(typeof error?.cause?.code==='string'?{code:error.cause.code.replace(/[^a-zA-Z0-9_]/g,'').slice(0,60)}:{})};}
  }
  const result={error:readOnly?'coordinator-read-unavailable':'coordinator-result-unconfirmed',operation:name,attempts,diagnostic,...(!readOnly?{outcome:'unconfirmed',...(input.proposalId?{proposalId:input.proposalId}:{})}:{}),next:readOnly?'Preserve your checkpoint and defer this job because the coordinator read is unavailable. Do not propose without a readable current context. Report an availability error; genuine explicit tool policy stops still require safety-stop.':'Do not assume success or retry this action, including under a new proposal ID. Preserve its exact identity and defer for verification of durable coordinator/domain receipts. Report the unconfirmed transport result; genuine explicit tool policy stops still require safety-stop.'};
  return {isError:true,content:[{type:'text',text:JSON.stringify(result)}]};
 };
}
