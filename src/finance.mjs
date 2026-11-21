import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {encrypt,readEncrypted,loadKey} from './crypto.mjs';
import {configPath} from './config.mjs';
import {accountLinks,bankingClient,day,readAccount,startConsent} from './finance-bank.mjs';

const settings=()=>{
  const file=configPath('finance.json');
  if (!existsSync(file)) return null;
  const cfg=JSON.parse(readFileSync(file,'utf8'));
  return cfg.enabled===true?cfg:null;
};
export function createFinance({dataDir, config=settings, client=bankingClient, keyProvider=loadKey}) {
  const path=join(dataDir,'finance.enc');
  let state,key,busy=false;
  const pending=new Map();
  function load() {
    if (!state) {
      key=keyProvider(dataDir);
      state=existsSync(path)?JSON.parse(readEncrypted(path,key)):{owners:{},accounts:{},targets:{}};
    }
    return state;
  }
  function save(next) {
    const tmp=path+'.new';
    writeFileSync(tmp,encrypt(Buffer.from(JSON.stringify(next)),key),{mode:0o600});
    renameSync(tmp,path); state=next;
  }
  async function exclusive(action) {
    if (busy) throw Error('En bankoppdatering pågår. Prøv igjen om litt.');
    busy=true;
    try {return await action();} finally {busy=false;}
  }
  function configuredOwners(cfg) {
    const owners=cfg?.owners||[];
    const devices=owners.map(o=>o.deviceId), ids=owners.map(o=>o.id);
    if (new Set(devices).size!==devices.length || new Set(ids).size!==ids.length ||
        owners.some(o=>!o.deviceId || !/^[a-z0-9-]{1,64}$/.test(o.id)||Object.hasOwn(Object.prototype,o.id))) throw Error('Kontroller voksenoppsettet.');
    return owners;
  }
  async function syncOwner(owner, force=false) {
    const current=load(), connection=current.owners[owner.id];
    if (!connection || Date.parse(connection.expires)<=Date.now()) return;
    if (!force && connection.attempt && Date.now()-Date.parse(connection.attempt)<(connection.issue?3600000:day)) return;
    const next=structuredClone(current), info=next.owners[owner.id];
    info.attempt=new Date().toISOString();
    const api=client(owner);
    const errors=[];
    for (const link of info.links) {
      try { next.accounts[link.key]=await readAccount(api,link,current.accounts[link.key]); }
      catch (err) {
        errors.push(link.name+': '+safeError(err));
      }
    }
    info.issue=errors.join(' · ')||null;
    save(next);
  }
  function safeError(error) {
    if (/^(Enable Banking svarte HTTP \d{3}|Gjentatt side i transaksjonslisten\.|Ufullstendig transaksjonsliste\.|Banken leverte ingen saldo\.)$/.test(error.message)) return error.message;
    return 'Kunne ikke fullføre banklesingen. Siste vellykkede data er beholdt.';
  }
  async function tick(){
    if (busy) return;
    const cfg=config();
    if (cfg) await exclusive(async()=>{for (const o of configuredOwners(cfg)) await syncOwner(o);});
  }
  function view(cfg, owner, month) {
    const s=load(), owners=configuredOwners(cfg);
    const active=new Set(owners.flatMap(o=>s.owners[o.id]?.links.map(l=>l.key)||[]));
    const accounts=Array.from(active).filter(k=>s.accounts[k]).map(k=>{
      const {rows,...rest}=s.accounts[k];
      return {key:k,own:!!s.owners[owner.id]?.links.some(l=>l.key===k),rule:!!s.targets[k],...rest,rows:Object.entries(rows).filter(([,r])=>r.date.startsWith(month)).map(([id,r])=>({
        id,date:r.date,currency:r.currency,minor:r.minor,label:r.label,
        canMark:r.minor<0&&!!r.counterparty, saving:r.minor<0&&!!r.counterparty&&s.targets[k]===r.counterparty
      })).sort((a,b)=>b.date.localeCompare(a.date))};
    });
    const saved=accounts.flatMap(a=>a.rows).filter(r=>r.saving&&r.currency==='NOK').reduce((n,r)=>n-r.minor,0);
    const connections=owners.map(o=>{
      const c=s.owners[o.id];return {name:o.name||o.id,me:o.id===owner.id,expires:c?.expires||null,issue:c?.issue||null,attempt:c?.attempt||null};
    });
    return {accounts,connections,saved,hasRule:Array.from(active).some(k=>!!s.targets[k]),goal:cfg.monthlySavingsNok??null};
  }
  async function route({device,path,req,res,send,json}) {
    const cfg=config(), owner=configuredOwners(cfg).find(o=>o.deviceId===device.id);
    if (!owner) return send(res,403,{error:'Økonomi krever en godkjent voksentelefon.',deviceId:device.id});
    if (path==='/send/api/finance'&&req.method==='GET') {
      const month=new URL(req.url,'http://local').searchParams.get('month');
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return send(res,400,{error:'Velg måned.'});
      return send(res,200,view(cfg,owner,month));
    }
    if (req.method!=='POST') return send(res,405,{error:'Ugyldig metode.'});
    const input=await json(req);
    try {
      const result=await exclusive(async()=>{
        if (path==='/send/api/finance/connect') {
          const redirect=new URL(cfg.redirectUrl);
          if (redirect.protocol!=='https:' || redirect.pathname!=='/send/finance/' || redirect.search || redirect.hash) throw Error();
          const token=randomUUID();
          const url=await startConsent(client(owner),redirect.href,token);
          pending.set(device.id,{token,until:Date.now()+15*60000});return {url};
        }
        if (path==='/send/api/finance/confirm') {
          const p=pending.get(device.id);
          if (!p||p.until<Date.now()||p.token!==input.state||typeof input.code!=='string'||!input.code) throw Error();
          pending.delete(device.id);
          const session=await client(owner)('/sessions',{code:input.code});
          const links=accountLinks(session);
          const next=structuredClone(load());
          next.owners[owner.id]={expires:session.access.valid_until,links};save(next);
          await syncOwner(owner,true);return {saved:true};
        }
        if (path==='/send/api/finance/target') {
          const next=structuredClone(load());
          const owned=next.owners[owner.id]?.links.some(l=>l.key===input.account);
          if (!owned) throw Error();
          if (input.clear===true) delete next.targets[input.account];
          else {
            const row=next.accounts[input.account]?.rows[input.id];
            if (!row?.counterparty || row.minor>=0) throw Error();
            next.targets[input.account]=row.counterparty;
          }
          save(next);return {saved:true};
        }
        throw Error();
      });
      return send(res,200,result);
    } catch(error) {return send(res,422,{error:safeError(error)});}
  }
  return {route,tick};
}
