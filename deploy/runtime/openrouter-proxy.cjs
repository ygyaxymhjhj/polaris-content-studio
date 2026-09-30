'use strict';
// Service-scoped OpenRouter and WikiFX transport. Other destinations stay unchanged.
const { ProxyAgent } = require('/opt/polaris-content-studio/app/node_modules/undici');
const proxyUrl = process.env.OPENROUTER_HTTP_PROXY;
if (proxyUrl) {
  const originalFetch = globalThis.fetch;
  const dispatcher = new ProxyAgent(proxyUrl);
  globalThis.fetch = function polarisProxyFetch(input, init) {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let useProxy = false;
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
      const isWikiFX = ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password
        && (hostname === 'wikifx.com' || hostname.endsWith('.wikifx.com') || hostname === 'wikifxtips.com' || hostname.endsWith('.wikifxtips.com'));
      useProxy = url.origin === 'https://openrouter.ai' || isWikiFX;
    } catch {}
    return originalFetch.call(this, input, useProxy ? { ...init, dispatcher } : init);
  };
}
