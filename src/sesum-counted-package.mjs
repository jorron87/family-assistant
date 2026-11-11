const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e9;
const near=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const text=(v,min)=>typeof v==='string'&&v.trim().length>=min&&v.length<=6000;

// A fixed pack may have independently declared count and physical measures.
// Neither a product name nor guessed per-item arithmetic is evidence.
export function countedPackage(source,proof,{packAmount,unit,packBasis,fixedPackVerified,at}={}){
 if(proof===undefined)return null;
 const lengthCount=proof?.rule==='measured-package-count-v1',fields=['rule','reviewed','wholePack','packAmount','unit','evidence','sourceReceipts',...(lengthCount?['sourceAmount','sourceUnit']:['sourceCount'])];
 if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).some(k=>!fields.includes(k))||proof.rule!==undefined&&!['counted-package-net-measure-v1','measured-package-count-v1'].includes(proof.rule)||proof.reviewed!==true||proof.wholePack!==true||!text(proof.evidence,40))throw Error('A counted package needs an explicit reviewed whole-pack measurement and concrete primary evidence.');
 if(source.soldByWeight===true||source.soldByWeight!==false&&fixedPackVerified!==true)throw Error('A whole-pack measurement needs a fixed source package; variable or unverified weight modes cannot be converted.');
 if(lengthCount){
  if(String(source.weightUnit??'').toLowerCase()!=='m'||proof.sourceUnit!=='m'||!near(proof.sourceAmount,source.weight))throw Error('The reviewed total length must match this exact fixed source package in metres; unknown or conflicting measures cannot be converted.');
  if(packBasis!==undefined&&packBasis!=='net'||unit!=='stk'||proof.unit!==unit||!Number.isSafeInteger(packAmount)||!positive(packAmount)||proof.packAmount!==packAmount)throw Error('A measured package count must be the documented integer item count of the WHOLE consumer pack, never an inferred count or metres per item.');
 }else{
  if(!['stk','pcs'].includes(String(source.weightUnit??'').toLowerCase())||!Number.isSafeInteger(source.weight)||source.weight<1||!near(proof.sourceCount,source.weight))throw Error('The reviewed count must match this exact fixed source package; variable, unknown or conflicting counts cannot be converted.');
  if(packBasis!==undefined&&packBasis!=='net'||!['kg','l'].includes(unit)||proof.unit!==unit||!near(proof.packAmount,packAmount))throw Error('A counted package measurement must match the canonical net mass/volume of the WHOLE pack; drained, per-item or other-unit conversions need separate evidence.');
 }
 if(!Array.isArray(proof.sourceReceipts)||!proof.sourceReceipts.length||proof.sourceReceipts.length>10)throw Error('The counted package needs actual primary source receipts.');
 const receipts=proof.sourceReceipts.map(r=>{
  let url;try{url=new URL(r?.url);}catch{throw Error('Counted package receipt needs a public HTTPS source.');}
  if(url.protocol!=='https:'||url.username||url.password||!text(r.evidence,20)||typeof r.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(r.observedAt)||!/(?:Z|[+-]\d\d:\d\d)$/.test(r.observedAt)||!Number.isFinite(Date.parse(r.observedAt))||!Number.isFinite(at)||Date.parse(r.observedAt)>at)throw Error('Counted package receipt needs a real primary read date and concrete same-pack evidence.');
  return {url:url.href,observedAt:r.observedAt,evidence:r.evidence.trim()};
 });
 return {rule:lengthCount?'measured-package-count-v1':'counted-package-net-measure-v1',reviewed:true,wholePack:true,...(lengthCount?{sourceAmount:source.weight,sourceUnit:'m'}:{sourceCount:source.weight}),packAmount,unit,evidence:proof.evidence.trim(),sourceReceipts:receipts};
}

