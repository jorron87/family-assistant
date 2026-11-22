// Deterministic household finance analysis. Everything here is recomputed from
// stored bank rows and explicit household/agent rules; nothing is persisted.
import {createHash} from 'node:crypto';

const DAY=86400000;
const nok=minor=>new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:0}).format(Math.round(minor/100));
// Fixed-price services where a higher charge really is a price change.
const FIXED_PRICE=new Set(['abonnement','telekom','forsikring','trening','medlemskap','bolig','barnehage','laan']);
const sha=value=>createHash('sha256').update(value).digest('hex');

export const CATEGORIES={
  dagligvarer:'Dagligvarer', restaurant:'Mat ute og takeaway', alkohol:'Vinmonopolet og alkohol',
  bolig:'Bolig og fellesutgifter', energi:'Strøm og energi', telekom:'Mobil og internett',
  abonnement:'Strømming og abonnementer', forsikring:'Forsikring', laan:'Lån og renter', gebyrer:'Bankgebyrer',
  bil:'Bil, bom og drivstoff', kollektiv:'Kollektivtransport', reise:'Reise og ferie', helse:'Helse og apotek',
  klaer:'Klær og sko', hjem:'Hjem og interiør', elektronikk:'Elektronikk', barn:'Barn, skole og fritid',
  barnehage:'Barnehage og SFO', trening:'Trening og sport', underholdning:'Underholdning og kultur',
  pleie:'Personlig pleie', gaver:'Gaver og veldedighet', medlemskap:'Medlemskap og fagforening',
  offentlig:'Skatt og offentlig', dyr:'Dyr', vipps:'Betalinger til personer', kontanter:'Kontantuttak',
  kort:'Kredittkort og delbetaling (innhold ukjent)', annet:'Annet',
  lonn:'Lønn', trygd:'NAV og offentlige ytelser', 'annen-inntekt':'Andre innbetalinger'
};
export const INCOME_CATEGORIES=new Set(['lonn','trygd','annen-inntekt']);
const SHARED_DEFAULT=new Set(['dagligvarer','bolig','energi','telekom','forsikring','barn','barnehage','laan','hjem','bil','dyr','abonnement']);

// Known Norwegian merchants and chains. The first match wins; household and agent
// rules always override this list.
const BRANDS=[
  ['REMA 1000',/\bREMA\b/,'dagligvarer',true],['KIWI',/\bKIWI\b/,'dagligvarer',true],['MENY',/\bMENY\b/,'dagligvarer',true],
  ['Coop Extra',/\b(COOP )?EXTRA\b/,'dagligvarer',true],['Coop Prix',/\b(COOP )?PRIX\b/,'dagligvarer',true],['Coop Obs',/\bOBS\b(?! BYGG)/,'dagligvarer',true],
  ['Coop Mega',/\b(COOP )?MEGA\b/,'dagligvarer',true],['Coop',/\bCOOP\b/,'dagligvarer',true],['Spar',/\b(EURO)?SPAR\b/,'dagligvarer',true],
  ['Joker',/\bJOKER\b/,'dagligvarer',true],['Bunnpris',/\bBUNNPRIS\b/,'dagligvarer',true],['Oda',/\b(ODA(\.COM)?|KOLONIAL)\b/,'dagligvarer',true],
  ['Nærbutikken',/\bNÆRBUTIKKEN\b/,'dagligvarer',true],['Matkroken',/\bMATKROKEN\b/,'dagligvarer',true],
  ['Vinmonopolet',/\bVINMONOPOLET\b/,'alkohol'],
  ['Foodora',/\bFOODORA\b/,'restaurant'],['Wolt',/\bWOLT\b/,'restaurant'],['Just Eat',/\bJUST ?EAT\b/,'restaurant'],
  ['McDonald’s',/\bMC ?DONALDS?\b/,'restaurant'],['Burger King',/\bBURGER KING\b/,'restaurant'],['Peppes',/\bPEPPES\b/,'restaurant'],
  ['Domino’s',/\bDOMINOS?\b/,'restaurant'],['Espresso House',/\bESPRESSO HOUSE\b/,'restaurant'],['Starbucks',/\bSTARBUCKS\b/,'restaurant'],
  ['Netflix',/\bNETFLIX\b/,'abonnement'],['Spotify',/\bSPOTIFY\b/,'abonnement'],['Apple',/\bAPPLE\.COM|\bITUNES\b/,'abonnement'],
  ['Google',/\bGOOGLE\b|\bYOUTUBE\b/,'abonnement'],['Disney+',/\bDISNEY\b/,'abonnement'],['HBO',/\bHBO\b|\bMAX\.COM\b/,'abonnement'],
  ['Viaplay',/\bVIAPLAY\b/,'abonnement'],['TV 2 Play',/\bTV ?2\b/,'abonnement'],['Storytel',/\bSTORYTEL\b/,'abonnement'],
  ['BookBeat',/\bBOOKBEAT\b/,'abonnement'],['Audible',/\bAUDIBLE\b/,'abonnement'],['Microsoft',/\bMICROSOFT\b|\bXBOX\b/,'abonnement'],
  ['Adobe',/\bADOBE\b/,'abonnement'],['OpenAI',/\bOPENAI\b|\bCHATGPT\b/,'abonnement'],['Anthropic',/\bANTHROPIC\b|\bCLAUDE\.AI\b/,'abonnement'],
  ['Aviser og magasiner',/\bAFTENPOSTEN\b|\bVG\+|\bVG PLUSS|\bECONOMIST\b|\bDAGENS NÆRINGSLIV\b|\bE24\b|\bAMEDIA\b|\bSCHIBSTED\b|\bMORGENBLADET\b|\bKLASSEKAMPEN\b|\bDAGBLADET\b|\bBUDSTIKKA\b|\bNEW YORK TIMES|\bNYTIMES/,'abonnement'],
  ['Dropbox',/\bDROPBOX\b/,'abonnement'],['Amazon',/\bAMAZON\b|\bAMZN\b/,'abonnement'],['PlayStation',/\bPLAYSTATION\b|\bSONY ?INTERACTIVE\b/,'abonnement'],
  ['Nintendo',/\bNINTENDO\b/,'abonnement'],['Strava',/\bSTRAVA\b/,'abonnement'],
  ['SATS',/\bSATS\b/,'trening'],['EVO',/\bEVO\b/,'trening'],['Elixia',/\bELIXIA\b/,'trening'],['3T',/\b3T\b/,'trening'],['Fresh Fitness',/\bFRESH FITNESS\b/,'trening'],
  ['Ruter',/\bRUTER/,'kollektiv'],['Vy',/\bVY\b|\bNSB\b/,'kollektiv'],['Entur',/\bENTUR\b/,'kollektiv'],['Skyss',/\bSKYSS\b/,'kollektiv'],['AtB',/\bATB\b/,'kollektiv'],['Kolumbus',/\bKOLUMBUS\b/,'kollektiv'],
  ['Circle K',/\bCIRCLE ?K\b/,'bil'],['Esso',/\bESSO\b/,'bil'],['Shell',/\bSHELL\b/,'bil'],['Uno-X',/\bUNO-?X\b/,'bil'],['YX',/\bYX\b/,'bil'],['St1',/\bST1\b/,'bil'],
  ['EasyPark',/\bEASY ?PARK\b/,'bil'],['Parkering',/\bAPCOA\b|\bONEPARK\b|\bAIMO\b|\bPARKERING/,'bil'],['Bompenger',/\bAUTOPASS\b|\bFJELLINJEN\b|\bBOMPENGER\b|\bFERDE\b|\bSKYTTEL\b|\bPNB-\d|\bBOMSTASJON/,'bil'],
  ['Boliglån',/^\s*LÅN\b/,'laan'],
  ['Tibber',/\bTIBBER\b/,'energi'],['Fjordkraft',/\bFJORDKRAFT\b/,'energi'],['Hafslund',/\bHAFSLUND\b/,'energi'],['Elvia',/\bELVIA\b/,'energi'],
  ['Fortum',/\bFORTUM\b/,'energi'],['NorgesEnergi',/\bNORGESENERGI\b/,'energi'],['Ishavskraft',/\bISHAVSKRAFT\b/,'energi'],['Lyse',/\bLYSE\b/,'energi'],
  ['Telenor',/\bTELENOR\b/,'telekom'],['Telia',/\bTELIA\b/,'telekom'],['Ice',/\bICE ?(NET|COMMUNICATION|\.NO)?\b/,'telekom'],['Talkmore',/\bTALKMORE\b/,'telekom'],
  ['OneCall',/\bONE ?CALL\b/,'telekom'],['Chili',/\bCHILI\b/,'telekom'],['Altibox',/\bALTIBOX\b/,'telekom'],['GlobalConnect',/\bGLOBALCONNECT\b/,'telekom'],
  ['Gjensidige',/\bGJENSIDIGE\b/,'forsikring'],['If',/\bIF ?SKADE/,'forsikring'],['Tryg',/\bTRYG\b/,'forsikring'],['Fremtind',/\bFREMTIND\b/,'forsikring'],
  ['Frende',/\bFRENDE\b/,'forsikring'],['Codan',/\bCODAN\b/,'forsikring'],['Eika Forsikring',/\bEIKA FORSIKRING\b/,'forsikring'],
  ['Apotek 1',/\bAPOTEK ?1\b/,'helse'],['Vitusapotek',/\bVITUS/,'helse'],['Boots',/\bBOOTS\b/,'helse'],['Apotek',/\bAPOTEK/,'helse'],
  ['H&M',/\bH ?& ?M\b|\bHENNES/,'klaer'],['Cubus',/\bCUBUS\b/,'klaer'],['Dressmann',/\bDRESSMANN\b/,'klaer'],['KappAhl',/\bKAPPAHL\b/,'klaer'],
  ['Lindex',/\bLINDEX\b/,'klaer'],['Zalando',/\bZALANDO\b/,'klaer'],['Boozt',/\bBOOZT\b/,'klaer'],
  ['XXL',/\bXXL\b/,'trening'],['Intersport',/\bINTERSPORT\b/,'trening'],['Sport 1',/\bSPORT ?1\b/,'trening'],['Anton Sport',/\bANTON SPORT\b/,'trening'],
  ['IKEA',/\bIKEA\b/,'hjem'],['Jysk',/\bJYSK\b/,'hjem'],['Clas Ohlson',/\bCLAS OHLSON\b/,'hjem'],['Biltema',/\bBILTEMA\b/,'hjem'],['Jula',/\bJULA\b/,'hjem'],
  ['Plantasjen',/\bPLANTASJEN\b/,'hjem'],['Europris',/\bEUROPRIS\b/,'hjem'],['Nille',/\bNILLE\b/,'hjem'],['Søstrene Grene',/\bSØSTRENE GRENE\b/,'hjem'],
  ['Rusta',/\bRUSTA\b/,'hjem'],['Maxbo',/\bMAXBO\b/,'hjem'],['Byggmax',/\bBYGGMAX\b/,'hjem'],['Obs Bygg',/\bOBS BYGG\b/,'hjem'],
  ['Power',/\bPOWER\b/,'elektronikk'],['Elkjøp',/\bELKJ(Ø|O)P\b/,'elektronikk'],['Komplett',/\bKOMPLETT\b/,'elektronikk'],['NetOnNet',/\bNETONNET\b/,'elektronikk'],
  ['Normal',/\bNORMAL\b/,'pleie'],['Spond',/\bSPOND\b/,'barn'],['Barnehage/SFO',/\bBARNEHAGE\b|\bSFO\b|\bAKS\b|\bSKOLEFRITIDS/,'barnehage'],
  ['Skatteetaten',/\bSKATTEETATEN\b|\bSKATT ?(ØST|VEST|NORD|SØR|MIDT)?\b/,'offentlig'],['Statens vegvesen',/\bSTATENS VEGVESEN\b/,'bil'],
  ['Statens innkrevingssentral',/\bINNKREVINGSSENTRAL/,'offentlig'],['Kommunen',/\bKOMMUNE\b/,'bolig'],
  ['Borettslag/sameie',/\bBORETTSLAG\b|\bSAMEIE\b|\bFELLESKOST|\bOBOS\b|\bUSBL\b|\bHUSLEIE\b/,'bolig'],
  ['Redd Barna',/\bREDD BARNA\b/,'gaver'],['Leger Uten Grenser',/\bLEGER UTEN GRENSER\b/,'gaver'],['Kirkens Bymisjon',/\bBYMISJON\b/,'gaver'],
  ['UNICEF',/\bUNICEF\b/,'gaver'],['Røde Kors',/\bR(Ø|O)DE KORS\b/,'gaver'],['Kreftforeningen',/\bKREFTFORENINGEN\b/,'gaver'],['SOS-barnebyer',/\bSOS[- ]BARNEBYER\b/,'gaver'],
  ['Norsk Folkehjelp',/\bFOLKEHJELP\b/,'gaver'],['WWF',/\bWWF\b/,'gaver'],['Plan',/\bPLAN INTERNATIONAL\b/,'gaver'],
  ['Fagforening',/\bTEKNA\b|\bNITO\b|\bFAGFORBUNDET\b|\bUTDANNINGSFORBUNDET\b|\bPARAT\b|\bFELLESFORBUNDET\b|\bECONA\b|\bSAMFUNNSVITERNE\b|\bDELTA\b|\bJURISTFORBUNDET\b|\bLEGEFORENINGEN\b|\bSYKEPLEIERFORBUND/,'medlemskap'],
  ['Nordnet',/\bNORDNET\b/,'saving'],['Kron',/\bKRON\b/,'saving'],['Firi',/\bFIRI\b/,'saving'],['Fond',/\bODIN FOND|\bSKAGEN\b|\bKLP FOND/,'saving'],
  ['Kredittkort',/\bEUROCARD\b|\bENTERCARD\b|\bRE:?MEMBER\b|\bBANK NORWEGIAN\b|\bTRUMF VISA\b|\bSAS EUROBONUS\b|\bKOMPLETT BANK\b|\bMORROW BANK\b|\bINSTABANK\b/,'kort'],
  ['Klarna/Riverty',/\bKLARNA\b|\bRIVERTY\b|\bAFTERPAY\b|\bWALLEY\b|\bRESURS\b/,'kort'],
  ['Lånekassen',/LÅNEKASSE/,'laan'],['Nettleie',/\bNORGESNETT\b|\bNETTLEIE\b|\bGLITRE\b|\bTENSIO\b|\bBKK NETT\b/,'energi'],
  ['Fiber/bredbånd',/\bFIBER\b|BREDBÅND/,'telekom'],['NAF',/\bNORGES AUTOMOBIL|\bNAF\b/,'bil'],
  ['Helse',/\bHF\b|\bSYKEHUS|\bLEGESENTER|\bLEGEKONTOR|\bTANNLEGE|\bFYSIOTERAPI|\bOPTIKER|\bSPECSAVERS\b|\bBRILLEOMSORG/,'helse'],
  ['Dyr',/\bRASEKATT|\bDYRLEGE|\bDYREKLINIKK|VETERINÆR|\bMUSTI\b|\bDYREBUTIKK/,'dyr'],
  ['Velforening',/\bVEL\b|\bVELFORENING/,'medlemskap'],['Kantine',/\bCOMPASS\b|\bKANTINE|\bSODEXO\b|\bISS FOOD/,'restaurant'],
  ['Vipps',/\bVIPPS\b/,'vipps'],['Kontantuttak',/\bMINIBANK\b|\bKONTANTUTTAK\b|\bATM\b/,'kontanter'],
];
const KEYWORDS=[
  [/\bLÅN\b|\bAVDRAG\b|\bRENTER?\b|\bTERMIN\b/,'laan'],[/\bGEBYR|\bÅRSAVGIFT|\bKORTAVGIFT/,'gebyrer'],
  [/\bFORSIKRING/,'forsikring'],[/\bSTRØM\b|\bNETTLEIE\b|\bKRAFT\b/,'energi'],[/\bKREDITTKORT/,'kort'],
];
const MCC=[
  [[5411,5422,5441,5451,5462,5499,5300],'dagligvarer'],[[5812,5813,5814],'restaurant'],[[5921],'alkohol'],[[4900],'energi'],
  [[4812,4814,4816],'telekom'],[[4899,5815,5816,5817,5818,7372],'abonnement'],[[6300,5960,6381],'forsikring'],[[6010,6011],'kontanter'],
  [[5541,5542,5983,7523,7524,4784,7531,7534,7535,7538,7542,7549,5511,5521,5531,5532,5533,5571,5599],'bil'],
  [[4111,4112,4121,4131,4789],'kollektiv'],[[4411,4511,4582,4722,7011,7012,7512,7513],'reise'],
  [[5912,5975,5976,8011,8021,8031,8041,8042,8043,8044,8049,8050,8062,8071,8099],'helse'],
  [[5611,5621,5631,5641,5651,5661,5681,5691,5697,5698,5699,5931,5948,5137,5139],'klaer'],
  [[5200,5211,5231,5251,5261,5310,5331,5712,5713,5714,5718,5719,5722,5950,5992,1520,1711,1731,1740,1750,1761,1771,7349,7641,7692,780],'hjem'],
  [[5045,5065,5732,5734,5946],'elektronikk'],[[5945,8211,8220,8241,8244,8249,8299],'barn'],[[8351],'barnehage'],
  [[5655,5941,7941,7997,7992],'trening'],[[5733,5735,5942,5994,7832,7841,7911,7922,7929,7932,7933,7991,7994,7996,7998,7999],'underholdning'],
  [[5977,7230,7297,7298],'pleie'],[[5947,8398,8661],'gaver'],[[8641,8651,8699],'medlemskap'],[[9211,9222,9223,9311,9399,9402,9405],'offentlig'],
  [[742,5995],'dyr'],[[4829,6540],'vipps'],
];
const mccMap=new Map(MCC.flatMap(([codes,category])=>codes.map(code=>[code,category])));
function mccCategory(mcc){
  const code=Number(mcc);if(!Number.isInteger(code))return null;
  if(code>=3000&&code<=3999)return 'reise';
  return mccMap.get(code)??null;
}

export function cleanLabel(label=''){
  return String(label).toUpperCase()
    .replace(/^(VISA|VAREKJØP|VAREKJOP|MASTERCARD)\s*,\s*/,' ').replace(/\bVIPPS\s*[:*]\s*/g,' ').replace(/VALUTAKURS:?\s*[\d.,]+/g,' ')
    .replace(/^\s*\*?\d{4}\s+/,' ').replace(/\bKL\.?\s*\d{2}[.:]\d{2}\s*VERSJON\s*\d+\s*AUT\.?\s*\d*,?/g,' ').replace(/\b\d{2}\.\d{2}(\.\d{2,4})?\b/g,' ')
    .replace(/\b(NOK|SEK|DKK|EUR|USD|GBP|CHF|PLN)\s*[\d.,]+/g,' ').replace(/KURS:?\s*[\d.,]+/g,' ')
    .replace(/\b(VAREKJØP|VAREKJOP|KORTKJØP|KJØP|BETALING|BETALT|RESERVERT|TRANSAKSJON|DATO)\b/g,' ')
    .replace(/[^A-ZÆØÅ0-9&+.\- ]/g,' ').replace(/\b\d{5,}\b/g,' ').replace(/\s+/g,' ').trim();
}
export function merchantOf(row){
  const text=cleanLabel(row.label)+' '+cleanLabel(row.text||'');
  for (const [name,pattern,category,chain] of BRANDS) if (pattern.test(text)) return {name,key:'brand:'+name.toLowerCase(),brandCategory:category,chain:chain?name:null};
  // Card text is "merchant, street, postcode": keep the words before the first number.
  const words=cleanLabel(row.label).replace(/^KONTOREGULERING\s*/,'').split(' ').filter(Boolean),cut=words.findIndex((w,i)=>i>0&&/^\d{2,}$/.test(w));
  const name=(cut>0?words.slice(0,Math.min(cut,3)):words.slice(0,3)).join(' ')||'Ukjent';
  return {name:name.charAt(0)+name.slice(1).toLowerCase(),key:row.counterparty?'party:'+row.counterparty.slice(0,16):'label:'+name.toLowerCase(),brandCategory:null,chain:null};
}

export const ROLES={checking:'Brukskonto',joint:'Felleskonto',child:'Barnas konto',savings:'Sparekonto',card:'Kredittkort',loan:'Lån'};

// Every household account with all owners that linked it. An explicit household
// role wins; otherwise the bank's account type, and shared links become joint.
export function householdAccounts(state){
  const result={};
  for (const connection of Object.values(state.connections||{})) for (const link of connection.links||[]) {
    const entry=result[link.key]??={key:link.key,owners:new Set(),bank:connection.bank?.name??null,name:link.name,linkRole:link.role??'checking'};
    entry.owners.add(connection.owner);
  }
  for (const entry of Object.values(result)) {
    entry.owners=[...entry.owners];
    entry.role=state.accountRoles?.[entry.key]?.role??(entry.linkRole==='checking'&&entry.owners.length>1?'joint':entry.linkRole);
    entry.label=state.accountRoles?.[entry.key]?.label??null;
    delete entry.linkRole;
  }
  return result;
}

const ruleMatches=(rule,row)=>(!rule.match.merchantKey||rule.match.merchantKey===row.merchantKey)&&(!rule.match.counterparty||rule.match.counterparty===row.counterparty)&&(!rule.match.account||rule.match.account===row.account)&&(!rule.match.rowId||rule.match.rowId===row.id)&&(rule.match.merchantKey||rule.match.counterparty||rule.match.rowId);

const INTERNAL_TEXT=/\bKONTOREGULERING\b|\bFRA EGEN KONTO\b|OVERFØRING MELLOM EGNE|\bEGEN KONTO\b/;
const nameTokens=value=>String(value||'').toLowerCase().normalize('NFC').split(/[^a-zæøåäöü]+/).filter(t=>t.length>=3);
// A payment to a household member's own name (bank text may drop æøå, leaving
// "Bj rn" or "h nsen") is a transfer inside the household, not consumption.
function householdName(label,names){
  if (/\d/.test(label)) return false;
  const tokens=nameTokens(label);
  if (tokens.length<2) return false;
  const same=(t,n)=>n===t||t.length>=4&&n.endsWith(t);
  // The first name must match too, so a relative sharing a surname is not "us".
  return names.some(name=>same(tokens[0],name[0])&&tokens.filter(t=>name.some(n=>same(t,n))).length>=2);
}
export function classify(state,{names=[]}={}){
  const accounts=householdAccounts(state);
  const keys=new Set(Object.keys(accounts));
  const savingParties=new Set([...Object.values(state.targets||{}),...(state.savingsTargets||[]).map(t=>t.counterparty)]);
  const rows=[];
  for (const key of keys) {
    const account=state.accounts?.[key];if(!account)continue;
    for (const [id,r] of Object.entries(account.rows||{})) {
      const merchant=merchantOf(r);
      rows.push({id,account:key,accountName:accounts[key].label??account.name,date:r.date,month:r.date.slice(0,7),currency:r.currency,minor:r.minor,
        label:r.label,text:r.text??null,purchaseDate:r.purchaseDate??null,counterparty:r.counterparty??null,mcc:r.mcc??null,
        merchant:merchant.name,merchantKey:merchant.key,chain:merchant.chain,brandCategory:merchant.brandCategory});
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  // Internal transfers: counterparty is a household account, or an exact opposite
  // amount on another household account within three days.
  const pair=new Map();
  const credits=rows.filter(r=>r.minor>0);
  for (const debit of rows) {
    if (debit.minor>=0) continue;
    if (debit.counterparty&&keys.has(debit.counterparty)&&debit.counterparty!==debit.account) {
      const match=credits.find(c=>!pair.has(c.id)&&c.account===debit.counterparty&&c.minor===-debit.minor&&Math.abs(Date.parse(c.date)-Date.parse(debit.date))<=4*DAY);
      pair.set(debit.id,{to:debit.counterparty,from:debit.account,match:match?.id??null});if(match)pair.set(match.id,{to:debit.counterparty,from:debit.account,match:debit.id});
      continue;
    }
    const transferish=/OVERF|EGEN KONTO|KREDITTKORT|EUROCARD|INNBETALING|SPARING|BSU|NEDBETAL|TREKK/.test(cleanLabel(debit.label+' '+(debit.text||'')))||!debit.counterparty&&!debit.mcc;
    if (!transferish) continue;
    const match=credits.find(c=>!pair.has(c.id)&&c.account!==debit.account&&c.currency===debit.currency&&c.minor===-debit.minor&&Date.parse(c.date)>=Date.parse(debit.date)-DAY&&Date.parse(c.date)-Date.parse(debit.date)<=3*DAY);
    if (match) {pair.set(debit.id,{to:match.account,from:debit.account,match:match.id});pair.set(match.id,{to:match.account,from:debit.account,match:debit.id});}
  }
  const expenseKeys=new Set(rows.filter(r=>r.minor<0&&r.brandCategory!=='saving'&&!INTERNAL_TEXT.test(cleanLabel(r.label))).map(r=>r.merchantKey));
  const people=[...new Set([...names,...Object.values(accounts).map(a=>state.accounts?.[a.key]?.name??a.name)])].map(nameTokens).filter(t=>t.length>=2);
  // Later rules win: agent rules first, family rules last; a single row beats a merchant.
  const rank=r=>(r.by==='family'?10:0)+(r.match.rowId?2:r.match.counterparty?1:0);
  const rules=(state.rules||[]).filter(r=>r.match&&r.set).sort((a,b)=>rank(a)-rank(b));
  for (const row of rows) {
    const p=pair.get(row.id);
    let kind,category,source;
    if (p) {
      const toSavings=accounts[p.to]?.role==='savings',fromSavings=accounts[p.from]?.role==='savings';
      kind='internal';category=null;source='transfer';
      if (row.minor<0&&toSavings&&!fromSavings) kind='saving';
      if (row.minor>0&&fromSavings&&!toSavings) kind='saving';
    } else if (INTERNAL_TEXT.test(cleanLabel(row.label))||householdName(row.label,people)) {
      kind='internal';category=null;source='household-transfer';
    } else if (row.minor<0&&row.counterparty&&savingParties.has(row.counterparty)||row.brandCategory==='saving'&&row.minor<0) {
      kind='saving';category=null;source=row.brandCategory==='saving'?'brand':'target';
    } else if (row.minor<0) {
      category=row.brandCategory&&row.brandCategory!=='saving'?row.brandCategory:mccCategory(row.mcc);source=category?(row.brandCategory?'brand':'mcc'):null;
      if(!category){const hit=KEYWORDS.find(([pattern])=>pattern.test(cleanLabel(row.label+' '+(row.text||''))));category=hit?.[1]??'annet';source=hit?'keyword':'default';}
      kind='expense';
    } else {
      const text=cleanLabel(row.label+' '+(row.text||''));
      if (row.brandCategory==='saving'||row.counterparty&&savingParties.has(row.counterparty)) {kind='saving';category=null;source='withdrawal';}
      else if (expenseKeys.has(row.merchantKey)&&row.brandCategory!=='vipps') {kind='expense';category=row.brandCategory&&row.brandCategory!=='saving'?row.brandCategory:mccCategory(row.mcc)??'annet';source='refund';}
      else if (/\bL(Ø|O)NN\b|\bSALARY\b|\bFERIEPENGER\b/.test(text)) {kind='income';category='lonn';source='keyword';}
      else if (/\bNAV\b|\bBARNETRYGD\b|\bKONTANTST(Ø|O)TTE\b|\bSKATTEETATEN\b|\bSKATTEOPPGJ/.test(text)) {kind='income';category='trygd';source='keyword';}
      else {kind='income';category='annen-inntekt';source='default';}
    }
    let shared=kind==='expense'?SHARED_DEFAULT.has(category):false,rule=null;
    for (const candidate of rules) if (ruleMatches(candidate,row)) rule=candidate;
    if (rule) {
      if (rule.set.kind) kind=rule.set.kind;
      if (rule.set.category) category=rule.set.category;
      if (typeof rule.set.shared==='boolean') shared=rule.set.shared;
      source='rule:'+rule.id;
    }
    if (kind==='income'&&!INCOME_CATEGORIES.has(category)) category='annen-inntekt';
    if (kind==='expense'&&(!category||INCOME_CATEGORIES.has(category))) category='annet';
    if (kind==='internal'||kind==='saving') category=null;
    Object.assign(row,{kind,category,shared,categorySource:source,transferMatch:p?.match??null});
  }
  // Salary heuristic: large monthly credits from the same counterparty.
  const incomeGroups=group(rows.filter(r=>r.kind==='income'&&r.category==='annen-inntekt'&&r.minor>=500000),r=>r.merchantKey);
  for (const list of incomeGroups.values()) if (new Set(list.map(r=>r.month)).size>=3&&cadence(list)?.name==='månedlig') for (const r of list) if(!r.categorySource?.startsWith('rule:')) {r.category='lonn';r.categorySource='recurring-income';}
  return rows;
}

function group(list,keyOf){const m=new Map();for(const item of list){const k=keyOf(item);if(!m.has(k))m.set(k,[]);m.get(k).push(item);}return m;}
const median=values=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:Math.round((s[m-1]+s[m])/2);};
const addDays=(date,days)=>new Date(Date.parse(date)+days*DAY).toISOString().slice(0,10);

const CADENCES=[['ukentlig',7,2,52],['månedlig',30.4,6,12],['kvartalsvis',91,12,4],['halvårlig',182,20,2],['årlig',365,25,1]];
function cadence(list){
  const dates=[...new Set(list.map(r=>r.date))].sort();
  if (dates.length<2) return null;
  const gaps=dates.slice(1).map((d,i)=>(Date.parse(d)-Date.parse(dates[i]))/DAY);
  const gap=median(gaps);
  for (const [name,days,tolerance,perYear] of CADENCES) {
    if (Math.abs(gap-days)>tolerance) continue;
    const steady=gaps.filter(g=>Math.abs(g-days)<=tolerance*1.6).length/gaps.length;
    const needed=days>=182?1:2;
    if (gaps.length>=needed&&steady>=0.7) return {name,days,perYear};
  }
  return null;
}

export function recurring(rows,today){
  const result=[];
  for (const [key,list] of group(rows.filter(r=>r.minor<0&&(r.kind==='expense'||r.kind==='saving')&&r.currency==='NOK'),r=>r.merchantKey)) {
    const c=cadence(list);if(!c)continue;
    const sorted=[...list].sort((a,b)=>a.date.localeCompare(b.date));
    const amounts=sorted.map(r=>-r.minor),typical=median(amounts.slice(-6)),last=sorted.at(-1);
    if (typical<1000) continue;
    // Rare cadences need similar amounts, otherwise two holiday purchases a year apart look like a subscription.
    if (c.days>=182&&Math.max(...amounts)>Math.min(...amounts)*1.2) continue;
    const prior=amounts.slice(-7,-1),steady=prior.length>=2&&Math.max(...prior)-Math.min(...prior)<=median(prior)*0.05;
    const lastDate=last.date,active=(Date.parse(today)-Date.parse(lastDate))/DAY<=c.days*1.6;
    const previous=median(amounts.slice(-7,-1));
    const change=previous&&amounts.at(-1)-previous;
    result.push({merchantKey:key,merchant:last.merchant,category:last.category,kind:last.kind,cadence:c.name,occurrences:sorted.length,
      typicalMinor:typical,lastMinor:amounts.at(-1),lastDate,firstDate:sorted[0].date,active,nextDate:active?addDays(lastDate,Math.round(c.days)):null,
      annualMinor:typical*c.perYear,priceChangeMinor:steady&&FIXED_PRICE.has(last.category)&&change&&Math.abs(change)>=500&&Math.abs(change)/previous>=0.03?change:0,
      accounts:[...new Set(sorted.map(r=>r.accountName))],rowIds:sorted.slice(-6).map(r=>r.id)});
  }
  return result.sort((a,b)=>b.annualMinor-a.annualMinor);
}

export function coverage(state,owners,today){
  const accounts=householdAccounts(state);
  const list=Object.values(accounts).map(a=>{const s=state.accounts?.[a.key];return {key:a.key,name:a.label??s?.name??a.name,bank:a.bank,role:a.role,owners:a.owners,
    firstDate:s?.firstDate??null,syncedAt:s?.syncedAt??null,difference:s?.difference??null,skipped:s?.skipped??0,stale:!s||Date.parse(today)-Date.parse(s.syncedAt)>36*3600000};});
  const connected=new Set(Object.values(state.connections||{}).map(c=>c.owner));
  const synced=list.filter(a=>a.syncedAt),dated=synced.filter(a=>a.firstDate);
  const fullFrom=list.length&&synced.length===list.length&&dated.length?dated.map(a=>a.firstDate).sort().at(-1):null;
  return {accounts:list,missingOwners:owners.filter(o=>!connected.has(o.id)).map(o=>o.name||o.id),
    expired:Object.values(state.connections||{}).filter(c=>Date.parse(c.expires)<=Date.parse(today)).map(c=>({owner:c.owner,bank:c.bank?.name})),
    expiringSoon:Object.values(state.connections||{}).filter(c=>{const left=Date.parse(c.expires)-Date.parse(today);return left>0&&left<14*DAY;}).map(c=>({owner:c.owner,bank:c.bank?.name,expires:c.expires})),
    fullFrom,complete:!!fullFrom};
}
// A month is fully covered when every account's history starts before it and it has ended.
const covered=(month,cov,today)=>!!cov.fullFrom&&cov.fullFrom<=month+'-01'&&month<today.slice(0,7);

export function monthTotals(rows,month){
  const list=rows.filter(r=>r.month===month&&r.currency==='NOK');
  const byCategory={};
  let expense=0,income=0,saving=0;
  for (const r of list) {
    if (r.kind==='expense') {expense-=r.minor;byCategory[r.category]=(byCategory[r.category]??0)-r.minor;}
    else if (r.kind==='income') {income+=r.minor;}
    else if (r.kind==='saving') saving-=r.minor;
  }
  return {month,expenseMinor:expense,incomeMinor:income,savingMinor:saving,netMinor:income-expense-saving,byCategory,rows:list.length};
}

export function summary(rows,month,cov,today){
  const months=[...new Set(rows.map(r=>r.month))].sort();
  const current=monthTotals(rows,month);
  const prior=months.filter(m=>m<month&&covered(m,cov,today));
  const history=prior.slice(-12).map(m=>monthTotals(rows,m));
  const categories=Object.keys(CATEGORIES).filter(c=>!INCOME_CATEGORIES.has(c)).map(c=>{
    const amounts=history.map(h=>h.byCategory[c]??0);
    return {key:c,label:CATEGORIES[c],minor:current.byCategory[c]??0,median3:median(amounts.slice(-3)),median12:median(amounts)};
  }).filter(c=>c.minor||c.median12).sort((a,b)=>b.minor-a.minor||b.median12-a.median12);
  return {...current,covered:covered(month,cov,today),partial:month>=today.slice(0,7),categories,
    trend:months.slice(-13).map(m=>({...monthTotals(rows,m),byCategory:undefined,covered:covered(m,cov,today)}))};
}

export function groceries(rows,today){
  const since=d=>addDays(today,-d);
  const window=days=>{const totals={};let all=0;for(const r of rows)if(r.kind==='expense'&&r.category==='dagligvarer'&&r.currency==='NOK'&&r.date>=since(days)){const chain=r.chain??'Andre';totals[chain]=(totals[chain]??0)-r.minor;all-=r.minor;}
    return {days,totalMinor:all,chains:Object.entries(totals).map(([chain,minor])=>({chain,minor,share:all?Math.round(minor/all*1000)/1000:0})).sort((a,b)=>b.minor-a.minor)};};
  const year=window(365),quarter=window(90);
  const oda=year.chains.find(c=>c.chain==='Oda');
  return {quarter,year,odaShareEstimate:year.totalMinor>0&&oda?Math.round(oda.minor/year.totalMinor*100)/100:null};
}

export function savings(rows,month,goalNok){
  const list=rows.filter(r=>r.kind==='saving'&&r.month===month&&r.currency==='NOK');
  const byTarget={};
  for (const r of list) byTarget[r.merchant]=(byTarget[r.merchant]??0)-r.minor;
  const total=list.reduce((n,r)=>n-r.minor,0);
  return {month,totalMinor:total,goalMinor:goalNok!=null?goalNok*100:null,targets:Object.entries(byTarget).map(([name,minor])=>({name,minor}))};
}

export function settlement(rows,month,state,owners){
  if (owners.length<2) return null;
  const accounts=householdAccounts(state);
  const paid=Object.fromEntries(owners.map(o=>[o.id,0]));
  let joint=0;
  for (const r of rows) {
    if (r.month!==month||r.kind!=='expense'||!r.shared||r.currency!=='NOK') continue;
    const a=accounts[r.account];
    if (a?.role==='child') continue;
    if (a?.owners.length===1&&paid[a.owners[0]]!==undefined&&a.role!=='joint') paid[a.owners[0]]-=r.minor;else joint-=r.minor;
  }
  const total=Object.values(paid).reduce((a,b)=>a+b,0),fair=Math.round(total/owners.length);
  return {month,jointMinor:joint,totalPersonalMinor:total,people:owners.map(o=>({id:o.id,name:o.name||o.id,paidMinor:paid[o.id],balanceMinor:paid[o.id]-fair}))};
}

export function forecast(rows,state,recurringList,today,days=60){
  const accounts=householdAccounts(state);
  const liquid=Object.values(accounts).filter(a=>['checking','joint'].includes(a.role));
  const start=liquid.reduce((n,a)=>{const b=state.accounts?.[a.key]?.balance;return n+(b?.currency==='NOK'?b.minor:0);},0);
  const end=addDays(today,days),events=[];
  for (const r of recurringList.filter(x=>x.active&&x.kind==='expense')) {
    const step=CADENCES.find(c=>c[0]===r.cadence)[1];
    for (let d=r.nextDate;d&&d<=end;d=addDays(d,Math.round(step))) if (d>today) events.push({date:d,minor:-r.typicalMinor,label:r.merchant,kind:'recurring'});
  }
  for (const [,list] of group(rows.filter(r=>r.kind==='income'&&r.category==='lonn'&&r.currency==='NOK'),r=>r.merchantKey)) {
    const c=cadence(list);if(c?.name!=='månedlig')continue;
    const last=list.map(r=>r.date).sort().at(-1),typical=median(list.slice(-6).map(r=>r.minor));
    for (let d=addDays(last,30);d<=end;d=addDays(d,30)) if (d>today) events.push({date:d,minor:typical,label:list.at(-1).merchant,kind:'income'});
  }
  for (const p of Object.values(state.planned||{})) if (p.date>today&&p.date<=end&&!p.done) events.push({date:p.date,minor:-p.amountMinor,label:p.label,kind:'planned',source:p.source?.kind??null});
  const recurringKeys=new Set(recurringList.map(r=>r.merchantKey));
  const variable=rows.filter(r=>r.kind==='expense'&&r.currency==='NOK'&&r.date>addDays(today,-90)&&r.date<=today&&!recurringKeys.has(r.merchantKey)).reduce((n,r)=>n-r.minor,0);
  const dailyVariable=Math.round(variable/90);
  events.sort((a,b)=>a.date.localeCompare(b.date));
  let balance=start,low={date:today,minor:start};const points=[];
  for (let i=1;i<=days;i++) {
    const date=addDays(today,i);balance-=dailyVariable;
    for (const e of events) if (e.date===date) balance+=e.minor;
    if (balance<low.minor) low={date,minor:balance};
    if (i%7===0||i===days) points.push({date,minor:balance});
  }
  return {startMinor:start,dailyVariableMinor:dailyVariable,points,lowest:low,events:events.slice(0,60),accounts:liquid.map(a=>a.label??state.accounts?.[a.key]?.name??a.name)};
}

export function signals(rows,recurringList,summaryInfo,today,cov){
  const list=[];
  for (const r of recurringList.filter(x=>x.active&&x.priceChangeMinor>0)) list.push({key:'price:'+r.merchantKey,kind:'price-increase',title:r.merchant+' har økt prisen',detail:'Siste trekk var '+nok(r.priceChangeMinor)+' høyere enn før ('+r.cadence+').',annualImpactMinor:r.priceChangeMinor*({ukentlig:52,'månedlig':12,kvartalsvis:4,'halvårlig':2,'årlig':1}[r.cadence]),rowIds:r.rowIds.slice(-2)});
  for (const r of recurringList.filter(x=>x.active&&x.cadence==='månedlig'&&Date.parse(today)-Date.parse(x.firstDate)<75*DAY)) list.push({key:'new:'+r.merchantKey,kind:'new-recurring',title:'Nytt fast trekk: '+r.merchant,detail:'Første trekk '+r.firstDate+', '+nok(r.typicalMinor)+' per måned.',annualImpactMinor:r.annualMinor,rowIds:r.rowIds});
  const lastMonth=addDays(today.slice(0,7)+'-01',-1).slice(0,7);
  for (const r of recurringList.filter(x=>x.active&&x.cadence==='månedlig'&&['abonnement','trening','telekom'].includes(x.category))) {
    const hits=rows.filter(x=>x.merchantKey===r.merchantKey&&x.month===lastMonth&&x.minor<0);
    if (hits.length>=2&&new Set(hits.map(h=>h.minor)).size>1) list.push({key:'double-sub:'+r.merchantKey+':'+lastMonth,kind:'duplicate-subscription',title:'Mulig dobbelt abonnement hos '+r.merchant,detail:hits.length+' ulike trekk i '+lastMonth+'.',annualImpactMinor:median(hits.map(h=>-h.minor))*12,rowIds:hits.map(h=>h.id)});
  }
  const recent=rows.filter(r=>r.minor<=-20000&&r.mcc&&r.kind==='expense'&&r.date>=addDays(today,-45));
  for (const [,same] of group(recent,r=>r.merchantKey+'|'+r.minor)) {
    for (let i=1;i<same.length;i++) if (Date.parse(same[i].date)-Date.parse(same[i-1].date)<=DAY) list.push({key:'dup:'+same[i].id,kind:'possible-double-charge',title:'Mulig dobbelttrekk hos '+same[i].merchant,detail:'To like trekk på '+nok(-same[i].minor)+' ('+same[i-1].date+' og '+same[i].date+'). Kan være to ekte kjøp.',annualImpactMinor:0,rowIds:[same[i-1].id,same[i].id]});
  }
  const foreign=rows.filter(r=>r.kind==='expense'&&r.date>=addDays(today,-90)&&(r.currency!=='NOK'||/\b(SEK|DKK|EUR|USD|GBP|CHF|PLN)\b/.test(r.label+' '+(r.text||''))));
  if (foreign.length) list.push({key:'foreign:'+today.slice(0,7),kind:'foreign-currency',title:'Kjøp i utenlandsk valuta',detail:foreign.length+' kjøp siste 90 dager. Sjekk valutapåslag på kortene.',annualImpactMinor:0,rowIds:foreign.slice(-10).map(r=>r.id)});
  const fees=rows.filter(r=>r.kind==='expense'&&r.category==='gebyrer'&&r.date>=addDays(today,-365));
  if (fees.length) list.push({key:'fees:'+today.slice(0,4),kind:'bank-fees',title:'Bankgebyrer siste år',detail:nok(fees.reduce((n,r)=>n-r.minor,0))+' i gebyrer.',annualImpactMinor:fees.reduce((n,r)=>n-r.minor,0),rowIds:fees.slice(-10).map(r=>r.id)});
  for (const c of summaryInfo.categories) if (summaryInfo.covered&&c.median12&&c.minor>c.median12*1.5&&c.minor-c.median12>=100000) list.push({key:'spike:'+c.key+':'+summaryInfo.month,kind:'category-spike',title:c.label+' høyere enn vanlig',detail:nok(c.minor)+' mot vanlig '+nok(c.median12)+' per måned.',annualImpactMinor:0,rowIds:[]});
  const cardBills=rows.filter(r=>r.kind==='expense'&&r.category==='kort'&&r.date>=addDays(today,-90));
  if (cardBills.length) list.push({key:'card:'+today.slice(0,7),kind:'card-not-connected',title:'Kredittkort uten innsyn',detail:'Betaling av kortregning ('+nok(cardBills.reduce((n,r)=>n-r.minor,0))+' siste 90 dager) uten at kortkontoen er koblet til. Koble den til for å se hva pengene gikk til.',annualImpactMinor:0,rowIds:cardBills.slice(-6).map(r=>r.id)});
  if (cov.missingOwners.length) list.push({key:'owners',kind:'coverage',title:'Ikke alle voksne er koblet til',detail:'Mangler: '+cov.missingOwners.join(', ')+'.',annualImpactMinor:0,rowIds:[]});
  return list;
}

const kroneText=value=>Math.round(Number(String(value).replace(/\./g,'').replace(',','.'))*100);
export function loanParts(row){
  const text=row.label+' '+(row.text||'');
  const interest=/RENTER\s+KR\s+([\d.]+,\d{2})/i.exec(text),principal=/AVDRAG\s+KR\s+([\d.]+,\d{2})/i.exec(text),fees=/OMK\.?\s+KR\s+([\d.]+,\d{2})/i.exec(text);
  if (!interest&&!principal) return null;
  return {interestMinor:interest?kroneText(interest[1]):null,principalMinor:principal?kroneText(principal[1]):null,feesMinor:fees?kroneText(fees[1]):null};
}
export function loans(rows,today){
  const list=rows.filter(r=>r.minor<0&&r.date>addDays(today,-365)).map(r=>({row:r,parts:loanParts(r)})).filter(x=>x.parts);
  const sum=key=>list.reduce((n,x)=>n+(x.parts[key]??0),0);
  return {payments:list.length,interestMinor:sum('interestMinor'),principalMinor:sum('principalMinor'),feesMinor:sum('feesMinor'),
    interestOnly:list.length>0&&list.every(x=>x.parts.principalMinor===0),latest:list.at(-1)?{date:list.at(-1).row.date,...list.at(-1).parts,rowId:list.at(-1).row.id}:null};
}
export function taxYear(rows,year){
  const list=rows.filter(r=>r.date.startsWith(String(year))&&r.kind==='expense'&&['gaver','medlemskap','barnehage','laan'].includes(r.category));
  const result={};
  for (const r of list) {const c=result[r.category]??={category:r.category,label:CATEGORIES[r.category],minor:0,merchants:{}};c.minor-=r.minor;c.merchants[r.merchant]=(c.merchants[r.merchant]??0)-r.minor;}
  const interest=rows.filter(r=>r.date.startsWith(String(year))&&r.minor<0).map(loanParts).filter(Boolean).reduce((n,p)=>n+(p.interestMinor??0),0);
  return {year,loanInterestMinor:interest,categories:Object.values(result).map(c=>({...c,merchants:Object.entries(c.merchants).map(([name,minor])=>({name,minor})).sort((a,b)=>b.minor-a.minor).slice(0,12)}))};
}

// A suggestion is realized only by later actual bank rows: a lower amount from the
// same merchant, or no charge for longer than its cadence.
export function realize(suggestion,rows,today){
  const base=suggestion.baseline;
  if (!base?.merchantKey||suggestion.status!=='accepted') return null;
  const after=rows.filter(r=>r.merchantKey===base.merchantKey&&r.minor<0&&r.date>suggestion.acceptedAt.slice(0,10)).sort((a,b)=>a.date.localeCompare(b.date));
  const cycle=CADENCES.find(c=>c[0]===base.cadence)??CADENCES[1];
  if (after.length) {
    const latest=after.at(-1),lower=base.amountMinor-(-latest.minor);
    if (lower>0) return {kind:'lower',rowId:latest.id,date:latest.date,amountMinor:-latest.minor,annualSavingsMinor:lower*cycle[3]};
    return null;
  }
  const since=(Date.parse(today)-Date.parse(suggestion.acceptedAt))/DAY;
  if (since>cycle[1]*1.6) return {kind:'stopped',rowId:null,date:today,amountMinor:0,annualSavingsMinor:base.amountMinor*cycle[3]};
  return null;
}

export function paymentMatch(proposal,rows){
  if (proposal.status!=='open'&&proposal.status!=='approved') return null;
  const name=cleanLabel(proposal.payee.name).split(' ')[0];
  return rows.find(r=>r.minor===-proposal.amountMinor&&r.date>=proposal.createdAt.slice(0,10)&&(!name||cleanLabel(r.label+' '+(r.text||'')).includes(name)))??null;
}

export function fingerprint(value){return sha(JSON.stringify(value)).slice(0,24);}
