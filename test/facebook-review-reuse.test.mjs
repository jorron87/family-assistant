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
function fixture(fn){const dir=mkdtempSync(join(tmpdir(),'familien-fb-reuse-'));try{return fn(createStore(dir),dir);}finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+'\\'));rmSync(dir,{recursive:true,force:true});}}
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

test('archive lookup routes to the actual current payload and leaves changed work unread',()=>fixture(s=>{
 const original=post({text:'Original announcement'});
 ingest(s,original);
 const raw=s.upsertRaw({source:'facebook',externalId,title:'Original announcement',body:original.text}).item;
 s.markReviewed({source:'facebook',surface,externalId,rawId:raw.id,relevance:'relevant'});
 const before=Object.values(s.snapshot().reviewLedger)[0].reviewedAt;
 ingest(s,{...original,text:'The meeting date has actually changed.'});
 const row=s.sourceItems({source:'facebook',externalIds:[externalId]})[0];
 assert.equal(row.raws[0].id,raw.id);
 assert.equal(row.raws[0].revision,1,'a lookup does not rewrite the archived source');
 assert.equal(row.reading.contentRead,false);
 const current=s.collectedItem(row.reading.current.args[0]);
 assert.equal(row.reading.current.command,'collected');
 assert.equal(current.text,'The meeting date has actually changed.');
 assert.equal(row.reading.current.changeToken,current.token);
 assert.equal(s.completionReport().pendingItems.length,1,'neither lookup nor collected read certifies review');
 assert.equal(Object.values(s.snapshot().reviewLedger)[0].reviewedAt,before);
 const unknown=s.sourceItems({source:'facebook',externalIds:['facebook:post:9999999999999999']})[0];
 assert.equal(unknown.known,false);assert.equal(unknown.reading.current,null);
}));

test('explicit post-text irrelevance survives comment changes and restart, but actual post changes reopen it',()=>fixture((s,dir)=>{
 const base=post({text:'Invitation only for a different school class. '.repeat(12),comments:[],commentCount:0});
 ingest(s,base);
 s.markReviewed({source:'facebook',surface,externalId,relevance:'irrelevant',relevanceBasis:'post-text',reviewNote:'Read the complete post: explicitly addressed to another class, with no family invite or action.'});
 const receipt=()=>Object.values(s.snapshot().reviewLedger).find(e=>e.externalId===externalId);
 const reviewedAt=receipt().reviewedAt;
 assert.ok(reviewedAt);
 const changed={...base,commentCount:4,comments:[{id:'new-comment',text:'Another household accepts',replies:null}]};
 assert.equal(ingest(s,changed).results[0].needsReview,0);
 s=createStore(dir);
 assert.equal(receipt().reviewedAt,reviewedAt);
 assert.equal(ingest(s,changed).results[0].needsReview,0);
 assert.equal(s.collectedItem(externalId).commentsComplete,false);
 assert.equal(s.completionReport().pendingItems.length,0);
 assert.equal(ingest(s,{...changed,attachments:['new flyer']}).results[0].needsReview,1);
 assert.equal(ingest(s,{...changed,text:base.text+' The household class is now invited too.'}).results[0].needsReview,1);
 assert.equal(receipt().reviewedAt,reviewedAt,'collection never manufactures another reading receipt');
}));

test('post-text irrelevance cannot hide linked work or an empty post',()=>fixture(s=>{
 ingest(s,post({text:''}));
 const input={source:'facebook',surface,externalId,relevance:'irrelevant',relevanceBasis:'post-text',reviewNote:'A detailed reason cannot replace the missing actual full post body.'};
 assert.throws(()=>s.markReviewed(input),/Posttekst-grunnlag/);
 ingest(s,post());
 s.markReviewed(input);
 s.upsertActivity({canonicalKey:'linked-example',sourceId:'activity-1',sourceUrl:`https://www.facebook.com/groups/${group}/posts/9091057070884730/`,title:'Family activity',start:'2026-12-01T10:00:00Z',end:'2026-12-01T12:00:00Z',checkedAt:new Date().toISOString(),members:['child1'],reason:'Actual family plan',evidence:'Source confirms date and activity.'});
 assert.equal(s.completionReport().pendingItems.length,1,'new linked work reopens even without a new collection');
 assert.throws(()=>s.markReviewed(input),/Posttekst-grunnlag/);
}));

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
