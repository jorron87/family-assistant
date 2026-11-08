import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {loadKey,encrypt,decrypt} from './crypto.mjs';

// Prices are chain-level observations. Fetch time and product updated_at do not
// establish price freshness, local availability, promotions or customer limits.
export function kassalQuotes(data,now=new Date()) {
 const rows=Array.isArray(data?.data)?data.data:data?.data?.products??(data?.data?.id?[data.data]:[]);
 return rows.filter(p=>p.is_medicine!==true).map(p=>{
  const current=p.current_price,price=Number(typeof current==='object'?current?.price:current);
  const lastChecked=(typeof current==='object'?current?.date:null)??p.price_history?.[0]?.date??null;
  const age=now.getTime()-Date.parse(lastChecked),weight=Number(p.weight),unit=String(p.weight_unit??'').toLowerCase();
  const pack=weight>0&&Number.isFinite(weight)&&['kg','g','l','ml','piece','stk'].includes(unit)?{amount:weight*(['g','ml'].includes(unit)?.001:1),unit:['g','kg'].includes(unit)?'kg':['ml','l'].includes(unit)?'l':'stk'}:null;
  return {id:p.id,name:p.name,ean:p.ean??data?.data?.ean??null,store:p.store?.code??null,storeName:p.store?.name??null,url:p.url,price:Number.isFinite(price)&&price>0?price:null,pack,lastChecked,fresh:Number.isFinite(age)&&age>=-60000&&age<=48*3600000,scope:'chain',localAvailabilityVerified:false};
 });
}

export function createKassal({dataDir,fetchImpl=fetch,encryptionKey}={}) {
 const path=join(dataDir,'kassal-api.json.enc');let secret,cryptoKey,lastError=null,busy=false,lastRequest=0;
 const key=()=>cryptoKey??=encryptionKey??loadKey(dataDir);
 const read=()=>{if(secret===undefined)secret=existsSync(path)?JSON.parse(decrypt(readFileSync(path),key()).toString('utf8')).apiKey:null;return secret;};
 function configure(input){
  const value=String(input.apiKey??'').trim();if(!/^[A-Za-z0-9._-]{20,250}$/.test(value))throw Error('Ugyldig Kassal API-nøkkel.');
  const temporary=path+'.tmp';writeFileSync(temporary,encrypt(Buffer.from(JSON.stringify({apiKey:value})),key()));renameSync(temporary,path);secret=value;lastError=null;return {configured:true};
 }
 async function get(route,params={},body){
  if(busy)throw Error('En Kassal-forespørsel pågår.');const token=read();if(!token)throw Error('Kassal er ikke konfigurert.');
  busy=true;
  try{
   await delay(Math.max(0,1100-(Date.now()-lastRequest)));lastRequest=Date.now();
   const url=new URL('https://kassal.app/api/v1/'+route);for(const [k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=='')url.searchParams.set(k,String(v));
   const r=await fetchImpl(url,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});
   if(!r.ok)throw Error(r.status===401||r.status===403?'Kassal avviste API-nøkkelen.':r.status===429?'Kassals forespørselsgrense er nådd; prøv senere.':'Kassal svarte med HTTP '+r.status+'.');
   const data=await r.json();lastError=null;return {...data,quotes:kassalQuotes(data),fetchedAt:new Date().toISOString(),note:'Kjedepriser. Bekrefter ikke lokal lagerstatus, kundeavistilbud, medlemspris eller antallsgrense.'};
  }catch(e){lastError=/^Kassal/.test(e.message)?e.message:'Kassal kunne ikke hentes.';throw Error(lastError);}finally{busy=false;}
 }
 const page=input=>{const p=input.page??1,size=input.size??30;if(!Number.isInteger(p)||p<1||p>1000||!Number.isInteger(size)||size<1||size>100)throw Error('Ugyldig Kassal-side.');return {page:p,size};};
 const query=input=>{const value=String(input.query??'').trim();if(!value||value.length>150)throw Error('Skriv et søk på inntil150 tegn.');return value;};
 return {
  configure,
  status:()=>({configured:existsSync(path),busy,error:lastError}),
  history:input=>{const eans=[...new Set(input.eans??[])],days=input.days??90,aggregation=input.aggregation??'min';if(!Array.isArray(input.eans)||eans.length<1||eans.length>100||eans.some(e=>typeof e!=='string'||!/^\d{8,14}$/.test(e))||!Number.isInteger(days)||days<1||days>90||!['min','max','avg'].includes(aggregation))throw Error('Oppgi1–100 gyldige EAN-koder,1–90 dager og gyldig aggregering.');return get('products/prices-bulk',{}, {eans,days,aggregation});},
  search:input=>get('products',{search:query(input),...page(input),unique:0}),
  stores:input=>{if(input.group&&!/^[A-Z0-9_]{2,30}$/.test(input.group))throw Error('Ugyldig kjede.');return get('physical-stores',{search:query(input),...page(input),group:input.group});},
  product:input=>{if(!Number.isSafeInteger(input.id)||input.id<1)throw Error('Ugyldig Kassal-ID.');return get('products/id/'+input.id);},
  ean:input=>{if(!/^\d{8,14}$/.test(input.ean??''))throw Error('Ugyldig EAN.');return get('products/ean/'+input.ean);}
 };
}
