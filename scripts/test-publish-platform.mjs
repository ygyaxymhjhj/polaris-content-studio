// Exercise the real draft modal, selection hooks and submission functions without an app or database.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(repository, 'src/components/ContentStudio.tsx'), 'utf8');
const tree = ts.createSourceFile('ContentStudio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(tree);
const text = node => node.getText(tree);
function findNode(predicate) {
  const node = nodes.find(predicate);
  assert(node, 'Expected production code was not found');
  return node;
}
const declaration = name => {
  const node = nodes.find(candidate => ts.isVariableDeclaration(candidate) && text(candidate.name) === name);
  return node ? `const ${text(node)};` : '';
};
const state = name => `const ${text(findNode(node => ts.isVariableDeclaration(node)
  && ts.isArrayBindingPattern(node.name) && text(node.name.elements[0]) === name))};`;
const productionFunction = name => text(findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name));
const modal = text(findNode(node => ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression)
  && text(node.expression.left) === 'publishModalAsset'));
const drawerButton = text(findNode(node => ts.isJsxElement(node) && node.openingElement.tagName.getText(tree) === 'button'
  && node.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute)
    && text(attribute.name) === 'onClick' && text(attribute).includes('setPublishModalAsset(viewAsset)'))));
const cardHandler = findNode(node => ts.isJsxAttribute(node) && text(node.name) === 'onPublish').initializer.expression;
assert.match(text(cardHandler), /setPublishModalAsset\(asset\)/, 'Cards use the same modal state as the drawer');
const selectionEffect = nodes.filter(node => ts.isCallExpression(node) && text(node.expression) === 'useEffect'
  && node.arguments[0] && text(node.arguments[0]).includes('setSelectedAccountId(')).map(text).join(';\n');
const refreshEffect = text(findNode(node => ts.isCallExpression(node) && text(node.expression) === 'useEffect'
  && node.arguments[0] && text(node.arguments[0]).includes('if (publishModalAsset) void loadChannels()')));
const icons = text(findNode(node => ts.isImportDeclaration(node) && node.moduleSpecifier.text === 'lucide-react'));
const platformImport = nodes.filter(node => ts.isImportDeclaration(node)
  && node.moduleSpecifier.text === '@/lib/social-account-platform').map(text).join('\n');
const accounts = [
  { id: 'x-first', name: 'X desk', identifier: 'x' },
  { id: 'threads-one', name: 'Threads first', identifier: 'threads' },
  { id: 'facebook', name: 'Facebook desk', identifier: 'facebook' },
  { id: 'linkedin-page', name: 'LinkedIn page', identifier: 'linkedin-page' },
  { id: 'threads-two', name: 'Threads second', identifier: ' THREADS ' },
  { id: 'twitter', name: 'Twitter desk', identifier: 'twitter' },
  { id: 'instagram', name: 'Instagram desk', identifier: 'instagram-standalone' },
  { id: 'disabled', name: 'Disconnected Threads', identifier: 'threads', disabled: true },
  { id: 'unknown', name: 'Unsupported', identifier: 'threads-other' }
];
const assets = ['threads', 'x', 'linkedin', 'instagram', 'facebook'].map(platform => ({
  id: `asset-${platform}`, platform, assetType: 'short_post', title: `${platform} draft`, content: 'Unchanged copy',
  meta: {}, factIds: [], riskFlags: [], updatedAt: '2026-10-20T00:00:00.000Z'
}));
const transpile = input => ts.transpileModule(input, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
}).outputText;
const harnessPath = resolve(repository, 'scripts/publish-platform-virtual.tsx');
const virtualSource = `
  import React, { useCallback, useEffect, useRef, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { LocaleContext, translate } from '@/lib/i18n';
  import { PLATFORM_META } from '@/lib/types';
  import { mergeDraftTask } from '@/lib/draft-submission-client';
  import { isDraftSubmissionTask } from '@/lib/draft-submission-types';
  import ConnectAccountsDialog from '@/components/ConnectAccountsDialog';
  ${platformImport}
  ${icons}
  ${productionFunction('readJson')}
  ${productionFunction('PublishBadge')}
  import { getPublishBadge } from '@/lib/submission-status';
  import { useTranslation } from '@/lib/i18n';
  function Harness() {
    const [language, setLanguage] = useState('en');
    const t = message => translate(language, message);
    ${['socialAccounts', 'postizConfigured', 'postizUiUrl', 'postizOAuthConfigured', 'channelsLoading', 'channelsSyncedAt',
      'channelsError', 'connectOpen', 'publishModalAsset', 'selectedAccountId', 'acceptingAssetIds'].map(state).join('\n')}
    ${['channelRequestSequence', 'publishing', 'matchingAccounts', 'effectiveSelectedAccountId', 'loadChannels'].map(declaration).join('\n')}
    ${selectionEffect}
    ${refreshEffect};
    const [storedAssets, setAssets] = useState(${JSON.stringify(assets)});
    const [selectedAsset, setSelectedAsset] = useState(null);
    const [notice, notify] = useState('');
    const [submissionNotice, setSubmissionNotice] = useState('');
    const publishHistory = [];
    const currentProjectRef = useRef('project-test');
    const packSequence = useRef(1);
    const submissionAttempts = useRef(new Map());
    const acceptanceFlights = useRef(new Set());
    const config = {};
    const user = {role: 'admin'};
    const assets = storedAssets;
    const viewAsset = assets.find(asset => asset.platform === 'x');
    const imageUploading = false;
    ${productionFunction('submitDraft')}
    ${productionFunction('batchSubmitDrafts')}
    const [, setLoading] = useState(null);
    window.testSubmit = accountId => submitDraft(publishModalAsset, accountId);
    window.testBatch = batchSubmitDrafts;
    return <LocaleContext.Provider value={language}>
      <div data-testid="cards">{assets.map(asset => <button key={asset.id} onClick={() => (${text(cardHandler)})(asset)}>{asset.platform}</button>)}</div>
      <div data-testid="drawer">${drawerButton}</div>
      <button onClick={() => setLanguage('zh')}>zh</button><button onClick={() => setLanguage('en')}>en</button>
      <button onClick={() => setLanguage('vi')}>vi</button><button onClick={() => setLanguage('th')}>th</button>
      <output data-testid="selection">{selectedAccountId}</output>
      <output data-testid="assets">{JSON.stringify(storedAssets)}</output>
      <output data-testid="notice">{notice}{submissionNotice}</output>
      ${modal}
      <ConnectAccountsDialog open={connectOpen} onClose={() => setConnectOpen(false)} configured={postizConfigured}
        oauthConfigured={postizOAuthConfigured} uiUrl={postizUiUrl} loading={channelsLoading} error={channelsError}
        accounts={socialAccounts} onRefresh={loadChannels} canUsePostizUi={true} />
    </LocaleContext.Provider>;
  }
  createRoot(document.getElementById('root')).render(<Harness />);
`;
const modules = new Map();
function resolveLocalModule(modulePath, dependency) {
  if (!dependency.startsWith('.') && !dependency.startsWith('@/')) return createRequire(modulePath).resolve(dependency);
  const base = dependency.startsWith('@/') ? resolve(repository, 'src', dependency.slice(2)) : resolve(dirname(modulePath), dependency);
  const resolved = ['', '.ts', '.tsx', '.js'].map(extension => `${base}${extension}`).find(existsSync);
  assert(resolved, `Could not resolve ${dependency}`);
  return resolved;
}
function collectModule(modulePath) {
  if (modules.has(modulePath)) return;
  const moduleSource = modulePath === harnessPath ? virtualSource : readFileSync(modulePath, 'utf8');
  const compiled = /\.tsx?$/.test(modulePath) ? transpile(moduleSource) : moduleSource;
  const dependencies = {};
  modules.set(modulePath, { source: compiled, dependencies });
  for (const match of compiled.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const dependencyPath = resolveLocalModule(modulePath, match[1]);
    dependencies[match[1]] = dependencyPath;
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
  const contentType = request.url === '/bundle.js' ? 'application/javascript' : request.url === '/styles.css' ? 'text/css' : 'text/html';
  response.setHeader('Content-Type', `${contentType}; charset=utf-8`);
  response.end(request.url === '/bundle.js' ? bundle : request.url === '/styles.css' ? styles
    : '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  const submissions = [];
  let currentAccounts = accounts;
  let channelFailure = false;
  let holdRefresh = false;
  let releaseRefresh;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    assert.equal(url.hostname, '127.0.0.1', 'No external network access');
    if (url.pathname === '/api/social/channels') {
      if (holdRefresh) await new Promise(resolveRefresh => { releaseRefresh = resolveRefresh; });
      await route.fulfill(channelFailure ? { status: 503, json: { error: 'Synthetic channel failure' } }
        : { json: { configured: true, oauthConfigured: true, accounts: currentAccounts } });
    } else if (url.pathname === '/api/social/publish') {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 400, json: { error: 'Synthetic refusal' } });
    } else {
      assert(!url.pathname.startsWith('/api/'), `Unexpected API: ${url.pathname}`);
      await route.continue();
    }
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const dialog = page.locator('.publish-dialog').first();
  const confirm = () => dialog.locator('.dialog-footer .primary-button');
  const ids = () => dialog.locator('.account-option-card strong').allTextContents();
  const selected = () => dialog.locator('.account-option-card.selected strong').textContent();
  const refresh = async () => {
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.publish-dialog')?.textContent.includes('Loading accounts...'));
  };
  await page.getByTestId('cards').getByRole('button', { name: 'threads', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.account-option-card').length > 0);
  assert.deepEqual(await ids(), ['Threads first', 'Threads second'], 'Threads modal excludes every other platform and disabled account');
  assert.equal(await selected(), 'Threads first');
  await dialog.locator('.account-option-card', { hasText: 'Threads second' }).click();
  assert.equal(await selected(), 'Threads second');
  assert.equal(await page.locator('.connect-dialog').count(), 0, 'Selecting a card does not open account management');
  await dialog.locator('.dialog-body > .field-label > span').first().click({ position: { x: 8, y: 14 } });
  assert.equal(await page.locator('.connect-dialog').count(), 0, 'The field caption is inert');
  await refresh();
  assert.equal(await selected(), 'Threads second', 'Refreshing preserves a still-available matching selection');
  currentAccounts = accounts.filter(account => account.id !== 'threads-two');
  await refresh();
  assert.equal(await selected(), 'Threads first', 'Refreshing a removed selection falls back within the same platform');
  currentAccounts = accounts.filter(account => account.identifier.trim().toLowerCase() !== 'threads');
  await refresh();
  assert.equal(await dialog.locator('.account-option-card').count(), 0);
  assert.equal(await page.getByTestId('selection').textContent(), '');
  assert.equal(await confirm().isDisabled(), true);
  const emptyMessage = 'No available accounts for this platform. Connect an account or ask an administrator to assign one, then refresh.';
  assert((await dialog.textContent()).includes(emptyMessage));
  await page.evaluate(() => window.testSubmit('threads-one'));
  assert.equal(submissions.length, 0, 'A removed selection cannot be submitted from an empty list');
  for (const [locale, expectedMessage] of [['zh', '当前平台暂无可用账号'], ['vi', 'Chưa có tài khoản khả dụng cho nền tảng này'],
    ['th', 'ยังไม่มีบัญชีที่พร้อมใช้งานสำหรับแพลตฟอร์มนี้']]) {
    await page.getByRole('button', { name: locale, exact: true }).evaluate(button => button.click());
    await dialog.getByText(expectedMessage, { exact: false }).waitFor({ timeout: 3000 }).catch(error => {
      throw new Error(`${locale} translation unavailable: ${error.message}; browser errors: ${JSON.stringify(errors)}`);
    });
    assert((await dialog.textContent()).includes(expectedMessage), `${locale} has translated platform-specific empty copy`);
  }
  await page.getByRole('button', { name: 'en', exact: true }).evaluate(button => button.click());
  await dialog.getByText(emptyMessage, { exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Manage accounts' }).click();
  await page.locator('.connect-dialog').waitFor();
  await page.locator('.connect-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  currentAccounts = accounts;
  await refresh();
  for (const badAccountId of ['x-first', 'disabled', 'removed']) {
    const before = await page.getByTestId('assets').textContent();
    await page.evaluate(accountId => window.testSubmit(accountId), badAccountId);
    assert.equal(submissions.length, 0, 'Invalid accounts never reach POST');
    assert.equal(await page.getByTestId('assets').textContent(), before, 'Invalid accounts never alter publication state');
  }
  holdRefresh = true;
  await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.publish-dialog')?.textContent.includes('Loading accounts...'));
  assert.equal(await confirm().isDisabled(), true);
  await page.evaluate(() => window.testSubmit('threads-one'));
  await page.evaluate(() => window.testBatch());
  assert.equal(submissions.length, 0, 'Loading accounts block submission');
  channelFailure = true;
  releaseRefresh();
  holdRefresh = false;
  await dialog.getByText(/Synthetic channel failure/).waitFor();
  assert.equal(await confirm().isDisabled(), true);
  assert(!(await dialog.textContent()).includes(emptyMessage), 'Loading failures are not disguised as an empty account list');
  await page.evaluate(() => window.testSubmit('threads-one'));
  await page.evaluate(() => window.testBatch());
  assert.equal(submissions.length, 0, 'Failed refresh blocks submission');
  channelFailure = false;
  await refresh();
  await dialog.locator('.dialog-footer').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByTestId('drawer').getByRole('button').click();
  await page.waitForFunction(() => document.querySelectorAll('.account-option-card').length === 2);
  assert.deepEqual(await ids(), ['X desk', 'Twitter desk'], 'The actual drawer entry uses the same platform-filtered modal');
  assert.equal(await selected(), 'X desk', 'Switching platform never keeps the prior platform selection');
  for (const [platform, expectedNames] of [['linkedin', ['LinkedIn page']], ['instagram', ['Instagram desk']], ['facebook', ['Facebook desk']]]) {
    await dialog.locator('.dialog-footer').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByTestId('cards').getByRole('button', { name: platform, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.publish-dialog')?.textContent.includes('Loading accounts...'));
    assert.deepEqual(await ids(), expectedNames);
  }
  await confirm().click();
  await dialog.getByText('Synthetic refusal', { exact: true }).waitFor();
  assert.equal(submissions[0].integrationId, 'facebook');
  assert.equal(submissions[0].platform, 'facebook');
  assert.equal(submissions[0].content, 'Unchanged copy');
  submissions.length = 0;
  await page.evaluate(() => window.testBatch());
  assert.deepEqual(submissions.map(entry => entry.integrationId).sort(), ['facebook', 'instagram', 'linkedin-page', 'threads-one', 'x-first'].sort(), 'Batch submits only the first usable matching account per asset, including provider aliases');
  assert.deepEqual(errors, []);
  console.log('PASS: real modal JSX/hooks, card and drawer entries, provider aliases, refresh fallback/empty/errors, disabled guards, account management and batch first-match routing; no database or Postiz.');
} finally {
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}

const helperPath = resolve(repository, 'src/lib/social-account-platform.ts');
const helperModule = { exports: {} };
new Function('exports', transpile(readFileSync(helperPath, 'utf8')))(helperModule.exports);
const { getSocialAccountPlatform, getMatchingSocialAccounts } = helperModule.exports;
for (const [identifier, platform] of [[' x ', 'x'], ['TWITTER', 'x'], [' threads ', 'threads'], ['FACEBOOK', 'facebook'],
  ['linkedin', 'linkedin'], ['LinkedIn-Page', 'linkedin'], ['instagram', 'instagram'], ['instagram-standalone', 'instagram']]) {
  assert.equal(getSocialAccountPlatform(identifier), platform);
}
for (const identifier of ['', 'threads-other', 'x-other', 'my-twitter', 'linkedin-page-custom', '__proto__', 'constructor']) {
  assert.equal(getSocialAccountPlatform(identifier), null, 'Unknown identifiers must never partially match');
}
const beforeAccounts = structuredClone(accounts);
for (const [platform, expectedIds] of [['threads', ['threads-one', 'threads-two']], ['x', ['x-first', 'twitter']],
  ['linkedin', ['linkedin-page']], ['instagram', ['instagram']], ['facebook', ['facebook']]]) {
  assert.deepEqual(getMatchingSocialAccounts(accounts, platform).map(account => account.id), expectedIds);
}
assert.deepEqual(getMatchingSocialAccounts(accounts, null), []);
assert.deepEqual(accounts, beforeAccounts, 'Matching preserves the original account identifiers and order');
console.log('PASS: client-safe exact platform helper covers all five platforms, aliases, unknown identifiers and disabled accounts.');
