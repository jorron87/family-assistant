import test from 'node:test';
import assert from 'node:assert/strict';
import {createSesumDiscovery} from '../src/sesum-discovery.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {groupMetadataFingerprint,productMetadataFingerprint} from '../src/product-library.mjs';
import {sesumDonorFingerprint} from '../src/sesum-prices.mjs';

const NOW='2026-11-09T12:00:00Z',SOURCE_FP='1'.repeat(64),key='sesum:KIWI:123';
const group={id:'whole-beans',name:'Whole beans',category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Roasted whole coffee beans',exclusions:['Ground coffee'],qualityBasis:'Actual contents and use',comparisonBasis:'Per kilogram'};
const compact=g=>({name:g.name,category:g.category,unit:g.canonicalUnit,fingerprint:groupMetadataFingerprint(g),inclusion:g.inclusionCriteria,exclusions:g.exclusions,qualityBasis:g.qualityBasis,comparisonBasis:g.comparisonBasis});
function fixture(){
 const original={store:'ODA_NO',id:'7',source:'kassal',name:'Existing beans',ean:null,brand:'Existing',ingredients:'Whole coffee beans',description:null,sourceUrl:'https://example.test/old',pack:.5,packKnown:true,unit:'kg',packEvidence:'Old original',available:true,attributes:null,nutrition:null,quote:{grossPackPrice:30,receiptAt:NOW,reasons:[],sourceUrl:'https://example.test/old'}};
 const index={builtAt:NOW,groups:{[group.id]:compact(group)},members:{[group.id]:[{k:'kassal:ODA_NO:7',s:'approved',r:true,u:60,q:null,n:null}]},products:{'kassal:ODA_NO:7':original},qualityNotes:{}};
 const record={sourceKey:key,sourceFingerprint:SOURCE_FP,source:{id:'123',store:'KIWI',name:'New whole beans 500 g',brand:'New',ean:['1234567890123'],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/123-new-whole-beans-500g'},price:{price:20,observedAt:NOW},familyIds:['family:coffee']};
 const state={},clock={at:NOW};let saves=0;
 const reader=()=>createIndexReader(index)(Date.parse(clock.at));
 const discovery=createSesumDiscovery(state,{now:()=>new Date(clock.at),reader,source:sourceKey=>sourceKey===key?record:null,save:()=>{saves++;}});
 const input=(extra={})=>({sourceKey:key,sourceFingerprint:SOURCE_FP,identityEvidence:'Read the actual native product and original manufacturer label; same specific variant and package.',product:{ingredients:'Whole roasted coffee beans',description:'Plain whole beans, medium roast',attributes:{organic:false}},packAmount:.5,unit:'kg',packEvidence:'Original package explicitly says 500 g whole beans.',memberships:[{groupId:group.id,groupFingerprint:groupMetadataFingerprint(group),equivalenceEvidence:'Same whole-bean form and intended use.',qualityEvidence:'Roast and actual whole-bean ingredients reviewed.'}],sourceReceipts:[{url:'https://example.test/manufacturer/123',observedAt:'2026-11-09T11:00:00Z',evidence:'Original complete ingredients and fixed 500 g package read.'}],...extra});
 return {discovery,state,index,original,record,clock,input,reader,saves:()=>saves};
}

test('explicit metadata registration creates reviewed native product identity but no current price',()=>{
 const f=fixture(),before=structuredClone(f.index);assert.equal(f.discovery.record(key),null);
 const result=f.discovery.register(f.input()),read=f.discovery.overlay(),product=read.product(key);
 assert.equal(result.productKey,key);assert.equal(result.productFingerprint,product.metadataFingerprint);assert.equal(result.sourceFingerprint,SOURCE_FP);
 assert.equal(product.source,'sesum');assert.equal(product.nativeDiscovery,true);assert.equal(product.sourceFingerprint,SOURCE_FP);assert.equal(product.donorProductKey,undefined);assert.equal(product.pack,.5);assert.equal(product.ingredients,'Whole roasted coffee beans');
 assert.equal(read.quote(key).reviewCurrent,true);assert.equal(read.quote(key).price.grossPackPrice,null);assert.equal(read.quote(key).price.receiptAt,null);assert.equal(read.quote(key).price.fresh,false,'source.price is never imported by metadata registration');
 assert.equal(read.members(group.id,{all:true}).find(m=>m.productKey===key).eligible,false);assert.deepEqual(f.index,before,'existing native library products are untouched');assert.equal(f.saves(),1);
 assert.equal(product.metadataFingerprint,productMetadataFingerprint(f.discovery.record(key).product));
});
test('source and group changes invalidate explicit reviews and semantic overlay caches',()=>{
 const f=fixture();f.discovery.register(f.input());const cache=f.discovery.overlay().cacheKey,index=f.discovery.overlay().index();assert.equal(f.discovery.overlay().index(),index);
 f.record.sourceFingerprint='2'.repeat(64);assert.equal(f.discovery.record(key),null);assert.equal(f.discovery.overlay().product(key),null);assert.notEqual(f.discovery.overlay().cacheKey,cache);assert.throws(()=>f.discovery.register(f.input()),/metadata changed/);
 f.record.sourceFingerprint=SOURCE_FP;assert.ok(f.discovery.record(key));f.index.groups[group.id]=compact({...group,inclusionCriteria:'Only organic whole beans'});
 assert.equal(f.discovery.overlay().product(key),null);assert.equal(f.discovery.record(key),null);assert.throws(()=>f.discovery.register(f.input()),/family changed/);
});
test('new group definitions are explicit, fingerprinted and never overwrite conflicting existing rules',()=>{
 const f=fixture(),newGroup={...group,id:'dark-whole-beans',name:'Dark whole beans',inclusionCriteria:'Dark-roasted whole beans'};
 const result=f.discovery.register(f.input({groups:[newGroup],memberships:[{groupId:newGroup.id,groupFingerprint:groupMetadataFingerprint(newGroup),equivalenceEvidence:'Actual dark roast and whole form read.',qualityEvidence:'Manufacturer dark roast label read.'}]}));
 assert.equal(result.groups[0].groupId,newGroup.id);assert.equal(f.discovery.overlay().group(newGroup.id).fingerprint,groupMetadataFingerprint(newGroup));assert.equal(f.discovery.overlay().members(newGroup.id,{all:true}).length,1);assert.equal(f.discovery.overlay().group(group.id).fingerprint,groupMetadataFingerprint(group));
 assert.throws(()=>f.discovery.register(f.input({groups:[{...group,inclusionCriteria:'Different rules'}]})),/conflicting existing rules/);
});
test('fixed-package checks reject conflicting units, amounts and variable-weight guesses',()=>{
 const f=fixture();for(const extra of [{packAmount:.4},{unit:'stk'},{packAmount:0},{packEvidence:''},{identityEvidence:''}])assert.throws(()=>f.discovery.register(f.input(extra)));
 f.record.source.soldByWeight=true;assert.throws(()=>f.discovery.register(f.input()),/Variable-weight/);
 f.record.source.soldByWeight=null;assert.throws(()=>f.discovery.register(f.input()),/Unknown weight mode/);f.discovery.register(f.input({fixedPackVerified:true}));
 f.record.source.weightUnit='unknown';assert.throws(()=>f.discovery.register(f.input({fixedPackVerified:true})),/unit needs review/);
});
test('explicit drained mass preserves gross raw package and requires concrete evidence',()=>{
 const f=fixture();f.record.source.weight=380;f.record.source.name='Cooked beans 380 g';
 assert.throws(()=>f.discovery.register(f.input({packAmount:.23})),/amounts disagree/);
 assert.throws(()=>f.discovery.register(f.input({packAmount:.23,packBasis:'drained'})),/package-basis evidence/);
 const registered=f.discovery.register(f.input({packAmount:.23,packBasis:'drained',packBasisEvidence:'Original label was read: drained weight 230 g, net 380 g.'})),record=f.discovery.record(key);
 assert.equal(record.product.canonicalPackAmount,.23);assert.equal(record.product.rawPack.weight,380);assert.equal(record.packBasis,'drained');assert.match(record.product.packEvidence,/drained weight 230 g/);assert.ok(registered.productFingerprint);
 assert.throws(()=>f.discovery.register(f.input({packAmount:.5,packBasis:'drained',packBasisEvidence:'Invalid claim.'})),/no larger/);
});
test('complete original receipts and valid nutrition are required without guessing missing ingredients',()=>{
 const f=fixture();for(const extra of [{sourceReceipts:[]},{sourceReceipts:[{url:'http://example.test/label',observedAt:NOW,evidence:'Label.'}]},{sourceReceipts:[{url:'https://example.test/label',observedAt:'2026-11-10T12:00:00Z',evidence:'Future.'}]},{product:{nutrition:{basis:'kg',per100:{fat:2},sourceUrl:'https://example.test/label',evidence:'Read.'}}}])assert.throws(()=>f.discovery.register(f.input(extra)));
 f.discovery.register(f.input({product:{ingredients:null,description:'Identity confirmed, complete ingredients are not declared in this source.',accessToken:'secret',nutrition:{basis:'g',per100:{fat:2,protein:10,salt:null},sourceUrl:'https://example.test/label',evidence:'Actual per100g label read.'}}}));
 const record=f.discovery.record(key);assert.equal(record.product.ingredients,null);assert.equal(record.product.nutrition.per100.salt,null);assert.equal(JSON.stringify(f.state).includes('secret'),false);
});
test('record snapshots are read-only and registration cannot invent the native identity',()=>{
 const f=fixture();f.discovery.register(f.input());const copy=f.discovery.record(key);copy.product.name='Changed outside';assert.equal(f.discovery.record(key).product.name,f.record.source.name);
 f.record.source.store='REMA_1000';assert.throws(()=>f.discovery.register(f.input()),/identity/);
});
test('unknown chains and malformed normalized weight modes remain unregistered',()=>{
 const f=fixture();f.record.source.soldByWeight='false';assert.throws(()=>f.discovery.register(f.input({fixedPackVerified:true})),/weight mode/);assert.equal(f.discovery.status().registered,0);
 f.record.source.soldByWeight=false;f.record.source.store='UNKNOWN';assert.throws(()=>f.discovery.register(f.input()),/identity/);assert.equal(f.saves(),0);
});
test('replacing an existing Sesum key does not inherit old approvals from other groups',()=>{
 const f=fixture(),newGroup={...group,id:'plain-beans',name:'Plain whole beans'};
 f.index.products[key]={...structuredClone(f.original),source:'sesum',store:'KIWI',id:'123',name:f.record.source.name,sourceUrl:f.record.source.sourceUrl};
 f.index.members[group.id].push({k:key,s:'approved',r:true,u:50,q:null,n:null});const original=structuredClone(f.index);
 f.discovery.register(f.input({groups:[newGroup],memberships:[{groupId:newGroup.id,groupFingerprint:groupMetadataFingerprint(newGroup),equivalenceEvidence:'This actual plain-bean product was reviewed.',qualityEvidence:'Original content and form read.'}]}));
 const over=f.discovery.overlay();assert.deepEqual(over.groupsOf(key).map(m=>m.groupId),[newGroup.id]);assert.equal(over.members(group.id,{all:true}).some(m=>m.productKey===key),false);assert.deepEqual(f.index,original,'base metadata and historical memberships remain untouched');
});

test('an optional explicit same-chain native identity binds metadata and package without lending its recipe',()=>{
 const f=fixture(),nativeKey='kassal:KIWI:8',native={...structuredClone(f.original),store:'KIWI',id:'8',metadataFingerprint:'3'.repeat(64),ingredients:'Native recipe must not be copied',nutrition:{basis:'g',per100:{fat:50}}};
 f.index.products[nativeKey]=native;
 const binding={nativeProductKey:nativeKey,nativeProductFingerprint:sesumDonorFingerprint(native),nativeIdentityEvidence:'Actual source and native label show the same physical fixed 500 g variant; brand, form and package were checked together.'};
 f.discovery.register(f.input({...binding,product:{ingredients:null,description:'Source label facts remain independently researched.'}}));
 const product=f.discovery.overlay().product(key),record=f.discovery.record(key);
 assert.equal(product.ingredients,null);assert.equal(product.nutrition,null);
 assert.equal(product.nativeIdentity.key,nativeKey);assert.equal(product.nativeIdentity.metadataFingerprint,binding.nativeProductFingerprint);assert.equal(product.nativeIdentity.pack,.5);assert.equal(product.nativeIdentity.unit,'kg');
 assert.equal(record.nativeIdentityEvidence,binding.nativeIdentityEvidence);
 assert.equal(binding.nativeProductFingerprint,native.metadataFingerprint,'real compiled native metadata fingerprint is authoritative');
 assert.throws(()=>f.discovery.register(f.input({...binding,nativeProductFingerprint:product.metadataFingerprint})),/Native identity/,'the independently registered Sesum product fingerprint cannot replace the native fingerprint');
 native.quote={...native.quote,grossPackPrice:99,receiptAt:'2026-11-09T11:30:00Z'};assert.ok(f.discovery.record(key),'price changes do not invalidate reviewed identity');
 native.ingredients='Changed native physical variant';native.metadataFingerprint='4'.repeat(64);assert.equal(f.discovery.record(key),null);assert.equal(f.discovery.overlay().product(key),null,'changed native metadata withdraws source registration');
 assert.throws(()=>f.discovery.register(f.input(binding)),/Native identity/);
});

test('native identity never joins a different chain or infers identity from EAN/name alone',()=>{
 const f=fixture(),nativeKey='kassal:ODA_NO:7',binding={nativeProductKey:nativeKey,nativeProductFingerprint:sesumDonorFingerprint(f.original),nativeIdentityEvidence:'Explicit identity evidence'};
 assert.throws(()=>f.discovery.register(f.input(binding)),/Native identity/);
 for(const patch of [{nativeProductKey:nativeKey},{...binding,nativeIdentityEvidence:''},{...binding,nativeProductFingerprint:'f'.repeat(64)}])assert.throws(()=>f.discovery.register(f.input(patch)));
 const key2='kassal:KIWI:8',native={...structuredClone(f.original),store:'KIWI',id:'8',pack:.4};f.index.products[key2]=native;
 assert.throws(()=>f.discovery.register(f.input({nativeProductKey:key2,nativeProductFingerprint:sesumDonorFingerprint(native),nativeIdentityEvidence:'Explicit proof cannot override canonical package conflict.'})),/canonical package/);
 f.discovery.register(f.input());assert.equal(f.discovery.overlay().product(key).nativeIdentity,undefined,'registration without a binding stays source-only');
});
