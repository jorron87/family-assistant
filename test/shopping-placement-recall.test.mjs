import test from 'node:test';import assert from 'node:assert/strict';
import {placementRecallHints,guardNegativePlacement} from '../src/shopping-placement-recall.mjs';
test('label recall finds an alternative family independently of the misleading source name without approving it',()=>{
 const packet={families:[{familyId:'beans',name:'Hele kaffebønner'},{familyId:'ground',name:'Filtermalt kaffe'},{familyId:'capsules',name:'Kaffekapsler'}],sources:[{sourceKey:'sesum-product:1',observation:{source:{name:'Hele kaffebønner'}}}]},research=[{sourceKey:'sesum-product:1',notes:[{labelText:'100% brent kaffe, filtermalt. Ikke hele bønner. Fast netto 500 g.'}]}],recall=placementRecallHints(packet,research),hints=recall[0].hints;
 assert.deepEqual(hints.map(h=>[h.familyId,h.basis]),[['beans','metadata-name-only'],['ground','actual-label-text']]);assert.equal(packet.sources[0].reviewedIdentity,undefined);
 const row={sourceKey:'sesum-product:1',status:'no-active-family',evidence:'The heading does not prove whole beans.',negativeFamilyAssessments:[{familyIndex:0,evidence:'Actual filter-ground form excludes whole beans.'}]};assert.throws(()=>guardNegativePlacement(packet,{decisions:[row]},recall),/Filtermalt kaffe/);
 assert.deepEqual(guardNegativePlacement(packet,{decisions:[{sourceKey:row.sourceKey,status:'blocked'}]},recall),{decisions:[{sourceKey:row.sourceKey,status:'blocked'}]},'no hint can force approval');
});
test('negated label tokens are recall questions and concrete negative reasoning is preserved with the actual domain evidence',()=>{
 const packet={families:[{familyId:'nuts',name:'Mandler'}],sources:[{sourceKey:'sesum-product:2',observation:{source:{name:'Synthetic confection'}}}]},recall=placementRecallHints(packet,[{sourceKey:'sesum-product:2',notes:[{labelText:'Sukker og aroma; inneholder ikke mandler.'}]}]),input={reviewedAllFamilies:true,decisions:[{sourceKeys:['sesum-product:2'],status:'no-active-family',evidence:'Actual contents are confectionery.',negativeFamilyAssessments:[{familyIndex:0,evidence:'Actual label explicitly excludes almonds; this is sugar confectionery.'}]}]};
 assert.equal(recall[0].hints[0].familyId,'nuts');const guarded=guardNegativePlacement(packet,input,recall);assert.match(guarded.decisions[0].evidence,/explicitly excludes almonds/);assert.equal(guarded.decisions[0].status,'no-active-family');assert.equal(input.decisions[0].evidence,'Actual contents are confectionery.');
});

test('broad family names use discovery and reviewed group candidates without inheriting any approval',()=>{
 const packet={families:[{familyId:'vegetables',name:'Frosne grønnsaker naturell – flere typer',variants:[{groupId:'frozen-mix'}]},{familyId:'organic-only',name:'Et smalt eksakt husholdningskrav',variants:[{groupId:'frozen-mix',requires:['organic'],brands:['Required brand']}]}],sources:[{sourceKey:'sesum-product:3',observation:{source:{name:'Brokkoliblanding 500g'}},placement:{discoveryScope:{familyIds:['vegetables','unknown-family']}},reviewedIdentity:{groups:[{groupId:'frozen-mix'}],product:{ingredients:'Brokkoli, blomkål og gulrot',attributes:{organic:false},brand:'Other brand'}}}]};
 const before=structuredClone(packet),recall=placementRecallHints(packet);assert.deepEqual(recall[0].hints.map(h=>h.familyId),['vegetables','organic-only']);assert.ok(recall[0].hints.every(h=>h.basis==='reviewed-group-candidate'));assert.deepEqual(packet,before);
 assert.throws(()=>guardNegativePlacement(packet,[{sourceKey:'sesum-product:3',status:'no-active-family',evidence:'The actual product name does not match a full family name.'}],recall),/Frosne grønnsaker/);
 const blocked=[{sourceKey:'sesum-product:3',status:'blocked',reason:'Primary contents or the required organic declaration remain uncertain.'}];assert.deepEqual(guardNegativePlacement(packet,blocked,recall),blocked);
 delete packet.sources[0].reviewedIdentity;const discoveryOnly=placementRecallHints(packet)[0].hints;assert.deepEqual(discoveryOnly.map(h=>[h.familyId,h.basis]),[['vegetables','discovery-term-candidate']]);
});

test('incremental recall asks only genuinely pending families and keeps original family indexes',()=>{
 const packet={families:[{familyId:'old',name:'Mandler'},{familyId:'new',name:'Frosne grønnsaker naturell – flere typer'},{familyId:'unit-excluded',name:'Flytende såpe'}],sources:[{sourceKey:'sesum-product:4',observation:{source:{name:'Mandler'}},placement:{reviewDelta:{familiesToReview:['new']},discoveryScope:{familyIds:['old','new','unit-excluded']}}}]};
 const recall=placementRecallHints(packet);assert.deepEqual(recall[0].hints.map(h=>[h.familyId,h.familyIndex]),[['new',1]]);
 const negative={sourceKey:'sesum-product:4',status:'no-active-family',evidence:'Actual almonds are not a frozen vegetable mixture.',negativeFamilyAssessments:[{familyIndex:1,evidence:'The complete original label documents almonds; the changed family requires frozen vegetables.'}]};
 assert.equal(guardNegativePlacement(packet,[negative],recall)[0].status,'no-active-family');
 packet.sources[0].placement.reviewDelta.familiesToReview=[];assert.deepEqual(placementRecallHints(packet)[0].hints,[]);
});
