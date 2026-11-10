import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketCatalog} from '../src/shopping-catalog.mjs';

const at='2026-11-08T12:00:00.000Z';
const product=(overrides={})=>({id:123,store:'CHAIN_A',name:'Synthetic plain oats 500g',ean:'1234567890123',brand:'Synthetic',ingredients:'Whole oats',description:'Plain rolled oats',weight:500,weightUnit:'g',sourceUrl:'https://example.com/products/123',categories:['Pantry','Grains'],currentPrice:20,lastChecked:at,...overrides});
function fixture(){let date=new Date(at),saves=0;const state={},catalog=createMarketCatalog(state,{now:()=>date,save:()=>saves++});return {state,catalog,advance:hours=>{date=new Date(date.getTime()+hours*3600000);},saves:()=>saves};}
const observe=(catalog,p=product(),watchId='oats')=>catalog.observe({watchId,products:[p],query:'plain oats'}).entries[0];
const approve=(catalog,entry,extra={})=>catalog.review({watchId:entry.watchId,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status:'approved',equivalenceEvidence:'Reviewed synthetic ingredients and a 500g package; same plain grain variant.',packAmount:.5,unit:'kg',...extra});

test('stable native ID is scoped by watch and chain; arrays are detached',()=>{
 const {catalog,state}=fixture();
 const first=observe(catalog),second=observe(catalog,product({store:'CHAIN_B'})),third=observe(catalog,product(),'another-watch');
 assert.equal(new Set([first.key,second.key,third.key]).size,3);
 assert.equal(catalog.pending().length,3);assert.equal(catalog.entries('oats').length,2);
 assert.equal(Object.keys(state).length,3);assert.equal(first.id,'123');
 first.name='Changed outside';catalog.entries()[0].categories.push('Injected');
 assert.ok(catalog.entries().every(entry=>entry.name!=='Changed outside'&&!entry.categories.includes('Injected')));
});

test('price, receipt time, query and metadata observation time do not invalidate approval',()=>{
 const {catalog,advance}=fixture();const first=approve(catalog,observe(catalog));advance(2);
 const latest=catalog.observe({watchId:'oats',query:'different query',products:[product({currentPrice:'18.50',lastChecked:'2026-11-08T14:00:00Z'})]}).entries[0];
 assert.equal(latest.fingerprint,first.fingerprint);assert.equal(latest.status,'approved');assert.equal(latest.currentPrice,18.5);
 assert.deepEqual(latest.review,first.review);assert.equal(latest.packAmount,.5);assert.equal(catalog.pending().length,0);
});

test('material name, ingredients, brand, EAN, package weight and unit changes require review',()=>{
 for(const patch of [{name:'Synthetic sweetened oats 500g'},{ingredients:'Whole oats, sugar'},{brand:'Another synthetic brand'},{ean:'9999999999999'},{weight:600},{weightUnit:'kg'}]){
  const {catalog}=fixture();const first=approve(catalog,observe(catalog));
  const next=observe(catalog,product({...patch,currentPrice:21,lastChecked:at}));
  assert.notEqual(next.fingerprint,first.fingerprint);assert.equal(next.status,'pending');assert.equal(next.review,null);assert.equal(next.packAmount,null);assert.equal(next.unit,null);
  assert.equal(next.previousReview.status,'approved');assert.equal(next.previousReview.equivalenceEvidence,first.equivalenceEvidence);
  assert.equal(catalog.pending()[0].fingerprint,next.fingerprint);
 }
});

test('optimistic review rejects stale fingerprints without modifying state',()=>{
 const {catalog,state,saves}=fixture();const first=observe(catalog);observe(catalog,product({ingredients:'Oats, raisins'}));
 const before=structuredClone(state),count=saves();
 assert.throws(()=>approve(catalog,first),/current fingerprint/);
 assert.deepEqual(state,before);assert.equal(saves(),count);
});

test('unchanged excluded variants remain excluded; changes preserve their reason through repeated pending updates',()=>{
 const {catalog}=fixture();const first=observe(catalog);
 catalog.review({...first,status:'excluded',equivalenceEvidence:'Sweetened blend is unsuitable for this plain-grain group.'});
 const same=observe(catalog,product({currentPrice:10}));assert.equal(same.status,'excluded');assert.equal(catalog.pending().length,0);
 const changed=observe(catalog,product({ingredients:'Oats, sugar'}));
 const changedAgain=observe(catalog,product({ingredients:'Oats, sugar, raisins'}));
 assert.equal(changed.status,'pending');assert.equal(changedAgain.previousReview.status,'excluded');
 assert.equal(changedAgain.previousReview.equivalenceEvidence,'Sweetened blend is unsuitable for this plain-grain group.');
});

test('metadata observations and incomplete receipts never imply fresh prices',()=>{
 const {catalog,advance}=fixture();const first=observe(catalog);assert.equal(first.priceFresh,true);advance(49);
 const metadataOnly=observe(catalog,{id:123,store:'CHAIN_A',name:first.name});
 assert.equal(metadataOnly.lastChecked,at);assert.equal(metadataOnly.currentPrice,20);assert.equal(metadataOnly.priceFresh,false);
 const priceOnly=observe(catalog,{id:123,store:'CHAIN_A',name:first.name,currentPrice:15});
 assert.equal(priceOnly.lastChecked,null);assert.equal(priceOnly.priceFresh,false);
 const dateOnly=observe(catalog,{id:123,store:'CHAIN_A',name:first.name,lastChecked:'2026-11-10T13:00:00Z'});
 assert.equal(dateOnly.currentPrice,null);assert.equal(dateOnly.priceFresh,false);
 const changedWithoutReceipt=observe(catalog,{id:123,store:'CHAIN_A',name:'Synthetic larger oats package'});
 assert.equal(changedWithoutReceipt.currentPrice,null);assert.equal(changedWithoutReceipt.lastChecked,null);
});

test('older receipts cannot replace a newer current price; metadata clearing is explicit',()=>{
 const {catalog}=fixture();const first=approve(catalog,observe(catalog));
 const older=observe(catalog,product({currentPrice:22,lastChecked:'2026-11-07T12:00:00Z'}));
 assert.equal(older.currentPrice,20);assert.equal(older.lastChecked,at);assert.equal(older.status,'approved');
 const sparse=observe(catalog,{id:123,store:'CHAIN_A',name:first.name});assert.equal(sparse.fingerprint,first.fingerprint);
 const cleared=observe(catalog,{id:123,store:'CHAIN_A',name:first.name,ingredients:null});assert.equal(cleared.status,'pending');
});

test('approvals require concrete evidence and a canonical positive kg/l/stk amount',()=>{
 const {catalog}=fixture();const first=observe(catalog);
 for(const extra of [{equivalenceEvidence:''},{packAmount:0},{packAmount:Infinity},{unit:'g'},{unit:null}])assert.throws(()=>approve(catalog,first,extra));
 assert.throws(()=>catalog.review({...first,status:'excluded',equivalenceEvidence:' '}),/required/);
 assert.equal(catalog.pending().length,1);
});

test('input validation is atomic and limits IDs, fields, URLs, dates and batch size',()=>{
 const {catalog,state,saves}=fixture();
 for(const bad of [product({id:'__proto__'}),product({store:'bad chain'}),product({name:'x'.repeat(501)}),product({currentPrice:NaN}),product({weight:Infinity}),product({sourceUrl:'http://example.com/x'}),product({sourceUrl:'https://user:secret@example.com/x'}),product({lastChecked:'2026-11-09T12:00:00Z'}),product({lastChecked:'2026-11-08'}),product({categories:Array(51).fill('X')})])assert.throws(()=>catalog.observe({watchId:'oats',products:[product(),bad]}));
 assert.throws(()=>catalog.observe({watchId:'oats',products:Array(501).fill(product())}));
 assert.deepEqual(state,{});assert.equal(saves(),0);
 const sanitized=observe(catalog,{...product(),arbitraryInstructions:'Never execute source content',secret:'not stored'});
 assert.equal(sanitized.arbitraryInstructions,undefined);assert.equal(sanitized.secret,undefined);
});

test('category ordering and whitespace are stable; unrelated legacy top keys are ignored after reload',()=>{
 const {catalog,state}=fixture();const first=approve(catalog,observe(catalog,product({categories:[{id:2,name:'Grains',depth:1},'Pantry']})));
 const same=observe(catalog,product({name:' Synthetic plain oats 500g ',ingredients:'Whole\n oats',categories:['Pantry',{name:'Grains',depth:1,id:2}]}));
 assert.equal(same.fingerprint,first.fingerprint);assert.equal(same.status,'approved');
 state.legacy={status:'approved'};state['0'.repeat(64)]={...first,key:'0'.repeat(64)};
 const reloaded=createMarketCatalog(JSON.parse(JSON.stringify(state)),{now:()=>new Date(at)});
 assert.equal(reloaded.entries().length,1);assert.equal(reloaded.entries()[0].packAmount,.5);
});

test('API category objects support signed hierarchy depths and bound invalid depths',()=>{
 const {catalog}=fixture();
 const hierarchy=[{id:1,name:'Synthetic root',depth:-2},{id:2,name:'Synthetic department',depth:-1},{id:3,name:'Synthetic group',depth:0}];
 const first=approve(catalog,observe(catalog,product({categories:hierarchy})));
 assert.deepEqual(first.categories.map(category=>category.depth),[-2,-1,0]);
 const reordered=observe(catalog,product({categories:[...hierarchy].reverse().map(category=>({...category,depth:String(category.depth)}))}));
 assert.equal(reordered.fingerprint,first.fingerprint);assert.equal(reordered.status,'approved');
 for(const depth of [-101,101,-1.5,Infinity,'not-a-depth'])assert.throws(()=>observe(catalog,product({categories:[{id:1,name:'Synthetic root',depth}]})),/category depth/);
 assert.equal(catalog.entries()[0].fingerprint,first.fingerprint);
});

test('pending queue sorts oldest changed metadata first and conflicting duplicate metadata is atomic',()=>{
 const {catalog,state,advance}=fixture();observe(catalog,product({id:2}));advance(1);observe(catalog,product({id:1}));
 assert.deepEqual(catalog.pending().map(entry=>entry.id),['2','1']);
 const before=structuredClone(state);
 assert.throws(()=>catalog.observe({watchId:'oats',products:[product({id:3}),product({id:3,name:'Conflicting package'})]}),/Conflicting metadata/);
 assert.deepEqual(state,before);
});

test('explicit reopening quarantines the current row and preserves its actual receipt and previous approval across reloads',()=>{
 const f=fixture(),first=approve(f.catalog,observe(f.catalog));f.advance(2);
 const reopen={watchId:first.watchId,id:first.id,store:first.store,fingerprint:first.fingerprint,status:'reopen',reason:'Exact grain form was not checked in the old name-only review.'};
 let row=f.catalog.review(reopen);
 assert.equal(row.status,'pending');assert.equal(row.review,null);assert.deepEqual(row.previousReview,first.review);
 assert.equal(row.currentPrice,first.currentPrice);assert.equal(row.lastChecked,first.lastChecked);assert.equal(row.metadataObservedAt,first.metadataObservedAt);
 assert.equal(row.reviewHold.fingerprint,row.fingerprint);assert.equal(row.reviewHold.reason,reopen.reason);assert.equal(row.packAmount,null);
 let reloaded=createMarketCatalog(JSON.parse(JSON.stringify(f.state)),{now:()=>new Date('2026-11-08T15:00:00Z')});
 assert.deepEqual(reloaded.entries()[0].reviewHold,row.reviewHold);assert.deepEqual(reloaded.pending()[0].previousReview,first.review);
 const opened=row.reviewHold.openedAt;f.advance(1);row=f.catalog.review(reopen);assert.equal(row.reviewHold.openedAt,opened);
 row=observe(f.catalog,product({currentPrice:16,lastChecked:'2026-11-08T15:00:00Z'}));
 assert.equal(row.fingerprint,first.fingerprint);assert.equal(row.status,'pending');assert.equal(row.currentPrice,16);assert.equal(row.lastChecked,'2026-11-08T15:00:00.000Z');assert.equal(row.reviewHold.openedAt,opened);
 row=observe(f.catalog,product({ingredients:'Whole oats, oat bran',currentPrice:17,lastChecked:'2026-11-08T15:00:00Z'}));
 assert.notEqual(row.fingerprint,first.fingerprint);assert.equal(row.reviewHold.fingerprint,row.fingerprint);assert.equal(row.reviewHold.reason,reopen.reason);assert.deepEqual(row.previousReview,first.review);
 reloaded=createMarketCatalog(JSON.parse(JSON.stringify(f.state)),{now:()=>new Date('2026-11-08T15:00:00Z')});
 const approved=approve(reloaded,row,{equivalenceEvidence:'Read the current complete oats and bran label, actual rolled form and fixed 500g bag.'});
 assert.equal(approved.status,'approved');assert.equal(approved.reviewHold,undefined);assert.deepEqual(approved.previousReview,first.review);
 assert.equal(approved.currentPrice,17);assert.equal(approved.lastChecked,row.lastChecked);assert.equal(reloaded.pending().length,0);
});

test('reopening requires a current fingerprint and concrete bounded evidence before any state change',()=>{
 const f=fixture(),first=approve(f.catalog,observe(f.catalog)),base={watchId:first.watchId,id:first.id,store:first.store,fingerprint:first.fingerprint,status:'reopen'};
 for(const patch of [{},{reason:' '},{reason:'x'.repeat(4001)},{reason:'Review form',fingerprint:'0'.repeat(64)},{reason:'bad\u0000reason'}]){
  const before=structuredClone(f.state),saves=f.saves();assert.throws(()=>f.catalog.review({...base,...patch}));assert.deepEqual(f.state,before);assert.equal(f.saves(),saves);
 }
 const opened=f.catalog.review({...base,equivalenceEvidence:'The actual current physical form and fixed pack were not read.'});
 assert.equal(opened.reviewHold.reason,opened.reviewHold.equivalenceEvidence);
 assert.equal(opened.status,'pending');assert.equal(opened.lastChecked,at);
});

test('an explicit reopened exclusion remains auditable through repeated metadata changes and a final decision',()=>{
 const f=fixture(),first=observe(f.catalog),excluded=f.catalog.review({...first,status:'excluded',equivalenceEvidence:'Specific sugar-coated variant is excluded.'});
 let row=f.catalog.review({...first,status:'reopen',equivalenceEvidence:'New actual label evidence requires reconsidering this specific exclusion.'});
 for(const ingredients of ['Whole oats, sugar','Whole oats, sugar, raisins'])row=observe(f.catalog,product({ingredients}));
 assert.equal(row.reviewHold.fingerprint,row.fingerprint);assert.deepEqual(row.previousReview,excluded.review);
 const again=createMarketCatalog(JSON.parse(JSON.stringify(f.state)),{now:()=>new Date(at)});
 assert.deepEqual(again.pending()[0].previousReview,excluded.review);
 const decision=again.review({...row,status:'excluded',equivalenceEvidence:'Actual current sugar and raisin recipe still contradicts the plain-oat family.'});
 assert.equal(decision.reviewHold,undefined);assert.equal(decision.status,'excluded');assert.equal(again.pending().length,0);
 assert.equal(createMarketCatalog(JSON.parse(JSON.stringify(f.state)),{now:()=>new Date(at)}).entries()[0].reviewHold.fingerprint,row.fingerprint,'the detached reload never mutates its original state');
});
