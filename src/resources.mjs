import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { encrypt, decrypt, loadKey } from './crypto.mjs';
import { cleanText } from './activity-feeds.mjs';
import { sourceIdentity } from './source-identity.mjs';
import { inspectOriginalResponse } from './original-response.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 20 * 1024 * 1024;
const LOGIN_PAGE_ERROR = 'Kilden returnerte en innloggingsside, ikke originalen.';

// Give each portal its own budget. Older inaccessible external documents must
// not fill every slot ahead of a new native school attachment.
export function collectorResourceRequests(items, {now=Date.now(),limitPerSource=4}={}) {
  const origin={vigilo:'https://web-parent.prod.vigilo-oas.no',spond:'https://api.spond.com'};
  const eligible=items.filter(item=>item.status==='error' && item.url && origin[item.source] &&
    (item.authRequired || !item.retryAt || Date.parse(item.retryAt)<=now));
  const native=item=>{try{return !!item.nativeId && new URL(item.url).origin===origin[item.source];}catch{return false;}};
  const result=[];
  for(const source of Object.keys(origin)) {
    const pending=eligible.filter(item=>item.source===source).sort((a,b)=>Number(native(b))-Number(native(a)) ||
      (Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0) || a.id.localeCompare(b.id));
    // Rotate the remaining backlog hourly after prioritizing native originals.
    const priority=pending.filter(native).slice(0,limitPerSource);
    const others=pending.filter(item=>!priority.includes(item));
    const offset=others.length?Math.floor(now/3600000)%others.length:0;
    result.push(...priority,...[...others.slice(offset),...others.slice(0,offset)].slice(0,limitPerSource-priority.length));
  }
  return result.map(({id,source,url})=>({id,source,url}));
}
const unescape = text => String(text).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
export function readableUrl(value, base) {
  try { const u = new URL(unescape(value), base); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
export function extractLinks(text, base) {
  const found = new Map();
  for (const match of String(text).matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']|https?:\/\/[^\s<>"']+/gi)) {
    const url = readableUrl((match[1] ?? match[0]).replace(/[.,;)]+$/, ''), base);
    if (url && url !== base) found.set(url, { url });
  }
  return [...found.values()];
}

// Text extraction is evidence for an agent, never an automatic reading receipt.
export async function extractDocument(bytes, {mimeType = '', fileName = '', url = ''} = {}) {
  const head = bytes.subarray(0, 200).toString('utf8');
  const type = mimeType.split(';')[0].toLowerCase();
  const response=inspectOriginalResponse(bytes,{fileName,mimeType});
  if(response.isHtml) {
    const html=bytes.toString('utf8');
    const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]??html;
    const text=cleanText(main).join('\n');
    return {format:'html',pageCount:1,pages:[{page:1,text}],links:extractLinks(main,url),needsVisual:!text,requiresLogin:response.requiresLogin,dynamicContentPossible:/<iframe\b|__NEXT_DATA__|type=["']module/i.test(html)};
  }
  if (head.startsWith('%PDF-')) {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
    const doc = await task.promise;
    try {
      const pages = [], links = new Map();
      for (let page = 1; page <= doc.numPages; page++) {
        const sheet = await doc.getPage(page);
        const content = await sheet.getTextContent();
        let lastY = null;
        const text = content.items.map(item => {
          const y = item.transform?.[5];
          const newline = lastY !== null && y !== lastY; lastY = y;
          return (newline ? '\n' : '') + (item.str ?? '') + (item.hasEOL ? '\n' : ' ');
        }).join('').trim();
        const ops = await sheet.getOperatorList();
        const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
        const hasImages = ops.fnArray.some(op => imageOps.has(op));
        pages.push({page,text,hasImages,needsVisual:!text || hasImages,layoutReviewRecommended:true});
        for (const a of await sheet.getAnnotations()) {
          const href = readableUrl(a.url ?? a.unsafeUrl, url);
          if (href) links.set(href, {url:href,page});
        }
        for (const link of extractLinks(text, url)) links.set(link.url,{...link,page});
        sheet.cleanup();
      }
      return {format:'pdf',pageCount:doc.numPages,pages,links:[...links.values()],needsVisual:pages.some(p=>p.needsVisual)};
    } finally { await task.destroy(); }
  }
  if (/\.docx$/i.test(fileName) || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = (await import('mammoth')).default;
    let images = 0;
    const {value, messages} = await mammoth.convertToHtml({buffer:bytes}, {convertImage:mammoth.images.imgElement(async()=>{images++;return {src:'image-needs-visual-review'};})});
    return {format:'docx',pageCount:null,sections:[{text:cleanText(value).join('\n')}],links:extractLinks(value,url),needsVisual:images>0,layoutReviewRecommended:true,warnings:messages.map(m=>m.message)};
  }
  if (type.startsWith('text/') || /\.(txt|csv|tsv|ics|json|xml|md)$/i.test(fileName) || /application\/(json|xml)/.test(type)) {
    const text = bytes.toString('utf8');
    return {format:type || 'text',pageCount:1,pages:[{page:1,text}],links:extractLinks(text,url),needsVisual:false};
  }
  return {format:type || 'binary',pageCount:null,pages:[],links:[],needsVisual:true,note:'Originalen er bevart. Åpne den med et egnet verktøy; dette er ikke en lesekvittering.'};
}

export async function renderPdfPages(bytes, outDir, pageNumbers) {
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
  const {createCanvas}=await import('@napi-rs/canvas');
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});const doc=await task.promise;
  mkdirSync(outDir,{recursive:true});const paths=[];
  try{for(const number of pageNumbers??Array.from({length:doc.numPages},(_,i)=>i+1)){
    if(!Number.isInteger(number)||number<1||number>doc.numPages)throw Error('Ugyldig PDF-side.');
    const page=await doc.getPage(number),viewport=page.getViewport({scale:1.6}),canvas=createCanvas(Math.ceil(viewport.width),Math.ceil(viewport.height));
    await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    const path=join(outDir,`page-${number}.png`);writeFileSync(path,canvas.toBuffer('image/png'));paths.push(path);page.cleanup();
  }return paths;}finally{await task.destroy();}
}

export function createResources({dataDir, store, fetcher = fetch, extract = extractDocument, clock = Date.now}) {
  const dir = join(dataDir,'resources'); mkdirSync(dir,{recursive:true});
  const key = loadKey(dataDir), index = join(dir,'index.enc');
  const state = existsSync(index) ? JSON.parse(decrypt(readFileSync(index),key).toString('utf8')) : {items:{}};
  const save = () => {writeFileSync(index+'.tmp',encrypt(Buffer.from(JSON.stringify(state)),key));renameSync(index+'.tmp',index);};
  const now = () => new Date(clock()).toISOString();
  const missingUrlNote = item => item.nativeId
    ? 'Kilden oppga fil-ID uten nedlastingslenke. Observer lenken i den eksisterende kildefanen før filhenting.'
    : 'Ingen fil-ID eller nedlastingslenke er observert. Dette er en vedleggsindikator; kontroller innlegget i kildefanen før du antar at en original mangler.';
  let reclassified=false;
  for(const item of Object.values(state.items))if(item.status==='error'&&!item.url&&!item.sha256&&/bare fil-ID/.test(item.error??'')) {
    Object.assign(item,{status:'needs_browser',error:missingUrlNote(item),retryAt:null,authRequired:false});reclassified=true;
  }
  for(const item of Object.values(state.items))if(item.status==='error'&&item.error===LOGIN_PAGE_ERROR) {
    Object.assign(item,{status:'needs_browser',retryAt:null,authRequired:true});reclassified=true;
  }
  for(const item of Object.values(state.items))if(item.status==='ready'&&item.sha256&&/text\/html/i.test(item.mimeType)&&/\.(?:pdf|docx|xlsx|pptx)$/i.test(item.fileName)) {
    try {
      const response=inspectOriginalResponse(decrypt(readFileSync(join(dir,item.sha256+'.enc')),key),item);
      if(response.error){Object.assign(item,{status:'needs_browser',error:response.error,authRequired:response.requiresLogin,retryAt:null});reclassified=true;}
    } catch {Object.assign(item,{status:'error',error:'Originalcachen kunne ikke leses.',authRequired:false,retryAt:now()});reclassified=true;}
  }
  if(reclassified)save();
  // Eldre tilgangsfeil får samme behandling som nye: hentes av utvidelsen uten å vente på tjenestens backoff.
  for (const item of Object.values(state.items)) if (item.status === 'error' && /HTTP 40[13]\b/.test(item.error ?? '') && item.authRequired === undefined) { item.authRequired = true; item.retryAt = now(); }
  const get = id => { const item = state.items[id]; if(!item)throw Error('Ukjent ressurs.');return item; };
  const summary = item => {const {url,extraction,...rest}=item;return {...rest,url,extraction:extraction?{format:extraction.format,pageCount:extraction.pageCount,needsVisual:extraction.needsVisual,links:extraction.links.length}:null};};
  function register({source,externalId,url,fileName,mimeType,nativeId,version,parentId,depth=0,fetchAutomatically=true}) {
    const href = readableUrl(url);
    const id = digest(JSON.stringify([source,nativeId || href || `${externalId}:${fileName}`,version || ''])).slice(0,32);
    const prior = state.items[id];
    if(prior) {
      if(prior.refs.includes(externalId) && (!href || href===prior.url))return summary(prior);
      prior.refs = [...new Set([...prior.refs,externalId])];
      if (href && href !== prior.url) {prior.url=href;if(prior.status==='error'||prior.status==='needs_browser'&&fetchAutomatically){prior.retryAt=null;prior.status='queued';}}
      save(); return summary(prior);
    }
    const item = {id,source,refs:[externalId],url:href,fileName:basename(fileName || (href?new URL(href).pathname.split('/').at(-1):'') || 'original'),mimeType:mimeType || '',nativeId:nativeId || null,version:version || null,parentId:parentId || null,depth,status:href && fetchAutomatically?'queued':'needs_browser',createdAt:now(),attempts:0};
    state.items[id]=item;save();return summary(item);
  }
  function discover(item) {
    const found = [];
    const messages = item.detail?.messages ?? [];
    for (const file of [...(item.attachments ?? []),...messages.flatMap(m=>m.attachments ?? [])]) {
      if(file.name==='vedlegg' && !file.id && !file.url)continue;
      found.push(register({source:item.source,externalId:item.externalId,url:file.url,fileName:file.name,mimeType:file.mimeType,nativeId:file.id,version:file.version}));
    }
    const body = [item.text,...messages.map(m=>m.text),...(item.comments ?? []).map(c=>c.text)].join('\n');
    for (const link of extractLinks(body,item.source==='vigilo'?'https://web-parent.prod.vigilo-oas.no/':'https://spond.com/')) {
      if(found.some(f=>f.url===link.url))continue;
      // Links are queued for deliberate reading. GET can also perform an action;
      // only explicit source attachments are downloaded without agent selection.
      found.push(register({source:item.source,externalId:item.externalId,url:link.url,fetchAutomatically:false}));
    }
    return found;
  }
  const inflight = new Map();
  async function accept(id, bytes, meta={}) {
    const item=get(id);
    if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_BYTES)throw Error('Originalen er tom eller større enn 20 MB; bruk direkte filhenting.');
    const response=inspectOriginalResponse(bytes,{...item,...meta});
    if(response.error) {
      Object.assign(item,{status:'needs_browser',error:response.error,retryAt:null,authRequired:response.requiresLogin});save();
      throw Error(response.error);
    }
    const sha256=digest(bytes), path=join(dir,sha256+'.enc');
    if(!existsSync(path))writeFileSync(path,encrypt(bytes,key));
    let extraction;
    const cache=join(dir,sha256+'.text.enc');
    if(existsSync(cache))extraction=JSON.parse(decrypt(readFileSync(cache),key).toString('utf8'));
    else {
      try {extraction=await extract(bytes,{...item,...meta});}
      catch(error){extraction={format:'unknown',pageCount:null,pages:[],links:[],needsVisual:true,error:String(error.message).slice(0,300)};}
      writeFileSync(cache,encrypt(Buffer.from(JSON.stringify(extraction)),key));
    }
    if(extraction.requiresLogin) {
      // An anonymous retry (including the portal extension on an external host)
      // cannot read this page. Keep it visible for deliberate browser reading.
      Object.assign(item,{status:'needs_browser',error:LOGIN_PAGE_ERROR,retryAt:null,authRequired:true});save();
      throw Error(LOGIN_PAGE_ERROR);
    }
    Object.assign(item,{authRequired:false,sha256,bytes:bytes.length,mimeType:meta.mimeType || item.mimeType,status:'ready',fetchedAt:now(),extraction,error:null,retryAt:null});save();return summary(item);
  }
  async function retrieve(id, {force=false}={}) {
    if(inflight.has(id))return inflight.get(id);
    const item=get(id);
    if(item.status==='ready'&&!force)return summary(item);
    if(item.authRequired&&!force)return summary(item);
    if(!item.url) {
      Object.assign(item,{status:'needs_browser',error:missingUrlNote(item),retryAt:null,authRequired:false});
      save();return summary(item);
    }
    const work=(async()=>{
      item.attempts++;item.lastAttemptAt=now();save();
      try {
        let url=item.url,response;
        for(let redirects=0;redirects<=5;redirects++) {
          const u=new URL(url);
          if(!/^https?:$/.test(u.protocol) || /^(localhost|127\.|0\.|169\.254\.|\[?::1\]?$)/i.test(u.hostname))throw Error('Lokal adresse er ikke en kildeoriginal.');
          response=await fetcher(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(30000)});
          if([301,302,303,307,308].includes(response.status)){url=readableUrl(response.headers.get('location'),url);if(!url)throw Error('Ugyldig videresending.');continue;}break;
        }
        if(!response.ok)throw Error(`HTTP ${response.status}: originalen må hentes via innlogget kilde ved tilgangsfeil.`);
        if(Number(response.headers.get('content-length'))>MAX_BYTES)throw Error('Originalen overstiger 20 MB; bruk direkte filhenting.');
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>MAX_BYTES)throw Error('Originalen overstiger 20 MB.');chunks.push(chunk);}
        return await accept(id,Buffer.concat(chunks),{mimeType:response.headers.get('content-type') || item.mimeType,url});
      } catch(error){
        item.error=String(error.message).slice(0,400);
        const loginPage=item.error===LOGIN_PAGE_ERROR;
        const wrongOriginal=loginPage||item.error==='Kilden returnerte HTML, ikke den forventede originalfilen.';
        item.status=wrongOriginal?'needs_browser':'error';
        // Tilgangsfeil (401/403) kan tjenesten ikke løse selv: utvidelsen henter med sidens innlogging med en gang, og tjenesten prøver ikke på nytt.
        item.authRequired=loginPage||/HTTP 40[13]\b/.test(item.error);
        item.retryAt=wrongOriginal?null:item.authRequired?now():new Date(clock()+Math.min(24,2**item.attempts)*3600000).toISOString();
        save();return summary(item);
      }
    })().finally(()=>inflight.delete(id));
    inflight.set(id,work);return work;
  }
  function read(id) {const item=get(id);return structuredClone({...item,document:item.sha256?store.documentStatus(item.sha256):null});}
  function bytes(id){const item=get(id);if(!item.sha256)throw Error('Originalen er ikke hentet.');return decrypt(readFileSync(join(dir,item.sha256+'.enc')),key);}
  function attach(id,rawId){const item=get(id);return store.addAttachment(rawId,{fileName:item.fileName,mimeType:item.mimeType,bytes:bytes(id)});}
  function follow(id,urls){const item=get(id);if(!item.extraction)throw Error('Les ressursen først.');return urls.map(url=>{
    const link=item.extraction.links.find(link=>link.url===url);if(!link)throw Error('Lenken finnes ikke i denne originalen.');
    return register({source:item.source,externalId:item.refs[0],url,parentId:id,depth:item.depth+1,fetchAutomatically:false});
  });}
  function list({externalId,status}={}){return Object.values(state.items).filter(item=>(!externalId||item.refs.some(ref=>sourceIdentity(item.source,ref)===sourceIdentity(item.source,externalId)))&&(!status||item.status===status)).map(summary);}
  let running=false;
  async function tick(){if(running)return;running=true;try{for(const item of Object.values(state.items).filter(item=>item.status==='queued'||item.status==='error'&&item.url&&!item.authRequired&&Date.parse(item.retryAt)<=clock()).slice(0,4))await retrieve(item.id);}finally{running=false;}}
  return {register,discover,retrieve,accept,read,bytes,attach,follow,list,tick,summary:()=>({total:Object.keys(state.items).length,ready:list({status:'ready'}).length,errors:list({status:'error'}).map(i=>({id:i.id,fileName:i.fileName,error:i.error})),running})};
}
