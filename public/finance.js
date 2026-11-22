const $=selector=>document.querySelector(selector);
const API=location.pathname.startsWith('/send/')?'/send/api/finance':'/api/finance';
const fmt=new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:0});
const kr=minor=>minor==null?'–':fmt.format(Math.round(minor/100));
const krExact=(minor,currency='NOK')=>new Intl.NumberFormat('nb-NO',{style:'currency',currency}).format(minor/100);
const dateText=value=>value?new Date(value).toLocaleDateString('nb-NO',{day:'numeric',month:'short',year:'numeric'}):'–';
const timeText=value=>value?new Date(value).toLocaleString('nb-NO',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'–';
const monthName=month=>new Date(month+'-15').toLocaleDateString('nb-NO',{month:'long',year:'numeric'});
const median=values=>{const s=values.filter(v=>v!=null).sort((a,b)=>a-b);if(!s.length)return null;const m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;};
const CADENCE_TEXT={ukentlig:'Hver uke','månedlig':'Hver måned',kvartalsvis:'Hvert kvartal','halvårlig':'Hvert halvår','årlig':'Hvert år'};
const KIND_TEXT={contract:'Avtale',subscription:'Abonnement',grocery:'Dagligvarer',tax:'Skatt',refund:'Penger til gode',anomaly:'Avvik',forecast:'Prognose',goal:'Mål',settlement:'Oppgjør',fees:'Gebyrer',other:'Annet'};
const STATUS_TEXT={open:'Nytt',accepted:'Venter på bekreftelse i banken',done:'Gjort',realized:'Dokumentert spart',snoozed:'Utsatt',dismissed:'Avvist'};
const TX_KIND={expense:'Utgift',income:'Inntekt',internal:'Mellom egne kontoer',saving:'Sparing'};

function h(tag,attrs={},...children){
  const node=document.createElement(tag);
  for (const [key,value] of Object.entries(attrs||{})) {
    if (value==null||value===false) continue;
    if (key==='class') node.className=value;
    else if (key==='text') node.textContent=value;
    else if (key.startsWith('on')) node[key]=value;
    else node.setAttribute(key,value===true?'':value);
  }
  for (const child of children.flat()) if (child!=null&&child!==false) node.append(child instanceof Node?child:document.createTextNode(String(child)));
  return node;
}
const svg=(tag,attrs={})=>{const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);return node;};

class ApiError extends Error {constructor(message,status,body){super(message);this.status=status;this.body=body;}}
async function api(path,body){
  const response=await fetch(API+path,{method:body?'POST':'GET',cache:'no-store',credentials:'same-origin',
    headers:{'Content-Type':'application/json','x-family-request':'1'},body:body?JSON.stringify(body):undefined});
  let data={};try{data=await response.json();}catch{data={error:'Tjenesten svarte ikke som forventet (HTTP '+response.status+').'};}
  if (!response.ok) throw new ApiError(data.error||'Ukjent feil.',response.status,data);
  return data;
}
function setStatus(text,alert=false){const node=$('#status');node.textContent=text||'';node.className='status'+(alert?' alert':'');node.hidden=!text;}
function act(action){return async event=>{
  const button=event?.currentTarget;if(button)button.disabled=true;
  try {await action(event);} catch(error) {if(error.status===401)return showLock(error.body);setStatus(error.message,true);}
  finally {if(button&&button.isConnected)button.disabled=false;}
};}

let data=null,tab='overview',pollTimer=null,txFilter={category:'',kind:'',q:''},bankList=null;
const month=()=>$('#month').value;

function showLock(body={}){
  clearTimeout(pollTimer);
  $('#app').hidden=true;$('#locked').hidden=false;$('#lock').hidden=true;
  $('#lock-text').textContent=body.pinAvailable===false
    ?'Ingen voksen har satt PIN ennå. Kjør npm run finance:setup på PC-en for å sette en PIN.'
    :'Skriv inn din voksen-PIN for å åpne familieøkonomien.';
  $('#device-id').textContent=body.deviceId?'Enhets-ID for denne telefonen (til oppsettet på PC-en): '+body.deviceId:'';
  setStatus(sessionStorage.getItem('financeConfirmed')||'');
  $('#pin').value='';$('#pin').focus();
}

async function refresh({quiet=false}={}){
  clearTimeout(pollTimer);
  let next;
  try {next=await api('?month='+encodeURIComponent(month()));}
  catch (error) {if(error.status===401)return showLock(error.body);throw error;}
  data=next;
  $('#locked').hidden=true;$('#app').hidden=false;$('#lock').hidden=false;
  $('#lock').textContent=data.session==='enrolled'?'Lukk':'Lås';
  const typing=document.activeElement?.closest?.('#app')&&/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (!(quiet&&typing)) render();
  statusLine();
  if (data.progress||data.queued) pollTimer=setTimeout(()=>refresh({quiet:true}).catch(()=>{}),5000);
  else if (data.agent.running) pollTimer=setTimeout(()=>refresh({quiet:true}).catch(()=>{}),30000);
}
function statusLine(){
  if (data.progress) return setStatus('Henter bankhistorikk: '+data.progress.read+' av '+data.progress.total+' kontoer lest. Du kan lukke siden.');
  if (data.queued) return setStatus('Samtykket er lagret. Innlesingen starter automatisk i løpet av et minutt.');
  if (data.agent.running) return setStatus('Økonomiagenten går gjennom tallene nå.');
  const confirmed=sessionStorage.getItem('financeConfirmed');
  if (confirmed) {sessionStorage.removeItem('financeConfirmed');return setStatus(confirmed);}
  setStatus('');
}
function render(){
  for (const button of document.querySelectorAll('.tabs button')) button.setAttribute('aria-selected',String(button.dataset.tab===tab));
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden=panel.dataset.panel!==tab;
  const panel=document.querySelector(`[data-panel="${tab}"]`);
  panel.replaceChildren(...({overview,ideas,fixed,forecastView,tx:transactionsView,accounts}[tab==='forecast'?'forecastView':tab==='tx'?'tx':tab])());
}
function goTab(next,filter){tab=next;if(filter)txFilter={...txFilter,...filter};render();window.scrollTo({top:0,behavior:'smooth'});}

// ---------- shared pieces ----------
const tooltip=$('#tooltip');
function tip(target,text){
  target.onmouseenter=target.onfocus=event=>{tooltip.textContent=text;tooltip.hidden=false;move(event);};
  target.onmousemove=move;target.onmouseleave=target.onblur=()=>{tooltip.hidden=true;};
  function move(event){const rect=event.clientX!=null&&event.clientX?{x:event.clientX,y:event.clientY}:(()=>{const r=target.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top};})();
    tooltip.style.left=Math.min(window.innerWidth-tooltip.offsetWidth-8,rect.x+12)+'px';tooltip.style.top=Math.max(8,rect.y-36)+'px';}
}
function card(title,...children){return h('section',{class:'card'},title?h('h2',{text:title}):null,...children);}
function empty(text){return h('p',{class:'empty',text});}
function rowLine(r){
  return h('div',{class:'item'},h('span',{class:'what'},r.date+' · '+r.merchant,h('span',{class:'pill',text:r.category?data.categories[r.category]:TX_KIND[r.kind]})),
    h('span',{class:'amount '+(r.minor<0?'neg':'pos'),text:krExact(r.minor,r.currency)}));
}
function coverageNotes(){
  const notes=[],cov=data.coverage;
  if (cov.missingOwners?.length) notes.push('Ikke koblet til ennå: '+cov.missingOwners.join(', ')+'. Tallene viser bare tilkoblede kontoer.');
  for (const e of cov.expired||[]) notes.push('Banksamtykket for '+e.bank+' ('+e.owner+') har utløpt. Forny under Kontoer.');
  for (const e of cov.expiringSoon||[]) notes.push('Banksamtykket for '+e.bank+' ('+e.owner+') utløper '+dateText(e.expires)+'. Forny under Kontoer.');
  if (!data.summary.covered) notes.push(data.summary.partial?'Måneden er ikke ferdig. Kortkjøp bokføres ofte noen dager etter kjøpet.':'Ikke alle kontoer har historikk for hele denne måneden.');
  for (const a of data.accounts) {
    if (a.stale) notes.push(a.name+' er ikke oppdatert siste 36 timer.');
    if (a.difference) notes.push(a.name+': saldoendringen avviker '+krExact(a.difference)+' fra posteringene. Sjekk i nettbanken.');
    if (a.skipped) notes.push(a.name+': '+a.skipped+' posteringer kunne ikke tolkes.');
  }
  return notes.length?h('ul',{class:'notes'},notes.map(n=>h('li',{text:n}))):null;
}

// ---------- overview ----------
function overview(){
  const s=data.summary,covered=s.trend.filter(m=>m.covered&&m.month!==s.month),usual=median(covered.slice(-12).map(m=>m.expenseMinor));
  const goal=data.savings.goalMinor;
  const kpis=h('div',{class:'kpis'},
    kpi('Utgifter',kr(s.expenseMinor),usual!=null?'Vanlig måned: '+kr(usual):'Bygger opp historikk'),
    kpi('Inntekter',kr(s.incomeMinor),'Lønn, ytelser og andre innbetalinger'),
    kpi('Spart',kr(data.savings.totalMinor),goal?'Mål '+kr(goal)+(data.savings.totalMinor>=goal?' · nådd':''):'Overført til sparing'),
    kpi('Igjen',kr(s.netMinor),'Inntekter minus utgifter og sparing'));
  const out=[kpis,coverageNotes()];
  const grid=h('div',{class:'grid'});
  if (data.letter) grid.append(letterCard(data.letter));
  const open=data.suggestions.filter(x=>x.status==='open').slice(0,3);
  grid.append(card('Forslag fra agenten',
    open.length?h('div',{class:'list'},open.map(x=>h('div',{class:'item'},h('span',{class:'what'},x.title),h('span',{class:'amount',text:x.estimate?.annualSavingsMinor?kr(x.estimate.annualSavingsMinor)+'/år':''})))):empty(data.agent.enabled?'Ingen nye forslag akkurat nå.':'Økonomiagenten er ikke slått på ennå.'),
    data.realizedThisYearMinor?h('p',{class:'small'},'Dokumentert spart i år: ',h('strong',{text:kr(data.realizedThisYearMinor)+' per år'})):null,
    h('div',{class:'actions'},h('button',{class:'quiet',type:'button',text:'Se alle forslag',onclick:()=>goTab('ideas')}))));
  grid.append(categoryCard(s));
  grid.append(trendCard(s));
  if (data.signals.length) grid.append(card('Verdt en titt',h('div',{class:'list'},data.signals.slice(0,8).map(x=>h('div',{class:'item'},h('span',{class:'what'},h('strong',{text:x.title}),h('br'),h('span',{class:'small muted',text:x.detail})),
    h('span',{class:'amount small',text:x.annualImpactMinor?kr(x.annualImpactMinor)+'/år':''}))))));
  grid.append(savingsCard());
  if (data.settlement) grid.append(settlementCard());
  grid.append(groceryCard());
  out.push(grid);
  return out;
}
function kpi(label,value,sub){return h('div',{class:'kpi'},h('div',{class:'label',text:label}),h('div',{class:'value',text:value}),h('div',{class:'sub',text:sub}));}
function letterCard(letter){
  return h('section',{class:'card letter span-all'},h('h2',{text:letter.title}),h('p',{class:'meta',text:'Økonomibrev for '+monthName(letter.month)+' · skrevet '+dateText(letter.writtenAt)}),
    letter.highlights?.length?h('ul',{},letter.highlights.map(t=>h('li',{text:t}))):null,
    ...letter.body.split(/\n{2,}/).map(p=>h('p',{text:p})));
}
function categoryCard(s){
  const list=s.categories.filter(c=>c.minor>0||c.median12>0).slice(0,14);
  if (!list.length) return card('Hva pengene gikk til',empty('Ingen utgifter registrert i '+monthName(s.month)+'.'));
  const max=Math.max(...list.map(c=>Math.max(c.minor,c.median12??0)),1);
  return card('Hva pengene gikk til',
    h('div',{class:'legend'},h('span',{},h('i'),monthName(s.month)),h('span',{},h('i',{class:'tick'}),'Vanlig måned (median 12 mnd)')),
    h('div',{class:'bars'},list.map(c=>{
      const fill=h('span',{class:'bar-fill'}),track=h('span',{class:'bar-track'},fill);
      fill.style.width=(c.minor/max*100)+'%';
      if (c.median12) {const tick=h('span',{class:'bar-median'});tick.style.left='calc('+(c.median12/max*100)+'% - 1px)';track.append(tick);}
      const row=h('button',{class:'bar-row',type:'button',onclick:()=>goTab('tx',{category:c.key,kind:''})},h('span',{class:'bar-name',text:c.label}),track,h('span',{class:'bar-value',text:kr(c.minor)}));
      tip(row,c.label+': '+kr(c.minor)+(c.median12!=null?' · vanlig '+kr(c.median12):'')+' · trykk for posteringer');
      return row;
    })));
}
function trendCard(s){
  const months=s.trend.slice(-13);
  if (months.length<2) return card('Utgifter per måned',empty('Trenger minst to måneder med data.'));
  const W=640,H=200,pad={l:8,r:8,t:12,b:28},max=Math.max(...months.map(m=>m.expenseMinor),1),bw=(W-pad.l-pad.r)/months.length;
  const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'chart',role:'img','aria-label':'Utgifter per måned siste 13 måneder'});
  chart.append(svg('line',{x1:pad.l,x2:W-pad.r,y1:H-pad.b,y2:H-pad.b,class:'axis'}));
  months.forEach((m,i)=>{
    const height=(H-pad.t-pad.b)*m.expenseMinor/max,x=pad.l+i*bw+2,y=H-pad.b-height;
    const bar=svg('path',{d:`M${x},${H-pad.b} V${y+Math.min(4,height)} q0,-4 4,-4 h${bw-12} q4,0 4,4 V${H-pad.b} Z`,fill:m.month===s.month?'var(--brand)':'var(--bar)',opacity:m.covered||m.month===s.month?1:.45});
    chart.append(bar);
    if (i%2===months.length%2||months.length<8) {const t=svg('text',{x:x+(bw-4)/2,y:H-8,'text-anchor':'middle'});t.textContent=new Date(m.month+'-15').toLocaleDateString('nb-NO',{month:'short'});chart.append(t);}
    const hit=svg('rect',{x:pad.l+i*bw,y:pad.t,width:bw,height:H-pad.t-pad.b,class:'hit',tabindex:0});
    tip(hit,monthName(m.month)+': '+kr(m.expenseMinor)+(m.covered?'':' (ufullstendig)'));
    hit.onclick=()=>{$('#month').value=m.month;refresh().catch(e=>setStatus(e.message,true));};
    chart.append(hit);
  });
  return card('Utgifter per måned',chart,h('p',{class:'small muted',text:'Svake søyler har ufullstendig kontohistorikk. Trykk på en måned for å åpne den.'}));
}
function savingsCard(){
  const s=data.savings;
  return card('Sparing i '+monthName(s.month),
    s.targets.length?h('div',{class:'list'},s.targets.map(t=>h('div',{class:'item'},h('span',{text:t.name}),h('span',{class:'amount',text:kr(t.minor)})))):empty('Ingen sparing registrert denne måneden. Overføringer til sparekontoer og Nordnet/fond telles automatisk når kontoene er koblet til.'),
    s.goalMinor?h('p',{class:'small'},'Mål: '+kr(s.goalMinor)+' per måned · ',h('strong',{text:s.totalMinor>=s.goalMinor?'nådd':kr(s.goalMinor-s.totalMinor)+' igjen'})):null);
}
function settlementCard(){
  const s=data.settlement,owed=s.people.filter(p=>p.balanceMinor<0),ahead=s.people.filter(p=>p.balanceMinor>0);
  return card('Felles utgifter mellom de voksne',
    h('div',{class:'list'},s.people.map(p=>h('div',{class:'item'},h('span',{text:p.name+' betalte'}),h('span',{class:'amount',text:kr(p.paidMinor)})))),
    s.jointMinor?h('p',{class:'small muted',text:'Fra felleskonto: '+kr(s.jointMinor)+' (holdt utenfor oppgjøret).'}):null,
    owed.length&&ahead.length?h('p',{},h('strong',{text:owed[0].name+' kan overføre '+kr(-owed[0].balanceMinor)+' til '+ahead[0].name}),' for å dele likt.'):h('p',{class:'small',text:'Utgiftene er delt omtrent likt.'}),
    h('p',{class:'small muted',text:'Gjelder utgifter merket felles (dagligvarer, bolig, strøm, barn osv.). Endre en mottaker til personlig under Transaksjoner.'}));
}
function groceryCard(){
  const g=data.groceries,q=g.quarter;
  if (!q.totalMinor) return card('Dagligvarer per kjede',empty('Ingen dagligvarekjøp siste 90 dager.'));
  return card('Dagligvarer per kjede',h('p',{class:'small muted',text:'Siste 90 dager: '+kr(q.totalMinor)+'. Siste år: '+kr(g.year.totalMinor)+'.'}),
    h('div',{class:'list'},q.chains.slice(0,8).map(c=>h('div',{class:'item'},h('span',{text:c.chain}),h('span',{class:'amount',text:kr(c.minor)+' · '+Math.round(c.share*100)+' %'})))),
    g.odaShareEstimate!=null?h('p',{class:'small'},'Oda står for omtrent ',h('strong',{text:Math.round(g.odaShareEstimate*100)+' %'}),' av dagligvarekjøpene siste år. Handlemodulen kan bruke dette for å beregne årsbehov riktigere.'):null);
}

// ---------- ideas ----------
function ideas(){
  const out=[];
  const agent=data.agent;
  out.push(h('div',{class:'kpis'},
    kpi('Dokumentert spart i år',kr(data.realizedThisYearMinor),'Bekreftet av senere bankdata'),
    kpi('Åpne forslag',String(data.suggestions.filter(x=>x.status==='open').length),'Sortert etter verdi'),
    kpi('Økonomiagenten',agent.enabled?(agent.running?'Arbeider':'Klar'):'Av',agent.lastReview?'Sist gjennomgang '+dateText(agent.lastReview.at):'Ingen gjennomgang ennå')));
  if (agent.enabled) out.push(h('div',{class:'actions'},h('button',{class:'quiet',type:'button',disabled:agent.requested||agent.running,text:agent.requested?'Agenten er bedt om en gjennomgang':'Be agenten se gjennom nå',
    onclick:act(async()=>{await api('/agent-run',{});await refresh();setStatus('Agenten starter så snart tjenesten er ledig.');})})));
  const list=h('div',{class:'grid'});
  const shown=data.suggestions;
  if (!shown.length) list.append(card(null,empty(agent.enabled?'Agenten har ingen forslag ennå. Forslagene kommer etter første gjennomgang.':'Slå på økonomiagenten i finance.json for å få forslag.')));
  for (const s of shown) list.append(suggestionCard(s));
  out.push(h('h2',{text:'Forslag'}),list);
  out.push(h('h2',{text:'Spør agenten'}),h('div',{class:'grid'},questionCard()));
  out.push(h('h2',{text:'Betalinger'}),h('div',{class:'grid'},paymentsCard(),payeesCard()));
  return out;
}
function suggestionCard(s){
  const save=s.status==='realized'?s.realization?.annualSavingsMinor:s.estimate?.annualSavingsMinor;
  const node=h('section',{class:'card suggestion'+(s.status==='realized'?' realized':'')},
    h('div',{class:'head'},h('div',{},h('h3',{text:s.title}),h('span',{class:'pill',text:KIND_TEXT[s.kind]||s.kind}),h('span',{class:'pill '+(s.status==='realized'?'good':s.status==='open'?'':'warn'),text:STATUS_TEXT[s.status]})),
      h('div',{class:'save',text:save?kr(save)+'/år':''})),
    h('p',{text:s.summary}),
    s.steps?.length?h('ol',{},s.steps.map(t=>h('li',{text:t}))):null,
    s.dueDate?h('p',{class:'small'},'Frist: ',h('strong',{text:dateText(s.dueDate)})):null);
  if (s.draft) {
    const text=[s.draft.to?'Til: '+s.draft.to:null,s.draft.subject?'Emne: '+s.draft.subject:null,'',s.draft.body].filter(x=>x!=null).join('\n');
    node.append(h('details',{},h('summary',{text:'Utkast du kan sende selv'}),h('pre',{class:'draft',text}),
      h('button',{class:'quiet',type:'button',text:'Kopier utkastet',onclick:act(async()=>{await navigator.clipboard.writeText(text);setStatus('Utkastet er kopiert.');})})));
  }
  const rows=s.evidence.rowIds.map(id=>data.evidence[id]).filter(Boolean);
  if (rows.length||s.evidence.sources.length||s.evidence.reasoning) node.append(h('details',{},h('summary',{text:'Grunnlag'}),
    s.evidence.reasoning?h('p',{class:'small',text:s.evidence.reasoning}):null,
    s.estimate?.basis?h('p',{class:'small muted',text:'Anslag: '+s.estimate.basis}):null,
    rows.length?h('div',{class:'list small'},rows.map(rowLine)):null,
    s.evidence.sources.length?h('ul',{class:'small'},s.evidence.sources.map(src=>h('li',{},h('a',{href:src.url,target:'_blank',rel:'noopener noreferrer',text:src.note}),' · lest '+dateText(src.observedAt)))):null));
  if (s.status==='realized') node.append(h('p',{class:'small'},s.realization.kind==='stopped'?'Ingen nye trekk siden du avsluttet. ':'Nytt beløp '+kr(s.realization.amountMinor)+' fra '+dateText(s.realization.date)+'. ','Bekreftet av bankdata.'));
  const actions=h('div',{class:'actions'}),choose=(action,extra={})=>act(async()=>{await api('/suggestion',{id:s.id,action,...extra});await refresh();});
  if (s.status==='open'||s.status==='snoozed') {
    actions.append(h('button',{type:'button',text:s.action?.type==='oda-share'?'Bruk i handlemodulen':'Jeg gjør dette',onclick:choose('accept')}));
    actions.append(h('button',{class:'quiet',type:'button',text:'Utsett en måned',onclick:choose('snooze')}));
    const reason=h('input',{type:'text',placeholder:'Hvorfor ikke? (valgfritt)',maxlength:400});
    actions.append(h('button',{class:'quiet',type:'button',text:'Ikke aktuelt',onclick:act(async()=>{await api('/suggestion',{id:s.id,action:'dismiss',reason:reason.value||null});await refresh();})}),reason);
  } else if (s.status==='accepted') {
    actions.append(h('span',{class:'small muted',text:'Merket som gjort '+dateText(s.acceptedAt)+'. Spart beløp registreres når neste trekk viser endringen.'}));
    actions.append(h('button',{class:'quiet',type:'button',text:'Angre',onclick:choose('reopen')}));
  }
  const question=h('input',{type:'text',placeholder:'Spør agenten om dette forslaget',maxlength:1000});
  actions.append(h('form',{class:'inline-form',onsubmit:act(async event=>{event.preventDefault();if(!question.value.trim())return;await api('/suggestion',{id:s.id,action:'ask',question:question.value});question.value='';await refresh();setStatus('Spørsmålet er sendt til agenten.');})},question,h('button',{class:'quiet',text:'Spør'})));
  node.append(actions);
  return node;
}
function questionCard(){
  const text=h('textarea',{placeholder:'For eksempel: Hvorfor var oktober så dyr? Hva betaler vi for forsikring i året?',maxlength:1000});
  return card(null,h('form',{onsubmit:act(async event=>{event.preventDefault();if(!text.value.trim())return;await api('/question',{text:text.value});text.value='';await refresh();setStatus('Spørsmålet er sendt. Agenten svarer her.');})},text,h('div',{class:'actions'},h('button',{text:'Send spørsmål'}))),
    data.questions.length?h('div',{class:'list'},data.questions.map(q=>h('details',{open:q.status==='answered'&&Date.now()-Date.parse(q.answeredAt)<7*86400000},
      h('summary',{},q.text,h('span',{class:'pill '+(q.status==='answered'?'good':''),text:q.status==='answered'?'Besvart':'Venter'})),
      q.answer?q.answer.split(/\n{2,}/).map(p=>h('p',{text:p})):h('p',{class:'small muted',text:'Stilt '+timeText(q.at)+' av '+q.by+'.'})))):null);
}
function paymentsCard(){
  const list=data.payments.filter(p=>p.status!=='paid'||Date.now()-Date.parse(p.updatedAt||p.createdAt)<30*86400000);
  return card('Betalingsforslag',h('p',{class:'small muted',text:'Agenten kontrollerer regninger mot mottakerne dere har godkjent. Selve betalingen gjør dere i banken med BankID; forslaget merkes betalt når trekket dukker opp.'}),
    list.length?h('div',{class:'list'},list.map(p=>{
      const details=['Mottaker: '+p.payee.name,'Konto: '+p.payee.account,p.payee.kid?'KID: '+p.payee.kid:null,p.payee.message?'Melding: '+p.payee.message:null,'Beløp: '+krExact(p.amountMinor),'Forfall: '+p.dueDate].filter(Boolean).join('\n');
      return h('div',{class:'item'},h('div',{class:'what'},h('strong',{text:p.payee.name+' · '+krExact(p.amountMinor)}),h('span',{class:'pill '+(p.status==='paid'?'good':p.status==='approved'?'warn':''),text:{open:'Til godkjenning',approved:'Betales av dere',paid:'Betalt',rejected:'Avvist'}[p.status]}),
        h('br'),h('span',{class:'small muted',text:'Forfall '+dateText(p.dueDate)+' · '+p.evidence.source}),
        p.status==='open'||p.status==='approved'?h('div',{class:'actions'},
          h('button',{class:'quiet',type:'button',text:'Kopier betalingsinfo',onclick:act(async()=>{await navigator.clipboard.writeText(details);setStatus('Betalingsinformasjonen er kopiert.');})}),
          p.status==='open'?h('button',{type:'button',text:'Jeg betaler denne',onclick:act(async()=>{await api('/payment',{id:p.id,action:'approve'});await refresh();})}):null,
          h('button',{class:'quiet',type:'button',text:'Allerede betalt',onclick:act(async()=>{await api('/payment',{id:p.id,action:'paid'});await refresh();})}),
          h('button',{class:'quiet',type:'button',text:'Avvis',onclick:act(async()=>{await api('/payment',{id:p.id,action:'reject'});await refresh();})})):null));
    })):empty('Ingen betalingsforslag.'));
}
function payeesCard(){
  const name=h('input',{placeholder:'Navn, f.eks. Barnehagen',maxlength:80,required:true}),account=h('input',{placeholder:'Kontonummer',inputmode:'numeric',required:true}),max=h('input',{placeholder:'Maks kr',inputmode:'decimal',required:true});
  return card('Godkjente betalingsmottakere',h('p',{class:'small muted',text:'Agenten kan bare foreslå betalinger til disse, og aldri over maksbeløpet.'}),
    data.paymentRules.length?h('div',{class:'list'},data.paymentRules.map(r=>h('div',{class:'item'},h('span',{class:'what',text:r.name+' · '+r.account}),h('span',{class:'amount'},'maks '+kr(r.maxAmountMinor),' ',
      h('button',{class:'quiet',type:'button',text:'Fjern',onclick:act(async()=>{await api('/payment-rule',{id:r.id,remove:true});await refresh();})}))))):empty('Ingen godkjente mottakere ennå.'),
    h('form',{class:'inline-form',onsubmit:act(async event=>{event.preventDefault();await api('/payment-rule',{name:name.value,account:account.value,maxAmountNok:Number(max.value.replace(',','.'))});await refresh();})},name,account,max,h('button',{text:'Legg til'})));
}

// ---------- fixed costs ----------
function fixed(){
  const list=data.recurring;
  const total=list.filter(r=>r.kind==='expense').reduce((n,r)=>n+r.annualMinor,0);
  const table=h('table',{},h('thead',{},h('tr',{},['Mottaker','Kategori','Hvor ofte','Vanlig beløp','Per år','Sist','Neste'].map((t,i)=>h('th',{class:i>=3&&i<=4?'num':null,text:t})))),
    h('tbody',{},list.map(r=>h('tr',{},h('td',{},r.merchant,r.priceChangeMinor>0?h('span',{class:'pill warn',text:'+'+kr(r.priceChangeMinor)}):null,r.kind==='saving'?h('span',{class:'pill good',text:'sparing'}):null),
      h('td',{text:r.category?data.categories[r.category]:'–'}),h('td',{text:CADENCE_TEXT[r.cadence]}),h('td',{class:'num',text:kr(r.typicalMinor)}),h('td',{class:'num',text:kr(r.annualMinor)}),
      h('td',{text:dateText(r.lastDate)}),h('td',{text:dateText(r.nextDate)})))));
  const loan=data.loans;
  return [h('div',{class:'kpis'},kpi('Faste utgifter per år',kr(total),list.filter(r=>r.kind==='expense').length+' faste trekk funnet'),kpi('Per måned',kr(total/12),'Gjennomsnitt'),
      loan?.payments?kpi('Lånerenter siste 12 mnd',kr(loan.interestMinor),loan.interestOnly?'Avdragsfritt: ingen nedbetaling på lånet':'Avdrag '+kr(loan.principalMinor)+' · gebyrer '+kr(loan.feesMinor)):null),
    h('section',{class:'card'},h('h2',{text:'Faste trekk og abonnementer'}),list.length?h('div',{class:'table-scroll'},table):empty('Trenger noen måneder med historikk for å finne faste trekk.'),
      h('p',{class:'small muted',text:'Funnet automatisk fra trekk som gjentar seg med jevne mellomrom. En prismarkering betyr at siste trekk var høyere enn vanlig.'}))];
}

// ---------- forecast ----------
function forecastView(){
  const f=data.forecast;
  const out=[h('div',{class:'kpis'},kpi('Disponibelt nå',kr(f.startMinor),f.accounts.length?f.accounts.length+' bruks- og felleskontoer':'Ingen brukskontoer'),kpi('Laveste punkt',kr(f.lowest.minor),dateText(f.lowest.date)),kpi('Løpende forbruk',kr(f.dailyVariableMinor*30)+'/mnd','Snitt siste 90 dager utenom faste trekk'))];
  out.push(h('section',{class:'card'},h('h2',{text:'Saldo neste 60 dager'}),lineChart(f),h('p',{class:'small muted',text:'Anslag fra faste trekk, lønn, planlagte utgifter og vanlig løpende forbruk. Ikke en garanti.'})));
  const label=h('input',{placeholder:'Hva, f.eks. Cup i Danmark',maxlength:120,required:true}),date=h('input',{type:'date',required:true}),amount=h('input',{placeholder:'Kr',inputmode:'decimal',required:true});
  out.push(h('div',{class:'grid'},
    card('Kommende',f.events.length?h('div',{class:'list'},f.events.map(e=>h('div',{class:'item'},h('span',{class:'what'},dateText(e.date)+' · '+e.label,e.kind==='planned'?h('span',{class:'pill',text:'planlagt'}):null),h('span',{class:'amount '+(e.minor<0?'neg':'pos'),text:kr(e.minor)})))):empty('Ingen kjente trekk de neste 60 dagene.')),
    card('Planlagte utgifter',h('p',{class:'small muted',text:'Ting dere vet kommer, som turer, cuper og årlige regninger. Agenten legger også inn det den finner i kalenderen.'}),
      data.planned.length?h('div',{class:'list'},data.planned.map(p=>h('div',{class:'item'},h('span',{class:'what',text:dateText(p.date)+' · '+p.label}),h('span',{class:'amount'},kr(p.amountMinor),' ',
        h('button',{class:'quiet',type:'button',text:'Fjern',onclick:act(async()=>{await api('/planned',{key:p.key,remove:true});await refresh();})}))))):null,
      h('form',{class:'inline-form',onsubmit:act(async event=>{event.preventDefault();await api('/planned',{label:label.value,date:date.value,amountNok:Number(amount.value.replace(',','.'))});await refresh();})},label,date,amount,h('button',{text:'Legg til'})))));
  return out;
}
function lineChart(f){
  const points=[{date:new Date().toISOString().slice(0,10),minor:f.startMinor},...f.points];
  const W=640,H=220,pad={l:12,r:12,t:16,b:28};
  const values=points.map(p=>p.minor),min=Math.min(0,...values),max=Math.max(...values,1);
  const x=i=>pad.l+(W-pad.l-pad.r)*i/(points.length-1),y=v=>pad.t+(H-pad.t-pad.b)*(max-v)/(max-min||1);
  const chart=svg('svg',{viewBox:`0 0 ${W} ${H}`,class:'chart',role:'img','aria-label':'Forventet disponibel saldo neste 60 dager'});
  chart.append(svg('line',{x1:pad.l,x2:W-pad.r,y1:H-pad.b,y2:H-pad.b,class:'axis'}));
  if (min<0) chart.append(svg('line',{x1:pad.l,x2:W-pad.r,y1:y(0),y2:y(0),class:'zero'}));
  for (const [value,yy] of [[max,pad.t+10],[min,H-pad.b-6]]) {const t=svg('text',{x:W-pad.r,y:yy,'text-anchor':'end'});t.textContent=kr(value);chart.append(t);}
  chart.append(svg('path',{class:'line',d:points.map((p,i)=>(i?'L':'M')+x(i)+','+y(p.minor)).join(' ')}));
  points.forEach((p,i)=>{
    chart.append(svg('circle',{class:'dot',cx:x(i),cy:y(p.minor),r:4}));
    if (i%2===0||i===points.length-1) {const t=svg('text',{x:x(i),y:H-8,'text-anchor':i===0?'start':i===points.length-1?'end':'middle'});t.textContent=new Date(p.date).toLocaleDateString('nb-NO',{day:'numeric',month:'short'});chart.append(t);}
    const hit=svg('rect',{x:x(i)-(W/points.length)/2,y:0,width:W/points.length,height:H,class:'hit',tabindex:0});
    tip(hit,dateText(p.date)+': '+kr(p.minor));chart.append(hit);
  });
  return chart;
}

// ---------- transactions ----------
function transactionsView(){
  const panel=h('div',{});
  const category=h('select',{'aria-label':'Kategori'},h('option',{value:'',text:'Alle kategorier'}),Object.entries(data.categories).map(([k,v])=>h('option',{value:k,text:v,selected:txFilter.category===k})));
  const kind=h('select',{'aria-label':'Type'},h('option',{value:'',text:'Alle typer'}),Object.entries(TX_KIND).map(([k,v])=>h('option',{value:k,text:v,selected:txFilter.kind===k})));
  const search=h('input',{type:'search',placeholder:'Søk etter butikk eller tekst',value:txFilter.q});
  const list=h('div',{class:'card'},h('p',{class:'muted',text:'Henter posteringer …'}));
  const load=async()=>{
    txFilter={category:category.value,kind:kind.value,q:search.value};
    const query=new URLSearchParams({month:month(),...Object.fromEntries(Object.entries(txFilter).filter(([,v])=>v))});
    const result=await api('/transactions?'+query);
    const sum=result.rows.filter(r=>r.currency==='NOK').reduce((n,r)=>n+r.minor,0);
    list.replaceChildren(h('p',{class:'small muted',text:result.total+' posteringer i '+monthName(month())+(result.total>result.rows.length?' (viser '+result.rows.length+')':'')+' · sum '+krExact(sum)}),
      ...(result.rows.length?result.rows.map(txRow):[empty('Ingen posteringer med dette utvalget.')]));
  };
  category.onchange=kind.onchange=act(load);let timer;search.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>load().catch(e=>setStatus(e.message,true)),300);};
  panel.append(h('div',{class:'filters'},category,kind,search),list);
  load().catch(error=>{if(error.status===401)return showLock(error.body);setStatus(error.message,true);});
  return [panel];
}
function txRow(r){
  const select=h('select',{'aria-label':'Ny kategori'},Object.entries(data.categories).map(([k,v])=>h('option',{value:k,text:v,selected:r.category===k})));
  const scope=h('select',{'aria-label':'Gjelder'},h('option',{value:'merchant',text:'Alle fra '+r.merchant}),h('option',{value:'row',text:'Bare denne posteringen'}));
  const save=set=>act(async()=>{await api('/rule',{match:scope.value==='row'?{rowId:r.id}:{merchantKey:r.merchantKey},set});await refresh();setStatus('Lagret. Tallene er regnet om.');});
  return h('details',{class:'tx'},h('summary',{},h('span',{class:'small',text:r.date}),h('span',{class:'what'},r.merchant,h('br'),h('span',{class:'cat',text:(r.category?data.categories[r.category]:TX_KIND[r.kind])+(r.shared&&r.kind==='expense'?' · felles':'')})),
      h('span',{class:'amount '+(r.minor<0?'neg':'pos'),text:krExact(r.minor,r.currency)})),
    h('div',{class:'tx-body'},h('span',{class:'small muted',text:[r.accountName,r.label!==r.merchant?r.label:null,r.text,r.purchaseDate?'kjøpt '+r.purchaseDate:null].filter(Boolean).join(' · ')}),
      h('div',{class:'inline-form'},select,scope,h('button',{class:'quiet',type:'button',text:'Lagre kategori',onclick:save({category:select.value,kind:'expense'})})),
      h('div',{class:'actions'},
        h('button',{class:'quiet',type:'button',text:'Mellom egne kontoer',onclick:save({kind:'internal'})}),
        h('button',{class:'quiet',type:'button',text:'Dette er sparing',onclick:save({kind:'saving'})}),
        r.kind==='expense'?h('button',{class:'quiet',type:'button',text:r.shared?'Gjør personlig':'Gjør felles',onclick:save({shared:!r.shared})}):null)));
}

// ---------- accounts ----------
function accounts(){
  const me=data.people.find(p=>p.me);
  const out=[];
  const people=card('Voksne og banker',h('div',{class:'list'},data.people.map(p=>h('div',{class:'item'},h('span',{class:'what'},h('strong',{text:p.name+(p.me?' (deg)':'')}),h('br'),
    h('span',{class:'small muted',text:p.setupIssue?'Venter på oppsett på PC-en':data.connections.filter(c=>c.owner===p.id).map(c=>c.bank).join(', ')||'Ingen bank koblet til'}))))));
  out.push(h('div',{class:'grid'},people,connectCard(me)));
  const connections=data.connections;
  if (connections.length) out.push(h('section',{class:'card'},h('h2',{text:'Banktilkoblinger'}),h('div',{class:'list'},connections.map(c=>{
    const left=Date.parse(c.expires)-Date.now();
    return h('div',{class:'item'},h('span',{class:'what'},h('strong',{text:c.bank+' · '+c.ownerName}),h('br'),h('span',{class:'small muted',text:(left<=0?'Samtykket har utløpt':'Samtykke til '+dateText(c.expires))+' · '+c.accounts+' kontoer · sist lest '+timeText(c.attempt)+(c.issue?' · '+c.issue:'')})),
      c.mine?h('span',{class:'actions'},h('button',{class:left<14*86400000?'':'quiet',type:'button',text:'Forny',onclick:act(()=>connect(c.bank))}),
        h('button',{class:'quiet',type:'button',text:'Koble fra',onclick:act(async()=>{if(!confirm('Koble fra '+c.bank+'? Banksamtykket trekkes tilbake. Historikken som er hentet blir liggende.'))return;await api('/disconnect',{connection:c.id});await refresh();})})):null);
  }))));
  out.push(h('section',{class:'card'},h('h2',{text:'Kontoer'}),data.accounts.length?h('div',{class:'table-scroll'},h('table',{},
    h('thead',{},h('tr',{},['Konto','Bank','Type','Saldo','Oppdatert','Historikk fra','Kontroll'].map((t,i)=>h('th',{class:i===3?'num':null,text:t})))),
    h('tbody',{},data.accounts.map(a=>{
      const role=h('select',{'aria-label':'Kontotype for '+a.name,disabled:!a.own},Object.entries(data.roles).map(([k,v])=>h('option',{value:k,text:v,selected:a.role===k})));
      role.onchange=act(async()=>{await api('/account',{account:a.key,role:role.value});await refresh();setStatus('Kontotypen er lagret og tallene regnet om.');});
      const label=h('input',{value:a.name,maxlength:60,'aria-label':'Navn på konto',disabled:!a.own});
      label.onchange=act(async()=>{await api('/account',{account:a.key,label:label.value});await refresh();setStatus('Kontonavnet er lagret.');});
      return h('tr',{},h('td',{},label),h('td',{text:a.bank||'–'}),h('td',{},role),h('td',{class:'num',text:a.balance?krExact(a.balance.minor,a.balance.currency):'–'}),
        h('td',{text:timeText(a.syncedAt)}),h('td',{text:dateText(a.firstDate)}),
        h('td',{},a.difference===null?h('span',{class:'pill',text:'Første måling'}):a.difference===0?h('span',{class:'pill good',text:'Stemmer'}):h('span',{class:'pill bad',text:'Avvik '+krExact(a.difference)})));
    })))):empty('Ingen kontoer er lest inn ennå.'),
    h('p',{class:'small muted',text:'Kontotypen styrer beregningene: overføringer til sparekontoer telles som sparing, kredittkortkjøp som forbruk og betaling av kortregningen som overføring. Barnas kontoer regnes ikke med i disponible penger.'})));
  return out;
}
function connectCard(me){
  const select=h('select',{'aria-label':'Velg bank'},h('option',{value:'',text:bankList?'Velg bank':'Henter banker …'}));
  const fill=()=>{select.replaceChildren(h('option',{value:'',text:'Velg bank'}),...(bankList||[]).map(b=>h('option',{value:b.name,text:b.name})));};
  if (bankList) fill();
  else if (!me?.setupIssue) api('/banks').then(r=>{bankList=r.banks;fill();}).catch(e=>{select.replaceChildren(h('option',{value:'',text:'Kunne ikke hente banklisten'}));setStatus(e.message,true);});
  return card('Koble til en bank',me?.setupIssue?h('p',{text:me.setupIssue}):h('div',{},
    h('p',{class:'small muted',text:'Koble til alle kontoene dine, også kredittkort og sparekontoer i andre banker. Du godkjenner lesetilgang med BankID hos banken. Tilgangen er bare lesing.'}),
    h('div',{class:'inline-form'},select,h('button',{type:'button',text:'Koble til',onclick:act(async()=>{if(!select.value)throw Error('Velg bank først.');await connect(select.value);})}))));
}
async function connect(bank){const {url}=await api('/connect',{bank});location.assign(url);}

// ---------- boot ----------
document.querySelector('.tabs').onclick=event=>{const button=event.target.closest('button[data-tab]');if(button)goTab(button.dataset.tab);};
$('#unlock').onsubmit=act(async event=>{event.preventDefault();await api('/unlock',{pin:$('#pin').value});$('#pin').value='';await refresh();});
$('#lock').onclick=act(async()=>{await api('/lock',{});data=null;$('#app').hidden=true;
  if (location.pathname.startsWith('/send/')) {location.assign('/send/');return;}
  showLock({pinAvailable:true});});
$('#month').onchange=act(()=>refresh());
if (!API.startsWith('/send')) {$('#home').href='/';}
const now=new Date();$('#month').value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
await act(async()=>{
  const query=new URLSearchParams(location.search);
  if (location.search) history.replaceState(null,'',location.pathname);
  if (query.has('code')) {
    setStatus('Bekrefter samtykket hos banken …');
    const result=await api('/confirm',{state:query.get('state'),code:query.get('code')});
    sessionStorage.setItem('financeConfirmed',result.bank+' er koblet til med '+result.accounts+' kontoer. Historikken hentes automatisk, og du kan lukke denne fanen.');
  } else if (query.has('error')) throw Error('Banktilkoblingen ble avbrutt. Åpne økonomi på nytt for å prøve igjen.');
  await refresh();
})();
