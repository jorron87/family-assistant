import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {decrypt,encrypt,loadKey} from '../src/crypto.mjs';
import {hsiaHref,hsiaOccurrenceToken} from '../src/activity-feeds.mjs';
const first={start:'2030-10-10T10:00:00Z',end:'2030-10-10T12:00:00Z'};
const second={start:'2030-10-17T10:00:00Z',end:'2030-10-17T12:00:00Z'};
const item={href:'/arrangorer/verksted/?from=2026-10-09',title:'Familieverksted',bubble:'Gratis',venue:'Biblioteket',area:'Røyken',audience:['For alle'],occurrences:[first,second],hash:'original'};
const sweep=rows=>({items:rows,complete:true,total:rows.length,window:{from:'2029-01-01',to:'2031-01-01'},covers:[]});
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'familien-hsia-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,store:createStore(dir)};}
test('only search dates are discarded; other identifiers remain distinct',()=>{
  assert.equal(hsiaHref(item.href),'/arrangorer/verksted/');
  assert.equal(hsiaHref('/arrangorer/verksted/?from=2026-10-10&id=7&amp;to=2026-11-10'),'/arrangorer/verksted/?id=7');
  assert.notEqual(hsiaHref('/arrangorer/verksted/?id=7'),hsiaHref('/arrangorer/verksted/?id=8'));
  assert.equal(hsiaHref('https://example.com/event?from=1'),'https://example.com/event?from=1');
});
test('new day and expired window dates reuse receipts; new date and changed price require reading',t=>{
  const {store}=fixture(t);
  store.activityFeedHsia(sweep([item]));
  store.activityFeedHsia(sweep([{...item,href:'/arrangorer/verksted/?from=2026-10-10'}]));
  assert.equal(store.activityFeedCandidates().total,0);
  store.activityFeedHsia({...sweep([{...item,hash:'window',occurrences:[second]}]),window:{from:'2030-10-11',to:'2031-01-01'}});
  assert.equal(store.activityFeedCandidates().total,0,'rolling window removal is not an edit');
  store.activityFeedHsia(sweep([{...item,hash:'new-date',occurrences:[second,{start:'2030-10-24T10:00:00Z',end:'2030-10-24T12:00:00Z'}]}]));
  assert.equal(store.activityFeedCandidates().total,1);
  store.activityFeedCandidates({ack:true});
  store.activityFeedHsia(sweep([{...item,hash:'paid',bubble:'kr 50',occurrences:[second]}]));
  assert.equal(store.activityFeedCandidates().total,1);
});
test('a missing future occurrence inside the checked window still requires verification',t=>{
  const {store}=fixture(t);store.activityFeedHsia(sweep([item]));
  store.activityFeedHsia(sweep([{...item,hash:'missing-date',occurrences:[second]}]));
  const candidates=store.activityFeedCandidates();
  assert.equal(candidates.total,1);assert.deepEqual(candidates.items[0].removedOccurrences,[first]);
  store.activityFeedCandidates({ack:true});
  store.activityFeedHsia(sweep([{...item,hash:'missing-date',occurrences:[second]}]));
  assert.equal(store.activityFeedCandidates().total,0);
});
test('legacy date links keep acknowledged receipts and details across two restarts',t=>{
  const {dir,store}=fixture(t);store.activityFeedHsia(sweep([item]));
  const path=join(dir,'archive.json.enc'),key=loadKey(dir);
  const state=JSON.parse(decrypt(readFileSync(path),key));
  // Relative tider: lageret rydder elementer som ikke er sett på sju dager, så faste oktoberdatoer råtnet.
  const hour=Math.floor(Date.now()/3600000)*3600000,daysAgo=d=>new Date(hour-d*86400000).toISOString();
  const legacy={...item,reviewedHash:item.hash,reviewedAt:daysAgo(2),firstSeenAt:daysAgo(3),lastSeenAt:daysAgo(2),detail:{description:'Behold originalt uttrekk'}};
  state.activityFeed.hsia.items={[item.href]:legacy,'/arrangorer/verksted/?from=2026-10-10':{...legacy,href:'/arrangorer/verksted/?from=2026-10-10',reviewedHash:null,lastSeenAt:daysAgo(1)}};
  writeFileSync(path,encrypt(Buffer.from(JSON.stringify(state)),key));
  const migrated=createStore(dir);
  assert.equal(migrated.activityFeedCandidates().total,0);
  migrated.activityFeedHsia(sweep([{...item,href:'/arrangorer/verksted/?from=2026-10-11'}]));
  const persisted=JSON.parse(decrypt(readFileSync(path),key));
  assert.equal(persisted.activityFeed.hsia.items[item.href].reviewedAt,legacy.reviewedAt);
  assert.equal(persisted.activityFeed.hsia.items['/arrangorer/verksted/'].detail.description,legacy.detail.description);
  assert.ok(persisted.activityFeed.hsia.items['/arrangorer/verksted/'].reviewedOccurrences.includes(hsiaOccurrenceToken(item,first)));
  assert.equal(createStore(dir).activityFeedCandidates().total,0);
});
