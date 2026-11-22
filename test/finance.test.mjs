import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createFinance} from '../src/finance.mjs';
import {readAccount} from '../src/finance-bank.mjs';

const date='2026-01-12';
const row=(amount,ref)=>({booking_date:date,entry_reference:ref,transaction_amount:{currency:'NOK',amount},
  credit_debit_indicator:'DBIT',status:'BOOK',creditor:{name:'Test merchant'},creditor_account:{iban:'fixture-destination'}});
function fixture(){
  let nextDay=false,fail=false;
  const expires=new Date(Date.now()+86400000).toISOString();
  return {advance(){nextDay=true;},breakPage(){fail=true;},api:async(path,input)=>{
    if(path.startsWith('/aspsps?')) return {aspsps:[{name:'DNB',country:'NO',maximum_consent_validity:86400}]};
    if(path==='/auth')return {url:'https://bank.example/?state='+input.state};
    if(path==='/sessions')return {aspsp:{name:'DNB',country:'NO'},psu_type:'personal',access:{valid_until:expires},
      accounts:[{identification_hash:'shared',uid:'source',name:'Test account'}]};
    if(path.endsWith('/balances'))return {balances:[{balance_type:'ITBD',balance_amount:{amount:nextDay?'96.00':'100.00',currency:'NOK'}}]};
    if(path.includes('continuation_key=')){
      if(fail)throw Error('Enable Banking svarte HTTP 503');
      return {transactions:[row('5.00'),row('5.00'),...(nextDay?[row('4.00','next')]:[])]};
    }
    assert.ok(path.includes('transaction_status=BOOK'));
    return {transactions:[row('3.25','first')],continuation_key:'next-page'};
  }};
}
test('all pages, two real identical purchases, overlapping windows and booked balance',async()=>{
  const f=fixture(),link={uid:'source',name:'test'};
  const first=await readAccount(f.api,link);
  assert.equal(Object.keys(first.rows).length,3);assert.equal(first.difference,null);
  f.advance();
  const next=await readAccount(f.api,link,first);
  assert.equal(Object.keys(next.rows).length,4);assert.equal(next.difference,0);
  f.breakPage();
  await assert.rejects(()=>readAccount(f.api,link,next),/503/);
});
test('only enrolled devices can authorize, read or set savings rules; callback cannot be replayed',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'finance-test-'));t.after(()=>rmSync(dataDir,{recursive:true,force:true}));
  const key=randomBytes(32),f=fixture(),cfg={redirectUrl:'https://family.example/send/finance/',owners:[
    {id:'adult-a',deviceId:'first'},{id:'adult-b',deviceId:'second'}]};
  let requests=0;
  const options={dataDir,config:()=>cfg,client:()=>{requests++;return f.api;},keyProvider:()=>key};
  let finance=createFinance(options);
  const call=(device,path='',input)=>finance.route({device:{id:device,memberId:'adult-a'},path:'/send/api/finance'+path,
    req:{method:input?'POST':'GET',url:'/?month=2026-01'},send:(_,status,body)=>({status,...body}),json:async()=>input});
  assert.equal((await call('child')).status,403);
  assert.match((await call('first')).connections[0].setupIssue,/Application ID/);
  assert.equal((await call('first','/connect',{})).status,409);
  assert.equal(requests,0);
  const privateKeyFile=join(dataDir,'mock-signing-key');
  for (const owner of cfg.owners) Object.assign(owner,{applicationId:'00000000-0000-4000-8000-000000000001',privateKeyFile});
  assert.match((await call('first','/connect',{})).error,/Signeringsnøkkelen/);
  assert.equal(requests,0);
  writeFileSync(privateKeyFile,'mock');
  const connect=await call('first','/connect',{});
  const params={state:new URL(connect.url).searchParams.get('state'),code:'sample'};
  assert.equal((await call('second','/confirm',params)).status,422);
  assert.equal((await call('first','/confirm',params)).saved,true);
  assert.equal((await call('first')).queued,true);
  await finance.tick();
  assert.equal((await call('first')).queued,false);
  assert.equal((await call('first','/confirm',params)).status,422);
  const {accounts:[account]}=await call('second');
  const choice={account:account.key,id:account.rows[0].id};
  assert.equal((await call('second','/target',choice)).status,422);
  await call('first','/target',choice);
  finance=createFinance(options);
  assert.equal((await call('second')).saved,1325);
  assert.equal(readFileSync(join(dataDir,'finance.enc')).includes(Buffer.from('Test merchant')),false);
  assert.equal((await call('first','/target',{account:account.key,clear:true})).saved,true);
  assert.equal((await call('first')).saved,0);
});
