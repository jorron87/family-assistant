import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import '../config/vigilo-keepalive/collector-core.js';
import {normalizeSpondPosts} from '../src/collector.mjs';
import {createResources} from '../src/resources.mjs';

test('title-only Spond inline media reaches the original queue through the extension whitelist',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-inline-media-'));
 try {
  const post={id:'A'.repeat(32),groupId:'B'.repeat(32),title:'Synthetic poster',body:'',timestamp:'2026-01-01T10:00:00Z',attachments:[],media:[{url:'https://spond.com/images/abc/first.jpeg',type:'IMAGE',width:1200,height:1800,authorization:'never-relay',uploader:{privateField:'never-relay'}}]};
  const relay=globalThis.FamilienCollectorCore.extract.posts([post]);
  assert.equal(JSON.stringify(relay).includes('never-relay'),false);
  const [normalized]=normalizeSpondPosts(relay);
  assert.equal(normalized.attachments.length,1);
  assert.equal(normalized.attachments[0].url,post.media[0].url);
  assert.equal(normalized.attachments[0].mimeType,'image/jpeg');
  const vault=createResources({dataDir:dir,store:{documentStatus:()=>({needsReading:true})}});
  const [resource]=vault.discover(normalized);assert.equal(resource.status,'queued');
  assert.equal(vault.read(resource.id).document,null,'discovery is never an image reading receipt');
  const again=normalizeSpondPosts(globalThis.FamilienCollectorCore.extract.posts([{...post,media:[{...post.media[0],width:600,height:900}]}]))[0];
  assert.equal(again.token,normalized.token,'display dimensions do not change the original');
  const changed=normalizeSpondPosts(globalThis.FamilienCollectorCore.extract.posts([{...post,media:[{...post.media[0],url:'https://spond.com/images/def/second.jpeg'}]}]))[0];
  assert.notEqual(changed.token,normalized.token,'a changed photo reopens review');
  assert.equal(normalizeSpondPosts([{...post,media:undefined}])[0].attachments.length,0);
 }finally{assert.ok(dir.startsWith(join(tmpdir(),'family-inline-media-')));rmSync(dir,{recursive:true,force:true});}
});
