import {createHash, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const day = 86400000;
export const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

export function bankingClient(owner, transport = fetch) {
  return async (path, body, method) => {
    const now = Math.floor(Date.now()/1000);
    const header = encode({typ:'JWT', alg:'RS256', kid:owner.applicationId});
    const claims = encode({iss:'enablebanking.com', aud:'api.enablebanking.com', iat:now, exp:now+120});
    const content = header+'.'+claims;
    const signature = sign('RSA-SHA256', Buffer.from(content), readFileSync(owner.privateKeyFile)).toString('base64url');
    const response = await transport('https://api.enablebanking.com'+path, {
      method:method || (body ? 'POST' : 'GET'), redirect:'error', signal:AbortSignal.timeout(45000),
      headers:{Authorization:'Bearer '+content+'.'+signature, 'Content-Type':'application/json'},
      body:body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) throw Error('Enable Banking svarte HTTP '+response.status);
    return response.status===204 ? {} : response.json();
  };
}

// Banks the owner's application can reach for private customers in Norway.
export async function listBanks(api) {
  const {aspsps} = await api('/aspsps?country=NO&psu_type=personal');
  if (!Array.isArray(aspsps)) throw Error('Ufullstendig bankliste.');
  return aspsps.filter(b=>b?.country==='NO' && typeof b.name==='string' && b.maximum_consent_validity>60)
    .map(b=>({name:b.name,country:'NO',maximumConsentSeconds:b.maximum_consent_validity}))
    .sort((a,b)=>a.name.localeCompare(b.name,'nb'));
}

export async function startConsent(api, redirectUrl, state, bankName='DNB') {
  const bank = (await listBanks(api)).find(b=>b.name===bankName);
  if (!bank) throw Error('Fant ikke lesetilgang til valgt bank.');
  const result = await api('/auth', {access:{valid_until:new Date(Date.now()+1000*(Math.min(bank.maximumConsentSeconds,180*86400)-60)).toISOString()},
    aspsp:{name:bank.name,country:'NO'}, psu_type:'personal',redirect_url:redirectUrl,state});
  const url = new URL(result.url);
  if (url.protocol!=='https:') throw Error('Ugyldig adresse fra banken.');
  return url.href;
}

const ROLE_BY_TYPE = {CACC:'checking', TRAN:'checking', SVGS:'savings', CARD:'card', LOAN:'loan', MOMA:'savings'};
export function guessRole(account) {
  const text = [account.name, account.product, account.details].filter(Boolean).join(' ');
  if (ROLE_BY_TYPE[account.cash_account_type]) return ROLE_BY_TYPE[account.cash_account_type];
  if (/kreditt|mastercard|visa|kort/i.test(text)) return 'card';
  if (/spar|bsu|høyrente|buffer|plassering/i.test(text)) return 'savings';
  if (/lån|loan/i.test(text)) return 'loan';
  return 'checking';
}

export function accountLinks(session, bankName) {
  if (!session.aspsp?.name || (bankName && session.aspsp.name!==bankName) || session.aspsp.country!=='NO' || session.psu_type!=='personal' ||
      !(Date.parse(session.access?.valid_until)>Date.now()) || !session.accounts?.length) throw Error('Ingen gyldig privat bankkonto.');
  return session.accounts.map(a=>{
    const stable = a.account_id?.iban || a.identification_hash;
    if (!a.uid || !stable) throw Error('Mangler stabil kontoidentitet.');
    const digits=String(a.account_id?.iban||a.account_id?.other?.identification||'').replace(/\D/g,'');
    const name=[a.product,a.name].filter(Boolean).join(' · ')||session.aspsp.name+'-konto';
    return {key:hash(stable), uid:a.uid, name:digits.length>=4?name+' …'+digits.slice(-4):name, role:guessRole(a)};
  });
}

// Banks normally send a positive amount with a direction, but some send signed amounts.
export function amount(raw) {
  const v=String(raw??'').trim().replace(/^-/,'');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) throw Error('Ukjent beløpsformat.');
  const [kr,ore='']=v.split('.');
  const n=Number(kr)*100+Number(ore.padEnd(2,'0'));
  if (!Number.isSafeInteger(n)) throw Error('Beløpet er utenfor støttet område.');
  return n;
}

export function bookedRow(t) {
  const credit=t.credit_debit_indicator==='CRDT';
  if (!credit && t.credit_debit_indicator!=='DBIT') throw Error('Ukjent retning på postering.');
  const date=t.booking_date, currency=t.transaction_amount?.currency;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !currency) throw Error('Mangler bokføringsdato eller valuta.');
  const party=credit?t.debtor:t.creditor, account=credit?t.debtor_account:t.creditor_account;
  const reference=account?.iban || account?.other?.identification;
  const remittance=(t.remittance_information||[]).filter(x=>typeof x==='string').join(' ').replace(/\s+/g,' ').trim();
  const label=party?.name || remittance || t.bank_transaction_code?.description || 'Ukjent mottaker';
  // The identity fields below are kept exactly as in the first release, so the
  // anonymous row IDs of already stored history remain stable.
  const row={date,currency,minor:amount(t.transaction_amount.amount)*(credit?1:-1),label,
    counterparty:reference?hash(reference):!credit&&/\bnordnet\b/i.test(label)?hash('label:'+label):null, mcc:t.merchant_category_code||null};
  const extra={};
  if (remittance && remittance!==label) extra.text=remittance.slice(0,300);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t.transaction_date||'') && t.transaction_date!==date) extra.purchaseDate=t.transaction_date;
  if (t.bank_transaction_code?.description && t.bank_transaction_code.description!==label) extra.code=String(t.bank_transaction_code.description).slice(0,80);
  return {row,extra};
}

export async function readAccount(api, link, previous, now=new Date()) {
  const base='/accounts/'+encodeURIComponent(link.uid);
  const from=previous?.syncedAt ? new Date(Date.parse(previous.syncedAt)-31*day).toISOString().slice(0,10) : null;
  const query=new URLSearchParams({transaction_status:'BOOK'});
  if (from) query.set('date_from',from); else query.set('strategy','longest');
  const seen=new Set(), counts=new Map(), incoming={};
  let skipped=0;
  for (;;) {
    const page=await api(base+'/transactions?'+query);
    if (!Array.isArray(page.transactions)) throw Error('Ufullstendig transaksjonsliste.');
    for (const t of page.transactions) {
      if (t.status && t.status!=='BOOK') continue;
      let parsed;
      // One unreadable row must not hide the rest of the account; the balance
      // reconciliation below still reveals the gap.
      try {parsed=bookedRow(t);} catch {skipped++;continue;}
      const {row,extra}=parsed;
      let id;
      if (t.entry_reference) id=hash('entry:'+t.entry_reference);
      else {
        const key=hash(JSON.stringify(row));
        const count=(counts.get(key)||0)+1;
        counts.set(key,count); id=key+':'+count;
      }
      incoming[id]={...row,...extra};
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
  const minor=amount(v)*(v.trim().startsWith('-')?-1:1);
  const total=Object.values(rows).reduce((s,r)=>s+(r.currency===currency?r.minor:0),0);
  const old=previous?.balance;
  const comparable=booked && old?.type===balance.balance_type && old.currency===currency && Number.isSafeInteger(previous.total);
  const difference=comparable ? minor-old.minor-(total-previous.total) : null;
  return {name:link.name,rows,balance:{minor,currency,type:balance.balance_type},total,difference,skipped,
    syncedAt:now.toISOString(),firstDate:Object.values(rows).map(r=>r.date).sort()[0]||null};
}
