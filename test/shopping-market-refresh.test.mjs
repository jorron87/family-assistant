import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshReviewedMarket} from '../src/shopping-market-refresh.mjs';
const entry={id:'1',store:'KIWI',name:'Beans',fingerprint:'same',status:'approved',packAmount:.5,unit:'kg',equivalenceEvidence:'Label and fixed pack reviewed'};
function fixture(){let rows=[{...entry}],market=null;const shopping={catalogEntries:()=>structuredClone(rows),catalogObserve:()=>{},market:input=>{market=input;return {status:'insufficient'};}};const kassal={product:async()=>({data:{id:1,store:{code:'KIWI'},name:'Beans',current_price:20,price_history:[{date:'2026-11-10T12:00:00Z',price:20}]}})};return {shopping,kassal,rows,get market(){return market;}};}
test('routine market refresh retains reviewed pack and actual receipt, never fetch time',async()=>{const f=fixture();await refreshReviewedMarket({...f,watchId:'beans'});assert.equal(f.market.products[0].packAmount,.5);assert.equal(f.market.products[0].lastChecked,'2026-11-10T12:00:00Z');assert.equal(f.market.windowDays,90);});
test('pending and changed metadata retain agent review and never recalibrate',async()=>{for(const pending of [true,false]){const f=fixture();if(pending)f.rows[0].status='pending';else f.shopping.catalogObserve=()=>{f.rows[0].status='pending';f.rows[0].fingerprint='new';};const r=await refreshReviewedMarket({...f,watchId:'beans'});assert.equal(r.deferred,true);assert.equal(f.market,null);}});
test('source chain mismatch cannot transfer a reviewed identity',async()=>{const f=fixture();f.kassal.product=async()=>({data:{id:1,store:{code:'MENY'}}});await assert.rejects(refreshReviewedMarket({...f,watchId:'beans'}),/identity/);assert.equal(f.market,null);});

test('concurrent review changes cannot be overwritten or used for calibration after I/O',async()=>{
 for(const change of [{fingerprint:'new-source'},{status:'excluded'},{packAmount:2},{equivalenceEvidence:'A new restricted decision'}]){
  const f=fixture(),read=f.kassal.product;let observed=0;
  f.shopping.catalogObserve=()=>{observed++;};
  f.kassal.product=async()=>{const response=await read();Object.assign(f.rows[0],change);return response;};
  const result=await refreshReviewedMarket({...f,watchId:'beans'});
  assert.equal(result.reason,'review-changed-during-refresh');assert.equal(observed,0);assert.equal(f.market,null);
 }
});

test('a review changed while a later product loads invalidates the whole calibration',async()=>{
 const f=fixture();f.rows.push({...entry,id:'2'});const read=f.kassal.product;
 f.kassal.product=async({id})=>{const response=await read();response.data.id=id;if(id===2)f.rows[0].packAmount=2;return response;};
 const result=await refreshReviewedMarket({...f,watchId:'beans'});
 assert.equal(result.reason,'review-changed-during-refresh');assert.equal(f.market,null);
});
