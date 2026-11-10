import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeUnitPriceBasis,unitPriceBasisFingerprint} from '../src/sesum-unit-basis.mjs';

const sourceUrl='https://www.sesum.no/produkt/77-synthetic-loose-root',observedAt='2026-11-09T21:36:01.28023+00:00';
const context={productId:'77',sourceUrl,storeId:9,storeCode:'REMA_1000',price:109,source:'receipt_realtime',observedAt};
const basis={kind:'own-chain-row-label-v1',productId:'77',sourceUrl,storeId:'9',storeCode:'REMA_1000',rowControl:'kjederad-9',label:'109,00 kr/kg',amount:109,unit:'kg',source:context.source,observedAt};

test('literal own-row amounts preserve microsecond source evidence and never replace it with capture time',()=>{
  const first=sanitizeUnitPriceBasis(basis,context);assert.equal(first.reason,null);assert.equal(first.basis.observedAt,observedAt);
  const earlier=unitPriceBasisFingerprint(first.basis,{sourceFingerprint:'a'.repeat(64),fetchedAt:'2026-11-10T00:00:00Z'}),later=unitPriceBasisFingerprint(first.basis,{sourceFingerprint:'a'.repeat(64),fetchedAt:'2026-11-10T12:00:00Z'});
  assert.notEqual(earlier,later);assert.equal(first.basis.observedAt,observedAt);
  for(const [label,amount] of [['1 234,50 kr/kg',1234.5],['1\u00a0234,50 kr/kg',1234.5],['1.234,50 NOK/kg',1234.5],['109 kr/kg',109]])assert.equal(sanitizeUnitPriceBasis({...basis,label,amount},{...context,price:amount}).reason,null);
  assert.equal(sanitizeUnitPriceBasis({...basis,label:'109,00 kr/l',unit:'l'},context).basis.unit,'l');
});

test('a hero, another row, changed receipt, ambiguous unit or injected nested field cannot prove an own unit quote',()=>{
  for(const patch of [{productId:'78'},{sourceUrl:'https://www.sesum.no/produkt/78-related-root'},{storeId:'2'},{storeCode:'KIWI'},{rowControl:'kjederad-2'},{label:'109,00 kr'},{label:'109,00 EUR/kg'},{label:'109.00 kr/kg'},{label:'109,001 kr/kg'},{label:'100,00 kr/kg'},{unit:'stk'},{amount:999},{source:'history_price'},{observedAt:'2026-11-09T21:36:01.280Z'},{profile:{cookie:'never-persist-this'}}]){
    const checked=sanitizeUnitPriceBasis({...basis,...patch},context);assert.equal(checked.basis,null,JSON.stringify(patch));assert.equal(checked.reason,'invalid-own-unit-price-basis');assert.equal(JSON.stringify(checked).includes('never-persist-this'),false);
  }
  assert.equal(sanitizeUnitPriceBasis(null,context).reason,'missing-own-unit-price-basis');
  assert.equal(sanitizeUnitPriceBasis(basis,{...context,price:109.004}).reason,null);assert.equal(sanitizeUnitPriceBasis(basis,{...context,price:109.006}).basis,null);
});
