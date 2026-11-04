import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createResources, collectorResourceRequests } from '../src/resources.mjs';
import { encrypt, decrypt, loadKey } from '../src/crypto.mjs';

const store = { documentStatus: (sha256) => ({ sha256, needsReading: true }), addAttachment: () => ({}) };

test('HTTP 200 login pages wait for browser reading across retries and restart; actual content can recover',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-resource-login-page-'));
  try {
    let gets=0,clock=Date.parse('2026-10-17T07:00:00Z');
    const options={dataDir:dir,store,clock:()=>clock,fetcher:async()=>{
      gets++;return new Response('<html><body><input type="password">Sign in</body></html>',{headers:{'content-type':'text/html'}});
    }};
    let vault=createResources(options);
    const item=vault.register({source:'vigilo',externalId:'post:1',url:'https://classroom.google.com/c/example'});
    const failed=await vault.retrieve(item.id);
    assert.equal(failed.status,'needs_browser');assert.equal(failed.authRequired,true);assert.equal(failed.retryAt,null);
    assert.equal(failed.sha256,undefined,'login HTML must never become the original');
    clock+=7*86400000;await vault.tick();assert.equal(gets,1);
    // Reproduce an existing persisted error from before this fix.
    const path=join(dir,'resources','index.enc'),key=loadKey(dir);
    const old=JSON.parse(decrypt(readFileSync(path),key));
    Object.assign(old.items[item.id],{status:'error',authRequired:false,retryAt:new Date(clock-1).toISOString()});
    writeFileSync(path,encrypt(Buffer.from(JSON.stringify(old)),key));
    vault=createResources(options);await vault.tick();assert.equal(gets,1);
    assert.equal(vault.read(item.id).status,'needs_browser');
    vault=createResources(options);assert.equal(vault.read(item.id).retryAt,null,'migration persists');
    await assert.rejects(vault.accept(item.id,Buffer.from('<html><input type="password"></html>'),{mimeType:'text/html'}),/innloggingsside/);
    assert.equal(vault.read(item.id).status,'needs_browser');
    const recovered=await vault.accept(item.id,Buffer.from('Actual assignment'),{mimeType:'text/plain'});
    assert.equal(recovered.status,'ready');assert.equal(recovered.authRequired,false);
    assert.match(vault.read(item.id).extraction.pages[0].text,/Actual assignment/);
    assert.equal(vault.read(item.id).document.needsReading,true,'fetching is not a reading receipt');
  } finally {assert.ok(dir.startsWith(join(tmpdir(),'familien-resource-login-page-')));rmSync(dir,{recursive:true,force:true});}
});

test('an attachment hint without a URL is browser work, not a failed network download',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-resource-hint-'));
  try {
    let gets=0;
    const vault=createResources({dataDir:dir,store,fetcher:async()=>{gets++;throw Error('No URL should be fetched');}});
    const hint=vault.register({source:'facebook',externalId:'facebook:post:1',fileName:'attachment 1'});
    const first=await vault.retrieve(hint.id);
    assert.equal(first.status,'needs_browser');
    assert.equal(first.attempts,0);
    assert.match(first.error,/Ingen fil-ID/);
    await vault.retrieve(hint.id);await vault.tick();
    assert.equal(vault.read(hint.id).attempts,0);
    assert.equal(gets,0);
    const native=vault.register({source:'spond',externalId:'post:2',nativeId:'actual-file',fileName:'plan.pdf'});
    assert.match((await vault.retrieve(native.id)).error,/fil-ID/);
    assert.equal(vault.read(native.id).status,'needs_browser');
    const resolved=vault.register({source:'spond',externalId:'post:2',nativeId:'actual-file',fileName:'plan.pdf',url:'https://example.com/plan.pdf'});
    assert.equal(resolved.status,'queued');
    assert.equal(resolved.id,native.id);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('tilgangsfeil (401) hentes av utvidelsen med en gang og gir ikke voksende backoff eller nye serverforsøk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-resource-auth-'));
  try {
    let gets = 0, clock = Date.parse('2026-09-29T10:00:00Z');
    const vault = createResources({ dataDir: dir, store, clock: () => clock, fetcher: async () => { gets++; return new Response('nei', { status: 401 }); } });
    const [item] = vault.discover({ source: 'vigilo', externalId: 'vigilo:news:1', attachments: [{ id: 'f1', name: 'ukeplan.pdf', url: 'https://web-parent.prod.vigilo-oas.no/api/x' }] });
    const failed = await vault.retrieve(item.id);
    assert.equal(failed.status, 'error');
    assert.equal(failed.authRequired, true);
    assert.equal(failed.retryAt, new Date(clock).toISOString(), 'ingen ventetid før utvidelsen får prøve');
    await vault.tick();
    assert.equal(gets, 1, 'tjenesten prøver ikke på nytt uten innlogging');
    await vault.retrieve(item.id);
    assert.equal(gets,1,'agentens ordinære resource-fetch gjenbruker en kjent tilgangsfeil');
    await vault.retrieve(item.id,{force:true});
    assert.equal(gets,2,'en eksplisitt ny kontroll etter endret tilgang er fortsatt mulig');
    // Vanlige feil får fortsatt økende backoff og prøves av tjenesten.
    const other = vault.register({ source: 'vigilo', externalId: 'vigilo:news:2', nativeId: 'f2', fileName: 'b.pdf', url: 'https://example.com/b.pdf' });
    const flaky = createResources({ dataDir: dir, store, clock: () => clock, fetcher: async () => new Response('feil', { status: 500 }) });
    const failedOther = await flaky.retrieve(other.id);
    assert.equal(failedOther.authRequired, false);
    assert.ok(Date.parse(failedOther.retryAt) > clock + 3600000 - 1000);
    // Etter at utvidelsen har levert filen er feilen borte.
    const ok = createResources({ dataDir: dir, store, clock: () => clock });
    const received = await ok.accept(item.id, Buffer.from('%PDF-1.4\n%%EOF'), { mimeType: 'application/pdf' });
    assert.equal(received.status, 'ready');
    assert.equal(ok.read(item.id).authRequired, false);
  } finally { assert.ok(dir.includes('familien-resource-auth-')); rmSync(dir, { recursive: true, force: true }); }
});

test('new native originals cannot be starved by old external access failures or another portal',()=>{
  const now=Date.parse('2026-10-26T08:00:00Z');
  const items=Array.from({length:9},(_,i)=>({id:`old-${i}`,source:i<5?'spond':'vigilo',url:`https://docs.google.com/document/d/${i}/edit`,status:'error',authRequired:true,createdAt:'2026-09-01T00:00:00Z'}));
  items.push({id:'new-pdf',source:'vigilo',url:'https://web-parent.prod.vigilo-oas.no/api/posts/p/attachments/f',nativeId:'f',status:'error',authRequired:true,createdAt:'2026-10-26T07:27:00Z'});
  const selected=collectorResourceRequests(items,{now});
  assert(selected.some(item=>item.id==='new-pdf'));
  assert.equal(selected.filter(item=>item.source==='spond').length,4);
  assert.equal(selected.filter(item=>item.source==='vigilo').length,4);
  const later=collectorResourceRequests(items,{now:now+3600000});
  assert.notDeepEqual(later.filter(item=>item.source==='spond'),selected.filter(item=>item.source==='spond'),'old failures also get a fair turn');
  assert(selected.every(item=>Object.keys(item).join(',')==='id,source,url'));
});

test('resource lookup reuses a native post ID with or without UUID separators',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-resource-identity-'));
  try{
    const vault=createResources({dataDir:dir,store});
    const id='vigilo:news:9ea103df-0eca-8729-5258-80a879b129a6';
    vault.register({source:'vigilo',externalId:id,nativeId:'f',fileName:'plan.pdf'});
    assert.equal(vault.list({externalId:id.replaceAll('-','')}).length,1);
    assert.equal(vault.list({externalId:'vigilo:news:967bc19ba8efd89995d8b90fd21fe6ab'}).length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
