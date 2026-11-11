const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0&&n<=1e9;
const near=(a,b)=>positive(a)&&positive(b)&&Math.abs(a-b)<=1e-6*Math.max(a,b);
const text=(v,min)=>typeof v==='string'&&v.trim().length>=min&&v.length<=6000;

// A fixed pack may have both an item count and a net mass/volume. Neither a
// product name nor arithmetic over guessed per-item amounts is evidence.
export function countedPackage(source,proof,{packAmount,unit,packBasis,fixedPackVerified,at}={}){
 if(proof===undefined)return null;
 if(!proof||typeof proof!=='object'||Array.isArray(proof)||Object.keys(proof).some(k=>!['rule','reviewed','wholePack','sourceCount','packAmount','unit','evidence','sourceReceipts'].includes(k))||proof.rule!==undefined&&proof.rule!=='counted-package-net-measure-v1'||proof.reviewed!==true||proof.wholePack!==true||!text(proof.evidence,40))throw Error('A counted package needs an explicit reviewed whole-pack measurement and concrete primary evidence.');
 if(source.soldByWeight===true||source.soldByWeight!==false&&fixedPackVerified!==true||!['stk','pcs'].includes(String(source.weightUnit??'').toLowerCase())||!Number.isSafeInteger(source.weight)||source.weight<1||!near(proof.sourceCount,source.weight))throw Error('The reviewed count must match this exact fixed source package; variable, unknown or conflicting counts cannot be converted.');
 if(packBasis!==undefined&&packBasis!=='net'||!['kg','l'].includes(unit)||proof.unit!==unit||!near(proof.packAmount,packAmount))throw Error('A counted package measurement must match the canonical net mass/volume of the WHOLE pack; drained, per-item or other-unit conversions need separate evidence.');
 if(!Array.isArray(proof.sourceReceipts)||!proof.sourceReceipts.length||proof.sourceReceipts.length>10)throw Error('The counted package needs actual primary source receipts.');
 const receipts=proof.sourceReceipts.map(r=>{
  let url;try{url=new URL(r?.url);}catch{throw Error('Counted package receipt needs a public HTTPS source.');}
  if(url.protocol!=='https:'||url.username||url.password||!text(r.evidence,20)||typeof r.observedAt!=='string'||!/^\d{4}-\d\d-\d\dT/.test(r.observedAt)||!/(?:Z|[+-]\d\d:\d\d)$/.test(r.observedAt)||!Number.isFinite(Date.parse(r.observedAt))||!Number.isFinite(at)||Date.parse(r.observedAt)>at)throw Error('Counted package receipt needs a real primary read date and concrete same-pack evidence.');
  return {url:url.href,observedAt:r.observedAt,evidence:r.evidence.trim()};
 });
 return {rule:'counted-package-net-measure-v1',reviewed:true,wholePack:true,sourceCount:source.weight,packAmount,unit,evidence:proof.evidence.trim(),sourceReceipts:receipts};
}

