import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('Sesum is opt-in, accepts only local/extension workers, and stays off kiosk ports',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'family-sesum-api-')),port=14947,api=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:resolve('.'),env:{...process.env,FAMILIEN_PORT:String(port),FAMILIEN_DATA_DIR:dir,FAMILIEN_CONFIG_DIR:resolve('test/config'),FAMILIEN_NO_DISPATCH:'1',CODEX_HOME:dir},stdio:'ignore',windowsHide:true});
  try{
    for(let i=0;i<150;i++){try{if((await fetch(api+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
    const status=await(await fetch(api+'/api/shopping/sesum/status')).json();assert.equal(status.enabled,false);
    const work=await(await fetch(api+'/api/shopping/sesum/work?peek=1')).json();assert.deepEqual(work.jobs,[]);
    assert.deepEqual(await(await fetch(api+'/api/shopping/sesum/offers')).json(),{items:[]});
    const placement=await(await fetch(api+'/api/shopping/sesum/placement')).json();assert.deepEqual(placement.items,[]);assert.deepEqual(placement.families,[]);assert.ok(placement.familySetFingerprint);
    assert.equal((await fetch(api+'/api/shopping/sesum/placement',{headers:{Origin:'chrome-extension://'+'a'.repeat(32)}})).status,403);
    assert.equal((await fetch(api+'/api/shopping/sesum/offers',{headers:{Origin:'chrome-extension://'+'a'.repeat(32)}})).status,403);
    assert.equal((await fetch(api+'/api/shopping/sesum/work',{headers:{Origin:'https://www.sesum.no'}})).status,403);
    assert.equal((await fetch(api+'/api/shopping/sesum/work',{headers:{Origin:'chrome-extension://'+'a'.repeat(32)}})).status,200);
    const post=(path,headers)=>fetch(api+path,{method:'POST',headers,body:'{}'});
    assert.equal((await post('/api/shopping/sesum/receive',{'Content-Type':'application/json'})).status,403);
    assert.equal((await post('/api/shopping/sesum/receive',{'Content-Type':'text/plain','X-Family-Request':'1'})).status,403);
    assert.equal((await post('/api/shopping/sesum/refresh',{'Content-Type':'application/json','X-Family-Request':'1',Origin:'chrome-extension://'+'a'.repeat(32)})).status,403);
    assert.equal((await fetch(`http://127.0.0.1:${port+1}/api/shopping/sesum/work`)).status,403);
    assert.equal((await fetch(`http://127.0.0.1:${port+1}/api/shopping/sesum/status`)).status,403);
    for(const listener of [port+1,port+2]){
      assert.ok([401,403].includes((await fetch(`http://127.0.0.1:${listener}/api/shopping/sesum/placement`)).status));
      assert.ok([401,403].includes((await fetch(`http://127.0.0.1:${listener}/api/shopping/sesum/offers`)).status));
      assert.ok([401,403,405].includes((await fetch(`http://127.0.0.1:${listener}/api/shopping/sesum/offer-review`,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:'{}'})).status));
    }
    assert.equal((await post('/api/shopping/sesum/offer-review',{'Content-Type':'application/json'})).status,403);
    assert.equal((await post('/api/shopping/sesum/offer-review',{'Content-Type':'application/json','X-Family-Request':'1',Origin:'chrome-extension://'+'a'.repeat(32)})).status,403);
    assert.equal((await post('/api/shopping/sesum/review',{'Content-Type':'application/json','X-Family-Request':'1',Origin:'chrome-extension://'+'a'.repeat(32)})).status,403);
    for(const listener of [port+1,port+2])assert.ok([401,403,405].includes((await fetch(`http://127.0.0.1:${listener}/api/shopping/sesum/review`,{method:'POST',headers:{'Content-Type':'application/json','X-Family-Request':'1'},body:JSON.stringify({status:'blocked',reason:'Unresolved source family membership'})})).status));
  }finally{
    const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;
    assert.ok(dir.startsWith(join(tmpdir(),'family-sesum-api-')));rmSync(dir,{recursive:true,force:true});
  }
});
