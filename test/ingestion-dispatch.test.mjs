import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createIngestionDispatcher,changeSignal} from '../src/ingestion-dispatch.mjs';
import {createStore} from '../src/store.mjs';
import {agentFamilyBasis,buildAgentContext} from '../src/shopping-agent-context.mjs';

test('empty or malformed recovery receipts cannot record a run or release an absent lease on repeated idle ticks',()=>{
 for(const receipt of [undefined,null,{}, {token:undefined},{token:null},{token:''},{token:' '},{token:0}]){
  const pool={status:()=>({running:false}),finishedLeaseForRecovery:()=>receipt},f=shoppingDispatchFixture([],{},undefined,false,pool);
  try{let reports=0,releases=0;f.store.recordRun=()=>reports++;f.store.endRun=()=>{releases++;throw Error('There is no owned lease to release');};
   for(let i=0;i<3;i++){f.dispatcher.tick();f.clock.at+=60000;}
   assert.equal(reports,0);assert.equal(releases,0);assert.equal(f.dispatcher.status().running,false);
  }finally{f.close();}
 }
});

test('an idle dispatcher recovers only its coordinators exact finished lease, preserving foreign owners and pauses',()=>{
 for(const gate of ['own','foreign','paused','safety']){
  let acknowledgements=0;const pool={status:()=>({running:false,...(gate==='safety'?{attention:{reason:'Explicit safety stop'}}:{})}),finishedLeaseForRecovery:()=>({token:'owned-test-batch'}),acknowledgeFinishedLease:()=>acknowledgements++},f=shoppingDispatchFixture([],{enabled:gate!=='paused'},undefined,false,pool),reports=[];
  try{f.store.beginRun();if(gate==='foreign'){const original=f.store.snapshot;f.store.runLease=()=>({token:'foreign'});f.store.snapshot=()=>({...original(),runLease:{token:'foreign'}});}
   f.store.recordRun=r=>reports.push(r);f.dispatcher.tick();
   assert.equal(acknowledgements,gate==='own'?1:0);assert.equal(reports.length,gate==='own'?1:0);
   if(gate==='own'){assert.equal(f.store.snapshot().runLease,null);assert.equal(reports[0].outcome,'error');assert.equal(reports[0].scope,'handel');}
   else assert.ok(f.store.snapshot().runLease);
  }finally{f.close();}
 }
});

test('a current foreign lease skips expensive read models but normal expiry permits dispatch',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'current'}]);
 try{f.store.beginRun();f.store.snapshot().runLease.expiresAt=new Date(f.clock.at+60000).toISOString();
  const completion=f.store.completionReport;f.store.completionReport=()=>{throw Error('Foreign owner must not trigger read model construction');};
  f.dispatcher.tick();assert.equal(f.launches.length,0);assert.equal(f.store.snapshot().runLease.token,'owned-test-batch');
  f.clock.at+=60001;f.store.completionReport=completion;f.dispatcher.tick();assert.equal(f.launches.length,1);f.launches[0].onExit(0);
 }finally{f.close();}
});

test('finished source work hands independent shopping over immediately while family priority and shopping failure backoff remain',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'needs-review'}]);f.store.reviewQueue=()=>({items:[{source:'spond',externalId:'known-blocked',listingHash:'same',reason:'Actual unchanged source gap'}]});
 try{f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer');f.launches[0].onExit(0);f.store.phone.list=()=>[{status:'queued'}];f.dispatcher.tick();assert.equal(f.launches.length,1);f.store.phone.list=()=>[];f.dispatcher.tick();assert.equal(f.launches.length,2,'the source minGap does not delay the first shopping wave');assert.equal(f.dispatcher.status().workerScope,'handel');f.launches[1].onExit(1);f.dispatcher.tick();assert.equal(f.launches.length,2,'same shopping cohort failure retains backoff');}finally{f.close();}
});

test('requesting the same failed cohort retains its backoff and cannot indefinitely mask source work',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'same'}]);
 try{f.dispatcher.tick();f.launches[0].onExit(1);f.dispatcher.requestShopping();assert.equal(f.launches.length,1);f.store.reviewQueue=()=>({items:[{source:'spond',externalId:'new-source',listingHash:'new',reason:'Actual new source change'}]});f.dispatcher.tick();assert.equal(f.launches.length,2);assert.equal(f.dispatcher.status().workerScope,'kildeendringer');f.launches[1].onExit(0);}finally{f.close();}
});

test('explicit repaired-runtime resume rebuilds shopping work but cannot resume a safety stop',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'same'}]);
 try{f.dispatcher.tick();f.launches[0].onExit(1);f.dispatcher.requestShopping({retryFailed:true});assert.equal(f.launches.length,2);f.launches[1].onExit(0);assert.throws(()=>f.dispatcher.requestShopping({retryFailed:true}),/Only an idle/);}finally{f.close();}
 let stopped=false;const pool={status:()=>({running:false,attention:stopped?{reason:'Explicit stop'}:null}),preferSerial:()=>[]},g=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'same'}],{},undefined,false,pool);
 try{g.dispatcher.tick();g.launches[0].onExit(1);stopped=true;assert.throws(()=>g.dispatcher.requestShopping({retryFailed:true}),/safety stops/);assert.equal(g.launches.length,1);}finally{g.close();}
});

test('an explicit repaired-shopping resume survives intervening successful source work clearing the display error',()=>{
 const pool={status:()=>({running:false,last:{id:'failed-shopping-pool',code:1}}),preferSerial:()=>[]},f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'same'}],{},undefined,false,pool);
 try{f.dispatcher.tick();f.launches[0].onExit(1);f.store.reviewQueue=()=>({items:[{source:'spond',externalId:'new-source',listingHash:'new',reason:'Actual new source'}]});f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer');f.launches[1].onExit(0);assert.equal(f.dispatcher.status().lastError,null);const before=f.dispatcher.status().sourceChanges;f.dispatcher.requestShopping({retryFailed:true});assert.equal(f.launches.length,3);assert.equal(f.dispatcher.status().workerScope,'handel');assert.deepEqual(f.dispatcher.status().sourceChanges,before);f.launches[2].onExit(0);}finally{f.close();}
});

test('explicit repair resume can restart an owner-preempted shopping session without changing source budgets',()=>{
 const pool={status:()=>({running:false,last:{code:0,preempted:true}}),preferSerial:()=>[]},f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'current'}],{},undefined,false,pool);
 try{const before=f.dispatcher.status().sourceChanges;f.dispatcher.requestShopping({retryFailed:true});assert.equal(f.launches.length,1);assert.deepEqual(f.dispatcher.status().sourceChanges,before);f.launches[0].onExit(0);}finally{f.close();}
});

test('an explicit one-session parallel preference preserves deferred work and source budgets after maintenance',()=>{
 const native=[{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'native'}],fresh=Array.from({length:100},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+(1000+i),sourceFingerprint:'source-'+i}));let active=false,last=null,starts=0;
 const pool={status:()=>({running:active,runId:'parallel-preference',last}),tick(){},preferSerial:()=>native,start(){active=true;starts++;return this.status();}},f=shoppingDispatchFixture([...native,...fresh],{shoppingWorkers:3},undefined,false,pool);
 try{f.dispatcher.tick();assert.equal(starts,1);active=false;last={id:'parallel-preference',code:0,positiveProgress:true,applied:1,slots:[]};f.queue.rows=[...native,...fresh.slice(60)];f.dispatcher.poll();const before=f.dispatcher.status().sourceChanges;f.dispatcher.requestShopping({preferParallel:true});assert.equal(starts,2);assert.equal(f.launches.length,0);assert.deepEqual(f.queue.rows,[...native,...fresh.slice(60)]);assert.deepEqual(f.dispatcher.status().sourceChanges,before);}finally{f.close();}
});

test('parallel dispatcher owns one lease, recovers its coordinator and reports only actual scoped work',()=>{
 let active=false,last=null,launches=0,polls=0;const rows=Array.from({length:65},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+(1000+i),sourceFingerprint:'current-'+i}));
 const pool={status:()=>({running:active,runId:active?'coordinated-run':null,last}),preferSerial:()=>[],tick(){polls++;},start(input){launches++;active=true;assert.equal(input.batches.length,3);assert.equal(input.batches.flatMap(b=>b.jobs).length,60);return this.status();}};
 const f=shoppingDispatchFixture(rows,{shoppingWorkers:3},undefined,false,pool),runs=[];f.store.recordRun=r=>runs.push(r);const completion=f.store.completionReport;f.store.completionReport=()=>({...completion(),shopping:{complete:false,work:f.queue.rows}});
 try{
  f.dispatcher.tick();assert.equal(launches,1);assert.equal(f.launches.length,0);assert.equal(f.dispatcher.status().shoppingBatch.jobs.length,60);f.dispatcher.tick();assert.equal(launches,1);assert.equal(f.store.snapshot().runLease.token,'owned-test-batch');
  // Recovered dispatcher polls the existing coordinator instead of treating a
  // missing single-worker PID as an interrupted run or taking a second lease.
  const recovered=createIngestionDispatcher({store:f.store,root:f.dir??'.',dataDir:f.dir??'',shoppingCoordinator:pool,clock:()=>f.clock.at,readConfig:()=>({enabled:true,shoppingWorkers:3}),alive:()=>false});
  recovered.poll();assert.equal(recovered.status().running,true);
  active=false;last={id:'coordinated-run',code:0,applied:3,positiveProgress:true,slots:[]};f.queue.rows=f.queue.rows.slice(60);recovered.poll();assert.equal(f.store.snapshot().runLease,null);assert.equal(runs[0].scope,'handel');assert.equal(runs[0].outcome,'continued');assert.equal(recovered.status().shoppingContinuation,true);assert.ok(polls>0);
 }finally{f.close();}
});

test('configured live batch size bounds workers while all later jobs remain counted',()=>{
 const rows=Array.from({length:60},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'same-'+i}));let active=false;
 const pool={status:()=>({running:active,runId:'small-wave'}),tick(){},preferSerial:()=>[],start({batches}){active=true;assert.deepEqual(batches.map(b=>b.jobs.length),[5,5,5]);return this.status();}},f=shoppingDispatchFixture(rows,{shoppingWorkers:3,shoppingWorkerBatchSize:5},undefined,false,pool);
 try{f.dispatcher.tick();assert.equal(f.dispatcher.status().shoppingBatch.summary.agentJobs.total,60);assert.equal(f.dispatcher.status().shoppingBatch.jobs.length,15);assert.equal(f.queue.rows.length,60);}finally{f.close();}
});

test('rolling dispatcher fills a free lane under its existing lease and reports cumulative assignments',()=>{
 let active=false,need=false,last=null,refills=0;const rows=Array.from({length:60},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'same-'+i}));
 const pool={status:()=>({running:active,runId:'rolling-run',last,...(active?{pool:{needsRefill:need}}:{})}),tick(){},preferSerial:()=>[],start(input){assert.deepEqual(input.pool,{capacity:3,batchSize:5,maxJobs:300,durationMs:15*60000});active=true;return this.status();},refill(input){refills++;assert.equal(input.stopReason,null);assert.deepEqual(input.queue,rows);need=false;return this.status();}};
 const f=shoppingDispatchFixture(rows,{shoppingWorkers:3,shoppingWorkerBatchSize:5},undefined,false,pool);try{f.dispatcher.tick();need=true;f.dispatcher.poll();assert.equal(refills,1);assert.equal(f.store.snapshot().runLease.token,'owned-test-batch');assert.equal(f.launches.length,0);
 active=false;last={id:'rolling-run',code:0,positiveProgress:true,applied:10,pool:{assignedJobs:75,refills:12},slots:[]};f.dispatcher.poll();assert.equal(f.dispatcher.status().lastMetrics.assignedJobs,75);assert.equal(f.dispatcher.status().lastMetrics.refills,12);assert.equal(f.dispatcher.status().shoppingContinuation,true);assert.equal(f.store.snapshot().runLease,null);
 }finally{f.close();}
});

test('a manually prioritized shopping session only drains for source changes after its own start',()=>{
 let active=false,need=false;const sources=[{source:'spond',externalId:'known',listingHash:'same',reason:'Known pending source'}],refills=[],rows=Array.from({length:3},(_,i)=>({do:'shopping-product-review',productKey:'kassal:ODA_NO:'+i,watchId:'family',fingerprint:'same-'+i}));
 const pool={status:()=>({running:active,runId:'owner-priority',...(active?{pool:{needsRefill:need}}:{})}),tick(){},preferSerial:()=>[],start(){active=true;return this.status();},refill(input){refills.push(input);need=false;return this.status();}},f=shoppingDispatchFixture(rows,{shoppingWorkers:3},undefined,false,pool);f.store.reviewQueue=()=>({items:sources});
 try{f.dispatcher.requestShopping();need=true;f.dispatcher.poll();assert.equal(refills[0].stopReason,null,'already known sources do not immediately undo owner prioritization');sources.push({source:'vigilo',externalId:'new',listingHash:'changed',reason:'Actual new source item'});need=true;f.dispatcher.poll();assert.equal(refills[1].stopReason,'new-source-work');assert.deepEqual(refills[1].queue,[]);assert.equal(f.store.snapshot().runLease.token,'owned-test-batch');assert.equal(f.launches.length,0,'active workers drain before handing the lease back');}finally{f.close();}
});

test('scoped shopping and source signals avoid constructing the unrelated queue',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'same'}]);try{
 const full=changeSignal(f.store),shopping=changeSignal(f.store,undefined,{shoppingOnly:true});assert.deepEqual(shopping.items,full.items.filter(row=>JSON.parse(row)[0]==='shopping'));
 f.store.completionReport=()=>{throw Error('Shopping-only signal must not construct source completion');};assert.equal(changeSignal(f.store,undefined,{shoppingOnly:true}).count,1);
 f.store.completionReport=()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]});f.store.shopping.queue=()=>{throw Error('Source signal must not construct shopping queue');};assert.equal(changeSignal(f.store,undefined,{sourceOnly:true}).count,0);
 }finally{f.close();}
});

test('source signal and launch scheduling use source completion, retaining shopping jobs and full final certification',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family',fingerprint:'current'}]);
 try{const complete=f.store.completionReport,source=complete();f.store.sourceCompletionReport=()=>({...source,sourceComplete:false,complete:undefined});f.store.completionReport=()=>{throw Error('Source scheduling should not rebuild shopping completion');};
  assert.equal(changeSignal(f.store,undefined,{sourceOnly:true}).count,0);f.dispatcher.tick();assert.equal(f.launches.length,1);assert.equal(f.dispatcher.status().workerScope,'handel');assert.equal(f.queue.rows.length,1);f.store.completionReport=complete;f.launches[0].onExit(0);
 }finally{f.close();}
});

test('coordinator safety stop also prevents the legacy full-tool fallback',()=>{
 const pool={status:()=>({running:false,attention:{reason:'An explicit runtime safety stop.'}})},f=shoppingDispatchFixture([{do:'shopping-review',storeId:'one'}],{shoppingWorkers:3},undefined,false,pool);try{f.dispatcher.tick();assert.equal(f.launches.length,0);assert.equal(f.store.snapshot().runLease,null);}finally{f.close();}
});

test('an unchanged deferred wave yields to other products before its bounded serial follow-up',()=>{
 let active=false,last=null,serial=false;const rows=Array.from({length:65},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+(1000+i),sourceFingerprint:'unchanged-'+i})),pool={status:()=>({running:active,runId:active?'handoff-run':null,last}),tick(){},preferSerial:queue=>serial?queue.slice(0,60):[],start(){active=true;return this.status();}},f=shoppingDispatchFixture(rows,{shoppingWorkers:3},undefined,false,pool);
 try{f.dispatcher.tick();active=false;last={id:'handoff-run',code:0,applied:0,positiveProgress:false,slots:[]};serial=true;f.dispatcher.poll();f.dispatcher.tick();assert.equal(f.launches.length,0);assert.equal(f.dispatcher.status().shoppingBatch.jobs.length,5,'fresh products are not delayed by the old cohort failure gap');active=false;f.dispatcher.poll();f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,1);assert.equal(f.dispatcher.status().shoppingBatch.jobs.length,20);assert.equal(f.dispatcher.status().shoppingBatch.summary.agentJobs.total,65);f.launches[0].onExit(0);}finally{f.close();}
});

test('deferred native reviews and serial flyers cannot monopolize independent workers, and serial work keeps its turn',()=>{
 const native=Array.from({length:27},(_,i)=>({do:'shopping-product-review',productKey:'kassal:ODA_NO:'+i,watchId:'family',fingerprint:'held-'+i})),fresh=Array.from({length:60},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'actual-'+i})),rows=[...native,{do:'shopping-review',storeId:'flyer'},...fresh];
 let active=false,last=null,starts=0;const pool={status:()=>({running:active,runId:'recovery-run',last}),tick(){},preferSerial:queue=>queue.filter(i=>native.includes(i)),start({batches}){starts++;active=true;assert.deepEqual(batches.map(b=>b.jobs.length),[20,20,20]);assert.ok(batches.flatMap(b=>b.items).every(i=>fresh.includes(i)));return this.status();}};
 const f=shoppingDispatchFixture(rows,{shoppingWorkers:3},undefined,false,pool);try{
  f.dispatcher.tick();assert.equal(starts,1);assert.equal(f.queue.rows.length,88);assert.equal(f.dispatcher.status().shoppingBatch.summary.agentJobs.total,88);
  active=false;last={id:'recovery-run',code:0,applied:0,positiveProgress:false,slots:[]};f.dispatcher.poll();f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(starts,1);assert.equal(f.launches.length,1);assert.deepEqual(f.dispatcher.status().shoppingBatch.items,native.slice(0,20));f.launches[0].onExit(0);
 }finally{f.close();}
});

test('an explicit shopping request takes one turn before due source work but retains owner, family, lease and safety gates',()=>{
 for(const gate of ['none','phone','calendar','stock','paused','lease','safety']){
  const rows=Array.from({length:3},(_,i)=>({do:'shopping-product-review',productKey:'kassal:ODA_NO:'+i,watchId:'family',fingerprint:'current-'+i}));let active=false,starts=0;
  const pool={status:()=>({running:active,runId:'requested-shopping',attention:gate==='safety'?{reason:'Explicit safety stop'}:null}),tick(){},preferSerial:()=>[],start(){starts++;active=true;return this.status();}},f=shoppingDispatchFixture(rows,{shoppingWorkers:3,dailyFullFallback:true,enabled:gate!=='paused'},undefined,false,pool);
  f.clock.at=Date.parse('2026-11-10T08:00:00Z');f.store.runHistory=()=>({runs:[],nextCursor:null});f.store.reviewQueue=()=>({items:[{source:'spond',externalId:'still-unread',listingHash:'actual',reason:'Source review remains pending'}]});
  if(gate==='phone')f.store.phone.list=()=>[{status:'queued'}];if(gate==='calendar')f.store.calendarActions=()=>[{}];if(gate==='stock')f.store.shopping.stockIntake={work:()=>[{}]};if(gate==='lease')f.store.beginRun=()=>({acquired:false});
  try{f.dispatcher.requestShopping();assert.equal(starts,gate==='none'?1:0,gate);assert.equal(f.launches.length,0);assert.equal(f.dispatcher.status().dailyFull?.attempts??0,0,'request does not certify or consume source coverage');assert.equal(f.store.reviewQueue().items.length,1);}finally{f.close();}
 }
});

test('shopping launch supplies complete stable family data before its variable assignment',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}]);
 const families=Array.from({length:91},(_,i)=>({familyId:'family-'+i,note:'Complete criterion '+i})),basis=agentFamilyBasis(families);
 f.store.shopping.agentFamilyBasis=()=>basis;
 try{f.dispatcher.tick();assert.ok(f.launches[0].prompt.startsWith(basis.prompt));assert.equal(f.dispatcher.status().familyBasisFingerprint,basis.familyBasisFingerprint);f.launches[0].onExit(0);assert.equal(f.dispatcher.status().familyBasisFingerprint,null);}finally{f.close();}
});

function shoppingDispatchFixture(initialRows,config={},resources=undefined,automaticShopping=false,shoppingCoordinator=null) {
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-batch-')),clock={at:Date.parse('2026-11-10T02:00:00Z')},queue={rows:initialRows},launches=[];let lease=null;
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[],shopping:{complete:false,blockedPlacements:[{status:'blocked',retryAt:'2026-11-11T02:00:00Z'}]}}),shopping:{queue:()=>queue.rows},beginRun:()=>({acquired:true,lease:lease={token:'owned-test-batch'}}),endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun(){}};
  const dispatcher=createIngestionDispatcher({store,resources,root:dir,dataDir:dir,shoppingCoordinator,automaticShopping,clock:()=>clock.at,readConfig:()=>({enabled:true,minGapMinutes:15,...config}),alive:()=>true,launch:input=>{launches.push(input);return {pid:123};}});
  store.recordRun??=()=>{};
  return {dir,dispatcher,clock,queue,launches,store,close(){assert.ok(dir.startsWith(join(tmpdir(),'familien-dispatch-batch-')));rmSync(dir,{recursive:true,force:true});}};
}

test('dispatcher prepares the exact frozen context file before launch and releases its lease on preparation failure',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}]);
 f.store.shopping.agentContext=assignment=>buildAgentContext(f.queue.rows,assignment,{families:()=>[{familyId:'beans',familyFingerprint:'criteria'}],sources:key=>({sourceKey:key,observation:{sourceFingerprint:'one'},label:'Complete original label'}),products:()=>null});
 try{
  f.dispatcher.tick();const launch=f.launches[0],document=JSON.parse(launch.prompt.split('\n').find(line=>line.startsWith('{"contextFile"'))),saved=JSON.parse(readFileSync(document.contextFile,'utf8'));
  assert.equal(saved.packet.contextFingerprint,document.contextFingerprint);assert.deepEqual(saved.assignment.jobs[0].sourceKeys,['sesum-product:1']);assert.equal(document.sources[0].label,'Complete original label');assert.equal(f.dispatcher.status().providedContextFingerprint,saved.packet.contextFingerprint);
  launch.onExit(0);f.clock.at+=16*60000;f.queue.rows[0].sourceFingerprint='genuinely-changed';f.store.shopping.agentContext=()=>{throw Error('Synthetic preparation failure');};f.dispatcher.tick();assert.equal(f.launches.length,1);assert.equal(f.store.snapshot().runLease,null);assert.equal(f.dispatcher.status().running,false);assert.match(f.dispatcher.status().lastError,/preparation failure/);
 }finally{f.close();}
});

test('code-owned Oda price work never launches a model and real product work still dispatches',()=>{
  const f=shoppingDispatchFixture([{do:'shopping-oda-refresh',watchId:'known',fingerprint:'price-gap'}],{},undefined,true);
  try{
    f.dispatcher.tick();assert.equal(f.launches.length,0);assert.equal(f.store.snapshot().runLease,null);
    f.queue.rows.push({do:'shopping-product-review',productKey:'kassal:ODA_NO:1',productId:'1',watchId:'family',fingerprint:'needs-label'});
    f.dispatcher.tick();assert.equal(f.launches.length,1);assert.equal(f.dispatcher.status().shoppingBatch.items.length,1);assert.equal(f.dispatcher.status().shoppingBatch.items[0].do,'shopping-product-review');
    assert.match(f.launches[0].prompt,/shopping-jobs --id/);assert.match(f.launches[0].prompt,/samme tildelte identitetene/);f.queue.rows=[];f.launches[0].onExit(0);
  }finally{f.close();}
});

test('unchanged blocked source work cannot be restarted by shopping arrivals or starve independent shopping',()=>{
 const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}]);
 const sources=[{source:'spond',externalId:'blocked-original',listingHash:'same',reason:'Actual source is blocked'}];f.store.reviewQueue=()=>({items:sources});
 try{
  f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer');f.launches[0].onExit(0);
  f.queue.rows.push({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:2',sourceFingerprint:'two'});f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'handel');assert.equal(f.dispatcher.status().sourceChanges.attempts,1);f.launches[1].onExit(0);
  sources.push({source:'vigilo',externalId:'genuine-new-item',listingHash:'new',reason:'Actual new source content'});f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer','genuinely new source work still preempts shopping');f.launches[2].onExit(0);
 }finally{f.close();}
});
test('a single shopping task does not inherit an unrelated original-resource retry pause',()=>{
 const retry='2026-11-10T04:00:00Z',resources={list:({status}={})=>status==='ready'?[]:[{status:'error',authRequired:true,attempts:3,fileName:'Original.pdf',retryAt:retry}]};
 const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}],{},resources),snapshot=f.store.snapshot;
 f.store.snapshot=()=>({...snapshot(),rawItems:{raw:{source:'spond',externalId:'original',revision:1}}});f.store.completionReport=()=>({profileReviews:[],missingDrive:[{rawId:'raw',kind:'source-original',fileName:'Original.pdf'}],unsyncedCalendar:[]});
 try{f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'handel');assert.equal(f.dispatcher.status().sourceChanges.retryAt,Date.parse(retry));f.launches[0].onExit(0);}finally{f.close();}
});

test('a failed source phase cannot bless a new ready-original signal with its older checkpoint',()=>{
  let ready=false;const resources={list:()=>ready?[{id:'original',source:'spond',refs:['source-original'],status:'ready',sha256:'new-original-bytes'}]:[]};
  const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}],{dailyFullFallback:true},resources);
  let phase={current:false,fingerprint:'source-a'};f.clock.at=Date.parse('2026-11-10T08:00:00Z');f.store.runHistory=()=>({runs:[],nextCursor:null});
  const originalSnapshot=f.store.snapshot;f.store.snapshot=()=>({...originalSnapshot(),rawItems:{raw:{source:'spond',externalId:'source-original',revision:1}}});
  f.store.completionReport=()=>({complete:false,sourcePhase:phase,profileReviews:[],missingDrive:[{rawId:'raw',kind:'source-original',fileName:'Original.pdf'}],unsyncedCalendar:[]});
  try{
    f.dispatcher.tick();phase={current:true,fingerprint:'source-a',checkpoint:{runId:'old-reviewed-checkpoint',startedAt:new Date(f.clock.at).toISOString(),checkedAt:new Date(f.clock.at).toISOString()}};f.launches[0].onExit(0);
    ready=true;f.clock.at+=31*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'alle');f.launches[1].onExit(1);
    f.clock.at+=121*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'alle','the old run cannot capture the changed resource signature after a failed reread');f.launches[2].onExit(1);
  }finally{f.close();}
});

test('a current source checkpoint resumes independent shopping while real source blockers stay incomplete',()=>{
  const f=shoppingDispatchFixture(Array.from({length:45},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'current-'+i})),{dailyFullFallback:true});
  let phase={current:false,fingerprint:'source-a'},phone=[];const sourceItems=[{source:'spond',externalId:'blocked-original',listingHash:'unchanged',reason:'blocked-original'}];
  f.clock.at=Date.parse('2026-11-10T08:00:00Z');f.store.runHistory=()=>({runs:[],nextCursor:null});f.store.phone.list=()=>phone;f.store.reviewQueue=()=>({items:sourceItems});f.store.completionReport=()=>({complete:false,sourcePhase:phase,profileReviews:[],missingDrive:[],unsyncedCalendar:[]});
  try{
    f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'alle');assert.equal(f.dispatcher.status().shoppingBatch.items.length,20);assert.match(f.launches[0].prompt,/sourcePhaseReviewed:true/);
    phase={current:true,fingerprint:'source-a',checkpoint:{runId:'actual-source-checkpoint',startedAt:new Date(f.clock.at).toISOString(),checkedAt:new Date(f.clock.at).toISOString(),blockers:['The exact Spond original remains unavailable.']}};
    f.queue.rows=f.queue.rows.slice(20);f.launches[0].onExit(0);f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'handel','unchanged source blocker must not force another source scan');
    f.queue.rows=[];f.launches[1].onExit(0);f.clock.at+=60*60000;f.dispatcher.tick();assert.equal(f.launches.length,2,'blocked sources remain incomplete without falsely finalizing or repeating their checkpoint');
    phone=[{status:'queued'}];phase={...phase,current:false};sourceItems.push({source:'spond',externalId:'actual-new-source',listingHash:'new',reason:'new'});f.dispatcher.tick();assert.equal(f.launches.length,2,'a family submission preempts resume');
    phone=[];f.dispatcher.tick();assert.equal(f.launches.length,3);assert.equal(f.dispatcher.status().workerScope,'alle','new source semantics require a new source phase');f.launches[2].onExit(1);
  }finally{f.close();}
});

test('continued never counts as a completed full run and final ok waits for actual global completion',()=>{
  const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}],{dailyFullFallback:true});
  let phase={current:false,fingerprint:'source-a'},complete=false;const runs=[];f.clock.at=Date.parse('2026-11-10T08:00:00Z');f.store.runHistory=()=>({runs,nextCursor:null});f.store.completionReport=()=>({complete,sourcePhase:phase,profileReviews:[],missingDrive:[],unsyncedCalendar:[]});
  f.store.sourceCompletionReport=()=>({sourceComplete:true,sourcePhase:phase,profileReviews:[],missingDrive:[],unsyncedCalendar:[]});
  try{
    f.dispatcher.tick();phase={current:true,fingerprint:'source-a',checkpoint:{runId:'checkpoint-one',startedAt:new Date(f.clock.at).toISOString(),checkedAt:new Date(f.clock.at).toISOString(),blockers:[]}};runs.push({scope:'alle',outcome:'continued',startedAt:new Date(f.clock.at).toISOString(),finishedAt:new Date(f.clock.at).toISOString()});f.launches[0].onExit(0);
    f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'handel','continued is a checkpoint, not a completed daily run');
    f.queue.rows=[];complete=true;f.launches[1].onExit(0);f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'alle');assert.match(f.launches[2].prompt,/Avsluttende fullføringskontroll/);
    runs.push({scope:'alle',outcome:'ok',startedAt:new Date(f.clock.at).toISOString(),finishedAt:new Date(f.clock.at).toISOString()});f.launches[2].onExit(0);f.clock.at+=60*60000;f.dispatcher.tick();assert.equal(f.launches.length,3);
  }finally{f.close();}
});

test('unchanged finalization without a real ok report keeps daily backoff and the three-attempt cap',()=>{
  for(const exitCode of [0,1]){
    const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}],{dailyFullFallback:true});
    let phase={current:false,fingerprint:'source-a'},complete=false;const runs=[];f.clock.at=Date.parse('2026-11-10T08:00:00Z');f.store.runHistory=()=>({runs,nextCursor:null});f.store.completionReport=()=>({complete,sourcePhase:phase,profileReviews:[],missingDrive:[],unsyncedCalendar:[]});
    try{
      f.dispatcher.tick();phase={current:true,fingerprint:'source-a',checkpoint:{runId:'checkpoint-final-retry',startedAt:new Date(f.clock.at).toISOString(),checkedAt:new Date(f.clock.at).toISOString(),blockers:[]}};f.queue.rows=[];complete=true;f.launches[0].onExit(0);
      f.dispatcher.tick();f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,1,'server completion cannot bypass the first daily retry even with an unchanged source phase');
      f.clock.at+=15*60000;f.dispatcher.tick();assert.equal(f.launches.length,2);assert.match(f.launches[1].prompt,/Avsluttende fullføringskontroll/);f.launches[1].onExit(exitCode);
      // CLI activity coverage may still reject final ok even when this server
      // report is complete. Exiting zero without that report is not success.
      f.dispatcher.tick();f.clock.at+=119*60000;f.dispatcher.tick();assert.equal(f.launches.length,2,'the unchanged finalization must wait its full daily backoff');
      f.clock.at+=2*60000;f.dispatcher.tick();assert.equal(f.launches.length,3);f.launches[2].onExit(exitCode);
      for(const minutes of [0,16,120,180]){f.clock.at+=minutes*60000;f.dispatcher.tick();}
      assert.equal(f.launches.length,3);assert.equal(f.dispatcher.status().dailyFull.attempts,3);assert.equal(f.dispatcher.status().dailyFull.retryAt,null);assert.deepEqual(runs,[],'no failed or missing final report becomes fullRunRecorded');
    }finally{f.close();}
  }
});

test('mixed source changes finish their own scope before a separate bounded shopping launch',()=>{
  const f=shoppingDispatchFixture(Array.from({length:50},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'current-'+i})));
  let sourceItems=[{source:'vigilo',externalId:'new-source-item',listingHash:'one',reason:'new'}];f.store.reviewQueue=()=>({items:sourceItems});
  try{
    f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer');assert.equal(f.dispatcher.status().shoppingBatch,null);
    assert.ok(!f.launches[0].prompt.includes('shopping-queue'));assert.ok(!f.launches[0].prompt.includes('shopping-sesum'));assert.ok(!f.launches[0].prompt.includes('shopping-oda-refresh'));
    sourceItems=[];f.launches[0].onExit(0);f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'handel');assert.equal(f.dispatcher.status().shoppingBatch.items.length,20);
    f.queue.rows=[];f.launches[1].onExit(0);
  }finally{f.close();}
});

test('a launch freezes at most twenty of eight thousand tasks and shrinking batches keep resuming',()=>{
  const f=shoppingDispatchFixture(Array.from({length:8000},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'metadata-'+i,familySetFingerprint:'set-a'})));
  try{
    f.dispatcher.tick();const frozen=f.dispatcher.status().shoppingBatch;
    assert.equal(frozen.items.length,20);assert.equal(frozen.summary.total,8000);assert.equal(frozen.summary.remaining,7980);assert.deepEqual(frozen.summary.byType,{'shopping-sesum-placement-review':8000});assert.match(frozen.summary.resumeHint,/next/);
    assert.match(f.launches[0].prompt,/Frosset handelsbolk/);assert.match(f.launches[0].prompt,/outcome:"continued"/);assert.ok(f.launches[0].prompt.includes('"sourceKeys":["sesum-product:19"]'));assert.ok(!f.launches[0].prompt.includes('"sourceKeys":["sesum-product:20"]'));assert.ok(f.launches[0].prompt.length<16000);
    // A completed placement may open identity research, but never expands the
    // already running assignment or counts as an approval of that next stage.
    f.queue.rows=[{...f.queue.rows[0],do:'shopping-sesum-discovery'},...f.queue.rows.slice(20)];
    assert.equal(frozen.items[0].do,'shopping-sesum-placement-review');f.launches[0].onExit(0);
    assert.equal(f.dispatcher.status().attempts,0);f.dispatcher.tick();assert.equal(f.launches.length,1,'the configured minimum gap still holds');
    f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.dispatcher.status().shoppingBatch.items[0].do,'shopping-sesum-discovery');
    for(let i=1;i<=4;i++){
      f.queue.rows=f.queue.rows.slice(20);f.launches[i].onExit(0);assert.equal(f.dispatcher.status().attempts,0);
      f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,i+2,'real removal must continue beyond three launches');
    }
    assert.equal(f.launches.length,6);f.queue.rows=[];f.launches.at(-1).onExit(0);assert.equal(f.dispatcher.status().running,false);
    assert.equal(changeSignal(f.store).count,0,'future blocked completion rows are not active cohort work');
  }finally{f.close();}
});

test('an unchanged failed shopping cohort keeps the normal three-attempt backoff',()=>{
  const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one',familySetFingerprint:'set'}]);
  try{
    f.dispatcher.tick();f.launches[0].onExit(1);f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,1);
    f.clock.at+=15*60000;f.dispatcher.tick();assert.equal(f.launches.length,2);f.launches[1].onExit(1);
    f.clock.at+=121*60000;f.dispatcher.tick();assert.equal(f.launches.length,3);f.launches[2].onExit(1);
    f.clock.at+=86400000;f.dispatcher.tick();assert.equal(f.launches.length,3);assert.equal(f.dispatcher.status().attempts,3);assert.equal(f.dispatcher.status().retryAt,null);
  }finally{f.close();}
});

test('new arrivals behind five thousand pending rows cannot reset an unchanged assigned cohort retry budget',()=>{
  const f=shoppingDispatchFixture(Array.from({length:5020},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'current-'+i})));let next=5020;
  const append=()=>f.queue.rows.push({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+next,sourceFingerprint:'current-'+next++});
  try{
    f.dispatcher.tick();const assigned=f.dispatcher.status().shoppingBatch.items.map(item=>item.sourceKey);append();f.launches[0].onExit(1);assert.equal(f.dispatcher.status().attempts,1);
    f.clock.at+=16*60000;append();f.dispatcher.tick();assert.equal(f.launches.length,1,'a new tail must not bypass the first retry pause');
    f.clock.at+=15*60000;append();f.dispatcher.tick();assert.equal(f.launches.length,2);assert.deepEqual(f.dispatcher.status().shoppingBatch.items.map(item=>item.sourceKey),assigned);assert.equal(f.dispatcher.status().shoppingBatch.summary.total,f.queue.rows.length);
    append();f.launches[1].onExit(1);assert.equal(f.dispatcher.status().attempts,2);f.clock.at+=16*60000;append();f.dispatcher.tick();assert.equal(f.launches.length,2);
    f.clock.at+=105*60000;append();f.dispatcher.tick();assert.equal(f.launches.length,3);append();f.launches[2].onExit(1);
    for(let i=0;i<3;i++){f.clock.at+=16*60000;append();f.dispatcher.tick();}assert.equal(f.launches.length,3);assert.equal(f.dispatcher.status().attempts,3);
    f.queue.rows[0]={...f.queue.rows[0],sourceFingerprint:'materially-changed'};f.dispatcher.tick();assert.equal(f.launches.length,4,'an actual assigned metadata change opens a new cohort');
    f.queue.rows=f.queue.rows.slice(20);append();f.launches[3].onExit(0);assert.equal(f.dispatcher.status().attempts,0);f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,5,'actual assigned removal continues through later cohorts');assert.equal(f.dispatcher.status().shoppingBatch.items[0].sourceKey,'sesum-product:20');
    f.queue.rows=[];f.launches[4].onExit(0);
  }finally{f.close();}
});

test('unassigned market-refresh families do not reset the assigned twenty-family retry budget',()=>{
  const ids=Array.from({length:91},(_,i)=>'family-'+i),f=shoppingDispatchFixture([{do:'shopping-market-refresh',watchIds:ids,groups:91}]);
  try{
    f.dispatcher.tick();f.queue.rows[0]={...f.queue.rows[0],watchIds:[...ids,'new-tail-family'],groups:92};f.launches[0].onExit(1);assert.equal(f.dispatcher.status().attempts,1);
    f.clock.at+=16*60000;f.dispatcher.tick();assert.equal(f.launches.length,1);f.clock.at+=15*60000;f.dispatcher.tick();assert.deepEqual(f.dispatcher.status().shoppingBatch.items[0].watchIds,ids.slice(0,20));assert.equal(f.dispatcher.status().shoppingBatch.summary.total,92);
    f.queue.rows=[];f.launches[1].onExit(0);
  }finally{f.close();}
});

test('material unresolved activity status preempts shopping without healthy or timestamp-only dispatch churn',()=>{
  const f=shoppingDispatchFixture([{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:1',sourceFingerprint:'one'}]);
  const original=f.store.snapshot,status={activity:{health:'ok',details:'Actual current activity list reviewed.',checkedAt:'2026-11-10T08:00:00Z',unresolvedItems:[]}};f.store.snapshot=()=>({...original(),activitySourceStatus:status});
  try{
    const initial=changeSignal(f.store);assert.equal(initial.shoppingOnly,true);status.activity.checkedAt='2026-11-10T09:00:00Z';assert.equal(changeSignal(f.store).signature,initial.signature);
    status.activity={...status.activity,health:'partial',unresolvedItems:[{externalId:'unread-one',reason:'Primary details unavailable.'}]};const unresolved=changeSignal(f.store);assert.equal(unresolved.shoppingOnly,false);assert.notEqual(unresolved.signature,initial.signature);
    f.dispatcher.tick();assert.equal(f.dispatcher.status().workerScope,'kildeendringer');f.launches[0].onExit(1);
    status.activity.unresolvedItems.push({externalId:'unread-two',reason:'New actual detail is unavailable.'});assert.notEqual(changeSignal(f.store).signature,unresolved.signature);
    status.activity.checkedAt='2026-11-10T10:00:00Z';const before=changeSignal(f.store).signature;status.activity.checkedAt='2026-11-10T11:00:00Z';assert.equal(changeSignal(f.store).signature,before);
  }finally{f.close();}
});

test('one aggregate market-refresh row cannot exceed the twenty-family launch budget',()=>{
  const watchIds=Array.from({length:91},(_,i)=>'family-'+i),f=shoppingDispatchFixture([{do:'shopping-market-refresh',groups:91,watchIds}]);
  try{
    f.dispatcher.tick();const batch=f.dispatcher.status().shoppingBatch;
    assert.equal(batch.items.length,1);assert.equal(batch.items[0].groups,20);assert.deepEqual(batch.items[0].watchIds,watchIds.slice(0,20));assert.equal(batch.summary.total,91);assert.equal(batch.summary.shown,20);assert.equal(batch.summary.remaining,71);assert.equal(f.queue.rows[0].watchIds.length,91);
    f.queue.rows=[{...f.queue.rows[0],groups:71,watchIds:watchIds.slice(20)}];f.launches[0].onExit(0);f.clock.at+=16*60000;f.dispatcher.tick();assert.deepEqual(f.dispatcher.status().shoppingBatch.items[0].watchIds,watchIds.slice(20,40));
    f.queue.rows=[];f.launches[1].onExit(0);
  }finally{f.close();}
});

test('same-count Sesum review changes wake dispatch by source identity, metadata and followed family',()=>{
  let rows=[{do:'shopping-sesum-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'metadata-a',familyIds:['family-b','family-a'],receiptAt:'2026-11-09T08:00:00Z'}];
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>rows}};
  const first=changeSignal(store);assert.equal(first.count,1);assert.equal(first.shoppingOnly,true);assert.ok(first.signature);
  rows[0].receiptAt='2026-11-09T10:00:00Z';rows[0].fetchedAt='2026-11-09T11:00:00Z';
  assert.equal(changeSignal(store).signature,first.signature,'ordinary price/fetch time alone does not reopen unchanged product review');
  rows[0].familyIds.reverse();assert.equal(changeSignal(store).signature,first.signature,'family ordering is not new work');
  rows[0].sourceFingerprint='metadata-b';const changedMetadata=changeSignal(store);assert.equal(changedMetadata.count,first.count);assert.notEqual(changedMetadata.signature,first.signature);
  rows[0].sourceKey='sesum:COOP_EXTRA:456';const changedSource=changeSignal(store);assert.equal(changedSource.count,first.count);assert.notEqual(changedSource.signature,changedMetadata.signature);
  rows[0].familyIds.push('newly-followed');assert.notEqual(changeSignal(store).signature,changedSource.signature,'new family association is meaningful even at the same pending row count');
  rows[0].do='shopping-sesum-discovery';assert.equal(changeSignal(store).shoppingOnly,true);assert.equal(changeSignal(store).count,1);
  rows=[];assert.equal(changeSignal(store).signature,null);
});

test('chain-neutral research uses semantic dispatch identity and a future blocked retry wakes only when available',()=>{
  let rows=[{do:'shopping-sesum-placement-review',sourceKey:'sesum-product:72',sourceFingerprint:'metadata-a',familySetFingerprint:'all-enabled-a',fingerprint:'research-a'}];
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>rows}};
  const initial=changeSignal(store);assert.equal(initial.shoppingOnly,true);rows[0].fetchedAt='2026-11-10T12:01:00Z';rows[0].receiptAt='2026-11-10T12:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  rows[0].sourceFingerprint='metadata-b';assert.notEqual(changeSignal(store).signature,initial.signature);rows=[];assert.equal(changeSignal(store).signature,null,'future blocked work stays out of the active queue');
  rows=[{do:'shopping-sesum-catalog-review',sourceKey:'sesum-product:72',sourceFingerprint:'metadata-b',familySetFingerprint:'all-enabled-a',fingerprint:'research-b',familyIds:['actual-unhinted-target']}];assert.equal(changeSignal(store).count,1);assert.equal(changeSignal(store).shoppingOnly,true);
});

test('new Sesum discovery launches the existing shopping agent with research and registration instructions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-sesum-'));let lease=null,launch,rows=[{do:'shopping-sesum-discovery',sourceKey:'sesum:KIWI:123',sourceFingerprint:'current-source',familyIds:['family-a']}];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>rows},phone:{list:()=>[]},calendarActions:()=>[],beginRun:()=>({acquired:true,lease:lease={token:'test-owned-lease'}}),endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  try{
    const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>Date.parse('2026-11-09T12:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),alive:()=>true,launch:input=>{launch=input;return {pid:123};}});
    d.tick();assert.equal(d.status().workerScope,'handel');
    for(const pattern of [/shopping-sesum-discovery/,/shopping-sesum-register/,/shopping-sesum-catalog/,/familyFingerprints/,/Manglende EAN eller gjennomgått donor er aldri automatisk avslag/,/shopping-agent-context/,/shopping-agent-guide TYPE/,/En faktisk eksplisitt sikkerhetsstopp/])assert.match(launch.prompt,pattern);
    assert.doesNotMatch(launch.prompt,/conditionsVerified:true/);assert.doesNotMatch(launch.prompt,/HELE den konkrete ingredienslisten/);
    rows=[];launch.onExit(0);assert.equal(lease,null);assert.equal(d.status().running,false);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-dispatch-sesum-')));rmSync(dir,{recursive:true,force:true});}
});

test('native-only product batches omit unrelated Sesum research protocols without reducing shopping scope',()=>{
  const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',productId:'1',watchId:'family',fingerprint:'current'}]);
  try{
    f.dispatcher.tick();const prompt=f.launches[0].prompt;
    assert.match(prompt,/shopping-catalog-review/);assert.match(prompt,/HELE den konkrete ingredienslisten/);
    assert.doesNotMatch(prompt,/Sesums globale plassering/);assert.doesNotMatch(prompt,/Sesum-discovery:/);
    assert.match(prompt,/shopping-jobs --id/);assert.equal(f.dispatcher.status().shoppingBatch.summary.agentJobs.shown,1);
    f.queue.rows=[];f.launches[0].onExit(0);
  }finally{f.close();}
});

test('fast shopping continuation requires configured delay and confirmed current receipts, with ordinary failure and family priority',()=>{
 for(const [proof,exitCode,expected] of [[true,0,2],[false,0,1],[true,1,1]]){
  const f=shoppingDispatchFixture(Array.from({length:25},(_,i)=>({do:'shopping-sesum-placement-review',sourceKey:'sesum-product:'+i,sourceFingerprint:'fp'+i})),{shoppingProgressGapSeconds:30});
  f.store.shopping.agentProgressSince=()=>proof;
  try{f.dispatcher.tick();f.queue.rows=f.queue.rows.slice(20);f.launches[0].onExit(exitCode);f.clock.at+=29000;f.dispatcher.tick();assert.equal(f.launches.length,1);f.clock.at+=2000;f.dispatcher.tick();assert.equal(f.launches.length,expected);if(expected===2)f.launches[1].onExit(0);}finally{f.close();}
 }
 const f=shoppingDispatchFixture([{do:'shopping-product-review',productKey:'kassal:ODA_NO:1',watchId:'family'}],{shoppingProgressGapSeconds:30});f.store.shopping.agentProgressSince=()=>true;
 try{f.dispatcher.tick();f.queue.rows=[{do:'shopping-product-review',productKey:'kassal:ODA_NO:2'}];f.launches[0].onExit(0);f.clock.at+=31000;f.store.phone.list=()=>[{status:'queued'}];f.dispatcher.tick();assert.equal(f.launches.length,1);}finally{f.close();}
});

test('campaign and linked offer terms wake the shopping agent at the same count, while price-date-only replay does not',()=>{
  const row={do:'shopping-sesum-offer-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',watchId:'family',familyFingerprint:'family-a',campaignFingerprint:'campaign-a',offerTermsFingerprint:'offer-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.shoppingOnly,true);assert.equal(initial.count,1);
  row.observedAt='2026-11-10T00:00:00Z';row.fetchedAt='2026-11-10T01:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.campaignFingerprint='campaign-b';const changed=changeSignal(store);assert.equal(changed.count,1);assert.notEqual(changed.signature,initial.signature);
  row.offerTermsFingerprint='offer-b';const offer=changeSignal(store);assert.notEqual(offer.signature,changed.signature);
  row.familyFingerprint='family-b';assert.notEqual(changeSignal(store).signature,offer.signature);
});

test('new source family research changes wake dispatch while ordinary receipt replay does not',()=>{
  const row={do:'shopping-sesum-family-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',watchId:'family',familyFingerprint:'family-a',registrationFingerprint:'product-groups-a',fingerprint:'research-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.shoppingOnly,true);assert.equal(initial.count,1);
  row.observedAt='2026-11-10T12:00:00Z';row.fetchedAt='2026-11-10T13:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.registrationFingerprint='product-groups-b';row.fingerprint='research-b';const changed=changeSignal(store);assert.equal(changed.count,1);assert.notEqual(changed.signature,initial.signature);
  row.familyFingerprint='family-b';assert.notEqual(changeSignal(store).signature,changed.signature);
});

test('all-family placement wakes on semantic source/product/family-set change without price-date churn',()=>{
  const row={do:'shopping-sesum-placement-review',sourceKey:'sesum:KIWI:123',sourceFingerprint:'source',registrationFingerprint:null,familySetFingerprint:'set-a'};
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),shopping:{queue:()=>[row]}};
  const initial=changeSignal(store);assert.equal(initial.count,1);assert.equal(initial.shoppingOnly,true);
  row.observedAt='2026-11-10T12:00:00Z';row.fetchedAt='2026-11-10T13:00:00Z';assert.equal(changeSignal(store).signature,initial.signature);
  row.registrationFingerprint='current-reviewed-product-groups';const product=changeSignal(store);assert.notEqual(product.signature,initial.signature);
  row.familySetFingerprint='set-b';assert.notEqual(changeSignal(store).signature,product.signature);
});

test('an edit to an already pending source item changes the dispatch signal',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));
  try{
    const store=createStore(dir);
    const base={source:'vigilo',surface:'child3:news',items:[{externalId:'vigilo:news:pending',title:'Ukeplan',sourceExcerpt:'Første versjon',publishedAt:new Date().toISOString()}]};
    store.observeListing(base);
    const first=changeSignal(store).signature;
    store.observeListing({...base,items:[{...base.items[0],sourceExcerpt:'Rettet versjon'}]});
    assert.notEqual(changeSignal(store).signature,first);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a newly fetched original wakes unchanged pending work while failed attempts do not',()=>{
  const externalId='vigilo:news:9ea103df0eca8729525880a879b129a6';
  const store={snapshot:()=>({rawItems:{},events:{}}),reviewQueue:()=>({items:[{source:'vigilo',externalId,listingHash:'same',reason:'new'}]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]})};
  const file={id:'pdf',source:'vigilo',refs:['vigilo:news:9ea103df-0eca-8729-5258-80a879b129a6'],status:'error',attempts:1};
  const resources={list:({status})=>file.status===status?[file]:[]};
  const initial=changeSignal(store,resources).signature;
  file.attempts++;assert.equal(changeSignal(store,resources).signature,initial);
  Object.assign(file,{status:'ready',sha256:'real-content'});
  assert.notEqual(changeSignal(store,resources).signature,initial,'bytes arriving need reading even if the source list is unchanged');
  const ready=changeSignal(store,resources).signature;
  file.attempts++;assert.equal(changeSignal(store,resources).signature,ready);
});

test('a daily full run can report the explicit alle scope',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));
  try{
    const store=createStore(dir);
    const run=store.recordRun({scope:'alle',outcome:'partial',blockers:['Facebook-gruppen krever ny innlogging for å lese innholdet.'],resumeHint:'Logg inn i gruppen og fortsett gjennomgangen.'});
    assert.equal(run.scope,'alle');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('change dispatcher owns one lease, preserves family priority, survives restart and bounds retries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.now(),lease=null,phones=[],launches=[],queue=[{source:'vigilo',externalId:'x',listingHash:'1',reason:'new'}];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>phones},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  const args={store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,minGapMinutes:15}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true};
  try{let d=createIngestionDispatcher(args);phones=[{status:'queued'}];d.tick();assert.equal(launches.length,0);phones=[];d.tick();assert.equal(launches.length,1);assert.match(launches[0].prompt,/kildeendringer/);d.tick();assert.equal(launches.length,1);const restored=createIngestionDispatcher(args);restored.tick();assert.equal(launches.length,1);launches[0].onExit(0);assert.equal(lease,null);d.tick();assert.equal(launches.length,1);clock+=31*60000;d.tick();assert.equal(launches.length,2);launches[1].onExit(1);clock+=121*60000;d.tick();assert.equal(launches.length,3);launches[2].onExit(1);clock+=86400000;d.tick();assert.equal(launches.length,3);queue[0].listingHash='2';d.tick();assert.equal(launches.length,4,'a real source edit wakes the worker');queue=[];launches[3].onExit(0);assert.equal(changeSignal(store).signature,null);
  }finally{assert.ok(dir.includes('familien-dispatch-'));rmSync(dir,{recursive:true,force:true});}
});

test('dispatcher waits for a blocked original instead of launching Luna for the same file',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-09-29T07:00:00Z'),lease=null,launches=0,queue=[];
  const externalId='spond:files:native-file';
  const store={snapshot:()=>({runLease:lease,rawItems:{raw:{externalId,revision:1}},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:[{rawId:'raw',kind:'source-original',fileName:'Hallvakt.pdf (original)'}],unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun:()=>{}};
  const resources={list:()=>[{fileName:'Hallvakt.pdf',status:'error',retryAt:'2026-09-29T08:00:00Z'}]};
  const args={store,resources,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,minGapMinutes:15}),launch:()=>{launches++;return {pid:123};},alive:()=>true};
  try{
    const d=createIngestionDispatcher(args);d.tick();assert.equal(launches,0);assert.equal(d.status().retryAt,Date.parse('2026-09-29T08:00:00Z'));
    clock+=31*60000;d.tick();assert.equal(launches,0,'the normal dispatcher retry must not precede the resource retry');
    queue=[{source:'vigilo',externalId:'new',listingHash:'1',reason:'new'}];d.tick();assert.equal(launches,1,'new source work must still start immediately');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('multiple references to a known rejected Google original do not restart Luna, but new work and restored bytes do',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-known-auth-'));let lease=null,queue=[],extraMissing=[],launches=[];
  const raw={source:'vigilo',externalId:'vigilo:news:old',revision:1};
  const blocked={id:'doc',source:'vigilo',refs:[raw.externalId],url:'https://docs.google.com/document/d/EXAMPLE_DOCUMENT_ID/edit',fileName:'edit',status:'error',authRequired:true,attempts:13};
  const store={snapshot:()=>({runLease:lease,rawItems:{a:raw,b:raw},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:queue}),completionReport:()=>({profileReviews:[],missingDrive:['a','b'].map(rawId=>({rawId,kind:'source-original',fileName:'Uke 44 (Google Dokument)'})).concat(extraMissing),unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun(){}};
  const resources={list:({status}={})=>!status||blocked.status===status?[blocked]:[]};
  const d=createIngestionDispatcher({store,resources,root:'.',dataDir:dir,clock:()=>Date.parse('2026-10-26T08:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
  try{
    d.tick();d.tick();assert.equal(launches.length,0);
    extraMissing=[{rawId:'a',kind:'source-original',fileName:'Ny ukeplan.pdf'}];d.tick();
    assert.equal(launches.length,1,'a new missing original must not be confused with the known Google failure');
    extraMissing=[];launches[0].onExit(0);d.tick();assert.equal(launches.length,1);
    queue=[{source:'vigilo',externalId:'new',listingHash:'1',reason:'new'}];d.tick();
    assert.equal(launches.length,2,'new source work is not blocked by the old document');
    queue=[];launches[1].onExit(0);d.tick();assert.equal(launches.length,2);
    Object.assign(blocked,{status:'ready',authRequired:false,sha256:'actual-bytes'});d.tick();
    assert.equal(launches.length,3,'restored original bytes wake the worker');
    launches[2].onExit(0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a preserved login response does not restart Luna, while restored original bytes still do',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-response-'));let lease=null,launches=[];
  const raw={source:'facebook',externalId:'facebook:post:1',revision:1,attachments:[{fileName:'file.docx',contentError:'Kilden returnerte en innloggingsside, ikke originalen.'}]};
  const resource={id:'f',source:'facebook',refs:[raw.externalId],fileName:'file.docx',status:'needs_browser',authRequired:true,attempts:1};
  const store={snapshot:()=>({runLease:lease,rawItems:{a:raw},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[{rawId:'a',kind:'source-original',fileName:'file.docx'}],unsyncedCalendar:[]}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;},renewRun(){}};
  const resources={list:({status}={})=>!status||resource.status===status?[resource]:[]};
  try{
    const d=createIngestionDispatcher({store,resources,root:'.',dataDir:dir,clock:()=>Date.parse('2026-10-30T08:00:00Z'),readConfig:()=>({enabled:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
    d.tick();assert.equal(launches.length,0);
    Object.assign(resource,{status:'ready',authRequired:false,sha256:'real-original'});d.tick();assert.equal(launches.length,1);launches[0].onExit(0);
  }finally{assert.ok(dir.startsWith(join(tmpdir(),'familien-dispatch-response-')));rmSync(dir,{recursive:true,force:true});}
});

test('missed 07 full run starts when the lease becomes free and is not duplicated',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-09-29T05:14:00Z'),lease={token:'other'},launches=[],runs=[];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs,nextCursor:null}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:token=>{assert.equal(token,lease.token);lease=null;},renewRun:()=>{}};
  const args={store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:0}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true};
  try{
    const d=createIngestionDispatcher(args);
    d.tick();assert.equal(launches.length,0,'allow the scheduled 07 run to start first');
    clock+=60000;d.tick();assert.equal(launches.length,0,'another run owns the lease');
    lease=null;d.tick();assert.equal(launches.length,1);assert.match(launches[0].prompt,/daglige fulle kildekontrollen/);assert.equal(d.status().workerScope,'alle');
    runs=[{scope:'alle',outcome:'partial',startedAt:new Date(clock).toISOString()}];
    launches[0].onExit(0);d.tick();assert.equal(launches.length,1,'a partial full run still counts as the daily attempt');
    clock+=3600000;d.tick();assert.equal(launches.length,2,'a partial without a valid source checkpoint cannot certify the daily full run');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('confirmed ChatGPT login recovery retries a missed full run immediately',()=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-'));let clock=Date.parse('2026-10-25T08:00:00Z'),lease=null;const launches=[],runs=[];
  const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({hsia:{candidates:0},changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs,nextCursor:null}),beginRun:()=>lease?{acquired:false}:{acquired:true,lease:lease={token:'owned'}},endRun:()=>{lease=null;},renewRun:()=>{}};
  const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>clock,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:15}),launch:input=>{launches.push(input);return {pid:123};},alive:()=>true});
  try{
    assert.throws(()=>d.resumeAfterLogin(),/Ingen registrert/);
    d.tick();assert.equal(launches.length,1);
    launches[0].onExit(1,'ChatGPT eller en tilkoblet konto krever ny innlogging.');
    assert.equal(d.status().running,false);
    assert.ok(d.status().dailyFull.retryAt>clock);
    d.resumeAfterLogin();
    assert.equal(launches.length,2,'login recovery bypasses the retry time and minimum gap');
    assert.equal(d.status().workerScope,'alle');
    d.resumeAfterLogin();assert.equal(launches.length,2,'an active run is not duplicated');
    launches[1].onExit(1,'ChatGPT eller en tilkoblet konto krever ny innlogging.');
    runs.unshift({scope:'alle',outcome:'partial',startedAt:new Date(clock).toISOString(),finishedAt:new Date(clock+1000).toISOString()});
    assert.equal(d.status().lastError,null,'a newer full report clears the obsolete login error');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a completed morning check spanning 07 prevents a duplicate fallback in summer and winter time',()=>{
  for(const boundary of ['2026-10-24T05:00:00Z','2026-10-27T06:00:00Z']){
    const seven=Date.parse(boundary),iso=minutes=>new Date(seven+minutes*60000).toISOString();
    for(const [label,run,expected] of [
      ['early scheduled partial',{scope:'alle',outcome:'partial',startedAt:iso(-3),finishedAt:iso(12)},1],
      ['early scheduled ok',{scope:'alle',outcome:'ok',startedAt:iso(-3),finishedAt:iso(12)},0],
      ['earlier full check ends before 07',{scope:'alle',outcome:'partial',startedAt:iso(-30),finishedAt:iso(-10)},1],
      ['change scope crosses 07',{scope:'kildeendringer',outcome:'partial',startedAt:iso(-3),finishedAt:iso(12)},1],
      ['skipped check',{scope:'alle',outcome:'skipped',startedAt:iso(-3),finishedAt:iso(12)},1],
      ['missing finish',{scope:'alle',outcome:'partial',startedAt:iso(-3)},1],
      ['previous day',{scope:'alle',outcome:'partial',startedAt:iso(-1440),finishedAt:iso(-1430)},1]
    ]){
      const dir=mkdtempSync(join(tmpdir(),'familien-dispatch-morning-'));let launches=0,lease=null;
      const store={snapshot:()=>({runLease:lease,rawItems:{},events:{}}),phone:{list:()=>[]},calendarActions:()=>[],activityFacebook:()=>[],activityFeedStatus:()=>({changedPages:[]}),reviewQueue:()=>({items:[]}),completionReport:()=>({profileReviews:[],missingDrive:[],unsyncedCalendar:[]}),runHistory:()=>({runs:[run],nextCursor:null}),beginRun:()=>({acquired:true,lease:lease={token:'owned'}}),endRun:()=>{lease=null;}};
      try{
        const d=createIngestionDispatcher({store,root:'.',dataDir:dir,clock:()=>seven+15*60000,readConfig:()=>({enabled:true,dailyFullFallback:true,minGapMinutes:0}),launch:({prompt})=>{launches++;assert.match(prompt,/gjenbruk feilkontrollpunktet/);return {pid:123};},alive:()=>true});
        d.tick();assert.equal(launches,expected,`${boundary}: ${label}`);
      }finally{rmSync(dir,{recursive:true,force:true});}
    }
  }
});
