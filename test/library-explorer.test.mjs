import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {buildExplorerData,createLibraryExplorer,familyDetail,ingredientMatches,sendExplorerBundle,shelfOf} from '../src/library-explorer.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {applyCampaigns,applyFollowed,axisDomain,emptyFilters,explore,familyGrid,familySummaries,featuredFamilies,sortFamilies,inRange,isPristine,prepareExplorer,priceView,proteinPerKrone,scatterPoints,sortItems,tokenScore} from '../public/library-explorer-core.mjs';

const NOW=Date.parse('2026-11-09T12:00:00Z'),FRESH='2026-11-09T08:00:00Z',OLD='2026-10-01T08:00:00Z',PARKED='2024-01-01T08:00:00Z';
const quote=(price,receiptAt=FRESH,reasons=[])=>({grossPackPrice:price,grossUnitPrice:null,unit:null,directUnitVerified:false,receiptAt,reasons,sourceUrl:'https://example.test/p'});
const product=(store,id,fields)=>({store,id,name:'Vare '+id,ean:null,brand:null,ingredients:null,description:null,packEvidence:'Etikett',pack:.5,packKnown:true,unit:'kg',rawPack:null,sourceUrl:'https://example.test/p',attributes:{organic:false,lactoseFree:false,glutenFree:false,frozen:false},available:true,nutrition:null,quote:quote(20),...fields});
const label=(fields,extra={})=>({basis:'g',per100:{kcal:100,fat:1,carbs:20,sugars:18,fiber:2,protein:1,salt:2,...fields},sourceUrl:'https://example.test/p',...extra});
const member=(k,s,fields={})=>({k,s,r:s==='approved',u:null,q:null,n:null,qs:'not-applicable',qr:null,e:null,qe:null,...fields});
const score=(value,key='ingredient-content-v10:ketchup:tomato-input-g-per-100g')=>({score:value,key,label:'Råvarekvalitet',criterion:'Tomater brukt per 100 g ketchup',value,unit:'g/100 g',evidence:null});
function index() {
 return {builtAt:'2026-11-09T11:00:00.000Z',groups:{
   ketchup:{name:'Ketchup',category:'Kolonial, pålegg og snacks',unit:'kg',inclusion:'Tomatketchup',exclusions:['Saus'],qualityBasis:'Tomat',comparisonBasis:'Per kg'},
   soap:{name:'Håndsåpe',category:'Hygiene',unit:'l',inclusion:'Såpe',exclusions:[],qualityBasis:'-',comparisonBasis:'Per l'}
  },members:{
   ketchup:[member('kassal:MENY_NO:1','approved',{u:40,q:score(70)}),member('kassal:SPAR_NO:2','approved',{u:50,q:score(60)}),member('kassal:KIWI:3','unknown'),member('kassal:COOP_NO:4','excluded',{e:'Annen saus. Kildens per100-verdier: {"kcal":1}'})],
   soap:[member('kassal:MENY_NO:9','approved',{u:30})]
  },products:{
   'kassal:MENY_NO:1':product('MENY_NO','1',{name:'Tomatketchup 500g',ean:'07038010000',brand:'Merke',ingredients:'Tomater, sukker, eddik',image:'https://img.test/a.png',attributes:{organic:true,lactoseFree:true,glutenFree:false,frozen:false},nutrition:label({protein:2}),quote:quote(20)}),
   'kassal:SPAR_NO:2':product('SPAR_NO','2',{name:'Tomatketchup',ean:'7038010000',brand:'Merke',ingredients:'Tomater, sukker',attributes:{organic:true,lactoseFree:false,glutenFree:false,frozen:false},nutrition:label({protein:9,fiber:12},{fiberConflict:true}),pack:.45,quote:quote(25,OLD)}),
   'kassal:KIWI:3':product('KIWI','3',{name:'Sennep',ingredients:null,quote:quote(null,FRESH,['unknown-gross-package-price'])}),
   'kassal:COOP_NO:4':product('COOP_NO','4',{name:'Peanøttsaus',ingredients:'x'.repeat(2000),quote:quote(12)}),
   'kassal:MENY_NO:9':product('MENY_NO','9',{name:'Såpe',unit:'l',pack:.3,nutrition:null})
  },qualityNotes:{}};
}
const options={imageRef:url=>url?'img'+url.length:null,chainName:code=>({MENY_NO:'MENY',SPAR_NO:'SPAR',KIWI:'KIWI',COOP_NO:'Coop'})[code]??code,ownStores:['MENY_NO']};
const compile=()=>{const built=buildExplorerData(index(),options);return {...built,model:prepareExplorer(built.data)};};
const byName=(model,name)=>model.items.find(i=>i.name===name);
const storeNo=(model,name)=>model.stores.findIndex(s=>s.name===name);

test('rows sharing a barcode become one card while each chain keeps its own facts',()=>{
 const {model}=compile(),item=model.byId.get('e7038010000');
 assert.equal(item.posts.length,2);
 assert.deepEqual(item.posts.map(p=>p.pack).sort(),[.45,.5]);
 assert.equal(item.packMixed,true,'different packs are never presented as one pack');
 assert.equal(item.pack,null);
 assert.equal(item.labels,1,'only a label every chain documents reaches the card');
 assert.equal(model.items.length,4);
});

test('a conflicting fibre label is withheld and unit prices need a current approved review',()=>{
 const {model}=compile(),item=model.byId.get('e7038010000'),soap=byName(model,'Såpe');
 assert.equal(item.nutrition.fiber,null);
 assert.equal(item.nutrition.protein,2);
 assert.equal(item.varies,true);
 assert.equal(soap.posts[0].unitPrice,30);
 const unknown=byName(model,'Sennep');
 assert.equal(unknown.posts[0].unitPrice,null);
 assert.equal(unknown.posts[0].packPrice,null,'a price with open reasons is held back');
 assert.equal(unknown.posts[0].held,true);
 assert.deepEqual(byName(model,'Peanøttsaus').shelves,[],'an excluded family gives no shelf');
});

test('the card price is the cheapest fresh one and an old receipt never counts as fresh',()=>{
 const {model}=compile(),item=model.byId.get('e7038010000'),meny=storeNo(model,'MENY'),spar=storeNo(model,'SPAR');
 const all=priceView(item,null,NOW,model.freshMs);
 assert.equal(all.packPrice,20);assert.equal(all.fresh,true);assert.equal(all.freshChains,1);assert.equal(all.chains,2);
 const old=priceView(item,new Set([spar]),NOW,model.freshMs);
 assert.equal(old.packPrice,25);assert.equal(old.fresh,false);
 const none=priceView(item,new Set([storeNo(model,'KIWI')]),NOW,model.freshMs);
 assert.equal(none.chains,0);assert.equal(none.packPrice,null);
 assert.equal(priceView(item,new Set([meny]),NOW+3*86400000,model.freshMs).fresh,false,'freshness is judged at use');
});

test('unknown values never satisfy a limit and never count as zero',()=>{
 assert.equal(inRange(null,{min:null,max:5}),false);
 assert.equal(inRange(0,{min:null,max:5}),true);
 const {model}=compile(),f=emptyFilters();
 f.ranges.fiber={min:null,max:50};
 const found=explore(model,f,NOW);
 assert.deepEqual(found.items.map(i=>i.name),[],'the only product with a fibre figure is the conflicting one');
 assert.ok(found.missing.fiber>=3,'hidden unknowns are counted so the page can say so');
 const points=scatterPoints(explore(model,emptyFilters(),NOW),'protein','sugars');
 assert.equal(points.points.length,1);assert.equal(points.missing,2);
});

test('facet counts ignore their own selection, and non-food stays out unless asked for',()=>{
 const {model}=compile(),f=emptyFilters();
 assert.equal(isPristine(f),true);
 assert.equal(explore(model,f,NOW).items.some(i=>i.name==='Såpe'),false);
 f.food=false;
 assert.equal(explore(model,f,NOW).items.some(i=>i.name==='Såpe'),true);
 f.food=true;f.stores=[storeNo(model,'KIWI')];
 const found=explore(model,f,NOW);
 assert.deepEqual(found.items.map(i=>i.name),['Sennep']);
 assert.equal(found.facets.stores[storeNo(model,'MENY')],1,'other chains still show what selecting them would give');
});

test('a quality score ranks only inside one measurement basis, and unit prices stay within a unit',()=>{
 const {model}=compile();
 assert.deepEqual(model.byId.get('e7038010000').quality.map(q=>q.score),[60],'disagreeing chains rank on the lower figure');
 const f=emptyFilters();f.food=false;
 const result=explore(model,f,NOW),chains=sortItems(result,'chains',null),fallback=sortItems(result,'quality',null);
 assert.deepEqual(fallback.map(i=>i.id),chains.map(i=>i.id),'without a chosen basis there is no score order');
 f.qualityKey=0;
 assert.deepEqual(explore(model,f,NOW).items.map(i=>i.id),['e7038010000']);
 const units=sortItems(result,'unit',null).filter(i=>result.views[i.index].unitPrice!==null).map(i=>result.views[i.index].unit);
 assert.deepEqual(units,['kg','l'],'kroner per kilo is listed apart from kroner per litre');
});

test('protein per krone needs a fresh kilo price and a gram label',()=>{
 const item={basis:'g',nutrition:{protein:20}};
 assert.equal(proteinPerKrone(item,{fresh:true,unit:'kg',unitPrice:100}),2);
 assert.equal(proteinPerKrone(item,{fresh:false,unit:'kg',unitPrice:100}),null);
 assert.equal(proteinPerKrone(item,{fresh:true,unit:'stk',unitPrice:100}),null);
 assert.equal(proteinPerKrone({basis:'ml',nutrition:{protein:20}},{fresh:true,unit:'kg',unitPrice:100}),null);
});

test('without an ingredient means a known complete list that lacks the word',()=>{
 const {data,texts,model}=compile();
 assert.throws(()=>ingredientMatches(texts,'x'),/2–60/);
 const hits=ingredientMatches(texts,'TOMATER');
 assert.equal(hits.term,'tomater');
 model.ingredientHits.set('tomater',new Set(hits.items));
 const f=emptyFilters();f.exclude=['tomater'];
 const found=explore(model,f,NOW);
 assert.deepEqual(found.items.map(i=>i.name),[],'no ingredient list and a cut-off list are unknown, not without');
 assert.equal(data.items.find(i=>i.n==='Peanøttsaus').t,2);
 const g=emptyFilters();g.include=['tomater'];
 assert.deepEqual(explore(model,g,NOW).items.map(i=>i.id),['e7038010000']);
});

test('search prefers whole words and compound tails over stray letters',()=>{
 assert.equal(tokenScore('ketchup',"ketchup"),5);
 assert.ok(tokenScore('tomatketchup','ketchup')>tokenScore('ketchupflaske','ost'));
 assert.equal(tokenScore('pesto','ost'),0);
 const {model}=compile(),f=emptyFilters();f.q='ketchup';
 assert.deepEqual(sortItems(explore(model,f,NOW),'auto',null).map(i=>i.id),['e7038010000']);
 f.q='7038010000';
 assert.equal(explore(model,f,NOW).items.length,1);
});

test('family summaries and map scales keep their own limits',()=>{
 const {model}=compile(),f=emptyFilters(),rows=familySummaries(model,explore(model,f,NOW));
 assert.equal(rows.length,1);
 assert.equal(rows[0].family.name,'Ketchup');assert.equal(rows[0].min,40);assert.equal(rows[0].spread,null);
 assert.deepEqual(axisDomain([1,2,3],{min:2,max:9},10),[2,9]);
 assert.equal(shelfOf('Frys: frukt og grønt').name,'Frys og is');
 assert.equal(shelfOf('Hygiene').food,false);
 assert.equal(shelfOf('Kolonial, pålegg og snacks').name,'Pålegg, frokost og snacks','the word egg must not match inside pålegg');
 assert.equal(shelfOf('Kjøtt, fisk og egg').name,'Kjøtt, fisk og egg');
 assert.equal(shelfOf('Noe helt nytt').name,'Noe helt nytt');
});

test('families show their reach across brands and stores, and name where the cheapest is',()=>{
 const {model}=compile(),result=explore(model,emptyFilters(),NOW),[row]=familySummaries(model,result);
 assert.equal(row.brands,1);assert.equal(row.chains,2);
 assert.equal(row.offers[0].store,storeNo(model,'MENY'));
 const scoped={...emptyFilters(),stores:[storeNo(model,'MENY')]},[only]=familySummaries(model,explore(model,scoped,NOW));
 assert.equal(only.chains,1,'the reach follows the chosen stores');
});

test('family order rewards real cross-brand comparison and search finds the named family first',()=>{
 const family=(name,brands,chains,prices,shelf=0)=>({family:{name,shelf},brands,chains,count:prices.length,offers:prices.map(price=>({price})),spread:prices.length>1?prices.at(-1)/prices[0]:null});
 const wide=family('Havregryn',4,5,[10,12,30]),narrow=family('Ketchup med chili',1,9,[20,30]),lone=family('Ketchup',8,8,[]);
 assert.deepEqual(sortFamilies([narrow,lone,wide],'breadth').map(r=>r.family.name),['Havregryn','Ketchup med chili','Ketchup'],'no fresh comparison means no reach');
 assert.deepEqual(sortFamilies([narrow,wide,lone],'breadth',['ketchup']).map(r=>r.family.name),['Ketchup med chili','Ketchup','Havregryn']);
 const same=family('Annen',3,3,[1,1.5,2,9],1),small=family('Liten',2,2,[1,2,3,50],2),other=family('Hvete',3,3,[2,3,4,8],1);
 assert.deepEqual(featuredFamilies([small,other,same]).map(r=>r.family.name),['Annen'],'one per shelf, and only broad comparisons');
});

test('the price grid has one row per product, and an old price can never be the cheapest',()=>{
 const item={id:'e1',name:'Ketchup',pack:.5,packUnit:'kg'},other={id:'e2',name:'Billig',pack:1,packUnit:'kg'};
 const byPost=new Map([['a',item],['b',item],['c',other],['d',other]]);
 const m=(key,store,unitPrice,fresh,oldUnitPrice=null,quality=null)=>({key,store,brand:'B',image:null,pack:1,unit:'kg',fresh,unitPrice,oldUnitPrice,quality,receiptAt:FRESH});
 const members=[m('a','MENY',40,true),m('b','SPAR',50,true),m('c','MENY',30,true,null,{key:'k',score:60}),m('d','Coop',null,false,5,{key:'k',score:70})];
 const grid=familyGrid(members,byPost,{qualityKey:'k'});
 assert.deepEqual(grid.rows.map(r=>r.id),['e2','e1']);
 assert.equal(grid.top,30,'the old 5 kr price is shown but does not win');
 assert.equal(grid.rows[0].cells.get('Coop').price,null);assert.equal(grid.rows[0].cells.get('Coop').old,5);
 assert.equal(grid.columns.find(c=>c.store==='MENY').wins,1,'a win needs another fresh price to beat');
 assert.equal(grid.columns.find(c=>c.store==='Coop').wins,0);
 assert.equal(grid.rows[0].score,60,'a product with disagreeing labels ranks on the lower figure');
 assert.deepEqual(familyGrid(members,byPost,{order:'SPAR'}).rows.map(r=>r.id),['e1','e2'],'sorting on a store keeps products it lacks last');
 assert.deepEqual(familyGrid(members,byPost,{order:'quality',qualityKey:'k'}).rows.map(r=>r.id),['e2','e1']);
});

test('a flyer offer brings a parked chain back inside the families it belongs to',()=>{
 const {model}=compile();
 const campaign={id:'o1',name:'Ketchup på tilbud',storeName:'REMA 1000',price:10,packAmount:.5,unit:'kg',unitPrice:20,validTo:'2026-11-15',memberOnly:false,groups:['ketchup']};
 applyCampaigns(model,[campaign,{...campaign,id:'o2',unit:'l',groups:['ketchup']},{...campaign,id:'o3',groups:['finnes-ikke']}]);
 const rema=storeNo(model,'REMA 1000');
 assert.ok(rema>=0,'the chain is selectable although the library has nothing fresh from it');
 const [row]=familySummaries(model,explore(model,emptyFilters(),NOW));
 assert.equal(row.campaigns.length,1,'an offer in another unit never joins the family');
 assert.equal(row.offers[0].campaign.id,'o1');assert.equal(row.min,20);assert.equal(row.regularMin,40);assert.equal(row.chains,3);
 assert.equal(isPristine({...emptyFilters(),offersOnly:true}),false);
 const onlyRema=explore(model,{...emptyFilters(),stores:[rema]},NOW);
 assert.equal(onlyRema.items.length,0,'single products from a parked chain stay hidden');
 assert.deepEqual(familySummaries(model,onlyRema).map(r=>r.family.name),['Ketchup'],'but the family with the offer shows');
 const labelled=explore(model,{...emptyFilters(),stores:[rema],labels:[2]},NOW);
 assert.deepEqual(familySummaries(model,labelled),[],'an offer cannot vouch for a label');
 const missed=explore(model,{...emptyFilters(),q:'havregryn'},NOW);
 assert.deepEqual(familySummaries(model,missed),[]);
 const grid=familyGrid([{key:'kassal:MENY_NO:1',store:'MENY',brand:'Merke',image:null,pack:.5,unit:'kg',fresh:true,unitPrice:40,oldUnitPrice:null,quality:null,receiptAt:FRESH}],model.byPost,{campaigns:[{...campaign}]});
 assert.equal(grid.top,20);assert.equal(grid.rows[0].id,'offer:o1');
 assert.equal(grid.columns.find(c=>c.store==='REMA 1000').wins,0);
});

test('a followed family carries household numbers, merges its variants and can repeat safely',()=>{
 const built=buildExplorerData(index(),options),model=prepareExplorer(built.data),ketchup=model.families.find(f=>f.id==='ketchup'),soap=model.families.find(f=>f.id==='soap');
 const stock={known:true,amount:2,months:3},prices={good:30,excellent:20,normal:40,current:25,currentChain:'MENY'};
 const followed=[{id:'merged',name:'Saus og såpe',unit:'kg',kind:'library',groups:['ketchup','soap'],members:[],stock,annualAmount:12,prices},{id:'one',name:'Min egen',unit:'kg',kind:'own',groups:[],members:['kassal:KIWI:3'],stock:{known:false},annualAmount:null,prices}];
 for(let run=0;run<2;run++){
  applyFollowed(model,followed);
  const merged=model.families.find(f=>f.id==='followed:merged'),own=model.families.find(f=>f.id==='followed:one');
  assert.equal(model.families.length,4,'repeating adds nothing');
  assert.equal(ketchup.mergedInto,merged.index);assert.equal(soap.mergedInto,merged.index);
  assert.deepEqual(merged.variants,['Ketchup','Håndsåpe']);
  assert.equal(byName(model,'Såpe').families.includes(soap.index),false,'one card, not one per variant');
  assert.equal(byName(model,'Såpe').families.includes(merged.index),true);
  assert.deepEqual(own.items.map(i=>i.name),['Sennep']);
  assert.equal(byName(model,'Sennep').familyLow.includes('min egen'),true);
 }
 applyCampaigns(model,[{id:'o',name:'Tilbud',storeName:'MENY',price:5,packAmount:.5,unit:'kg',unitPrice:10,validTo:'2026-11-15',groups:['ketchup','soap']}]);
 const merged=model.families.find(f=>f.id==='followed:merged');
 assert.equal(model.campaignsByFamily.get(merged.index).length,1,'an offer on two variants counts once');
 const food=emptyFilters();food.food=false;
 const rows=familySummaries(model,explore(model,food,NOW));
 assert.equal(rows.find(r=>r.family===merged).followed.annualAmount,12);
 assert.equal(rows.some(r=>r.family===ketchup),false);
 assert.equal(isPristine({...emptyFilters(),followedOnly:true}),false);
 const only=familySummaries(model,explore(model,{...food,followedOnly:true},NOW));
 assert.equal(only.every(r=>r.followed),true);assert.equal(only.length,2);
 assert.equal(familySummaries(model,explore(model,{...emptyFilters(),followedOnly:true},NOW)).length,2,'what the family follows is shown even when it is not food');
 applyFollowed(model,[]);
 assert.equal(model.families.length,2);assert.equal(ketchup.mergedInto,null);assert.equal(byName(model,'Såpe').families.includes(soap.index),true);
});

test('family detail keeps reasons for held-out products and reads without changing the index',()=>{
 const source=index(),before=structuredClone(source),read=createIndexReader(source)(NOW);
 const detail=familyDetail(read,'ketchup',options);
 assert.deepEqual(source,before);
 const excluded=detail.members.find(m=>m.status==='excluded');
 assert.equal(excluded.note,'Annen saus.');
 assert.equal(excluded.unitPrice,null);
 assert.equal(detail.sharedKey,'ingredient-content-v10:ketchup:tomato-input-g-per-100g');
 const old=detail.members.find(m=>m.key==='kassal:SPAR_NO:2');
 assert.equal(old.fresh,false);assert.equal(old.unitPrice,null);assert.equal(old.packPrice,25);assert.equal(old.oldUnitPrice,50);
 assert.equal(detail.members.find(m=>m.key==='kassal:MENY_NO:1').oldUnitPrice,null);
 assert.equal(familyDetail(read,'__proto__',options),null);
});

test('the bundle is compressed once, revalidates and reports a missing library',async()=>{
 const unavailable=createLibraryExplorer({reader:()=>null,imageRef:options.imageRef,chainName:options.chainName,status:()=>'building'});
 assert.deepEqual(await unavailable.bundle(),{status:'building'});
 const read=createIndexReader(index())(NOW);
 let calls=0;
 const explorer=createLibraryExplorer({reader:()=>{calls++;return read;},imageRef:options.imageRef,chainName:options.chainName,ownStores:()=>['MENY_NO']});
 const [one,two]=await Promise.all([explorer.bundle(),explorer.bundle()]);
 assert.equal(one,two);assert.equal(calls,2);
 const data=JSON.parse(gunzipSync(one.gzip));
 assert.equal(data.items.length,4);
 assert.equal(data.stores.find(s=>s.name==='MENY').own,true);
 const respond=headers=>{const out={};sendExplorerBundle({headers},{writeHead(status,h){out.status=status;out.headers=h;},end(body){out.body=body;}},one);return out;};
 assert.equal(respond({'accept-encoding':'gzip, br'}).headers['Content-Encoding'],'gzip');
 assert.equal(respond({}).headers['Content-Encoding'],undefined);
 const cached=respond({'if-none-match':one.etag});
 assert.equal(cached.status,304);assert.equal(cached.body,undefined);
 assert.deepEqual((await explorer.ingredients('eddik')).items.length,1);
 assert.throws(()=>explorer.family('finnes-ikke'),/Fant ikke/);
});

test('products without a price inside the horizon leave the listings but stay known',()=>{
 const source=index();
 Object.assign(source.products['kassal:SPAR_NO:2'],{quote:quote(25,PARKED)});
 Object.assign(source.products['kassal:COOP_NO:4'],{quote:quote(12,PARKED)});
 source.products['kassal:MENY_NO:1'].attributes.organic=true;
 source.products['kassal:SPAR_NO:2'].attributes.organic=false;
 const read=createIndexReader(source)(NOW);
 assert.equal(read.active('kassal:MENY_NO:1'),true);assert.equal(read.active('kassal:SPAR_NO:2'),false);assert.equal(read.active('finnes-ikke'),false);
 assert.deepEqual(read.members('ketchup').map(m=>m.productKey),['kassal:MENY_NO:1','kassal:KIWI:3']);
 assert.equal(read.members('ketchup',{all:true}).length,4);
 assert.equal(read.quote('kassal:SPAR_NO:2').product.name,'Tomatketchup','scans, orders and prices still find it');
 assert.equal(familyDetail(read,'ketchup',options).members.length,2);
 const {data}=buildExplorerData(source,{...options,active:read.active,horizonDays:183});
 assert.equal(data.horizonDays,183);
 assert.equal(data.stores.some(s=>s.name==='SPAR'||s.name==='Coop'),false,'a chain with only old prices is gone');
 const card=data.items.find(i=>i.id==='e7038010000');
 assert.equal(card.p.length,1);
 assert.equal(card.a,undefined,'a parked post can still veto a label');
 assert.equal(card.v[data.nutrients.indexOf('fiber')],null,'and a conflicting figure');
 assert.equal(data.items.some(i=>i.n==='Peanøttsaus'),false);
 source.products['kassal:SPAR_NO:2'].quote=quote(25,FRESH);
 assert.equal(createIndexReader(source)(NOW).active('kassal:SPAR_NO:2'),true,'a newer receipt brings it back');
 assert.equal(createIndexReader(source,{horizonDays:10})(NOW).active('kassal:MENY_NO:1'),true);
 const shortHorizon=index();shortHorizon.products['kassal:MENY_NO:1'].quote=quote(20,OLD);
 assert.equal(createIndexReader(shortHorizon,{horizonDays:10})(NOW).active('kassal:MENY_NO:1'),false,'the horizon is configurable');
});

test('both apps serve every explorer file',()=>{
 const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8'),phone=readFileSync(new URL('../src/phone-server.mjs',import.meta.url),'utf8');
 for(const file of ['library-explorer.mjs','library-explorer-core.mjs','library-explorer.css']){
  assert.ok(server.includes(`PUBLIC_FILES.set('${file}'`),file);
  assert.ok(phone.includes(`assets['/send/${file}']`),file);
 }
});
