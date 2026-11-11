import {createHash} from 'node:crypto';

const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const chain=v=>({EXTRA:'COOP_EXTRA',MENY:'MENY_NO',SPAR:'SPAR_NO',ODA:'ODA_NO',EUROPRIS:'EUROPRIS_NO',OBS:'COOP_OBS',PRIX:'COOP_PRIX',MEGA:'COOP_MEGA',JOKER:'JOKER_NO',COOP_MARKED:'MATKROKEN'}[v]??v);
const fields=new Set(['kind','productId','sourceUrl','storeId','storeCode','rowControl','label','amount','unit','observedAt','source']);
const chains=new Set(['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA','JOKER_NO','BUNNPRIS','MATKROKEN']);
const stamp=v=>typeof v==='string'&&v.length<=80&&/^\d{4}-\d\d-\d\dT/.test(v)&&/(?:Z|[+-]\d\d:\d\d)$/.test(v)&&Number.isFinite(Date.parse(v));
const bounded=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/u.test(v);
const store=v=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?String(v):typeof v==='string'&&/^[1-9]\d{0,29}$/.test(v)?v:null;

/** A numeric field never proves its unit: only this exact own-row label can. */
export function sanitizeUnitPriceBasis(value,context){
  if(value==null)return {basis:null,reason:'missing-own-unit-price-basis'};
  const invalid=()=>({basis:null,reason:'invalid-own-unit-price-basis'});
  if(!plain(value)||Object.keys(value).some(key=>!fields.has(key))||value.kind!=='own-chain-row-label-v1')return invalid();
  const id=String(context.productId),storeId=store(context.storeId);
  if(!/^[1-9]\d*$/.test(id)||typeof value.productId!=='string'||value.productId!==id||!storeId||typeof value.storeId!=='string'||store(value.storeId)!==storeId||!chains.has(chain(context.storeCode))||chain(value.storeCode)!==chain(context.storeCode)||value.rowControl!==`kjederad-${storeId}`)return invalid();
  try{
    const url=new URL(value.sourceUrl);
    if(url.origin!=='https://www.sesum.no'||url.username||url.password||url.search||url.hash||!new RegExp(`^/produkt/${id}(?:-[^/?#]+)?/?$`).test(url.pathname)||url.href!==context.sourceUrl)return invalid();
  }catch{return invalid();}
  if(!bounded(value.label,150)||!bounded(value.source,100)||value.source!==context.source||!stamp(value.observedAt)||value.observedAt!==context.observedAt||!['kg','l'].includes(value.unit))return invalid();
  const match=value.label.trim().match(/^((?:\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d+)(?:,\d{1,2})?)\s+(?:kr|NOK)\s*\/\s*(kg|l)$/u);
  if(!match||match[2]!==value.unit)return invalid();
  const amount=Number(match[1].replace(/[ \u00a0\u202f.]/gu,'').replace(',','.'));
  if(!(amount>0&&amount<=1e9)||typeof value.amount!=='number'||!Number.isFinite(value.amount)||Math.abs(amount-value.amount)>Number.EPSILON*Math.max(1,amount)||typeof context.price!=='number'||!Number.isFinite(context.price)||Math.abs(amount-context.price)>.005+Number.EPSILON*Math.max(1,amount,context.price))return invalid();
  return {basis:{kind:value.kind,productId:id,sourceUrl:context.sourceUrl,storeId,storeCode:chain(context.storeCode),rowControl:value.rowControl,label:value.label,amount,unit:value.unit,observedAt:value.observedAt,source:value.source},reason:null};
}

export function unitPriceBasisFingerprint(basis,{sourceFingerprint,fetchedAt}){
  if(!basis||!stamp(fetchedAt)||typeof sourceFingerprint!=='string')return null;
  return createHash('sha256').update(JSON.stringify([sourceFingerprint,basis.productId,basis.sourceUrl,basis.storeCode,basis.storeId,basis.rowControl,basis.label,basis.amount,basis.unit,basis.source,basis.observedAt,new Date(fetchedAt).toISOString()])).digest('hex');
}
