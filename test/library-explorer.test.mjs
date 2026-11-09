import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {buildExplorerData,createLibraryExplorer,familyDetail,ingredientMatches,sendExplorerBundle,shelfOf} from '../src/library-explorer.mjs';
import {createIndexReader} from '../src/shopping-library.mjs';
import {axisDomain,emptyFilters,explore,familySummaries,inRange,isPristine,prepareExplorer,priceView,proteinPerKrone,scatterPoints,sortItems,tokenScore} from '../public/library-explorer-core.mjs';

const NOW=Date.parse('2026-11-09T12:00:00Z'),FRESH='2026-11-09T08:00:00Z',OLD='2024-01-01T08:00:00Z';
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

test('family detail keeps reasons for held-out products and reads without changing the index',()=>{
 const source=index(),before=structuredClone(source),read=createIndexReader(source)(NOW);
 const detail=familyDetail(read,'ketchup',options);
 assert.deepEqual(source,before);
 const excluded=detail.members.find(m=>m.status==='excluded');
 assert.equal(excluded.note,'Annen saus.');
 assert.equal(excluded.unitPrice,null);
 assert.equal(detail.sharedKey,'ingredient-content-v10:ketchup:tomato-input-g-per-100g');
 const old=detail.members.find(m=>m.key==='kassal:SPAR_NO:2');
 assert.equal(old.fresh,false);assert.equal(old.unitPrice,null);assert.equal(old.packPrice,25);
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

test('both apps serve every explorer file',()=>{
 const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8'),phone=readFileSync(new URL('../src/phone-server.mjs',import.meta.url),'utf8');
 for(const file of ['library-explorer.mjs','library-explorer-core.mjs','library-explorer.css']){
  assert.ok(server.includes(`PUBLIC_FILES.set('${file}'`),file);
  assert.ok(phone.includes(`assets['/send/${file}']`),file);
 }
});
