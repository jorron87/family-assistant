import {shoppingWorkBatch, SHOPPING_BATCH_LIMIT} from './shopping-work-batch.mjs';

// A source key is an identity, a display name/EAN is not. Only relatedSources
// or an exact metadata research key established by the domain may join chains.
export function shoppingAgentJobs(queue = []) {
  const parent = new Map();
  const root = key => {if (!parent.has(key)) parent.set(key,key); const p=parent.get(key); if(p===key)return key; const r=root(p);parent.set(key,r);return r;};
  const keys = item => item.sourceKey ? [item.sourceKey,...(item.relatedSources??[]).map(r=>r.sourceKey)] : [];
  for (const item of queue) {const sources=keys(item);for(const key of sources)parent.set(root(key),root(sources[0]));}
  const metadata=new Map();
  for(const item of queue)if(item.sourceKey&&item.researchProductKey){const prior=metadata.get(item.researchProductKey);if(prior)parent.set(root(item.sourceKey),root(prior));else metadata.set(item.researchProductKey,item.sourceKey);}
  const jobs = new Map();
  for (const [index,item] of queue.entries()) {
    // Market calibration is independently bounded per family, not per row.
    const rows=item.do==='shopping-market-refresh'&&item.watchIds?.length ? [...new Set(item.watchIds)].map(id=>({...item,groups:1,watchIds:[id]})) : [item];
    for(const row of rows){
      const id=row.sourceKey ? 'source:'+root(row.sourceKey) : row.do==='shopping-product-review'&&row.productKey ? 'product:'+row.productKey : row.do==='shopping-market-refresh'&&row.watchIds?.length ? 'market:'+row.watchIds[0] : 'task:'+index;
      const job=jobs.get(id)??{id,sourceKeys:[],productKey:row.do==='shopping-product-review'?row.productKey??null:null,items:[]};
      job.sourceKeys=[...new Set([...job.sourceKeys,...keys(row)])].sort();job.items.push(row);jobs.set(id,job);
    }
  }
  return [...jobs.values()];
}

export function shoppingAgentBatch(queue=[],{limit=SHOPPING_BATCH_LIMIT,id=null}={}) {
  if(!Number.isInteger(limit)||limit<0||limit>SHOPPING_BATCH_LIMIT)throw Error('Invalid shopping agent batch.');
  const all=shoppingAgentJobs(queue), matching=id?all.filter(j=>j.id===id||j.sourceKeys.includes(id)||j.productKey===id):all;
  const jobs=matching.slice(0,limit),items=[],markets=new Map(),summary=shoppingWorkBatch(queue,{limit:0}).summary;
  for(const item of jobs.flatMap(j=>j.items)){
    if(item.do!=='shopping-market-refresh'||!item.watchIds?.length){items.push(item);continue;}
    const {groups,watchIds,...rest}=item,key=JSON.stringify(rest),prior=markets.get(key);
    if(prior){prior.watchIds.push(...watchIds);prior.groups=prior.watchIds.length;}
    else{const row={...item,watchIds:[...watchIds]};markets.set(key,row);items.push(row);}
  }
  return {items,jobs,summary:{...summary,shown:shoppingWorkBatch(items,{full:true}).summary.total,remaining:summary.total-shoppingWorkBatch(items,{full:true}).summary.total,agentJobs:{total:matching.length,shown:jobs.length,remaining:matching.length-jobs.length},resumeHint:'Read shopping-jobs for current stages of the assigned identities; other products wait for the next batch.'}};
}
