export function doorbellController({open,close,setTitle,schedule=setTimeout,cancel=clearTimeout,now=()=>Date.now(),durationMs=30000}){
 let active=false,timer=null,until=0;
 function dismiss(){if(!active)return;active=false;cancel(timer);timer=null;until=0;close();}
 function alarm(event){
  if(!['person','ring'].includes(event?.kind))return false;
  if(event.at&&(now()-Date.parse(event.at)>5000||Date.parse(event.at)>now()+2000||!Number.isFinite(Date.parse(event.at))))return false;
  if(active&&event.kind==='person')return false;
  if(!active){active=true;open(event);}
  setTitle(event.kind==='ring'?'Noen ringer på':'Person ved døren',event.kind);until=now()+durationMs;cancel(timer);timer=schedule(dismiss,durationMs);return true;
 }
 function extend(){if(!active)return false;until=now()+durationMs;cancel(timer);timer=schedule(dismiss,durationMs);return true;}
 return {alarm,dismiss,extend,durationMs,isOpen:()=>active,remaining:()=>Math.max(0,Math.ceil((until-now())/1000)),remainingMs:()=>Math.max(0,until-now())};
}

export function playDoorbellVideo(video,{onError,onFrame,url='/api/doorbell/video',WebSocketImpl=WebSocket,MediaSourceImpl=window.MediaSource}){
 let socket=null,media=null,source=null,objectUrl=null,closed=false,queue=[],bytes=0,started=false,frameSeen=false;
 const timer=setTimeout(()=>fail('Direktebildet svarte ikke. Prøv igjen ved neste besøk.'),15000);
 let stallTimer=null,frameHandle=null;
 const onVideoError=()=>fail('Direktebildet kunne ikke spilles av.'),onTime=()=>{if(video.currentTime>0)frame();};
 const cleanup=()=>{if(closed)return;closed=true;clearTimeout(timer);clearTimeout(stallTimer);if(frameHandle!=null)video.cancelVideoFrameCallback?.(frameHandle);video.removeEventListener('error',onVideoError);video.removeEventListener('timeupdate',onTime);socket?.close();queue=[];bytes=0;video.pause();video.removeAttribute('src');video.load();if(objectUrl)URL.revokeObjectURL(objectUrl);source=null;media=null;};
 function fail(message){if(closed)return;cleanup();onError(message);}
 function frame(){if(closed)return;clearTimeout(stallTimer);stallTimer=setTimeout(()=>fail('Direktebildet stoppet. Videoforbindelsen er lukket.'),6000);if(!frameSeen){frameSeen=true;clearTimeout(timer);onFrame();}if(video.requestVideoFrameCallback)frameHandle=video.requestVideoFrameCallback(frame);}
 function pump(){
  if(closed||!source||source.updating)return;
  try{
   if(source.buffered.length&&video.currentTime-source.buffered.start(0)>10){source.remove(source.buffered.start(0),video.currentTime-5);return;}
   if(queue.length){const chunk=queue.shift();bytes-=chunk.byteLength;source.appendBuffer(chunk);return;}
   const ranges=source.buffered;if(!ranges.length)return;
   const start=ranges.start(ranges.length-1),end=ranges.end(ranges.length-1);
   if(!started&&end-start>=0.2){started=true;video.currentTime=Math.max(start,end-0.5);video.play().catch(()=>fail('Nettleseren kunne ikke starte direktebildet.'));}
   else if(started&&(video.currentTime<start||end-video.currentTime>2))video.currentTime=Math.max(start,end-0.5);
  }catch{fail('Nettleseren kunne ikke vise videostrømmen.');}
 }
 video.muted=true;video.autoplay=true;video.playsInline=true;video.disableRemotePlayback=true;
 if(!MediaSourceImpl){fail('Denne nettleseren støtter ikke direktevideo.');return cleanup;}
 const target=new URL(url,location.href);target.protocol=target.protocol==='https:'?'wss:':'ws:';
 socket=new WebSocketImpl(target);socket.binaryType='arraybuffer';
 socket.addEventListener('message',({data})=>{
  if(closed)return;
  if(typeof data==='string'){
   let init;try{init=JSON.parse(data);}catch{fail('Videobroen svarte ugyldig.');return;}
   if(init.type==='error'){fail(init.message||'Direktebildet er utilgjengelig.');return;}
   if(init.type!=='init'||media)return;
   if(typeof init.mime!=='string'||!MediaSourceImpl.isTypeSupported(init.mime)){fail('Videostrømmens format støttes ikke på skjermen.');return;}
   media=new MediaSourceImpl();objectUrl=URL.createObjectURL(media);video.src=objectUrl;
   media.addEventListener('sourceopen',()=>{if(closed)return;try{source=media.addSourceBuffer(init.mime);source.mode='segments';source.addEventListener('updateend',pump);source.addEventListener('error',()=>fail('Videostrømmen kunne ikke dekodes.'));pump();}catch{fail('Videostrømmen kunne ikke åpnes.');}},{once:true});
  }else if(data instanceof ArrayBuffer){bytes+=data.byteLength;if(bytes>8*1024*1024){fail('Videoforbindelsen er for treg.');return;}queue.push(data);pump();}
 });
 socket.addEventListener('error',()=>fail('Får ikke kontakt med ringeklokkens direktebilde.'));
 socket.addEventListener('close',()=>{if(!closed)fail('Videoforbindelsen ble brutt.');});
 video.addEventListener('error',onVideoError,{once:true});
 if(video.requestVideoFrameCallback)frameHandle=video.requestVideoFrameCallback(frame);
 else video.addEventListener('timeupdate',onTime);
 return cleanup;
}

// Ringeklokkevisning. Ringing = stort vindu (modal). Person = kompakt direktekort nede til høyre som ikke stjeler fokus; trykk for å forstørre.
// Sett PERSON_MODE til 'full' for å få samme store vindu også for personer.
const PERSON_MODE='compact';
const BELL='<svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 17h12l-1.5-2.2V10.5a4.5 4.5 0 0 0-9 0v4.3z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>';
const PERSON='<svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20c.6-3.8 3.4-6 7-6s6.4 2.2 7 6"/></svg>';
const clockFormat=new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

// Tegner en rolig prøveflate uten å vekke kameraet (?doorbell-preview=ring-demo eller person-demo).
function playDemo(video,{onFrame}){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=512;const ctx=canvas.getContext('2d');let n=0;
 const draw=()=>{const g=ctx.createLinearGradient(0,0,512,512);g.addColorStop(0,'#2b3a33');g.addColorStop(1,'#10181a');ctx.fillStyle=g;ctx.fillRect(0,0,512,512);
  ctx.fillStyle='#c9d4cc';ctx.font='28px system-ui';ctx.textAlign='center';ctx.fillText('Prøvebilde',256,250);ctx.fillStyle='#ffffff55';ctx.fillRect(40+(n++%40)*10,300,24,24);};
 draw();const timer=setInterval(draw,200);video.srcObject=canvas.captureStream(5);video.play().catch(()=>{});setTimeout(onFrame,600);
 return()=>{clearInterval(timer);video.pause();video.srcObject=null;};
}

export function installDoorbellView({preview=null,onFrame=()=>{}}={}){
 const demo=/-demo$/.test(preview??''),previewKind=(preview??'').replace(/-demo$/,'');
 const dialog=document.createElement('dialog');dialog.className='doorbell-dialog';dialog.setAttribute('aria-labelledby','doorbell-title');
 dialog.innerHTML=`<div class="db-picture"><video muted autoplay playsinline aria-label="Direktebilde fra ringeklokken"></video>
  <div class="db-status" role="status"><div class="db-icon" aria-hidden="true"></div><p class="db-message">Kobler til direktebildet …</p><button type="button" class="db-retry" hidden>Prøv igjen</button></div>
  <span class="db-live"><i></i>Direkte · lyd av</span><button type="button" class="db-x" aria-label="Lukk">✕</button></div>
  <div class="db-side"><div><p class="db-eyebrow"><span class="db-where">Ved inngangen</span><time class="db-time"></time></p><h2 id="doorbell-title"></h2><p class="db-hint">Trykk på bildet for å se større</p></div>
   <div><div class="db-count"><div class="db-bar"><i></i></div><span class="doorbell-countdown"></span></div>
   <div class="db-actions"><button type="button" class="db-more">Vis 30 s til</button><button type="button" class="doorbell-close">Lukk</button></div></div></div>`;
 document.body.append(dialog);
 const q=selector=>dialog.querySelector(selector),video=q('video'),status=q('.db-status'),message=q('.db-message'),retry=q('.db-retry'),icon=q('.db-icon'),fill=q('.db-bar i'),label=q('.doorbell-countdown');
 let release=()=>{},ticker=null,focus=null,started=0,mode=null,kind=null;
 const present=()=>{mode==='full'?dialog.showModal():dialog.show();};
 function setMode(next){
  if(mode===next)return;mode=next;dialog.dataset.mode=next;
  if(!dialog.open)return;dialog.close();present();if(mode==='full')q('.doorbell-close').focus({preventScroll:true});
 }
 const fail=text=>{message.textContent=text;status.hidden=false;status.classList.add('db-failed');retry.hidden=false;dialog.classList.add('doorbell-failed');icon.textContent='!';};
 function connect(){
  started=performance.now();release();release=()=>{};retry.hidden=true;status.hidden=false;status.classList.remove('db-failed');dialog.classList.remove('doorbell-failed');
  message.textContent='Kobler til direktebildet …';icon.innerHTML=kind==='ring'?BELL:PERSON;
  const shown=()=>{status.hidden=true;onFrame({kind,firstFrameMs:Math.round(performance.now()-started),at:new Date().toISOString(),preview:!!preview});};
  if(previewKind==='error')fail('Direktebildet er utilgjengelig. Videoforbindelsen er lukket.');
  else release=demo?playDemo(video,{onFrame:shown}):playDoorbellVideo(video,{onError:fail,onFrame:shown});
 }
 const controller=doorbellController({
  open:event=>{
   focus=document.activeElement;kind=event.kind;mode=event.kind==='ring'||PERSON_MODE==='full'?'full':'compact';dialog.dataset.mode=mode;dialog.dataset.kind=kind;
   q('.db-time').textContent='kl. '+clockFormat.format(event.at?new Date(event.at):new Date());present();
   if(mode==='full')q('.doorbell-close').focus({preventScroll:true});
   connect();ticker=setInterval(()=>{const ms=controller.remainingMs();fill.style.transform=`scaleX(${Math.max(0,ms/controller.durationMs)})`;label.textContent=`Lukkes om ${Math.ceil(ms/1000)} s`;},200);
  },
  setTitle:(title,newKind)=>{q('h2').textContent=title;if(newKind&&newKind!==kind){kind=newKind;dialog.dataset.kind=kind;if(!status.classList.contains('db-failed'))icon.innerHTML=kind==='ring'?BELL:PERSON;}if(newKind==='ring')setMode('full');},
  close:()=>{clearInterval(ticker);release();release=()=>{};mode=null;dialog.close();focus?.focus?.({preventScroll:true});}
 });
 q('.doorbell-close').onclick=controller.dismiss;q('.db-x').onclick=controller.dismiss;q('.db-more').onclick=()=>controller.extend();
 retry.onclick=()=>{controller.extend();connect();};
 q('.db-picture').onclick=event=>{if(mode==='compact'&&!event.target.closest('button')){setMode('full');controller.extend();}};
 dialog.addEventListener('click',event=>{if(event.target===dialog&&mode==='full')controller.dismiss();});
 dialog.addEventListener('cancel',event=>{event.preventDefault();controller.dismiss();});
 dialog.addEventListener('close',()=>{if(!dialog.open&&controller.isOpen())controller.dismiss();});
 const events=new EventSource('/api/doorbell/events');events.addEventListener('alarm',event=>{try{controller.alarm(JSON.parse(event.data));}catch{}});
 if(['person','ring','error'].includes(previewKind))setTimeout(()=>controller.alarm({kind:previewKind==='person'?'person':'ring'}),500);
 const dispose=()=>{events.close();controller.dismiss();dialog.remove();};window.addEventListener('pagehide',dispose,{once:true});
 return {...controller,dispose};
}
