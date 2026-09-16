// Isolated-world bridge. Only the packaged extension can invoke this receiver.
(() => {
  const allowed = new Set(['http://192.168.220.109:13300', 'http://localhost:3002', 'http://127.0.0.1:3002', 'http://localhost:3000', 'http://127.0.0.1:3000']);
  if (!allowed.has(location.origin) || location.pathname !== '/') return;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'POLARIS_DELIVER_ARTICLE') return;
    if (document.documentElement.dataset.polarisArticleImport !== 'v1') { sendResponse({ ok: false, error: 'APP_NOT_READY' }); return; }
    if (typeof message.article?.text !== 'string' || message.article.text.length > 120000) { sendResponse({ ok: false, error: 'INVALID_ARTICLE' }); return; }
    // randomUUID requires HTTPS; getRandomValues also works on the current HTTP LAN site.
    const requestId = Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
    const timer = setTimeout(() => { window.removeEventListener('message', receive); sendResponse({ ok: false, error: 'APP_NOT_READY' }); }, 3000);
    function receive(event) {
      if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'POLARIS_ARTICLE_ACK' || event.data.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      sendResponse({ ok: event.data.ok === true });
    }
    window.addEventListener('message', receive);
    window.postMessage({ type: 'POLARIS_BROWSER_ARTICLE', version: 1, requestId, article: message.article }, location.origin);
    return true;
  });
})();
