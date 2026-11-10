// A market-refresh row may cover many families. Count those families as work,
// so one aggregate cannot silently expand a bounded agent assignment.
export const SHOPPING_BATCH_LIMIT = 20;
const marketFamilies = item => item?.do === 'shopping-market-refresh' && Array.isArray(item.watchIds) && item.watchIds.length
  ? [...new Set(item.watchIds)] : null;
export const shoppingWorkCount = (items = []) => items.reduce((total, item) => total + (marketFamilies(item)?.length ?? 1), 0);
export function filterShoppingWork(queue,{type=null,id=null}={}){
  if(!type&&!id)return queue;
  return queue.filter(item=>!type||item.do===type).flatMap(item=>{
    if(!id||['id','sourceKey','watchId','familyId','productKey','productId','storeId'].some(key=>String(item[key]??'')===id))return [item];
    const families=marketFamilies(item);return families?.includes(id)?[{...item,groups:1,watchIds:[id]}]:[];
  });
}

export function shoppingWorkBatch(queue = [], { full = false, limit = SHOPPING_BATCH_LIMIT } = {}) {
  if (!Array.isArray(queue) || !Number.isInteger(limit) || limit < 0 || limit > SHOPPING_BATCH_LIMIT) throw Error('Invalid shopping batch.');
  const byType = {};
  for (const item of queue) byType[item.do] = (byType[item.do] ?? 0) + (marketFamilies(item)?.length ?? 1);
  const total = shoppingWorkCount(queue), items = [];
  let shown = 0;
  if (full) { shown = total; }
  else for (const item of [...queue].sort((a,b)=>priority(a)-priority(b))) {
    const left = limit - shown;
    if (!left) break;
    const families = marketFamilies(item);
    if (families) {
      const watchIds = families.slice(0, left);
      items.push({ ...item, groups: watchIds.length, watchIds });
      shown += watchIds.length;
    } else { items.push(item); shown++; }
  }
  const remaining = total - shown;
  return { items: full ? queue : items, summary: { total, shown, remaining, byType,
    ...(remaining ? { resumeHint: 'Read next after this batch; shopping-queue --full exports the complete unchanged queue.' } : {}) } };
}
const priority=item=>item.do==='shopping-stock-review'?0:item.do==='shopping-list-route'?1:2;
