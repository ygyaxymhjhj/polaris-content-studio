// Exercise the actual translation boundary and rendered account/connection UI without live APIs.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
function loadModule(modulePath, sourceOverride) {
  if (modules.has(modulePath)) return modules.get(modulePath).exports;
  const source = sourceOverride ?? readFileSync(modulePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const moduleRecord = { exports: {} };
  modules.set(modulePath, moduleRecord);
  const require = dependency => {
    if (!dependency.startsWith('@/') && !dependency.startsWith('.')) return createRequire(modulePath)(dependency);
    const basePath = dependency.startsWith('@/') ? resolve(repository, 'src', dependency.slice(2)) : resolve(dirname(modulePath), dependency);
    return loadModule(existsSync(`${basePath}.ts`) ? `${basePath}.ts` : `${basePath}.tsx`);
  };
  new Function('require', 'module', 'exports', compiled)(require, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports;
}

const translationPath = resolve(repository, 'src/lib/i18n.tsx');
const { translate, LocaleContext } = loadModule(translationPath);
const { default: SocialAccountsView } = loadModule(resolve(repository, 'src/components/SocialAccountsView.tsx'));
const { default: ConnectAccountsDialog } = loadModule(resolve(repository, 'src/components/ConnectAccountsDialog.tsx'));
const { default: AssetImageEditor } = loadModule(resolve(repository, 'src/components/AssetImageEditor.tsx'));
const { default: SocialPreview } = loadModule(resolve(repository, 'src/components/SocialPreview.tsx'));
const syntaxTree = ts.createSourceFile(translationPath, readFileSync(translationPath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const brandedMessages = new Set();
function collectMessages(node) {
  if (ts.isStringLiteral(node) && /postiz/i.test(node.text)) brandedMessages.add(node.text);
  ts.forEachChild(node, collectMessages);
}
collectMessages(syntaxTree);
const dynamicMessages = [
  'POSTIZ_API_KEY is missing; Postiz returned HTTP 503. Retry later.',
  'pOsTiZ refused submission: account disconnected.',
  'Draft accepted by Postiz, but status tracking failed. Do not resubmit.',
  'Configure POSTIZ_JWT_SECRET and POSTIZ_API_URL before connecting.'
];
const consoleUrl = 'https://postiz.example.test/console';
for (const language of ['en', 'zh', 'vi', 'th']) {
  for (const message of [...brandedMessages, ...dynamicMessages]) {
    assert.doesNotMatch(translate(language, message), /postiz/i, `${language}: ${message}`);
  }
  assert.equal(translate(language, 'Unrelated system message'), 'Unrelated system message');
  assert.match(translate(language, dynamicMessages[0]), /503/, 'status details survive neutralization');
  assert.doesNotMatch(translate(language, `Postiz returned an error at ${consoleUrl}`), /postiz/i, 'displayed error endpoints do not reveal the engine brand');
  assert.ok(translate(language, 'Retry https://example.test/status').endsWith('https://example.test/status'), 'unrelated URLs in messages remain unchanged');
  const render = component => renderToStaticMarkup(React.createElement(LocaleContext.Provider, { value: language }, component));
  for (const variant of ['default', 'composer']) {
    const imageMarkup = render(React.createElement(AssetImageEditor, {
      value: '', title: '', variant, onChange() {}, onBusyChange() {}
    }));
    assert.doesNotMatch(imageMarkup, /30 MB|asset-image-help|aria-describedby/, 'upload limits are only shown on validation failure, without a dangling hint reference');
    assert.match(translate(language, 'This image exceeds 30 MB. Choose an image up to 30 MB.'), /30 MB/);
    const mediaMarkup = render(React.createElement(AssetImageEditor, {
      value: '', title: '', variant, onChange() {}, onVideoChange() {}, onBusyChange() {}
    }));
    assert.doesNotMatch(mediaMarkup, /100 MB|30 MB|video\/\*|aria-describedby/, 'MP4 selection adds no persistent limits or unsupported formats');
    assert.match(mediaMarkup, /accept="[^"]*video\/mp4/);
    for (const message of ['Post media', 'Upload post media', 'Post video', 'Replace video', 'Remove video', 'Cancel upload',
      'Uploading video…', 'Video transferred. Waiting for processing…', 'Video queued…', 'Validating video…',
      'Converting video to H.264…', 'Saving video…', 'This platform requires an image or MP4 video.',
      'Video conversion is unavailable. Ask an administrator to check the server.',
      'Could not convert this video to H.264. Please try another MP4.', 'Video conversion timed out. Please try another MP4.',
      'Could not process this video. Please try another MP4.', 'Video job ID:', 'Retry processing status',
      'This video exceeds the processing limits. Choose a smaller or shorter MP4.',
      'Could not confirm video processing status. The job may still be running. Do not upload the file again.',
      'Video processing is taking longer than expected. The job may still be running. Do not upload the file again.',
      'This video exceeds 100 MB. Choose an MP4 up to 100 MB.', 'Could not upload this video. Please try again.']) {
      if (language !== 'en') assert.notEqual(translate(language, message), message, `${language}: missing media copy: ${message}`);
    }
  }
  const accountMarkup = render(React.createElement(SocialAccountsView, {
    accounts: [{ id: 'account', name: 'Postiz Fan', identifier: 'x', disabled: true }],
    configured: true, uiUrl: consoleUrl, loading: false,
    error: dynamicMessages[0], notice: dynamicMessages[2], syncedAt: '', isAdmin: true,
    onAddAccount() {}, onRefresh() {}
  }));
  assert.ok(accountMarkup.includes('Postiz Fan'), 'user account names are not rewritten');
  assert.ok(accountMarkup.includes(`href="${consoleUrl}"`), 'admin console URLs are unchanged');
  assert.doesNotMatch(accountMarkup.replace(/<[^>]*>/g, '').replaceAll('Postiz Fan', ''), /postiz/i);
  const dialogMarkup = render(React.createElement(ConnectAccountsDialog, {
    open: true, onClose() {}, configured: false, oauthConfigured: false, loading: false,
    uiUrl: consoleUrl, accounts: [], error: dynamicMessages[1], onRefresh() {}, canUsePostizUi: true
  }));
  assert.doesNotMatch(dialogMarkup.replace(/<[^>]*>/g, ''), /postiz/i);
}
assert.equal(translate('en', 'Push drafts to Postiz'), 'Push drafts');
assert.equal(translate('zh', 'Push drafts to Postiz'), '提交草稿');
assert.equal(translate('en', 'Postiz drafts'), 'Draft inbox');
assert.equal(translate('zh', 'Postiz drafts'), '草稿箱');
assert.equal(translate('en', 'Open Postiz'), 'Open publishing console');
console.log(`PASS: four locales, ${brandedMessages.size} branded dictionary strings, dynamic errors/configuration, semantic labels, account/connection rendering, unchanged account names and admin console URL.`);

// Render production views rather than checking whether old strings disappeared from source files.
const studioTree = ts.createSourceFile('ContentStudio.tsx', readFileSync(resolve(repository, 'src/components/ContentStudio.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const productionFunction = name => studioTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(studioTree);
const iconImport = studioTree.statements.find(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'lucide-react').getText(studioTree);
const viewNames = ['platformIcon', 'PublishBadge', 'WorkspaceView', 'FactsView', 'AssetsView', 'ExportView'];
const views = loadModule(resolve(repository, 'scripts/quiet-views-virtual.tsx'), `
  import { useState } from 'react';
  import { useTranslation } from '@/lib/i18n';
  import { PLATFORM_META, DEFAULT_PLATFORMS } from '@/lib/types';
  import { getPublishBadge } from '@/lib/submission-status';
  ${iconImport}
  const platformGroups = [{ label: 'Social channels', platforms: DEFAULT_PLATFORMS }];
  ${viewNames.map(productionFunction).join('\n')}
  export { WorkspaceView, FactsView, AssetsView, ExportView };
`);
const { default: OverviewView } = loadModule(resolve(repository, 'src/components/OverviewView.tsx'));
const { default: ProjectStorage } = loadModule(resolve(repository, 'src/components/ProjectStorage.tsx'));
const noop = () => {};
const config = { name: 'News', title: 'Source article', category: '', language: 'en', audience: '', cta: '', websiteUrl: '', sourceUrl: '', tone: '', publishDate: '' };
const asset = { id: 'asset', platform: 'x', assetType: 'short_post', title: 'News draft', content: 'Original content stays unchanged.', factIds: ['fact'], riskFlags: [], meta: {}, updatedAt: '2026-10-20T00:00:00Z' };
const videoId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
for (const language of ['en', 'zh', 'vi', 'th']) {
  for (const platform of ['x', 'linkedin', 'facebook', 'instagram', 'threads']) {
    const videoAsset = { ...asset, platform, videoMediaId: videoId, imageUrl: 'https://example.invalid/untrusted-image.png',
      assetType: 'carousel', meta: { slides: [{ title: 'An old carousel' }] } };
    const preview = load(renderViewMedia(SocialPreview, { asset: videoAsset, imageUrl: 'https://example.invalid/article.png' }));
    assert.equal(preview('video').attr('src'), `/api/media/uploads/${videoId}`);
    assert.equal(preview('video').attr('preload'), 'metadata');
    assert.equal(preview('video[controls][playsinline]').length, 1);
    assert.equal(preview('.mock-image, .ig-slide-card').length, 0, 'video takes precedence over article images and carousel metadata on all five platforms');
    const card = load(renderViewMedia(views.AssetsView, { assets: [videoAsset], filteredAssets: [videoAsset], filter: 'all',
      setFilter() {}, onOpen() {}, onPublish() {}, onGenerate() {}, onExport() {}, loading: null, usedFallback: false,
      pendingPlatforms: [], targetCount: 1, config: { imageUrl: 'https://example.invalid/article.png' } }));
    assert.equal(card('.asset-card-video').length, 1);
    assert.equal(card('.asset-card-media img, .asset-card-media video').length, 0, 'asset grids show an icon without fetching a full video or falling back to an image');
  }
  function renderViewMedia(component, properties) {
    return renderToStaticMarkup(React.createElement(LocaleContext.Provider, { value: language }, React.createElement(component, properties)));
  }
}

const studioNodes = [];
function collectStudioNodes(node) { studioNodes.push(node); ts.forEachChild(node, collectStudioNodes); }
collectStudioNodes(studioTree);
const viewAssetExpression = studioNodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(studioTree) === 'viewAsset').initializer.getText(studioTree);
const projectCandidate = new Function('previewCandidate', 'selectedAsset', `return ${viewAssetExpression};`);
assert.equal(projectCandidate({ asset: { ...asset, imageUrl: 'rogue', videoMediaId: 'rogue' } }, { ...asset, imageUrl: '', videoMediaId: videoId }).videoMediaId, videoId);
assert.equal(projectCandidate({ asset: { ...asset, imageUrl: 'rogue', videoMediaId: 'rogue' } }, { ...asset, imageUrl: 'chosen-image' }).imageUrl, 'chosen-image');
assert.equal(projectCandidate({ asset: { ...asset, videoMediaId: videoId } }, asset).videoMediaId, undefined, 'model candidates cannot introduce a media reference');
const mediaEditor = studioNodes.find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(studioTree) === 'AssetImageEditor');
let selectedMediaAsset = { ...asset, imageUrl: 'article-image' };
const mediaCallback = name => new Function('setSelectedAsset', 'selectedAsset', `return ${mediaEditor.attributes.properties.find(attribute => attribute.name?.getText(studioTree) === name).initializer.expression.getText(studioTree)};`)(
  update => { selectedMediaAsset = update(selectedMediaAsset); }, selectedMediaAsset
);
mediaCallback('onVideoChange')(videoId);
assert.equal(selectedMediaAsset.imageUrl, '', 'AI video selection suppresses the article-image fallback atomically');
assert.equal(selectedMediaAsset.videoMediaId, videoId);
mediaCallback('onChange')('replacement-image');
assert.equal(selectedMediaAsset.videoMediaId, undefined, 'AI image selection clears the video in the same state update');
mediaCallback('onVideoChange')(videoId);
const { getAssetStatusFields } = loadModule(resolve(repository, 'src/lib/submission-status.ts'));
let savedMediaAsset;
const saveAssetFunction = studioNodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'saveAsset').getText(studioTree);
const saveContext = {
  selectedAsset: selectedMediaAsset, imageUploadingRef: { current: false }, deliveryDraft: '{}',
  rewriteSequence: { current: 0 }, setRewriting() {}, getAssetStatusFields,
  setAssets: update => { savedMediaAsset = update([asset])[0]; }, setSelectedAsset() {}, clearCandidates() {}, notify() {}, t: text => text
};
const compiledSave = ts.transpileModule(saveAssetFunction, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
new Function(...Object.keys(saveContext), `${compiledSave}; return saveAsset();`)(...Object.values(saveContext));
assert.equal(savedMediaAsset.videoMediaId, videoId, 'actual AI saveAsset copies the durable video id');
assert.equal(savedMediaAsset.imageUrl, '');
const { getMatchingSocialAccounts } = loadModule(resolve(repository, 'src/lib/social-account-platform.ts'));
const { createClientId } = loadModule(resolve(repository, 'src/lib/client-id.ts'));
let submittedMediaPayload;
const submitAssetFunction = studioNodes.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'submitDraft').getText(studioTree);
const submitContext = {
  imageUploadingRef: { current: false }, acceptanceFlights: { current: new Set() }, channelsLoading: false, channelsError: '',
  socialAccounts: [{ id: 'account', identifier: 'x', name: 'News desk' }], getMatchingSocialAccounts, createClientId,
  currentProjectRef: { current: 'project' }, packSequence: { current: 0 }, submissionAttempts: { current: new Map() },
  config: { imageUrl: 'article-fallback' }, setAssets() {}, setSelectedAsset() {}, setPublishModalAsset() {}, setAcceptingAssetIds() {},
  t: text => text, notify() {}, readJson: response => response.json(),
  fetch: async (url, options) => { submittedMediaPayload = JSON.parse(options.body); return Response.json({ error: 'Synthetic refusal' }, { status: 400 }); }
};
const compiledSubmit = ts.transpileModule(submitAssetFunction, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const submitAsset = new Function(...Object.keys(submitContext), `${compiledSubmit}; return submitDraft;`)(...Object.values(submitContext));
await submitAsset(selectedMediaAsset, 'account');
assert.equal(submittedMediaPayload.videoMediaId, videoId);
assert.equal(Object.hasOwn(submittedMediaPayload, 'imageUrl'), false, 'actual AI submission never adds an article-image fallback to video');
const analysis = { summaryShort: 'Article summary', summaryLong: 'Source context.', keyTerms: [], riskFlags: [], facts: [{ id: 'fact', type: 'claim', text: 'Source claim', sourceExcerpt: 'Source claim', sourceLocation: 'Article', verified: true, usableOnSocial: true, riskLevel: 'low' }] };
const accountProperties = { accounts: [{ id: 'account', name: 'News desk', identifier: 'x' }], configured: true, uiUrl: consoleUrl, loading: false, error: '', notice: '', syncedAt: '', isAdmin: true, onAddAccount: noop, onRefresh: noop };
const assetProperties = { assets: [asset], filteredAssets: [asset], filter: 'all', setFilter: noop, onOpen: noop, onPublish: noop, onGenerate: noop, onExport: noop, loading: null, usedFallback: false, pendingPlatforms: [], targetCount: 1, config };
const exportProperties = { assets: [asset], submittedCount: 0, onExport: noop, onBatchSubmitDrafts: noop, loading: null, socialAccountsCount: 1 };
const connectProperties = { open: true, onClose: noop, configured: true, oauthConfigured: true, loading: false, uiUrl: consoleUrl, accounts: [], error: '', onRefresh: noop, canUsePostizUi: true };
const conciseLabels = {
  en: { batch: 'Submit all drafts', single: 'Submit draft', connected: 'Connected' },
  zh: { batch: '批量提交草稿', single: '提交草稿', connected: '已连接' },
  vi: { batch: 'Gửi tất cả bản nháp', single: 'Gửi bản nháp', connected: 'Đã kết nối' },
  th: { batch: 'ส่งฉบับร่างทั้งหมด', single: 'ส่งฉบับร่าง', connected: 'เชื่อมต่อแล้ว' }
};
const renderView = (language, component, properties) => renderToStaticMarkup(React.createElement(LocaleContext.Provider, { value: language }, React.createElement(component, properties)));
const browserViews = {};
for (const language of ['en', 'zh', 'vi', 'th']) {
  const accounts = load(renderView(language, SocialAccountsView, accountProperties));
  assert.equal(accounts('.accounts-guide, .accounts-trust-note').length, 0);
  assert.equal(accounts('.accounts-directory-row').length, 1);
  assert.equal(accounts('.accounts-list-footer a').attr('href'), consoleUrl);
  assert.equal(accounts('.accounts-list-footer > span').eq(1).text(), conciseLabels[language].connected);
  assert.equal(translate(language, 'Submit to Postiz draft'), conciseLabels[language].single);
  const emptyAccounts = load(renderView(language, SocialAccountsView, { ...accountProperties, accounts: [], isAdmin: false }));
  assert.ok(emptyAccounts('.accounts-empty p').text().includes(translate(language, 'Missing an account? Ask an administrator to assign it to you.')));
  const dialog = load(renderView(language, ConnectAccountsDialog, connectProperties));
  assert.equal(dialog('.connection-next-step, .connection-security').length, 0);
  assert.equal(dialog('#connect-account-description').text(), translate(language, 'Choose a platform to connect.'));
  assert.equal(dialog('.connect-dialog').attr('aria-describedby'), 'connect-account-description');
  const unavailable = load(renderView(language, ConnectAccountsDialog, { ...connectProperties, oauthConfigured: false, error: 'Synthetic authorisation failure' }));
  assert.equal(unavailable('.dialog-footer .primary-button').is('[disabled]'), true);
  assert.equal(unavailable('[role="alert"]').text(), 'Synthetic authorisation failure');
  assert.ok(unavailable('[role="status"]').text().length > 0, 'Unavailable authorisation still explains the configuration blocker');
  const facts = load(renderView(language, views.FactsView, { analysis, sourceText: 'Source claim', updateFact: noop, onGenerate: noop, loading: null }));
  assert.equal(facts('.risk-card, .rule-line').length, 0);
  assert.equal(facts('.page-heading p').text(), translate(language, 'Changes apply when you regenerate.'));
  assert.equal(facts('.fact-details').length, 1, 'Reference editing stays available');
  const riskyFacts = load(renderView(language, views.FactsView, { analysis: { ...analysis, riskFlags: ['Actual source risk'] }, sourceText: 'Source', updateFact: noop, onGenerate: noop, loading: null }));
  assert.equal(riskyFacts('.risk-card li').text(), 'Actual source risk');
  const blockedFacts = load(renderView(language, views.FactsView, { analysis: { ...analysis, facts: [] }, sourceText: '', updateFact: noop, onGenerate: noop, loading: null }));
  assert.equal(blockedFacts('.next-card button').is('[disabled]'), true);
  const exported = load(renderView(language, views.ExportView, exportProperties));
  assert.equal(exported('.export-checklist').length, 0);
  assert.equal(exported('.export-stats > div').length, 4);
  assert.ok(exported('.export-summary p').text().length > 0);
  assert.equal(exported('button').length, 2);
  assert.equal(exported('.export-actions .primary-button').text().trim(), conciseLabels[language].batch);
  if (language === 'en') {
    assert.equal(exported('.export-summary h2').text(), '1 asset · 1 channel');
    const multipleAssets = load(renderView(language, views.ExportView, { ...exportProperties, assets: [asset, { ...asset, id: 'second', platform: 'threads' }] }));
    assert.equal(multipleAssets('.export-summary h2').text(), '2 assets · 2 channels');
  }
  const fallback = load(renderView(language, views.AssetsView, { ...assetProperties, usedFallback: true }));
  assert.equal(fallback('[role="status"]').text(), translate(language, 'Some drafts use local templates instead of AI. Review before use.'));
  const overview = load(renderView(language, OverviewView, { accounts: [], accountsLoading: false, accountsError: '', onRefreshAccounts: noop, onOpenAccounts: noop, onOpenPosts: noop, onNewPost: noop, onOpenWorkspace: noop, refreshToken: 0 }));
  assert.equal(overview('.overview-footnote, .overview-heading p').length, 0);
  const storage = load(renderView(language, ProjectStorage, { snapshot: { config }, busy: false, onRestore: noop }));
  assert.equal(storage('.storage-help-icon').length, 0);
  assert.doesNotMatch(storage('.storage-status-text').text(), /MySQL/);
  assert.doesNotMatch(translate(language, 'Saved to MySQL'), /MySQL/);
  assert.doesNotMatch(translate(language, 'Saving to MySQL…'), /MySQL/);
  const workspace = load(renderView(language, views.WorkspaceView, { config, updateConfig: noop, sourceText: 'Source claim', setSourceText: noop, sourceName: '', loading: null, selectedPlatforms: ['x'], togglePlatform: noop, handleFile: noop, analyzeArticle: noop, hasAnalysis: true, goTo: noop, fetchArticle: noop, downloadSource: noop, sourcePending: false }));
  assert.equal(workspace('.action-note').length, 0);
  assert.equal(workspace('.distribution-panel .primary-button').length, 1);
  if (language === 'en') Object.assign(browserViews, { accounts: accounts.html(), facts: facts.html(), export: exported.html(), connect: dialog.html(), workspace: workspace.html() });
}

const screenshots = mkdtempSync(resolve(tmpdir(), 'polaris-quiet-ui-'));
const styles = readFileSync(resolve(repository, 'src/app/globals.css'), 'utf8').replace(/@import\s+url\([^)]*\)\s*;/g, '');
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.abort());
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, markup] of Object.entries(browserViews)) {
        await page.setContent(`<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div class="app-shell"><aside class="sidebar"></aside><main class="main-area"><div class="content-wrap">${markup}</div></main></div></body></html>`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: ${theme} ${width}px must not overflow`);
        if (name === 'accounts') {
          const layout = await page.locator('.accounts-layout').boundingBox();
          const panel = await page.locator('.accounts-panel').boundingBox();
          assert.ok(Math.abs(layout.width - panel.width) < 2, 'The account panel fills the former guide column');
          const identity = await page.locator('.accounts-directory-identity').boundingBox();
          const assignment = await page.locator('.account-owner-control').boundingBox();
          const accountState = await page.locator('.accounts-directory-row .account-state').boundingBox();
          const overlaps = (first, second) => first.x < second.x + second.width && first.x + first.width > second.x
            && first.y < second.y + second.height && first.y + first.height > second.y;
          assert.equal(overlaps(identity, assignment), false, 'Account identity must not overlap the assignment control');
          assert.equal(overlaps(identity, accountState), false, 'Account identity must not overlap its status');
          assert.equal(overlaps(assignment, accountState), false, 'Assignment and status must remain separate');
          if (width === 390) assert.ok(assignment.y >= identity.y + identity.height, 'Mobile account assignment has its own row');
        }
        await page.screenshot({ path: resolve(screenshots, `${name}-${theme}-${width}.png`), fullPage: true });
      }
    }
  }
} finally {
  await browser.close();
}
console.log(`PASS: production JSX SSR in four locales, real risk/configuration/empty states, disabled guards, account full-width layout and 390px light/dark checks. Screenshots: ${screenshots}`);
