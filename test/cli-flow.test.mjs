import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'node:http';

const run = promisify(execFile);
function syntheticConfig(dir){
  const target=join(dir,'config');mkdirSync(target);
  for(const name of readdirSync('config').filter(name=>name.endsWith('.example.json')))copyFileSync(join('config',name),join(target,name.replace('.example.json','.json')));
  return target;
}

test('shopping-queue and next expose a bounded cohort while full exports every backend row',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-cli-batch-')),config=syntheticConfig(dir);
  const shopping=Array.from({length:8000},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'current-'+i}));
  const data={'/api/shopping/queue':shopping,'/api/phone/inbox':[],'/api/calendar-actions':[],'/api/completion':{complete:false,counts:{shoppingPending:8000}},'/api/review-queue':{items:[]},'/api/activities':{sources:[]},'/api/collector/status':{},'/api/activity-feed':{changedPages:[]}};
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data[req.url]??{}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cli=async(...args)=>JSON.parse((await run(process.execPath,['src/cli.mjs',...args],{env:{...process.env,FAMILIEN_CONFIG_DIR:config,FAMILIEN_API:'http://127.0.0.1:'+server.address().port},maxBuffer:5*1024*1024})).stdout);
  try{
    const view=await cli('shopping-queue');assert.equal(view.shopping.length,20);assert.equal(view.shoppingSummary.total,8000);assert.equal(view.shoppingSummary.shown,20);assert.equal(view.shoppingSummary.remaining,7980);assert.match(view.shoppingSummary.resumeHint,/next/);
    const full=await cli('shopping-queue','--full');assert.equal(full.length,8000);assert.deepEqual(full.at(-1),shopping.at(-1));
    const jobs=await cli('shopping-jobs');assert.equal(jobs.jobs.length,20);assert.equal(jobs.summary.agentJobs.total,8000);assert.equal(jobs.summary.total,8000);
    const oneJob=await cli('shopping-jobs','--id','sesum-product:7999');assert.equal(oneJob.jobs.length,1);assert.deepEqual(oneJob.jobs[0].sourceKeys,['sesum-product:7999']);
    const exact=await cli('shopping-queue','--type','shopping-sesum-placement-review','--id','sesum-product:7999');assert.equal(exact.shopping.length,1);assert.equal(exact.shopping[0].sourceKey,'sesum-product:7999');
    const batch=await cli('batch',JSON.stringify([{cmd:'shopping-queue',args:['--type','shopping-sesum-placement-review','--id','sesum-product:7999']},{cmd:'shopping-queue',args:['--id','sesum-product:7998'],flags:['--full']}]));
    assert.equal(batch.ok,true);assert.equal(batch.results[0].result.shopping.length,1);assert.equal(batch.results[0].result.shopping[0].sourceKey,'sesum-product:7999');assert.deepEqual(batch.results[1].result,[shopping[7998]]);
    const next=await cli('next');assert.equal(next.shopping.length,20);assert.equal(next.work.length,20);assert.equal(next.remaining,8000);assert.equal(next.moreWork,7980);assert.equal(next.counts.shoppingPending,8000);
    assert.equal((await cli('next','--full')).shopping.length,8000);assert.equal(shopping.length,8000);
  }finally{await new Promise(resolve=>server.close(resolve));assert.ok(dir.startsWith(join(tmpdir(),'familien-cli-batch-')));rmSync(dir,{recursive:true,force:true});}
});

test('Sesum candidate summaries are bounded and exact source reads preserve the raw identity evidence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-cli-candidates-')),config=syntheticConfig(dir),seen=[];
  const rows=Array.from({length:30},(_,i)=>({sourceKey:'sesum:KIWI:'+i,sourceFingerprint:'source-'+i,status:'pending',source:{name:'Synthetic food '+i},familyIds:['family-a'],donors:[{productKey:'kassal:KIWI:'+i,product:{ingredients:'Actual synthetic full ingredient label'}}]}));
  const server=createServer((req,res)=>{const query=new URL(req.url,'http://local.test').searchParams;seen.push(query);res.setHeader('content-type','application/json');res.end(JSON.stringify(query.has('sourceKey')?rows.filter(row=>row.sourceKey===query.get('sourceKey')):rows));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cli=async(...args)=>JSON.parse((await run(process.execPath,['src/cli.mjs',...args],{env:{...process.env,FAMILIEN_CONFIG_DIR:config,FAMILIEN_API:'http://127.0.0.1:'+server.address().port}})).stdout);
  try{
    const view=await cli('shopping-sesum-candidates');assert.equal(view.items.length,20);assert.equal(view.total,30);assert.equal(view.remaining,10);assert.equal(view.items[0].donorCount,1);assert.equal(view.items[0].donors,undefined);
    const exact=await cli('shopping-sesum-candidates','family-a','--source','sesum:KIWI:25');assert.deepEqual(exact,[rows[25]]);assert.ok(seen.some(q=>q.get('familyId')==='family-a'&&q.get('sourceKey')==='sesum:KIWI:25'));
    assert.deepEqual(await cli('shopping-sesum-candidate','sesum:KIWI:25'),[rows[25]]);assert.deepEqual(await cli('shopping-sesum-candidates','--source','sesum:KIWI:'),[]);
    const batch=await cli('batch',JSON.stringify([{cmd:'shopping-sesum-candidates',args:['family-a','--source','sesum:KIWI:26']},{cmd:'shopping-sesum-candidates',args:['--source','sesum:KIWI:27'],flags:['--full']} ]));
    assert.equal(batch.ok,true);assert.deepEqual(batch.results[0].result,[rows[26]]);assert.deepEqual(batch.results[1].result,[rows[27]]);assert.ok(seen.some(q=>q.get('familyId')==='family-a'&&q.get('sourceKey')==='sesum:KIWI:26'));assert.ok(!seen.some(q=>q.get('familyId')==='--source'));
    assert.deepEqual(await cli('shopping-sesum-candidates','--full'),rows);
  }finally{await new Promise(resolve=>server.close(resolve));assert.ok(dir.startsWith(join(tmpdir(),'familien-cli-candidates-')));rmSync(dir,{recursive:true,force:true});}
});

test('cli: intake med markReviewed/profileReview og observe-list med surfaceStatus i ett kall hver', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'familien-cli-'));
  const port = 14340;
  const api = `http://127.0.0.1:${port}`;
  const config=syntheticConfig(dir);
  const child = spawn(process.execPath, ['src/server.mjs'], { env: { ...process.env, FAMILIEN_CONFIG_DIR:config,FAMILIEN_NO_DISPATCH:'1', FAMILIEN_PORT: String(port), FAMILIEN_DATA_DIR: dir, CODEX_HOME: dir }, stdio: 'ignore' });
  const cli = async (...args) => JSON.parse((await run(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, FAMILIEN_CONFIG_DIR:config,FAMILIEN_API: api } })).stdout);
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${api}/health`)).ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const observed = await cli('observe-list', JSON.stringify({
      source: 'facebook', surface: 'group-1:posts',
      items: [{ externalId: 'fb:post:1', title: 'Loppis', summary: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1', publishedAt: new Date().toISOString() }],
      surfaceStatus: { health: 'ok', complete: true, details: 'Test' }
    }));
    assert.equal(observed.decisions[0].needsReview, true);
    assert.match(observed.warning, /partial/);
    assert.equal(observed.surfaceStatus.health, 'partial');

    const intake = await cli('intake', JSON.stringify({
      source: 'facebook', externalId: 'fb:post:1', title: 'Loppis', body: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1',
      publishedAt: new Date().toISOString(), memberIds: ['child3'],
      profileReview: { note: 'Ingen varig informasjon.', facts: [] },
      markReviewed: [{ surface: 'group-1:posts', relevance: 'relevant' }]
    }));
    assert.ok(intake.item.id);
    assert.equal(intake.profileReview.rawId, intake.item.id);
    assert.equal(intake.markReviewed.length, 1);

    const again = await cli('observe-list', JSON.stringify({
      source: 'facebook', surface: 'group-1:posts',
      items: [{ externalId: 'fb:post:1', title: 'Loppis', summary: 'Loppemarked lørdag', sourceUrl: 'https://example.com/1', publishedAt: observed.decisions.length ? new Date().toISOString() : null }],
    }));
    assert.equal(again.decisions.length, 1);

    const batch = await cli('surface', JSON.stringify([
      { source: 'facebook', surface: 'group-1:posts', health: 'partial', details: 'a' },
      { source: 'facebook', surface: 'group-2:posts', health: 'partial', details: 'b' }
    ]));
    assert.equal(batch.length, 2);

    const batched = await cli('batch', JSON.stringify([
      { cmd: 'surface', input: { source: 'facebook', surface: 'group-3:posts', health: 'partial', details: 'c' } },
      { cmd: 'completion' },
      { cmd: 'usage', args: ['1'] }
    ]));
    assert.equal(batched.ok, true);
    assert.equal(batched.ran, 3);
    assert.equal(batched.results[0].result.surface, 'group-3:posts');
    assert.ok(batched.results[1].result.counts);
    assert.ok(Array.isArray(batched.results[2].result.sessions));
    // Første feil stopper resten og gir exit-kode 1.
    let failed;
    try { await cli('batch', JSON.stringify([{ cmd: 'mark-reviewed', input: { source: 'facebook', externalId: 'finnes-ikke' } }, { cmd: 'completion' }])); }
    catch (error) { failed = JSON.parse(error.stdout); }
    assert.equal(failed.ok, false);
    assert.equal(failed.ran, 1);
    assert.equal(failed.of, 2);

    const completion = await cli('completion');
    assert.equal(completion.historicalItems, undefined);
    assert.ok(completion.counts);
    assert.ok(Array.isArray((await cli('next')).work));

    // PowerShell's default UTF-8 file must pass through the CLI and HTTP API on
    // the first attempt, before the agent releases its observed start time.
    const {lease}=await cli('begin-run');
    const reportFile=join(dir,'run-bom.json');
    writeFileSync(reportFile,'\uFEFF'+JSON.stringify({scope:'kildeendringer',outcome:'partial',summary:'Kjøringen fant et kildehull.',blockers:['Originalen var utilgjengelig fra kildens server.'],resumeHint:'Prøv igjen ved ny kildeinformasjon.'}),'utf8');
    try {
      const recorded=await cli('run',reportFile);
      assert.equal(recorded.startedAt,lease.startedAt);
      assert.equal(recorded.summary,'Kjøringen fant et kildehull.');
      assert.ok(recorded.durationMs>=0);
      assert.equal((await cli('runs')).filter(item=>item.summary==='Kjøringen fant et kildehull.').length,1);
    } finally { await cli('end-run',lease.token); }
  } finally {
    const done = child.exitCode!==null?Promise.resolve():new Promise((r) => child.once('exit', r));
    if(child.exitCode===null)child.kill();
    await done;
    assert.ok(dir.startsWith(join(tmpdir(), 'familien-cli-')));
    rmSync(dir, { recursive: true, force: true });
  }
});
