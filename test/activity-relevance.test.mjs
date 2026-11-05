import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';

const groupId='962077861881912',postId='123456789012345',externalId='facebook:post:'+postId;
const evidence='Read the actual post: a lost umbrella with no event, deadline or connection to the family.';
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'family-relevance-'));try{fn(createStore(dir),dir);}finally{rmSync(dir,{recursive:true,force:true});}}
function observe(store,overrides={}){store.collectorIngest({source:'facebook',kind:'posts',groupId,items:[{postId,groupId,groupProof:'target_group',created:Math.floor(Date.now()/1000),text:'Lost umbrella outside the station.',attachments:[],comments:[],commentCount:10,...overrides}]});}
const status={sourceId:'activity-1',health:'partial',details:'Targeted post review only; feed coverage is unchanged.',scanTo:'2026-11-30'};
function hole(store){store.activitySource({...status,unresolvedItems:[{externalId,reason:'Reported comment count exceeds the available thread.'},{externalId:'facebook:post:987654321000000',reason:'Actual post body remains unavailable.'}]});}
const resolve=store=>store.activitySource({...status,resolvedItems:[{externalId,resolution:'irrelevant',evidence}]});

test('irrelevance needs actual text and a current acknowledged activity post',()=>fixture(store=>{
  observe(store,{text:''});hole(store);store.activityFacebook('activity-1',{ack:true});assert.throws(()=>resolve(store),/Irrelevant krever/);
  observe(store);assert.throws(()=>resolve(store),/Irrelevant krever/);
  store.activityFacebook('activity-1',{ack:true});
  assert.throws(()=>store.activitySource({...status,resolvedItems:[{externalId,resolution:'irrelevant',evidence:'Unrelated post'}]}),/Irrelevant krever/);
  const fixed=resolve(store);assert.equal(fixed.health,'partial');assert.equal(fixed.unresolvedItems.length,1);assert.equal(fixed.lastSuccessfulCheckAt,null);
  assert.equal(fixed.resolutionHistory[0].resolution,'irrelevant');assert.equal(fixed.resolutionHistory[0].evidence,evidence);
}));

test('comment-only changes reuse irrelevance; changed text or attachments return to review after restart',()=>fixture((store,dir)=>{
  const created=Math.floor(Date.now()/1000);observe(store,{created});hole(store);store.activityFacebook('activity-1',{ack:true});resolve(store);
  const reopened=createStore(dir);
  observe(reopened,{created,comments:[{id:'comment-1',text:'Mine',replies:0}],commentCount:11});assert.equal(reopened.activityFacebook('activity-1').length,0);
  assert.equal(reopened.snapshot().activitySourceStatus['activity-1'].unresolvedItems.length,1);
  observe(reopened,{created,text:'Community workshop tomorrow at the library.'});assert.equal(reopened.activityFacebook('activity-1').length,1);
  observe(reopened,{created,attachments:['new poster']});assert.equal(reopened.activityFacebook('activity-1').length,1);
}));

test('linked proposals cannot be discarded as irrelevant',()=>fixture(store=>{
  observe(store);hole(store);store.activityFacebook('activity-1',{ack:true});
  for(const sourceUrl of [`https://www.facebook.com/groups/${groupId}/posts/${postId}/`,`https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${groupId}`]){
    store.upsertActivity({canonicalKey:'example-workshop',sourceId:'activity-1',sourceUrl,title:'Workshop',start:'2026-11-10T12:00:00Z',end:'2026-11-10T14:00:00Z',checkedAt:new Date().toISOString(),members:['child1'],reason:'Family workshop',evidence:'Source confirms the workshop date and place.'});
    assert.throws(()=>resolve(store),/Irrelevant krever/);assert.equal(store.snapshot().activitySourceStatus['activity-1'].unresolvedItems.length,2);
  }
}));
