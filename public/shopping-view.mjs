// Family-facing shopping page, shared by the dashboard and the phone app.
// Polling only touches the banner, so reading and typing are never interrupted.
import {PANTRY_GROUPS,pantryGroup} from './pantry-groups.mjs';
const nf=(digits)=>new Intl.NumberFormat('nb-NO',{maximumFractionDigits:digits});
const kr=value=>`${nf(0).format(value)} kr`;
const price=value=>`${nf(2).format(value)} kr`;
const amount=(value,unit)=>`${nf(value<10?1:0).format(value)} ${unit}`;
const dayLabel=day=>new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',weekday:'short',day:'numeric',month:'short'}).format(new Date(day+'T12:00:00Z')).replace(/\.$/,'');
const monthsText=months=>months<1?'noen uker':`${nf(0).format(months)} mnd`;

function el(tag,text,cls) {
  const node=document.createElement(tag);
  if(text!==undefined&&text!==null)node.textContent=text;
  if(cls)node.className=cls;
  return node;
}
function button(label,action,cls) {
  const node=el('button',label,cls);
  node.type='button';
  node.onclick=action;
  return node;
}
function link(label,url) {
  const node=el('a',label);
  node.href=url;node.target='_blank';node.rel='noopener noreferrer';
  return node;
}
function field(label,control) {
  const wrap=el('label',label,'shop-field');
  wrap.append(control);
  return wrap;
}

const SHELF_CHOICES=[[1,'1 mnd'],[3,'3 mnd'],[6,'6 mnd'],[9,'9 mnd'],[12,'1 år']];
const LOCATIONS=[['all','Alt'],['frozen','Fryser'],['pantry','Tørrvarer'],['chilled','Kjøl']];
const TIER_LABEL={excellent:'Svært bra pris',good:'Bra pris',small:'Liten rabatt'};
const BASIS_TEXT={'documented-purchases':'ut fra registrerte kjøp, også utenfor Oda','household-estimate':'etter det dere har oppgitt','planned-amount':'etter planlagt årsmengde','oda-lower-bound':'minst dette, ut fra kjøpene hos Oda','oda-share-estimate':'anslått ut fra Oda-kjøpene og hvor stor del av handelen de er'};
const HELD_TEXT={member:'krever medlemskap vi ikke har registrert','needs-review':'venter på at en vare sjekkes','stale-prices':'venter på ferske priser'};

export function refreshDraftChoices(edits,previous=[],next=[]) {
  const before=new Map(previous.map(x=>[x.watchId,x])),after=new Map(next.map(x=>[x.watchId,x]));
  for(const [id,state] of edits){
    const old=before.get(id),item=after.get(id);
    if(!old||!item){edits.delete(id);continue;}
    const same=old.productId===item.productId&&old.packAmount===item.packAmount&&old.unit===item.unit;
    const userPacks=state.userPacks??state.packs!==old.packs,userOn=state.userOn??state.on!==!old.elsewhere;
    state.packs=same&&userPacks?Math.min(item.maxAtOda??100,Math.max(1,state.packs)):item.packs;
    state.on=userOn?state.on:!item.elsewhere;
    state.userPacks=!!(same&&userPacks);state.userOn=!!userOn;
  }
}

/** Lines that are cheaper elsewhere come first, the biggest saving on top. */
export function splitCheaper(rows,saving=row=>row.savings?.annual??0) {
  return {cheaper:rows.filter(x=>x.places?.length).sort((a,b)=>saving(b)-saving(a)),rest:rows.filter(x=>!x.places?.length)};
}

export function installShoppingView({panel,banner=null,onOpen=()=>{},base='/api/shopping',compact=false}) {
  const draftEdits=new Map(),cartState=new Map(),cartIds=new Map();let cartBusy=false;
  const check={itemId:null,query:'',price:'',size:null,custom:'',customUnit:null};
  let listNeed='later',cart=null,cartHolder=null,draftSync=null;
  const cartPending=new Map();
  const stockDraft={text:'',location:'',mode:'minimum',files:[],intakeId:null,clientId:crypto.randomUUID()},stockPreviews=new Map();let stockSending=false;
  let dirty=false,data=null,tab='buy',search='',location='all',stale=false,odaQuery='',toastTimer=null;
  const chosen=new Map(),openSections=new Set(['draft-elsewhere']);
  panel.classList.add('shop');
  const toastNode=el('div',undefined,'shop-toast');toastNode.setAttribute('role','status');toastNode.hidden=true;

  async function api(path,input) {
    const response=await fetch(base+path,{...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify(input)}),credentials:'same-origin',signal:AbortSignal.timeout(path==='/oda/sync'?300000:45000)});
    const body=await response.json();
    if(!response.ok)throw Error(body.error??'Noe gikk galt. Prøv igjen.');
    return body;
  }
  const visible=()=>compact?!panel.hidden:panel.classList.contains('active');
  function toast(message,undo,label='Angre') {
    clearTimeout(toastTimer);
    toastNode.replaceChildren(el('span',message));
    if(undo)toastNode.append(button(label,undo));
    toastNode.hidden=false;
    toastTimer=setTimeout(()=>{toastNode.hidden=true;},undo?9000:4000);
  }
  function fail(error){toast(error.message);}
  function updateBanner(summary) {
    if(!banner)return;
    banner.hidden=!summary.dealCount;
    banner.replaceChildren();
    if(!summary.dealCount)return;
    const lead=summary.excellentCount?`Svært bra pris på ${summary.top}`:`${summary.dealCount} ${summary.dealCount===1?'godt kjøp':'gode kjøp'} denne uka`;
    banner.append(button(`${lead} · spar ${kr(summary.potential)} · se Handel`,onOpen));
  }
  async function load() {
    const next=await api('/family');
    refreshDraftChoices(draftEdits,data?.odaDraft.items??[],next.odaDraft.items);
    data=next;
    stale=false;
    updateBanner({...data.summary});
  }
  async function act(fn,message,undo,undoLabel) {
    try{await fn();await load();render(true);const text=typeof message==='function'?message():message;if(text)toast(text,undo,undoLabel);}catch(error){fail(error);}
  }
  async function poll() {
    try{
      const summary=await api('/summary');
      updateBanner(summary);
      if(data&&summary.rev!==data.rev&&visible()){
        // The shared list follows what others tick off, unless someone is typing.
        if((tab==='list'&&!cartBusy||tab==='pantry'&&!stockSending)&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){await load();render(true);}
        else if(!stale){stale=true;panel.querySelector('.shop-refresh')?.removeAttribute('hidden');}
      }
    }catch{}
  }

  function details(id,summary,build,cls) {
    const node=el('details',undefined,cls);
    node.open=openSections.has(id);
    node.ontoggle=()=>{if(node.isConnected){if(node.open)openSections.add(id);else openSections.delete(id);}};
    node.append(el('summary',summary));
    build(node);
    return node;
  }
  function chips(options,selected,onPick,label) {
    const row=el('div',undefined,'shop-chips');
    row.setAttribute('role','group');row.setAttribute('aria-label',label);
    for(const [value,text] of options){
      const chip=button(text,()=>onPick(value),value===selected?'on':'');
      chip.setAttribute('aria-pressed',String(value===selected));
      row.append(chip);
    }
    return row;
  }
  const packLabel=(size,unit)=>{
    if(unit==='kg')return size<1?`${Math.round(size*100)*10} g`:`${nf(2).format(size)} kg`;
    if(unit==='l')return size<1?`${nf(1).format(size*10)} dl`:`${nf(2).format(size)} l`;
    return size===1?'stk':`${nf(0).format(size)} stk`;
  };
  function stockSummary(item) {
    if(!item.stock.known)return 'Ikke registrert';
    if(item.stock.amount<=0)return 'Tomt';
    const parts=item.packs.filter(p=>p.count>0).map(p=>`${p.count} × ${packLabel(p.amount,item.unit)}`);
    const what=parts.length?parts.join(' + '):amount(item.stock.amount,item.unit);
    return item.stock.months!=null?`${what} · rekker ${item.stock.months<1?'noen uker':`ca. ${monthsText(item.stock.months)}`}`:what;
  }
  // Tapping is saved shortly after the last tap, so a count of six is one request.
  function stockEditor(item,afterSave,{confirm=false}={}) {
    const done=confirm?button('Ferdig',()=>save(),'shop-stock-done'):null;
    const wrap=el('div',undefined,'shop-stock'),counts=new Map(item.packs.map(p=>[p.amount,p.count])),values=new Map();
    let timer=null;
    const save=async()=>{
      clearTimeout(timer);timer=null;
      try{
        const reply=await api('/pantry',{watchId:item.id,packs:[...counts].map(([size,count])=>({amount:size,count}))});
        const index=data.items.findIndex(x=>x.id===item.id);
        if(index>=0)data.items[index]={...data.items[index],...reply.item,stockEvidence:null};
        dirty=true;afterSave(reply.item);
      }catch(error){fail(error);}
    };
    const change=(size,delta)=>{counts.set(size,Math.max(0,counts.get(size)+delta));values.get(size).textContent=String(counts.get(size));if(confirm){done.hidden=false;return;}clearTimeout(timer);timer=setTimeout(save,700);};
    for(const pack of item.packs){
      const row=el('div',undefined,'shop-step'),label=packLabel(pack.amount,item.unit),value=el('span',String(pack.count),'shop-step-value');
      values.set(pack.amount,value);
      const less=button('−',()=>change(pack.amount,-1)),more=button('+',()=>change(pack.amount,1));
      less.setAttribute('aria-label',`Én færre ${label}`);more.setAttribute('aria-label',`Én mer ${label}`);
      row.append(less,value,more,el('span',item.unit==='stk'&&pack.amount===1?'stk':`pk à ${label}`,'shop-step-label'));
      wrap.append(row);
    }
    const empty=button('Tomt',()=>{for(const size of counts.keys()){counts.set(size,0);values.get(size).textContent='0';}save();},'shop-empty');
    wrap.append(empty);
    if(done){done.hidden=true;wrap.append(done);}
    return wrap;
  }

  // The living-room display has no browser chrome, so a new tab has no way back.
  const isKiosk=()=>document.body.classList.contains('kiosk');
  async function sourceDialog(deal) {
    const box=el('dialog',undefined,'shop-dialog shop shop-source-dialog');
    const head=el('div',undefined,'shop-source-head'),holder=el('div','Henter kilden …','shop-source-body');
    const close=()=>{holder.cleanup?.();box.close();box.remove();};
    head.append(el('h2',`${deal.watchName} · ${deal.storeName}`),button('Lukk',close,'primary'));
    box.append(head,holder);box.oncancel=event=>{event.preventDefault();close();};
    document.body.append(box);box.showModal();
    try{
      const info=await api(`/source?offerId=${encodeURIComponent(deal.offerId)}`);
      if(!box.isConnected)return;
      if(info.kind==='pdf'){
        const {renderPdf}=await import('/document-viewer.mjs');
        await renderPdf(holder,`${base}/source/file?offerId=${encodeURIComponent(deal.offerId)}`,{page:info.page??1});
      }else{
        const qr=el('img',undefined,'shop-qr');qr.src=info.qr;qr.alt='QR-kode til tilbudet';
        holder.replaceChildren(qr,el('p','Denne kilden kan ikke vises her. Skann koden for å åpne den på mobilen.','shop-sub'));
      }
    }catch(error){if(box.isConnected)holder.textContent=error.message;}
  }

  // ---- Kjøp nå ----
  function dealCard(deal) {
    const card=el('article',undefined,'shop-deal '+deal.tier);
    const option=deal.options.find(x=>x.key===chosen.get(deal.offerId))??deal.options.find(x=>x.key===deal.recommendedKey)??deal.options[0];
    const badges=el('div',undefined,'shop-badges');
    badges.append(el('span',TIER_LABEL[deal.tier],'shop-badge '+deal.tier));
    if(deal.lowestSeen)badges.append(el('span','Laveste vi har sett','shop-badge low'));
    if(deal.validFrom>data.today)badges.append(el('span',`Fra ${dayLabel(deal.validFrom)}`,'shop-badge later'));
    const sourceLabel=`Se tilbudet hos ${deal.storeName.replace(/\s*\(.*\)$/,'')}`;
    const source=isKiosk()?button(sourceLabel,()=>sourceDialog(deal),'shop-source'):link(`${sourceLabel} ↗`,deal.sourceUrl);
    if(!isKiosk())source.className='shop-source';
    card.append(badges,el('h4',deal.watchName),el('p',deal.name,'shop-sub'),source);
    const line=el('p',undefined,'shop-price');
    line.append(el('strong',`${price(deal.unitPrice)}/${deal.unit}`),el('span',` · ${deal.referenceType==='target'?'grensen er':'vanlig'} ${price(deal.referencePrice)}/${deal.unit}${deal.discountPct>=1?` · ${nf(0).format(deal.discountPct)} % lavere`:''}`));
    card.append(line);
    if(deal.options.length>1){
      card.append(chips(deal.options.map(x=>[x.key,`${x.label} · ${x.packs} pk`]),option.key,key=>{chosen.set(deal.offerId,key);render(true);},'Velg mengde'));
    }
    const total=el('div',undefined,'shop-total');
    total.append(el('span',`${option.packs} ${option.packs===1?'pakke':'pakker'} · ${amount(option.amount,deal.unit)} · ${kr(option.cost)}`));
    if(option.saving!=null)total.append(el('strong',`Spar ${kr(option.saving)}`));
    card.append(total);
    const notes=[];
    if(deal.tier==='good'&&deal.fullMonths===3)notes.push('Bra, men ikke et kupp, så vi foreslår 3 måneder.');
    else if(deal.tier!=='small'&&deal.fullMonths!=null&&deal.fullMonths<(deal.tier==='excellent'?12:3))notes.push(`Holder ca. ${monthsText(deal.fullMonths)}, så vi foreslår ikke mer.`);
    const stockItem=data.items.find(x=>x.id===deal.watchId);
    if(deal.stock.known&&stockItem)notes.push(`Dere har ${stockSummary(stockItem)}.`);
    if(deal.bestBefore)notes.push(`Best før ${dayLabel(deal.bestBefore)}.`);
    if(deal.maxPacks)notes.push(`Maks ${deal.maxPacks} per kunde.`);
    if(deal.bundlePacks>1)notes.push(`Kjøp ${deal.bundlePacks} og ${deal.bundlePacks}.`);
    if(deal.memberOnly)notes.push('Krever medlemskap.');
    if(deal.alsoAt.length)notes.push(`Også hos ${deal.alsoAt.map(x=>`${x.storeName} (${price(x.unitPrice)})`).join(', ')}.`);
    if(notes.length)card.append(el('p',notes.join(' '),'shop-sub'));
    if(!deal.stock.known&&stockItem){
      const ask=el('div',undefined,'shop-ask');
      ask.append(el('span','Hvor mange har dere hjemme?','shop-sub'),stockEditor(stockItem,async()=>{await load();render(true);},{confirm:true}));
      card.append(ask);
    }
    const actions=el('div',undefined,'shop-actions');
    actions.append(
      deal.onList?el('span','På listen ✓','shop-onlist'):button('Legg på listen',()=>act(()=>api('/list',{action:'add',offerId:deal.offerId,packs:option.packs}),'Lagt på handlelisten.'),'primary'),
      button('Kjøpt',()=>act(()=>api('/deal',{offerId:deal.offerId,action:'bought',packs:option.packs}),`${deal.watchName} er lagt på lager${option.saving!=null?`, ${kr(option.saving)} spart`:''}.`,()=>act(()=>api('/deal',{offerId:deal.offerId,action:'undo'}),'Angret.'))),
      button('Ikke nå',()=>act(()=>api('/deal',{offerId:deal.offerId,action:'snooze'}),'Skjult til tilbudet er over.',()=>act(()=>api('/deal',{offerId:deal.offerId,action:'undo'}),'Angret.')))
    );
    card.append(actions);
    card.append(details('why:'+deal.offerId,'Slik er det regnet',node=>{
      node.append(el('p',deal.comparisonNote,'shop-sub'));
      if(deal.annualAmount!=null)node.append(el('p',`Årsbehov: ${amount(deal.annualAmount,deal.unit)}, ${BASIS_TEXT[deal.quantityBasis]??''}.`,'shop-sub'));
      if(deal.conditions)node.append(el('p',deal.conditions,'shop-sub'));
      if(deal.evidence)node.append(el('p',`Kilde: ${deal.evidence}`,'shop-sub'));
    },'shop-why'));
    return card;
  }
  // Same horizons as the server's deal planning: quantities, never durations.
  function priceAdvice(item,unitPrice,size) {
    const {normal,good,excellent,targetPrice,current,currentChain}=item.prices,unit=item.unit,goodLine=good??targetPrice;
    const reference=item.prices.evaluationReference??normal,discount=reference?(1-unitPrice/reference)*100:0;
    const tier=discount>=8&&((excellent!=null&&unitPrice<=excellent)||discount>=25)?'excellent':discount>=8&&goodLine!=null&&unitPrice<=goodLine?'good':normal==null||unitPrice<=normal?'normal':'dear';
    const title={excellent:'Svært bra pris',good:'Bra pris',normal:'Vanlig pris',dear:'Dyrt'}[tier];
    const months={excellent:Math.min(12,item.shelfLifeMonths),good:Math.min(3,item.shelfLifeMonths),normal:Math.min(1,item.shelfLifeMonths)}[tier];
    let action;
    if(tier==='dear')action=`Vent hvis dere kan. Vanlig pris er ${price(normal)}/${unit}.`;
    else if(item.annualAmount==null)action='Vi vet ikke hvor mye dere bruker, så kjøp det dere trenger nå.';
    else{
      const need=item.annualAmount/12*months-(item.stock.amount??0);
      if(need<=0)action=`Dere har nok hjemme: ${stockSummary(item)}.`;
      else if(size){
        const packs=Math.max(1,Math.floor(need/size+.75));
        action=`Kjøp ${packs} ${packs===1?'pakke':'pakker'} à ${packLabel(size,unit)} (${amount(packs*size,unit)}).`;
      }else action=`Kjøp ${amount(Math.ceil(need*10)/10,unit)}.`;
      if(tier==='normal'&&need>0)action=`Bare til neste tur: ${action.replace('Kjøp ','')}`;
    }
    return {tier,title,action,cheaper:current&&current<unitPrice*.98?`Billigere nå: ${price(current)}/${unit} hos ${currentChain}.`:null};
  }
  function priceCheck() {
    const card=el('section',undefined,'shop-card'),picker=el('div'),form=el('div'),out=el('div');
    const items=data.items.filter(x=>x.prices.normal||x.prices.targetPrice),selected=()=>items.find(x=>x.id===check.itemId);
    const sizeOf=item=>check.size==='custom'?customSize(item):check.size==='per'?null:check.size;
    const customSize=item=>{const n=Number(check.custom);if(!(n>0))return undefined;return check.customUnit==='g'||check.customUnit==='ml'?n/1000:check.customUnit==='dl'?n/10:n;};
    function drawResult() {
      const item=selected();out.replaceChildren();
      if(!item)return;
      const value=Number(check.price),size=sizeOf(item);
      if(!(value>0)||size===undefined)return;
      const unitPrice=size?value/size:value,advice=priceAdvice(item,unitPrice,size);
      const box=el('div',undefined,'shop-result '+advice.tier);
      box.append(el('strong',advice.title),el('p',`${price(unitPrice)}/${item.unit}${item.prices.normal?` · vanlig ${price(item.prices.normal)}/${item.unit}`:''}`,'shop-sub'),el('p',advice.action,'shop-advice'));
      if(advice.cheaper)box.append(el('p',advice.cheaper,'shop-sub'));
      out.append(box);
    }
    function drawForm() {
      const item=selected();form.replaceChildren();
      if(!item)return;
      const {normal,good,excellent}=item.prices,unit=item.unit,show=v=>v!=null?`${price(v)}/${unit}`:'–';
      form.append(el('p',`Vanlig ${show(normal)} · bra ${show(good)} · svært bra ${show(excellent)}`,'shop-sub'));
      const input=el('input'),row=el('div',undefined,'shop-check');
      input.type='number';input.inputMode='decimal';input.min='0';input.step='0.01';input.value=check.price;input.className='shop-price-input';
      input.placeholder=check.size==='per'?`Pris per ${unit}`:'Hyllepris';input.setAttribute('aria-label','Pris i kroner');
      input.oninput=()=>{check.price=input.value;drawResult();};
      row.append(input,el('span','kr','shop-unit'));form.append(row);
      if(check.size===null)check.size=item.packs[0]?.amount??'per';
      const options=[...item.packs.map(p=>[p.amount,packLabel(p.amount,unit)]),['custom',unit==='stk'?'Annet antall':'Annen vekt'],['per',`Pris per ${unit}`]];
      form.append(chips(options,check.size,value=>{check.size=value;drawForm();drawResult();},'Velg pakning'));
      if(check.size==='custom'){
        const units={kg:['g','kg'],l:['dl','l'],stk:['stk']}[unit];
        check.customUnit=units.includes(check.customUnit)?check.customUnit:units[0];
        const amountInput=el('input'),unitSelect=el('select'),custom=el('div',undefined,'shop-check');
        amountInput.type='number';amountInput.inputMode='decimal';amountInput.min='0';amountInput.step='any';amountInput.value=check.custom;amountInput.placeholder=unit==='stk'?'Antall':'Vekt';amountInput.className='shop-price-input';amountInput.setAttribute('aria-label','Pakningsstørrelse');
        for(const value of units)unitSelect.append(Object.assign(el('option',value),{value}));
        unitSelect.value=check.customUnit;unitSelect.setAttribute('aria-label','Enhet');
        amountInput.oninput=()=>{check.custom=amountInput.value;drawResult();};
        unitSelect.onchange=()=>{check.customUnit=unitSelect.value;drawResult();};
        custom.append(amountInput,unitSelect);form.append(custom);
      }
    }
    function choose(id) {check.itemId=id;check.size=null;check.custom='';drawPicker();drawForm();drawResult();}
    function drawPicker() {
      picker.replaceChildren();
      const item=selected();
      if(item){
        const row=el('div',undefined,'shop-picked');
        row.append(el('strong',item.name),button('Bytt vare',()=>{check.itemId=null;check.query='';check.price='';check.size=null;drawPicker();drawForm();drawResult();}));
        picker.append(row);return;
      }
      const input=el('input'),matches=el('div');
      input.type='search';input.placeholder='Hvilken vare?';input.value=check.query;input.className='shop-find';input.setAttribute('aria-label','Finn vare');
      const drawMatches=()=>{const needle=check.query.toLocaleLowerCase('nb-NO'),found=items.filter(x=>x.name.toLocaleLowerCase('nb-NO').includes(needle)).slice(0,6);matches.replaceChildren(found.length?chips(found.map(x=>[x.id,x.name]),null,choose,'Velg vare'):el('p','Fant ingen vare med det navnet.','shop-sub'));};
      input.oninput=()=>{check.query=input.value;drawMatches();};
      picker.append(input,matches);drawMatches();
    }
    card.append(el('h3','Er dette en god pris?'),picker,form,out);
    drawPicker();drawForm();drawResult();
    return card;
  }
  function storeSections(deals) {
    const groups=new Map();
    for(const deal of deals){const list=groups.get(deal.storeName)??[];list.push(deal);groups.set(deal.storeName,list);}
    const sum=list=>list.reduce((n,d)=>n+(d.saving??0),0);
    return [...groups.entries()].sort((a,b)=>sum(b[1])-sum(a[1])).map(([store,list])=>{
      const section=el('section',undefined,'shop-store'),head=el('div',undefined,'shop-store-head');
      head.append(el('h3',store),el('span',`${sum(list)>0?`Spar ${kr(sum(list))} · `:''}senest ${dayLabel(list.map(d=>d.validTo).sort()[0])}`,'shop-sub'));
      section.append(head,...list.map(dealCard));
      return section;
    });
  }
  function renderBuy(root) {
    const hero=el('section',undefined,'shop-hero');
    const potential=data.summary.potential;
    if(data.deals.length||data.steady.length){
      const parts=[data.deals.length?data.deals.length+' '+(data.deals.length===1?'tilbud':'tilbud'):null,data.steady.length?data.steady.length+' fast lav pris':null].filter(Boolean).join(' og ');
      hero.append(el('p','Denne uka','shop-sub'),el('div',`${kr(potential)} å spare`,'shop-hero-number'),el('p',`${parts}${data.saved.year?` · ${kr(data.saved.year)} spart i år`:''}`,'shop-sub'));
    }else{
      hero.append(el('div',data.monitoring?'Ingen kupp akkurat nå':'Tilbudsovervåkning er av','shop-hero-number small'),el('p',`${data.storesCheckedToday} butikker sjekket i dag${data.saved.year?` · ${kr(data.saved.year)} spart i år`:''}`,'shop-sub'));
    }
    root.append(hero,priceCheck());
    root.append(...storeSections(data.deals));
    if(data.steady.length){
      const section=el('section',undefined,'shop-store');
      const head=el('div',undefined,'shop-store-head');head.append(el('h3','Fast lav pris, verdt en tur'),el('span','Ikke tilbud, men langt under de andre butikkene','shop-sub'));
      section.append(head);
      for(const item of data.steady){
        const card=el('article',undefined,'shop-deal'),top=el('div',undefined,'shop-steady'),text=el('div',undefined,'shop-list-text');
        text.append(el('h4',item.name),el('p',item.storeName+' · '+item.productName,'shop-sub'));
        top.append(thumb(item.image),text);card.append(top);
        const line=el('p',undefined,'shop-price');line.append(el('strong',price(item.unitPrice)+'/'+item.unit),el('span',' · referanse '+price(item.referencePrice)+'/'+item.unit+' · '+item.diffPct+' % lavere'));card.append(line);
        const total=el('div',undefined,'shop-total');total.append(el('span','Kjøp '+item.packs+' × '+packLabel(item.packAmount,item.unit)+' ('+amount(item.packs*item.packAmount,item.unit)+') · '+kr(item.cost)),el('strong','Spar '+kr(item.saving)));card.append(total);
        const stockItem=data.items.find(x=>x.id===item.watchId);
        card.append(el('p',(item.stock.known?'Dere har '+(stockItem?stockSummary(stockItem):'lite igjen')+'. ':'Lager ikke talt. ')+'Kjedepris, så sjekk at butikken har den.','shop-sub'));
        if(!item.stock.known&&stockItem){const ask=el('div',undefined,'shop-ask');ask.append(el('span','Hvor mange har dere hjemme?','shop-sub'),stockEditor(stockItem,async()=>{await load();render(true);},{confirm:true}));card.append(ask);}
        const actions=el('div',undefined,'shop-actions');
        actions.append(button('Legg på listen',()=>act(()=>api('/list',{action:'add',watchId:item.watchId,storeName:item.storeName,packs:item.packs,packAmount:item.packAmount,unitPrice:item.unitPrice,saving:item.saving,detail:item.productName}),'Lagt på handlelisten.'),'primary'));
        if(item.sourceUrl&&!isKiosk()){const source=link('Se varen ↗',item.sourceUrl);source.className='shop-source';actions.append(source);}
        card.append(actions);section.append(card);
      }
      root.append(section);
    }
    const low=data.items.filter(x=>x.enabled&&x.stock.known&&x.stock.months!=null&&x.stock.months<1).slice(0,8);
    if(low.length){
      const card=el('section',undefined,'shop-card');
      card.append(el('h3','Snart tomt'));
      for(const item of low){
        const row=el('div',undefined,'shop-low');
        const text=el('div');
        text.append(el('strong',item.name),el('span',item.prices.current?`Billigst nå: ${price(item.prices.current)}/${item.unit} hos ${item.prices.currentChain}`:'Ingen fersk pris','shop-sub'));
        row.append(text);
        row.append(button('Legg på listen',()=>act(()=>api('/list',{action:'add',watchId:item.id,packAmount:item.packs[0].amount}),'Lagt på handlelisten.')));
        if(data.oda.connected)row.append(button('Finn i Oda',()=>{odaQuery=item.name;openSections.add('oda');render(true);panel.querySelector('.shop-oda')?.scrollIntoView({block:'center'});}));
        card.append(row);
      }
      root.append(card);
    }
    if(data.smallDeals.length)root.append(details('small',`Små tilbud på turer dere uansett tar (${data.smallDeals.length})`,node=>node.append(...storeSections(data.smallDeals)),'shop-fold'));
    if(data.belowTrip.length)root.append(details('below',`Bra pris, men ikke verdt en egen tur (${data.belowTrip.length})`,node=>node.append(...storeSections(data.belowTrip)),'shop-fold'));
    if(data.covered.length)root.append(details('covered',`Godt tilbud, men dere har nok (${data.covered.length})`,node=>{for(const deal of data.covered){const item=data.items.find(x=>x.id===deal.watchId);node.append(el('p',`${deal.watchName} hos ${deal.storeName}: ${price(deal.unitPrice)}/${deal.unit}. Dere har ${item?stockSummary(item):'nok'}.`,'shop-sub'));}},'shop-fold'));
    if(data.held.length)root.append(details('held',`Tilbud vi ikke kan vise ennå (${data.held.length})`,node=>{for(const entry of data.held)node.append(el('p',`${entry.watchName} hos ${entry.storeName} ${HELD_TEXT[entry.reason]??'venter'}.`,'shop-sub'));},'shop-fold'));
    root.append(odaSearch());
  }
  function odaSearch() {
    return details('oda','Legg varer i Oda-kurven',node=>{
      if(!data.oda.connected){node.append(el('p','Oda må kobles til fra oppsettet på PC-en.','shop-sub'));return;}
      const form=el('form',undefined,'shop-check'),input=el('input'),go=el('button','Søk'),results=el('div');
      input.type='search';input.placeholder='Hva trenger dere?';input.value=odaQuery;input.setAttribute('aria-label','Søk i Oda');go.type='submit';
      form.append(input,go);
      form.onsubmit=async event=>{
        event.preventDefault();go.disabled=true;results.replaceChildren();
        try{
          odaQuery=input.value;
          const response=await api('/oda/search',{query:input.value});
          for(const product of response.result?.[0]?.products??[]){
            const row=el('div',undefined,'shop-low'),qty=el('input');
            qty.type='number';qty.min='1';qty.max='100';qty.value='1';qty.className='shop-qty';qty.setAttribute('aria-label',`Antall ${product.name}`);
            const add=button('Legg til',async()=>{
              add.disabled=true;
              try{const receipt=await api('/oda/add',{requestId:crypto.randomUUID(),productId:product.id,quantity:Number(qty.value)});row.append(isKiosk()?el('span','Lagt i Oda-kurven','shop-sub'):link('Lagt til · se kurven',receipt.url));}catch(error){add.disabled=false;fail(error);}
            });
            add.disabled=product.availability?.isAvailable!==true;
            const text=el('div');text.append(el('strong',product.name),el('span',`${product.description} · ${product.price} kr`,'shop-sub'));
            row.append(text,qty,add);results.append(row);
          }
          if(!results.childElementCount)results.append(el('p','Ingen treff.','shop-sub'));
        }catch(error){fail(error);}finally{go.disabled=false;}
      };
      node.append(form,results,el('p','Dere ser over og betaler hos Oda.','shop-sub'));
      if(odaQuery&&openSections.has('oda'))queueMicrotask(()=>form.requestSubmit());
    },'shop-fold shop-oda');
  }

  // ---- Handleliste ----
  // Puts a product from another chain on that chain's part of the shopping list.
  // ---- Varekort ----
  const productName=(label,info)=>info.key||info.watchId?button(label,()=>productDialog(info,label),'shop-product-link'):el('strong',label);
  const LABEL_TEXT={organic:'Økologisk',lactoseFree:'Laktosefri',glutenFree:'Glutenfri',frozen:'Frysevare'};
  const NUTRIENTS=[['kcal','Energi','kcal'],['fat','Fett','g'],['carbs','Karbohydrater','g'],['sugars','Sukkerarter','g'],['fiber','Kostfiber','g'],['protein','Protein','g'],['salt','Salt','g']];
  const NUTRITION_LEVEL={good:['god',''],medium:['middels','later'],low:['svakere','low']};
  function pillRow(row) {
    if(!row?.pills)return null;
    const node=el('span',undefined,'shop-badges shop-pills'),{raw,nutrition,value}=row.pills;
    if(raw){const tone=raw.unknown?'later':raw.score>=67?'':raw.score>=34?'later':'low',pill=el('span',raw.unknown?'Råvare: ukjent':raw.label+' '+nf(0).format(raw.score),('shop-badge '+tone).trim());pill.title=raw.unknown?'Etiketten oppgir ikke mengden som måles. Ukjent er ikke det samme som dårlig.':'Dokumentert råvareinnhold sammenlignet med varer målt på samme måte.';node.append(pill);}
    if(nutrition){const [word,tone]=NUTRITION_LEVEL[nutrition.level];const pill=el('span','Næring: '+word,('shop-badge '+tone).trim());pill.title='Sammenlignet med andre varer i samme varefamilie. Ikke en helsevurdering.';node.append(pill);}
    if(value){const pill=el('span','Kvalitet for pengene','shop-badge excellent');pill.title='Både høy kvalitet og lav pris i varefamilien.';node.append(pill);}
    return node.childNodes.length?node:null;
  }
  const appendPills=(holder,row)=>{const node=pillRow(row);if(node)holder.append(node);};
  const MEASURE_TEXT={sugars:'Sukkerarter',salt:'Salt',fiber:'Kostfiber',protein:'Protein'};
  function nutritionCard(group) {
    const box=el('section',undefined,'shop-quality'),n=group.nutrition,[word]=NUTRITION_LEVEL[n.level];
    const head=el('div',undefined,'shop-quality-head');head.append(el('span',nf(0).format(n.score),'shop-quality-score'),el('span','av 100 · næring: '+word,'shop-sub'));box.append(head);
    for(const m of n.measures)box.append(el('p',MEASURE_TEXT[m.key]+': '+nf(1).format(m.value)+' g, vanlig i varefamilien er '+nf(1).format(m.median)+' g'));
    box.append(el('p','Sammenlignet med andre varer i samme varefamilie: mindre sukker og salt, mer fiber og protein gir høyere tall. Dette er ingen helsevurdering.','shop-sub'));
    return box;
  }
  function qualityCard(group) {
    const box=el('section',undefined,'shop-quality'),q=group.quality;
    if(!q){box.append(el('p',group.qualityStatus==='unknown'?'Kvalitetsscore mangler: etiketten oppgir ikke mengden som måles.':'Vi har ingen kvalitetsmodell for denne varetypen ennå.','shop-sub'));return box;}
    const head=el('div',undefined,'shop-quality-head');head.append(el('span',nf(0).format(q.score),'shop-quality-score'),el('span','av 100 · '+q.label,'shop-sub'));box.append(head);
    box.append(el('p',q.criterion+(q.value!=null?': '+nf(1).format(q.value)+' '+(q.unit??''):'')));
    if(q.evidence)box.append(el('p','Fra etiketten: «'+q.evidence+'»','shop-sub'));
    if(q.rank&&q.of>1)box.append(el('p','Nummer '+q.rank+' av '+q.of+' varer målt på samme måte.'));
    if(q.peers.length>1){const list=el('div',undefined,'shop-quality-peers');for(const peer of q.peers){const row=el('div',undefined,'shop-quality-peer'+(peer.own?' own':''));row.append(el('span',nf(0).format(peer.score),'shop-quality-peer-score'),el('span',peer.name),el('span',peer.unitPrice!=null?price(peer.unitPrice):'','shop-sub'));list.append(row);}box.append(list);}
    if(q.limitations.length)box.append(el('p',q.limitations.join(' '),'shop-sub'));
    return box;
  }
  function renderProductInfo(holder,data) {
    holder.replaceChildren();holder.className='';
    if(!data.available){holder.append(el('p','Produktbiblioteket er ikke tilgjengelig akkurat nå.','shop-sub'));return;}
    if(!data.product){holder.append(el('p',(data.watchName?data.watchName+' er':'Denne varen er')+' ikke med i produktbiblioteket ennå.','shop-sub'));return;}
    const p=data.product,section=(title,...nodes)=>{const node=el('section',undefined,'shop-product-section');node.append(el('h3',title),...nodes);holder.append(node);};
    const top=el('div',undefined,'shop-product-top'),text=el('div',undefined,'shop-list-text');
    text.append(el('strong',p.name),el('span',[p.brand,p.storeName,p.packAmount&&p.unit?packLabel(p.packAmount,p.unit):null,p.price.grossPackPrice!=null?price(p.price.grossPackPrice)+(p.price.fresh?'':' (eldre pris)'):null].filter(Boolean).join(' · '),'shop-sub'));
    appendPills(text,p);
    top.append(thumb(p.image),text);holder.append(top);
    if(p.labels.length)holder.append(el('p',p.labels.map(x=>LABEL_TEXT[x]??x).join(' · '),'shop-sub'));
    const approved=data.groups.filter(g=>g.status==='approved');
    section('Kvalitet',...(approved.length?[...new Map(approved.map(g=>[g.quality?g.name:'none',g])).values()].slice(0,3).map(qualityCard):[el('p','Varen er ikke godkjent i noen varefamilie ennå.','shop-sub')]));
    const nutritionGroup=approved.find(g=>g.nutrition);if(nutritionGroup)section('Næring i varefamilien',nutritionCard(nutritionGroup));
    const valueGroup=approved.find(g=>g.value);if(valueGroup)section('Kvalitet for pengene',el('p','Kvalitet '+nf(0).format(valueGroup.value.quality)+' av 100 og pris '+nf(0).format(valueGroup.value.price)+' av 100, der billigst i varefamilien er 100. '+(valueGroup.value.top?'En av de beste kombinasjonene i varefamilien.':'Andre varer gir bedre kombinasjon.')));
    if(p.ingredients)section('Ingredienser',el('p',p.ingredients));
    if(p.nutrition){const table=el('dl',undefined,'shop-facts');for(const [key,label,unit] of NUTRIENTS){const value=p.nutrition.per100?.[key];if(typeof value==='number')table.append(el('dt',label),el('dd',nf(1).format(value)+' '+unit));}section('Næring per 100 '+p.nutrition.basis,table);}
    if(p.description)section('Beskrivelse',el('p',p.description,'shop-sub'));
    for(const group of approved.slice(0,3))section('Varefamilie: '+group.name,...[group.equivalenceEvidence?el('p',group.equivalenceEvidence):null,group.qualityEvidence?el('p',group.qualityEvidence,'shop-sub'):null,group.comparisonBasis?el('p','Sammenlignes: '+group.comparisonBasis,'shop-sub'):null].filter(Boolean));
    const facts=[p.ean?'Strekkode '+p.ean:null,p.packEvidence].filter(Boolean);if(facts.length)holder.append(el('p',facts.join(' · '),'shop-sub'));
    if(p.sourceUrl&&!isKiosk()){const source=link('Se varen hos kilden ↗',p.sourceUrl);source.className='shop-source';holder.append(source);}
  }
  async function productDialog(info,title) {
    const box=el('dialog',undefined,'shop-dialog shop shop-product'),holder=el('div','Henter varen …','shop-sub'),close=()=>{box.close();box.remove();};
    const actions=el('div',undefined,'shop-actions');actions.append(button('Lukk',close));
    box.append(el('h2',title),holder,actions);box.oncancel=event=>{event.preventDefault();close();};
    document.body.append(box);box.showModal();
    try{const query=new URLSearchParams();if(info.key)query.set('key',info.key);if(info.watchId)query.set('watchId',info.watchId);const found=await api('/product-info?'+query);if(box.isConnected)renderProductInfo(holder,found);}
    catch(error){if(box.isConnected)holder.textContent=error.message;}
  }
  const placeAction=place=>place.odaProductId?'Legg i Oda-kurven':'Legg på listen';
  function moveToOda(entryId,productId) {
    let note=null;
    act(async()=>{const moved=await api('/list',{action:'toOda',id:entryId,productId});note=moved.inCart?'Lagt i Oda-kurven.':moved.cartError?'Sjekk Oda-kurven.':'Flyttet til Oda.';if(moved.inCart)await loadCart(true);},()=>note);
  }
  function addElsewhere(place,context) {
    if(place.odaProductId)return moveToOda(context.replaceEntry,place.odaProductId);
    const wanted=context.amount(),packs=place.packAmount&&wanted?Math.max(1,Math.ceil(wanted/place.packAmount-.001)):1,cost=place.unitPrice*(place.packAmount?packs*place.packAmount:0);
    const saving=wanted&&place.packAmount?Math.max(0,context.currentUnit*wanted-cost):null;
    const body=place.offerId?{action:'add',offerId:place.offerId,packs:place.maxPacks?Math.min(place.maxPacks,packs):packs}:{action:'add',alternative:true,...(context.watchId?{watchId:context.watchId}:{}),name:context.name,detail:place.name,storeName:place.storeName,productKey:place.productKey,packs,packAmount:place.packAmount,unit:context.unit,unitPrice:place.unitPrice,saving:saving===null?null:Math.round(saving*100)/100,imageId:place.image};
    act(async()=>{await api('/list',body);if(context.replaceEntry)await api('/list',{action:'remove',id:context.replaceEntry});},'Lagt på listen for '+place.storeName+'.',context.removeFromCart,context.removeFromCart?'Fjern fra kurven':undefined);
  }
  function cheaperBlock(item,context) {
    const box=el('div',undefined,'shop-elsewhere');
    box.append(el('strong','Denne varen kan kjøpes billigere:'));
    for(const place of item.places){
      const row=el('div',undefined,'shop-elsewhere-row'),text=el('div',undefined,'shop-list-text');
      text.append(el('strong',place.storeName+(place.online?' (+ frakt)':'')+': '+price(place.unitPrice)+'/'+context.unit),el('span',[place.name,place.offer?'tilbud':null,place.own?null:'utenfor butikkene deres'].filter(Boolean).join(' · '),'shop-sub'));
      appendPills(text,place);
      row.append(thumb(place.image),text,button(placeAction(place),()=>addElsewhere(place,context)));
      box.append(row);
    }
    const note=el('p','','shop-sub shop-elsewhere-note');
    const refresh=()=>{const s=item.savings,amountNow=context.amount(),parts=[];if(!s){note.textContent='';return;}if(s.annual)parts.push(kr(s.annual)+' på 12 måneder');if(amountNow>0)parts.push(kr(s.perUnit*amountNow)+' på '+context.label());note.textContent=parts.length?'Spar opptil '+parts.join(' og ')+' hos '+s.storeName+(s.online?', før frakt':'')+'.':'';};
    box.append(note);box.refresh=refresh;refresh();return box;
  }
  function thumb(id) {
    const box=el('span',undefined,'shop-thumb');
    if(id){const img=el('img');img.src=base+'/image?id='+id;img.alt='';img.loading='lazy';img.onerror=()=>img.remove();box.append(img);}
    return box;
  }
  function variantChooser(watchId,variants,currentId,unit,onPick,others=[],context=null) {
    return details('variant:'+watchId,'Andre varianter ('+(variants.length+others.length)+')',node=>{
      for(const variant of variants){
        const row=el('div',undefined,'shop-variant'),text=el('div',undefined,'shop-list-text'),chosen=variant.productId===currentId;
        text.append(productName(variant.name,{key:variant.productKey}),el('span',price(variant.packPrice)+' · '+price(variant.unitPrice)+'/'+unit+(variant===variants[0]?(others.length?' · billigst hos Oda':' · billigst'):'')+(variant.library?' · annet merke':'')+(variant.maxAtOda!=null?' · maks '+variant.maxAtOda:''),'shop-sub'));
        appendPills(text,variant);
        row.append(thumb(variant.image),text,chosen?el('span','Valgt','shop-onlist'):button('Velg',()=>{if(onPick)return onPick(variant);draftEdits.delete(watchId);act(()=>api('/list',{action:'variant',watchId,productId:variant.productId}),'Oda-variant valgt.');}));
        node.append(row);
      }
      if(others.length)node.append(el('p','Samme varefamilie hos andre kjeder','shop-sub shop-variant-head'));
      for(const other of others){
        const row=el('div',undefined,'shop-variant'),text=el('div',undefined,'shop-list-text');
        text.append(productName(other.name,{key:other.productKey}),el('span',[other.storeName+(other.online?' (+ frakt)':''),other.packPrice!=null?price(other.packPrice):null,price(other.unitPrice)+'/'+unit,other===others[0]?'billigst':null,other.offer?'tilbud':null,other.own?null:'utenfor butikkene deres'].filter(Boolean).join(' · '),'shop-sub'));
        appendPills(text,other);
        row.append(thumb(other.image),text);if(context&&other.storeName!==context.currentStore)row.append(button(placeAction(other),()=>addElsewhere(other,context)));node.append(row);
      }
    },'shop-variants');
  }
  function listRow(entry) {
    const row=el('div',undefined,'shop-list-row'+(entry.checkedAt?' done':''));
    const tick=el('input');tick.type='checkbox';tick.checked=!!entry.checkedAt;tick.setAttribute('aria-label',`Kjøpt: ${entry.name}`);
    tick.onchange=()=>act(()=>api('/list',{action:tick.checked?'check':'uncheck',id:entry.id}),tick.checked&&entry.watchId?'Lagt på lager.':null);
    const text=el('div',undefined,'shop-list-text'),qty=entry.packs&&entry.packAmount?`${entry.packs} × ${packLabel(entry.packAmount,entry.unit)} `:'';
    text.append(productName(qty+entry.name,{key:entry.productKey,watchId:entry.watchId}));
    const facts=[entry.cartError,entry.reason,entry.detail,entry.unitPrice?`${price(entry.unitPrice)}/${entry.unit}`:null,entry.saving?`Spar ${kr(entry.saving)}`:null,entry.cheaper&&!entry.places?.length?`Billigere nå: ${price(entry.cheaper.unitPrice)}/${entry.unit} hos ${entry.cheaper.storeName}`:null,entry.expired?'Tilbudet er over':entry.validTo?`Til ${dayLabel(entry.validTo)}`:null].filter(Boolean);
    if(facts.length)text.append(el('span',facts.join(' · '),'shop-sub'+(entry.expired?' shop-expired':'')));
    appendPills(text,entry);
    row.append(tick,thumb(entry.image),text);
    if(entry.sourceUrl&&!isKiosk()){const source=link('Kilde ↗',entry.sourceUrl);source.className='shop-list-source';row.append(source);}
    const remove=button('×',()=>act(()=>api('/list',{action:'remove',id:entry.id})),'shop-list-remove');remove.setAttribute('aria-label',`Fjern ${entry.name}`);
    row.append(remove);
    if(entry.routing==='choose'&&entry.suggestions?.length&&!entry.checkedAt){
      const picks=el('div',undefined,'shop-suggestions');
      picks.append(el('span','Hva mente du?','shop-sub'));
      for(const option of entry.suggestions)picks.append(button(option.type==='watch'?option.name:`${option.name} · ${option.storeName} · ${price(option.unitPrice)}/${option.unit}`,()=>{let note=null;act(async()=>{const placed=await api('/list',{action:'choose',id:entry.id,...(option.type==='watch'?{watchId:option.watchId}:{productKey:option.productKey})});note=placed.inCart?'Lagt i Oda-kurven.':'Lagt under '+(placed.storeName??'listen')+'.';if(placed.inCart)await loadCart(true);},()=>note);}));
      picks.append(button('Ingen av disse',()=>act(()=>api('/list',{action:'choose',id:entry.id,agent:true}),'Vi finner beste sted.'),'shop-quiet'));
      row.append(picks);
    }
    if(entry.odaReturn&&!entry.checkedAt){const back=el('div',undefined,'shop-return');back.append(button('Flytt til Oda · '+price(entry.odaReturn.unitPrice)+'/'+entry.unit,()=>moveToOda(entry.id,entry.odaReturn.productId)));row.append(back);}
    if(!entry.checkedAt&&(entry.places?.length||entry.variants?.length>1||entry.others?.length)){
      const context={watchId:entry.watchId,name:entry.name,unit:entry.unit,currentUnit:entry.unitPrice,amount:()=>(entry.packs??0)*(entry.packAmount??0),label:()=>entry.packs+' pk på listen',replaceEntry:entry.id,currentStore:entry.storeName};
      if(entry.places?.length)row.append(cheaperBlock(entry,context));
      if(entry.variants?.length>1||entry.others?.length)row.append(variantChooser(entry.watchId,entry.variants,entry.odaProductId,entry.unit,undefined,entry.others,context));
    }
    return row;
  }
  async function loadCart(force=false) {
    if(!data?.oda.connected||cartPending.size)return;
    try{cart=await api(force?'/oda/live?force=1':'/oda/live');drawCart();}catch{}
  }
  function saveLine(line) {
    const pending=cartPending.get(line.productId);
    clearTimeout(pending.timer);
    pending.timer=setTimeout(async()=>{
      const delta=pending.delta;cartPending.delete(line.productId);
      if(!delta)return;
      try{cart=await api('/oda/line',{requestId:crypto.randomUUID(),productId:line.productId,delta});}
      catch(error){fail(error);await loadCart(true);return;}
      if(!cartPending.size)drawCart();
    },700);
  }
  function cartLine(line) {
    const row=el('div',undefined,'shop-draft-row');
    const text=el('div',undefined,'shop-list-text');text.append(productName(line.name,{key:line.productKey,watchId:line.watchId}),el('span',[line.total?kr(Number(line.total)):null,line.unitPrice?price(line.unitPrice)+'/'+line.unit:null].filter(Boolean).join(' · '),'shop-sub'));
    const swapTo=variant=>act(async()=>{const quantity=line.packAmount?Math.max(1,Math.round(line.quantity*line.packAmount/variant.packAmount)):line.quantity;cart=await api('/oda/swap',{requestId:crypto.randomUUID(),fromProductId:line.productId,toProductId:variant.productId,quantity,watchId:line.watchId});},'Variant byttet i kurven.');
    const value=el('span',String(line.quantity),'shop-step-value'),step=el('div',undefined,'shop-step');
    const change=delta=>{
      const pending=cartPending.get(line.productId)??{delta:0,timer:null,quantity:line.quantity};
      if(pending.quantity+delta<0)return;
      pending.delta+=delta;pending.quantity+=delta;cartPending.set(line.productId,pending);value.textContent=String(pending.quantity);saveLine(line);
    };
    step.append(button('−',()=>change(-1)),value,button('+',()=>change(1)));
    const remove=button('×',()=>change(-(cartPending.get(line.productId)?.quantity??line.quantity)),'shop-list-remove');remove.setAttribute('aria-label','Fjern '+line.name);
    appendPills(text,line);
    row.append(thumb(line.image),text,step,remove);
    if(line.limit)row.append(el('div',line.limit,'shop-limit'));
    if(line.cheaperVariant){
      const cheaper=el('div',undefined,'shop-cheaper');
      cheaper.append(el('span','Billigere variant hos Oda: '+line.cheaperVariant.name+', '+price(line.cheaperVariant.unitPrice)+'/'+line.unit+' ('+line.cheaperVariant.diffPct+' % lavere).'),button('Bytt',()=>swapTo(line.cheaperVariant)));
      row.append(cheaper);
    }
    if(line.libraryAlternative){
      const other=line.libraryAlternative,box=el('div',undefined,'shop-cheaper'),quality=other.quality?` ${other.quality.label}: ${nf(0).format(other.quality.other)} mot ${nf(0).format(other.quality.own)} av 100.`:'';
      box.append(el('span','Lignende vare hos Oda: '+other.name+', '+price(other.unitPrice)+'/'+other.unit+' ('+other.diffPct+' % lavere).'+quality),button('Bytt',()=>act(async()=>{const quantity=other.linePackAmount?Math.max(1,Math.round(line.quantity*other.linePackAmount/other.packAmount)):line.quantity;cart=await api('/oda/swap',{requestId:crypto.randomUUID(),fromProductId:line.productId,toProductId:other.productId,quantity});},'Variant byttet i kurven.')));
      row.append(box);
    }
    const lineContext={watchId:line.watchId,name:line.name,unit:line.unit??line.familyUnit,currentUnit:line.unitPrice??(line.savings&&line.places?.[0]?line.places[0].unitPrice+line.savings.perUnit:0),amount:()=>line.quantity*(line.packAmount??0),label:()=>line.quantity+' pk i kurven',removeFromCart:()=>act(async()=>{cart=await api('/oda/line',{requestId:crypto.randomUUID(),productId:line.productId,delta:-line.quantity});},'Fjernet fra kurven.')};
    if(line.places?.length)row.append(cheaperBlock(line,lineContext));
    else if(line.cheapestKnown&&!line.elsewhere)row.append(el('div','Billigste vi kjenner: '+price(line.cheapestKnown.unitPrice)+'/'+line.unit+' hos '+line.cheapestKnown.storeName+'.','shop-known'));
    if(line.variants?.length>1||line.others?.length)row.append(variantChooser(line.watchId??'product:'+line.productId,line.variants,line.productId,line.unit??line.familyUnit,swapTo,line.others,lineContext));
    return row;
  }
  function drawCart() {
    draftSync?.();
    if(!cartHolder||!cartHolder.isConnected||!cart)return;
    const card=el('section',undefined,'shop-card'),count=cart.lines.reduce((n,x)=>n+x.quantity,0);
    const head=el('div',undefined,'shop-store-head');
    head.append(el('h3','Oda-kurven'),el('span',count?count+' varer · '+kr(Number(cart.total)):'Tom','shop-sub'));
    card.append(head);
    if(cart.stale)card.append(el('p','Kunne ikke hente kurven akkurat nå. Viser sist kjente.','shop-sub'));
    const listed=cart.lines.map(x=>x.limit);
    for(const text of cart.messages)if(!listed.includes(text))card.append(el('div',text,'shop-limit'));
    const lineSaving=x=>(x.savings?.perUnit??0)*x.quantity*(x.packAmount??0),cartGroups=splitCheaper(cart.lines,lineSaving),inCartSaving=cartGroups.cheaper.reduce((n,x)=>n+lineSaving(x),0);
    if(cartGroups.cheaper.length)card.append(el('p',`Billigere et annet sted (${cartGroups.cheaper.length})${inCartSaving?` · spar opptil ${kr(inCartSaving)} på antallet i kurven`:''}`,'shop-group-label'),...cartGroups.cheaper.map(cartLine));
    if(cartGroups.cheaper.length&&cartGroups.rest.length)card.append(el('p','Resten av kurven','shop-group-label'));
    card.append(...[...cartGroups.rest].sort((x,y)=>Number(!!y.limit)-Number(!!x.limit)).map(cartLine));
    if(count&&cart.url&&!isKiosk()){const go=link('Til kassen hos Oda ↗',cart.url);go.className='shop-source';card.append(go);}
    cartHolder.replaceChildren(card);
  }
  function odaDraftCard() {
    const draft=data.odaDraft,card=el('section',undefined,'shop-card');
    const edit=item=>{if(!draftEdits.has(item.watchId))draftEdits.set(item.watchId,{on:!item.elsewhere,packs:item.packs});return draftEdits.get(item.watchId);};
    const inCart=x=>cart?.lines.some(line=>line.productId===x.productId||(line.watchId&&line.watchId===x.watchId));
    const selected=()=>draft.items.filter(x=>edit(x).on&&!inCart(x)&&cartState.get(x.watchId)?.state!=='uncertain');
    const summary=el('p','','shop-sub'),go=el('button','','primary');go.type='button';
    let armed=false;
    const refresh=()=>{
      const list=selected(),sum=list.reduce((n,x)=>n+x.packPrice*edit(x).packs,0);
      summary.textContent=`${list.length} varer · ca. ${kr(sum)}${draft.covered?` · ${draft.covered} varer dekket av lageret`:''}`;
      go.textContent=armed?`Bekreft: legg ${list.length} forslag i kurven`:`Legg ${list.length} forslag i kurven`;
      go.disabled=!list.length||cartBusy;
    };
    card.append(el('h3','Forslag til neste storhandel'),el('p',`Forslag til bestilling rundt ${dayLabel(draft.nextAround)}. Fersk frukt og andre varer velger dere selv.${draft.items.some(x=>x.stockKnown)?'':' Lageret er ikke talt ennå, så mengdene regner med at dere ikke har noe hjemme.'}`,'shop-sub'),summary);
    const rows=new Map();
    const renderRows=(node,list)=>{
      for(const item of list){
        const row=el('div',undefined,'shop-draft-row'),state=edit(item);
        const on=el('input');on.type='checkbox';on.checked=state.on;on.setAttribute('aria-label',`Ta med ${item.name}`);
        on.onchange=()=>{state.on=on.checked;state.userOn=true;armed=false;refresh();};
        const text=el('div',undefined,'shop-list-text'),note={excellent:'Svært bra pris nå',good:'Bra pris nå',dear:'Dyrere enn vanlig, derfor lite'}[item.tier];
        text.append(productName(item.name,{key:item.productKey,watchId:item.watchId}),el('span',[item.productName,`${price(item.packPrice)} per pakke · ${price(item.unitPrice)}/${item.unit}`,note,draft.items.some(x=>x.stockKnown)&&!item.stockKnown?'Lager ikke talt':null].filter(Boolean).join(' · '),'shop-sub'));
        const value=el('span',String(state.packs),'shop-step-value'),step=el('div',undefined,'shop-step');
        const change=delta=>{state.packs=Math.min(item.maxAtOda??100,Math.max(1,state.packs+delta));state.userPacks=true;value.textContent=String(state.packs);armed=false;refresh();cheaper?.refresh();};
        step.append(button('−',()=>change(-1)),value,button('+',()=>change(1)));
        const status=el('span',cartState.get(item.watchId)?.text??'','shop-draft-status');
        appendPills(text,item);
        row.append(on,thumb(item.image),text,step,status);
        const context={watchId:item.watchId,name:item.name,unit:item.unit,currentUnit:item.unitPrice,amount:()=>state.packs*item.packAmount,label:()=>state.packs+' pk i forslaget'};
        const cheaper=item.places?.length?cheaperBlock(item,context):null;
        if(cheaper)row.append(cheaper);
        if(item.variants?.length>1||item.others?.length)row.append(variantChooser(item.watchId,item.variants,item.productId,item.unit,undefined,item.others,context));
        if(item.maxAtOda!=null&&item.wanted>item.maxAtOda)row.append(el('div','Oda tillater maks '+item.maxAtOda+' per bestilling. Resten, '+(item.wanted-item.maxAtOda)+' pk, må kjøpes et annet sted.','shop-limit'));
        else if(item.maxAtOda!=null)row.append(el('div','Maks '+item.maxAtOda+' hos Oda.','shop-limit quiet'));
        node.append(row);rows.set(item.watchId,status);
      }
    };
    const groups=splitCheaper(draft.items),yearly=groups.cheaper.reduce((n,x)=>n+(x.savings?.annual??0),0);
    if(groups.cheaper.length)card.append(details('draft-elsewhere',`Billigere et annet sted (${groups.cheaper.length})${yearly?` · spar opptil ${kr(yearly)} på 12 måneder`:''}`,node=>renderRows(node,groups.cheaper),'shop-why'));
    card.append(details('draft',`${groups.cheaper.length?'Resten av varene':'Se varene'} (${groups.rest.length})`,node=>renderRows(node,groups.rest),'shop-why'));
    if(draft.missing.length)card.append(details('draft-missing',`Må velges selv (${draft.missing.length})`,node=>node.append(el('p',draft.missing.join(', '),'shop-sub')),'shop-why'));
    if(data.oda.connected){
      go.onclick=async()=>{
        if(!armed){armed=true;refresh();return;}
        armed=false;cartBusy=true;go.disabled=true;let added=0;
        for(const item of selected()){
          const state=edit(item),key=`${item.productId}:${state.packs}`;
          if(!cartIds.has(key))cartIds.set(key,crypto.randomUUID());
          go.textContent=`Legger i kurven … ${added+1}`;
          const mark=(next,text)=>{cartState.set(item.watchId,{state:next,text});const node=rows.get(item.watchId);if(node)node.textContent=text;};
          try{await api('/oda/add',{requestId:cartIds.get(key),productId:item.productId,quantity:state.packs});mark('done','I kurven ✓');added++;for(const id of item.entryIds??[])await api('/list',{action:'remove',id}).catch(()=>{});}
          catch(error){mark('uncertain','Sjekk i kurven');toast(error.message);break;}
        }
        cartBusy=false;await loadCart(true);refresh();if(added)toast(`${added} varer lagt i Oda-kurven. Se over og betal hos Oda.`);
      };
      const actions=el('div',undefined,'shop-actions');actions.append(go);card.append(actions);
    }else card.append(el('p','Oda må kobles til for å legge varer i kurven.','shop-sub'));
    draftSync=()=>{refresh();for(const item of draft.items){const node=rows.get(item.watchId);if(node&&inCart(item))node.textContent='Ligger i kurven';}};
    draftSync();
    return card;
  }
  function renderList(root) {
    const addCard=el('section',undefined,'shop-card'),form=el('form',undefined,'shop-check'),input=el('input'),go=el('button','Legg til');
    const needChips=chips([['now','Trenger nå'],['later','Kan vente']],listNeed,value=>{listNeed=value;render(true);},'Hvor fort trengs det?');
    input.type='text';input.placeholder='Legg til vare';input.maxLength=120;input.className='shop-find';input.setAttribute('aria-label','Legg til vare');go.type='submit';
    form.onsubmit=event=>{event.preventDefault();const name=input.value.trim();if(name){let note=null;act(async()=>{const added=await api('/list',{action:'add',name,need:listNeed});note=added.inCart?'Lagt i Oda-kurven.':added.routing==='choose'?'Velg riktig vare på listen.':added.routing==='pending'&&added.need!=='now'?'Vi finner beste sted.':added.storeName?'Lagt under '+added.storeName+'.':'Lagt på listen.';if(added.inCart)await loadCart(true);},()=>note);}};
    form.append(input,go);addCard.append(el('h3','Handleliste'),needChips,form,el('p',listNeed==='now'?'Nærmeste butikk, eller en annen nærbutikk hvis det lønner seg.':'Vi finner det beste stedet å kjøpe den.','shop-sub'));root.append(addCard);
    const groups=new Map();
    for(const entry of data.list.open){const key=entry.routing==='choose'&&entry.need!=='now'?'Velg vare':entry.routing==='pending'&&entry.need!=='now'?'Finner beste sted …':entry.storeName??'Hvor som helst';const list=groups.get(key)??[];list.push(entry);groups.set(key,list);}
    if(!groups.size)root.append(el('p','Listen er tom. Legg på gode tilbud fra Kjøp nå, eller skriv inn det dere trenger.','shop-sub'));
    const rank=name=>name==='Velg vare'?-1:name==='Nærmeste butikk'?0:name==='Finner beste sted …'?3:name==='Hvor som helst'?2:1;
    for(const [store,entries] of [...groups].sort((a,b)=>rank(a[0])-rank(b[0]))){
      const section=el('section',undefined,'shop-store'),head=el('div',undefined,'shop-store-head'),save=entries.reduce((n,x)=>n+(x.saving??0),0);
      head.append(el('h3',store),el('span',`${entries.length} ${entries.length===1?'vare':'varer'}${save?` · spar ${kr(save)}`:''}`,'shop-sub'));
      const lineGroups=splitCheaper(entries);
      section.append(head);
      if(lineGroups.cheaper.length)section.append(el('p',`Billigere et annet sted (${lineGroups.cheaper.length})`,'shop-group-label'),...lineGroups.cheaper.map(listRow));
      if(lineGroups.cheaper.length&&lineGroups.rest.length)section.append(el('p','Resten','shop-group-label'));
      section.append(...lineGroups.rest.map(listRow));root.append(section);
    }
    cartHolder=el('div');
    if(data.oda.connected)root.append(cartHolder);
    if(data.odaDraft.items.length)root.append(odaDraftCard());
    drawCart();loadCart();
    if(data.list.done.length)root.append(details('done',`Kjøpt (${data.list.done.length})`,node=>{node.append(...data.list.done.map(listRow),button('Tøm kjøpte',()=>act(()=>api('/list',{action:'clear'}))));},'shop-fold'));
  }

  // ---- Lager ----
  function resetStockDraft(){for(const url of stockPreviews.values())URL.revokeObjectURL(url);stockPreviews.clear();Object.assign(stockDraft,{text:'',location:'',mode:'minimum',files:[],intakeId:null,clientId:crypto.randomUUID()});}
  function stockIntakeCard() {
    const card=el('section',undefined,'shop-card shop-stock-intake'),form=el('form'),description=el('textarea');
    description.rows=3;description.maxLength=2000;description.placeholder='For eksempel: 400 gram kyllingfilet og 15 tomatbokser à 400 g';description.value=stockDraft.text;description.setAttribute('aria-label','Hva har du på lager?');description.oninput=()=>{stockDraft.text=description.value;};
    const where=el('input');where.placeholder='For eksempel: fryser i boden, øverste skuff';where.maxLength=120;where.value=stockDraft.location;where.setAttribute('aria-label','Hvor ligger varene?');where.oninput=()=>{stockDraft.location=where.value;};
    const mode=el('select');for(const [value,label] of [['minimum','Bare det som er synlig – behold minst dette'],['replace','Jeg har telt hele beholdningen av disse varene']])mode.append(Object.assign(el('option',label),{value}));mode.value=stockDraft.mode;mode.onchange=()=>{stockDraft.mode=mode.value;};mode.setAttribute('aria-label','Hvor komplett er tellingen?');
    const photos=el('input');photos.type='file';photos.accept='image/jpeg,image/png,image/webp';photos.multiple=true;photos.setAttribute('aria-label','Bilder av lageret');
    const previews=el('div',undefined,'shop-stock-previews');
    const showPhotos=()=>{previews.replaceChildren();for(const file of stockDraft.files){if(!stockPreviews.has(file))stockPreviews.set(file,URL.createObjectURL(file));const figure=el('figure'),img=el('img');img.src=stockPreviews.get(file);img.alt=file.name;figure.append(img,el('figcaption',file.name));previews.append(figure);}};
    photos.onchange=()=>{const selected=[...photos.files];if(selected.length>8||selected.some(f=>f.size>10*1024*1024)||selected.reduce((n,f)=>n+f.size,0)>40*1024*1024){photos.value='';toast('Velg opptil åtte bilder, maks 10 MB hver og 40 MB totalt.');return;}for(const url of stockPreviews.values())URL.revokeObjectURL(url);stockPreviews.clear();stockDraft.files=selected;showPhotos();};showPhotos();
    const submit=el('button',stockSending?'Sender …':stockDraft.intakeId?'Fortsett innsending':'La agenten telle','primary');submit.type='submit';submit.disabled=stockSending;
    for(const input of [description,where,mode,photos])input.disabled=stockSending||!!stockDraft.intakeId;
    const error=el('p','','shop-error');error.setAttribute('role','status');
    form.onsubmit=async event=>{
      event.preventDefault();if(stockSending)return;
      if(!stockDraft.text.trim()&&!stockDraft.files.length){error.textContent='Skriv hva du har, eller velg et bilde.';return;}
      stockSending=true;submit.disabled=true;submit.textContent='Sender …';for(const input of [description,where,mode,photos])input.disabled=true;
      try{
        if(!stockDraft.intakeId){const entry=await api('/stock-intake',{clientId:stockDraft.clientId,text:stockDraft.text,location:stockDraft.location,mode:stockDraft.mode,fileCount:stockDraft.files.length});stockDraft.intakeId=entry.id;}
        for(let slot=0;slot<stockDraft.files.length;slot++){const file=stockDraft.files[slot],response=await fetch(base+'/stock-intake/'+stockDraft.intakeId+'/files/'+slot,{method:'POST',credentials:'same-origin',headers:{'X-Family-Request':'1','X-File-Name':encodeURIComponent(file.name)},body:file,signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error((await response.json()).error??'Bildet kunne ikke lastes opp.');}
        await api('/stock-intake/'+stockDraft.intakeId+'/submit',{});resetStockDraft();await load();stockSending=false;render(true);toast('Sendt. Agenten kobler varene og teller lageret.');
      }catch(problem){stockSending=false;render(true);toast(problem.message);}finally{stockSending=false;submit.disabled=false;if(!stockDraft.intakeId)for(const input of [description,where,mode,photos])input.disabled=false;}
    };
    const actions=el('div',undefined,'shop-actions');actions.append(submit);
    if(stockDraft.intakeId)actions.append(button('Avbryt innsending',()=>act(async()=>{await api('/stock-action',{id:stockDraft.intakeId,action:'cancel'});resetStockDraft();},'Innsending avbrutt.')));
    else if(stockDraft.text||stockDraft.files.length)actions.append(button('Tøm',()=>{resetStockDraft();render(true);}));
    card.append(el('h3','Fortell eller vis hva du har'),el('p','Skriv fritt, eller legg ved bilder av pantry, kjøleskap og fryser. Overlappende bilder av samme samling telles én gang.','shop-sub'));
    form.append(field('Varer og mengder',description),field('Plassering (valgfritt)',where),field('Tellemetode',mode),field('Bilder · JPG, PNG eller WebP',photos),previews,actions,error);card.append(form);return card;
  }
  function stockReports(root) {
    const reports=data.stockReports??[];if(!reports.length)return;
    const labels={uploading:'Ikke sendt ennå',queued:'Agenten teller …',done:'Lageret er oppdatert',needs_input:'Trenger avklaring',acknowledged:'Avklaring sett'};
    root.append(details('stock-reports','Lagertellinger ('+reports.length+')',holder=>{
      for(const report of reports.slice(0,12)){
        const row=el('article',undefined,'shop-stock-report');row.append(el('strong',labels[report.status]??report.status),el('p',[report.text,report.location].filter(Boolean).join(' · '),'shop-sub'));
        if(report.result){for(const change of report.result.changes)row.append(el('p',change.name+': '+amount(change.amount,change.unit)+(report.mode==='minimum'?' (minst)':'')));for(const missing of report.result.unmatched)row.append(el('p',missing.description+' · '+missing.reason,'shop-error'));row.append(el('p',report.result.evidence,'shop-sub'));}
        else if(report.note)row.append(el('p',report.note,'shop-sub'));
        if(report.result?.changes.length)row.append(button('Angre telling',()=>act(()=>api('/stock-action',{id:report.id,action:'undo'}),'Tellingen er angret.')));
        if(report.status==='needs_input')row.append(button('Jeg har sett avklaringen',()=>act(()=>api('/stock-action',{id:report.id,action:'dismiss'}),'Avklaringen er lukket.')));
        if(['uploading','queued'].includes(report.status))row.append(button('Avbryt',()=>act(()=>api('/stock-action',{id:report.id,action:'cancel'}),'Tellingen er avbrutt.')));
        holder.append(row);
      }
    },'shop-fold'));
  }
  function pantryRow(item) {
    const row=el('div',undefined,'shop-item');
    const head=button('',()=>itemDialog(item),'shop-item-head');
    const title=el('span',undefined,'shop-item-title');
    const status=el('span',stockSummary(item)+(item.stockEvidence?.estimated?' · anslag fra bilde':'')+(item.stock.needsCheck?' · sjekk gjerne':''),'shop-sub');
    title.append(el('strong',item.name),status);
    head.append(thumb(item.image),title,el('span','›','shop-chevron'));
    row.append(head);
    row.append(stockEditor(item,updated=>{status.textContent=stockSummary(updated);}));
    return row;
  }
  function pantryList(holder) {
    const needle=search.toLocaleLowerCase('nb-NO');
    const items=data.items.filter(x=>(location==='all'||x.storage===location)&&x.name.toLocaleLowerCase('nb-NO').includes(needle));
    holder.replaceChildren();
    for(const group of PANTRY_GROUPS){const members=items.filter(x=>pantryGroup(x)===group).sort((a,b)=>a.name.localeCompare(b.name,'nb'));if(!members.length)continue;const section=el('section',undefined,'shop-pantry-group'),head=el('div',undefined,'shop-store-head');head.append(el('h3',group),el('span',members.filter(x=>x.stock.known).length+' av '+members.length+' telt','shop-sub'));section.append(head,...members.map(pantryRow));holder.append(section);}
    if(!items.length)holder.append(el('p','Ingen varer her.','shop-sub'));
  }
  // Each scan is one family action on one package; unknown codes change nothing.
  function scanDialog() {
    const box=el('dialog',undefined,'shop-dialog shop shop-scan'),video=el('video'),status=el('p','Hold strekkoden foran kameraet.','shop-sub'),result=el('div',undefined,'shop-scan-result');
    video.muted=true;let stopCamera=null;
    const close=()=>{stopCamera?.();box.close();box.remove();if(dirty){dirty=false;load().then(()=>render(true)).catch(()=>{});}};
    const code=el('input');code.inputMode='numeric';code.placeholder='Eller skriv tallene under strekkoden';code.maxLength=14;code.setAttribute('aria-label','Strekkode');
    const startCamera=async()=>{
      if(!navigator.mediaDevices?.getUserMedia){status.textContent='Kameraet er ikke tilgjengelig her. Skriv tallene under strekkoden.';video.hidden=true;return;}
      try{const {scanCamera}=await import('./barcode.mjs');video.hidden=false;status.textContent='Hold strekkoden foran kameraet.';stopCamera=await scanCamera(video,show);}
      catch{status.textContent='Fikk ikke brukt kameraet. Skriv tallene under strekkoden.';video.hidden=true;}
    };
    async function show(ean) {
      result.replaceChildren();status.textContent='Slår opp '+ean+' …';
      try{
        const found=await api('/stock-scan',{action:'lookup',ean});
        if(!found.options.length){status.textContent=found.knownProduct?found.knownProduct+' er ikke koblet til en lagervare ennå. Bruk tekst eller bilde.':'Fant ikke denne varen. Bruk tekst eller bilde.';}
        else status.textContent=found.options.length>1?'Velg riktig vare:':found.options[0].productName;
        for(const option of found.options){
          const row=el('div',undefined,'shop-scan-option'),apply=count=>{const clientId=crypto.randomUUID();(async()=>{try{const saved=await api('/stock-scan',{action:'apply',ean,watchId:option.watchId,packAmount:option.packAmount,count,clientId});dirty=true;result.replaceChildren();status.textContent=saved.name+': '+amount(saved.amount,saved.unit)+' på lager.';const undo=button('Angre',async()=>{try{await api('/stock-scan',{action:'undo',id:saved.id});status.textContent='Angret.';result.replaceChildren(again());dirty=true;}catch(error){status.textContent=error.message;}});result.append(undo,again());}catch(error){status.textContent=error.message;}})();};
          row.append(el('strong',option.name),el('span',packLabel(option.packAmount,option.unit),'shop-sub'),button('Kjøpt, legg til',()=>apply(1),'primary'),button('Brukt opp',()=>apply(-1)));
          result.append(row);
        }
        result.append(again());
      }catch(error){status.textContent=error.message;result.replaceChildren(again());}
    }
    const again=()=>button('Skann en til',()=>{result.replaceChildren();code.value='';startCamera();});
    const form=el('form',undefined,'shop-check'),go=el('button','Slå opp');go.type='submit';form.append(code,go);
    form.onsubmit=event=>{event.preventDefault();const value=code.value.trim();if(value){stopCamera?.();show(value);}};
    const actions=el('div',undefined,'shop-actions');actions.append(button('Lukk',close));
    box.append(el('h2','Skann strekkode'),video,status,result,form,actions);box.oncancel=event=>{event.preventDefault();close();};
    document.body.append(box);box.showModal();startCamera();
  }
  function renderPantry(root) {
    const known=data.items.filter(x=>x.stock.known).length;
    const intro=el('section',undefined,'shop-hero');
    intro.append(el('div','Hva har vi hjemme?','shop-hero-number small'),el('p',`${known} av ${data.items.length} varer er registrert. Tell pakker en gang, så trekker vi fra etter hvert som dere bruker, og «Kjøpt» legger til.`,'shop-sub'));
    const input=el('input');input.type='search';input.placeholder='Finn en vare';input.value=search;input.setAttribute('aria-label','Søk i lageret');
    const list=el('div',undefined,'shop-list');
    input.oninput=()=>{search=input.value;pantryList(list);};
    root.append(intro);
    if(!isKiosk())root.append(button('Skann strekkode',scanDialog,'shop-scan-open'));
    root.append(details('stock-input','Oppdater lager med tekst eller bilder',holder=>holder.append(stockIntakeCard()),'shop-fold'));stockReports(root);
    root.append(input,chips(LOCATIONS,location,value=>{location=value;render(true);},'Velg sted'),button('Legg til vare manuelt',()=>itemDialog(null),'shop-add'),list);
    pantryList(list);
  }

  // ---- Varedetalj ----
  let dialog=null;
  function itemDialog(item) {
    dialog?.remove();
    dialog=el('dialog',undefined,'shop-dialog shop');
    const form=el('form');
    const values={shelfLifeMonths:item?.shelfLifeMonths??12};
    form.append(el('h2',item?item.name:'Ny vare'));
    const inputs={};
    const add=(key,label,type,value,attrs={})=>{const input=el('input');input.type=type;input.value=value??'';Object.assign(input,attrs);inputs[key]=input;form.append(field(label,input));return input;};
    if(!item){
      add('name','Navn','text','',{required:true,maxLength:120});
      const unit=el('select');for(const value of ['kg','l','stk'])unit.append(Object.assign(el('option',value),{value}));inputs.unit=unit;form.append(field('Enhet',unit));
      const storage=el('select');for(const [value,text] of LOCATIONS.slice(1))storage.append(Object.assign(el('option',text),{value}));inputs.storage=storage;form.append(field('Hvor oppbevares den?',storage));
    }else{
      const facts=el('dl',undefined,'shop-facts'),fact=(a,b)=>{facts.append(el('dt',a),el('dd',b));};
      const p=item.prices,unit=item.unit,show=v=>v!=null?`${price(v)}/${unit}`:'–';
      fact('Vanlig',show(p.normal));fact('Bra',show(p.good));fact('Svært bra',show(p.excellent));
      if(p.current)fact('Billigst nå',`${show(p.current)} hos ${p.currentChain}`);
      if(p.lowestSeen)fact(`Lavest på ${p.historyDays} dager`,show(p.lowestSeen));
      form.append(facts,el('p',p.basis,'shop-sub'));
    }
    const shelfWrap=el('div',undefined,'shop-field');
    const drawShelf=()=>shelfWrap.replaceChildren(el('span',`Hvor lenge holder den?${item&&!item.shelfCustom?' (vårt anslag)':''}`),chips(SHELF_CHOICES,values.shelfLifeMonths,v=>{values.shelfLifeMonths=v;drawShelf();},'Holdbarhet'));
    drawShelf();form.append(shelfWrap);
    add('annualAmount',`Bruker dere per år${item?` (${item.unit})`:''}`,'number',item?.annualBasis==='household-estimate'?item.annualAmount:'',{min:0,step:'any',placeholder:item?.annualAmount!=null?`Nå regnet ${nf(1).format(item.annualAmount)}`:'Ukjent'});
    if(item)form.append(details('limits:'+item.id,'Egne prisgrenser',node=>{
      for(const [key,label,value] of [['targetPrice','Bra pris under',item.prices.targetPrice],['excellentPrice','Svært bra pris under',item.prices.excellent]]){const input=el('input');input.type='number';input.min='0';input.step='0.01';input.value=value??'';input.dataset.original=input.value;inputs[key]=input;node.append(field(label,input));}
      node.append(el('p','Egne grenser beholdes når prisene oppdateres om morgenen.','shop-sub'));
    },'shop-why'));
    const error=el('p','','shop-error'),save=el('button','Lagre','primary');save.type='submit';
    const row=el('div',undefined,'shop-actions');
    row.append(save);
    if(item)row.append(button(item.enabled?'Stopp overvåking':'Start overvåking',()=>{dialog.close();act(()=>api('/item',{id:item.id,enabled:!item.enabled}),item.enabled?'Overvåking stoppet.':'Overvåking startet.');}));
    row.append(button('Lukk',()=>dialog.close()));
    form.append(error,row);
    form.onsubmit=async event=>{
      event.preventDefault();save.disabled=true;
      try{
        const payload=item?{id:item.id}:{name:inputs.name.value,unit:inputs.unit.value,storage:inputs.storage.value};
        payload.shelfLifeMonths=values.shelfLifeMonths;
        if(inputs.annualAmount.value!=='')payload.annualAmount=Number(inputs.annualAmount.value);else if(item?.annualBasis==='household-estimate')payload.annualAmount=null;
        for(const key of ['targetPrice','excellentPrice'])if(inputs[key]&&inputs[key].value!==inputs[key].dataset.original)payload[key]=inputs[key].value===''?null:Number(inputs[key].value);
        await api('/item',payload);
        dialog.close();await load();render(true);toast('Lagret.');
      }catch(problem){error.textContent=problem.message;save.disabled=false;}
    };
    dialog.append(form);
    (compact?document.body:document.body).append(dialog);
    dialog.showModal();
  }

  // ---- Innsikt ----
  function renderInsight(root) {
    const hero=el('section',undefined,'shop-hero');
    hero.append(el('p','Spart med «Kjøpt»-knappen','shop-sub'),el('div',`${kr(data.saved.year)} i år`,'shop-hero-number'),el('p',`${kr(data.saved.all)} totalt`,'shop-sub'));
    root.append(hero);
    if(data.purchases.length){
      const card=el('section',undefined,'shop-card');card.append(el('h3','Siste kjøp'));
      for(const entry of data.purchases.slice(0,10)){const row=el('div',undefined,'shop-row');row.append(el('span',`${entry.name} · ${entry.packs} pk`),el('strong',entry.saving!=null?`Spart ${kr(entry.saving)}`:kr(entry.total)));card.append(row);}
      root.append(card);
    }
    const a=data.analysis,money=el('section',undefined,'shop-card');
    money.append(el('h3','Hvor går pengene?'),el('p',`${a.orderCount} bestillinger hos Oda på ett år, ${kr(a.orderTotal)}. Kjøp i andre butikker er ikke med.`,'shop-sub'));
    const biggest=a.categories[0]?.amount||1;
    for(const category of a.categories.slice(0,8)){
      const row=el('div',undefined,'shop-cat'),bar=el('div',undefined,'shop-bar'),fill=el('span');
      fill.style.width=`${category.amount/biggest*100}%`;bar.append(fill);
      const label=el('div',undefined,'shop-row');label.append(el('span',category.name),el('span',kr(category.amount)));
      row.append(label,bar);money.append(row);
    }
    money.append(details('top','Varene dere bruker mest på',node=>{for(const product of a.top){const row=el('div',undefined,'shop-row');row.append(el('span',product.name),el('strong',kr(product.spent)));node.append(row);}},'shop-why'));
    root.append(money);
    root.append(details('stores',`Butikker (${data.storesCheckedToday} av ${data.stores.length} sjekket i dag)`,node=>{
      for(const store of data.stores){const row=el('div',undefined,'shop-row');row.append(el('span',store.name),el('span',store.status==='ok'?'Sjekket':store.status==='blocked'?'Fikk ikke sjekket':'Ikke sjekket','shop-sub'));node.append(row);}
      if(data.oda.connected){const sync=button('Hent nye Oda-bestillinger',()=>act(async()=>{const result=await api('/oda/sync',{});if(!result.complete)throw Error(result.note);},'Oda er oppdatert.'));node.append(sync);}
    },'shop-fold'));
  }

  function render(keepScroll=false) {
    if(!data)return;
    const y=window.scrollY;
    panel.replaceChildren();
    const refresh=button('Nye priser er klare · oppdater',async()=>{try{await load();render();}catch(error){fail(error);}},'shop-refresh');
    refresh.hidden=!stale;
    const head=el('div',undefined,'shop-head');
    if(!compact)head.append(el('h2','Handel'));
    const tabs=el('div',undefined,'shop-tabs');tabs.setAttribute('role','tablist');
    for(const [key,label] of [['buy','Kjøp nå'],['list',`Liste${data.list.open.length?` (${data.list.open.length})`:''}`],['pantry','Lager'],['insight','Innsikt']]){
      const node=button(label,async()=>{tab=key;if(dirty){dirty=false;try{await load();}catch{}}render();window.scrollTo({top:panel.getBoundingClientRect().top+window.scrollY-20});},key===tab?'on':'');
      node.setAttribute('role','tab');node.setAttribute('aria-selected',String(key===tab));tabs.append(node);
    }
    head.append(tabs);
    const body=el('div',undefined,'shop-body');
    panel.append(head,refresh,body,toastNode);
    if(tab==='buy')renderBuy(body);else if(tab==='list')renderList(body);else if(tab==='pantry')renderPantry(body);else renderInsight(body);
    if(keepScroll)window.scrollTo({top:y});
  }
  async function open() {
    if(!data)panel.replaceChildren(el('p','Henter Handel …','shop-sub'));
    try{await load();render();}catch(error){panel.replaceChildren(el('h2','Handel'),el('p',error.message));}
  }
  poll();
  setInterval(poll,60000);
  setInterval(()=>{if(tab==='list'&&visible()&&!cartBusy)loadCart();},20000);
  return {open};
}
