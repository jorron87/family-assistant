import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';
import {agentManifest,buildAgentContext,agentContextPages,bindPlacementDecisions} from '../src/shopping-agent-context.mjs';
import {shoppingProtocol} from '../src/shopping-agent-protocol.mjs';
const facts={families:()=>[{familyId:'beans',familyFingerprint:'criteria'}],sources:key=>({sourceKey:key,ingredients:'Coffee beans'}),products:key=>({key})};
test('one context shares family criteria and follows assigned products across stages without adding new chain sources',()=>{
 const a='sesum:KIWI:1',b='sesum:REMA_1000:1',c='sesum:COOP_EXTRA:1';
 const assignment=agentManifest(shoppingAgentBatch([{do:'shopping-sesum-placement-review',sourceKey:a,relatedSources:[{sourceKey:b}]}]));
 const next=[{do:'shopping-sesum-discovery',sourceKey:a,relatedSources:[{sourceKey:b},{sourceKey:c}]},{do:'shopping-sesum-family-review',sourceKey:b},{do:'shopping-sesum-family-review',sourceKey:c}];
 const packet=buildAgentContext(next,assignment,facts);assert.equal(packet.families.length,1);assert.deepEqual(packet.sources.map(r=>r.sourceKey),[a,b]);assert.equal(packet.jobs[0].items.length,2);assert.deepEqual(packet.jobs[0].items[0].relatedSources,[{sourceKey:b}]);assert.equal(packet.activeStagesEmpty,false);
 assert.equal(buildAgentContext([],assignment,facts).activeStagesEmpty,true);
 assert.equal(buildAgentContext(next,assignment,facts).contextFingerprint,packet.contextFingerprint);
 assert.notEqual(buildAgentContext(next,assignment,{...facts,families:()=>[{familyFingerprint:'changed'}]}).contextFingerprint,packet.contextFingerprint);
 const regrouped=buildAgentContext([{do:'shopping-sesum-placement-review',sourceKey:c,relatedSources:[{sourceKey:a,sourceFingerprint:'a'},{sourceKey:b,sourceFingerprint:'b'}]}],assignment,facts);
 assert.equal(regrouped.jobs[0].items[0].sourceKey,a);assert.equal(regrouped.jobs[0].items[0].sourceFingerprint,'a');assert.deepEqual(regrouped.jobs[0].sourceKeys,[a,b]);assert.ok(!JSON.stringify(regrouped.jobs).includes(c));
});
test('queue reordering cannot replace an assigned feed or market task with another task',()=>{
 const old={do:'shopping-review',storeId:'one',fingerprint:'original'},assignment=agentManifest(shoppingAgentBatch([old]));
 const packet=buildAgentContext([{do:'shopping-review',storeId:'other'},old],assignment,facts);assert.deepEqual(packet.jobs.flatMap(j=>j.items),[old]);
 assert.throws(()=>buildAgentContext([], {...assignment,jobs:[...assignment.jobs,...assignment.jobs]},facts),/identity/);
});
test('placement protocol loads only its current contract and gives an explicit downstream guide path',()=>{
 const guide=shoppingProtocol(['shopping-sesum-placement-review']);assert.match(guide,/reviewedAllFamilies:true/);assert.match(guide,/noActiveFamilyVerified:true/);assert.doesNotMatch(guide,/Sesum-discovery:/);assert.match(guide,/shopping-agent-guide TYPE/);
 assert.match(shoppingProtocol(['shopping-sesum-discovery']),/shopping-sesum-register/);assert.match(shoppingProtocol(['shopping-product-review']),/HELE den konkrete ingredienslisten/);
});

test('context pages preserve whole evidence and index binding never trusts a copied fingerprint',()=>{
 const source='sesum-product:1',packet=buildAgentContext([{do:'shopping-sesum-placement-review',sourceKey:source}],agentManifest(shoppingAgentBatch([{do:'shopping-sesum-placement-review',sourceKey:source}])),{...facts,sources:key=>({sourceKey:key,placement:{sourceFingerprint:'exact-source',registrationFingerprint:null,familySetFingerprint:'exact-set',reviewDelta:{familiesToReview:['beans'],retainedTargets:[]}},label:'ø'.repeat(24000)})});
 const pages=agentContextPages(packet,2000);assert.ok(pages.sources.length>1);assert.ok(pages.sources.every(p=>JSON.stringify(p).length<2400));const text=pages.sources.map(p=>p.text).join('');assert.equal(JSON.parse(text).label,'ø'.repeat(24000));
 const bound=bindPlacementDecisions(packet,[{sourceIndex:0,sourceFingerprint:'wrong',status:'reviewed',reviewedAllFamilies:true,targets:[{familyIndex:0,equivalenceEvidence:'Actual label and family requirements reviewed.'}]}])[0];
 assert.equal(bound.sourceFingerprint,'exact-source');assert.equal(bound.familySetFingerprint,'exact-set');assert.equal(bound.targets[0].familyFingerprint,'criteria');assert.deepEqual(bound.reviewedFamilyIds,['beans']);
 assert.throws(()=>bindPlacementDecisions(packet,[{sourceIndex:1,targets:[]}]),/index/);
 const shared=bindPlacementDecisions(packet,{scopeEvidence:'All exact family criteria read.',reviewedAllFamilies:true,decisions:[{sourceIndexes:[0],status:'reviewed',targets:[{familyIndex:0,equivalenceEvidence:'Reviewed actual label and fixed pack.'}]}]});assert.equal(shared[0].reviewedAllFamilies,true);assert.equal(shared[0].scopeEvidence,'All exact family criteria read.');
 assert.throws(()=>bindPlacementDecisions(packet,[{sourceIndexes:[0,0],status:'blocked',targets:[]}]),/duplicate/);
});
