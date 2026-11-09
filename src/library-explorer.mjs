// Read model for the family-facing product explorer. It only reads the compiled
// shopping index: nothing here approves a product, changes a price or touches a
// watch, a cart or the archive. Rows sharing a barcode become one card for display,
// while every chain post keeps its own pack, price and label facts.
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const compress=promisify(gzip);
export const EXPLORER_VERSION=1;
export const NUTRIENT_KEYS=['kcal','fat','carbs','sugars','fiber','protein','salt'];
const LABELS=[['organic',1],['lactoseFree',2],['glutenFree',4],['frozen',8]];
const LEVELS={low:0,medium:1,good:2};
const INGREDIENT_LIMIT=2000; // shoppingIndex keeps this many characters of a list.
const FRUIT={blueberry:'blåbær',blackcurrant:'solbær',apricot:'aprikos',orange:'appelsin',raspberry:'bringebær',strawberry:'jordbær'};
const low=value=>String(value??'').normalize('NFC').toLocaleLowerCase('nb-NO');
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;

// The library's categories grew batch by batch. Shelves are only a display
// grouping on top of them; the families and their rules stay as reviewed.
const SHELVES=[
 [/^frys|^is og/,'Frys og is',true],[/hus og|rengjøring/,'Hus og rengjøring',false],[/hygiene/,'Hygiene',false],[/baby/,'Baby og barn',false],[/kjæledyr/,'Kjæledyr',false],
 [/kjøtt|fisk|\begg\b/,'Kjøtt, fisk og egg',true],[/meieri/,'Meieri og ost',true],[/brød|bakst/,'Brød og bakst',true],[/frukt og grønt|grønnsak/,'Frukt og grønt',true],
 [/^mel\b|korn/,'Mel, korn og baking',true],[/ris og pasta/,'Ris og pasta',true],[/drikke/,'Drikke',true],[/nøtter/,'Nøtter og frø',true],[/krydder|olje|eddik/,'Krydder, oljer og basis',true],
 [/hermetikk|middag|ferdigmat/,'Middag og hermetikk',true],[/pålegg|frokost|kolonial|snacks/,'Pålegg, frokost og snacks',true]
];
export function shelfOf(category) {
 const text=low(category),hit=SHELVES.find(([re])=>re.test(text));
 return hit?{name:hit[1],food:hit[2]}:{name:String(category),food:true};
}

const barcode=value=>{const digits=String(value??'').trim();return /^\d{8,14}$/.test(digits)?digits.replace(/^0+/,''):null;};
const heldPrice=(quote,available)=>!available||quote.reasons.length>0;
function differs(a,b) {
 if(a==null||b==null)return false;
 return Math.abs(a-b)>Math.max(.5,.1*Math.max(a,b));
}
const qualityTitle=(key,q)=>{const part=key.split(':');return part[1]==='fruit-spread'&&FRUIT[part[2]]?`${q.criterion} (${FRUIT[part[2]]})`:q.criterion;};

/** Pure compilation; the same index and store list always give the same document. */
export function buildExplorerData(index,{imageRef,chainName,ownStores=[],active=()=>true,horizonDays=null}) {
 const shelves=[],shelfIndex=new Map(),families=[],familyIndex=new Map(),stores=[],storeIndex=new Map(),qualityKeys=[],qualityIndex=new Map(),links=new Map();
 const shelfId=category=>{const shelf=shelfOf(category);if(!shelfIndex.has(shelf.name)){shelfIndex.set(shelf.name,shelves.length);shelves.push(shelf);}return shelfIndex.get(shelf.name);};
 const storeId=code=>{if(!storeIndex.has(code)){storeIndex.set(code,stores.length);stores.push({code,name:chainName(code)});}return storeIndex.get(code);};
 for(const [id,group] of Object.entries(index.groups)){familyIndex.set(id,families.length);families.push({id,name:group.name,shelf:shelfId(group.category),unit:group.unit});}
 for(const [groupId,rows] of Object.entries(index.members))for(const row of rows){if(!links.has(row.k))links.set(row.k,[]);links.get(row.k).push({...row,family:familyIndex.get(groupId)});}
 const buckets=new Map();
 for(const [key,product] of Object.entries(index.products)){const code=barcode(product.ean),id=code?'e'+code:key;if(!buckets.has(id))buckets.set(id,[]);buckets.get(id).push([key,product]);}
 const items=[],texts=[];
 for(const [id,every] of buckets){
  // A parked chain post is not shown, but it can still veto a label or a figure.
  const rows=every.filter(([key])=>active(key));
  if(!rows.length)continue;
  const weight=([,p])=>(p.nutrition?2:0)+(p.image?1:0)+(p.ingredients?1:0);
  rows.sort((a,b)=>weight(b)-weight(a)||a[1].name.localeCompare(b[1].name,'nb')||(a[0]<b[0]?-1:1));
  const rep=rows[0][1],approved=new Set(),shelfSet=new Set(),scores=new Map(),seen=rows.map(([,p])=>p.nutrition).filter(n=>n?.per100);
  let level=null,labels=0;
  for(const [flag,bit] of LABELS)if(every.every(([,p])=>p.attributes?.[flag]===true))labels|=bit; // A held or conflicting post must not inherit a label from its siblings.
  const posts=rows.map(([key,p])=>{
   let unitPrice=null;
   for(const m of links.get(key)??[]){
    if(m.family===undefined||m.s==='excluded')continue;
    shelfSet.add(families[m.family].shelf);
    if(m.s==='approved'&&m.r){
     approved.add(m.family);
     if(unitPrice===null&&m.u!==null)unitPrice=[m.u,families[m.family].unit];
     if(m.q){
      if(!qualityIndex.has(m.q.key)){qualityIndex.set(m.q.key,qualityKeys.length);qualityKeys.push({key:m.q.key,label:m.q.label,criterion:qualityTitle(m.q.key,m.q),unit:m.q.unit,items:0});}
      const slot=qualityIndex.get(m.q.key),prior=scores.get(slot);
      if(!prior||m.q.score<prior[1])scores.set(slot,[slot,m.q.score,m.q.value]); // Posts disagreeing on a label are ranked on the lower documented figure.
     }
     if(m.n&&key===rows[0][0])level=LEVELS[m.n.level]??null;
    }
   }
   const q=p.quote,held=heldPrice(q,p.available);
   return [key,storeId(p.store),held?null:q.grossPackPrice,held||!unitPrice?null:unitPrice[0],unitPrice?.[1]??null,p.pack,p.unit,q.receiptAt?Math.round(Date.parse(q.receiptAt)/1000):null,(held?1:0)|(p.available?0:2)];
  });
  for(const [slot] of scores)qualityKeys[slot].items++;
  const conflict=every.some(([,p])=>p.nutrition?.fiberConflict),image=rep.image??every.find(([,p])=>p.image)?.[1].image;
  const facts=rep.nutrition?.per100?NUTRIENT_KEYS.map(k=>k==='fiber'&&conflict?null:number(rep.nutrition.per100[k])):null;
  const varies=seen.length>1&&NUTRIENT_KEYS.some(k=>seen.some((a,i)=>seen.slice(i+1).some(b=>differs(number(a.per100[k]),number(b.per100[k])))));
  const lists=rows.map(([,p])=>p.ingredients).filter(Boolean),complete=lists.length>0&&lists.every(t=>t.length<INGREDIENT_LIMIT);
  texts.push(low(lists.join(' | ')));
  items.push({id,n:rep.name,...(rep.brand?{b:rep.brand}:{}),...(barcode(rep.ean)?{e:rep.ean}:{}),...(image?{i:imageRef(image)}:{}),s:[...shelfSet],f:[...approved],...(labels?{a:labels}:{}),...(facts?{v:facts,g:rep.nutrition.basis==='ml'?1:0}:{}),...(varies?{d:1}:{}),...(level!==null?{l:level}:{}),...(scores.size?{q:[...scores.values()]}:{}),...(lists.length?{t:complete?1:2}:{}),p:posts});
 }
 const own=new Set(ownStores);
 for(const store of stores)store.own=own.has(store.code);
 return {data:{version:EXPLORER_VERSION,built:index.builtAt,nutrients:NUTRIENT_KEYS,freshHours:48,horizonDays,shelves,families,stores,qualityKeys,items},texts};
}

export function ingredientMatches(texts,term) {
 const needle=low(term).trim();
 if(needle.length<2||needle.length>60)throw Error('Skriv 2–60 tegn.');
 const items=[];
 texts.forEach((text,index)=>{if(text.includes(needle))items.push(index);});
 return {term:needle,items};
}

/** Members and review notes for one family, judged at the reader's own clock. */
export function familyDetail(read,id,{imageRef,chainName}) {
 const group=read.group(id);if(!group)return null;
 const readable=value=>value?value.replace(/\s*Kildens per100-verdier:\s*\{[^}]*\}?\.?/g,'').trim():null;
 const members=read.members(id).map(row=>{
  const p=row.product,price=row.price,held=price.reasons.some(code=>code!=='stale-price-receipt');
  const note=read.groupsOf(row.productKey).find(m=>m.groupId===id);
  return {key:row.productKey,status:row.status,reviewCurrent:row.reviewCurrent,name:p.name,brand:p.brand,store:chainName(p.store),image:imageRef(p.image),pack:p.pack,unit:p.unit,packPrice:held?null:price.grossPackPrice,unitPrice:row.eligible?row.unitPrice:null,fresh:price.fresh,receiptAt:price.receiptAt,quality:row.status==='approved'&&row.reviewCurrent?row.quality:null,nutritionLevel:row.nutrition?.level??null,value:read.valueDetail(row.productKey,id),note:row.status==='approved'?null:readable(note?.e)};
 });
 const counts=new Map();
 for(const m of members)if(m.quality)counts.set(m.quality.key,(counts.get(m.quality.key)??0)+1);
 const sharedKey=[...counts].filter(([,n])=>n>=2).sort((a,b)=>b[1]-a[1])[0]?.[0]??null;
 return {id,name:group.name,category:group.category,unit:group.unit,inclusion:group.inclusion,exclusions:group.exclusions,qualityBasis:group.qualityBasis,comparisonBasis:group.comparisonBasis,sharedKey,qualityNote:sharedKey?read.qualityNote(sharedKey):[],members};
}

export function createLibraryExplorer({reader,imageRef,chainName,ownStores=()=>[],status=()=>'disabled'}) {
 let cached=null,pending=null;
 async function compile(read,key) {
  const {data,texts}=buildExplorerData(read.index(),{imageRef,chainName,ownStores:ownStores(),active:read.active,horizonDays:read.horizonDays});
  const json=Buffer.from(JSON.stringify(data));
  const zipped=await compress(json);
  return {key,status:'ready',built:data.built,texts,json,gzip:zipped,etag:'"'+createHash('sha256').update(json).digest('hex').slice(0,32)+'"'};
 }
 async function bundle() {
  const read=reader();if(!read)return {status:status()};
  const key=read.builtAt+'|'+Math.floor(Date.now()/86400000)+'|'+[...new Set(ownStores())].sort().join(','); // Products pass the price horizon as days go by.
  if(cached?.key===key)return cached;
  if(pending?.key===key)return pending.work;
  const work=compile(read,key).then(done=>{cached=done;return done;}).finally(()=>{if(pending?.work===work)pending=null;});
  pending={key,work};
  return work;
 }
 return {
  bundle,
  async ingredients(term) {
   const ready=await bundle();
   if(ready.status!=='ready')return {status:ready.status,items:[]};
   return {status:'ready',built:ready.built,...ingredientMatches(ready.texts,String(term??''))};
  },
  family(id) {
   const read=reader();if(!read)return {status:status()};
   const family=familyDetail(read,String(id??''),{imageRef,chainName});
   if(!family)throw Error('Fant ikke varefamilien.');
   return {status:'ready',family};
  }
 };
}

/** Sends a prepared bundle with revalidation; repeat visits cost a 304 only. */
export function sendExplorerBundle(req,res,bundle) {
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-cache',ETag:bundle.etag,Vary:'Accept-Encoding','X-Content-Type-Options':'nosniff'};
 if(req.headers['if-none-match']===bundle.etag){res.writeHead(304,headers);res.end();return;}
 const zipped=/\bgzip\b/.test(req.headers['accept-encoding']??''),body=zipped?bundle.gzip:bundle.json;
 res.writeHead(200,{...headers,...(zipped?{'Content-Encoding':'gzip'}:{}),'Content-Length':body.length});
 res.end(body);
}
