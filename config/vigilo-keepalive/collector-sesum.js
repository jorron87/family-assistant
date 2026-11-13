/* Familien – read-only Sesum collection in the page's normal browser session.
 * No cookies, application storage, authorization headers or Supabase keys are
 * read. Only explicitly parsed public product/price fields leave the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.FamilienSesumCollector = api; api.install(root); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ORIGIN = 'https://www.sesum.no';
  const WORK = '/api/shopping/sesum/work', RECEIVE = '/api/shopping/sesum/receive';
  const VERSION = 'sesum-collector-1.9.1';
  const BUILD = 'sesum-collector-build-1.9.1-1';
  // The background alarm repairs the bridge every minute. Page ticks advance
  // the bounded durable queue more often; the server still controls spacing
  // and each batch has at most eight reads. Running/Locks prevent overlaps.
  const TICK_MS = 20000;
  const MAX_BYTES = 12 * 1024 * 1024;
  const MAX_RECEIPT_BYTES = 5 * 1024 * 1024; // Below the localhost JSON request limit.
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
  function allowedUrl(value, kind) {
    try {
      if (typeof value !== 'string' || value.length > 4096) return false;
      const url = new URL(value);
      if (url.origin !== ORIGIN || url.username || url.password || url.hash) return false;
      if (kind === 'product') return /^\/produkt\/[1-9]\d*(?:-[^/?#]+)?\/?$/.test(url.pathname) && !url.search;
      if (kind === 'catalogue') {
        if (!/^\/kategori(?:\/[1-9]\d*(?:-[^/?#]+)?)?\/?$/.test(url.pathname)) return false;
        for (const [key,val] of url.searchParams) if (!['side','page','visning'].includes(key) || (key==='visning'?val!=='alle':!/^[1-9]\d{0,7}$/.test(val)) || url.searchParams.getAll(key).length !== 1) return false;
        return true;
      }
      if (kind !== 'search' || url.pathname !== '/sok' || !url.searchParams.get('q')?.trim() || url.searchParams.get('q').length > 250 || url.searchParams.getAll('q').length !== 1) return false;
      for (const [key,item] of url.searchParams) {
        if (!['q','page','side','offset','limit','cursor'].includes(key) || item.length > 2000) return false;
        if (['page','side','offset','limit'].includes(key) && !/^\d{1,9}$/.test(item)) return false;
      }
      return true;
    } catch { return false; }
  }
  function retryDelay(value, at) {
    const seconds = Number(value), date = Date.parse(value);
    return Math.min(86400000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - at : 0));
  }
  function receiptSize(value) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  async function readHtml(response) {
    if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw Object.assign(new Error('oversized_response'), {code:'oversized_response'});
    if (!/\btext\/html\b/i.test(response.headers?.get('content-type') ?? '')) throw Object.assign(new Error('unexpected_content_type'), {code:'unexpected_content_type'});
    if (!response.body?.getReader) {
      const html = await response.text();
      if (new TextEncoder().encode(html).length > MAX_BYTES) throw Object.assign(new Error('oversized_response'), {code:'oversized_response'});
      return html;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, html = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw Object.assign(new Error('oversized_response'), {code:'oversized_response'});
        html += decoder.decode(chunk.value, {stream:true});
      }
      return html + decoder.decode();
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  async function runCycle({core, server, fetchPage, state, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
    if (state.pausedUntil > now()) return {reason:'paused', calls:0, posted:0};
    const work = await server(WORK, 'GET');
    if (!work?.enabled) return {reason:'disabled', calls:0, posted:0};
    const remotePause = Date.parse(work.pauseUntil ?? '');
    if (remotePause > now()) { state.pausedUntil = remotePause; return {reason:'paused', calls:0, posted:0}; }
    if (!validId(work.runId) || !Array.isArray(work.jobs)) return {reason:'invalid_work', calls:0, posted:0};
    const budget = Math.min(8, Math.max(1, Math.trunc(Number(work.limits?.cycleCalls) || 4)));
    const spacing = Math.min(30000, Math.max(1500, Number(work.limits?.minSpacingMs) || 1500));
    let calls = 0, posted = 0;
    for (const job of work.jobs.slice(0, budget)) {
      if (!validId(job?.id) || !allowedUrl(job.url, job.kind)) {
        if (validId(job?.id)) { await server(RECEIVE, 'POST', {runId:work.runId,jobId:job.id,collectorVersion:VERSION,collectorBuild:BUILD,status:'error',fetchedAt:new Date(now()).toISOString(),error:{code:'invalid_job',message:'Unsupported Sesum read job.'}}); posted++; }
        continue;
      }
      const wait = (state.lastCallAt ?? -Infinity) + spacing - now();
      if (wait > 0) await sleep(wait);
      state.lastCallAt = now(); calls++;
      let result = null, error = null, status = 'ok', pause = 0;
      try {
        const response = await fetchPage(job.url, {method:'GET',credentials:job.publicCatalogue===true?'omit':'same-origin',redirect:'error',headers:{Accept:'text/html'},signal:AbortSignal.timeout(25000)});
        if (!response.ok) {
          const code = response.status === 401 || response.status === 403 ? 'auth_required' : response.status === 429 ? 'rate_limited' : `http_${response.status}`;
          pause = code === 'auth_required' ? 10 * 60000 : code === 'rate_limited' ? Math.max(30 * 60000, retryDelay(response.headers?.get('retry-after'), now())) : response.status >= 500 ? 5 * 60000 : 0;
          throw Object.assign(new Error(code), {code});
        }
        if (response.url && !allowedUrl(response.url, job.kind)) throw Object.assign(new Error('unexpected_response_url'), {code:'unexpected_response_url'});
        const html = await readHtml(response);
        result = job.kind === 'product' ? core.parseProduct(html, job.url) : job.kind === 'catalogue' ? core.parseCatalogue(html, job.url) : core.parseSearch(html, job.url);
        if (!result?.ok || result.kind !== job.kind) { status = 'partial'; error = {code:'unrecognized_schema',message:'Sesum response could not be completely parsed.'}; }
      } catch (failure) {
        status = 'error';
        const code = typeof failure?.code === 'string' && /^[a-z0-9_]{1,60}$/.test(failure.code) ? failure.code : 'network_error';
        error = {code,message:code === 'auth_required' ? 'Normal Sesum access must be restored in the browser.' : 'Sesum read failed; no price receipt was inferred.'};
        if (!pause && ['network_error','unexpected_content_type','unexpected_response_url','oversized_response'].includes(code)) pause = 5 * 60000;
      }
      if (pause) { state.pausedUntil = now() + pause; error.retryAfterMs = pause; }
      let envelope = {runId:work.runId,jobId:job.id,collectorVersion:VERSION,collectorBuild:BUILD,status,fetchedAt:new Date(now()).toISOString(),...(result ? {result} : {}),...(error ? {error} : {})};
      if (receiptSize(envelope) > MAX_RECEIPT_BYTES) {
        pause = 5 * 60000;state.pausedUntil = now() + pause;
        error = {code:'oversized_receipt',message:'Parsed Sesum response exceeds the local receipt limit; no list or price was truncated.',retryAfterMs:pause};
        envelope = {runId:work.runId,jobId:job.id,collectorVersion:VERSION,collectorBuild:BUILD,status:'error',fetchedAt:new Date(now()).toISOString(),error};
      }
      // A failed localhost receipt stops this cycle. The server owns job IDs and
      // accepts repeated receipts idempotently, so cursor progress is never guessed.
      await server(RECEIVE, 'POST', envelope);
      posted++;
      if (pause) return {reason:error.code,calls,posted};
    }
    return {reason:work.jobs.length ? 'collected' : 'idle',calls,posted};
  }
  function install(root) {
    if (root.location?.origin !== ORIGIN || !root.FamilienSesumCore) return;
    if (root.__familienSesumCollector === VERSION && root.__familienSesumCollectorBuild === BUILD) return;
    root.__familienSesumStop?.();
    const state = {}, pending = new Map(), fetchPage = root.fetch.bind(root);
    let running = false, stopped = false, owner = false, ownershipPending = false, releaseOwner = null;
    const reply = event => {
      if (event.source !== root || !event.data?.familienCollectorReply) return;
      const finish = pending.get(event.data.id);
      if (finish) { pending.delete(event.data.id); finish(event.data); }
    };
    const server = (path, method, body) => new Promise((resolve, reject) => {
      const id = 'sesum-' + Math.random().toString(36).slice(2);
      const timer = root.setTimeout(() => {pending.delete(id);reject(new Error('local_timeout'));},15000);
      pending.set(id, value => {root.clearTimeout(timer);value.ok ? resolve(value.data) : reject(new Error('local_receipt_failed'));});
      root.postMessage({familienCollector:true,id,path,method,...(body ? {body} : {})},ORIGIN);
    });
    const claimOwnership = () => {
      if (stopped || owner || ownershipPending) return;
      if (!root.navigator?.locks) { owner = true; void tick(); return; }
      ownershipPending = true;
      // Hold the existing origin lock for this worker's lifetime. Older workers
      // take it per cycle, so they also yield to this owner without remote reads.
      void root.navigator.locks.request('familien-sesum-collector',{ifAvailable:true},async lock => {
        if (!lock || stopped) return;
        owner = true;
        try { await new Promise(resolve => {releaseOwner=resolve;if(stopped)resolve();else void tick();}); }
        finally {owner=false;releaseOwner=null;}
      }).catch(() => {}).finally(() => {ownershipPending=false;});
    };
    const tick = async () => {
      if (running || stopped || root.navigator?.onLine === false) return;
      if (!owner) {claimOwnership();return;}
      running = true;let advance=false;
      try {
        const run = async () => {
          if (stopped) return;
          const outcome = await runCycle({core:root.FamilienSesumCore,server,fetchPage,state});
          advance=outcome.reason==='collected'&&outcome.calls>0;
          root.__familienSesumLast = {at:new Date().toISOString(),implementation:VERSION,build:BUILD,...outcome};
        };
        await run();
      } catch { root.__familienSesumLast = {at:new Date().toISOString(),implementation:VERSION,build:BUILD,reason:'local_unavailable'}; }
      finally { running = false;if(advance&&!stopped)root.setTimeout(tick,0); }
    };
    const wake = event => {if(event.source === root && event.data?.familienCollectorWake) void tick();};
    root.addEventListener('message',reply); root.addEventListener('message',wake);
    const timer = root.setInterval(tick,TICK_MS);
    root.__familienSesumCollector = VERSION;
    root.__familienSesumCollectorBuild = BUILD;
    root.__familienSesumStop = () => {stopped=true;releaseOwner?.();root.clearInterval(timer);root.removeEventListener('message',reply);root.removeEventListener('message',wake);delete root.__familienSesumCollector;delete root.__familienSesumCollectorBuild;};
    root.setTimeout(tick,3000);
  }
  return {VERSION,BUILD,TICK_MS,ORIGIN,WORK,RECEIVE,allowedUrl,retryDelay,readHtml,runCycle,install};
});
