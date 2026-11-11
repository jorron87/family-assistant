import test from 'node:test';
import assert from 'node:assert/strict';
import {sesumDiscoveryTrace} from '../src/sesum-discovery-trace.mjs';
const product=(id,familyIds=['pasta'])=>({id:'p'+id,kind:'product',url:'https://www.sesum.no/produkt/'+id+'-synthetic',familyIds,status:'complete',createdAt:'2026-11-01T10:00:00Z',observationFetchedAt:'2026-11-01T11:00:00Z',productObservation:{name:'Synthetic source '+id,privateAccount:'DO_NOT_RETURN'}});
const search=(id,query,productJobIds)=>({id,kind:'search',url:'https://www.sesum.no/sok?q='+query,familyIds:['pasta'],status:'complete',endReached:true,fetchedAt:'2026-11-01T10:00:00Z',productJobIds,nextJobIds:[]});
const fixture=()=>({id:'synthetic-run',families:[{familyId:'pasta',name:'Pasta',queries:['pasta','penne']},{familyId:'other',name:'Other',queries:['other']}],jobs:{s1:search('s1','pasta',['p1','p2']),s2:search('s2','penne',['p2']),p1:product(1),p2:product(2),p3:product(3)}});
test('source tracing explains genuine broad hits and preserves untraced hints without inventing query membership',()=>{
 const run=fixture(),before=structuredClone(run),trace=sesumDiscoveryTrace(run,{familyId:'pasta'});assert.equal(trace.total,3);assert.deepEqual(trace.products.find(p=>p.productId==='2').directSearchJobIds,['s1','s2']);assert.deepEqual(trace.products.find(p=>p.productId==='3').untracedFamilyIds,['pasta']);assert.equal(trace.searches[0].productEdgesKnown,true);assert.equal(JSON.stringify(trace).includes('DO_NOT_RETURN'),false);assert.deepEqual(run,before);assert.equal(sesumDiscoveryTrace(run,{familyId:'pasta'}).fingerprint,trace.fingerprint);
});
test('aliases cannot duplicate products and a product-specific trace exposes only its actual query edges',()=>{
 const run=fixture();run.productAliases={old2:'p2'};run.jobs.s1.productJobIds.push('old2');const trace=sesumDiscoveryTrace(run,{productId:'2'});assert.equal(trace.products.length,1);assert.deepEqual(trace.products[0].directSearchJobIds,['s1','s2']);assert.deepEqual(trace.searches.find(s=>s.jobId==='s1').productIds,['1','2']);assert.equal(trace.searches.find(s=>s.jobId==='s1').savedProductEdges,3);
});
test('missing legacy edges, missing children and a not-yet-started run remain explicit unknowns',()=>{
 const run=fixture();delete run.jobs.s1.productJobIds;run.jobs.s2.productJobIds.push('missing-child');const trace=sesumDiscoveryTrace(run,{familyId:'pasta'});assert.equal(trace.searches.find(s=>s.jobId==='s1').productEdgesKnown,false);assert.deepEqual(trace.products.find(p=>p.productId==='1').untracedFamilyIds,['pasta']);assert.deepEqual(trace.searches.find(s=>s.jobId==='s2').missingProductJobIds,['missing-child']);assert.deepEqual(sesumDiscoveryTrace(null,{productId:'1'}).products,[]);
 for(const input of [{},{familyId:'../wrong'},{productId:'0'},{productId:1},{familyId:'missing'}])assert.throws(()=>sesumDiscoveryTrace(run,input));run.productAliases={loop:'loop'};run.jobs.s2.productJobIds=['loop'];assert.throws(()=>sesumDiscoveryTrace(run,{familyId:'pasta'}),/alias/);
});
