import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sesumCollectionCompletion} from '../src/sesum-completion.mjs';
import {createSesumCollector} from '../src/shopping-sesum.mjs';
import {shoppingStore} from '../src/shopping.mjs';
import {createStore} from '../src/store.mjs';

const NOW='2026-11-09T12:00:00Z';
const family={familyId:'synthetic-family',requirementsFingerprint:'semantic-1'};
const finished=()=>({enabled:true,status:'complete',runId:'synthetic-run',jobCounts:{pending:0,complete:2,partial:0,blocked:0},replayPendingCount:0,manifest:[{familyId:family.familyId,fingerprint:family.requirementsFingerprint,collectionStatus:'complete',collectionOutcome:'no_matches',chains:[{freshProducts:0}]}]});
const temp=t=>{const dir=mkdtempSync(join(tmpdir(),'sesum-completion-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test('collection completion does not certify equivalence or fresh chain prices',()=>{
  const report=sesumCollectionCompletion(finished(),[family]);
  assert.equal(report.complete,true);assert.equal(report.pending,false);assert.equal(report.blocked,false);
  assert.equal(report.families[0].collectionOutcome,'no_matches');
  assert.equal('freshProducts' in report.families[0],false);
  assert.equal(sesumCollectionCompletion({enabled:false}).complete,true);
});

test('initial, active, replay and terminal source failures each prevent completion',()=>{
  for(const update of [{status:'not_started',manifest:[]},{status:'collecting'},{replayPendingCount:1},{jobCounts:{partial:1}},{jobCounts:{blocked:1}},{manifest:[{...finished().manifest[0],collectionStatus:'partial'}]},{status:'unknown'},{refreshDue:true},{planCurrent:false}]){
    const result=sesumCollectionCompletion({...finished(),...update},[family]);
    assert.equal(result.complete,false,JSON.stringify(update));assert.ok(result.pending||result.blocked);
  }
  assert.equal(sesumCollectionCompletion(null).blocked,true);
});

test('a completed old plan cannot certify newly enabled or materially changed families',()=>{
  const fresh=sesumCollectionCompletion(finished(),[family,{familyId:'another-family',requirementsFingerprint:'semantic-2'}]);
  assert.deepEqual(fresh.changedFamilies,['another-family']);assert.equal(fresh.pending,true);assert.equal(fresh.complete,false);
  const changed=sesumCollectionCompletion(finished(),[{...family,requirementsFingerprint:'changed-variant-requirement'}]);
  assert.deepEqual(changed.changedFamilies,[family.familyId]);assert.equal(changed.complete,false);
});

test('all91 real collector searches must finish despite an empty agent queue and remain separate from fresh prices',async t=>{
  const dir=temp(t),state={};let collector,at=Date.parse(NOW);
  const shop=shoppingStore(state,{save(){},now:()=>new Date(at),sesumCollectionStatus:()=>collector?.status()});
  shop.settings({monitoringEnabled:true,stores:[]});
  for(let i=0;i<91;i++)shop.watch({id:`family-${i}`,name:`Synthetic commodity ${i}`,unit:'kg',storage:'pantry'});
  const options={dataDir:dir,encryptionKey:Buffer.alloc(32,29),now:()=>new Date(at),families:()=>shop.sesumFamilies(),config:{enabled:true,cycleCalls:8}};
  collector=createSesumCollector(options);
  assert.equal(shop.queue().length,0);assert.equal(shop.completion().complete,false,'not started is not complete');
  let work=collector.work(),searches=0;
  assert.equal(shop.completion().collection.families.length,91);assert.equal(shop.completion().complete,false);
  while(work.jobs.length){
    for(const job of work.jobs){
      assert.equal(job.kind,'search');searches++;
      await collector.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:new Date(at).toISOString(),result:{ok:true,kind:'search',sourceUrl:job.url,productUrls:[],nextUrls:[],endReached:true,errors:[]}});
    }
    at+=60000;work=collector.work();
  }
  assert.equal(searches,91);assert.equal(shop.completion().complete,true);
  assert.equal(shop.completion().collection.families.filter(f=>f.collectionOutcome==='no_matches').length,91);
  collector=createSesumCollector(options);
  assert.equal(shop.completion().complete,true,'completion reads the persisted current collector after restart');
  shop.watch({id:'new-family',name:'New synthetic commodity',unit:'kg',storage:'pantry'});
  assert.equal(shop.completion().complete,false,'read-only completion catches a new family before Chrome next claims work');
  assert.deepEqual(shop.completion().collection.changedFamilies,['new-family']);
});

test('run reports reject shopping success while collection remains, preserve phone scope and fail closed on missing status',t=>{
  const dir=temp(t);let current={enabled:true,status:'not_started'},fail=false;
  const store=createStore(dir,{sesumCollectionStatus:()=>{if(fail)throw Error('Synthetic status unavailable');return current;}});
  store.shopping.settings({monitoringEnabled:true,stores:[]});
  let report=store.completionReport();
  assert.equal(report.shopping.work.length,0);assert.equal(report.shopping.complete,false);assert.equal(report.counts.shoppingPending,0);
  assert.equal(report.counts.shoppingCollectionPending,1);assert.equal(store.changeCompletion().counts.shoppingCollectionPending,undefined);assert.equal(store.changeCompletion().complete,true);
  assert.doesNotThrow(()=>store.recordRun({scope:'kildeendringer',outcome:'ok',summary:'Independent source changes complete',sources:[]}));
  for(const scope of ['handel','alle'])assert.throws(()=>store.recordRun({scope,outcome:'ok',summary:'Synthetic completion attempt',sources:[]}),/restanser/);
  assert.doesNotThrow(()=>store.recordRun({scope:'familiehandlinger',outcome:'ok',summary:'Independent phone actions complete',sources:[]}));
  fail=true;report=store.completionReport();assert.equal(report.shopping.complete,false);assert.equal(report.counts.shoppingCollectionBlocked,1);assert.equal(report.counts.shoppingBlocked,1);
  assert.doesNotThrow(()=>store.recordRun({scope:'kildeendringer',outcome:'ok',summary:'Source changes remain independent of collection failure',sources:[]}));
  for(const scope of ['handel','alle'])assert.throws(()=>store.recordRun({scope,outcome:'ok',summary:'Collection failure still prevents completion',sources:[]}),/restanser/);
  fail=false;current={enabled:false,status:'disabled'};
  assert.equal(store.shopping.completion().complete,true);assert.equal('shoppingCollectionPending' in store.completionReport().counts,false);
  current={enabled:true,status:'not_started'};store.shopping.settings({monitoringEnabled:false});
  assert.equal(store.shopping.completion().complete,true,'shopping remains opt-in');
});

test('an overdue refresh or changed query/chain configuration cannot reuse a completed collector certificate',async t=>{
  const dir=temp(t);let at=Date.parse(NOW);
  const options={dataDir:dir,encryptionKey:Buffer.alloc(32,31),now:()=>new Date(at),families:()=>[{familyId:'family',name:'Synthetic commodity',unit:'kg',queries:['synthetic']}],config:{enabled:true,refreshHours:24,cycleCalls:1,chainCodes:['KIWI']}};
  const collector=createSesumCollector(options),work=collector.work(),job=work.jobs[0];
  await collector.receive({runId:work.runId,jobId:job.id,status:'ok',fetchedAt:NOW,result:{ok:true,kind:'search',sourceUrl:job.url,productUrls:[],nextUrls:[],endReached:true,errors:[]}});
  assert.equal(sesumCollectionCompletion(collector.status()).complete,true);
  const chainChanged=createSesumCollector({...options,config:{...options.config,chainCodes:['KIWI','REMA_1000']}}).status();
  const queriesChanged=createSesumCollector({...options,config:{...options.config,queryOverrides:{family:['different explicit query']}}}).status();
  for(const status of [chainChanged,queriesChanged]){assert.equal(status.planCurrent,false);assert.equal(sesumCollectionCompletion(status).complete,false);assert.equal(status.runId,work.runId,'status does not start a new source run');}
  at+=24*3600000;
  const overdue=collector.status();assert.equal(overdue.refreshDue,true);assert.equal(overdue.runId,work.runId);assert.equal(overdue.jobCounts.complete,1);
  assert.equal(sesumCollectionCompletion(overdue).pending,true);assert.equal(sesumCollectionCompletion(overdue).complete,false);
});
