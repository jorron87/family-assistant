/* Familien – API-samler, sidedelen (MAIN world i Vigilo- og Spond-fanen).
 * Se collector-core.js for regler og begrensninger. Tokenet holdes bare i minnet her og forlater aldri siden. */
(function () {
  'use strict';
  const core = globalThis.FamilienCollectorCore;
  if (!core || globalThis.__familienCollector) return;
  const source = location.hostname === 'web-parent.prod.vigilo-oas.no' ? 'vigilo' : location.hostname === 'spond.com' ? 'spond' : null;
  if (!source) return;
  globalThis.__familienCollector = true;

  const apiOrigin = core.SOURCES[source].origin;
  const templates = {};
  let captured = null, capturedAt = 0, lastNudge = 0;
  const origFetch = window.fetch.bind(window);

  const jwtExpiry = (token) => {
    try { const part = token.split('.')[1]; return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch { return null; }
  };
  const bearerOf = (value) => { const match = /^Bearer\s+(\S{20,})$/i.exec(String(value ?? '')); return match ? match[1] : null; };

  function captureTemplate(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.origin !== apiOrigin) return;
      const path = parsed.pathname;
      if (source === 'vigilo') {
        if (path === '/api/news-feed') templates.news = parsed.toString();
        else if (path === '/api/message-threads') templates.threads = parsed.toString();
      } else if (!parsed.searchParams.has('groupId')) {
        if (path === '/core/v1/posts') templates.posts = parsed.toString();
        else if (path === '/core/v1/sponds') templates.events = parsed.toString();
      }
    } catch { /* ignoreres */ }
  }

  function seen(url, authorization) {
    const token = bearerOf(authorization);
    // The portal also uses relative fetch/XHR URLs. Resolve them against the
    // page before checking the exact origin, just as for list templates.
    let sameApi = false;
    try { sameApi = new URL(url, location.href || location.origin).origin === apiOrigin; } catch { /* no request URL */ }
    if (token && sameApi) { captured = token; capturedAt = Date.now(); }
    captureTemplate(url);
  }

  // Passiv observasjon av appens egne kall: nyeste token og malene for listekallene.
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const headers = new Headers(init?.headers ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
      seen(url, headers.get('authorization'));
    } catch { /* ignoreres */ }
    return origFetch(input, init);
  };
  const open = XMLHttpRequest.prototype.open, setHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) { this.__familienUrl = url; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try { if (/^authorization$/i.test(name)) seen(this.__familienUrl, value); } catch { /* ignoreres */ }
    return setHeader.apply(this, arguments);
  };

  // Fersk token: det nyeste av det appen sist brukte og OIDC-brukeren appen selv har lagret (standard oidc-client-nøkkel).
  function oidcToken() {
    try {
      for (const storage of [sessionStorage, localStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !key.startsWith('oidc.user:')) continue;
          const user = JSON.parse(storage.getItem(key));
          if (user?.access_token && (user.expires_at ?? 0) * 1000 > Date.now() + 60000) return user.access_token;
        }
      }
    } catch { /* ignoreres */ }
    return null;
  }

  function currentToken() {
    const expiry = captured ? jwtExpiry(captured) : null;
    // Spond's opaque credential has no locally readable expiry. Dropping it
    // after 45 minutes stopped collection in an otherwise authenticated idle
    // tab. Keep the app-observed credential in memory; actual 401/403 responses
    // still trigger the existing authentication pause. Known JWT expiry remains
    // authoritative, and Vigilo keeps its OIDC fallback/age limit.
    const usable = Number.isFinite(expiry) ? expiry > Date.now() + 60000 : source === 'spond' || Date.now() - capturedAt < 45 * 60000;
    const fromApp = captured && usable ? captured : null;
    const token = fromApp ?? (source === 'vigilo' ? oidcToken() : null);
    if (!token && Date.now() - lastNudge > 10 * 60000) {
      // Ber appen om å hente noe selv (den fornyer da tokenet). Bare vanlige fokus-hendelser.
      lastNudge = Date.now();
      try { document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); } catch { /* ignoreres */ }
    }
    return token;
  }

  // Bro til Familien-tjenesten via utvidelsen (lokal HTTP fra en https-side går ikke direkte).
  const pending = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data?.familienCollectorReply) return;
    const waiter = pending.get(event.data.id);
    if (waiter) { pending.delete(event.data.id); waiter(event.data); }
  });
  function server(path, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('server_timeout')); }, path==='/api/resources/receive'?90000:15000);
      pending.set(id, (reply) => { clearTimeout(timer); reply.ok ? resolve(reply.data) : reject(new Error(reply.error ? `server: ${reply.error}` : 'server_error')); });
      window.postMessage({ familienCollector: true, id, path, method, body }, location.origin);
    });
  }

  async function fetchJson(url) {
    const token = currentToken();
    if (!token) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
    const response = await origFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, credentials: url.startsWith(location.origin) ? 'same-origin' : 'omit', signal: AbortSignal.timeout(20000) });
    const retry = Number(response.headers.get('retry-after'));
    let json = null;
    if (response.ok) { try { json = await response.json(); } catch { json = null; } }
    return { status: response.status, json, retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined };
  }

  const stateKey = `familien.collector.${source}`;
  const loadState = () => { try { return JSON.parse(localStorage.getItem(stateKey)) ?? {}; } catch { return {}; } };
  const saveState = (state) => { try { localStorage.setItem(stateKey, JSON.stringify({ lastCycleAt: state.lastCycleAt, lastFullAt: state.lastFullAt, probeHash: state.probeHash, pausedUntil: state.pausedUntil, pauseKind: state.pauseKind, consecutiveFailures: state.consecutiveFailures })); } catch { /* ignoreres */ } };
  const resourceAttempts = new Map();
  async function fetchResources(config) {
    for(const item of (config.want?.resources ?? []).filter(item=>item.source===source)) {
      if(Date.now()-(resourceAttempts.get(item.id)??0)<3600000)continue;
      resourceAttempts.set(item.id,Date.now());
      try {
        const url=new URL(item.url), headers={};
        // Never send a portal's bearer token to an external attachment host.
        if(url.origin===apiOrigin) {const token=currentToken();if(!token)continue;headers.Authorization=`Bearer ${token}`;}
        const response=await origFetch(url.href,{method:'GET',headers,credentials:url.origin===location.origin?'same-origin':'omit',redirect:'follow',signal:AbortSignal.timeout(30000)});
        if(!response.ok || Number(response.headers.get('content-length'))>20*1024*1024)continue;
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>20*1024*1024)throw Error('file_too_large');chunks.push(chunk);}
        let binary='';for(const chunk of chunks)for(let start=0;start<chunk.length;start+=16384)binary+=String.fromCharCode(...chunk.subarray(start,start+16384));
        await server('/api/resources/receive','POST',{id:item.id,base64:btoa(binary),mimeType:response.headers.get('content-type')});
      } catch { /* visible error and original URL remain on the server */ }
    }
  }

  async function tick() {
    if (document.visibilityState === 'hidden' && !navigator.onLine) return;
    const config = await server('/api/collector/config').catch(() => null);
    if (!config?.enabled) return;
    const state = loadState();
        const result = await core.runCycle({
      source, config, templates, state, now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      token: currentToken, fetchJson, server, log: () => {}
    });
    saveState(state);
    if(!['unauthorized','backoff','paused'].includes(result.reason))await fetchResources(config);
    if(config.supplemental !== false && !['unauthorized','backoff','paused','no_token'].includes(result.reason)) {
      const extraKey=stateKey+'.extra';let extra;
      try{extra=JSON.parse(localStorage.getItem(extraKey))??{};}catch{extra={};}
      try{await globalThis.FamilienCollectorExtra?.run({source,state:extra,config,now:Date.now,fetchJson,server,sleep:ms=>new Promise(r=>setTimeout(r,ms))});}
      finally{localStorage.setItem(extraKey,JSON.stringify(extra));}
    }
    globalThis.__familienCollectorLast = { at: new Date().toISOString(), reason: result.reason, calls: result.calls, posted: result.posted };
  }

  // Bare én fane per kilde kjører samleren.
  function scheduled() {
    if (!navigator.locks) { tick().catch(() => {}); return; }
    navigator.locks.request(`familien-collector-${source}`, { ifAvailable: true }, async (lock) => { if (lock) await tick().catch(() => {}); });
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.data?.familienCollectorWake) scheduled();
  });
  setInterval(scheduled, 60000);
  setTimeout(scheduled, 15000);
})();
