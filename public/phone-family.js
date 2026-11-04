import {osloDay,addDays,eventStartDay,eventsOnDay,weekDays,monthDays,shiftMonth} from './calendar-data.mjs';
import {cleanTitle,isFollowUp,noteFor} from './event-display.mjs';
import {celebrateTick,celebrateComplete,celebrationFor,pop} from './celebrate.mjs';
import {isHomework} from './home-tasks.mjs';
const $=s=>document.querySelector(s);
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const dayText=(day,opts={weekday:'long',day:'numeric',month:'long'})=>new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',...opts}).format(new Date(day+'T12:00:00Z'));
const colors=new Proxy({}, {get:(_,id)=>['#c57b84','#668db5','#749a7b','#d5a557','#808789','#987b9a'][String(id).split('').reduce((n,c)=>n+c.charCodeAt(0),0)%6]});
export function installFamily({api,post,status}) {
 let editor;
 async function refreshProfile(){try{if(!editor){const {installProfileEditor}=await import('./profile-editor.mjs?v='+Date.now());editor=installProfileEditor($('#mobile-profile-cards'),{read:()=>api('/profile'),save:data=>post('/profile/edit',data),onSaved:()=>refresh()});}await editor.refresh();}catch{$('#mobile-profile-cards').textContent='Profilredigeringen blir tilgjengelig når den pågående kjøringen er ferdig.';}}
 let data={members:[],events:[]},person='all',view='home',mode='agenda',day=osloDay(),showLater=false,signature='',openedId=null;
 const expanded=new Set();
 const name=id=>data.members.find(x=>x.id===id)?.name??id;
 const matching=()=>data.events.filter(e=>person==='all'||e.members.includes(person));
 const active=()=>matching().filter(e=>!e.visibility?.hidden);
 const left=e=>e.task?.items.filter(i=>!i.doneAt).length??0;
 const tasks=()=>active().filter(e=>e.task&&!e.cancelled&&left(e));
 function setView(next){view=next;$('#family-home').hidden=view!=='home';$('#family-tasks').hidden=view!=='tasks';$('#family-profile').hidden=view!=='profile';$('#person-tabs').hidden=view==='profile';$('#capture').hidden=view!=='capture';$('#family').hidden=view==='capture';for(const b of document.querySelectorAll('[data-view]'))b.classList.toggle('selected',b.dataset.view===view);if(view==='profile')refreshProfile();render();window.scrollTo({top:0});}
 for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>setView(b.dataset.view);
 for(const b of document.querySelectorAll('[data-mode]'))b.onclick=()=>{mode=b.dataset.mode;showLater=false;render();};
 $('#event-close').onclick=()=>$('#mobile-event').close();
 $('#mobile-event').onclose=()=>{openedId=null;};
 $('#mobile-event').onclick=e=>{if(e.target===$('#mobile-event'))e.target.close();};
 async function refresh(){update(await api('/family'));}
 async function mutate(path,payload,button){button.disabled=true;try{await post(path,payload);await refresh();return true;}catch(e){status(e.message,true);return false;}finally{button.disabled=false;}}
 function time(e){return e.task?(left(e)?`${left(e)} igjen`:'Fullført'):e.allDay?'Hele dagen':isFollowUp(e)?'Følg opp':new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit'}).format(new Date(e.start));}
 function row(e){const b=node('button',undefined,'agenda-row');b.type='button';b.append(node('span',time(e),'agenda-time'));const copy=node('span');copy.append(node('span',cleanTitle(e.title),'agenda-title'));copy.append(node('span',noteFor(e,110),'agenda-note'));copy.append(node('span',[e.members.map(name).join(' · '),e.provisional&&!isFollowUp(e)?'ikke bekreftet':'',e.cancelled?'Avlyst':''].filter(Boolean).join(' · '),'people-label'));b.append(copy);b.onclick=()=>openEvent(e.id);return b;}
 function checklist(e){const list=node('div',undefined,'task-checklist');for(const item of e.task.items){const label=node('label',undefined,'task-item'+(item.doneAt?' done':'')),check=node('input');check.type='checkbox';check.checked=!!item.doneAt;check.disabled=!!e.taskSplit;check.onchange=async()=>{const feast=celebrationFor({items:e.task.items,key:item.key,checked:check.checked});if(feast){const member=e.members?.length===1?e.members[0]:null,who={name:member?name(member):'',color:member?colors[member]:undefined},rect=check.getBoundingClientRect();pop(label);navigator.vibrate?.(feast.complete?[60,40,60,40,180]:30);if(feast.complete&&isHomework(e))celebrateComplete({...who,total:feast.total,homework:true,title:cleanTitle(e.title)});else celebrateTick({...who,x:rect.left+rect.width/2,y:rect.top,done:feast.done,total:feast.total});}if(!await mutate(`/events/${e.id}/tasks/${encodeURIComponent(item.key)}`,{done:check.checked,expectedText:item.text},check))check.checked=!!item.doneAt;};label.append(check,node('span',item.text));list.append(label);}return list;}
 function openEvent(id){const e=data.events.find(e=>e.id===id);if(!e)return;openedId=id;const period=e.task?`${dayText(e.task.visibleFrom,{day:'numeric',month:'short'})} – ${dayText(e.task.dueDate,{day:'numeric',month:'short'})}`:dayText(eventStartDay(e));const content=$('#mobile-event-content');content.replaceChildren(node('h2',cleanTitle(e.title)),node('p',`${period} · ${time(e)}${e.provisional&&!isFollowUp(e)?' · ikke bekreftet':''}\n${e.members.map(name).join(' · ')}`,'event-meta'));
  const action=node('div',undefined,'event-actions'),button=node('button',e.visibility?.hidden?'Gjenåpne oppføring':'Ferdig vurdert · skjul');button.onclick=async()=>{if(await mutate(`/events/${e.id}/visibility`,{hidden:!e.visibility?.hidden},button))$('#mobile-event').close();};if(e.taskSplit){button.disabled=true;button.textContent='Erstattet av personlige lekseoppgaver';}action.append(button);content.append(action);
  if(e.visibility?.sync?.status==='pending')content.append(node('p',e.visibility.sync.error??'Endringen synkroniseres med Google-kalenderen.','sync-note'));
  if(e.timeNote)content.append(node('p',e.timeNote,'event-meta'));if(e.details)content.append(node('p',e.details,'event-description'));
  if(e.task)content.append(checklist(e));else if(e.checklist?.length){const ul=node('ul',undefined,'event-checklist');for(const text of e.checklist)ul.append(node('li',text));content.append(ul);}
  const sources=node('div',undefined,'source-list');sources.append(node('h3','Kilder'));
  const link=(label,url)=>{if(!url)return;const a=node('a',label,'source-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';sources.append(a);};
  if(!e.visibility?.hidden)link('Åpne i Google-kalenderen ↗',e.calendarUrl);
  for(const raw of e.sources){const group=node('details');group.append(node('summary',raw.title));sources.append(group);if(raw.driveUrl){const a=node('a','Kilde i Drive ↗','source-link');a.href=raw.driveUrl;a.target='_blank';a.rel='noopener noreferrer';group.append(a);}if(raw.url){const a=node('a','Original kilde ↗','source-link');a.href=raw.url;a.target='_blank';a.rel='noopener noreferrer';group.append(a);}for(const file of raw.attachments){const a=node('a',file.name+' ↗','source-link');a.href=file.url;a.target='_blank';a.rel='noopener noreferrer';group.append(a);}}
  content.append(sources);if(!$('#mobile-event').open)$('#mobile-event').showModal();
 }
 function renderDates(){const holder=$('#mobile-dates');holder.replaceChildren();for(const b of document.querySelectorAll('[data-mode]'))b.classList.toggle('selected',b.dataset.mode===mode);
  if(mode!=='agenda'){const nav=node('div',undefined,'date-navigation'),prev=node('button','←'),next=node('button','→');prev.setAttribute('aria-label','Forrige periode');next.setAttribute('aria-label','Neste periode');prev.onclick=()=>{day=mode==='month'?shiftMonth(day,-1):addDays(day,-7);render();};next.onclick=()=>{day=mode==='month'?shiftMonth(day,1):addDays(day,7);render();};nav.append(prev,node('span',dayText(day,{month:'long',year:'numeric'})),next);holder.append(nav);}
  if(mode==='month'){const labels=node('div',undefined,'month-weekdays');for(const text of ['M','T','O','T','F','L','S'])labels.append(node('span',text));holder.append(labels);}
  const grid=node('div',undefined,mode==='month'?'month-grid':'date-strip');
  for(const d of mode==='month'?monthDays(day):weekDays(day)){const b=node('button',undefined,(d===day?'selected ':'')+(mode==='month'&&d.slice(0,7)!==day.slice(0,7)?'other-month ':'')+(eventsOnDay(active(),d).length?'has-plans':''));b.setAttribute('aria-label',dayText(d));b.setAttribute('aria-pressed',String(d===day));if(mode!=='month')b.append(node('span',dayText(d,{weekday:'short'})));b.append(node('strong',String(Number(d.slice(8)))));b.onclick=()=>{day=d;render();};grid.append(b);}holder.append(grid);
  if(day!==osloDay()){const today=node('button','Til i dag', 'back-today');today.onclick=()=>{day=osloDay();render();};holder.append(today);}
 }
 function daySection(title,d){const group=node('section'),h=node('div',undefined,'day-heading');h.append(node('h3',title),node('span',dayText(d,{day:'numeric',month:'short'}),'date-caption'));group.append(h);const list=eventsOnDay(active().filter(e=>!e.task),d).sort((x,y)=>Number(isFollowUp(x))-Number(isFollowUp(y)));if(!list.length)group.append(node('p','Ingen planer.','empty'));else for(const e of list)group.append(row(e));return group;}
 function renderTasks(){const holder=$('#family-task-list');holder.replaceChildren();const all=active().filter(e=>e.task&&!e.cancelled).sort((a,b)=>a.task.dueDate.localeCompare(b.task.dueDate));$('#task-total').textContent=`${tasks().reduce((n,e)=>n+left(e),0)} gjenstår`;
  if(!all.length)holder.append(node('p','Ingen oppgaver.','empty'));
  const completed=node('details',undefined,'completed-groups');completed.open=expanded.has('completed');completed.ontoggle=()=>{if(!completed.isConnected)return;if(completed.open)expanded.add('completed');else expanded.delete('completed');};completed.append(node('summary',`Fullførte (${all.filter(e=>!left(e)).length})`));
  for(const e of all){const group=node('details',undefined,'task-group');group.open=expanded.has(e.id);group.ontoggle=()=>{if(!group.isConnected)return;if(group.open)expanded.add(e.id);else expanded.delete(e.id);};const summary=node('summary');summary.append(node('strong',cleanTitle(e.title)),node('span',`${left(e)} igjen · ${e.members.map(name).join(' · ')} · frist ${dayText(e.task.dueDate,{day:'numeric',month:'short'})}`,'muted'));group.append(summary,checklist(e));const detail=node('button','Detaljer og kilder');detail.onclick=()=>openEvent(e.id);group.append(detail);(left(e)?holder:completed).append(group);}
  if(all.some(e=>!left(e)))holder.append(completed);
  const hidden=matching().filter(e=>e.visibility?.hidden);$('#hidden-entries>summary').textContent=`Skjulte oppføringer (${hidden.length})`;$('#hidden-list').replaceChildren(...hidden.map(row));
 }
 function render(){if(!data.members.length)return;$('#today-label').textContent=dayText(osloDay(),{day:'numeric',month:'long'});const people=$('#person-tabs');people.replaceChildren();for(const member of [{id:'all',name:'Alle'},...data.members]){const b=node('button',undefined,member.id===person?'selected':'');b.setAttribute('aria-pressed',String(member.id===person));const dot=node('span',undefined,'person-dot');dot.style.setProperty('--person',colors[member.id]??'#749a7b');b.append(dot,document.createTextNode(member.name));b.onclick=()=>{person=member.id;if(person!=='all'){for(const e of tasks())expanded.add(e.id);setView('tasks');}else render();};people.append(b);}
  renderDates();const count=tasks().filter(e=>e.task.visibleFrom<=addDays(osloDay(),7)).reduce((n,e)=>n+left(e),0);$('#task-summary').hidden=!count;$('#task-summary').textContent=`${count} oppgave${count===1?'':'r'} gjenstår  →`;$('#task-summary').onclick=()=>setView('tasks');
  const agenda=$('#family-agenda');agenda.replaceChildren(daySection(day===osloDay()?'I dag':dayText(day),day));if(mode==='agenda'&&day===osloDay()){agenda.append(daySection('I morgen',addDays(day,1)));const later=active().filter(e=>!e.task&&eventStartDay(e)>addDays(day,1)&&eventStartDay(e)<=addDays(day,showLater?90:30)).sort((a,b)=>a.start.localeCompare(b.start));if(later.length){const h=node('div',undefined,'day-heading');h.append(node('h3','Senere'));agenda.append(h);for(const e of later.slice(0,showLater?100:6)){const b=row(e);b.querySelector('.agenda-time').textContent=dayText(eventStartDay(e),{day:'numeric',month:'short'});agenda.append(b);}if(later.length>6&&!showLater){const more=node('button','Vis flere planer →');more.onclick=()=>{showLater=true;render();};agenda.append(more);}}}
  renderTasks();renderWeeklyLetter();
 }
 function renderWeeklyLetter(){
  let holder=$('#mobile-weekly-letter');
  if(!holder){holder=node('section',undefined,'weekly-letter-strip');holder.id='mobile-weekly-letter';holder.setAttribute('aria-label','Barnets ukebrev');$('#person-tabs').after(holder);}
  holder.replaceChildren();holder.hidden=!(data.childIds??[]).includes(person)||!['home','tasks'].includes(view);if(holder.hidden)return;
  const letter=(data.weeklyLetters??[]).find(item=>item.memberId===person);
  if(!letter){holder.append(node('span','Ukebrev ikke tilgjengelig ennå','muted'));return;}
  const button=node(letter.url?'a':'button',undefined,'weekly-letter-button');
  button.append(node('strong',`▤ Ukebrev · uke ${letter.week}`),node('span','Åpne →'));
  button.setAttribute('aria-label',`Åpne ukebrevet for ${name(person)}, uke ${letter.week}, ${letter.year}`);
  if(letter.url){button.href=letter.url;button.target='_blank';button.rel='noopener noreferrer';}
  else{button.type='button';button.onclick=async()=>{try{const raw=await api(`/weekly-letters/${letter.rawId}`);openedId=null;$('#mobile-event-content').replaceChildren(node('h2',raw.title),node('p',raw.body,'event-description'));if(!$('#mobile-event').open)$('#mobile-event').showModal();}catch(error){status(error.message,true);}};}
  holder.append(button);if(letter.status!=='current')holder.append(node('span',letter.status==='upcoming'?'Neste skoleuke':'Sist tilgjengelig','weekly-letter-note'));
 }
 function showLogin(){const line=$('#login-line');line.hidden=!data.login;if(!data.login)return;line.textContent=(data.login.level==='login'?'🔒 ':'⚠ ')+data.login.text;line.className='login-line '+data.login.level;}
 function update(next){const json=JSON.stringify(next)+osloDay();data=next;showLogin();if(json!==signature){signature=json;render();if(openedId)openEvent(openedId);}}
 return {update,setView,refresh,openEvent,get view(){return view;}};
}

