// Real composer and media preparation in a browser, with local API responses instead of a database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText;
const harnessPath = resolve(repository, 'scripts/post-composer-virtual.tsx');
const imageShimPath = resolve(repository, 'scripts/post-composer-image-virtual.tsx');
const accounts = [
  { id: 'channel-x', identifier: 'x', name: 'News desk' },
  { id: 'channel-linkedin', identifier: 'linkedin', name: 'Company page' },
  { id: 'channel-instagram', identifier: 'instagram', name: 'Photo desk' },
  { id: 'channel-disabled', identifier: 'facebook', name: 'Disconnected', disabled: true }
];
const virtualSources = new Map([
  [imageShimPath, transpile(`import React from 'react'; export default function Image({fill, unoptimized, sizes, ...properties}) { return <img {...properties} style={{width: '100%', height: '100%', objectFit: 'cover'}} />; }`)],
  [harnessPath, transpile(`
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import PostEditorView from '@/components/PostEditorView';
    import { LocaleContext } from '@/lib/i18n';
    function Harness() {
      const [postId, setPostId] = useState('new');
      return <LocaleContext.Provider value="en"><main className="content-wrap">
        <PostEditorView postId={postId} accounts={${JSON.stringify(accounts)}} accountsLoading={false} accountsError=""
          postizUiUrl="" isAdmin={false} onBack={() => {}} onOpened={setPostId} onSaved={() => {}}
          onOpenAccounts={() => {}} onRefreshAccounts={() => {}} />
      </main></LocaleContext.Provider>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `)]
]);
const modules = new Map();
function collectModule(modulePath) {
  if (modules.has(modulePath)) return;
  const source = virtualSources.get(modulePath) ?? (/\.tsx?$/.test(modulePath)
    ? transpile(readFileSync(modulePath, 'utf8')) : readFileSync(modulePath, 'utf8'));
  const dependencies = {};
  modules.set(modulePath, { source, dependencies });
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const dependency = match[1];
    const dependencyPath = dependency === 'next/image' ? imageShimPath : dependency.startsWith('@/')
      ? resolve(repository, `src/${dependency.slice(2)}${['@/lib/types', '@/lib/post-types', '@/lib/image-upload'].includes(dependency) ? '.ts' : '.tsx'}`)
      : createRequire(modulePath).resolve(dependency);
    dependencies[dependency] = dependencyPath;
    collectModule(dependencyPath);
  }
}
collectModule(harnessPath);
const bundle = `(() => {
  const process = {env: {NODE_ENV: 'development'}};
  const factories = {${[...modules].map(([modulePath, entry]) => `${JSON.stringify(modulePath)}: function(require, module, exports) {\n${entry.source}\n}`).join(',')}};
  const dependencies = ${JSON.stringify(Object.fromEntries([...modules].map(([modulePath, entry]) => [modulePath, entry.dependencies])))};
  const cache = {};
  function load(modulePath) {
    if (cache[modulePath]) return cache[modulePath].exports;
    const module = cache[modulePath] = {exports: {}};
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
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  }
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const origin = `http://127.0.0.1:${server.address().port}`;
const imageBuffer = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#26a579' } }).png().toBuffer();
let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let storedPost;
  const requests = [];
  let delayNextSave = false;
  let holdSave;
  let releaseSave;
  let refusedAccount = '';
  const submissions = [];
  await page.route('**/api/posts**', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;
    requests.push({ method: request.method(), pathname, body });
    if (pathname.endsWith('/submit')) {
      assert.equal(body.expectedVersion, storedPost.version);
      const integrationId = pathname.split('/').at(-2);
      submissions.push({ integrationId, content: storedPost.content });
      const refused = integrationId === refusedAccount;
      storedPost = { ...storedPost, editable: false, frozenReason: 'accepted', targets: storedPost.targets.map(target => target.integrationId === integrationId
        ? { ...target, status: refused ? 'failed' : 'accepted', error: refused ? 'Synthetic upstream refusal' : null, postizPostId: refused ? null : `draft-${integrationId}` } : target) };
    } else if (request.method() !== 'GET') {
      if (delayNextSave) {
        delayNextSave = false;
        holdSave?.();
        await new Promise(resolveSave => { releaseSave = resolveSave; });
      }
      const timestamp = new Date().toISOString();
      storedPost = {
        id: '11111111-1111-4111-8111-111111111111', title: body.title || '', content: body.content,
        imageUrl: body.imageDataUrl === null ? null : body.imageDataUrl || storedPost?.imageUrl || null,
        version: (storedPost?.version || 0) + 1, editable: true, frozenReason: null,
        createdAt: timestamp, updatedAt: timestamp,
        targets: body.integrationIds.map(integrationId => ({ integrationId, platform: accounts.find(account => account.id === integrationId).identifier,
          accountName: accounts.find(account => account.id === integrationId).name, status: 'not_started', snapshotVersion: 0, postizPostId: null, warning: null, error: null }))
      };
    }
    await route.fulfill({ json: { post: storedPost } });
  });
  await page.goto(origin);
  const text = page.getByRole('textbox', { name: 'Post text', exact: true });
  const addPlatform = page.getByRole('button', { name: 'Add platform', exact: true });
  const push = page.getByRole('button', { name: 'Push drafts to Postiz', exact: true });
  await text.waitFor();
  assert.equal(await page.getByLabel('Internal title').count(), 0);
  assert.equal(await page.locator('.post-editor-counter, select').count(), 0);
  assert.equal(await page.locator('.post-account-picker').count(), 0);
  assert.equal(await push.isDisabled(), true);
  await page.waitForTimeout(1400);
  assert.equal(requests.length, 0, 'untouched editor never creates a record');
  await addPlatform.click();
  assert.equal(await page.getByLabel('Search accounts', { exact: true }).evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: 'LinkedIn', exact: true }).click();
  assert.equal(await page.getByRole('checkbox').count(), 1);
  await page.getByRole('checkbox', { name: /Company page/ }).check();
  await page.getByRole('button', { name: 'All', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Disconnected/ }).isDisabled(), true);
  await page.getByRole('checkbox', { name: /News desk/ }).check();
  await page.getByLabel('Search accounts', { exact: true }).fill('Photo');
  assert.equal(await page.getByRole('checkbox').count(), 1);
  await page.getByLabel('Search accounts', { exact: true }).press('Escape');
  assert.equal(await page.locator('.post-account-picker').count(), 0);
  assert.equal(await addPlatform.evaluate(element => document.activeElement === element), true);
  await page.getByRole('button', { name: 'Remove account: Company page', exact: true }).click();
  assert.equal(await page.locator('.post-editor-target').count(), 1, 'summary updates before autosave');
  await text.fill('Draft content that stays local until pushed.');
  await page.getByLabel('Upload post image', { exact: true }).setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: imageBuffer });
  await page.locator('.post-media-thumbnail img').waitFor();
  await page.screenshot({ path: '/tmp/polaris-composer-dark.png', fullPage: true });
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));

  // Force an autosave to be in flight, then type newer text and push before that save returns.
  delayNextSave = true;
  const saveStarted = new Promise(resolveStarted => { holdSave = resolveStarted; });
  await text.fill('Older autosave snapshot');
  await saveStarted;
  const latestContent = `Newest draft snapshot ${'long draft text '.repeat(30)}`;
  await text.fill(latestContent);
  await push.click();
  assert.equal(await text.isDisabled(), true, 'content locks while the latest save is flushed');
  releaseSave();
  await page.getByText('This post is read-only.', { exact: true }).waitFor();
  assert.deepEqual(submissions, [{ integrationId: 'channel-x', content: latestContent }]);
  assert.equal(await text.isDisabled(), true);
  assert.equal(await addPlatform.isDisabled(), true);
  assert.equal(await push.isDisabled(), true);
  assert.equal(storedPost.title, '', 'composer does not require an internal title');
  assert.ok(storedPost.imageUrl.startsWith('data:image/png;'));

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.screenshot({ path: '/tmp/polaris-composer-light.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: '/tmp/polaris-composer-mobile.png', fullPage: true });

  // A new post can save and push in one click; retrying a failed account never repeats acceptance.
  storedPost = undefined;
  submissions.length = 0;
  refusedAccount = 'channel-linkedin';
  await page.goto(origin);
  await text.fill('Two account draft');
  await addPlatform.click();
  await page.getByRole('checkbox', { name: /News desk/ }).check();
  await page.getByRole('checkbox', { name: /Company page/ }).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await push.click();
  const retry = page.getByRole('button', { name: 'Retry this account', exact: true });
  await retry.waitFor();
  assert.deepEqual(submissions.map(submission => submission.integrationId).sort(), ['channel-linkedin', 'channel-x']);
  refusedAccount = '';
  await retry.click();
  await page.waitForFunction(() => document.querySelectorAll('.post-editor-target.accepted').length === 2);
  assert.equal(submissions.filter(submission => submission.integrationId === 'channel-x').length, 1);
  assert.equal(submissions.filter(submission => submission.integrationId === 'channel-linkedin').length, 2);
  await page.setViewportSize({ width: 812, height: 375 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: real composer, account filtering/selection, image upload, autosave flush, new-post push, per-account retry without duplicates, frozen state, dark/light and mobile layout.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
