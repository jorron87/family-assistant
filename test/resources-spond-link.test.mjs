import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createResources} from '../src/resources.mjs';

test('native Spond post links reuse an archived group file without changing IDs, age or reading receipts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-spond-link-'));
 let requests=0,extracts=0,clock=Date.parse('2026-01-01T10:00:00Z');
 const store={documentStatus:sha256=>({sha256,needsReading:true})};
 const options={dataDir:dir,store,clock:()=>clock,fetcher:async()=>{requests++;return new Response('Unauthorized',{status:401});},extract:async()=>{extracts++;return {format:'text',pages:[{page:1,text:'Synthetic original'}],pageCount:1,links:[]};}};
 const fileId='A'.repeat(32),attachmentId='B'.repeat(32);
 try {
  let vault=createResources(options);
  const post=vault.register({source:'spond',externalId:'spond:post:sample',nativeId:attachmentId,url:`https://spond.com/storage/upload/group/${fileId}`,fileName:'manual.txt'});
  assert.equal((await vault.retrieve(post.id)).authRequired,true);
  const file=vault.register({source:'spond',externalId:`spond:files:${fileId}`,nativeId:fileId,url:'https://example.com/actual-original',fileName:'different-name.txt'});
  await vault.accept(file.id,Buffer.from('Synthetic original'),{mimeType:'text/plain'});
  const fetchedAt=vault.read(file.id).fetchedAt;
  clock+=86400000;vault=createResources(options);await vault.tick();
  const recovered=vault.read(post.id);
  assert.equal(recovered.id,post.id);assert.equal(recovered.nativeId,attachmentId);
  assert.equal(recovered.status,'ready');assert.equal(recovered.authRequired,false);
  assert.equal(recovered.sha256,vault.read(file.id).sha256);assert.equal(recovered.fetchedAt,fetchedAt);
  assert.equal(recovered.reusedFromResourceId,file.id);assert.equal(recovered.document.needsReading,true);
  assert.equal(requests,1);assert.equal(extracts,1);
  assert.equal(vault.bytes(post.id).toString(),'Synthetic original');
  for(const [source,url,version] of [
   ['spond',`https://spond.com/storage/upload/group/${'C'.repeat(32)}`,null],
   ['spond',`https://spond.com/storage/upload/group/${fileId}?version=2`,null],
   ['spond',`https://spond.com.evil.example/storage/upload/group/${fileId}`,null],
   ['vigilo',`https://spond.com/storage/upload/group/${fileId}`,null],
   ['spond',`https://spond.com/storage/upload/group/${fileId}`,'new-version']
  ]) {
   const unrelated=vault.register({source,externalId:'other',url,version,fileName:'different-name.txt'});
   assert.equal((await vault.retrieve(unrelated.id)).status,'error','filename, other source, URL or version must not authorize reuse');
  }
 }finally{assert.ok(dir.startsWith(join(tmpdir(),'family-spond-link-')));rmSync(dir,{recursive:true,force:true});}
});
