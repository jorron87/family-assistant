import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {shoppingStore} from '../src/shopping.mjs';
import {createStore} from '../src/store.mjs';
import {createPhoneDispatcher} from '../src/phone-dispatch.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII=','base64');
function harness(){const state={},blobs=new Map();let now=new Date('2026-11-08T12:00:00Z');const shop=shoppingStore(state,{save(){},now:()=>now,files:{write:(id,bytes)=>blobs.set(id,bytes),read:id=>blobs.get(id)}});const watch=shop.watch({id:'tomatoes',name:'Tomater på boks naturell',unit:'kg',storage:'pantry',purchaseAmount:12});return {state,shop,watch,advance:()=>{now=new Date(now.getTime()+1000);}};}
const begin=(shop,extra={})=>shop.stockIntake.begin({clientId:crypto.randomUUID(),text:'15 tomatbokser à 400 gram',location:'Pantry',...extra});
const observation=(watchId,extra={})=>({watchId,amount:6,unit:'kg',confidence:'certain',location:'Pantry',collectionKey:'Tomatbokser på hyllen',evidence:'15 synlige bokser, etiketten viser 400 g naturell tomat. Tilsvarende varegruppe.',imageIds:[],...extra});

test('free inventory text is queued even with monitoring off, applies a reviewed group and can be undone',()=>{
 const {shop,watch}=harness(),entry=begin(shop,{mode:'replace'});shop.stockIntake.submit(entry.id);
 assert.equal(shop.queue()[0].do,'shopping-stock-review');assert.equal(shop.completion().complete,false);
 const result=shop.stockIntake.review({id:entry.id,evidence:'Eksplisitt antall og mengde fra familien',imageIds:[],observations:[observation(watch.id)]});
 assert.equal(result.status,'done');assert.equal(shop.familyView().items[0].stock.amount,6);assert.equal(shop.completion().complete,true);
 shop.stockIntake.review({id:entry.id,evidence:'Repeated',imageIds:[],observations:[observation(watch.id,{amount:99})]});assert.equal(shop.familyView().items[0].stock.amount,6);
 shop.stockIntake.action({id:entry.id,action:'undo'});assert.equal(shop.familyView().items[0].stock.known,false);
});

test('overlapping photos count the same collection once, while a shelf and a drawer add up',()=>{
 const {shop,watch}=harness(),entry=begin(shop,{fileCount:2,mode:'replace'});
 const a=shop.stockIntake.upload(entry.id,0,{bytes:png,fileName:'shelf.png'}),b=shop.stockIntake.upload(entry.id,1,{bytes:png,fileName:'another-angle.png'});
 assert.equal(shop.stockIntake.upload(entry.id,0,{bytes:png}).id,a.id);assert.throws(()=>shop.stockIntake.submit(entry.id+'x'),/Ukjent/);
 shop.stockIntake.submit(entry.id);
 assert.throws(()=>shop.stockIntake.review({id:entry.id,evidence:'Lest',imageIds:[a.id],observations:[]}),/Alle bildene/);
 const result=shop.stockIntake.review({id:entry.id,evidence:'Begge vinkler viser samme 15 bokser. Skuffen er tydelig separat.',imageIds:[a.id,b.id],observations:[observation(watch.id,{imageIds:[a.id]}),observation(watch.id,{amount:5.6,confidence:'estimated',imageIds:[b.id]}),observation(watch.id,{amount:.8,location:'Kjøkkenskuff',collectionKey:'Tomater i skuff',imageIds:[b.id]})]});
 assert.equal(result.result.observations.length,2);assert.equal(result.result.changes[0].amount,6.8);assert.equal(shop.familyView().items[0].stockEvidence.estimated,true);
});

test('unclear sizes remain visible, minimum counts preserve unseen stock, and newer family edits win',()=>{
 const {shop,watch,advance}=harness();shop.pantry({watchId:watch.id,amount:10});
 const entry=begin(shop);shop.stockIntake.submit(entry.id);
 const result=shop.stockIntake.review({id:entry.id,evidence:'Synlig minimum, en annen etikett kan ikke leses',imageIds:[],observations:[observation(watch.id)],unmatched:[{description:'Pose med mat',reason:'Vare og nettovekt er uleselig'}]});
 assert.equal(result.status,'needs_input');assert.equal(shop.familyView().items[0].stock.amount,10);assert.equal(shop.completion().complete,false);
 shop.stockIntake.action({id:entry.id,action:'dismiss'});assert.equal(shop.completion().complete,true);
 const next=begin(shop,{mode:'replace'});shop.stockIntake.submit(next.id);advance();shop.pantry({watchId:watch.id,amount:9});
 assert.throws(()=>shop.stockIntake.review({id:next.id,evidence:'Ny gjennomgang',imageIds:[],observations:[observation(watch.id)]}),/endret siden/);
 assert.throws(()=>shop.stockIntake.action({id:entry.id,action:'undo'}),/endret etter/);assert.equal(shop.familyView().items[0].stock.amount,9);
});

test('upload validation, durable encryption and stock worker leases survive restart without calendar intake',()=>{
 const dir=mkdtempSync(join(tmpdir(),'family-stock-'));let calls=[];
 try{
  const store=createStore(dir),entry=begin(store.shopping,{fileCount:1});
  assert.throws(()=>store.shopping.stockIntake.submit(entry.id),/alle bildene/);
  assert.throws(()=>store.shopping.stockIntake.upload(entry.id,0,{bytes:Buffer.from('<html>login</html>')}),/JPG/);
  const image=store.shopping.stockIntake.upload(entry.id,0,{bytes:png,fileName:'shelf.png'});
  assert.equal(readFileSync(join(dir,'attachments',image.id+'.enc')).includes(png),false);
  store.shopping.stockIntake.submit(entry.id);
  const reopened=createStore(dir);assert.deepEqual(reopened.shopping.stockIntake.image(entry.id,image.id).bytes,png);
  const dispatch=createPhoneDispatcher({store:reopened,root:dir,launch:input=>{calls.push(input);return {pid:2147483647};}});dispatch.tick();
  assert.equal(calls.length,1);assert.match(calls[0].prompt,/scope:"lager"/);assert.match(calls[0].prompt,/maksimum, ikke summen/);assert.deepEqual(reopened.snapshot().phone.worker.stockIds,[entry.id]);assert.equal(reopened.phone.list().length,0);
  const again=createStore(dir);createPhoneDispatcher({store:again,root:dir,launch:()=>{throw Error('backoff');}}).tick();
  assert.equal(again.snapshot().runLease,null);assert.ok(again.shopping.stockIntake.work()[0].retryAt);
  assert.throws(()=>again.recordRun({scope:'lager',outcome:'ok'}),/restanser/);
  again.shopping.stockIntake.action({id:entry.id,action:'cancel'});assert.equal(again.recordRun({scope:'lager',outcome:'ok',summary:'Bare lagerkøen er kontrollert'}).scope,'lager');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an invalid later observation cannot partially change any inventory',()=>{
 const {shop,watch}=harness(),entry=begin(shop);shop.stockIntake.submit(entry.id);
 assert.throws(()=>shop.stockIntake.review({id:entry.id,evidence:'Test',imageIds:[],observations:[observation(watch.id),observation('missing')]}),/Ukjent varegruppe/);
 assert.equal(shop.familyView().items[0].stock.known,false);assert.equal(shop.stockIntake.get(entry.id).status,'queued');
 assert.throws(()=>shop.stockIntake.action({id:'__proto__',action:'cancel'}),/Ukjent/);
 assert.throws(()=>shop.stockIntake.review({id:entry.id,evidence:'Test',imageIds:[],observations:[observation('__proto__')]}),/Ukjent/);
 assert.equal({}.status,undefined);assert.equal({}.stockAmount,undefined);
});
