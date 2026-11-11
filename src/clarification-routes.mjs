export function familyClarifications(store,params=new URLSearchParams()){
 const page=store.clarifications.list({includeResolved:params.get('includeResolved')==='1',offset:Number(params.get('offset')??0),limit:100,expectedFingerprint:params.get('expectedFingerprint')});
 return {...page,summary:store.clarifications.summary(),members:store.profile().members.filter(m=>m.role==='parent').map(({id,name})=>({id,name}))};
}
export function answerClarification(store,input){const {senderMemberId,...answer}=input;return store.clarifications.answer(answer,{senderMemberId});}
export function clarificationHandler({store,send,json,onQueued=()=>{}}){
 return async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;if(!path.startsWith('/api/clarifications'))return false;
  const reply=(code,value)=>{send(res,code,value);return true;};
  try{
   if(req.method==='GET'&&path==='/api/clarifications')return reply(200,familyClarifications(store,url.searchParams));
   if(req.method==='GET'&&path==='/api/clarifications/agent')return reply(200,{summary:store.clarifications.summary(),work:store.clarifications.ready()});
   const detail=/^\/api\/clarifications\/agent\/([a-f0-9]{24})$/.exec(path);if(req.method==='GET'&&detail)return reply(200,store.clarifications.detail(detail[1]));
   if(req.method!=='POST')return reply(405,{error:'Ukjent avklaringshandling.'});
   if(req.headers['x-family-request']!=='1'||req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return reply(403,{error:'Ugyldig avsender.'});
   const input=await json(req);
   if(path==='/api/clarifications/request')return reply(200,store.clarifications.request(input));
   if(path==='/api/clarifications/review')return reply(200,store.clarifications.review(input));
   if(path==='/api/clarifications/close')return reply(200,store.clarifications.close(input));
   if(path==='/api/clarifications/answer'){const result=answerClarification(store,input);reply(200,result);if(!result.replayed)queueMicrotask(onQueued);return true;}
   return reply(405,{error:'Ukjent avklaringshandling.'});
  }catch(error){return reply(422,{error:error.message});}
 };
}
