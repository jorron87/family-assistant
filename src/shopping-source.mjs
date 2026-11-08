// Fetches the page behind a stored offer so the living-room display can show a
// flyer PDF without leaving the dashboard. Only URLs already saved on offers are
// fetched, never a URL from the request, and the bytes are treated as untrusted.
const MAX_BYTES=60*1024*1024,CACHE_MS=15*60000,CACHE_ENTRIES=3;
const UA='Mozilla/5.0 (compatible; FamilienDashboard/1.0; privat hjemmedashboard)';

export function publicHttps(value) {
 let url;
 try{url=new URL(value);}catch{return false;}
 if(url.protocol!=='https:'||url.username||url.password)return false;
 const host=url.hostname.toLowerCase();
 return host.includes('.')&&!host.endsWith('.local')&&!host.endsWith('.localhost')&&!/^\[|^\d+(?:\.\d+){3}$/.test(host);
}

/** The flyer page an agent noted in its evidence, when there is exactly one. */
export function flyerPage(evidence) {
 const pages=[...new Set([...String(evidence??'').matchAll(/\bside\s*(\d{1,3})\b/gi)].map(match=>Number(match[1])))];
 return pages.length===1&&pages[0]>0?pages[0]:null;
}

export function createSourceFetcher({fetchImpl=fetch,now=Date.now}={}) {
 const cache=new Map();
 async function load(url) {
  const hit=cache.get(url);
  if(hit&&now()-hit.at<CACHE_MS)return hit;
  const page={kind:'page',bytes:null,at:now()};
  const remember=entry=>{cache.delete(url);cache.set(url,entry);while(cache.size>CACHE_ENTRIES)cache.delete(cache.keys().next().value);return entry;};
  if(!publicHttps(url))return page;
  let response;
  try{response=await fetchImpl(url,{headers:{'User-Agent':UA,Accept:'application/pdf,text/html;q=0.8'},redirect:'follow',signal:AbortSignal.timeout(30000)});}catch{return page;}
  if(!response.ok||!publicHttps(response.url||url)||Number(response.headers.get('content-length')??0)>MAX_BYTES)return remember(page);
  if(/^text\/html/i.test(response.headers.get('content-type')??''))return remember(page);
  let bytes;
  try{bytes=Buffer.from(await response.arrayBuffer());}catch{return page;}
  if(bytes.length>MAX_BYTES||bytes.subarray(0,5).toString('latin1')!=='%PDF-')return remember(page);
  return remember({kind:'pdf',bytes,at:now()});
 }
 return {load};
}
