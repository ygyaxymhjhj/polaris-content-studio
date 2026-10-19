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
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import PostEditorView from '@/components/PostEditorView';
    import PostsView from '@/components/PostsView';
    import { LocaleContext } from '@/lib/i18n';
    function Harness() {
      const [postId, setPostId] = useState(new URLSearchParams(location.search).get('postId') || 'new');
      const [showList, setShowList] = useState(new URLSearchParams(location.search).has('list'));
      const [editorSession, setEditorSession] = useState(0);
      useEffect(() => {
        const resetEditor = () => { setEditorSession(session => session + 1); setPostId('new'); setShowList(false); };
        window.addEventListener('test-editor-reset', resetEditor);
        return () => window.removeEventListener('test-editor-reset', resetEditor);
      }, []);
      return <LocaleContext.Provider value="en"><main className="content-wrap">
        {showList ? <PostsView accounts={${JSON.stringify(accounts)}} accountsLoading={false} accountsError=""
          onOpenPost={setPostId} onNewPost={() => {}} onOpenAccounts={() => {}} initialStatus="all" refreshToken={0} />
          : <PostEditorView key={editorSession} postId={postId} accounts={${JSON.stringify(accounts)}} accountsLoading={false} accountsError=""
          postizUiUrl="" isAdmin={false} onBack={() => setShowList(true)} onOpened={(identifier, newSession) => {
            if (newSession) setEditorSession(session => session + 1);
            setPostId(identifier);
          }} onSaved={() => {}}
          onOpenAccounts={() => {}} onRefreshAccounts={() => {}} />}
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
  let deleteFailure = false;
  let freezeOnDelete = false;
  let conflictNextSave = false;
  let holdCopy;
  let releaseCopy;
  let holdDelete;
  let releaseDelete;
  let holdRead;
  let releaseRead;
  let submitPendingUnknown = false;
  let submissionFailure = false;
  let listReadFailure = false;
  let heldSubmissionId = '';
  let holdSubmission;
  let releaseSubmission;
  const submissions = [];
  await page.route('**/api/posts**', async route => {
    const request = route.request();
    const body = request.postDataJSON();
    const pathname = new URL(request.url()).pathname;
    requests.push({ method: request.method(), pathname, body });
    if (pathname.endsWith('/duplicate')) {
      if (holdCopy) {
        holdCopy();
        holdCopy = null;
        await new Promise(resolveCopy => { releaseCopy = resolveCopy; });
      }
      storedPost = { ...storedPost, id: '22222222-2222-4222-8222-222222222222', version: 1 };
      await route.fulfill({ json: { post: storedPost } });
      return;
    }
    if (request.method() === 'PATCH' && conflictNextSave) {
      conflictNextSave = false;
      await route.fulfill({ status: 409, json: { code: 'CONFLICT', error: 'Version conflict.' } });
      return;
    }
    if (request.method() === 'DELETE') {
      assert.equal(pathname, `/api/posts/${storedPost.id}`, 'delete uses the actual saved identifier');
      if (freezeOnDelete) {
        storedPost = { ...storedPost, editable: false, frozenReason: 'accepted', targets: [{ integrationId: 'channel-x',
          platform: 'x', accountName: 'News desk', status: 'accepted', postizPostId: 'external-draft', warning: null, error: null }] };
        await route.fulfill({ status: 409, json: { code: 'POST_FROZEN', error: 'A Postiz draft already exists. Delete it in Postiz instead.' } });
        return;
      }
      if (holdDelete) {
        holdDelete();
        holdDelete = null;
        await new Promise(resolveDelete => { releaseDelete = resolveDelete; });
      }
      if (deleteFailure) {
        await route.fulfill({ status: 503, json: { error: 'Postiz refused deletion. Check POSTIZ_API_KEY configuration.' } });
      } else {
        storedPost = undefined;
        await route.fulfill({ json: { deleted: true } });
      }
      return;
    }
    if (request.method() === 'GET' && pathname === '/api/posts') {
      if (listReadFailure) {
        await route.fulfill({ status: 503, json: { error: 'Temporary list connection failure.' } });
        return;
      }
      const rejectedCount = storedPost?.targets.filter(target => target.status === 'rejected').length || 0;
      const acceptedCount = storedPost?.targets.filter(target => target.status === 'accepted').length || 0;
      const status = rejectedCount ? 'attention' : acceptedCount ? 'pushed' : 'draft';
      const posts = storedPost ? [{ ...storedPost, excerpt: storedPost.content, hasImage: false, status, platforms: [], rejectedCount,
        targetCount: storedPost.targets.length, acceptedCount, deletable: storedPost.editable }] : [];
      await route.fulfill({ json: { posts, total: posts.length, counts: { all: posts.length, draft: status === 'draft' ? posts.length : 0,
        pushing: 0, pushed: status === 'pushed' ? posts.length : 0, attention: rejectedCount ? posts.length : 0 } } });
      return;
    }
    if (request.method() === 'GET') {
      const snapshot = structuredClone(storedPost);
      if (holdRead) {
        holdRead();
        holdRead = null;
        await new Promise(resolveRead => { releaseRead = resolveRead; });
      }
      await route.fulfill({ json: { post: snapshot } });
      return;
    }
    if (pathname.endsWith('/submit')) {
      assert.equal(body.expectedVersion, storedPost.version);
      const integrationId = pathname.split('/').at(-2);
      const shownTarget = storedPost.targets.find(target => target.integrationId === integrationId);
      if (shownTarget.status === 'rejected') assert.equal(body.expectedAuditId, shownTarget.auditId, 'rejected retry binds the shown review attempt');
      else assert.equal(body.expectedAuditId, undefined, 'first and failed submissions remain compatible');
      submissions.push({ integrationId, content: storedPost.content, body });
      if (submissionFailure) {
        await route.fulfill({ status: 503, json: { error: 'Synthetic resubmission failure' } });
        return;
      }
      const refused = integrationId === refusedAccount;
      storedPost = { ...storedPost, editable: false, frozenReason: 'accepted', targets: storedPost.targets.map(target => target.integrationId === integrationId
        ? { ...target, status: refused ? 'failed' : submitPendingUnknown ? 'pending_unknown' : 'accepted', auditId: `audit-${submissions.length}`,
          error: refused ? 'Synthetic upstream refusal' : null, postizPostId: refused ? null : `draft-${integrationId}-${submissions.length}` } : target) };
      if (integrationId === heldSubmissionId) {
        const snapshot = structuredClone(storedPost);
        holdSubmission?.();
        await new Promise(resolveSubmission => { releaseSubmission = resolveSubmission; });
        await route.fulfill({ json: { post: snapshot } });
        return;
      }
    } else if (request.method() !== 'GET') {
      if (delayNextSave) {
        delayNextSave = false;
        holdSave?.();
        await new Promise(resolveSave => { releaseSave = resolveSave; });
      }
      const timestamp = new Date().toISOString();
      storedPost = {
        id: request.method() === 'PATCH' ? pathname.split('/').at(-1) : '11111111-1111-4111-8111-111111111111', title: body.title || '', content: body.content,
        imageUrl: body.imageDataUrl === null ? null : body.imageDataUrl || storedPost?.imageUrl || null,
        version: (storedPost?.version || 0) + 1, editable: true, frozenReason: null,
        createdAt: timestamp, updatedAt: timestamp,
        targets: body.integrationIds.map(integrationId => ({ integrationId, platform: accounts.find(account => account.id === integrationId).identifier,
          accountName: accounts.find(account => account.id === integrationId).name, status: 'not_started', snapshotVersion: 0, postizPostId: null, auditId: null, warning: null, error: null }))
      };
    }
    await route.fulfill({ json: { post: storedPost } });
  });
  await page.goto(origin);
  const text = page.getByRole('textbox', { name: 'Post text', exact: true });
  const addPlatform = page.getByRole('button', { name: 'Add platform', exact: true });
  const push = page.getByRole('button', { name: 'Push drafts', exact: true });
  await text.waitFor();
  assert.equal(await page.getByLabel('Internal title').count(), 0);
  assert.equal(await page.locator('.post-editor-counter, select').count(), 0);
  assert.equal(await page.locator('.post-account-picker').count(), 0);
  assert.equal(await push.isDisabled(), true);
  await page.waitForTimeout(1400);
  assert.equal(requests.length, 0, 'untouched editor never creates a record');
  assert.equal(await page.getByRole('button', { name: 'Delete draft', exact: true }).count(), 0);
  await addPlatform.click();
  const picker = page.getByRole('group', { name: 'Choose accounts', exact: true });
  assert.equal(await picker.locator('img, input[type="text"]').count(), 0, 'compact picker has no avatars or search field');
  assert.equal(await page.getByRole('checkbox').count(), 4);
  const pickerBounds = await picker.boundingBox();
  assert.ok(pickerBounds.width <= 280 && pickerBounds.height <= 360, 'account picker stays compact');
  assert.equal(await page.getByRole('checkbox', { name: /News desk/ }).evaluate(element => document.activeElement === element), true);
  await page.screenshot({ path: '/tmp/polaris-account-picker-dark.png', fullPage: true });
  await page.getByRole('checkbox', { name: /Company page/ }).check();
  assert.equal(await page.getByRole('checkbox', { name: /Disconnected/ }).isDisabled(), true);
  await page.getByRole('checkbox', { name: /News desk/ }).check();
  await page.getByRole('checkbox', { name: /News desk/ }).press('Escape');
  assert.equal(await page.locator('.post-account-picker').count(), 0);
  assert.equal(await addPlatform.evaluate(element => document.activeElement === element), true);
  await addPlatform.click();
  await text.click();
  assert.equal(await picker.count(), 0, 'click outside closes the picker');
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
  assert.deepEqual(submissions.map(({ integrationId, content }) => ({ integrationId, content })), [{ integrationId: 'channel-x', content: latestContent }]);
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
  const mobilePickerBounds = await picker.boundingBox();
  assert.ok(mobilePickerBounds.x >= 12 && mobilePickerBounds.x + mobilePickerBounds.width <= 363);
  assert.ok(mobilePickerBounds.y >= 12 && mobilePickerBounds.y + mobilePickerBounds.height <= 801);
  await page.screenshot({ path: '/tmp/polaris-account-picker-mobile.png', fullPage: true });
  await page.getByRole('checkbox', { name: /Company page/ }).press('Escape');
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

  // Local drafts expose a visible, cancellable action. A refused delete keeps all edits usable.
  const deleteDraft = page.getByRole('button', { name: 'Delete draft', exact: true });
  storedPost = undefined;
  await page.goto(origin);
  await text.fill('A local draft mentioning Postiz stays unchanged.');
  await deleteDraft.waitFor();
  const originalPost = structuredClone(storedPost);
  const deleteCount = () => requests.filter(request => request.method === 'DELETE').length;
  let confirmation = '';
  page.once('dialog', async dialog => { confirmation = dialog.message(); await dialog.dismiss(); });
  await deleteDraft.click();
  assert.doesNotMatch(confirmation, /postiz/i);
  assert.equal(deleteCount(), 0);
  assert.equal(await text.inputValue(), originalPost.content);
  assert.equal(await text.isEnabled(), true);

  deleteFailure = true;
  const deleteStarted = new Promise(resolveStarted => { holdDelete = resolveStarted; });
  await text.fill('Unsaved edits survive a failed delete: Postiz.');
  page.once('dialog', dialog => dialog.accept());
  await deleteDraft.click();
  await deleteStarted;
  for (const control of [text, push, addPlatform,
    page.getByRole('button', { name: 'Save draft', exact: true }),
    page.getByRole('button', { name: 'Copy as new draft', exact: true }),
    page.getByRole('button', { name: 'Back to posts', exact: true })]) {
    assert.equal(await control.isDisabled(), true, 'deletion locks edits and competing actions');
  }
  await page.waitForTimeout(1400);
  assert.equal(storedPost.content, originalPost.content, 'deletion parks the pending autosave');
  releaseDelete();
  await page.getByRole('alert').filter({ hasText: 'refused deletion' }).waitFor();
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /postiz/i);
  assert.equal(await text.inputValue(), 'Unsaved edits survive a failed delete: Postiz.');
  assert.equal(await text.isEnabled(), true);
  await text.fill('Editing still works after deletion failure.');
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(storedPost.content, 'Editing still works after deletion failure.');
  deleteFailure = false;
  page.once('dialog', dialog => dialog.accept());
  await deleteDraft.click();
  await page.getByRole('heading', { name: 'Create your first post', exact: true }).waitFor();
  const afterDelete = requests.length;
  await page.waitForTimeout(1500);
  assert.equal(storedPost, undefined);
  assert.equal(requests.length, afterDelete, 'successful deletion never resurrects the record');

  // Deletion awaits either an in-flight initial create or PATCH and uses the returned id.
  for (const saveMethod of ['POST', 'PATCH']) {
    storedPost = undefined;
    await page.goto(origin);
    if (saveMethod === 'PATCH') {
      await text.fill('Persisted draft before PATCH');
      await deleteDraft.waitFor();
    }
    delayNextSave = true;
    const savingStarted = new Promise(resolveStarted => { holdSave = resolveStarted; });
    await text.fill(`In-flight ${saveMethod}`);
    await savingStarted;
    await text.fill('Newer edits must be discarded, not saved before deleting.');
    const writesBeforeDelete = requests.filter(request => request.method !== 'GET').length;
    page.once('dialog', dialog => dialog.accept());
    await deleteDraft.click();
    assert.equal(await text.isDisabled(), true);
    const deletesBeforeRelease = deleteCount();
    await page.waitForTimeout(1400);
    assert.equal(deleteCount(), deletesBeforeRelease, 'delete waits for the save response');
    releaseSave();
    await page.getByRole('heading', { name: 'Create your first post', exact: true }).waitFor();
    await page.waitForTimeout(1400);
    assert.equal(requests.filter(request => request.method !== 'GET').length, writesBeforeDelete + 1, 'only DELETE follows the in-flight save');
    assert.equal(storedPost, undefined);
  }

  // All authoritative frozen states hide deletion; failed-only drafts remain deletable.
  for (const targetStatus of ['accepted', 'rejected', 'submitting', 'pending_unknown', 'failed']) {
    storedPost = { ...originalPost, content: 'Status verification draft.', editable: targetStatus === 'failed', frozenReason: targetStatus === 'failed' ? null : targetStatus === 'rejected' ? 'accepted' : targetStatus,
      targets: [{ integrationId: 'channel-x', platform: 'x', accountName: 'News desk', status: targetStatus,
        postizPostId: 'status-draft', auditId: 'status-audit', warning: 'Postiz warning: review the draft.', error: 'Postiz refused the draft.', snapshotVersion: 0 }] };
    await page.goto(`${origin}/?postId=${storedPost.id}`);
    await text.waitFor();
    assert.equal(await deleteDraft.count(), targetStatus === 'failed' ? 1 : 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /postiz/i, 'target errors and warnings pass through the presentation boundary');
    if (targetStatus === 'failed') {
      page.once('dialog', dialog => dialog.accept());
      await deleteDraft.click();
      await page.getByRole('heading', { name: 'Create your first post', exact: true }).waitFor();
    }
  }

  storedPost = originalPost;
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  await text.fill('Preserve unsaved edits if the server freezes this draft.');
  freezeOnDelete = true;
  page.once('dialog', dialog => dialog.accept());
  await deleteDraft.click();
  await page.getByRole('alert').filter({ hasText: 'already exists' }).waitFor();
  assert.equal(await deleteDraft.count(), 0, 'a frozen DELETE refusal refreshes authoritative state');
  assert.equal(await text.isDisabled(), true);
  assert.equal(await text.inputValue(), 'Preserve unsaved edits if the server freezes this draft.');
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /postiz/i);
  const requestsAfterFreeze = requests.length;
  await page.waitForTimeout(1400);
  assert.equal(requests.length, requestsAfterFreeze, 'server-frozen drafts never resume autosave');
  freezeOnDelete = false;

  storedPost = originalPost;
  await page.goto(`${origin}/?list=1`);
  const listDelete = page.getByRole('button', { name: 'Delete local draft', exact: true });
  await listDelete.waitFor();
  assert.equal(await listDelete.innerText(), 'Delete local draft', 'list deletion has a visible text label');
  page.once('dialog', dialog => dialog.accept());
  await listDelete.click();
  await page.getByRole('heading', { name: 'Create your first post', exact: true }).waitFor();

  // A copied draft starts a fresh editor session; conflict and pending operations never leak.
  storedPost = structuredClone(originalPost);
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  conflictNextSave = true;
  await text.fill('Trigger a version conflict before copying.');
  await page.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor();
  const copyStarted = new Promise(resolveStarted => { holdCopy = resolveStarted; });
  await page.getByRole('button', { name: 'Copy as new draft', exact: true }).click();
  await copyStarted;
  assert.equal(await deleteDraft.isDisabled(), true, 'copy and delete are mutually exclusive');
  assert.equal(await text.isDisabled(), true, 'copy prevents a competing autosave snapshot');
  assert.equal(await page.getByRole('button', { name: 'Back to posts', exact: true }).isDisabled(), true);
  releaseCopy();
  await page.waitForFunction(() => document.querySelector('textarea')?.value === 'A local draft mentioning Postiz stays unchanged.');
  assert.equal(await page.getByRole('alert').count(), 0, 'fresh copy does not inherit conflict state');
  await text.fill('The copied draft remains independently editable.');
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(requests.filter(request => request.method === 'PATCH').at(-1).pathname, '/api/posts/22222222-2222-4222-8222-222222222222');

  // Focus refresh observes a rejection without reopening, unfreezing or changing the snapshot.
  const reviewTarget = {
    integrationId: 'channel-x', platform: 'x', accountName: 'News desk', status: 'accepted',
    auditId: 'review-audit-original', postizPostId: 'review-draft-original', snapshotVersion: originalPost.version,
    warning: 'Keep this review warning.', error: null, submittedAt: new Date().toISOString()
  };
  const reviewPost = { ...originalPost, content: 'An immutable review snapshot.', editable: false, frozenReason: 'accepted', targets: [reviewTarget] };
  storedPost = structuredClone(reviewPost);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await page.locator('.post-editor-target.accepted').waitFor();
  storedPost.targets[0].status = 'rejected';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const resubmit = page.getByRole('button', { name: 'Resubmit for review', exact: true });
  await resubmit.waitFor();
  assert.equal(await text.isDisabled(), true);
  assert.equal(await deleteDraft.count(), 0);
  assert.equal(await text.inputValue(), reviewPost.content);
  assert.equal(await page.locator('.post-editor-target-meta').count(), 0, 'rejection does not retain accepted tracking progress');
  assert.equal(await page.getByRole('button', { name: 'Refresh status', exact: true }).locator('.spin').count(), 0, 'background refresh has no spinner');
  assert.match(await page.locator('.info-banner.frozen').innerText(), /copy it as a new draft/i);
  assert.doesNotMatch(await page.locator('body').innerText(), /postiz/i);

  // Background refresh never clears an action error, and hidden/in-flight pages do not poll twice.
  submissionFailure = true;
  await resubmit.click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic resubmission failure' }).waitFor();
  const refreshedAfterFailure = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/posts/${storedPost.id}`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshedAfterFailure;
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Synthetic resubmission failure' }).count(), 1);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.dispatchEvent(new Event('focus'));
  });
  const hiddenRequests = requests.length;
  await page.waitForTimeout(80);
  assert.equal(requests.length, hiddenRequests, 'hidden editor skips refresh');
  await page.evaluate(() => { delete document.hidden; });
  submissionFailure = false;

  const staleReadStarted = new Promise(resolveStarted => { holdRead = resolveStarted; });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await staleReadStarted;
  const requestsDuringRead = requests.length;
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(80);
  assert.equal(requests.length, requestsDuringRead, 'one status read at a time');
  submitPendingUnknown = true;
  await resubmit.click();
  await page.locator('.post-editor-target.pending_unknown').waitFor();
  const staleResponse = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/posts/${storedPost.id}`);
  releaseRead();
  await staleResponse;
  await page.waitForTimeout(80);
  assert.equal(await page.locator('.post-editor-target.pending_unknown').count(), 1, 'a pre-resubmit rejection cannot replace the new pending audit');
  assert.equal(await resubmit.count(), 0);
  assert.equal(submissions.at(-1).body.expectedAuditId, 'review-audit-original');
  submitPendingUnknown = false;

  // Bulk hand-off includes each rejected account's own shown audit and skips accepted accounts.
  storedPost = { ...structuredClone(reviewPost), targets: [
    { ...reviewTarget, status: 'rejected', auditId: 'bulk-review-x' },
    { ...reviewTarget, integrationId: 'channel-linkedin', platform: 'linkedin', accountName: 'Company page', status: 'rejected', auditId: 'bulk-review-linkedin' },
    { ...reviewTarget, integrationId: 'channel-instagram', platform: 'instagram', accountName: 'Photo desk' }
  ] };
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await page.locator('.post-editor-target.rejected').first().waitFor();
  const bulkStart = submissions.length;
  await push.click();
  await page.waitForFunction(() => document.querySelectorAll('.post-editor-target.accepted').length === 3);
  assert.deepEqual(submissions.slice(bulkStart).map(submission => [submission.integrationId, submission.body.expectedAuditId]).sort(),
    [['channel-linkedin', 'bulk-review-linkedin'], ['channel-x', 'bulk-review-x']]);
  assert.ok(submissions.slice(bulkStart).every(submission => submission.content === reviewPost.content));

  // Status-only merging preserves unsaved text, local account selection and the PATCH version.
  storedPost = { ...structuredClone(reviewPost), editable: true, frozenReason: null };
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  await text.fill('Unsaved text must survive remote status synchronization.');
  await addPlatform.click();
  await page.getByRole('checkbox', { name: /Company page/ }).check();
  await page.getByRole('checkbox', { name: /Company page/ }).press('Escape');
  const writesBeforeStatus = requests.filter(request => request.method !== 'GET').length;
  storedPost = { ...storedPost, content: 'Other tab content must not overwrite the form.', version: storedPost.version + 1,
    editable: false, frozenReason: 'accepted', targets: [{ ...reviewTarget, status: 'rejected' }] };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await resubmit.waitFor();
  assert.equal(await text.inputValue(), 'Unsaved text must survive remote status synchronization.');
  assert.equal(await page.locator('.post-account-chip').filter({ hasText: 'Company page' }).count(), 1, 'refresh keeps locally selected accounts');
  assert.match(await page.locator('.post-editor-save-state').innerText(), /Unsaved changes/);
  await page.waitForTimeout(1400);
  assert.equal(requests.filter(request => request.method !== 'GET').length, writesBeforeStatus, 'remote freeze cancels autosave without discarding edits');

  // A status refresh must not silently adopt another tab's content version for autosave.
  storedPost = { ...structuredClone(reviewPost), editable: true, frozenReason: null };
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  const originalVersion = storedPost.version;
  await text.fill('Keep this edit until the version conflict is resolved.');
  storedPost = { ...storedPost, version: originalVersion + 1, content: 'Saved elsewhere.' };
  conflictNextSave = true;
  const versionRefresh = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/posts/${storedPost.id}`);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await versionRefresh;
  await page.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor();
  assert.equal(requests.filter(request => request.method === 'PATCH').at(-1).body.version, originalVersion, 'polling preserves optimistic concurrency');
  assert.equal(await text.inputValue(), 'Keep this edit until the version conflict is resolved.');

  // List focus refresh updates the badge, accepted progress and attention count quietly.
  storedPost = structuredClone(reviewPost);
  await page.goto(`${origin}/?list=1`);
  await page.locator('.posts-row').waitFor();
  assert.match(await page.locator('.posts-row-progress').innerText(), /1 \/ 1/);
  storedPost.targets[0].status = 'rejected';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.locator('.posts-status-pill.rejected').waitFor();
  assert.equal(await page.locator('.posts-status-pill.rejected').textContent(), 'Review rejected');
  assert.match(await page.locator('.posts-row-progress').innerText(), /0 \/ 1/);
  assert.match(await page.getByRole('tab', { name: /Needs attention/ }).innerText(), /1/);
  assert.equal(await listDelete.count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Refresh', exact: true }).locator('.spin').count(), 0);
  listReadFailure = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({ hasText: 'Temporary list connection failure' }).waitFor();
  listReadFailure = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({ hasText: 'Temporary list connection failure' }).waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'rejected list badge fits a mobile viewport');

  // A late account A response contains account B's old rejection. It must not roll back B's result.
  storedPost = structuredClone(reviewPost);
  storedPost.targets = ['channel-x', 'channel-linkedin'].map((integrationId, index) => ({
    ...storedPost.targets[0], integrationId, platform: index ? 'linkedin' : 'x',
    accountName: index ? 'Company page' : 'News desk', status: 'rejected', auditId: `old-audit-${index}`
  }));
  storedPost.editable = false;
  storedPost.frozenReason = 'rejected';
  heldSubmissionId = 'channel-x';
  const submissionHeld = new Promise(resolveHeld => { holdSubmission = resolveHeld; });
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await page.getByRole('button', { name: 'Resubmit for review', exact: true }).first().waitFor();
  await push.click();
  await submissionHeld;
  await page.locator('.post-editor-target.accepted').filter({ hasText: 'Company page' }).waitFor();
  releaseSubmission();
  await page.waitForFunction(() => document.querySelectorAll('.post-editor-target.accepted').length === 2);
  assert.equal(await page.getByRole('button', { name: 'Resubmit for review', exact: true }).count(), 0);
  heldSubmissionId = '';
  assert.deepEqual(errors, []);
  console.log('PASS: compact picker, image upload, autosave flush, push/retry, mobile layout; safe deletion and copy; rejected sync, audit-bound individual/bulk resubmit, stale-poll protection, hidden/in-flight guards, preserved unsaved fields/selection, neutral copy and list attention counts.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
