import test from 'node:test';
import assert from 'node:assert/strict';
import {researchScope,groupPlacementWork} from '../src/sesum-research-scope.mjs';
test('targeted discovery is brand independent, accent tolerant and fails open without complete family configuration',()=>{
 const f=[{familyId:'milk'},{familyId:'beans'}],terms={milk:['melk','mjølk'],beans:['kaffebønner']};
 assert.equal(researchScope({name:'New brand Kaffebonner 500g'},f,terms).candidate,true);
 assert.equal(researchScope({name:'Another brand Helmjølk 1l'},f,terms).candidate,true);
 assert.equal(researchScope({name:'Organic whole chicken'},f,terms).candidate,false);
 assert.equal(researchScope({name:'Unknown opaque brand'},f,{milk:['melk']}).candidate,true);
});
test('shared metadata groups research without losing chain-specific review inputs or mutating observations',()=>{
 const rows=[{sourceKey:'sesum:KIWI:1',fp:'same'},{sourceKey:'sesum:REMA_1000:1',fp:'same'},{sourceKey:'sesum:KIWI:2',fp:'different'}],before=JSON.stringify(rows),groups=groupPlacementWork(rows,x=>x.fp);
 assert.equal(groups.length,2);assert.equal(groups[0].sourceCount,2);assert.equal(groups[0].relatedSources[0].sourceKey,'sesum:REMA_1000:1');assert.equal(JSON.stringify(rows),before);
});
