import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshDraftChoices,splitCheaper} from '../public/shopping-view.mjs';
const item=extra=>({watchId:'test-beans',productId:1,packAmount:.225,unit:'kg',packs:51,elsewhere:null,maxAtOda:null,...extra});

test('new live prices replace untouched draft quantities and route defaults in an already-open page',()=>{
 const edits=new Map([['test-beans',{on:true,packs:51}]]);
 refreshDraftChoices(edits,[item()],[item({packs:2,elsewhere:{storeName:'Other chain'}})]);
 assert.equal(edits.get('test-beans').packs,2);assert.equal(edits.get('test-beans').on,false);
 refreshDraftChoices(edits,[item({packs:2,elsewhere:{storeName:'Other chain'}})],[item({packs:3})]);
 assert.equal(edits.get('test-beans').packs,3);assert.equal(edits.get('test-beans').on,true);
});

test('explicit household quantities and checkboxes survive refresh, within actual store limits',()=>{
 const edits=new Map([['test-beans',{on:false,packs:7,userOn:true,userPacks:true}]]);
 refreshDraftChoices(edits,[item()],[item({packs:2})]);assert.equal(edits.get('test-beans').packs,7);assert.equal(edits.get('test-beans').on,false);
 refreshDraftChoices(edits,[item({packs:2})],[item({packs:1,maxAtOda:4})]);assert.equal(edits.get('test-beans').packs,4);
});

test('a changed package or product cannot inherit the previous package count',()=>{
 const edits=new Map([['test-beans',{on:false,packs:7,userOn:true,userPacks:true}]]);
 refreshDraftChoices(edits,[item()],[item({productId:2,packAmount:.5,packs:2})]);
 assert.equal(edits.get('test-beans').packs,2);assert.equal(edits.get('test-beans').on,false);assert.equal(edits.get('test-beans').userPacks,false);
 refreshDraftChoices(edits,[item({productId:2,packAmount:.5,packs:2})],[]);assert.equal(edits.size,0);
});

test('lines that are cheaper elsewhere are grouped first, biggest saving on top',()=>{
 const a={id:'a',places:[{}],savings:{annual:10}},b={id:'b',places:[{}],savings:{annual:90}},c={id:'c',places:[]},d={id:'d'};
 let split=splitCheaper([c,a,d,b]);
 assert.deepEqual(split.cheaper.map(x=>x.id),['b','a']);assert.deepEqual(split.rest.map(x=>x.id),['c','d']);
 split=splitCheaper([b,a],x=>x.id==='a'?5:1);assert.deepEqual(split.cheaper.map(x=>x.id),['a','b']);
 assert.deepEqual(splitCheaper([]),{cheaper:[],rest:[]});
});
