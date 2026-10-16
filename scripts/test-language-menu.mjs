// Actual React components in an isolated browser: no app server, login, database or API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true };
const transpile = source => ts.transpileModule(source, { compilerOptions }).outputText;
const studioSource = readFileSync(resolve(repository, 'src/components/ContentStudio.tsx'), 'utf8');
const branding = studioSource.match(/<div className="brand-lockup">[\s\S]*?(?=\n\s*<div className="workspace-label">)/)?.[0];
assert.ok(branding, 'Use the real sidebar branding, not a second copy');
assert.match(branding, /<LanguageMenu language=\{uiLanguage\} onChange=\{changeUiLanguage\}/);
const header = studioSource.match(/<header className="topbar">[\s\S]*?<\/header>/)?.[0];
assert.ok(header);
assert.doesNotMatch(header, /select|topbar-actions|system-status|Search|Bell|CircleHelp/);
assert.match(header, /breadcrumbs/);

const harnessPath = resolve(repository, 'scripts/language-menu-virtual-harness.js');
const virtualSources = new Map([[harnessPath, transpile(`
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { LocaleContext, translate } from '@/lib/i18n';
  import LanguageMenu from '@/components/LanguageMenu';
  import ThemeToggle from '@/components/ThemeToggle';
  import ThemeProvider from '@/components/ThemeProvider';
  function Harness() {
    const [uiLanguage, setLanguage] = useState(localStorage.getItem('polaris-ui-language') || 'en');
    const [source, setSource] = useState('Untouched source');
    const [output, setOutput] = useState('vi');
    const t = text => translate(uiLanguage, text);
    function changeUiLanguage(value) {
      window.languageCalls.push(value);
      setLanguage(value);
      localStorage.setItem('polaris-ui-language', value);
    }
    return <ThemeProvider><LocaleContext.Provider value={uiLanguage}>
      <div className="app-shell"><aside className="sidebar">${branding}
        <button id="after-preferences" style={{width: '100%', minWidth: 0, overflowWrap: 'anywhere'}}>Next control</button>
        <div style={{minHeight: 1000}} />
      </aside><main className="main-area"><header className="topbar">Language menu preview</header>
        <label>Source<input aria-label="Source" value={source} onChange={event => setSource(event.target.value)} /></label>
        <label>Output<select aria-label="Output" value={output} onChange={event => setOutput(event.target.value)}><option value="vi">Vietnamese</option><option value="en">English</option></select></label>
        <output id="language-state">{uiLanguage}</output>
        <button id="outside">Outside</button>
      </main></div>
    </LocaleContext.Provider></ThemeProvider>;
  }
  window.languageCalls = [];
  createRoot(document.getElementById('root')).render(<React.StrictMode><Harness /></React.StrictMode>);
`)]]);
const modules = new Map();
function collectModule(modulePath) {
  if (modules.has(modulePath)) return;
  const source = virtualSources.get(modulePath) ?? (/\.tsx?$/.test(modulePath)
    ? transpile(readFileSync(modulePath, 'utf8')) : readFileSync(modulePath, 'utf8'));
  const dependencies = {};
  modules.set(modulePath, { source, dependencies });
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const dependency = match[1];
    const dependencyPath = dependency.startsWith('@/')
      ? resolve(repository, `src/${dependency.slice(2)}${dependency === '@/lib/theme' ? '.ts' : '.tsx'}`)
      : createRequire(modulePath).resolve(dependency);
    dependencies[dependency] = dependencyPath;
    collectModule(dependencyPath);
  }
}
collectModule(harnessPath);
const bundle = `(() => {
  const process = { env: { NODE_ENV: 'development' } };
  const factories = { ${[...modules].map(([modulePath, entry]) => `${JSON.stringify(modulePath)}: function(require, module, exports) {\n${entry.source}\n}`).join(',')} };
  const dependencies = ${JSON.stringify(Object.fromEntries([...modules].map(([modulePath, entry]) => [modulePath, entry.dependencies])))};
  const cache = {};
  function load(modulePath) {
    if (cache[modulePath]) return cache[modulePath].exports;
    const module = cache[modulePath] = { exports: {} };
    factories[modulePath](name => load(dependencies[modulePath][name]), module, module.exports);
    return module.exports;
  }
  load(${JSON.stringify(harnessPath)});
})();`;
const styles = readFileSync(resolve(repository, 'src/app/globals.css'), 'utf8').replace(/@import\s+url\([^)]*\)\s*;/g, '');
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(bundle);
  } else if (request.url === '/styles.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(styles);
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  const unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && ['/', '/bundle.js', '/styles.css'].includes(url.pathname)) return route.continue();
    unexpectedRequests.push(url.pathname);
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem('polaris-theme-mode', 'light');
    window.storageWrites = [];
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      window.storageWrites.push({ key, value });
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto(origin);
  const trigger = page.locator('.language-menu-trigger');
  const options = page.locator('.language-menu-option');
  const popover = page.locator('.language-menu-popover');
  await trigger.waitFor();
  const wordmarkBounds = await page.locator('.brand-copy .brand-name').boundingBox();
  const appearanceBounds = await page.locator('.theme-toggle-trigger').boundingBox();
  const languageTriggerBounds = await trigger.boundingBox();
  assert.equal(await page.locator('.brand-lockup .brand-mark, .brand-lockup .brand-product').count(), 0);
  assert.ok(wordmarkBounds.x + wordmarkBounds.width <= appearanceBounds.x, 'Wordmark must not overlap preferences');
  assert.equal(appearanceBounds.y, languageTriggerBounds.y, 'Preferences share one header row');
  assert.ok(Math.abs(wordmarkBounds.y + wordmarkBounds.height / 2 - appearanceBounds.y - appearanceBounds.height / 2) < 1);
  for (const preference of ['.theme-toggle', '.language-menu']) {
    assert.equal(await page.locator(`.sidebar-preferences > ${preference}`).evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)');
  }
  const assertFocused = async locator => assert.equal(await locator.evaluate(element => element === document.activeElement), true);
  const assertBounds = async () => {
    const bounds = await popover.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds.x >= 10 && bounds.y >= 10);
    assert.ok(bounds.x + bounds.width <= viewport.width - 9);
    assert.ok(bounds.y + bounds.height <= viewport.height - 9);
    assert.equal(await popover.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + 24));
    }), true, 'Popover must not be clipped by the scrolling sidebar');
  };
  await page.getByLabel('Source', { exact: true }).fill('Keep my source');
  const labels = ['English', '简体中文', 'Tiếng Việt', 'ไทย'];
  const values = ['en', 'zh', 'vi', 'th'];
  for (const [index, label] of labels.entries()) {
    await trigger.click();
    assert.deepEqual(await options.allTextContents(), labels);
    assert.equal(await trigger.getAttribute('aria-controls'), await popover.getAttribute('id'));
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    assert.equal(await popover.count(), 0);
    await assertFocused(trigger);
    assert.equal(await page.locator('#language-state').textContent(), values[index]);
    assert.equal(await page.getByLabel('Source', { exact: true }).inputValue(), 'Keep my source');
    assert.equal(await page.getByLabel('Output', { exact: true }).inputValue(), 'vi');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await trigger.press('ArrowDown');
    const checked = page.getByRole('menuitemradio', { checked: true });
    assert.equal(await checked.textContent(), label);
    await assertFocused(checked);
    await page.keyboard.press('Escape');
    await assertFocused(trigger);
  }
  assert.deepEqual(await page.evaluate(() => window.languageCalls), values);
  assert.deepEqual(await page.evaluate(() => window.storageWrites.map(entry => entry.key)), values.map(() => 'polaris-ui-language'), 'Only the harness parent persists, once per selection');
  await trigger.press('ArrowUp');
  await assertFocused(options.nth(3));
  await page.keyboard.press('ArrowDown');
  await assertFocused(options.nth(0));
  await page.keyboard.press('ArrowDown');
  await assertFocused(options.nth(1));
  await page.keyboard.press('ArrowDown');
  await assertFocused(options.nth(2));
  await page.keyboard.press('Home');
  await assertFocused(options.nth(0));
  await page.keyboard.press('End');
  await assertFocused(options.nth(3));
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#language-state').textContent(), 'vi');
  await trigger.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#language-state').textContent(), 'en');
  await trigger.click();
  await page.keyboard.press('Tab');
  assert.equal(await popover.count(), 0);
  await assertFocused(page.locator('#after-preferences'));
  await trigger.click();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await popover.count(), 0);
  await assertFocused(trigger);
  const changesBeforeToggle = await page.evaluate(() => window.languageCalls.length);
  await trigger.click();
  await trigger.click();
  assert.equal(await popover.count(), 0);
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  await assertFocused(trigger);
  assert.equal(await page.evaluate(() => window.languageCalls.length), changesBeforeToggle);
  await trigger.click();
  await page.locator('#outside').click();
  assert.equal(await popover.count(), 0);
  await assertFocused(page.locator('#outside'));
  await trigger.click();
  await assertBounds();
  await page.screenshot({ path: '/tmp/polaris-language-menu-light.png' });
  await page.keyboard.press('Escape');
  await page.locator('.theme-toggle-trigger').click();
  await page.locator('.theme-option').nth(2).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await trigger.click();
  assert.notEqual(await popover.evaluate(element => getComputedStyle(element).color), await popover.evaluate(element => getComputedStyle(element).backgroundColor));
  await page.screenshot({ path: '/tmp/polaris-language-menu-dark.png' });
  await page.setViewportSize({ width: 900, height: 600 });
  await assertBounds();
  await page.setViewportSize({ width: 375, height: 667 });
  await assertBounds();
  const languageBounds = await trigger.boundingBox();
  const themeBounds = await page.locator('.theme-toggle-trigger').boundingBox();
  assert.ok(languageBounds.width >= 44 && languageBounds.height >= 44);
  assert.ok(languageBounds.x === themeBounds.x && languageBounds.y >= themeBounds.y + themeBounds.height);
  assert.equal(await page.locator('.sidebar').evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({ path: '/tmp/polaris-language-menu-mobile.png' });
  await page.locator('.sidebar').evaluate(element => { element.scrollTop = 40; });
  await page.waitForTimeout(100);
  await assertBounds();
  await page.keyboard.press('Escape');
  await page.reload();
  await trigger.waitFor();
  assert.equal(await page.locator('#language-state').textContent(), 'en');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log('PASS: actual React four-language menu, checked state, keyboard/focus, outside/Tab dismissal, parent-only persistence, unchanged source/output/theme, responsive positioning and screenshots.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
