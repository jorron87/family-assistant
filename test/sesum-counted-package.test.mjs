import test from 'node:test';
import assert from 'node:assert/strict';
import {countedPackage} from '../src/sesum-counted-package.mjs';
const NOW=Date.parse('2026-11-10T12:00:00Z'),source={weight:8,weightUnit:'stk',soldByWeight:false};
const proof={reviewed:true,wholePack:true,sourceCount:8,packAmount:.32,unit:'kg',evidence:'Read the original exact eight-piece consumer bag: all eight pieces together have a declared net mass of 320 g, not 320 g per piece.',sourceReceipts:[{url:'https://producer.example.test/original-eight-pack',observedAt:'2026-11-10T11:00:00Z',evidence:'Read the actual whole original eight-piece pack and its total net 320 g declaration.'}]};
const expected={packAmount:.32,unit:'kg',at:NOW};

test('a same-pack count and total mass are separate explicit measurements, not multiplied guesses',()=>{
 const before=structuredClone(proof),measure=countedPackage(source,proof,expected);assert.equal(measure.sourceCount,8);assert.equal(measure.packAmount,.32);assert.equal(measure.unit,'kg');assert.equal(measure.rule,'counted-package-net-measure-v1');assert.deepEqual(proof,before);assert.deepEqual(source,{weight:8,weightUnit:'stk',soldByWeight:false});
 assert.throws(()=>countedPackage(source,proof,{...expected,packAmount:2.56}),/WHOLE pack/);assert.throws(()=>countedPackage(source,proof,{...expected,packAmount:.04}),/WHOLE pack/);
});

test('counted quantities cannot override unknown, conflicting, variable, same-unit or drained packages',()=>{
 for(const change of [{weight:4},{weight:null},{weight:8.5},{weightUnit:'g'},{weightUnit:'unknown'},{soldByWeight:true},{soldByWeight:null}])assert.throws(()=>countedPackage({...source,...change},proof,expected));
 for(const change of [{reviewed:false},{wholePack:false},{sourceCount:4},{unit:'l'},{packAmount:0},{evidence:'320g'},{sourceReceipts:[]},{perItemPackAmount:.32},{receiptAt:'2026-11-10T12:00:00Z'},{rule:'unreviewed-guess'}])assert.throws(()=>countedPackage(source,{...proof,...change},expected));
 assert.throws(()=>countedPackage(source,proof,{...expected,unit:'stk'}));assert.throws(()=>countedPackage(source,proof,{...expected,packBasis:'drained'}));assert.throws(()=>countedPackage(source,null,expected));
 assert.equal(countedPackage(source,undefined,expected),null);
 assert.equal(countedPackage({...source,soldByWeight:null},proof,{...expected,fixedPackVerified:true}).packAmount,.32);
});

test('actual HTTPS primary receipts are mandatory and never become price timestamps',()=>{
 for(const change of [{url:'http://producer.example.test/'},{url:'https://user:pass@producer.example.test/'},{observedAt:'2026-11-11T12:00:00Z'},{observedAt:'2026-11-10'},{evidence:'guessed'}])assert.throws(()=>countedPackage(source,{...proof,sourceReceipts:[{...proof.sourceReceipts[0],...change}]},expected));
 const measure=countedPackage(source,proof,expected);assert.equal(measure.receiptAt,undefined);assert.equal(measure.price,undefined);assert.equal(measure.sourceReceipts[0].observedAt,proof.sourceReceipts[0].observedAt);
});

