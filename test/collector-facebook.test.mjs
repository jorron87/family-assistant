import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../config/vigilo-keepalive/collector-facebook.js';
import { createStore } from '../src/store.mjs';
import { normalizeFacebookPosts } from '../src/collector.mjs';

// Innlegget er alltid fra i går (hel time), så det ligger innenfor det rullerende 30-dagersvinduet. Fast dato råtnet.
const CREATED = Math.floor(Date.now() / 3600000) * 3600 - 86400;
const CREATED_DAY = new Date(CREATED * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
const fb = globalThis.FamilienFacebook;
const GROUP = '9588369767575429';

// Formet etter Relay-dataene sett i gruppesiden: Story med comet_sections, message.text, actors, feedback_context.
const story = (over = {}) => ({
  __typename: 'Story', id: 'UzpfSTEx', post_id: '9975171322480569', creation_time: CREATED, attachments: [],
  actors: [{ __typename: 'User', name: 'Rigmor', id: '1', url: 'https://www.facebook.com/x' }],
  wwwURL: `https://www.facebook.com/groups/${GROUP}/posts/9975171322480569/`,
  comet_sections: {
    content: { story: { message: { text: 'Halloweenfest for trinnet?\nHa en fin høstferie!' }, post_id: '9975171322480569' } },
    feedback: { story: { story_ufi_container: { story: { feedback_context: {
      interesting_top_level_comments: [{ comment: { id: 'c1', body: { text: 'Supert forslag' }, author: { name: 'Elene', id: '2' }, created_time: 1790601000, feedback: { total_reply_count: 0 } } }],
      feedback_target_with_context: { comment_rendering_instance: { comments: { total_count: 1 } } }
    } } } } }
  },
  ...over
});
const wrap = (...stories) => ({ data: { node: { group_feed: { edges: stories.map((node) => ({ node })) } } } });

test('extractStories finner Story-noder uansett hvor de ligger i treet', () => {
  const found = fb.extractStories(wrap(story(), story({ post_id: '9912023752657060', wwwURL: 'https://www.facebook.com/groups/x/posts/9912023752657060/' })));
  assert.equal(found.size, 2);
  const one = found.get('9975171322480569');
  assert.equal(one.text, 'Halloweenfest for trinnet?\nHa en fin høstferie!');
  assert.equal(one.author, 'Rigmor');
  assert.equal(one.created, CREATED);
  assert.equal(one.commentCount, 1);
  assert.deepEqual(one.comments.map((c) => [c.id, c.author, c.text]), [['c1', 'Elene', 'Supert forslag']]);
  assert.match(one.url, /posts\/9975171322480569/);
  // Andre noder og ufullstendige stories ignoreres.
  assert.equal(fb.extractStories({ a: [{ __typename: 'Story', post_id: '1' }, { __typename: 'User', post_id: '2', creation_time: 1 }] }).size, 0);
});

test('parseChunks tåler strømmede svar med flere linjer og halve linjer', () => {
  const text = [JSON.stringify(wrap(story())), 'ikke json', '{"halv":', JSON.stringify({ label: 'x', data: story({ post_id: '9727519130105396' }) })].join('\n');
  const trees = fb.parseChunks(text);
  assert.equal(trees.length, 2);
  assert.equal(fb.extractStories(trees[1]).size, 1);
  assert.equal(fb.groupFromPath('/groups/9588369767575429/events'), '9588369767575429');
  assert.equal(fb.groupFromPath('/marketplace'), null);
});

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'familien-fb-'));
  try { return fn(createStore(dir)); }
  finally { assert.ok(dir.startsWith(join(tmpdir(), 'familien-fb-'))); rmSync(dir, { recursive: true, force: true }); }
}
const send = (store, posts, groupId = GROUP) => store.collectorIngest({ source: 'facebook', kind: 'posts', groupId, complete: false, items: posts.map(fb.toItem) });
const one = (over) => fb.extractStories(wrap(story(over))).values().next().value;

test('Facebook-innlegg: konfigurert gruppe tas imot, ukjent gruppe ignoreres, og token ignorerer støy', () => fixture((store) => {
  const result = send(store, [one()]);
  assert.equal(result.results[0].surface, `group-${GROUP}:posts`);
  assert.equal(result.results[0].needsReview, 1);
  assert.equal(send(store, [one()], '999').ignored, 'ukjent gruppe');
  const [a] = normalizeFacebookPosts([fb.toItem(one())]);
  const [b] = normalizeFacebookPosts([fb.toItem(one({ view_count: 999 }))]);
  assert.equal(a.token, b.token);
  assert.equal(a.externalId, 'facebook:post:9975171322480569');
  assert.equal(a.title, 'Halloweenfest for trinnet?');
}));

test('unrelated personal posts in a group tab are not attributed to that group',()=>fixture(store=>{
  const unrelated=story({post_id:'94902977818511058',wwwURL:'https://www.facebook.com/james.g.lea/posts/pfbid-example'});
  const candidate=one(unrelated);
  assert.equal(candidate.groupId,null);
  assert.equal(candidate.groupProof,null);
  const result=send(store,[candidate]);
  assert.equal(result.results[0].count,0);
  assert.throws(()=>store.collectedItem('facebook:post:94902977818511058'),/Ukjent samlet element/);
  const groupPost=one(story({post_id:'9934496309877182',wwwURL:'https://www.facebook.com/james/posts/example',target_group:{id:GROUP}}));
  assert.equal(send(store,[groupPost]).results[0].count,1,'an explicit target group is sufficient even with an author URL');
  assert.equal(store.collectedList('facebook',`group-${GROUP}:posts`).length,1);
  assert.equal(store.collectedList('facebook',`group-999:posts`).length,0);
  send(store,[one({post_id:'9178333469191461',target_group:{id:'962077861881912'},wwwURL:'https://www.facebook.com/groups/962077861881912/posts/9178333469191461/'})], '962077861881912');
  assert.equal(store.collectedList('facebook','activity:activity-1').length,1,'activity cache remains available separately');
}));

test('Facebook: agentens tidligere gjennomgang godtas som utgangspunkt, ny kommentar gir gjennomgang, og flaten settes aldri ok av samleren', () => fixture((store) => {
  store.observeListing({ source: 'facebook', surface: `group-${GROUP}:posts`, items: [{ externalId: 'facebook:post:9975171322480569', title: 'Halloweenfest', summary: 's', publishedAt: CREATED_DAY }] });
  store.markReviewed({ source: 'facebook', surface: `group-${GROUP}:posts`, externalId: 'facebook:post:9975171322480569', relevance: 'irrelevant', reviewNote: 'Ikke aktuelt.' });
  // Kommentar uten tidspunkt kan ikke avvises som gammel: leses på nytt.
  const noTime = story();
  delete noTime.comet_sections.feedback.story.story_ufi_container.story.feedback_context.interesting_top_level_comments[0].comment.created_time;
  assert.equal(send(store, [one(noTime)]).results[0].needsReview, 1);
  store.markReviewed({ source: 'facebook', surface: `group-${GROUP}:posts`, externalId: 'facebook:post:9975171322480569', relevance: 'irrelevant', reviewNote: 'Ok.' });
  assert.equal(send(store, [one(noTime)]).results[0].needsReview, 0, 'uendret etter ny gjennomgang');
  const more = story();
  more.comet_sections.feedback.story.story_ufi_container.story.feedback_context.interesting_top_level_comments.push({ comment: { id: 'c2', body: { text: 'Kan noen hjelpe til?' }, author: { name: 'Per' }, created_time: 1790609999 } });
  assert.equal(send(store, [one(more)]).results[0].needsReview, 1);
  assert.notEqual(store.snapshot().surfaces[`facebook:group-${GROUP}:posts`].health, 'ok');
  const item = store.collectedItem('facebook:post:9975171322480569');
  assert.equal(item.comments.length, 2);
  assert.equal(item.text.startsWith('Halloweenfest'), true);
}));

test('autoScroll ruller til det ikke kommer flere innlegg og gir opp når feeden står stille', async () => {
  let count = 1, scrolls = 0;
  const slept = [];
  const env = { scroll: () => { scrolls++; if (scrolls <= 4) count += 3; }, sleep: async (ms) => { slept.push(ms); }, count: () => count, random: () => 0.5 };
  const result = await fb.autoScroll(env, { maxScrolls: 14, patience: 3 });
  assert.equal(result.stories, 13);
  assert.equal(result.steps, 7, '4 steg med nye innlegg + 3 tomme');
  assert.equal(result.stalled, false);
  assert.ok(slept.every((ms) => ms >= 1500 && ms <= 3000), 'rolige, litt tilfeldige pauser');
  const stuck = await fb.autoScroll({ scroll: () => {}, sleep: async () => {}, count: () => 1, random: () => 0 }, { maxScrolls: 14, patience: 3 });
  assert.deepEqual([stuck.steps, stuck.stalled], [3, true], 'feed som ikke laster er «stalled»');
  const capped = await fb.autoScroll({ scroll: () => { count += 1; }, sleep: async () => {}, count: () => count, random: () => 0 }, { maxScrolls: 5, patience: 3 });
  assert.equal(capped.steps, 5);
});

test('dueSlot: kjører hver tidsluke én gang per dag, bare innenfor tre timer etter klokkeslettet', () => {
  const times = ['06:20', '21:40'];
  assert.equal(fb.dueSlot(times, {}, '2026-09-29', '06:19'), null);
  assert.equal(fb.dueSlot(times, {}, '2026-09-29', '06:20'), '06:20');
  assert.equal(fb.dueSlot(times, { '06:20': '2026-09-29' }, '2026-09-29', '07:10'), null, 'allerede kjørt i dag');
  assert.equal(fb.dueSlot(times, { '06:20': '2026-09-28' }, '2026-09-29', '07:10'), '06:20', 'i går teller ikke');
  assert.equal(fb.dueSlot(times, {}, '2026-09-29', '10:00'), null, 'for sent (mer enn tre timer)');
  assert.equal(fb.dueSlot(times, { '06:20': '2026-09-29' }, '2026-09-29', '22:05'), '21:40');
  assert.equal(fb.dueSlot([], {}, '2026-09-29', '12:00'), null);
  assert.equal(fb.dueSlot(['08:20', '09:20', '10:20'], {}, '2026-09-29', '10:25'), '10:20', 'siste forfalte luke velges, ikke den eldste');
});

test('samler-konfigurasjonen gir Facebook-sveip med kun numeriske gruppe-ID-er', () => fixture((store) => {
  const config = store.collectorConfig().facebook;
  assert.equal(config.enabled, true);
  assert.ok(config.sweepTimes.length >= 2 && config.sweepTimes.every((time) => /^\d\d:\d\d$/.test(time)));
  assert.ok(config.groups.length >= 4 && config.groups.every((id) => /^\d+$/.test(id)));
  assert.ok(config.groups.includes('9588369767575429'));
  assert.equal(store.collectorIngest({ source: 'facebook', kind: 'health', health: 'stalled', detail: 'sveip' }).ok, true);
}));

test('detached comments and replies attach only to an explicitly known feedback ID',()=>{
  const original={postId:'123456789',feedbackIds:['feedback1'],comments:[{id:'c1',text:'Before'}]};const known=new Map([['feedback1',original]]);
  const response={data:{node:{id:'feedback1',comments:{edges:[{node:{__typename:'Comment',id:'c1',body:{text:'Corrected'}}},{node:{__typename:'Comment',id:'c2',body:{text:'New reply'},feedback:{total_reply_count:0}}}]}}}};
  const result=fb.commentUpdates(response,known).get(original.postId);assert.equal(result.comments.length,2);assert.equal(result.comments[0].text,'Corrected');assert.equal(fb.commentUpdates(response,new Map()).size,0);
  const body=new URLSearchParams({variables:JSON.stringify({feedbackID:'feedback1'})}).toString();assert.equal(fb.requestedFeedback(body,known),'feedback1');assert.equal(fb.requestedFeedback(body,new Map()),null);
  assert.equal(fb.commentUpdates({data:{comment:{__typename:'Comment',id:'c3',body:{text:'Reply'}}}},known,'feedback1').get(original.postId).comments.length,2);
});
