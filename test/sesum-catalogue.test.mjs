import test from 'node:test';
import assert from 'node:assert/strict';
import {createSesumCatalogue,sesumCatalogueFingerprint} from '../src/sesum-catalogue.mjs';

const NOW='2026-11-10T12:00:00Z',OLD='2026-05-01T12:00:00Z',KEY='sesum-product:72';
const product=(extra={})=>({id:'72',name:'Plain whole coffee beans 500g',brand:'New',vendor:'Roaster',ean:['1234567890123'],nonEanCodes:['LOCAL-72'],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/72-plain-whole-beans',prices:[],priceCandidates:[],...extra});
const summary=(date=OLD,extra={})=>({kind:'own-product-chain-receipts-v1',productId:'72',sourceUrl:product().sourceUrl,receipts:[{storeCode:'JOKER',storeId:'21',observedAt:date,source:'actual_source_receipt',...extra}]});
function fixture(){const state={},clock={at:NOW};let saves=0;const registry=createSesumCatalogue(state,{save:()=>saves++,now:()=>new Date(clock.at)});const ingest=(p=product(),familyIds=['wrong-honey-hint'])=>registry.ingest({fetchedAt:clock.at,familyIds,products:[p]});return {state,clock,registry,ingest,get saves(){return saves;}};}

test('catalogue identity is chain-neutral metadata, never a quote, and price/capture churn cannot change its semantic fingerprint',()=>{
 const f=fixture();f.ingest(product({store:'KIWI',currentPrice:1,grossUnitPrice:2,metadataApproval:true}));const row=f.registry.record(KEY);
 assert.equal(row.sourceKey,KEY);assert.equal(row.ageStatus,'unknown');assert.equal(row.receiptAt,null);assert.deepEqual(row.familyIds,['wrong-honey-hint']);
 for(const field of ['store','prices','priceCandidates','currentPrice','grossUnitPrice','metadataApproval'])assert.equal(Object.hasOwn(row.source,field),false,field);
 assert.equal(row.sourceFingerprint,sesumCatalogueFingerprint(product({price:99,fetchedAt:'2026-11-11T12:00:00Z'})));
 f.clock.at='2026-11-10T13:00:00Z';f.ingest();assert.equal(f.registry.record(KEY).sourceFingerprint,row.sourceFingerprint);assert.equal(f.registry.record(KEY).receiptAt,null);assert.equal(f.registry.summaries()[0].parked,false);
});
test('all-own off-scope actual receipts park unchanged metadata without refreshing a price or leaking arbitrary fields',()=>{
 const f=fixture();f.ingest(product({ownReceiptSummary:summary(OLD,{price:1,profile:'untrusted extra'})}));const row=f.registry.record(KEY);assert.equal(row.receiptAt,OLD.replace('Z','.000Z'));assert.equal(row.ageStatus,'known');assert.equal(f.registry.summaries()[0].parked,true);
 assert.deepEqual(Object.keys(row.ownReceiptSummary.receipts[0]),['storeCode','storeId','source','observedAt']);assert.equal(Object.hasOwn(f.registry.summaries()[0],'ownReceiptSummary'),false);
 f.clock.at='2026-11-11T12:00:00Z';f.ingest();assert.equal(f.registry.record(KEY).receiptAt,row.receiptAt);assert.equal(f.registry.summaries()[0].parked,true,'an empty new capture cannot revive known old unchanged metadata');
 f.ingest(product({ownReceiptSummary:summary('2026-11-10T11:00:00Z')}));assert.equal(f.registry.summaries()[0].parked,false);assert.equal(f.registry.record(KEY).receiptAt,'2026-11-10T11:00:00.000Z');
});
test('materially changed current metadata has no old-variant receipt age and invalidates the source currentness predicate',()=>{
 const f=fixture();f.ingest(product({ownReceiptSummary:summary()}));const original=f.registry.record(KEY);assert.equal(f.registry.current({...original.source,store:'KIWI'}),true);
 f.clock.at='2026-11-10T13:00:00Z';f.ingest(product({name:'Materially new flavoured ground coffee 500g'}));const changed=f.registry.record(KEY);
 assert.notEqual(changed.sourceFingerprint,original.sourceFingerprint);assert.equal(changed.receiptAt,null);assert.equal(changed.ageStatus,'unknown');assert.equal(f.registry.current(original.source),false);assert.equal(f.registry.current(changed.source),true);assert.deepEqual(f.state.history,[original]);
});
test('invalid or future summary, changed URL binding and a malformed later product fail atomically',()=>{
 const f=fixture();f.ingest();const before=structuredClone(f.state);
 for(const ownReceiptSummary of [summary('2026-11-11T12:00:00Z'),summary(OLD,{source:null}),{...summary(),productId:'73'},{...summary(),sourceUrl:'https://www.sesum.no/produkt/73-other'},summary(OLD,{storeId:'unknown'})])assert.throws(()=>f.ingest(product({ownReceiptSummary})));
 assert.throws(()=>f.registry.ingest({fetchedAt:NOW,familyIds:['wrong-honey-hint'],products:[product({name:'Valid first staged change'}),product({id:'bad'})]}));
 assert.throws(()=>f.registry.ingest({fetchedAt:NOW,familyIds:['wrong-honey-hint'],products:[product(),product()]}));assert.deepEqual(f.state,before);
});
test('older metadata replay only adds raw provenance and cannot roll back a newer variant or manufacture price age',()=>{
 const f=fixture();f.ingest();f.clock.at='2026-11-10T13:00:00Z';f.ingest(product({name:'New current source variant'}));const current=f.registry.record(KEY);
 f.registry.ingest({fetchedAt:NOW,familyIds:['newly-found-hint'],products:[product({ownReceiptSummary:summary()})]});const replayed=f.registry.record(KEY);
 assert.equal(replayed.sourceFingerprint,current.sourceFingerprint);assert.equal(replayed.fetchedAt,current.fetchedAt);assert.equal(replayed.receiptAt,null);assert.deepEqual(replayed.familyIds,['wrong-honey-hint','newly-found-hint']);
});

test('actual legacy chain input can reactivate age without inventing a previously absent store identifier',()=>{
 const f=fixture();f.ingest(product({ownReceiptSummary:summary()}));assert.equal(f.registry.summaries()[0].parked,true);
 f.ingest(product({prices:[{storeCode:'KIWI',price:20,source:'actual_source_receipt',observedAt:NOW}]}));const row=f.registry.record(KEY);
 assert.equal(row.receiptAt,'2026-11-10T12:00:00.000Z');assert.equal(f.registry.summaries()[0].parked,false);assert.deepEqual(row.ownReceiptSummary.receipts,[]);assert.equal(row.source.store,undefined);
});
