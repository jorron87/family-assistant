import {readConfig} from './config.mjs';
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decrypt, encrypt, loadKey } from "./crypto.mjs";
import { initialProfile } from "./profile.mjs";
import { normalizeProfile, validateFact, learnFact, profileView } from "./profile-facts.mjs";
import { mergeTask } from "./tasks.mjs";
import { phoneStore } from './phone.mjs';
import { shoppingStore } from './shopping.mjs';
import {sourceIdentity} from './source-identity.mjs';
import {normalizeWeeklyLetter} from './weekly-letters.mjs';
import {recoveredSpondDiscovery} from './collector.mjs';
import {hsiaHref,hsiaOccurrenceToken} from './activity-feeds.mjs';
import {inspectOriginalResponse} from './original-response.mjs';
import {reconcileSourceReviews} from './source-reviews.mjs';
import {assertDisplayText,prepareTextRepairs} from './text-integrity.mjs';
import {normalizeChildren,normalizeVigiloNews,normalizeVigiloThreads,normalizeVigiloThreadDetail,normalizeSpondPosts,normalizeSpondEvents,normalizeFacebookPosts,normalizeFacebookEvents,mergeFacebookPost,facebookPostToken,normalizeSupplemental,collectorIsFresh,isoDay,normalizeTitle,VIGILO_ORIGIN} from './collector.mjs';

export const DATA_DIR = process.env.FAMILIEN_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "Familien", "data");
const SOURCES = new Set(["vigilo", "spond", "facebook", "renovasjon"]);
const HEALTH = new Set(["ok", "partial", "needs_login", "error"]);

const VIGILO_SECTIONS = ["news", "messages"];
const retiredSurface = (entry) => entry.source === 'vigilo' && /^(?:[^:]+:)?(?:consents|consent-counts)$/.test(entry.surface);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const calendarDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Intl.DateTimeFormat('en-CA', {timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const canonicalSurface = (source, value) => {
  let name = words(value, 300);
  while (name.startsWith(`${source}:`)) name = name.slice(source.length + 1);
  if (source === "facebook" && /^\d+:/.test(name)) name = `group-${name}`;
  return name;
};
const fileLabel = (value) => String(value).normalize("NFKC").toLocaleLowerCase("nb-NO").replace(/\.(pdf|docx?|pptx?|xlsx?|jpe?g|png)$/," ").replace(/[^\p{L}\p{N}]/gu,"");
const cleanUrl = (value) => {
  if (!value) return null;
  const url = new URL(value);
  if (!new Set(["https:", "http:"]).has(url.protocol)) throw new Error("Ugyldig kilde-URL.");
  for (const name of [...url.searchParams.keys()]) {
    if (!new Set(["id", "eid", "resourcekey", "story_fbid", "fbid", "comment_id", "reply_comment_id"]).has(name.toLowerCase())) url.searchParams.delete(name);
  }
  url.hash = "";
  return url.toString();
};
const words = (value, max = 20000) => String(value ?? "").trim().slice(0, max);
const uniq = (values) => [...new Set(values.filter(Boolean))];
const validDate = (value, field, nullable = false) => {
  if (!value && nullable) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Ugyldig ${field}.`);
  return value;
};

export function createStore(dataDir = DATA_DIR) {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "attachments"), { recursive: true });
  const runDir = join(dataDir, "runs");
  mkdirSync(runDir, { recursive:true });
  const key = loadKey(dataDir);
  const statePath = join(dataDir, "archive.json.enc");
  const backupPath = `${statePath}.bak`;
  let recovered = false;
  let state;
  if (existsSync(statePath)) {
    try { state = JSON.parse(decrypt(readFileSync(statePath), key).toString("utf8")); }
    catch (error) {
      if (!existsSync(backupPath)) throw error;
      state = JSON.parse(decrypt(readFileSync(backupPath), key).toString("utf8"));
      recovered = true;
      state.recoveredAt = now();
    }
  } else state = { version: 1, profile: structuredClone(initialProfile), rawItems: {}, events: {}, sourceStatus: {}, runs: [], createdAt: now() };
  if (state.version !== 1) throw new Error("Ukjent arkivversjon.");
  const archiveRun = (run) => {
    const file = join(runDir, `${run.finishedAt.replace(/[:.]/g,"-")}_${run.id}.enc`);
    if (!existsSync(file)) writeFileSync(file, encrypt(Buffer.from(JSON.stringify(run)), key));
  };
  if (recovered) {
    const recoveryRun = { id:randomUUID(), startedAt:now(), finishedAt:now(), outcome:"error", summary:"Skadet hovedarkiv ble gjenopprettet fra kryptert forrige versjon. Kontroller siste kildeoverlapp og eksterne Drive-/kalenderskrivinger før full dekning.", blockers:["Siste arkivskriving kan mangle etter gjenoppretting."], resumeHint:"Les siste 72 timer på nytt og avstem eksisterende eksterne fil-/hendelses-ID-er." };
    state.runs.unshift(recoveryRun);
    for (const source of SOURCES) state.sourceStatus[source] = { ...(state.sourceStatus[source] ?? {}), source, health:"error", checkedAt:now(), details:recoveryRun.summary };
  }
  for (const run of state.runs) archiveRun(run);
  const childMemberIds = () => state.profile.members.filter(m=>m.role==='child').map(m=>m.id);
  const vigiloMemberIds = () => state.profile.members.filter(m=>m.role==='child' && m.vigilo!==false).map(m=>m.id);
  state.reviewLedger ??= {};
  state.documentReviews ??= {};
  state.surfaces ??= {};
  state.activities ??= {};
  state.activitySourceStatus ??= {};
  state.reviewPolicy ??= { historyDays:30 };
  state.activityFeed ??= { hsia: { items: {}, sweepAt: null, baselined: false }, pages: {} };
  // Keep legacy entries/receipts as history, but route day-specific search URLs
  // to one activity page. Only actually acknowledged versions confer receipts.
  for (const [href,item] of Object.entries(state.activityFeed.hsia.items)) {
    const stable = hsiaHref(href);
    const acknowledged = item.reviewedOccurrences ?? (item.hash===item.reviewedHash ? item.occurrences.map(o=>hsiaOccurrenceToken(item,o)) : []);
    item.reviewedOccurrences = acknowledged;
    const current = state.activityFeed.hsia.items[stable];
    if (stable!==href) {
      if (!current) state.activityFeed.hsia.items[stable] = {...item,href:stable,identityAlias:null};
      else {
        current.reviewedOccurrences = uniq([...(current.reviewedOccurrences??[]),...acknowledged]);
        if (String(item.lastSeenAt)>String(current.lastSeenAt)) {
          state.activityFeed.hsia.items[stable] = {...item,href:stable,identityAlias:null,reviewedOccurrences:current.reviewedOccurrences,detail:item.detail??current.detail,firstSeenAt:[item.firstSeenAt,current.firstSeenAt].filter(Boolean).sort()[0]};
        }
      }
      item.identityAlias=stable;
    }
  }
  state.collector ??= { children:{}, items:{}, sweeps:{}, health:{}, aliases:{}, refreshRequestedAt:null };
  let supplementalMigration = false;
  for (const [id,status] of Object.entries(state.collector.supplemental ?? {})) {
    const root = id.match(/^spond:files:([A-Fa-f0-9]{32}):$/)?.[1];
    const corrected = root && state.collector.supplemental[`spond:files:${root}:${root}`];
    if (status.health === 'error' && !status.resolvedAt && corrected?.complete === true && corrected.health === 'ok' && corrected.at > status.at) {
      status.resolvedAt = corrected.at; status.resolvedBy = `spond:files:${root}:${root}`; supplementalMigration = true;
    }
  }
  const originalSurfaces = JSON.stringify(state.surfaces);
  const surfaces = {};
  for (const old of Object.values(state.surfaces).sort((a,b) => String(a.checkedAt).localeCompare(String(b.checkedAt)))) {
    const surface = canonicalSurface(old.source, old.surface);
    const key = `${old.source}:${surface}`;
    const previous = surfaces[key];
    surfaces[key] = {...previous, ...old, surface, listingObservedAt:[previous?.listingObservedAt,old.listingObservedAt].filter(Boolean).sort().at(-1) ?? null, lastCompleteScanAt:[previous?.lastCompleteScanAt,old.lastCompleteScanAt].filter(Boolean).sort().at(-1) ?? null};
  }
  state.surfaces = surfaces;
  const surfacesMigrated = originalSurfaces !== JSON.stringify(surfaces);
  const profileMigration = state.profile.facts.some((fact) => !fact.id);
  normalizeProfile(state.profile);
  const reviewKey = (source, surface, externalId) => hash(`${source}\0${canonicalSurface(source,surface)}\0${externalId}`).slice(0, 24);
  const migratedReviewLedger = Object.entries(state.reviewLedger).some(([key, entry]) => key !== reviewKey(entry.source, entry.surface, entry.externalId));
  if (migratedReviewLedger) state.reviewLedger = Object.fromEntries(Object.values(state.reviewLedger).sort((a,b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt))).map((entry) => {
    const id = reviewKey(entry.source, entry.surface, entry.externalId);
    return [id, { ...entry, id, surface:canonicalSurface(entry.source,entry.surface) }];
  }));

  function eventFingerprint(event) {
    const evidence = event.sourceRefs.map((id) => {
      const raw = state.rawItems[id];
      return [id, raw?.revision, raw?.driveUrl, (raw?.attachments ?? []).map((a) => [a.sha256, a.driveUrl])];
    });
    return hash(JSON.stringify([event.title, event.kind, event.start, event.end, event.allDay, event.provisional, event.members, event.checklist, event.details, event.sourceRefs, event.alternatives, evidence, ...(event.timeNote ? [event.timeNote] : []), ...(event.cancelled ? ["cancelled"] : []), ...(event.task ? [{visibleFrom:event.task.visibleFrom,dueDate:event.task.dueDate,items:event.task.items.map(({key,text})=>({key,text}))}] : [])]));
  }

  function refreshEvents(rawId) {
    for (const event of currentEvents()) if (event.sourceRefs.includes(rawId)) event.fingerprint = eventFingerprint(event);
  }

  function repairText(input) {
    if(!state.runLease || input.token!==state.runLease.token || Date.parse(state.runLease.expiresAt)<=Date.now())throw Error('Tekstretting krever egen aktiv kjøringslås.');
    const records=prepareTextRepairs(state,input.changes);
    const receipt={at:now(),fields:input.changes.length,records:records.map(({collection,id})=>({collection,id}))};
    if(input.dryRun)return {...receipt,dryRun:true};
    // All comparisons succeed before any mutation. Checkmarks, stable keys,
    // source receipts, hidden state and dates are copied, never re-imported.
    for(const {collection,id,record} of records) {
      if(collection==='rawItems' && (record.body!==state.rawItems[id].body||record.title!==state.rawItems[id].title)) {
        const old=state.rawItems[id];record.revision=old.revision+1;
        record.contentHash=hash(JSON.stringify([record.title,record.body,record.sourceUrl,record.groupName,record.publishedAt,record.memberIds,...(record.expectedOriginals?.length?[record.expectedOriginals]:[])]));
        if(old.profileReviewedRevision===old.revision)record.profileReviewedRevision=record.revision;
      }
      record.updatedAt=receipt.at;state[collection][id]=record;
    }
    for(const event of currentEvents())event.fingerprint=eventFingerprint(event);
    state.textRepairs??=[];state.textRepairs.push({...receipt,changes:structuredClone(input.changes)});
    save();return receipt;
  }

  const currentEvents = () => Object.values(state.events).filter(event=>!event.mergedInto);
  function resolveEvent(id) {
    let event=state.events[id];const seen=new Set();
    while(event?.mergedInto){if(seen.has(event.id))throw Error('Sirkulært hendelsesalias.');seen.add(event.id);event=state.events[event.mergedInto];}
    return event;
  }
  const event = id => structuredClone(resolveEvent(id));
  const eventHistory = id => structuredClone(state.events[id]);

  // Explicit, revision-checked repair. Original keys and complete objects remain
  // as aliases/history; never delete Google or re-import the original source.
  function mergeEvents(input) {
    const ids=uniq([input.targetId,...(input.eventIds??[])]);
    const records=ids.map(id=>state.events[id]);
    if(records.length<2 || records.some(item=>!item))throw Error('Sammenslåing trenger minst to kjente oppføringer.');
    const target=state.events[input.targetId];
    if(records.every(item=>resolveEvent(item.id)?.id===target.id))return {id:target.id,alreadyMerged:true};
    if(records.some(item=>item.mergedInto || item.taskSplit))throw Error('Oppføring er allerede erstattet; les gjeldende ID-er.');
    if(records.some(item=>input.expectedEvents?.[item.id]!==hash(JSON.stringify(item))))throw Error('Oppføring eller familievalg er endret. Les på nytt før sammenslåing.');
    const calendar=target.calendar;
    if(!calendar?.eventId || input.googleEventId!==calendar.eventId || records.some(item=>item.calendar && (item.calendar.eventId!==calendar.eventId || item.calendar.calendarId!==calendar.calendarId)))throw Error('Sammenslåing krever bekreftet samme Google-hendelse.');
    const memberKey=item=>[...item.members].sort().join('|');
    if(records.some(item=>item.start?.slice(0,10)!==target.start?.slice(0,10) || memberKey(item)!==memberKey(target) || item.task?.category==='homework'))throw Error('Ulike datoer/personer eller personlige lekser kan ikke slås sammen med denne reparasjonen.');
    const next=structuredClone(target),at=now();
    next.sourceRefs=uniq(records.flatMap(item=>item.sourceRefs));
    const history=records.flatMap(item=>item.calendarHistory??[]);
    next.calendarHistory=history.filter((item,index)=>history.findIndex(other=>JSON.stringify(other)===JSON.stringify(item))===index);
    if(records.some(old=>old.task?.items.some(item=>!item.doneAt && !next.task?.items.some(current=>current.text===item.text))))throw Error('Åpne deloppgaver må avstemmes før sammenslåing.');
    if(next.task)for(const item of next.task.items){
      const done=records.flatMap(old=>old.task?.items??[]).filter(old=>old.text===item.text&&old.doneAt).map(old=>old.doneAt).sort();
      if(done.length)item.doneAt=done[0];
    }
    const choice=records.filter(item=>item.visibility?.changedAt).sort((a,b)=>String(b.visibility.changedAt).localeCompare(String(a.visibility.changedAt)))[0];
    if(choice)next.visibility=structuredClone(choice.visibility);
    const removed=records.map(item=>item.calendar).filter(item=>item?.removedAt).sort((a,b)=>b.removedAt.localeCompare(a.removedAt))[0];
    const latestSync=records.map(item=>item.calendar).filter(Boolean).sort((a,b)=>String(b.syncedAt).localeCompare(String(a.syncedAt)))[0];
    if(removed && removed.removedAt>=latestSync.syncedAt)next.calendar=structuredClone(removed);
    if(choice)next.visibility={...next.visibility,revision:Math.max(...records.map(item=>item.visibility?.revision??0))+1,
      sync:{status:next.visibility.hidden?(next.calendar?.removedAt?'done':'pending'):(next.calendar?.removedAt?'pending':next.visibility.sync?.status??'done')},history:[...(next.visibility.history??[]),{hidden:next.visibility.hidden,at,reason:'Bevart siste familievalg ved sammenslåing'}]};
    const {eventMerge:priorMerge,...targetBefore}=structuredClone(target);
    next.eventMerge={at,eventIds:uniq([...(target.eventMerge?.eventIds??[]),...ids.filter(id=>id!==target.id)]),canonicalKeys:uniq(records.flatMap(item=>[item.canonicalKey,...(item.eventMerge?.canonicalKeys??[])])),versions:[...(priorMerge?.versions??[]),targetBefore]};
    next.fingerprint=eventFingerprint(next);
    const receipt={id:next.id,mergedIds:ids.filter(id=>id!==target.id),hidden:!!next.visibility?.hidden,needsCalendar:!next.visibility?.hidden && next.calendar?.fingerprint!==next.fingerprint};
    if(input.dryRun)return {...receipt,dryRun:true};
    state.events[target.id]=next;
    for(const old of records)if(old.id!==target.id)state.events[old.id]={...old,mergedInto:target.id,mergedAt:at};
    for(const raw of Object.values(state.rawItems))raw.findingIds=uniq(raw.findingIds.map(id=>ids.includes(id)?target.id:id));
    for(const activity of Object.values(state.activities))if(ids.includes(activity.plan?.eventId))activity.plan.eventId=target.id;
    save();return receipt;
  }

  function save() {
    const temp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temp, encrypt(Buffer.from(JSON.stringify(state)), key));
    if (existsSync(statePath) && !recovered) copyFileSync(statePath, backupPath);
    renameSync(temp, statePath);
    recovered = false;
  }
  function backupArchive(input={}) {
    const label=String(input.label??'manual');
    if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(label))throw Error('Ugyldig sikkerhetskopinavn.');
    const at=now(),name=`${at.replace(/[:.]/g,'-')}_${randomUUID()}_${label}.enc`;
    const directory=join(dataDir,'backups');mkdirSync(directory,{recursive:true});
    const bytes=encrypt(Buffer.from(JSON.stringify(state)),key);
    writeFileSync(join(directory,name),bytes,{flag:'wx'});
    if(!readFileSync(join(directory,name)).equals(bytes))throw Error('Sikkerhetskopien kunne ikke verifiseres.');
    return {at,fileName:name,bytes:bytes.length,sha256:hash(bytes),currentEvents:currentEvents().length,
      archivedEvents:Object.keys(state.events).length,rawItems:Object.keys(state.rawItems).length};
  }
  const discoveryRecovery=recoveredSpondDiscovery(state.collector,state.surfaces);
  if(discoveryRecovery) {
    const prior=state.collector.supplemental['spond:discovery:all:'];
    state.collector.supplemental['spond:discovery:all:']={health:'ok',complete:true,count:discoveryRecovery.groupIds.length,
      ...discoveryRecovery,recoveredFrom:{at:prior.at,detail:prior.detail}};
    const surface=state.surfaces['spond:group-all:discovery'];
    if(surface?.collectorFailure)state.surfaces['spond:group-all:discovery']={...surface,health:'ok',currentComplete:true,
      checkedAt:discoveryRecovery.at,lastCompleteScanAt:discoveryRecovery.at,scanTo:discoveryRecovery.at,
      blocker:null,retryAfter:null,collectorFailure:false,seenCount:discoveryRecovery.groupIds.length,
      details:'Tidligere gruppehentingsfeil er avløst av to komplette tilleggsinnhentinger med samme observerte gruppeoversikt. Dette kvitterer bare gruppeoversikten.'};
    supplementalMigration=true;
  }
  if (!existsSync(statePath) || migratedReviewLedger || surfacesMigrated || profileMigration || supplementalMigration || recovered) save();

  function cutoffAt(at = Date.now()) { return at - state.reviewPolicy.historyDays * 86400000; }
  function rawIsActive(raw, at = Date.now()) {
    if (!raw) return true;
    if(raw.discardedAt)return false;
    if(raw.source==='telefon') {
      const phoneItem=state.phone?.inbox[raw.externalId];
      if(['uploading','cancelled'].includes(phoneItem?.status))return false;
      if(phoneItem && phoneItem.status!=='done')return true;
    }
    if (!raw.publishedAt || Date.parse(raw.publishedAt) >= cutoffAt(at) || (raw.updatedAt && Date.parse(raw.updatedAt) >= cutoffAt(at))) return true;
    if (raw.retainUntil && Date.parse(raw.retainUntil) >= at) return true;
    return currentEvents().some((event) => event.sourceRefs.includes(raw.id) && !event.visibility?.hidden && !event.cancelled && (Date.parse(event.end) >= at || event.task?.items.some(item=>!item.doneAt)));
  }
  function outsideWindow(entry, at = Date.now()) {
    if (!entry.publishedAt || Date.parse(entry.publishedAt) >= cutoffAt(at) || (entry.updatedAt && Date.parse(entry.updatedAt) >= cutoffAt(at)) || (entry.retainUntil && Date.parse(entry.retainUntil) >= at)) return false;
    return !(entry.rawId && rawIsActive(state.rawItems[entry.rawId], at));
  }
  function historicalOnly(surface) {
    return surface.health === "partial" && surface.currentComplete === true && surface.historicalGap && Date.parse(surface.historicalGap.to) < cutoffAt() && surface.scanTo && Date.now()-Date.parse(surface.scanTo) < 12*3600000 && (!state.runLease || surface.scanTo >= state.runLease.startedAt);
  }

  function recentVigiloListing(surfaceName, info = collectorStatus().sources.vigilo) {
    const [child,section] = surfaceName.split(':');
    if (!vigiloMemberIds().includes(child) || !VIGILO_SECTIONS.includes(section)) return false;
    const sweep = info.sweeps[`vigilo:${section === 'messages' ? 'threads' : 'news'}:${child}`];
    const surface = state.surfaces[`vigilo:${surfaceName}`];
    return collectorIsFresh(info) && sweep?.complete === true &&
      surface?.listingObservedAt >= sweep.at;
  }

  function vigiloCoverage() {
    const collectorInfo = collectorStatus().sources.vigilo;
    return vigiloMemberIds().flatMap((child) => VIGILO_SECTIONS.map((section) => {
      const surfaceName = `${child}:${section}`;
      const surface = state.surfaces[`vigilo:${surfaceName}`];
      const entries = Object.values(state.reviewLedger).filter((entry) => entry.source === "vigilo" && entry.surface === surfaceName);
      const pending = entries.filter((entry) => !["unchanged","outside-window"].includes(reviewDecision(entry)));
      const thisRun = state.runLease?.startedAt;
      const issues = [];
      const recent = recentVigiloListing(surfaceName, collectorInfo);
      if (!surface?.listingObservedAt || (thisRun && surface.listingObservedAt < thisRun && !recent)) issues.push("listen er ikke lest i denne kjøringen");
      const reviewedCurrentListing = recent && surface.lastCompleteScanAt >= surface.listingObservedAt;
      if (!surface?.lastCompleteScanAt || (thisRun && surface.lastCompleteScanAt < thisRun && !reviewedCurrentListing)) issues.push("alle detaljer/vedlegg er ikke bekreftet gjennomgått i denne kjøringen");
      if (surface?.health !== "ok") issues.push(`status ${surface?.health ?? "mangler"}`);
      if (pending.length) issues.push(`${pending.length} listeelementer trenger gjennomgang`);
      return { child, section, surface: surfaceName, observed: entries.length, pending: pending.length, health: surface?.health ?? "missing", lastCompleteScanAt: surface?.lastCompleteScanAt ?? null, issues };
    }));
  }

  function upsertRaw(input) {
    assertDisplayText(input);
    input={...input,externalId:resolveExternalId(input.source,input.externalId)};
    if (!SOURCES.has(input.source) && !['aktiviteter','telefon','familie'].includes(input.source)) throw new Error("Ukjent kilde.");
    if (!words(input.externalId, 500)) throw new Error("externalId kreves.");
    if (!words(input.title, 500)) throw new Error("title kreves.");
    if (String(input.body ?? "").length > 1000000) throw new Error("Kildeteksten er for stor. Del dokumentuttrekket i stabile del-elementer; teksten skal aldri avkortes lydløst.");
    for (const finding of input.findings ?? []) {
      const canonicalKey = words(finding.canonicalKey || `${input.source}:${input.externalId}:${finding.key ?? finding.title}`, 500);
      const previousEvent = resolveEvent(hash(canonicalKey).slice(0, 24));
      if (!validDate(finding.start, "start", true) && !previousEvent?.start) {
        throw new Error("Funn må ha dato. Bruk en foreløpig oppfølgingspåminnelse når hendelsesdatoen er ukjent.");
      }
    }
    const id = hash(`${input.source}\0${input.externalId}`).slice(0, 24);
    const previous = state.rawItems[id];
    if(input.discarded===true && (input.source!=='facebook'||!words(input.discardReason,500)||previous?.findingIds?.length||previous?.attachments?.length||/facebook\.com\/groups\//.test(input.sourceUrl??'')))throw Error('Bare dokumentert feilfangede Facebook-innlegg uten funn eller originaler kan forkastes.');
    const item = {
      id, source: input.source, externalId: words(input.externalId, 500),
      title: words(input.title, 500), body: words(input.body, 1000000),
      sourceUrl: cleanUrl(input.sourceUrl), groupName: words(input.groupName, 500) || null,
      publishedAt: validDate(input.publishedAt, "publishedAt", true),
      memberIds: uniq([...(previous?.memberIds ?? []), ...(input.memberIds ?? []).map(String)]),
      observedAt: now(),
      firstSeenAt: previous?.firstSeenAt ?? now(),
      attachments: previous?.attachments ?? [],
      expectedOriginals: input.expectedOriginals ? uniq(input.expectedOriginals.map((name) => words(name, 300))) : previous?.expectedOriginals ?? [],
      weeklyLetter: input.weeklyLetter === undefined ? previous?.weeklyLetter ?? null : normalizeWeeklyLetter(input.weeklyLetter),
      driveUrl: previous?.driveUrl ?? null,
      driveRevision: previous?.driveRevision ?? null,
      profileReviewedRevision: previous?.profileReviewedRevision ?? null,
      profileReviewNote: previous?.profileReviewNote ?? null,
      profileReviewedAt: previous?.profileReviewedAt ?? null,
      retainUntil: validDate(input.retainUntil,"retainUntil",true) ?? previous?.retainUntil ?? null,
      updatedAt: validDate(input.updatedAt,"updatedAt",true) ?? previous?.updatedAt ?? null,
      findingIds: previous?.findingIds ?? []
    };
    item.discardedAt=previous?.discardedAt??(input.discarded===true?now():null);
    item.discardReason=previous?.discardReason??(input.discarded===true?words(input.discardReason,500):null);
    item.contentHash = hash(JSON.stringify([item.title, item.body, item.sourceUrl, item.groupName, item.publishedAt, item.memberIds, ...(item.expectedOriginals.length ? [item.expectedOriginals] : [])]));
    item.revision = previous?.contentHash === item.contentHash ? previous.revision : (previous?.revision ?? 0) + 1;
    state.rawItems[id] = item;
    const results = [];
    for (const finding of input.findings ?? []) results.push(upsertFinding(id, finding, false));
    refreshEvents(id);
    save();
    return { item, changed: previous?.contentHash !== item.contentHash, findings: results };
  }

  function upsertFinding(rawId, input, persist = true) {
    assertDisplayText(input);
    const raw = state.rawItems[rawId];
    if (!raw) throw new Error("Ukjent råelement.");
    if(raw.discardedAt)throw new Error('Forkastet kildeelement kan ikke få kalenderfunn.');
    const requestedKey = words(input.canonicalKey || `${raw.source}:${raw.externalId}:${input.key ?? input.title}`, 500);
    const resolved = resolveEvent(hash(requestedKey).slice(0,24));
    const canonicalKey = resolved?.canonicalKey ?? requestedKey;
    if (!canonicalKey || !words(input.title, 500)) throw new Error("Funn trenger canonicalKey og title.");
    const id = hash(canonicalKey).slice(0, 24);
    const previous = state.events[id];
    if (previous?.taskSplit) throw new Error('Den felles leksegruppen er erstattet. Oppdater de personlige oppgavene med deres canonicalKey.');
    const start = validDate(input.start, "start", true);
    const end = validDate(input.end, "end", true);
    if (start && end && Date.parse(end) <= Date.parse(start)) throw new Error("end må være etter start.");
    const sourceRefs = uniq([...(previous?.sourceRefs ?? []), rawId]);
    const alternatives = input.correctsPrevious ? [] : [...(previous?.alternatives ?? [])];
    let chosenStart = start ?? previous?.start ?? null;
    if (!chosenStart) throw new Error("Funn må ha dato. Bruk en foreløpig oppfølgingspåminnelse når hendelsesdatoen er ukjent.");
    let chosenEnd = end ?? previous?.end ?? null;
    const dateConfirmed = input.dateConfirmed ?? previous?.dateConfirmed ?? false;
    let provisional = Boolean(input.provisional && !dateConfirmed);
    const differentStart = previous?.start && start && (previous.allDay && input.allDay
      ? calendarDay(previous.start) !== calendarDay(start)
      : Date.parse(previous.start) !== Date.parse(start));
    if (differentStart && !input.correctsPrevious && !previous.sourceRefs.includes(rawId)) {
      if (!alternatives.some((entry) => entry.start === start && entry.end === end && entry.rawId === rawId)) alternatives.push({ start, end, rawId });
      chosenStart = previous.start;
      chosenEnd = previous.end;
      provisional = true;
    }
    const task = mergeTask(input.task,previous?.task);
    const members = uniq([...(input.replacePrevious ? [] : previous?.members ?? []), ...(input.members ?? []).map(String)]);
    const homework = task && (task.category === 'homework' || /\blekse(?:r|plan|planer|oppgaver)?\b|\bukeslekser\b/i.test(input.title));
    if (homework && (members.length !== 1 || !childMemberIds().includes(members[0]))) throw new Error('Lekseoppgaver krever ett barn per oppgavegruppe, også når søsken deler ukeplan. Bruk personens ID i canonicalKey.');
    if (homework && previous?.task?.category === 'homework' && previous.members[0] !== members[0]) throw new Error('En personlig lekseoppgave kan ikke flyttes til et annet barn. Bruk barnets egen canonicalKey.');
    if (homework) task.category = 'homework';
    const event = {
      id, canonicalKey, title: words(input.title, 500),
      kind: words(input.kind ?? (task ? "task" : previous?.kind ?? "event"), 40), start: chosenStart, end: chosenEnd,
      allDay: Boolean(input.allDay), provisional: provisional || Boolean(alternatives.length),
      dateConfirmed: Boolean(dateConfirmed), timeNote: words(input.timeNote ?? previous?.timeNote, 1000),
      cancelled: input.cancelled ?? previous?.cancelled ?? false,
      members,
      checklist: task ? task.items.map(item=>item.text) : uniq([...(input.replacePrevious ? [] : previous?.checklist ?? []), ...(input.checklist ?? []).map((x) => words(x, 300))]),
      details: input.replacePrevious || words(input.details, 10000).length >= words(previous?.details, 10000).length ? words(input.details, 10000) : words(previous?.details, 10000),
      reason: words(input.reason, 3000), sourceRefs, alternatives,
      calendar: previous?.calendar ?? null,
      calendarHistory: previous?.calendarHistory ?? [],
      task,
      visibility: previous?.visibility ?? null,
      ...(previous?.splitFrom ? {splitFrom:previous.splitFrom} : {}),
      ...(previous?.eventMerge ? {eventMerge:previous.eventMerge} : {}),
      createdAt: previous?.createdAt ?? now(), updatedAt: now()
    };
    event.fingerprint = eventFingerprint(event);
    state.events[id] = event;
    raw.findingIds = uniq([...raw.findingIds, id]);
    if (persist) save();
    return event;
  }

  function checkTask(eventId, key, input) {
    const event = resolveEvent(eventId);
    const item = event?.task?.items.find(item=>item.key===key);
    if (!item || event.cancelled || event.taskSplit || typeof input.done !== "boolean") throw new Error("Ugyldig oppgaveavkryssing. Bruk barnets personlige oppgave hvis listen er erstattet.");
    if (input.expectedText !== item.text) throw new Error("Oppgaven er endret. Last inn den nye teksten før avkryssing.");
    item.doneAt = input.done ? item.doneAt ?? now() : null;
    save();
    return structuredClone(event);
  }

  function setEventVisibility(eventId, input) {
    const event = resolveEvent(eventId);
    if (!event || typeof input.hidden !== 'boolean') throw new Error('Ugyldig arkivering.');
    if (event.taskSplit && !input.hidden) throw new Error('Denne felleslisten er erstattet av personlige lekseoppgaver. Gjenåpne barnets egen liste.');
    if(event.visibility?.hidden===input.hidden)return structuredClone(event);
    const revision=(event.visibility?.revision??0)+1;
    const needsCalendar=input.hidden ? !!event.calendar && !event.calendar.removedAt : true;
    event.visibility = {hidden:input.hidden, revision, changedAt:now(), sync:{status:needsCalendar?'pending':'done'}, history:[...(event.visibility?.history ?? []), {hidden:input.hidden, at:now()}]};
    save();
    return structuredClone(event);
  }

  // One atomic migration; original checks remain on the archived shared list.
  // Only explicitly attributed checks are copied to children. Retrying never resets their progress.
  function splitHomework(eventId, input) {
    const parent = resolveEvent(eventId);
    if (!parent?.task || parent.kind !== 'task') throw new Error('Ukjent lekseoppgave.');
    if (parent.taskSplit) return {alreadySplit:true,eventIds:parent.taskSplit.eventIds};
    if (parent.members.length < 2 || !parent.members.every(id=>childMemberIds().includes(id))) throw new Error('Deling krever en felles oppgave for barn.');
    if (input.expectedFingerprint !== parent.fingerprint || JSON.stringify(input.expectedItems) !== JSON.stringify(parent.task.items)) throw new Error('Oppgaven eller avkryssingene er endret. Les listen på nytt før deling.');
    const completedFor = input.completedFor ?? {};
    for (const [key, members] of Object.entries(completedFor)) {
      if (!parent.task.items.some(item=>item.key===key && item.doneAt) || !Array.isArray(members) || !members.every(id=>parent.members.includes(id))) throw new Error('Ugyldig fordeling av eksisterende avkryssing.');
    }
    const names = parent.members.map(id=>state.profile.members.find(member=>member.id===id)?.name ?? id);
    const at = now();
    const children = parent.members.map((memberId,index)=>{
      const canonicalKey = `${parent.canonicalKey}:${memberId}`;
      const id = hash(canonicalKey).slice(0,24);
      if (state.events[id]) throw new Error('Personlig oppgave finnes allerede. Avstem før deling.');
      const child = structuredClone(parent);
      const ownText = text => text.replaceAll(names.join(' og '),names[index]).replaceAll(names.join(' eller '),names[index]).replaceAll('en av dem',names[index]);
      const task = mergeTask({...parent.task,category:'homework',items:parent.task.items.map(item=>({...item,text:ownText(item.text)}))},null);
      task.items.forEach(item=>{if(completedFor[item.key]?.includes(memberId)) item.doneAt=parent.task.items.find(old=>old.key===item.key).doneAt;});
      Object.assign(child,{id,canonicalKey,title:ownText(parent.title),members:[memberId],task,checklist:task.items.map(item=>item.text),details:ownText(parent.details),calendar:null,calendarHistory:[],createdAt:at,updatedAt:at,splitFrom:parent.id});
      child.visibility = parent.visibility?.hidden ? {...structuredClone(parent.visibility),sync:{status:'done'}} : null;
      child.fingerprint = eventFingerprint(child);
      return child;
    });
    for (const child of children) {
      state.events[child.id] = child;
      for (const rawId of child.sourceRefs) state.rawItems[rawId].findingIds = uniq([...state.rawItems[rawId].findingIds,child.id]);
    }
    parent.taskSplit = {eventIds:children.map(child=>child.id),at,completedFor:structuredClone(completedFor)};
    if (!parent.visibility?.hidden) parent.visibility={hidden:true,revision:(parent.visibility?.revision??0)+1,changedAt:at,sync:{status:parent.calendar && !parent.calendar.removedAt?'pending':'done'},history:[...(parent.visibility?.history??[]),{hidden:true,at,reason:'Personlige lekseoppgaver'}]};
    save();
    return {alreadySplit:false,eventIds:children.map(child=>child.id),unassignedChecks:parent.task.items.filter(item=>item.doneAt && !completedFor[item.key]?.length).map(item=>item.key)};
  }

  function calendarActions() {
    return currentEvents().filter(event=>event.visibility?.sync?.status==='pending').map(event=>({eventId:event.id,revision:event.visibility.revision,action:event.visibility.hidden?'remove':'restore',title:event.title,calendar:event.calendar}));
  }

  function calendarAction(eventId,input) {
    const event=resolveEvent(eventId);
    if(!event || input.revision!==event.visibility?.revision)throw new Error('Familievalget er endret. Les gjeldende oppføring på nytt.');
    if(input.status==='processing') {event.visibility.sync={status:'pending',startedAt:now()};save();return event;}
    if(input.status==='error') {event.visibility.sync={status:'pending',error:words(input.note,1000),retryAt:validDate(input.retryAt,'retryAt',true)};save();return event;}
    if(!event.visibility.hidden || input.action!=='removed' || input.googleEventId!==event.calendar?.eventId)throw new Error('Ugyldig kalenderfjerningskvittering.');
    event.calendar.removedAt=now();event.visibility.sync={status:'done',syncedAt:now()};save();return event;
  }

  function updateSource(input) {
    if (!SOURCES.has(input.source) || !HEALTH.has(input.health)) throw new Error("Ugyldig kildestatus.");
    if (input.historicalOnly === true) {
      const surfaces = Object.values(state.surfaces).filter(surface => surface.source === input.source && !retiredSurface(surface));
      if (input.health !== 'partial' || !surfaces.some(historicalOnly) ||
          !surfaces.every(surface => !surface.nextPageHint && !surface.blocker &&
            (surface.health === 'ok' || historicalOnly(surface)))) {
        throw new Error('Historisk-only kildestatus krever at alle aktive overflater kun har historiske hull.');
      }
    }
    if (input.source === "vigilo" && input.health === "ok") {
      const incomplete = vigiloCoverage().filter((entry) => entry.issues.length);
      if (incomplete.length) throw new Error(`Vigilo kan ikke merkes ferdig: ${incomplete.map((entry) => `${entry.surface} (${entry.issues.join(", ")})`).join("; ")}`);
    }
    const status = {
      source: input.source, health: input.health, historicalOnly: input.historicalOnly === true, checkedAt: now(),
      scope: words(input.scope, 2000), details: words(input.details, 3000),
      seenCount: Number.isInteger(input.seenCount) && input.seenCount >= 0 ? input.seenCount : null,
      oldestCoveredAt: validDate(input.oldestCoveredAt, "oldestCoveredAt", true),
      newestCoveredAt: validDate(input.newestCoveredAt, "newestCoveredAt", true)
    };
    state.sourceStatus[input.source] = status;
    save();
    return status;
  }

  function addAttachment(rawId, { fileName, mimeType, bytes }) {
    const raw = state.rawItems[rawId];
    if (!raw) throw new Error("Ukjent råelement.");
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error("Ugyldig vedleggsstørrelse.");
    const response=inspectOriginalResponse(bytes,{fileName,mimeType});
    if(response.error)throw Error(response.error);
    const sha256 = hash(bytes);
    const existing = raw.attachments.find((a) => a.sha256 === sha256);
    if (existing) return existing;
    const id = randomUUID();
    writeFileSync(join(dataDir, "attachments", `${id}.enc`), encrypt(bytes, key));
    const attachment = { id, fileName: words(fileName, 300) || "vedlegg", mimeType: words(mimeType, 120) || "application/octet-stream", sha256, size: bytes.length, driveUrl: null, addedAt: now() };
    raw.attachments.push(attachment);
    refreshEvents(rawId);
    save();
    return attachment;
  }

  function getAttachment(rawId, attachmentId) {
    const attachment = state.rawItems[rawId]?.attachments.find((a) => a.id === attachmentId);
    if (!attachment) throw new Error("Ukjent vedlegg.");
    const bytes=decrypt(readFileSync(join(dataDir, "attachments", `${attachmentId}.enc`)), key);
    const response=inspectOriginalResponse(bytes,attachment);
    if(response.error&&!attachment.contentError){attachment.contentError=response.error;save();}
    return { attachment, bytes };
  }

  function documentStatus(sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Ugyldig SHA-256.");
    const references = Object.values(state.rawItems).flatMap((raw) => raw.attachments
      .filter((attachment) => attachment.sha256 === sha256)
      .map((attachment) => ({ rawId:raw.id, attachmentId:attachment.id, fileName:attachment.fileName, title:raw.title, memberIds:raw.memberIds, driveUrl:attachment.driveUrl })));
    const receipt = state.documentReviews[sha256] ?? null;
    return structuredClone({ sha256, needsReading:!receipt, receipt, references });
  }

  function reviewDocument(rawId, attachmentId, input) {
    const attachment = state.rawItems[rawId]?.attachments.find((a) => a.id === attachmentId);
    if (!attachment) throw new Error("Ukjent vedlegg.");
    const checked=getAttachment(rawId,attachmentId).attachment;
    if(checked.contentError)throw Error(checked.contentError);
    const { pageCount, pages, method } = input;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 10000 || !Array.isArray(pages) || pages.length !== pageCount) throw new Error("Alle dokumentets sider må være dokumentert.");
    if (!["text", "visual", "mixed"].includes(method)) throw new Error("Oppgi lesemetode text, visual eller mixed.");
    const seen = new Set();
    let textSize = 0;
    for (const page of pages) {
      if (!Number.isInteger(page.page) || page.page < 1 || page.page > pageCount || seen.has(page.page) || typeof page.text !== "string" || !page.text.trim()) throw new Error("Hver side krever unikt sidenummer og bevart tekst eller visuell beskrivelse.");
      seen.add(page.page);
      textSize += page.text.length;
    }
    if (textSize > 1000000) throw new Error("Dokumentuttrekket overstiger 1 000 000 tegn.");
    const receipt = { sha256:attachment.sha256, rawId, attachmentId, pageCount, pages:pages.map((p) => ({page:p.page, text:p.text})).sort((a,b) => a.page-b.page), method, reviewedAt:now() };
    state.documentReviews[attachment.sha256] = receipt;
    save();
    return documentStatus(attachment.sha256);
  }

  function linkDrive(rawId, attachmentId, url) {
    const raw = state.rawItems[rawId];
    if (!raw) throw new Error("Ukjent råelement.");
    const clean = cleanUrl(url);
    if (!clean || !/^https:\/\/(?:drive\.google\.com\/|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/)/.test(clean)) throw new Error("Drive-lenke kreves.");
    if (attachmentId) {
      const attachment = raw.attachments.find((a) => a.id === attachmentId);
      if (!attachment) throw new Error("Ukjent vedlegg.");
      if(getAttachment(rawId,attachmentId).attachment.contentError)throw Error(attachment.contentError);
      attachment.driveUrl = clean;
    } else {
      raw.driveUrl = clean;
      raw.driveRevision = raw.revision;
    }
    refreshEvents(rawId);
    save();
    return raw;
  }

  function linkCalendar(eventId, { calendarId, eventId: googleEventId, eventUrl, fingerprint, visibilityRevision }) {
    const event = resolveEvent(eventId);
    if (!event) throw new Error("Ukjent hendelse.");
    if(event.visibility?.hidden)throw new Error('Familien har skjult oppføringen. Ikke gjenopprett den i Google Calendar.');
    if(event.calendar?.removedAt && event.calendar.eventId===googleEventId || event.calendarHistory?.some(entry=>entry.removedAt && entry.eventId===googleEventId))throw new Error('Denne Google-ID-en er slettet. Opprett en ny aktiv oppføring; ikke oppdater den slettede ID-en.');
    if(event.visibility?.sync?.status==='pending' && visibilityRevision!==event.visibility.revision)throw new Error('Gjenåpning krever gjeldende visibilityRevision.');
    if (!calendarId || !googleEventId) throw new Error("Kalender-ID og hendelses-ID kreves.");
    const owner=currentEvents().find(other=>other.id!==event.id && !other.calendar?.removedAt && other.calendar?.calendarId===calendarId && other.calendar?.eventId===googleEventId);
    if(owner)throw Error(`Google-hendelsen tilhører allerede ${owner.id} (${owner.canonicalKey}). Avstem med merge-events; ikke lag en ny kalenderkopi.`);
    if(event.calendar?.removedAt)event.calendarHistory=[...(event.calendarHistory??[]),structuredClone(event.calendar)];
    event.calendar = { calendarId, eventId: googleEventId, eventUrl: cleanUrl(eventUrl), fingerprint: fingerprint ?? event.fingerprint, syncedAt: now() };
    if(event.visibility)event.visibility.sync={status:'done',syncedAt:now()};
    save();
    return event;
  }

  function updateProfile(input) {
    if (!input || !Array.isArray(input.members) || !Array.isArray(input.facts)) throw new Error("Ugyldig familieprofil.");
    // Preserve facts learned since an older browser snapshot was loaded.
    const incoming = normalizeProfile(structuredClone(input));
    state.profile = { ...incoming, facts: [...state.profile.facts, ...incoming.facts.filter((fact) => !state.profile.facts.some((old) => old.id === fact.id))] };
    save();
    return state.profile;
  }

  function editProfile(input) {
    if (input.action === "saveDetails") {
      const target = input.memberId === "family" ? state.profile : state.profile.members.find(m => m.id === input.memberId);
      if (!target) throw new Error("Ukjent profil.");
      const field = input.memberId === "family" ? "familyName" : "name";
      if (input.expectedName !== target[field] || (input.memberId !== "family" && input.expectedSchoolClass !== (target.schoolClass ?? ""))) throw new Error("Profilen er endret. Lukk og åpne redigeringen igjen.");
      const name = words(input.name, 100).trim();
      if (!name) throw new Error("Navn må fylles ut.");
      target[field] = name;
      if (input.memberId !== "family") { target.schoolClass = words(input.schoolClass, 100).trim(); target.aliases = [...new Set([...(target.aliases ?? []), name])]; }
    } else {
      const previous = input.id ? state.profile.facts.find(f => f.id === input.id) : null;
      if (input.id && (!previous || previous.status === "superseded" || previous.text !== input.expectedText)) throw new Error("Opplysningen er endret. Lukk og åpne redigeringen igjen.");
      if (input.action === "removeFact") {
        if (!previous) throw new Error("Ukjent opplysning.");
        previous.status = "superseded"; previous.familyRemovedAt = now();
      } else if (input.action === "saveFact") {
        const fact = { memberId:previous?.memberId ?? input.memberId, key:previous?.key ?? `manual:${randomUUID()}`, text:input.text, category:input.category, source:"manual", confidence:"confirmed", correctsPrevious:true, validFrom:previous?.validFrom, validTo:input.validTo || null };
        validateFact(state.profile, fact, null);
        if (previous && !fact.validTo) previous.validTo = null;
        learnFact(state.profile, fact, null);
      } else throw new Error("Ukjent profilhandling.");
    }
    save(); return profileView(state.profile);
  }

  function profileFact(input) {
    const raw = input.rawId ? state.rawItems[input.rawId] : null;
    if (input.rawId && !raw) throw new Error("Ukjent profilkilde.");
    const result = learnFact(state.profile, input, raw);
    save();
    return result;
  }

  function reviewProfile(rawId, input) {
    const raw = state.rawItems[rawId];
    if (!raw || !Array.isArray(input.facts) || !words(input.note, 1000)) throw new Error("Profilvurdering krever råelement, facts og note.");
    for (const fact of input.facts) validateFact(state.profile, fact, raw);
    const facts = input.facts.map((fact) => learnFact(state.profile, fact, raw));
    raw.profileReviewedRevision = raw.revision;
    raw.profileReviewNote = words(input.note, 1000);
    raw.profileReviewedAt = now();
    save();
    return { rawId, revision: raw.revision, facts };
  }

  function completionReport() {
    const leaseStartedAt = state.runLease?.startedAt;
    const pendingItems = reviewQueue().items;
    const incompleteSurfaces = Object.values(state.surfaces)
      .filter((surface) => !retiredSurface(surface))
      .filter((surface) => (surface.health !== "ok" || surface.nextPageHint) && !historicalOnly(surface))
      .map((surface) => ({ source: surface.source, surface: surface.surface, health: surface.health, nextPageHint: surface.nextPageHint }));
    const incompleteSources = [...SOURCES].filter((source) => {
      const status = state.sourceStatus[source];
      const onlyHistorical = status?.health === "partial" && status.historicalOnly === true &&
        Object.values(state.surfaces).some(s=>s.source===source && historicalOnly(s)) &&
        !incompleteSurfaces.some(s=>s.source===source);
      return !status || (status.health !== "ok" && !onlyHistorical) || Date.now() - Date.parse(status.checkedAt) > (source === 'renovasjon' ? 36 : 12) * 60 * 60 * 1000 || (source !== 'renovasjon' && leaseStartedAt && status.checkedAt < leaseStartedAt);
    }).map((source) => ({ source, health: state.sourceStatus[source]?.health ?? "missing" }));
    const allMissingDrive = Object.values(state.rawItems).filter(raw=>!raw.discardedAt).flatMap((raw) => [
      ...(!raw.driveUrl || raw.driveRevision !== raw.revision ? [{ rawId: raw.id, title: raw.title, kind: "raw-card" }] : []),
      ...raw.attachments.filter((attachment) => !attachment.driveUrl && !attachment.contentError)
        .map((attachment) => ({ rawId: raw.id, title: raw.title, kind: "attachment", attachmentId: attachment.id, fileName: attachment.fileName })),
      ...(raw.expectedOriginals ?? []).filter((name) => !raw.attachments.some((attachment) => !attachment.contentError && fileLabel(attachment.fileName) === fileLabel(name)))
        .map((fileName) => ({ rawId:raw.id, title:raw.title, kind:"source-original", fileName }))
    ]);
    const missingDrive = allMissingDrive.filter(item=>rawIsActive(state.rawItems[item.rawId]));
    const historicalMissingDrive = allMissingDrive.filter(item=>!rawIsActive(state.rawItems[item.rawId]));
    const unsyncedCalendar = currentEvents()
      .filter((event) => event.visibility?.sync?.status==='pending' || (!event.visibility?.hidden && (!event.cancelled || event.calendar) && (!event.calendar || event.calendar.removedAt || event.calendar.fingerprint !== event.fingerprint)))
      .map((event) => ({ eventId: event.id, title: event.title }));
    const vigiloIssues = vigiloCoverage().filter((entry) => entry.issues.length);
    const profileReviews = Object.values(state.rawItems).filter((raw) => !raw.discardedAt && rawIsActive(raw) && raw.profileReviewedRevision !== raw.revision).map((raw) => ({ rawId: raw.id, title: raw.title, revision: raw.revision }));
    const phonePending=Object.values(state.phone?.inbox??{}).filter(item=>['queued','processing','blocked'].includes(item.status)).map(item=>({id:item.id,rawId:item.rawId,title:item.title,status:item.status,note:item.note}));
    return {
      complete: !phonePending.length && !pendingItems.length && !incompleteSurfaces.length && !incompleteSources.length && !missingDrive.length && !unsyncedCalendar.length && !vigiloIssues.length && !profileReviews.length,
      counts: { phonePending:phonePending.length,pendingItems: pendingItems.length, incompleteSurfaces: incompleteSurfaces.length, incompleteSources: incompleteSources.length, missingDrive: missingDrive.length, unsyncedCalendar: unsyncedCalendar.length, vigiloIssues: vigiloIssues.length, profileReviews: profileReviews.length },
      phonePending,pendingItems, incompleteSurfaces, incompleteSources, missingDrive, unsyncedCalendar, vigiloIssues, profileReviews,
      cutoffAt:new Date(cutoffAt()).toISOString(), historyDays:state.reviewPolicy.historyDays,
      historicalMissingDrive, historicalSurfaces:Object.values(state.surfaces).filter(historicalOnly),
      historicalItems:Object.values(state.reviewLedger).filter(entry=>outsideWindow(entry))
    };
  }

  function changeCompletion() {
    const report=completionReport(),feed=activityFeedStatus();
    const pendingActivities=Object.values(state.activities).filter(item=>!item.mergedInto && item.plan?.status==='pending');
    const counts=Object.fromEntries(['pendingItems','missingDrive','unsyncedCalendar','profileReviews'].map(key=>[key,report[key].length]));
    counts.facebookActivities=activityFacebook().length;counts.activityCandidates=feed.hsia?.candidates??0;counts.activityPages=feed.changedPages?.length??0;counts.activityPlans=pendingActivities.length;
    return {scope:'kildeendringer',complete:Object.values(counts).every(n=>n===0),counts,note:'Gjelder endringsarbeid og publisering, ikke full kildekontroll.'};
  }

  function recordRun(input) {
    if (input.outcome === "skipped") {
      const run = { id: randomUUID(), startedAt: input.startedAt ?? now(), finishedAt: now(), outcome: "skipped", summary: words(input.summary, 3000), sources: [], completion: null };
      archiveRun(run); state.runs.unshift(run); state.runs = state.runs.slice(0, 100); save(); return run;
    }
    if (input.outcome === "ok") {
      const report = completionReport();
      if (input.scope==='handel' ? shopping.queue().length || shopping.view().reviews.some(r=>r.status==='blocked') : input.scope==='kildeendringer' ? !changeCompletion().complete : ['telefon','familiehandlinger'].includes(input.scope) ? report.phonePending.length || calendarActions().length : !report.complete) throw new Error(`Kjøringen kan ikke rapporteres ok med restanser: ${JSON.stringify(report.counts)}.`);
    } else if (["partial", "needs_login", "error"].includes(input.outcome)) {
      if (!Array.isArray(input.blockers) || !input.blockers.length || !input.blockers.every((blocker) => words(blocker, 500).length >= 12)) {
        throw new Error("Ufullstendig kjøring krever konkrete blockers. Arbeidsmengde eller planlagt sluttid er ikke en blokkering.");
      }
      if (!words(input.resumeHint, 1000)) throw new Error("Ufullstendig kjøring krever resumeHint for neste fortsettelse.");
    } else {
      throw new Error("Ugyldig kjøringsutfall.");
    }
    if (input.scope && !['alle','telefon','familiehandlinger','kildeendringer','handel'].includes(input.scope)) throw new Error('Ugyldig kjøringsomfang.');
    // An agent's report timestamp must not override the observed lease start.
    // After release we have no observed start; do not invent a zero duration or
    // associate the report with another agent's previous lease.
    const startedAt = validDate(state.runLease?.startedAt ?? input.startedAt ?? null, "startedAt", true);
    const finishedAt = now();
    const run = { id: randomUUID(), startedAt, finishedAt, durationMs: startedAt ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null, scope: input.scope ?? "alle", outcome: input.outcome, summary: words(input.summary ?? input.details, 3000), sources: input.sources ?? [], blockers: input.blockers ?? [], resumeHint: words(input.resumeHint, 1000) || null, completion: completionReport().counts };
    archiveRun(run);
    state.runs.unshift(run);
    state.runs = state.runs.slice(0, 100);
    reconcileSourceReviews(state.sourceStatus,[run]);
    save();
    return run;
  }

  function resolveExternalId(source,value,surface=null) {
    const id=words(value,500),identity=sourceIdentity(source,id);
    const alias=(surface&&state.collector?.aliases?.[`${surface}|${identity}`])||state.collector?.aliases?.[identity];
    if(alias)return alias;
    const raw=Object.values(state.rawItems).find(r=>r.source===source&&sourceIdentity(source,r.externalId)===identity);
    if(raw)return raw.externalId;
    const entry=Object.values(state.reviewLedger).find(r=>r.source===source&&sourceIdentity(source,r.externalId)===identity);
    return entry?.externalId??identity;
  }

  function sourceItems(input) {
    if(!SOURCES.has(input.source)||!Array.isArray(input.externalIds)||input.externalIds.length>500)throw Error('Kilde og opptil 500 kilde-ID-er kreves.');
    return input.externalIds.map(value=>{
      const externalId=resolveExternalId(input.source,value),identity=sourceIdentity(input.source,externalId);
      const raws=Object.values(state.rawItems).filter(r=>r.source===input.source&&sourceIdentity(input.source,r.externalId)===identity);
      const reviews=Object.values(state.reviewLedger).filter(r=>r.source===input.source&&sourceIdentity(input.source,r.externalId)===identity);
      return {requestedId:value,externalId,known:!!(raws.length||reviews.length),duplicateRawIds:raws.length>1?raws.map(r=>r.id):[],raws:raws.map(r=>({id:r.id,title:r.title,revision:r.revision,driveRevision:r.driveRevision,profileReviewedRevision:r.profileReviewedRevision,attachments:r.attachments.map(a=>({id:a.id,fileName:a.fileName,sha256:a.sha256,driveUrl:a.driveUrl,needsReading:!state.documentReviews?.[a.sha256]}))})),reviews:reviews.map(r=>({surface:r.surface,title:r.title,summary:r.summary,sourceExcerpt:r.sourceExcerpt,sourceUrl:r.sourceUrl,publishedAt:r.publishedAt,updatedAt:r.updatedAt,attachmentHint:r.attachmentHint,changeToken:r.changeToken,changeTracking:r.changeTracking,reviewPolicy:effectiveReviewPolicy(r),reviewedAt:r.reviewedAt,rawId:r.rawId,reason:reviewDecision(r)}))};
    });
  }

  function effectiveReviewPolicy(entry) {
    if (["once", "before-start", "watch"].includes(entry.reviewPolicy)) return entry.reviewPolicy;
    if (entry.source === "spond") {
      if (/(?:^|:)(?:polls?|payments?)(?:$|:)/i.test(`${entry.surface}:${entry.externalId}`)) return "watch";
      if (/(?:^|:)(?:events?)(?:$|:)/i.test(`${entry.surface}:${entry.externalId}`)) return "before-start";
    }
    return entry.reviewPolicy === "watch" || entry.reviewPolicy === "before-start" ? entry.reviewPolicy : "once";
  }

  function reviewDecision(entry, at = Date.now()) {
    if (outsideWindow(entry,at)) return "outside-window";
    if (!entry.reviewedAt) return "new";
    if (entry.reviewedListingHash !== entry.listingHash) return "changed";
    if (entry.relevance === "irrelevant") return "unchanged";
    if (entry.lastSeenAt && entry.reviewedAt >= entry.lastSeenAt) return "unchanged";
    const policy = effectiveReviewPolicy(entry);
    if (policy === "once") return "unchanged";
    // A reliable version signal handles changes without a timed detail read.
    if (entry.changeTracking === "reliable") return "unchanged";
    const horizon = 72 * 60 * 60 * 1000;
    const upcoming = currentEvents().some(event => {
      if (!event.sourceRefs?.includes(entry.rawId) || event.visibility?.hidden || event.cancelled) return false;
      if (event.kind === "task" && event.task?.items?.length && event.task.items.every(item => item.doneAt)) return false;
      const starts = Date.parse(event.kind === "task" ? event.task?.dueDate : event.start);
      return starts >= at && starts <= at + horizon && Date.parse(entry.reviewedAt) < starts - horizon;
    });
    if (upcoming) return "upcoming-check";
    if (policy === "watch" && at - Date.parse(entry.reviewedAt) >= 7 * 24 * 60 * 60 * 1000) return "periodic-check";
    return "unchanged";
  }

  function observeListing(input, opts = {}) {
    input = {...input,surface:canonicalSurface(input.source,input.surface)};
    if (!SOURCES.has(input.source) || !words(input.surface, 300) || !Array.isArray(input.items) || input.items.length > 500) throw new Error("Ugyldig kildeoversikt.");
    const observedAt = now();
    const decisions = [];
    for (const item of input.items) {
      const externalId = resolveExternalId(input.source,item.externalId,input.surface);
      if (!externalId) throw new Error("Kildeoversikt mangler externalId.");
      if(item.sourceExcerpt!==undefined&&typeof item.sourceExcerpt!=='string')throw Error('sourceExcerpt må være ordrett kildetekst.');
      if(item.sourceExcerpt?.length>20000)throw Error('Listeutdrag er for stort; bruk et kort stabilt ordrett utdrag.');
      if (item.reviewPolicy !== undefined && !["once", "before-start", "watch"].includes(item.reviewPolicy)) throw Error("Ugyldig reviewPolicy.");
      const id = reviewKey(input.source, input.surface, externalId);
      const previous = state.reviewLedger[id];
      if (previous?.managedBy === 'collector' && !opts.collector) {
        // API-observasjonen eier tittel, utdrag og endringstoken. Agentens skjermlesing overskriver dem ikke.
        previous.lastSeenAt = observedAt;
        const reason = reviewDecision(previous);
        decisions.push({ id, externalId, title: previous.title, reason, needsReview: !["unchanged","outside-window"].includes(reason), rawId: previous.rawId });
        continue;
      }
      const entry = {
        id, source: input.source, surface: words(input.surface, 300), externalId,
        title: words(item.title, 500), summary: words(item.summary, 1500),
        sourceExcerpt:item.sourceExcerpt??null,
        sourceUrl: cleanUrl(item.sourceUrl),
        publishedAt: validDate(item.publishedAt, "publishedAt", true),
        updatedAt: validDate(item.updatedAt, "updatedAt", true),
        attachmentHint: words(item.attachmentHint, 500),
        changeTracking: item.changeTracking === "reliable" && words(item.changeToken, 500) ? "reliable" : "unknown",
        changeToken: words(item.changeToken, 500),
        reviewPolicy: item.reviewPolicy ?? previous?.reviewPolicy ?? null,
        firstSeenAt: previous?.firstSeenAt ?? observedAt,
        lastSeenAt: observedAt,
        reviewedAt: previous?.reviewedAt ?? null,
        reviewedListingHash: previous?.reviewedListingHash ?? null,
        rawId: previous?.rawId ?? null,
        relevance: previous?.relevance ?? null,
        reviewNote: previous?.reviewNote ?? null
      };
      entry.listingHash = hash(JSON.stringify([entry.title, entry.sourceExcerpt??entry.summary, entry.sourceUrl, entry.publishedAt, entry.updatedAt, entry.attachmentHint]));
      if (entry.changeToken) entry.listingHash = hash(`${entry.listingHash}\0${entry.changeToken}`);
      entry.retainUntil = validDate(item.retainUntil,"retainUntil",true) ?? previous?.retainUntil ?? null;
      if (opts.collector) {
        entry.managedBy = 'collector';
        // A previously read original can prove that only serialization changed.
        // Callers must compare the full normalized body, not a title/summary.
        if (previous?.reviewedAt && opts.unchangedReviewedIds?.has(externalId)) {
          entry.reviewedListingHash = entry.listingHash;
          entry.baselinedAt = observedAt;
        }
        // Første API-observasjon av et element agenten allerede har lest: godta som utgangspunkt hvis kilden ikke viser aktivitet etter gjennomgangen.
        if (previous?.reviewedAt && previous.managedBy !== 'collector' && entry.reviewedListingHash !== entry.listingHash) {
          const activity = item.latestActivityAt ? Date.parse(item.latestActivityAt) : 0;
          if (!(activity > Date.parse(previous.reviewedAt))) { entry.reviewedListingHash = entry.listingHash; entry.baselinedAt = observedAt; }
        }
      }
      state.reviewLedger[id] = entry;
      const reason = reviewDecision(entry);
      decisions.push({ id, externalId, title: entry.title, reason, needsReview: !["unchanged","outside-window"].includes(reason), rawId: entry.rawId });
    }
    const surfaceKey = `${input.source}:${words(input.surface, 300)}`;
    const surface = state.surfaces[surfaceKey];
    if (opts.collector) {
      const pending = decisions.some((decision) => decision.needsReview);
      const resumeCurrentCoverage = pending && surface?.health === 'partial' && surface.currentComplete === true && surface.historicalGap && !surface.blocker && !surface.nextPageHint
        ? {resumeCurrentCoverage:{scanTo:surface.scanTo}} : {};
      state.surfaces[surfaceKey] = { ...(surface ?? { source: input.source, surface: words(input.surface, 300), health: "partial" }), listingObservedAt: observedAt, health: pending && surface?.health === "ok" ? "partial" : surface?.health ?? "partial", ...resumeCurrentCoverage, ...(pending ? { currentComplete:false, ...(surface?.health === 'ok' ? { resumeOnReview:true } : {}) } : {}) };
      save();
      return { source: input.source, surface: input.surface, observedAt, decisions };
    }
    if (surface) delete surface.resumeCurrentCoverage;
    state.surfaces[surfaceKey] = {
      ...(surface ?? { source: input.source, surface: words(input.surface, 300), health: "partial" }),
      listingObservedAt: observedAt,
      health: surface?.health === "ok" ? "partial" : surface?.health ?? "partial",
      currentComplete:false
    };
    save();
    return { source: input.source, surface: input.surface, observedAt, decisions };
  }

  function markReviewed(input) {
    input={...input,externalId:resolveExternalId(input.source,input.externalId)};
    if (input.surface) input = {...input,surface:canonicalSurface(input.source,input.surface)};
    if (!SOURCES.has(input.source) || !words(input.externalId, 500)) throw new Error("Ugyldig kilde-ID.");
    const matches = Object.values(state.reviewLedger).filter((entry) => entry.source === input.source && entry.externalId === input.externalId && (!input.surface || entry.surface === input.surface));
    if (!matches.length) throw new Error("Observer elementet i kildeoversikten først.");
    if (matches.length > 1) throw new Error("Kildeelementet finnes for flere barn/overflater; angi surface i mark-reviewed.");
    const entry = matches[0];
    if (input.rawId && (state.rawItems[input.rawId]?.source !== input.source || state.rawItems[input.rawId]?.externalId !== input.externalId)) throw new Error("Råelementet matcher ikke kilde-ID.");
    if (!input.rawId && (input.relevance !== "irrelevant" || !words(input.reviewNote, 1000))) throw new Error("Irrelevant element krever begrunnelse.");
    entry.reviewedAt = now();
    entry.reviewedListingHash = entry.listingHash;
    entry.rawId = input.rawId ?? entry.rawId;
    entry.relevance = input.relevance === "irrelevant" ? "irrelevant" : "relevant";
    entry.reviewNote = words(input.reviewNote, 1000) || null;
    const surface = state.surfaces[`${entry.source}:${entry.surface}`];
    if (surface?.resumeCurrentCoverage && surface.health === 'partial' && surface.historicalGap &&
        surface.scanTo === surface.resumeCurrentCoverage.scanTo && !surface.blocker && !surface.nextPageHint &&
        !pendingOn(entry.source,entry.surface).length) {
      surface.currentComplete = true;
      delete surface.resumeCurrentCoverage;
      // Retain the actual full scan's date/range and historical gap. A detail
      // receipt does not establish a new full scan or bypass freshness checks.
    }
    save();
    return entry;
  }

  function updateSurface(input) {
    input = {...input,surface:canonicalSurface(input.source,input.surface)};
    if (!SOURCES.has(input.source) || !words(input.surface, 300) || !new Set(["ok", "partial", "needs_login", "error"]).has(input.health)) throw new Error("Ugyldig dekningsstatus.");
    const key = `${input.source}:${words(input.surface, 300)}`;
    const previous = state.surfaces[key];
    if (input.source === "vigilo" && input.health === "ok") {
      const [member,section]=input.surface.split(':');
      const supplemental=state.collector.supplemental??{};
      const observed=section==='consents' && supplemental[`vigilo:consent-counts:${member}:`]?.counts?.every(row=>row.consentFormsTotalCount===0)
        ? supplemental[`vigilo:consent-counts:${member}:`]
        : supplemental[`vigilo:${section}:${member==='family'?'all':member}:`];
      const emptySupplemental=observed?.health==='ok' && observed.complete===true &&
        (section==='consents'?observed.counts?.every(row=>row.consentFormsTotalCount===0):observed.count===0) &&
        Date.now()-Date.parse(observed.at)<2*3600000;
      if (!input.complete || ((!previous?.listingObservedAt || (state.runLease && previous.listingObservedAt < state.runLease.startedAt)) && !emptySupplemental && !recentVigiloListing(input.surface))) {
        throw new Error("Vigilo-overflate kan bare merkes ferdig etter at listen og alle detaljer/vedlegg er gjennomgått i denne kjøringen.");
      }
      const pending = Object.values(state.reviewLedger).filter((entry) => entry.source === "vigilo" && entry.surface === input.surface && !["unchanged","outside-window"].includes(reviewDecision(entry)));
      if (pending.length) throw new Error(`Vigilo-overflate har ${pending.length} elementer som fortsatt må gjennomgås.`);
    }
    const status = {
      source: input.source, surface: words(input.surface, 300), health: input.health,
      checkedAt: now(),
      backfillFrom: validDate(input.backfillFrom, "backfillFrom", true) ?? previous?.backfillFrom ?? null,
      oldestCoveredAt: validDate(input.oldestCoveredAt, "oldestCoveredAt", true) ?? previous?.oldestCoveredAt ?? null,
      newestCoveredAt: validDate(input.newestCoveredAt, "newestCoveredAt", true) ?? previous?.newestCoveredAt ?? null,
      lastCompleteScanAt: input.complete ? now() : previous?.lastCompleteScanAt ?? null,
      listingObservedAt: previous?.listingObservedAt ?? null,
      nextPageHint: words(input.nextPageHint, 1000) || null,
      seenCount: Number.isInteger(input.seenCount) && input.seenCount >= 0 ? input.seenCount : null,
      details: words(input.details, 2000)
    };
    // Historical checkpoints survive ordinary incremental scans.
    status.backfillComplete = input.backfillComplete ?? previous?.backfillComplete ?? false;
    status.scanFrom = validDate(input.scanFrom, "scanFrom", true) ?? previous?.scanFrom ?? null;
    status.scanTo = validDate(input.scanTo, "scanTo", true) ?? previous?.scanTo ?? null;
    status.blocker = words(input.blocker, 1000) || null;
    status.retryAfter = validDate(input.retryAfter, "retryAfter", true);
    status.historicalGap = previous?.historicalGap ?? null;
    status.currentComplete = input.currentComplete ?? input.complete ?? false;
    if (input.historicalGap) {
      const from = validDate(input.historicalGap.from,"historicalGap.from");
      const to = validDate(input.historicalGap.to,"historicalGap.to");
      if (Date.parse(to) < Date.parse(from) || !words(input.historicalGap.reason,1000)) throw new Error("Historisk hull krever periode og begrunnelse.");
      status.historicalGap = {from,to,reason:words(input.historicalGap.reason,1000)};
    }
    state.surfaces[key] = status;
    save();
    return status;
  }

  function reviewQueue() {
    return {
      surfaces: Object.fromEntries(Object.entries(state.surfaces).filter(([,surface])=>!retiredSurface(surface))),
      vigiloCoverage: vigiloCoverage(),
      items: Object.values(state.reviewLedger).map((entry) => {
        const reason = reviewDecision(entry);
        return { source: entry.source, surface: entry.surface, externalId: entry.externalId, title: entry.title, listingHash: entry.listingHash, reason, reviewPolicy:effectiveReviewPolicy(entry), needsReview: !["unchanged","outside-window"].includes(reason), rawId: entry.rawId, lastSeenAt: entry.lastSeenAt, reviewedAt: entry.reviewedAt };
      }).filter((entry) => entry.needsReview && !retiredSurface(entry) && !state.rawItems[entry.rawId]?.discardedAt)
    };
  }

  // ---- API-samler: Chrome-utvidelsen sender kompakte utdrag av det Vigilo og Spond selv har hentet ----
  const NATIVE_VIGILO = /^vigilo:(news|message):[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
  const COLLECTOR_HEALTH = new Set(['ok', 'unauthorized', 'error', 'needs_template', 'paused', 'stalled']);
  const collectorMember = (child) => {
    const full = child.firstName.toLowerCase().trim();
    // Vigilo kan ha mellomnavn i fornavnet («Barn To»): prøv hele navnet, så første ord.
    for (const candidate of [full, full.split(/\s+/)[0]]) {
      const member = state.profile.members.find((m) => m.id === candidate || m.name?.toLowerCase() === candidate || (m.aliases ?? []).some((alias) => alias.toLowerCase() === candidate));
      if (member) return member.id;
    }
    const prefixed=state.profile.members.filter(m=>[m.name,...(m.aliases??[])].some(n=>full.startsWith(n.toLowerCase()+' ')));
    if(prefixed.length===1)return prefixed[0].id;
    return full.split(/\s+/)[0].normalize('NFKD').replace(/[^a-z]/g, '');
  };
  const ledgerFor = (source, externalId) => Object.values(state.reviewLedger).filter((entry) => entry.source === source && entry.externalId === externalId);
  const pendingOn = (source, surface) => Object.values(state.reviewLedger).filter((entry) => entry.source === source && entry.surface === surface && !['unchanged', 'outside-window'].includes(reviewDecision(entry)));

  function adoptLegacyId(item, surface) {
    if (item.source !== 'vigilo') return;
    const identity = sourceIdentity('vigilo', item.externalId);
    const collector = state.collector;
    if (collector.aliases[identity] || collector.aliases[surface + '|' + identity] || ledgerFor('vigilo', item.externalId).some((entry) => entry.surface === surface)) return;
    const day = isoDay(item.postedAt);
    if (!day) return;
    const title = normalizeTitle(item.title);
    const legacy = Object.values(state.reviewLedger).filter((entry) => entry.source === 'vigilo' && entry.surface === surface && entry.managedBy !== 'collector' && !NATIVE_VIGILO.test(entry.externalId) && normalizeTitle(entry.title) === title && entry.publishedAt && Math.abs(Date.parse(isoDay(entry.publishedAt)) - Date.parse(day)) <= 86400000);
    const ids = uniq(legacy.map((entry) => entry.externalId));
    // Bare et entydig treff (samme overflate, tittel og dato) får alias; ellers vurderes elementet på nytt av agenten.
    if (ids.length === 1) collector.aliases[surface + '|' + identity] = ids[0];
  }

  function spondSurface(item) {
    const existing = ledgerFor('spond', resolveExternalId('spond', item.externalId));
    if (existing.length) return existing.sort((a, b) => String(b.reviewedAt ?? '').localeCompare(String(a.reviewedAt ?? '')))[0].surface;
    const section = item.kind === 'post' ? 'posts' : 'events';
    if (!item.groupId) return 'collector:' + section;
    return 'group-' + item.groupId + (item.subGroupIds?.length === 1 ? '-S-' + item.subGroupIds[0] : '') + ':' + section;
  }

  const listingOf = (item, sourceUrl) => ({
    externalId: item.externalId, title: item.title || item.externalId, summary: item.text.slice(0, 300), sourceExcerpt: item.text.slice(0, 300),
    sourceUrl, publishedAt: item.postedAt, updatedAt: item.updatedAt,
    attachmentHint: item.attachments.map((file) => file.name).filter(Boolean).join('; '),
    changeTracking: item.source === 'vigilo' && item.kind === 'news' ? 'reliable' : 'unknown', changeToken: item.token, latestActivityAt: item.latestActivityAt ?? null,
    retainUntil: item.retainUntil ?? (item.kind === 'event' ? item.endAt ?? item.startAt : undefined)
  });

  function storeCollected(item, surface) {
    const items = state.collector.items;
    const previous = items[item.externalId];
    items[item.externalId] = { ...(previous?.detail ? { detail: previous.detail } : {}), ...item, surfaces: uniq([...(previous?.surfaces ?? []), surface]), firstSeenAt: previous?.firstSeenAt ?? now(), lastSeenAt: now() };
  }

  function finalizeSurface(source, surface, complete, healthBefore) {
    const key = source + ':' + surface;
    const status = state.surfaces[key];
    if (!complete || !status || status.nextPageHint || status.blocker || pendingOn(source, surface).length) return false;
    // Spond: agenten eier ok-statusen (vedlegg, avstemninger); samleren beholder den bare.
    if (source === 'spond' && healthBefore !== 'ok' && status.resumeOnReview !== true) return false;
    try { updateSurface({ source, surface, health: 'ok', complete: true, scanTo: now(), details: 'Automatisk: API-observasjon uten nye eller endrede elementer.' }); return true; }
    catch { return false; }
  }

  function finalizeVigiloSource() {
    if (vigiloMemberIds().some((child) => VIGILO_SECTIONS.some((section) => state.surfaces['vigilo:' + child + ':' + section]?.health !== 'ok'))) return;
    if (vigiloCoverage().some((entry) => entry.issues.length)) return;
    if(Object.values(state.surfaces).some(s=>s.source==='vigilo'&&!retiredSurface(s)&&s.health!=='ok'))return;
    try { updateSource({ source: 'vigilo', health: 'ok', scope: 'Siste nytt og Meldinger for Barn En, Barn To, Barn Tre og Barn Fire via API-observasjon; aktivt 30-dagersvindu', details: 'Automatisk: alle åtte flater observert komplett uten nye eller endrede elementer.' }); } catch { /* agenten tar det ved behov */ }
  }

  function observeCollected(source, surface, sourceUrl, normalized, { complete, adopt = false, unchangedReviewedIds }) {
    const healthBefore = state.surfaces[source + ':' + surface]?.health;
    if (adopt) for (const item of normalized) adoptLegacyId(item, surface);
    const result = observeListing({ source, surface, items: normalized.map((item) => listingOf(item, sourceUrl)) }, { collector: true, unchangedReviewedIds });
    for (const item of normalized) storeCollected(item, surface);
    const finalized = finalizeSurface(source, surface, complete, healthBefore);
    return { surface, count: normalized.length, needsReview: result.decisions.filter((decision) => decision.needsReview).length, finalized };
  }

  // Feil i behandlingen huskes slik at de kan leses i collector-status (utvidelsen ser bare «server_error»).
  function collectorIngest(input) {
    try {
      const result = collectorIngestUnsafe(input);
      if (state.collector.lastError?.source === input.source) state.collector.lastError = null;
      return result;
    } catch (error) {
      state.collector.lastError = { at: now(), source: input?.source ?? null, kind: input?.kind ?? null, message: words(error.message, 300), items: Array.isArray(input?.items) ? input.items.length : input?.items?.items?.length ?? null };
      throw error;
    }
  }

  function collectorIngestUnsafe(input) {
    const collector = state.collector;
    const at = now();
    if (!['vigilo', 'spond', 'facebook'].includes(input?.source)) throw new Error('Ukjent samlerkilde.');
    if (input.kind === 'heartbeat') {
      // Counter checks demonstrate liveness, never new list/detail coverage.
      collector.probes ??= {};
      collector.probes[input.source] = { at, lastFullAt: input.lastFullAt ?? null };
      save(); return { ok: true };
    }
    if (['supplemental','supplemental-error'].includes(input.kind)) {
      const sections=new Set(['discovery','required-actions','meetings','registrations','consent-counts','consents','polls','payments','files']);
      if(!sections.has(input.section))throw Error('Ukjent tilleggsflate.');
      const member=collector.children[String(input.childId ?? '').toLowerCase()]?.memberId;
      if(input.childId&&!member)throw Error('Ukjent barn på tilleggsflate.');
      collector.supplemental ??= {};
      const key=[input.source,input.section,member ?? input.groupId ?? 'all',input.unitId ?? input.folderId ?? ''].join(':');
      if(input.kind==='supplemental-error'){
        collector.supplemental[key]={at,health:'error',detail:words(input.detail,300),implementation:words(input.implementation,100)||null};
        const surface=input.source==='vigilo'?`${member??'family'}:${input.section}`:`group-${input.groupId??'all'}:${input.section}`;
        updateSurface({source:input.source,surface,health:'partial',complete:false,blocker:words(input.detail,300),details:'API-innhenting feilet. Kontroller flaten i nettleseren eller ved neste API-forsøk.'});
        state.surfaces[`${input.source}:${surface}`].collectorFailure = true;
        save();return {ok:true};
      }
      if(!Array.isArray(input.items))throw Error('Liste mangler på tilleggsflate.');
      collector.supplemental[key]={at,health:input.complete?'ok':'partial',count:input.items.length,complete:input.complete===true,implementation:words(input.implementation,100)||null};
      // collector-extra reads /groups successfully before it creates the poll /
      // payment queue. Its complete response carries that exact group inventory.
      // Previously a failed /groups call was reported, but this later successful
      // discovery had no receipt, leaving a permanent, false partial surface.
      // This closes only inventory discovery, never unread posts or originals.
      if(input.source==='spond' && ['polls','payments'].includes(input.section) && input.complete===true &&
          Array.isArray(input.groupIds) && input.groupIds.every(id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,120}$/.test(id))) {
        const discoveryKey='spond:discovery:all:',prior=collector.supplemental[discoveryKey];
        collector.supplemental[discoveryKey]={at,health:'ok',complete:true,count:input.groupIds.length,groupIds:uniq(input.groupIds),
          ...(prior?.health==='error'?{recoveredFrom:{at:prior.at,detail:prior.detail}}:prior?.recoveredFrom?{recoveredFrom:prior.recoveredFrom}:{})};
        updateSurface({source:'spond',surface:'group-all:discovery',health:'ok',complete:true,seenCount:input.groupIds.length,
          scanFrom:at,scanTo:at,details:'Gruppelisten er hentet før den komplette tilleggslisten; dette kvitterer bare gruppeoversikten, ikke gruppenes innhold eller vedlegg.'});
      }
      // Old clients omitted folderId on root errors. A successful root listing
      // resolves that exact diagnostic; child-folder failures remain active.
      if (input.section === 'files' && input.complete === true && input.folderId === input.groupId) {
        const legacy = collector.supplemental[[input.source,'files',input.groupId,''].join(':')];
        if (legacy?.health === 'error') { legacy.resolvedAt = at; legacy.resolvedBy = key; }
      }
      if(input.signal){collector.supplemental[key].counts=input.items;save();return {ok:true,signal:true};}
      const normalized=normalizeSupplemental(input);
      const unchangedReviewedIds = new Set();
      for (const item of normalized) {
        const id = resolveExternalId(input.source,item.externalId);
        const entries = ledgerFor(input.source,id);
        for (const entry of entries) {
          const raw = state.rawItems[entry.rawId];
          if (!entry.reviewedAt || !raw || raw.profileReviewedRevision !== raw.revision || entry.reviewedAt < raw.observedAt) continue;
          try {
            const prior = normalizeSupplemental({...input,items:[JSON.parse(raw.body)]})[0];
            if (prior?.token === item.token && sourceIdentity(input.source,prior.externalId) === sourceIdentity(input.source,item.externalId)) unchangedReviewedIds.add(id);
          } catch { /* A prose summary cannot prove an unchanged full API body. */ }
        }
      }
      const bySurface=new Map();
      for(const item of normalized){
        const child=member ?? collector.children[item.childIds?.[0]]?.memberId;
        const surface=input.source==='vigilo'?`${child ?? 'family'}:${input.section}`:`group-${item.groupId ?? input.groupId ?? 'unknown'}:${input.section}`;
        (bySurface.get(surface)??bySurface.set(surface,[]).get(surface)).push(item);
      }
      // Empty results still leave observable coverage; they never assert detail reading.
      if(input.source==='spond'&&['polls','payments'].includes(input.section)&&Array.isArray(input.groupIds))for(const groupId of input.groupIds)if(!bySurface.has(`group-${groupId}:${input.section}`))bySurface.set(`group-${groupId}:${input.section}`,[]);
      if(!bySurface.size)bySurface.set(input.source==='vigilo'?`${member ?? 'family'}:${input.section}`:`group-${input.groupId ?? 'all'}:${input.section}`,[]);
      const results=[...bySurface].map(([surface,items])=>{
        const memberOrGroup = input.source === 'vigilo' ? surface.split(':')[0].replace(/^family$/,'all') : surface.split(':')[0].replace(/^group-/, '');
        const activeError = Object.entries(collector.supplemental).some(([id,status]) =>
          !status.resolvedAt && status.health !== 'ok' && id.startsWith(`${input.source}:${input.section}:${memberOrGroup}:`));
        const priorSurface = state.surfaces[`${input.source}:${surface}`];
        if (input.complete === true && !activeError && priorSurface?.collectorFailure) {
          priorSurface.blocker = null;
          if (priorSurface.lastCompleteScanAt) priorSurface.resumeOnReview = true;
          delete priorSurface.collectorFailure;
        }
        const result=observeCollected(input.source,surface,input.url,items,{complete:input.complete === true,unchangedReviewedIds});
        // A complete, empty Vigilo endpoint has no details or attachments for the
        // agent to read. Let the endpoint itself close this surface.
        if(input.complete===true&&!activeError&&items.length===0&&!pendingOn(input.source,surface).length){
          updateSurface({source:input.source,surface,health:'ok',complete:true,scanTo:at,details:'Automatisk: komplett tom API-liste.'});
          result.finalized=true;
        }
        return result;
      });
      if (input.source === 'vigilo') finalizeVigiloSource();
      save();return {ok:true,results};
    }
    if (input.kind === 'health') {
      if (!COLLECTOR_HEALTH.has(input.health)) throw new Error('Ugyldig samlerstatus.');
      collector.health[input.source] = { health: input.health, detail: words(input.detail, 200), at };
      if (input.source === 'vigilo' && input.health === 'ok') finalizeVigiloSource();
      save();
      return { ok: true };
    }
    const complete = input.complete === true;
    let results;
    if (input.source === 'facebook') {
      if (!['posts','events'].includes(input.kind)) throw new Error('Ukjent samlertype.');
      const groupId = String(input.groupId ?? '');
      let configured = [];
      try { configured = (readConfig('sources.json').facebookGroupUrls ?? []).map((url) => String(url).split('/').filter(Boolean).at(-1)); } catch { /* ingen konfigurasjon */ }
      // Bare konfigurerte grupper tas imot; alt annet på Facebook ignoreres uten feil.
      const activity=facebookTargets().find(target=>target.activitySourceId&&(target.id===groupId||target.groupId===groupId));
      if (!configured.includes(groupId)&&!activity) return { ok: true, ignored: 'ukjent gruppe' };
      const unchangedReviewedIds = new Set();
      const posts = input.kind==='posts'?normalizeFacebookPosts(input.items).filter(item=>{
        if(activity)return true;
        const urlGroup=item.url?.match(/^https:\/\/(?:www\.)?facebook\.com\/groups\/(\d+)(?:\/|$)/)?.[1];
        return item.groupId===groupId && (item.groupProof==='target_group'||urlGroup===groupId);
      }).map(item=>{
        const previous=collector.items[item.externalId];
        const merged=mergeFacebookPost(previous,item);
        if(previous && facebookPostToken(previous)===merged.token &&
          ledgerFor('facebook',item.externalId).some(entry=>entry.reviewedAt && entry.reviewedListingHash===entry.listingHash)) unchangedReviewedIds.add(item.externalId);
        return merged;
      }):normalizeFacebookEvents(input.items);
      if(activity){for(const item of posts)storeCollected({...item,activitySourceId:activity.activitySourceId},`activity:${activity.activitySourceId}`);results=[{activitySourceId:activity.activitySourceId,count:posts.length}];}
      else results = [observeCollected('facebook', 'group-' + groupId + ':'+input.kind, 'https://www.facebook.com/groups/' + groupId, posts, { complete: false, unchangedReviewedIds })];
      collector.sweeps['facebook:'+input.kind+':' + groupId] = { at, count: posts.length, complete: false };
    } else if (input.source === 'vigilo') {
      if (input.kind === 'children') {
        const children = normalizeChildren(input.items);
        for (const child of children) collector.children[child.id] = { firstName: child.firstName, lastName: child.lastName, memberId: collectorMember(child) };
        // This exact endpoint is also supplemental discovery's first request.
        // Record the successful inventory, rather than leaving a previous 401
        // permanently active. Never infer this from cached children/probes.
        if (Array.isArray(input.items) && children.length === input.items.length &&
            children.every(child => vigiloMemberIds().includes(collector.children[child.id]?.memberId)) &&
            new Set(children.map(child=>collector.children[child.id].memberId)).size === vigiloMemberIds().length) {
          collector.supplemental ??= {};
          const key='vigilo:discovery:all:', prior=collector.supplemental[key];
          collector.supplemental[key]={at,health:'ok',complete:true,count:children.length,childIds:children.map(child=>child.id),
            evidence:'GET /api/children/my: faktisk mottatt barneliste',
            ...(prior?.health==='error'?{recoveredFrom:{at:prior.at,detail:prior.detail}}:prior?.recoveredFrom?{recoveredFrom:prior.recoveredFrom}:{})};
          const surface=state.surfaces['vigilo:family:discovery'];
          if (surface?.collectorFailure) {
            surface.listingObservedAt=at;
            updateSurface({source:'vigilo',surface:'family:discovery',health:'ok',complete:true,seenCount:children.length,
              scanFrom:at,scanTo:at,details:'Ny vellykket barneliste avløser tidligere discovery-feil. Bare identitetsoversikten er kvittert; skoleinnhold/klasseendringer er ikke ferdiglest av dette.'});
            delete state.surfaces['vigilo:family:discovery'].collectorFailure;
          }
        }
        results = [{ children: Object.keys(collector.children).length }];
      } else {
        const child = collector.children[String(input.childId ?? '').toLowerCase()];
        if (!child || !vigiloMemberIds().includes(child.memberId)) throw new Error('Ukjent barn. Send barneliste først.');
        if (input.kind === 'news') results = [observeCollected('vigilo', child.memberId + ':news', VIGILO_ORIGIN + '/news', normalizeVigiloNews(input.items), { complete, adopt: true })];
        else if (input.kind === 'threads') results = [observeCollected('vigilo', child.memberId + ':messages', VIGILO_ORIGIN + '/messages', normalizeVigiloThreads(input.items), { complete, adopt: true })];
        else if (input.kind === 'thread-detail') {
          const detail = normalizeVigiloThreadDetail(input.detail);
          const item = detail && collector.items[detail.externalId];
          if (item) { item.detail = { messages: detail.messages, fetchedAt: at, forToken: item.token }; results = [{ detail: detail.externalId }]; } else results = [{ detail: null }];
        } else throw new Error('Ukjent samlertype.');
        if (input.kind !== 'thread-detail') collector.sweeps['vigilo:' + input.kind + ':' + child.memberId] = { at, count: results[0].count, complete };
        finalizeVigiloSource();
      }
    } else {
      const normalized = input.kind === 'posts' ? normalizeSpondPosts(input.items) : input.kind === 'events' ? normalizeSpondEvents(input.items) : null;
      if (!normalized) throw new Error('Ukjent samlertype.');
      const bySurface = new Map();
      for (const item of normalized) { const surface = spondSurface(item); (bySurface.get(surface) ?? bySurface.set(surface, []).get(surface)).push(item); }
      results = [...bySurface].map(([surface, items]) => observeCollected('spond', surface, 'https://spond.com/client/groups' + (items[0].groupId ? '/' + items[0].groupId : ''), items, { complete }));
      collector.sweeps['spond:' + input.kind] = { at, count: normalized.length, complete };
    }
    // Rydd bort elementer som ikke er sett på 45 dager.
    const cutoff = Date.now() - 45 * 86400000;
    for (const [id, item] of Object.entries(collector.items)) if (Date.parse(item.lastSeenAt) < cutoff) delete collector.items[id];
    save();
    return { ok: true, results };
  }

  function collectorFacebookSweep() { state.collector.facebookSweepRequestedAt = now(); save(); return { facebookSweepRequestedAt: state.collector.facebookSweepRequestedAt }; }

  function collectorRefresh() { state.collector.refreshRequestedAt = now(); save(); return { refreshRequestedAt: state.collector.refreshRequestedAt }; }

  function facebookGroupIds() {
    try { return (readConfig('sources.json').facebookGroupUrls ?? []).map((url) => String(url).split('/').filter(Boolean).at(-1)).filter((id) => /^\d+$/.test(id)); } catch { return []; }
  }
  function facebookTargets() {
    const groups=facebookGroupIds().flatMap(id=>[{id,url:`https://www.facebook.com/groups/${id}/?sorting_setting=CHRONOLOGICAL`},{id:id+':events',url:`https://www.facebook.com/groups/${id}/events`}]);
    try{const activities=readConfig('activity-sources.json').sources.filter(s=>/facebook\.com/.test(s.url));
      for(const source of activities){const group=source.url.match(/\/groups\/(\d+)/)?.[1];groups.push({id:group??source.id,groupId:group??null,url:source.url,activitySourceId:source.id});if(group)groups.push({id:group+':events',groupId:group,url:source.url+'/events',activitySourceId:source.id});}
    }catch{/* optional activity sources */}return groups;
  }
  const activityContentKey = item => hash(JSON.stringify([item.kind,item.title,item.text,item.postedAt,
    (item.attachments??[]).map(a=>[a.nativeId??a.id??null,a.name??a.fileName,a.version??null])]));
  function activityFacebook(sourceId,{ack=false}={}) {
    state.collector.activityReviewed??={};
    const items=Object.values(state.collector.items).filter(item=>item.activitySourceId&&(!sourceId||item.activitySourceId===sourceId)
      &&state.collector.activityReviewed[item.activitySourceId+'|'+item.externalId]!==item.token
      &&state.collector.activityIrrelevant?.[item.activitySourceId+'|'+item.externalId]?.contentKey!==activityContentKey(item));
    if(ack){for(const item of items)state.collector.activityReviewed[item.activitySourceId+'|'+item.externalId]=item.token;save();}
    return structuredClone(items);
  }

  function collectorConfig() {
    const collector = state.collector;
    const pendingEntry = (item) => [...ledgerFor('vigilo', item.externalId), ...ledgerFor('vigilo', resolveExternalId('vigilo', item.externalId))].some((entry) => !['unchanged', 'outside-window'].includes(reviewDecision(entry)));
    const want = Object.values(collector.items).filter((item) => item.kind === 'message' && (!item.detail || item.detail.forToken !== item.token) && pendingEntry(item))
      .slice(0, 10).map((item) => ({ id: item.externalId.split(':').at(-1), childId: item.childIds?.[0] ?? null }));
    const supplementalRetries = Object.entries(collector.supplemental ?? {}).flatMap(([key,status])=>{
      const [source,section,member]=key.split(':');
      if(source!=='vigilo'||!['meetings','registrations'].includes(section)||status.health!=='error'||!/unauthorized|HTTP 40[13]/i.test(status.detail??''))return [];
      const childId=Object.entries(collector.children).find(([,child])=>child.memberId===member)?.[0];
      return childId?[{source,section,childId,requestedAt:status.at}]:[];
    });
    // config/collector.json styrer intervaller og av/på. Utvidelsen har egne harde minstegrenser uansett hva som står her.
    let custom = {};
    try { custom = readConfig('collector.json'); } catch { /* standardverdier */ }
    const defaults = { vigilo: { probeMinutes: 15, fullMinutes: 60 }, spond: { probeMinutes: 15, fullMinutes: 60 }, quiet: { from: '23:00', to: '05:30', factor: 4 }, limits: { minSpacingMs: 1500, cycleCalls: 20 } };
    return {
      enabled: custom.enabled !== false, serverTime: now(), refreshRequestedAt: collector.refreshRequestedAt,
      vigilo: { ...defaults.vigilo, ...custom.vigilo }, spond: { ...defaults.spond, ...custom.spond },
      quiet: { ...defaults.quiet, ...custom.quiet }, limits: { ...defaults.limits, ...custom.limits },
      facebook: { enabled: custom.facebook?.enabled === true, sweepTimes: custom.facebook?.sweepTimes ?? ['06:20', '21:40'], maxScrolls: custom.facebook?.maxScrolls ?? 14, groups: facebookGroupIds(), targets:facebookTargets(),sweepRequestedAt: collector.facebookSweepRequestedAt ?? null },
      supplemental: custom.supplemental !== false, vigiloConsents: false, want: { threads: want, supplementalRetries }
    };
  }

  function collectorStatus() {
    const collector = state.collector;
    const bySource = {};
    for (const source of ['vigilo', 'spond', 'facebook']) {
      const sweeps = Object.entries(collector.sweeps).filter(([key]) => key.startsWith(source + ':'));
      const oldest = sweeps.map(([, value]) => value.at).sort()[0] ?? null;
      const pending = Object.values(state.reviewLedger).filter((entry) => entry.source === source && entry.managedBy === 'collector' && !['unchanged', 'outside-window'].includes(reviewDecision(entry)));
      const oldestPost = {}; if (source === 'facebook') for (const item of Object.values(collector.items)) if (item.source === 'facebook' && item.groupId) { const at = item.postedAt; if (at && (!oldestPost[item.groupId] || at < oldestPost[item.groupId])) oldestPost[item.groupId] = at.slice(0, 10); }
      bySource[source] = { ...(source === 'facebook' ? { oldestPostByGroup: oldestPost } : {}), health: collector.health[source] ?? null, sweeps: Object.fromEntries(sweeps), oldestSweepAt: oldest, complete: sweeps.length > 0 && sweeps.every(([, value]) => value.complete), pending: pending.length, pendingItems: pending.slice(0, 20).map((entry) => ({ externalId: entry.externalId, surface: entry.surface, title: entry.title })), items: Object.values(collector.items).filter((item) => item.source === source).length };
    }
    const config = collectorConfig();
    const hm = new Intl.DateTimeFormat('en-GB', {timeZone:'Europe/Oslo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
    const q = config.quiet;
    const factor = (q.from > q.to ? hm >= q.from || hm < q.to : hm >= q.from && hm < q.to) ? q.factor : 1;
    for (const source of ['vigilo', 'spond']) {
      const info = bySource[source];
      const required = source === 'vigilo' ? vigiloMemberIds().flatMap(child => ['news','threads'].map(kind => `vigilo:${kind}:${child}`)) : ['spond:posts','spond:events'];
      info.complete = required.every(key => collector.sweeps[key]?.complete === true);
      info.probeAt = collector.probes?.[source]?.at ?? null;
      info.maxProbeAgeMinutes = Math.max(5, config[source].probeMinutes) * factor + 5;
      info.maxFullAgeMinutes = Math.max(15, config[source].fullMinutes) * factor + 5;
      info.coveredKinds = source === 'vigilo' ? ['news','messages'] : ['posts','events'];
    }
    return { supplemental:Object.fromEntries(Object.entries(collector.supplemental ?? {}).filter(([id,status])=>!status.resolvedAt&&!/^vigilo:consent(?:s|-counts):/.test(id))), refreshRequestedAt: collector.refreshRequestedAt, children: Object.entries(collector.children).map(([id, child]) => ({ id: id.slice(0, 8), memberId: child.memberId, firstName: child.firstName, lastName: child.lastName })), lastError: collector.lastError ?? null, sources: bySource };
  }

  function collectedItem(externalId) {
    const source = String(externalId).split(':')[0];
    const item = state.collector.items[externalId] ?? state.collector.items[resolveExternalId(source, externalId)] ?? Object.values(state.collector.items).find(item=>sourceIdentity(source,item.externalId)===sourceIdentity(source,externalId));
    if (!item) throw new Error('Ukjent samlet element.');
    return structuredClone(item);
  }

  function collectedItems(source) {return Object.values(state.collector.items).filter(item=>!source||item.source===source).map(item=>structuredClone(item));}

  function collectedList(source, surface) {
    if (!['vigilo','spond','facebook'].includes(source)) throw Error('Ukjent samlerkilde.');
    const target = surface ? canonicalSurface(source,surface) : null;
    return Object.values(state.collector.items).filter(item=>{
      if(item.source!==source || (target && !item.surfaces.includes(target)))return false;
      if(source!=='facebook')return true;
      if(item.activitySourceId)return !target || target===`activity:${item.activitySourceId}`;
      if(item.kind==='event')return true;
      const urlGroup=item.url?.match(/^https:\/\/(?:www\.)?facebook\.com\/groups\/(\d+)(?:\/|$)/)?.[1];
      return item.surfaces.some(name=> (!target || name===target) &&
        name===`group-${item.groupId}:posts` && (item.groupProof==='target_group'||urlGroup===item.groupId));
    })
      .sort((a,b)=>String(b.postedAt??'').localeCompare(String(a.postedAt??'')))
      .map(item=>{
        const entries=ledgerFor(source,resolveExternalId(source,item.externalId)).filter(entry=>!target || entry.surface===target);
        const raw=entries.map(entry=>state.rawItems[entry.rawId]).find(Boolean);
        return {externalId:item.externalId,kind:item.kind,title:item.title,postedAt:item.postedAt,startAt:item.startAt??null,latestActivityAt:item.latestActivityAt,lastSeenAt:item.lastSeenAt,
          sourceUrl:item.url??item.sourceUrl??null,commentCount:item.commentCount??item.comments?.length??null,
          commentsComplete:item.commentsComplete??null,attachments:item.attachments.length,
          needsReview:entries.some(entry=>!['unchanged','outside-window'].includes(reviewDecision(entry))),rawId:raw?.id??null};
      });
  }

  function beginRun() {
    const current = state.runLease;
    if (current && Date.parse(current.expiresAt) > Date.now()) return { acquired: false, lease: current };
    if (current) {
      const interrupted = { id:randomUUID(), startedAt:current.startedAt, finishedAt:now(), outcome:"error", summary:"Forrige kjøringslås utløp uten frigjøring. Arbeidet fortsetter fra lagrede kontrollpunkter.", blockers:["Avbrutt kjøring eller manglende låsfornyelse."], resumeHint:"Kontroller review-queue og completion før ny innhenting." };
      archiveRun(interrupted); state.runs.unshift(interrupted);
      state.runs = state.runs.slice(0, 100);
    }
    const lease = { token: randomUUID(), startedAt: now(), renewedAt: now(), expiresAt: new Date(Date.now() + 90 * 60 * 1000).toISOString() };
    state.runLease = lease;
    state.collector.refreshRequestedAt = now();
    save();
    return { acquired: true, lease };
  }

  function renewRun(token) {
    if (!state.runLease || state.runLease.token !== token) throw new Error("Ugyldig kjøringslås.");
    state.runLease.renewedAt = now();
    state.runLease.expiresAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    save();
    return { renewed: true, lease: state.runLease };
  }

  function endRun(token) {
    if (!state.runLease || state.runLease.token !== token) throw new Error("Ugyldig kjøringslås.");
    state.runLease = null;
    save();
    return { released: true };
  }

  function resolveActivity(id) {
    let activity=state.activities[id];
    const visited=new Set();
    while(activity?.mergedInto) {
      if(visited.has(activity.id)) throw new Error('Sirkulært aktivitetsalias.');
      visited.add(activity.id); activity=state.activities[activity.mergedInto];
    }
    return activity;
  }
  function nativeActivityKey(input) {
    // A title is not identity. Match only a native Facebook event and the same
    // start instant; recurring occurrences with different dates stay separate.
    let event=null;
    try {
      const url=new URL(input.sourceUrl);
      event=/^(?:www\.|m\.)?facebook\.com$/.test(url.hostname) && url.pathname.match(/^\/events\/(\d+)\/?$/)?.[1] || null;
    } catch { /* An explicit native key can still identify a cross-post. */ }
    event ??= [input.canonicalKey,...(Array.isArray(input.canonicalAliases)?input.canonicalAliases:[])]
      .map(key=>String(key??'').match(/^facebook:event:(\d{6,30})(?::|$)/)?.[1]).find(Boolean)??null;
    return event && Number.isFinite(Date.parse(input.start)) ? `${event}:${Date.parse(input.start)}` : null;
  }
  function upsertActivity(input) {
    assertDisplayText(input);
    if (!words(input.canonicalKey,300) || !words(input.title,300) || !words(input.reason,1000) || !words(input.evidence,6000)) throw new Error("Aktivitet krever canonicalKey, title, reason og kildebelegg i evidence.");
    const start=validDate(input.start,"start"), end=validDate(input.end,"end");
    if (Date.parse(end)<=Date.parse(start)) throw new Error("Aktivitet må ha slutt etter start.");
    const sourceUrl=cleanUrl(input.sourceUrl);
    if (!sourceUrl || !words(input.sourceId,100)) throw new Error("Aktivitet krever sourceId og sourceUrl.");
    const members=uniq(input.members ?? []);
    if (!members.length || members.some(id=>!state.profile.members.some(m=>m.id===id))) throw new Error("Velg kjente familiemedlemmer.");
    const incomingKey=words(input.canonicalKey,300), nativeKey=nativeActivityKey(input);
    const matches=Object.values(state.activities).filter(item=>!item.mergedInto && (item.canonicalKey===incomingKey || item.canonicalAliases?.includes(incomingKey) || (nativeKey && nativeActivityKey(item)===nativeKey)));
    const direct=resolveActivity(hash(incomingKey).slice(0,24));
    const previous=matches.find(item=>item.plan) ?? direct ?? matches.sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))[0];
    const duplicates=matches.filter(item=>item.id!==previous?.id);
    const reactions=uniq(matches.map(item=>item.reaction));
    const plans=uniq(matches.filter(item=>item.plan).map(item=>JSON.stringify(item.plan)));
    if(reactions.length>1 || plans.length>1) throw new Error('Aktivitetsdubletter har motstridende familievalg; krever kontrollert sammenslåing.');
    const id=previous?.id ?? hash(incomingKey).slice(0,24);
    const summary=words(input.summary,2000);
    const pitch=input.pitch === undefined
      ? previous?.title===words(input.title,300) && previous?.summary===summary ? previous?.pitch ?? '' : ''
      : words(input.pitch,300);
    const activity={id,canonicalKey:previous?.canonicalKey ?? incomingKey,title:words(input.title,300),start,end,sourceId:words(input.sourceId,100),sourceUrl,members,
      summary,pitch,reason:words(input.reason,1000),evidence:words(input.evidence,6000),location:words(input.location,500),
      category:words(input.category,100),organizer:words(input.organizer,300),audience:words(input.audience,500),price:words(input.price,500)||"Pris ikke avklart",free:input.free===true,
      registration:words(input.registration,1000)||"Påmelding og ledige plasser ikke avklart",practical:words(input.practical,1000),
      score:Math.max(0,Math.min(100,Number(input.score)||0)),cancelled:input.cancelled===true,
      checkedAt:validDate(input.checkedAt,"checkedAt"),updatedAt:now(),createdAt:previous?.createdAt??now(),
      reaction:reactions[0]??previous?.reaction??null,plan:matches.find(item=>item.plan)?.plan??previous?.plan??null,
      canonicalAliases:uniq([...(previous?.canonicalAliases??[]),incomingKey,...duplicates.flatMap(item=>[item.canonicalKey,...(item.canonicalAliases??[])])]).filter(value=>value!==(previous?.canonicalKey??incomingKey))};
    if (Date.parse(activity.checkedAt)>Date.now()+60000) throw new Error("checkedAt kan ikke være i fremtiden.");
    for(const item of duplicates) state.activities[item.id]={...item,mergedInto:id,mergedAt:now()};
    state.activities[id]=activity; save(); return activity;
  }
  function activityReaction(id,input) {
    const activity=resolveActivity(id);
    if (!activity) throw new Error("Ukjent aktivitet.");
    if (!["interested","hidden","restore","plan","cancel-plan"].includes(input.action)) throw new Error("Ugyldig aktivitetsvalg.");
    if (input.action==="plan") {
      if (activity.cancelled || Date.parse(activity.end)<=Date.now()) throw new Error("Avlyst eller avsluttet aktivitet kan ikke planlegges.");
      if (!activity.plan || activity.plan.status!=="published") activity.plan={status:"pending",requestedAt:activity.plan?.requestedAt??now(),members:activity.members};
      activity.reaction="interested";
    } else if (input.action==="cancel-plan") {
      if (activity.plan?.status==="published") throw new Error("En publisert kalenderavtale må endres i kalenderen.");
      activity.plan=null;
    } else activity.reaction=input.action==="restore"?null:input.action;
    save();return activity;
  }
  function activityPlan(id,input) {
    const activity=resolveActivity(id);
    if (!activity?.plan) throw new Error("Familien har ikke valgt aktiviteten til kalenderen.");
    if (input.status==="published") {
      const event=resolveEvent(input.eventId);
      if (!event?.calendar?.eventUrl || event.cancelled || event.canonicalKey!==activity.canonicalKey || event.calendar.fingerprint!==event.fingerprint || !event.sourceRefs?.length || event.sourceRefs.some(rawId=>!state.rawItems[rawId]?.driveUrl)) throw new Error("Aktivitet krever arkivert kildekopi i Drive og publisert kalenderhendelse.");
      activity.plan={...activity.plan,status:"published",eventId:event.id,eventUrl:event.calendar.eventUrl,updatedAt:now()};
    } else if (input.status==="blocked") activity.plan={...activity.plan,status:"blocked",details:words(input.details,1000),updatedAt:now()};
    else throw new Error("Ugyldig planstatus.");
    save();return activity;
  }
  function activitySource(input) {
    if (!words(input.sourceId,100) || !HEALTH.has(input.health) || !words(input.details,2000)) throw new Error("Aktivitetskilde krever sourceId, health og details.");
    const status={sourceId:words(input.sourceId,100),health:input.health,details:words(input.details,2000),checkedAt:now(),scanTo:validDate(input.scanTo,"scanTo",true),nextPageHint:words(input.nextPageHint,1000)};
    const previous = state.activitySourceStatus[status.sourceId];
    if ((input.unresolvedItems !== undefined && !Array.isArray(input.unresolvedItems)) ||
        (input.resolvedItems !== undefined && !Array.isArray(input.resolvedItems))) throw Error('Kildehull må være lister.');
    const unresolved = new Map((previous?.unresolvedItems ?? []).map(item => [item.externalId, {...item}]));
    const resolutionHistory = [...(previous?.resolutionHistory ?? [])];
    const classified=[];
    for (const item of input.unresolvedItems ?? []) {
      const externalId = words(item.externalId,300), reason = words(item.reason,1000);
      if (!externalId || !reason) throw Error('Ulest kildeelement krever externalId og konkret reason.');
      unresolved.set(externalId,{externalId,reason,firstObservedAt:unresolved.get(externalId)?.firstObservedAt ?? status.checkedAt,lastAttemptedAt:status.checkedAt});
    }
    for (const item of input.resolvedItems ?? []) {
      if (!unresolved.has(item.externalId) || !['read','removed','outside-window','irrelevant'].includes(item.resolution) || words(item.evidence,2000).length < 12)
        throw Error('Løs kildehull med kjent externalId, resolution (read/removed/outside-window/irrelevant) og konkret evidence.');
      if(item.resolution==='irrelevant') {
        const post=state.collector.items[item.externalId],key=status.sourceId+'|'+item.externalId;
        const nativeId=item.externalId.match(/^facebook:post:(\d+)$/)?.[1];
        const linked=Object.values(state.rawItems).some(raw=>raw.externalId===item.externalId&&raw.findingIds?.length)
          ||Object.values(state.activities).some(a=>!a.mergedInto&&nativeId&&new RegExp('(?:(?:posts|permalink)/'+nativeId+'(?:[/?#]|$)|[?&](?:story_fbid|post_id)='+nativeId+'(?:[&#]|$))').test(a.sourceUrl??''));
        if(!nativeId||post?.kind!=='post'||post.activitySourceId!==status.sourceId||!post.text?.trim()
          ||state.collector.activityReviewed?.[key]!==post.token||words(item.evidence,2000).length<40||linked)
          throw Error('Irrelevant krever faktisk aktivitetsposttekst, kvittert gjeldende vurdering, konkret begrunnelse og ingen tilknyttede forslag/funn.');
        classified.push([key,{contentKey:activityContentKey(post),evidence:words(item.evidence,2000),classifiedAt:status.checkedAt}]);
      }
      resolutionHistory.push({...unresolved.get(item.externalId),resolution:item.resolution,evidence:words(item.evidence,2000),resolvedAt:status.checkedAt});
      unresolved.delete(item.externalId);
    }
    status.unresolvedItems = [...unresolved.values()];
    status.resolutionHistory = resolutionHistory;
    if (status.health === 'ok' && status.unresolvedItems.length) {
      status.health = 'partial';
      status.details = words(`${status.details} Uavklarte kildehull beholdt: ${status.unresolvedItems.map(item=>item.externalId).join(', ')}.`,2000);
    }
    // A failed/current partial check must not erase the last successful feed
    // checkpoint, or the next agent starts reading the whole month again.
    status.lastSuccessfulCheckAt = status.health === 'ok' ? status.checkedAt
      : previous?.lastSuccessfulCheckAt ?? (previous?.health === 'ok' ? previous.checkedAt : null);
    state.activitySourceStatus[status.sourceId]=status;
    if(classified.length){state.collector.activityIrrelevant??={};for(const [key,value]of classified)state.collector.activityIrrelevant[key]=value;}
    // Agentens ok betyr at gjeldende sideutgave er gjennomgått.
    const page = state.activityFeed.pages[status.sourceId];
    if (page && status.health === 'ok' && page.hash) { page.reviewedHash = page.hash; page.reviewedLineHashes = page.lineHashes ?? []; page.reviewedAt = now(); page.lines = null; }
    save();return status;
  }
  // ---- Aktivitetskilder hentet direkte over HTTP (src/activity-feeds.mjs, src/activity-feed-runner.mjs) ----
  const autoStatus = (sourceId, details, scanTo) => {
    const previous = state.activitySourceStatus[sourceId];
    // Bare ok-kilder oppdateres automatisk; partial/feil er agentens åpne saker og røres ikke.
    if (previous?.health !== 'ok') return false;
    const checkedAt = now();
    state.activitySourceStatus[sourceId] = { ...previous, sourceId, health: 'ok', details, checkedAt, lastSuccessfulCheckAt: checkedAt, scanTo, nextPageHint: previous.nextPageHint && !/Neste daglige/.test(previous.nextPageHint) ? previous.nextPageHint : 'Neste daglige 30-dagerskontroll.' };
    return true;
  };

  function activityFeedHsia(sweep) {
    const feed = state.activityFeed.hsia;
    const at = now();
    const first = !feed.baselined;
    const counts = { new: 0, changed: 0, seen: 0 };
    for (const item of sweep.items) {
      const href=hsiaHref(item.href);
      const previous = feed.items[href];
      const merged = { ...item,href, firstSeenAt: previous?.firstSeenAt ?? at, lastSeenAt: at, detail: item.detail ?? previous?.detail ?? null, detailHash: item.detail ? item.hash : previous?.detailHash ?? null,
        reviewedHash: previous?.reviewedHash ?? null, reviewedAt: previous?.reviewedAt ?? null,reviewedOccurrences:previous?.reviewedOccurrences ?? [],removedOccurrences:previous?.removedOccurrences ?? [] };
      if (sweep.complete && previous) {
        const currentDates=new Set(item.occurrences.map(o=>JSON.stringify([o.start,o.end])));
        const removed=previous.occurrences.filter(o=>Date.parse(o.start)>=Date.parse(sweep.window?.from) && Date.parse(o.start)<=Date.parse(sweep.window?.to) && (!o.end || Date.parse(o.end)>Date.now()) && !currentDates.has(JSON.stringify([o.start,o.end])));
        merged.removedOccurrences=[...new Map([...merged.removedOccurrences,...removed].map(o=>[JSON.stringify([o.start,o.end]),o])).values()];
      }
      // Første sveip: alt agenten har sett de siste dagene godtas som utgangspunkt; bare nye ting etter dette meldes.
      if (first && !previous) { merged.reviewedHash = item.hash; merged.reviewedAt = at; merged.reviewedOccurrences=item.occurrences.map(o=>hsiaOccurrenceToken(item,o)); counts.seen++; }
      else if (!previous) counts.new++;
      else if (previous.hash !== item.hash) counts.changed++;
      feed.items[href] = merged;
    }
    if (sweep.complete) {
      const cutoff = Date.now() - 7 * 86400000;
      for (const [href, item] of Object.entries(feed.items)) if (Date.parse(item.lastSeenAt) < cutoff) delete feed.items[href];
    }
    feed.sweepAt = at; feed.complete = sweep.complete; feed.window = sweep.window; feed.total = sweep.total; feed.baselined = true; feed.error = null;
    let covered = 0;
    if (sweep.complete) for (const id of sweep.covers ?? []) if (autoStatus(id, 'Automatisk: Hva skjer i Asker hentet direkte (' + sweep.items.length + ' aktivitetssider i vinduet).', sweep.window.to)) covered++;
    save();
    return { ...counts, covered, items: sweep.items.length, complete: sweep.complete };
  }

  const openCandidates = () => Object.values(state.activityFeed.hsia.items)
    .filter((item) => !item.identityAlias && ((item.removedOccurrences??[]).some(o=>!o.end || Date.parse(o.end)>Date.now()) || item.occurrences.some((o) => (!o.end || Date.parse(o.end) > Date.now()) && !(item.reviewedOccurrences??[]).includes(hsiaOccurrenceToken(item,o)))))
    .sort((a, b) => String(a.occurrences[0]?.start).localeCompare(String(b.occurrences[0]?.start)));

  function activityFeedCandidates({ ack = false, limit = 60, full = false } = {}) {
    const items = openCandidates();
    const shown = items.slice(0, limit);
    if (ack) { for (const item of shown) { item.reviewedHash = item.hash; item.reviewedAt = now(); item.reviewedOccurrences=uniq([...(item.reviewedOccurrences??[]),...item.occurrences.map(o=>hsiaOccurrenceToken(item,o))]);item.removedOccurrences=[]; } save(); }
    return { total: items.length, shown: shown.length, acked: ack, items: shown.map((item) => ({
      hash:item.hash,url: 'https://www.hvaskjeriasker.no' + item.href, title: item.title, place: [item.venue, item.area].filter(Boolean).join(', '), audience: item.audience, price: item.bubble ?? item.detail?.prices?.join(' / ') ?? null,
      when: item.occurrences.slice(0, 4).map((o) => o.timeText || o.start), occurrences: item.occurrences.length, first: item.occurrences[0]?.start ?? null,
      ...((item.removedOccurrences??[]).length?{removedOccurrences:item.removedOccurrences}:{}),
      description: (full?item.detail?.description:item.detail?.description?.slice(0,400)) ?? null, registration: item.detail?.registrationUrl ?? null, ics: item.detail?.icsUrl ?? null,...(full?{allOccurrences:item.occurrences,detail:item.detail}:{}),detailsAvailable:!!item.detail
    })) };
  }

  function activityFeedNeedsDetail(limit = 40) {
    return openCandidates().filter((item) => !item.detail).slice(0, limit).map((item) => item.href);
  }
  function activityFeedDetail(href, detail) {
    const item = state.activityFeed.hsia.items[hsiaHref(href)];
    if (item) { item.detail = detail; save(); }
  }

  function activityFeedPage(sourceId, snapshot, { targetThrough }) {
    const pages = state.activityFeed.pages;
    const at = now();
    const entry = pages[sourceId] ??= { hash: null, reviewedHash: null, reviewedLineHashes: [] };
    entry.checkedAt = at; entry.error = null; entry.hash = snapshot.hash; entry.chars = snapshot.chars; entry.lineHashes = snapshot.lineHashes;
    if (!entry.reviewedHash && state.activitySourceStatus[sourceId]?.health === 'ok') { entry.reviewedHash = snapshot.hash; entry.reviewedLineHashes = snapshot.lineHashes; entry.reviewedAt = at; }
    if (entry.hash === entry.reviewedHash) { entry.lines = null; autoStatus(sourceId, 'Automatisk: siden er uendret siden siste gjennomgang.', targetThrough); }
    else entry.lines = snapshot.lines.slice(0, 4000);
    save();
    return { changed: entry.hash !== entry.reviewedHash };
  }

  function activityFeedError(kind, sourceId, message) {
    const at = now();
    if (kind === 'hsia') state.activityFeed.hsia.error = { at, message: words(message, 300) };
    else (state.activityFeed.pages[sourceId] ??= { hash: null, reviewedHash: null, reviewedLineHashes: [] }).error = { at, message: words(message, 300) };
    save();
  }

  function activityFeedPageText(sourceId, { ack = false, full = false } = {}) {
    const entry = state.activityFeed.pages[sourceId];
    if (!entry) throw new Error('Ukjent kilde eller ikke hentet ennå.');
    const changed = entry.hash !== entry.reviewedHash;
    const known = new Set(entry.reviewedLineHashes ?? []);
    const lines = entry.lines ?? [];
    const added = changed ? lines.filter((line, index) => !known.has(entry.lineHashes?.[index])) : [];
    const currentHashes=new Set(entry.lineHashes??[]);
    const removedCount=[...known].filter(hash=>!currentHashes.has(hash)).length;
    const result = { sourceId, changed, checkedAt: entry.checkedAt, reviewedAt: entry.reviewedAt ?? null, chars: entry.chars, addedLines:full?added:added.slice(0,400),addedCount:added.length,moreLines:full?0:Math.max(0,added.length-400),removedCount,...(full?{currentLines:lines}:{}),neverReviewed: !entry.reviewedHash, error: entry.error ?? null };
    if (ack && entry.hash) { entry.reviewedHash = entry.hash; entry.reviewedLineHashes = entry.lineHashes ?? []; entry.reviewedAt = now(); entry.lines = null; save(); }
    return result;
  }

  function activityFeedStatus() {
    const feed = state.activityFeed;
    const pages = Object.entries(feed.pages).map(([id, entry]) => ({ id, hash:entry.hash, changed: entry.hash !== entry.reviewedHash, checkedAt: entry.checkedAt ?? null, error: entry.error?.message ?? null, errorAt: entry.error?.at ?? null }));
    return {facebookActivities:activityFacebook().map(item=>({sourceId:item.activitySourceId,externalId:item.externalId,title:item.title})), hsia: { sweepAt: feed.hsia.sweepAt, complete: feed.hsia.complete ?? null, total: feed.hsia.total ?? null, window: feed.hsia.window ?? null, items: Object.keys(feed.hsia.items).length, candidates: openCandidates().length, error: feed.hsia.error?.message ?? null, errorAt: feed.hsia.error?.at ?? null }, pages, changedPages: pages.filter((page) => page.changed).map((page) => page.id) };
  }

  function snapshot() { const { collector, activityFeed, shopping, ...rest } = state; return structuredClone({...rest,events:Object.fromEntries(currentEvents().map(event=>[event.id,event]))}); }
  function runHistory(before = null) {
    const files = readdirSync(runDir).filter((file) => file.endsWith(".enc") && (!before || file < before)).sort().reverse();
    const page = files.slice(0, 30);
    return { runs:page.map((file) => JSON.parse(decrypt(readFileSync(join(runDir, file)), key).toString("utf8"))), nextCursor: files.length > 30 ? page.at(-1) : null };
  }
  if (currentEvents().some((event) => event.fingerprint !== eventFingerprint(event))) {
    for (const event of currentEvents()) event.fingerprint = eventFingerprint(event);
    save();
  }
  const phone=phoneStore(state,{save,upsertRaw,addAttachment});
  const shopping=shoppingStore(state,{save});
  if(reconcileSourceReviews(state.sourceStatus,state.runs))save();
  return { shopping, repairText, backupArchive, eventHistory, event, mergeEvents, splitHomework, activityFacebook, changeCompletion, collectedItems, collectedList, sourceItems, editProfile, phone, calendarActions, calendarAction, setEventVisibility, upsertActivity, activityReaction, activityPlan, activitySource, snapshot, runHistory, profile: () => profileView(state.profile), profileFact, reviewProfile, documentStatus, reviewDocument, checkTask, upsertRaw, upsertFinding, updateSource, observeListing, markReviewed, updateSurface, reviewQueue, completionReport, addAttachment, getAttachment, linkDrive, linkCalendar, updateProfile, recordRun, beginRun, renewRun, endRun, collectorIngest, collectorConfig, collectorStatus, collectorRefresh, collectorFacebookSweep, collectedItem, activityFeedHsia, activityFeedCandidates, activityFeedNeedsDetail, activityFeedDetail, activityFeedPage, activityFeedError, activityFeedPageText, activityFeedStatus };
}

