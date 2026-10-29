import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openWorkspace, signIn } from './_login.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load as html } from 'cheerio';
import sharp from 'sharp';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function loadModule(path, mocks = {}, cache = new Map()) {
  if (cache.has(path)) return cache.get(path).exports;
  const loaded = { exports: {} };
  cache.set(path, loaded);
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (!name.startsWith('.') && !name.startsWith('@/')) return createRequire(path)(name);
    const target = name.startsWith('@/') ? resolve(repository, 'src', name.slice(2)) : resolve(dirname(path), name);
    return loadModule(existsSync(target + '.ts') ? target + '.ts' : target + '.tsx', mocks, cache);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const { projectSchema, saveProjectSchema } = loadModule(resolve(repository, 'src/lib/project-schema.ts'));
const imageIds = [randomUUID(), randomUUID()];
const testAsset = { id: 'asset', platform: 'x', assetType: 'short_post', title: 'Images', content: 'Ordered images', factIds: [], riskFlags: [], updatedAt: new Date().toISOString() };
const testSnapshot = {
  schemaVersion: 1,
  config: { name: 'Images', title: '', category: '', language: 'en', audience: '', cta: '', websiteUrl: '', sourceUrl: '', tone: '', publishDate: '', imageUrl: 'https://example.test/article.jpg' },
  sourceText: '', sourceName: '', sourcePending: false, importedSource: null, editedConfig: [], analysis: null,
  assets: [{ ...testAsset, imageMediaIds: imageIds }, { ...testAsset, id: 'empty', imageMediaIds: [], imageUrl: 'https://example.test/stale.jpg' }],
  selectedPlatforms: ['x'], threads: {}, usedFallback: false, generationRun: 'images'
};
assert.deepEqual(projectSchema.parse(testSnapshot).assets.map(asset => asset.imageMediaIds), [imageIds, []]);
for (const imageMediaIds of [['bad'], [imageIds[0], imageIds[0].toUpperCase()], Array.from({ length: 11 }, () => randomUUID())]) {
  assert.equal(projectSchema.safeParse({ ...testSnapshot, assets: [{ ...testAsset, imageMediaIds }] }).success, false);
}
assert.equal(projectSchema.safeParse({ ...testSnapshot, assets: [{ ...testAsset, imageMediaIds: [], videoMediaId: randomUUID() }] }).success, true);
for (const imageMediaIds of [imageIds]) {
  assert.equal(projectSchema.safeParse({ ...testSnapshot, assets: [{ ...testAsset, imageMediaIds, videoMediaId: randomUUID() }] }).success, false);
}
for (const forged of ['uploadedMedia', 'uploadedImages', 'postizMediaId', 'postizPath']) {
  assert.equal(saveProjectSchema.safeParse({ id: randomUUID(), version: 0, snapshot: { ...testSnapshot, assets: [{ ...testAsset, [forged]: 'forged' }] } }).success, false);
}
const translations = loadModule(resolve(repository, 'src/lib/i18n.tsx'));
const Preview = loadModule(resolve(repository, 'src/components/SocialPreview.tsx')).default;
for (const language of ['en', 'zh', 'vi', 'th']) {
  const render = asset => html(renderToStaticMarkup(React.createElement(translations.LocaleContext.Provider, { value: language }, React.createElement(Preview, { asset, imageUrl: testSnapshot.config.imageUrl }))));
  const collection = render(testSnapshot.assets[0]);
  assert.equal(collection('.mock-image').attr('src'), `/api/media/images/${imageIds[0]}`);
  assert.match(collection('.preview-platform-bar').text(), /2/);
  assert.equal(render(testSnapshot.assets[1])('.mock-image').length, 0, 'explicit empty image refs suppress both scalar and article fallback');
  for (const key of ['Add images', 'Image uploads', 'Move image left', 'Move image right', 'Upload cancelled', 'Uploading image…', 'Waiting to upload', 'Attach up to 10 images.', 'X supports up to 4 images.', 'Attach either images or one MP4 video, not both.', 'Could not upload this image. Please try again.']) {
    if (language !== 'en') assert.notEqual(translations.translate(language, key), key, `${language}: ${key}`);
  }
}
const ownershipCalls = [];
let refuseImages = false;
let rollbacks = 0;
let commits = 0;
const connection = { beginTransaction: async () => {}, rollback: async () => { rollbacks++; }, commit: async () => { commits++; }, release() {}, execute: async sql => sql.startsWith('SELECT') ? [[]] : [{}] };
const projectRoute = loadModule(resolve(repository, 'src/app/api/projects/route.ts'), {
  'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
  '@/lib/auth': { currentUser: async () => ({ ownerHash: 'owner-hash', user: { id: 'owner' } }) },
  '@/lib/project-db': { database: () => ({ getConnection: async () => connection }) },
  '@/lib/same-origin': { isSameOrigin: () => true },
  '@/lib/video-uploads': { ownsVideoUploads: async () => true },
  '@/lib/image-uploads': { getImageUploads: async (owner, ids, transaction) => { ownershipCalls.push({ owner, ids, transaction }); if (refuseImages) throw new Error('not owned'); return []; } }
});
const saveRequest = snapshot => new Request('https://studio.test/api/projects', { method: 'PUT', body: JSON.stringify({ id: randomUUID(), version: 0, snapshot }) });
assert.equal((await projectRoute.PUT(saveRequest(testSnapshot))).status, 200);
assert.equal(commits, 1);
assert.deepEqual(ownershipCalls.map(call => [call.owner, call.ids]), [['owner', imageIds]], 'server checks ordered refs under the project transaction, skipping explicit empty');
assert.equal(ownershipCalls[0].transaction, connection);
refuseImages = true;
const deniedImages = await projectRoute.PUT(saveRequest(testSnapshot));
assert.equal(deniedImages.status, 400);
assert.equal((await deniedImages.json()).code, 'INVALID_IMAGE');
assert.equal(commits, 1, 'unowned refs never commit');
assert.equal(rollbacks, 1);
console.log('PASS: project ordered UUID references, explicit empty fallback, image/video exclusion, forged upstream fields, owner validation/rollback and four-locale preview labels.');
const studioTree = ts.createSourceFile('ContentStudio.tsx', readFileSync(resolve(repository, 'src/components/ContentStudio.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const studioNodes = [];
function collectNodes(node) { studioNodes.push(node); ts.forEachChild(node, collectNodes); }
collectNodes(studioTree);
function studioFunction(name, context) {
  const node = studioNodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  const compiled = ts.transpileModule(node.getText(studioTree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), `${compiled}; return ${name};`)(...Object.values(context));
}
let savedAsset;
studioFunction('saveAsset', {
  selectedAsset: testSnapshot.assets[0], imageUploadingRef: { current: false }, deliveryDraft: '{}', rewriteSequence: { current: 0 }, setRewriting() {},
  setAssets: update => { savedAsset = update([{ ...testAsset, content: 'Older content' }])[0]; }, getAssetStatusFields: () => ({}),
  setSelectedAsset() {}, clearCandidates() {}, notify() {}, t: text => text
})();
assert.deepEqual(savedAsset.imageMediaIds, imageIds, 'AI drawer saves the exact ordered collection');
const viewExpression = studioNodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(studioTree) === 'viewAsset').initializer.getText(studioTree);
const previewCandidate = new Function('previewCandidate', 'selectedAsset', `return ${viewExpression};`);
assert.deepEqual(previewCandidate({ asset: { ...testAsset, imageMediaIds: [randomUUID()] } }, savedAsset).imageMediaIds, imageIds, 'model candidate media cannot replace selected images');
const mediaHelpers = loadModule(resolve(repository, 'src/lib/image-types.ts'));
let sentPayload;
const submit = studioFunction('submitDraft', {
  imageUploadingRef: { current: false }, acceptanceFlights: { current: new Set() }, channelsLoading: false, channelsError: '', socialAccounts: [{ id: 'channel', identifier: 'x' }],
  getMatchingSocialAccounts: accounts => accounts, currentProjectRef: { current: 'project' }, packSequence: { current: 0 }, submissionAttempts: { current: new Map() },
  setAssets() {}, setSelectedAsset() {}, setPublishModalAsset() {}, setAcceptingAssetIds() {}, config: testSnapshot.config, imageSelectionError: mediaHelpers.imageSelectionError,
  createClientId: randomUUID, notify() {}, t: text => text, readJson: response => response.json(),
  fetch: async (url, options) => { sentPayload = JSON.parse(options.body); return Response.json({ error: 'Synthetic refusal' }, { status: 400 }); }
});
for (const asset of testSnapshot.assets) {
  await submit(asset, 'channel');
  assert.deepEqual(sentPayload.imageMediaIds, asset.imageMediaIds);
  assert.equal(Object.hasOwn(sentPayload, 'imageUrl'), false, 'AI submission sends explicit refs, not article/scalar fallback');
}
const zipFiles = new Map();
let exported = false;
let exportNotice = '';
await studioFunction('exportPackage', {
  assets: testSnapshot.assets, config: testSnapshot.config, analysis: null, setLoading() {}, t: text => text, getImagePreviewUrl: mediaHelpers.getImagePreviewUrl,
  JSZip: class { file(name, value) { zipFiles.set(name, value); } async generateAsync() { return new Blob(); } },
  fetch: async url => { assert.match(url, /\?download=1$/); return new Response(new Blob(['image bytes'], { type: url.includes(imageIds[0]) ? 'image/png' : 'image/webp' })); },
  URL: { createObjectURL: () => 'blob:export', revokeObjectURL() {} }, document: { createElement: () => ({ click: () => { exported = true; } }) }, notify: message => { exportNotice = message; }
})();
assert.equal(exported, true);
assert.equal(exportNotice, 'Content pack exported.');
assert.deepEqual(JSON.parse(zipFiles.get('x/asset.json')).imageMediaIds, imageIds);
const manifest = JSON.parse(zipFiles.get('x/asset-images.json'));
assert.deepEqual(manifest.map(image => image.id), imageIds);
assert.ok(zipFiles.has(`x/asset-images/1-${imageIds[0]}.png`));
assert.ok(zipFiles.has(`x/asset-images/2-${imageIds[1]}.webp`));
assert.deepEqual(JSON.parse(zipFiles.get('x/empty-images.json')), []);
console.log('PASS: actual AI save/candidate/submission preserves ordered refs and explicit empty; ZIP exports ordered URLs/manifest and owner bytes with truthful MIME extensions.');
if (process.argv.includes('--schema-only')) process.exit(0);

const base=process.env.TEST_BASE_URL || 'http://localhost:3002';
const browser=await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
const source='Fictional storage test. Example Company opens at 09:00 and closes at 17:00. '.repeat(4);
let alice, bob;
try {
 const context=await browser.newContext();
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/analyze',r=>r.fulfill({json:{summaryShort:'Storage test',summaryLong:'Fictional source.',keyTerms:['Test'],riskFlags:[],facts:[{id:'F001',type:'claim',text:'Example Company opens at 09:00.',sourceExcerpt:'Example Company opens at 09:00 and closes at 17:00.',sourceLocation:'Test',verified:false,usableOnSocial:true,riskLevel:'low'}]}}));
 await page.route('**/api/generate',r=>{const p=r.request().postDataJSON().platforms[0];return r.fulfill({json:{assets:[{id:`storage-${p}`,platform:p,assetType:'test',title:'Storage test '+p,content:'Persisted fictional content.',cta:'Read the test',factIds:['F001'],riskFlags:[],status:'needs_review',generationMode:'ai',meta:{note:'test'},updatedAt:new Date().toISOString()}],usedFallback:false}});});
 alice=await signIn(page,base,{displayName:'Storage Alice'});
 await openWorkspace(page);
 // The source panel opens on the URL tab; the paste textarea only exists on the text tab.
 await page.locator('.segmented-tab').nth(1).click();
 await page.locator('.source-textarea').fill(source);
 // Current flow: analyse the source, then generate from the confirmed facts in the references view.
 await page.locator('.distribution-panel .panel-actions .primary-button').click();
 await page.locator('.main-nav .nav-item').filter({hasText:'Source references'}).click();
 await page.getByRole('button',{name:/Generate confirmed facts/}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===5);
 await page.waitForFunction(()=>document.querySelector('.project-storage [role=status]')?.textContent==='Saved to MySQL');
 const list=await (await context.request.get(base+'/api/projects')).json(); assert(list.projects.length>=1);
 const id=list.projects.find(p=>p.assetCount===5)?.id;assert(id);
 await page.reload(); await page.waitForFunction(()=>document.querySelectorAll('.asset-card:not(.skeleton)').length===5);
 assert.equal(await page.locator('.asset-preview').first().innerText(),'Persisted fictional content.');
 assert.equal(await page.locator('.asset-card .publish-pill').first().innerText(),'Unpublished','Reload must not change the hand-off state');
 let detail=await (await context.request.get(base+`/api/projects?id=${id}`)).json();
 assert.equal(detail.snapshot.sourceText,source);assert.equal(detail.snapshot.assets.length,5);
 const imageBytes = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#26a579' } }).png().toBuffer();
 const uploadedIds = [];
 for (let index = 0; index < 2; index++) {
   const upload = await context.request.post(base + '/api/media/images', { headers: { Origin: base }, data: { requestId: randomUUID(), dataUrl: `data:image/png;base64,${imageBytes.toString('base64')}`, name: `project-${index}.png` } });
   assert.equal(upload.status(), 201);
   uploadedIds.push((await upload.json()).image.id);
 }
 const withImages = { ...detail, snapshot: { ...detail.snapshot, assets: detail.snapshot.assets.map((asset, index) => index === 0 ? { ...asset, imageMediaIds: uploadedIds.slice().reverse(), imageUrl: '' } : index === 1 ? { ...asset, imageMediaIds: [], imageUrl: 'https://example.test/stale.jpg' } : asset) } };
 const saveImages = await context.request.put(base + '/api/projects', { headers: { Origin: base }, data: withImages });
 assert.equal(saveImages.status(), 200);
 detail = await (await context.request.get(base + `/api/projects?id=${id}`)).json();
 assert.deepEqual(detail.snapshot.assets[0].imageMediaIds, uploadedIds.slice().reverse());
 assert.deepEqual(detail.snapshot.assets[1].imageMediaIds, []);
 await page.reload();
 await page.waitForFunction(() => document.querySelectorAll('.asset-card:not(.skeleton)').length === 5);
 assert.equal(await page.locator('.asset-card').first().locator('.asset-image-count').innerText(), '2 images');
 assert.equal(await page.locator('.asset-card').nth(1).locator('.asset-card-media').count(), 0, 'explicit empty collection suppresses the article cover after real reload');
 const denied = await context.request.put(base + '/api/projects', { headers: { Origin: base }, data: { ...detail, snapshot: { ...detail.snapshot, assets: [{ ...detail.snapshot.assets[0], imageMediaIds: [randomUUID()] }] } } });
 assert.equal(denied.status(), 400);
 assert.equal((await denied.json()).code, 'INVALID_IMAGE');
 const anonymous=await browser.newContext();
 assert.equal((await anonymous.request.get(base+'/api/projects')).status(),401,'anonymous access must be refused');
 assert.equal((await anonymous.request.get(base+`/api/projects?id=${id}`)).status(),401);await anonymous.close();
 const other=await browser.newContext();
 bob=await signIn(await other.newPage(),base,{displayName:'Storage Bob'});
 const forbidden=await other.request.get(base+`/api/projects?id=${id}`);assert.equal(forbidden.status(),404,'another account must not read this project');
 const stolenImages = await other.request.put(base + '/api/projects', { headers: { Origin: base }, data: { id: randomUUID(), version: 0, snapshot: withImages.snapshot } });
 assert.equal(stolenImages.status(), 400, 'another account cannot save borrowed image references');
 assert.equal((await stolenImages.json()).code, 'INVALID_IMAGE');
 await other.close();
 const crossOrigin=await context.request.put(base+'/api/projects',{headers:{Origin:'https://untrusted.example'},data:detail});assert.equal(crossOrigin.status(),403);
 const invalid=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:{...detail,snapshot:{...detail.snapshot,assets:[{content:{invalid:true}}]}}});assert.equal(invalid.status(),400);
 const next={...detail,snapshot:{...detail.snapshot,generationRun:'new-storage-test-run',assets:[]}};
 const saved=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(saved.status(),200);
 const conflict=await context.request.put(base+'/api/projects',{headers:{Origin:base},data:next});assert.equal(conflict.status(),409);
 const history=await (await context.request.get(base+'/api/projects')).json();assert(history.projects.some(p=>p.id!==id&&p.assetCount===5),'A new run must archive previous generated content');
 assert.deepEqual(errors,[]);
 console.log('PASS: real MySQL autosave, generated assets/source restored after reload, hand-off state preserved across reload, account isolation, CSRF rejection, schema validation, optimistic conflicts and generation archiving. AI mocked; no paid requests.');
} finally {
 await browser.close();
 if (alice) await alice.cleanup();
 if (bob) await bob.cleanup();
}
