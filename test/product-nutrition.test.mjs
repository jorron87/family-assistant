import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreFamilyNutrition} from '../src/product-nutrition.mjs';
const row=(key,per100,basis='g')=>({key,basis,per100});

test('nutrition is ranked inside the family on differences that matter',()=>{
 const scores=scoreFamilyNutrition([row('a',{sugars:30,salt:2,protein:5}),row('b',{sugars:10,salt:1,protein:5}),row('c',{sugars:20,salt:1.5,protein:5})]);
 assert.deepEqual([scores.get('a').level,scores.get('c').level,scores.get('b').level],['low','medium','good']);
 assert.equal(scores.get('b').score,100);assert.deepEqual(scores.get('b').measures.map(x=>x.key),['sugars','salt'],'equal protein is not a difference');
});
test('too few products, small spreads or protein alone give no indicator',()=>{
 assert.equal(scoreFamilyNutrition([row('a',{sugars:30}),row('b',{sugars:10})]).size,0);
 assert.equal(scoreFamilyNutrition([row('a',{sugars:10.5}),row('b',{sugars:10}),row('c',{sugars:10.2})]).size,0);
 assert.equal(scoreFamilyNutrition([row('a',{protein:10}),row('b',{protein:20}),row('c',{protein:15})]).size,0);
});
test('unknown facts stay unknown and never count as zero',()=>{
 const scores=scoreFamilyNutrition([row('a',{sugars:30,salt:2}),row('b',{sugars:10,salt:1}),row('c',{sugars:20,salt:1.5}),row('d',{sugars:null,salt:null}),row('e',{sugars:5,salt:null}),row('f',{sugars:15,salt:1.2},'ml')]);
 assert.equal(scores.has('d'),false);assert.equal(scores.has('f'),false,'another basis is not comparable');
 assert.equal(scores.has('e'),false,'most measured facts must be known');
});
