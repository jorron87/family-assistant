import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import {createResources,extractDocument,extractLinks,renderPdfPages} from '../src/resources.mjs';

function pdf(){const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',null,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',null,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];for(const [i,text] of [[3,'First page'],[5,'Second page']]){const stream=`BT /F1 12 Tf 30 350 Td (${text}) Tj ET`;objects[i]=`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;}let out='%PDF-1.4\n',offsets=[0];objects.forEach((object,i)=>{offsets.push(out.length);out+=`${i+1} 0 obj\n${object}\nendobj\n`;});const start=out.length;out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return Buffer.from(out);}

test('extracts every PDF page, preserves links, and renders selected pages only',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-resource-pdf-'));
  try{const result=await extractDocument(pdf(),{mimeType:'application/octet-stream'});assert.equal(result.pageCount,2);assert.match(result.pages[0].text,/First page/);assert.match(result.pages[1].text,/Second page/);assert.equal(result.needsVisual,false);const paths=await renderPdfPages(pdf(),dir,[2]);assert.equal(paths.length,1);assert.ok(readFileSync(paths[0]).length>1000);}finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\familien-resource-'));rmSync(dir,{recursive:true,force:true});}
});
test('HTML, Word, text and unknown originals keep content and linked resources',async()=>{
  assert.deepEqual(extractLinks('<a href="../plan.docx?download=1&amp;v=2">plan</a>','https://school.example/news/1'),[{url:'https://school.example/plan.docx?download=1&v=2'}]);
  const html=await extractDocument(Buffer.from('<html><main>Tur tirsdag<a href="https://school.example/a">Mer</a></main></html>'),{url:'https://school.example'});assert.equal(html.links.length,1);assert.match(html.pages[0].text,/Tur tirsdag/);
  const zip=new JSZip();zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word original</w:t></w:r></w:p></w:body></w:document>');const docx=await extractDocument(await zip.generateAsync({type:'nodebuffer'}),{fileName:'plan.docx'});assert.match(docx.sections[0].text,/Word original/);assert.equal(docx.pageCount,null,'never invent Word pagination');
  const image=await extractDocument(Buffer.from([137,80,78,71]),{mimeType:'image/png'});assert.equal(image.needsVisual,true);
});
test('resource vault caches identical versions, encrypts originals, preserves errors and does not follow arbitrary links automatically',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-resource-vault-'));let gets=0,extracts=0;const docs={documentStatus:sha=>({sha256:sha,needsReading:true}),addAttachment:(rawId,data)=>({rawId,name:data.fileName})};
  try{const create=()=>createResources({dataDir:dir,store:docs,fetcher:async()=>{gets++;return new Response('<html><main>Private original <a href="https://example.com/more">more</a></main></html>',{headers:{'content-type':'text/html'}});},extract:async(...args)=>{extracts++;return extractDocument(...args);}});let vault=create();
    const found=vault.discover({source:'vigilo',externalId:'post:1',attachments:[{id:'file1',name:'plan.html',url:'https://example.com/plan'}],text:'See https://example.com/register'});assert.equal(found.length,2);assert.equal(found[1].status,'needs_browser');
    const first=await vault.retrieve(found[0].id);await vault.retrieve(first.id);assert.equal(gets,1);assert.equal(extracts,1);assert.equal(vault.read(first.id).document.needsReading,true);assert.equal(readFileSync(join(dir,'resources',first.sha256+'.enc')).includes(Buffer.from('Private original')),false);
    vault=create();await vault.retrieve(first.id);assert.equal(gets,1,'restart reuses persisted version');assert.equal(vault.follow(first.id,['https://example.com/more'])[0].parentId,first.id);assert.throws(()=>vault.follow(first.id,['https://unrelated.example']),/finnes ikke/);assert.equal(vault.attach(first.id,'raw1').rawId,'raw1');
    const same=vault.register({source:'vigilo',externalId:'post:2',nativeId:'file1',url:'https://example.com/plan?newSignature=1',fileName:'plan.html'});assert.equal(same.id,first.id);assert.equal(same.status,'ready');
    const pending=vault.register({source:'spond',externalId:'post:3',nativeId:'file2',fileName:'original.pdf'});assert.equal(pending.status,'needs_browser');
    const resolved=vault.register({source:'spond',externalId:'post:3',nativeId:'file2',url:'https://example.com/original.pdf',fileName:'original.pdf'});assert.equal(resolved.id,pending.id);assert.equal(resolved.status,'queued');
  }finally{assert.ok(dir.includes('familien-resource-vault-'));rmSync(dir,{recursive:true,force:true});}
});
