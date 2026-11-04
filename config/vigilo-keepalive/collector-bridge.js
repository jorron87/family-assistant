/* Familien – bro mellom samleren i siden og utvidelsen (isolert world). Sender bare kompakte kildeutdrag til localhost. */
(function () {
globalThis.__familienCollectorBridgeStop?.();
const relay = (event) => {
  const data = event.data;
  if (event.source !== window || !data?.familienCollector || typeof data.id !== 'string') return;
  try { chrome.runtime.sendMessage({ type: 'familien-collector', path: data.path, method: data.method, body: data.body }, (reply) => {
    // Consume lastError after extension/service restarts; no unhandled callback.
    const failed = !!chrome.runtime.lastError;
    window.postMessage({ familienCollectorReply: true, id: data.id, ok: !failed && !!reply?.ok, data: reply?.data ?? null, error: reply?.data?.error ?? null }, location.origin);
  }); } catch { /* obsolete extension context; background repairs the bridge */ }
};
window.addEventListener('message', relay);

// Bestilling fra bakgrunnen om å rulle Facebook-feeden i denne fanen.
const receive = (message, sender, sendResponse) => {
  if (message?.type === 'familien-collector-ping') { sendResponse({ok:true}); return false; }
  if (message?.type === 'familien-collector-wake') {
    window.postMessage({ familienCollectorWake: true }, location.origin);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type !== 'familien-fb-scroll') return false;
  const id = Math.random().toString(36).slice(2);
  const finish = (result) => { window.removeEventListener('message', onReply); clearTimeout(timer); sendResponse(result); };
  const onReply = (event) => { if (event.source === window && event.data?.familienFbScrollReply && event.data.id === id) finish(event.data.result); };
  const timer = setTimeout(() => finish({ steps: 0, stories: 0, stalled: true, timeout: true }), 100000);
  window.addEventListener('message', onReply);
  window.postMessage({ familienFbScroll: true, id, maxScrolls: message.maxScrolls }, location.origin);
  return true;
};
chrome.runtime.onMessage.addListener(receive);
globalThis.__familienCollectorBridgeStop = () => {
  window.removeEventListener('message', relay);
  chrome.runtime.onMessage.removeListener(receive);
};
})();
