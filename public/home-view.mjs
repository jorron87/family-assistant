import { dtf } from "./dtf.mjs";
const node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;};
const states={home:'Hjemme',not_home:'Borte',unavailable:'Utilgjengelig',unknown:'Ukjent',docked:'I ladestasjonen',cleaning:'Rengjør',returning:'På vei hjem',paused:'Pause',idle:'Klar',error:'Trenger hjelp',open:'Åpne',closed:'Lukket',opening:'Åpner',closing:'Lukker',playing:'Spiller',off:'Av',on:'På',standby:'Hvile'};
const label=e=>states[e.state]??e.state;
export function installHomeView({panel,rail,onOpen,onData,temperature=document.querySelector('#outdoor-temperature')}) {
 let data={status:'not_configured',entities:[],stale:true},busy=false,lastSignature='';
 const entities=group=>data.entities.filter(e=>e.group===group);
 async function api(path='',input){const res=await fetch('/api/home-assistant'+path,input?{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify(input)}:{});const value=await res.json();if(!res.ok)throw Error(value.error??'Kunne ikke oppdatere huset.');return value;}
 const btn=(text,action,unavailable=false)=>{const b=node('button',text);b.type='button';b.disabled=unavailable||busy;b.onclick=action;return b;};
 const can=e=>!data.stale&&e.available;
 const message=node('p',undefined,'home-message');message.setAttribute('role','status');
 async function command(e,action,value){if(busy)return;busy=true;message.textContent='Sender …';for(const b of panel.querySelectorAll('button,input'))b.disabled=true;try{data=await api('/command',{entityId:e.id,action,value});lastSignature='';render();message.textContent='Sendt til '+e.name+'.';}catch(err){message.textContent=err.message;}finally{busy=false;lastSignature='';render();}}
 function card(title,icon){const c=node('section',undefined,'house-card'),head=node('div',undefined,'house-card-heading');head.append(node('span',icon,'house-icon'),node('h3',title));c.append(head);return c;}
 function row(e){const r=node('div',undefined,'house-row'),info=node('div');info.append(node('strong',e.name),node('small',label(e)+(e.attributes?.battery_level!==undefined?' · '+e.attributes.battery_level+' %':'')));r.append(info);return r;}
 function renderRail(){rail.replaceChildren();rail.hidden=data.status==='not_configured';if(rail.hidden)return;
  const people=node('div',undefined,'house-rail-people');for(const e of entities('presence')){const chip=node('span',undefined,'house-presence '+(e.state==='home'?'is-home':''));chip.append(node('i'),node('span',e.name),node('small',label(e)));people.append(chip);}rail.append(people);
  if(data.stale)rail.append(node('span','Sist kjente status','house-stale'));
  rail.append(btn('Huset →',onOpen));
 }
 function render(){
  onData?.(data);
  if(temperature){const t=entities('weather')[0],value=Number(t?.state);const known=t?.available&&Number.isFinite(value);temperature.textContent=(known?new Intl.NumberFormat('nb-NO',{maximumFractionDigits:1}).format(value):'—')+'° ute';temperature.classList.toggle('is-stale',data.stale);temperature.title=data.stale?'Utetemperatur: sist kjente verdi, forbindelsen mangler.':'Utetemperatur fra Home Assistant';temperature.setAttribute('aria-label',known?`Utetemperatur ${temperature.textContent}${data.stale?', sist kjente verdi':''}`:'Utetemperatur utilgjengelig');}
  const signature=JSON.stringify(data)+busy;if(signature===lastSignature)return;if(!busy&&data.status==='ok'&&panel.contains(document.activeElement)&&document.activeElement.matches('input'))return;lastSignature=signature;renderRail();panel.replaceChildren();
  const heading=node('div',undefined,'house-heading'),title=node('div');title.append(node('span','HJEMME HOS OSS','eyebrow'),node('h2','Huset'));heading.append(title);const status=node('span',data.status==='ok'?'Oppdatert nå':data.message??'Venter på tilkobling','house-status');heading.append(status);panel.append(heading,message);
  if(data.status==='not_configured'){const intro=card('Koble huset til familien','⌂');intro.append(node('p','Familiestatus, temperatur, persienner, musikk og støvsugere — samlet her.'));
   if(!new URLSearchParams(location.search).has('kiosk')){const form=node('form',undefined,'house-connect'),input=node('input');input.type='password';input.autocomplete='off';input.placeholder='Home Assistant-tilgangsnøkkel';input.setAttribute('aria-label','Home Assistant-tilgangsnøkkel');input.required=true;const submit=node('button','Koble til');submit.type='submit';form.append(input,submit);form.onsubmit=async event=>{event.preventDefault();submit.disabled=true;try{data=await api('/connect',{token:input.value.trim()});input.value='';render();}catch(e){message.textContent=e.message;}finally{submit.disabled=false;}};intro.append(form);}
   else intro.append(node('p','Tilkoblingen settes opp fra PC-en.'));panel.append(intro);return;
  }
  const grid=node('div',undefined,'house-grid');
  const presence=card('Familien','⌂');for(const e of entities('presence')){const r=row(e);r.append(node('span',e.state==='home'?'●':'○','house-person-dot '+(e.state==='home'?'is-home':'')));presence.append(r);}grid.append(presence);
  const covers=card('Persienner','▤');for(const e of entities('covers')){covers.append(row(e));if(Number.isFinite(e.attributes.current_position))covers.append(node('p',e.attributes.current_position+' % åpne','house-position'));const actions=node('div',undefined,'house-controls');for(const [text,action] of [['↑ Åpne','open_cover'],['■ Stopp','stop_cover'],['↓ Lukk','close_cover']])actions.append(btn(text,()=>command(e,action),!can(e)));covers.append(actions);}grid.append(covers);
  const media=card('Musikk og TV','♫');for(const e of entities('media')){media.append(row(e));if(e.attributes.media_title||e.attributes.source)media.append(node('p',[e.attributes.media_title,e.attributes.media_artist??e.attributes.source].filter(Boolean).join(' · '),'house-track'));const controls=node('div',undefined,'house-controls');controls.append(btn(e.state==='off'?'Slå på':'Slå av',()=>command(e,e.state==='off'?'turn_on':'turn_off'),!can(e)),btn(e.state==='playing'?'Ⅱ Pause':'▷ Spill',()=>command(e,'media_play_pause'),!can(e)||e.state==='off'));media.append(controls);
   if(Number.isFinite(e.attributes.volume_level)){const group=node('label','Lydnivå','house-volume'),slider=node('input');slider.type='range';slider.min='0';slider.max='100';slider.value=String(Math.round(e.attributes.volume_level*100));slider.disabled=!can(e)||busy;slider.onchange=()=>command(e,'volume_set',Number(slider.value)/100);group.append(slider);media.append(group);}}
  grid.append(media);
  const vacuums=card('Støvsugere','◉');for(const e of entities('vacuums')){vacuums.append(row(e));const controls=node('div',undefined,'house-controls');controls.append(btn(e.state==='cleaning'?'Ⅱ Pause':'▷ Start',()=>command(e,e.state==='cleaning'?'pause':'start'),!can(e)),btn('⌂ Til lader',()=>command(e,'return_to_base'),!can(e)));vacuums.append(controls);}vacuums.append(btn('Send alle til lader',()=>command({name:'støvsugerne'},'return_all'),!entities('vacuums').length||entities('vacuums').some(e=>!can(e))));grid.append(vacuums);
  const routines=card('Hverdagsrutiner','◷');for(const e of entities('schedule')){const field=node('label',e.name,'house-time'),input=node('input');input.type='time';input.value=/^\d\d:\d\d/.test(e.state)?e.state.slice(0,5):'';input.disabled=!can(e)||busy;field.append(input);const save=btn('Lagre tid',()=>command(e,'set_datetime',input.value),!can(e));routines.append(field,save);}
  for(const e of entities('switches')){routines.append(row(e));routines.append(btn(e.state==='on'?'Slå av gjestemodus':'Slå på gjestemodus',()=>command(e,e.state==='on'?'turn_off':'turn_on'),!can(e)));}grid.append(routines);panel.append(grid);
  if(data.stale&&data.checkedAt)panel.append(node('p','Sist oppdatert '+dtf('nb-NO',{timeStyle:'short'}).format(new Date(data.checkedAt))+'. Kontroller er deaktivert til forbindelsen er tilbake.','house-stale'));
 }
 async function refresh(){if(busy||document.hidden)return;try{data=await api();}catch{data={...data,status:'error',stale:true,message:'Huset er midlertidig utilgjengelig.'};}render();}
 refresh();const timer=setInterval(refresh,20000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});return {refresh,stop(){clearInterval(timer);}};
}
