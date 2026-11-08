import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrateMarket} from '../src/shopping-market.mjs';

const now=new Date('2026-11-08T12:00:00Z');
const date=n=>new Date(Date.parse('2026-10-10T10:00:00Z')+n*86400000).toISOString();
function product(id,store,prices,overrides={}){return {id,ean:String(id).padStart(13,'0'),store,unit:'kg',packAmount:.5,reviewed:true,equivalenceEvidence:'Synthetic reviewed equivalent variant',lastChecked:date(prices.length-1),history:prices.map((n,i)=>({date:date(i),price:n*.5})),...overrides};}

test('daily market floor is not inflated by expensive chains or duplicate SKU counts',()=>{
 const low=Array.from({length:30},(_,i)=>i>=6&&i<=9?80:i>=20&&i<=22?70:100);
 const one=product(1,'A',low),high=product(2,'B',Array(30).fill(140));
 const first=calibrateMarket({unit:'kg',products:[one,high],now});
 const duplicated=calibrateMarket({unit:'kg',products:[one,...Array.from({length:50},(_,i)=>({...high,id:10+i}))],now});
 assert.equal(first.status,'ready');assert.equal(first.referencePrice,100);assert.equal(first.goodPrice,100);assert.equal(first.excellentPrice,70);
 assert.equal(first.supportedLow,70);assert.equal(first.support.longestRun,3);assert.equal(first.coverage.observedDays,30);
 assert.deepEqual(duplicated.quantiles,first.quantiles);assert.equal(duplicated.goodPrice,first.goodPrice);assert.equal(duplicated.excellentPrice,first.excellentPrice);
});

test('constant affordable prices have no invented excellent deal',()=>{
 const result=calibrateMarket({unit:'kg',products:[product(1,'A',Array(30).fill(100))],now});
 assert.equal(result.status,'ready');assert.equal(result.referencePrice,100);assert.equal(result.goodPrice,100);assert.equal(result.excellentPrice,null);
 assert.ok(result.warnings.includes('lack-of-price-variation'));assert.ok(result.warnings.includes('good-threshold-is-ordinary-cheap-price'));
});

test('latest cheaper obtainable price caps the good threshold without promoting an isolated minimum',()=>{
 const prices=Array(30).fill(100);prices[29]=60;
 const result=calibrateMarket({unit:'kg',products:[product(1,'A',prices)],now});
 assert.equal(result.currentBestPrice,60);assert.equal(result.historicalLow,60);assert.equal(result.goodPrice,60);assert.equal(result.supportedLow,100);assert.equal(result.excellentPrice,null);
 assert.ok(result.warnings.includes('historical-minimum-not-repeated-or-sustained'));
});

test('unreviewed, stale, wrong-unit and missing current histories are excluded with audit reasons',()=>{
 const good=product(1,'A',Array(30).fill(100));
 const result=calibrateMarket({unit:'kg',now,products:[good,
  product(2,'B',Array(30).fill(1),{reviewed:false}),
  product(3,'C',Array(30).fill(1),{unit:'l'}),
  product(4,'D',Array(30).fill(1),{lastChecked:'2024-01-01'}),
  product(5,'E',Array(5).fill(1),{lastChecked:now.toISOString()}),
  product(6,'F',Array(30).fill(1),{packAmount:0}),
  product(7,'G',Array(30).fill(1),{available:false})]});
 assert.equal(result.referencePrice,100);assert.equal(result.coverage.products,1);
 assert.deepEqual(new Set(result.exclusions.map(e=>e.reason)),new Set(['unreviewed-equivalence','unit-mismatch','stale-or-missing-current-receipt','no-fresh-price-in-history','invalid-pack-amount','delisted-or-unavailable']));
});

test('isolated impossible spikes are audited and cannot become current or historical low reference',()=>{
 const prices=Array(30).fill(100);prices[8]=.01;prices[20]=100000;
 const result=calibrateMarket({unit:'kg',products:[product(1,'A',prices)],now});
 assert.equal(result.historicalLow,100);assert.equal(result.referencePrice,100);assert.equal(result.rejectedObservations.filter(o=>o.reason==='extreme-temporal-outlier').length,2);
 assert.equal(result.excellentPrice,null);
});

test('sparse, short or large-gap histories remain insufficient rather than filling missing days',()=>{
 const base=product(1,'A',Array(30).fill(100));
 const sparse={...base,history:base.history.filter((_,i)=>i%3===0||i===29)};
 const short=product(2,'A',Array(5).fill(100),{lastChecked:now.toISOString(),history:Array.from({length:5},(_,i)=>({date:date(25+i),price:50}))});
 for(const p of [sparse,short]){const result=calibrateMarket({unit:'kg',products:[p],now});assert.equal(result.status,'insufficient');assert.equal(result.goodPrice,null);assert.equal(result.excellentPrice,null);}
 const gap={...base,history:base.history.filter((_,i)=>i<7||i>23)};
 const result=calibrateMarket({unit:'kg',products:[gap],now});assert.equal(result.coverage.largestGapDays,17);assert.ok(result.reasons.includes('large-history-gap'));assert.equal(result.coverage.observedDays,13);
});

test('repeated separate low episodes can support a stock-up level, while one-day low does not',()=>{
 const prices=Array(30).fill(100);prices[5]=80;prices[17]=80;prices[10]=60;
 const result=calibrateMarket({unit:'kg',products:[product(1,'A',prices)],now});
 assert.equal(result.historicalLow,60);assert.equal(result.supportedLow,80);assert.equal(result.excellentPrice,80);assert.equal(result.support.episodes,3);
});

test('date conflicts do not cherry-pick the lower value and a fresh explicit current receipt can anchor history',()=>{
 const p=product(1,'A',Array(30).fill(100));p.history.push({date:date(10),price:25});
 const result=calibrateMarket({unit:'kg',products:[p],now});assert.equal(result.historicalLow,100);assert.equal(result.coverage.observedDays,29);
 const past={...p,history:p.history.slice(0,25),lastChecked:now.toISOString(),currentPrice:45};
 const anchored=calibrateMarket({unit:'kg',products:[past],now});assert.equal(anchored.currentBestPrice,90);assert.equal(anchored.coverage.to,'2026-11-08');
});
