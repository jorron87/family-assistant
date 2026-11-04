import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createStore} from '../src/store.mjs';
import {normalizeFacebookPosts,mergeFacebookPost} from '../src/collector.mjs';

const group='951081777302696', surface=`group-${group}:posts`, externalId='facebook:post:9091057070884730';
const post=(over={})=>({postId:'9091057070884730',created:Math.floor(Date.now()/1000),text:'Felles beskjed',groupId:group,groupProof:'target_group',url:`https://www.facebook.com/groups/${group}/posts/9091057070884730/`,attachments:[],commentCount:2,comments:[{id:'c1',text:'',time:1700000000,replies:0},{id:'c2',text:'',time:1700000000,replies:0}],...over});
const normalized=p=>normalizeFacebookPosts([p])[0];
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'familien-fb-reuse-'));try{return fn(createStore(dir));}finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}}
const ingest=(s,p)=>s.collectorIngest({source:'facebook',kind:'posts',groupId:group,items:[p],complete:false});
const reviewed=s=>s.markReviewed({source:'facebook',surface,externalId,relevance:'irrelevant',reviewNote:'Alle detaljer lest.'});

test('comment order and smaller feed excerpts reuse comments without claiming full observation',()=>{
 const full=normalized(post());
 const reversed=normalized(post({comments:[...post().comments].reverse()}));
 assert.equal(full.token,reversed.token);
 const excerpt=mergeFacebookPost(full,normalized(post({comments:[]})));
 assert.equal(excerpt.token,full.token);assert.equal(excerpt.comments.length,2);
 assert.equal(excerpt.commentsComplete,false);assert.deepEqual(excerpt.cachedCommentIds,['c1','c2']);
 const edit=mergeFacebookPost(excerpt,normalized(post({comments:[{id:'c1',text:'Ny dato',replies:null}]})));
 assert.notEqual(edit.token,full.token);assert.equal(edit.comments.length,2);
 assert.equal(edit.comments[0].replies,0);
 const removed=mergeFacebookPost(edit,normalized(post({commentCount:0,comments:[]})));
 assert.equal(removed.comments.length,0);assert.notEqual(removed.token,edit.token);
});

test('reviewed Facebook receipt survives repeated partial excerpts, edits still reopen it',()=>fixture(s=>{
 ingest(s,post());reviewed(s);
 assert.equal(ingest(s,post({comments:[]})).results[0].needsReview,0);
 assert.equal(ingest(s,post()).results[0].needsReview,0);
 assert.equal(ingest(s,post({commentCount:3,comments:[...post().comments,{id:'c3',text:'Ny avtale',replies:0}]})).results[0].needsReview,1);
 assert.equal(s.collectedItem(externalId).comments.length,3);
}));

test('ID-only Relay references never clear reviewed text or prove complete comments',()=>fixture(s=>{
 const full=post({comments:[{id:'c1',text:'Vi kommer klokken 17',author:'Foresatt',time:1700000000,replies:0},{id:'c2',text:'Ta med støvler',author:'Foresatt',time:1700000000,replies:0}]});
 ingest(s,full);reviewed(s);
 const placeholders=full.comments.map(c=>({id:c.id,text:'',author:null,time:null,replies:null}));
 for(let i=0;i<3;i++) {
   assert.equal(ingest(s,post({comments:placeholders})).results[0].needsReview,0);
   assert.equal(ingest(s,full).results[0].needsReview,0);
 }
 ingest(s,post({comments:placeholders}));
 const cached=s.collectedItem(externalId);
 assert.equal(cached.comments[0].text,full.comments[0].text);
 assert.equal(cached.commentsComplete,false);assert.deepEqual(cached.cachedCommentIds,['c1','c2']);
 const edit=post({comments:[{...full.comments[0],text:'',time:1700000001},full.comments[1]]});
 assert.equal(ingest(s,edit).results[0].needsReview,1,'an explicitly observed empty edit still counts');
 reviewed(s);
 assert.equal(ingest(s,post({commentCount:3,comments:[...placeholders,{id:'c3',text:'',author:null,time:null,replies:null}]})).results[0].needsReview,1,'unknown new ID must be read');
}));

test('unknown reply count and missing text cannot establish completeness',()=>{
 assert.equal(normalized(post({comments:[{id:'c1',text:'Kjent',replies:null},{id:'c2',text:'Kjent',replies:0}]})).commentsComplete,false);
 assert.equal(normalized(post({commentCount:1,comments:[{id:'c1',text:'',textObserved:false,replies:0}]})).commentsComplete,false);
 assert.equal(normalized(post({commentCount:0,comments:[]})).commentsComplete,true);
});

test('only a prior verified historical checkpoint resumes after all changed details are reviewed',()=>fixture(s=>{
 ingest(s,post());reviewed(s);
 const old=new Date(Date.now()-45*86400000).toISOString(), scanTo=new Date().toISOString();
 s.updateSurface({source:'facebook',surface,health:'partial',currentComplete:true,scanTo,historicalGap:{from:old,to:old,reason:'Historisk hull'}});
 ingest(s,post({text:'Rettet beskjed'}));
 assert.equal(s.snapshot().surfaces[`facebook:${surface}`].currentComplete,false);
 reviewed(s);
 const result=s.snapshot().surfaces[`facebook:${surface}`];
 assert.equal(result.currentComplete,true);assert.equal(result.health,'partial');assert.equal(result.scanTo,scanTo);
 assert.equal(s.completionReport().incompleteSurfaces.length,0);
 s.updateSurface({source:'facebook',surface,health:'partial',currentComplete:false,scanTo});
 ingest(s,post({text:'Enda en rettelse'}));reviewed(s);
 assert.equal(s.snapshot().surfaces[`facebook:${surface}`].currentComplete,false,'no unseen surface is completed');
}));

test('manual new scan cancels resumable checkpoint; a collector change cannot complete that scan',()=>fixture(s=>{
 ingest(s,post());reviewed(s);
 const old=new Date(Date.now()-45*86400000).toISOString();
 s.updateSurface({source:'facebook',surface,health:'partial',currentComplete:true,scanTo:new Date().toISOString(),historicalGap:{from:old,to:old,reason:'Historisk hull'}});
 ingest(s,post({text:'Ny beskjed'}));
 s.observeListing({source:'facebook',surface,items:[{externalId,title:'Ny beskjed'}]});reviewed(s);
 assert.equal(s.snapshot().surfaces[`facebook:${surface}`].currentComplete,false);
}));
