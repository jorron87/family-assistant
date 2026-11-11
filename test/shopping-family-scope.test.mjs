import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scopeCoverageCurrent,effectiveScopeVariants} from '../src/shopping-family-scope.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';

const evidence='Read both complete definitions: the organic subclass meets every existing plain-product criterion, with additional production facts only.';
const parent={groupId:'plain',groupFingerprint:'parent-fp',brands:['Required Brand'],requires:['plain'],excludeProductKeys:['held-product']};
const child={groupId:'organic',groupFingerprint:'child-fp',brands:['Required Brand'],requires:['plain','organic'],excludeProductKeys:['held-product'],scopeCoverage:{groupId:'plain',groupFingerprint:'parent-fp',childGroupFingerprint:'child-fp',reviewed:true,evidence}};
const groups=new Map([['plain',{unit:'kg',fingerprint:'parent-fp'}],['organic',{unit:'kg',fingerprint:'child-fp'}]]),group=id=>groups.get(id);

test('explicit current subgroup coverage keeps every real variant but reuses the unchanged scope',()=>{
 const links=[parent,child];assert.equal(scopeCoverageCurrent(child,links,group),true);assert.deepEqual(effectiveScopeVariants(links,group),[parent]);assert.equal(links.length,2);assert.ok(links[1].scopeCoverage.evidence.includes('complete definitions'));
});

test('coverage cannot bypass changed definitions, brand requirements, attributes, exclusions, or missing explicit review',()=>{
 for(const patch of [{brands:[]},{requires:['organic']},{excludeProductKeys:[]},{groupFingerprint:'stale'}, {scopeCoverage:{...child.scopeCoverage,reviewed:false}},{scopeCoverage:{...child.scopeCoverage,groupFingerprint:'old'}},{scopeCoverage:{...child.scopeCoverage,evidence:'short'}}]){const proposed={...child,...patch};assert.equal(scopeCoverageCurrent(proposed,[parent,proposed],group),false);assert.equal(effectiveScopeVariants([parent,proposed],group).length,2);}
 assert.equal(scopeCoverageCurrent(child,[parent,child],id=>({...group(id),fingerprint:id==='organic'?'changed':group(id).fingerprint})),false);
 assert.equal(scopeCoverageCurrent(child,[parent,child],id=>({...group(id),unit:id==='organic'?'l':'kg'})),false);
 assert.equal(scopeCoverageCurrent(child,[child],group),false);
 assert.equal(scopeCoverageCurrent(child,[{...parent,scopeCoverage:{...child.scopeCoverage}},child],group),false,'a cycle or nested unreviewed inference cannot establish coverage');
});

test('a reviewed subgroup does not reopen global placement; changed or genuinely wider scope still does',t=>{
 const dir=mkdtempSync(join(tmpdir(),'family-scope-'));t.after(()=>{assert.ok(dir.startsWith(join(tmpdir(),'family-scope-')));rmSync(dir,{recursive:true,force:true});});
 const definition=(id,name,criteria)=>({id,name,category:'Synthetic vegetables',canonicalUnit:'kg',inclusionCriteria:criteria,exclusions:['Added flavours or mixtures'],qualityBasis:'Actual complete ingredient and production label.',comparisonBasis:'Same physical form and use, per documented kilogram.'}),base=definition('plain','Plain fresh vegetable','Plain fresh single-ingredient vegetable.'),organic=definition('organic','Organic fresh vegetable','Plain fresh single-ingredient vegetable. Additionally certified organic.');
 const p={productKey:'kassal:KIWI:1',source:'kassal',store:'KIWI',id:'1',name:'Synthetic organic fresh vegetable 1kg',brand:'Synthetic',ean:null,ingredients:'Single plain fresh vegetable.',description:'Actual synthetic plain raw form, certified organic.',canonicalPackAmount:1,unit:'kg',packEvidence:'Actual synthetic sealed 1kg pack.',rawPack:{weight:1000,weightUnit:'g'},attributes:{organic:true},nutrition:null,sourceUrl:'https://example.test/label'};p.metadataFingerprint=productMetadataFingerprint(p);
 const file=join(dir,'library.json'),data={schemaVersion:1,createdAt:'2026-11-10T12:00:00Z',updatedAt:'2026-11-10T12:00:00Z',groups:[base,organic],products:[p],memberships:[{groupId:'organic',productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(organic),equivalenceEvidence:evidence,qualityEvidence:'Actual certified organic production is preserved as a visible difference.',reviewedAt:'2026-11-10T12:00:00Z',sourceReceipts:[{url:p.sourceUrl,observedAt:'2026-11-10T12:00:00Z',evidence:'Complete actual synthetic label and fixed kilogram pack.'}]}],prices:[{productKey:p.productKey,grossPackPrice:20,receiptAt:'2026-11-10T12:00:00Z',sourceUrl:p.sourceUrl,availabilityScope:'chain'}]};writeFileSync(file,JSON.stringify(data));
 const provider=libraryPriceProvider(file,{now:()=>new Date('2026-11-10T12:00:00Z')}),shop=shoppingStore({},{save(){},now:()=>new Date('2026-11-10T12:00:00Z'),libraryPrices:provider});shop.settings({monitoringEnabled:true,stores:[{id:'synthetic-kiwi',name:'Synthetic physical store',chainCode:'KIWI',minSavings:0,url:'https://example.test/store'}]});const w=shop.watch({id:'synthetic-vegetable',name:'Synthetic fresh vegetable',unit:'kg',storage:'pantry'}),reader=provider.reader();
 const a={groupId:'plain',groupFingerprint:reader.group('plain').fingerprint,evidence,brands:[],requires:[],excludeProductKeys:[]},b={groupId:'organic',groupFingerprint:reader.group('organic').fingerprint,evidence,brands:[],requires:['organic'],excludeProductKeys:[]};
 const link=variants=>shop.libraryLink({familyId:w.id,evidence,variants}),scope=()=>shop.sesumPlacement();link([a]);const original=scope().familySetFingerprint;
 link([a,b]);const expanded=scope().families[0].familyFingerprint;assert.notEqual(scope().familySetFingerprint,original,'new unqualified scope must be assessed');assert.equal(shop.familyView().items[0].prices.current,20);
 b.scopeCoverage={groupId:a.groupId,groupFingerprint:a.groupFingerprint,childGroupFingerprint:b.groupFingerprint,reviewed:true,evidence};link([a,b]);assert.equal(scope().familySetFingerprint,original);assert.equal(scope().families[0].variants.length,2,'the subgroup and its criteria remain visible');assert.deepEqual(scope().families[0].equivalentFamilyFingerprints,[expanded]);assert.equal(scope().families[0].variants.find(v=>v.groupId==='organic').scopeCoverageCurrent,true);
 assert.equal(shop.familyView().items[0].prices.current,20,'a product belonging only to the subgroup retains its reviewed fresh price');
 organic.inclusionCriteria+=' Changed actual eligibility requirements requiring fresh review.';writeFileSync(file,JSON.stringify(data));assert.notEqual(scope().familySetFingerprint,original,'a definition change invalidates the containment receipt');assert.equal(shop.familyView().items[0].prices.current,null,'changed actual criteria still hold the old product review');
 const current={...b,groupFingerprint:provider.reader().group('organic').fingerprint};assert.throws(()=>link([a,current]),/Scope coverage/,'reapproving a changed link cannot silently reuse the old containment decision');
});
