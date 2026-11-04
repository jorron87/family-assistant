import { createHash } from 'node:crypto';

// Old clients included the discovered group IDs on both supplemental lists, but
// the store did not retain them on the discovery receipt. Recover only when two
// complete, newer batches left the SAME native group inventory in their exact
// listing timestamps. This proves inventory discovery, not content review.
export function recoveredSpondDiscovery(collector, surfaces) {
  const failed=collector?.supplemental?.['spond:discovery:all:'];
  if(failed?.health!=='error' || !Number.isFinite(Date.parse(failed.at)))return null;
  const evidence=[];
  for(const section of ['polls','payments']) {
    const receipt=collector.supplemental[`spond:${section}:all:`];
    const at=Date.parse(receipt?.at);
    if(receipt?.health!=='ok'||receipt.complete!==true||!Number.isFinite(at)||at<=Date.parse(failed.at))return null;
    const groups=Object.values(surfaces??{}).filter(surface=>surface.source==='spond' &&
      new RegExp(`^group-[A-Fa-f0-9]{32}:${section}$`).test(surface.surface) &&
      Date.parse(surface.listingObservedAt)>=at && Date.parse(surface.listingObservedAt)<=at+5000)
      .map(surface=>surface.surface.split(':')[0].slice(6)).sort();
    if(!groups.length)return null;
    evidence.push({section,at:receipt.at,groupIds:groups});
  }
  if(JSON.stringify(evidence[0].groupIds)!==JSON.stringify(evidence[1].groupIds))return null;
  return {at:evidence.map(row=>row.at).sort().at(-1),groupIds:evidence[0].groupIds,evidence:evidence.map(({section,at})=>({section,at}))};
}

// Normaliserer svar fra Vigilo og Spond (samlet inn av utvidelsen) til kildeelementer med native ID-er og endringstoken.
// Kun uttrukne felt lagres. Alt som ikke er på listene under forkastes, også hvis API-et legger til nye felt.

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const text = (value, max = 1000000) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').slice(0, max) : '');
const iso = (value) => { const time = typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID32 = /^[0-9A-Fa-f]{32}$/;
const uuid = (value) => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);
const id32 = (value) => (typeof value === 'string' && ID32.test(value) ? value.toUpperCase() : null);
const oneLine = (value, max) => text(value, max * 3).replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value) => (Array.isArray(value) ? value : []);

// Object field order and read counters are transport/UI details, not revisions.
const supplementalData = value => {
  if (Array.isArray(value)) return value.map(supplementalData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => !['unread','isRead','seenCount','lastRead'].includes(key))
    .map(key => [key, supplementalData(value[key])]));
  return value;
};

export function collectorIsFresh(info, at = Date.now()) {
  const age = info?.oldestSweepAt ? (at - Date.parse(info.oldestSweepAt)) / 60000 : Infinity;
  const probe = info?.probeAt ? (at - Date.parse(info.probeAt)) / 60000 : Infinity;
  return info?.complete === true && (!info.health || info.health.health === 'ok') &&
    age >= 0 && age <= (info.maxFullAgeMinutes ?? 30) &&
    (age <= 30 || probe <= (info.maxProbeAgeMinutes ?? 20));
}

export const VIGILO_ORIGIN = 'https://web-parent.prod.vigilo-oas.no';

export function normalizeChildren(items) {
  return list(items).map((child) => ({ id: uuid(child?.id), firstName: oneLine(child?.firstName, 60), lastName: oneLine(child?.lastName, 60) })).filter((child) => child.id && child.firstName);
}

export function attachmentsOf(items) {
  return list(items).map((file) => ({ id: uuid(file?.id) ?? id32(file?.id) ?? (oneLine(file?.id, 128) || null), name: oneLine(file?.name, 300), mimeType: oneLine(file?.mimeType, 100), url: resourceUrl(file?.url ?? file?.downloadUrl), version: oneLine(file?.version ?? file?.updatedAt, 100) || null })).filter((file) => file.id || file.name || file.url);
}

function resourceUrl(value) { try { const url = new URL(value, VIGILO_ORIGIN); return value && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
const attachmentVersion = (file) => [file.id ?? file.name, file.name, file.mimeType, file.version];

export function normalizeVigiloNews(items) {
  const result = [];
  for (const post of list(items)) {
    const id = uuid(post?.id);
    if (!id) continue;
    const attachments = attachmentsOf(post.attachments);
    const body = text(post.text);
    const updated = iso(post.updated);
    result.push({
      source: 'vigilo', kind: 'news', externalId: `vigilo:news:${id}`,
      title: oneLine(post.title, 300), text: body, postedAt: iso(post.posted), updatedAt: updated,
      attachments, author: oneLine(`${post.author?.firstName ?? ''} ${post.author?.lastName ?? ''}`, 120),
      childIds: list(post.childIds).map(uuid).filter(Boolean),
      latestActivityAt: updated,
      token: hash(['vn', updated, post.editor ? 'edited' : null, post.title, body, attachments.map(attachmentVersion)])
    });
  }
  return result;
}

export function normalizeVigiloThreads(payload) {
  const items = Array.isArray(payload) ? payload : payload?.items;
  const result = [];
  for (const thread of list(items)) {
    const id = uuid(thread?.messageThreadId);
    if (!id || thread.isDeleted === true) continue;
    const last = thread.lastMessage ?? {};
    const lastAt = iso(last.createdAt) ?? iso(thread.createdAt);
    result.push({
      source: 'vigilo', kind: 'message', externalId: `vigilo:message:${id}`,
      title: oneLine(thread.title, 300), text: oneLine(last.body, 600), postedAt: iso(thread.createdAt), updatedAt: lastAt,
      attachments: thread.hasAttachments ? [{ id: null, name: 'vedlegg', mimeType: '' }] : [],
      author: oneLine(`${thread.sender?.firstName ?? ''} ${thread.sender?.lastName ?? ''}`, 120),
      childIds: thread.child?.id ? [uuid(thread.child.id)].filter(Boolean) : [],
      latestActivityAt: lastAt,
      token: hash(['vt', uuid(last.id), thread.numberOfReplies ?? null, thread.hasAttachments === true, thread.title, last.body, lastAt])
    });
  }
  return result;
}

// Full tekst for én tråd (detaljkallet), for at agenten skal slippe å åpne den i nettleseren.
export function normalizeVigiloThreadDetail(detail) {
  const id = uuid(detail?.messageThreadId);
  if (!id || detail.isDeleted === true) return null;
  return {
    externalId: `vigilo:message:${id}`, title: oneLine(detail.title, 300),
    messages: list(detail.messages).filter((message) => !message?.isDeleted).map((message) => ({
      id: uuid(message.id), at: iso(message.createdAt), text: text(message.text),
      attachments: attachmentsOf(message.attachments)
    }))
  };
}

function commentsOf(comments) {
  const out = [];
  const walk = (items, depth) => {
    for (const comment of list(items)) {
      out.push({ id: id32(comment?.id), at: iso(comment?.timestamp), edited: comment?.edited === true, text: text(comment?.text) });
      walk(comment?.children, depth + 1);
    }
  };
  walk(comments, 0);
  return out.filter((comment) => comment.id);
}

export function normalizeSpondPosts(items) {
  const result = [];
  for (const post of list(items)) {
    const id = id32(post?.id);
    if (!id || post.type === 'DELETED') continue;
    const comments = commentsOf(post.comments);
    const attachments = attachmentsOf(post.attachments);
    const body = text(post.body);
    const posted = iso(post.timestamp);
    const latestComment = comments.map((comment) => comment.at).filter(Boolean).sort().at(-1) ?? null;
    result.push({
      source: 'spond', kind: 'post', externalId: `spond:post:${id}`, groupId: id32(post.groupId), subGroupIds: list(post.subGroupIds).map(id32).filter(Boolean),
      title: oneLine(post.title || body, 300), text: body, postedAt: posted, updatedAt: null,
      attachments, comments, latestActivityAt: [posted, latestComment].filter(Boolean).sort().at(-1),
      token: hash(['sp', post.title, body, attachments.map(attachmentVersion), comments.map((comment) => [comment.id, comment.edited, comment.at, comment.text]), post.commentsDisabled === true])
    });
  }
  return result;
}

export function normalizeSpondEvents(items) {
  const result = [];
  for (const event of list(items)) {
    const id = id32(event?.id);
    if (!id) continue;
    const comments = commentsOf(event.comments);
    const attachments = attachmentsOf(event.attachments);
    const desc = text(event.description);
    const start = iso(event.startTimestamp), end = iso(event.endTimestamp);
    const latestComment = comments.map((comment) => comment.at).filter(Boolean).sort().at(-1) ?? null;
    const groupId = id32(event.recipients?.group?.id);
    result.push({
      source: 'spond', kind: 'event', externalId: `spond:event:${id}`, groupId, subGroupIds: list(event.recipients?.groups ?? event.subGroupIds).map((group) => id32(group?.id ?? group)).filter(Boolean),
      title: oneLine(event.heading, 300), text: desc, postedAt: iso(event.createdTime) ?? start, updatedAt: null,
      startAt: start, endAt: end, location: oneLine(event.location?.feature ?? event.location?.address ?? '', 200),
      hidden: event.hidden === true, cancelled: event.cancelled === true || event.status === 'CANCELLED',
      attachments, comments, latestActivityAt: latestComment ?? null,
      // `updated` og svarlister endres av vanlige påmeldinger og gir støy; token bygger bare på innholdet familien bryr seg om.
      token: hash(['se', event.heading, desc, start, end, event.location?.feature ?? null, event.hidden === true, event.cancelled === true, attachments.map(attachmentVersion), comments.map((comment) => [comment.id, comment.edited, comment.at, comment.text])])
    });
  }
  return result;
}

export function facebookPostToken(post) {
  return hash(['fb', post.text, post.attachments.map(a => a.name), post.commentCount,
    post.comments.map(c => [c.id, c.text, c.replies]).sort((a,b) => a[0].localeCompare(b[0]))]);
}

export function mergeFacebookPost(previous, incoming) {
  if (!previous || previous.externalId !== incoming.externalId) return incoming;
  // Feed excerpts omit previously observed comments. Only an explicitly complete
  // response proves removal; an observed edit/new ID still replaces its cache.
  if (!incoming.commentsComplete) {
    const comments = new Map(previous.comments.map(c => [c.id,c]));
    for (const c of incoming.comments) {
      const prior = comments.get(c.id);
      // Relay also emits ID-only Comment references. Old extensions serialize
      // these as empty text with no author/time/reply metadata, not an edit.
      if (c.textObserved === false && prior) comments.set(c.id,{...prior});
      else comments.set(c.id,{...c,replies:c.replies ?? prior?.replies ?? null});
    }
    const observed = new Set(incoming.comments.filter(c=>c.textObserved!==false).map(c => c.id));
    incoming = {...incoming, comments:[...comments.values()], cachedCommentIds:[...comments.keys()].filter(id => !observed.has(id))};
  }
  return {...incoming, token:facebookPostToken(incoming)};
}

export function normalizeFacebookPosts(items) {
  const result = [];
  const now = Date.now();
  for (const post of list(items)) {
    const postId = typeof post?.postId === 'string' && /^\d{6,30}$/.test(post.postId) ? post.postId : null;
    const created = Number.isFinite(post?.created) ? post.created * 1000 : null;
    if (!postId || !created) continue;
    const body = text(post.text, 20000);
    const comments = list(post.comments).map((comment) => ({ id: oneLine(comment?.id, 120), author: oneLine(comment?.author, 120), text: text(comment?.text), at: Number.isFinite(comment?.time) ? new Date(comment.time * 1000).toISOString() : null, replies:comment.replies ?? null,
      textObserved:comment?.textObserved ?? (typeof comment?.text === 'string' && (!!comment.text || !!comment.author || Number.isFinite(comment.time) || Number.isFinite(comment.replies)))
    })).filter((comment) => comment.id);
    const knownTimes = comments.map((comment) => comment.at).filter(Boolean).sort();
    // Kommentarer uten tidspunkt kan ikke avvises som gamle: da leses innlegget på nytt.
    const activity = comments.some((comment) => !comment.at) ? new Date(now).toISOString() : [new Date(created).toISOString(), knownTimes.at(-1)].filter(Boolean).sort().at(-1);
    const attachments = list(post.attachments).map((type) => oneLine(type, 60)).filter(Boolean);
    const item = {
      source: 'facebook', kind: 'post', externalId: `facebook:post:${postId}`, groupId: oneLine(post.groupId, 40) || null, groupProof:oneLine(post.groupProof,30)||null, url: oneLine(post.url, 400) || null,
      title: oneLine(body.split('\n').find((line) => line.trim()) ?? `Innlegg av ${post.author ?? 'ukjent'}`, 200) || `Innlegg ${postId}`,
      text: body, author: oneLine(post.author, 120), postedAt: new Date(created).toISOString(), updatedAt: null,
      attachments: attachments.map((type, index) => ({ id: null, name: `${type} ${index + 1}`, mimeType: '' })), comments, commentCount: Number.isFinite(post.commentCount) ? post.commentCount : comments.length,
      commentsComplete: post.commentCount===0 || Number.isFinite(post.commentCount)&&comments.length>=post.commentCount&&comments.every(c=>c.textObserved && c.replies===0),
      latestActivityAt: activity,
    };
    item.token = facebookPostToken(item);
    result.push(item);
  }
  return result;
}

export function isoDay(value) { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null; }
export function normalizeSupplemental(input) {
  const section = input.section;
  return list(input.items).map(data => {
    const native = data?.id ?? data?.invitationId ?? data?.formId ?? data?.resourceId;
    const stable = native || hash([section,input.childId,input.unitId,input.groupId,data?.type,data?.properties ?? data]);
    const kind = input.source==='spond' && ['polls','payments'].includes(section) ? 'post' : section;
    const stableData=supplementalData(data);if(section==='files'&&data?.type!=='LINK')delete stableData.url;
    const body = JSON.stringify(stableData,null,2);
    return {source:input.source,kind:section,externalId:`${input.source}:${kind}:${stable}`,groupId:data?.groupId ?? input.groupId,childIds:[input.childId ?? data?.properties?.childId].filter(Boolean),
      title:oneLine(data?.title ?? data?.heading ?? data?.name ?? data?.poll?.question ?? `${section}: ${data?.type ?? stable}`,300),text:body,
      postedAt:iso(data?.timestamp ?? data?.createdAt ?? data?.publishedAt),updatedAt:iso(data?.updatedAt),
      attachments:attachmentsOf(section==='files'&&data?.type!=='LINK'?[{...data,name:data.name??data.title,mimeType:data.mimeType??data.mediaType}]:data?.attachments),token:hash(stableData),latestActivityAt:iso(data?.updatedAt),
      retainUntil:iso(data?.deadline ?? data?.registrationDeadline ?? data?.endTimestamp),sourceUrl:input.url};
  });
}
export function normalizeFacebookEvents(items) {
  return list(items).filter(e=>/^\d{6,30}$/.test(e.eventId??'')).map(e=>({source:'facebook',kind:'event',externalId:`facebook:event:${e.eventId}`,title:oneLine(e.title,300),text:text(e.text),postedAt:null,updatedAt:null,startAt:e.start?iso(e.start*1000):null,endAt:e.end?iso(e.end*1000):null,location:oneLine(e.location,300),url:resourceUrl(e.url),attachments:[],comments:[],detailsComplete:false,cancelled:e.cancelled===true,token:hash([e.title,e.text,e.start,e.end,e.location,e.cancelled])}));
}
export const normalizeTitle = (value) => String(value ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
