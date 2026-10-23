// Real composer and media preparation in a browser, with local API responses instead of a database.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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
    import React, { useCallback, useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import PostEditorView from '@/components/PostEditorView';
    import PostsView from '@/components/PostsView';
    import { LocaleContext } from '@/lib/i18n';
    import { validateVideoUpload } from '@/lib/video-upload-client';
    window.testValidateVideoUpload = validateVideoUpload;
    function Harness() {
      const [postId, setPostId] = useState(new URLSearchParams(location.search).get('postId') || 'new');
      const [showList, setShowList] = useState(new URLSearchParams(location.search).has('list'));
      const [editorSession, setEditorSession] = useState(0);
      const [navigationLocked, setNavigationLocked] = useState(false);
      const handleNavigationLock = useCallback(locked => setNavigationLocked(locked), []);
      useEffect(() => {
        const resetEditor = () => { setEditorSession(session => session + 1); setPostId('new'); setShowList(false); };
        window.addEventListener('test-editor-reset', resetEditor);
        return () => window.removeEventListener('test-editor-reset', resetEditor);
      }, []);
      return <LocaleContext.Provider value="en"><main className="content-wrap">
        <button data-testid="outer-navigation" disabled={navigationLocked} onClick={() => setShowList(true)}>Outer navigation</button>
        {showList ? <PostsView accounts={${JSON.stringify(accounts)}} accountsLoading={false} accountsError=""
          onOpenPost={setPostId} onNewPost={() => {}} onOpenAccounts={() => {}} initialStatus="all" refreshToken={0} />
          : <PostEditorView key={editorSession} postId={postId} accounts={${JSON.stringify(accounts)}} accountsLoading={false} accountsError=""
          postizUiUrl="" isAdmin={false} onBack={() => setShowList(true)} onOpened={(identifier, newSession) => {
            if (newSession) setEditorSession(session => session + 1);
            setPostId(identifier);
          }} onSaved={() => {}}
          onOpenAccounts={() => {}} onRefreshAccounts={() => {}} onDeletionPendingChange={handleNavigationLock} />}
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
    const basePath = dependency.startsWith('@/') ? resolve(repository, 'src', dependency.slice(2)) : resolve(dirname(modulePath), dependency);
    const dependencyPath = dependency === 'next/image' ? imageShimPath : dependency.startsWith('@/') || dependency.startsWith('.')
      ? existsSync(`${basePath}.ts`) ? `${basePath}.ts` : existsSync(`${basePath}.tsx`) ? `${basePath}.tsx` : createRequire(modulePath).resolve(dependency)
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
let handleVideoUpload;
const server = createServer((request, response) => {
  if (request.url === '/api/media/uploads' && request.method === 'POST') {
    void handleVideoUpload(request, response);
  } else if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    response.end(bundle);
  } else if (request.url === '/styles.css') {
    response.setHeader('Content-Type', 'text/css; charset=utf-8');
    response.end(styles);
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  }
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const origin = `http://127.0.0.1:${server.address().port}`;
const imageBuffer = await sharp({ create: { width: 120, height: 120, channels: 3, background: '#26a579' } }).png().toBuffer();
const fixtureDirectory = mkdtempSync(resolve(tmpdir(), 'polaris-composer-video-'));
let browser;
try {
  const fixturePath = resolve(fixtureDirectory, 'sample.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:r=10', '-t', '0.5',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixturePath]);
  const videoBuffer = readFileSync(fixturePath);
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    assert.equal(new URL(route.request().url()).origin, origin, 'No external network access');
    return route.fallback();
  });
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
  let submitAsynchronously = false;
  let submissionFailure = false;
  let listReadFailure = false;
  let heldSubmissionId = '';
  let holdSubmission;
  let releaseSubmission;
  const submissions = [];
  const uploads = [];
  let holdUpload;
  let releaseUpload;
  let nextUploadFailure = false;
  let nextUploadInvalid = false;
  let nextUploadStatus = 201;
  let nextUploadJob;
  let heldVideoJobId = '';
  let holdJobRead;
  let releaseJobRead;
  const processingJobs = new Map();
  const jobReads = [];
  const jobDeletes = [];
  const uploadRequestIds = [];
  const videoIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  handleVideoUpload = async (request, response) => {
    assert.equal(request.headers['content-type'], 'video/mp4');
    assert.match(request.headers['x-upload-request-id'], /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    uploadRequestIds.push(request.headers['x-upload-request-id']);
    assert.ok(decodeURIComponent(request.headers['x-file-name']).endsWith('.mp4'));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), videoBuffer, 'MP4 is sent as raw original bytes, never JSON or multipart');
    const video = { id: videoIds[uploads.length % 2], name: 'sample.mp4', bytes: videoBuffer.length, width: 64, height: 64, durationSeconds: 0.5 };
    uploads.push(video);
    const failure = nextUploadFailure;
    const invalid = nextUploadInvalid;
    const status = nextUploadStatus;
    const processing = nextUploadJob;
    nextUploadFailure = false;
    nextUploadInvalid = false;
    nextUploadStatus = 201;
    nextUploadJob = undefined;
    if (holdUpload) {
      holdUpload();
      holdUpload = null;
      await new Promise(resolveUpload => { releaseUpload = resolveUpload; });
    }
    if (processing) {
      const job = { id: `dddddddd-dddd-4ddd-8ddd-${String(uploads.length).padStart(12, '0')}`, state: 'queued', phase: 'validating', ...processing.initial };
      const reads = (processing.reads || []).map(update => ({ ...job, ...update, ...(update.state === 'succeeded' && !processing.malformedSuccess ? { video } : {}) }));
      processingJobs.set(job.id, { job, reads, failuresRemaining: processing.failuresRemaining || 0 });
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ job }));
      return;
    }
    response.writeHead(failure ? 503 : status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(failure ? { code: 'POSTIZ_UPLOAD_FAILED', error: '/private/server stderr must not be displayed' }
      : { video: invalid ? { ...video, id: 'invalid-id' } : video }));
  };
  await page.route('**/api/media/uploads**', async route => {
    if (route.request().method() === 'POST') await route.continue();
    else await route.fulfill({ contentType: 'video/mp4', body: videoBuffer });
  });
  await page.route('**/api/media/video-jobs/**', async route => {
    const request = route.request();
    const identifier = new URL(request.url()).pathname.split('/').at(-1);
    const processing = processingJobs.get(identifier);
    assert.ok(processing, 'The job route receives job JSON, never the raw MP4 POST route');
    if (request.method() === 'DELETE') {
      jobDeletes.push(identifier);
      processing.job = { ...processing.job, state: 'cancelled' };
      await route.fulfill({ json: { job: processing.job } });
      return;
    }
    assert.equal(request.method(), 'GET');
    jobReads.push(identifier);
    if (processing.failuresRemaining > 0) {
      processing.failuresRemaining -= 1;
      await route.fulfill({ status: 503, json: { error: '/private/server stderr' } });
      return;
    }
    processing.job = processing.reads.shift() || processing.job;
    const snapshot = structuredClone(processing.job);
    if (identifier === heldVideoJobId) {
      holdJobRead?.();
      holdJobRead = null;
      await new Promise(resolveRead => { releaseJobRead = resolveRead; });
    }
    await route.fulfill({ json: { job: snapshot }, headers: { 'Cache-Control': 'no-store' } });
  });
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
      const posts = storedPost ? [{ ...storedPost, excerpt: storedPost.content, hasImage: Boolean(storedPost.imageUrl), hasVideo: Boolean(storedPost.videoMediaId), status, platforms: [], rejectedCount,
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
      if (submitAsynchronously) {
        storedPost = { ...storedPost, editable: false, frozenReason: 'submitting', targets: storedPost.targets.map(target =>
          target.integrationId === integrationId ? { ...target, status: 'submitting' } : target) };
        await route.fulfill({ status: 202, json: { accepted: true, task: { state: 'queued' }, post: storedPost } });
        return;
      }
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
        imageUrl: body.videoMediaId || body.imageDataUrl === null ? null : body.imageDataUrl || storedPost?.imageUrl || null,
        videoMediaId: body.imageDataUrl ? null : body.videoMediaId === undefined ? storedPost?.videoMediaId ?? null : body.videoMediaId,
        version: (storedPost?.version || 0) + 1, editable: true, frozenReason: null,
        createdAt: timestamp, updatedAt: timestamp,
        targets: body.integrationIds.map(integrationId => ({ integrationId, platform: accounts.find(account => account.id === integrationId).identifier,
          accountName: accounts.find(account => account.id === integrationId).name, status: 'not_started', snapshotVersion: 0, postizPostId: null, auditId: null, warning: null, error: null }))
      };
    }
    await route.fulfill({ json: { post: storedPost } });
  });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined', 'LAN HTTP has no crypto.randomUUID; native uploads must still work');
  const uploadResults = await page.evaluate(async compiledSource => {
    const imageUpload = {};
    new Function('exports', compiledSource)(imageUpload);
    const canvas = document.createElement('canvas');
    canvas.width = 3000;
    canvas.height = 2000;
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
    const originalImage = await new Promise(resolveBlob => canvas.toBlob(resolveBlob, 'image/png'));
    const accepted = [];
    for (const megabytes of [10, 30]) {
      // Padding tests original-file byte limits without allocating enormous decoded pixel buffers.
      const imageFile = new File([originalImage, new Uint8Array(megabytes * 1024 * 1024 - originalImage.size)], `${megabytes}mb.png`, { type: 'image/png' });
      const prepared = await imageUpload.prepareUploadedImage(imageFile);
      accepted.push({ inputBytes: imageFile.size, outputBytes: (await (await fetch(prepared.dataUrl)).blob()).size,
        width: prepared.width, height: prepared.height, optimized: prepared.optimized });
    }
    const rejected = [];
    for (const imageFile of [
      new File([new Uint8Array(30 * 1024 * 1024 + 1)], 'oversized.png', { type: 'image/png' }),
      new File([], 'empty.png', { type: 'image/png' }),
      new File(['not an image'], 'corrupt.png', { type: 'image/png' }),
      new File(['GIF89a'], 'unsupported.gif', { type: 'image/gif' })
    ]) {
      try { await imageUpload.prepareUploadedImage(imageFile); rejected.push(null); }
      catch (error) { rejected.push(error.message); }
    }
    return { accepted, rejected };
  }, transpile(readFileSync(resolve(repository, 'src/lib/image-upload.ts'), 'utf8')));
  assert.deepEqual(uploadResults.accepted.map(result => result.inputBytes), [10, 30].map(megabytes => megabytes * 1024 * 1024));
  for (const result of uploadResults.accepted) {
    assert.ok(result.outputBytes <= 1024 * 1024, 'large originals do not enlarge saved image payloads');
    assert.ok(Math.max(result.width, result.height) <= 2048);
    assert.equal(result.optimized, true);
  }
  assert.deepEqual(uploadResults.rejected, [
    'This image exceeds 30 MB. Choose an image up to 30 MB.', 'Choose a non-empty image.',
    'Could not read this image. Please try another file.', 'Use a JPG, PNG or WebP image.'
  ]);
  const text = page.getByRole('textbox', { name: 'Post text', exact: true });
  const addPlatform = page.getByRole('button', { name: 'Add platform', exact: true });
  const push = page.getByRole('button', { name: 'Push drafts', exact: true });
  await text.waitFor();
  assert.equal(await page.locator('.post-composer-media .asset-image-help, .post-composer-media [role="alert"]').count(), 0, 'normal uploads need no persistent size hint or empty error placeholder');
  assert.doesNotMatch(await page.locator('.post-composer-media').innerText(), /30 MB/);
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
  // Click the visible row content, not just the native input: label activation blurs the
  // previously focused checkbox before it forwards the click to the next checkbox.
  const companyRow = picker.locator('.post-picker-account').filter({ hasText: 'Company page' });
  const newsRow = picker.locator('.post-picker-account').filter({ hasText: 'News desk' });
  await companyRow.locator('small').click();
  assert.equal(await page.locator('.post-account-chip').filter({ hasText: 'Company page' }).count(), 1, 'clicking the username selects the account');
  assert.equal(await picker.count(), 1, 'an internal label click must not dismiss the picker');
  assert.equal(await page.getByRole('checkbox', { name: /Company page/ }).isChecked(), true);
  assert.equal(await companyRow.locator('input').evaluate(element => getComputedStyle(element).opacity), '1', 'native checkboxes are visibly rendered');
  await newsRow.locator('strong').click();
  assert.equal(await page.getByRole('checkbox', { name: /News desk/ }).isChecked(), true, 'platform name selects the account');
  await companyRow.locator('.post-picker-platform').click();
  assert.equal(await page.getByRole('checkbox', { name: /Company page/ }).isChecked(), false, 'platform mark can deselect');
  await companyRow.click({ position: { x: 250, y: 5 } });
  assert.equal(await page.getByRole('checkbox', { name: /Company page/ }).isChecked(), true, 'row padding also toggles the account');
  await page.getByRole('checkbox', { name: /Company page/ }).click();
  assert.equal(await page.getByRole('checkbox', { name: /Company page/ }).isChecked(), false, 'native checkbox changes exactly once');
  await page.getByRole('checkbox', { name: /Company page/ }).press('Space');
  assert.equal(await page.getByRole('checkbox', { name: /Company page/ }).isChecked(), true, 'space toggles the checkbox');
  assert.equal(await page.getByRole('checkbox', { name: /Disconnected/ }).isDisabled(), true);
  const disabledAccountBounds = await picker.locator('.post-picker-account').filter({ hasText: 'Disconnected' }).locator('strong').boundingBox();
  await page.mouse.click(disabledAccountBounds.x + disabledAccountBounds.width / 2, disabledAccountBounds.y + disabledAccountBounds.height / 2);
  assert.equal(await page.locator('.post-account-chip').filter({ hasText: 'Disconnected' }).count(), 0, 'disabled account rows do not select');
  await page.getByRole('checkbox', { name: /News desk/ }).press('Escape');
  assert.equal(await page.locator('.post-account-picker').count(), 0);
  assert.equal(await addPlatform.evaluate(element => document.activeElement === element), true);
  await addPlatform.click();
  await text.click();
  assert.equal(await picker.count(), 0, 'click outside closes the picker');
  await addPlatform.click();
  await picker.getByRole('button', { name: 'Manage accounts', exact: true }).focus();
  await page.keyboard.press('Tab');
  await picker.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Remove account: Company page', exact: true }).click();
  assert.equal(await page.locator('.post-editor-target').count(), 1, 'summary updates before autosave');
  await text.fill('Draft content that stays local until pushed.');
  const maximumSizeImage = Buffer.alloc(30 * 1024 * 1024);
  imageBuffer.copy(maximumSizeImage);
  const imageInput = page.getByLabel('Upload post media', { exact: true });
  await imageInput.setInputFiles({ name: '30mb.png', mimeType: 'image/png', buffer: maximumSizeImage });
  await page.locator('.post-media-thumbnail img').waitFor();
  const uploadedPreview = await page.locator('.post-media-thumbnail img').getAttribute('src');
  assert.ok(Buffer.from(uploadedPreview.split(',')[1], 'base64').length <= 1024 * 1024);
  await imageInput.setInputFiles({ name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(30 * 1024 * 1024 + 1) });
  await page.getByRole('alert').filter({ hasText: 'This image exceeds 30 MB. Choose an image up to 30 MB.' }).waitFor();
  assert.equal(await page.locator('.post-media-thumbnail img').getAttribute('src'), uploadedPreview, 'a rejected replacement preserves the current image');
  assert.equal(await imageInput.isEnabled(), true);
  await imageInput.setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: imageBuffer });
  await page.locator('.post-composer-media [role="alert"]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Replace image', exact: true }).first().waitFor();
  assert.doesNotMatch(await page.locator('.post-composer-media').innerText(), /30 MB/);
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
  await picker.locator('.post-picker-account').filter({ hasText: 'News desk' }).locator('small').click();
  await picker.locator('.post-picker-account').filter({ hasText: 'Company page' }).locator('small').click();
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
  assert.match(await page.locator('.info-banner.frozen').innerText(), /read-only.*review rejected/is);
  assert.equal(await page.locator('.info-banner.frozen').getByRole('button', { name: 'Copy as new draft', exact: true }).isEnabled(), true);
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
  storedPost = undefined;
  submitAsynchronously = true;
  await page.goto(origin);
  await text.fill('An asynchronously submitted draft');
  await addPlatform.click();
  await page.getByRole('checkbox', { name: /News desk/ }).click();
  await page.getByRole('checkbox', { name: /News desk/ }).press('Escape');
  await push.click();
  await page.locator('.post-editor-target.submitting').waitFor();
  assert.equal(await page.locator('.post-editor-aside-foot, .post-draft-destination').count(), 0, 'The submission button and target status need no duplicate process note');
  assert.equal(await page.getByText('Submission accepted. Processing in the background; you can close this dialog or leave this page.', { exact: true }).count(), 0, '202 is represented by the target status, not a permanent success banner');
  assert.equal(await page.locator('.post-editor-target.submitting').count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Back to posts', exact: true }).isEnabled(), true, '202 releases navigation while the worker remains pending');
  const pendingPostId = storedPost.id;
  await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
  await page.locator('.posts-view').waitFor();
  await page.goto(`${origin}/?postId=${pendingPostId}`);
  await page.locator('.post-editor-target.submitting').waitFor();
  storedPost = { ...storedPost, frozenReason: 'accepted', targets: storedPost.targets.map(target => ({ ...target,
    status: 'accepted', postizPostId: 'background-draft', auditId: 'background-audit' })) };
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.locator('.post-editor-target.accepted').waitFor();
  console.log('PASS: original composer, image, copy/delete, review, autosave and async submission safeguards.');

  // MP4 stays an independent raw upload; only a validated local id becomes draft state.
  submitAsynchronously = false;
  storedPost = { ...structuredClone(originalPost), content: 'A video draft', imageUrl: `data:image/png;base64,${imageBuffer.toString('base64')}`,
    videoMediaId: null, editable: true, frozenReason: null, targets: [] };
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  const videoInput = page.getByLabel('Upload post media', { exact: true });
  const videoPreview = page.locator('.post-media-thumbnail video');
  const saveDraft = page.getByRole('button', { name: 'Save draft', exact: true });
  const outerNavigation = page.getByTestId('outer-navigation');
  const videoFile = { name: 'sample.mp4', mimeType: 'video/mp4', buffer: videoBuffer };
  const writes = () => requests.filter(request => request.method !== 'GET').length;
  const expectedOldImage = storedPost.imageUrl;
  assert.match(await videoInput.getAttribute('accept'), /video\/mp4/);
  assert.doesNotMatch(await videoInput.getAttribute('accept'), /video\/\*/);
  assert.doesNotMatch(await page.locator('.post-composer-media').innerText(), /100 MB|30 MB/);
  const boundary = await page.evaluate(() => {
    const maximum = new File([new Uint8Array(100 * 1024 * 1024)], 'limit.mp4', { type: 'video/mp4' });
    window.testValidateVideoUpload(maximum);
    const rejected = [];
    for (const file of [new File([maximum, new Uint8Array(1)], 'too-large.mp4', { type: 'video/mp4' }),
      new File([], 'empty.mp4', { type: 'video/mp4' }), new File(['mov'], 'other.mov', { type: 'video/quicktime' })]) {
      try { window.testValidateVideoUpload(file); } catch (error) { rejected.push(error.message); }
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([maximum, new Uint8Array(1)], 'too-large.mp4', { type: 'video/mp4' }));
    const input = document.querySelector('input[type=file]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return rejected;
  });
  assert.deepEqual(boundary, ['This video exceeds 100 MB. Choose an MP4 up to 100 MB.', 'Choose a non-empty MP4 video.', 'Use a JPG, PNG, WebP image or an MP4 video.']);
  await page.getByRole('alert').filter({ hasText: 'exceeds 100 MB' }).waitFor();
  assert.equal(uploads.length, 0, 'oversized video is rejected before network work');
  assert.equal(await page.locator('.post-media-thumbnail img').getAttribute('src'), expectedOldImage);
  nextUploadFailure = true;
  await videoInput.setInputFiles(videoFile);
  await page.getByRole('alert').filter({ hasText: 'Could not save the video' }).waitFor();
  assert.equal(await page.locator('.post-media-thumbnail img').getAttribute('src'), expectedOldImage, 'failed MP4 preserves the old image');
  nextUploadInvalid = true;
  await videoInput.setInputFiles(videoFile);
  await page.getByRole('alert').filter({ hasText: 'Could not upload this video' }).waitFor();
  assert.equal(storedPost.videoMediaId, null, 'a malformed successful response cannot become draft media');

  await page.evaluate(() => {
    window.testRevokedUrls = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = value => { window.testRevokedUrls.push(value); revoke(value); };
  });
  const slowStarted = new Promise(resolveStarted => { holdUpload = resolveStarted; });
  await text.fill('Text typed just before a slow video upload');
  await videoInput.setInputFiles(videoFile);
  await slowStarted;
  await page.locator('.asset-video-progress').filter({ hasText: 'Waiting for processing' }).waitFor();
  assert.match(await videoPreview.getAttribute('src'), /^blob:/);
  const localPreviewUrl = await videoPreview.getAttribute('src');
  await videoPreview.evaluate(element => new Promise((resolveReady, rejectReady) => {
    if (element.readyState >= 1) resolveReady();
    else { element.onloadedmetadata = resolveReady; element.onerror = () => rejectReady(new Error('Local MP4 cannot be played')); }
  }));
  assert.equal(await videoPreview.evaluate(element => element.videoWidth), 64, 'actual H.264 MP4 metadata plays locally');
  const writesDuringUpload = writes();
  assert.equal(await saveDraft.isDisabled(), true);
  assert.equal(await push.isDisabled(), true);
  assert.equal(await outerNavigation.isDisabled(), true, 'outer navigation shares the synchronous upload lock');
  assert.equal(await page.getByRole('button', { name: 'Back to posts', exact: true }).isDisabled(), true);
  assert.equal(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), true, 'closing the page warns during upload, even before a usable id exists');
  await page.waitForTimeout(1400);
  assert.equal(writes(), writesDuringUpload, 'an already queued autosave cannot save during server validation');
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  const releaseCancelledUpload = releaseUpload;
  assert.equal(await page.locator('.post-media-thumbnail img').getAttribute('src'), expectedOldImage, 'cancel restores old image');
  assert.equal(await outerNavigation.isEnabled(), true);
  assert.ok(await page.evaluate(value => window.testRevokedUrls.includes(value), localPreviewUrl), 'cancel revokes the local URL');

  const replacementStarted = new Promise(resolveStarted => { holdUpload = resolveStarted; });
  await videoInput.setInputFiles(videoFile);
  await replacementStarted;
  releaseCancelledUpload();
  await page.waitForTimeout(100);
  assert.equal(await outerNavigation.isDisabled(), true, 'late old finally cannot unlock a newer upload');
  assert.equal(await videoInput.isDisabled(), true);
  const firstVideoId = uploads.at(-1).id;
  releaseUpload();
  await page.waitForFunction(expected => document.querySelector('.post-media-thumbnail video')?.getAttribute('src') === `/api/media/uploads/${expected}`, firstVideoId);
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(storedPost.videoMediaId, firstVideoId);
  assert.equal(storedPost.imageUrl, null, 'a saved video atomically clears the image');
  assert.equal(await page.locator('.post-media-thumbnail img').count(), 0);
  assert.doesNotMatch(await page.locator('.post-composer-media').innerText(), /100 MB|30 MB/);

  // A save response for image=='' must not discard a different, newly selected video id.
  delayNextSave = true;
  const oldSaveStarted = new Promise(resolveStarted => { holdSave = resolveStarted; });
  await text.fill('Old save snapshot with the first video');
  await oldSaveStarted;
  const secondUploadCompleted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/media/uploads');
  nextUploadStatus = 200;
  await videoInput.setInputFiles(videoFile);
  assert.equal((await secondUploadCompleted).status(), 200, 'A successful receipt replay remains compatible');
  const secondVideoId = uploads.at(-1).id;
  await page.waitForFunction(expected => document.querySelector('.post-media-thumbnail video')?.getAttribute('src') === `/api/media/uploads/${expected}`, secondVideoId);
  assert.notEqual(secondVideoId, firstVideoId);
  releaseSave();
  await page.waitForFunction(expected => document.querySelector('.post-media-thumbnail video')?.getAttribute('src') === `/api/media/uploads/${expected}`
    && document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'), secondVideoId);
  assert.equal(storedPost.videoMediaId, secondVideoId, 'the newer id still dirties and autosaves after the old save completes');
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await videoPreview.waitFor();
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${secondVideoId}`, 'reopening uses the durable id');
  const copiedVideoLoaded = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === '/api/posts/22222222-2222-4222-8222-222222222222');
  await page.getByRole('button', { name: 'Copy as new draft', exact: true }).click();
  await copiedVideoLoaded;
  await page.waitForFunction(() => !document.querySelector('input[type=file]')?.disabled);
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${secondVideoId}`, 'copy shares the local media reference');

  const cancelledReplacementStarted = new Promise(resolveStarted => { holdUpload = resolveStarted; });
  await videoInput.setInputFiles(videoFile);
  await cancelledReplacementStarted;
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  releaseUpload();
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${secondVideoId}`, 'cancelled replacement preserves old video');
  nextUploadFailure = true;
  await videoInput.setInputFiles(videoFile);
  await page.getByRole('alert').filter({ hasText: 'Could not save the video' }).waitFor();
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${secondVideoId}`, 'failed replacement preserves old video');
  await videoInput.setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: imageBuffer });
  await page.locator('.post-media-thumbnail img').waitFor();
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(storedPost.videoMediaId, null, 'image replacement clears video reference');
  assert.ok(storedPost.imageUrl.startsWith('data:image/'));
  const instagramUploadCompleted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  await instagramUploadCompleted;
  await page.waitForFunction(() => document.querySelector('.post-media-thumbnail video')?.getAttribute('src')?.startsWith('/api/media/uploads/'));
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  await addPlatform.click();
  await page.getByRole('checkbox', { name: /Photo desk/ }).check();
  await page.getByRole('checkbox', { name: /Photo desk/ }).press('Escape');
  assert.equal(await push.isEnabled(), true, 'video satisfies Instagram media validation');
  const instagramVideoId = storedPost.videoMediaId;
  submitAsynchronously = true;
  await push.click();
  await page.locator('.post-editor-target.submitting').waitFor();
  assert.equal(storedPost.videoMediaId, instagramVideoId);
  assert.equal(await outerNavigation.isEnabled(), true, '202 releases navigation after the video reference has been saved');
  await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
  await page.locator('.posts-view').waitFor();
  await page.locator('.posts-row-thumb [aria-label="Post video"]').waitFor();
  assert.equal(await page.locator('.posts-row-thumb [aria-label="Post video"]').count(), 1);
  assert.equal(await page.locator('.posts-row-thumb video').count(), 0, 'listing never downloads full videos');

  // Forcible editor replacement aborts and isolates its old completion from a new draft session.
  storedPost = undefined;
  await page.goto(origin);
  const abandonedStarted = new Promise(resolveStarted => { holdUpload = resolveStarted; });
  await videoInput.setInputFiles(videoFile);
  await abandonedStarted;
  await page.evaluate(() => window.dispatchEvent(new Event('test-editor-reset')));
  releaseUpload();
  await page.waitForTimeout(1400);
  assert.equal(await videoPreview.count(), 0);
  assert.equal(storedPost, undefined, 'late uploaded id cannot leak into a replacement session');
  const videoOnlyCompleted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  await videoOnlyCompleted;
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.ok(storedPost.videoMediaId, 'a video-only new draft is not mistaken for an untouched page');
  assert.equal(storedPost.content, '');
  assert.equal(storedPost.imageUrl, null);
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${storedPost.videoMediaId}`, 'new-to-id upgrade keeps the successful attachment');
  await page.getByRole('button', { name: 'Remove video', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(storedPost.videoMediaId, null, 'removing the video saves an explicit null reference');

  // Back waits for the latest snapshot, and does not permit a new upload in that wait window.
  delayNextSave = true;
  const leavingSaveStarted = new Promise(resolveStarted => { holdSave = resolveStarted; });
  await text.fill('Earlier snapshot before leaving');
  await leavingSaveStarted;
  await text.fill('Latest snapshot before leaving');
  await page.getByRole('button', { name: 'Back to posts', exact: true }).click();
  assert.equal(await videoInput.isDisabled(), true);
  assert.equal(await text.isDisabled(), true);
  assert.equal(await outerNavigation.isDisabled(), true);
  const uploadsBeforeLeaving = uploads.length;
  await videoInput.setInputFiles(videoFile);
  assert.equal(uploads.length, uploadsBeforeLeaving, 'return-to-list save cannot admit a new upload');
  releaseSave();
  await page.locator('.posts-row').first().waitFor();
  assert.equal(storedPost.content, 'Latest snapshot before leaving', 'Back flushes a newer edit after an older autosave');

  // A delayed explicit Reload cannot overwrite a video selected while its old GET was pending.
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  conflictNextSave = true;
  await text.fill('A conflict that requires reloading');
  await page.getByRole('alert').filter({ hasText: 'changed in another tab' }).waitFor();
  const reloadStarted = new Promise(resolveStarted => { holdRead = resolveStarted; });
  await page.getByRole('button', { name: 'Reload post', exact: true }).click();
  await reloadStarted;
  assert.equal(await videoInput.isDisabled(), true);
  assert.equal(await text.isDisabled(), true);
  assert.equal(await outerNavigation.isDisabled(), true);
  const uploadsBeforeReloading = uploads.length;
  await videoInput.setInputFiles(videoFile);
  assert.equal(uploads.length, uploadsBeforeReloading, 'reload locks media until its server snapshot settles');
  releaseRead();
  await page.getByRole('button', { name: 'Reload post', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await videoInput.isEnabled(), true);
  assert.equal(await outerNavigation.isEnabled(), true, 'reload restores the outer navigation lock');
  assert.equal(await text.inputValue(), 'Latest snapshot before leaving');

  // Real composer async processing: POST returns immediately while validation/conversion stays pending.
  storedPost = { ...structuredClone(originalPost), imageUrl: expectedOldImage, videoMediaId: null,
    targets: [{ integrationId: 'channel-x', platform: 'x', accountName: 'News desk', status: 'not_started' }] };
  await page.goto(`${origin}/?postId=${storedPost.id}`);
  await text.waitFor();
  nextUploadJob = { reads: [{ state: 'failed', phase: 'converting', code: 'VIDEO_CONVERSION_FAILED', error: '/private/ffmpeg stderr' }] };
  await videoInput.setInputFiles(videoFile);
  await page.getByRole('alert').filter({ hasText: 'Could not convert this video' }).waitFor();
  assert.equal(await page.locator('.post-media-thumbnail img').getAttribute('src'), expectedOldImage, 'Failed job preserves the old image');
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /private|stderr/);
  assert.equal(await push.isEnabled(), true);

  nextUploadJob = {};
  const asyncPostResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/media/uploads');
  const uploadCountBeforeProcessing = uploads.length;
  const readsBeforeProcessing = jobReads.length;
  await videoInput.setInputFiles(videoFile);
  const queuedResponse = await asyncPostResponse;
  assert.equal(queuedResponse.status(), 202);
  const queuedJob = (await queuedResponse.json()).job;
  const controlledProcessing = processingJobs.get(queuedJob.id);
  assert.equal(jobReads.length, readsBeforeProcessing, 'POST 202 does not wait for even the first processing poll');
  const writesBeforeProcessing = writes();
  const processingLabels = ['Video queued…', 'Validating video…', 'Converting video to H.264…', 'Saving video…'];
  const processingUpdates = [{ state: 'running', phase: 'validating' }, { state: 'running', phase: 'converting' },
    { state: 'running', phase: 'saving' }, { state: 'succeeded', phase: 'saving', video: uploads.at(-1) }];
  for (const [phaseIndex, label] of processingLabels.entries()) {
    await page.locator('.asset-video-progress').filter({ hasText: label }).waitFor();
    for (const control of [saveDraft, push, outerNavigation, page.getByRole('button', { name: 'Back to posts', exact: true })]) {
      assert.equal(await control.isDisabled(), true, `${label} retains every media busy lock`);
    }
    assert.equal(writes(), writesBeforeProcessing, 'No autosave/push during queued/running processing');
    assert.equal(storedPost.videoMediaId, null, 'Unfinished job never becomes a draft media reference');
    if (label === 'Converting video to H.264…') {
      await videoPreview.evaluate(element => element.dispatchEvent(new Event('error')));
      assert.equal(await page.getByRole('alert').count(), 0, 'Unsupported local preview does not reject server conversion');
      assert.equal(await videoPreview.evaluate(element => element.autoplay), false, 'Local preview never auto-plays');
    }
    controlledProcessing.job = { ...controlledProcessing.job, ...processingUpdates[phaseIndex] };
  }
  await page.waitForFunction(() => document.querySelector('.post-media-thumbnail video')?.getAttribute('src')?.startsWith('/api/media/uploads/'));
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  const processedVideoId = storedPost.videoMediaId;
  assert.ok(processedVideoId);
  assert.equal(storedPost.imageUrl, null);
  assert.equal(uploads.length, uploadCountBeforeProcessing + 1, 'All processing phases reuse exactly one raw-file POST');

  nextUploadJob = { reads: [{ state: 'failed', phase: 'saving', code: 'POSTIZ_UPLOAD_FAILED', error: '/private/server path' }] };
  await videoInput.setInputFiles(videoFile);
  await page.getByRole('alert').filter({ hasText: 'Could not save the video' }).waitFor();
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${processedVideoId}`, 'Failed job preserves the previous video');
  for (const processing of [{ initial: { state: 'succeeded' } }, { malformedSuccess: true, reads: [{ state: 'succeeded', phase: 'saving' }] }]) {
    nextUploadJob = processing;
    await videoInput.setInputFiles(videoFile);
    await page.getByRole('alert').waitFor();
    assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${processedVideoId}`, 'Malformed job success never replaces the previous media');
    assert.equal(await videoInput.isEnabled(), true);
  }
  assert.match(await page.getByRole('alert').innerText(), /may still be running.*Video job ID:/, 'Unconfirmed GET keeps safe job receipt information');

  // Exhaust the three transient retries, then recover the SAME job without resending the File.
  const retryProcessing = page.getByRole('button', { name: 'Retry processing status', exact: true });
  nextUploadJob = { failuresRemaining: 4 };
  const recoveryPost = page.waitForResponse(response => response.status() === 202 && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  const recoveryJob = (await (await recoveryPost).json()).job;
  await retryProcessing.waitFor();
  assert.equal(jobReads.filter(identifier => identifier === recoveryJob.id).length, 4);
  assert.equal(jobDeletes.includes(recoveryJob.id), false, 'Status failure never secretly cancels the original job');
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${processedVideoId}`);
  assert.equal(await outerNavigation.isEnabled(), true, 'Old attachments can still be saved while status is unconfirmed');
  const recoveryUploadCount = uploads.length;
  const recoveryRequestIds = [...uploadRequestIds];
  processingJobs.get(recoveryJob.id).job = { ...recoveryJob, state: 'succeeded', phase: 'saving', video: uploads.at(-1) };
  await retryProcessing.click();
  assert.equal(await saveDraft.isDisabled(), true);
  assert.equal(await push.isDisabled(), true);
  assert.equal(await outerNavigation.isDisabled(), true);
  await page.locator('.asset-video-progress').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('.post-editor-save-state')?.textContent.includes('Saved'));
  assert.equal(storedPost.videoMediaId, uploads.at(-1).id);
  assert.equal(uploads.length, recoveryUploadCount, 'Recovery performs no second raw upload');
  assert.deepEqual(uploadRequestIds, recoveryRequestIds, 'Recovery creates no new request ID');
  assert.equal(await retryProcessing.count(), 0);
  const recoveredVideoId = storedPost.videoMediaId;

  // A held late GET from a cancelled session cannot unlock or mutate a newer queued job.
  nextUploadJob = { failuresRemaining: 4, reads: [{ state: 'succeeded', phase: 'saving' }] };
  const firstQueuedResponse = page.waitForResponse(response => response.status() === 202 && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  const firstQueuedJob = (await (await firstQueuedResponse).json()).job;
  await retryProcessing.waitFor();
  heldVideoJobId = firstQueuedJob.id;
  const oldReadStarted = new Promise(resolveStarted => { holdJobRead = resolveStarted; });
  await retryProcessing.click();
  await oldReadStarted;
  const deletedOldJob = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(firstQueuedJob.id));
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await deletedOldJob;
  assert.equal(await videoPreview.getAttribute('src'), `/api/media/uploads/${recoveredVideoId}`);
  nextUploadJob = {};
  const secondQueuedResponse = page.waitForResponse(response => response.status() === 202 && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  const secondQueuedJob = (await (await secondQueuedResponse).json()).job;
  releaseJobRead();
  heldVideoJobId = '';
  await page.waitForTimeout(100);
  assert.equal(await outerNavigation.isDisabled(), true, 'Late cancelled GET cannot unlock a new queued job');
  assert.equal(await videoInput.isDisabled(), true);
  assert.equal(storedPost.videoMediaId, recoveredVideoId, 'Late cancelled recovery success cannot replace saved media');
  assert.equal(jobDeletes.includes(secondQueuedJob.id), false, 'Old cleanup never cancels the new job');
  const deletedNewJob = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(secondQueuedJob.id));
  await page.getByRole('button', { name: 'Cancel upload', exact: true }).click();
  await deletedNewJob;
  assert.equal(await outerNavigation.isEnabled(), true);

  nextUploadJob = {};
  const abandonedJobResponse = page.waitForResponse(response => response.status() === 202 && new URL(response.url()).pathname === '/api/media/uploads');
  await videoInput.setInputFiles(videoFile);
  const abandonedJob = (await (await abandonedJobResponse).json()).job;
  const abandonedJobDeleted = page.waitForRequest(request => request.method() === 'DELETE' && request.url().endsWith(abandonedJob.id));
  await page.evaluate(() => window.dispatchEvent(new Event('test-editor-reset')));
  await abandonedJobDeleted;
  await page.waitForTimeout(100);
  assert.equal(await videoPreview.count(), 0, 'Unmounted job cannot leak media into the fresh session');
  assert.equal(await outerNavigation.isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log('PASS: async video phases and early 202, queue/running locks, safe failed/malformed jobs, same-job status recovery without POST/request ID, cancelled recovery fencing and unmount isolation.');
  console.log('PASS: original composer safeguards; raw MP4 upload, 100 MiB boundary, local playback, validation-stage busy/navigation guards, failure/cancel recovery, stale completion fencing, save/reopen/copy, image/video exclusion, Instagram and async 202 navigation.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
