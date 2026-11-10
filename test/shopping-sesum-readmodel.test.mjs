import test from 'node:test';
import assert from 'node:assert/strict';
import {shoppingStore} from '../src/shopping.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {productTextHash} from '../src/product-library.mjs';
import {sesumDonorFingerprint} from '../src/sesum-prices.mjs';

const NOW='2026-11-10T12:00:00Z';
function fixture(){
  const index={builtAt:NOW,groups:{
    beans:{name:'Plain whole coffee beans',unit:'kg',fingerprint:'a'.repeat(64),inclusion:'Plain whole roasted beans',exclusions:['Ground beans'],comparisonBasis:'Per actual kg'},
    organic:{name:'Organic whole coffee beans',unit:'kg',fingerprint:'b'.repeat(64),inclusion:'Plain organic whole roasted beans',exclusions:['Unknown organic declaration'],comparisonBasis:'Per actual kg'}
  },members:{beans:[],organic:[]},products:{},qualityNotes:{}};
  for(const id of ['71','72']){
    const key='kassal:KIWI:'+id,p={source:'kassal',store:'KIWI',id,name:'Reviewed whole beans '+id+' 500g',brand:'Synthetic',ean:'70000000000'+id,ingredients:'Whole roasted coffee beans',description:'A separately reviewed plain whole-bean roast',pack:.5,packKnown:true,packEvidence:'Read one actual fixed 500g bag.',unit:'kg',rawPack:{weight:500,weightUnit:'g'},sourceUrl:'https://producer.example.test/label/'+id,attributes:{organic:false},available:true,nutrition:null,quote:{grossPackPrice:30,grossUnitPrice:null,unit:'kg',directUnitVerified:false,receiptAt:'2026-11-10T11:00:00Z',reasons:[],sourceUrl:'https://producer.example.test/receipt/'+id}};
    p.textHash=productTextHash(p);index.products[key]=p;index.members.beans.push({k:key,s:'approved',r:true,u:60,q:null,n:null});
  }
  const oda={...structuredClone(index.products['kassal:KIWI:71']),store:'ODA_NO',id:'801',name:'Separate reviewed Oda whole beans 500g',brand:'OdaSynthetic',ean:'7000000000801',sourceUrl:'https://oda.com/no/products/801-reviewed-whole-beans'};
  oda.quote={...oda.quote,grossPackPrice:50,sourceUrl:oda.sourceUrl};oda.textHash=productTextHash(oda);index.products['kassal:ODA_NO:801']=oda;index.members.beans.push({k:'kassal:ODA_NO:801',s:'approved',r:true,u:100,q:null,n:null});
  const clock={at:NOW},readerFactory=createIndexReader(index),libraryPrices=()=>({status:'ready',quotes:[]});libraryPrices.reader=()=>readerFactory(Date.parse(clock.at));
  const state={},shop=shoppingStore(state,{save(){},now:()=>new Date(clock.at),libraryPrices});
  shop.settings({monitoringEnabled:true,stores:[{id:'kiwi',name:'KIWI',chainCode:'KIWI',url:'https://producer.example.test/store',minSavings:0}]});
  for(const [id,groupId] of [['plain','beans'],['organic','organic']]){
    shop.watch({id,name:id==='plain'?'Plain whole coffee beans':'Organic whole coffee beans',unit:'kg',storage:'pantry',...(id==='plain'?{purchaseAmount:10}:{}),note:id==='plain'?'Plain whole roasted beans only.':'A separately researched organic whole-bean family.'});
    shop.libraryLink({familyId:id,evidence:'An explicit current household family decision.',variants:[{groupId,groupFingerprint:index.groups[groupId].fingerprint,evidence:'Read the actual current ingredient and physical-form definition.'}]});
  }
  const ingest=(id,changes={},observedAt='2026-11-10T11:30:00Z')=>{const p=index.products['kassal:KIWI:'+id];return shop.sesumReceivePrices({familyIds:['plain','organic'],fetchedAt:clock.at,products:[{id,name:p.name,brand:p.brand,ean:[p.ean],weight:500,weightUnit:'g',soldByWeight:false,sourceUrl:'https://www.sesum.no/produkt/'+id+'-whole-beans',...changes,prices:[{storeCode:'KIWI',price:20,observedAt,source:'actual_synthetic_receipt',isPromo:false}]}]});};
  for(const id of ['71','72']){
    ingest(id);const current=state.shopping.sesumPrices.products['sesum:KIWI:'+id],p=index.products['kassal:KIWI:'+id];
    shop.sesumPriceReview({sourceKey:current.sourceKey,sourceFingerprint:current.fingerprint,productKey:'kassal:KIWI:'+id,productFingerprint:sesumDonorFingerprint(p),status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Read the actual fixed product, original ingredients, form and source identity together.',packEvidence:'Both concrete records and the actual original package document one fixed 500g bag.'});
  }
  const candidates=()=>shop.sesumCandidates(),candidate=id=>candidates().find(row=>row.sourceKey==='sesum:KIWI:'+id),family=(id,familyId)=>candidate(id).families.find(row=>row.familyId===familyId);
  const scoped=(id,status,extra={},familyId='organic')=>{const current=candidate(id),context=current.families.find(f=>f.familyId===familyId);return shop.sesumPriceReview({sourceKey:current.sourceKey,sourceFingerprint:current.sourceFingerprint,registrationFingerprint:context.registrationFingerprint,status,familyIds:[familyId],familyFingerprints:{[familyId]:context.requirementsFingerprint},equivalenceEvidence:'The exact current source is considered only for this specific household family.',...extra});};
  // A previously persisted explicit family review remains independent debt
  // when a newer queue contract introduces whole-set placement first.
  const priorBlocked=id=>{const current=candidate(id),context=current.families.find(f=>f.familyId==='organic');state.shopping.sesumFamilyReviews[current.sourceKey]={organic:{status:'blocked',sourceFingerprint:current.sourceFingerprint,familyFingerprint:context.requirementsFingerprint,registrationFingerprint:context.registrationFingerprint,evidence:'A separately recorded earlier review requires the actual organic declaration.',reason:'The actual original organic declaration remains unknown.',retryAt:'2026-11-11T12:00:00Z',reviewedAt:NOW}};};
  return {index,state,shop,clock,candidates,candidate,family,scoped,ingest,priorBlocked};
}

test('family-review reads observe scoped exclusions, blocks and reopening immediately without crossing families or sources',()=>{
  const f=fixture();
  for(const id of ['71','72']){assert.equal(f.family(id,'plain').familyReview,null);assert.equal(f.family(id,'organic').familyReview,null,'a raw organic hint never opens new family research before placement');}
  f.scoped('71','excluded');
  assert.equal(f.family('71','organic').sourceDecision.status,'excluded');assert.equal(f.family('71','organic').familyReview,null);
  assert.equal(f.family('72','organic').familyReview,null,'another source still awaits its own whole-set placement');
  assert.equal(f.family('71','plain').sourceDecision,null,'a scoped organic exclusion cannot spread to the plain family');
  assert.equal(f.shop.familyView().items.find(row=>row.id==='plain').prices.current,40,'the actually approved plain family remains usable');
  f.priorBlocked('72');f.scoped('72','blocked',{reason:'The actual organic declaration is missing from the current original label.',retryAt:'2026-11-11T12:00:00Z'});
  assert.equal(f.family('72','organic').familyReview.status,'blocked');assert.equal(f.family('72','organic').familyReview.retryAt,'2026-11-11T12:00:00Z');
  f.scoped('71','reopen');assert.equal(f.family('71','organic').sourceDecision,null);assert.equal(f.family('71','organic').familyReview,null,'an explicit reopened negative returns to current placement before new family research');
  assert.ok(f.shop.queue().some(row=>row.sourceKey==='sesum:KIWI:71'&&row.do==='shopping-sesum-placement-review'));
  assert.equal(f.family('72','organic').familyReview.status,'blocked','reopening one source cannot erase another source block');
});

test('source, household criteria and current group changes invalidate the next family-review read',()=>{
  const f=fixture();f.scoped('71','excluded');const before=f.family('71','organic');
  f.shop.watch({...f.state.shopping.watches.organic,note:'The household changed its concrete acceptable roast requirements; the original organic declaration still needs review.'});
  const changed=f.family('71','organic');assert.notEqual(changed.requirementsFingerprint,before.requirementsFingerprint);assert.equal(changed.sourceDecision,null);assert.equal(changed.familyReview,null,'a rejected OR hint returns to whole-set placement before opening new family work');
  f.ingest('72',{name:'Changed actual source variant 500g'});
  assert.equal(f.candidate('72').status,'pending','a current source metadata change withdraws its old bridge');assert.equal(f.family('72','organic').familyReview,null,'unapproved identity returns to its separate identity work');
  assert.equal(f.family('71','organic').familyReview,null,'an unchanged source without a researched organic target does not become organic-family work');
  const groupBefore=f.family('71','organic').requirementsFingerprint;f.index.groups.organic={...f.index.groups.organic,fingerprint:'c'.repeat(64),inclusion:'A materially revised organic roast definition.'};
  const groupAfter=f.family('71','organic');assert.notEqual(groupAfter.requirementsFingerprint,groupBefore);assert.deepEqual(groupAfter.groups,[],'a changed group link is visible immediately and cannot lend old group approval');assert.equal(groupAfter.familyReview,null);
  assert.equal(f.state.shopping.sesumFamilyReviews['sesum:KIWI:71'].organic.status,'excluded','the original exclusion stays intact');
  assert.ok(f.shop.queue().some(row=>row.sourceKey==='sesum:KIWI:71'&&row.do==='shopping-sesum-placement-review'));
});

test('repeated reads recheck actual price freshness and parked family work when the clock changes',()=>{
  const f=fixture();f.scoped('71','excluded');
  f.priorBlocked('72');
  f.scoped('72','blocked',{reason:'The actual organic declaration remains unknown after a separately recorded scoped review.',retryAt:'2026-11-11T12:00:00Z'});
  const plain=()=>f.shop.familyView().items.find(row=>row.id==='plain');
  assert.equal(plain().prices.current,40);assert.equal(f.family('72','organic').familyReview.status,'blocked');
  f.clock.at=new Date(Date.parse(NOW)+49*3600000).toISOString();
  assert.equal(plain().prices.current,null,'an earlier API read cannot keep an expired source or native quote fresh');
  assert.equal(f.family('72','organic').familyReview.status,'blocked','stale prices within the source horizon do not erase explicit scoped research debt');
  f.ingest('72',{},f.clock.at);assert.equal(plain().prices.current,40,'a genuinely newer actual receipt restores the current shared quote');
  assert.equal(f.family('72','organic').familyReview.status,'blocked');
  f.clock.at=new Date(Date.parse(NOW)+186*86400000).toISOString();
  assert.equal(f.family('72','organic').familyReview,null,'a product older than the actual-price horizon creates no family review work');
  assert.equal(plain().prices.current,null);
  f.ingest('72',{},f.clock.at);assert.equal(f.family('72','organic').familyReview.status,'blocked');assert.equal(plain().prices.current,40);
  assert.equal(f.family('71','organic').sourceDecision.status,'excluded','expiry and unrelated receipt updates cannot erase a durable source-specific negative');
});

test('Oda draft and list alternatives share current scoped holds while independent chains remain available',()=>{
  const f=fixture(),view=()=>f.shop.familyView(),draft=()=>view().odaDraft.items.find(row=>row.watchId==='plain');
  assert.ok(draft());assert.ok(draft().others.some(row=>['sesum:KIWI:71','kassal:KIWI:71'].includes(row.productKey)&&row.unitPrice===40));
  f.shop.list({action:'add',watchId:'plain',storeName:'Oda',odaProductId:801,packAmount:.5,packs:1,unitPrice:100});
  f.scoped('71','excluded',{},'plain');f.scoped('72','excluded',{},'plain');
  let current=view();assert.equal(current.items.find(row=>row.id==='plain').prices.current,100,'the independent actually reviewed Oda quote survives KIWI-only source holds');
  for(const rows of [current.odaDraft.items.find(row=>row.watchId==='plain').others,current.list.open[0].others])assert.ok(rows.every(row=>!['sesum:KIWI:71','sesum:KIWI:72','kassal:KIWI:71','kassal:KIWI:72'].includes(row.productKey)),'neither the held source nor its documented same-chain alias can return through all-chain alternatives');
  assert.equal(f.family('71','organic').sourceDecision,null,'the negative is still scoped to the selected household family');
  f.scoped('71','reopen',{},'plain');current=view();assert.equal(current.items.find(row=>row.id==='plain').prices.current,40);assert.ok(current.odaDraft.items.find(row=>row.watchId==='plain').others.some(row=>['sesum:KIWI:71','kassal:KIWI:71'].includes(row.productKey)&&row.unitPrice===40),'a fresh explicit source decision is reflected by the very next draft read');
});
