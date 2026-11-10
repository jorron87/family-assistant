import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';
import {agentManifest,buildAgentContext,agentContextPages,bindPlacementDecisions,agentFamilyBasis,agentContextSummary,agentStartupContext,agentContextView} from '../src/shopping-agent-context.mjs';
import {shoppingProtocol} from '../src/shopping-agent-protocol.mjs';
const facts={families:()=>[{familyId:'beans',familyFingerprint:'criteria'}],sources:key=>({sourceKey:key,ingredients:'Coffee beans'}),products:key=>({key})};

test('family prompt contains every complete criterion and shortcut requires identical current data',()=>{
 const families=Array.from({length:91},(_,i)=>({familyId:'family-'+i,familyFingerprint:'fp-'+i,note:'ø'.repeat(3000),variants:[{requires:['actual label '+i]}]}));
 const basis=agentFamilyBasis(families),document=JSON.parse(basis.prompt.split('\n')[1]);
 assert.deepEqual(document.families,families.map((f,familyIndex)=>({...f,familyIndex})));
 const packet={version:1,jobs:[],families,sources:[],products:[]};
 assert.equal(agentContextSummary(packet,basis.familyBasisFingerprint).pages.families,0);
 assert.ok(agentContextSummary(packet).pages.families>0,'manual requests retain all family pages');
 families[90].note+=' changed';assert.equal(agentContextSummary(packet,basis.familyBasisFingerprint).familiesProvidedInPrompt,false);
 assert.ok(agentContextSummary(packet,basis.familyBasisFingerprint).pages.families>0);
});

test('repeated long evidence uses lossless explicit text references without changing raw context',()=>{
 const text='Actual complete label ø '.repeat(100),packet={version:1,jobs:[],families:[],sources:[{sourceKey:'one',label:text},{sourceKey:'two',label:text}],products:[]};
 const pages=agentContextPages(packet),rows=pages.sources.flatMap(p=>p.items),texts=pages.texts.flatMap(p=>p.items);
 assert.equal(texts.length,1);for(const row of rows)assert.equal(texts[row.label.contextTextIndex].text,text);
 assert.equal(packet.sources[0].label,text);assert.equal(packet.sources[1].label,text);
});

test('bounded startup supplies the complete source view and falls back to full pages for large packets',()=>{
 const packet={version:1,contextFingerprint:'current',assignmentChanges:[],activeStagesEmpty:false,jobs:[{id:'one'}],families:facts.families(),sources:[{sourceKey:'sesum-product:1',label:'Full original label ø '.repeat(500)}],products:[]};
 const startup=agentStartupContext(packet,'tmp/context.json'),view=agentContextView(packet);
 assert.equal(startup.contextIncluded,true);assert.ok(startup.prompt.startsWith(agentFamilyBasis(packet.families).prompt));
 const document=JSON.parse(startup.prompt.split('\n').find(line=>line.startsWith('{"contextFile"')));
 const {families,...rest}=view;for(const [key,value] of Object.entries(rest))assert.deepEqual(document[key],value);
 assert.equal(document.contextFile,'tmp/context.json');assert.equal(document.contextFingerprint,'current');
 const large=agentStartupContext(packet,'tmp/context.json',1000);assert.equal(large.contextIncluded,false);assert.equal(large.prompt,agentFamilyBasis(packet.families).prompt);
 assert.ok(agentContextPages(packet).sources.length>0,'fallback retains complete paged evidence');
 const noPrefix=agentStartupContext({...packet,families:[{familyId:'huge',criteria:'ø'.repeat(5000)}]},'tmp/context.json',1000);assert.equal(noPrefix.prompt,'');assert.equal(noPrefix.familyBasisFingerprint,null);assert.equal(noPrefix.contextIncluded,false);
});
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
