import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { normalizeSpondEvents, normalizeSpondPosts, normalizeVigiloNews, normalizeVigiloThreads, normalizeSupplemental } from '../src/collector.mjs';
import { recoveredSpondDiscovery } from '../src/collector.mjs';

test('legacy discovery recovery requires matching complete batches newer than the failure', () => {
  const group='0778F16EAC3269E55B587B44ADBE9010';
  const collector={supplemental:{'spond:discovery:all:':{health:'error',at:'2026-10-06T05:57:00Z'},
    'spond:polls:all:':{health:'ok',complete:true,at:'2026-10-06T06:28:05Z'},
    'spond:payments:all:':{health:'ok',complete:true,at:'2026-10-06T06:28:08Z'}}};
  const surfaces=['polls','payments'].map((section,index)=>({source:'spond',surface:`group-${group}:${section}`,listingObservedAt:`2026-10-06T06:28:${index===0?'05':'08'}.200Z`}));
  assert.deepEqual(recoveredSpondDiscovery(collector,surfaces).groupIds,[group]);
  const newerFailure=structuredClone(collector);newerFailure.supplemental['spond:discovery:all:'].at='2026-10-06T06:29:00Z';
  assert.equal(recoveredSpondDiscovery(newerFailure,surfaces),null);
  const partial=structuredClone(collector);partial.supplemental['spond:payments:all:'].complete=false;
  assert.equal(recoveredSpondDiscovery(partial,surfaces),null);
  assert.equal(recoveredSpondDiscovery(collector,[surfaces[0]]),null);
  const mismatch=structuredClone(surfaces);mismatch[1].surface='group-549868399BF44F8EA3995BE9BB281BD4:payments';
  assert.equal(recoveredSpondDiscovery(collector,mismatch),null);
  const oldList=structuredClone(surfaces);oldList[1].listingObservedAt='2026-10-06T06:27:00Z';
  assert.equal(recoveredSpondDiscovery(collector,oldList),null);
});

const CHILD = '9e71a037-026d-163e-be04-9a41044ef491';
const POST = 'c7ef9824-c72d-7341-4e1b-17b48bd2c02f';
const THREAD = '8c51b67e-3c1c-082d-b833-6397a34805b9';
const GROUP = '0778F16EAC3269E55B587B44ADBE9010';
const SPOND_POST = '02F8C09192D7D3587CE66F6019A8DB30';
const SPOND_EVENT = 'BD216981E0B4A9C7799D3A8DBA13F277';

// Fiksturene ligger alltid innenfor det rullerende 30-dagersvinduet (faste septemberdatoer råtnet 25. oktober).
// Tidene låses én gang per kjøring (hel time) så tokenene er stabile mellom kall.
const HOUR = Math.floor(Date.now() / 3600000) * 3600000;
const ago = (days) => new Date(HOUR - days * 86400000).toISOString();
// Et eldre listeelement for samme nyhet, noen minutter før API-tidspunktet (samme dato).
const LEGACY_AT = new Date(Date.parse(ago(1)) - 1800000).toISOString();
const news = (over = {}) => ({ id: POST, posted: ago(1), title: 'Omgangssyke', text: 'Det går omgangssyke på skolen.', childIds: [CHILD], attachments: [], updated: null, editor: null, isRead: false, author: { firstName: 'Lærer', lastName: 'X' }, type: 'news', ...over });
const thread = (over = {}) => ({ messageThreadId: THREAD, title: 'SFO-meny', createdAt: ago(4), lastMessage: { id: '2e5a8865-c02d-3afc-f85a-6b828302637b', body: 'Menyen', createdAt: ago(4) }, numberOfReplies: 0, hasAttachments: false, isDeleted: false, child: { id: CHILD, firstName: 'Barn Tre' }, sender: { firstName: 'SFO', lastName: '' }, ...over });
const spondPost = (over = {}) => ({ id: SPOND_POST, type: 'PLAIN', groupId: GROUP, subGroupIds: [], title: 'Hallvakt', body: 'Meld dere på hallvakt.', timestamp: ago(1), attachments: [], comments: [], unread: true, seenCount: 3, reactions: {}, ...over });
// Arrangementet ligger alltid to dager frem, men tiden låses én gang så tokenet er stabilt mellom kall.
const EVENT_START = new Date(Math.floor(Date.now() / 3600000) * 3600000 + 2 * 86400000).toISOString();
const EVENT_END = new Date(Date.parse(EVENT_START) + 3600000).toISOString();
const spondEvent = (over = {}) => ({ id: SPOND_EVENT, heading: 'Grunntrening', description: 'Ta med drikkeflaske', startTimestamp: EVENT_START, endTimestamp: EVENT_END, location: { feature: 'ROS Arena' }, recipients: { group: { id: GROUP } }, responses: { acceptedIds: ['x'] }, createdTime: '2026-09-01T10:00:00.000Z', updated: 1, comments: [], attachments: [], hidden: false, type: 'RECURRING', ...over });

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'familien-collector-'));
  try { return fn(createStore(dir), dir); }
  finally { assert.ok(dir.startsWith(join(tmpdir(), 'familien-collector-'))); rmSync(dir, { recursive: true, force: true }); }
}
const children = (store) => store.collectorIngest({ source: 'vigilo', kind: 'children', items: [{ id: CHILD, firstName: 'Barn Tre', lastName: 'Eksempel' }] });
const sendNews = (store, items, complete = true) => store.collectorIngest({ source: 'vigilo', kind: 'news', childId: CHILD, complete, items });

test('retired consent errors do not hold healthy Vigilo coverage partial; active invitation errors do',()=>fixture(store=>{
  const kids=['Barn En','Barn To','Barn Tre','Barn Fire'].map((firstName,i)=>({id:`0000000${i}-0000-4000-8000-000000000000`,firstName}));
  store.collectorIngest({source:'vigilo',kind:'children',items:kids});
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'consents',childId:kids[0].id,detail:'Old retired error'});
  for(const child of kids)for(const kind of ['news','threads'])store.collectorIngest({source:'vigilo',kind,childId:child.id,complete:true,items:[]});
  store.collectorIngest({source:'vigilo',kind:'health',health:'ok'});
  assert.equal(store.snapshot().sourceStatus.vigilo.health,'ok');
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'registrations',childId:kids[0].id,detail:'HTTP 403'});
  store.updateSource({source:'vigilo',health:'partial',details:'Active invitation error'});
  store.collectorIngest({source:'vigilo',kind:'health',health:'ok'});
  assert.equal(store.snapshot().sourceStatus.vigilo.health,'partial');
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'registrations',childId:kids[0].id,complete:true,items:[]});
  assert.equal(store.snapshot().sourceStatus.vigilo.health,'ok');
}));

test('normalisering: bare native ID-er og fastsatte felt, og støyfelt påvirker ikke token', () => {
  const [a] = normalizeVigiloNews([news()]);
  assert.equal(a.externalId, `vigilo:news:${POST}`);
  assert.equal(normalizeVigiloNews([{ ...news(), id: 'ikke-uuid' }]).length, 0);
  assert.equal(normalizeVigiloNews([news({ isRead: true })])[0].token, a.token, 'lest-status er støy');
  assert.notEqual(normalizeVigiloNews([news({ updated: ago(0) })])[0].token, a.token);
  assert.notEqual(normalizeVigiloNews([news({ text: 'Rettet tekst' })])[0].token, a.token);
  assert.notEqual(normalizeVigiloNews([news({ attachments: [{ id: THREAD, name: 'plan.pdf', mimeType: 'application/pdf' }] })])[0].token, a.token);
  const [t] = normalizeVigiloThreads({ items: [thread()] });
  assert.equal(t.externalId, `vigilo:message:${THREAD}`);
  assert.notEqual(normalizeVigiloThreads({ items: [thread({ numberOfReplies: 1 })] })[0].token, t.token);
  assert.equal(normalizeVigiloThreads({ items: [thread({ isDeleted: true })] }).length, 0);
  const [p] = normalizeSpondPosts([spondPost()]);
  assert.equal(p.externalId, `spond:post:${SPOND_POST}`);
  assert.equal(normalizeSpondPosts([spondPost({ seenCount: 99, unread: false })])[0].token, p.token, 'antall visninger er støy');
  assert.notEqual(normalizeSpondPosts([spondPost({ comments: [{ id: SPOND_EVENT, timestamp: ago(0), text: 'Hei', edited: false }] })])[0].token, p.token);
  const [e] = normalizeSpondEvents([spondEvent()]);
  assert.equal(normalizeSpondEvents([spondEvent({ updated: 999, responses: { acceptedIds: ['x', 'y'] } })])[0].token, e.token, 'påmeldinger er støy');
  assert.notEqual(normalizeSpondEvents([spondEvent({ startTimestamp: '2026-10-06T16:00:00.000Z' })])[0].token, e.token);
});

test('nytt element krever gjennomgang, uendret gjør ikke, endring gjør igjen', () => fixture((store) => {
  children(store);
  let result = sendNews(store, [news()]);
  assert.equal(result.results[0].needsReview, 1);
  assert.equal(store.reviewQueue().items.length, 1);
  store.markReviewed({ source: 'vigilo', surface: 'child3:news', externalId: `vigilo:news:${POST}`, relevance: 'irrelevant', reviewNote: 'Ikke aktuelt for oss.' });
  result = sendNews(store, [news()]);
  assert.equal(result.results[0].needsReview, 0);
  assert.equal(store.reviewQueue().items.length, 0);
  result = sendNews(store, [news({ text: 'Redigert tekst', updated: ago(0), editor: { id: 'x' } })]);
  assert.equal(result.results[0].needsReview, 1);
  assert.equal(store.reviewQueue().items[0].reason, 'changed');
}));

test('Spond restores verified surface coverage after a source edit is reviewed', () => fixture((store) => {
  const surface=`group-${GROUP}:posts`, externalId=`spond:post:${SPOND_POST}`;
  const ingest=post=>store.collectorIngest({source:'spond',kind:'posts',complete:true,items:[post]});
  ingest(spondPost());
  store.markReviewed({source:'spond',surface,externalId,relevance:'irrelevant',reviewNote:'Ingen familiehandling.'});
  store.updateSurface({source:'spond',surface,health:'ok',complete:true,backfillComplete:true,details:'Komplett liste og detaljer kontrollert.'});
  ingest(spondPost({body:'Rettet tekst'}));
  assert.equal(store.snapshot().surfaces[`spond:${surface}`].health,'partial');
  store.markReviewed({source:'spond',surface,externalId,relevance:'irrelevant',reviewNote:'Rettelsen er lest; ingen familiehandling.'});
  ingest(spondPost({body:'Rettet tekst'}));
  assert.equal(store.snapshot().surfaces[`spond:${surface}`].health,'ok');
  assert.equal(store.snapshot().surfaces[`spond:${surface}`].resumeOnReview,undefined);
}));

test('agentens skjermlesing overskriver ikke API-observerte elementer', () => fixture((store) => {
  children(store);
  sendNews(store, [news()]);
  store.markReviewed({ source: 'vigilo', surface: 'child3:news', externalId: `vigilo:news:${POST}`, relevance: 'irrelevant', reviewNote: 'Ikke aktuelt.' });
  const observed = store.observeListing({ source: 'vigilo', surface: 'child3:news', items: [{ externalId: `vigilo:news:${POST}`, title: 'Omgangssyke (omskrevet av agent)', summary: 'helt annen tekst', sourceExcerpt: 'annet utdrag' }] });
  assert.equal(observed.decisions[0].needsReview, false);
  assert.equal(store.reviewQueue().items.length, 0);
}));

test('legacy Vigilo-nøkkel med samme overflate, tittel og dato får alias og grunnlag uten omlesing', () => fixture((store) => {
  store.observeListing({ source: 'vigilo', surface: 'child3:news', items: [{ externalId: 'vigilo:news:child3:omgangssyke', title: 'Omgangssyke', summary: 'Det går omgangssyke', publishedAt: LEGACY_AT }] });
  store.markReviewed({ source: 'vigilo', surface: 'child3:news', externalId: 'vigilo:news:child3:omgangssyke', relevance: 'irrelevant', reviewNote: 'Ikke aktuelt.' });
  children(store);
  const result = sendNews(store, [news()]);
  assert.equal(result.results[0].needsReview, 0, 'allerede gjennomgått legacy-element skal ikke leses på nytt');
  const entries = Object.values(store.snapshot().reviewLedger).filter((entry) => entry.source === 'vigilo');
  assert.equal(entries.length, 1, 'ingen dublett-oppføring');
  assert.equal(entries[0].externalId, 'vigilo:news:child3:omgangssyke');
  assert.equal(entries[0].managedBy, 'collector');
}));

test('mistenkelig aktivitet etter gjennomgang hindrer at legacy-elementet godtas som utgangspunkt', () => fixture((store) => {
  store.observeListing({ source: 'vigilo', surface: 'child3:news', items: [{ externalId: 'vigilo:news:child3:omgangssyke', title: 'Omgangssyke', summary: 's', publishedAt: LEGACY_AT }] });
  store.markReviewed({ source: 'vigilo', surface: 'child3:news', externalId: 'vigilo:news:child3:omgangssyke', relevance: 'irrelevant', reviewNote: 'x' });
  children(store);
  const result = sendNews(store, [news({ updated: new Date(Date.now() + 60000).toISOString(), editor: { id: 'e' } })]);
  assert.equal(result.results[0].needsReview, 1, 'redigert etter gjennomgang skal leses på nytt');
}));

test('flere mulige legacy-treff gir ikke alias (agenten vurderer på nytt)', () => fixture((store) => {
  for (const slug of ['a', 'b']) store.observeListing({ source: 'vigilo', surface: 'child3:news', items: [{ externalId: `vigilo:news:child3:${slug}`, title: 'Omgangssyke', summary: 's', publishedAt: LEGACY_AT }] });
  children(store);
  const result = sendNews(store, [news()]);
  assert.equal(result.results[0].needsReview, 1);
}));

test('komplett observasjon uten ventende elementer gjør Vigilo-flaten ok; ufullstendig eller ventende gjør det ikke', () => fixture((store) => {
  children(store);
  sendNews(store, [news()], true);
  assert.notEqual(store.snapshot().surfaces['vigilo:child3:news'].health, 'ok', 'ventende element');
  store.markReviewed({ source: 'vigilo', surface: 'child3:news', externalId: `vigilo:news:${POST}`, relevance: 'irrelevant', reviewNote: 'x' });
  sendNews(store, [news()], false);
  assert.notEqual(store.snapshot().surfaces['vigilo:child3:news'].health, 'ok', 'ufullstendig observasjon');
  sendNews(store, [news()], true);
  const surface = store.snapshot().surfaces['vigilo:child3:news'];
  assert.equal(surface.health, 'ok');
  assert.match(surface.details ?? '', /Automatisk/);
}));

test('Spond: bruker eksisterende overflate, ignorerer støy og fanger redigert kommentar', () => fixture((store) => {
  store.observeListing({ source: 'spond', surface: `group-${GROUP}-S-SUB1:posts`, items: [{ externalId: `spond:post:${SPOND_POST}`, title: 'Hallvakt', summary: 'Meld dere', publishedAt: ago(1) }] });
  store.markReviewed({ source: 'spond', surface: `group-${GROUP}-S-SUB1:posts`, externalId: `spond:post:${SPOND_POST}`, relevance: 'irrelevant', reviewNote: 'x' });
  let result = store.collectorIngest({ source: 'spond', kind: 'posts', complete: true, items: [spondPost({ subGroupIds: ['SUB1'] })] });
  assert.equal(result.results[0].surface, `group-${GROUP}-S-SUB1:posts`);
  assert.equal(result.results[0].needsReview, 0);
  result = store.collectorIngest({ source: 'spond', kind: 'posts', complete: true, items: [spondPost({ seenCount: 40 })] });
  assert.equal(result.results[0].needsReview, 0);
  result = store.collectorIngest({ source: 'spond', kind: 'posts', complete: true, items: [spondPost({ comments: [{ id: SPOND_EVENT, timestamp: new Date(Date.now() + 60000).toISOString(), text: 'Ny info', edited: false }] })] });
  assert.equal(result.results[0].needsReview, 1);
}));

test('Spond: nytt arrangement får kanonisk flate, og en partial flate blir ikke satt til ok av samleren', () => fixture((store) => {
  const result = store.collectorIngest({ source: 'spond', kind: 'events', complete: true, items: [spondEvent()] });
  assert.equal(result.results[0].surface, `group-${GROUP}:events`);
  assert.equal(result.results[0].needsReview, 1);
  store.markReviewed({ source: 'spond', surface: `group-${GROUP}:events`, externalId: `spond:event:${SPOND_EVENT}`, relevance: 'irrelevant', reviewNote: 'x' });
  store.collectorIngest({ source: 'spond', kind: 'events', complete: true, items: [spondEvent()] });
  assert.notEqual(store.snapshot().surfaces[`spond:group-${GROUP}:events`].health, 'ok', 'agenten eier ok for Spond');
}));

test('trådtekst: config ber om detaljer for ventende meldinger, og detaljer lagres for agenten', () => fixture((store) => {
  children(store);
  store.collectorIngest({ source: 'vigilo', kind: 'threads', childId: CHILD, complete: true, items: [thread()] });
  assert.deepEqual(store.collectorConfig().want.threads, [{ id: THREAD, childId: CHILD }]);
  store.collectorIngest({ source: 'vigilo', kind: 'thread-detail', childId: CHILD, detail: { messageThreadId: THREAD, title: 'SFO-meny', messages: [{ id: '2e5a8865-c02d-3afc-f85a-6b828302637b', text: 'Hele menyen for uken', createdAt: ago(4), attachments: [{ id: THREAD, name: 'meny.pdf', mimeType: 'application/pdf', url: 'https://x/y?token=hemmelig' }] }] } });
  assert.deepEqual(store.collectorConfig().want.threads, []);
  const item = store.collectedItem(`vigilo:message:${THREAD}`);
  assert.equal(item.detail.messages[0].text, 'Hele menyen for uken');
  assert.equal(JSON.stringify(item).includes('hemmelig'), true, 'signert originaladresse beholdes i kryptert lokalt arkiv');
}));

test('validering og tilstandsvern: ukjent kilde, ukjent barn og ingen lekkasje til snapshot', () => fixture((store) => {
  assert.throws(() => store.collectorIngest({ source: 'renovasjon', kind: 'posts', items: [] }), /Ukjent samlerkilde/);
  assert.throws(() => sendNews(store, [news()]), /Ukjent barn/);
  assert.throws(() => store.collectorIngest({ source: 'spond', kind: 'ukjent', items: [] }), /Ukjent samlertype/);
  children(store);
  sendNews(store, [news()]);
  assert.equal(store.snapshot().collector, undefined, 'samlerdata skal ikke ligge i /api/state');
  store.collectorIngest({ source: 'vigilo', kind: 'health', health: 'unauthorized', detail: 'token utløpt' });
  assert.equal(store.collectorStatus().sources.vigilo.health.health, 'unauthorized');
  assert.throws(() => store.collectorIngest({ source: 'vigilo', kind: 'health', health: 'hva-som-helst' }), /Ugyldig samlerstatus/);
  assert.ok(store.collectorRefresh().refreshRequestedAt);
}));

test('Vigilo leverer fullt navn i fornavnsfeltet: barna kobles til riktig familiemedlem', () => fixture((store) => {
  const kids = [['Barn Tre Eksempel', 'child3'], ['Barn Fire Eksempel', 'child4'], ['Barn To Eksempel', 'child2'], ['Barn En Eksempel', 'child1']];
  store.collectorIngest({ source: 'vigilo', kind: 'children', items: kids.map(([firstName], i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, firstName, lastName: 'Eksempel' })) });
  assert.deepEqual(store.collectorStatus().children.map((child) => child.memberId), kids.map(([, id]) => id));
}));

// Probe freshness never invents full child coverage or clears an authentication error.
test('freshness uses recent unchanged probes without hiding missing lists or errors',async()=>{
  const {collectorSummary}=await import('../src/cli-lib.mjs');const now=Date.now();
  const info={complete:true,oldestSweepAt:new Date(now-55*60000).toISOString(),probeAt:new Date(now-2*60000).toISOString(),maxFullAgeMinutes:90,maxProbeAgeMinutes:20,health:{health:'ok'}};
  const fresh=over=>collectorSummary({sources:{vigilo:{...info,...over}}},now).vigilo.fresh;
  assert.equal(fresh({}),true);assert.equal(fresh({complete:false}),false);assert.equal(fresh({health:{health:'unauthorized'}}),false);assert.equal(fresh({oldestSweepAt:new Date(now-100*60000).toISOString()}),false);
});

test('supplemental files preserve originals and ignore expiring URLs as content changes',async()=>{
  const {normalizeSupplemental}=await import('../src/collector.mjs');
  const input={source:'spond',section:'files',groupId:GROUP,items:[{id:POST,name:'Brev.docx',type:'FILE',url:'https://files.example/a?sig=one'}]};
  const first=normalizeSupplemental(input)[0];input.items[0].url='https://files.example/a?sig=two';const next=normalizeSupplemental(input)[0];
  assert.equal(first.token,next.token);assert.equal(first.text,next.text);assert.equal(next.attachments[0].url,input.items[0].url);assert.equal(next.attachments[0].name,'Brev.docx');
});

test('complete empty Vigilo supplemental lists close their surfaces, errors do not',()=>fixture(store=>{
  children(store);
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'meetings',childId:CHILD,detail:'HTTP 404'});
  assert.equal(store.snapshot().surfaces['vigilo:child3:meetings'].health,'partial');
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'meetings',childId:CHILD,complete:true,items:[]});
  assert.equal(store.snapshot().surfaces['vigilo:child3:meetings'].health,'ok');
  assert.equal(store.snapshot().surfaces['vigilo:child3:meetings'].blocker,null);
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'registrations',childId:CHILD,complete:false,items:[]});
  assert.equal(store.snapshot().surfaces['vigilo:child3:registrations'].health,'partial');
}));

test('a recent empty supplemental result remains valid when a run starts later',()=>fixture(store=>{
  children(store);
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'registrations',childId:CHILD,complete:true,items:[]});
  store.collectorIngest({source:'vigilo',kind:'supplemental',section:'consent-counts',childId:CHILD,complete:true,signal:true,items:[{consentFormsTotalCount:0}]});
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'consents',childId:CHILD,detail:'Uventet listeformat'});
  const lease=store.beginRun().lease;
  assert.doesNotThrow(()=>store.updateSurface({source:'vigilo',surface:'child3:registrations',health:'ok',complete:true}));
  assert.doesNotThrow(()=>store.updateSurface({source:'vigilo',surface:'child3:consents',health:'ok',complete:true}));
  store.endRun(lease.token);
}));

test('supplemental revisions ignore object order and nested read counters, but retain real poll changes',()=>fixture(store=>{
  const input = {source:'spond',kind:'supplemental',section:'polls',groupIds:[GROUP],complete:true,url:'https://api.spond.com/core/v1/posts?type=POLL',items:[{
    id:SPOND_POST,type:'POLL',groupId:GROUP,timestamp:new Date().toISOString(),muted:false,
    poll:{question:'Velg hallvakt',options:[{id:'one',text:'Tirsdag',votes:[]}]},selectMemberPoll:false
  }]};
  store.collectorIngest(input);
  const original = normalizeSupplemental(input)[0];
  const raw = store.upsertRaw({source:'spond',externalId:original.externalId,title:original.title,body:JSON.stringify(input.items[0],null,2),publishedAt:original.postedAt}).item;
  store.reviewProfile(raw.id,{facts:[],note:'Ingen varig profilinformasjon.'});
  store.markReviewed({source:'spond',surface:`group-${GROUP}:polls`,externalId:original.externalId,rawId:raw.id});
  store.updateSurface({source:'spond',surface:`group-${GROUP}:polls`,health:'ok',complete:true});
  const reversed = Object.fromEntries(Object.entries(input.items[0]).reverse());
  reversed.poll = {options:input.items[0].poll.options,question:'Velg hallvakt',isRead:true};
  const again = {...input,items:[reversed]};
  assert.equal(normalizeSupplemental(again)[0].token,original.token);
  store.collectorIngest(again);
  assert.equal(store.reviewQueue().items.length,0);
  assert.equal(store.snapshot().rawItems[raw.id].revision,raw.revision,'no rewriting original/Drive card');
  assert.equal(store.snapshot().surfaces[`spond:group-${GROUP}:polls`].health,'ok');
  reversed.poll.options = [{id:'one',text:'Onsdag',votes:[]}];
  store.collectorIngest(again);
  assert.equal(store.reviewQueue().items[0].reason,'changed');
}));

test('a successful root folder resolves only its old root error and does not cover other groups',()=>fixture(store=>{
  store.collectorIngest({source:'spond',kind:'supplemental-error',section:'files',groupId:GROUP,detail:'Uventet mappeformat'});
  store.collectorIngest({source:'spond',kind:'supplemental-error',section:'files',groupId:GROUP,folderId:SPOND_POST,detail:'HTTP 403'});
  store.collectorIngest({source:'spond',kind:'supplemental',section:'files',groupId:GROUP,folderId:GROUP,groupIds:[GROUP,SPOND_EVENT],complete:true,items:[]});
  const supplemental = store.collectorStatus().supplemental;
  assert.equal(supplemental[`spond:files:${GROUP}:`],undefined);
  assert.equal(supplemental[`spond:files:${GROUP}:${SPOND_POST}`].health,'error');
  assert.equal(store.snapshot().surfaces[`spond:group-${SPOND_EVENT}:files`],undefined);
  assert.equal(store.snapshot().surfaces[`spond:group-${GROUP}:files`].health,'partial','a denied child folder is still a real gap');
}));

test('fresh complete API lists survive a run starting seconds later; stale lists and unread details do not',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'familien-collector-race-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=createStore(dir);
  const kids=['Barn En','Barn To','Barn Tre','Barn Fire'].map((firstName,i)=>({id:`0000000${i}-0000-4000-8000-000000000000`,firstName}));
  store.collectorIngest({source:'vigilo',kind:'children',items:kids});
  for(const child of kids)for(const kind of ['news','threads'])store.collectorIngest({source:'vigilo',kind,childId:child.id,complete:true,items:[]});
  store.collectorIngest({source:'vigilo',kind:'health',health:'ok'});
  await new Promise(resolve=>setTimeout(resolve,10));
  const lease=store.beginRun().lease;
  assert.equal(store.completionReport().vigiloIssues.length,0,'fresh verified lists remain usable for the next run');
  assert.doesNotThrow(()=>store.updateSurface({source:'vigilo',surface:'child3:news',health:'ok',complete:true}));
  store.collectorIngest({source:'vigilo',kind:'news',childId:kids[2].id,complete:true,items:[news({childIds:[kids[2].id],posted:new Date().toISOString()})]});
  assert.ok(store.completionReport().vigiloIssues.some(item=>item.child==='child3'&&item.pending===1));
  const realNow=Date.now();t.mock.method(Date,'now',()=>realNow+36*60000);
  assert.ok(store.completionReport().vigiloIssues.some(item=>item.child==='child1'));
  assert.throws(()=>store.updateSurface({source:'vigilo',surface:'child1:news',health:'ok',complete:true}),/Vigilo-overflate/);
  store.endRun(lease.token);
});
