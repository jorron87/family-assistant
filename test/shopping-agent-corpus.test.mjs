import test from 'node:test';
import assert from 'node:assert/strict';
import {expandedFamilies,expandedCorpus} from '../scripts/fixtures/shopping-agent-corpus.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {agentManifest} from '../src/shopping-agent-context.mjs';
import {shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';

test('expanded shopping benchmark has unique cases and real criteria covering all 91 families',()=>{
 const cases=expandedCorpus(),keys=new Set(expandedFamilies.map(f=>f.key));
 assert.equal(keys.size,91);assert.equal(cases.length,140);assert.equal(new Set(cases.map(c=>c.caseId)).size,140);assert.equal(new Set(cases.map(c=>c.text)).size,140);
 assert.equal(cases.filter(c=>c.tags.includes('positive')).length,91);assert.equal(cases.filter(c=>c.tags.includes('boundary')).length,25);assert.equal(cases.filter(c=>c.expected.status==='blocked').length,24);
 assert.ok(cases.some(c=>c.tags.includes('missing-package')));assert.ok(cases.some(c=>c.tags.includes('missing-or-conflicting-label')));assert.ok(cases.some(c=>c.tags.includes('long-label')));
 for(const c of cases){assert.ok(c.expected.targets.every(id=>keys.has(id)));assert.ok(c.text.length>30);assert.ok(!c.text.includes('UNIQUE_FOOD_'));}
 assert.equal(new Set(cases.filter(c=>c.tags.includes('positive')).flatMap(c=>c.expected.targets)).size,91);
});

test('every expanded gold decision passes current domain validation in an isolated bounded cohort',()=>{
 const cases=expandedCorpus(),now='2026-11-10T12:00:00Z';let saved=0;
 for(let offset=0;offset<cases.length;offset+=20){
  const state={},shop=shoppingStore(state,{save(){},now:()=>new Date(now)});shop.settings({monitoringEnabled:true,stores:[]});
  for(const f of expandedFamilies)shop.watch({id:'synthetic-'+f.key,name:f.name,note:f.note,unit:f.unit,storage:'pantry'});
  const selected=cases.slice(offset,offset+20);shop.sesumReceiveMetadata({familyIds:[],fetchedAt:now,products:selected.map(c=>({id:String(1000+c.caseNumber),name:c.name,brand:c.brand,vendor:'Synthetic',ean:[],weight:c.weight,weightUnit:c.weightUnit,soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/'+(1000+c.caseNumber)+'-synthetic'}))});
  const assignment=agentManifest(shoppingAgentBatch(shop.queue().filter(i=>i.do==='shopping-sesum-placement-review'))),packet=shop.agentContext(assignment);assert.equal(packet.sources.length,selected.length);assert.equal(packet.families.length,91);
  const decisions=packet.sources.map((s,sourceIndex)=>{const c=selected.find(c=>s.sourceKey==='sesum-product:'+(1000+c.caseNumber));return {sourceIndex,status:c.expected.status,evidence:'Synthetic gold label: '+c.text,targets:c.expected.targets.map(key=>({familyIndex:packet.families.findIndex(f=>f.familyId==='synthetic-'+key),equivalenceEvidence:'Gold fixture explicitly documents the required product form and actual package.'})),...(c.expected.status==='blocked'?{reason:'Concrete required fact is missing or conflicting in the supplied label.',retryAt:'2026-11-10T18:00:00Z'}:c.expected.status==='no-active-family'?{noActiveFamilyVerified:true,reason:'The actual declared variant is excluded from every active family.'}:{})};});
  saved+=shop.agentPlacement({assignment,contextFingerprint:packet.contextFingerprint,decisions:{reviewedAllFamilies:true,scopeEvidence:'All complete synthetic family criteria and exact source labels were supplied and reviewed.',decisions}}).saved;
 }
 assert.equal(saved,140);
});

test('three-chain stress keeps twenty product jobs and sixty separate source decisions without price approval',()=>{
 const now='2026-11-10T12:00:00Z',state={},shop=shoppingStore(state,{save(){},now:()=>new Date(now)}),codes=['KIWI','REMA_1000','COOP_EXTRA'];
 shop.settings({monitoringEnabled:true,stores:codes.map(code=>({id:code.toLowerCase(),name:code,chainCode:code,url:'https://example.test/'+code,minSavings:0}))});
 for(const f of expandedFamilies)shop.watch({id:'synthetic-'+f.key,name:f.name,note:f.note,unit:f.unit,storage:'pantry'});
 const cases=expandedCorpus().slice(0,20);shop.sesumReceivePrices({familyIds:[],fetchedAt:now,products:cases.map((c,i)=>({id:String(1000+i),name:c.name,brand:c.brand,vendor:'Synthetic',ean:[],weight:c.weight,weightUnit:c.weightUnit,soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/'+(1000+i)+'-synthetic',prices:codes.map((storeCode,j)=>({storeCode,price:10+i+j,observedAt:now,source:'receipt_realtime',isPromo:false,promotion:null}))}))});
 const assignment=agentManifest(shoppingAgentBatch(shop.queue().filter(i=>i.do==='shopping-sesum-placement-review'))),packet=shop.agentContext(assignment);
 assert.equal(assignment.jobs.length,20);assert.equal(packet.sources.length,60);assert.equal(new Set(packet.sources.map(s=>s.sourceKey)).size,60);assert.ok(assignment.jobs.every(j=>j.sourceKeys.length===3));
 const decisions=packet.sources.map((s,sourceIndex)=>{const c=cases[Number(s.observation.source.id)-1000];return {sourceIndex,status:c.expected.status,targets:c.expected.targets.map(key=>({familyIndex:packet.families.findIndex(f=>f.familyId==='synthetic-'+key),equivalenceEvidence:'The synthetic original label and fixed package match the exact family criteria.'})),evidence:c.text,...(c.expected.status==='blocked'?{reason:'Required concrete label/package fact is missing or conflicting.',retryAt:'2026-11-10T18:00:00Z'}:c.expected.status==='no-active-family'?{noActiveFamilyVerified:true,reason:'The actual label documents an excluded variant for every active family.'}:{})};});
 assert.equal(shop.agentPlacement({assignment,contextFingerprint:packet.contextFingerprint,decisions:{reviewedAllFamilies:true,scopeEvidence:'Read all 91 actual synthetic families and all 60 source rows with original labels.',decisions}}).saved,60);
 assert.equal(Object.keys(state.shopping.sesumPlacementReviews).length,60);assert.equal(Object.keys(state.shopping.sesumPrices.bridges).length,0);
});
