import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {agentContextPages,agentContextView} from '../src/shopping-agent-context.mjs';
import {planWorkerContextDelivery,workerContextPages} from '../src/shopping-context-delivery.mjs';
import {expandedCorpus,expandedFamilies} from '../scripts/fixtures/shopping-agent-corpus.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decode(pages){
 const rows=[];let partial='',expectedOffset=0;
 for(const page of pages){
  assert.ok(JSON.stringify({section:'sources',page:100,totalPages:100,...page}).length<16000,'existing response ceiling remains intact');
  if(page.items){assert.equal(partial,'');rows.push(...page.items);continue;}
  assert.equal(page.offset,expectedOffset);partial+=page.text;expectedOffset+=page.text.length;
  if(expectedOffset===page.totalCharacters){rows.push(JSON.parse(partial));partial='';expectedOffset=0;}
 }
 assert.equal(partial,'');return rows;
}
const pages=(packet,aligned)=>agentContextPages(packet,8000,{separateSourceRows:aligned});

test('the expanded multi-chain corpus preserves every source and complete label through successive delivery layouts',t=>{
 const corpus=expandedCorpus();assert.ok(corpus.length>=140);assert.equal(expandedFamilies.length,91);
 const chains=['KIWI','REMA_1000','COOP_EXTRA'],totals={products:corpus.length,chains:chains.length,updates:0,packedSourceCalls:0,adaptiveSourceCalls:0,coldPackedPages:0,coldAdaptivePages:0};
 for(let offset=0;offset<corpus.length;offset+=5){
  const cases=corpus.slice(offset,offset+5),packet={version:1,jobs:cases.map(c=>({id:'product:'+c.caseNumber})),families:expandedFamilies.map(f=>({familyId:f.key,name:f.name,note:f.note,unit:f.unit})),products:[],sources:cases.flatMap(c=>chains.map((chain,index)=>({sourceKey:`sesum:${chain}:${c.caseNumber}`,observation:{source:{name:c.name,brand:c.brand,weight:c.weight,weightUnit:c.weightUnit,ingredients:c.text}},placement:{familySetFingerprint:'current-family-set',review:{status:'reviewed',evidence:c.text}},...(index===0&&c.caseNumber%17===0?{singleChainLabel:('Full unique label '+c.caseNumber+' æøå \\"\n').repeat(400)}:{})})))};
  let packed=pages(packet,false),delivery=planWorkerContextDelivery(packet);totals.coldPackedPages+=packed.sources.length;totals.coldAdaptivePages+=delivery.pages.sources.length;
  assert.deepEqual(decode(delivery.pages.sources),agentContextView(packet).sources);
  let previous={packet:structuredClone(packet),sourceRowsSeparate:delivery.sourceRowsSeparate,served:Object.entries(delivery.pages).flatMap(([s,p])=>p.map((_,i)=>s+':'+i))};
  for(let i=0;i<packet.sources.length;i++){
   packet.sources[i].registration={productKey:'synthetic:'+i,reviewedLabel:'Actually changed registration receipt for '+i,packEvidence:cases[Math.floor(i/3)].text,previousExclusion:'Retain the actual previous scope-specific reason.'};
   const nextPacked=pages(packet,false),next=planWorkerContextDelivery(packet,{previous}),oldPacked=new Map(packed.sources.map(p=>[digest(p),p])),oldPages=workerContextPages(previous).sources,oldRows=agentContextView(previous.packet).sources,receipts=new Map(oldRows.map(r=>[digest(r),r]));
   totals.packedSourceCalls+=nextPacked.sources.filter(p=>!oldPacked.has(digest(p))).length;totals.adaptiveSourceCalls+=next.pages.sources.filter((_,i)=>!next.served.includes('sources:'+i)).length;totals.updates++;
   // Rebuild from the exact previously delivered bytes plus each required new
   // page, rather than asserting that omitted pages are probably unchanged.
   const delivered=next.pages.sources.map((p,i)=>{
    if(!next.served.includes('sources:'+i))return p;
    if(p.items)return {...p,items:p.items.map(row=>{assert.ok(receipts.has(digest(row)));return receipts.get(digest(row));})};
    assert.ok(oldPages.some(old=>digest(old)===digest(p))||receipts.has(digest(agentContextView(packet).sources[p.rowIndex])));return p;
   });
   assert.deepEqual(decode(delivered),agentContextView(packet).sources);
   for(const section of ['jobs','families','products','texts'])assert.deepEqual(next.pages[section],nextPacked[section]);
   packed=nextPacked;previous={packet:structuredClone(packet),sourceRowsSeparate:next.sourceRowsSeparate,served:Object.entries(next.pages).flatMap(([s,p])=>p.map((_,i)=>s+':'+i))};
  }
 }
 t.diagnostic(JSON.stringify(totals));
 assert.ok(totals.adaptiveSourceCalls<totals.packedSourceCalls);assert.equal(totals.coldAdaptivePages,totals.coldPackedPages);
});

test('a changed suffix of a split label remains required while byte-identical fragments can be reused',()=>{
 const packet={version:1,jobs:[],families:[],products:[],sources:[{sourceKey:'one',label:'æøå '.repeat(8000)}]},before=pages(packet,true).sources;
 packet.sources[0].label+=' An actual newly supplied allergen fact.';const after=pages(packet,true).sources,known=new Set(before.map(digest));
 assert.ok(after.some(p=>!known.has(digest(p))));assert.deepEqual(decode(after),agentContextView(packet).sources);
 const partial=new Set(before.slice(0,-1).map(digest));assert.ok(before.some(p=>!partial.has(digest(p))),'an unread old fragment never becomes a reading receipt');
});

test('partial source delivery, a cold restart or explicit rereading cannot create complete-row receipts',()=>{
 const packet={version:1,jobs:[],families:[],products:[],sources:[{sourceKey:'one',label:'Full actual declaration æøå '.repeat(2000)}]},initial=planWorkerContextDelivery(packet);
 assert.ok(initial.pages.sources.length>1);const partial={packet:structuredClone(packet),sourceRowsSeparate:initial.sourceRowsSeparate,served:['sources:0']};
 const next=planWorkerContextDelivery(packet,{previous:partial});assert.ok(next.served.length<next.pages.sources.length);
 const cold=planWorkerContextDelivery(packet);assert.deepEqual(cold.served,[]);
 const changed=structuredClone(packet);changed.sources[0].label+=' Actual newly supplied allergen.';const current=planWorkerContextDelivery(changed,{previous:partial});assert.ok(current.pages.sources.some((_,i)=>!current.served.includes('sources:'+i)));
});

test('changed dictionary text and family criteria remain required even when source reference bytes are unchanged',()=>{
 const label='Full original actual ingredient declaration. '.repeat(20),packet={version:1,jobs:[],families:[{familyId:'family',note:'Original actual criterion.'}],products:[],sources:[{sourceKey:'one',label},{sourceKey:'two',label}]},initial=planWorkerContextDelivery(packet,{provided:true}),previous={packet:structuredClone(packet),sourceRowsSeparate:initial.sourceRowsSeparate,served:initial.served};
 for(const row of packet.sources)row.label='New actual declaration with changed allergens. '.repeat(20);packet.families[0].note='Actually changed household criterion.';
 const current=planWorkerContextDelivery(packet,{previous});assert.ok(current.pages.texts.some((_,i)=>!current.served.includes('texts:'+i)));assert.ok(current.pages.families.some((_,i)=>!current.served.includes('families:'+i)));
 assert.deepEqual(decode(current.pages.sources),agentContextView(packet).sources);
});

test('changing all sources uses compact pages without increasing the cold-read call count',()=>{
 const packet={version:1,jobs:[],families:[],products:[],sources:Array.from({length:15},(_,i)=>({sourceKey:'source:'+i,wholeActualLabel:'Unique actual facts for '+i+' '+String(i).repeat(350),familySetFingerprint:'old'}))},initial=planWorkerContextDelivery(packet,{provided:true}),previous={packet:structuredClone(packet),sourceRowsSeparate:initial.sourceRowsSeparate,served:initial.served};
 for(const row of packet.sources)row.familySetFingerprint='changed';const current=planWorkerContextDelivery(packet,{previous});assert.equal(current.sourceRowsSeparate,false);assert.equal(current.pages.sources.filter((_,i)=>!current.served.includes('sources:'+i)).length,agentContextPages(packet).sources.length);assert.deepEqual(decode(current.pages.sources),agentContextView(packet).sources);
});
