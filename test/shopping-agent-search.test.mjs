import test from 'node:test';
import assert from 'node:assert/strict';
import {createIndexReader} from '../src/shopping-library.mjs';
import {createSesumDiscovery} from '../src/sesum-discovery.mjs';
import {createSesumPrices,sesumDonorFingerprint} from '../src/sesum-prices.mjs';
import {groupMetadataFingerprint} from '../src/product-library.mjs';

const NOW='2026-11-11T12:00:00Z',at=Date.parse(NOW);
const keyOf=i=>'kassal:ODA_NO:'+String(i).padStart(4,'0');
function product(i,changes={}){
 return {productKey:keyOf(i),source:'kassal',store:'ODA_NO',id:String(i),name:'Coffee '+String(i).padStart(4,'0'),brand:'Synthetic',ean:null,ingredients:'Whole roasted coffee beans',description:'Plain whole beans',pack:.5,packKnown:true,unit:'kg',packEvidence:'Actual fixed 500g package read.',rawPack:{weight:500,weightUnit:'g'},sourceUrl:'https://producer.example.test/coffee/'+i,available:true,attributes:null,nutrition:null,quote:{grossPackPrice:20,receiptAt:NOW,reasons:[],sourceUrl:'https://producer.example.test/receipt/'+i},...changes};
}
function indexOf(products){return {builtAt:NOW,groups:{},members:{},products:Object.fromEntries(products.map(p=>[p.productKey,p])),qualityNotes:{}};}

test('agent search enumerates every match with a total, continuation and explicit final page',()=>{
 const products=Array.from({length:25},(_,i)=>product(25-i)),read=createIndexReader(indexOf(products))(at),first=read.searchPage('coffee',{limit:20});
 assert.equal(first.total,25);assert.equal(first.matchedTotal,25);assert.equal(first.parked,0);assert.equal(first.items.length,20);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,20);
 const last=read.searchPage('coffee',{offset:first.nextOffset,limit:20,expectedFingerprint:first.fingerprint});assert.equal(last.items.length,5);assert.equal(last.hasMore,false);assert.equal(last.nextOffset,null);assert.equal(last.fingerprint,first.fingerprint);
 assert.deepEqual([...first.items,...last.items].map(r=>r.key),Array.from({length:25},(_,i)=>keyOf(i+1)));assert.equal(new Set([...first.items,...last.items].map(r=>r.key)).size,25);
 assert.deepEqual(read.searchPage('coffee',{offset:25}).items,[]);assert.deepEqual(read.search('coffee',20),first.items,'the existing bounded UI search keeps its array contract');
});

test('agent enumeration has no hidden five-thousand-match ceiling and resolves tied names by stable keys',()=>{
 const products=Array.from({length:5017},(_,i)=>product(5017-i,{name:'Coffee same name'})),index=indexOf(products),read=createIndexReader(index)(at),tail=read.searchPage('coffee',{offset:5000,limit:20});
 assert.equal(tail.total,5017);assert.equal(tail.items.length,17);assert.equal(tail.items.at(-1).key,keyOf(5017));assert.equal(tail.nextOffset,null);assert.equal(tail.hasMore,false);
 const reverse=createIndexReader(indexOf([...products].reverse()))(at);assert.deepEqual(read.searchPage('coffee'),reverse.searchPage('coffee'),'insertion order cannot change page identity or tied ordering');
 assert.equal(read.search('coffee',9999).length,5000,'legacy UI enumeration is not changed');
});

test('only evidenced old actual receipts park agent search; unknown or missing prices stay explicit research',()=>{
 const old=new Date(at-184*86400000).toISOString(),stale=new Date(at-100*86400000).toISOString(),products=[product(1),product(2,{quote:{grossPackPrice:20,receiptAt:old,reasons:[]}}),product(3,{quote:{grossPackPrice:null,receiptAt:null,reasons:['missing-price']}}),product(4,{quote:{grossPackPrice:20,receiptAt:stale,reasons:[]}}),product(5,{quote:{grossPackPrice:null,receiptAt:'unknown',reasons:['missing-price']}})],read=createIndexReader(indexOf(products))(at),page=read.searchPage('coffee');
 assert.equal(page.total,4);assert.equal(page.parked,1);assert.equal(page.matchedTotal,5);assert.ok(!page.items.some(r=>r.key===keyOf(2)));assert.ok(page.items.some(r=>r.key===keyOf(3)&&r.price.receiptAt===null&&r.price.fresh===false));assert.ok(page.items.some(r=>r.key===keyOf(4)&&r.price.fresh===false));assert.ok(page.items.some(r=>r.key===keyOf(5)&&r.price.fresh===false));
 assert.equal(read.search('coffee',20).length,5,'existing UI search retains its historical contract');
});

test('continuation rejects changed search ordering and bad bounds instead of silently skipping results',()=>{
 const index=indexOf([product(1,{name:'Coffee Z'}),product(2,{name:'Coffee A',quote:{grossPackPrice:20,receiptAt:new Date(at-47*3600000).toISOString(),reasons:[]}})]),factory=createIndexReader(index),first=factory(at).searchPage('coffee',{limit:1});
 assert.equal(first.items[0].key,keyOf(2));assert.throws(()=>factory(at+2*3600000).searchPage('coffee',{offset:1,expectedFingerprint:first.fingerprint}),/results changed/);
 const changed=createIndexReader(indexOf([...Object.values(index.products),product(3)]))(at);assert.throws(()=>changed.searchPage('coffee',{offset:1,expectedFingerprint:first.fingerprint}),/results changed/);
 for(const options of [{offset:-1},{offset:1.2},{offset:Number.MAX_SAFE_INTEGER+1},{limit:0},{limit:201},{limit:1.2},{expectedFingerprint:'not-a-fingerprint'}])assert.throws(()=>factory(at).searchPage('coffee',options),/search|fingerprint/);
 const empty=factory(at).searchPage('');assert.deepEqual(empty.items,[]);assert.equal(empty.total,0);assert.equal(empty.nextOffset,null);assert.equal(empty.hasMore,false);
});

test('registered and reviewed chain-overlay products inherit the same complete paginated search',()=>{
 const g={id:'whole-beans',name:'Whole coffee beans',category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Plain whole roasted coffee beans',exclusions:['Ground coffee'],qualityBasis:'Actual complete contents and physical form',comparisonBasis:'Per kilogram'},p=product(1),index=indexOf([p]);
 index.groups[g.id]={name:g.name,category:g.category,unit:g.canonicalUnit,fingerprint:groupMetadataFingerprint(g),inclusion:g.inclusionCriteria,exclusions:g.exclusions,qualityBasis:g.qualityBasis,comparisonBasis:g.comparisonBasis};index.members[g.id]=[{k:p.productKey,s:'approved',r:true,u:40,q:null,n:null}];
 const reader=()=>createIndexReader(index)(at),sourceKey='sesum:KIWI:900',observed={sourceKey,sourceFingerprint:'a'.repeat(64),source:{id:'900',store:'KIWI',name:'Coffee new variant',brand:'Synthetic',ean:[],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/900-coffee'}},discovery=createSesumDiscovery({},{reader,now:()=>new Date(NOW),source:key=>key===sourceKey?observed:null});
 discovery.register({sourceKey,sourceFingerprint:observed.sourceFingerprint,identityEvidence:'Actual new source variant and complete original label read.',product:{ingredients:'Whole roasted coffee beans',description:'Plain whole-bean roast'},packAmount:.5,unit:'kg',packEvidence:'Actual fixed net 500g package read.',memberships:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),equivalenceEvidence:'Actual whole-bean form and complete original contents match this group.',qualityEvidence:'Actual whole-bean ingredients and roast were read.'}],sourceReceipts:[{url:'https://producer.example.test/new-coffee',observedAt:NOW,evidence:'Actual original contents, form and fixed 500g package read.'}]});
 const prices=createSesumPrices({},{reader:()=>discovery.overlay(reader()),now:()=>new Date(NOW)});prices.ingest({familyIds:[],fetchedAt:NOW,products:[{id:'901',name:p.name,brand:p.brand,ean:[],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/901-coffee',prices:[{storeCode:'KIWI',price:14,observedAt:NOW,source:'actual-receipt',isPromo:false,promotion:null}]}]});
 const candidate=prices.candidates(null,'sesum:KIWI:901')[0];prices.review({sourceKey:candidate.sourceKey,sourceFingerprint:candidate.sourceFingerprint,productKey:p.productKey,productFingerprint:sesumDonorFingerprint(p),status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Actual source bag, full original contents and fixed package identify this same physical variant.',packEvidence:'Both exact reviewed records document the fixed 500g net package.'});
 const read=prices.overlay(),first=read.searchPage('coffee',{limit:2}),last=read.searchPage('coffee',{offset:first.nextOffset,limit:2,expectedFingerprint:first.fingerprint});assert.equal(first.total,3);assert.equal(last.hasMore,false);assert.deepEqual(new Set([...first.items,...last.items].map(r=>r.key)),new Set([p.productKey,sourceKey,'sesum:KIWI:901']));assert.equal(read.quote(sourceKey).price.receiptAt,null,'metadata registration never invents a fresh price');
});
