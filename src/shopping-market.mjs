const DAY=86400000;
const round=value=>value==null?null:Math.round((value+Number.EPSILON)*100)/100;
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const ordinal=day=>Date.parse(day+'T00:00:00Z')/DAY;
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const quantile=(values,p)=>{
 if(!values.length)return null;
 const sorted=[...values].sort((a,b)=>a-b),position=(sorted.length-1)*p,index=Math.floor(position),fraction=position-index;
 return sorted[index]+(sorted[Math.min(index+1,sorted.length-1)]-sorted[index])*fraction;
};

function supportFor(days,level) {
 const selected=days.filter(d=>d.price<=level),dates=selected.map(d=>d.day);let longestRun=0,run=0,episodes=0,previous=null;
 for(const d of selected){const n=ordinal(d.day);if(previous===n-1)run++;else{run=1;episodes++;}longestRun=Math.max(longestRun,run);previous=n;}
 const weeks=new Set(dates.map(d=>Math.floor((ordinal(d)+3)/7))).size;
 const span=dates.length?ordinal(dates.at(-1))-ordinal(dates[0]):0;
 return {days:dates.length,longestRun,episodes,weekCount:weeks,dates,supported:longestRun>=3||(episodes>=2&&weeks>=2&&span>=7)};
}

/**
 * Calibrate one explicitly reviewed equivalent-product group. Prices in history
 * and currentPrice are gross PACKAGE prices; packAmount is in the requested unit.
 * Each observation is an actual price receipt, never a forward-filled interval.
 * `reviewed` is caller evidence of equivalence, not a name-matching heuristic.
 */
export function calibrateMarket({unit,products=[],now=new Date(),windowDays=90,minimumDays=14,minimumSpanDays=21,minimumCoverage=.5,minimumWeeks=3,maxGapDays=14,freshnessHours=48,meaningfulDiscount=.02,bounds=null}={}) {
 if(!['kg','l','stk'].includes(unit)||!Array.isArray(products))throw Error('Market calibration requires a unit and product list.');
 const at=new Date(now).getTime();if(!Number.isFinite(at)||!Number.isInteger(windowDays)||windowDays<1||windowDays>365)throw Error('Invalid market calibration window.');
 if(!Number.isInteger(minimumDays)||minimumDays<1||!Number.isInteger(minimumSpanDays)||minimumSpanDays<1||!Number.isInteger(minimumWeeks)||minimumWeeks<1||!Number.isInteger(maxGapDays)||maxGapDays<0||!Number.isFinite(minimumCoverage)||minimumCoverage<0||minimumCoverage>1||!positive(freshnessHours)||!Number.isFinite(meaningfulDiscount)||meaningfulDiscount<0||meaningfulDiscount>=1)throw Error('Invalid market calibration quality requirements.');
 if(bounds&&(!positive(bounds.min)||!positive(bounds.max)||bounds.max<bounds.min))throw Error('Invalid explicit unit-price bounds.');
 const today=dayAt(at),first=ordinal(today)-windowDays+1,exclusions=[],warnings=[],rejectedObservations=[];
 const freshMs=freshnessHours*3600000,byIdentity=new Map();let ignoredOutOfWindow=0;
 for(const p of products){
  const id=p?.id??p?.ean??null,store=p?.store??null,label={id,ean:p?.ean??null,store};
  let reason=null;
  if(p?.reviewed!==true)reason='unreviewed-equivalence';
  else if(p.available===false||p.delisted===true)reason='delisted-or-unavailable';
  else if(!store||id===null)reason='missing-product-or-chain-id';
  else if(p.unit!==unit)reason='unit-mismatch';
  else if(!positive(p.packAmount))reason='invalid-pack-amount';
  const checked=Date.parse(p?.lastChecked),age=at-checked;
  if(!reason&&(!Number.isFinite(checked)||age>freshMs||age< -60000))reason='stale-or-missing-current-receipt';
  if(reason){exclusions.push({...label,reason});continue;}
  const key=String(store)+'\0'+String(id),previous=byIdentity.get(key);
  if(previous&&(previous.packAmount!==p.packAmount||previous.unit!==p.unit)){
   previous.invalid=true;exclusions.push({...label,reason:'conflicting-pack-amount'});continue;
  }
  const entry=previous??{...label,name:p.name??null,unit,packAmount:p.packAmount,lastChecked:p.lastChecked,equivalenceEvidence:p.equivalenceEvidence??null,history:[],invalid:false};
  if(checked>Date.parse(entry.lastChecked))entry.lastChecked=p.lastChecked;
  entry.history.push(...(Array.isArray(p.history)?p.history:[]));
  if(positive(p.currentPrice))entry.history.push({date:p.lastChecked,price:p.currentPrice,verified:p.currentPriceVerified===true});
  byIdentity.set(key,entry);
 }
 const eligible=[];
 for(const p of byIdentity.values()){
  if(p.invalid)continue;
  const candidate=[];
  for(const h of p.history){
   const timestamp=Date.parse(h?.date);
   if(!Number.isFinite(timestamp)||timestamp>at+60000||!positive(h?.price)){
    rejectedObservations.push({id:p.id,store:p.store,date:h?.date??null,reason:'invalid-date-or-price'});continue;
   }
   const day=dayAt(timestamp),n=ordinal(day);
   if(n<first||n>ordinal(today)){ignoredOutOfWindow++;continue;}
   const price=h.price/p.packAmount;
   if(!positive(price)||(bounds&&(price<bounds.min||price>bounds.max))){
    rejectedObservations.push({id:p.id,store:p.store,date:day,reason:'outside-unit-price-bounds'});continue;
   }
   candidate.push({day,timestamp,price,verified:h.verified===true});
  }
  const center=quantile(candidate.map(h=>h.price),.5),daily=new Map(),conflicts=new Set();
  for(const h of candidate){
   // A 90%+ price collapse or 10x spike needs explicit source verification.
   // A lasting low within this range is retained; no presumed promo is invented.
   if(center&&candidate.length>=5&&!h.verified&&(h.price<center*.1||h.price>center*10)){
    rejectedObservations.push({id:p.id,store:p.store,date:h.day,reason:'extreme-temporal-outlier'});continue;
   }
   const previous=daily.get(h.day);
   if(!previous||h.timestamp>previous.timestamp){daily.set(h.day,h);conflicts.delete(h.day);}
   else if(h.timestamp===previous.timestamp&&h.price!==previous.price)conflicts.add(h.day);
  }
  for(const d of conflicts){daily.delete(d);rejectedObservations.push({id:p.id,store:p.store,date:d,reason:'conflicting-same-time-price'});}
  const history=[...daily.values()].sort((a,b)=>a.timestamp-b.timestamp),latest=history.at(-1);
  if(!latest||at-latest.timestamp>freshMs){exclusions.push({id:p.id,ean:p.ean,store:p.store,reason:'no-fresh-price-in-history'});continue;}
  eligible.push({...p,history,currentUnitPrice:latest.price,lastPriceDate:latest.day});
 }
 const byChainDay=new Map();
 for(const p of eligible)for(const h of p.history){
  const key=p.store+'\0'+h.day,previous=byChainDay.get(key);
  if(!previous||h.price<previous.price)byChainDay.set(key,{day:h.day,store:p.store,price:h.price,id:p.id,ean:p.ean});
 }
 const byDay=new Map();
 for(const h of byChainDay.values()){
  const previous=byDay.get(h.day);
  if(!previous||h.price<previous.price)byDay.set(h.day,h);
 }
 const days=[...byDay.values()].sort((a,b)=>a.day.localeCompare(b.day)),prices=days.map(d=>d.price);
 const from=days[0]?.day??null,to=days.at(-1)?.day??null,spanDays=days.length?ordinal(to)-ordinal(from)+1:0;
 let largestGapDays=0;for(let i=1;i<days.length;i++)largestGapDays=Math.max(largestGapDays,ordinal(days[i].day)-ordinal(days[i-1].day)-1);
 const coverageRatio=spanDays?days.length/spanDays:0,weekCount=new Set(days.map(d=>Math.floor((ordinal(d.day)+3)/7))).size;
 const chains=[...new Set(eligible.map(p=>p.store))].sort(),reference=quantile(prices,.5),currentBest=eligible.length?Math.min(...eligible.map(p=>p.currentUnitPrice)):null;
 const coverage={requestedDays:windowDays,observedDays:days.length,spanDays,coverageRatio:round(coverageRatio),windowCoverageRatio:round(days.length/windowDays),largestGapDays,weekCount,from,to,chains,chainCount:chains.length,products:eligible.length};
 const reasons=[];
 if(!eligible.length)reasons.push('no-reviewed-fresh-products');
 if(days.length<minimumDays)reasons.push('too-few-observed-days');
 if(spanDays<minimumSpanDays)reasons.push('too-short-observed-span');
 if(coverageRatio<minimumCoverage)reasons.push('sparse-history');
 if(weekCount<minimumWeeks)reasons.push('too-few-observed-weeks');
 if(largestGapDays>maxGapDays)reasons.push('large-history-gap');
 if(chains.length===1)warnings.push('single-chain-market-coverage');
 if(days.length<windowDays*.75)warnings.push('limited-window-coverage');
 if(rejectedObservations.length)warnings.push('rejected-price-observations');
 const q={p10:quantile(prices,.1),p25:quantile(prices,.25),p50:reference,p75:quantile(prices,.75)};
 let supportedLow=null,support=null;
 for(const level of [...new Set(prices)].sort((a,b)=>a-b)){const candidate=supportFor(days,level);if(candidate.supported){supportedLow=level;support=candidate;break;}}
 let good=q.p25==null?null:Math.min(q.p25,currentBest),excellent=null;
 const low=prices.length?Math.min(...prices):null;
 if(reference&&low>=reference*(1-meaningfulDiscount))warnings.push('lack-of-price-variation');
 if(good!==null&&reference!==null&&good>=reference*(1-meaningfulDiscount))warnings.push('good-threshold-is-ordinary-cheap-price');
 if(supportedLow!==null&&reference!==null&&supportedLow<reference*(1-meaningfulDiscount)&&supportedLow<good*(1-meaningfulDiscount))excellent=supportedLow;
 else warnings.push('no-distinct-supported-stock-up-price');
 if(low!==null&&supportedLow!==null&&low<supportedLow)warnings.push('historical-minimum-not-repeated-or-sustained');
 if(reasons.length){good=null;excellent=null;}
 return {
  status:reasons.length?'insufficient':'ready',unit,checkedAt:new Date(at).toISOString(),
  referencePrice:reasons.length?null:round(reference),goodPrice:round(good),excellentPrice:round(excellent),
  currentBestPrice:round(currentBest),historicalLow:round(low),supportedLow:round(supportedLow),
  quantiles:Object.fromEntries(Object.entries(q).map(([k,v])=>[k,round(v)])),coverage,
  products:eligible.map(p=>({id:p.id,ean:p.ean,store:p.store,name:p.name,packAmount:p.packAmount,unit:p.unit,lastChecked:p.lastChecked,lastPriceDate:p.lastPriceDate,currentUnitPrice:round(p.currentUnitPrice),observedDays:p.history.length,equivalenceEvidence:p.equivalenceEvidence})),
  dailyBest:days.map(d=>({...d,price:round(d.price)})),support: support?{...support,level:round(supportedLow)}:null,
  exclusions,rejectedObservations,ignoredOutOfWindow,reasons,warnings,
  method:{version:1,aggregation:'cheapest-reviewed-product-per-chain-day, then cheapest-chain-per-observed-day',normal:'median daily obtainable market floor',good:'lower quartile capped by current fresh market best',excellent:'lowest repeated or sustained level meaningfully below normal and good',gapPolicy:'observed receipts only; no forward fill',limits:{minimumDays,minimumSpanDays,minimumCoverage,minimumWeeks,maxGapDays,freshnessHours,meaningfulDiscount},scope:'chain prices; no local stock, customer limits, memberships or flyer campaign claims'}
 };
}
