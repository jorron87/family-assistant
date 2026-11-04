import {installFamily} from './phone-family.js';
const $=selector=>document.querySelector(selector);
const node=(tag,text)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;};
let files=[],draft=null,busy=false,paired=false,polling=false,toastTimer,receiptSignature='';
let senderMemberId=null;
const sender=$('#sender');
sender.onchange=async()=>{const previous=senderMemberId;sender.disabled=true;$('#submit').disabled=true;try{const result=await post('/identity',{memberId:sender.value});senderMemberId=result.memberId;}catch(error){sender.value=previous??'';status(error.message,true);}finally{sender.disabled=busy||!!draft;$('#submit').disabled=busy;}};
const status=(text,error=false)=>{clearTimeout(toastTimer);$('#status').textContent=text;$('#status').hidden=!text;$('#status').classList.toggle('error',error);if(text&&!error&&!busy)toastTimer=setTimeout(()=>{$('#status').hidden=true;},4500);};
async function api(path,options={}) {
 const response=await fetch('/send/api'+path,{...options,headers:{'X-Family-Request':'1',...options.headers}});
 const result=await response.json();if(!response.ok){const error=Error(result.error||'Kunne ikke kontakte familien.');error.status=response.status;throw error;}return result;
}
const post=(path,data)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
const family=installFamily({api,post,status});
const logout=$('#logout');
const cancelUpload=node('button','Avbryt opplasting');cancelUpload.type='button';cancelUpload.hidden=true;cancelUpload.className='cancel-upload';$('#submit').after(cancelUpload);
cancelUpload.onclick=async()=>{if(busy||!draft)return;try {await post(`/inbox/${draft.id}/cancel`,{});draft=null;for(const input of $('#send-form').querySelectorAll('input,textarea,select'))input.disabled=false;showFiles();status('Opplasting avbrutt.');}catch(error){status(error.message,true);}};
logout.onclick=async()=>{if(busy||draft)return;try{await post('/logout',{});status('Telefonen er koblet fra.');await load();}catch(error){status(error.message,true);}};
function showFiles() {
 sender.disabled=busy||!!draft;
 cancelUpload.hidden=!draft||busy;logout.disabled=busy||!!draft;
 const holder=$('#previews');for(const image of holder.querySelectorAll('img'))URL.revokeObjectURL(image.src);holder.replaceChildren();
 for(const [index,file] of files.entries()) {
  const row=node('div');row.className='file-row';
  if(file.type.startsWith('image/')&&!/heic|heif/.test(file.type)){const image=node('img');image.src=URL.createObjectURL(file);image.alt='Forhåndsvisning';row.append(image);}
  row.append(node('span',`${file.name} · ${(file.size/1024/1024).toFixed(1)} MB`));
  const remove=node('button','Fjern');remove.type='button';remove.disabled=busy||!!draft;remove.onclick=()=>{files.splice(index,1);showFiles();};row.append(remove);holder.append(row);
 }
}
for(const selector of ['#camera','#files']) $(selector).onchange=event=>{
 if(busy||draft){event.target.value='';return;}
 const selected=[...event.target.files];
 if(selected.some(file=>file.size>20*1024*1024)||files.length+selected.length>12||[...files,...selected].reduce((n,f)=>n+f.size,0)>100*1024*1024){status('Maks 12 filer, 20 MB per fil og 100 MB totalt.',true);event.target.value='';return;}
 files.push(...selected);showFiles();event.target.value='';status('');
};
function receipts(result){
 if(!sender.options.length||sender.options.length===1)for(const member of result.members){const option=node('option',member.name);option.value=member.id;sender.append(option);}
 if(!busy&&!draft&&document.activeElement!==sender){senderMemberId=result.senderMemberId;sender.value=senderMemberId??'';}
 if(!$('#members').children.length)for(const member of result.members){const label=node('label'),check=node('input');check.type='checkbox';check.value=member.id;label.append(check,document.createTextNode(member.name));$('#members').append(label);}
 const signature=JSON.stringify(result.items);if(signature===receiptSignature)return;receiptSignature=signature;
 const holder=$('#receipt-list'),open=new Set([...holder.querySelectorAll('details[open]')].map(x=>x.dataset.id));holder.replaceChildren();
 $('#receipt-count').textContent=result.items.length?String(result.items.length):'';
 const labels={uploading:'Ikke sendt ennå',queued:'Mottatt – behandles snart',processing:'Leses nå',done:'Lagt inn',blocked:'Trenger svar fra deg',cancelled:'Avbrutt'};
 for(const item of result.items.slice(0,10)) {
  const card=node('details');card.className='receipt';card.dataset.id=item.id;card.open=open.has(item.id);
  const summary=node('summary',item.title),state=node('span',labels[item.status]??item.status);state.className='receipt-status '+item.status;summary.append(state);card.append(summary);
  card.append(node('p',new Intl.DateTimeFormat('nb-NO',{dateStyle:'medium',timeStyle:'short'}).format(new Date(item.createdAt))));if(item.note)card.append(node('p',item.note,item.status==='blocked'?'receipt-question':undefined));
  for(const event of item.events){const open=node('button','Lagt inn: '+event.title.replace(/^s*[s*foreløpigs*]s*/i,'')+' ›');open.type='button';open.className='receipt-event';open.onclick=()=>family.openEvent(event.id);card.append(open);}
  holder.append(card);
 }
 if(!result.items.length)holder.append(node('p','Innsendingene dine vises her.'));
}
function disconnect(){paired=false;for(const id of ['startup','family','capture','receipts','mobile-nav','logout'])$('#'+id).hidden=true;$('#pair').hidden=false;$('#mobile-event').close();}
const weatherLabels={clear:'Klart',partly:'Delvis skyet',cloudy:'Skyet',fog:'Tåke',rain:'Regn',sleet:'Sludd',snow:'Snø',thunder:'Torden'};
let weatherAt=0;
async function weather(){
 if(Date.now()-weatherAt<600000)return;weatherAt=Date.now();
 try{const value=await api('/weather'),line=$('#weather-line');if(value.unavailable||!value.now){line.hidden=true;return;}
  const parts=value.alert?['☂ '+value.alert.text]:[`${Math.round(value.now.temp)}° · ${weatherLabels[value.now.kind]??''}`,value.nowcast&&value.nowcast.state!=='dry'?value.nowcast.text:''];
  line.textContent=parts.filter(Boolean).join(' · ');line.classList.toggle('alert',!!value.alert);line.hidden=false;}catch{}
}
async function load() {
 if(polling)return;polling=true;
 try {
  const [inbox,data]=await Promise.all([api('/inbox'),api('/family')]);const first=!paired;
  $('#pair').hidden=true;$('#mobile-nav').hidden=false;$('#receipts').hidden=false;logout.hidden=false;
  receipts(inbox);family.update(data);weather();if(first)family.setView('home');paired=true;$('#startup').hidden=true;
 } catch(error) {if(error.status===401)disconnect();else {status('Kunne ikke oppdatere. Prøver igjen.',true);if(!paired){$('#startup').hidden=false;$('#startup-message').textContent='Kunne ikke hente familien. Prøver igjen.';}}}
 finally{polling=false;}
}
$('#pair-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await post('/pair',{code:$('#pair-code').value.trim(),name:$('#device-name').value});$('#pair-code').value='';status('Knyttet til familien ✓');await load();}catch(error){status(error.message,true);}finally{button.disabled=false;}};
$('#send-form').onsubmit=async event=>{
 event.preventDefault();if(busy)return;if(!senderMemberId){status('Velg hvem som sender.',true);return;}if(!files.length&&!$('#message').value.trim()){status('Ta et bilde, velg en fil eller skriv en beskjed.',true);return;}busy=true;$('#submit').disabled=true;
 try {
  const clientId=draft?.clientId??(crypto.randomUUID?.()??'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=crypto.getRandomValues(new Uint8Array(1))[0]&15;return(c==='x'?r:(r&3)|8).toString(16);}));
  if(!draft){const item=await post('/inbox',{clientId,fileCount:files.length,title:$('#title').value,text:$('#message').value,members:[...document.querySelectorAll('#members input:checked')].map(input=>input.value)});draft={id:item.id,clientId};}
  for(const input of $('#send-form').querySelectorAll('input,textarea,select'))input.disabled=true;
  showFiles();
  for(const [index,file] of files.entries()){status(`Laster opp ${index+1} av ${files.length} …`);await api(`/inbox/${draft.id}/files/${index}`,{method:'POST',headers:{'X-File-Name':encodeURIComponent(file.name),'Content-Type':file.type||'application/octet-stream'},body:file});}
  await post(`/inbox/${draft.id}/submit`,{});draft=null;files=[];for(const input of $('#send-form').querySelectorAll('input,textarea,select'))input.disabled=false;$('#send-form').reset();sender.value=senderMemberId;$('#send-form details').open=false;busy=false;showFiles();status('Sendt ✓ Luna tar det videre.');await load();
 } catch(error) {status(error.message+(draft?'\nTrykk Send igjen for å fortsette. Hold siden åpen.':''),true);}
 finally {busy=false;$('#submit').disabled=false;showFiles();}
};
window.addEventListener('beforeunload',event=>{if(files.length||draft||$('#message').value.trim()){event.preventDefault();event.returnValue='';}});
const invitation=new URLSearchParams(location.hash.slice(1)).get('pair');
if(invitation) {history.replaceState(null,'',location.pathname);try{await post('/pair',{code:invitation,name:'Familietelefon'});}catch(error){status(error.message,true);}}
await load();setInterval(()=>{if(!busy&&!document.hidden)load();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!busy)load();});
