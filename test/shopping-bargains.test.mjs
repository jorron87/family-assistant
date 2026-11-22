import test from 'node:test';
import assert from 'node:assert/strict';
import {buildBargains,bargainHideKeys,fitsFamily} from '../src/shopping-bargains.mjs';
import {shoppingStore} from '../src/shopping.mjs';

const AT=Date.parse('2026-11-22T12:00:00Z');
const family=(extra={})=>({name:'Kjøttdeig av storfe',unit:'kg',storage:'frozen',need:{amount:24,basis:'planned-amount'},stock:{known:true,amount:0,months:0},shelfMonths:4,excellentPrice:null,maxPacks:100,minDiscountPct:0,terms:['kjøttdeig av storfe'],variants:[],...extra});
const stores=[{key:'oda',name:'Oda',oda:true,minSavings:0},{key:'kiwi',name:'KIWI',minSavings:25},{key:'rema',name:'REMA 1000',minSavings:50}];
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
 const check=row({reviewed:false,storeKey:'rema',storeName:'REMA 1000'});
 const result=build([row(),check]);
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
