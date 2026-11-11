import test from 'node:test';
import assert from 'node:assert/strict';
import {researchScope,createResearchScope,groupPlacementWork,placementProof,placementDelta,familyBasisIndex} from '../src/sesum-research-scope.mjs';
import {createHash} from 'node:crypto';

test('exact historical criteria hashes restore only this source own legacy whole-set decisions',()=>{
 const old=[{familyId:'coffee',familyFingerprint:'coffee1',unit:'kg'},{familyId:'vegetables',familyFingerprint:'vegetables1',unit:'kg'}],fingerprint=createHash('sha256').update(JSON.stringify(old.map(f=>[f.familyId,f.familyFingerprint]))).digest('hex').slice(0,24);
 const witness={familySetFingerprint:fingerprint,status:'reviewed',reviewedAllFamilies:true,familyProofVersion:1,reviewedFamilies:old};
 const bases=familyBasisIndex([witness]),source={sourceKey:'source:own',sourceFingerprint:'own-facts'},latest={...source,registrationFingerprint:null,familySetFingerprint:fingerprint,status:'no-active-family',reviewedAllFamilies:true,noActiveFamilyVerified:true,scopeEvidence:'Actually read all the original family criteria against this source.',targets:[],reviewedAt:'2026-11-10T12:00:00Z'};
 const families=[old[0],{...old[1],familyFingerprint:'vegetables2'}],delta=placementDelta(source,null,latest,families,bases);
 assert.deepEqual(delta.retainedFamilyIds,['coffee']);assert.deepEqual(delta.familiesToReview,['vegetables']);assert.equal(delta.recoveredFamilyBasis,fingerprint);
 const proof=placementProof(source,'same-criteria-new-set',null,latest,[],old,bases);assert.equal(proof.status,'no-active-family');assert.equal(proof.reviewedAt,latest.reviewedAt);assert.equal(latest.familySetFingerprint,fingerprint);
 for(const changed of [{...latest,status:'reopen'},{...latest,status:'blocked'},{...latest,sourceKey:'other'},{...latest,sourceFingerprint:'changed'},{...latest,registrationFingerprint:'changed'},{...latest,reviewedAllFamilies:false},{...latest,noActiveFamilyVerified:false},{...latest,scopeEvidence:''},{...latest,familyProofVersion:2}])assert.equal(placementDelta(source,null,changed,families,bases).familiesToReview.length,2);
 for(const invalid of [{...witness,familySetFingerprint:'guessed'},{...witness,reviewedFamilies:[old[0],old[0]]},{...witness,status:'reopen'},{...witness,familyProofVersion:undefined},{...witness,reviewedAllFamilies:false}])assert.equal(familyBasisIndex([invalid]).size,0);
 assert.equal(familyBasisIndex([{...witness,familySetFingerprint:'bad'},witness]).size,1);
 const positive={...latest,status:'reviewed',targets:[{...old[0],equivalenceEvidence:'Actual reviewed original whole-bean ingredients and form.'}]};
 assert.equal(placementDelta(source,null,positive,families,bases).retainedTargets.length,1);
 assert.equal(placementDelta(source,null,{...positive,targets:[{...positive.targets[0],familyFingerprint:'guessed'}]},families,bases).retainedTargets.length,0);
 assert.equal(placementDelta(source,null,{...latest,targets:[],reviewedAllFamilies:undefined},families,bases).retainedFamilyIds.length,0,'a peer review never approves another source');
});

test('code rejects only incompatible current canonical units and never invents a positive target',()=>{
 const source={sourceKey:'source:soap',sourceFingerprint:'facts',placementUnit:'l'},families=[{familyId:'soap',familyFingerprint:'s1',unit:'l'},{familyId:'vegetables',familyFingerprint:'v2',unit:'kg'},{familyId:'unknown',familyFingerprint:'u1'}],latest={...source,registrationFingerprint:'approved',status:'reviewed',reviewedAllFamilies:true,familyProofVersion:1,reviewedFamilies:[families[0],{...families[1],familyFingerprint:'v1'},families[2]],targets:[{...families[0],equivalenceEvidence:'Actual reviewed liquid soap contents and fixed pack.'}],reviewedAt:'2026-11-10T12:00:00Z'};
 const d=placementDelta(source,'approved',latest,families);assert.deepEqual(d.familiesToReview,[]);assert.deepEqual(d.codeExcludedFamilies,[{familyId:'vegetables',familyFingerprint:'v2',rule:'canonical-unit-mismatch-v1',sourceUnit:'l',familyUnit:'kg'}]);
 const proof=placementProof(source,'new-set','approved',latest,[],families);assert.equal(proof.targets.length,1);assert.equal(proof.targets[0].familyId,'soap');assert.equal(proof.reviewedAt,latest.reviewedAt);
 for(const unit of [undefined,null,'guessed',''])assert.deepEqual(placementDelta({...source,placementUnit:unit},'approved',latest,families).familiesToReview,['vegetables']);
 assert.deepEqual(placementDelta(source,'approved',null,families).familiesToReview,['soap','unknown'],'unknown identity still needs all potentially matching families');
 assert.equal(placementProof(source,'new-set','changed-registration',latest,[],families),null);
});

test('unchanged identity holds retain their retry across a changed checklist without reviving any approval',()=>{
 const source={sourceKey:'source:unknown',sourceFingerprint:'facts'},latest={...source,registrationFingerprint:null,familySetFingerprint:'old',status:'blocked',reason:'The actual original ingredient label is unavailable.',evidence:'The unreadable actual source was checked.',retryAt:'2026-11-11T12:00:00Z',reviewedAt:'2026-11-10T12:00:00Z'};
 assert.equal(placementProof(source,'changed-checklist',null,latest),latest);
 for(const changed of [{...latest,status:'reopen'},{...latest,retryAt:null},{...latest,sourceFingerprint:'changed'},{...latest,sourceKey:'other'},{...latest,registrationFingerprint:'new'}])assert.equal(placementProof(source,'changed-checklist',null,changed),null);
});

test('a 91-family corpus retains historical negatives, routes every genuine change and preserves unmapped newcomers',()=>{
 const old=Array.from({length:91},(_,i)=>({familyId:'family-'+String(i).padStart(2,'0'),familyFingerprint:'original-'+i,unit:['kg','l','stk'][i%3]}));
 const fingerprint=createHash('sha256').update(JSON.stringify(old.map(f=>[f.familyId,f.familyFingerprint]))).digest('hex').slice(0,24),witness={familySetFingerprint:fingerprint,status:'reviewed',reviewedAllFamilies:true,familyProofVersion:1,reviewedFamilies:old};
 const bases=familyBasisIndex([witness]),current=old.map((f,i)=>i===0?{...f,familyFingerprint:'actual-expanded-vegetable-scope'}:f);
 for(let i=0;i<1000;i++){
  const source={sourceKey:'source:'+i,sourceFingerprint:'unchanged-'+i,...(i%4?{placementUnit:['kg','l','stk'][i%3]}:{})};
  const latest={...source,registrationFingerprint:null,familySetFingerprint:fingerprint,status:'no-active-family',reviewedAllFamilies:true,noActiveFamilyVerified:true,scopeEvidence:'Read the complete historical family set against the actual product facts.',targets:[],reviewedAt:'2026-11-10T12:00:00Z'};
  const before=JSON.stringify(latest),delta=placementDelta(source,null,latest,current,bases),cannotMatch=source.placementUnit&&source.placementUnit!=='kg';
  assert.deepEqual(delta.familiesToReview,cannotMatch?[]:['family-00']);
  assert.equal(delta.retainedFamilyIds.length,90);assert.deepEqual(delta.retainedTargets,[]);
  const proof=placementProof(source,'changed-family-set',null,latest,[],current,bases);
  assert.equal(!!proof,!!cannotMatch);if(proof){assert.equal(proof.status,'no-active-family');assert.equal(proof.reviewedAt,latest.reviewedAt);}
  assert.equal(JSON.stringify(latest),before);
  const newcomer=placementDelta({...source,sourceKey:'new-unmapped-'+i},null,null,current,bases);
  assert.ok(newcomer.familiesToReview.includes('family-00')===!cannotMatch,'unmapped candidates with compatible or unknown units always remain');
  assert.equal(newcomer.retainedFamilyIds.length,0);assert.equal(newcomer.retainedTargets.length,0);
  const changed=placementDelta({...source,sourceFingerprint:'changed-actual-facts'},null,latest,current,bases);
  assert.equal(changed.retainedFamilyIds.length,0,'changed source facts never reuse historical family verdicts');
 }
});

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
