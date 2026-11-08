// Family-facing shopping page, shared by the dashboard and the phone app.
// Polling only touches the banner, so reading and typing are never interrupted.
const nf=(digits)=>new Intl.NumberFormat('nb-NO',{maximumFractionDigits:digits});
const kr=value=>`${nf(0).format(value)} kr`;
const price=value=>`${nf(2).format(value)} kr`;
const amount=(value,unit)=>`${nf(value<10?1:0).format(value)} ${unit}`;
const dayLabel=day=>new Intl.DateTimeFormat('nb-NO',{timeZone:'Europe/Oslo',weekday:'short',day:'numeric',month:'short'}).format(new Date(day+'T12:00:00Z'));
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

const STOCK_LEVELS=[[0,'Tomt'],[1,'1 mnd'],[3,'3 mnd'],[6,'6 mnd'],[12,'1 år']];
const SHELF_CHOICES=[[1,'1 mnd'],[3,'3 mnd'],[6,'6 mnd'],[9,'9 mnd'],[12,'1 år']];
const LOCATIONS=[['all','Alt'],['frozen','Fryser'],['pantry','Tørrvarer'],['chilled','Kjøl']];
const TIER_LABEL={excellent:'Svært bra pris',good:'Bra pris',small:'Liten rabatt'};
const BASIS_TEXT={'household-estimate':'etter det dere har oppgitt','planned-amount':'etter planlagt årsmengde','oda-lower-bound':'minst dette, ut fra kjøpene hos Oda','oda-share-estimate':'anslått ut fra Oda-kjøpene og hvor stor del av handelen de er'};
const HELD_TEXT={member:'krever medlemskap vi ikke har registrert','needs-review':'venter på at en vare sjekkes','stale-prices':'venter på ferske priser'};

export function installShoppingView({panel,banner=null,onOpen=()=>{},base='/api/shopping',compact=false}) {
  let data=null,tab='buy',search='',location='all',stale=false,odaQuery='',toastTimer=null;
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
      if(data&&summary.rev!==data.rev&&visible()&&!stale){stale=true;panel.querySelector('.shop-refresh')?.removeAttribute('hidden');}
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
  const nearestLevel=months=>months==null?null:STOCK_LEVELS.reduce((best,[m])=>Math.abs(m-months)<Math.abs(best-months)?m:best,0);
  function setStock(item,months) {
    return act(()=>api('/pantry',{watchId:item.id??item.watchId,months}),null);
  }

  // ---- Kjøp nå ----
  function dealCard(deal) {
    const card=el('article',undefined,'shop-deal '+deal.tier);
    const option=deal.options.find(x=>x.key===chosen.get(deal.offerId))??deal.options.find(x=>x.key===deal.recommendedKey)??deal.options[0];
    const badges=el('div',undefined,'shop-badges');
    badges.append(el('span',TIER_LABEL[deal.tier],'shop-badge '+deal.tier));
    if(deal.lowestSeen)badges.append(el('span','Laveste vi har sett','shop-badge low'));
    if(deal.validFrom>data.today)badges.append(el('span',`Fra ${dayLabel(deal.validFrom)}`,'shop-badge later'));
    const source=link(`Se tilbudet hos ${deal.storeName.replace(/\s*\(.*\)$/,'')} ↗`,deal.sourceUrl);
    source.className='shop-source';
    card.append(badges,el('h4',deal.watchName),el('p',deal.name,'shop-sub'),source);
    const line=el('p',undefined,'shop-price');
    line.append(el('strong',`${price(deal.unitPrice)}/${deal.unit}`),el('span',` · ${deal.referenceType==='target'?'grensen er':'vanlig'} ${price(deal.referencePrice)}/${deal.unit}${deal.discountPct>=1?` · ${nf(0).format(deal.discountPct)} % lavere`:''}`));
    card.append(line);
    if(deal.options.length>1){
      card.append(chips(deal.options.map(x=>[x.key,x.label]),option.key,key=>{chosen.set(deal.offerId,key);render(true);},'Velg mengde'));
    }
    const total=el('div',undefined,'shop-total');
    total.append(el('span',`${option.packs} ${option.packs===1?'pakke':'pakker'} · ${amount(option.amount,deal.unit)} · ${kr(option.cost)}`));
    if(option.saving!=null)total.append(el('strong',`Spar ${kr(option.saving)}`));
    card.append(total);
    const notes=[];
    if(deal.tier==='good'&&deal.fullMonths===3)notes.push('Bra, men ikke et kupp, så vi foreslår 3 måneder.');
    else if(deal.tier!=='small'&&deal.fullMonths!=null&&deal.fullMonths<(deal.tier==='excellent'?12:3))notes.push(`Holder ca. ${monthsText(deal.fullMonths)}, så vi foreslår ikke mer.`);
    if(deal.stock.known&&deal.stock.months!=null)notes.push(`Dere har ca. ${monthsText(deal.stock.months)} på lager.`);
    if(deal.bestBefore)notes.push(`Best før ${dayLabel(deal.bestBefore)}.`);
    if(deal.maxPacks)notes.push(`Maks ${deal.maxPacks} per kunde.`);
    if(deal.bundlePacks>1)notes.push(`Kjøp ${deal.bundlePacks} og ${deal.bundlePacks}.`);
    if(deal.memberOnly)notes.push('Krever medlemskap.');
    if(deal.alsoAt.length)notes.push(`Også hos ${deal.alsoAt.map(x=>`${x.storeName} (${price(x.unitPrice)})`).join(', ')}.`);
    if(notes.length)card.append(el('p',notes.join(' '),'shop-sub'));
    if(!deal.stock.known&&deal.annualAmount!=null){
      const ask=el('div',undefined,'shop-ask');
      ask.append(el('span','Har dere noe fra før?','shop-sub'),chips(STOCK_LEVELS,null,months=>setStock(deal,months),'Hvor mye har dere?'));
      card.append(ask);
    }
    const actions=el('div',undefined,'shop-actions');
    actions.append(
      button('Kjøpt',()=>act(()=>api('/deal',{offerId:deal.offerId,action:'bought',packs:option.packs}),`${deal.watchName} er lagt på lager${option.saving!=null?`, ${kr(option.saving)} spart`:''}.`,()=>act(()=>api('/deal',{offerId:deal.offerId,action:'undo'}),'Angret.')),'primary'),
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
  function verdict(item,value) {
    const {normal,good,excellent}=item.prices,unit=item.unit,hasAtLeast=months=>item.stock.known&&item.stock.months!=null&&item.stock.months>=Math.min(months,item.shelfLifeMonths);
    if(!(value>0))return `Skriv inn prisen per ${unit}.`;
    if(!normal&&!item.prices.targetPrice)return 'Vi har for lite prisdata på denne varen ennå.';
    const buy=months=>{const span=Math.min(months,item.shelfLifeMonths);return hasAtLeast(months)?'Men dere har nok på lager.':`Kjøp ${span>=12?'for et helt år':`for ${monthsText(span)}`}.`;};
    if(excellent!=null&&value<=excellent)return `Svært bra pris. ${buy(12)}`;
    if(good!=null&&value<=good)return `Bra pris. ${buy(3)}`;
    if(normal==null||value<=normal)return 'Vanlig pris. Kjøp bare det dere trenger nå.';
    return `Dyrt. Vanlig pris er ${price(normal)}/${unit}.`;
  }
  function priceCheck() {
    const card=el('section',undefined,'shop-card');
    const select=el('select'),input=el('input'),out=el('p','','shop-verdict');
    select.setAttribute('aria-label','Velg vare');
    for(const item of [...data.items].sort((a,b)=>a.name.localeCompare(b.name,'nb')))if(item.prices.normal||item.prices.targetPrice){const option=el('option',item.name);option.value=item.id;select.append(option);}
    input.type='number';input.inputMode='decimal';input.min='0';input.step='0.01';input.placeholder='kr';input.setAttribute('aria-label','Pris per enhet');
    const unit=el('span','','shop-unit');
    const update=()=>{const item=data.items.find(x=>x.id===select.value);if(!item)return;unit.textContent=`kr/${item.unit}`;out.textContent=input.value?verdict(item,Number(input.value)):'';};
    select.onchange=update;input.oninput=update;
    const row=el('div',undefined,'shop-check');row.append(select,input,unit);
    card.append(el('h3','Er dette en god pris?'),row,out);
    update();
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
        if(data.oda.connected)row.append(button('Finn i Oda',()=>{odaQuery=item.name;openSections.add('oda');render(true);panel.querySelector('.shop-oda')?.scrollIntoView({block:'center'});}));
        card.append(row);
      }
      root.append(card);
    }
    if(data.smallDeals.length)root.append(details('small',`Små tilbud på turer dere uansett tar (${data.smallDeals.length})`,node=>node.append(...storeSections(data.smallDeals)),'shop-fold'));
    if(data.belowTrip.length)root.append(details('below',`Bra pris, men ikke verdt en egen tur (${data.belowTrip.length})`,node=>node.append(...storeSections(data.belowTrip)),'shop-fold'));
    if(data.covered.length)root.append(details('covered',`Godt tilbud, men dere har nok (${data.covered.length})`,node=>{for(const deal of data.covered)node.append(el('p',`${deal.watchName} hos ${deal.storeName}: ${price(deal.unitPrice)}/${deal.unit}. Dere har ca. ${monthsText(deal.stock.months??0)} på lager.`,'shop-sub'));},'shop-fold'));
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
              try{const receipt=await api('/oda/add',{requestId:crypto.randomUUID(),productId:product.id,quantity:Number(qty.value)});row.append(link('Lagt til · se kurven',receipt.url));}catch(error){add.disabled=false;fail(error);}
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

  // ---- Lager ----
  function stockText(item) {
    if(!item.stock.known)return 'Ikke registrert';
    if(item.stock.amount<=0)return 'Tomt';
    return item.stock.months!=null?`ca. ${monthsText(item.stock.months)} igjen · ${amount(item.stock.amount,item.unit)}`:amount(item.stock.amount,item.unit);
  }
  function pantryRow(item) {
    const row=el('div',undefined,'shop-item'+(item.enabled?'':' paused'));
    const head=button('',()=>itemDialog(item),'shop-item-head');
    const title=el('span',undefined,'shop-item-title');
    title.append(el('strong',item.name),el('span',stockText(item)+(item.stock.needsCheck?' · sjekk gjerne':''),'shop-sub'));
    head.append(title,el('span','›','shop-chevron'));
    row.append(head);
    if(item.stock.known&&item.stock.months!=null){
      const bar=el('div',undefined,'shop-bar'),fill=el('span');
      fill.style.width=`${Math.min(100,item.stock.months/12*100)}%`;
      if(item.stock.months<1)fill.className='low';
      bar.append(fill);row.append(bar);
    }
    if(item.annualAmount!=null)row.append(chips(STOCK_LEVELS,nearestLevel(item.stock.months),months=>setStock(item,months),`Beholdning av ${item.name}`));
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
    intro.append(el('div','Hva har vi hjemme?','shop-hero-number small'),el('p',`${known} av ${data.items.length} varer er registrert. Beholdningen telles ned av seg selv, og «Kjøpt» legger til.`,'shop-sub'));
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
    for(const [key,label] of [['buy','Kjøp nå'],['pantry','Lager'],['insight','Innsikt']]){
      const node=button(label,()=>{tab=key;render();window.scrollTo({top:panel.getBoundingClientRect().top+window.scrollY-20});},key===tab?'on':'');
      node.setAttribute('role','tab');node.setAttribute('aria-selected',String(key===tab));tabs.append(node);
    }
    head.append(tabs);
    const body=el('div',undefined,'shop-body');
    panel.append(head,refresh,body,toastNode);
    if(tab==='buy')renderBuy(body);else if(tab==='pantry')renderPantry(body);else renderInsight(body);
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
