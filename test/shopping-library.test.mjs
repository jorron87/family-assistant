import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';

const NOW='2026-11-09T12:10:00Z',RECEIPT='2026-11-09T12:05:00Z';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shopping-library-')),file=path.join(dir,'library.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const g={id:'beans',name:'Whole beans',category:'Coffee',canonicalUnit:'kg',inclusionCriteria:'Roasted whole beans',exclusions:['Ground'],qualityBasis:'Reviewed same use',comparisonBasis:'Per kg'};
 const p={productKey:'kassal:ODA_NO:1',source:'kassal',store:'ODA_NO',id:'1',name:'Whole beans 500g',ean:null,brand:null,ingredients:'Roasted whole beans',description:'',sourceUrl:'https://oda.com/no/products/123-test/',canonicalPackAmount:.5,unit:'kg',packEvidence:'Reviewed label 500g',nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
 const d={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[g],products:[p],memberships:[{groupId:g.id,productKey:p.productKey,status:'approved',equivalenceEvidence:'Roasted whole beans reviewed',qualityEvidence:'Same use and form',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),reviewedAt:'2026-11-09T11:00:00Z',sourceReceipts:[{url:p.sourceUrl,observedAt:'2026-11-09T11:00:00Z',evidence:'Actual ingredients and package read'}]}],prices:[{productKey:p.productKey,grossPackPrice:20,receiptAt:RECEIPT,availabilityScope:'chain',sourceUrl:p.sourceUrl}]};
 const write=()=>fs.writeFileSync(file,JSON.stringify(d));write();
 const clock={at:NOW},provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)}),state={},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});
 const w=shop.watch({name:'Coffee',unit:'kg',storage:'pantry',purchaseAmount:12,targetPrice:100});
 const seen=shop.catalogObserve({watchId:w.id,products:[{id:'1',store:'ODA_NO',name:p.name,ingredients:p.ingredients,description:p.description,sourceUrl:p.sourceUrl,currentPrice:30,lastChecked:'2026-11-09T12:00:00Z'}]}).entries[0];
 const approve=()=>shop.catalogReview({watchId:w.id,id:'1',store:'ODA_NO',fingerprint:seen.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Explicit family watch approval'});
 return {d,p,g,shop,state,w,clock,provider,write,approve,file};
}

test('a library classification alone never approves a family watch; a matching native review reuses newer price evidence',t=>{
 const f=fixture(t);assert.equal(f.shop.familyView().items[0].prices.current,null);
 f.approve();let view=f.shop.familyView();assert.equal(view.items[0].prices.current,40);assert.equal(view.odaDraft.items[0].packPrice,20);
 assert.equal(f.shop.catalogEntries()[0].currentPrice,30,'read model never writes into reviewed catalogue/archive');
 f.d.prices.push({...f.d.prices[0],grossPackPrice:null,receiptAt:'2026-11-09T12:06:00Z'});f.write();
 view=f.shop.familyView();assert.equal(view.items[0].prices.current,null,'new unknown actual receipt blocks older catalogue price');assert.equal(view.odaDraft.items.length,0);
});

test('changed composition, package, review or group rules cannot lend a library price to a watch',t=>{
 const f=fixture(t);f.approve();
 f.p.ingredients='Ground beans';f.p.metadataFingerprint=productMetadataFingerprint(f.p);f.d.memberships[0].reviewedFingerprint=f.p.metadataFingerprint;f.write();assert.equal(f.shop.familyView().items[0].prices.current,60);
 f.p.ingredients='Roasted whole beans';f.p.canonicalPackAmount=1;f.p.metadataFingerprint=productMetadataFingerprint(f.p);f.d.memberships[0].reviewedFingerprint=f.p.metadataFingerprint;f.write();assert.equal(f.shop.familyView().items[0].prices.current,60);
 f.p.canonicalPackAmount=.5;f.p.metadataFingerprint=productMetadataFingerprint(f.p);f.d.memberships[0].reviewedFingerprint=f.p.metadataFingerprint;f.g.inclusionCriteria='New stricter rule';f.write();assert.equal(f.shop.familyView().items[0].prices.current,60);
});

test('expired library prices do not survive the shared freshness boundary or an unreadable file',t=>{
 const f=fixture(t);f.approve();assert.equal(f.shop.familyView().items[0].prices.current,40);
 f.clock.at='2026-11-12T12:00:00Z';assert.equal(f.shop.familyView().items[0].prices.current,null);
 fs.writeFileSync(f.file,'not JSON');assert.equal(f.provider(f.shop.catalogEntries()).status,'unavailable');assert.equal(f.shop.familyView().odaDraft.items.length,0);
});

test('conflicting simultaneous library/catalogue quotes are held and newer catalogue receipts win',t=>{
 const f=fixture(t);f.approve();
 f.d.prices[0].receiptAt='2026-11-09T12:00:00Z';f.write();assert.equal(f.shop.familyView().items[0].prices.current,null);
 f.clock.at='2026-11-09T12:11:00Z';f.shop.catalogObserve({watchId:f.w.id,products:[{id:'1',store:'ODA_NO',name:f.p.name,currentPrice:25,lastChecked:f.clock.at}]});
 assert.equal(f.shop.familyView().items[0].prices.current,50);
});

test('variable weights require a verified direct unit quote and never become an invented cart package',t=>{
 const f=fixture(t);f.approve();
 const seen=f.shop.catalogObserve({watchId:f.w.id,products:[{id:'1',store:'ODA_NO',name:'Whole beans ca. 500g',currentPrice:30,lastChecked:'2026-11-09T12:00:00Z'}]}).entries[0];
 f.shop.catalogReview({watchId:f.w.id,id:'1',store:'ODA_NO',fingerprint:seen.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Legacy approximate package review'});
 assert.equal(f.shop.familyView().items[0].prices.current,null);assert.equal(f.shop.familyView().odaDraft.items.length,0);
 f.p.name=seen.name;f.p.canonicalPackAmount=null;f.p.unit=null;f.p.metadataFingerprint=productMetadataFingerprint(f.p);f.d.memberships[0].reviewedFingerprint=f.p.metadataFingerprint;
 Object.assign(f.d.prices[0],{grossPackPrice:null,grossUnitPrice:40,unit:'kg',unitPriceEvidence:'Primary source explicitly quotes gross40NOK/kg',priceIncludesVat:true});f.write();
 assert.equal(f.shop.familyView().items[0].prices.current,40);assert.equal(f.shop.familyView().odaDraft.items.length,0);
 const fixed=f.shop.catalogObserve({watchId:f.w.id,products:[{id:'2',store:'ODA_NO',name:'Whole beans 500g fixed',sourceUrl:'https://oda.com/no/products/456-fixed/',currentPrice:30,lastChecked:RECEIPT}]}).entries[0];
 f.shop.catalogReview({watchId:f.w.id,id:'2',store:'ODA_NO',fingerprint:fixed.fingerprint,status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Reviewed fixed 500g whole beans'});
 const cart=f.shop.cartReview({groups:[{items:[{product:{id:456,name:fixed.name},quantity:1,totalGrossAmount:30}]}],validationMessages:[]});
 assert.deepEqual(cart.lines[0].cheapestKnown,{storeName:'Oda',unitPrice:40},'cart includes verified unit quotes without inventing a buyable pack');
});
