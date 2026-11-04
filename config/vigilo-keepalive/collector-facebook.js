/* Familien – Facebook-grupper: passiv innsamling av innlegg og kommentarer i den åpne fanen (MAIN world, facebook.com/groups/*).
 * Ingen egne kall til Facebook. Vi leser (1) Relay-dataene som ligger i siden ved innlasting og (2) svarene appen selv får fra /api/graphql/ når feeden scroller.
 * Uttrekket søker etter Story-noder i stedet for faste stier, så små endringer i Facebooks oppsett ikke ødelegger det. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FamilienFacebook = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
  const first = (...values) => values.find((value) => value !== undefined && value !== null);

  // Finn første forekomst av en nøkkel (bredde først, begrenset dybde).
  function find(node, key, depth = 10) {
    const queue = [[node, 0]];
    while (queue.length) {
      const [current, d] = queue.shift();
      if (!current || typeof current !== 'object' || d > depth) continue;
      if (!Array.isArray(current) && current[key] !== undefined && current[key] !== null) return current[key];
      for (const child of Array.isArray(current) ? current : Object.values(current)) queue.push([child, d + 1]);
    }
    return undefined;
  }

  function commentsOf(story) {
    const found=new Map(),stack=[story];let visited=0;
    while(stack.length&&visited++<100000){
      const node=stack.pop();if(!node||typeof node!=='object')continue;
      const comment=node.comment ?? node;
      if(comment.id && (comment.__typename==='Comment'||comment.body?.text!==undefined||comment.preferred_body?.text!==undefined))found.set(comment.id,{
        id:str(comment.id,120),author:str(comment.author?.name,120),text:str(comment.body?.text??comment.preferred_body?.text??'',1000000)??'',
        time:Number.isFinite(comment.created_time)?comment.created_time:null,replies:Number.isFinite(comment.feedback?.total_reply_count)?comment.feedback.total_reply_count:null
      });
      for(const child of Object.values(node))if(child&&typeof child==='object')stack.push(child);
    }
    return [...found.values()];
  }

  function storyOf(node) {
    const postId = str(node.post_id, 40);
    const message = first(node.comet_sections?.content?.story?.message, node.message, find(node.comet_sections?.message_container, 'message'));
    const text = str(message?.text ?? '', 1000000) ?? '';
    const created = Number.isFinite(node.creation_time) ? node.creation_time : find(node, 'creation_time');
    if (!postId || !Number.isFinite(created)) return null;
    const attachments = Array.isArray(node.attachments) ? node.attachments : (node.comet_sections?.content?.story?.attachments ?? []);
    const total = find(node.comet_sections?.feedback ?? node, 'comment_rendering_instance')?.comments?.total_count;
    const url=str(first(node.wwwURL, node.comet_sections?.content?.story?.wwwURL, node.url), 400);
    let urlGroup=null;
    try {if(new URL(url).hostname.endsWith('.facebook.com'))urlGroup=groupFromPath(new URL(url).pathname);}catch{}
    const targetGroup=str(node.target_group?.id,40);
    return {
      postId, feedbackIds:[node.feedback?.id,node.comet_sections?.feedback?.story?.feedback?.id,find(node.comet_sections?.feedback,'feedback_target_with_context')?.id].filter(Boolean), id: str(node.id, 120), url, author: str(node.actors?.[0]?.name, 120),
      created, text, attachments: (Array.isArray(attachments) ? attachments : []).slice(0, 12).map((item) => str(item?.__typename ?? item?.style_type_renderer?.attachment?.__typename ?? 'attachment', 60)),
      commentCount: Number.isFinite(total) ? total : null, comments: commentsOf(node),
      groupId: targetGroup??urlGroup, groupProof:targetGroup?'target_group':urlGroup?'group_url':null
    };
  }

  // Samle Story-noder fra et JSON-tre (Relay-blob eller GraphQL-svar). Beholder den rikeste utgaven per innlegg.
  function extractStories(tree, into = new Map()) {
    const stack = [tree];
    let visited = 0;
    while (stack.length && visited++ < 400000) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) { for (const child of node) stack.push(child); continue; }
      if (node.__typename === 'Story' && node.post_id && (node.comet_sections || node.message)) {
        const story = storyOf(node);
        if (story) {
          const previous = into.get(story.postId);
          const score = (item) => item.text.length + item.comments.length * 50 + (item.url ? 10 : 0);
          if (!previous || score(story) >= score(previous)) into.set(story.postId, story);
        }
      }
      for (const child of Object.values(node)) if (child && typeof child === 'object') stack.push(child);
    }
    return into;
  }

  // Detached reply responses are linked only through an observed native feedback ID.
  function commentUpdates(tree, known, requestedId=null) {
    const out=new Map(),stack=[tree];let visited=0;
    const collect=(node,id)=>{const original=known.get(id);if(!original)return;const comments=commentsOf(node);if(!comments.length)return;const prior=out.get(original.postId)??original;const merged=new Map(prior.comments.map(c=>[c.id,c]));for(const c of comments)merged.set(c.id,c);out.set(original.postId,{...prior,comments:[...merged.values()]});};
    while(stack.length&&visited++<400000){const node=stack.pop();if(!node||typeof node!=='object')continue;if(known.has(node.id))collect(node,node.id);for(const child of Object.values(node))if(child&&typeof child==='object')stack.push(child);}
    if(!out.size&&known.has(requestedId))collect(tree.data??tree,requestedId);
    return out;
  }
  function requestedFeedback(body,known) {
    try {const values=typeof body==='string'?new URLSearchParams(body):body;const variables=JSON.parse(values?.get?.('variables')??'{}');const stack=[variables];while(stack.length){const value=stack.pop();if(typeof value==='string'&&known.has(value))return value;if(value&&typeof value==='object')stack.push(...Object.values(value));}}catch{}return null;
  }

  function parseChunks(text) {
    const trees = [];
    for (const line of String(text).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) continue;
      try { trees.push(JSON.parse(trimmed)); } catch { /* delvis linje */ }
    }
    return trees;
  }

  function extractEvents(tree, into=new Map()) {
    const stack=[tree];let count=0;
    while(stack.length&&count++<400000){const node=stack.pop();if(!node||typeof node!=='object')continue;
      if(node.__typename==='Event'&&/^\d+$/.test(node.id??'')&&(node.name||node.event_title)){
        const start=node.start_timestamp??node.start_time,end=node.end_timestamp??node.end_time;
        into.set(node.id,{eventId:node.id,title:node.name??node.event_title,text:node.description?.text??node.event_description?.text??'',start:Number.isFinite(start)?start:null,end:Number.isFinite(end)?end:null,url:node.url??`https://www.facebook.com/events/${node.id}/`,location:node.event_place?.name??node.place?.name??null,cancelled:node.is_canceled===true||node.is_cancelled===true,detailsComplete:false});
      }
      for(const value of Object.values(node))if(value&&typeof value==='object')stack.push(value);
    }return into;
  }

  const groupFromPath = (pathname) => (String(pathname).match(/^\/groups\/([^/?#]+)/) ?? [])[1] ?? null;
  const toItem = (story) => ({ postId: story.postId, url: story.url, author: story.author, created: story.created, text: story.text, attachments: story.attachments, commentCount: story.commentCount, comments: story.comments, groupId: story.groupId, groupProof:story.groupProof });

  // Ruller feeden i små, litt tilfeldige steg til det ikke kommer flere innlegg. env: { scroll(), sleep(ms), count(), random() }
  async function autoScroll(env, { maxScrolls = 14, patience = 3 } = {}) {
    let steps = 0, stagnant = 0, last = env.count();
    while (steps < maxScrolls && stagnant < patience) {
      env.scroll();
      await env.sleep(1500 + Math.round(env.random() * 1500));
      steps++;
      const now = env.count();
      if (now === last) stagnant++; else { stagnant = 0; last = now; }
    }
    return { steps, stories: env.count(), stalled: stagnant >= patience && env.count() <= 1 };
  }

  // Tidsluke som skal kjøres nå: første «HH:MM» (norsk tid) som er passert de siste tre timene og ikke er utført i dag.
  function dueSlot(times, done, day, hm) {
    const minutes = (value) => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
    const current = minutes(hm);
    // Siste forfalte luke vinner (bakgrunnsskriptet har en identisk kopi).
    return (times ?? []).filter((slot) => current >= minutes(slot) && current < minutes(slot) + 180 && done?.[slot] !== day).pop() ?? null;
  }

  return { commentUpdates, requestedFeedback, extractStories, extractEvents, parseChunks, groupFromPath, toItem, storyOf, autoScroll, dueSlot };
});

(function () {
  'use strict';
  const core = globalThis.FamilienFacebook;
  if (typeof window === 'undefined' || !core || globalThis.__familienFacebook) return;
  if (location.hostname !== 'www.facebook.com') return;
  globalThis.__familienFacebook = true;

  const seenIds = new Set();
  const sent = new Map();          // postId -> signatur som sist ble sendt
  const knownFeedback=new Map();
  const pendingItems = new Map();  // postId -> {story, groupId}
  let timer = null, lastScan = '';
  let targets=[];

  const pending = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.familienCollectorReply) return;
    const waiter = pending.get(event.data.id);
    if (waiter) { pending.delete(event.data.id); waiter(event.data); }
  });
  function server(path, method, body) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('server_timeout')); }, 15000);
      pending.set(id, (reply) => { clearTimeout(timeout); reply.ok ? resolve(reply.data) : reject(new Error('server_error')); });
      window.postMessage({ familienCollector: true, id, path, method, body }, location.origin);
    });
  }
  server('/api/collector/config','GET').then(config=>{targets=config.facebook?.targets??[];lastScan='';scanEmbedded();}).catch(()=>{});
  function context(){const group=core.groupFromPath(location.pathname);if(group)return group;const target=targets.find(t=>{try{const u=new URL(t.url);return u.pathname.replace(/\/$/,'')===location.pathname.replace(/\/$/,'')&&(!u.searchParams.get('id')||u.searchParams.get('id')===new URL(location.href).searchParams.get('id'));}catch{return false;}});return target?.id??null;}
  const eventSent=new Map();
  function queueEvents(events){const groupId=context();if(!groupId)return;const items=[...events.values()].filter(e=>eventSent.get(e.eventId)!==JSON.stringify(e));if(!items.length)return;server('/api/collector','POST',{source:'facebook',kind:'events',groupId,pageUrl:location.href,items}).then(()=>{for(const e of items)eventSent.set(e.eventId,JSON.stringify(e));}).catch(()=>{});}

  const signature = (story) => JSON.stringify([story.text,story.attachments,story.comments,story.commentCount]);

  function queue(stories) {
    const pageGroup = context();
    const strictGroup=core.groupFromPath(location.pathname);
    for (const story of stories.values()) {
      // Relay responses also contain recommendations and posts from unrelated
      // feeds. A group tab alone is not evidence that a Story belongs to it.
      if(strictGroup && story.groupId!==strictGroup)continue;
      const groupId = story.groupId ?? pageGroup;
      if (!groupId) continue;
      seenIds.add(story.postId);
      story.groupId=groupId;for(const id of story.feedbackIds??[])knownFeedback.set(id,story);
      if (sent.get(story.postId) === signature(story)) continue;
      pendingItems.set(story.postId, { story, groupId });
    }
    if (pendingItems.size && !timer) timer = setTimeout(flush, 2500);
  }

  async function flush() {
    timer = null;
    const byGroup = new Map();
    for (const { story, groupId } of pendingItems.values()) (byGroup.get(groupId) ?? byGroup.set(groupId, []).get(groupId)).push(story);
    const batch = [...pendingItems.values()];
    pendingItems.clear();
    for (const [groupId, stories] of byGroup) {
      try {
        await server('/api/collector', 'POST', { source: 'facebook', kind: 'posts', groupId, pageUrl:location.href,complete: false, items: stories.map(core.toItem) });
        for (const story of stories) sent.set(story.postId, signature(story));
      } catch {
        for (const { story, groupId: id } of batch) if (id === groupId) pendingItems.set(story.postId, { story, groupId: id });
        setTimeout(() => { if (!timer) timer = setTimeout(flush, 30000); }, 0);
      }
    }
  }

  function scanEmbedded() {
    const scripts = document.querySelectorAll('script[type="application/json"]');
    const key = `${location.pathname}|${scripts.length}`;
    if (key === lastScan) return;
    lastScan = key;
    const stories = new Map(),events=new Map();
    for (const script of scripts) {
      const text = script.textContent;
      if (!text || !/creation_time|start_timestamp|event_title/.test(text)) continue;
      try {const tree=JSON.parse(text);core.extractStories(tree, stories);core.extractEvents(tree,events);} catch { /* ikke gyldig JSON */ }
    }
    if (stories.size) queue(stories);
    if(events.size)queueEvents(events);
  }

  // Appens egne GraphQL-svar (scrolling, paginering). Bare lesing av svaret, ingen egne kall.
  function onGraphql(text,requestBody) {
    try {
      if (!/creation_time|created_time|start_timestamp|event_title|Comment/.test(String(text))) return;
      const stories = new Map(),events=new Map();
      for (const tree of core.parseChunks(text)) {core.extractStories(tree, stories);core.extractEvents(tree,events);for(const [id,story] of core.commentUpdates(tree,knownFeedback,core.requestedFeedback(requestBody,knownFeedback)))stories.set(id,story);}
      if (stories.size) queue(stories);
      if(events.size)queueEvents(events);
    } catch { /* ignoreres */ }
  }
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : input?.url;
      if (/\/api\/graphql\/?/.test(url ?? '')) promise.then((response) => response.clone().text().then(text=>onGraphql(text,init?.body))).catch(() => {});
    } catch { /* ignoreres */ }
    return promise;
  };
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.__familienFbUrl = String(url); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    if (/\/api\/graphql\/?/.test(this.__familienFbUrl ?? '')) {const requestBody=arguments[0];this.addEventListener('load', () => onGraphql(this.responseText,requestBody));}
    return send.apply(this, arguments);
  };

  // Bestilt fra utvidelsen: rull feeden så appen laster flere innlegg (vi leser bare svarene den selv får).
  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data?.familienFbScroll) return;
    const { id, maxScrolls } = event.data;
    scanEmbedded();
    const result = await core.autoScroll({
      scroll: () => window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'instant' }),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), count: () => seenIds.size, random: Math.random
    }, { maxScrolls: Math.min(Math.max(Number(maxScrolls) || 12, 1), 30) });
    if (timer) { clearTimeout(timer); await flush(); } else if (pendingItems.size) await flush();
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.postMessage({ familienFbScrollReply: true, id, result }, location.origin);
  });

  document.addEventListener('DOMContentLoaded', scanEmbedded);
  setInterval(scanEmbedded, 5000);
  setTimeout(scanEmbedded, 3000);
})();
