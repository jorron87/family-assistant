// Inspect response bytes before trusting a filename or a cached extraction.
export function inspectOriginalResponse(bytes, {fileName='',mimeType=''}={}) {
  const head=bytes.subarray(0,2048).toString('utf8');
  const binary=head.startsWith('%PDF-')||bytes.subarray(0,2).toString()==='PK';
  const isHtml=!binary&&(mimeType.split(';')[0].trim().toLowerCase()==='text/html'||/<(?:!doctype\s+html|html|head|body)\b/i.test(head));
  if(!isHtml)return {isHtml:false,requiresLogin:false,error:null};
  const html=bytes.toString('utf8');
  const canonical=[...html.matchAll(/<link\b[^>]*>/gi)].some(([tag])=>{
    if(!/\brel\s*=\s*["']canonical["']/i.test(tag))return false;
    const href=tag.match(/\bhref\s*=\s*["']([^"']+)/i)?.[1];
    try{return /^\/(?:login(?:\.php)?|signin)\/?$/i.test(new URL(href).pathname);}catch{return false;}
  });
  const requiresLogin=canonical||/<input[^>]+type\s*=\s*["']password/i.test(html)&&!/<article\b/i.test(html);
  return {isHtml,requiresLogin,error:requiresLogin?'Kilden returnerte en innloggingsside, ikke originalen.':/\.(?:pdf|docx|xlsx|pptx)$/i.test(fileName)?'Kilden returnerte HTML, ikke den forventede originalfilen.':null};
}
