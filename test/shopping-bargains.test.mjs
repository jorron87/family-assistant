import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBargains,bargainHideKeys,fitsFamily} from '../src/shopping-bargains.mjs';
import {shoppingStore} from '../src/shopping.mjs';

const AT=Date.parse('2026-11-22T12:00:00Z');
const family=(extra={})=>({name:'Kjøttdeig av storfe',unit:'kg',storage:'frozen',need:{amount:24,basis:'planned-amount'},stock:{known:true,amount:0,months:0},shelfMonths:4,excellentPrice:null,maxPacks:100,minDiscountPct:0,terms:['kjøttdeig av storfe'],variants:[],...extra});
const stores=[{key:'oda',name:'Oda',oda:true,minSavings:0},{key:'kiwi',name:'KIWI',minSavings:25},{key:'rema',name:'REMA 1000',minSavings:50},{key:'europris',name:'Europris',minSavings:0}];
const row=extra=>({kind:'price',reviewed:true,watchId:'mince',storeKey:'kiwi',storeName:'KIWI',productKey:'p1',productName:'Kjøttdeig 400 g',unitPrice:100,packAmount:.4,packPrice:40,reference:{price:160,basis:'paid'},...extra});
const build=(candidates,families=new Map([['mince',family()]]),hides={})=>buildBargains({candidates,families,stores,hides,at:AT});

test('an ordinary shelf price well under the usual price is a good buy without any campaign',()=>{
 const result=build([row()]);
 assert.equal(result.rows.length,1);
 const [r]=result.rows;
 assert.equal(r.tier,'excellent');assert.equal(r.discountPct,37.5);assert.equal(r.kind,'price');
 // Frozen mince keeps four months, so an excellent price buys four months of the need.
 assert.equal(r.fullMonths,4);assert.equal(r.packs,20);assert.equal(r.saving,480);
 assert.equal(result.total,480);
 assert.deepEqual(result.stores.map(s=>[s.key,s.count,s.saving,s.worthTrip]),[['kiwi',1,480,true]]);
});

test('Oda is a store like any other: a cheap Oda price surfaces with delivery, not a trip',()=>{
 const result=build([row({storeKey:'oda',storeName:'Oda',odaProductId:42,reference:{price:91,basis:'usual'},unitPrice:70,packAmount:.285,packPrice:19.95})],new Map([['mince',family({name:'Gulost skivet',storage:'chilled',shelfMonths:2,need:{amount:7.2,basis:'planned-amount'},terms:['gulost skivet']})]]));
 const [r]=result.rows;
 assert.equal(r.oda,true);assert.equal(r.odaProductId,42);assert.equal(r.tier,'good');
 assert.equal(r.fullMonths,2,'cheese keeps two months, so a good price stops there');
 assert.equal(result.stores[0].worthTrip,null);
});

test('unreviewed shelf variants are marked, need a clear gap, and never count as reviewed savings',()=>{
 const check=row({reviewed:false,storeKey:'rema',storeName:'REMA 1000',watchId:'other',productKey:'r1'});
 const result=build([row(),check],new Map([['mince',family()],['other',family({name:'Annen kjøttdeig'})]]));
 assert.equal(result.rows.length,2);
 assert.equal(result.rows[0].reviewed,true,'reviewed buys come first');
 const rema=result.stores.find(s=>s.key==='rema');
 assert.equal(rema.count,0);assert.equal(rema.checkCount,1);assert.equal(rema.saving,0);assert.equal(rema.worthTrip,false);
 assert.equal(result.total,480,'the headline counts each need once and only reviewed prices');
 assert.equal(build([row({reviewed:false,unitPrice:150})]).rows.length,0,'a small gap is no reason to check a variant');
 assert.equal(build([row({reviewed:false,unitPrice:40})]).rows.length,0,'a huge gap is usually another pack or unit');
});

test('variant checks keep brand, dietary, light and form requirements',()=>{
 const f=family({terms:['kjøttdeig av storfe','kjøttdeig, ren storfe 12–15 % fett','kjøttdeig, ren storfe 12–15 % fett · økologisk']});
 assert.equal(fitsFamily(f,{name:'Kjøttdeig Snabb 400g Folkets'}),true,'one organic sub-variant does not make organic required');
 const milk=family({name:'Laktosefri lettmelk',terms:['laktosefri lettmelk1%','lettmelk, laktosefri']});
 assert.equal(fitsFamily(milk,{name:'Lettmelk 0,5% 1,75l Q'}),false);
 assert.equal(fitsFamily(milk,{name:'Tine Laktosefri Lettmelk 0,5%'}),true);
 const paste=family({name:'Solidox Totalbeskyttelse',terms:['solidox totalbeskyttelse','tannkrem solidox total'],variants:[{brands:['Solidox'],requires:[]}]});
 assert.equal(fitsFamily(paste,{name:'Tannkrem Mentol 75ml First Price',brand:'First Price'}),false);
 assert.equal(fitsFamily(paste,{name:'Solidox Total tannkrem',brand:'Solidox'}),true);
 const coconut=family({name:'Kokosmelk',terms:['kokosmelk']});
 assert.equal(fitsFamily(coconut,{name:'Kokosmelk Lett 250ml'}),false);
 const coffee=family({name:'Kaffe – hele bønner',terms:['kaffe – hele bønner']});
 assert.equal(fitsFamily(coffee,{name:'Evergood Classic Filtermalt 500g'}),false);
 assert.equal(fitsFamily(coffee,{name:'Evergood Classic Hele Bønner 500g'}),true);
 const olives=family({name:'Grønne oliven uten sten',terms:['grønne oliven uten sten']});
 assert.equal(fitsFamily(olives,{name:'Oliven Sort uten Sten 340gr'}),false);
 assert.equal(fitsFamily(family(),{name:'Salmiakk 750ml'}),false,'an unrelated product in a broad category is not a variant');
});

test('one shelf pack answers one need per store, and tiny savings stay out of the way',()=>{
 const families=new Map([['mince',family()],['other',family({name:'Annen kjøttdeig'})]]);
 const result=build([row(),row({watchId:'other',reference:{price:120,basis:'usual'}})],families);
 assert.equal(result.rows.length,1);assert.equal(result.rows[0].watchId,'mince');
 const tiny=build([row({unitPrice:150,packAmount:.4,packPrice:60})],new Map([['mince',family({need:{amount:1,basis:'planned-amount'}})]]));
 assert.equal(tiny.rows.length,0);assert.equal(tiny.minor.length,1);
});

test('the family can say a variant does not fit, everywhere, or put a price aside until it changes',()=>{
 const shelf=row({reviewed:false,storeKey:'rema',storeName:'REMA 1000',productKey:'sesum:REMA:1'});
 const other=row({reviewed:false,storeKey:'kiwi',storeName:'KIWI',productKey:'sesum:KIWI:1'});
 const keys=bargainHideKeys(shelf);
 const mismatch=build([shelf,other],undefined,{[keys.mismatch]:{kind:'mismatch',at:new Date(AT).toISOString()}});
 assert.equal(mismatch.rows.length,0);assert.equal(mismatch.hidden,2);
 const snooze={[keys.snooze]:{kind:'snooze',unitPrice:100,at:new Date(AT-86400000).toISOString()}};
 assert.equal(build([shelf,other],undefined,snooze).rows.length,1,'only the snoozed store row is hidden');
 assert.equal(build([{...shelf,unitPrice:95}],undefined,snooze).rows.length,1,'a new price brings it back');
 assert.equal(buildBargains({candidates:[shelf],families:new Map([['mince',family()]]),stores,hides:snooze,at:AT+15*86400000}).rows.length,1,'and so do two weeks');
});

test('the family view lists a reviewed Oda price under the usual price as a good buy',()=>{
 const state={},shop=shoppingStore(state,{save(){},now:()=>new Date('2026-11-08T12:00:00Z')});
 shop.settings({historyFrom:'2025-11-08',monitoringEnabled:true,stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/near',minSavings:0,chainCode:'NEAR'}]});
 const w=shop.watch({name:'Mel',unit:'kg',storage:'pantry',maxPacks:100,purchaseAmount:12,priceGuide:{referencePrice:30,checkedAt:'2026-11-08T10:00:00Z',evidence:'Vanlig pris'}});
 const seen=shop.catalogObserve({watchId:w.id,products:[{id:1,store:'ODA_NO',name:'Hvetemel 1 kg',sourceUrl:'https://oda.com/no/products/123-hvetemel/',currentPrice:20,lastChecked:'2026-11-08T10:00:00Z'}]});
 shop.catalogReview({watchId:w.id,id:1,store:'ODA_NO',fingerprint:seen.entries[0].fingerprint,status:'approved',packAmount:1,unit:'kg',equivalenceEvidence:'Samme mel'});
 const view=shop.familyView(),[r]=view.bargains.rows;
 assert.equal(r.storeKey,'oda');assert.equal(r.odaProductId,123);assert.equal(r.reviewed,true);
 assert.equal(r.referenceBasis,'usual');assert.equal(r.referencePrice,30);assert.equal(r.tier,'excellent');
 assert.equal(r.packs,12);assert.equal(r.saving,120);
 assert.equal(view.summary.topBargain.familyName,'Mel');assert.equal(view.summary.bargainSaving,120);
 shop.bargainAction({action:'snooze',keys:r.hideKeys,unitPrice:r.unitPrice});
 assert.equal(shop.familyView().bargains.rows.length,0);
 shop.bargainAction({action:'undo',keys:r.hideKeys});
 assert.equal(shop.familyView().bargains.rows.length,1);
 assert.throws(()=>shop.bargainAction({action:'mismatch',keys:{mismatch:'unknown|name:x'}}),/Ugyldig/);
});

test('a seen price stays current for three weeks, while a new read must still be recent',async()=>{
 const {currentPriceReceipt,CURRENT_PRICE_DAYS,RECENT_PRICE_MS}=await import('../src/price-freshness.mjs');
 const now=Date.parse('2026-11-22T12:00:00Z'),day=86400000;
 assert.equal(CURRENT_PRICE_DAYS,21);assert.equal(RECENT_PRICE_MS,48*3600000);
 assert.equal(currentPriceReceipt('2026-11-16T18:00:00Z',now),true,'a stable shelf price seen six days ago is still current');
 assert.equal(currentPriceReceipt(new Date(now-21*day).toISOString(),now),true);
 assert.equal(currentPriceReceipt(new Date(now-21*day-1).toISOString(),now),false);
 assert.equal(currentPriceReceipt(new Date(now+1000).toISOString(),now),false,'a future receipt is never current');
 assert.equal(currentPriceReceipt('not a date',now),false);
});

test('a price clearly below the household Oda product is a cheaper place for the next trip, never a stock-up',()=>{
 // Usual market price 200, the household's Oda product 349.50, the shop 182.
 const families=new Map([['mince',family({name:'Grana Padano',storage:'chilled',shelfMonths:6,need:{amount:2.4,basis:'planned-amount'},terms:['grana padano']})]]);
 const shelf=row({reviewed:false,productName:'Grana Padano 200g',unitPrice:182,packAmount:.2,packPrice:36.4,reference:{price:200,basis:'usual'},odaPrice:349.5});
 const [r]=build([shelf],families).rows;
 assert.equal(r.tier,'switch');assert.equal(r.referenceBasis,'oda');assert.equal(r.referencePrice,349.5);assert.equal(r.discountPct,47.93);
 assert.equal(r.fullMonths,1,'only the next trip, since the market price is not unusually low');
 assert.equal(r.packs,1);assert.equal(r.saving,33.5);
 assert.equal(build([{...shelf,odaPrice:null}],families).rows.length,0,'without an Oda product it is just a normal price');
 assert.equal(build([{...shelf,storeKey:'oda',odaPrice:349.5}],families).rows.length,0,'Oda is never cheaper than itself');
 const market=build([{...shelf,unitPrice:140,packPrice:28}],families).rows[0];
 assert.equal(market.tier,'excellent','a real market low stays a good buy with a stock-up plan');assert.equal(market.referenceBasis,'usual');
});

test('the overview sends each need to the cheapest place, not to a checked but dearer one',()=>{
 const families=new Map([['mince',family({name:'Kaffe – hele bønner',storage:'pantry',shelfMonths:12,need:{amount:12,basis:'planned-amount'},terms:['kaffe – hele bønner']})]]);
 const europris=row({storeKey:'europris',storeName:'Europris',productKey:'e1',productName:'Kaffebønner 1000 g',unitPrice:189,packAmount:1,packPrice:189,reference:{price:189,basis:'usual'},odaPrice:241});
 const kiwi=row({reviewed:false,productKey:'k1',productName:'Evergood Classic Hele Bønner 500g',unitPrice:155.8,packAmount:.5,packPrice:77.9,reference:{price:189,basis:'usual'}});
 const result=build([europris,kiwi],families);
 const picked=[...result.rows,...result.minor].filter(r=>r.best);
 assert.equal(picked.length,1);assert.equal(picked[0].storeKey,'kiwi');
 assert.deepEqual(picked[0].checkedAlternative,{storeName:'Europris',unitPrice:189,productName:'Kaffebønner 1000 g'});
 const dear=result.rows.find(r=>r.storeKey==='europris');
 assert.equal(dear.best,false);assert.deepEqual(dear.bestAt,{storeName:'KIWI',unitPrice:155.8,reviewed:false});
 assert.equal(result.top.storeKey,'kiwi','the banner names the cheapest place too');
 // An unchecked variant only a little cheaper does not displace a checked price.
 const close=build([europris,{...kiwi,unitPrice:185,packPrice:92.5}],families);
 assert.equal([...close.rows,...close.minor].find(r=>r.best).storeKey,'europris');
 // A store's trip saving leaves out a need that a checked price elsewhere covers more cheaply.
 // A store's view, chip and trip saving hold only the needs it is the best place for.
 const checked=build([europris,{...kiwi,reviewed:true}],families);
 assert.equal(checked.stores.find(s=>s.key==='europris'),undefined,'Europris has nothing that is cheapest there');
 const kiwiStore=checked.stores.find(s=>s.key==='kiwi');
 assert.equal(kiwiStore.count,1);assert.ok(kiwiStore.saving>0);
 assert.equal(checked.total,kiwiStore.saving,'the headline counts the best place only');
 assert.equal(result.stores.find(s=>s.key==='europris'),undefined);
 assert.equal(result.total,0,'an unchecked best place adds nothing certain to the headline');
});

test('at the same chain price the store with more to gain anyway is the best place',()=>{
 const families=new Map([['mince',family()],['other',family({name:'Pølser',terms:['pølser']})]]);
 const result=build([row(),row({storeKey:'rema',storeName:'REMA 1000',productKey:'r1'}),row({watchId:'other',storeKey:'rema',storeName:'REMA 1000',productKey:'r2',productName:'Grillpølser'})],families);
 assert.equal(result.rows.find(r=>r.watchId==='mince'&&r.best).storeKey,'rema');
});
