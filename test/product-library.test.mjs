import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createProductLibrary,groupMetadataFingerprint,productMetadataFingerprint,readProductLibrary} from '../src/product-library.mjs';

const NOW='2026-11-09T12:00:00Z',OLD='2026-10-01T12:00:00Z';
function product(id,store,extra={}) {
 const p={productKey:`kassal:${store}:${id}`,source:'kassal',store,id:String(id),name:'Cashewnøtter naturell',ean:null,brand:'Testmerke',ingredients:'Cashewnøtter',description:'Usaltede nøtter',sourceUrl:'https://example.com/products/'+id,canonicalPackAmount:.5,unit:'kg',packEvidence:'Etiketten dokumenterer 500 g',nutrition:null,...extra};
 p.metadataFingerprint=productMetadataFingerprint(p);return p;
}
const group=(id='cashew',unit='kg')=>({id,name:'Cashewnøtter naturell',category:'Nøtter',canonicalUnit:unit,inclusionCriteria:'Usaltede cashewnøtter uten smakstilsetning',exclusions:['Saltede nøtter'],qualityBasis:'Omtrent samme råvare- og kvalitetsnivå',comparisonBasis:'Innhold og bruk, merker kan variere'});
const membership=(p,extra={})=>({groupId:'cashew',productKey:p.productKey,status:'approved',equivalenceEvidence:'Naturell cashew uten tilsatt salt eller olje',qualityEvidence:'Samme type nøtt og tilberedning; ingen dokumentert kvalitetsforskjell',reviewedFingerprint:p.metadataFingerprint,reviewedGroupFingerprint:groupMetadataFingerprint(group()),reviewedAt:OLD,sourceReceipts:[{url:p.sourceUrl,observedAt:OLD,evidence:'Ingrediens- og pakningsetikett lest'}],...extra});
const price=(p,value,extra={})=>({productKey:p.productKey,grossPackPrice:value,receiptAt:NOW,availabilityScope:'chain',sourceUrl:p.sourceUrl,...extra});
function fixture() {
 const a=product(1,'CHAIN_A'),b=product(2,'CHAIN_B');
 return {schemaVersion:1,createdAt:OLD,updatedAt:NOW,coverage:{note:'Discovery plan is not assortment coverage'},groups:[group()],products:[a,b],memberships:[membership(a),membership(b)],prices:[price(a,30),price(b,25)]};
}

test('quality annotations follow reviewed metadata without changing price or equivalence decisions',()=>{
 const data=fixture(),g={...group(),id:'ketchup-standard',inclusionCriteria:'Vanlig tomatketchup'};data.groups=[g];data.products=data.products.map((p,i)=>{const out={...p,name:'Tomatketchup',ingredients:i?'Tomater (200g per100g ketchup), sukker.':'Tomater (148g per100g ketchup), sukker.'};out.metadataFingerprint=productMetadataFingerprint(out);return out;});data.memberships=data.products.map(p=>({...membership(p),groupId:g.id,reviewedGroupFingerprint:groupMetadataFingerprint(g)}));
 const before=createProductLibrary(data,{now:NOW}).compare(g.id);assert.equal(before.rows.find(r=>r.productKey===data.products[0].productKey).quality.score,74);assert.equal(before.rows.find(r=>r.productKey===data.products[1].productKey).quality.score,100);assert.equal(before.cheapest.unitPrice,50);
 data.products[1].ingredients='Tomater (250g per100g ketchup), sukker.';const changed=createProductLibrary(data,{now:NOW}).compare(g.id);assert.equal(changed.rows.find(r=>r.productKey===data.products[1].productKey).quality.score,null);assert.equal(changed.counts.reviewed,1);assert.equal(changed.cheapest.unitPrice,60);
 data.products[1].metadataFingerprint=productMetadataFingerprint(data.products[1]);assert.equal(createProductLibrary(data,{now:NOW}).compare(g.id).rows.find(r=>r.productKey===data.products[1].productKey).quality.score,null);
});

test('shopping index withholds a conflicting fiber value but keeps other nutrition and the source data',()=>{
 const data=fixture(),p=data.products[0];
 p.nutrition={basis:'g',per100:{kcal:220,fat:2,fiber:6.5},sourceUrl:p.sourceUrl,evidence:'Næring per 100 g fra etikett'};
 p.nutritionObservation={fiberConflict:{evidence:'To ulike deklarasjoner',observations:[{value:6.5},{value:0}]}};
 p.metadataFingerprint=productMetadataFingerprint(p);data.memberships[0].reviewedFingerprint=p.metadataFingerprint;
 const library=createProductLibrary(data,{now:NOW}),out=library.shoppingIndex().products[p.productKey].nutrition;
 assert.equal(out.per100.fiber,null);assert.equal(out.per100.fat,2);assert.equal(out.fiberConflict,true);
 assert.equal(p.nutrition.per100.fiber,6.5);assert.equal(p.nutritionObservation.fiberConflict.observations[0].value,6.5);
});

test('explicit reviewed groups compare gross package prices across canonical pack sizes',()=>{
 const data=fixture();data.products[1]=product(2,'CHAIN_B',{canonicalPackAmount:.25,packEvidence:'Etiketten dokumenterer 250 g'});data.memberships[1]=membership(data.products[1]);data.prices[1]=price(data.products[1],20);
 const reader=createProductLibrary(data,{now:NOW}),view=reader.compare('cashew');
 assert.equal(view.rows.length,2);assert.equal(view.cheapest.unitPrice,60);assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);assert.equal(view.rows[1].unitPrice,80);assert.equal(view.counts.reviewed,2);
 assert.equal(view.rows[0].price.receiptAt,NOW);assert.equal(view.rows[0].price.availabilityScope,'chain');
 view.rows[0].product.name='Changed output';assert.equal(reader.search('Cashew').items[0].product.name,'Cashewnøtter naturell');
 assert.equal(data.products[0].name,'Cashewnøtter naturell');assert.throws(()=>reader.compare('missing'),/Unknown/);
});

test('length comparison uses documented meters and rejects a direct price per roll',()=>{
 const data=fixture(),g={...group('baking-roll','m'),name:'Bakepapir, rull 38 cm',inclusionCriteria:'Rull med dokumentert bredde 38 cm',comparisonBasis:'Pris per meter ved lik bredde'};data.groups=[g];
 data.products=[product(1,'CHAIN_A',{name:'Bakepapir 8 m',unit:'m',canonicalPackAmount:8,packEvidence:'8 meter og 38 cm bredde dokumentert'}),product(2,'CHAIN_B',{name:'Bakepapir 10 m',unit:'m',canonicalPackAmount:10,packEvidence:'10 meter og 38 cm bredde dokumentert'})];
 data.memberships=data.products.map(p=>membership(p,{groupId:g.id,reviewedGroupFingerprint:groupMetadataFingerprint(g)}));data.prices=[price(data.products[0],24),price(data.products[1],25)];
 let reader=createProductLibrary(data,{now:NOW}),view=reader.compare(g.id);assert.equal(reader.audit().ok,true);assert.equal(view.cheapest.unitPrice,2.5);assert.equal(view.cheapest.unit,'m');
 data.products[1]=product(2,'CHAIN_B',{name:'Bakepapir med ukjent lengde',unit:'m',canonicalPackAmount:null,packEvidence:'Lengde ukjent'});data.memberships[1]=membership(data.products[1],{groupId:g.id,reviewedGroupFingerprint:groupMetadataFingerprint(g)});data.prices[1]=price(data.products[1],null,{grossUnitPrice:1,unit:'stk',unitPriceEvidence:'Pris per rull',priceIncludesVat:true});
 view=createProductLibrary(data,{now:NOW}).compare(g.id);assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);assert.equal(view.rows.find(r=>r.productKey===data.products[1].productKey).unitPrice,null);
});

test('stale prices retain membership but never win today; the latest actual receipt wins over older cheap rows',()=>{
 const data=fixture();data.prices=[price(data.products[0],1,{receiptAt:OLD}),price(data.products[1],2,{receiptAt:'2026-11-09T10:00:00Z'}),price(data.products[1],25)];
 const view=createProductLibrary(data,{now:NOW}).compare('cashew');
 assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_B:2']);assert.equal(view.cheapest.unitPrice,50);
 const stale=view.rows.find(r=>r.productKey==='kassal:CHAIN_A:1');assert.equal(stale.reviewCurrent,true);assert.equal(stale.price.fresh,false);assert.equal(stale.unitPrice,null);assert.ok(stale.reasons.includes('stale-price-receipt'));
 data.prices[2].grossPackPrice=null;const missing=createProductLibrary(data,{now:NOW}).compare('cashew');assert.equal(missing.cheapest,null,'a later unknown quote cannot revive the earlier cheap receipt');
});

test('metadata fingerprints are canonical, exclude price updates and invalidate changed composition or pack evidence',()=>{
 const data=fixture(),p=data.products[0],original=p.metadataFingerprint;
 assert.equal(productMetadataFingerprint({...p,currentPrice:99,fetchedAt:NOW}),original);
 assert.equal(productMetadataFingerprint(Object.fromEntries(Object.entries(p).reverse())),original);
 p.ingredients='Cashewnøtter, salt';let reader=createProductLibrary(data,{now:NOW});assert.equal(reader.compare('cashew').rows.find(r=>r.productKey===p.productKey).eligible,false);assert.ok(reader.audit().issues.some(i=>i.code==='metadata-fingerprint-mismatch'));
 p.metadataFingerprint=productMetadataFingerprint(p);reader=createProductLibrary(data,{now:NOW});assert.ok(reader.compare('cashew').rows.find(r=>r.productKey===p.productKey).reasons.includes('reviewed-metadata-changed'));
 assert.notEqual(productMetadataFingerprint({...p,rawPack:{weight:500,weightUnit:'g'}}),p.metadataFingerprint);
 assert.notEqual(productMetadataFingerprint({...p,nutritionObservation:{basis:'unknown'}}),p.metadataFingerprint);
});

test('unknown, excluded and missing-evidence relationships cannot set the cheapest price',()=>{
 for(const patch of [{status:'unknown'},{status:'excluded',equivalenceEvidence:'Salted variant is outside this group'},{qualityEvidence:''},{sourceReceipts:[]},{reviewedAt:'2026-11-09T12:00:01Z'},{sourceReceipts:[{url:'https://example.com/label',observedAt:'2026-11-09T12:00:01Z',evidence:'Future observation'}]}]){
  const data=fixture();data.memberships[1]={...data.memberships[1],...patch};data.prices[1].grossPackPrice=1;
  const view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);assert.equal(view.counts.currentComparable,1);
 }
});

test('variable packs, wrong units, unknown VAT and nonpositive quotes stay visible without a unit price',()=>{
 for(const [productPatch,pricePatch] of [[{canonicalPackAmount:null,rawPack:{weight:500,weightUnit:'g',name:'ca. 500 g'}},{}],[{unit:'l'},{}],[{}, {grossPackPrice:null,quotedPrice:10}],[{}, {grossPackPrice:10,priceIncludesVat:false}],[{}, {grossPackPrice:0}],[{}, {currency:'EUR'}]]){
  const data=fixture(),p=product(2,'CHAIN_B',productPatch);data.products[1]=p;data.memberships[1]=membership(p);data.prices[1]=price(p,1,pricePatch);
  const row=createProductLibrary(data,{now:NOW}).compare('cashew').rows.find(r=>r.productKey===p.productKey);assert.equal(row.reviewCurrent,true);assert.equal(row.unitPrice,null);assert.equal(row.eligible,false);
 }
});

test('duplicate identities, conflicting current receipts and duplicate membership decisions fail closed',()=>{
 const data=fixture();data.prices.push(price(data.products[1],1));
 let reader=createProductLibrary(data,{now:NOW});assert.deepEqual(reader.compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);assert.equal(reader.audit().ok,false);assert.ok(reader.audit().issues.some(i=>i.code==='conflicting-latest-prices'));
 const duplicated=fixture();duplicated.products.push({...duplicated.products[1]});reader=createProductLibrary(duplicated,{now:NOW});assert.deepEqual(reader.compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);
 const decisions=fixture();decisions.memberships.push({...decisions.memberships[1],status:'excluded'});reader=createProductLibrary(decisions,{now:NOW});assert.deepEqual(reader.compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);assert.ok(reader.audit().issues.some(i=>i.code==='duplicate-membership'));
});

test('price freshness uses the actual receipt boundary; future, unavailable and other-scope prices cannot win',()=>{
 const data=fixture(),p=data.products[1];data.prices[1]=price(p,1,{receiptAt:'2026-11-07T12:00:00Z'});assert.equal(createProductLibrary(data,{now:NOW}).compare('cashew').cheapest.unitPrice,2);
 for(const patch of [{receiptAt:'2026-11-07T11:59:59Z'},{receiptAt:'2026-11-09T12:00:01Z'},{available:false},{availabilityScope:'unknown'},{sourceUrl:null}]){
  data.prices[1]=price(p,1,patch);assert.deepEqual(createProductLibrary(data,{now:NOW}).compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);
 }
});

test('summary and audit report actual chains, categories and research gaps without claiming assortment coverage',()=>{
 const data=fixture(),unassigned=product(3,'CHAIN_C',{canonicalPackAmount:null});data.products.push(unassigned);data.memberships[1].status='unknown';
 const reader=createProductLibrary(data,{now:NOW}),summary=reader.summary();
 assert.equal(summary.actualCoverage.chains.length,3);assert.deepEqual(summary.actualCoverage.categories,[{category:'Nøtter',groups:1,products:2,reviewedProducts:1}]);assert.equal(summary.actualCoverage.researchGaps.unassignedProducts,1);assert.equal(summary.actualCoverage.researchGaps.unreviewedMemberships,1);assert.equal(summary.actualCoverage.researchGaps.unknownPackAmounts,1);
 assert.match(summary.coverageNote,/not complete/);assert.deepEqual(summary.reportedCoverage,data.coverage);assert.equal(reader.search('testmerke',{limit:1}).total,3);assert.equal(reader.search('no match').total,0);assert.throws(()=>reader.search('cashew',{limit:0}),/limit/);assert.ok(reader.audit({limit:1}).moreIssues>0);
});

test('reader and standalone CLI use an explicit BOM-capable file and perform no writes',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-product-library-')),file=join(dir,'library.json');
 try{
  writeFileSync(file,'\uFEFF'+JSON.stringify(fixture()));const bytes=readFileSync(file),files=readdirSync(dir);
  assert.equal(readProductLibrary(file,{now:NOW}).compare('cashew').cheapest.unitPrice,50);
  for(const args of [['summary'],['search','Cashew'],['compare','cashew'],['audit']]){const r=spawnSync(process.execPath,['scripts/product-library.mjs',file,...args,'--now',NOW],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.ok(JSON.parse(r.stdout));}
  assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(readdirSync(dir),files);
  const bad=spawnSync(process.execPath,['scripts/product-library.mjs','summary'],{encoding:'utf8'});assert.equal(bad.status,1);assert.match(bad.stderr,/Usage/);
  const invalid=fixture();invalid.memberships[0].reviewedFingerprint='0'.repeat(64);writeFileSync(file,JSON.stringify(invalid));const audited=spawnSync(process.execPath,['scripts/product-library.mjs',file,'audit','--now',NOW],{encoding:'utf8'});assert.equal(audited.status,2);assert.equal(JSON.parse(audited.stdout).ok,false);
  writeFileSync(file,bytes);assert.deepEqual(readFileSync(file),bytes);assert.deepEqual(readdirSync(dir),files);
  writeFileSync(file,Buffer.from([123,34,120,34,58,34,255,34,125]));assert.throws(()=>readProductLibrary(file),/UTF-8/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a malformed date, retracted availability or tiny real price difference is never hidden by normalization',()=>{
 const data=fixture();data.prices[0].grossPackPrice=25.000001;
 let view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_B:2']);
 data.prices[1].receiptAt='2026-02-30T12:00:00Z';view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);
 data.prices[1]=price(data.products[1],25);data.prices.push(price(data.products[1],25,{delisted:true}));view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);
});

test('changed group criteria reopen membership review without implicitly converting kg and litres',()=>{
 const data=fixture(),first=groupMetadataFingerprint(data.groups[0]);data.groups[0].inclusionCriteria='Only roasted nuts';
 assert.notEqual(groupMetadataFingerprint(data.groups[0]),first);
 let view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.equal(view.cheapest,null);assert.ok(view.rows.every(r=>r.reasons.includes('reviewed-group-changed')));
 data.groups[0].canonicalUnit='l';for(const m of data.memberships)m.reviewedGroupFingerprint=groupMetadataFingerprint(data.groups[0]);
 view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.equal(view.cheapest,null);assert.ok(view.rows.every(r=>r.reviewCurrent&&r.reasons.includes('unit-mismatch')));
});

function variableQuoteData() {
 const data=fixture(),p=product(2,'CHAIN_B',{canonicalPackAmount:null,unit:null,packEvidence:'Variabel vekt, ingen dokumentert fast pakning',rawPack:{weight:null,weightUnit:'kg',name:'Vektvare'}});
 data.products[1]=p;data.memberships[1]=membership(p);
 data.prices[1]={productKey:p.productKey,grossPackPrice:null,grossUnitPrice:40,unit:'kg',unitPriceEvidence:'Primærsiden oppgir 40 kr/kg inklusive mva for denne varen',priceIncludesVat:true,receiptAt:NOW,availabilityScope:'chain',sourceUrl:p.sourceUrl};
 return data;
}

test('an evidenced direct gross unit quote prices variable goods without inventing a package',()=>{
 const data=variableQuoteData(),reader=createProductLibrary(data,{now:NOW}),view=reader.compare('cashew'),row=view.rows[0];
 assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_B:2']);assert.equal(row.unitPrice,40);assert.equal(row.unitPriceBasis,'direct-unit');assert.equal(row.price.grossPackPrice,null);assert.equal(row.product.canonicalPackAmount,null);assert.equal(row.product.unit,null);assert.equal(row.price.unit,'kg');assert.equal(row.price.directUnitVerified,true);
 const summary=reader.summary();assert.equal(summary.actualCoverage.researchGaps.unknownPackAmounts,1);assert.equal(summary.actualCoverage.chains.find(x=>x.store==='CHAIN_B').currentComparableProducts,1);
 assert.equal(data.products[1].canonicalPackAmount,null);assert.equal(data.prices[1].grossPackPrice,null);
});

test('direct quotes require their own unit evidence, explicit gross VAT basis and a current receipt',()=>{
 for(const patch of [{grossUnitPrice:null},{grossUnitPrice:0},{grossUnitPrice:-1},{unit:'l'},{unit:'g'},{unitPriceEvidence:null},{unitPriceEvidence:''},{priceIncludesVat:undefined},{priceIncludesVat:false},{priceIncludesVat:null},{receiptAt:OLD},{receiptAt:'2026-11-09T12:00:01Z'},{availabilityScope:'unknown'},{sourceUrl:null}]){
  const data=variableQuoteData();Object.assign(data.prices[1],patch);const view=createProductLibrary(data,{now:NOW}).compare('cashew');assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1'],JSON.stringify(patch));assert.equal(view.rows.find(r=>r.productKey===data.products[1].productKey).unitPrice,null);
 }
 const data=variableQuoteData();delete data.prices[1].grossUnitPrice;delete data.prices[1].unitPriceEvidence;data.prices[1].current_unit_price=1;
 assert.deepEqual(createProductLibrary(data,{now:NOW}).compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1'],'raw API unit prices are never inferred as verified direct quotes');
});

test('a newer unknown receipt blocks an older unit quote and does not refresh its evidence',()=>{
 const data=variableQuoteData();data.prices[1].receiptAt='2026-11-09T10:00:00Z';
 data.prices.push({productKey:data.products[1].productKey,grossPackPrice:null,receiptAt:NOW,availabilityScope:'chain',sourceUrl:data.products[1].sourceUrl});
 const view=createProductLibrary(data,{now:NOW}).compare('cashew'),row=view.rows.find(r=>r.productKey===data.products[1].productKey);
 assert.deepEqual(view.cheapest.productKeys,['kassal:CHAIN_A:1']);assert.equal(row.price.receiptAt,NOW);assert.equal(row.price.grossUnitPrice,null);assert.equal(row.unitPrice,null);assert.equal(row.reviewCurrent,true);
});

test('direct quote conflicts and changed review fingerprints cannot set the cheapest price',()=>{
 const data=variableQuoteData();data.prices.push({...data.prices[1],grossUnitPrice:30});
 let reader=createProductLibrary(data,{now:NOW});assert.deepEqual(reader.compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);assert.ok(reader.audit().issues.some(i=>i.code==='conflicting-latest-prices'));
 data.prices.pop();data.memberships[1].reviewedGroupFingerprint='0'.repeat(64);reader=createProductLibrary(data,{now:NOW});assert.deepEqual(reader.compare('cashew').cheapest.productKeys,['kassal:CHAIN_A:1']);
});

test('documented package and unit quotes must agree, allowing only ordinary unit-price rounding',()=>{
 const data=fixture(),p=product(2,'CHAIN_B',{canonicalPackAmount:3,packEvidence:'Tre kg dokumentert på pakken'});data.products[1]=p;data.memberships[1]=membership(p);data.prices[1]={...price(p,7),grossUnitPrice:2.33,unit:'kg',unitPriceEvidence:'Primærkilde viser avrundet 2,33 kr/kg inklusive mva',priceIncludesVat:true};
 let reader=createProductLibrary(data,{now:NOW}),row=reader.compare('cashew').rows[0];assert.equal(row.unitPrice,7/3);assert.equal(row.unitPriceBasis,'package');assert.equal(row.eligible,true);
 data.prices[1].grossUnitPrice=1;reader=createProductLibrary(data,{now:NOW});row=reader.compare('cashew').rows.find(r=>r.productKey===p.productKey);assert.equal(row.eligible,false);assert.ok(row.reasons.includes('conflicting-price-bases'));assert.ok(reader.audit().issues.some(i=>i.code==='conflicting-price-bases'));
});
