// Family-facing shopping page, shared by the dashboard and the phone app.
// Polling only touches the banner, so reading and typing are never interrupted.
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
const BASIS_TEXT={'household-estimate':'etter det dere har oppgitt','planned-amount':'etter planlagt årsmengde','oda-lower-bound':'minst dette, ut fra kjøpene hos Oda','oda-share-estimate':'anslått ut fra Oda-kjøpene og hvor stor del av handelen de er'};
const HELD_TEXT={member:'krever medlemskap vi ikke har registrert','needs-review':'venter på at en vare sjekkes','stale-prices':'venter på ferske priser'};

export function installShoppingView({panel,banner=null,onOpen=()=>{},base='/api/shopping',compact=false}) {
  const draftEdits=new Map(),cartState=new Map(),cartIds=new Map();let cartBusy=false;
  const check={itemId:null,query:'',price:'',size:null,custom:'',customUnit:null};
  let listNeed='later';
  let dirty=false,data=null,tab='buy',search='',location='all',stale=false,odaQuery='',toastTimer=null;
  const chosen=new Map(),openSections=new Set();
  panel.classList.add('shop');
  const toastNode=el('div',undefined,'shop-toast');toastNode.setAttribute('role','status');toastNode.hidden=true;

  async function api(path,input) {
    const response=await fetch(base+path,{...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify(input)}),credentials:'same-origin',signal:AbortSignal.timeout(path==='/oda/sync'?300000:45000)});
    const body=await response.json();
    if(!response.ok)throw Error(body.error??'Noe gikk galt. Prøv igjen.');
    return body;
  }
  const visible=()=>compact?!panel.hidden:panel.classList.contains('active');
  function toast(message,undo) {
    clearTimeout(toastTimer);
    toastNode.replaceChildren(el('span',message));
    if(undo)toastNode.append(button('Angre',undo));
    toastNode.hidden=false;
    toastTimer=setTimeout(()=>{toastNode.hidden=true;},undo?9000:4000);
  }
  function fail(error){toast(error.message);}
  function updateBanner(summary) {
    if(!banner)return;
    banner.hidden=!summary.dealCount;
    banner.replaceChildren();
    if(!summary.dealCount)return;
    const lead=summary.excellentCount?`Svært bra pris på ${summary.top}`:`${summary.dealCount} gode kjøp denne uka`;
    banner.append(button(`${lead} · spar ${kr(summary.potential)} · se Handel`,onOpen));
  }
  async function load() {
    data=await api('/family');
    stale=false;
    updateBanner({...data.summary});
  }
  async function act(fn,message,undo) {
    try{await fn();await load();render(true);if(message)toast(message,undo);}catch(error){fail(error);}
  }
  async function poll() {
    try{
      const summary=await api('/summary');
      updateBanner(summary);
      if(data&&summary.rev!==data.rev&&visible()){
        // The shared list follows what others tick off, unless someone is typing.
        if(tab==='list'&&!cartBusy&&document.activeElement?.tagName!=='INPUT'){await load();render(true);}
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
        if(index>=0)data.items[index]=reply.item;
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
    const discount=normal?(1-unitPrice/normal)*100:0;
    const tier=(excellent!=null&&unitPrice<=excellent)||discount>=25?'excellent':goodLine!=null&&unitPrice<=goodLine?'good':normal==null||unitPrice<=normal?'normal':'dear';
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
    if(data.deals.length){
      hero.append(el('p','Denne uka','shop-sub'),el('div',`${kr(potential)} å spare`,'shop-hero-number'),el('p',`${data.deals.length} ${data.deals.length===1?'kjøp':'kjøp'} verdt å gjøre${data.saved.year?` · ${kr(data.saved.year)} spart i år`:''}`,'shop-sub'));
    }else{
      hero.append(el('div',data.monitoring?'Ingen kupp akkurat nå':'Tilbudsovervåkning er av','shop-hero-number small'),el('p',`${data.storesCheckedToday} butikker sjekket i dag${data.saved.year?` · ${kr(data.saved.year)} spart i år`:''}`,'shop-sub'));
    }
    root.append(hero,priceCheck());
    root.append(...storeSections(data.deals));
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
  function listRow(entry) {
    const row=el('div',undefined,'shop-list-row'+(entry.checkedAt?' done':''));
    const tick=el('input');tick.type='checkbox';tick.checked=!!entry.checkedAt;tick.setAttribute('aria-label',`Kjøpt: ${entry.name}`);
    tick.onchange=()=>act(()=>api('/list',{action:tick.checked?'check':'uncheck',id:entry.id}),tick.checked&&entry.watchId?'Lagt på lager.':null);
    const text=el('div',undefined,'shop-list-text'),qty=entry.packs&&entry.packAmount?`${entry.packs} × ${packLabel(entry.packAmount,entry.unit)} `:'';
    text.append(el('strong',qty+entry.name));
    const facts=[entry.reason,entry.detail,entry.unitPrice?`${price(entry.unitPrice)}/${entry.unit}`:null,entry.saving?`Spar ${kr(entry.saving)}`:null,entry.expired?'Tilbudet er over':entry.validTo?`Til ${dayLabel(entry.validTo)}`:null].filter(Boolean);
    if(facts.length)text.append(el('span',facts.join(' · '),'shop-sub'+(entry.expired?' shop-expired':'')));
    row.append(tick,text);
    if(entry.sourceUrl&&!isKiosk()){const source=link('Kilde ↗',entry.sourceUrl);source.className='shop-list-source';row.append(source);}
    const remove=button('×',()=>act(()=>api('/list',{action:'remove',id:entry.id})),'shop-list-remove');remove.setAttribute('aria-label',`Fjern ${entry.name}`);
    row.append(remove);
    return row;
  }
  function odaDraftCard() {
    const draft=data.odaDraft,card=el('section',undefined,'shop-card');
    const edit=item=>{if(!draftEdits.has(item.watchId))draftEdits.set(item.watchId,{on:!item.elsewhere,packs:item.packs});return draftEdits.get(item.watchId);};
    const selected=()=>draft.items.filter(x=>edit(x).on&&cartState.get(x.watchId)?.state!=='done'&&cartState.get(x.watchId)?.state!=='uncertain');
    const summary=el('p','','shop-sub'),go=el('button','','primary');go.type='button';
    let armed=false;
    const refresh=()=>{
      const list=selected(),sum=list.reduce((n,x)=>n+x.packPrice*edit(x).packs,0);
      summary.textContent=`${list.length} varer · ca. ${kr(sum)}${draft.covered?` · ${draft.covered} varer dekket av lageret`:''}`;
      go.textContent=armed?`Bekreft: legg ${list.length} varer i kurven`:`Legg ${list.length} varer i Oda-kurven`;
      go.disabled=!list.length||cartBusy;
    };
    card.append(el('h3','Neste storhandel hos Oda'),el('p',`Forslag til bestilling rundt ${dayLabel(draft.nextAround)}. Fersk frukt og andre varer velger dere selv.${draft.items.some(x=>x.stockKnown)?'':' Lageret er ikke talt ennå, så mengdene regner med at dere ikke har noe hjemme.'}`,'shop-sub'),summary);
    const rows=new Map();
    const body=details('draft',`Se varene (${draft.items.length})`,node=>{
      for(const item of draft.items){
        const row=el('div',undefined,'shop-draft-row'),state=edit(item);
        const on=el('input');on.type='checkbox';on.checked=state.on;on.setAttribute('aria-label',`Ta med ${item.name}`);
        on.onchange=()=>{state.on=on.checked;armed=false;refresh();};
        const text=el('div',undefined,'shop-list-text'),note={excellent:'Svært bra pris nå',good:'Bra pris nå',dear:'Dyrere enn vanlig, derfor lite'}[item.tier];
        text.append(el('strong',item.name),el('span',[item.productName,`${price(item.packPrice)}`,note,draft.items.some(x=>x.stockKnown)&&!item.stockKnown?'Lager ikke talt':null].filter(Boolean).join(' · '),'shop-sub'));
        const value=el('span',String(state.packs),'shop-step-value'),step=el('div',undefined,'shop-step');
        const change=delta=>{state.packs=Math.min(item.maxAtOda??100,Math.max(1,state.packs+delta));value.textContent=String(state.packs);armed=false;refresh();};
        step.append(button('−',()=>change(-1)),value,button('+',()=>change(1)));
        const status=el('span',cartState.get(item.watchId)?.text??'','shop-draft-status');
        row.append(on,text,step,status);
        if(item.elsewhere){
          const warn=el('div',undefined,'shop-warning');
          warn.append(el('span','Bør ikke kjøpes på Oda: '+item.elsewhere.diffPct+' % billigere hos '+item.elsewhere.storeName+' ('+price(item.elsewhere.unitPrice)+'/'+item.unit+', spar '+kr(item.elsewhere.saving)+').'));
          if(item.elsewhere.offerId)warn.append(button('Legg på listen dit',()=>act(()=>api('/list',{action:'add',offerId:item.elsewhere.offerId,packs:Math.max(1,Math.ceil(item.wanted*item.packAmount/item.elsewhere.packAmount))}),'Lagt på handlelisten.')));
          row.append(warn);
        }
        if(item.maxAtOda!=null&&item.wanted>item.maxAtOda)row.append(el('div','Oda tillater maks '+item.maxAtOda+' per bestilling. Resten, '+(item.wanted-item.maxAtOda)+' pk, må kjøpes et annet sted.','shop-limit'));
        else if(item.maxAtOda!=null)row.append(el('div','Maks '+item.maxAtOda+' hos Oda.','shop-limit quiet'));
        node.append(row);rows.set(item.watchId,status);
      }
    },'shop-why');
    card.append(body);
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
        cartBusy=false;refresh();if(added)toast(`${added} varer lagt i Oda-kurven. Se over og betal hos Oda.`);
      };
      const actions=el('div',undefined,'shop-actions');actions.append(go);card.append(actions);
      const review=el('div');
      const checkCart=button('Sjekk det som ligger i Oda-kurven',async()=>{
        checkCart.disabled=true;review.replaceChildren(el('p','Leser kurven …','shop-sub'));
        try{
          const result=await api('/oda/review',{});
          review.replaceChildren(el('p',result.lines.length?result.lines.length+' varer i kurven · '+kr(Number(result.total)):'Oda-kurven er tom.','shop-sub'));
          for(const text of result.messages)review.append(el('div',text,'shop-limit'));
          for(const line of result.lines){
            if(!line.elsewhere&&!line.limit)continue;
            const row=el('div',undefined,'shop-cart-line');row.append(el('strong',line.quantity+' × '+line.name));
            if(line.elsewhere)row.append(el('div','Bør ikke kjøpes på Oda: '+line.elsewhere.diffPct+' % billigere hos '+line.elsewhere.storeName+' (spar '+kr(line.elsewhere.saving)+').','shop-warning'));
            if(line.limit)row.append(el('div',line.limit,'shop-limit'));
            review.append(row);
          }
          if(result.lines.length&&!result.lines.some(x=>x.elsewhere||x.limit)&&!result.messages.length)review.append(el('p','Ingen varer å advare om.','shop-sub'));
        }catch(error){review.replaceChildren(el('p',error.message,'shop-sub'));}
        checkCart.disabled=false;
      },'shop-add');
      card.append(checkCart,review);
    }else card.append(el('p','Oda må kobles til for å legge varer i kurven.','shop-sub'));
    refresh();
    return card;
  }
  function renderList(root) {
    const addCard=el('section',undefined,'shop-card'),form=el('form',undefined,'shop-check'),input=el('input'),go=el('button','Legg til');
    const needChips=chips([['now','Trenger nå'],['later','Kan vente']],listNeed,value=>{listNeed=value;render(true);},'Hvor fort trengs det?');
    input.type='text';input.placeholder='Legg til vare';input.maxLength=120;input.className='shop-find';input.setAttribute('aria-label','Legg til vare');go.type='submit';
    form.onsubmit=event=>{event.preventDefault();const name=input.value.trim();if(name)act(()=>api('/list',{action:'add',name,need:listNeed}));};
    form.append(input,go);addCard.append(el('h3','Handleliste'),needChips,form,el('p',listNeed==='now'?'Går på listen til nærmeste butikk.':'Vi finner det beste stedet å kjøpe den.','shop-sub'));root.append(addCard);
    const groups=new Map();
    for(const entry of data.list.open){const key=entry.routing==='pending'?'Finner beste sted …':entry.storeName??'Hvor som helst';const list=groups.get(key)??[];list.push(entry);groups.set(key,list);}
    if(!groups.size)root.append(el('p','Listen er tom. Legg på gode tilbud fra Kjøp nå, eller skriv inn det dere trenger.','shop-sub'));
    const rank=name=>name==='Nærmeste butikk'?0:name==='Finner beste sted …'?3:name==='Hvor som helst'?2:1;
    for(const [store,entries] of [...groups].sort((a,b)=>rank(a[0])-rank(b[0]))){
      const section=el('section',undefined,'shop-store'),head=el('div',undefined,'shop-store-head'),save=entries.reduce((n,x)=>n+(x.saving??0),0);
      head.append(el('h3',store),el('span',`${entries.length} ${entries.length===1?'vare':'varer'}${save?` · spar ${kr(save)}`:''}`,'shop-sub'));
      section.append(head,...entries.map(listRow));root.append(section);
    }
    if(data.odaDraft.items.length)root.append(odaDraftCard());
    if(data.list.done.length)root.append(details('done',`Kjøpt (${data.list.done.length})`,node=>{node.append(...data.list.done.map(listRow),button('Tøm kjøpte',()=>act(()=>api('/list',{action:'clear'}))));},'shop-fold'));
  }

  // ---- Lager ----
  function pantryRow(item) {
    const row=el('div',undefined,'shop-item'+(item.enabled?'':' paused'));
    const head=button('',()=>itemDialog(item),'shop-item-head');
    const title=el('span',undefined,'shop-item-title');
    const status=el('span',stockSummary(item)+(item.stock.needsCheck?' · sjekk gjerne':''),'shop-sub');
    title.append(el('strong',item.name),status);
    head.append(title,el('span','›','shop-chevron'));
    row.append(head);
    row.append(stockEditor(item,updated=>{status.textContent=stockSummary(updated);}));
    return row;
  }
  function pantryList(holder) {
    const needle=search.toLocaleLowerCase('nb-NO');
    const items=data.items.filter(x=>(location==='all'||x.storage===location)&&x.name.toLocaleLowerCase('nb-NO').includes(needle));
    holder.replaceChildren(...items.map(pantryRow));
    if(!items.length)holder.append(el('p','Ingen varer her.','shop-sub'));
  }
  function renderPantry(root) {
    const known=data.items.filter(x=>x.stock.known).length;
    const intro=el('section',undefined,'shop-hero');
    intro.append(el('div','Hva har vi hjemme?','shop-hero-number small'),el('p',`${known} av ${data.items.length} varer er registrert. Tell pakker en gang, så trekker vi fra etter hvert som dere bruker, og «Kjøpt» legger til.`,'shop-sub'));
    const input=el('input');input.type='search';input.placeholder='Finn en vare';input.value=search;input.setAttribute('aria-label','Søk i lageret');
    const list=el('div',undefined,'shop-list');
    input.oninput=()=>{search=input.value;pantryList(list);};
    root.append(intro,input,chips(LOCATIONS,location,value=>{location=value;render(true);},'Velg sted'),button('Legg til vare',()=>itemDialog(null),'shop-add'),list);
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
  return {open};
}
