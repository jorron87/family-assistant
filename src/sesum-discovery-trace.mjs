import {createHash} from 'node:crypto';

// Explain the collector's saved edges, not product relevance. This read model
// never repairs a missing legacy edge by guessing from names or family hints.
export function sesumDiscoveryTrace(run,{familyId=null,productId=null}={}){
 if(familyId===null&&productId===null)throw Error('Oppgi en konkret varefamilie eller Sesum-produkt-ID.');
 if(familyId!==null&&(typeof familyId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(familyId)))throw Error('Ugyldig varefamilie.');
 if(productId!==null&&(typeof productId!=='string'||!/^[1-9]\d{0,15}$/.test(productId)))throw Error('Ugyldig Sesum-produkt-ID.');
 if(!run)return {runId:null,families:[],searches:[],products:[],total:0};
 if(familyId!==null&&!run.families.some(f=>f.familyId===familyId))throw Error('Ukjent varefamilie i denne innhentingen.');
 const resolve=id=>{const seen=new Set();while(run.productAliases?.[id]){if(seen.has(id))throw Error('Ugyldig kildealias i innhentingen.');seen.add(id);id=run.productAliases[id];}return id;};
 const number=j=>new URL(j.url).pathname.match(/^\/produkt\/(\d+)/)?.[1]??null;
 const jobs=Object.values(run.jobs),allSearches=jobs.filter(j=>j.kind==='search'),allProducts=jobs.filter(j=>j.kind==='product');
 const targetJobs=new Set(allProducts.filter(j=>productId===null||number(j)===productId).map(j=>j.id));
 const searches=allSearches.filter(j=>(familyId===null||j.familyIds.includes(familyId))&&(productId===null||(j.productJobIds??[]).some(id=>targetJobs.has(resolve(id)))));
 const edges=new Map();
 // Retain all query provenance for the selected products, including evidence
 // that a raw family hint currently has no saved direct search edge.
 for(const search of allSearches)for(const key of new Set((search.productJobIds??[]).map(resolve))){const rows=edges.get(key)??[];rows.push(search);edges.set(key,rows);}
 const selected=new Set(searches.flatMap(j=>(j.productJobIds??[]).map(resolve)));
 const products=allProducts.filter(j=>(productId===null||number(j)===productId)&&(familyId===null||j.familyIds.includes(familyId)||selected.has(j.id))).sort((a,b)=>a.url.localeCompare(b.url)).map(j=>{
  const direct=edges.get(j.id)??[],provenFamilies=new Set(direct.flatMap(s=>s.familyIds));
  return {productId:number(j),jobId:j.id,url:j.url,name:j.productObservation?.name??null,status:j.status,createdAt:j.createdAt??null,observationFetchedAt:j.observationFetchedAt??null,familyIds:[...j.familyIds],directSearchJobIds:direct.map(s=>s.id),untracedFamilyIds:j.familyIds.filter(id=>!provenFamilies.has(id))};
 });
 const productKeys=new Set(products.map(p=>p.jobId));
 const relevantSearches=productId===null?searches:allSearches.filter(j=>(j.productJobIds??[]).some(id=>productKeys.has(resolve(id))));
 const rows=relevantSearches.sort((a,b)=>a.url.localeCompare(b.url)).map(j=>({jobId:j.id,url:j.url,query:new URL(j.url).searchParams.get('q'),familyIds:[...j.familyIds],generation:j.generation??null,status:j.status,fetchedAt:j.fetchedAt??null,endReached:j.endReached===true,productEdgesKnown:Array.isArray(j.productJobIds),nextEdgesKnown:Array.isArray(j.nextJobIds),savedProductEdges:j.productJobIds?.length??null,productIds:[...new Set((j.productJobIds??[]).map(id=>run.jobs[resolve(id)]).filter(j=>j?.kind==='product').map(number))],missingProductJobIds:(j.productJobIds??[]).filter(id=>!run.jobs[resolve(id)]),nextSearchJobIds:[...(j.nextJobIds??[])]}));
 const familyIds=new Set([...products.flatMap(p=>p.familyIds),...rows.flatMap(s=>s.familyIds)]);
 const result={runId:run.id,families:run.families.filter(f=>familyId===null?familyIds.has(f.familyId):f.familyId===familyId).map(f=>({familyId:f.familyId,name:f.name,queries:[...f.queries]})),searches:rows,products,total:products.length};
 return {...result,fingerprint:createHash('sha256').update(JSON.stringify(result)).digest('hex'),authority:'Saved discovery provenance only. Missing edges stay unknown; neither a search hit nor a family hint approves relevance, equivalence, price freshness or stock.'};
}
