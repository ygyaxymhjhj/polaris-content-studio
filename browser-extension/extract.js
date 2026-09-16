// This function is serialized by Chrome and runs only after an explicit user click.
// No network calls, cookies, local storage, form values or hidden script state are read.
globalThis.polarisExtractArticle = function () {
  const normalize = value => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!/^https?:$/.test(location.protocol)) throw new Error("UNSUPPORTED_PAGE");
  const pageTitle = document.title;
  if (/access denied|just a moment|verify you are human|access verification/i.test(pageTitle) || document.querySelector('#nc_1_wrapper, #aliyunCaptcha-window-popup, #challenge-running')) throw new Error("VERIFICATION_REQUIRED");
  const visible = node => {
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && !!node.getClientRects().length;
  };
  const dedicated = document.querySelector('#articleInfo');
  const candidates = [...document.querySelectorAll('[itemprop="articleBody"], .article-body, .article-content, .post-content, .entry-content, article, main, [role="main"]')].filter(visible);
  const score = node => [...node.querySelectorAll('p')].filter(visible).reduce((sum, p) => sum + normalize(p.textContent || '').length, 0);
  const root = dedicated && visible(dedicated) ? dedicated : candidates.sort((a, b) => score(b) - score(a))[0];
  if (!root) throw new Error("NO_ARTICLE");
  const clone = root.cloneNode(true);
  // Match original visibility before modifying the detached clone.
  const originalNodes = [...root.querySelectorAll('*')];
  const cloneNodes = [...clone.querySelectorAll('*')];
  cloneNodes.forEach((node, i) => { if (!visible(originalNodes[i])) node.remove(); });
  clone.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,input,textarea,select,button,svg,iframe,[hidden],[aria-hidden="true"],.ads,.advertisement,.about,.related,.related-posts,.share-channels,.auther,.next-pre,.next-pre-mobile,.article-r').forEach(node => node.remove());
  clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
  const blocks = [...clone.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,figcaption,tr')]
    .filter(node => !node.querySelector('p,li,blockquote,tr'))
    .map(node => normalize(node.textContent || '')).filter(Boolean);
  const text = normalize(blocks.length ? blocks.join('\n\n') : clone.textContent || '');
  if (text.length < 80) throw new Error("NO_ARTICLE");
  if (text.length > 120000) throw new Error("ARTICLE_TOO_LONG");
  const h1 = [...document.querySelectorAll('h1')].find(visible);
  const title = normalize(h1?.textContent || document.querySelector('meta[property="og:title"]')?.content || pageTitle).slice(0, 500);
  // Drop query/fragment data: article URLs may carry tracking or session tokens.
  const safeUrl = new URL(location.href); safeUrl.username = ''; safeUrl.password = ''; safeUrl.search = ''; safeUrl.hash = '';
  return { title, text, sourceUrl: safeUrl.href, canonical: safeUrl.href, characterCount: text.length, capturedAt: new Date().toISOString(), importMethod: 'browser-extension' };
};
