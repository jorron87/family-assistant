/* Familien – API-samler, kjernelogikk.
 *
 * Kjører i Vigilo- eller Spond-fanen (MAIN world) og leser lister fra portalenes egne API-er med sidens egen innlogging,
 * slik en forelder ville sett dem i klienten, bare sjeldnere. Ren logikk uten Chrome-avhengigheter, så den kan testes i Node.
 *
 * Enkle grenser:
 *  - Tokenet brukes bare i siden og sendes ikke videre til Familien-tjenesten.
 *  - Bare lesing (GET) mot faste listekall.
 *  - Skånsom bruk: minst 1,5 s mellom kall, tak per runde, sjekk av tellere før full henting, backoff ved feil,
 *    og pause ved 401/403/429.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilienCollectorCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY = 86400000;
  const HARD = { minSpacingMs: 1000, cycleCalls: 30, minCycleGapMs: 5 * 60000, minRefreshGapMs: 2 * 60000, maxWindowDays: 45 };

  const SOURCES = {
    vigilo: {
      origin: 'https://web-parent.prod.vigilo-oas.no',
      allow: [/^\/api\/children\/my$/, /^\/api\/count-of-posts$/, /^\/api\/children-counters$/, /^\/api\/news-feed$/, /^\/api\/message-threads$/, /^\/api\/message-threads\/[0-9a-f-]{36}$/i]
    },
    spond: {
      origin: 'https://api.spond.com',
      allow: [/^\/core\/v1\/posts$/, /^\/core\/v1\/posts\/badge$/, /^\/core\/v1\/sponds$/]
    }
  };

  // ---- URL og dato ----
  function isAllowedRead(source, url) {
    try {
      const spec = SOURCES[source];
      const parsed = new URL(url);
      return !!spec && parsed.origin === spec.origin && spec.allow.some((pattern) => pattern.test(parsed.pathname));
    } catch { return false; }
  }

  const two = (n) => String(n).padStart(2, '0');
  function formatLike(sample, date) {
    const value = String(sample ?? '');
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return date.toISOString();
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return `${two(date.getUTCDate())}.${two(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
    return date.toISOString().slice(0, 10);
  }

  function windowDates(now, days) {
    const back = Math.min(Math.max(days, 1), HARD.maxWindowDays);
    const from = new Date(Math.floor((now - back * DAY) / DAY) * DAY);
    const to = new Date(Math.floor(now / DAY) * DAY + 2 * DAY - 1000);
    return { from, to };
  }

  function withParams(base, sets) {
    const url = new URL(base);
    for (const [key, value] of Object.entries(sets)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url.toString();
  }

  // Bygger URL fra malen appen selv har brukt (med samme parameterformat), ellers fra beste standard.
  function buildUrl(kind, { template, childId, now, windowDays = 30, max }) {
    const date = windowDates(now, windowDays);
    const sample = template && kind !== 'thread-detail' ? new URL(template).searchParams : null;
    switch (kind) {
      case 'news': {
        const base = template ?? `${SOURCES.vigilo.origin}/api/news-feed`;
        return withParams(base, { childIds: childId, fromDate: formatLike(sample?.get('fromDate'), date.from), toDate: formatLike(sample?.get('toDate'), date.to) });
      }
      case 'threads': {
        const base = template ?? `${SOURCES.vigilo.origin}/api/message-threads`;
        return withParams(base, { childIds: childId, fromDate: formatLike(sample?.get('fromDate'), date.from), toDate: formatLike(sample?.get('toDate'), date.to), includeAfterSchoolMessages: sample?.get('includeAfterSchoolMessages') ?? 'true' });
      }
      case 'thread-detail':
        return withParams(`${SOURCES.vigilo.origin}/api/message-threads/${template}`, { childPersonId: childId });
      case 'posts': {
        const base = template ?? `${SOURCES.spond.origin}/core/v1/posts`;
        const url = new URL(base);
        // A poll/payment view and a scrolled list use the same endpoint. Their
        // filters/cursors must not replace the ordinary complete post list.
        url.searchParams.set('type', 'PLAIN');
        for (const flag of ['includeComments', 'includeReadStatus', 'includeSeenCount']) url.searchParams.set(flag, 'true');
        url.searchParams.set('max', String(max));
        for (const key of ['groupId','subGroupId','prevId','maxTimestamp','minTimestamp']) url.searchParams.delete(key);
        return url.toString();
      }
      case 'events': {
        const base = template ?? `${SOURCES.spond.origin}/core/v1/sponds`;
        const url = new URL(base);
        for (const [key, value] of Object.entries({ includeComments: 'true', includeHidden: 'false', addProfileInfo: 'true', scheduled: 'true', order: 'asc' })) url.searchParams.set(key, value);
        url.searchParams.set('max', String(max));
        url.searchParams.set('minEndTimestamp', new Date(now - DAY).toISOString());
        for (const key of ['groupId','subGroupId','prevId','maxTimestamp','maxEndTimestamp','maxStartTimestamp','minStartTimestamp']) url.searchParams.delete(key);
        return url.toString();
      }
      default: throw new Error('ukjent type');
    }
  }

  // ---- Uttrekk: bare det serveren trenger. Ingenting annet forlater siden. ----
  const s = (value, max = 1000000) => (typeof value === 'string' ? value.slice(0, max) : null);
  const files = (items) => (Array.isArray(items) ? items : []).map((file) => ({ id: s(file?.id, 128), name: s(file?.name ?? file?.fileName ?? file?.title, 300), mimeType: s(file?.mimeType ?? file?.contentType, 100), url: s(file?.url ?? file?.downloadUrl ?? file?.media, 8192), version: s(file?.version ?? file?.updatedAt ?? file?.updated, 100) }));
  const comments = (items, depth = 0) => (Array.isArray(items) ? items : []).map((comment) => ({
    id: s(comment?.id, 64), timestamp: s(comment?.timestamp, 40), text: s(comment?.text), edited: comment?.edited === true,
    children: comments(comment?.children, depth + 1)
  }));

  const extract = {
    children: (body) => (Array.isArray(body) ? body : body?.items ?? []).map((child) => ({ id: s(child?.id, 64), firstName: s(child?.firstName, 60), lastName: s(child?.lastName, 60) })),
    news: (body) => (Array.isArray(body) ? body : body?.items ?? []).map((post) => ({
      id: s(post?.id, 64), posted: s(post?.posted, 40), title: s(post?.title, 300), text: s(post?.text), childIds: (Array.isArray(post?.childIds) ? post.childIds : []).map((id) => s(id, 64)),
      attachments: files(post?.attachments).map(file=>({...file,url:file.url || (file.id ? SOURCES.vigilo.origin+'/api/'+(post.type==='pedagogicalPlan'?'pedagogical-plans':'posts')+'/'+post.id+'/attachments/'+file.id : null)})), updated: s(post?.updated, 40), editor: post?.editor ? { id: 'x' } : null, author: { firstName: s(post?.author?.firstName, 60), lastName: s(post?.author?.lastName, 60) }
    })),
    threads: (body) => ({ items: (Array.isArray(body) ? body : body?.items ?? []).map((thread) => ({
      messageThreadId: s(thread?.messageThreadId, 64), title: s(thread?.title, 300), createdAt: s(thread?.createdAt, 40), isDeleted: thread?.isDeleted === true,
      numberOfReplies: Number.isFinite(thread?.numberOfReplies) ? thread.numberOfReplies : null, hasAttachments: thread?.hasAttachments === true,
      sender: { firstName: s(thread?.sender?.firstName, 60), lastName: s(thread?.sender?.lastName, 60) }, child: { id: s(thread?.child?.id, 64) },
      lastMessage: { id: s(thread?.lastMessage?.id, 64), body: s(thread?.lastMessage?.body, 600), createdAt: s(thread?.lastMessage?.createdAt, 40) }
    })) }),
    threadDetail: (body) => ({
      messageThreadId: s(body?.messageThreadId, 64), title: s(body?.title, 300), isDeleted: body?.isDeleted === true,
      messages: (Array.isArray(body?.messages) ? body.messages : []).map((message) => ({ id: s(message?.id, 64), text: s(message?.text), createdAt: s(message?.createdAt, 40), isDeleted: message?.isDeleted === true, attachments: files(message?.attachments).map(file=>({...file,url:file.url || (file.id ? SOURCES.vigilo.origin+'/api/message-threads/'+body.messageThreadId+'/attachments/'+file.id : null)})) }))
    }),
    posts: (body) => (Array.isArray(body) ? body : []).map((post) => ({
      id: s(post?.id, 64), type: s(post?.type, 20), groupId: s(post?.groupId, 64), subGroupIds: (Array.isArray(post?.subGroupIds) ? post.subGroupIds : []).map((id) => s(id, 64)),
      title: s(post?.title, 300), body: s(post?.body), timestamp: s(post?.timestamp, 40), attachments: files(post?.attachments), commentsDisabled: post?.commentsDisabled === true, comments: comments(post?.comments)
    })),
    events: (body) => (Array.isArray(body) ? body : []).map((event) => ({
      id: s(event?.id, 64), heading: s(event?.heading, 300), description: s(event?.description), startTimestamp: s(event?.startTimestamp, 40), endTimestamp: s(event?.endTimestamp, 40),
      createdTime: s(event?.createdTime, 40), hidden: event?.hidden === true, cancelled: event?.cancelled === true, location: { feature: s(event?.location?.feature, 200) },
      recipients: { group: { id: s(event?.recipients?.group?.id, 64) }, groups: (Array.isArray(event?.recipients?.groups) ? event.recipients.groups : []).slice(0, 10).map((group) => ({ id: s(group?.id, 64) })) },
      attachments: files(event?.attachments), comments: comments(event?.comments)
    }))
  };

  const isList = (body) => Array.isArray(body) || Array.isArray(body?.items);
  const listComplete = (body, count) => count < 200 && !body?.hasNextPage && !body?.nextPage && !body?.nextCursor && !(Number.isFinite(body?.totalCount) && body.totalCount > count) && !(Number.isFinite(body?.count) && body.count > count);

  // ---- Skånsomhet ----
  function createLimiter({ minSpacingMs, cycleCalls, now, sleep }) {
    const spacing = Math.max(minSpacingMs ?? 1500, HARD.minSpacingMs);
    const cap = Math.min(cycleCalls ?? 20, HARD.cycleCalls);
    let last = 0, used = 0;
    return {
      get used() { return used; },
      async take() {
        if (used >= cap) throw Object.assign(new Error('call_budget'), { code: 'budget' });
        const wait = last + spacing - now();
        if (wait > 0) await sleep(wait);
        last = now(); used++;
      }
    };
  }

  const quiet = (nowMs, cfg) => {
    if (!cfg) return false;
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs));
    return cfg.from > cfg.to ? hm >= cfg.from || hm < cfg.to : hm >= cfg.from && hm < cfg.to;
  };

  function nextDelayMs(cfg, source, nowMs) {
    const base = Math.max((cfg?.[source]?.probeMinutes ?? 15) * 60000, HARD.minCycleGapMs);
    return quiet(nowMs, cfg?.quiet) ? base * (cfg.quiet.factor ?? 4) : base;
  }

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function assertNoSecrets(payload, token) {
    const text = JSON.stringify(payload);
    if ((token && token.length > 12 && text.includes(token)) || /bearer\s+[a-z0-9._-]{12,}/i.test(text) || /"?authorization"?\s*:/i.test(text)) throw new Error('payload_contains_secret');
  }

  // ---- Én runde ----
  // ctx: { source, now(), sleep(ms), token(), fetchJson(url), server(path, method, body), state, templates, log(event), config }
  async function runCycle(ctx) {
    const { source } = ctx;
    const nowMs = ctx.now();
    const state = ctx.state;
    const config = ctx.config ?? {};
    const token = ctx.token();
    const out = { source, ran: false, calls: 0, posted: 0, reason: null };
    if (!token) { out.reason = 'no_token'; return out; }
    const refreshAt = config.refreshRequestedAt ? Date.parse(config.refreshRequestedAt) : 0;
    // Hard pause (avvist token, 429) står alltid. Myk pause (vår egen feil eller et engangsavbrudd) kan brytes av en bestilt oppdatering.
    const softBypass = state.pauseKind === 'soft' && refreshAt > (state.lastFullAt ?? 0);
    if (state.pausedUntil && state.pauseKind && nowMs < state.pausedUntil && !softBypass) { out.reason = 'paused'; return out; }
    const wantThreads = source !== 'vigilo' ? [] : (config.want?.threads ?? []).filter((item) => /^[0-9a-f-]{36}$/i.test(item.id ?? '') && /^[0-9a-f-]{36}$/i.test(item.childId ?? ''));
    const refresh = refreshAt > (state.lastFullAt ?? 0);
    const since = nowMs - (state.lastCycleAt ?? 0);
    if (!refresh && !wantThreads.length && since < nextDelayMs(config, source, nowMs)) { out.reason = 'not_due'; return out; }
    if ((refresh || wantThreads.length) && since < HARD.minRefreshGapMs) { out.reason = 'too_soon'; return out; }
    if (!refresh && !wantThreads.length && since < HARD.minCycleGapMs) { out.reason = 'too_soon'; return out; }

    out.ran = true;
    state.lastCycleAt = nowMs;
    const limiter = createLimiter({ minSpacingMs: config.limits?.minSpacingMs, cycleCalls: config.limits?.cycleCalls, now: ctx.now, sleep: ctx.sleep });
    const health = (value, detail) => ctx.server('/api/collector', 'POST', { source, kind: 'health', health: value, detail }).catch(() => {});

    async function get(url) {
      if (!isAllowedRead(source, url)) throw Object.assign(new Error('not_allowed'), { code: 'not_allowed' });
      await limiter.take();
      out.calls++;
      const reply = await ctx.fetchJson(url);
      if (reply.status === 401 || reply.status === 403) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
      if (reply.status === 429 || reply.status >= 500) throw Object.assign(new Error('backoff'), { code: 'backoff', retryAfterMs: reply.retryAfterMs });
      if (reply.status < 200 || reply.status >= 300) throw Object.assign(new Error(`http_${reply.status}`), { code: 'http', status: reply.status });
      return reply.json;
    }
    async function post(payload) {
      assertNoSecrets(payload, token);
      await ctx.server('/api/collector', 'POST', payload);
      out.posted++;
    }

    try {
      const fullDue = refresh || wantThreads.length > 0 || !state.lastFullAt || nowMs - state.lastFullAt >= (config[source]?.fullMinutes ?? 60) * 60000 * (quiet(nowMs, config.quiet) ? (config.quiet.factor ?? 4) : 1);
      // 1. Billig sjekk: uendrede tellere og fersk full henting betyr at det ikke er noe nytt å hente.
      const probeUrls = source === 'vigilo' ? [`${SOURCES.vigilo.origin}/api/count-of-posts`, `${SOURCES.vigilo.origin}/api/children-counters`] : [`${SOURCES.spond.origin}/core/v1/posts/badge`];
      let probe = '';
      for (const url of probeUrls) probe += JSON.stringify(await get(url) ?? null);
      const probeHash = hashText(probe);
      const changed = probeHash !== state.probeHash;
      state.probeHash = probeHash;
      if (!fullDue && !changed) {
        await post({ source, kind: 'heartbeat', probeHash, lastFullAt: new Date(state.lastFullAt).toISOString() });
        out.reason = 'unchanged'; state.consecutiveFailures = 0; return out;
      }

      // 2. Full henting.
      if (source === 'vigilo') await vigiloFull();
      else await spondFull();
      state.lastFullAt = ctx.now();
      state.consecutiveFailures = 0;
      state.pausedUntil = 0; state.pauseKind = null;
      out.reason = 'full';
      await post({ source, kind: 'heartbeat', probeHash, lastFullAt: new Date(state.lastFullAt).toISOString() });
      await health('ok', 'ok');
      return out;
    } catch (error) {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      if (error.code === 'unauthorized') { state.pausedUntil = ctx.now() + 10 * 60000; state.pauseKind = 'hard'; out.reason = 'unauthorized'; await health('unauthorized', 'token avvist eller utløpt'); }
      else if (error.code === 'backoff') { const wait = Math.min(Math.max(error.retryAfterMs ?? 0, 30 * 60000 * Math.min(state.consecutiveFailures, 4)), 4 * 3600000); state.pausedUntil = ctx.now() + wait; state.pauseKind = 'hard'; out.reason = 'backoff'; await health('paused', `pause ${Math.round(wait / 60000)} min`); }
      else if (error.code === 'budget') { out.reason = 'budget'; await health('stalled', 'Kallbudsjett nådd; full gjennomgang er ikke ferdig.'); }
      else if (error.code === 'shape') { out.reason = 'shape'; await health('error', `uventet format: ${error.message}`); }
      else if (error.code === 'http') { state.pausedUntil = ctx.now() + 30 * 60000; state.pauseKind = 'soft'; out.reason = `http_${error.status}`; await health(error.status === 400 || error.status === 404 ? 'needs_template' : 'error', `http ${error.status}`); }
      else { state.pausedUntil = ctx.now() + Math.min(5 * state.consecutiveFailures, 30) * 60000; state.pauseKind = 'soft'; out.reason = 'error'; await health('error', String(error.message).slice(0, 200)); }
      return out;
    }

    async function vigiloFull() {
      const childrenBody = await get(`${SOURCES.vigilo.origin}/api/children/my`);
      if (!isList(childrenBody)) throw Object.assign(new Error('children'), { code: 'shape' });
      const children = extract.children(childrenBody).filter((child) => child.id && child.firstName);
      await post({ source, kind: 'children', items: children });
      for (const child of children) {
        const news = await get(buildUrl('news', { template: ctx.templates.news, childId: child.id, now: ctx.now() }));
        if (!isList(news)) throw Object.assign(new Error('news'), { code: 'shape' });
        const newsItems = extract.news(news);
        await post({ source, kind: 'news', childId: child.id, complete: listComplete(news,newsItems.length), items: newsItems });
        const threads = await get(buildUrl('threads', { template: ctx.templates.threads, childId: child.id, now: ctx.now() }));
        if (!isList(threads)) throw Object.assign(new Error('threads'), { code: 'shape' });
        const threadPayload = extract.threads(threads);
        await post({ source, kind: 'threads', childId: child.id, complete: listComplete(threads,threadPayload.items.length), items: threadPayload });
      }
      // Detaljer bare for tråder serveren ber om (nye eller endrede som agenten skal lese).
      for (const want of wantThreads.slice(0, 10)) {
        const detail = await get(buildUrl('thread-detail', { template: want.id, childId: want.childId }));
        await post({ source, kind: 'thread-detail', childId: want.childId, detail: extract.threadDetail(detail) });
      }
    }

    async function spondFull() {
      const windowMs = 30 * DAY;
      let max = 60;
      let posts;
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = await get(buildUrl('posts', { template: ctx.templates.posts, now: ctx.now(), max }));
        if (!Array.isArray(body)) throw Object.assign(new Error('posts'), { code: 'shape' });
        posts = body;
        const oldest = posts.map((post) => Date.parse(post.timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0];
        if (posts.length < max || (oldest && oldest < ctx.now() - windowMs)) break;
        max = 150;
      }
      const postsComplete = posts.length < max || (posts.map((post) => Date.parse(post.timestamp)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? Infinity) < ctx.now() - windowMs;
      await post({ source, kind: 'posts', complete: postsComplete, items: extract.posts(posts) });
      const eventsBody = await get(buildUrl('events', { template: ctx.templates.events, now: ctx.now(), max: 100 }));
      if (!Array.isArray(eventsBody)) throw Object.assign(new Error('events'), { code: 'shape' });
      await post({ source, kind: 'events', complete: eventsBody.length < 100, items: extract.events(eventsBody) });
    }
  }

  return { HARD, SOURCES, isAllowedRead, buildUrl, formatLike, windowDates, extract, createLimiter, quiet, nextDelayMs, hashText, assertNoSecrets, runCycle };
});
