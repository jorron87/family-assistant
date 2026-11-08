const money=value=>new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:0}).format(value);
const priceMoney=value=>new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',minimumFractionDigits:0,maximumFractionDigits:2}).format(value);
const number=value=>new Intl.NumberFormat('nb-NO',{maximumFractionDigits:3}).format(value);
const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const link=(title,url)=>{const a=el('a',title);a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;};
const button=(label,action)=>{const b=el('button',label);b.type='button';b.onclick=action;return b;};
async function request(path,input){const response=await fetch('/api/shopping'+path,{...(input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify(input)}),signal:AbortSignal.timeout(path==='/oda/sync'?300000:45000)});const data=await response.json();if(!response.ok)throw Error(data.error??'Kunne ikke hente handelen.');return data;}
function table(headers,rows){const t=el('table'),head=el('thead'),hr=el('tr');for(const h of headers)hr.append(el('th',h));head.append(hr);t.append(head);const body=el('tbody');for(const row of rows){const tr=el('tr');for(const value of row){const td=el('td');td.append(value instanceof Node?value:document.createTextNode(String(value)));tr.append(td);}body.append(tr);}t.append(body);const wrap=el('div',undefined,'shopping-table');wrap.append(t);return wrap;}

export function installShoppingView({panel,banner,onOpen}) {
  let data=null,loading=false,error=null,watchDialog;
  const message=el('p',undefined,'shopping-message');message.setAttribute('role','status');
  async function action(fn){try{message.textContent='Arbeider …';await fn();message.textContent='Lagret.';await refresh(true);}catch(e){message.textContent=e.message;}}
  function watchForm(product=null,existing=null){
    watchDialog?.remove();watchDialog=el('dialog',undefined,'shopping-dialog');const form=el('form');
    form.append(el('h2',existing?'Endre overvåkning':'Overvåk pris'));
    const fields={};
    function field(name,label,type,value){const wrap=el('label',label),input=el(type==='select'?'select':'input');input.name=name;if(type!=='select')input.type=type;input.value=value??'';wrap.append(input);form.append(wrap);fields[name]=input;return input;}
    field('name','Vare eller varegruppe','text',existing?.name??product?.name).required=true;
    const unit=field('unit','Sammenligningsenhet','select');for(const v of ['kg','l','stk']){const o=el('option',v);o.value=v;unit.append(o);}unit.value=existing?.unit??product?.unit??'stk';
    const storage=field('storage','Lagring','select');for(const [v,title]of [['frozen','Kan fryses'],['pantry','Tørrvare / lang holdbarhet'],['chilled','Kjølevare'],['other','Annet']]){const o=el('option',title);o.value=v;storage.append(o);}storage.value=existing?.storage??'other';
    field('targetPrice','Varsle under pris per valgt enhet (valgfritt)','number',existing?.targetPrice).step='.01';
    field('excellentPrice','Svært bra pris per valgt enhet (valgfritt)','number',existing?.excellentPrice).step='.01';
    field('minDiscountPct','Minste rabatt i prosent','number',existing?.minDiscountPct??0);
    field('maxPacks','Øvre grense for antall pakker','number',existing?.maxPacks??10);
    field('purchaseAmount','Planlagt bulkmengde i valgt enhet (valgfritt)','number',existing?.purchaseAmount).step='.1';
    field('monthlyUsage','Anslått samlet månedsforbruk i valgt enhet (valgfritt)','number',existing?.monthlyUsage).step='.1';
    field('stockAmount','På lager nå, i valgt enhet (valgfritt)','number',existing?.stockAmount).step='.1';
    form.append(el('p','Velg enten en planlagt bulkmengde eller et månedsforbruk. Bulkmengden er et innkjøpsmål, ikke målt forbruk. Vurder holdbarhet og beholdning. Oda viser bare kjøpene hos Oda; suppleringskjøp og antallsgrenser kan skjule behovet.'));
    const save=el('button','Lagre overvåkning');save.type='submit';form.append(save,button('Avbryt',()=>watchDialog.close()));
    form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{const input=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,['name','storage','unit'].includes(k)?v.value:v.value===''?null:Number(v.value)]));await request('/watch',{...existing,...input,productKeys:existing?.productKeys??(product?[product.productKey]:[])});watchDialog.close();await refresh(true);}catch(e){save.disabled=false;form.append(el('p',e.message));}};
    watchDialog.append(form);document.body.append(watchDialog);watchDialog.showModal();
  }
  function render(){
    if(!data)return;panel.replaceChildren();const heading=el('div',undefined,'shopping-heading');heading.append(el('div',undefined,'eyebrow'),el('h2','Handel'),el('p','Gode kjøp på det vi faktisk bruker.'));panel.append(heading,message);
    const offers=el('section',undefined,'shopping-offers');offers.append(el('h3','Gode kjøp å vurdere'));
    if(!data.opportunities.length)offers.append(el('p',data.settings.monitoringEnabled?'Ingen ferske, verifiserte tilbud oppfyller grensene nå.':'Tilbudsovervåkning er ikke aktivert ennå.'));
    for(const o of data.opportunities){const card=el('article',undefined,'shopping-offer');card.append(el('span',o.storeName,'eyebrow'),el('h3',o.watchName),el('strong',o.saving!==null?`${money(o.saving)} mulig spart`:'Under målprisen'),el('p',`${priceMoney(o.unitPrice)} / ${o.unit} inkl. moms · sammenlignet med ${priceMoney(o.referencePrice)} / ${o.unit} ${o.referenceType==='paid'?'betalt hos Oda':o.referenceType==='market'?'konservativ markedsreferanse':o.referenceType==='alternative'?'aktuell alternativpris':'målpris'}`),el('p',`${o.packs} pakker à ${number(o.packAmount)} ${o.unit} · gjelder ${o.validFrom}–${o.validTo}`),el('p',o.quantityBasis==='planned-amount'?'Planlagt bulkmengde; kontroller beholdning og holdbarhet før kjøp.':o.quantityBasis==='oda-lower-bound'?'Forsiktig mengdeanslag fra Oda-kjøp; faktisk forbruk kan være høyere.':o.quantityBasis==='household-estimate'?'Mengdeanslag fra familiens oppgitte forbruk.':'Tilbudets pakningsmengde; samlet forbruk er ukjent.'),el('p',[o.checkStock?'Sjekk lagerplass og beholdning.':'Lagerbeholdning er tatt med.',o.conditions,o.memberOnly?'Krever medlemskap.':''].filter(Boolean).join(' ')),el('p',o.comparisonNote),link('Se tilbudet',o.sourceUrl));offers.append(card);}panel.append(offers);
    const analysis=el('section');analysis.append(el('h3','Hvor går pengene?'));const a=data.analysis;
    analysis.append(el('p',`${a.orderCount} Oda-bestillinger · ${a.from}–${a.to} · ${money(a.orderTotal)} inkludert gebyrer og pant`),el('p','Dette er bare Oda-kjøp. Kjøp i andre butikker mangler, og antallsgrenser kan skjule behovet. Innkjøp er ikke målt forbruk.','shopping-note'));
    if(a.unallocatedDiscount>0)analysis.append(el('p',`${money(a.unallocatedDiscount)} i rabatter mangler fordeling på varer. Berørte priser brukes ikke som tilbudsgrunnlag.`));
    if(a.orderCount){analysis.append(table(['Kategori','Varelinjer etter fordelte rabatter'],a.categories.map(x=>[x.name,money(x.amount)])));
      const details=el('details');details.append(el('summary','Varene vi bruker mest penger på'),table(['Vare','Beløp','Antall kjøp','Betalt per enhet',''],a.products.map(p=>[p.name,money(p.spent),p.orders,p.baselineUnitPrice!==null?`${priceMoney(p.baselineUnitPrice)} / ${p.unit}`:'Mangler sikkert prisgrunnlag',button('Overvåk',()=>watchForm(p))])));analysis.append(details);
    }else analysis.append(el('p','Hent historikken etter at Oda er tilkoblet.'));
    const sync=button('Hent Oda-historikk',()=>action(async()=>{sync.disabled=true;try{const result=await request('/oda/sync',{});if(!result.complete)throw Error(result.note);}finally{sync.disabled=false;}}));sync.disabled=!data.oda.connected;analysis.append(sync);panel.append(analysis);
    const watch=el('section');watch.append(el('h3','Vi følger med på'),button('Legg til prisovervåkning',()=>watchForm()));
    const groups=data.watches.map(w=>{const rows=a.products.filter(p=>w.productKeys.includes(p.productKey));return {w,rows,spent:rows.reduce((sum,p)=>sum+p.spent,0),household:rows.some(p=>['Hus og hjem','Hygiene og skjønnhet','Baby og barn'].includes(p.category))};}).filter(g=>g.rows.length||(g.w.storage==='frozen'&&g.w.targetPrice!==null)).sort((x,y)=>y.spent-x.spent);
    if(groups.length){
      const filter=el('input'),kind=el('select'),guideRows=el('div'),count=el('p');filter.type='search';filter.placeholder='Finn en varegruppe';filter.setAttribute('aria-label','Filtrer prisguiden');kind.setAttribute('aria-label','Varetype');
      for(const [value,label]of [['all','Alle varer'],['food','Mat'],['household','Husholdning']]){const option=el('option',label);option.value=value;kind.append(option);}
      function renderGuide(){
        const selected=groups.filter(g=>g.w.name.toLocaleLowerCase('nb-NO').includes(filter.value.toLocaleLowerCase('nb-NO'))&&(kind.value==='all'||(kind.value==='household')===g.household));
        count.textContent=`${selected.filter(g=>g.w.marketCalibration?.status==='ready').length} av ${selected.length} grupper har tilstrekkelig gjennomgått markedshistorikk.`;
        const price=v=>v!=null?priceMoney(v):'—';
        guideRows.replaceChildren(table(['Varegruppe og grunnlag','Oda-beløp','Registrert mengde','Referanse / enhet','Bra kjøp / enhet','Svært bra / enhet','Bulkmengde'],selected.map(({w,rows,spent})=>{
          const m=w.marketCalibration,label=el('span',w.name);
          const basis=m?.status==='ready'?`Kassal: ${m.coverage.observedDays} dager · ${m.coverage.chainCount} kjeder`:m?'For lite sikker markedshistorikk':w.priceGuide?'Oda-basis · foreløpig':'Ikke markedskalibrert';
          label.append(el('small',basis));if(w.priceGuide)label.title=w.priceGuide.evidence;
          return [label,rows.length?money(spent):'Ukjent',rows.length&&rows.every(p=>p.unit===w.unit)?`${number(rows.reduce((sum,p)=>sum+p.baselineAmount,0))} ${w.unit}`:'Ukjent',`${price(w.priceGuide?.referencePrice)} / ${w.unit}`,`${price(w.targetPrice)} / ${w.unit}`,`${price(w.excellentPrice)} / ${w.unit}`,w.purchaseAmount!=null?`${number(w.purchaseAmount)} ${w.unit}`:'Vurderes ved tilbud'];
        })));
      }
      filter.oninput=renderGuide;kind.onchange=renderGuide;
      watch.append(el('h3','Prisguide for basisvarer og faste kjøp'),el('p','Kassal-grupper bygger på faktisk prishistorikk for gjennomgåtte, tilsvarende varer. Vanlig lavpris er ikke nødvendigvis et hamstringstilbud; tomt felt for svært bra betyr at en særskilt lavpris ikke er dokumentert. Oda-mengder er nedre kjøpsgrunnlag, ikke målt forbruk.'),filter,kind,count,guideRows);renderGuide();
    }
    const controls=el('details');controls.append(el('summary',`Endre overvåkninger (${data.watches.length})`));
    for(const w of data.watches){const row=el('div',undefined,'shopping-watch');row.append(el('span',w.name+(w.enabled===false?' · pauset':'')),button('Endre',()=>watchForm(null,w)),button(w.enabled===false?'Start':'Pause',()=>action(()=>request('/watch',{...w,enabled:w.enabled===false}))));controls.append(row);}watch.append(controls);panel.append(watch);
    const nutrition=el('section');nutrition.append(el('h3','Mat og næring'));const n=data.nutrition;
    nutrition.append(el('p',`Næringsdata dekker ${number(n.coverage.spendPct)} % av matvarebeløpet (${n.coverage.coveredLines} av ${n.coverage.foodLines} varelinjer).`),el('p',n.note,'shopping-note'));
    if(n.coverage.coveredLines)nutrition.append(table(['Kildebelagte innkjøp','Mengde'],[['Energi',`${number(n.totals.kcal)} kcal`],['Protein',`${number(n.totals.protein)} g`],['Fett',`${number(n.totals.fat)} g`],['Karbohydrater',`${number(n.totals.carbs)} g`]]),table(['Proteinkilde','Kr per 100 g protein'],n.proteinCosts.slice(0,10).map(x=>[x.name,money(x.per100gProtein)])));
    else nutrition.append(el('p','Næringsverdier må hentes fra produktetiketter eller andre verifiserte kilder før makroer kan beregnes.'));
    const planner=el('details');planner.append(el('summary','Proteinanslag for voksne som trener styrke'));const weightLabel=el('label','Kroppsvekt i kg'),weight=el('input'),estimate=el('p');weight.type='number';weight.min='30';weight.max='300';weight.placeholder='kg';weightLabel.append(weight);planner.append(weightLabel,estimate,el('p','Omtrent 1,2–1,8 g/kg/dag er Olympiatoppens oppgitte intervall for styrke-/kraftidretter. Ca. 1,6 g/kg er et praktisk planleggingspunkt. Dette er et anslag for voksne, ikke barnas mål.'),link('Kilde: Olympiatoppen','https://www.olympiatoppen.no/fagomrader/idrettspsernaering/faktaark/8.-fakta-om-protein-og-idrett/'));weight.oninput=()=>{const kg=Number(weight.value);estimate.textContent=kg>=30&&kg<=300?`${Math.round(kg*1.2)}–${Math.round(kg*1.8)} g per dag · planleggingspunkt ca. ${Math.round(kg*1.6)} g`:'';};nutrition.append(planner);panel.append(nutrition);
    const cart=el('section');cart.append(el('h3','Legg varer i Oda-kurven'));
    if(!data.oda.connected){cart.append(el('p','Oda må kobles til én gang fra oppsettet på PC-en.'));
      if(location.port!=='4319')cart.append(link('Åpne shoppingoppsett','/shopping-setup'));
    }else{const form=el('form',undefined,'shopping-search'),input=el('input'),search=el('button','Søk i Oda'),results=el('div');input.type='search';input.placeholder='Hva trenger vi?';input.setAttribute('aria-label','Søk etter vare hos Oda');search.type='submit';form.append(input,search);form.onsubmit=async event=>{event.preventDefault();search.disabled=true;results.replaceChildren();try{const response=await request('/oda/search',{query:input.value});for(const p of response.result?.[0]?.products??[]){const row=el('div',undefined,'shopping-watch'),quantity=el('input');quantity.type='number';quantity.min='1';quantity.max='100';quantity.value='1';quantity.setAttribute('aria-label',`Antall ${p.name}`);const add=button('Legg til',async()=>{add.disabled=true;const requestId=crypto.randomUUID();try{const receipt=await request('/oda/add',{requestId,productId:p.id,quantity:Number(quantity.value)});row.append(link('Lagt til · se kurven',receipt.url));}catch(e){row.append(el('p',e.message));}});add.disabled=p.availability?.isAvailable!==true;row.append(el('span',`${p.name} · ${p.description} · ${p.price} kr${p.availability?.description?' · '+p.availability.description:''}`),quantity,add);results.append(row);}if(!results.childElementCount)results.append(el('p','Ingen treff.'));}catch(e){results.append(el('p',e.message));}finally{search.disabled=false;}};cart.append(form,results,el('p','Du ser over og betaler hos Oda.'));
    }panel.append(cart);
    const sources=el('details');sources.append(el('summary','Butikker og kontrollstatus'),el('p',data.settings.storageNote));for(const store of data.settings.stores){const review=data.reviews.find(x=>x.storeId===store.id);sources.append(el('p',`${store.name}: ${review?`${review.status==='ok'?'kontrollert':'blokkert'} ${review.checkedAt.slice(0,10)}`:'ikke kontrollert'} · minst ${money(store.minSavings)} mulig spart for handletur.`));}panel.append(sources);
  }
  async function refresh(force=false){if(loading)return;loading=true;try{data=await request('');error=null;banner.hidden=!data.opportunities.length;banner.replaceChildren();if(data.opportunities.length)banner.append(button(`${data.opportunities.length} gode kjøp å vurdere · se Handel`,onOpen));if(force||panel.classList.contains('active')){if(!panel.contains(document.activeElement)||force)render();}}catch(e){error=e.message;if(panel.classList.contains('active')){panel.replaceChildren(el('h2','Handel'),el('p',error));}}finally{loading=false;}}
  refresh();setInterval(()=>refresh(),60000);return {open:()=>{if(data)render();else refresh(true);}};
}
