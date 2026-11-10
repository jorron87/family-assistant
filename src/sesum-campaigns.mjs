import {createHash} from 'node:crypto';

const HOURS_48=48*3600000,DAY=86400000;
const CHAINS=new Set(['KIWI','REMA_1000','COOP_EXTRA','MENY_NO','SPAR_NO','ODA_NO','EUROPRIS_NO','COOP_OBS','COOP_PRIX','COOP_MEGA']);
const EVIDENCE_KEYS=['price','period','membership','customerLimit','bundle','conditions'];
const START_KEYS=['startsAt','starts_at','startDate','start_date','validFrom','valid_from'];
const END_KEYS=['endsAt','ends_at','endDate','end_date','validTo','valid_to','validUntil','valid_until'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=1e9;
const present=value=>value!==undefined&&value!==null;
const sameAmount=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const sameMoney=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=.005;
function text(value,label,max=4000,{optional=false}={}){
  if(optional&&value==null)return null;
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))throw Error(`Invalid or missing ${label}.`);
  return value.trim();
}
function canonical(value,depth=0){
  if(depth>8)throw Error('Campaign data is too deeply nested.');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){if(value.length>16000)throw Error('Oversized campaign field.');return value;}
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)){if(value.length>100)throw Error('Oversized campaign array.');return value.map(v=>canonical(v,depth+1));}
  if(plain(value)){
    const keys=Object.keys(value).sort();if(keys.length>100)throw Error('Too many campaign fields.');
    return Object.fromEntries(keys.map(key=>{if(key.length>200)throw Error('Oversized campaign key.');return [key,canonical(value[key],depth+1)];}));
  }
  throw Error('Campaign fingerprints require bounded JSON data.');
}
const fingerprint=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function https(value){
  const parsed=new URL(text(value,'source URL',2048));
  if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw Error('Review sources must use HTTPS without credentials.');
  return parsed;
}
function timestamp(value,label){
  if(typeof value!=='string'||value.length>64||!/^\d{4}-\d\d-\d\dT/.test(value)||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error(`Invalid ${label}.`);
  date(value.slice(0,10),label);
  return Date.parse(value);
}
function date(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\d$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)throw Error(`Invalid ${label}.`);
  return value;
}
const addDays=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*DAY).toISOString().slice(0,10);
const osloFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function osloParts(at){return Object.fromEntries(osloFormat.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
function osloDay(at){const p=osloParts(at);return `${p.year}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`;}
function osloMidnight(value){
  const target=Date.parse(value+'T00:00:00Z');let at=target;
  for(let i=0;i<3;i++){const p=osloParts(at),local=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);at+=target-local;}
  return at;
}
function context(input){
  if(!plain(input)||!plain(input.receipt))throw Error('A current campaign context and receipt are required.');
  const sourceKey=text(input.sourceKey,'source key',250),match=sourceKey.match(/^sesum:([A-Z0-9_]+):([1-9]\d*)$/);
  if(!match||!CHAINS.has(match[1])||!Number.isSafeInteger(Number(match[2])))throw Error('Invalid campaign source identity.');
  if(!/^[a-f0-9]{64}$/.test(input.sourceFingerprint??''))throw Error('A current source fingerprint is required.');
  if(!positive(input.packAmount)||!['kg','l','stk','m'].includes(input.unit))throw Error('A documented canonical campaign package is required.');
  const promotion=input.receipt.promotion??null;
  if(promotion!==null&&!plain(promotion))throw Error('Invalid campaign promotion data.');
  canonical(promotion);
  if(present(input.receipt.price)&&!positive(input.receipt.price))throw Error('Invalid actual receipt price.');
  if(present(input.receipt.isPromo)&&typeof input.receipt.isPromo!=='boolean')throw Error('Invalid campaign flag.');
  if(present(input.source)&&!plain(input.source))throw Error('Invalid campaign source metadata.');
  if(input.source?.store!=null&&input.source.store!==match[1]||input.chainCode!=null&&input.chainCode!==match[1])throw Error('Campaign source chain is contradictory.');
  return {sourceKey,sourceFingerprint:input.sourceFingerprint,packAmount:input.packAmount,unit:input.unit,chainCode:match[1],receipt:input.receipt,promotion};
}

/** Product identity is independent of price/campaign changes. Observation and
 * transport times never manufacture a new campaign revision. Unknown promotion
 * fields are retained in full so an opaque material change is never ignored. */
export function campaignFingerprint(input){
  const c=context(input);
  return fingerprint({sourceKey:c.sourceKey,sourceFingerprint:c.sourceFingerprint,packAmount:c.packAmount,unit:c.unit,price:c.receipt.price??null,isPromo:c.receipt.isPromo??false,promotion:c.promotion,priceSource:text(c.receipt.source,'price source',100,{optional:true})});
}

/** Bind an acknowledgement to the actual stored ordinary offer, including its
 * effective gross price and restrictions; reading/review prose is not a term. */
export function offerTermsFingerprint(offer,chainCode){
  if(!plain(offer)||!CHAINS.has(chainCode))throw Error('An ordinary offer and exact chain are required.');
  const fields=['storeId','watchId','externalId','name','price','packAmount','unit','validFrom','validTo','memberOnly','maxPacks','bundlePacks','conditions','bestBefore','priceIncludesVat','quotedPriceIncludesVat','priceBeforeVat','vatRate','sourceUrl'];
  return fingerprint({chainCode,...Object.fromEntries(fields.map(key=>[key,offer[key]??null]))});
}

function sourceNumber(promotion,key,{integer=false}={}){
  const value=promotion[key];if(!present(value))return null;
  const parsed=typeof value==='string'&&/^\d+(?:[.,]\d+)?$/.test(value.trim())?Number(value.trim().replace(',','.')):value;
  if(!positive(parsed)||integer&&!Number.isSafeInteger(parsed))throw Error(`Unresolved campaign ${key}.`);
  return parsed;
}
function equalKnown(values,label){
  const known=values.filter(present);
  if(known.some(value=>value!==known[0]))throw Error(`Contradictory campaign ${label}.`);
  return known[0]??null;
}
function periodOf(promotion){
  const starts=[],ends=[],exclusiveEnds=[];
  for(const key of START_KEYS)if(present(promotion[key])){
    const value=promotion[key];starts.push(typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value)?date(value,key):osloDay(timestamp(value,key)));
  }
  for(const key of END_KEYS)if(present(promotion[key])){
    const value=promotion[key];
    if(typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value))ends.push(date(value,key));
    else{const at=timestamp(value,key);exclusiveEnds.push(at);ends.push(addDays(osloDay(at),-1));}
  }
  const start=equalKnown(starts,'start dates'),end=equalKnown(ends,'end dates');
  if(start&&end&&end<start)throw Error('Contradictory campaign period.');
  return {start,end,exclusiveEnds};
}

/** Validate an agent's explicitly evidenced campaign review. Evidence is a
 * trusted manual decision, not an automatic proof from a name, EAN, paid receipt
 * or empty source field. Household membership/variant checks belong to caller. */
export function validateCampaignOffer({campaign,offer,chainCode,conditionsVerified,termsEvidence,sourceReceipts,now=new Date()}={}){
  const c=context(campaign),p=c.promotion??{},at=new Date(now).getTime();
  if(!Number.isFinite(at))throw Error('Invalid campaign review time.');
  if(c.receipt.isPromo!==true&&c.promotion===null)throw Error('The source has no current campaign to review.');
  if(chainCode!==c.chainCode)throw Error('Offer and campaign must use the exact same chain.');
  if(!plain(offer)||offer.unit!==c.unit||!sameAmount(offer.packAmount,c.packAmount))throw Error('Offer canonical package or unit does not match the campaign.');
  if(!positive(offer.price)||offer.priceIncludesVat!==true)throw Error('A verified gross per-package offer price is required.');
  if(typeof offer.memberOnly!=='boolean'||!Number.isSafeInteger(offer.bundlePacks)||offer.bundlePacks<1||offer.maxPacks!==null&&(!Number.isSafeInteger(offer.maxPacks)||offer.maxPacks<1))throw Error('Explicit offer membership, customer limit and bundle terms are required.');
  if(offer.maxPacks!==null&&offer.maxPacks<offer.bundlePacks)throw Error('The customer cap cannot be lower than the required campaign bundle.');
  if(typeof offer.conditions!=='string'||offer.conditions.length>1000)throw Error('Invalid ordinary offer conditions.');
  if(conditionsVerified!==true)throw Error('Campaign conditions require explicit verification.');
  if(!plain(termsEvidence)||Object.keys(termsEvidence).some(key=>!EVIDENCE_KEYS.includes(key)))throw Error('Six explicit campaign evidence fields are required.');
  const evidence=Object.fromEntries(EVIDENCE_KEYS.map(key=>[key,text(termsEvidence[key],`${key} evidence`)]));
  if(!Array.isArray(sourceReceipts)||!sourceReceipts.length||sourceReceipts.length>20)throw Error('Fresh primary campaign review receipts are required.');
  const receipts=sourceReceipts.map(receipt=>{
    if(!plain(receipt))throw Error('Invalid primary review receipt.');
    const parsed=https(receipt.url),readAt=timestamp(receipt.observedAt,'actual primary read time');
    if(readAt>at||at-readAt>HOURS_48)throw Error('Primary campaign review receipts must be actual past reads within 48 hours.');
    const hostname=parsed.hostname.toLowerCase().replace(/\.$/,'');
    return {url:parsed.href,observedAt:new Date(readAt).toISOString(),evidence:text(receipt.evidence,'primary source evidence'),primary:hostname!=='sesum.no'&&!hostname.endsWith('.sesum.no')};
  });
  const primary=receipts.filter(receipt=>receipt.primary);
  if(!primary.length)throw Error('A non-Sesum primary campaign source is required.');
  const latestRead=Math.max(...primary.map(receipt=>Date.parse(receipt.observedAt))),observed=timestamp(offer.observedAt,'actual offer observation');
  if(observed>latestRead||at-observed>HOURS_48)throw Error('Offer observation must be fresh and cannot be newer than the actual primary read.');
  https(offer.sourceUrl);
  const from=date(offer.validFrom,'offer start date'),to=date(offer.validTo,'offer end date'),period=periodOf(p);
  if(to<from||osloMidnight(addDays(to,1))<=at)throw Error('Invalid or expired offer period.');
  // Announced start days use the ordinary day model and explicit primary proof.
  // Timestamp ends are exclusive: the whole advertised final local day must fit.
  if(period.start&&from<period.start||period.end&&to>period.end||period.exclusiveEnds.some(end=>osloMidnight(addDays(to,1))>end))throw Error('Offer period broadens the supplied campaign period.');
  const membership=equalKnown(['memberOnly','member_only'].map(key=>{
    if(!present(p[key]))return null;if(typeof p[key]!=='boolean')throw Error('Unresolved campaign membership.');return p[key];
  }),'membership requirements');
  if(membership===true&&!offer.memberOnly)throw Error('A required campaign membership cannot be removed.');
  const limit=equalKnown(['customerLimit','customer_limit','limit'].map(key=>sourceNumber(p,key,{integer:true})),'customer limits');
  if(limit!==null&&(offer.maxPacks===null||offer.maxPacks>limit))throw Error('Campaign customer limits cannot be weakened.');
  const quantity=equalKnown(['multi_buy_quantity','quantity'].map(key=>sourceNumber(p,key,{integer:true})),'bundle quantities');
  if(quantity!==null&&offer.bundlePacks!==quantity)throw Error('The required campaign bundle quantity must match.');
  const payFor=sourceNumber(p,'multi_buy_pay_for',{integer:true});
  if(payFor!==null&&payFor>offer.bundlePacks)throw Error('Contradictory campaign pay-for quantity.');
  const packPrice=sourceNumber(p,'price'),bundlePrice=sourceNumber(p,'multi_buy_price');
  if(packPrice!==null&&!sameMoney(offer.price,packPrice))throw Error('Offer price contradicts the announced campaign package price.');
  if(bundlePrice!==null&&!sameMoney(offer.price*offer.bundlePacks,bundlePrice))throw Error('Effective package price and bundle quantity contradict the campaign total.');
  if(p.conditions!=null&&typeof p.conditions!=='string')throw Error('Unresolved campaign conditions.');
  if((typeof p.conditions==='string'&&p.conditions.trim()||membership===true||limit!==null||offer.bundlePacks>1||payFor!==null)&&!String(offer.conditions??'').trim())throw Error('Campaign restrictions must be preserved in offer conditions.');
  return {campaignFingerprint:campaignFingerprint(campaign),offerTermsFingerprint:offerTermsFingerprint(offer,chainCode),conditionsVerified:true,termsEvidence:evidence,sourceReceipts:receipts.map(({primary,...receipt})=>receipt),latestPrimaryReadAt:new Date(latestRead).toISOString(),reviewedAt:new Date(at).toISOString()};
}
