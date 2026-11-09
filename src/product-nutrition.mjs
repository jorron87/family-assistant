// How one product's declared nutrition compares inside its own reviewed family.
// This is a relative shopping aid, not a health rating. Unknown facts stay unknown.
export const NUTRITION_MODEL_VERSION='family-nutrition-v1';
const MEASURES=[{key:'sugars',better:'low',spread:2},{key:'salt',better:'low',spread:.3},{key:'fiber',better:'high',spread:1.5},{key:'protein',better:'high',spread:2}];
const MIN_PRODUCTS=3;
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),mid=sorted.length>>1;return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;};
const round=value=>Math.round(value*100)/100;

/** rows: [{key,basis,per100}]. Returns Map key -> {score,level,measures}. */
export function scoreFamilyNutrition(rows) {
 const result=new Map(),bases=new Map();
 for(const row of rows)bases.set(row.basis,(bases.get(row.basis)??0)+1);
 const basis=[...bases].sort((a,b)=>b[1]-a[1])[0]?.[0],usable=rows.filter(row=>row.basis===basis);
 if(usable.length<MIN_PRODUCTS)return result;
 // Only differences large enough to matter count. Protein alone says little.
 const active=MEASURES.map(measure=>{
  const values=usable.map(row=>row.per100?.[measure.key]).filter(Number.isFinite);
  if(values.length<MIN_PRODUCTS)return null;
  const min=Math.min(...values),max=Math.max(...values);
  return max-min>=measure.spread?{...measure,min,max,median:median(values)}:null;
 }).filter(Boolean);
 if(!active.some(measure=>measure.key!=='protein'))return result;
 for(const row of usable){
  const known=active.filter(measure=>Number.isFinite(row.per100?.[measure.key]));
  if(known.length<Math.ceil(active.length*2/3))continue;
  const positions=known.map(m=>{const value=row.per100[m.key],share=(value-m.min)/(m.max-m.min);return m.better==='low'?1-share:share;});
  const score=Math.round(positions.reduce((a,b)=>a+b,0)/positions.length*100);
  result.set(row.key,{score,level:score>=67?'good':score>=34?'medium':'low',measures:known.map(m=>({key:m.key,better:m.better,value:round(row.per100[m.key]),median:round(m.median)}))});
 }
 return result;
}
