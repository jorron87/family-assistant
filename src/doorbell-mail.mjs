import {simpleParser} from 'mailparser';
import {createHash} from 'node:crypto';

// Explicit alarm fields only; physical verification is recorded separately.
// The operator may deliberately enable these candidates before physical tests.
export async function parseDoorbellMail(raw,{now=Date.now(),maxAgeMs=30000,skewMs=2000}={}){
 const mail=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true});
 const subject=(mail.subject??'').slice(0,200),text=(mail.text??'').slice(0,16000);
 const field=text.match(/^(?:Alarm Event|Alarm Type|Event Type)\s*:\s*([^\r\n]+)$/im)?.[1]?.trim();
 const kind=['Person','Person Detected','Person Detection'].some(v=>v.toLowerCase()===field?.toLowerCase())?'person':['Visitor','Ring','Doorbell Press','Doorbell Pressed'].some(v=>v.toLowerCase()===field?.toLowerCase())?'ring':null;
 const at=mail.date?.getTime(),fresh=Number.isFinite(at)&&now-at>=-skewMs&&now-at<=maxAgeMs;
 const validSender=mail.from?.value?.length===1&&mail.from.value[0].address==='camera@doorbell.local';
 const validRecipient=mail.to?.value?.length===1&&mail.to.value[0].address==='dashboard@doorbell.local';
 return {id:createHash('sha256').update(raw).digest('hex'),subject,text,field:field??null,kind,fresh,validSender,validRecipient,at:Number.isFinite(at)?new Date(at).toISOString():null,attachmentCount:mail.attachments.length};
}
