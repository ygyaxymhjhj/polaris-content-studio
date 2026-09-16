import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';

const extension = path.resolve('browser-extension');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'polaris-extension-test-'));
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  const app = await context.newPage();
  await app.goto(process.env.TEST_BASE_URL || 'http://localhost:3002/');
  await app.locator('.locale-switcher select').selectOption('en');
  await app.waitForFunction(() => document.documentElement.dataset.polarisArticleImport === 'v1');
  const oldText = await app.locator('.source-textarea').inputValue();
  const reader = await context.newPage();
  await reader.route('https://example.com/article*', route => route.fulfill({ contentType: 'text/html', body: `<h1>Example article for import testing</h1><div id="articleInfo"><h3>Short heading</h3><p>${'An exact source fact with its context. '.repeat(5)}</p><p style="display:none">HIDDEN_SECRET</p><form><input value="PASSWORD"><p>FORM_SECRET</p></form><div class="about"><p>RELATED_STORY</p></div></div>` }));
  await reader.goto('https://example.com/article?tracking=secret#private');
  await reader.addScriptTag({ path: path.join(extension, 'extract.js') });
  const article = await reader.evaluate(() => globalThis.polarisExtractArticle());
  assert(article.text.includes('Short heading'));
  for (const value of ['HIDDEN_SECRET', 'FORM_SECRET', 'PASSWORD', 'RELATED_STORY']) assert(!article.text.includes(value));
  assert.equal(article.sourceUrl, 'https://example.com/article');

  // Exercise the installed extension's isolated bridge using its own runtime.
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  const installed = await manager.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: false, includeTerminated: false }, resolve)));
  const id = installed.find(item => item.name === 'Polaris Article Import')?.id;
  assert(id, 'Extension must be installed');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  async function send(payload) {
    return popup.evaluate(async ({ payload, target }) => {
      const tabs = await chrome.tabs.query({ url: `${new URL(target).origin}/*` });
      return chrome.tabs.sendMessage(tabs[0].id, { type: 'POLARIS_DELIVER_ARTICLE', article: payload });
    }, { payload, target: app.url() });
  }
  assert.equal((await send({ ...article, sourceUrl: 'javascript:alert(1)' })).ok, false);
  assert.equal((await send(article)).ok, true);
  const dialog = app.getByRole('dialog', { name: 'Article from your browser' });
  await dialog.waitFor();
  assert.equal(await app.locator('.source-textarea').inputValue(), oldText, 'Delivery must not overwrite without confirmation');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await app.locator('.source-textarea').inputValue(), oldText);
  assert.equal((await send(article)).ok, true);
  await dialog.getByRole('button', { name: 'Confirm article import', exact: true }).click();
  assert.equal(await app.locator('.source-textarea').inputValue(), article.text);
  assert.equal(await app.locator('.url-input-row input').inputValue(), article.sourceUrl);
  await reader.evaluate(() => { document.title = 'Access Denied'; });
  assert(await reader.evaluate(() => { try { globalThis.polarisExtractArticle(); return false; } catch { return true; } }));
  console.log('PASS: DOM extraction on a synthetic article, hidden/form exclusion, installed extension bridge, invalid URL rejection, cancel/confirm import and access-denied detection. No live website or paid AI request.');
} finally {
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
