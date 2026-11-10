import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createStore } from "../src/store.mjs";

function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "familien-test-"));
  try { return fn(dir); }
  finally {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + "\\")) throw new Error("Utrygg testopprydding.");
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a campaign waiting for a future retry counts as blocked shopping even with no active shopping work',()=>fixture(dir=>{
  const store=createStore(dir),campaign={do:'shopping-sesum-offer-review',sourceKey:'sesum:KIWI:123',familyId:'synthetic-family',status:'blocked',reason:'Primary campaign customer limit is unresolved.',retryAt:new Date(Date.now()+3600000).toISOString()};
  // The shopping integration tests exercise the real future-retry queue. This
  // boundary test verifies the store aggregates its durable completion result.
  store.shopping.completion=()=>({complete:false,work:[],blockedStores:[],blockedRoutes:[],blockedCampaigns:[campaign]});
  const report=store.completionReport();
  assert.equal(report.shopping.complete,false);assert.deepEqual(report.shopping.work,[]);assert.deepEqual(report.shopping.blockedCampaigns,[campaign]);
  assert.equal(report.counts.shoppingPending,0);assert.equal(report.counts.shoppingBlocked,1);assert.equal(report.complete,false);
  assert.equal(store.changeCompletion().counts.shoppingBlocked,1,'change completion reports the same unresolved shopping blocker');
  const family={do:'shopping-sesum-family-review',sourceKey:'sesum:KIWI:456',familyId:'synthetic-family',status:'blocked',reason:'A required product label fact is unresolved.',retryAt:campaign.retryAt};
  store.shopping.completion=()=>({complete:false,work:[],blockedStores:[],blockedRoutes:[],blockedCampaigns:[],blockedFamilies:[family]});
  assert.equal(store.completionReport().shopping.complete,false);assert.equal(store.completionReport().counts.shoppingPending,0);assert.equal(store.completionReport().counts.shoppingBlocked,1);
  assert.equal(store.changeCompletion().counts.shoppingBlocked,1,'a future family retry is also an unresolved shopping blocker');
  store.shopping.completion=()=>({complete:false,work:[],blockedStores:[],blockedRoutes:[],blockedPlacements:[{sourceKey:'sesum:KIWI:789',status:'blocked',reason:'Placement needs a readable current label.'}]});
  assert.equal(store.completionReport().counts.shoppingBlocked,1);assert.equal(store.completionReport().shopping.complete,false);assert.equal(store.changeCompletion().counts.shoppingBlocked,1);
  store.shopping.completion=()=>({complete:true,work:[],blockedStores:[],blockedRoutes:[]});
  assert.equal(store.completionReport().counts.shoppingBlocked,0,'older shopping providers without campaign blockers remain compatible');
}));

test('retired Vigilo consent pages stay archived without blocking current completion', () => fixture(dir => {
  const store=createStore(dir);
  store.collectorIngest({source:'vigilo',kind:'supplemental-error',section:'consents',detail:'HTTP 404'});
  assert.equal(store.completionReport().incompleteSurfaces.some(item=>item.surface.endsWith(':consents')),false);
  assert.equal(Object.values(store.reviewQueue().surfaces).some(item=>item.surface.endsWith(':consents')),false);
  assert.equal(Object.keys(store.collectorStatus().supplemental).some(key=>key.startsWith('vigilo:consents:')),false);
  assert.ok(Object.values(store.snapshot().surfaces).some(item=>item.surface.endsWith(':consents')),'history remains in the archive');
}));

test('Spond successful group discovery clears only its stale discovery failure', () => fixture(dir => {
  const store=createStore(dir);
  const group='0778F16EAC3269E55B587B44ADBE9010';
  store.collectorIngest({source:'spond',kind:'supplemental-error',section:'discovery',detail:'HTTP 401'});
  store.collectorIngest({source:'spond',kind:'supplemental-error',section:'files',groupId:group,folderId:group,detail:'HTTP 403'});
  const polls={source:'spond',kind:'supplemental',section:'polls',items:[],complete:true};
  store.collectorIngest(polls);
  assert.equal(store.collectorStatus().supplemental['spond:discovery:all:'].health,'error','a poll list without the discovered group inventory is insufficient');
  store.collectorIngest({...polls,complete:false,groupIds:[group]});
  assert.equal(store.collectorStatus().supplemental['spond:discovery:all:'].health,'error');
  store.collectorIngest({...polls,groupIds:[group]});
  assert.equal(store.collectorStatus().supplemental['spond:discovery:all:'].health,'ok');
  assert.deepEqual(store.collectorStatus().supplemental['spond:discovery:all:'].groupIds,[group]);
  const surface=store.snapshot().surfaces['spond:group-all:discovery'];
  assert.equal(surface.health,'ok');
  assert.equal(surface.currentComplete,true);
  assert.equal(surface.blocker,null);
  assert.equal(store.collectorStatus().supplemental[`spond:files:${group}:${group}`].health,'error','a denied original remains a real hole');
  assert.equal(store.snapshot().sourceStatus.spond?.health,undefined,'discovery alone does not assert full source coverage');
  assert.equal(createStore(dir).collectorStatus().supplemental['spond:discovery:all:'].health,'ok','receipt survives restart');
}));

test('a current source failure is not hidden by one historical surface gap', () => fixture(dir => {
  const store=createStore(dir);
  const oldFrom=new Date(Date.now()-80*86400000).toISOString();
  const oldTo=new Date(Date.now()-60*86400000).toISOString();
  store.updateSurface({source:'spond',surface:'group-abc:polls',health:'partial',complete:true,currentComplete:true,
    scanTo:new Date().toISOString(),historicalGap:{from:oldFrom,to:oldTo,reason:'Eldre liste utilgjengelig'},details:'Aktuelt vindu gjennomgått'});
  store.updateSource({source:'spond',health:'partial',details:'Samlerens autentisering feilet'});
  assert.ok(store.completionReport().incompleteSources.some(item=>item.source==='spond'));
  store.updateSource({source:'spond',health:'partial',historicalOnly:true,details:'Bare eldre historikk mangler'});
  assert.equal(store.completionReport().incompleteSources.some(item=>item.source==='spond'),false);
  store.updateSurface({source:'spond',surface:'group-abc:events',health:'ok',complete:true,scanTo:new Date().toISOString()});
  assert.doesNotThrow(()=>store.updateSource({source:'spond',health:'partial',historicalOnly:true,details:'Friske flater og bare ett historisk hull'}));
  store.updateSurface({source:'spond',surface:'group-abc:events',health:'ok',nextPageHint:'Unfinished page'});
  assert.throws(()=>store.updateSource({source:'spond',health:'partial',historicalOnly:true}),/Historisk-only/);
  store.updateSurface({source:'spond',surface:'group-abc:events',health:'ok',complete:true,scanTo:new Date().toISOString()});
  store.updateSurface({source:'spond',surface:'group-abc:posts',health:'partial',details:'Aktuell liste mangler'});
  assert.ok(store.completionReport().incompleteSources.some(item=>item.source==='spond'));
  assert.throws(()=>store.updateSource({source:'spond',health:'partial',historicalOnly:true,details:'Feilaktig kvittering'}),/Historisk-only/);
}));

test("Drive receipts accept private Office editor links returned by Google", () => fixture(dir => {
  const store=createStore(dir);
  const raw=store.upsertRaw({source:"spond",externalId:"file-office",title:"Office original",body:"Original"}).item;
  store.linkDrive(raw.id,null,"https://docs.google.com/document/d/EXAMPLE_DOCUMENT_ID/edit?usp=drivesdk");
  assert.equal(store.snapshot().rawItems[raw.id].driveUrl,"https://docs.google.com/document/d/EXAMPLE_DOCUMENT_ID/edit");
  assert.throws(()=>store.linkDrive(raw.id,null,"https://example.com/document/d/private-file/edit"),/Drive-lenke/);
}));

test("activity refresh preserves family choices and encrypted persistence without calendar creation", () => fixture(dir => {
  const store=createStore(dir);
  const input={canonicalKey:"test:gaming:2099-10-01",title:"Gaming",start:"2099-10-01T16:00:00+02:00",end:"2099-10-01T18:00:00+02:00",sourceId:"activity-4",sourceUrl:"https://example.com/gaming",members:["child3"],pitch:"Spill sammen og prøv nye baner.",summary:"Spillkveld",reason:"Liker gaming",evidence:"Verifisert dato og tid",checkedAt:new Date().toISOString()};
  const one=store.upsertActivity(input);
  assert.equal(store.upsertActivity({...input,pitch:undefined}).pitch,input.pitch,'unchanged source keeps its pitch');
  store.activityReaction(one.id,{action:"interested"});
  const updated=store.upsertActivity({...input,title:"Gaming og brettspill",pitch:"Prøv både spill og brettspill sammen."});
  assert.equal(updated.id,one.id);assert.equal(updated.reaction,"interested");
  assert.equal(updated.pitch,"Prøv både spill og brettspill sammen.");
  assert.equal(store.upsertActivity({...input,title:"Nytt gamingprogram",pitch:undefined}).pitch,'','changed source must not retain a stale pitch');
  assert.equal(Object.keys(store.snapshot().events).length,0);
  store.activityReaction(one.id,{action:"plan"});
  assert.throws(()=>store.activityPlan(one.id,{status:"published",eventId:"missing"}),/arkivert kildekopi/);
  const reopened=createStore(dir);assert.equal(reopened.snapshot().activities[one.id].plan.status,"pending");
  assert.equal(readFileSync(join(dir,"archive.json.enc")).includes(Buffer.from("Gaming og brettspill")),false);
  reopened.activityReaction(one.id,{action:"cancel-plan"});reopened.activityReaction(one.id,{action:"hidden"});
  assert.equal(reopened.upsertActivity(input).reaction,"hidden");
  reopened.activityReaction(one.id,{action:"plan"});
  const raw=reopened.upsertRaw({source:"aktiviteter",externalId:one.id,title:input.title,body:input.evidence,sourceUrl:input.sourceUrl,memberIds:input.members}).item;
  const event=reopened.upsertFinding(raw.id,{canonicalKey:input.canonicalKey,title:input.title,start:input.start,end:input.end,members:input.members});
  reopened.linkCalendar(event.id,{calendarId:"family-test",eventId:"calendar-test",eventUrl:"https://calendar.google.com/calendar/event?eid=test"});
  assert.throws(()=>reopened.activityPlan(one.id,{status:"published",eventId:event.id}),/arkivert kildekopi/);
  reopened.linkDrive(raw.id,null,"https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  assert.throws(()=>reopened.activityPlan(one.id,{status:"published",eventId:event.id}),/arkivert kildekopi/);
  reopened.linkCalendar(event.id,{calendarId:"family-test",eventId:"calendar-test",eventUrl:"https://calendar.google.com/calendar/event?eid=test"});
  assert.equal(reopened.activityPlan(one.id,{status:"published",eventId:event.id}).plan.status,"published");
  reopened.activitySource({sourceId:"activity-1",health:"needs_login",details:"Facebook trenger innlogging"});
  assert.equal(reopened.snapshot().sourceStatus.facebook,undefined);
  assert.throws(()=>reopened.upsertActivity({...input,end:input.start}),/slutt etter start/);
}));

test("document reading is reusable across sources and names only for identical bytes", () => fixture((dir) => {
  const store = createStore(dir);
  const one = store.upsertRaw({source:"vigilo",externalId:"shared-max",title:"Barn Tre ukeplan",memberIds:["child3"]}).item;
  const two = store.upsertRaw({source:"spond",externalId:"shared-child4",title:"Barn Fire ukeplan",memberIds:["child4"]}).item;
  const first = store.addAttachment(one.id,{fileName:"ukeplan.pdf",mimeType:"application/pdf",bytes:Buffer.from("same-file")});
  const duplicate = store.addAttachment(two.id,{fileName:"plan (2).pdf",mimeType:"application/pdf",bytes:Buffer.from("same-file")});
  assert.equal(store.documentStatus(first.sha256).needsReading,true);
  assert.throws(() => store.reviewDocument(one.id,first.id,{pageCount:2,method:"visual",pages:[{page:1,text:"Tirsdag turdag"}]}), /Alle dokumentets sider/);
  assert.throws(() => store.reviewDocument(one.id,first.id,{pageCount:2,method:"visual",pages:[{page:1,text:"A"},{page:1,text:"B"}]}), /unikt sidenummer/);
  assert.equal(store.documentStatus(first.sha256).needsReading,true);
  store.reviewDocument(one.id,first.id,{pageCount:2,method:"mixed",pages:[{page:2,text:"Ved og kakao"},{page:1,text:"Uke 39, tirsdag turdag"}]});
  const reopened = createStore(dir);
  const reused = reopened.documentStatus(duplicate.sha256);
  assert.equal(reused.needsReading,false);
  assert.equal(reused.references.length,2);
  assert.deepEqual(reused.receipt.pages.map(p=>p.page),[1,2]);
  assert.equal(reused.receipt.pages[1].text,"Ved og kakao");
  assert.equal(readFileSync(join(dir,"archive.json.enc")).includes(Buffer.from("Ved og kakao")),false);
  reused.receipt.pages[0].text = "mutated";
  assert.equal(reopened.documentStatus(first.sha256).receipt.pages[0].text,"Uke 39, tirsdag turdag");
  const changed = reopened.addAttachment(two.id,{fileName:"ukeplan.pdf",mimeType:"application/pdf",bytes:Buffer.from("changed-file")});
  assert.equal(reopened.documentStatus(changed.sha256).needsReading,true);
  assert.equal(reopened.documentStatus(first.sha256).needsReading,false);
  assert.equal(reopened.snapshot().rawItems[two.id].memberIds[0],"child4");
}));

test("encrypted archive persists raw material and attachments without plaintext", () => fixture((dir) => {
  const store = createStore(dir);
  const result = store.upsertRaw({ source:"vigilo", externalId:"week-42", title:"Ukeplan", body:"Ta med ved og kakao", memberIds:["child3"] });
  const attachment = store.addAttachment(result.item.id, { fileName:"ukeplan.pdf", mimeType:"application/pdf", bytes:Buffer.from("secret-pdf-content") });
  const encrypted = readFileSync(join(dir, "archive.json.enc"));
  assert.equal(encrypted.subarray(0,4).toString(), "FAM1");
  assert.equal(encrypted.includes(Buffer.from("Ta med ved")), false);
  assert.equal(readFileSync(join(dir,"attachments",`${attachment.id}.enc`)).includes(Buffer.from("secret-pdf-content")), false);
  const reopened = createStore(dir);
  assert.equal(reopened.snapshot().rawItems[result.item.id].body, "Ta med ved og kakao");
  assert.equal(reopened.getAttachment(result.item.id, attachment.id).bytes.toString(), "secret-pdf-content");
}));

test("family task checks persist independently of calendar sync and source corrections preserve only unchanged checks", () => fixture((dir) => {
  const store=createStore(dir);
  const raw=store.upsertRaw({source:"vigilo",externalId:"week-tasks",title:"Lekser"}).item;
  const finding={canonicalKey:"week:child2",title:"Lekser",members:["child2"],kind:"task",start:"2026-10-04T18:00:00+02:00",end:"2026-10-04T18:15:00+02:00",task:{visibleFrom:"2026-10-05",dueDate:"2026-10-09",items:[{key:"english",text:"Les engelsk"},{key:"packing",text:"Pakk ved"}]}};
  const first=store.upsertFinding(raw.id,finding);
  store.checkTask(first.id,"english",{done:true,expectedText:"Les engelsk"});
  const checked=store.snapshot().events[first.id];
  assert.ok(checked.task.items[0].doneAt);
  assert.equal(checked.fingerprint,first.fingerprint);
  assert.ok(createStore(dir).snapshot().events[first.id].task.items[0].doneAt);
  store.checkTask(first.id,"packing",{done:true,expectedText:"Pakk ved"});
  const corrected=store.upsertFinding(raw.id,{...finding,task:{...finding.task,items:[{key:"english",text:"Les engelsk"},{key:"packing",text:"Pakk matpakke og drikke"}]}});
  assert.ok(corrected.task.items[0].doneAt);
  assert.equal(corrected.task.items[1].doneAt,null);
  assert.equal(corrected.task.history[0].text,"Pakk ved");
  assert.deepEqual(corrected.checklist,["Les engelsk","Pakk matpakke og drikke"]);
  assert.throws(()=>store.checkTask(first.id,"packing",{done:true,expectedText:"Pakk ved"}),/Oppgaven er endret/);
  assert.throws(()=>store.upsertFinding(raw.id,{...finding,task:{...finding.task,dueDate:"2026-02-30"}}),/Oppgave krever/);
}));

test("rolling cutoff preserves future commitments and recent changes while keeping expired evidence visible", () => fixture((dir) => {
  const store = createStore(dir);
  const old = new Date(Date.now()-45*86400000).toISOString();
  const future = new Date(Date.now()+86400000).toISOString();
  const futureEnd = new Date(Date.now()+90000000).toISOString();
  const past = store.upsertRaw({source:"spond",externalId:"expired",title:"Gammelt referat",publishedAt:old,expectedOriginals:["referat.pdf"]}).item;
  const next = store.upsertRaw({source:"spond",externalId:"future",title:"Kommende oppgave",publishedAt:old,expectedOriginals:["oppgave.pdf"],findings:[{canonicalKey:"future-task",title:"Oppgave",start:future,end:futureEnd}]}).item;
  const listing = {source:"spond",surface:"group-1:posts",items:[{externalId:past.externalId,title:past.title,publishedAt:old},{externalId:next.externalId,title:next.title,publishedAt:old}]};
  store.observeListing(listing);
  store.markReviewed({source:"spond",surface:listing.surface,externalId:next.externalId,rawId:next.id});
  store.observeListing({...listing,items:[{...listing.items[1],summary:"Endret oppgave"}]});
  assert.equal(store.reviewQueue().items[0].reason,"changed");
  const report = store.completionReport();
  assert.ok(report.historicalMissingDrive.some(item=>item.rawId===past.id));
  assert.ok(report.missingDrive.some(item=>item.rawId===next.id));
  assert.ok(report.historicalItems.some(item=>item.externalId===past.externalId));
  assert.equal(store.observeListing({...listing,items:[{...listing.items[0],updatedAt:new Date().toISOString()}]}).decisions[0].reason,"new");
  const retained = store.observeListing({...listing,items:[{externalId:"retained",title:"Åpen oppgave",publishedAt:old,retainUntil:future}]});
  assert.equal(retained.decisions[0].needsReview,true);
}));

test("surface aliases merge and historical gaps require confirmed fresh current coverage", () => fixture((dir) => {
  const store = createStore(dir);
  const old = new Date(Date.now()-45*86400000).toISOString();
  const item={externalId:"same-post",title:"Innlegg",publishedAt:new Date().toISOString()};
  store.observeListing({source:"facebook",surface:"facebook:group-123:posts",items:[item]});
  store.markReviewed({source:"facebook",surface:"123:posts",externalId:item.externalId,relevance:"irrelevant",reviewNote:"Gjelder ikke familien."});
  assert.equal(store.reviewQueue().items.length,0);
  assert.equal(Object.keys(store.snapshot().surfaces).length,1);
  const input={source:"facebook",surface:"123:posts",health:"partial",scanTo:new Date().toISOString(),historicalGap:{from:old,to:old,reason:"Eldre innlegg utilgjengelige."}};
  store.updateSurface(input);
  assert.equal(store.completionReport().incompleteSurfaces.length,1);
  store.updateSurface({...input,currentComplete:true});
  assert.equal(store.completionReport().incompleteSurfaces.length,0);
  assert.equal(store.completionReport().historicalSurfaces.length,1);
  store.observeListing({source:"facebook",surface:"group-123:posts",items:[item]});
  assert.equal(store.completionReport().incompleteSurfaces.length,1);
}));

test("expected originals match harmless filename formatting differences", () => fixture((dir) => {
  const store=createStore(dir);
  const raw=store.upsertRaw({source:"spond",externalId:"filename",title:"Vedlegg",expectedOriginals:["Ukeslutt informasjon klassekontakter"]}).item;
  const file=store.addAttachment(raw.id,{fileName:"ukeslutt_informasjon_klassekontakter.docx",mimeType:"application/octet-stream",bytes:Buffer.from("file")});
  store.linkDrive(raw.id,file.id,"https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  assert.equal(store.completionReport().missingDrive.filter(item=>item.kind==="source-original").length,0);
}));

test("repeated intake is idempotent and later source enriches one canonical event", () => fixture((dir) => {
  const store = createStore(dir);
  const first = { source:"vigilo", externalId:"week-42", title:"Ukeplan", body:"Tirsdag turdag; ta med ved og kakao", findings:[{
    canonicalKey:"2026-10-13:turdag:3A", title:"Turdag", start:"2026-10-13T08:00:00+02:00", end:"2026-10-13T14:00:00+02:00", members:["child3","child4"], checklist:["Ved","Kakao"], reason:"Ukeplanen sier tirsdag."
  }] };
  const one = store.upsertRaw(first);
  const repeat = store.upsertRaw(first);
  assert.equal(repeat.changed, false);
  assert.equal(repeat.item.revision, 1);
  const second = store.upsertRaw({ source:"spond", externalId:"event-77", title:"Turdag 3A", findings:[{
    canonicalKey:"2026-10-13:turdag:3A", title:"Turdag", start:"2026-10-13T08:00:00+02:00", end:"2026-10-13T14:00:00+02:00", members:["child3","child4"], checklist:["Matpakke"]
  }] });
  const events = Object.values(store.snapshot().events);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].sourceRefs.sort(), [one.item.id, second.item.id].sort());
  assert.deepEqual(events[0].checklist, ["Ved","Kakao","Matpakke"]);
}));

test("actionable findings cannot be stored without a date", () => fixture((dir) => {
  const store = createStore(dir);
  assert.throws(() => store.upsertRaw({ source:"vigilo", externalId:"bad-intake", title:"Udatert beskjed", findings:[{ canonicalKey:"undated:new", title:"Må huskes" }] }), /Funn må ha dato/);
  assert.equal(Object.keys(store.snapshot().rawItems).length, 0);
  const raw = store.upsertRaw({ source:"vigilo", externalId:"unknown-date", title:"Vennetreff" });
  assert.throws(() => store.upsertFinding(raw.item.id, { canonicalKey:"friend-group:max", title:"Avtal vennetreff" }), /Funn må ha dato/);
  assert.equal(Object.keys(store.snapshot().events).length, 0);
}));

test("conflicting source dates remain visible as provisional without duplicate alternatives", () => fixture((dir) => {
  const store = createStore(dir);
  store.upsertRaw({ source:"vigilo", externalId:"post-1", title:"Skoleforestilling", findings:[{ canonicalKey:"forestilling:child1", title:"Skoleforestilling", start:"2026-11-02T17:00:00+01:00", members:["child1"] }] });
  const input = { source:"facebook", externalId:"post-2", title:"Skoleforestilling", findings:[{ canonicalKey:"forestilling:child1", title:"Skoleforestilling", start:"2026-11-03T17:00:00+01:00", members:["child1"] }] };
  store.upsertRaw(input);
  store.upsertRaw(input);
  const event = Object.values(store.snapshot().events)[0];
  assert.equal(event.provisional, true);
  assert.equal(event.alternatives.length, 1);
  assert.equal(event.sourceRefs.length, 2);
}));

test('equivalent all-day dates and equivalent timed instants do not create provisional conflicts',()=>fixture(dir=>{
  const store=createStore(dir);
  const insert=(id,key,start,allDay)=>store.upsertRaw({source:'vigilo',externalId:id,title:'Prøve',findings:[{canonicalKey:key,title:'Prøve',start,allDay,dateConfirmed:true,members:['child1']}]});
  insert('a','exam:all-day','2026-10-29T00:00:00+01:00',true);
  const same=insert('b','exam:all-day','2026-10-29',true).findings[0];
  assert.equal(same.provisional,false);assert.deepEqual(same.alternatives,[]);
  const changed=insert('c','exam:all-day','2026-10-30',true).findings[0];
  assert.equal(changed.provisional,true);assert.equal(changed.alternatives.length,1);
  insert('d','exam:timed','2026-10-29T09:00:00+01:00',false);
  const sameInstant=insert('e','exam:timed','2026-10-29T08:00:00Z',false).findings[0];
  assert.equal(sameInstant.provisional,false);assert.deepEqual(sameInstant.alternatives,[]);
}));

test("Drive link changes the calendar fingerprint and a correction resolves date conflict", () => fixture((dir) => {
  const store = createStore(dir);
  const first = store.upsertRaw({ source:"vigilo", externalId:"p1", title:"Tur", memberIds:["child3"], findings:[{ canonicalKey:"trip:3a", title:"Tur", start:"2026-11-02T09:00:00+01:00", members:["child3"], details:"Kort melding" }] });
  const eventId = first.findings[0].id;
  const initialFingerprint = store.snapshot().events[eventId].fingerprint;
  store.linkDrive(first.item.id, null, "https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  assert.notEqual(store.snapshot().events[eventId].fingerprint, initialFingerprint);
  assert.equal(store.snapshot().rawItems[first.item.id].driveRevision, 1);
  store.upsertRaw({ source:"vigilo", externalId:"p1", title:"Tur", memberIds:["child3"] });
  assert.equal(store.snapshot().rawItems[first.item.id].driveRevision, 1);
  store.upsertRaw({ source:"vigilo", externalId:"p1", title:"Tur", body:"Ny beskjed", memberIds:["child3"] });
  assert.equal(store.snapshot().rawItems[first.item.id].revision, 2);
  assert.equal(store.snapshot().rawItems[first.item.id].driveRevision, 1);
  const second = store.upsertRaw({ source:"spond", externalId:"p2", title:"Tur", memberIds:["child4"], findings:[{ canonicalKey:"trip:3a", title:"Tur", start:"2026-11-03T09:00:00+01:00", members:["child4"], details:"Mer utførlig melding om turen" }] });
  assert.equal(second.findings[0].provisional, true);
  store.upsertFinding(second.item.id, { canonicalKey:"trip:3a", title:"Tur", start:"2026-11-03T09:00:00+01:00", members:["child4"], details:"Mer utførlig melding om turen", correctsPrevious:true });
  const corrected = store.snapshot().events[eventId];
  assert.equal(corrected.start, "2026-11-03T09:00:00+01:00");
  assert.deepEqual(corrected.alternatives, []);
  assert.equal(corrected.provisional, false);
  assert.equal(corrected.details, "Mer utførlig melding om turen");
}));

test("review ledger skips unchanged listings, revisits edits, and persists coverage", () => fixture((dir) => {
  const store = createStore(dir);
  const listing = { source:"vigilo", surface:"child3:news", items:[{ externalId:"post-42", title:"Ukeplan", summary:"Ta med kakao", publishedAt:new Date(Date.now()-10*86400000).toISOString() }] };
  const first = store.observeListing(listing);
  assert.equal(first.decisions[0].reason, "new");
  const raw = store.upsertRaw({ source:"vigilo", externalId:"post-42", title:"Ukeplan", body:"Ta med kakao" });
  store.markReviewed({ source:"vigilo", externalId:"post-42", rawId:raw.item.id, relevance:"relevant" });
  assert.equal(store.observeListing(listing).decisions[0].reason, "unchanged");
  assert.equal(store.reviewQueue().items.length, 0);
  const changed = store.observeListing({ ...listing, items:[{ ...listing.items[0], summary:"Ta med ved og kakao" }] });
  assert.equal(changed.decisions[0].reason, "changed");
  assert.equal(store.reviewQueue().items.length, 1);
  store.updateSurface({ source:"vigilo", surface:"child3:news", health:"partial", backfillFrom:"2026-08-01", nextPageHint:"Side 3", details:"Første to sider lest" });
  const reopened = createStore(dir);
  assert.equal(reopened.reviewQueue().items[0].reason, "changed");
  assert.equal(reopened.snapshot().surfaces["vigilo:child3:news"].nextPageHint, "Side 3");
}));

test("the same Vigilo item is reviewed separately on each child's surface", () => fixture((dir) => {
  const store = createStore(dir);
  const item = { externalId:"shared-weekplan", title:"Ukeplan", publishedAt:new Date().toISOString() };
  store.observeListing({ source:"vigilo", surface:"child3:news", items:[item] });
  store.observeListing({ source:"vigilo", surface:"child4:news", items:[item] });
  const raw = store.upsertRaw({ source:"vigilo", externalId:item.externalId, title:item.title });
  assert.throws(() => store.markReviewed({ source:"vigilo", externalId:item.externalId, rawId:raw.item.id }), /angi surface/);
  store.markReviewed({ source:"vigilo", surface:"child3:news", externalId:item.externalId, rawId:raw.item.id });
  assert.deepEqual(store.reviewQueue().items.map((entry) => entry.surface), ["child4:news"]);
  store.markReviewed({ source:"vigilo", surface:"child4:news", externalId:item.externalId, rawId:raw.item.id });
  assert.equal(store.reviewQueue().items.length, 0);
  assert.equal(store.observeListing({ source:"vigilo", surface:"child3:news", items:[item] }).decisions[0].reason, "unchanged");
}));

test("unchanged published Vigilo items stay reviewed until the listing changes", (t) => fixture((dir) => {
  t.mock.timers.enable({ apis:["Date"], now:Date.now() });
  const store = createStore(dir);
  const item = { externalId:"recent", title:"Ukeplan", summary:"Les side 26", publishedAt:new Date().toISOString(), attachmentHint:"41.pdf" };
  const listing = { source:"vigilo", surface:"child3:news", items:[item] };
  store.observeListing(listing);
  store.markReviewed({ source:"vigilo", surface:"child3:news", externalId:item.externalId, relevance:"irrelevant", reviewNote:"Ingen oppgaver for familien" });
  t.mock.timers.tick(3 * 3600000);
  assert.equal(store.observeListing(listing).decisions[0].reason, "unchanged");
  assert.equal(store.reviewQueue().items.length, 0);
  assert.equal(store.observeListing({...listing,items:[{...item,summary:"Les side 27"}]}).decisions[0].reason, "changed");
  store.observeListing(listing);
  t.mock.timers.tick(21 * 3600000);
  assert.equal(store.observeListing(listing).decisions[0].reason, "unchanged");
  t.mock.timers.tick(6 * 86400000);
  assert.equal(store.observeListing(listing).decisions[0].reason, "unchanged");
  assert.equal(store.reviewQueue().items.length, 0);
}));

test("explicit watch items get a weekly check and keep the tag when a later list omits it", (t) => fixture((dir) => {
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const store=createStore(dir);
  const item={externalId:"active-thread",title:"Pågående avklaring",publishedAt:new Date().toISOString(),reviewPolicy:"watch"};
  const listing={source:"vigilo",surface:"child1:messages",items:[item]};
  const raw=store.upsertRaw({source:"vigilo",externalId:item.externalId,title:item.title});
  store.observeListing(listing);
  store.markReviewed({source:"vigilo",surface:listing.surface,externalId:item.externalId,rawId:raw.item.id});
  t.mock.timers.tick(8*86400000);
  const later=store.observeListing({...listing,items:[{externalId:item.externalId,title:item.title,publishedAt:item.publishedAt}]});
  assert.equal(later.decisions[0].reason,"periodic-check");
  assert.equal(store.reviewQueue().items[0].reviewPolicy,"watch");
}));

test("Spond events check once near start; polls remain watched", (t) => fixture((dir) => {
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const store=createStore(dir);
  const start=new Date(Date.now()+12*86400000).toISOString();
  const event={externalId:"spond:event:abc",title:"Aktivitet",publishedAt:new Date().toISOString()};
  const raw=store.upsertRaw({source:"spond",externalId:event.externalId,title:event.title,findings:[{canonicalKey:"event:abc",title:event.title,start,end:new Date(Date.parse(start)+3600000).toISOString(),members:["child3"]}]});
  const eventList={source:"spond",surface:"group-1:events",items:[event]};
  store.observeListing(eventList);
  store.markReviewed({source:"spond",surface:eventList.surface,externalId:event.externalId,rawId:raw.item.id});
  t.mock.timers.tick(8*86400000);
  assert.equal(store.observeListing(eventList).decisions[0].reason,"unchanged");
  assert.equal(store.reviewQueue().items.length,0);
  t.mock.timers.tick(25*3600000);
  assert.equal(store.observeListing(eventList).decisions[0].reason,"upcoming-check");
  const poll={externalId:"spond:poll:def",title:"Velg tidspunkt",publishedAt:new Date().toISOString()};
  const pollList={source:"spond",surface:"group-1:polls",items:[poll]};
  const pollRaw=store.upsertRaw({source:"spond",externalId:poll.externalId,title:poll.title});
  store.observeListing(pollList);
  store.markReviewed({source:"spond",surface:pollList.surface,externalId:poll.externalId,rawId:pollRaw.item.id});
  t.mock.timers.tick(8*86400000);
  assert.equal(store.observeListing(pollList).decisions[0].reason,"periodic-check");
  store.markReviewed({source:"spond",surface:pollList.surface,externalId:poll.externalId,rawId:pollRaw.item.id});
  assert.equal(store.observeListing({...pollList,items:[{...poll,reviewPolicy:"once"}]}).decisions[0].reason,"unchanged");
}));

test("reliable versions avoid periodic rereads but a changed version is immediate", (t) => fixture((dir) => {
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const store=createStore(dir);
  const item={externalId:"versioned",title:"Plan",publishedAt:new Date().toISOString(),changeTracking:"reliable",changeToken:"v1:comments0:attachment1"};
  const listing={source:"vigilo",surface:"child3:news",items:[item]};
  store.observeListing(listing);
  store.markReviewed({source:"vigilo",surface:"child3:news",externalId:item.externalId,relevance:"irrelevant",reviewNote:"Ingen relevante funn"});
  t.mock.timers.tick(8 * 86400000);
  assert.equal(store.observeListing(listing).decisions[0].reason,"unchanged");
  assert.equal(store.observeListing({...listing,items:[{...item,changeToken:"v2:comments1:attachment2"}]}).decisions[0].reason,"changed");
}));

test("explicit before-start items get one check in the upcoming 72-hour window", (t) => fixture((dir) => {
  t.mock.timers.enable({apis:["Date"],now:Date.now()});
  const store=createStore(dir);
  const item={externalId:"trip",title:"Tur",publishedAt:new Date().toISOString(),reviewPolicy:"before-start"};
  const listing={source:"vigilo",surface:"child3:news",items:[item]};
  const start=new Date(Date.now()+4*86400000).toISOString();
  const raw=store.upsertRaw({source:"vigilo",externalId:item.externalId,title:item.title,findings:[{canonicalKey:"test:trip",title:"Tur",start,end:new Date(Date.parse(start)+3600000).toISOString(),members:["child3"]}]});
  store.observeListing(listing);
  store.markReviewed({source:"vigilo",surface:"child3:news",externalId:item.externalId,rawId:raw.item.id});
  t.mock.timers.tick(25*3600000);
  assert.equal(store.observeListing(listing).decisions[0].reason,"upcoming-check");
  store.markReviewed({source:"vigilo",surface:"child3:news",externalId:item.externalId,rawId:raw.item.id});
  t.mock.timers.tick(3*3600000);
  assert.equal(store.observeListing(listing).decisions[0].reason,"unchanged");
}));

test("Vigilo cannot report full coverage until news and messages are checked for every child", () => fixture((dir) => {
  const store = createStore(dir);
  store.beginRun();
  assert.throws(() => store.updateSource({ source:"vigilo", health:"ok" }), /Vigilo kan ikke merkes ferdig/);
  assert.throws(() => store.recordRun({ outcome:"ok", summary:"Ferdig" }), /restanser/);
  assert.throws(() => store.updateSurface({ source:"vigilo", surface:"child2:messages", health:"ok", complete:true }), /listen og alle detaljer/);
  for (const child of ["child1", "child2", "child3", "child4"]) for (const section of ["news", "messages"]) {
    const surface = `${child}:${section}`;
    store.observeListing({ source:"vigilo", surface, items:[] });
    store.updateSurface({ source:"vigilo", surface, health:"ok", complete:true });
  }
  assert.equal(store.updateSource({ source:"vigilo", health:"ok" }).health, "ok");
  store.updateSource({ source:"spond", health:"ok" });
  store.updateSource({ source:"facebook", health:"ok" });
  assert.deepEqual(store.completionReport().incompleteSources.map(s=>s.source), ['renovasjon']);
  store.updateSource({ source:"renovasjon", health:"ok" });
  assert.equal(store.recordRun({ outcome:"ok", summary:"Ferdig" }).outcome, "ok");
  assert.equal(store.reviewQueue().vigiloCoverage.filter((entry) => entry.issues.length).length, 0);
}));

test("run completion requires reviewed queue, full coverage, Drive copies and synced calendar", () => fixture((dir) => {
  const store = createStore(dir);
  store.beginRun();
  for (const child of ["child1", "child2", "child3", "child4"]) for (const section of ["news", "messages"]) {
    const surface = `${child}:${section}`;
    store.observeListing({ source:"vigilo", surface, items:[] });
    store.updateSurface({ source:"vigilo", surface, health:"ok", complete:true });
  }
  store.updateSource({ source:"vigilo", health:"ok" });
  store.updateSource({ source:"spond", health:"ok" });
  store.updateSource({ source:"facebook", health:"ok" });
  store.updateSource({ source:"renovasjon", health:"ok" });
  const raw = store.upsertRaw({ source:"spond", externalId:"trip", title:"Tur", findings:[{ canonicalKey:"trip", title:"Tur", start:"2026-10-01T08:00:00+02:00", end:"2026-10-01T09:00:00+02:00" }] });
  store.observeListing({ source:"spond", surface:"events", items:[{ externalId:"trip", title:"Tur" }] });
  store.updateSurface({ source:"spond", surface:"events", health:"partial", nextPageHint:"Neste side" });
  assert.deepEqual(store.completionReport().counts, { phonePending:0,pendingItems:1, incompleteSurfaces:1, incompleteSources:0, missingDrive:1, unsyncedCalendar:1, vigiloIssues:0, profileReviews:1,shoppingPending:0,shoppingBlocked:0 });
  assert.throws(() => store.recordRun({ outcome:"ok" }), /restanser/);
  assert.throws(() => store.recordRun({ outcome:"partial", summary:"Trenger mer tid" }), /blockers/);
  store.markReviewed({ source:"spond", surface:"events", externalId:"trip", rawId:raw.item.id });
  store.reviewProfile(raw.item.id, { facts:[], note:"Ingen varig familieinformasjon i dette arrangementet." });
  store.updateSurface({ source:"spond", surface:"events", health:"ok", complete:true });
  store.linkDrive(raw.item.id, null, "https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  const event = store.snapshot().events[raw.findings[0].id];
  store.linkCalendar(event.id, { calendarId:"family", eventId:"google-id", fingerprint:event.fingerprint });
  assert.equal(store.completionReport().complete, true);
  assert.equal(store.recordRun({ outcome:"ok", summary:"Ferdig" }).outcome, "ok");
}));

test("a long source scan renews its lease without allowing overlap", () => fixture((dir) => {
  const store = createStore(dir);
  const first = store.beginRun();
  assert.equal(first.acquired, true);
  assert.equal(store.beginRun().acquired, false);
  assert.equal(store.renewRun(first.lease.token).renewed, true);
  assert.equal(store.beginRun().acquired, false);
  assert.deepEqual(store.endRun(first.lease.token), { released:true });
  assert.equal(store.beginRun().acquired, true);
}));

test("profile assessment is tied to the raw revision and stale profile forms preserve learned facts", () => fixture((dir) => {
  const store = createStore(dir);
  const oldProfile = store.snapshot().profile;
  const raw = store.upsertRaw({ source:"spond", externalId:"role", title:"Foreldrekontakt", body:"Forelder A er foreldrekontakt." });
  store.reviewProfile(raw.item.id, { note:"Eksplisitt rolle i kilden.", facts:[{ memberId:"parent1", key:"role:3a", category:"role", confidence:"confirmed", text:"Foreldrekontakt 3A", quote:"Forelder A er foreldrekontakt.", validTo:"2027-08-01" }] });
  assert.equal(store.completionReport().counts.profileReviews, 0);
  store.updateProfile(oldProfile);
  assert.equal(store.profile().activeFacts.some((fact) => fact.key === "role:3a"), true);
  store.upsertRaw({ source:"spond", externalId:"role", title:"Foreldrekontakt", body:"Rollen er endret." });
  assert.equal(store.completionReport().counts.profileReviews, 1);
}));

test("encrypted previous version restores a corrupt archive without exposing plaintext", () => fixture((dir) => {
  const store = createStore(dir);
  store.upsertRaw({ source:"vigilo", externalId:"one", title:"Første" });
  store.upsertRaw({ source:"vigilo", externalId:"two", title:"Andre" });
  assert.equal(readFileSync(join(dir,"archive.json.enc.bak")).includes(Buffer.from("Første")), false);
  writeFileSync(join(dir,"archive.json.enc"), "corrupt");
  const recovered = createStore(dir);
  assert.equal(Object.values(recovered.snapshot().rawItems)[0].title, "Første");
  assert.ok(recovered.snapshot().recoveredAt);
  assert.equal(recovered.snapshot().sourceStatus.vigilo.health, "error");
}));

test("run logging uses lease start and overlap is a skipped attempt", () => fixture((dir) => {
  const store = createStore(dir);
  const { lease } = store.beginRun();
  const run = store.recordRun({ outcome:"partial", blockers:["Kildens innlogging er utløpt."], resumeHint:"Logg inn og fortsett." });
  assert.equal(run.startedAt, lease.startedAt);
  assert.ok(run.durationMs >= 0);
  const skipped = store.recordRun({ outcome:"skipped", summary:"Aktiv kjøring holder låsen." });
  assert.equal(skipped.completion, null);
  assert.equal(store.snapshot().runLease.token, lease.token);
}));

test('run timing keeps the real lease start and marks late reports as unmeasured', () => fixture(dir => {
  const store=createStore(dir);
  const {lease}=store.beginRun();
  const input={scope:'kildeendringer',outcome:'partial',blockers:['Kildens API svarte ikke på det siste forsøket.'],resumeHint:'Kontroller samleren ved neste faktiske endring.'};
  const run=store.recordRun({...input,startedAt:new Date(Date.parse(lease.startedAt)+3600000).toISOString(),details:'Behandling fullført unntatt kildefeilen.'});
  assert.equal(run.startedAt,lease.startedAt);
  assert.equal(run.summary,'Behandling fullført unntatt kildefeilen.');
  store.endRun(lease.token);
  const late=store.recordRun({...input,summary:'Rapporten ble sendt etter frigjøring.'});
  assert.equal(late.startedAt,null);
  assert.equal(late.durationMs,null);
  const timed=store.recordRun({...input,summary:'Eksplisitt dokumentert start.',startedAt:lease.startedAt});
  assert.equal(timed.startedAt,lease.startedAt);
  assert.ok(timed.durationMs>=0);
  assert.equal(store.snapshot().runLease,null);
}));

test("expected source originals stay visible even when no local attachment was obtained", () => fixture((dir) => {
  const store = createStore(dir);
  const raw = store.upsertRaw({ source:"spond", externalId:"file", title:"Oppgaver", expectedOriginals:["oppgaver.pdf"] });
  store.linkDrive(raw.item.id, null, "https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  assert.equal(store.completionReport().missingDrive[0].kind, "source-original");
  const attachment = store.addAttachment(raw.item.id, { fileName:"oppgaver.pdf", bytes:Buffer.from("pdf") });
  assert.equal(store.completionReport().missingDrive[0].kind, "attachment");
  store.linkDrive(raw.item.id, attachment.id, "https://drive.google.com/file/d/EXAMPLE_DOCUMENT_ID/view");
  assert.equal(store.completionReport().missingDrive.length, 0);
}));

test("an explicit source correction removes obsolete checklist text and cancellation requires calendar sync", () => fixture((dir) => {
  const store = createStore(dir);
  const raw = store.upsertRaw({ source:"spond", externalId:"event", title:"Tur", findings:[{ canonicalKey:"trip", title:"Tur", start:"2026-10-01T08:00:00+02:00", end:"2026-10-01T09:00:00+02:00", details:"Lang gammel beskjed", checklist:["Ved","Kakao"] }] });
  const event = raw.findings[0];
  store.linkCalendar(event.id, { calendarId:"family", eventId:"google", fingerprint:event.fingerprint });
  store.upsertFinding(raw.item.id, { canonicalKey:"trip", title:"Tur avlyst", replacePrevious:true, cancelled:true, checklist:[], details:"Avlyst" });
  const changed = store.snapshot().events[event.id];
  assert.deepEqual(changed.checklist, []);
  assert.equal(changed.details, "Avlyst");
  assert.equal(changed.cancelled, true);
  assert.notEqual(changed.fingerprint, changed.calendar.fingerprint);
}));

test("long source text is preserved and oversized intake fails without silently truncating", () => fixture((dir) => {
  const store = createStore(dir);
  const body = "x".repeat(120000);
  assert.equal(store.upsertRaw({ source:"vigilo", externalId:"long", title:"Langt dokument", body }).item.body.length, body.length);
  assert.throws(() => store.upsertRaw({ source:"vigilo", externalId:"too-long", title:"For langt", body:"x".repeat(1000001) }), /avkortes/);
}));

test("encrypted run history remains available through bounded pages", () => fixture((dir) => {
  const store = createStore(dir);
  for (let index = 0; index < 31; index++) store.recordRun({ outcome:"skipped", summary:`Forsøk ${index}` });
  const first = store.runHistory();
  const second = store.runHistory(first.nextCursor);
  assert.equal(first.runs.length, 30);
  assert.equal(second.runs.length, 1);
  assert.equal(new Set([...first.runs, ...second.runs].map((run) => run.id)).size, 31);
}));

test('native source IDs reuse the same raw item and review across formatting variants without title guessing',()=>fixture(dir=>{
 const store=createStore(dir),id='vigilo:news:42f8e253-e477-43bb-d783-8917b05af14a';
 const input={source:'vigilo',externalId:id,title:'Ukeplan',body:'Samme tekst',publishedAt:new Date().toISOString()};
 const raw=store.upsertRaw(input).item;
 store.observeListing({source:'vigilo',surface:'child3:news',items:[{externalId:id,title:'Ukeplan',publishedAt:input.publishedAt}]});
 store.markReviewed({source:'vigilo',surface:'child3:news',externalId:id,rawId:raw.id});
 const alternate='NEWS:42F8E253E47743BBD7838917B05AF14A';
 assert.equal(store.upsertRaw({...input,externalId:alternate}).item.id,raw.id);
 assert.equal(store.observeListing({source:'vigilo',surface:'child3:news',items:[{externalId:alternate,title:'Ukeplan',publishedAt:input.publishedAt}]}).decisions[0].reason,'unchanged');
 const lookup=store.sourceItems({source:'vigilo',externalIds:[alternate]})[0];
 assert.equal(lookup.raws[0].id,raw.id);assert.equal(lookup.reviews.length,1);
 assert.equal(store.observeListing({source:'vigilo',surface:'child4:news',items:[{externalId:alternate,title:'Ukeplan',publishedAt:input.publishedAt}]}).decisions[0].reason,'new','each child still needs relevance review');
 const post='spond:post:77A45B9649B1655A772A35998011283E';
 const one=store.upsertRaw({source:'spond',externalId:post,title:'Samme tittel',body:'A'}).item;
 assert.equal(store.upsertRaw({source:'spond',externalId:post.toLowerCase(),title:'Samme tittel',body:'A'}).item.id,one.id);
 assert.notEqual(store.upsertRaw({source:'spond',externalId:post.replace(':post:',':event:'),title:'Samme tittel',body:'A'}).item.id,one.id);
 assert.equal(store.sourceItems({source:'vigilo',externalIds:['annen:ukeplan']})[0].known,false);
}));

test('exact source excerpts detect real edits without agent summary churn',()=>fixture(dir=>{
 const store=createStore(dir),item={externalId:'stable-list-test',title:'Beskjed',summary:'Agentens første formulering',sourceExcerpt:'Tur tirsdag. Ta med kakao.',publishedAt:new Date().toISOString()};
 const input={source:'vigilo',surface:'child3:news',items:[item]};
 store.observeListing(input);store.markReviewed({source:'vigilo',surface:'child3:news',externalId:item.externalId,relevance:'irrelevant',reviewNote:'Test'});
 assert.equal(store.observeListing({...input,items:[{...item,summary:'En helt annen agentoppsummering'}]}).decisions[0].reason,'unchanged');
 assert.equal(store.observeListing({...input,items:[{...item,sourceExcerpt:'Tur onsdag. Ta med kakao.'}]}).decisions[0].reason,'changed');
}));

test('a confirmed off-group Facebook false positive leaves an audit record without blocking publication',()=>fixture(dir=>{
 const store=createStore(dir),input={source:'facebook',externalId:'facebook:post:94902977818511058',title:'Unrelated post',body:'Drone testing in Texas',sourceUrl:'https://www.facebook.com/person/posts/example',expectedOriginals:['attachment 1']};
 const raw=store.upsertRaw(input).item;
 assert.ok(store.completionReport().missingDrive.some(item=>item.rawId===raw.id));
 store.upsertRaw({...input,discarded:true,discardReason:'Personlig innlegg uten gruppetilknytning i kildedata.'});
 assert.equal(store.snapshot().rawItems[raw.id].discardReason,'Personlig innlegg uten gruppetilknytning i kildedata.');
 assert.equal(store.completionReport().missingDrive.some(item=>item.rawId===raw.id),false);
 assert.equal(store.completionReport().profileReviews.some(item=>item.rawId===raw.id),false);
 assert.throws(()=>store.upsertFinding(raw.id,{canonicalKey:'x',title:'x',start:'2026-10-01',end:'2026-10-02'}),/Forkastet/);
 assert.throws(()=>store.upsertRaw({...input,sourceUrl:'https://www.facebook.com/groups/123/posts/456',discarded:true,discardReason:'wrong'}),/feilfangede/);
}));
