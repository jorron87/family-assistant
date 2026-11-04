import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const details = {
  authenticated:'Vigilo viser en innlogget fane. Fanen er beskyttet mot automatisk minneutlasting; Vigilo håndterer øktfornyelsen selv.',
  offline:'Vigilo-fanen er uten nett. Øktfornyelsen kan ikke bekreftes før nettet er tilbake.',
  tab_frozen:'Chrome har fryst Vigilo-fanen. Åpne fanen; Vigilos øktfornyelse kan ha vært satt på pause.',
  restoring_discarded:'Chrome hadde lastet Vigilo-fanen ut av minnet. Fanen er gjenåpnet; innlogging er ennå ikke bekreftet.',
  loading:'Vigilo-fanen laster. Innlogging er ennå ikke bekreftet.',
  returning_to_content:'Vigilo bekreftet «Du er pålogget». Den samme fanen går tilbake til Siste nytt; venter på bekreftet innlogget visning.',
  other_page:'Vigilo står på en annen side. Gå til Siste nytt/Meldinger i den eksisterende fanen for øktkontroll.',
  inspection_failed:'Utvidelsen kunne ikke kontrollere Vigilo-fanen. Prøv utvidelsesknappen og kontroller at fanen er tilgjengelig.',
  unrecognized_page:'Vigilo-fanen viser ikke den forventede innloggede visningen. Kontroller fanen; dette er ikke bekreftet innlogging.',
  login_required:'Vigilo viser ikke en innlogget Siste nytt/Meldinger-fane. Åpne Vigilo og fullfør eventuell ny innlogging.',
  no_tab:'Ingen Vigilo-foreldreportalfane er åpen. Åpne Vigilo og logg inn ved behov.',
  extension_error:'Vigilo-utvidelsen meldte en teknisk feil. Kontroller utvidelsen; innlogging er ikke bekreftet.',
  legacy:'Den eldre Vigilo-utvidelsen rapporterer status. Last inn versjon 1.2.0 for forbedret øktkontroll.',
};
// Nyere utvidelsesversjoner er alltid greit; bare eldre (eller ukjent) krever oppgradering.
const atLeast = (version, minimum) => { const a = String(version).split('.').map(Number), b = minimum.split('.').map(Number); if (a.length !== 3 || a.some(Number.isNaN)) return false; for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };
const initial = () => ({latest:null,history:[],lastAuthenticatedAt:null,lastNeedsLoginAt:null,continuousSince:null});

export function createSessionMaintenance({dataDir,now=Date.now}) {
  mkdirSync(dataDir,{recursive:true});
  const file=join(dataDir,'vigilo-session-health.json');
  let state=initial();
  if(existsSync(file)) {try {state={...state,...JSON.parse(readFileSync(file,'utf8'))};} catch { /* A fresh report repairs diagnostic state only. */ }}
  const staleAfter=entry=>(entry?.intervalSeconds??300)*3000;
  function snapshot() {
    const latest=state.latest;
    const stale=!!latest&&now()-Date.parse(latest.checkedAt)>staleAfter(latest);
    return {...(latest??{health:'not_configured',details:'Vigilo-øktkontroll venter på rapport fra Chrome.',checkedAt:null}),
      ...(stale?{health:'error',details:'Øktkontrollen svarer ikke. Chrome, PC-en eller utvidelsen kan være stoppet.',reportedHealth:latest.health}:{}),
      stale,expectedVersion:'1.2.0',upgradeRequired:!!latest&&!atLeast(latest.version,'1.2.0'),
      lastAuthenticatedAt:state.lastAuthenticatedAt,lastNeedsLoginAt:state.lastNeedsLoginAt,
      continuousSince:stale?null:state.continuousSince};
  }
  function record(input) {
    if(!['ok','needs_login','error','checking'].includes(input.health))throw Error('Ugyldig øktstatus.');
    const code=Object.hasOwn(details,input.code)?input.code:'legacy';
    const checkedAt=new Date(now()).toISOString();
    // Allowlist only: no page text, URLs, exception messages or credentials.
    const entry={health:input.health,code,details:details[code],checkedAt,
      version:/^\d+\.\d+\.\d+$/.test(input.version??'')?input.version:'legacy',
      intervalSeconds:Number.isFinite(input.intervalSeconds)?Math.max(30,Math.min(300,input.intervalSeconds)):300};
    for(const key of ['keeperProtected','focused','wasDiscarded'])if(typeof input[key]==='boolean')entry[key]=input[key];
    for(const key of ['tabCount','keeperTabId','pageAgeMs','probeGapMs'])if(Number.isFinite(input[key])&&input[key]>=0)entry[key]=Math.min(input[key],365*86400000);
    const gap=state.latest?now()-Date.parse(state.latest.checkedAt):null;
    if(gap>staleAfter(state.latest))entry.reportGapMs=gap;
    if(state.latest?.keeperTabId!==undefined&&entry.keeperTabId!==undefined&&state.latest.keeperTabId!==entry.keeperTabId)entry.keeperChanged=true;
    if(state.latest?.pageAgeMs!==undefined&&entry.pageAgeMs!==undefined&&entry.pageAgeMs+5000<state.latest.pageAgeMs)entry.documentChanged=true;
    if(input.health==='ok') {
      state.lastAuthenticatedAt=checkedAt;
      if(state.latest?.health!=='ok'||entry.reportGapMs||!state.continuousSince)state.continuousSince=checkedAt;
    } else state.continuousSince=null;
    if(input.health==='needs_login')state.lastNeedsLoginAt=checkedAt;
    const previous=state.history.at(-1);
    if(!previous||previous.health!==entry.health||previous.code!==entry.code||previous.version!==entry.version||
      entry.reportGapMs||entry.keeperChanged||entry.documentChanged||entry.probeGapMs>180000||entry.wasDiscarded!==previous.wasDiscarded||now()-Date.parse(previous.checkedAt)>=15*60000)state.history.push(entry);
    state.latest=entry;
    state.history=state.history.filter(item=>Date.parse(item.checkedAt)>now()-14*86400000).slice(-3000);
    writeFileSync(`${file}.tmp`,JSON.stringify(state));renameSync(`${file}.tmp`,file);
    return snapshot();
  }
  return {snapshot,record,history:()=>({status:snapshot(),events:state.history.slice(-200)})};
}
