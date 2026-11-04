import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectOriginalResponse} from '../src/original-response.mjs';
import {createResources,extractDocument} from '../src/resources.mjs';
import {createStore} from '../src/store.mjs';
import {encrypt,decrypt,loadKey} from '../src/crypto.mjs';
import {createHash} from 'node:crypto';

const html=Buffer.from('<!DOCTYPE html><html><head><link href="https://nb-no.facebook.com/login.php" rel="canonical"></head><body>Log in</body></html>');
test('response bytes identify login HTML before a DOCX filename or MIME type',async()=>{
  const result=await extractDocument(html,{fileName:'plan.docx',mimeType:'application/octet-stream'});
  assert.equal(result.format,'html');assert.equal(result.requiresLogin,true);
  assert.match(inspectOriginalResponse(html,{fileName:'plan.pdf'}).error,/innloggingsside/);
  assert.equal(inspectOriginalResponse(Buffer.from('PK actual binary'),{fileName:'plan.docx',mimeType:'text/html'}).isHtml,false);
  assert.equal(inspectOriginalResponse(Buffer.from('<html><article>Actual page</article></html>'),{fileName:'source.html'}).error,null);
  assert.match(inspectOriginalResponse(Buffer.from('<html>Access denied</html>'),{fileName:'plan.docx'}).error,/HTML/);
});

test('resource rejects fake originals and reclassifies an old cached ready response without fetching',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-original-resource-'));let gets=0;
  const options={dataDir:dir,store:{documentStatus:()=>({needsReading:true})},fetcher:async()=>{gets++;return new Response(html,{headers:{'content-type':'text/html'}});}};
  try{
    let vault=createResources(options);const item=vault.register({source:'facebook',externalId:'facebook:post:1',fileName:'file.docx',url:'https://example.test/file'});
    const result=await vault.retrieve(item.id);assert.equal(result.status,'needs_browser');assert.equal(result.authRequired,true);assert.equal(result.sha256,undefined);
    await vault.tick();await vault.retrieve(item.id);assert.equal(gets,1);
    const key=loadKey(dir),file=join(dir,'resources','index.enc'),s=JSON.parse(decrypt(readFileSync(file),key));const sha=createHash('sha256').update(html).digest('hex');
    writeFileSync(join(dir,'resources',sha+'.enc'),encrypt(html,key));
    Object.assign(s.items[item.id],{status:'ready',mimeType:'text/html',sha256:sha,extraction:{format:'unknown',links:[]}});writeFileSync(file,encrypt(Buffer.from(JSON.stringify(s)),key));
    vault=createResources(options);assert.equal(vault.read(item.id).status,'needs_browser');assert.equal(gets,1);assert.deepEqual(vault.bytes(item.id),html,'diagnostic bytes are preserved');
    await vault.accept(item.id,Buffer.from('PK recovered original'),{mimeType:'application/octet-stream'});assert.equal(vault.read(item.id).status,'ready');
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-original-resource-')));rmSync(dir,{recursive:true,force:true});}
});

test('legacy bad attachments stay preserved, cannot be read or Drive-acknowledged, and do not satisfy the expected original',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-original-store-'));
  try{
    let store=createStore(dir);const raw=store.upsertRaw({source:'facebook',externalId:'facebook:post:1',title:'Info',body:'File attached',expectedOriginals:['file.docx']}).item;
    assert.throws(()=>store.addAttachment(raw.id,{fileName:'file.docx',bytes:html}),/innloggingsside/);
    const a=store.addAttachment(raw.id,{fileName:'file.docx',bytes:Buffer.from('PK legacy placeholder')});
    const key=loadKey(dir),archive=join(dir,'archive.json.enc'),s=JSON.parse(decrypt(readFileSync(archive),key));const legacy=s.rawItems[raw.id].attachments[0];legacy.sha256=createHash('sha256').update(html).digest('hex');legacy.size=html.length;
    writeFileSync(join(dir,'attachments',a.id+'.enc'),encrypt(html,key));writeFileSync(archive,encrypt(Buffer.from(JSON.stringify(s)),key));
    store=createStore(dir);assert.match(store.getAttachment(raw.id,a.id).attachment.contentError,/innloggingsside/);assert.deepEqual(store.getAttachment(raw.id,a.id).bytes,html);
    assert.throws(()=>store.reviewDocument(raw.id,a.id,{pageCount:1,pages:[{page:1,text:'Login'}],method:'text'}),/innloggingsside/);
    assert.throws(()=>store.linkDrive(raw.id,a.id,'https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view'),/innloggingsside/);
    const missing=store.completionReport().missingDrive.filter(i=>i.rawId===raw.id);assert(missing.some(i=>i.kind==='source-original'));assert(!missing.some(i=>i.kind==='attachment'));
    store.addAttachment(raw.id,{fileName:'file.docx',bytes:Buffer.from('PK restored file')});assert(!store.completionReport().missingDrive.some(i=>i.rawId===raw.id&&i.kind==='source-original'));
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-original-store-')));rmSync(dir,{recursive:true,force:true});}
});
