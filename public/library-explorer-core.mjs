// Filtering, facets and ranking for the product explorer. No DOM, so the rules
// can be tested directly. Unknown is never treated as zero or as a pass.
export const NUTRIENTS=[
  {key:'protein',label:'Protein',unit:'g'},
  {key:'fat',label:'Fett',unit:'g'},
  {key:'carbs',label:'Karbohydrater',unit:'g'},
  {key:'sugars',label:'Sukkerarter',unit:'g'},
  {key:'fiber',label:'Kostfiber',unit:'g'},
  {key:'salt',label:'Salt',unit:'g'},
  {key:'kcal',label:'Energi',unit:'kcal'}
];
export const PRICE_AXIS={key:'price',label:'Pris',unit:'kr/kg'};
export const LABELS=[['organic',1,'Økologisk'],['lactoseFree',2,'Laktosefri'],['glutenFree',4,'Glutenfri'],['frozen',8,'Frysevare']];
export const STATUSES=[['fresh','Fersk pris'],['image','Med bilde'],['nutrition','Med næringstall'],['quality','Med råvarescore']];
const BINS=24,UNIT_ORDER=['kg','l','stk','m'];

const low=value=>String(value??'').normalize('NFC').toLocaleLowerCase('nb-NO');
const wordChar=ch=>ch!==undefined&&/[\p{L}\p{N}]/u.test(ch);
export function emptyFilters() {
  return {q:'',shelves:[],food:true,stores:[],labels:[],status:[],hideGone:true,ranges:{},include:[],exclude:[],qualityKey:null};
}
export const isPristine=f=>!f.q.trim()&&!f.shelves.length&&f.food&&!f.stores.length&&!f.labels.length&&!f.status.length&&f.hideGone&&!Object.keys(f.ranges).length&&!f.include.length&&!f.exclude.length&&!f.qualityKey;

// A compound ends in what it is, so "ketchup" should find tomatketchup before
// it finds a word that merely contains the letters.
export function tokenScore(text,token) {
  let at=text.indexOf(token),best=0;
  while(at!==-1&&best<5){
    const start=!wordChar(text[at-1]),end=!wordChar(text[at+token.length]),score=start&&end?5:end?4:start?3:2;
    if(score>best)best=score;
    at=text.indexOf(token,at+1);
  }
  return best;
}
export function searchTerms(query) {return low(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);}
function nice(value) {
  if(!(value>0))return 1;
  const power=10**Math.floor(Math.log10(value)),scaled=value/power,step=[1,1.5,2,2.5,3,4,5,6,8,10].find(x=>scaled<=x);
  return step*power;
}
function percentile(values,p) {
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
}

export function prepareExplorer(data) {
  const keys=data.nutrients;
  const model={built:data.built,freshMs:data.freshHours*3600000,horizonDays:data.horizonDays??null,shelves:data.shelves,families:data.families.map((f,i)=>({...f,index:i,items:[]})),stores:data.stores,qualityKeys:data.qualityKeys,items:[],byId:new Map(),byPost:new Map(),ingredientHits:new Map(),domains:{}};
  data.items.forEach((row,index)=>{
    const nutrition=row.v?Object.fromEntries(keys.map((key,i)=>[key,row.v[i]])):null;
    const posts=row.p.map(p=>({key:p[0],store:p[1],packPrice:p[2],unitPrice:p[3],priceUnit:p[4],pack:p[5],unit:p[6],at:p[7]===null?null:p[7]*1000,held:!!(p[8]&1),gone:!!(p[8]&2)}));
    const item={index,id:row.id,name:row.n,brand:row.b??null,ean:row.e??null,image:row.i??null,shelves:row.s,families:row.f,labels:row.a??0,nutrition,basis:nutrition?(row.g?'ml':'g'):null,varies:!!row.d,level:row.l??null,quality:row.q?row.q.map(([key,score,value])=>({key,score,value})):[],ingredients:row.t??0,posts};
    item.nameLow=low(item.name);item.brandLow=low(item.brand);item.familyLow=low(item.families.map(f=>model.families[f].name).join(' '));
    item.gone=posts.every(p=>p.gone);
    const known=[...new Set(posts.filter(p=>p.pack).map(p=>p.pack+'|'+p.unit))];
    item.packMixed=known.length>1;
    const first=posts.find(p=>p.pack);item.pack=!item.packMixed&&first?first.pack:null;item.packUnit=!item.packMixed&&first?first.unit:null;
    model.items.push(item);model.byId.set(item.id,item);
    for(const post of posts)model.byPost.set(post.key,item);
    for(const family of item.families)model.families[family].items.push(item);
  });
  for(const {key} of NUTRIENTS){
    const values=model.items.map(i=>i.nutrition?.[key]).filter(v=>typeof v==='number');
    model.domains[key]=nice(percentile(values,.99));
  }
  const prices=model.items.flatMap(i=>i.posts).filter(p=>p.unitPrice!==null&&p.priceUnit==='kg').map(p=>p.unitPrice);
  model.domains.price=nice(percentile(prices,.97));
  return model;
}

export const isFresh=(at,now,freshMs)=>at!==null&&now-at>=0&&now-at<=freshMs;

/** The price a card may show: cheapest fresh in the chosen chains, else the newest old one. */
export function priceView(item,storeSet,now,freshMs) {
  let packPrice=null,unitPrice=null,unit=null,store=null,fresh=false,at=null,stale=null,chains=0,freshChains=0;
  for(const post of item.posts){
    if(storeSet&&!storeSet.has(post.store))continue;
    chains++;
    const priced=post.packPrice!==null||post.unitPrice!==null;
    if(!priced)continue;
    if(isFresh(post.at,now,freshMs)){
      freshChains++;fresh=true;
      if(post.packPrice!==null&&(packPrice===null||post.packPrice<packPrice)){packPrice=post.packPrice;at=post.at;store=post.store;}
      if(post.unitPrice!==null&&(unitPrice===null||post.unitPrice<unitPrice)){unitPrice=post.unitPrice;unit=post.priceUnit;if(packPrice===null){at=post.at;store=post.store;}}
    }else if(!stale||(post.at??0)>(stale.at??0))stale=post;
  }
  if(!fresh&&stale)return {packPrice:stale.packPrice,unitPrice:stale.unitPrice,unit:stale.priceUnit,store:stale.store,fresh:false,at:stale.at,chains,freshChains};
  return {packPrice,unitPrice,unit,store,fresh,at,chains,freshChains};
}

export function axisValue(item,key,view) {
  if(key==='price')return view.fresh&&view.unit==='kg'?view.unitPrice:null;
  const value=item.nutrition?.[key];
  return typeof value==='number'?value:null;
}
export function inRange(value,range) {
  if(value===null||value===undefined)return false; // Unknown never satisfies a limit.
  return (range.min===null||value>=range.min)&&(range.max===null||value<=range.max);
}

/** Runs every filter once. A facet's counts ignore that facet's own selection. */
export function explore(model,f,now=Date.now()) {
  const storeSet=f.stores.length?new Set(f.stores):null,shelfSet=f.shelves.length?new Set(f.shelves):null,terms=searchTerms(f.q);
  const views=new Array(model.items.length),scores=new Float64Array(model.items.length);
  for(const item of model.items)views[item.index]=priceView(item,storeSet,now,model.freshMs);
  const dims=[];
  if(terms.length)dims.push(['q',item=>{
    let total=0;
    for(const term of terms){
      if(/^\d{6,}$/.test(term)&&item.ean?.includes(term)){total+=12;continue;}
      const score=Math.max(tokenScore(item.nameLow,term)*2,tokenScore(item.brandLow,term)*1.5,tokenScore(item.familyLow,term));
      if(!score)return false;
      total+=score;
    }
    scores[item.index]=total;return true;
  }]);
  if(f.food)dims.push(['food',item=>!item.shelves.length||item.shelves.some(s=>model.shelves[s].food)]);
  if(f.hideGone)dims.push(['gone',item=>!item.gone]);
  if(shelfSet)dims.push(['shelves',item=>item.shelves.some(s=>shelfSet.has(s))]);
  if(storeSet)dims.push(['stores',item=>views[item.index].chains>0]);
  if(f.labels.length){const mask=f.labels.reduce((sum,bit)=>sum|bit,0);dims.push(['labels',item=>(item.labels&mask)===mask]);}
  for(const status of f.status)dims.push(['status:'+status,statusTest(status,views)]);
  for(const [key,range] of Object.entries(f.ranges))dims.push(['range:'+key,item=>inRange(axisValue(item,key,views[item.index]),range)]);
  for(const term of f.include){const hits=model.ingredientHits.get(term);if(hits)dims.push(['in:'+term,item=>hits.has(item.index)]);}
  for(const term of f.exclude){const hits=model.ingredientHits.get(term);if(hits)dims.push(['out:'+term,item=>item.ingredients===1&&!hits.has(item.index)]);}
  if(f.qualityKey!==null)dims.push(['quality',item=>item.quality.some(q=>q.key===f.qualityKey)]);

  const facets={shelves:new Int32Array(model.shelves.length),stores:new Int32Array(model.stores.length),labels:{},status:{}};
  const hist={},missing={};
  for(const axis of [...NUTRIENTS,PRICE_AXIS]){hist[axis.key]=new Int32Array(BINS);missing[axis.key]=0;}
  const countInto=(item,only)=>{
    const view=views[item.index],all=only===null;
    if(all||only==='shelves')for(const s of item.shelves)facets.shelves[s]++;
    if(all||only==='stores')for(const post of item.posts)facets.stores[post.store]++;
    if(all||only==='labels')for(const [,bit] of LABELS)if(item.labels&bit)facets.labels[bit]=(facets.labels[bit]??0)+1;
    for(const [status] of STATUSES)if((all||only==='status:'+status)&&statusTest(status,views)(item))facets.status[status]=(facets.status[status]??0)+1;
    for(const axis of [...NUTRIENTS,PRICE_AXIS]){
      if(!all&&only!=='range:'+axis.key)continue;
      const value=axisValue(item,axis.key,view);
      if(value===null){missing[axis.key]++;continue;}
      hist[axis.key][Math.min(BINS-1,Math.floor(value/model.domains[axis.key]*BINS))]++;
    }
  };
  const items=[];
  for(const item of model.items){
    let failed=null,failures=0;
    for(const [id,test] of dims){if(test(item))continue;failures++;failed=id;if(failures>1)break;}
    if(failures>1)continue;
    if(failures===0){items.push(item);countInto(item,null);}
    else countInto(item,failed);
  }
  return {items,views,scores,facets,hist,missing,bins:BINS,hasQuery:terms.length>0};
}
function statusTest(status,views) {
  if(status==='fresh')return item=>views[item.index].fresh;
  if(status==='image')return item=>!!item.image;
  if(status==='nutrition')return item=>!!item.nutrition;
  return item=>item.quality.length>0;
}

export const SORTS=[
  ['auto','Mest relevant'],['chains','Flest kjeder'],['name','A–Å'],['unit','Lavest kilopris'],['pack','Lavest pakkepris'],
  ['protein','Mest protein'],['proteinValue','Mest protein per krone'],['fiber','Mest fiber'],['sugars','Minst sukker'],['salt','Minst salt'],['kcal','Færrest kalorier'],['quality','Høyest råvarescore']
];
/** Grams of protein for one krone, only from a fresh kilo price and a gram label. */
export function proteinPerKrone(item,view) {
  if(!view.fresh||view.unit!=='kg'||!view.unitPrice||item.basis!=='g'||typeof item.nutrition?.protein!=='number')return null;
  return item.nutrition.protein*10/view.unitPrice;
}
export function sortItems(result,mode,qualityKey) {
  const {items,views,scores,hasQuery}=result,name=(a,b)=>a.name.localeCompare(b.name,'nb');
  const nulls=(get,dir)=>(a,b)=>{const x=get(a),y=get(b);if(x===null&&y===null)return name(a,b);if(x===null)return 1;if(y===null)return -1;return dir*(x-y)||name(a,b);};
  const nutrient=key=>item=>typeof item.nutrition?.[key]==='number'?item.nutrition[key]:null;
  const chains=(a,b)=>views[b.index].chains-views[a.index].chains||Number(!!b.image)-Number(!!a.image)||name(a,b);
  const quality=item=>item.quality.find(q=>q.key===qualityKey)?.score??null;
  const rank=item=>UNIT_ORDER.indexOf(views[item.index].unit);
  const compare={
    auto:hasQuery?(a,b)=>scores[b.index]-scores[a.index]||chains(a,b):chains,
    chains,name,
    unit:(a,b)=>{const x=views[a.index].unitPrice,y=views[b.index].unitPrice;if(x===null||y===null)return (x===null)-(y===null)||name(a,b);return rank(a)-rank(b)||x-y||name(a,b);}, // Kroner per kilo never line up against kroner per piece.
    pack:nulls(item=>views[item.index].packPrice,1),
    protein:nulls(nutrient('protein'),-1),
    proteinValue:nulls(item=>proteinPerKrone(item,views[item.index]),-1),
    fiber:nulls(nutrient('fiber'),-1),sugars:nulls(nutrient('sugars'),1),salt:nulls(nutrient('salt'),1),kcal:nulls(nutrient('kcal'),1),
    quality:qualityKey===null?chains:nulls(quality,-1) // A score only ranks inside one measurement basis.
  }[mode]??chains;
  return [...items].sort(compare);
}

/** Families touched by the current selection, with their spread of fresh prices. */
export function familySummaries(model,result) {
  const buckets=new Map();
  for(const item of result.items)for(const family of item.families){if(!buckets.has(family))buckets.set(family,[]);buckets.get(family).push(item);}
  return [...buckets].map(([index,items])=>{
    const family=model.families[index],stores=new Set(),prices=[];
    for(const item of items){
      const view=result.views[item.index];
      for(const post of item.posts)stores.add(post.store);
      if(view.fresh&&view.unitPrice!==null&&view.unit===family.unit)prices.push(view.unitPrice);
    }
    prices.sort((a,b)=>a-b);
    const min=prices[0]??null,max=prices[prices.length-1]??null;
    return {family,items,count:items.length,chains:stores.size,prices,min,max,spread:min&&max&&prices.length>1?max/min:null,images:items.filter(i=>i.image).slice(0,4).map(i=>i.image)};
  });
}
export function sortFamilies(rows,mode) {
  const name=(a,b)=>a.family.name.localeCompare(b.family.name,'nb');
  const compare={count:(a,b)=>b.count-a.count||name(a,b),chains:(a,b)=>b.chains-a.chains||b.count-a.count||name(a,b),spread:(a,b)=>(b.spread??0)-(a.spread??0)||name(a,b),name}[mode]??name;
  return [...rows].sort(compare);
}

export function scatterPoints(result,xKey,yKey) {
  const points=[];let missing=0;
  for(const item of result.items){
    const view=result.views[item.index],x=axisValue(item,xKey,view),y=axisValue(item,yKey,view);
    if(x===null||y===null)missing++;else points.push({item,x,y});
  }
  return {points,missing};
}
export function axisDomain(values,range,fallback) {
  const lo=range?.min??0;
  if(range?.max!=null)return [lo,range.max];
  return [lo,Math.max(lo+1e-6,nice(Math.max(percentile(values,.995),lo*1.05,fallback*.05)))];
}
export function ticks(lo,hi,count=5) {
  const raw=(hi-lo)/count,power=10**Math.floor(Math.log10(raw||1)),step=[1,2,2.5,5,10].find(x=>x*power>=raw)*power,out=[];
  for(let v=Math.ceil(lo/step)*step;v<=hi+step*1e-6;v+=step)out.push(Math.round(v*1e6)/1e6);
  return out;
}
