import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

test('another household with a different child count maps sources and independent homework without example IDs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-custom-'));
 try{
  const store=createStore(dir);
  store.updateProfile({familyName:'Synthetic household',members:[{id:'guardian',name:'Guardian',role:'parent'},{id:'kid-r',name:'Riley',role:'child'},{id:'kid-c',name:'Casey',role:'child'},{id:'kid-o',name:'Offline child',role:'child',vigilo:false}],facts:[]});
  const native='00000000-0000-4000-8000-000000000001';
  store.collectorIngest({source:'vigilo',kind:'children',items:[{id:native,firstName:'Riley',lastName:'Example'}]});
  store.collectorIngest({source:'vigilo',kind:'news',childId:native,complete:true,items:[]});
  assert.equal(store.collectorStatus().children[0].memberId,'kid-r');
  assert.ok(store.reviewQueue().surfaces['vigilo:kid-r:news']);
  const raw=store.upsertRaw({source:'vigilo',externalId:'synthetic-week-plan',title:'Weekly plan',body:'Read a book'}).item;
  const input={title:'Homework',kind:'task',start:'2099-01-05',end:'2099-01-10',task:{category:'homework',visibleFrom:'2099-01-05',dueDate:'2099-01-09',items:[{key:'read',text:'Read a book'}]}};
  const r=store.upsertFinding(raw.id,{...input,canonicalKey:'synthetic:read:kid-r',members:['kid-r']});
  const c=store.upsertFinding(raw.id,{...input,canonicalKey:'synthetic:read:kid-c',members:['kid-c']});
  assert.notEqual(r.id,c.id);
  const offline=store.upsertFinding(raw.id,{...input,canonicalKey:'synthetic:read:kid-o',members:['kid-o']});
  assert.deepEqual(offline.members,['kid-o'],'homework is also personal for children outside Vigilo');
  assert.throws(()=>store.upsertFinding(raw.id,{...input,canonicalKey:'synthetic:shared',members:['kid-r','kid-c']}),/ett barn/);
  const restored=createStore(dir);
  assert.equal(restored.profile().members.length,4);
  assert.equal(restored.collectorStatus().children[0].memberId,'kid-r');
 }finally{assert.ok(dir.startsWith(join(tmpdir(),'family-custom-')));rmSync(dir,{recursive:true,force:true});}
});
