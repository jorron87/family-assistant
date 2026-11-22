import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createFinance,migrate} from '../src/finance.mjs';
import {hash,readAccount} from '../src/finance-bank.mjs';
import {classify,recurring,settlement} from '../src/finance-analysis.mjs';
import {createFinanceSessions,hashPin} from '../src/finance-access.mjs';
import {encrypt} from '../src/crypto.mjs';

const DAY=86400000;
const daysAgo=n=>new Date(Date.now()-n*DAY).toISOString().slice(0,10);
const row=(amount,ref,extra={})=>({booking_date:'2026-01-12',entry_reference:ref,transaction_amount:{currency:'NOK',amount},
  credit_debit_indicator:'DBIT',status:'BOOK',creditor:{name:'Test merchant'},creditor_account:{iban:'fixture-destination'},...extra});

test('all pages, two real identical purchases, overlapping windows and booked balance',async()=>{
  let nextDay=false,fail=false;
  const api=async path=>{
    if(path.endsWith('/balances'))return {balances:[{balance_type:'ITBD',balance_amount:{amount:nextDay?'96.00':'100.00',currency:'NOK'}}]};
    if(path.includes('continuation_key=')){if(fail)throw Error('Enable Banking svarte HTTP 503');return {transactions:[row('5.00'),row('5.00'),...(nextDay?[row('4.00','next')]:[])]};}
    assert.ok(path.includes('transaction_status=BOOK'));
    return {transactions:[row('3.25','first')],continuation_key:'next-page'};
  };
  const link={uid:'source',name:'test'};
  const first=await readAccount(api,link);
  assert.equal(Object.keys(first.rows).length,3);assert.equal(first.difference,null);
  nextDay=true;
  const next=await readAccount(api,link,first);
  assert.equal(Object.keys(next.rows).length,4);assert.equal(next.difference,0);
  fail=true;
  await assert.rejects(()=>readAccount(api,link,next),/503/);
});

test('a signed amount is read by direction and one unreadable row does not hide the account',async()=>{
  const api=async path=>path.endsWith('/balances')?{balances:[{balance_type:'ITBD',balance_amount:{amount:'-10.00',currency:'NOK'}}]}:
    {transactions:[row('-10.00','a'),{...row('1.00','b'),credit_debit_indicator:'????'}]};
  const result=await readAccount(api,{uid:'u',name:'n'});
  assert.equal(Object.values(result.rows)[0].minor,-1000);
  assert.equal(result.skipped,1);
  assert.equal(result.balance.minor,-1000);
});

test('the first release state migrates without losing accounts or savings targets',()=>{
  const old={owners:{'adult-a':{expires:'2099-01-01T00:00:00Z',links:[{key:'k1',uid:'u1',name:'Brukskonto'},{key:'k2',uid:'u2',name:'BSU'}],attempt:'2026-01-01T00:00:00Z',issue:null}},
    accounts:{k1:{name:'Brukskonto',rows:{}}},targets:{k1:'nordnet'}};
  const state=migrate(old);
  assert.equal(state.version,2);assert.equal(state.owners,undefined);
  assert.deepEqual(Object.keys(state.connections),['adult-a:dnb']);
  assert.equal(state.connections['adult-a:dnb'].links[1].role,'savings');
  assert.equal(state.targets.k1,'nordnet');assert.ok(state.accounts.k1);
  assert.deepEqual(state.suggestions,{});
});

function household(){
  const conn=(owner,links)=>({owner,bank:{name:'DNB',country:'NO'},expires:'2099-01-01T00:00:00Z',links});
  const rows={};
  const add=(acc,id,date,minor,label,extra={})=>{(rows[acc]??={})[id]={date,currency:'NOK',minor,label,counterparty:null,mcc:null,...extra};};
  for (let m=0;m<6;m++) {
    add('a1','net'+m,daysAgo(5+m*30),m===0?-14900:-12900,'NETFLIX.COM',{mcc:'4899'});
    add('a1','rema'+m,daysAgo(3+m*30),-85000,'REMA 1000 SENTRUM',{mcc:'5411'});
    add('b1','kiwi'+m,daysAgo(4+m*30),-45000,'KIWI 123',{mcc:'5411'});
    add('a1','save'+m,daysAgo(8+m*30),-200000,'Overføring',{});
    add('a2','save-in'+m,daysAgo(8+m*30),200000,'Overføring',{});
  }
  add('a1','refund',daysAgo(2),20000,'REMA 1000 SENTRUM',{});
  return {version:2,connections:{'a:dnb':conn('a',[{key:'a1',uid:'1',name:'Brukskonto',role:'checking'},{key:'a2',uid:'2',name:'Sparekonto',role:'savings'}]),'b:dnb':conn('b',[{key:'b1',uid:'3',name:'Konto B',role:'checking'}])},
    accounts:Object.fromEntries(Object.entries(rows).map(([k,r])=>[k,{name:k,rows:r,syncedAt:new Date().toISOString(),firstDate:daysAgo(200),balance:{minor:500000,currency:'NOK',type:'ITBD'},total:0}])),
    rules:[],accountRoles:{},targets:{},savingsTargets:[],planned:{}};
}

test('analysis separates transfers, savings, refunds, recurring price changes and the adults’ shared costs',()=>{
  const state=household(),rows=classify(state);
  const kind=id=>rows.find(r=>r.id===id);
  assert.equal(kind('save0').kind,'saving');assert.equal(kind('save-in0').kind,'internal');
  assert.equal(kind('rema0').category,'dagligvarer');assert.equal(kind('rema0').chain,'REMA 1000');
  assert.equal(kind('refund').kind,'expense');assert.equal(kind('refund').category,'dagligvarer');
  assert.equal(kind('net0').category,'abonnement');
  const fixed=recurring(rows,daysAgo(0));
  const netflix=fixed.find(r=>r.merchant==='Netflix');
  assert.equal(netflix.cadence,'månedlig');assert.equal(netflix.priceChangeMinor,2000);
  assert.ok(!fixed.some(r=>r.kind==='internal'));
  const month=daysAgo(3).slice(0,7);
  const split=settlement(rows,month,state,[{id:'a',name:'A'},{id:'b',name:'B'}]);
  assert.ok(split.people.find(p=>p.id==='a').balanceMinor>0);
  state.rules=[{id:'x',match:{merchantKey:kind('rema0').merchantKey},set:{category:'annet'},by:'family'},{id:'y',match:{merchantKey:kind('rema0').merchantKey},set:{category:'restaurant'},by:'agent'}];
  assert.equal(classify(state).find(r=>r.id==='rema0').category,'annet');
});

function harness({agentEnabled=true}={}){
  const dataDir=mkdtempSync(join(tmpdir(),'finance-test-'));
  const key=randomBytes(32),privateKeyFile=join(dataDir,'mock-signing-key');writeFileSync(privateKeyFile,'mock');
  const cfg={redirectUrl:'https://family.example/send/finance/',agent:{enabled:agentEnabled},owners:[
    {id:'adult-a',name:'A',deviceId:'first',applicationId:'00000000-0000-4000-8000-000000000001',privateKeyFile,pinHash:hashPin('246810')},
    {id:'adult-b',name:'B',deviceId:'second',applicationId:'00000000-0000-4000-8000-000000000002',privateKeyFile}]};
  let gate=null;
  const expires=new Date(Date.now()+86400000).toISOString();
  const api=async(path,input)=>{
    if(path.startsWith('/aspsps?'))return {aspsps:[{name:'DNB',country:'NO',maximum_consent_validity:86400},{name:'Sbanken',country:'NO',maximum_consent_validity:86400}]};
    if(path==='/auth')return {url:'https://bank.example/?state='+input.state};
    if(path==='/sessions')return {session_id:'sess-'+input.code,aspsp:{name:input.code==='sb'?'Sbanken':'DNB',country:'NO'},psu_type:'personal',access:{valid_until:expires},
      accounts:[{identification_hash:'acc-'+input.code,uid:'uid-'+input.code,name:'Konto '+input.code,cash_account_type:'CACC'}]};
    if(path.endsWith('/balances'))return {balances:[{balance_type:'ITBD',balance_amount:{amount:'100.00',currency:'NOK'}}]};
    if(path.includes('/transactions')){if(gate)await gate;return {transactions:[
      {booking_date:daysAgo(10),entry_reference:'e1',transaction_amount:{currency:'NOK',amount:'129.00'},credit_debit_indicator:'DBIT',creditor:{name:'NETFLIX.COM'},merchant_category_code:'4899'},
      {booking_date:daysAgo(40),entry_reference:'e2',transaction_amount:{currency:'NOK',amount:'129.00'},credit_debit_indicator:'DBIT',creditor:{name:'NETFLIX.COM'},merchant_category_code:'4899'},
      {booking_date:daysAgo(70),entry_reference:'e3',transaction_amount:{currency:'NOK',amount:'129.00'},credit_debit_indicator:'DBIT',creditor:{name:'NETFLIX.COM'},merchant_category_code:'4899'},
      {booking_date:daysAgo(12),entry_reference:'e4',transaction_amount:{currency:'NOK',amount:'500.00'},credit_debit_indicator:'DBIT',creditor:{name:'Barnehagen'},creditor_account:{iban:'NO9386011117947'}},
      {booking_date:daysAgo(11),entry_reference:'e5',transaction_amount:{currency:'NOK',amount:'2000.00'},credit_debit_indicator:'DBIT',creditor:{name:'Nordnet Bank'},creditor_account:{iban:'NO0000000000001'}}]};}
    throw Error('unexpected '+path);
  };
  const launched=[];
  let yieldNow=false;
  const options={dataDir,config:()=>cfg,client:()=>api,keyProvider:()=>key,shouldYield:()=>yieldNow,
    launchAgent:({prompt,onExit})=>{launched.push({prompt,onExit});return {pid:process.pid};}};
  const finance=createFinance(options);
  const responses=[];
  const call=(surface,{device=null,path='',input,cookie,agentKey,query='month='+daysAgo(10).slice(0,7)}={})=>new Promise(resolve=>{
    const headers={...(cookie?{cookie}:{}),...(agentKey?{'x-finance-agent':agentKey,'content-type':'application/json'}:{})};
    const base=surface==='mobile'?'/send/api/finance':surface==='agent'?'/api/finance/agent':'/api/finance';
    const req={method:input?'POST':'GET',url:base+path+'?'+query,headers,socket:{}};
    const res={headers:{},setHeader(k,v){this.headers[k]=v;}};
    const send=(_,status,body)=>{responses.push(res.headers);resolve({status,...body,setCookie:res.headers['Set-Cookie']});};
    const args={device:device?{id:device}:null,path:base+path,req,res,send,json:async()=>input};
    (surface==='mobile'?finance.mobile(args):surface==='agent'?finance.agent(args):finance.desktop(args));
  });
  return {dataDir,cfg,finance,call,launched,options,setGate:g=>{gate=g;},setYield:v=>{yieldNow=v;},cleanup:()=>rmSync(dataDir,{recursive:true,force:true})};
}
const stateOf=url=>new URL(url).searchParams.get('state');

test('enrolled phones and PIN sessions open finance, children stay locked and a bank read never blocks consent',async t=>{
  const h=harness();t.after(h.cleanup);
  assert.equal((await h.call('mobile',{device:'child'})).status,401);
  assert.equal((await h.call('desktop')).status,401);
  const wrong=await h.call('desktop',{path:'/unlock',input:{pin:'000000'}});assert.equal(wrong.status,422);
  const unlocked=await h.call('desktop',{path:'/unlock',input:{pin:'246810'}});
  assert.equal(unlocked.status,200);assert.match(unlocked.setCookie,/HttpOnly; SameSite=Strict; Path=\//);
  const cookie=unlocked.setCookie.split(';')[0];
  assert.equal((await h.call('desktop',{cookie})).me.id,'adult-a');
  // Adult A connects two banks. The first long read must not block adult B's consent.
  const dnb=await h.call('mobile',{device:'first',path:'/connect',input:{bank:'DNB'}});
  assert.equal((await h.call('mobile',{device:'first',path:'/confirm',input:{state:stateOf(dnb.url),code:'dnb'}})).saved,true);
  let release;h.setGate(new Promise(r=>{release=r;}));
  const sync=h.finance.tick();
  const other=await h.call('mobile',{device:'second',path:'/connect',input:{bank:'Sbanken'}});
  assert.equal(other.status,200);
  // The bank can return in a browser that is not paired: the state token is the proof.
  const confirmed=await new Promise(resolve=>h.finance.confirmMobile({path:'/send/api/finance/confirm',req:{method:'POST',url:'/send/api/finance/confirm',headers:{}},res:{setHeader(){}},
    send:(_,status,body)=>resolve({status,...body}),json:async()=>({state:stateOf(other.url),code:'sb'})}));
  assert.equal(confirmed.saved,true);
  assert.equal((await h.call('mobile',{device:'second',path:'/confirm',input:{state:stateOf(other.url),code:'sb'}})).status,422,'replay');
  release();await sync;await h.finance.tick();
  const view=await h.call('mobile',{device:'second'});
  assert.equal(view.connections.length,2);
  assert.equal(view.accounts.length,2);
  assert.ok(view.recurring.some(r=>r.merchant==='Netflix'));
  assert.equal(readFileSync(join(h.dataDir,'finance.enc')).includes(Buffer.from('NETFLIX')),false);
  assert.equal((await h.call('desktop',{cookie,path:'/lock',input:{}})).locked,true);
  assert.equal((await h.call('desktop',{cookie})).status,401);
});

test('PIN unlock is rate limited',()=>{
  const sessions=createFinanceSessions();const owners=[{id:'a',pinHash:hashPin('135791')}];
  for (let i=0;i<5;i++) assert.throws(()=>sessions.unlock('000000',owners),/Feil PIN/);
  assert.throws(()=>sessions.unlock('135791',owners),/For mange/);
});

test('agent surface: key, current fingerprint, evidence, family decisions, realization and payment limits',async t=>{
  const h=harness();t.after(h.cleanup);
  const c=await h.call('mobile',{device:'first',path:'/connect',input:{bank:'DNB'}});
  await h.call('mobile',{device:'first',path:'/confirm',input:{state:stateOf(c.url),code:'dnb'}});
  await h.finance.tick();
  assert.equal((await h.call('agent',{path:'/digest',agentKey:'wrong-key-wrong-key-wrong-key-wrong-key-wrong-key-wrong-key-12'})).status,403);
  const agentKey=h.finance.agentToken();
  const digest=await h.call('agent',{path:'/digest',agentKey});
  assert.ok(digest.duties.some(d=>d.kind==='weekly-review'));
  assert.equal(h.launched.length,1,'tick launched the finance agent for its duties');
  assert.match(h.launched[0].prompt,/aldri betale/);
  const netflix=digest.recurring.find(r=>r.merchant==='Netflix');
  const base={subject:'subscription:netflix',kind:'subscription',title:'Si opp Netflix',summary:'Dere betaler for Netflix hver måned.',
    evidence:{rowIds:netflix.rowIds,reasoning:'Tre like trekk siste tre måneder fra samme mottaker.'},estimate:{annualSavingsNok:1548,basis:'129 kr × 12 måneder.'},
    baseline:{merchantKey:netflix.merchantKey}};
  assert.match((await h.call('agent',{path:'/suggestion',agentKey,input:{...base,dataFingerprint:'old'}})).error,/endret/);
  assert.match((await h.call('agent',{path:'/suggestion',agentKey,input:{...base,dataFingerprint:digest.dataFingerprint,evidence:{...base.evidence,rowIds:['nope']}}})).error,/Ukjent postering/);
  const created=await h.call('agent',{path:'/suggestion',agentKey,input:{...base,dataFingerprint:digest.dataFingerprint}});
  assert.equal(created.status,'open');
  const view=await h.call('mobile',{device:'second'});
  assert.equal(view.suggestions[0].estimate.annualSavingsMinor,154800);
  assert.equal(Object.keys(view.evidence).length,3);
  await h.call('mobile',{device:'second',path:'/suggestion',input:{id:created.id,action:'dismiss',reason:'Vi bruker den'}});
  assert.match((await h.call('agent',{path:'/suggestion',agentKey,input:{...base,dataFingerprint:digest.dataFingerprint}})).error,/avviste/);
  await h.call('mobile',{device:'second',path:'/suggestion',input:{id:created.id,action:'reopen'}});
  assert.equal((await h.call('mobile',{device:'second',path:'/suggestion',input:{id:created.id,action:'accept'}})).status,'accepted');
  // Family rules win over agent rules.
  const kid=digest.recurring.length&&(await h.call('agent',{path:'/transactions',agentKey,query:'q=barnehagen'})).rows[0];
  await h.call('mobile',{device:'first',path:'/rule',input:{match:{merchantKey:kid.merchantKey},set:{category:'barnehage'}}});
  assert.match((await h.call('agent',{path:'/rule',agentKey,input:{match:{merchantKey:kid.merchantKey},set:{category:'annet'},evidence:'Ser ut som annet ifølge teksten.'}})).error,/Familien/);
  // Nordnet is recognized as saving without a manual target.
  assert.equal((await h.call('agent',{path:'/transactions',agentKey,query:'q=nordnet'})).rows[0].kind,'saving');
  // Payments only to approved payees within the family's limit.
  const proposal={key:'invoice-1',ruleId:'none',payee:{account:'8601 11 17947',kid:'123455'},amountNok:500,dueDate:daysAgo(-5),evidence:{source:'Faktura i Drive',reasoning:'Månedlig barnehagefaktura med samme beløp som før.'}};
  assert.match((await h.call('agent',{path:'/payment',agentKey,input:proposal})).error,/godkjent/);
  const rule=await h.call('mobile',{device:'first',path:'/payment-rule',input:{name:'Barnehagen',account:'NO93 8601 1117 947',maxAmountNok:600}});
  assert.match((await h.call('agent',{path:'/payment',agentKey,input:{...proposal,ruleId:rule.id,amountNok:900}})).error,/grense/);
  assert.match((await h.call('agent',{path:'/payment',agentKey,input:{...proposal,ruleId:rule.id,payee:{account:'12345678903'}}})).error,/samsvarer/);
  const paid=await h.call('agent',{path:'/payment',agentKey,input:{...proposal,ruleId:rule.id}});
  assert.equal(paid.status,'open');
  const done=await h.call('agent',{path:'/done',agentKey,input:{completed:['weekly-review','contract-review'],outcome:'ok',summary:'Gikk gjennom faste trekk.'}});
  assert.equal(done.saved,true);
  h.launched[0].onExit(0,null);
  const after=await h.call('agent',{path:'/digest',agentKey});
  assert.ok(!after.duties.some(d=>d.kind==='weekly-review'||d.kind==='contract-review'));
});

test('agent stays off until the household enables it and yields to family actions',async t=>{
  const off=harness({agentEnabled:false});t.after(off.cleanup);
  assert.equal((await off.call('agent',{path:'/digest',agentKey:off.finance.agentToken()})).status,403);
  const on=harness();t.after(on.cleanup);
  const c=await on.call('mobile',{device:'first',path:'/connect',input:{bank:'DNB'}});
  await on.call('mobile',{device:'first',path:'/confirm',input:{state:stateOf(c.url),code:'dnb'}});
  on.setYield(true);await on.finance.tick();
  assert.equal(on.launched.length,0);
});

test('an existing encrypted first-release store keeps working',async t=>{
  const h=harness();t.after(h.cleanup);
  const key=randomBytes(32);
  const old={owners:{'adult-a':{expires:new Date(Date.now()+DAY).toISOString(),links:[{key:hash('acc-dnb'),uid:'uid-dnb',name:'Konto'}],attempt:new Date().toISOString(),issue:null}},
    accounts:{[hash('acc-dnb')]:{name:'Konto',rows:{x:{date:daysAgo(3),currency:'NOK',minor:-5000,label:'REMA 1000',counterparty:null,mcc:'5411'}},syncedAt:new Date().toISOString(),total:-5000,balance:{minor:1,currency:'NOK',type:'ITBD'},difference:null,firstDate:daysAgo(3)}},targets:{}};
  writeFileSync(join(h.dataDir,'finance.enc'),encrypt(Buffer.from(JSON.stringify(old)),key));
  const finance=createFinance({...h.options,keyProvider:()=>key});
  const view=await new Promise(resolve=>finance.mobile({device:{id:'first'},path:'/send/api/finance',req:{method:'GET',url:'/send/api/finance?month='+daysAgo(3).slice(0,7),headers:{}},res:{setHeader(){}},send:(_,status,body)=>resolve({status,...body}),json:async()=>null}));
  assert.equal(view.status,200);
  assert.equal(view.summary.byCategory.dagligvarer,5000);
  assert.equal(view.connections[0].bank,'DNB');
});

test('savings are realized only by later bank rows, and payments are matched to the booked debit',async()=>{
  const {realize,paymentMatch}=await import('../src/finance-analysis.mjs');
  const accepted={status:'accepted',acceptedAt:daysAgo(40)+'T10:00:00Z',baseline:{merchantKey:'brand:telia',amountMinor:59900,cadence:'månedlig'}};
  const rows=[{id:'old',merchantKey:'brand:telia',minor:-59900,date:daysAgo(45),label:'TELIA'},{id:'new',merchantKey:'brand:telia',minor:-39900,date:daysAgo(10),label:'TELIA'}];
  assert.deepEqual(realize(accepted,rows.slice(0,1),daysAgo(30)),null);
  assert.equal(realize(accepted,rows,daysAgo(0)).annualSavingsMinor,240000);
  assert.equal(realize({...accepted,acceptedAt:daysAgo(60)+'T10:00:00Z'},[],daysAgo(0)).kind,'stopped');
  const proposal={status:'approved',amountMinor:50000,createdAt:daysAgo(5)+'T00:00:00Z',payee:{name:'Barnehagen AS'}};
  assert.equal(paymentMatch(proposal,[{id:'p',minor:-50000,date:daysAgo(1),label:'BARNEHAGEN AS'}]).id,'p');
  assert.equal(paymentMatch(proposal,[{id:'q',minor:-50000,date:daysAgo(1),label:'REMA 1000'}]),null);
});

test('bank card text, own-account wording and transfers to household members are read as the household means them',()=>{
  const state=household();
  const add=(id,label,minor=-10000)=>{state.accounts.a1.rows[id]={date:daysAgo(1),currency:'NOK',minor,label,counterparty:null,mcc:null};};
  state.accounts.a1.name='Kari Nordmann Hansen';state.accounts.b1.name='Ola Hansen';
  add('card','Varekjøp, Kl. 19.18 Versjon 2 Aut. 075865, Kiwi 123 Sentrum Storgata 0001 O');
  add('local','Varekjøp, Kl. 17.27 Versjon 2 Aut. 075840, Bondens Gårdsb Gårdsveien Bygda');
  add('own','Kontoregulering, Mobil Overføring');
  add('member','Ola h nsen');add('relative','Per Hansen og Kari');add('card-bill','Eurocard',-500000);
  const rows=classify(state),get=id=>rows.find(r=>r.id===id);
  assert.equal(get('card').chain,'KIWI');assert.equal(get('card').category,'dagligvarer');
  assert.equal(get('local').merchant,'Bondens gårdsb gårdsveien');
  assert.equal(get('own').kind,'internal');assert.equal(get('member').kind,'internal');
  assert.equal(get('relative').kind,'expense');
  assert.equal(get('card-bill').category,'kort');
});

test('online card text, Vipps purchases from businesses and loan interest are understood',async()=>{
  const {loanParts}=await import('../src/finance-analysis.mjs');
  const state=household();
  const add=(id,label,minor=-10000)=>{state.accounts.a1.rows[id]={date:daysAgo(1),currency:'NOK',minor,label,counterparty:null,mcc:null};};
  add('visa','Visa, Nok 149,00 Netflix.Com');add('usd','Visa, Usd 6,50 Example Cloud Inc, Valutakurs:     9,5553');add('vippsshop','Visa, Vipps:Avishuset');
  add('loan','Lån, Lån 1234.56.78901, Avdrag      Kr           0,00, Renter      Kr      12.345,67, Omk.        Kr          60,00',-1240567);
  const rows=classify(state),get=id=>rows.find(r=>r.id===id);
  assert.equal(get('visa').category,'abonnement');assert.notEqual(get('usd').category,'kort');assert.notEqual(get('vippsshop').category,'vipps');
  assert.equal(get('loan').category,'laan');
  assert.deepEqual(loanParts(get('loan')),{interestMinor:1234567,principalMinor:0,feesMinor:6000});
});
