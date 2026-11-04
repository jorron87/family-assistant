// Independent adapter for the public Min Renovasjon address calendar.
const api = 'https://norkartrenovasjon.azurewebsites.net/proxyserver.ashx?server=https://komteksky.norkart.no/MinRenovasjon.Api/api/';
export const nextDay = date => new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
export function parseSchedule(fractions, rows) {
  if (!Array.isArray(fractions) || !Array.isArray(rows) || !rows.length) throw new Error('Min Renovasjon returnerte ingen gyldig henteplan. Tidligere avtaler beholdes.');
  const names = new Map(fractions.map(f => [Number(f.Id), f.Navn]));
  const seen = new Set();
  return rows.map(row => {
    const id = Number(row.FraksjonId), name = names.get(id);
    if (!name || seen.has(id) || !Array.isArray(row.Tommedatoer) || !row.Tommedatoer.length) throw new Error('Ufullstendig eller ukjent avfallsfraksjon. Tidligere avtaler beholdes.');
    seen.add(id);
    const dates = [...new Set(row.Tommedatoer.map(value => {
      if (!/^\d{4}-\d{2}-\d{2}T00:00:00$/.test(value) || new Date(value+'Z').toISOString().slice(0,19) !== value) throw new Error('Ugyldig hentedato fra Min Renovasjon.');
      return value.slice(0,10);
    }))].sort();
    return {id,name,dates};
  }).sort((a,b)=>a.id-b.id);
}
export function reconcileSchedule(current, previous = [], today) {
  const byId = new Map(current.map(f => [f.id, f]));
  // The API only supplies the next few dates per fraction. Preserve dates beyond
  // its verified horizon; absence outside that horizon is not a cancellation.
  for (const old of previous) {
    const fresh = byId.get(old.id);
    if (!fresh) throw new Error('En tidligere avfallsfraksjon mangler. Kontroller kilden før sletting.');
    fresh.dates = [...new Set([...fresh.dates, ...old.dates.filter(d=>d>=today && d>fresh.dates.at(-1))])].sort();
  }
  const grouped = new Map();
  for (const fraction of byId.values()) for (const date of fraction.dates.filter(d=>d>=today)) {
    const group = grouped.get(date) ?? [];
    group.push(fraction.name); grouped.set(date,group);
  }
  return [...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([date,names])=>({date,names}));
}
export async function fetchWaste(config, fetcher = fetch) {
  if(!config.appKey)throw Error('Configure an authorized Min Renovasjon appKey before enabling collection.');
  const headers = {Kommunenr:config.municipality, RenovasjonAppKey:config.appKey};
  const get = async path => {
    const response = await fetcher(api+path, {headers, signal:AbortSignal.timeout(25000)});
    if (!response.ok) throw new Error(`Min Renovasjon HTTP ${response.status}`);
    return response.json();
  };
  const query = new URLSearchParams({kommunenr:config.municipality,gatenavn:config.street,gatekode:String(config.streetCode),husnr:String(config.houseNumber)});
  const [fractions,calendar] = await Promise.all([get('fraksjoner/'),get('tommekalender?'+query)]);
  return {schedule:parseSchedule(fractions,calendar), original:{fractions,calendar}, endpoint:api+'tommekalender?'+query};
}
export async function refreshWaste(store, config, {force=false} = {}) {
  const state = store.snapshot(), status = state.sourceStatus.renovasjon;
  const localDate = value => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Oslo'}).format(new Date(value));
  if (!force && status?.health==='ok' && localDate(status.checkedAt)===localDate(Date.now())) return {cached:true,status,unsynced:state.events ? Object.values(state.events).filter(e=>e.canonicalKey.startsWith('renovasjon:')&&e.calendar?.fingerprint!==e.fingerprint) : []};
  try {
    const externalId = `${config.municipality}:${config.streetCode}:${config.houseNumber}`;
    const old = Object.values(state.rawItems).find(r=>r.source==='renovasjon'&&r.externalId===externalId);
    let previous=[];
    if (old) previous=JSON.parse(old.body.slice(old.body.indexOf('\nJSON:\n')+7)).schedule;
    const fetched = await fetchWaste(config);
    const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Oslo'}).format(new Date());
    const pickups = reconcileSchedule(structuredClone(fetched.schedule),previous,today);
    const prefix = `renovasjon:${externalId}:`;
    const findings = pickups.map(({date,names})=>({canonicalKey:prefix+date,title:`Søppelhenting – ${names.join(', ')}`,kind:'event',start:date,end:nextDay(date),allDay:true,provisional:false,cancelled:false,members:[],checklist:[`Sett frem ${names.join(', ').toLocaleLowerCase('nb-NO')} kvelden før.`],details:`Henting ved ${config.address}. ${names.join(', ')}. Datoen er oppgitt av Min Renovasjon; hentetidspunkt er ikke oppgitt. Sett frem kvelden før.`,reason:'Adressebasert henteplan fra Min Renovasjon (Asker).',replacePrevious:true,correctsPrevious:true}));
    for (const event of Object.values(state.events).filter(e=>e.canonicalKey.startsWith(prefix)&&!e.cancelled&&e.start>=today&&!pickups.some(p=>p.date===e.start))) findings.push({...event,cancelled:true,replacePrevious:true,correctsPrevious:true,details:'Denne hentedatoen er fjernet fra den oppdaterte henteplanen. Ikke sett frem basert på denne oppføringen.'});
    const evidence={schedule:fetched.schedule,original:fetched.original,endpoint:fetched.endpoint};
    const result = store.upsertRaw({source:'renovasjon',externalId,title:`Henteplan – ${config.address}`,body:`Min Renovasjon / Asker\nAdresse: ${config.address}\n${pickups.map(p=>`${p.date}: ${p.names.join(', ')}`).join('\n')}\nJSON:\n${JSON.stringify(evidence)}`,sourceUrl:config.sourceUrl,publishedAt:old?.publishedAt??new Date().toISOString(),memberIds:[],findings});
    store.reviewProfile(result.item.id,{facts:[],note:'Adressebasert henteplan; ingen nye personlige preferanser eller verv.'});
    const checked = store.updateSource({source:'renovasjon',health:'ok',scope:config.address,details:`${pickups.length} hentedager. API viser et begrenset antall datoer per avfallstype; ingen gjentakelser er antatt.`,seenCount:pickups.length});
    return {cached:false,changed:result.changed,rawId:result.item.id,revision:result.item.revision,pickups,status:checked,unsynced:result.findings.filter(e=>e.calendar?.fingerprint!==e.fingerprint)};
  } catch(error) {
    store.updateSource({source:'renovasjon',health:'error',scope:config.address,details:`${error.message} Eksisterende avtaler er beholdt.`});
    throw error;
  }
}
