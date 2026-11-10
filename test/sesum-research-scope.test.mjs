import test from 'node:test';
import assert from 'node:assert/strict';
import {researchScope,groupPlacementWork,placementProof,placementDelta} from '../src/sesum-research-scope.mjs';
test('targeted discovery is brand independent, accent tolerant and fails open without complete family configuration',()=>{
 const f=[{familyId:'milk'},{familyId:'beans'}],terms={milk:['melk','mjølk'],beans:['kaffebønner']};
 assert.equal(researchScope({name:'New brand Kaffebonner 500g'},f,terms).candidate,true);
 assert.equal(researchScope({name:'Another brand Helmjølk 1l'},f,terms).candidate,true);
 assert.equal(researchScope({name:'Organic whole chicken'},f,terms).candidate,false);
 assert.equal(researchScope({name:'Unknown opaque brand'},f,{milk:['melk']}).candidate,true);
});
test('shared metadata groups research without losing chain-specific review inputs or mutating observations',()=>{
 const rows=[{sourceKey:'sesum:KIWI:1',fp:'same'},{sourceKey:'sesum:REMA_1000:1',fp:'same'},{sourceKey:'sesum:KIWI:2',fp:'different'}],before=JSON.stringify(rows),groups=groupPlacementWork(rows,x=>x.fp);
 assert.equal(groups.length,2);assert.equal(groups[0].sourceCount,2);assert.equal(groups[0].relatedSources[0].sourceKey,'sesum:REMA_1000:1');assert.equal(JSON.stringify(rows),before);
});
test('short category words do not match inside unrelated compounds',()=>{
 const families=[{familyId:'salt'},{familyId:'cheese'}],terms={salt:['salt'],cheese:['ost','gulost']};
 assert.equal(researchScope({name:'Frokostkjeks usaltet'},families,terms).candidate,false);
 assert.equal(researchScope({name:'Salt 1 kg'},families,terms).candidate,true);
 assert.equal(researchScope({name:'Norvegia Gulost'},families,terms).candidate,true);
});
test('review history reuses only an exact versioned basis and cannot bypass holds or reopen',()=>{
 const source={sourceKey:'sesum:KIWI:1',sourceFingerprint:'metadata'},old={...source,registrationFingerprint:null,familySetFingerprint:'old',status:'reviewed',reviewedAllFamilies:true,historyProofVersion:2,targets:[{familyId:'one'}]},latest={...old,familySetFingerprint:'new'};
 assert.equal(placementProof(source,'old',null,latest,[old]),old);
 for(const hold of [null,{...latest,status:'blocked'},{...latest,sourceFingerprint:'changed'}])assert.equal(placementProof(source,'old',null,hold,[old]),null);
 assert.equal(placementProof(source,'old',null,latest,[{...old,historyProofVersion:undefined}]),null);
 assert.equal(placementProof(source,'old',null,latest,[old,{...old,status:'reopen'}]),null);
 assert.equal(placementProof(source,'old','new-registration',latest,[old]),null);
});

test('per-family proof retains unchanged decisions and reopens only changed or new families',()=>{
 const source={sourceKey:'sesum:KIWI:1',sourceFingerprint:'metadata'},families=[{familyId:'a',familyFingerprint:'a1'},{familyId:'b',familyFingerprint:'b2'}];
 const latest={...source,status:'reviewed',registrationFingerprint:null,reviewedAllFamilies:true,familyProofVersion:1,reviewedFamilies:[families[0],{familyId:'b',familyFingerprint:'b1'}],targets:[{familyId:'a',familyFingerprint:'a1'}]};
 assert.deepEqual(placementDelta(source,null,latest,families).familiesToReview,['b']);
 assert.equal(placementProof(source,'new',null,latest,[],families),null);
 const unchanged=placementProof(source,'new',null,latest,[],[families[0]]);
 assert.equal(unchanged.familySetFingerprint,'new');assert.deepEqual(unchanged.targets,latest.targets);
 for(const changed of [{...latest,status:'blocked'},{...latest,familyProofVersion:undefined},{...latest,registrationFingerprint:'changed'},{...latest,sourceFingerprint:'changed'}])assert.deepEqual(placementDelta(source,null,changed,families).familiesToReview,['a','b']);
});
