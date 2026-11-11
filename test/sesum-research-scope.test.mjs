import test from 'node:test';
import assert from 'node:assert/strict';
import {researchScope,createResearchScope,groupPlacementWork,placementProof,placementDelta} from '../src/sesum-research-scope.mjs';

test('current explicit scope equivalence reuses the latest positive without reviving an older negative or changing its read time',()=>{
 const source={sourceKey:'sesum:KIWI:1',sourceFingerprint:'source'},families=[{familyId:'vegetable',familyFingerprint:'parent-scope',equivalentFamilyFingerprints:['parent-with-covered-child']}],latest={sourceKey:source.sourceKey,sourceFingerprint:'source',registrationFingerprint:'registered',familySetFingerprint:'old-expanded-set',status:'reviewed',reviewedAllFamilies:true,familyProofVersion:1,reviewedFamilies:[{familyId:'vegetable',familyFingerprint:'parent-with-covered-child'}],targets:[{familyId:'vegetable',familyFingerprint:'parent-with-covered-child',equivalenceEvidence:'Actual current positive ingredient and form assessment.'}],reviewedAt:'2026-11-10T12:00:00Z'},older={...latest,status:'no-active-family',targets:[],familySetFingerprint:'current-parent-set',historyProofVersion:2};
 const proof=placementProof(source,'current-parent-set','registered',latest,[older],families);assert.equal(proof.status,'reviewed');assert.equal(proof.targets[0].familyFingerprint,'parent-scope');assert.equal(proof.reviewedAt,latest.reviewedAt);assert.equal(latest.targets[0].familyFingerprint,'parent-with-covered-child');assert.deepEqual(placementDelta(source,'registered',latest,families).familiesToReview,[]);
 assert.equal(placementProof({...source,sourceFingerprint:'changed'},'current-parent-set','registered',latest,[],families),null);
 assert.equal(placementProof(source,'changed-set','registered',latest,[],[{familyId:'vegetable',familyFingerprint:'new-actual-requirements'}]),null);
 assert.equal(placementProof(source,'current-parent-set','registered',{...latest,status:'blocked'},[older],families),null);
});

test('compiled routing preserves all results and a later read recompiles changed terms',()=>{
 const families=[{familyId:'milk'},{familyId:'salt'},{familyId:'cheese'},{familyId:'beans'}],terms={milk:['melk','mjølk'],salt:['salt'],cheese:['ost','gulost',null,'ab'],beans:['kaffebønner']};
 const original=(source,f,t)=>{
  if(!t||f.some(x=>!Array.isArray(t[x.familyId])||!t[x.familyId].length))return {mode:'unrestricted',candidate:true};
  const fold=s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('nb').replace(/ø/g,'o').replace(/æ/g,'ae'),name=fold(source.name),words=new Set(name.match(/[\p{L}\d]+/gu)??[]),matches=f.filter(x=>t[x.familyId].some(v=>{if(typeof v!=='string'||v.trim().length<3)return false;const term=fold(v).trim();return term.length<=4?words.has(term):name.includes(term);})).map(x=>x.familyId);
  return {mode:'targeted-discovery',candidate:matches.length>0,familyIds:matches,reason:matches.length?'category-term-candidate':'outside-configured-discovery-terms'};
 };
 const names=['Helmjølk','Melk og salt','Frokostkjeks usaltet','Gulost','Kaffebonner 500g','Opaque brand','SALT','Økologisk ost','mélk'];
 for(const config of [terms,null,{}, {...terms,milk:[]}]){const compiled=createResearchScope(families,config);for(const name of names)assert.deepEqual(compiled({name}),original({name},families,config));}
 const old=createResearchScope(families,terms);terms.beans=['espresso'];assert.equal(old({name:'Kaffebønner'}).candidate,true);assert.equal(createResearchScope(families,terms)({name:'Kaffebønner'}).candidate,false);
});
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
