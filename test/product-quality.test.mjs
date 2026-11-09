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
test('crunchy peanut butter uses explicit whole-product share for bilingual and dry-roasted labels',()=>{
 const id='peanut-butter-crunchy-sweet';
 const a=score('Peanuts/peanøtter 87 %, sukker, salt.',id),b=score('Tørristede peanøtter (92 %), sukker, salt.',id);
 assert.equal(a.score,87);assert.equal(b.score,92);assert.equal(a.comparisonKey,b.comparisonKey);
 assert.equal(a.comparisonKey,score('Peanøtter 87 %, salt.','peanut-butter-standard').comparisonKey);
 for(const s of ['Peanuts/peanøtter, sukker 87 %.','Tørristede peanøtter 87 % av nøttene, sukker.','Peanuts/peanøtter (87 %) av nøttene er ristede, sukker.','Nøtteblanding (peanuts/peanøtter 87 %), sukker.','Peanuts/peanøtter 87 %, peanøtter 90 %, salt.','Peanøtter 101 %, salt.'])assert.equal(score(s,id).score,null,s);
 assert.equal(scoreProductQuality({ingredients:'Peanuts/peanøtter 87 %, salt.'},{groupId:id}).status,'review-required');
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
 assert.equal(score('Fisk [torsk, hyse] 80 %) av fisken er norsk.','fishcakes-very-high').score,null);
 assert.equal(score('Fisk 52 %, fisk 80 %, vann.','fishcakes-ordinary').score,null);
 assert.equal(score('Fisk 50 % (hvitlaks, surimi), melk.','fishcakes-surimi-ordinary').status,'not-applicable');
 assert.equal(score('Fisk 65 %, hvetemel.','fishsticks-breaded').score,65);
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
test('a reviewed primary supplier statement carries its own source and preserves contradictions',()=>{
 const p={ingredients:'Tomatkonsentrat 68%, sukker, salt.',sourceUrl:'https://store.example/sku',nutritionObservation:{primaryLabel:{primaryUrl:'https://supplier.example/sku',description:'Det brukes 750 gram friske solmodne tomater for å lage 300 gram ketchup.'}}};
 const q=scoreProductQuality(p,{groupId:'ketchup-standard',reviewCurrent:true});assert.equal(q.score,100);assert.equal(q.measurement.value,250);assert.equal(q.measurement.evidence[0].field,'primaryLabel.description');assert.equal(q.measurement.evidence[0].sourceUrl,'https://supplier.example/sku');
 const noSource=structuredClone(p);delete noSource.nutritionObservation.primaryLabel.primaryUrl;assert.equal(scoreProductQuality(noSource,{groupId:'ketchup-standard',reviewCurrent:true}).score,null);
 p.description='2 kg tomater til 1 kg ketchup';assert.equal(scoreProductQuality(p,{groupId:'ketchup-standard',reviewCurrent:true}).score,null);
 assert.equal(scoreProductQuality(p,{groupId:'ketchup-standard'}).score,null);
 assert.equal(score('Peanøtter*','peanut-butter-100').score,100);
 assert.equal(score('Peanøtter*, havsalt.','peanut-butter-100').score,null);
});
test('supplier fruit input remains distinct from declared fruit percentage',()=>{
 const p={ingredients:'Solbær, sukker, vann, pektin.',nutritionObservation:{primaryLabel:{primaryUrl:'https://supplier.example/jam',description:'Framstilt av 60 g solbær per 100 g ferdig produkt.'}}};
 const q=scoreProductQuality(p,{groupId:'fruit-spread-blackcurrant',reviewCurrent:true});assert.equal(q.score,60);assert.equal(q.measurement.basis,'fruit-input-g-per-100g');assert.equal(q.measurement.evidence[0].sourceUrl,'https://supplier.example/jam');
 assert.notEqual(q.comparisonKey,score('Solbær 60 %, sukker.','fruit-spread-blackcurrant').comparisonKey);
 p.ingredients='Solbær, sukker. Fremstilt av 40 g solbær per 100 g.';assert.equal(scoreProductQuality(p,{groupId:'fruit-spread-blackcurrant',reviewCurrent:true}).score,null);
});
test('crispbread fiber score uses only a sourced per-100g nutrition fact',()=>{
 const product={ingredients:'Fullkornsrugmel, gjær, salt.',sourceUrl:'https://store.example/bread',nutrition:{basis:'g',sourceUrl:'https://supplier.example/label',per100:{fiber:15,sugars:1,salt:1}}};
 const options={groupId:'crispbread-rye',reviewCurrent:true},q=scoreProductQuality(product,options);
 assert.equal(q.score,50);assert.equal(q.label,'Kostfiber');assert.equal(q.measurement.value,15);assert.equal(q.measurement.basis,'dietary-fiber-g-per-100g');assert.equal(q.measurement.evidence[0].sourceUrl,'https://supplier.example/label');
 assert.equal(q.nutrition.salt,1);assert.equal(q.nutrition.sugars,1);assert.equal(q.nutrition.fiber,15);
 for(const fiber of [undefined,-1,101,NaN])assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,per100:{fiber}}},options).score,null);
 assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,basis:'ml'}},options).score,null);
 assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,sourceUrl:null}},options).score,null);
 const conflict=scoreProductQuality({...product,nutritionObservation:{fiberConflict:{evidence:'Conflicting supplier values.'}}},options);assert.equal(conflict.score,null);assert.equal(conflict.reasons[0],'conflicting-fiber-labels');
 assert.equal(scoreProductQuality(product,{groupId:'crispbread-rye'}).status,'review-required');
 assert.equal(scoreProductQuality(product,{groupId:'bread-white',reviewCurrent:true}).status,'not-applicable');
});

test('fruit muesli fiber compares sourced labels within its own group and suppresses conflicts',()=>{
 const p={ingredients:'Havre, frukt.',nutrition:{basis:'g',per100:{fiber:8.6,sugars:13,salt:.31},sourceUrl:'https://producer.example/label'}};
 const opts={groupId:'muesli-fruit-raisin-pineapple-banana',reviewCurrent:true},a=scoreProductQuality(p,opts),b=scoreProductQuality({...p,nutrition:{...p.nutrition,per100:{fiber:9.8,sugars:15,salt:.05}}},opts);
 assert.equal(a.score,57.3);assert.equal(b.score,65.3);assert.equal(a.measurement.value,8.6);assert.equal(a.nutrition.sugars,13);assert.equal(a.normalization.target,15);
 const practical=scoreProductQuality({...p,nutrition:{...p.nutrition,per100:{fiber:10.2,sugars:18,salt:.01}}},{groupId:'muesli-fruit-practical',reviewCurrent:true});
 assert.equal(practical.score,68);assert.equal(practical.comparisonKey,a.comparisonKey);assert.equal(practical.nutrition.sugars,18);
 assert.notEqual(a.comparisonKey,scoreProductQuality(p,{groupId:'crispbread-rye',reviewCurrent:true}).comparisonKey);
 assert.equal(scoreProductQuality({...p,nutritionObservation:{fiberConflict:{evidence:'Etiketter avviker'}}},opts).score,null);
 assert.equal(scoreProductQuality({...p,nutrition:{...p.nutrition,sourceUrl:null}},opts).score,null);assert.equal(scoreProductQuality({...p,nutrition:{...p.nutrition,basis:'ml'}},opts).score,null);
 assert.equal(scoreProductQuality(p,{groupId:'muesli-fruit-raisin-pineapple-banana'}).status,'review-required');assert.equal(scoreProductQuality(p,{groupId:'muesli-other',reviewCurrent:true}).status,'not-applicable');
});

test('mild pasta sauce sums only complete declared tomato components and never treats purée as fresh tomato',()=>{
 const id='pasta-sauce-tomato-mild-herbs',a=score('Tomater 84% (Italia), vann, løk.',id),b=score('Tomat 71,5 %, daddeltomat 24 %, løk.',id);
 assert.equal(a.score,84);assert.equal(b.score,95.5);assert.equal(b.measurement.evidence.length,2);assert.equal(a.comparisonKey,b.comparisonKey);assert.notEqual(a.comparisonKey,score('Tomater (148 g per 100 g ketchup)').comparisonKey);
 for(const s of ['Hakkede tomater 45 %, vann, tomatpuré.','Tomater (73%), tomatpuré (17%), løk.','Tomat 80 %, tomatjuice 10 %.','Tomat 80 %, daddeltomat, salt.','Tomat 80 %, tomat 30 %.','Tomat 40 %, hakkede tomater 30 %.','Tomat 40 % av tomatene er norske, vann.','Tomat (40 %) av tomatene er norske, vann.'])assert.equal(score(s,id).score,null,s);
 assert.equal(scoreProductQuality({ingredients:'Tomat 90 %, salt.'},{groupId:id}).status,'review-required');
});

test('beans in tomato sauce score an explicit share of the complete product',()=>{
 const id='beans-white-in-tomato-sauce',a=score('Hvite bønner 45 %, vann, tomatpuré 3,6 %, sukker.',id),b=score('Utbløtte hvite bønner (55 %), vann, salt.',id),c=score('Bønner (51%), vann, tomatpuré (14%), sukker.',id);
 assert.equal(a.score,45);assert.equal(b.score,55);assert.equal(c.score,51);assert.equal(a.comparisonKey,b.comparisonKey);assert.notEqual(a.comparisonKey,score('Fisk 45 %, melk.','fishcakes-ordinary').comparisonKey);
 for(const s of ['Hvite bønner, vann, tomatpuré 40 %.','Bønneblanding (hvite bønner 50 %), vann.','Bønner 30 %, bønner 30 %, vann.','Hvite bønner 30 %, kidneybønner 20 %, vann.','Bønner 50 % av bønnene er hvite, vann.','Bønner 120 %, vann.'])assert.equal(score(s,id).score,null,s);
 assert.equal(scoreProductQuality({ingredients:'Hvite bønner 50 %, vann.'},{groupId:id}).status,'review-required');
});
test('fishsticks only score an explicitly stated share of fish in the product',()=>{
 const check=s=>score(s,'fishsticks-breaded');
 assert.equal(check('Alaska pollock 65 % (fisk), kavring, olje.').score,65);
 assert.equal(check('Fisk - alaska pollock* (theragra chalcogramma) 61 %, hvetemel.').score,61);
 assert.equal(check('Seifilet (pollachius virens) (50%), panering, olje.').score,50);
 assert.equal(check('Hakket fisk * 60%, hvetemel.').score,60);
 for(const s of ['Alaska pollock 65 % av fisken er norsk, panering.','Seifilet (65 %) av fisken er norsk, panering.','Alaska pollock 40 %, torsk 20 %, panering.','Panering (alaska pollock 65 %), mel.','Fisk (alaska pollock 65 %), mel.','Seifilet 110%, mel.'])assert.equal(check(s).score,null,s);
 assert.notEqual(check('Alaska pollock 65 %, hvetemel.').comparisonKey,score('Fisk 65 %, melk.','fishcakes-high').comparisonKey);
});

test('fish gratin scores only its declared main fish ingredient and excludes stock',()=>{
 const id='fish-gratin-macaroni-practical-frozen',a=score('Vann, seifilet (Pollachius virens)* (20 %), makaroni, fiskefont (fiskekjøtt, salt).',id),b=score('Torskefilet * (gadus morhua) 30 %, melk, makaroni.',id),c=score('Skummetmelk, sei (pollachius virens)* 30 %, makaroni, fiskefond [fisk, salt].',id);
 assert.equal(a.score,20);assert.equal(b.score,30);assert.equal(c.score,30);assert.equal(a.comparisonKey,b.comparisonKey);
 assert.equal(a.measurement.basis,'declared-main-fish-ingredient-percent');
 assert.notEqual(a.comparisonKey,score('Fisk 20 %, melk.','fishcakes-ordinary').comparisonKey);
 assert.equal(score('Torskefilet 30 %, makaroni.','fish-gratin-macaroni-frozen-30pct').comparisonKey,b.comparisonKey);
 for(const s of ['Seifilet, makaroni 30 %.','Fisk (torsk 30 %), makaroni.','Torsk 20 %, sei 10 %, makaroni.','Torsk 20 %, røkt laks 10 %, makaroni.','Torsk 30 % av fisken, makaroni.','Torsk (30 %) av fisken, makaroni.','Torsk 120 %, makaroni.','Fiskefond (fisk 30 %), makaroni.'])assert.equal(score(s,id).score,null,s);
 assert.equal(scoreProductQuality({ingredients:'Sei 30 %, makaroni.'},{groupId:id}).status,'review-required');
});

test('chicken cold cuts score only one explicitly declared chicken-meat ingredient',()=>{
 const id='chicken-coldcuts-plain--coldcut-slices--meat-under-90';
 const a=score('Kyllingfilet (87 %), vann, salt.',id),b=score('Kyllingbryst (74%), vann, salt.',id),c=score('Kvernet kyllingfilet* uten skinn (87 %), vann.',id),d=score('Kyllingfilet uten skinn (98 %), salt, kyllingaroma.','chicken-coldcuts-plain--cooked-slices');
 assert.equal(a.score,87);assert.equal(b.score,74);assert.equal(c.score,87);assert.equal(d.score,98);assert.equal(a.comparisonKey,b.comparisonKey);assert.equal(a.comparisonKey,d.comparisonKey);
 assert.equal(score('Kyllingbryst (opprinnelse norge) 85%, vann.',id).score,85);
 assert.equal(a.measurement.basis,'declared-chicken-meat-ingredient-percent');
 for(const text of ['Kyllingfilet, vann 87 %.','Kyllingfilet 87 % av kjøttet, vann.','Kyllingfilet (87 %) av kjøttet, vann.','Kyllingblanding (kyllingfilet 87 %), vann.','Kyllingfilet 87 %, kyllinglår 5 %, vann.','Kyllingfilet 87 %, kyllingbryst 87 %, vann.','Kyllingfilet 101 %, vann.','Kyllingfilet (opprinnelse Norge), vann. Til 100 g ferdig vare har det medgått 107 g kjøtt.','Kyllingfilet (kylling 80 %) 90 %, vann.'])assert.equal(score(text,id).score,null,text);
 assert.equal(score('Kyllingfilet 87 %, vann.','chicken-thigh-raw').status,'not-applicable');
 assert.equal(scoreProductQuality({ingredients:'Kyllingfilet 87 %, vann.'},{groupId:id}).status,'review-required');
});

test('cooked ham scores only one directly declared pork-meat ingredient',()=>{
 const a=score('Sammensatte stykker av svinekjøtt (84%), vann, salt.','ham-cooked-sliced-80-89');
 const b=score('Renskåret svinekjøtt av skinke (85 %), vann, salt.','ham-cooked-sliced-80-89');
 const c=score('Norsk renskåret skinke av svin (92 %), vann, salt.','ham-cooked');
 const d=score('Norsk svinekjøtt 90 %, vann, salt.','ham-cooked');
 assert.deepEqual([a.score,b.score,c.score,d.score],[84,85,92,90]);assert.equal(a.comparisonKey,c.comparisonKey);assert.equal(a.measurement.basis,'declared-pork-meat-ingredient-percent');
 for(const text of ['Svinekjøtt, vann 85 %.','Svinekjøtt (85 %) av råvarene, vann.','Svinekjøtt 84 %, svinekjøtt 84 %, vann.','Svinekjøtt 84 %, svinefett, vann.','Skinke (svinekjøtt 85 %), vann.','Svinekjøtt 101 %, vann.','Svinekjøtt, vann. Til 100 g ferdig vare har det medgått 120 g kjøtt.'])assert.equal(score(text,'ham-cooked').score,null,text);
 assert.equal(score('Svinekjøtt 84 %, vann.','ham-cured').status,'not-applicable');
 assert.equal(scoreProductQuality({ingredients:'Svinekjøtt 84 %, vann.'},{groupId:'ham-cooked'}).status,'review-required');
});

test('potato salad scores only an explicit and complete potato ingredient share',()=>{
 const opts={groupId:'potato-salad-creme-practical',reviewCurrent:true},p={ingredients:'Poteter 57 %, rapsolje, crème fraîche 11 %, purre, salt.',nutrition:{basis:'g',per100:{fat:16.5,salt:1.2,sugars:2.3}}};
 const a=scoreProductQuality(p,opts),b=score('Potet (60 %), rapsolje, crème fraîche.','potato-salad-creme-fraiche'),c=score('Potetskiver 60 %, rapsolje, crème fraîche.','potato-salad-creme-practical');
 assert.deepEqual([a.score,b.score,c.score],[57,60,60]);assert.equal(a.comparisonKey,b.comparisonKey);assert.equal(a.nutrition.fat,16.5);assert.equal(a.nutrition.salt,1.2);assert.equal(a.nutrition.sugars,2.3);
 for(const text of ['Poteter, crème fraîche 60 %.','Poteter 60 % av grønnsakene, olje.','Potetskiver (60 %) av grønnsakene, olje.','Potetflak 60 %, olje.','Søtpoteter 60 %, olje.','Grønnsaker (potet 60 %), olje.','Poteter 60 %, potetflak, olje.','Poteter 60 %, potetstivelse, olje.','Poteter 60 %, potetskiver 60 %, olje.','Poteter 101 %, olje.'])assert.equal(score(text,opts.groupId).score,null,text);
 assert.equal(score('Poteter 60 %, olje.','potato-fries').status,'not-applicable');
 assert.equal(scoreProductQuality(p,{groupId:opts.groupId}).status,'review-required');
});

test('wholegrain bread fiber uses sourced per-100g facts and holds zeros and conflicts',()=>{
 const opts={groupId:'bread-wholegrain--lower-fat',reviewCurrent:true},product={ingredients:'Sammalt hvete, vann, hvetemel.',sourceUrl:'https://store.example/bread',nutrition:{basis:'g',sourceUrl:'https://producer.example/bread',per100:{fiber:6,fat:2,sugars:1,salt:1}}};
 const a=scoreProductQuality(product,opts),b=scoreProductQuality({...product,nutrition:{...product.nutrition,per100:{fiber:8.2,fat:3.7,sugars:1.1,salt:.8}}},{groupId:'bread-wholegrain--higher-fat',reviewCurrent:true});
 assert.equal(a.score,40);assert.equal(b.score,54.7);assert.equal(a.comparisonKey,b.comparisonKey);assert.equal(a.measurement.sourceUrl,'https://producer.example/bread');assert.equal(a.nutrition.fat,2);
 assert.notEqual(a.comparisonKey,scoreProductQuality(product,{groupId:'crispbread-wheat',reviewCurrent:true}).comparisonKey);assert.notEqual(a.comparisonKey,scoreProductQuality(product,{groupId:'muesli-fruit-practical',reviewCurrent:true}).comparisonKey);
 for(const fiber of [undefined,0,-1,101,NaN])assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,per100:{fiber}}},opts).score,null,String(fiber));
 const zero=scoreProductQuality({...product,nutrition:{...product.nutrition,per100:{fiber:0,fat:2}}},opts);
 assert.equal(zero.nutrition.fiber,null);assert.equal(zero.nutrition.fat,2);
 const conflict=scoreProductQuality({...product,nutritionObservation:{fiberConflict:{evidence:'Etiketter er uenige'}}},opts);
 assert.equal(conflict.score,null);assert.equal(conflict.nutrition.fiber,null);
 const crispZero=scoreProductQuality({...product,nutrition:{...product.nutrition,per100:{fiber:0}}},{groupId:'crispbread-wheat',reviewCurrent:true});
 assert.equal(crispZero.nutrition.fiber,0);assert.equal(crispZero.score,0);
 assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,sourceUrl:null}},opts).score,null);
 assert.equal(scoreProductQuality({...product,nutrition:{...product.nutrition,basis:'ml'}},opts).score,null);
 assert.equal(scoreProductQuality(product,{groupId:opts.groupId}).status,'review-required');
 assert.equal(scoreProductQuality(product,{groupId:'bread-white',reviewCurrent:true}).status,'not-applicable');
});

test('wholegrain pasta scores the declared wholegrain flour in the recipe, not the wheat alone',()=>{
 const id='pasta-wholegrain',a=score('Fullkornmel av durumhvete (65%), mel av durumhvete.',id),b=score('Fullkornmel av durumhvete (55%) og mel av durumhvete',id);
 assert.equal(a.score,65);assert.equal(b.score,55);assert.equal(a.comparisonKey,b.comparisonKey);assert.equal(a.measurement.basis,'declared-wholegrain-flour-ingredient-percent');
 for(const text of ['Fullkorn durumhvete, vann.','Fullkorn durumhvete semulina (100% italiensk hvete), vann.','Fullkornmel av durumhvete, vann.','Fullkornmel av durumhvete 65 % av melet, vann.','Fullkornmel av durumhvete (65 %) av melet, vann.','Fullkornmel av durumhvete 65 % (av melet), vann.','Fullkornmel av durumhvete (65%), sammalt rug, vann.','Fullkornmel av durumhvete (65%) og sammalt rug, vann.','Fullkornmel av durumhvete (101%), vann.','Kornblanding (fullkornmel av durumhvete 65 %), vann.'])assert.equal(score(text,id).score,null,text);
 assert.equal(score('Fullkornmel av durumhvete (65%), mel av durumhvete.','pasta-durum-white').status,'not-applicable');
 assert.equal(scoreProductQuality({ingredients:'Fullkornmel av durumhvete (65%), vann.'},{groupId:id}).status,'review-required');
});
