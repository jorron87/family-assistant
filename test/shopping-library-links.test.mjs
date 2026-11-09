import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {libraryPriceProvider,writeShoppingIndex} from '../src/shopping-library.mjs';
import {shoppingStore,namedPackConflict} from '../src/shopping.mjs';
import {createOdaCart} from '../src/shopping-oda-cart.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';

const NOW='2026-11-09T12:10:00Z',RECEIPT='2026-11-09T12:05:00Z';
const tomato=grams=>`Tomater (${grams} g per 100 g ketchup), eddik`;
function libraryData() {
 const g={id:'ketchup-standard',name:'Tomatketchup vanlig',category:'Kolonial, pålegg og snacks',canonicalUnit:'kg',inclusionCriteria:'Vanlig tomatketchup',exclusions:['Sukkerfri'],qualityBasis:'Samme bruk',comparisonBasis:'Per kg'};
 const row=(store,id,name,price,extra={})=>{const sourceUrl=store==='ODA_NO'?`https://oda.com/no/products/${id}-vare/`:`https://example.com/${store}/${id}`,p={productKey:`kassal:${store}:${id}`,source:'kassal',store,id:String(id),name,ean:extra.ean??null,brand:extra.brand??null,ingredients:extra.ingredients??'Tomater, eddik',description:'',sourceUrl,canonicalPackAmount:extra.pack===undefined?.5:extra.pack,unit:'kg',packEvidence:'Etikett',nutrition:extra.nutrition??null,attributes:extra.attributes??null};p.metadataFingerprint=productMetadataFingerprint(p);return {p,price:{productKey:p.productKey,grossPackPrice:price,receiptAt:RECEIPT,availabilityScope:'chain',sourceUrl}};};
 const rows=[row('ODA_NO',1,'Vanlig ketchup 500 g',30,{brand:'Merke A',ingredients:tomato(148),ean:'7030000000017'}),row('ODA_NO',2,'Billig ketchup 500 g',10,{brand:'Merke B',ingredients:tomato(100),attributes:{organic:false}}),row('ODA_NO',3,'Økologisk ketchup 500 g',40,{brand:'Merke C',ingredients:tomato(200),attributes:{organic:true}}),row('MENY_NO',4,'Meny ketchup 500 g',12,{brand:'Merke D',ean:'7030000000024'}),row('JOKER_NO',5,'Joker ketchup 500 g',5,{brand:'Merke E'}),row('ODA_NO',6,'Avvist ketchup 500 g',8,{brand:'Merke F'})];
 const d={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[g],products:rows.map(x=>x.p),prices:rows.map(x=>x.price),memberships:rows.map(({p})=>({groupId:g.id,productKey:p.productKey,status:'approved',equivalenceEvidence:'Vanlig tomatketchup lest',qualityEvidence:'Samme bruk',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),reviewedAt:'2026-11-09T11:00:00Z',sourceReceipts:[{url:p.sourceUrl,observedAt:'2026-11-09T11:00:00Z',evidence:'Etikett lest'}]}))};
 return {d,g,rows};
}
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-links-')),file=path.join(dir,'library.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const {d,g,rows}=libraryData(),write=()=>fs.writeFileSync(file,JSON.stringify(d));write();
 const clock={at:NOW},provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)}),state={},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});
 shop.settings({monitoringEnabled:true,stores:[{id:'meny',name:'MENY – Kassal-kjedepriser',url:'https://example.com/meny',minSavings:0,chainCode:'MENY_NO'},{id:'web',name:'Rest (nettbutikk)',url:'https://example.com/web',minSavings:0,chainCode:'JOKER_NO'}]});
 const w=shop.watch({name:'Tomatketchup',unit:'kg',storage:'pantry',purchaseAmount:6,targetPrice:200});
 const native=(row,status='approved',pack=.5)=>{const p=row.p,seen=shop.catalogObserve({watchId:w.id,products:[{id:p.id,store:p.store,name:p.name,ean:p.ean,brand:p.brand,ingredients:p.ingredients,description:p.description,sourceUrl:p.sourceUrl,currentPrice:row.price.grossPackPrice,lastChecked:RECEIPT}]}).entries[0];return shop.catalogReview({watchId:w.id,id:p.id,store:p.store,fingerprint:seen.fingerprint,status,packAmount:status==='approved'?pack:undefined,unit:status==='approved'?'kg':undefined,equivalenceEvidence:'Vurdert'});};
 const link=(extra={})=>shop.libraryLink({watchId:w.id,evidence:'Gruppen dekker varen',links:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Samme bruk og innhold',...extra}]});
 return {d,g,rows,write,clock,provider,state,shop,w,native,link,file,dir};
}

test('a library group lends nothing until the watch has an explicit link, and exclusions and chains hold',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.native(f.rows[5],'excluded');
 let view=f.shop.familyView();assert.equal(view.items[0].prices.current,60);
 assert.deepEqual(view.odaDraft.items[0].variants.map(x=>x.productId),[2,1,3],'an undecided family is shown for comparison');
 assert.equal(view.odaDraft.items[0].productId,1);
 assert.ok(f.shop.queue().some(x=>x.do==='shopping-family-build'&&x.reason==='undecided'));
 f.link();view=f.shop.familyView();
 assert.equal(view.items[0].prices.current,20,'cheapest linked product at an allowed chain');
 const ids=view.odaDraft.items[0].variants.map(x=>x.productId);
 assert.ok(ids.includes(2)&&ids.includes(3));assert.ok(!ids.includes(6),'a family exclusion wins over the group');
 assert.equal(view.odaDraft.items[0].productId,1,'a cheaper brand is offered, never swapped in');
 assert.ok(!f.shop.queue().some(x=>x.do==='shopping-family-build'));
});

test('quality is compared only between the same measurement, and only linked brands and attributes pass',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.link();
 let variants=f.shop.familyView().odaDraft.items[0].variants;
 assert.deepEqual(variants.map(x=>x.quality?.score??null),[null,50,74,100],'a missing label is unknown, never zero');
 assert.equal(variants.find(x=>x.productId===2).library,true);assert.equal(variants.find(x=>x.productId===1).library,false);
 f.link({requires:['organic']});variants=f.shop.familyView().odaDraft.items[0].variants;assert.deepEqual(variants.map(x=>x.productId),[1,3]);
 f.link({brands:['Merke B']});variants=f.shop.familyView().odaDraft.items[0].variants;assert.deepEqual(variants.map(x=>x.productId),[2,1]);
 assert.throws(()=>f.link({requires:['cheap']}),/Ugyldige krav/);
});

test('a changed library group stops lending and asks for a new review; a decline stays closed',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.link();assert.equal(f.shop.familyView().items[0].prices.current,16);
 assert.throws(()=>f.shop.libraryLink({watchId:f.w.id,evidence:'x',links:[{groupId:f.g.id,groupFingerprint:'0'.repeat(64),evidence:'y'}]}),/endret/);
 f.g.inclusionCriteria='Strengere regel';for(const m of f.d.memberships)m.reviewedGroupFingerprint=groupMetadataFingerprint(f.g);f.write();
 assert.equal(f.shop.familyView().items[0].prices.current,60);
 assert.equal(f.shop.queue().find(x=>x.do==='shopping-family-build').reason,'group-changed');
 f.shop.libraryLink({watchId:f.w.id,evidence:'Familien krever eksakt variant',links:[]});
 assert.ok(!f.shop.queue().some(x=>x.do==='shopping-family-build'));assert.equal(f.shop.familyView().items[0].prices.current,60);
});

test('fresh prices expire on their own without reloading, and links never cross units',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.link();
 f.clock.at='2026-11-12T12:00:00Z';assert.equal(f.shop.familyView().items[0].prices.current,null);
 const other=f.shop.watch({name:'Annen',unit:'l',storage:'pantry'});
 assert.throws(()=>f.shop.libraryLink({watchId:other.id,evidence:'x',links:[{groupId:f.g.id,groupFingerprint:groupMetadataFingerprint(f.g),evidence:'y'}]}),/enhet/);
});

test('free text never reaches the cart on a guess',t=>{
 const f=fixture(t);f.native(f.rows[0]);
 const exact=f.shop.list({action:'add',name:'tomatketchup'});assert.equal(exact.storeName,'Oda');assert.equal(exact.odaProductId,1);
 f.shop.list({action:'remove',id:exact.id});
 const guess=f.shop.list({action:'add',name:'ketchup'});
 assert.equal(guess.routing,'choose');assert.equal(guess.odaProductId,null);assert.equal(guess.storeName,null);
 assert.deepEqual(guess.suggestions.map(x=>x.type),['watch','library']);
 assert.equal(guess.suggestions[1].odaProductId,6,'the group suggestion names one concrete product');
 assert.equal(f.shop.listRouteWork().length,0,'waiting for the family needs no agent run');
 const placed=f.shop.list({action:'choose',id:guess.id,watchId:f.w.id});assert.equal(placed.storeName,'Oda');assert.equal(placed.odaProductId,1);assert.equal(placed.name,'Tomatketchup');
 const second=f.shop.list({action:'add',name:'ketchup'}),library=second.suggestions.find(x=>x.type==='library');
 const fromLibrary=f.shop.list({action:'choose',id:second.id,productKey:library.productKey});assert.equal(fromLibrary.storeName,'Oda');assert.equal(fromLibrary.odaProductId,6);assert.equal(fromLibrary.packs,1);
 const third=f.shop.list({action:'add',name:'ketchup'});assert.equal(f.shop.list({action:'choose',id:third.id,agent:true}).routing,'pending');assert.equal(f.shop.listRouteWork().length,1);
 assert.throws(()=>f.shop.list({action:'choose',id:third.id,watchId:f.w.id}),/venter ikke/);
 const urgent=f.shop.list({action:'add',name:'ketchup',need:'now'});assert.ok(urgent.suggestions.filter(x=>x.type==='library').every(x=>x.odaProductId===null));
});

test('a word inside a longer watch name is offered, not placed',t=>{
 const f=fixture(t);const w=f.shop.watch({name:'Ananasbiter i juice på boks',unit:'kg',storage:'pantry',purchaseAmount:6,targetPrice:200});
 const seen=f.shop.catalogObserve({watchId:w.id,products:[{id:'9',store:'ODA_NO',name:'Ananas 340 g',sourceUrl:'https://oda.com/no/products/99-ananas/',currentPrice:20,lastChecked:RECEIPT}]}).entries[0];
 f.shop.catalogReview({watchId:w.id,id:'9',store:'ODA_NO',fingerprint:seen.fingerprint,status:'approved',packAmount:.34,unit:'kg',equivalenceEvidence:'Vurdert'});
 const entry=f.shop.list({action:'add',name:'juice'});assert.equal(entry.routing,'choose');assert.equal(entry.storeName,null);assert.equal(entry.odaProductId,null);
});

test('reviews that contradict the package in the name are refused and audited',t=>{
 const f=fixture(t);
 assert.equal(namedPackConflict('Helmelk Laktosefri, 1,75 l',1,'l'),1.75);assert.equal(namedPackConflict('Helmelk 1,75 l',1.75,'l'),null);assert.equal(namedPackConflict('Brus 6 x 1,5 l',9,'l'),null);assert.equal(namedPackConflict('Ost ca. 1 kg',1,'kg'),null);
 assert.throws(()=>f.native(f.rows[0],'approved',1),/Varenavnet viser 0.5/);
 const row=f.rows[0],seen=f.shop.catalogEntries(f.w.id)[0];
 f.shop.catalogReview({watchId:f.w.id,id:row.p.id,store:row.p.store,fingerprint:seen.fingerprint,status:'approved',packAmount:1,unit:'kg',equivalenceEvidence:'Vurdert',packConflictEvidence:'Tolererer dokumentert avvik i test'});
 let audit=f.shop.libraryAudit();assert.deepEqual(audit.findings.map(x=>x.kind).sort(),['library-pack-conflict','name-pack-conflict']);
 assert.equal(f.shop.queue().filter(x=>x.do==='shopping-library-audit')[0].findings,2);
 assert.throws(()=>f.shop.libraryAuditAck({items:[{id:audit.findings[0].id}]}),/belegg/);
 f.shop.libraryAuditAck({items:audit.findings.map(x=>({id:x.id,evidence:'Kontrollert'}))});
 assert.equal(f.shop.libraryAudit().findings.length,0);assert.ok(!f.shop.queue().some(x=>x.do==='shopping-library-audit'));
});

test('the audit reports products the library does not approve and watches with no group',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.d.memberships[0].status='excluded';f.write();
 f.shop.watch({name:'Toalettpapir',unit:'stk',storage:'other'});
 const audit=f.shop.libraryAudit();assert.equal(audit.findings[0].kind,'library-not-approved');assert.equal(audit.findings[0].libraryStatus[0].status,'excluded');
 assert.ok(audit.noGroup.some(x=>x.name==='Toalettpapir'));
});

test('a scan adds or removes one verified package, and unknown codes change nothing',t=>{
 const f=fixture(t);f.native(f.rows[0]);
 assert.deepEqual(f.shop.stockScan({action:'lookup',ean:'7030000000017'}).options.map(x=>[x.watchId,x.packAmount]),[[f.w.id,.5]]);
 const meny=f.shop.stockScan({action:'lookup',ean:'7030000000024'});assert.equal(meny.options.length,0,'no link yet means no stock line');assert.equal(meny.knownProduct,'Meny ketchup 500 g');
 assert.throws(()=>f.shop.stockScan({action:'apply',ean:'7030000000024',watchId:f.w.id,packAmount:.5,count:1}),/passer ikke/);
 f.link();assert.equal(f.shop.stockScan({action:'lookup',ean:'7030000000024'}).options[0].productName,'Meny ketchup 500 g');
 assert.throws(()=>f.shop.stockScan({action:'lookup',ean:'abc'}),/strekkode/);assert.equal(f.shop.stockScan({action:'lookup',ean:'7030000000031'}).options.length,0);
 assert.throws(()=>f.shop.stockScan({action:'apply',ean:'7030000000017',watchId:f.w.id,packAmount:.5,count:-1}),/ikke talt/);
 const added=f.shop.stockScan({action:'apply',ean:'7030000000017',watchId:f.w.id,packAmount:.5,count:1,clientId:'a'});assert.equal(added.amount,.5);
 assert.equal(f.shop.stockScan({action:'apply',ean:'7030000000017',watchId:f.w.id,packAmount:.5,count:1,clientId:'a'}).id,added.id,'a retried request counts once');
 assert.equal(f.shop.familyView().items[0].stock.amount,.5);
 assert.equal(f.shop.stockScan({action:'apply',ean:'7030000000017',watchId:f.w.id,packAmount:.5,count:-1,clientId:'b'}).amount,0);
 const last=f.state.shopping.scanLog.at(-1);f.shop.stockScan({action:'undo',id:last.id});assert.equal(f.shop.familyView().items[0].stock.amount,.5);
 const third=f.shop.stockScan({action:'apply',ean:'7030000000017',watchId:f.w.id,packAmount:.5,count:1,clientId:'c'});f.shop.pantry({watchId:f.w.id,amount:9});assert.throws(()=>f.shop.stockScan({action:'undo',id:third.id}),/endret/);
});

test('a cart line outside every watch gets a same-group alternative, and native order lines get label data',t=>{
 const f=fixture(t);f.d.products[0].nutrition={basis:'g',per100:{kcal:100,protein:1,fat:0,carbs:20},sourceUrl:'https://oda.com/no/products/1-vare/',evidence:'Etikett'};f.d.products[0].metadataFingerprint=productMetadataFingerprint(f.d.products[0]);f.d.memberships[0].reviewedFingerprint=f.d.products[0].metadataFingerprint;f.write();
 const line=f.shop.cartReview({groups:[{items:[{product:{id:1,name:'Vanlig ketchup 500 g'},quantity:2,totalGrossAmount:'60.00'}]}],validationMessages:[],totalGrossAmount:'60.00'}).lines[0];
 assert.equal(line.watchId,null);assert.equal(line.libraryAlternative.productId,6);assert.equal(line.libraryAlternative.diffPct,73);assert.equal(line.libraryAlternative.linePackAmount,.5);
 f.shop.importOrders({orders:[{orderNumber:'n1',deliveryDate:'2026-11-08',currency:'NOK',grossAmount:60,products:[{product:{id:1,name:'Vanlig ketchup 500 g',description:'500 g'},quantity:2,totalGrossAmount:'60.00'}]}]});
 assert.equal(f.shop.familyView().nutrition.spendPct,100);
 assert.deepEqual(f.shop.queue().find(x=>x.do==='shopping-order-link').libraryGroups,[f.g.id]);
});

test('purchases elsewhere keep the need up once stock has been used, without counting stock still at home',t=>{
 const f=fixture(t);const w=f.shop.watch({name:'Havregryn',unit:'kg',storage:'pantry',targetPrice:100});
 f.shop.settings({stores:[{id:'near',name:'Nærbutikk',url:'https://example.com/near',minSavings:0}]});
 f.state.shopping.purchases.push({id:'p',offerId:null,watchId:w.id,name:w.name,packs:12,packAmount:1,unit:'kg',at:'2026-01-10T12:00:00Z'});
 assert.equal(Math.round(f.shop.familyView().items.find(x=>x.id===w.id).annualAmount),12);
 f.shop.pantry({watchId:w.id,amount:12});assert.equal(f.shop.familyView().items.find(x=>x.id===w.id).annualAmount,null,'unused stock proves no consumption');
});

test('editing an item keeps the evidence behind its counted stock',t=>{
 const f=fixture(t);f.shop.pantry({watchId:f.w.id,amount:1});f.state.shopping.watches[f.w.id].stockEvidence={intakeId:'a',estimated:true,evidence:'Bilde',at:NOW};
 f.shop.item({id:f.w.id,shelfLifeMonths:6});assert.equal(f.state.shopping.watches[f.w.id].stockEvidence.estimated,true);
});

test('pack amounts differing by floating point noise still match the library',t=>{
 const f=fixture(t);f.rows[0].p.canonicalPackAmount=.1+.4000000000000001;f.rows[0].p.metadataFingerprint=productMetadataFingerprint(f.rows[0].p);f.d.memberships[0].reviewedFingerprint=f.rows[0].p.metadataFingerprint;f.d.prices[0].receiptAt='2026-11-09T12:06:00Z';f.write();
 f.native(f.rows[0]);assert.equal(f.provider(f.shop.catalogEntries(f.w.id)).quotes.length,1);
});

test('the server reads a compact index and rebuilds it outside the request',t=>{
 const f=fixture(t),indexFile=path.join(f.dir,'index.json');let builds=0;
 const build=(file,output,done)=>{builds++;writeShoppingIndex(file,output);done(true);};
 const provider=libraryPriceProvider(f.file,{now:()=>new Date(NOW),indexFile,build});
 assert.equal(provider([]).status,'building');assert.equal(builds,1);
 assert.equal(provider([]).status,'ready');assert.ok(provider.reader().group(f.g.id));
 provider([]);assert.equal(builds,1,'an unchanged library is not rebuilt');
 f.d.createdAt='2026-11-09T12:00:00Z';f.g.name='Ny tomatketchup';for(const m of f.d.memberships)m.reviewedGroupFingerprint=groupMetadataFingerprint(f.g);f.write();
 provider([]);assert.equal(builds,2);assert.equal(provider.reader().group(f.g.id).name,'Ny tomatketchup');
 const failing=libraryPriceProvider(f.file,{now:()=>new Date(NOW),indexFile:path.join(f.dir,'none.json'),build:(a,b,done)=>{builds++;done(false);}});
 const before=builds;failing([]);failing([]);assert.equal(builds,before+1,'a failed build backs off');assert.equal(failing([]).status,'building');
 assert.ok(fs.statSync(indexFile).size<fs.statSync(f.file).size*2);
});

test('the big shop compares the same library family across every chain with a fresh price',t=>{
 const f=fixture(t);f.shop.settings({stores:[{id:'meny',name:'MENY – Kassal-kjedepriser',url:'https://example.com/meny',minSavings:0,chainCode:'MENY_NO'}]});f.native(f.rows[0]);
 let row=f.shop.familyView().odaDraft.items[0];
 assert.equal(f.shop.familyView().items[0].prices.current,60,'an undecided family never moves the price');
 assert.deepEqual(row.others.map(x=>[x.storeName,x.unitPrice,x.own]),[['Joker',10,false],['MENY',24,true]]);
 assert.deepEqual(row.places.map(x=>[x.storeName,x.unitPrice,x.own,x.online]),[['Joker',10,false,false],['MENY',24,true,false]]);
 assert.equal(row.savings.storeName,'Joker');assert.equal(row.savings.perUnit,50);assert.equal(row.savings.annual,300);
 assert.equal(row.elsewhere,null,'a chain outside the family stores never steers the purchase');
 f.link();row=f.shop.familyView().odaDraft.items[0];
 assert.deepEqual(row.others.map(x=>x.storeName),['Joker','MENY'],'a linked family shows every chain too');
 f.shop.libraryLink({watchId:f.w.id,evidence:'Eksakt variant',links:[]});row=f.shop.familyView().odaDraft.items[0];
 assert.deepEqual(row.others,[]);assert.deepEqual(row.variants.map(x=>x.productId),[1],'a declined watch shows no family');
});

test('family rows respect exclusions, show one row per chain first, and appear on cart lines',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.native(f.rows[4],'excluded');
 let row=f.shop.familyView().odaDraft.items[0];assert.deepEqual(row.others.map(x=>x.storeName),['MENY']);
 const cart=id=>f.shop.cartReview({groups:[{items:[{product:{id,name:'Ketchup'},quantity:1,totalGrossAmount:'30.00'}]}],validationMessages:[],totalGrossAmount:'30.00'}).lines[0];
 const hit=cart(1);assert.equal(hit.watchId,f.w.id);assert.deepEqual(hit.others.map(x=>x.storeName),['MENY']);assert.equal(hit.places[0].unitPrice,24);assert.equal(hit.savings.perUnit,36);
 assert.ok(hit.variants.some(x=>x.productId===2));
 f.shop.list({action:'variant',watchId:f.w.id,productId:2});assert.equal(f.shop.familyView().odaDraft.items[0].productId,2,'a family product can be chosen');
 const state=f.state.shopping;delete state.odaChoices[f.w.id];state.watches[f.w.id].enabled=false;
 const outside=cart(2);assert.equal(outside.watchId,null);assert.deepEqual(outside.others.map(x=>x.storeName),['Rest','MENY']);assert.equal(outside.familyUnit,'kg');
});

test('a product from another chain goes on that store list and shrinks the Oda suggestion',t=>{
 const f=fixture(t);f.native(f.rows[0]);
 const before=f.shop.familyView().odaDraft.items[0],place=before.places.find(x=>x.storeName==='MENY');
 assert.equal(before.packs,1);
 const entry=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',detail:place.name,storeName:place.storeName,packs:1,packAmount:place.packAmount,unit:'kg',unitPrice:place.unitPrice,saving:18});
 assert.equal(entry.storeName,'MENY');assert.equal(entry.reason,'Billigere enn på Oda');assert.equal(entry.detail,'Meny ketchup 500 g');
 assert.equal(f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'MENY',packs:1,packAmount:.5,unit:'kg',unitPrice:24}).id,entry.id,'pressing twice adds one line');
 assert.notEqual(f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'SPAR',packs:1,packAmount:.5,unit:'kg',unitPrice:24}).id,entry.id,'another store gets its own line');
 assert.equal(f.shop.familyView().list.open.filter(x=>x.storeName==='MENY').length,1);
 const free=f.shop.list({action:'add',alternative:true,name:'Ketchup uten varegruppe',detail:'Joker ketchup',storeName:'Joker',packs:2,packAmount:.5,unit:'kg',unitPrice:10});
 assert.equal(free.watchId,null);assert.equal(free.storeName,'Joker');assert.equal(free.routing,null);
 assert.throws(()=>f.shop.list({action:'add',alternative:true,name:'x',storeName:'Joker',unit:'tonn'}),/enhet/);
});

test('every list line that costs more elsewhere is marked, also lines at another store',t=>{
 const f=fixture(t);f.native(f.rows[0]);
 const entry=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'MENY',packs:1,packAmount:.5,unit:'kg',unitPrice:60});
 const row=f.shop.familyView().list.open.find(x=>x.id===entry.id);
 assert.deepEqual(row.places.map(x=>x.storeName),['Rest','Oda']);assert.equal(row.savings.storeName,'Oda','a web shop without freight is not the saving basis');assert.equal(row.savings.annual,264);
 f.shop.list({action:'check',id:entry.id});assert.deepEqual(f.shop.familyView().list.done.find(x=>x.id===entry.id).places,[]);
});

test('savings use a physical store over a web shop whose price lacks freight',t=>{
 const f=fixture(t);f.shop.settings({stores:[{id:'meny',name:'MENY – Kassal-kjedepriser',url:'https://example.com/meny',minSavings:0,chainCode:'MENY_NO'},{id:'web',name:'Joker (nettbutikk)',url:'https://example.com/web',minSavings:0,chainCode:'JOKER_NO'}]});f.native(f.rows[0]);
 const row=f.shop.familyView().odaDraft.items[0];assert.equal(row.places[0].online,true);assert.equal(row.savings.storeName,'MENY');assert.equal(row.savings.online,false);
});

test('photos from other chains come from a sidecar and are served only from known addresses',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.dir,'product-images.json'),JSON.stringify({'kassal:MENY_NO:4':'https://images.example.com/meny.jpg','kassal:ODA_NO:2':'javascript:alert(1)'}));
 f.native(f.rows[0]);const row=f.shop.familyView().odaDraft.items[0],meny=row.others.find(x=>x.storeName==='MENY');
 assert.ok(meny.image);assert.equal(f.shop.imageSource(meny.image),'https://images.example.com/meny.jpg');
 assert.equal(row.others.find(x=>x.storeName==='Rest').image,null);
 assert.equal(row.variants.find(x=>x.productId===2).image,null,'only https addresses are accepted');
 const entry=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'MENY',packs:1,packAmount:.5,unit:'kg',unitPrice:24,imageId:meny.image});
 assert.equal(f.shop.familyView().list.open.find(x=>x.id===entry.id).image,meny.image);
});

test('a line moved to another store can go back to Oda, as Oda variants and in one tap',async t=>{
 const f=fixture(t);f.native(f.rows[0]);
 const entry=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',detail:'Meny ketchup 500 g',storeName:'MENY',packs:3,packAmount:.5,unit:'kg',unitPrice:24});
 const row=f.shop.familyView().list.open.find(x=>x.id===entry.id);
 assert.equal(row.odaReturn.productId,1,'the usual Oda product, not the cheapest other brand');
 assert.ok(row.others.filter(x=>x.storeName==='Oda').some(x=>x.odaProductId===1));
 assert.throws(()=>f.shop.list({action:'toOda',id:entry.id,productId:999}),/Varianten/);
 const moved=f.shop.list({action:'toOda',id:entry.id,productId:1});
 assert.equal(moved.storeName,'Oda');assert.equal(moved.odaProductId,1);assert.equal(moved.packs,3);assert.equal(moved.unitPrice,60);assert.equal(moved.offerId,null);assert.equal(moved.saving,null);
 assert.equal(f.shop.familyView().list.open.find(x=>x.id===entry.id).odaReturn,null);
 const urgent=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'SPAR',packs:1,packAmount:.5,unit:'kg',unitPrice:24,need:'now'});
 urgent.need='now';f.state.shopping.shoppingList.find(x=>x.id===urgent.id).need='now';
 assert.equal(f.shop.familyView().list.open.find(x=>x.id===urgent.id).odaReturn,null);assert.throws(()=>f.shop.list({action:'toOda',id:urgent.id,productId:1}),/nærbutikk/);
 const calls=[],oda={status:()=>({connected:true}),addToCart:async x=>{calls.push(x);},cart:async()=>({groups:[],validationMessages:[]})},cart=createOdaCart({oda,shopping:f.shop});
 const again=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'Rema',packs:1,packAmount:.5,unit:'kg',unitPrice:24});
 const result=await cart.list({action:'toOda',id:again.id,productId:1});
 assert.equal(result.inCart,true);assert.deepEqual(calls.map(x=>[x.productId,x.quantity]),[[1,1]]);assert.equal(f.shop.familyView().list.open.some(x=>x.id===again.id),false);
});

test('the item card shows the library score, its measurement and the label',t=>{
 const f=fixture(t);f.native(f.rows[0]);f.d.products[1].nutrition={basis:'g',per100:{kcal:90,protein:1,fat:0,carbs:20,salt:2},sourceUrl:'https://oda.com/no/products/2-vare/',evidence:'Etikett'};f.d.products[1].metadataFingerprint=productMetadataFingerprint(f.d.products[1]);f.d.memberships[1].reviewedFingerprint=f.d.products[1].metadataFingerprint;f.write();
 const info=f.shop.productInfo({key:'kassal:ODA_NO:2'});
 assert.equal(info.product.name,'Billig ketchup 500 g');assert.equal(info.product.storeName,'Oda');assert.equal(info.product.ingredients,tomato(100));assert.equal(info.product.nutrition.per100.salt,2);
 const q=info.groups[0].quality;assert.equal(q.score,50);assert.equal(q.value,100);assert.equal(q.unit,'g/100 g');assert.ok(q.limitations.length);assert.equal(q.rank,3);assert.equal(q.of,3);
 assert.deepEqual(q.peers.map(x=>[x.score,x.own]),[[100,false],[74,false],[50,true]]);
 assert.equal(info.groups[0].equivalenceEvidence,'Vanlig tomatketchup lest');
});

test('the item card finds a product from a watch or list line, and says when nothing is known',t=>{
 const f=fixture(t);f.native(f.rows[0]);
 assert.equal(f.shop.productInfo({watchId:f.w.id}).product.name,'Vanlig ketchup 500 g');
 assert.equal(f.shop.productInfo({key:'kassal:ODA_NO:999'}).product,null);
 assert.equal(f.shop.productInfo({key:'__proto__',watchId:'__proto__'}).product,null);
 const unscored=f.shop.productInfo({key:'kassal:MENY_NO:4'}).groups[0];assert.equal(unscored.quality,null);assert.equal(unscored.qualityStatus,'unknown');
 const row=f.shop.familyView().odaDraft.items[0];assert.equal(row.productKey,'kassal:ODA_NO:1');assert.equal(row.others.find(x=>x.storeName==='MENY').productKey,'kassal:MENY_NO:4');
 const entry=f.shop.list({action:'add',alternative:true,watchId:f.w.id,name:'Tomatketchup',storeName:'MENY',packs:1,packAmount:.5,unit:'kg',unitPrice:24,productKey:'kassal:MENY_NO:4'});
 assert.equal(f.shop.familyView().list.open.find(x=>x.id===entry.id).productKey,'kassal:MENY_NO:4');
 const line=f.shop.cartReview({groups:[{items:[{product:{id:1,name:'Ketchup'},quantity:1,totalGrossAmount:'30.00'}]}],validationMessages:[],totalGrossAmount:'30.00'}).lines[0];assert.equal(line.productKey,'kassal:ODA_NO:1');
});

test('the item card shares places on equal scores and hides raw label data in the evidence',t=>{
 const f=fixture(t);f.d.memberships[0].equivalenceEvidence='Etikett lest. Kildens per100-verdier: {"kcal":102,"fat":0.1} Pakning i navnet.';f.write();
 for(const row of [2])f.rows[row].p.ingredients=tomato(200);
 f.d.products[0].ingredients=tomato(200);f.d.products[0].metadataFingerprint=productMetadataFingerprint(f.d.products[0]);f.d.memberships[0].reviewedFingerprint=f.d.products[0].metadataFingerprint;f.write();
 const info=f.shop.productInfo({key:'kassal:ODA_NO:1'}).groups[0];
 assert.equal(info.quality.score,100);assert.equal(info.quality.rank,1,'a tie at the top is first place');
 assert.equal(info.equivalenceEvidence,'Etikett lest. Pakning i navnet.');
});

function withNutrition(f,values) {
 values.forEach((v,i)=>{if(!v)return;const p=f.d.products[i];p.nutrition={basis:'g',per100:{kcal:100,protein:1,fat:0,carbs:20,...v},sourceUrl:p.sourceUrl,evidence:'Etikett'};p.metadataFingerprint=productMetadataFingerprint(p);f.d.memberships[i].reviewedFingerprint=p.metadataFingerprint;});f.write();
}
test('pills show relative nutrition and only mark products with both high quality and a low price',t=>{
 const f=fixture(t);withNutrition(f,[{sugars:30,salt:2},{sugars:12,salt:1},{sugars:10,salt:1},{sugars:20,salt:1.8}]);f.native(f.rows[0]);f.link();
 const row=f.shop.familyView().odaDraft.items[0],by=id=>row.variants.find(x=>x.productId===id);
 assert.deepEqual(row.pills,{raw:{score:74,label:'Råvarekvalitet',unknown:false},nutrition:{score:0,level:'low'},value:null});
 assert.equal(by(2).pills.nutrition.level,'good');assert.deepEqual(by(2).pills.value,{quality:73,price:100},'good quality at the lowest price');
 assert.equal(by(3).pills.nutrition.level,'good');assert.equal(by(3).pills.value,null,'top quality at the highest price is not value for money');
 const meny=row.others.find(x=>x.storeName==='MENY');assert.equal(meny.pills.nutrition.level,'medium');assert.equal(meny.pills.value,null);
 const card=f.shop.productInfo({key:'kassal:ODA_NO:2'}),group=card.groups[0];
 assert.deepEqual(card.product.pills,by(2).pills);assert.equal(group.value.top,true);assert.deepEqual(group.nutrition.measures.map(x=>x.key),['sugars','salt']);
 f.clock.at='2026-11-12T12:00:00Z';assert.equal(f.shop.productInfo({key:'kassal:ODA_NO:2'}).product.pills.value,null,'a stale price cannot earn the value pill');
});

test('a cheap product without an ingredient measure can never be called good value',t=>{
 const f=fixture(t);withNutrition(f,[{sugars:30,salt:2},{sugars:12,salt:1},{sugars:10,salt:1},null,null,{sugars:8,salt:.8}]);f.native(f.rows[0]);f.link();
 const row=f.shop.familyView().odaDraft.items[0],cheapest=row.variants.find(x=>x.productId===6),scored=row.variants.find(x=>x.productId===2);
 assert.equal(cheapest.unitPrice<scored.unitPrice,true);
 assert.equal(cheapest.pills.nutrition.level,'good','good sugar and salt figures are still shown');
 assert.deepEqual(cheapest.pills.raw,{score:null,label:null,unknown:true},'unknown is shown, never hidden or scored as zero');
 assert.equal(cheapest.pills.value,null);
 assert.ok(scored.pills.value,'the documented product at a good price keeps the pill');
});

test('a family with no ingredient measure can use nutrition alone for value',t=>{
 const f=fixture(t);for(const i of [0,1,2]){f.d.products[i].ingredients='Tomater, eddik';f.d.products[i].metadataFingerprint=productMetadataFingerprint(f.d.products[i]);f.d.memberships[i].reviewedFingerprint=f.d.products[i].metadataFingerprint;}
 withNutrition(f,[{sugars:30,salt:2},{sugars:12,salt:1},{sugars:10,salt:1}]);f.native(f.rows[0]);f.link();
 const pill=f.shop.familyView().odaDraft.items[0].variants.find(x=>x.productId===2).pills;
 assert.equal(pill.raw,null);assert.ok(pill.value);
});
