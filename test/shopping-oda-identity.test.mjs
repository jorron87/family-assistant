import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {libraryPriceProvider} from '../src/shopping-library.mjs';
import {productMetadataFingerprint,groupMetadataFingerprint} from '../src/product-library.mjs';
import {odaProductIdFromUrl} from '../src/oda-product-identity.mjs';

const NOW='2026-11-10T12:00:00Z',NATIVE='2026-11-10T10:00:00Z',NEWER='2026-11-10T11:00:00Z';
function fixture(t,{kind='oil',receiptUrl='https://prices.example.test/receipts/51',canonicalUrl,price=28}={}){
 const dir=mkdtempSync(join(tmpdir(),'oda-identity-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir(),'oda-identity-')));rmSync(dir,{recursive:true,force:true});});
 const flour=kind==='flour',unit=flour?'kg':'l',amount=flour?2:1,id=flour?'52':'51',odaId=flour?702:701;
 const g={id:'synthetic-'+kind,name:'Synthetic plain '+kind,category:'Pantry',canonicalUnit:unit,inclusionCriteria:'Actual plain '+kind+' for the documented use.',exclusions:['Flavoured or mixed products'],qualityBasis:'Actual complete ingredients and package',comparisonBasis:'Per '+unit};
 const p={productKey:'kassal:ODA_NO:'+id,source:'kassal',store:'ODA_NO',id,name:'Synthetic plain '+kind+' '+amount+' '+unit,brand:'Synthetic',ean:null,ingredients:flour?'Wheat flour':'Refined vegetable oil',description:'Synthetic reviewed label, never household data.',sourceUrl:canonicalUrl??'https://oda.com/no/products/'+odaId+'-synthetic-'+kind+'/',canonicalPackAmount:amount,unit,packEvidence:'Actual synthetic fixed '+amount+' '+unit+' label.',rawPack:{weight:amount*1000,weightUnit:flour?'g':'ml'},nutrition:null};p.metadataFingerprint=productMetadataFingerprint(p);
 const data={schemaVersion:1,createdAt:NOW,updatedAt:NOW,groups:[g],products:[p],memberships:[{groupId:g.id,productKey:p.productKey,status:'approved',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(g),equivalenceEvidence:'Actual synthetic plain product ingredients and use.',qualityEvidence:'Read the complete synthetic fixed-package label.',reviewedAt:NATIVE,sourceReceipts:[{url:p.sourceUrl,observedAt:NATIVE,evidence:'Read the synthetic original package and actual complete ingredients.'}]}],prices:[{productKey:p.productKey,grossPackPrice:price,receiptAt:NEWER,sourceUrl:receiptUrl,availabilityScope:'chain'}]};
 const file=join(dir,'library.json'),write=()=>writeFileSync(file,JSON.stringify(data),'utf8');write();
 const clock={at:NOW},provider=libraryPriceProvider(file,{now:()=>new Date(clock.at)}),state={},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices:provider});
 shop.settings({monitoringEnabled:true,stores:[]});const w=shop.watch({id:'synthetic-'+kind,name:'Synthetic '+kind+' need',unit,storage:'pantry',purchaseAmount:12});
 const entry=shop.catalogObserve({watchId:w.id,products:[{id:p.id,store:p.store,name:p.name,brand:p.brand,ingredients:p.ingredients,description:p.description,weight:p.rawPack.weight,weightUnit:p.rawPack.weightUnit,sourceUrl:p.sourceUrl,currentPrice:30,lastChecked:NATIVE}]}).entries[0];
 shop.catalogReview({watchId:w.id,id:p.id,store:p.store,fingerprint:entry.fingerprint,status:'approved',packAmount:amount,unit,equivalenceEvidence:'Actual unchanged synthetic plain SKU and fixed package.'});
 return {shop,state,p,w,data,provider,clock,write,odaId};
}

test('fresh library receipt URLs cannot remove reviewed oil or flour Oda identities from the bulk draft',t=>{
 for(const kind of ['oil','flour']){
  const f=fixture(t,{kind}),view=f.shop.familyView(),row=view.odaDraft.items.find(row=>row.watchId===f.w.id);
  assert.ok(row,'a price evidence URL is not a missing product choice');assert.equal(row.productId,f.odaId);assert.equal(row.productKey,f.p.productKey);assert.equal(row.packPrice,28);assert.deepEqual(view.odaDraft.missing,[]);
 }
});

test('an incidental other Oda product ID in price evidence never changes the canonical SKU',t=>{
 const f=fixture(t,{receiptUrl:'https://oda.com/no/products/999-price-evidence-reference/'}),row=f.shop.familyView().odaDraft.items[0];
 assert.equal(row.productId,701);assert.equal(row.variants[0].productId,701);assert.equal(f.provider.reader().byOdaId(701),f.p.productKey);assert.equal(f.provider.reader().byOdaId(999),null);
});

test('a known canonical product remains identifiable when its actual price expires, without inventing a fresh quote',t=>{
 const f=fixture(t);f.clock.at='2026-11-13T12:00:00Z';const reader=f.provider.reader(),view=f.shop.familyView();
 assert.equal(reader.byOdaId(f.odaId),f.p.productKey);assert.equal(reader.quote(f.p.productKey).price.fresh,false);assert.equal(view.items[0].prices.current,null);assert.equal(view.odaDraft.items.length,0,'a refresh flow may reuse identity, never a fictitious fresh price');
});

test('only a canonical HTTPS Oda product URL supplies a safe retailer identity',()=>{
 for(const url of ['https://oda.com/no/products/701-synthetic/','https://www.oda.com/no/products/701-synthetic','https://oda.com/products/701-synthetic/','https://oda.com/no/products/701'])assert.equal(odaProductIdFromUrl(url),701,url);
 for(const url of [null,701,'not a URL','http://oda.com/no/products/701-synthetic/','https://prices.example.test/no/products/701-synthetic/','https://oda.com.evil.example/no/products/701-synthetic/','https://oda.com:8443/no/products/701-synthetic/','https://oda.com/api/products/701-synthetic/','https://oda.com/no/products/0-invalid','https://oda.com/no/products/9007199254740993-unsafe'])assert.equal(odaProductIdFromUrl(url),null,String(url));
 const credentials=new URL('https://oda.com/no/products/701-synthetic/');credentials.username='synthetic';credentials.password='fixture';assert.equal(odaProductIdFromUrl(credentials.href),null);
 const masquerade=new URL('https://evil.example/no/products/701-synthetic/');masquerade.username='oda.com';assert.equal(odaProductIdFromUrl(masquerade.href),null);
});

test('HTTP or unrelated-host product metadata cannot become a cart ID through native quotes or the library index',t=>{
 assert.throws(()=>fixture(t,{canonicalUrl:'http://oda.com/no/products/701-synthetic/'}),/HTTPS/,'native observation already rejects insecure source metadata');
 for(const canonicalUrl of ['https://prices.example.test/no/products/701-synthetic/']){
  const f=fixture(t,{canonicalUrl}),view=f.shop.familyView();assert.equal(f.provider.reader().byOdaId(701),null);assert.equal(view.odaDraft.items.length,0);assert.ok(view.odaDraft.missing.includes(f.w.name));
 }
});

test('composite reads resolve the Oda price overlay once and observe the next actual receipt immediately',t=>{
 const f=fixture(t),g=f.data.groups[0];
 f.shop.libraryLink({familyId:f.w.id,evidence:'Reviewed synthetic plain-oil group and fixed litre package.',variants:[{groupId:g.id,groupFingerprint:groupMetadataFingerprint(g),evidence:'Actual complete synthetic recipe and plain form.'}]});
 for(let n=0;n<20;n++)f.shop.watch({id:'extra-'+n,name:'Synthetic extra family '+n,unit:'l',storage:'pantry'});
 f.shop.sesumReceivePrices({familyIds:[f.w.id],fetchedAt:NOW,products:[{id:'171',name:f.p.name,brand:f.p.brand,ean:[],weight:1000,weightUnit:'ml',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/171-synthetic-plain-oil',prices:[{storeCode:'KIWI',price:22,observedAt:NOW,source:'receipt_realtime',isPromo:false,promotion:null}]}]});
 const row=f.shop.sesumCandidates(f.w.id)[0],donor=row.donors.find(d=>d.productKey===f.p.productKey);
 f.shop.sesumPriceReview({sourceKey:row.sourceKey,sourceFingerprint:row.sourceFingerprint,productKey:f.p.productKey,productFingerprint:donor.productFingerprint,status:'approved',packAmount:1,unit:'l',equivalenceEvidence:'Both synthetic labels document the same plain oil and fixed litre package.',packEvidence:'Actual fixed1000ml source and independently reviewed1l donor package.'});
 const receive=price=>f.shop.odaRefreshReceive({plan:f.shop.odaRefreshPlan({force:true})[0],receipts:[{observedAt:f.clock.at,product:{id:f.odaId,name:f.p.name,description:'1 l',price:price.toFixed(2),unitPrice:price.toFixed(2),unitName:'liter',url:f.p.sourceUrl,availability:{isAvailable:true}}}],observedAt:f.clock.at,searchComplete:true});
 receive(26);
 const original=f.provider.reader;let calls=0;f.provider.reader=(...args)=>{calls++;return original(...args);};
 for(const read of [()=>f.shop.familyView(),()=>f.shop.view(),()=>f.shop.sesumCandidates(f.w.id),()=>f.shop.sesumPlacement(row.sourceKey),()=>f.shop.sesumFamilies(),()=>f.shop.sesumPriceStatus(),()=>f.shop.odaRefreshPlan({force:true}),()=>f.shop.libraryAudit(),()=>f.shop.productInfo({key:f.p.productKey,watchId:f.w.id})]){
  calls=0;read();assert.ok(calls<=1,`one composite read resolved the base library ${calls} times`);
 }
 f.clock.at='2026-11-10T12:01:00Z';receive(25);
 assert.equal(f.shop.familyView().odaDraft.items.find(x=>x.watchId===f.w.id).unitPrice,25);
 assert.equal(f.shop.productInfo({key:f.p.productKey,watchId:f.w.id}).product.price.grossPackPrice,25);
 f.clock.at='2026-11-13T12:00:00Z';assert.equal(f.shop.familyView().odaDraft.items.length,0,'per-read reuse never preserves expired prices across calls');
});
