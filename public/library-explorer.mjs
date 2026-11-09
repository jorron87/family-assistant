// The product explorer: browse, filter and compare the reviewed product library.
// Read-only by design: nothing on this page changes a list, a cart or a review.
import {NUTRIENTS,PRICE_AXIS,LABELS,STATUSES,SORTS,emptyFilters,isPristine,prepareExplorer,explore,sortItems,familySummaries,sortFamilies,scatterPoints,axisDomain,ticks,axisValue,proteinPerKrone,isFresh} from './library-explorer-core.mjs';

const nf=digits=>new Intl.NumberFormat('nb-NO',{maximumFractionDigits:digits});
const money=value=>nf(2).format(value)+' kr';
const whole=value=>nf(0).format(value);
const short=value=>nf(value<10?1:0).format(value);
function el(tag,text,cls) {
  const node=document.createElement(tag);
  if(text!==undefined&&text!==null)node.textContent=text;
  if(cls)node.className=cls;
  return node;
}
function button(label,action,cls) {
  const node=el('button',label,cls);
  node.type='button';node.onclick=action;
  return node;
}
function packText(amount,unit) {
  if(!amount||!unit)return null;
  if(unit==='kg')return amount<1?whole(amount*1000)+' g':short(amount)+' kg';
  if(unit==='l')return amount<1?whole(amount*100)+' cl':short(amount)+' l';
  return whole(amount)+' '+unit;
}
function ago(at,now) {
  if(at===null)return 'ukjent dato';
  const days=Math.floor((now-at)/86400000);
  if(days<1)return 'i dag';if(days===1)return 'i går';if(days<31)return days+' dager siden';
  return new Intl.DateTimeFormat('nb-NO',{month:'short',year:'numeric',timeZone:'Europe/Oslo'}).format(new Date(at)).replace('.','');
}
const AXES=[...NUTRIENTS,PRICE_AXIS];
const axisOf=key=>AXES.find(a=>a.key===key);
const axisTitle=axis=>axis.key==='price'?'Pris, kr per kg (fersk)':`${axis.label}, ${axis.unit} per 100 g/ml`;
const LEVEL=['Næring: svakere','Næring: middels','Næring: god'];
const QUALITY_NOTE='Tallet gjelder bare varer målt på nøyaktig samme måte. Det er ingen helsevurdering.';
const DISCOVER=[
  ['Mye protein','Minst 20 g protein per 100 g/ml',{range:['protein',20,null]}],
  ['Lite sukker','Høyst 5 g sukkerarter per 100 g/ml',{range:['sugars',null,5]}],
  ['Mye fiber','Minst 6 g kostfiber per 100 g/ml',{range:['fiber',6,null]}],
  ['Lite salt','Høyst 0,3 g salt per 100 g/ml',{range:['salt',null,.3]}],
  ['Økologisk','Merket økologisk hos alle kjedene som fører varen',{label:1}],
  ['Fersk pris','Priskvittering fra de siste 48 timene',{status:'fresh'}]
];
const PRESETS=[['Protein mot sukker','sugars','protein'],['Fett mot energi','fat','kcal'],['Fiber mot sukker','sugars','fiber'],['Pris mot protein','price','protein']];
const STORAGE='familien-varer-v1';

export function installLibraryExplorer({panel,base='/api/shopping',compact=false,onBack=null}) {
  const saved=(()=>{try{return JSON.parse(sessionStorage.getItem(STORAGE))??{};}catch{return {};}})();
  let filters={...emptyFilters(),...(saved.filters??{}),ranges:saved.filters?.ranges??{}};
  let view=saved.view??'items',sort=saved.sort??'auto',familySort=saved.familySort??'count';
  let model=null,result=null,sorted=[],shown=0,scheduled=false,loading=false,built=false;
  const compare=new Map(),refs={},stack=[];
  const isKiosk=()=>document.body.classList.contains('kiosk');
  panel.classList.add('lx');

  async function api(path) {
    const response=await fetch(base+path,{credentials:'same-origin',signal:AbortSignal.timeout(45000)});
    const body=await response.json();
    if(!response.ok)throw Error(body.error??'Noe gikk galt. Prøv igjen.');
    return body;
  }
  const imageUrl=id=>base+'/image?id='+id;
  function remember() {try{sessionStorage.setItem(STORAGE,JSON.stringify({filters,view,sort,familySort}));}catch{}}
  function schedule() {
    if(scheduled)return;
    scheduled=true;
    requestAnimationFrame(()=>{scheduled=false;refresh();});
  }
  function photo(id,name,cls='lx-photo') {
    const box=el('span',undefined,cls);
    const fallback=()=>{box.replaceChildren(el('span',(name||'?').trim().charAt(0).toLocaleUpperCase('nb-NO'),'lx-monogram'));};
    if(id){const img=el('img');img.src=imageUrl(id);img.alt='';img.loading='lazy';img.decoding='async';img.onerror=fallback;box.append(img);}
    else fallback();
    return box;
  }

  // ---- first paint and data ----
  async function open() {
    if(loading)return;
    loading=true;
    if(!model)panel.replaceChildren(el('p','Henter varene …','lx-state'));
    try{
      const data=await api('/explore');
      if(data.status&&data.status!=='ready'){
        if(!model)panel.replaceChildren(stateCard(data.status==='building'?'Varebiblioteket bygges nå. Prøv igjen om et halvt minutt.':'Produktbiblioteket er ikke tilgjengelig her.'));
        return;
      }
      if(!model||model.built!==data.built){
        model=prepareExplorer(data);
        await loadIngredientHits();
        if(!built)build();
        schedule();
      }else schedule();
    }catch(error){if(!model)panel.replaceChildren(stateCard(error.message));}
    finally{loading=false;}
  }
  function stateCard(message) {
    const box=el('div',undefined,'lx-state');
    box.append(el('p',message),button('Prøv igjen',open,'lx-ghost'));
    return box;
  }
  async function loadIngredientHits() {
    await Promise.all([...filters.include,...filters.exclude].map(ingredientHit));
  }
  async function ingredientHit(term) {
    if(model.ingredientHits.has(term))return;
    const found=await api('/explore-ingredients?q='+encodeURIComponent(term));
    if(found.status==='ready'&&found.built===model.built)model.ingredientHits.set(term,new Set(found.items));
  }

  function build() {
    built=true;
    const root=document.createDocumentFragment();
    root.append(buildHero());
    const shell=el('div',undefined,'lx-shell');
    shell.append(buildRail(),buildMain());
    root.append(shell,buildTray(),el('p','Viser kjedepriser og gjennomgåtte varefamilier, ikke lokal lagerstatus eller butikkens tilbud. Varer med samme strekkode er slått sammen for visning, og hver kjedes egne tall vises på varen. Tomme tall betyr at opplysningen mangler, ikke null.','lx-foot'));
    panel.replaceChildren(root);
  }

  // ---- hero ----
  function buildHero() {
    const hero=el('header',undefined,'lx-hero');
    if(onBack)hero.append(button('← Tilbake til Handel',onBack,'lx-back'));
    const title=el('div',undefined,'lx-hero-title');
    title.append(el('span','Produktbiblioteket','lx-eyebrow'),el('h2','Utforsk varene'));
    const stats=el('div',undefined,'lx-stats'),now=Date.now();
    const freshCount=model.items.filter(i=>i.posts.some(p=>p.packPrice!==null&&isFresh(p.at,now,model.freshMs))).length;
    for(const [value,label] of [[model.items.length,'varer'],[model.families.filter(f=>f.items.length).length,'varefamilier'],[model.stores.length,'kjeder'],[freshCount,'med fersk pris']]){
      const stat=el('div',undefined,'lx-stat');stat.append(el('strong',whole(value)),el('span',label));stats.append(stat);
    }
    title.append(stats);
    const search=el('div',undefined,'lx-search');
    const input=el('input');input.type='search';input.placeholder='Søk etter vare, merke, varefamilie eller strekkode';input.setAttribute('aria-label','Søk i varebiblioteket');input.value=filters.q;
    let timer=null;input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{filters.q=input.value;changed();},110);};
    refs.search=input;
    const surprise=button('Overrask meg',()=>{const pool=model.families.filter(f=>f.items.length>=3&&new Set(f.items.flatMap(i=>i.posts.map(p=>p.store))).size>=3&&(!filters.food||model.shelves[f.shelf].food));if(pool.length){stack.length=0;showFamily(pool[Math.floor(Math.random()*pool.length)].index);}},'lx-surprise');
    search.append(input,surprise);
    const discover=el('div',undefined,'lx-discover');discover.setAttribute('role','group');discover.setAttribute('aria-label','Snarveier');
    refs.discover=[];
    for(const [label,hint,effect] of DISCOVER){const chip=button(label,()=>toggleDiscover(effect),'lx-chip');chip.title=hint;discover.append(chip);refs.discover.push([chip,effect]);}
    hero.append(title,search,discover);
    return hero;
  }
  function discoverOn(effect) {
    if(effect.range){const [key,min,max]=effect.range,r=filters.ranges[key];return !!r&&r.min===min&&r.max===max;}
    if(effect.label)return filters.labels.includes(effect.label);
    return filters.status.includes(effect.status);
  }
  function toggleDiscover(effect) {
    const on=discoverOn(effect);
    if(effect.range){const [key,min,max]=effect.range;if(on)delete filters.ranges[key];else filters.ranges[key]={min,max};}
    else if(effect.label)toggleIn(filters.labels,effect.label);
    else toggleIn(filters.status,effect.status);
    changed(true);
  }
  function toggleIn(list,value) {const at=list.indexOf(value);if(at>=0)list.splice(at,1);else list.push(value);}
  function changed(syncControls=false) {
    remember();
    if(syncControls)syncRail();
    schedule();
  }

  // ---- filter rail ----
  function section(title,...nodes) {
    const box=el('section',undefined,'lx-section');
    box.append(el('h3',title),...nodes);
    return box;
  }
  function buildRail() {
    const rail=el('aside',undefined,'lx-rail');rail.setAttribute('aria-label','Filtre');
    const head=el('div',undefined,'lx-rail-head');
    head.append(el('strong','Filtre'),button('Nullstill',()=>{filters=emptyFilters();refs.search.value='';changed(true);},'lx-link'));
    rail.append(head);refs.rail=rail;

    refs.shelves=model.shelves.map((shelf,index)=>({shelf,index})).sort((a,b)=>a.shelf.name.localeCompare(b.shelf.name,'nb')).map(({shelf,index})=>{
      const row=button('',()=>{toggleIn(filters.shelves,index);changed(true);},'lx-facet');
      const fill=el('span',undefined,'lx-facet-fill'),name=el('span',shelf.name,'lx-facet-name'),count=el('span','','lx-facet-count');
      row.append(fill,name,count);
      return {row,fill,count,index,food:shelf.food};
    });
    const shelfBox=el('div',undefined,'lx-facets');for(const r of refs.shelves)shelfBox.append(r.row);
    refs.food=toggle('Vis også hus, hygiene og dyr',()=>{filters.food=!filters.food;changed(true);});
    rail.append(section('Hyller',shelfBox,refs.food));

    const storeBox=el('div',undefined,'lx-pills');
    refs.stores=model.stores.map((store,index)=>({store,index})).sort((a,b)=>a.store.name.localeCompare(b.store.name,'nb')).map(({store,index})=>{
      const chip=button('',()=>{toggleIn(filters.stores,index);changed(true);},'lx-chip small');
      chip.append(el('span',store.name),el('small',''));storeBox.append(chip);
      return {chip,index,count:chip.lastChild};
    });
    const own=model.stores.flatMap((s,i)=>s.own?[i]:[]);
    const storeHead=el('div',undefined,'lx-row');
    if(own.length)storeHead.append(button('Bare våre butikker',()=>{const same=own.length===filters.stores.length&&own.every(i=>filters.stores.includes(i));filters.stores=same?[]:[...own];changed(true);},'lx-link'));
    rail.append(section('Butikker',storeBox,storeHead));

    refs.labels=LABELS.map(([,bit,label])=>{const t=toggle(label,()=>{toggleIn(filters.labels,bit);changed(true);});t.bit=bit;return t;});
    rail.append(section('Merking',...refs.labels));

    refs.ranges=NUTRIENTS.map(axis=>rangeControl(axis));
    const missing=el('p','','lx-note');refs.rangeNote=missing;
    rail.append(section('Næring per 100 g/ml',...refs.ranges.map(r=>r.root),missing));

    const priceRange=rangeControl(PRICE_AXIS);refs.ranges.push(priceRange);
    rail.append(section('Kilopris',priceRange.root));

    rail.append(section('Ingredienser',ingredientControl()));

    const select=el('select');select.setAttribute('aria-label','Sammenlign på råvareinnhold');
    select.append(new Option('Velg hva som måles …',''));
    for(const [index,q] of model.qualityKeys.map((q,i)=>[i,q]).sort((a,b)=>a[1].criterion.localeCompare(b[1].criterion,'nb')))select.append(new Option(`${q.criterion} (${q.items})`,String(index)));
    select.onchange=()=>{filters.qualityKey=select.value===''?null:Number(select.value);if(filters.qualityKey!==null)sort='quality';else if(sort==='quality')sort='auto';changed(true);};
    refs.quality=select;
    rail.append(section('Råvarescore',select,el('p',QUALITY_NOTE,'lx-note')));

    refs.status=STATUSES.map(([key,label])=>{const t=toggle(label,()=>{toggleIn(filters.status,key);changed(true);});t.key=key;return t;});
    refs.gone=toggle('Vis utgåtte varer',()=>{filters.hideGone=!filters.hideGone;changed(true);});
    rail.append(section('Vis bare',...refs.status,refs.gone));

    refs.applySheet=button('Vis varene',()=>rail.classList.remove('open'),'lx-apply');
    rail.append(refs.applySheet);
    return rail;
  }
  function toggle(label,action) {
    const node=button('',action,'lx-toggle');
    node.append(el('span',undefined,'lx-switch'),el('span',label),el('small',''));
    return node;
  }
  function rangeControl(axis) {
    const root=el('div',undefined,'lx-range'),top=el('div',undefined,'lx-range-top'),value=el('span','','lx-range-value');
    top.append(el('span',axis.label),value);
    const hist=el('div',undefined,'lx-hist');hist.setAttribute('aria-hidden','true');
    const bars=[];for(let i=0;i<24;i++){const b=el('i');hist.append(b);bars.push(b);}
    const domain=model.domains[axis.key],step=domain/96;
    const sliders=el('div',undefined,'lx-sliders');
    const make=name=>{const s=el('input');s.type='range';s.min='0';s.max=String(domain);s.step=String(step);s.setAttribute('aria-label',`${axis.label}, ${name}`);return s;};
    const lo=make('lavest'),hi=make('høyest');
    const apply=()=>{
      let a=Number(lo.value),b=Number(hi.value);
      if(a>b){if(document.activeElement===lo)a=b;else b=a;}
      const min=a<=0?null:Math.round(a*100)/100,max=b>=domain?null:Math.round(b*100)/100;
      if(min===null&&max===null)delete filters.ranges[axis.key];else filters.ranges[axis.key]={min,max};
      changed();
    };
    lo.oninput=apply;hi.oninput=apply;sliders.append(lo,hi);
    root.append(top,hist,sliders);
    return {root,axis,bars,value,lo,hi,domain};
  }
  function rangeLabel(range,axis) {
    const u=axis.key==='price'?' kr':' '+axis.unit;
    if(range.min!==null&&range.max!==null)return `${short(range.min)}–${short(range.max)}${u}`;
    if(range.min!==null)return `minst ${short(range.min)}${u}`;
    return `høyst ${short(range.max)}${u}`;
  }
  function ingredientControl() {
    const box=el('div',undefined,'lx-ingredients'),input=el('input');
    input.type='text';input.placeholder='f.eks. palmeolje';input.maxLength=60;input.setAttribute('aria-label','Ingrediens');
    const go=async list=>{
      const term=input.value.normalize('NFC').toLocaleLowerCase('nb-NO').trim();
      if(term.length<2)return;
      try{await ingredientHit(term);}catch(error){refs.ingredientNote.textContent=error.message;return;}
      if(!list.includes(term))list.push(term);
      input.value='';changed(true);
    };
    input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();go(filters.include);}};
    const buttons=el('div',undefined,'lx-row');
    buttons.append(button('Inneholder',()=>go(filters.include),'lx-ghost small'),button('Uten',()=>go(filters.exclude),'lx-ghost small'));
    refs.ingredientNote=el('p','Søker i ingredienslisten. Ikke en allergenvurdering: les alltid etiketten. «Uten» viser bare varer der listen er kjent.','lx-note');
    box.append(input,buttons,refs.ingredientNote);
    return box;
  }
  function syncRail() {
    for(const r of refs.ranges){
      const range=filters.ranges[r.axis.key];
      r.lo.value=String(range?.min??0);r.hi.value=String(range?.max??r.domain);
    }
    refs.quality.value=filters.qualityKey===null?'':String(filters.qualityKey);
  }
  function setOn(node,on) {node.classList.toggle('on',on);node.setAttribute('aria-pressed',String(on));}
  function updateRail() {
    const {facets,hist,missing}=result;
    const top=Math.max(1,...refs.shelves.map(r=>facets.shelves[r.index]));
    for(const r of refs.shelves){
      const n=facets.shelves[r.index];
      r.count.textContent=whole(n);r.fill.style.width=(n/top*100)+'%';setOn(r.row,filters.shelves.includes(r.index));
      r.row.hidden=(filters.food&&!r.food)||(!n&&!filters.shelves.includes(r.index));
    }
    setOn(refs.food,!filters.food);
    for(const s of refs.stores){s.count.textContent=whole(facets.stores[s.index]);setOn(s.chip,filters.stores.includes(s.index));}
    for(const t of refs.labels){t.lastChild.textContent=whole(facets.labels[t.bit]??0);setOn(t,filters.labels.includes(t.bit));}
    for(const t of refs.status){t.lastChild.textContent=whole(facets.status[t.key]??0);setOn(t,filters.status.includes(t.key));}
    setOn(refs.gone,!filters.hideGone);
    for(const r of refs.ranges){
      const counts=hist[r.axis.key],peak=Math.max(1,...counts),range=filters.ranges[r.axis.key];
      r.bars.forEach((bar,i)=>{
        bar.style.height=Math.max(counts[i]?8:2,counts[i]/peak*100)+'%';
        const lo=i/24*r.domain,hi=(i+1)/24*r.domain;
        bar.classList.toggle('off',!!range&&(range.min!==null&&hi<=range.min||range.max!==null&&lo>=range.max));
      });
      r.value.textContent=range?rangeLabel(range,r.axis):'alle';
    }
    const hidden=Object.keys(filters.ranges).map(key=>missing[key]).filter(n=>n>0);
    refs.rangeNote.textContent=hidden.length?`${whole(Math.max(...hidden))} varer uten oppgitt tall er skjult av grensene.`:'';
    refs.applySheet.textContent=`Vis ${whole(result.items.length)} varer`;
    for(const [chip,effect] of refs.discover)setOn(chip,discoverOn(effect));
  }

  // ---- main column ----
  function buildMain() {
    const main=el('div',undefined,'lx-main');
    const bar=el('div',undefined,'lx-toolbar'),views=el('div',undefined,'lx-views');views.setAttribute('role','tablist');
    refs.views=[['items','Varer'],['families','Varefamilier'],['map','Næringskart']].map(([key,label])=>{
      const b=button(label,()=>{view=key;remember();shown=0;schedule();},'');b.setAttribute('role','tab');b.dataset.view=key;views.append(b);return b;
    });
    refs.count=el('span','','lx-count');refs.count.setAttribute('role','status');
    refs.sort=el('select');refs.sort.setAttribute('aria-label','Sorter');
    refs.sort.onchange=()=>{if(view==='families')familySort=refs.sort.value;else sort=refs.sort.value;remember();shown=0;schedule();};
    const openFilters=button('Filtre',()=>refs.rail.classList.add('open'),'lx-open-filters');refs.openFilters=openFilters;
    bar.append(views,refs.count,refs.sort,openFilters);
    refs.pills=el('div',undefined,'lx-active');
    refs.content=el('div',undefined,'lx-content');
    refs.sentinel=el('div',undefined,'lx-sentinel');
    main.append(bar,refs.pills,refs.content,refs.sentinel);
    new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&view!=='map')appendMore();},{rootMargin:'900px'}).observe(refs.sentinel);
    return main;
  }
  function updateSortControl() {
    const options=view==='families'?[['count','Flest varer'],['chains','Flest kjeder'],['spread','Størst prisforskjell'],['name','A–Å']]:SORTS.filter(([key])=>key!=='quality'||filters.qualityKey!==null).map(([key,label])=>[key,key==='auto'&&!result.hasQuery?'Flest kjeder først':label]);
    const current=view==='families'?familySort:sort;
    const signature=options.map(o=>o.join()).join('|');
    if(refs.sort.dataset.signature!==signature){refs.sort.replaceChildren(...options.map(([key,label])=>new Option(label,key)));refs.sort.dataset.signature=signature;}
    refs.sort.value=current;refs.sort.hidden=view==='map';
  }
  function updatePills() {
    const pills=[];
    const add=(label,remove)=>pills.push(button(label+' ×',()=>{remove();changed(true);},'lx-pill'));
    if(filters.q.trim())add('«'+filters.q.trim()+'»',()=>{filters.q='';refs.search.value='';});
    for(const s of filters.shelves)add(model.shelves[s].name,()=>toggleIn(filters.shelves,s));
    for(const s of filters.stores)add(model.stores[s].name,()=>toggleIn(filters.stores,s));
    for(const [,bit,label] of LABELS)if(filters.labels.includes(bit))add(label,()=>toggleIn(filters.labels,bit));
    for(const [key,label] of STATUSES)if(filters.status.includes(key))add(label,()=>toggleIn(filters.status,key));
    for(const [key,range] of Object.entries(filters.ranges)){const axis=axisOf(key);add(`${axis.label}: ${rangeLabel(range,axis)}`,()=>delete filters.ranges[key]);}
    for(const term of filters.include)add('Med '+term,()=>toggleIn(filters.include,term));
    for(const term of filters.exclude)add('Uten '+term,()=>toggleIn(filters.exclude,term));
    if(filters.qualityKey!==null)add(model.qualityKeys[filters.qualityKey].criterion,()=>{filters.qualityKey=null;if(sort==='quality')sort='auto';});
    refs.pills.replaceChildren(...pills);refs.pills.hidden=!pills.length;
    refs.openFilters.textContent=pills.length?`Filtre (${pills.length})`:'Filtre';
  }
  function refresh() {
    if(!model||!built)return;
    result=explore(model,filters);
    updateRail();updatePills();updateSortControl();
    for(const b of refs.views){const on=b.dataset.view===view;b.classList.toggle('on',on);b.setAttribute('aria-selected',String(on));}
    refs.content.dataset.view=view;
    if(view==='map'){refs.count.textContent=whole(result.items.length)+' varer i utvalget';renderMap();return;}
    if(view==='families'){
      sorted=sortFamilies(familySummaries(model,result),familySort);
      refs.count.textContent=whole(sorted.length)+' varefamilier';
    }else{
      sorted=sortItems(result,sort,filters.qualityKey);
      refs.count.textContent=whole(sorted.length)+(sorted.length===1?' vare':' varer');
    }
    scatter=null;
    refs.content.replaceChildren();shown=0;
    if(!sorted.length){refs.content.append(emptyState());return;}
    if(view==='items'&&isPristine(filters))refs.content.append(atlas());
    refs.grid=el('div',undefined,view==='families'?'lx-family-grid':'lx-grid');
    refs.content.append(refs.grid);
    appendMore();
  }
  function appendMore() {
    if(!sorted?.length||shown>=sorted.length||!refs.grid)return;
    const next=sorted.slice(shown,shown+48),fragment=document.createDocumentFragment();
    next.forEach((row,i)=>{const node=view==='families'?familyCard(row):itemCard(row);node.style.setProperty('--i',String(Math.min(i,14)));fragment.append(node);});
    refs.grid.append(fragment);shown+=next.length;
  }
  function emptyState() {
    const box=el('div',undefined,'lx-state');
    box.append(el('p','Ingen varer passer alle filtrene.'),button('Nullstill filtrene',()=>{filters=emptyFilters();refs.search.value='';changed(true);},'lx-ghost'));
    return box;
  }
  function atlas() {
    const box=el('section',undefined,'lx-atlas');box.setAttribute('aria-label','Hyller');
    const rows=model.shelves.map((shelf,index)=>({shelf,index,count:result.facets.shelves[index]})).filter(r=>r.shelf.food&&r.count).sort((a,b)=>b.count-a.count);
    for(const {shelf,index,count} of rows){
      const picks=result.items.filter(i=>i.image&&i.shelves.includes(index)).sort((a,b)=>b.posts.length-a.posts.length||a.name.localeCompare(b.name,'nb')).slice(0,3);
      const tile=button('',()=>{filters.shelves=[index];changed(true);},'lx-tile');
      const stack=el('span',undefined,'lx-tile-photos');for(const item of picks)stack.append(photo(item.image,item.name,'lx-tile-photo'));
      const text=el('span',undefined,'lx-tile-text');text.append(el('strong',shelf.name),el('small',whole(count)+' varer'));
      tile.append(stack,text);box.append(tile);
    }
    return box;
  }

  // ---- cards ----
  function macroBar(item) {
    const n=item.nutrition;
    if(!n||typeof n.protein!=='number'||typeof n.carbs!=='number'||typeof n.fat!=='number')return el('span','Næring ikke oppgitt','lx-macro-none');
    const bar=el('span',undefined,'lx-macro');
    bar.title=`Per 100 ${item.basis}: protein ${short(n.protein)} g, karbohydrater ${short(n.carbs)} g, fett ${short(n.fat)} g`;
    for(const [key,value] of [['protein',n.protein],['carbs',n.carbs],['fat',n.fat]]){if(value<=0)continue;const part=el('i',undefined,'m-'+key);part.style.width=Math.min(100,value)+'%';bar.append(part);}
    return bar;
  }
  function priceBlock(view) {
    const box=el('div',undefined,'lx-price');
    if(view.packPrice===null&&view.unitPrice===null){box.append(el('span','Ingen brukbar pris','lx-muted'));return box;}
    if(view.packPrice!==null)box.append(el('strong',money(view.packPrice)));
    else box.append(el('strong',money(view.unitPrice)+'/'+view.unit));
    if(view.packPrice!==null&&view.unitPrice!==null)box.append(el('span',money(view.unitPrice)+'/'+view.unit,'lx-muted'));
    if(!view.fresh)box.append(el('span','eldre pris','lx-old'));
    return box;
  }
  function badges(item) {
    const row=el('div',undefined,'lx-badges');
    for(const [,bit,label] of LABELS)if(item.labels&bit)row.append(el('span',label,'lx-badge'));
    if(filters.qualityKey!==null){const q=item.quality.find(x=>x.key===filters.qualityKey);if(q)row.append(el('span',`${model.qualityKeys[q.key].label} ${whole(q.score)}`,'lx-badge strong'));}
    else if(item.level!==null&&item.level!==undefined)row.append(el('span',LEVEL[item.level],'lx-badge quiet'));
    return row;
  }
  function itemCard(item) {
    const card=el('article',undefined,'lx-card'),v=result.views[item.index];
    if(item.gone)card.classList.add('gone');
    const main=button('',()=>{stack.length=0;showItem(item);},'lx-card-open');
    const picture=photo(item.image,item.name);
    const chains=el('span',v.chains>1?v.chains+' kjeder':model.stores[item.posts[0].store].name,'lx-chains');
    picture.append(chains);
    const pack=item.packMixed?'ulike pakninger':packText(item.pack,item.packUnit);
    const body=el('span',undefined,'lx-card-body');
    body.append(el('span',item.name,'lx-card-name'),el('span',[item.brand,pack].filter(Boolean).join(' · ')||' ','lx-card-sub'));
    main.append(picture,body);
    const footer=el('div',undefined,'lx-card-foot');
    footer.append(priceBlock(v),macroBar(item),badges(item));
    const pick=button(compare.has(item.id)?'✓':'+',()=>{toggleCompare(item);pick.textContent=compare.has(item.id)?'✓':'+';pick.classList.toggle('on',compare.has(item.id));},'lx-pick'+(compare.has(item.id)?' on':''));
    pick.title='Legg til i sammenligning';pick.setAttribute('aria-label','Sammenlign '+item.name);
    card.append(main,footer,pick);
    return card;
  }
  function familyCard(row) {
    const card=button('',()=>{stack.length=0;showFamily(row.family.index);},'lx-family');
    const mosaic=el('span',undefined,'lx-mosaic n'+Math.min(4,row.images.length));
    for(const id of row.images)mosaic.append(photo(id,row.family.name,'lx-mosaic-photo'));
    if(!row.images.length)mosaic.append(photo(null,row.family.name,'lx-mosaic-photo'));
    const body=el('span',undefined,'lx-family-body');
    body.append(el('span',model.shelves[row.family.shelf].name,'lx-eyebrow small'),el('span',row.family.name,'lx-family-name'),el('span',`${whole(row.count)} ${row.count===1?'vare':'varer'} · ${row.chains} ${row.chains===1?'kjede':'kjeder'}`,'lx-card-sub'));
    body.append(priceTrack(row));
    card.append(mosaic,body);
    return card;
  }
  function priceTrack(row) {
    const box=el('span',undefined,'lx-track');
    if(row.min===null){box.append(el('span','Ingen ferske priser','lx-muted'));return box;}
    const unit=' kr/'+row.family.unit,line=el('span',undefined,'lx-track-line');
    if(row.max>row.min)for(const p of row.prices){const dot=el('i');dot.style.left=((p-row.min)/(row.max-row.min)*100)+'%';line.append(dot);}
    const labels=el('span',undefined,'lx-track-labels');
    labels.append(el('b',short(row.min)+unit),row.max>row.min?el('span',short(row.max)+unit):el('span',''));
    box.append(line,labels);
    return box;
  }

  // ---- nutrition map ----
  let scatter=null;
  function renderMap() {
    if(!scatter){
      scatter=createScatter();
      refs.content.replaceChildren(scatter.root);refs.grid=null;
    }
    scatter.update();
  }
  function createScatter() {
    const state=scatter?.state??{x:saved.x??'sugars',y:saved.y??'protein',highlight:''};
    const root=el('section',undefined,'lx-map');
    const controls=el('div',undefined,'lx-map-controls');
    const axisSelect=(label,key)=>{
      const select=el('select');select.setAttribute('aria-label',label);
      for(const axis of AXES)select.append(new Option(axis.label,axis.key));
      select.value=state[key];select.onchange=()=>{state[key]=select.value;persist();update();};
      const wrap=el('label',undefined,'lx-axis');wrap.append(el('span',label),select);
      return [wrap,select];
    };
    const [xWrap,xSelect]=axisSelect('Bortover','x'),[yWrap,ySelect]=axisSelect('Oppover','y');
    const persist=()=>{saved.x=state.x;saved.y=state.y;};
    const highlight=el('select');highlight.setAttribute('aria-label','Fremhev hylle');highlight.append(new Option('Ingen',''));
    model.shelves.map((s,i)=>[s,i]).filter(([s])=>!filters.food||s.food).sort((a,b)=>a[0].name.localeCompare(b[0].name,'nb')).forEach(([s,i])=>highlight.append(new Option(s.name,String(i))));
    highlight.onchange=()=>{state.highlight=highlight.value;update();};
    const hiWrap=el('label',undefined,'lx-axis');hiWrap.append(el('span','Fremhev'),highlight);
    const presets=el('div',undefined,'lx-presets');
    for(const [label,x,y] of PRESETS)presets.append(button(label,()=>{state.x=x;state.y=y;xSelect.value=x;ySelect.value=y;persist();update();},'lx-chip small'));
    controls.append(xWrap,yWrap,hiWrap,presets);
    const stage=el('div',undefined,'lx-stage'),canvas=el('canvas'),tip=el('div',undefined,'lx-tip');tip.hidden=true;
    canvas.setAttribute('role','img');
    stage.append(canvas,tip);
    const legend=el('div',undefined,'lx-map-legend'),note=el('p','','lx-note');
    root.append(controls,stage,legend,note);

    const base=document.createElement('canvas');
    let points=[],domainX=[0,1],domainY=[0,1],size={w:0,h:0},plot=null,hover=null,drag=null;
    const M={l:54,r:18,t:16,b:44};
    const colors=()=>{const s=getComputedStyle(root);return {dot:s.getPropertyValue('--lx-dot').trim(),hi:s.getPropertyValue('--lx-hi').trim(),faint:s.getPropertyValue('--lx-faint').trim(),grid:s.getPropertyValue('--lx-line').trim(),muted:s.getPropertyValue('--lx-muted').trim(),surface:s.getPropertyValue('--lx-card').trim()};};
    const px=v=>plot.x+(v-domainX[0])/(domainX[1]-domainX[0])*plot.w,py=v=>plot.y+plot.h-(v-domainY[0])/(domainY[1]-domainY[0])*plot.h;
    const inv=(x,y)=>[domainX[0]+(x-plot.x)/plot.w*(domainX[1]-domainX[0]),domainY[0]+(plot.y+plot.h-y)/plot.h*(domainY[1]-domainY[0])];
    function update() {
      const found=scatterPoints(result,state.x,state.y),X=axisOf(state.x),Y=axisOf(state.y);
      domainX=axisDomain(found.points.map(p=>p.x),filters.ranges[state.x],model.domains[state.x]);
      domainY=axisDomain(found.points.map(p=>p.y),filters.ranges[state.y],model.domains[state.y]);
      points=found.points.filter(p=>p.x>=domainX[0]&&p.x<=domainX[1]&&p.y>=domainY[0]&&p.y<=domainY[1]);
      const outside=found.points.length-points.length;
      canvas.setAttribute('aria-label',`Punktdiagram med ${points.length} varer: ${X.label} bortover og ${Y.label} oppover. Det samme utvalget finnes som liste under Varer.`);
      note.textContent=[`${whole(points.length)} varer i kartet.`,found.missing?`${whole(found.missing)} mangler tall for minst én akse og er ikke med.`:null,outside?`${whole(outside)} er utenfor skalaen.`:null,'Dra over et område for å zoome og filtrere. Det samme utvalget ligger som liste under Varer.'].filter(Boolean).join(' ');
      legend.replaceChildren();
      if(state.highlight!==''){
        const a=el('span',model.shelves[state.highlight].name),b=el('span','Andre varer');
        a.className='hi';b.className='rest';legend.append(a,b);
      }
      hover=null;tip.hidden=true;
      layout();
    }
    function layout() {
      const w=stage.clientWidth;if(!w)return;
      const h=Math.max(320,Math.min(620,Math.round(w*.56))),ratio=devicePixelRatio||1;
      size={w,h};plot={x:M.l,y:M.t,w:w-M.l-M.r,h:h-M.t-M.b};
      canvas.width=base.width=Math.round(w*ratio);canvas.height=base.height=Math.round(h*ratio);
      canvas.style.width=w+'px';canvas.style.height=h+'px';
      paintBase(ratio);paint();
    }
    function paintBase(ratio) {
      const g=base.getContext('2d'),c=colors(),X=axisOf(state.x),Y=axisOf(state.y);
      g.setTransform(ratio,0,0,ratio,0,0);g.clearRect(0,0,size.w,size.h);
      g.font='12px "Segoe UI",system-ui,sans-serif';g.lineWidth=1;
      g.strokeStyle=c.grid;g.fillStyle=c.muted;g.textBaseline='middle';
      g.textAlign='right';
      for(const t of ticks(domainY[0],domainY[1])){const y=Math.round(py(t))+.5;g.beginPath();g.moveTo(plot.x,y);g.lineTo(plot.x+plot.w,y);g.stroke();g.fillText(nf(t<10?1:0).format(t),plot.x-8,y);}
      g.textAlign='center';g.textBaseline='top';
      for(const t of ticks(domainX[0],domainX[1],Math.max(3,Math.round(plot.w/110)))){const x=Math.round(px(t))+.5;g.beginPath();g.moveTo(x,plot.y);g.lineTo(x,plot.y+plot.h);g.stroke();g.fillText(nf(t<10?1:0).format(t),x,plot.y+plot.h+7);}
      g.fillText(axisTitle(X),plot.x+plot.w/2,plot.y+plot.h+25);
      g.save();g.translate(13,plot.y+plot.h/2);g.rotate(-Math.PI/2);g.textBaseline='middle';g.fillText(axisTitle(Y),0,0);g.restore();
      const hi=state.highlight===''?null:Number(state.highlight),r=points.length>2500?2.6:3.4;
      const dots=(list,color,alpha)=>{g.fillStyle=color;g.globalAlpha=alpha;g.beginPath();for(const p of list){const x=px(p.x),y=py(p.y);g.moveTo(x+r,y);g.arc(x,y,r,0,Math.PI*2);}g.fill();g.globalAlpha=1;};
      if(hi===null)dots(points,c.dot,.5);
      else{dots(points.filter(p=>!p.item.shelves.includes(hi)),c.faint,.55);dots(points.filter(p=>p.item.shelves.includes(hi)),c.hi,.7);}
      for(const p of points){p.px=px(p.x);p.py=py(p.y);}
    }
    function paint() {
      const g=canvas.getContext('2d'),ratio=devicePixelRatio||1,c=colors();
      g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,canvas.width,canvas.height);g.drawImage(base,0,0);g.setTransform(ratio,0,0,ratio,0,0);
      if(hover){
        const family=hover.item.families[0];
        if(family!==undefined){
          g.strokeStyle=c.hi;g.lineWidth=1.5;g.beginPath();
          for(const p of points)if(p!==hover&&p.item.families.includes(family)){g.moveTo(p.px+4.5,p.py);g.arc(p.px,p.py,4.5,0,Math.PI*2);}
          g.stroke();
        }
        g.fillStyle=c.hi;g.strokeStyle=c.surface;g.lineWidth=2;g.beginPath();g.arc(hover.px,hover.py,7,0,Math.PI*2);g.fill();g.stroke();
      }
      if(drag?.moved){
        const x=Math.min(drag.x0,drag.x1),y=Math.min(drag.y0,drag.y1);
        g.fillStyle=c.hi;g.globalAlpha=.12;g.fillRect(x,y,Math.abs(drag.x1-drag.x0),Math.abs(drag.y1-drag.y0));g.globalAlpha=1;
        g.strokeStyle=c.hi;g.lineWidth=1;g.strokeRect(x+.5,y+.5,Math.abs(drag.x1-drag.x0),Math.abs(drag.y1-drag.y0));
      }
    }
    function nearest(x,y,limit=26) {
      let best=null,bestD=limit*limit;
      for(const p of points){const d=(p.px-x)**2+(p.py-y)**2;if(d<bestD){bestD=d;best=p;}}
      return best;
    }
    const local=event=>{const r=canvas.getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top];};
    const clampX=x=>Math.max(plot.x,Math.min(plot.x+plot.w,x)),clampY=y=>Math.max(plot.y,Math.min(plot.y+plot.h,y));
    function showTip(p) {
      if(!p){tip.hidden=true;return;}
      const X=axisOf(state.x),Y=axisOf(state.y),v=result.views[p.item.index],text=el('div');
      const line=(axis,value)=>el('span',`${short(value)} ${axis.unit}`+' '+axis.label.toLocaleLowerCase('nb-NO'));
      text.append(el('strong',p.item.name),line(X,p.x),line(Y,p.y));
      if(v.packPrice!==null)text.append(el('span',money(v.packPrice)+(v.fresh?'':' (eldre pris)')));
      tip.replaceChildren(photo(p.item.image,p.item.name,'lx-tip-photo'),text);
      tip.hidden=false;
      const left=p.px+16+tip.offsetWidth>size.w?p.px-16-tip.offsetWidth:p.px+16;
      tip.style.left=Math.max(4,left)+'px';tip.style.top=Math.max(4,Math.min(size.h-tip.offsetHeight-4,p.py-tip.offsetHeight/2))+'px';
    }
    const brushable=event=>event.pointerType==='mouse'||isKiosk();
    canvas.onpointerdown=event=>{
      const [x,y]=local(event);
      if(brushable(event)){drag={x0:clampX(x),y0:clampY(y),x1:clampX(x),y1:clampY(y),moved:false};canvas.setPointerCapture(event.pointerId);}
      else{hover=nearest(x,y,32);showTip(hover);paint();}
    };
    canvas.onpointermove=event=>{
      const [x,y]=local(event);
      if(drag){drag.x1=clampX(x);drag.y1=clampY(y);drag.moved=Math.abs(drag.x1-drag.x0)>8&&Math.abs(drag.y1-drag.y0)>8;tip.hidden=true;paint();return;}
      if(event.pointerType!=='mouse')return;
      const next=nearest(x,y);if(next!==hover){hover=next;showTip(hover);paint();canvas.classList.toggle('over',!!hover);}
    };
    canvas.onpointerup=event=>{
      if(!drag){if(hover&&event.pointerType!=='mouse'){stack.length=0;showItem(hover.item);}return;}
      const box=drag;drag=null;
      if(box.moved){
        const [ax,ay]=inv(Math.min(box.x0,box.x1),Math.max(box.y0,box.y1)),[bx,by]=inv(Math.max(box.x0,box.x1),Math.min(box.y0,box.y1));
        const r=value=>Math.round(value*100)/100;
        filters.ranges[state.x]={min:r(ax),max:r(bx)};filters.ranges[state.y]={min:r(ay),max:r(by)};
        changed(true);return;
      }
      const [x,y]=local(event),hit=nearest(x,y);
      paint();if(hit){stack.length=0;showItem(hit.item);}
    };
    canvas.onpointerleave=()=>{if(!drag){hover=null;tip.hidden=true;paint();}};
    new ResizeObserver(()=>{if(canvas.isConnected&&stage.clientWidth!==size.w)layout();}).observe(stage);
    return {root,state,update};
  }

  // ---- drawer ----
  let drawer=null,holder=null;
  function ensureDrawer() {
    if(drawer)return;
    drawer=el('dialog',undefined,'lx-drawer lx');
    drawer.setAttribute('aria-label','Vareinformasjon');
    drawer.oncancel=event=>{event.preventDefault();closeDrawer();};
    drawer.onclick=event=>{if(event.target===drawer)closeDrawer();};
    holder=el('div',undefined,'lx-drawer-body');
    drawer.append(holder);document.body.append(drawer);
  }
  function closeDrawer() {drawer.close();stack.length=0;}
  function openDrawer(entry) {
    ensureDrawer();
    stack.push(entry);
    if(!drawer.open)drawer.showModal();
    paintEntry();
  }
  function paintEntry() {
    const entry=stack[stack.length-1];
    holder.replaceChildren();holder.scrollTop=0;
    const bar=el('div',undefined,'lx-drawer-bar');
    bar.append(stack.length>1?button('← Tilbake',()=>{stack.pop();paintEntry();},'lx-ghost small'):el('span'),button('Lukk',closeDrawer,'lx-ghost small'));
    holder.append(bar);
    if(entry.type==='item')paintItem(entry);else paintFamily(entry);
  }
  const showItem=(item,postKey=null)=>openDrawer({type:'item',item,postKey});
  const showFamily=index=>openDrawer({type:'family',index});
  function block(title,...nodes) {
    const box=el('section',undefined,'lx-block');
    box.append(el('h3',title),...nodes);
    holder.append(box);
    return box;
  }
  function chainRows(item,entry) {
    const now=Date.now(),rows=[...item.posts].sort((a,b)=>{
      const fa=isFresh(a.at,now,model.freshMs)&&a.packPrice!==null,fb=isFresh(b.at,now,model.freshMs)&&b.packPrice!==null;
      return Number(fb)-Number(fa)||(a.unitPrice??a.packPrice??Infinity)-(b.unitPrice??b.packPrice??Infinity);
    });
    const list=el('div',undefined,'lx-chain-list');
    for(const post of rows){
      const fresh=isFresh(post.at,now,model.freshMs),row=button('',()=>{if(entry.postKey===post.key)return;entry.postKey=post.key;paintEntry();},'lx-chain'+(post.key===entry.postKey?' on':''));
      const name=el('span',model.stores[post.store].name,'lx-chain-name');
      const amount=el('span',packText(post.pack,post.unit)??'pakning ukjent','lx-muted');
      const price=el('span',post.gone?'Utgått':post.held||(post.packPrice===null&&post.unitPrice===null)?'Pris holdt tilbake':post.packPrice!==null?money(post.packPrice):money(post.unitPrice)+'/'+post.priceUnit,'lx-chain-price');
      const unit=el('span',post.unitPrice!==null&&post.packPrice!==null?money(post.unitPrice)+'/'+post.priceUnit:'','lx-muted');
      const when=el('span',ago(post.at,now),fresh?'lx-fresh':'lx-old');
      row.append(name,amount,price,unit,when);list.append(row);
    }
    return list;
  }
  function nutritionBars(item,facts) {
    const list=el('div',undefined,'lx-bars');
    for(const axis of NUTRIENTS){
      const value=facts?.[axis.key];
      const row=el('div',undefined,'lx-bar'),track=el('span',undefined,'lx-bar-track');
      if(typeof value==='number'){const fill=el('i');fill.style.width=Math.min(100,value/(axis.key==='kcal'?900:100)*100)+'%';track.append(fill);}
      row.append(el('span',axis.label),track,el('span',typeof value==='number'?`${short(value)} ${axis.unit}`:'ikke oppgitt',typeof value==='number'?'':'lx-muted'));
      list.append(row);
    }
    return list;
  }
  async function paintItem(entry) {
    const {item}=entry;
    entry.postKey??=item.posts.find(p=>p.packPrice!==null)?.key??item.posts[0].key;
    const top=el('header',undefined,'lx-detail-top'),text=el('div');
    const v=result.views[item.index];
    text.append(el('h2',item.name),el('p',[item.brand,item.packMixed?'ulike pakninger':packText(item.pack,item.packUnit),item.ean?'Strekkode '+item.ean:null].filter(Boolean).join(' · '),'lx-muted'),priceBlock(v),badges(item));
    const pick=button(compare.has(item.id)?'Fjern fra sammenligning':'Legg til i sammenligning',()=>{toggleCompare(item);pick.textContent=compare.has(item.id)?'Fjern fra sammenligning':'Legg til i sammenligning';},'lx-ghost small');
    text.append(pick);
    top.append(photo(item.image,item.name,'lx-detail-photo'),text);
    holder.append(top);
    block(item.posts.length>1?'Hos kjedene ('+item.posts.length+')':'Pris',chainRows(item,entry),item.posts.length>1?el('p','Trykk på en kjede for å se akkurat den varens etikett. Samme strekkode betyr ikke at oppskriften er kontrollert lik.','lx-note'):el('span'));
    const nutritionBox=block('Næring per 100 '+(item.basis??'g'),nutritionBars(item,item.nutrition));
    if(item.varies)nutritionBox.append(el('p','Tallene varierer mellom kjedene. Velg en kjede over for å se dens etikett.','lx-note'));
    if(item.families.length){
      const links=el('div',undefined,'lx-family-links');
      for(const family of item.families.slice(0,4))links.append(button(model.families[family].name+' →',()=>showFamily(family),'lx-chip small'));
      block('Varefamilier',links);
    }
    const detail=el('div','Henter etikett …','lx-muted');holder.append(detail);
    try{
      const info=await api('/product-info?key='+encodeURIComponent(entry.postKey));
      if(stack[stack.length-1]!==entry||!detail.isConnected)return;
      detail.replaceChildren();detail.className='';
      paintLabel(detail,info,entry,nutritionBox,item);
    }catch(error){if(detail.isConnected)detail.textContent=error.message;}
  }
  function paintLabel(detail,info,entry,nutritionBox,item) {
    const p=info.product;if(!p)return;
    const add=(title,...nodes)=>{const box=el('section',undefined,'lx-block');box.append(el('h3',title),...nodes);detail.append(box);};
    if(p.name!==item.name)nutritionBox.before(el('p','Navn hos denne kjeden: '+p.name,'lx-note'));
    if(p.nutrition?.per100){
      const facts={...p.nutrition.per100};if(p.nutrition.fiberConflict)facts.fiber=null;
      nutritionBox.querySelector('h3').textContent='Næring per 100 '+p.nutrition.basis;
      nutritionBox.querySelector('.lx-bars').replaceWith(nutritionBars(item,facts));
      if(p.nutrition.fiberConflict)nutritionBox.append(el('p','Kostfiber er utelatt fordi kjedene oppgir motstridende tall.','lx-note'));
    }
    const scored=info.groups.find(g=>g.status==='approved'&&g.quality);
    if(scored){
      const q=scored.quality,box=el('div',undefined,'lx-score'),head=el('div',undefined,'lx-score-head');
      head.append(el('strong',whole(q.score)),el('span','av 100 · '+q.label));
      box.append(head,el('p',q.criterion+(q.value!=null?': '+short(q.value)+' '+(q.unit??''):'')));
      if(q.rank&&q.of>1)box.append(el('p',`Nummer ${q.rank} av ${q.of} varer målt på samme måte.`,'lx-muted'));
      if(q.evidence)box.append(el('p','Fra etiketten: «'+q.evidence+'»','lx-muted'));
      box.append(el('p',(q.limitations??[]).join(' '),'lx-note'));
      add('Råvareinnhold',box);
    }
    if(p.ingredients)add('Ingredienser',el('p',p.ingredients));
    if(p.description)add('Beskrivelse',el('p',p.description,'lx-muted'));
    if(p.packEvidence||p.sourceUrl){
      const box=el('div');
      if(p.packEvidence)box.append(el('p',p.packEvidence,'lx-note'));
      if(p.sourceUrl&&!isKiosk()){const a=el('a','Se varen hos kilden ↗','lx-link');a.href=p.sourceUrl;a.target='_blank';a.rel='noopener noreferrer';box.append(a);}
      add('Kilde',box);
    }
  }
  async function paintFamily(entry) {
    const family=model.families[entry.index],now=Date.now();
    const top=el('header',undefined,'lx-family-top');
    top.append(el('span',model.shelves[family.shelf].name,'lx-eyebrow small'),el('h2',family.name));
    holder.append(top);
    const body=el('div','Henter varefamilien …','lx-muted');holder.append(body);
    let found;
    try{found=(await api('/explore-family?id='+encodeURIComponent(family.id))).family;}
    catch(error){body.textContent=error.message;return;}
    if(stack[stack.length-1]!==entry||!body.isConnected)return;
    body.replaceChildren();body.className='';
    if(!found)return;
    entry.tab??='approved';entry.byQuality??=false;
    const groups={approved:found.members.filter(m=>m.status==='approved'&&m.reviewCurrent),unknown:found.members.filter(m=>m.status==='unknown'||m.status==='approved'&&!m.reviewCurrent),excluded:found.members.filter(m=>m.status==='excluded')};
    const summary=el('section',undefined,'lx-block');
    summary.append(el('p',Array.isArray(found.inclusion)?found.inclusion.join(' '):found.inclusion));
    if(found.exclusions?.length)summary.append(el('p','Holdes utenfor: '+found.exclusions.join(' '),'lx-muted'));
    body.append(summary);
    const tabs=el('div',undefined,'lx-tabs');
    for(const [key,label] of [['approved','Godkjent'],['unknown','Uavklart'],['excluded','Holdt utenfor']]){
      if(!groups[key].length)continue;
      tabs.append(button(`${label} (${groups[key].length})`,()=>{entry.tab=key;draw();},''));
    }
    const sortRow=el('div',undefined,'lx-row');
    if(found.sharedKey)sortRow.append(button('Pris',()=>{entry.byQuality=false;draw();},'lx-chip small'),button('Råvarescore',()=>{entry.byQuality=true;draw();},'lx-chip small'));
    const list=el('div',undefined,'lx-member-list');
    body.append(tabs,sortRow,list);
    const notes=el('section',undefined,'lx-block');
    if(found.comparisonBasis)notes.append(el('h3','Slik sammenlignes de'),el('p',found.comparisonBasis,'lx-muted'));
    if(found.qualityBasis)notes.append(el('p',found.qualityBasis,'lx-muted'));
    if(found.qualityNote?.length)notes.append(el('p',found.qualityNote.join(' '),'lx-note'));
    body.append(notes);
    function draw() {
      [...tabs.children].forEach((b,i)=>{const key=['approved','unknown','excluded'].filter(k=>groups[k].length)[i];b.classList.toggle('on',key===entry.tab);});
      [...sortRow.children].forEach((b,i)=>b.classList.toggle('on',i===(entry.byQuality?1:0)));
      sortRow.hidden=entry.tab!=='approved'||!found.sharedKey;
      const scored=m=>m.quality?.key===found.sharedKey?m.quality.score:null;
      const rows=[...groups[entry.tab]].sort((a,b)=>{
        if(entry.byQuality){const x=scored(a),y=scored(b);if(x!==y)return x===null?1:y===null?-1:y-x;}
        return Number(b.fresh&&b.unitPrice!==null)-Number(a.fresh&&a.unitPrice!==null)||(a.unitPrice??Infinity)-(b.unitPrice??Infinity)||a.name.localeCompare(b.name,'nb');
      });
      const live=rows.filter(m=>m.fresh&&m.unitPrice!==null).map(m=>m.unitPrice),lo=Math.min(...live),hi=Math.max(...live);
      list.replaceChildren(...rows.map((m,i)=>memberRow(m,i,lo,hi,found,now)));
    }
    draw();
  }
  function memberRow(m,index,lo,hi,found,now) {
    const item=model.byPost.get(m.key);
    const row=button('',()=>{if(item)showItem(item,m.key);},'lx-member');
    row.disabled=!item;
    const text=el('span',undefined,'lx-member-text');
    text.append(el('span',m.name,'lx-card-name'),el('span',[m.store,m.brand,packText(m.pack,m.unit)].filter(Boolean).join(' · '),'lx-card-sub'));
    if(m.note)text.append(el('span',m.note.length>190?m.note.slice(0,190)+' …':m.note,'lx-note'));
    const side=el('span',undefined,'lx-member-side');
    if(m.quality&&m.quality.key===found.sharedKey)side.append(el('span',`${m.quality.label} ${whole(m.quality.score)}`,'lx-badge strong'));
    if(m.value?.top)side.append(el('span','Kvalitet for pengene','lx-badge strong'));
    if(m.unitPrice!==null&&m.fresh){
      side.append(el('strong',money(m.unitPrice)+'/'+found.unit));
      if(hi>lo){const line=el('span',undefined,'lx-member-line'),dot=el('i');dot.style.left=((m.unitPrice-lo)/(hi-lo)*100)+'%';line.append(dot);side.append(line);}
    }else if(m.packPrice!==null)side.append(el('span',money(m.packPrice),''),el('span',m.fresh?'pakning':ago(m.receiptAt?Date.parse(m.receiptAt):null,now),'lx-old'));
    else side.append(el('span','Ingen pris','lx-muted'));
    row.append(photo(m.image,m.name,'lx-member-photo'),text,side);
    return row;
  }

  // ---- compare ----
  function buildTray() {
    const tray=el('div',undefined,'lx-tray');tray.hidden=true;refs.tray=tray;
    return tray;
  }
  function toggleCompare(item) {
    if(compare.has(item.id))compare.delete(item.id);
    else{if(compare.size>=4)compare.delete(compare.keys().next().value);compare.set(item.id,item);}
    paintTray();
  }
  function paintTray() {
    const tray=refs.tray,items=[...compare.values()];
    tray.hidden=!items.length;tray.replaceChildren();
    for(const item of items){
      const chip=el('span',undefined,'lx-tray-item');
      chip.append(photo(item.image,item.name,'lx-tray-photo'),el('span',item.name),button('×',()=>{toggleCompare(item);schedule();},'lx-tray-x'));
      tray.append(chip);
    }
    tray.append(button(items.length>1?`Sammenlign ${items.length} varer`:'Velg minst én til',showCompare,'lx-primary'));
    tray.lastChild.disabled=items.length<2;
  }
  function showCompare() {
    const box=el('dialog',undefined,'lx-compare lx'),items=[...compare.values()],close=()=>{box.close();box.remove();};
    box.oncancel=event=>{event.preventDefault();close();};
    const head=el('div',undefined,'lx-drawer-bar');head.append(el('h2','Side om side'),button('Lukk',close,'lx-ghost small'));box.append(head);
    const scroll=el('div',undefined,'lx-compare-scroll'),table=el('table');
    const headRow=el('tr');headRow.append(el('th',''));
    for(const item of items){const th=el('th');th.append(photo(item.image,item.name,'lx-compare-photo'),el('span',item.name,'lx-card-name'),el('span',[item.brand,packText(item.pack,item.packUnit)].filter(Boolean).join(' · '),'lx-card-sub'));headRow.append(th);}
    const thead=el('thead');thead.append(headRow);table.append(thead);
    const tbody=el('tbody');
    const line=(label,get)=>{const tr=el('tr');tr.append(el('th',label));for(const item of items){const td=el('td',get(item)??'–');tr.append(td);}tbody.append(tr);};
    const views=new Map(items.map(i=>[i.id,result.views[i.index]]));
    line('Pakkepris',i=>views.get(i.id).packPrice!==null?money(views.get(i.id).packPrice)+(views.get(i.id).fresh?'':' (eldre)'):null);
    line('Enhetspris',i=>views.get(i.id).unitPrice!==null?money(views.get(i.id).unitPrice)+'/'+views.get(i.id).unit:null);
    for(const axis of NUTRIENTS){
      const tr=el('tr');tr.append(el('th',axis.label));
      const values=items.map(i=>i.nutrition?.[axis.key]),top=Math.max(...values.filter(v=>typeof v==='number'),1);
      values.forEach(value=>{
        const td=el('td');
        if(typeof value==='number'){td.append(el('span',`${short(value)} ${axis.unit}`));const track=el('span',undefined,'lx-bar-track'),fill=el('i');fill.style.width=(value/top*100)+'%';track.append(fill);td.append(track);}
        else td.textContent='ikke oppgitt';
        tr.append(td);
      });
      tbody.append(tr);
    }
    line('Protein per krone',i=>{const value=proteinPerKrone(i,views.get(i.id));return value===null?null:short(value)+' g';});
    table.append(tbody);scroll.append(table);box.append(scroll);
    const shared=items.reduce((set,item,i)=>i?set.filter(f=>item.families.includes(f)):[...item.families],[]);
    box.append(el('p',shared.length?'Alle er gjennomgått i samme varefamilie: '+model.families[shared[0]].name+'. Tall per 100 g/ml.':'Disse er ikke vurdert som like varer. Sammenligningen viser bare tallene.','lx-note'));
    document.body.append(box);box.showModal();
  }

  return {open};
}
