import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {countedPackage} from '../src/sesum-counted-package.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider,createIndexReader} from '../src/shopping-library.mjs';
import {groupMetadataFingerprint,productMetadataFingerprint,productTextHash} from '../src/product-library.mjs';
import {createSesumPrices,sesumDonorFingerprint} from '../src/sesum-prices.mjs';
import {applyWorkerProposal,workerOperationGuide} from '../src/shopping-worker-contract.mjs';

const NOW='2026-11-10T12:00:00Z',RECEIPT='2026-11-09T12:00:00Z',KEY='sesum:KIWI:82';
const source={id:'82',name:'Plain household paper',brand:'Synthetic',ean:['1234567890123'],weight:96,weightUnit:'m',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/82-plain-paper'};
const proof={rule:'measured-package-count-v1',reviewed:true,wholePack:true,sourceAmount:96,sourceUnit:'m',packAmount:8,unit:'stk',evidence:'Read this exact primary consumer package: eight rolls with a declared total length of 96 metres, three plies and 12 metres per roll. The count is rolls, not sheets.',sourceReceipts:[{url:'https://producer.example.test/actual-paper-pack',observedAt:NOW,evidence:'Read the same actual consumer package declaring eight rolls, 96 metres total, three plies, 12 metres per roll and the actual sheet dimensions.'}]};
const expected={packAmount:8,unit:'stk',at:Date.parse(NOW)};

test('independently reviewed whole-pack metres and roll count preserve both measures',()=>{
 const before=structuredClone({source,proof}),measure=countedPackage(source,proof,expected);
 assert.deepEqual(measure,proof);assert.deepEqual({source,proof},before);
 assert.equal(measure.sourceCount,undefined);assert.equal(measure.receiptAt,undefined);assert.equal(measure.price,undefined);
 for(const change of [{weight:12},{weight:null},{weightUnit:'stk'},{weightUnit:'kg'},{soldByWeight:true},{soldByWeight:null}])assert.throws(()=>countedPackage({...source,...change},proof,expected));
 for(const change of [{rule:undefined},{rule:'guessed-count'},{sourceAmount:12},{sourceUnit:'cm'},{sourceCount:8},{wholePack:false},{reviewed:false},{packAmount:4},{packAmount:8.000001},{perRollLength:12},{sourceReceipts:[]},{evidence:'8pk from name'}])assert.throws(()=>countedPackage(source,{...proof,...change},expected));
 for(const change of [{unit:'m'},{packAmount:1},{packAmount:8.5},{packBasis:'drained'}])assert.throws(()=>countedPackage(source,proof,{...expected,...change}));
 for(const change of [{url:'http://producer.example.test/'},{observedAt:'2026-11-11T12:00:00Z'},{evidence:'guessed'}])assert.throws(()=>countedPackage(source,{...proof,sourceReceipts:[{...proof.sourceReceipts[0],...change}]},expected));
 assert.equal(countedPackage({...source,soldByWeight:null},proof,{...expected,fixedPackVerified:true}).packAmount,8);
 assert.equal(countedPackage(source,undefined,expected),null,'a missing proof cannot be fabricated from the name, EAN or arithmetic');
});

function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'sesum-length-package-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'sesum-length-package-')));rmSync(dir,{recursive:true,force:true});});
 const group={id:'plain-paper-rolls',name:'Plain three-ply household paper',category:'Household',canonicalUnit:'stk',inclusionCriteria:'Plain household paper, three plies, 12 metres per roll and documented sheet dimensions. Count rolls, not sheets.',exclusions:['Kitchen paper','Perfumed paper','Unknown roll length or ply'],qualityBasis:'Actual same-pack ply, sheet dimensions and roll length',comparisonBasis:'Per documented roll with equivalent dimensions'};
 const p={productKey:'kassal:KIWI:81',source:'kassal',store:'KIWI',id:'81',name:'Baseline plain household paper',brand:'Synthetic',ean:'1234567890124',ingredients:'Cellulose',description:'Four three-ply rolls, 12 m per roll, 12.5 by 9.5 cm sheets',sourceUrl:'https://producer.example.test/baseline-paper',canonicalPackAmount:4,unit:'stk',packEvidence:'Read actual four-roll pack, 48 metres total, three plies and sheet dimensions.',rawPack:{weight:4,weightUnit:'stk'},attributes:null,nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
 const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[group],products:[p],memberships:[{groupId:group.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(group),equivalenceEvidence:'Read actual three-ply paper, same sheet dimensions and 12 metres per roll.',qualityEvidence:'Actual whole-pack roll count, sheet dimensions, ply and total length reviewed.',reviewedAt:NOW,sourceReceipts:[{url:p.sourceUrl,observedAt:NOW,evidence:'Read complete primary label, four rolls and 48 metres total.'}]}],prices:[{productKey:p.productKey,grossPackPrice:20,receiptAt:RECEIPT,availabilityScope:'chain',sourceUrl:p.sourceUrl}]};
 const file=join(dir,'library.json');writeFileSync(file,JSON.stringify(data));let state={},shop;
 const open=()=>shop=shoppingStore(state,{save(){},now:()=>new Date(NOW),libraryPrices:libraryPriceProvider(file,{now:()=>new Date(NOW)})});open();
 shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://shop.example.test/kiwi',minSavings:0}]});
 const target=shop.watch({id:'household-paper',name:'Plain household paper rolls',unit:'stk',storage:'pantry',purchaseAmount:40,stockAmount:4,note:'Three-ply paper, documented 12 metres per roll and sheet dimensions; count rolls, not sheets.'});
 const other=shop.watch({id:'whole-beans',name:'Whole coffee beans',unit:'kg',storage:'pantry',note:'Whole coffee beans only, never household paper.'});
 shop.libraryLink({familyId:target.id,variants:[{groupId:group.id,groupFingerprint:groupMetadataFingerprint(group),evidence:'Read actual equivalent plain three-ply rolls, same dimensions and length.'}],evidence:'Explicitly reviewed household requirement for equivalent rolls.'});
 const ingest=(changes={})=>shop.sesumReceivePrices({familyIds:[other.id],fetchedAt:NOW,products:[{...source,...changes,prices:[{storeCode:'KIWI',price:24,observedAt:RECEIPT,source:'actual_source_receipt',isPromo:false}]}]});
 const row=()=>shop.sesumPlacement(KEY).items[0],view=()=>shop.familyView().items.find(f=>f.id===target.id);
 const review=(extra={})=>{const d=shop.sesumPlacement(KEY),r=d.items[0],f=d.families.find(f=>f.familyId===target.id);return shop.sesumPriceReview({kind:'placement',sourceKey:KEY,sourceFingerprint:r.sourceFingerprint,registrationFingerprint:r.registrationFingerprint,familySetFingerprint:d.familySetFingerprint,status:'reviewed',reviewedAllFamilies:true,scopeEvidence:'Read the complete current family set: household paper requires rolls, three plies, stated length and sheet dimensions; whole coffee beans exclude this paper product.',evidence:'Read exact primary eight-roll pack, dimensions, three plies and 96 metres total.',targets:[{familyId:target.id,familyFingerprint:f.familyFingerprint,equivalenceEvidence:'Actual same-pack primary declaration proves eight equivalent plain three-ply rolls, 12 metres per roll, 12.5 by 9.5 cm sheets.'}],...extra});};
 const register=(extra={})=>shop.sesumRegister({sourceKey:KEY,sourceFingerprint:row().sourceFingerprint,identityEvidence:'Read this exact native plain paper variant and original eight-roll consumer package.',product:{ingredients:'Cellulose',description:'Eight three-ply rolls, 12 metres per roll, 12.5 by 9.5 cm sheets',brand:'Synthetic'},packAmount:8,unit:'stk',packEvidence:'Read original eight-roll consumer pack, three plies, 96 metres total and actual sheet dimensions.',memberships:[{groupId:group.id,groupFingerprint:groupMetadataFingerprint(group),equivalenceEvidence:'Actual same-pack three-ply paper, sheet dimensions and roll length match the current group criteria.',qualityEvidence:'Read full primary material declaration, three plies, sheet size and 12 metre roll length.'}],sourceReceipts:proof.sourceReceipts,...extra});
 return {get shop(){return shop;},get state(){return state;},group,ingest,row,view,review,register,reload(){state=structuredClone(state);open();}};
}

test('metre source flows through placement, native registration and real per-roll pricing without rewriting source or receipt',t=>{
 const f=fixture(t);f.ingest();const raw=structuredClone(f.row().source),receiptAt=f.row().receiptAt;
 assert.equal(f.view().prices.current,5);assert.throws(()=>f.review(),/measured-package-count-v1/);assert.throws(()=>f.register(),/package amounts disagree/);
 f.review({countedPack:proof});assert.equal(f.row().review.targets[0].countedPackReviewed,true);assert.equal(f.view().prices.current,5,'a physical measurement and research target approve no SKU or price');
 assert.equal(f.row().registration,null);f.register({countedPack:proof});assert.equal(f.row().status,'pending','newly registered identity requires current full-set placement');
 f.review({countedPack:proof});assert.equal(f.row().status,'reviewed');assert.equal(f.view().prices.current,3,'24 is the price for all eight rolls, not per roll or per metre');
 assert.equal(f.row().registration.product.canonicalPackAmount,8);assert.equal(f.row().registration.product.unit,'stk');assert.equal(f.row().registration.countedPack.sourceAmount,96);
 assert.equal(f.row().receiptAt,receiptAt);assert.deepEqual(f.row().source,raw);assert.equal(receiptAt,new Date(RECEIPT).toISOString());
 const watch=f.state.shopping.watches['household-paper'];assert.equal(watch.stockAmount,4);assert.equal(watch.purchaseAmount,40);
 assert.throws(()=>f.review({countedPack:{...proof,packAmount:4}}),/produktgrunnlag/,'placement cannot redefine an already approved canonical package');
 f.reload();assert.equal(f.row().status,'reviewed');assert.deepEqual(f.row().review.countedPack,proof);assert.equal(f.view().prices.current,3);
 f.ingest({weight:80});assert.equal(f.row().status,'pending');assert.equal(f.view().prices.current,5,'changed source measure invalidates the identity and price approval');assert.throws(()=>f.review({countedPack:proof}),/total length must match/);
});

test('an existing same-chain donor also needs exact reviewed count and retains the actual package price date',()=>{
 const p={store:'KIWI',id:'81',name:'Plain household paper',brand:'Synthetic',ean:source.ean[0],ingredients:'Cellulose',description:'Eight three-ply rolls, 12 metres per roll, 12.5 by 9.5 cm sheets',sourceUrl:'https://producer.example.test/actual-paper-pack',pack:8,unit:'stk',packKnown:true,packEvidence:proof.evidence,rawPack:{weight:8,weightUnit:'stk'},attributes:null,nutrition:null,quote:{grossPackPrice:40,receiptAt:'2026-11-09T11:00:00Z',reasons:[],sourceUrl:'https://producer.example.test/receipt'}};p.textHash=productTextHash(p);
 const key='kassal:KIWI:81',index={builtAt:NOW,groups:{paper:{name:'Plain paper',unit:'stk',fingerprint:'a'.repeat(64)}},members:{paper:[{k:key,s:'approved',r:true,u:5,q:null,n:null}]},products:{[key]:p},qualityNotes:{}},state={};
 const prices=createSesumPrices(state,{reader:()=>createIndexReader(index)(Date.parse(NOW)),save(){},now:()=>new Date(NOW)});
 prices.ingest({familyIds:['paper'],fetchedAt:NOW,products:[{...source,prices:[{storeCode:'KIWI',price:24,rawUnitPrice:99,observedAt:RECEIPT,source:'actual_source_receipt',isPromo:false}]}]});
 const c=prices.candidates()[0],input={sourceKey:KEY,sourceFingerprint:c.sourceFingerprint,productKey:key,productFingerprint:sesumDonorFingerprint(p),status:'approved',packAmount:8,unit:'stk',equivalenceEvidence:'Read this same exact consumer pack, material, dimensions, ply, count and length against the current reviewed native donor.',packEvidence:proof.evidence};
 assert.throws(()=>prices.review(input),/measured-package-count-v1/);prices.review({...input,countedPack:proof});
 const q=prices.overlay().quote(KEY).price;assert.equal(q.grossPackPrice,24);assert.equal(prices.overlay().members('paper').find(p=>p.productKey===KEY).unitPrice,3);assert.equal(q.receiptAt,new Date(RECEIPT).toISOString());assert.equal(q.unit,'stk');assert.equal(state.bridges[KEY].countedPack.sourceAmount,96);
 const approved=structuredClone(state.bridges[KEY]);delete state.bridges[KEY].countedPack;assert.equal(prices.approvedSource(KEY),null,'an older bridge without the metre/count proof must return to review');state.bridges[KEY]=approved;assert.equal(prices.approvedSource(KEY).packAmount,8);
 prices.ingest({familyIds:['paper'],fetchedAt:NOW,products:[{...source,weight:80,prices:[{storeCode:'KIWI',price:24,observedAt:RECEIPT,source:'actual_source_receipt'}]}]});assert.equal(prices.approvedSource(KEY),null);
 p.pack=80;p.unit='m';p.rawPack={weight:80,weightUnit:'m'};p.textHash=productTextHash(p);index.groups.paper.unit='m';
 const metreInput={...input,sourceFingerprint:prices.candidates()[0].sourceFingerprint,productFingerprint:sesumDonorFingerprint(p),packAmount:80,unit:'m'};prices.review(metreInput);assert.equal(prices.approvedSource(KEY).unit,'m','matching metre packages continue to work without a count conversion');
 const metreBridge=structuredClone(state.bridges[KEY]);state.bridges[KEY].packAmount=64;assert.equal(prices.approvedSource(KEY),null);state.bridges[KEY]=metreBridge;
 p.pack=64;assert.throws(()=>prices.review({...metreInput,productFingerprint:sesumDonorFingerprint(p),packAmount:64}),/package amounts disagree/,'metres are a known source measure, never an unknown package that can silently accept another length');
});

test('scoped registration can reuse only its own current matching measured-count proof and receives the complete contract',()=>{
 const row={sourceKey:KEY,observation:{sourceFingerprint:'current'},placement:{review:{sourceFingerprint:'current',countedPack:proof}}},packet={assignmentChanges:[],jobs:[{items:[{do:'shopping-sesum-discovery',sourceKey:KEY}]}],sources:[row]},assignment={jobs:[{sourceKeys:[KEY]}]};let saved;
 const apply=extra=>applyWorkerProposal({store:{shopping:{sesumRegister:input=>(saved=input)}},assignment,packet,operation:'source-register',input:{sourceKey:KEY,packAmount:8,unit:'stk',memberships:[],...extra}});
 apply({});assert.deepEqual(saved.countedPack,proof);apply({packAmount:4});assert.equal(saved.countedPack,undefined);apply({unit:'m'});assert.equal(saved.countedPack,undefined);row.placement.review.sourceFingerprint='changed';apply({});assert.equal(saved.countedPack,undefined);
 for(const stage of ['shopping-sesum-placement-review','shopping-sesum-discovery','shopping-sesum-review']){const guide=workerOperationGuide([stage]);for(const term of ['measured-package-count-v1','sourceAmount','sourceUnit','never sheets','ply','roll length'])assert.ok(guide.includes(term),stage+': '+term);}
});
