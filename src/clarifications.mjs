import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(v);
const text=(v,max,min=1)=>{if(typeof v!=='string'||v.trim().length<min||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v))throw Error('Oppgi en kort, konkret avklaring.');return v.normalize('NFC').trim();};
const fields=(v,allowed)=>{if(!plain(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw Error('Ugyldige felt i avklaringen.');};
export const SHOPPING_CLARIFICATION_KEYS=Object.freeze(['variant','brands','requirements','annual-need','stock','storage','other']);
export function createClarifications(state,{save=()=>{},now=()=>new Date(),members=()=>[],subjectExists=()=>true}={}){
 state.questions??={};
 const stamp=()=>new Date(now()).toISOString(),time=()=>new Date(now()).getTime();
 const get=id=>{const q=Object.hasOwn(state.questions,id)?state.questions[id]:null;if(!q)throw Error('Fant ikke avklaringen.');return q;};
 const fingerprint=q=>hash([q.questionFingerprint,q.answer?.fingerprint??null,q.review?.status??null,q.withdrawn?.at??null]);
 const status=q=>q.withdrawn?'withdrawn':!q.answer?'open':q.review?.status==='applied'?'resolved':q.review?.status==='blocked'?'blocked':'answered';
 const publicRow=q=>({id:q.id,fingerprint:fingerprint(q),question:q.question,reason:q.reason,subjectLabel:q.subject.label,options:structuredClone(q.options),required:q.required,status:status(q),createdAt:q.createdAt,answer:q.answer?{optionId:q.answer.optionId,label:q.options.find(o=>o.id===q.answer.optionId)?.label??'',text:q.answer.text,senderName:q.answer.senderName,submittedAt:q.answer.submittedAt}:null,message:q.review?.message??null});
 function request(input){
  fields(input,['key','subject','question','reason','options','required','contextFingerprint','evidence','replace','expectedFingerprint']);
  fields(input.subject,['type','id','label']);if(!id(input.key)||!id(input.subject.id)||!['shopping-family','shopping-product','family'].includes(input.subject.type))throw Error('Avklaringen krever et stabilt spørsmål og en konkret familie eller vare.');
  if(input.subject.type==='shopping-family'&&!SHOPPING_CLARIFICATION_KEYS.includes(input.key))throw Error('Bruk et felles avklaringstema for varefamilien, ikke en nøkkel per SKU.');
  if(!subjectExists(input.subject))throw Error('Avklaringen må gjelde en eksisterende varefamilie.');
  const subject={type:input.subject.type,id:input.subject.id,label:text(input.subject.label,160)},key=input.key,qid=hash([subject.type,subject.id,key]).slice(0,24),previous=state.questions[qid];
  // Multiple product workers share one household decision. They cannot silently
  // reword it, replace options or erase an answer by sending another upsert.
  if(previous&&input.replace!==true)return {...publicRow(previous),existing:true};
  if(previous&&input.expectedFingerprint!==fingerprint(previous))throw Error('Avklaringen er endret. Les gjeldende spørsmål før erstatning.');
  if(!Array.isArray(input.options)||input.options.length<2||input.options.length>6)throw Error('Oppgi mellom to og seks svaralternativer.');
  const seen=new Set(),options=input.options.map(o=>{fields(o,['id','label','description','allowText']);if(!id(o.id)||seen.has(o.id))throw Error('Svaralternativene må ha ulike stabile ID-er.');seen.add(o.id);return {id:o.id,label:text(o.label,160),description:o.description==null?null:text(o.description,350),allowText:o.allowText===true};});
  const body={key,subject,question:text(input.question,350),reason:text(input.reason,1200,10),options,required:input.required!==false,contextFingerprint:input.contextFingerprint==null?null:text(input.contextFingerprint,250),evidence:input.evidence==null?null:text(input.evidence,6000,10)};
  if(previous?.questionFingerprint===hash(body)&&!previous.withdrawn)return {...publicRow(previous),existing:true};
  const q={...body,id:qid,questionFingerprint:hash(body),createdAt:previous?.createdAt??stamp(),updatedAt:stamp(),answer:null,review:null,history:previous?[...(previous.history??[]),structuredClone({...previous,history:undefined})]:[]};
  state.questions[qid]=q;save();return publicRow(q);
 }
 function answer(input,{senderMemberId}={}){
  fields(input,['id','expectedFingerprint','optionId','text']);const q=get(input.id),sender=members().find(m=>m.id===senderMemberId&&m.role==='parent');if(!sender)throw Error('En forelder må velges som avsender av svaret.');
  if(q.withdrawn)throw Error('Avklaringen er allerede løst uten et nytt svar. Oppdater listen.');
  const option=q.options.find(o=>o.id===input.optionId);if(!option)throw Error('Velg et av de gjeldende svaralternativene.');
  const note=input.text==null?'':text(input.text,1200,0);if(note&&!option.allowText)throw Error('Dette svaralternativet har ikke fritekst.');
  if(q.answer?.optionId===option.id&&q.answer.text===note&&q.answer.senderMemberId===sender.id&&[q.answer.requestFingerprint,fingerprint(q)].includes(input.expectedFingerprint))return {...publicRow(q),replayed:true};
  if(input.expectedFingerprint!==fingerprint(q))throw Error('Spørsmålet eller svaret er endret. Oppdater avklaringen og velg på nytt.');
  const prior=q.answer,version=(prior?.version??0)+1;if(prior)(q.answerHistory??=[]).push({answer:structuredClone(prior),review:structuredClone(q.review)});
  const a={version,questionFingerprint:q.questionFingerprint,optionId:option.id,text:note,senderMemberId:sender.id,senderName:sender.name,submittedAt:stamp(),requestFingerprint:input.expectedFingerprint};a.fingerprint=hash(a);q.answer=a;q.review=null;q.dispatch=null;q.updatedAt=stamp();save();return publicRow(q);
 }
 const pending=()=>Object.values(state.questions).filter(q=>!q.withdrawn&&q.answer&&q.review?.status!=='applied');
 const ready=()=>pending().filter(q=>(!q.review?.retryAt||Date.parse(q.review.retryAt)<=time())&&(!q.dispatch?.retryAt||Date.parse(q.dispatch.retryAt)<=time())).map(q=>({id:q.id,answerFingerprint:q.answer.fingerprint,subject:structuredClone(q.subject),question:q.question,answer:structuredClone(q.answer)}));
 function review(input){
  fields(input,['id','answerFingerprint','status','evidence','message','retryAt']);const q=get(input.id);if(q.withdrawn||!q.answer||input.answerFingerprint!==q.answer.fingerprint)throw Error('Svaret er endret. Les gjeldende avklaring før behandling.');
  if(!['applied','blocked'].includes(input.status))throw Error('Velg applied eller blocked for svarets oppfølging.');
  const retryAt=input.status==='blocked'?input.retryAt:null;if(input.status==='blocked'&&(!Number.isFinite(Date.parse(retryAt))||Date.parse(retryAt)<=time()||Date.parse(retryAt)>time()+7*86400000))throw Error('En blokkert oppfølging trenger en fremtidig frist innen sju dager.');
  q.review={status:input.status,answerFingerprint:input.answerFingerprint,evidence:text(input.evidence,6000,20),message:input.message==null?null:text(input.message,500),retryAt,reviewedAt:stamp()};q.dispatch=null;save();return publicRow(q);
 }
 function attempt(items){for(const item of items){const q=get(item.id);if(q.answer?.fingerprint===item.answerFingerprint&&q.review?.status!=='applied')q.dispatch={attemptedAt:stamp(),retryAt:new Date(time()+5*60000).toISOString()};}save();}
 function finish(items){for(const item of items){const q=get(item.id);if(q.answer?.fingerprint===item.answerFingerprint&&q.review?.status!=='applied')q.dispatch={...q.dispatch,retryAt:new Date(time()+5*60000).toISOString()};}save();}
 function list({includeResolved=false,offset=0,limit=100,expectedFingerprint=null}={}){if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Ugyldig side for avklaringer.');const all=Object.values(state.questions).filter(q=>includeResolved||!['resolved','withdrawn'].includes(status(q))).sort((a,b)=>Number(!!a.answer)-Number(!!b.answer)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)),pageFingerprint=hash(all.map(q=>[q.id,fingerprint(q)])),items=all.slice(offset,offset+limit).map(publicRow),nextOffset=offset+items.length<all.length?offset+items.length:null;if(expectedFingerprint!==null&&expectedFingerprint!==pageFingerprint)throw Error('Avklaringene er endret. Oppdater listen fra starten.');return {fingerprint:pageFingerprint,items,total:all.length,nextOffset,hasMore:nextOffset!==null};}
 function summary(){const waiting=Object.values(state.questions).filter(q=>!q.withdrawn&&!q.answer),answers=pending();return {complete:!waiting.some(q=>q.required)&&!answers.length,awaitingAnswer:waiting.length,requiredAwaitingAnswer:waiting.filter(q=>q.required).length,pendingAnswers:answers.length,readyAnswers:ready().length,blockedAnswers:answers.filter(q=>q.review?.status==='blocked').length};}
 function close(input){fields(input,['id','expectedFingerprint','evidence']);const q=get(input.id);if(input.expectedFingerprint!==fingerprint(q))throw Error('Avklaringen er endret. Les den før lukking.');q.withdrawn={at:stamp(),evidence:text(input.evidence,6000,20)};q.dispatch=null;save();return publicRow(q);}
 return {request,answer,review,close,ready,attempt,finish,list,summary,detail:id=>structuredClone(get(id)),familyRow:id=>publicRow(get(id))};
}
