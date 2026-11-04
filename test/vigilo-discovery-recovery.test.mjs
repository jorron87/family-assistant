import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';
const children=['Barn En','Barn To','Barn Tre','Barn Fire'].map((firstName,i)=>({id:`00000000-0000-4000-8000-00000000000${i}`,firstName,lastName:'Eksempel'}));
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'familien-discovery-'));try{fn(createStore(dir),dir);}finally{if(!resolve(dir).startsWith(resolve(tmpdir())+'\\'))throw Error('Utrygg opprydding');rmSync(dir,{recursive:true,force:true});}}

test('only failed child supplemental auth scopes are requested again, then cleared by actual success',()=>fixture(store=>{
  store.collectorIngest({source:'vigilo',kind:'children',items:children});
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'meetings',childId:children[1].id,detail:'unauthorized'});
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'registrations',childId:children[0].id,detail:'HTTP 500'});
  const retry=store.collectorConfig().want.supplementalRetries;
  assert.equal(retry.length,1);assert.equal(retry[0].childId,children[1].id);assert.equal(retry[0].section,'meetings');
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'meetings',childId:children[1].id,items:[],complete:true,implementation:'extra-auth-queue-2026-11-04'});
  assert.equal(store.collectorConfig().want.supplementalRetries.length,0);
  assert.equal(store.collectorStatus().supplemental['vigilo:meetings:child2:'].implementation,'extra-auth-queue-2026-11-04');
}));
test('fresh real child inventory resolves only prior collector discovery, persists and leaves content holes',()=>fixture((store,dir)=>{
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'discovery',detail:'unauthorized'});
  store.updateSurface({source:'vigilo',surface:'child3:news',health:'partial',complete:false,blocker:'Original mangler'});
  store.collectorIngest({source:'vigilo',kind:'children',items:children});
  const status=store.collectorStatus().supplemental['vigilo:discovery:all:'];
  assert.equal(status.health,'ok');assert.equal(status.count,4);assert.equal(status.recoveredFrom.detail,'unauthorized');
  assert.equal(store.snapshot().surfaces['vigilo:family:discovery'].blocker,null);
  assert.equal(store.snapshot().surfaces['vigilo:child3:news'].health,'partial');
  assert.equal(store.snapshot().sourceStatus.vigilo?.health,undefined,'inventory is not global coverage');
  assert.equal(createStore(dir).collectorStatus().supplemental['vigilo:discovery:all:'].health,'ok');
}));
test('incomplete or malformed list cannot infer recovery from retained older identities; later error reopens',()=>fixture(store=>{
  store.collectorIngest({source:'vigilo',kind:'children',items:children});
  for(const items of [children.slice(0,3),[...children,{id:'bad',firstName:'bad'}],[]]){
    store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'discovery',detail:'HTTP 401'});
    store.collectorIngest({source:'vigilo',kind:'children',items});
    assert.equal(store.collectorStatus().supplemental['vigilo:discovery:all:'].health,'error');
  }
  store.collectorIngest({source:'vigilo',kind:'children',items:children});
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'discovery',detail:'HTTP 403'});
  assert.equal(store.snapshot().surfaces['vigilo:family:discovery'].health,'partial');
}));
test('manual unresolved discovery is not overwritten by identity-only receipt',()=>fixture(store=>{
  store.updateSurface({source:'vigilo',surface:'family:discovery',health:'partial',blocker:'Klasse må kontrolleres'});
  store.collectorIngest({source:'vigilo',kind:'children',items:children});
  assert.equal(store.snapshot().surfaces['vigilo:family:discovery'].blocker,'Klasse må kontrolleres');
}));
