const local = 'http://127.0.0.1:4318/api/session-maintenance';
const alarmName = 'vigilo-session';
const origin = 'https://web-parent.prod.vigilo-oas.no';
let running;

function pageKind(value) {
  try {
    const url = new URL(value);
    if (url.origin !== origin) return 'other';
    if (/^\/(news|messages)\/?$/.test(url.pathname)) return 'content';
    if (/^\/login(?:\/|$)/.test(url.pathname)) return 'login';
    return 'other';
  } catch { return 'other'; }
}

// Isolated extension world: only DOM booleans and our own probe times leave the
// page. No app state, cookies, browser storage, credentials or URLs are read.
function inspectPage() {
  const visible = element => !!element?.getClientRects().length;
  const menu = [...document.querySelectorAll('[aria-label="Brukermeny"],[aria-label="User menu"]')].some(visible);
  const children = [...document.querySelectorAll('[role="radio"],input[type="radio"]')].some(visible);
  const now = Date.now();
  const previous = globalThis.__familienSessionProbeAt;
  globalThis.__familienSessionProbeAt = now;
  return {
    authenticated: menu && children,
    ready: document.readyState === 'complete', online: navigator.onLine,
    focused: document.hasFocus(), wasDiscarded: document.wasDiscarded === true,
    pageAgeMs: Math.max(0, now - performance.timeOrigin),
    probeGapMs: previous ? now - previous : null,
  };
}

// Vigilo can finish authentication on /login with only “Du er pålogget.”
// visible. The URL alone does not mean the session has expired. Return this
// explicit success page to the app; never touch a real sign-in form.
function inspectLoginLanding() {
  const visible = element => !!element?.getClientRects().length;
  return {
    signedIn: /(?:^|\n)\s*Du er pålogget\.?\s*(?:\n|$)/i.test(document.body?.innerText ?? ''),
    form: [...document.querySelectorAll('input,textarea,[contenteditable="true"]')].some(visible),
    ready: document.readyState === 'complete', online: navigator.onLine,
  };
}
const loginReturnAttempts = new Map();
async function returnFromLoginLanding(tabs) {
  for (const tab of tabs) {
    if (pageKind(tab.url) !== 'login' || new URL(tab.url).pathname !== '/login' || tab.discarded || tab.frozen || tab.status === 'loading') continue;
    const attemptedAt = loginReturnAttempts.get(tab.id);
    if (attemptedAt !== undefined && Date.now() - attemptedAt < 3600000) continue;
    let probe;
    try { probe = (await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},func:inspectLoginLanding})))[0]?.result; }
    catch { continue; }
    if (!probe?.signedIn || probe.form || !probe.ready || !probe.online) continue;
    loginReturnAttempts.set(tab.id, Date.now());
    await chrome.tabs.update(tab.id, {url:`${origin}/news`,pinned:true,autoDiscardable:false});
    await report('checking','returning_to_content',{tabCount:tabs.length,keeperTabId:tab.id,keeperProtected:true});
    return true;
  }
  return false;
}

async function report(health, code, diagnostics = {}) {
  // A stopped local service must not stop protection of the Chrome tab.
  const badge = health === 'needs_login' ? '!' : health === 'error' ? '?' : health === 'checking' ? '…' : '';
  await chrome.action.setBadgeText({text: badge});
  await chrome.action.setTitle({title: health === 'needs_login' ? 'Vigilo: åpne fanen og logg inn' : 'Familien: Vigilo-øktkontroll'});
  try {
    const response = await fetch(local, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({health, code, version:chrome.runtime.getManifest().version, intervalSeconds:60, ...diagnostics}),
      signal:AbortSignal.timeout(4000)});
    if (!response.ok) throw new Error('local_report_failed');
  } catch {
    await chrome.action.setBadgeText({text: health === 'needs_login' ? '!' : '?'});
    await chrome.action.setTitle({title:'Vigilo-kontroll: lokal statusrapport kunne ikke leveres'});
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(alarmName);
  if (alarm?.periodInMinutes !== 1) await chrome.alarms.create(alarmName, {periodInMinutes:1});
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('inspection_timeout')),8000);
    })]);
  } finally { clearTimeout(timer); }
}

// Extension upgrades invalidate the old isolated-world bridge while leaving
// the logged-in page and MAIN-world collector alive. Repair scripts in place;
// never reload a healthy portal or replace its per-tab login session.
async function wakeCollector(tabId) {
  if (!chrome.tabs.sendMessage) return;
  let bridge;
  try { bridge = await bounded(chrome.tabs.sendMessage(tabId, {type:'familien-collector-ping'})); } catch { /* missing/orphaned bridge */ }
  if (!bridge?.ok) await chrome.scripting.executeScript({target:{tabId},files:['collector-bridge.js']});
  const [main] = await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:() => globalThis.__familienCollector === true});
  if (!main?.result) await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['collector-core.js','collector-extra.js','collector-main.js']});
  await bounded(chrome.tabs.sendMessage(tabId, {type:'familien-collector-wake'}));
}
let vigiloWakeAt = 0;

async function tick() {
  const tabs = await chrome.tabs.query({url:`${origin}/*`});
  const pages = tabs.filter(tab => pageKind(tab.url) === 'content').sort((a,b) => Number(b.pinned)-Number(a.pinned));
  let loading = false, discarded, frozen = false, inspectionFailed = false;
  for (const tab of pages) {
    if (tab.discarded) { discarded ??= tab; continue; }
    if (tab.frozen) { frozen = true; continue; }
    if (tab.status === 'loading') { loading = true; continue; }
    let probe;
    try {
      const results = await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},func:inspectPage}));
      probe = results[0]?.result;
    } catch { inspectionFailed = true; continue; }
    if (!probe?.authenticated) { loading ||= !probe?.ready; continue; }
    // Keep the real logged-in tab. A new URL tab does not inherit its per-tab
    // OIDC session. Leave normal renewal to Vigilo instead of resetting timers.
    if (!tab.pinned || tab.autoDiscardable !== false) {
      await chrome.tabs.update(tab.id, {pinned:true,autoDiscardable:false});
    }
    await report(probe.online ? 'ok' : 'error', probe.online ? 'authenticated' : 'offline', {
      tabCount:tabs.length, keeperTabId:tab.id, keeperProtected:true, focused:probe.focused,
      wasDiscarded:probe.wasDiscarded, pageAgeMs:probe.pageAgeMs, probeGapMs:probe.probeGapMs,
    });
    if (probe.online && Date.now() - vigiloWakeAt > 300000) {
      try { await wakeCollector(tab.id); vigiloWakeAt = Date.now(); } catch { /* source collector freshness reports a failed recovery */ }
    }
    return;
  }
  if (!pages.length && await returnFromLoginLanding(tabs)) return;
  if (discarded && !loading) {
    // Already unloaded: no in-progress text can be lost. Verify on a later tick.
    await chrome.tabs.update(discarded.id, {pinned:true,autoDiscardable:false});
    await chrome.tabs.reload(discarded.id);
    await report('checking','restoring_discarded',{tabCount:tabs.length});
  } else if (loading) await report('checking','loading',{tabCount:tabs.length});
  else if (frozen) await report('error','tab_frozen',{tabCount:tabs.length});
  else if (inspectionFailed) await report('error','inspection_failed',{tabCount:tabs.length});
  else if (pages.length) await report('error','unrecognized_page',{tabCount:tabs.length});
  else if (tabs.some(tab=>pageKind(tab.url)==='login')) await report('needs_login','login_required',{tabCount:tabs.length});
  else if (tabs.length) await report('checking','other_page',{tabCount:tabs.length});
  else await report('needs_login','no_tab',{tabCount:0});
}

// Only visible DOM booleans: never inspect app credentials or storage.
function inspectSpondPage() {
  const visible = element => !!element.getClientRects().length;
  const buttons = [...document.querySelectorAll('button')].filter(visible);
  const authenticated = buttons.some(el => /Hjem/.test(el.innerText)) && buttons.some(el => /Meldinger/.test(el.innerText)) && [...document.querySelectorAll('[role="menu"]')].some(visible);
  const drafts = [...document.querySelectorAll('input:not([type="hidden"]),textarea,[contenteditable="true"]')].some(el => String(el.value ?? el.textContent ?? '').trim());
  return {authenticated, ready:document.readyState === 'complete', online:navigator.onLine, focused:document.hasFocus(), drafts, dialog:[...document.querySelectorAll('[role="dialog"]')].some(visible)};
}

async function recoverSpond(tab) {
  if (!chrome.storage?.local || tab.status === 'loading' || tab.frozen) return;
  let status;
  try {
    const response = await fetch('http://127.0.0.1:4318/api/collector/status', {signal:AbortSignal.timeout(4000)});
    if (!response.ok) return;
    status = (await response.json()).sources?.spond;
  } catch { return; }
  const key = 'spondSessionRecovery';
  const saved = (await chrome.storage.local.get(key))[key] ?? {};
  const health = status?.health;
  if (health?.health === 'ok' && Date.parse(health.at) > (saved.at ?? 0)) {
    if (saved.active) await chrome.storage.local.set({[key]:{...saved,active:false}});
    return;
  }
  // One recovery per failure episode, at most once per hour. New error
  // timestamps from repeated rejected retries do not authorize more reloads.
  const age = Date.now() - Date.parse(health?.at);
  if (health?.health !== 'unauthorized' || !Number.isFinite(age) || age < 0 || age > 30*60000 || saved.active || Date.now() - (saved.at ?? 0) < 3600000) return;
  const [probe] = await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},func:inspectSpondPage}));
  const page = probe?.result;
  if (!page?.authenticated || !page.ready || !page.online || page.focused || page.drafts || page.dialog) return;
  // Reload the existing idle app once so its normal authenticated startup
  // supplies a current credential. Do not bypass collector backoff or login.
  await chrome.storage.local.set({[key]:{active:true,at:Date.now(),failureAt:health.at}});
  await chrome.tabs.reload(tab.id);
}

// Spond-samleren kjører i en spond.com-fane. Hold én festet fane åpen, uten auto-forkasting, og gjenåpne den hvis den er borte.
async function spondKeeper() {
  const tabs = (await chrome.tabs.query({url: 'https://spond.com/*'})).filter(t => String(t.url).startsWith('https://spond.com/'));
  const tab = tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned))[0];
  if (!tab) { await chrome.tabs.create({url: 'https://spond.com/client', active: false, pinned: true}); return; }
  if (!tab.pinned || tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, {pinned: true, autoDiscardable: false});
  if (tab.discarded) await chrome.tabs.reload(tab.id);
  else { await wakeCollector(tab.id).catch(() => {}); await recoverSpond(tab); }
}
let spondCheckedAt = 0;

function requestTick() {
  running ??= (async () => {
    try { await ensureAlarm(); await tick(); if (Date.now() - spondCheckedAt > 300000) { spondCheckedAt = Date.now(); await spondKeeper().catch(() => {}); } }
    catch { await report('error','extension_error').catch(()=>{}); }
  })().finally(()=>{running=undefined;});
  return running;
}
chrome.runtime.onInstalled.addListener(requestTick);
chrome.runtime.onStartup.addListener(requestTick);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===alarmName) void requestTick();});
chrome.action.onClicked.addListener(requestTick);
// MV3 workers restart independently of Chrome. Repair missing alarms on wake.
void ensureAlarm().catch(()=>{});

// ---- API-samler: relé fra sidene til Familien-tjenesten ----
// Bare disse to lokale kallene slippes gjennom, og bare fra Vigilo- og Spond-faner.
const collectorLocal = 'http://127.0.0.1:4318';
const collectorAllowed = (path, method) => (method === 'GET' && path === '/api/collector/config') || (method === 'POST' && ['/api/collector','/api/resources/receive'].includes(path));
const collectorOrigins = new Set(['https://web-parent.prod.vigilo-oas.no', 'https://spond.com', 'https://www.facebook.com']);
// Sesum can submit only its read observations. It cannot reach school intake,
// original files, catalog approvals, family settings or cart operations.
const sesumRelayAllowed = (path, method) => method === 'GET' && path === '/api/shopping/sesum/work' || method === 'POST' && path === '/api/shopping/sesum/receive';
chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'familien-collector') return false;
  let origin = '';
  try { origin = new URL(sender.tab?.url ?? '').origin; } catch { /* ingen fane */ }
  const allowed = origin === 'https://www.sesum.no' ? sender.frameId === 0 && sesumRelayAllowed(message.path,message.method) : collectorOrigins.has(origin) && collectorAllowed(message.path,message.method);
  if (!allowed) { sendResponse({ok: false}); return false; }
  (async () => {
    try {
      const response = await fetch(collectorLocal + message.path, {
        method: message.method,
        headers: message.method === 'POST' ? {'Content-Type': 'application/json', 'X-Family-Request': '1'} : {},
        body: message.method === 'POST' ? JSON.stringify(message.body ?? {}) : undefined,
        signal: AbortSignal.timeout(message.path==='/api/resources/receive'?90000:15000)
      });
      sendResponse({ok: response.ok, data: await response.json().catch(() => null)});
    } catch { sendResponse({ok: false}); }
  })();
  return true;
});

// ---- Facebook: planlagt sveip (åpner/gjenbruker en festet fane, ruller gruppene, og går tilbake til fanen du var på) ----
// Feeden laster bare mens fanen er synlig, så fanen aktiveres kort. Standardtidene er tidlig morgen og sen kveld (config/collector.json).
let facebookRunning = false;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const osloNow = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date());
  const get = type => parts.find(part => part.type === type).value;
  return {day: get('year') + '-' + get('month') + '-' + get('day'), hm: get('hour') + ':' + get('minute')};
};
const dueSlot = (times, done, day, hm) => {
  const minutes = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
  // Siste forfalte luke vinner; tidligere forfalte luker samme dag kvitteres ut av kalleren, så et tett program ikke gir sveip på rad.
  return (times ?? []).filter(slot => minutes(hm) >= minutes(slot) && minutes(hm) < minutes(slot) + 180 && done?.[slot] !== day).pop() ?? null;
};
async function waitForTab(tabId, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const tab = await chrome.tabs.get(tabId); if (tab.status === 'complete') return true; await wait(500); }
  return false;
}
async function facebookSweep(config) {
  const [previous] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  let tab = (await chrome.tabs.query({url: 'https://www.facebook.com/groups/*'})).find(candidate => candidate.pinned);
  const created = !tab;
  if (created) tab = await chrome.tabs.create({url: 'about:blank', active: false, pinned: true});
  const results = [];
  try {
    for (const {id,url} of config.targets ?? config.groups.map(id=>({id,url:'https://www.facebook.com/groups/' + id + '/?sorting_setting=CHRONOLOGICAL'}))) {
      await chrome.tabs.update(tab.id, {url, active: true});
      try { await chrome.windows.update(tab.windowId, {focused: true}); } catch { /* vinduet kan ikke fokuseres */ }
      await waitForTab(tab.id, 30000);
      await wait(4000);
      let outcome;
      try { outcome = await Promise.race([chrome.tabs.sendMessage(tab.id, {type: 'familien-fb-scroll', maxScrolls: config.maxScrolls}), wait(110000).then(() => ({timeout: true, stalled: true}))]); }
      catch { outcome = {stalled: true, error: true}; }
      results.push({id, ...(outcome ?? {stalled: true})});
      await wait(3000 + Math.random() * 3000);
    }
  } finally {
    if (created) await chrome.tabs.remove(tab.id).catch(() => {});
    if (previous?.id) {
      await chrome.tabs.update(previous.id, {active: true}).catch(() => {});
      if (previous.windowId) await chrome.windows.update(previous.windowId, {focused: true}).catch(() => {});
    }
  }
  const stalled = results.filter(result => result.stalled).length;
  await fetch('http://127.0.0.1:4318/api/collector', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Family-Request': '1'},
    body: JSON.stringify({source: 'facebook', kind: 'health', health: stalled === results.length ? 'stalled' : 'ok', detail: 'sveip ' + results.map(result => String(result.id).slice(-4) + ':' + (result.stories ?? 0) + '/' + (result.steps ?? 0)).join(' ')}),
    signal: AbortSignal.timeout(4000)}).catch(() => {});
}
async function facebookTick() {
  if (facebookRunning || !chrome.storage?.local || !chrome.windows || !chrome.tabs?.sendMessage) return;
  let config;
  try { config = (await (await fetch('http://127.0.0.1:4318/api/collector/config', {signal: AbortSignal.timeout(4000)})).json()).facebook; } catch { return; }
  if (!config?.enabled || !config.groups?.length) return;
  const {day, hm} = osloNow();
  const done = (await chrome.storage.local.get('facebookDone')).facebookDone ?? {};
  // Bestilt manuelt (node src/cli.mjs facebook-sweep) eller tidsluke som er passert i dag.
  const requested = config.sweepRequestedAt && Date.parse(config.sweepRequestedAt) > (done.requestHandled ?? 0);
  const slot = requested ? 'manuell' : dueSlot(config.sweepTimes, done, day, hm);
  if (!slot) return;
  facebookRunning = true;
  try { if (requested) done.requestHandled = Date.parse(config.sweepRequestedAt); else for (const earlier of config.sweepTimes ?? []) { if (earlier <= slot) done[earlier] = day; } await chrome.storage.local.set({facebookDone: done}); await facebookSweep(config); }
  finally { facebookRunning = false; }
}
chrome.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === alarmName) void facebookTick().catch(() => {}); });

// ---- Sesum: separate bounded shopping queue; never navigates a source tab. ----
const sesumOrigin = 'https://www.sesum.no', sesumAlarm = 'familien-sesum';
let sesumRunning;
async function ensureSesumAlarm() {
  const alarm = await chrome.alarms.get(sesumAlarm);
  if (alarm?.periodInMinutes !== 1) await chrome.alarms.create(sesumAlarm,{periodInMinutes:1});
}
async function wakeSesumCollector(tabId) {
  let bridge;
  try { bridge = await bounded(chrome.tabs.sendMessage(tabId,{type:'familien-collector-ping'})); } catch { /* repair after an extension update */ }
  if (!bridge?.ok) await chrome.scripting.executeScript({target:{tabId},files:['collector-bridge.js']});
  const [main] = await bounded(chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:() => globalThis.__familienSesumCollector === 'sesum-collector-1.7.0' && globalThis.__familienSesumCollectorBuild === 'sesum-collector-build-1.7.0-3'}));
  if (!main?.result) await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['sesum-core.js','collector-sesum.js']});
  await bounded(chrome.tabs.sendMessage(tabId,{type:'familien-collector-wake'}));
}
async function sesumTick() {
  if (sesumRunning || !chrome.tabs?.query || !chrome.tabs?.sendMessage) return sesumRunning;
  sesumRunning = (async () => {
    // The background only decides whether to wake the page. Reserving work is
    // the page collector's job; a preflight must never consume its own queue.
    const response = await fetch(collectorLocal + '/api/shopping/sesum/work?peek=1',{signal:AbortSignal.timeout(4000)});
    if (!response.ok) return;
    const work = await response.json();
    if (!work?.enabled || !work.jobs?.length || Date.parse(work.pauseUntil ?? '') > Date.now()) return;
    const tabs = (await chrome.tabs.query({url:sesumOrigin+'/*'})).filter(tab => {
      try {return new URL(tab.url).origin === sesumOrigin;} catch {return false;}
    });
    if (!tabs.length) { await chrome.tabs.create({url:sesumOrigin+'/',active:false}); return; }
    // A visible user's Sesum tab can supply its ordinary session without being
    // navigated, focused, reloaded, pinned or having in-progress input touched.
    const tab = tabs.find(candidate => !candidate.discarded && !candidate.frozen && candidate.status !== 'loading');
    if (tab) await wakeSesumCollector(tab.id);
    else {
      const discarded = tabs.find(candidate => candidate.discarded && !candidate.frozen && candidate.status !== 'loading');
      if (discarded) await chrome.tabs.reload(discarded.id);
    }
  })().finally(() => {sesumRunning=undefined;});
  return sesumRunning;
}
const requestSesumTick = () => {void ensureSesumAlarm().then(sesumTick).catch(() => {});};
chrome.runtime.onInstalled.addListener(requestSesumTick);
chrome.runtime.onStartup.addListener(requestSesumTick);
chrome.alarms?.onAlarm?.addListener(alarm => {if(alarm.name === sesumAlarm) void sesumTick().catch(() => {});});
void ensureSesumAlarm().catch(() => {});
