import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore} from '../src/shopping.mjs';

const NOW='2026-11-08T12:00:00Z',DAY=86400000;
const history=(from,count,price,packAmount=1)=>Array.from({length:count},(_,i)=>({date:new Date(Date.parse(`${from}T10:00:00Z`)+i*DAY).toISOString(),price:price*packAmount}));
function fixture({unit='kg'}={}){
 const state={},clock={at:NOW},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at)});
 const watch=shop.watch({id:'staple',name:'Synthetic reviewed staple',unit,storage:'pantry',purchaseAmount:12,stockAmount:3});
 function observe(id,extra={}){return shop.catalogObserve({watchId:watch.id,products:[{id,store:'CHAIN',name:`Synthetic staple ${id}`,ingredients:'Reviewed synthetic contents',currentPrice:100,lastChecked:clock.at,...extra}]}).entries[0];}
 function review(entry,{status='approved',packAmount=1,unit:packUnit=unit,equivalenceEvidence='Same reviewed contents and canonical package'}={}){return shop.catalogReview({watchId:watch.id,id:entry.id,store:entry.store,fingerprint:entry.fingerprint,status,packAmount,unit:packUnit,equivalenceEvidence});}
 function product(id,extra={}){return {id,store:'CHAIN',unit,packAmount:1,reviewed:true,equivalenceEvidence:'Current reviewed contents and package',lastChecked:clock.at,currentPrice:100,history:history('2026-10-10',30,100),...extra};}
 const market=(products,windowDays=90)=>shop.market({watchId:watch.id,products,windowDays});
 const prices=()=>shop.familyView().items.find(w=>w.id===watch.id).prices;
 return {state,clock,shop,watch,observe,review,product,market,prices};
}

test('changed reviewed cohort archives exact old derived series and removes excluded cheap days outside the new window',()=>{
 const f=fixture();f.review(f.observe('plain'));const wrong=f.observe('wrong',{ingredients:'Different variant'});f.review(wrong);
 const plain=f.product('plain'),wrongPrice=f.product('wrong',{history:history('2026-08-11',90,50),currentPrice:50});
 f.market([plain,wrongPrice]);
 const oldSeries=structuredClone(f.state.shopping.priceHistory.staple),oldBasis=structuredClone(f.state.shopping.priceHistoryBasis.staple),rawBefore=structuredClone(f.state.shopping.marketCatalog);
 assert.equal(f.prices().lowestSeen,50);assert.equal(f.prices().historyDays,90);
 f.review(wrong,{status:'excluded',equivalenceEvidence:'The actual variant does not meet this family requirement'});
 assert.equal(f.prices().historyDays,0,'unsafe history is hidden immediately, before recalibration');
 assert.equal(f.prices().lowestSeen,null);
 f.market([plain,wrongPrice],30);
 assert.equal(f.state.shopping.priceHistory.staple['2026-09-01'],undefined);
 assert.equal(f.prices().lowestSeen,100);assert.equal(f.prices().historyDays,30);
 const [archived]=f.state.shopping.priceHistoryArchive.staple;
 assert.deepEqual(archived.series,oldSeries);assert.deepEqual(archived.basis,oldBasis);assert.equal(archived.reason,'reviewed-product-basis-changed');
 assert.equal(archived.replacedBy,f.state.shopping.priceHistoryBasis.staple.fingerprint);
 const after=f.state.shopping.marketCatalog;
 for(const [key,row] of Object.entries(rawBefore)){assert.equal(after[key].currentPrice,row.currentPrice);assert.equal(after[key].lastChecked,row.lastChecked);assert.equal(after[key].ingredients,row.ingredients);}
 assert.equal(f.state.shopping.watches.staple.stockAmount,3);assert.equal(f.state.shopping.watches.staple.purchaseAmount,12);
});

test('same semantic basis preserves older observed days despite new prices, receipt times, evidence and review dates',()=>{
 const f=fixture();const entry=f.observe('plain');f.review(entry);
 f.market([f.product('plain',{history:history('2026-08-11',90,100)})]);
 const basis=structuredClone(f.state.shopping.priceHistoryBasis.staple);
 f.clock.at='2026-11-09T12:00:00Z';const updated=f.observe('plain',{currentPrice:90});f.review(updated,{equivalenceEvidence:'The same contents and package, checked again'});
 f.market([f.product('plain',{currentPrice:90,history:history('2026-10-11',30,90),equivalenceEvidence:'Updated review prose only'})],30);
 assert.deepEqual(f.state.shopping.priceHistoryBasis.staple,basis);
 assert.equal(f.state.shopping.priceHistory.staple['2026-08-11'],100);
 assert.equal(f.state.shopping.priceHistory.staple['2026-11-09'],90);
 assert.equal(Object.keys(f.state.shopping.priceHistory.staple).length,91);
 assert.equal(f.state.shopping.priceHistoryArchive.staple,undefined);
});

test('a bounded same-basis source response preserves earlier actual days within the requested window',()=>{
 const f=fixture();f.review(f.observe('plain'));
 f.market([f.product('plain',{history:history('2026-09-10',60,100)})]);
 const recent=history('2026-10-15',25,90);
 f.market([f.product('plain',{history:recent,currentPrice:90})],90);
 assert.equal(f.state.shopping.priceHistory.staple['2026-10-14'],100,'missing from latest25 does not retract a real prior receipt');
 assert.equal(f.state.shopping.priceHistory.staple['2026-10-15'],90,'received actual days replace their earlier scalar value');
 assert.equal(f.state.shopping.priceHistory.staple['2026-09-10'],100);
 assert.equal(f.prices().historyDays,60);assert.equal(f.state.shopping.priceHistoryArchive.staple,undefined);
});

test('native metadata changes and canonical package changes reset history even with the same SKU and chain',()=>{
 for(const change of ['metadata','pack']){
  const f=fixture();f.review(f.observe('plain'));
  f.market([f.product('plain',{history:history('2026-08-11',90,100)})]);
  const old=structuredClone(f.state.shopping.priceHistory.staple),basis=f.state.shopping.priceHistoryBasis.staple.fingerprint;
  if(change==='metadata'){
   const changed=f.observe('plain',{ingredients:'Changed actual contents'});assert.equal(f.prices().historyDays,0);f.review(changed);
  }else f.review(f.shop.catalogEntries('staple')[0],{packAmount:.5});
  assert.equal(f.prices().historyDays,0);
  f.market([f.product('plain',{packAmount:change==='pack'?.5:1,currentPrice:change==='pack'?50:100,history:history('2026-10-10',30,100,change==='pack'?.5:1)})],30);
  assert.notEqual(f.state.shopping.priceHistoryBasis.staple.fingerprint,basis);
  assert.equal(f.prices().historyDays,30);assert.equal(f.prices().lowestSeen,100);
  assert.deepEqual(f.state.shopping.priceHistoryArchive.staple[0].series,old);
 }
});

test('unit and caller-reviewed to catalog-managed changes cannot inherit a previous basis',()=>{
 const f=fixture();f.market([f.product('plain',{history:history('2026-08-11',90,100)})]);
 const unmanaged=f.state.shopping.priceHistoryBasis.staple.fingerprint;
 f.review(f.observe('plain'));assert.equal(f.prices().historyDays,0);
 f.market([f.product('plain')]);assert.notEqual(f.state.shopping.priceHistoryBasis.staple.fingerprint,unmanaged);
 const managed=f.state.shopping.priceHistoryBasis.staple.fingerprint;
 f.shop.watch({...f.shop.view().watches[0],unit:'l'});assert.equal(f.prices().historyDays,0);
 f.review(f.shop.catalogEntries('staple')[0],{unit:'l'});
 f.market([f.product('plain',{unit:'l'})]);assert.notEqual(f.state.shopping.priceHistoryBasis.staple.fingerprint,managed);
 assert.equal(f.state.shopping.priceHistoryBasis.staple.unit,'l');assert.equal(f.state.shopping.priceHistoryArchive.staple.length,2);
 const withCatalog=f.state.shopping.priceHistoryBasis.staple.fingerprint;
 f.state.shopping.watches.staple.catalogManaged=false;assert.equal(f.prices().historyDays,0);
 f.market([f.product('plain',{unit:'l'})]);assert.notEqual(f.state.shopping.priceHistoryBasis.staple.fingerprint,withCatalog);
 assert.equal(f.state.shopping.priceHistoryArchive.staple.length,3);
});

test('legacy unbound history is hidden and reversibly archived once rather than lent to a new cohort',()=>{
 const f=fixture();const legacy={'2026-09-01':1,'2026-09-02':2};f.state.shopping.priceHistory.staple=structuredClone(legacy);
 assert.equal(f.prices().historyDays,0);
 f.market([f.product('plain')],30);
 const [archived]=f.state.shopping.priceHistoryArchive.staple;
 assert.deepEqual(archived.series,legacy);assert.equal(archived.basis,null);assert.equal(archived.reason,'legacy-unbound-history');
 assert.equal(f.prices().historyDays,30);assert.equal(f.prices().lowestSeen,100);
 f.market([f.product('plain')],30);assert.equal(f.state.shopping.priceHistoryArchive.staple.length,1);
});

test('an insufficient calibration with no eligible products cannot leave the previous history visible',()=>{
 const f=fixture();const entry=f.observe('plain');f.review(entry);f.market([f.product('plain')]);
 const old=structuredClone(f.state.shopping.priceHistory.staple);
 f.review(entry,{status:'excluded',equivalenceEvidence:'Wrong exact variant for this family'});
 const result=f.market([f.product('plain')]);assert.equal(result.status,'insufficient');
 assert.deepEqual(f.state.shopping.priceHistory.staple,{});assert.equal(f.prices().historyDays,0);assert.equal(f.prices().lowestSeen,null);
 assert.deepEqual(f.state.shopping.priceHistoryArchive.staple[0].series,old);
});

test('an incomplete stored history basis is ignored safely',()=>{
 const f=fixture();f.review(f.observe('plain'));f.market([f.product('plain')]);
 const old=structuredClone(f.state.shopping.priceHistory.staple);
 delete f.state.shopping.priceHistoryBasis.staple.products;
 assert.equal(f.prices().historyDays,0);assert.equal(f.prices().lowestSeen,null);
 f.market([f.product('plain',{history:history('2026-10-15',25,100)})]);
 assert.equal(f.state.shopping.priceHistory.staple['2026-10-10'],undefined,'an unknown stored basis must rebuild rather than merge');
 assert.deepEqual(f.state.shopping.priceHistoryArchive.staple[0].series,old);
});

test('basis is independent of input ordering, duplicate rows and numeric versus string SKU IDs',()=>{
 const f=fixture(),one=f.product(1),two=f.product(2,{store:'OTHER'});
 f.market([one,two]);const basis=structuredClone(f.state.shopping.priceHistoryBasis.staple);
 f.market([{...two,id:'2'},{...one,id:'1'},one]);
 assert.deepEqual(f.state.shopping.priceHistoryBasis.staple,basis);
 assert.equal(f.state.shopping.priceHistoryArchive.staple,undefined);
});

test('an insufficient changed cohort quarantines automatic guides and archives them exactly, even without scalar history',()=>{
 for(const legacy of [false,true]){
  const f=fixture();const entry=f.observe('plain');f.review(entry);
  f.market([f.product('plain')]);
  if(legacy){delete f.state.shopping.priceHistoryBasis.staple;delete f.state.shopping.priceHistory.staple;}
  const w=f.state.shopping.watches.staple,old={priceGuide:structuredClone(w.priceGuide),targetPrice:w.targetPrice,excellentPrice:w.excellentPrice};
  f.review(entry,{status:'excluded',equivalenceEvidence:'This exact variant is unsuitable'});
  const result=f.market([f.product('plain')]);
  assert.equal(result.status,'insufficient');assert.equal(w.marketCalibration.status,'insufficient');
  assert.equal(w.priceGuide,null);assert.equal(w.targetPrice,null);assert.equal(w.excellentPrice,null);
  assert.deepEqual(f.state.shopping.priceHistoryArchive.staple[0].automaticGuide,old);
  assert.equal(w.marketCalibration.fallback.status,'needs-review');assert.equal(w.marketCalibration.fallback.automaticGuideQuarantined,true);
  assert.match(f.prices().basis,/varegrunnlag/);assert.equal(f.prices().normal,null);assert.equal(f.prices().good,null);assert.equal(f.prices().excellent,null);
  assert.equal(w.stockAmount,3);assert.equal(w.purchaseAmount,12);
  if(legacy)assert.deepEqual(f.state.shopping.priceHistoryArchive.staple[0].series,{});
  f.market([f.product('plain')]);assert.equal(w.marketCalibration.fallback.automaticGuideQuarantined,true);assert.equal(f.state.shopping.priceHistoryArchive.staple.length,1);
 }
});

test('an insufficient changed cohort preserves explicitly manual guides and limits',()=>{
 const f=fixture();const entry=f.observe('plain');f.review(entry);f.market([f.product('plain')]);
 f.shop.watch({...f.shop.view().watches[0],manualLimits:true,targetPrice:80,excellentPrice:60,priceGuide:{referencePrice:100,checkedAt:NOW,evidence:'Explicit household guide'}});
 const w=f.state.shopping.watches.staple,old={priceGuide:structuredClone(w.priceGuide),targetPrice:w.targetPrice,excellentPrice:w.excellentPrice};
 f.review(entry,{status:'excluded',equivalenceEvidence:'This exact variant is unsuitable'});
 assert.equal(f.market([f.product('plain')]).status,'insufficient');
 assert.deepEqual({priceGuide:w.priceGuide,targetPrice:w.targetPrice,excellentPrice:w.excellentPrice},old);
 assert.equal(w.marketCalibration.fallback.automaticGuideQuarantined,false);assert.equal(f.state.shopping.priceHistoryArchive.staple[0].automaticGuide,undefined);
});

test('an insufficient same-basis response retains the existing labelled fallback guide',()=>{
 const f=fixture();f.review(f.observe('plain'));f.market([f.product('plain')]);
 const w=f.state.shopping.watches.staple,old={priceGuide:structuredClone(w.priceGuide),targetPrice:w.targetPrice,excellentPrice:w.excellentPrice};
 const result=f.market([f.product('plain',{history:history('2026-11-04',5,100)})]);
 assert.equal(result.status,'insufficient');
 assert.deepEqual({priceGuide:w.priceGuide,targetPrice:w.targetPrice,excellentPrice:w.excellentPrice},old);
 assert.equal(w.marketCalibration.fallback,undefined);assert.equal(f.state.shopping.priceHistoryArchive.staple,undefined);
 assert.equal(f.prices().historyDays,30);
});

test('an initial planning guide without known generated market provenance survives insufficient new basis',()=>{
 const f=fixture();f.shop.watch({...f.shop.view().watches[0],targetPrice:80,excellentPrice:60,priceGuide:{referencePrice:100,checkedAt:NOW,evidence:'Conservative documented paid planning reference'}});
 const w=f.state.shopping.watches.staple,old={priceGuide:structuredClone(w.priceGuide),targetPrice:w.targetPrice,excellentPrice:w.excellentPrice};
 assert.equal(f.market([]).status,'insufficient');
 assert.deepEqual({priceGuide:w.priceGuide,targetPrice:w.targetPrice,excellentPrice:w.excellentPrice},old);
 assert.equal(w.marketCalibration.fallback.status,'needs-review');assert.equal(w.marketCalibration.fallback.automaticGuideQuarantined,false);
 assert.equal(f.state.shopping.priceHistoryArchive.staple,undefined);
});
