import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingAgentBatch} from '../src/shopping-agent-jobs.mjs';
import {agentManifest,buildAgentContext,agentContextPages,bindPlacementDecisions,agentFamilyBasis,agentContextSummary,agentStartupContext,agentContextView} from '../src/shopping-agent-context.mjs';
import {shoppingProtocol} from '../src/shopping-agent-protocol.mjs';
const facts={families:()=>[{familyId:'beans',familyFingerprint:'criteria'}],sources:key=>({sourceKey:key,ingredients:'Coffee beans'}),products:key=>({key})};

test('binding normalizes only a genuinely missing empty target list for an explicit evidenced negative or hold',()=>{
 const sourceKey='sesum-product:1',queue=[{do:'shopping-sesum-placement-review',sourceKey}],packet=buildAgentContext(queue,agentManifest(shoppingAgentBatch(queue)),{...facts,sources:key=>({sourceKey:key,placement:{sourceFingerprint:'source',registrationFingerprint:null,familySetFingerprint:'set',reviewDelta:{familiesToReview:['beans'],retainedTargets:[]}}})});
 const negative={sourceIndex:0,status:'no-active-family',reviewedAllFamilies:true,noActiveFamilyVerified:true,scopeEvidence:'Read all actual family criteria against the complete original product facts.',evidence:'The actual whole label is an incompatible household cleaning formula.'};
 assert.deepEqual(bindPlacementDecisions(packet,[negative])[0].targets,[]);assert.equal(Object.hasOwn(negative,'targets'),false);
 const hold={sourceIndex:0,status:'blocked',evidence:'The actual ingredient label is unreadable.',reason:'The primary ingredient label must be obtained before placement.',retryAt:'2026-11-12T12:00:00Z'};
 assert.deepEqual(bindPlacementDecisions(packet,[hold])[0].targets,[]);
 for(const targets of [null,undefined,'',0,{}])assert.throws(()=>bindPlacementDecisions(packet,[{...negative,targets}]),/explicit array/);
 for(const change of [{status:'reviewed'},{noActiveFamilyVerified:false},{reviewedAllFamilies:false},{scopeEvidence:''},{evidence:''}])assert.throws(()=>bindPlacementDecisions(packet,[{...negative,...change}]),/explicit array/);
 assert.throws(()=>bindPlacementDecisions(packet,[{...hold,reason:''}]),/explicit array/);
 assert.throws(()=>bindPlacementDecisions(packet,{targets:[{familyIndex:0,equivalenceEvidence:'A contradictory shared positive may not be silently discarded.'}],decisions:[negative]}),/top-level targets/);
 assert.deepEqual(bindPlacementDecisions(packet,[{...negative,targets:[]}])[0].targets,[]);
});

test('own counted-pack evidence is reused only for unchanged source facts and explicit invalid input is preserved for domain rejection',()=>{
 const sourceKey='sesum-product:1',queue=[{do:'shopping-sesum-placement-review',sourceKey}],countedPack={reviewed:true,wholePack:true,sourceCount:8,packAmount:.32,unit:'kg',evidence:'Original whole-pack measurement already read on this exact unchanged source.'};
 const packet=buildAgentContext(queue,agentManifest(shoppingAgentBatch(queue)),{...facts,sources:key=>({sourceKey:key,placement:{sourceFingerprint:'current',registrationFingerprint:null,familySetFingerprint:'set',review:{sourceFingerprint:'current',countedPack},reviewDelta:{familiesToReview:['beans'],retainedTargets:[]}}})});
 const input={sourceIndex:0,status:'reviewed',targets:[{familyIndex:0,equivalenceEvidence:'Actual complete source facts match this current family.'}]};
 assert.deepEqual(bindPlacementDecisions(packet,[input])[0].countedPack,countedPack);assert.equal(bindPlacementDecisions(packet,[{...input,countedPack:null}])[0].countedPack,null);
 packet.sources[0].placement.review.sourceFingerprint='stale';assert.equal(bindPlacementDecisions(packet,[input])[0].countedPack,undefined);
});

test('incremental binding preserves current retained positives and cannot reverse unchanged negatives',()=>{
 const source='sesum-product:1',queue=[{do:'shopping-sesum-placement-review',sourceKey:source}],retained={familyId:'beans',familyFingerprint:'criteria',equivalenceEvidence:'Original actually reviewed source-family proof.'},packet=buildAgentContext(queue,agentManifest(shoppingAgentBatch(queue)),{...facts,families:()=>[...facts.families(),{familyId:'new-family',familyFingerprint:'new-criteria'},{familyId:'held-negative',familyFingerprint:'held'}],sources:key=>({sourceKey:key,placement:{sourceFingerprint:'source',registrationFingerprint:null,familySetFingerprint:'set',reviewDelta:{familiesToReview:['new-family'],retainedTargets:[retained]}}})});
 const input={sourceIndex:0,status:'reviewed',reviewedAllFamilies:true,evidence:'The complete actual source and current family criteria were reviewed.',scopeEvidence:'Actual unchanged and new family requirements were checked.',targets:[{familyIndex:0,equivalenceEvidence:'Redundant restatement of an already reviewed positive.'},{familyIndex:1,equivalenceEvidence:'Actual source facts match the genuinely new family.'}]},before=structuredClone(packet);
 const bound=bindPlacementDecisions(packet,[input])[0];assert.deepEqual(bound.reviewedFamilyIds,['new-family']);assert.deepEqual(bound.targets.map(t=>t.familyId),['new-family']);assert.deepEqual(packet,before);assert.equal(packet.sources[0].placement.reviewDelta.retainedTargets[0].equivalenceEvidence,retained.equivalenceEvidence);
 assert.throws(()=>bindPlacementDecisions(packet,[{...input,targets:[{familyIndex:2,equivalenceEvidence:'New unsupported reversal of an unchanged negative.'}]}]),/explicit reopen|family audit/);
});

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

test('compact placement bindings preserve every semantic field and never change the bound write',()=>{
 const key='sesum-product:1',assignment=agentManifest(shoppingAgentBatch([{do:'shopping-sesum-placement-review',sourceKey:key}]));
 const packet=buildAgentContext([{do:'shopping-sesum-placement-review',sourceKey:key}],assignment,{...facts,sources:key=>({sourceKey:key,observation:{sourceFingerprint:'exact-source',source:{id:'1',name:'Actual whole beans',weight:500,weightUnit:'g'}},placement:{sourceFingerprint:'exact-source',registrationFingerprint:null,familySetFingerprint:'exact-set',reviewDelta:{familiesToReview:['beans'],retainedTargets:[]}},ingredients:'Coffee beans',priorExclusion:{reason:'Concrete previously excluded variant',sourceFingerprint:'previous'}})});
 const original=structuredClone(packet),startup=agentStartupContext(packet,'context.json',400000,{compactBindings:true}),full=agentStartupContext(packet,'context.json');
 assert.ok(startup.prompt.length<full.prompt.length);assert.deepEqual(packet,original);
 const data=JSON.parse(startup.prompt.split('\n').find(line=>line.startsWith('{"contextFile"'))),familyData=JSON.parse(startup.prompt.split('\n')[1]);assert.equal(data.bindingsInContextFile,true);
 assert.equal(data.sources[0].ingredients,'Coffee beans');assert.equal(data.sources[0].priorExclusion.reason,'Concrete previously excluded variant');assert.equal(data.sources[0].observation.source.weight,500);assert.equal(familyData.families[0].familyId,'beans');assert.equal(familyData.families[0].familyFingerprint,undefined);
 assert.equal(data.contextFingerprint,packet.contextFingerprint);assert.equal(data.familyBasisFingerprint,agentFamilyBasis(packet.families).familyBasisFingerprint);
 const bound=bindPlacementDecisions(packet,[{sourceIndex:0,status:'reviewed',targets:[{familyIndex:0,equivalenceEvidence:'Read original whole beans and documented fixed pack.'}]}])[0];assert.equal(bound.sourceFingerprint,'exact-source');assert.equal(bound.familySetFingerprint,'exact-set');assert.equal(bound.targets[0].familyFingerprint,'criteria');
 const multiStage=structuredClone(packet);multiStage.jobs[0].items.push({do:'shopping-sesum-family-review',sourceKey:key});const other=agentStartupContext(multiStage,'context.json',400000,{compactBindings:true});assert.equal(JSON.parse(other.prompt.split('\n')[1]).bindingsInContextFile,false);
});

test('complete context is reused only when the actually supplied packet and family basis are still identical',()=>{
 const packet={version:1,contextFingerprint:'current-complete-packet',jobs:[],families:facts.families(),sources:[{sourceKey:'sesum-product:1',label:'Actual source label'}],products:[]},basis=agentFamilyBasis(packet.families);
 const same=agentContextSummary(packet,basis.familyBasisFingerprint,packet.contextFingerprint);assert.equal(same.contextDataProvidedInPrompt,true);assert.ok(Object.values(same.pages).every(n=>n===0));
 const changed=agentContextSummary({...packet,contextFingerprint:'new-label-or-review'},basis.familyBasisFingerprint,packet.contextFingerprint);assert.equal(changed.contextDataProvidedInPrompt,false);assert.ok(changed.pages.sources>0);assert.equal(changed.pages.families,0);
 const familyChanged=agentContextSummary(packet,'old-family-basis',packet.contextFingerprint);assert.equal(familyChanged.contextDataProvidedInPrompt,false);assert.ok(familyChanged.pages.families>0);
 const manual=agentContextSummary(packet);assert.equal(manual.contextDataProvidedInPrompt,false);assert.ok(manual.pages.sources>0);
});

test('compact bindings retain explicit stale group and prior-review comparisons',()=>{
 const packet={version:1,contextFingerprint:'current',assignmentChanges:[],activeStagesEmpty:false,jobs:[{items:[{do:'shopping-sesum-placement-review'}]}],families:[{familyId:'beans',variants:[{groupId:'actual-group',groupFingerprint:'new-rules',reviewedGroupFingerprint:'old-rules',group:{inclusion:'Current complete inclusion rule'}}]}],sources:[{sourceKey:'sesum-product:1',placement:{sourceFingerprint:'new-source',registrationFingerprint:'new-identity',familySetFingerprint:'new-families',review:{sourceFingerprint:'old-source',registrationFingerprint:'old-identity',familySetFingerprint:'old-families',evidence:'Old concrete evidence stays visible'}},nativeFamilyReviews:[{fingerprint:'new-metadata',status:'pending',review:{fingerprint:'old-metadata',status:'approved'}}]}],products:[]};
 const startup=agentStartupContext(packet,'context.json',400000,{compactBindings:true}),family=JSON.parse(startup.prompt.split('\n')[1]),data=JSON.parse(startup.prompt.split('\n').find(line=>line.startsWith('{"contextFile"')));
 assert.equal(family.families[0].variants[0].groupReviewCurrent,false);assert.equal(family.families[0].variants[0].group.inclusion,'Current complete inclusion rule');
 assert.deepEqual(data.sources[0].placement.priorReviewBindings,{sourceCurrent:false,registrationCurrent:false,familySetCurrent:false});assert.equal(data.sources[0].placement.review.evidence,'Old concrete evidence stays visible');assert.equal(data.sources[0].nativeFamilyReviews[0].reviewBindingCurrent,false);
 packet.families[0].variants[0].reviewedGroupFingerprint='new-rules';assert.equal(JSON.parse(agentStartupContext(packet,'context.json',400000,{compactBindings:true}).prompt.split('\n')[1]).families[0].variants[0].groupReviewCurrent,true);
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
