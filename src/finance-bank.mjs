import {createHash, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const day = 86400000;
export const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function bankingClient(owner, transport = fetch) {
  return async (path, body) => {
    const now = Math.floor(Date.now()/1000);
    const header = encode({typ:'JWT', alg:'RS256', kid:owner.applicationId});
    const claims = encode({iss:'enablebanking.com', aud:'api.enablebanking.com', iat:now, exp:now+120});
    const content = header+'.'+claims;
    const signature = sign('RSA-SHA256', Buffer.from(content), readFileSync(owner.privateKeyFile)).toString('base64url');
    const response = await transport('https://api.enablebanking.com'+path, {
      method:body ? 'POST' : 'GET', redirect:'error', signal:AbortSignal.timeout(45000),
      headers:{Authorization:'Bearer '+content+'.'+signature, 'Content-Type':'application/json'},
      body:body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw Error('Enable Banking svarte HTTP '+response.status);
    return response.json();
  };
}

export async function startConsent(api, redirectUrl, state) {
  const {aspsps} = await api('/aspsps?country=NO&psu_type=personal');
  const bank = aspsps.find(b=>b.name==='DNB' && b.country==='NO');
  if (!bank || !(bank.maximum_consent_validity>60)) throw Error('Fant ikke lesetilgang til DNB privat.');
  const result = await api('/auth', {access:{valid_until:new Date(Date.now()+1000*(Math.min(bank.maximum_consent_validity,180*86400)-60)).toISOString()},
    aspsp:{name:bank.name,country:'NO'}, psu_type:'personal',redirect_url:redirectUrl,state});
  const url = new URL(result.url);
  if (url.protocol!=='https:') throw Error('Ugyldig adresse fra banken.');
  return url.href;
}

export function accountLinks(session) {
  if (session.aspsp?.name!=='DNB' || session.aspsp.country!=='NO' || session.psu_type!=='personal' ||
      !(Date.parse(session.access?.valid_until)>Date.now()) || !session.accounts?.length) throw Error('Ingen gyldig privat DNB-konto.');
  return session.accounts.map(a=>{
    const stable = a.account_id?.iban || a.identification_hash;
    if (!a.uid || !stable) throw Error('Mangler stabil kontoidentitet.');
    return {key:hash(stable), uid:a.uid, name:a.name||a.product||'DNB-konto'};
  });
}

function amount(raw) {
  const v=String(raw??'');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw Error('Ukjent beløpsformat.');
  const [kr,ore='']=v.split('.');
  const n=Number(kr)*100+Number(ore.padEnd(2,'0'));
  if (!Number.isSafeInteger(n)) throw Error('Beløpet er utenfor støttet område.');
  return n;
}

function bookedRow(t) {
  const credit=t.credit_debit_indicator==='CRDT';
  if (!credit && t.credit_debit_indicator!=='DBIT') throw Error('Ukjent retning på postering.');
  const date=t.booking_date, currency=t.transaction_amount?.currency;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !currency) throw Error('Mangler bokføringsdato eller valuta.');
  const party=credit?t.debtor:t.creditor, account=credit?t.debtor_account:t.creditor_account;
  const reference=account?.iban || account?.other?.identification;
  const label=party?.name || (t.remittance_information||[]).join(' ') || t.bank_transaction_code?.description || 'Ukjent mottaker';
  return {date,currency,minor:amount(t.transaction_amount.amount)*(credit?1:-1),label,
    counterparty:reference?hash(reference):!credit&&/\bnordnet\b/i.test(label)?hash('label:'+label):null, mcc:t.merchant_category_code||null};
}

export async function readAccount(api, link, previous, now=new Date()) {
  const base='/accounts/'+encodeURIComponent(link.uid);
  const from=previous?.syncedAt ? new Date(Date.parse(previous.syncedAt)-31*day).toISOString().slice(0,10) : null;
  const query=new URLSearchParams({transaction_status:'BOOK'});
  if (from) query.set('date_from',from); else query.set('strategy','longest');
  const seen=new Set(), counts=new Map(), incoming={};
  for (;;) {
    const page=await api(base+'/transactions?'+query);
    if (!Array.isArray(page.transactions)) throw Error('Ufullstendig transaksjonsliste.');
    for (const t of page.transactions) {
      if (t.status && t.status!=='BOOK') continue;
      const row=bookedRow(t);
      let id;
      if (t.entry_reference) id=hash('entry:'+t.entry_reference);
      else {
        const key=hash(JSON.stringify(row));
        const count=(counts.get(key)||0)+1;
        counts.set(key,count); id=key+':'+count;
      }
      incoming[id]=row;
    }
    if (!page.continuation_key) break;
    if (seen.has(page.continuation_key)) throw Error('Gjentatt side i transaksjonslisten.');
    seen.add(page.continuation_key); query.set('continuation_key',page.continuation_key);
  }
  const {balances}=await api(base+'/balances');
  if (!Array.isArray(balances)||!balances.length) throw Error('Banken leverte ingen saldo.');
  // A booked day can have several identical purchases without a bank reference.
  // Replace that day's anonymous rows only after all pages were delivered.
  const suppliedDates=new Set(Object.values(incoming).map(row=>row.date));
  const retained=Object.entries(previous?.rows||{}).filter(([id,row])=>!id.includes(':') || !suppliedDates.has(row.date));
  const rows={...Object.fromEntries(retained),...incoming};
  const booked=balances.find(b=>b.balance_type==='ITBD')||balances.find(b=>b.balance_type==='CLBD');
  const balance=booked||balances[0];
  const currency=balance.balance_amount.currency;
  const v=String(balance.balance_amount.amount);
  const minor=amount(v.replace(/^-/u,''))*(v.startsWith('-')?-1:1);
  const total=Object.values(rows).reduce((s,r)=>s+(r.currency===currency?r.minor:0),0);
  const old=previous?.balance;
  const comparable=booked && old?.type===balance.balance_type && old.currency===currency && Number.isSafeInteger(previous.total);
  const difference=comparable ? minor-old.minor-(total-previous.total) : null;
  return {name:link.name,rows,balance:{minor,currency,type:balance.balance_type},total,difference,
    syncedAt:now.toISOString(),firstDate:Object.values(rows).map(r=>r.date).sort()[0]||null};
}
