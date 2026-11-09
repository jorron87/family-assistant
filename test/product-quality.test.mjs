import test from'node:test';import assert from'node:assert/strict';
import{scoreProductQuality}from'../src/product-quality.mjs';
const score=(ingredients,groupId='ketchup-standard',extra={})=>scoreProductQuality({ingredients,...extra},{groupId,reviewCurrent:true});
test('ketchup scores compare tomato input on the same basis, never puree percentage',()=>{
 const a=score('Tomater (148 g per 100 g ketchup), sukker, salt.'),b=score('Tomatpuré 80 %, sukker.',undefined,{description:'2 kilo tomater til 1 kilo Tomatketchup.'});
 assert.equal(a.score,74);assert.equal(b.score,100);assert.equal(a.comparisonKey,b.comparisonKey);assert.equal(b.measurement.value,200);
 const unknown=score('Tomatpuré 80 %, sukker, salt.');assert.equal(unknown.score,null);assert.equal(unknown.context[0].value,80);
 assert.equal(score('Tomatpuré 18 %, vann, sukker').score,null);
});
test('tomato statements from different source fields must agree; missing or impossible data cannot win',()=>{
 assert.equal(score('Tomater (148g per100g ketchup)',undefined,{description:'2 kg tomater til 1 kg ketchup'}).score,null);
 assert.equal(score('Tomatpuré 37 %, vann. Til 100 g ketchup er det brukt 110 g friske tomater.').score,55);
 assert.equal(score('Tomater (2000 g per 100 g ketchup)').score,null);
 assert.equal(score('Tomater, sukker.',undefined,{description:'1000148 kg tomater til 1 kg ketchup'}).score,null);
 assert.equal(score('Tomater, sukker, salt').score,null);
});
test('nested fruit-juice/rind and unrelated percentages never become total fruit share',()=>{
 const missing=score('Sukker, appelsiner (appelsinskall 26 %, appelsinsaft 27 %), vann.','fruit-spread-orange');assert.equal(missing.score,null);
 const p=score('Appelsiner 40 %, sukker 55 %, vann.','fruit-spread-orange');assert.equal(p.score,40);
 assert.notEqual(p.comparisonKey,score('Blåbær 40 %, sukker 55 %, vann.','fruit-spread-blueberry').comparisonKey);
 const f=score('Sukker. Fremstilt av 62 g frukt og bær per 100 g.','fruit-spread-orange');assert.equal(f.score,62);assert.notEqual(p.comparisonKey,f.comparisonKey);
});
test('percentage decimals, multilingual names and single-ingredient declarations remain explicit',()=>{
 assert.equal(score('Ristede peanøtter (99,3 %), havsalt.','peanut-butter-near-pure').score,99.3);
 assert.equal(score('Peanøtter, havsalt.','peanut-butter-near-pure').score,null);
 assert.equal(score('Peanøtter','peanut-butter-100').score,100);
 assert.equal(score('Sukker, hasselnøttkjerner / hasselnøddekerner* 9 %, kakao.','hazelnut-chocolate-spread').score,9);
 assert.equal(score('Socker, hasselnötter (13%), kakao.','hazelnut-chocolate-spread').score,13);
});
test('fish quantity is total fish, not an arbitrary nested species percentage',()=>{
 assert.equal(score('Fisk (60 %), melk, potetmel.','fishcakes-high').score,60);
 assert.equal(score('Fisk (hyse 40 %, sei 20 %), melk.','fishcakes-high').score,null);
 assert.equal(score('Fisk 60 %, fisk 80 %, melk.','fishcakes-high').score,null);
 assert.equal(score('Fisk 60 % av fisken er torsk, vann.','fishcakes-high').score,null);
 assert.equal(score('Peanøtter 90 % av nøttene er ristede, salt.','peanut-butter-near-pure').score,null);
});

test('fishcake content uses one explicit total-share basis across researched fish tiers',()=>{
 const ordinary=score('Fisk 52 % [torsk, hyse, sei], vann.','fishcakes-ordinary');
 const high=score('Fisk 80 % [torsk 60 %, hyse 40 %], vann.','fishcakes-very-high--burger');
 assert.equal(ordinary.score,52);assert.equal(high.score,80);
 assert.equal(ordinary.comparisonKey,high.comparisonKey);
 assert.equal(score('Fisk (hyse 80 %, sei 20 %), vann.','fishcakes-very-high').score,null);
 assert.equal(score('Fisk [torsk, hyse, sei] 52 %, vann.','fishcakes-ordinary').score,52);
 assert.equal(score('Fisk [torsk 60 %, hyse 40 %] 80 %, vann.','fishcakes-very-high').score,80);
 assert.equal(score('Fisk [torsk 60 %, hyse 40 %], vann.','fishcakes-very-high').score,null);
 assert.equal(score('Fisk [torsk, hyse] 80 % av råvarene er norske.','fishcakes-very-high').score,null);
 assert.equal(score('Fisk 52 %, fisk 80 %, vann.','fishcakes-ordinary').score,null);
 assert.equal(score('Fisk 50 % (hvitlaks, surimi), melk.','fishcakes-surimi-ordinary').status,'not-applicable');
 assert.equal(score('Fisk 65 %, hvetemel.','fishsticks-breaded').status,'not-applicable');
});

test('fish fillet and trimmed fish are separate documented quality dimensions',()=>{
 const fillet=score('Fiskefilet (41%), melk, salt.','fishcakes-ordinary');
 const trimmed=score('Renskåret hvit- fisk (51%), melk, salt.','fishcakes-ordinary');
 const total=score('Fisk (60%), melk, salt.','fishcakes-ordinary');
 assert.equal(fillet.score,41);assert.equal(trimmed.score,51);assert.equal(total.score,60);
 assert.notEqual(fillet.comparisonKey,trimmed.comparisonKey);assert.notEqual(fillet.comparisonKey,total.comparisonKey);assert.notEqual(trimmed.comparisonKey,total.comparisonKey);
 assert.equal(score('48 % fersk fiskefilet (50% hyse/torsk og 50% sei), melk.','fishcakes-ordinary').score,48);
 assert.equal(score('Fersk hysefilet (49%), melk.','fishcakes-ordinary').score,49);
 for(const s of ['Fiskefilet 41 % av fisken er hyse, melk.','41 % fiskefilet av fisken er hyse, melk.','Fiskeblanding (fiskefilet 41%), melk.','Fiskefilet 41 %, fiskefilet 48 %, melk.','Fiskefilet 41 %, renskåret fisk 48 %, melk.','Fiskefilet 120 %, melk.'])assert.equal(score(s,'fishcakes-ordinary').score,null,s);
});

test('explicit label syntax preserves quantity without borrowing nested or relative percentages',()=>{
 assert.equal(score('100% Peanøtter','peanut-butter-100').score,100);
 assert.equal(score('Ristede og malte økologiske peanøtter 99,4% (Norge), havsalt.','peanut-butter-near-pure').score,99.4);
 assert.equal(score('Øko appelsin (50%), sukker.','fruit-spread-orange').score,50);
 assert.equal(score('Villblåbær* 55%, konsentrert eplejuice, pektin.','fruit-spread-blueberry').score,55);
 assert.equal(score('100 % av peanøttene er ristede, havsalt.','peanut-butter-near-pure').score,null);
 assert.equal(score('50% peanøttsmørblanding, sukker.','peanut-butter-standard').score,null);
 assert.equal(score('Peanøttblanding (100% peanøtter), salt.','peanut-butter-near-pure').score,null);
 assert.equal(score('100% peanøtter, peanøtter 90%.','peanut-butter-100').reasons[0],'conflicting-declared-amounts');
 assert.equal(score('100% tomatpuré, vann.').score,null);
});
test('category scope, review gate and nutrition facts never imply health or freshness',()=>{
 const p={ingredients:'Tomater (148g per100g ketchup)',nutrition:{basis:'g',per100:{sugars:18,salt:1.6}}};
 assert.equal(scoreProductQuality(p,{groupId:'ketchup-standard'}).score,null);
 const q=scoreProductQuality(p,{groupId:'ketchup-standard',reviewCurrent:true});assert.equal(q.nutrition.sugars,18);assert.equal(q.score,74);assert.equal(q.eligible,undefined);
 assert.equal(score('Melk, salt.','cheese-mild-standard').status,'not-applicable');
 assert.equal(score('Tomater (148g per100g ketchup)',undefined,{nutrition:{basis:'ml',per100:{sugars:1}}}).nutrition,null);
 assert.equal(score('Tomater (148g per100g ketchup) sukker 10 %',undefined,{description:'Økologisk og dyr vare'}).score,74);
});
test('reviewed cross-source label facts retain their own source and detect contradiction',()=>{
 const p={ingredients:null,sourceUrl:'https://store.example/sku',nutritionObservation:{crossSourceLabel:{ingredients:'Tomatpuré 80 %, sukker.',description:'2 kg tomater til 1 kg ketchup',sourceUrl:'https://producer.example/label'}}};
 const q=scoreProductQuality(p,{groupId:'ketchup-standard',reviewCurrent:true});assert.equal(q.score,100);assert.equal(q.measurement.evidence[0].field,'crossSourceLabel.description');assert.equal(q.measurement.evidence[0].sourceUrl,'https://producer.example/label');
 p.description='1 kg tomater til 1 kg ketchup';assert.equal(scoreProductQuality(p,{groupId:'ketchup-standard',reviewCurrent:true}).score,null);
});
