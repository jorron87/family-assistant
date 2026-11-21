const el=id=>document.getElementById(id);
const money=(minor,currency='NOK')=>new Intl.NumberFormat('nb-NO',{style:'currency',currency}).format(minor/100);
const date=value=>new Date(value).toLocaleString('nb-NO');
function append(parent,tag,text) {
  const child=document.createElement(tag);child.textContent=text;parent.append(child);return child;
}
async function request(path,body){
  const response=await fetch('/send/api/finance'+path,{method:body?'POST':'GET',cache:'no-store',
    headers:{'Content-Type':'application/json','x-family-request':'1'},body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if (!response.ok) throw Error(data.error+(data.deviceId?' Enhets-ID: '+data.deviceId:''));
  return data;
}
function run(action){return async()=>{try {await action();}catch(error){el('status').textContent=error.message;}};}
function addAction(parent,label,action) {
  const button=append(parent,'button',label);button.type='button';button.onclick=run(action);
}
async function show(){
  const data=await request('?month='+encodeURIComponent(el('month').value));
  el('overview').hidden=false;
  el('status').textContent='Opplysningene er felles for de godkjente voksne.';
  const current=data.connections.find(c=>c.me);
  el('connect').textContent=current?.expires?'Forny min DNB-tilkobling':'Koble mine DNB-kontoer til felles voksenvisning';
  el('savings').textContent=data.hasRule?money(data.saved)+(data.goal!=null?' av '+money(data.goal*100):'')+' registrert denne måneden.':'Velg en kjent Nordnet-overføring under egen konto for å kjenne igjen kommende innskudd.';
  if (data.hasRule && data.saved===0) el('savings').textContent+=' Ingen innbetaling til den bekreftede mottakeren er registrert i perioden. Sjekk kontodekning og siste synk.';
  const connections=el('connections');connections.replaceChildren();
  for (const c of data.connections) {
    const remaining=Date.parse(c.expires)-Date.now();
    const status=!c.expires?'Venter på tilkobling':remaining<=0?'Samtykket har utløpt':remaining<7*86400000?'Forny samtykket før '+date(c.expires):'Samtykke til '+date(c.expires);
    append(connections,'p',c.name+' · '+status+(c.issue?' · '+c.issue:''));
  }
  const accounts=el('accounts');accounts.replaceChildren();
  for (const a of data.accounts) {
    const section=append(accounts,'section','');section.className='surface';
    append(section,'h3',a.name);
    append(section,'p',money(a.balance.minor,a.balance.currency)+' · '+a.balance.type+' · oppdatert '+date(a.syncedAt));
    if (Date.now()-Date.parse(a.syncedAt)>36*3600000) append(section,'p','Tallene er eldre enn 36 timer. Nye kjøp kan mangle.');
    append(section,'p','Eldste bokførte postering: '+(a.firstDate||'ingen kjøp')+'. '+(a.difference===null?'Ingen sammenlignbar tidligere bokført saldo.':a.difference===0?'Saldoendringen stemmer med posteringene.':'Avvik mot forrige bokførte saldo: '+money(a.difference,a.balance.currency)));
    if (a.own&&a.rule) addAction(section,'Fjern Nordnet-regel',async()=>{await request('/target',{account:a.key,clear:true});await show();});
    if (!a.rows.length) append(section,'p','Ingen registrerte posteringer i valgt måned.');
    for (const r of a.rows) {
      const line=append(section,'details','');
      append(line,'summary',r.date+' · '+r.label+' · '+money(r.minor,r.currency)+(r.saving?' · Nordnet':''));
      if (a.own&&r.canMark&&!r.saving) addAction(line,'Bekreft mottaker som Nordnet',async()=>{await request('/target',{account:a.key,id:r.id});await show();});
    }
  }
}
const today=new Date();
el('month').value=today.getFullYear()+'-'+String(today.getMonth()+1).padStart(2,'0');
el('month').onchange=run(show);
el('connect').onclick=run(async()=>{const {url}=await request('/connect',{});location.assign(url);});
await run(async()=>{
  const query=new URLSearchParams(location.search);
  if (location.search) history.replaceState(null,'',location.pathname);
  if (query.has('code')) {
    el('status').textContent='Henter kontoer og bokførte kjøp …';
    await request('/confirm',{state:query.get('state'),code:query.get('code')});
  } else if (query.has('error')) throw Error('Banktilkoblingen ble avbrutt. Åpne økonomi på nytt for å prøve igjen.');
  await show();
})();
