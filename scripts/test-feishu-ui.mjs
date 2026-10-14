// Runs the actual panel with real ReactDOM in Chromium. All API traffic is intercepted;
// no app route, authentication, database, real webhook, or extra dependency is needed.
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
const panelPath = resolve(repository, 'src/components/FeishuSettingsPanel.tsx');
const localePath = resolve(repository, 'src/lib/i18n.tsx');
const harnessPath = resolve(repository, 'scripts/feishu-browser-harness.js');
const virtualSources = new Map([
  [panelPath, transpile(readFileSync(panelPath, 'utf8'))],
  [localePath, transpile(readFileSync(localePath, 'utf8'))],
  [harnessPath, `
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { flushSync } = require('react-dom');
    const { LocaleContext } = require('@/lib/i18n');
    const Panel = require('@/components/FeishuSettingsPanel').default;
    const root = createRoot(document.getElementById('root'));
    let epoch = 0;
    window.renderPanel = (permission, language = 'en') => flushSync(() => root.render(
      React.createElement(React.StrictMode, null,
        React.createElement(LocaleContext.Provider, { value: language },
          React.createElement(Panel, { key: epoch, canManageMembers: permission })))));
    window.mountPanel = (permission, language = 'en') => { epoch += 1; window.renderPanel(permission, language); };
    window.renderPanel(false);
  `]
]);
const modules = new Map();
function collectModule(modulePath) {
  if (modules.has(modulePath)) return;
  const source = virtualSources.get(modulePath) ?? readFileSync(modulePath, 'utf8');
  const dependencies = {};
  modules.set(modulePath, { source, dependencies });
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const dependency = match[1];
    const dependencyPath = dependency === '@/lib/i18n' ? localePath
      : dependency === '@/components/FeishuSettingsPanel' ? panelPath : createRequire(modulePath).resolve(dependency);
    dependencies[dependency] = dependencyPath;
    collectModule(dependencyPath);
  }
}
collectModule(harnessPath);
const browserBundle = `(() => {
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
const styles = readFileSync(resolve(repository, 'src/app/globals.css'), 'utf8').replace(/@import[^;]+;/g, '');
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(browserBundle);
  } else if (request.url === '/styles.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(styles);
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><head><link rel="stylesheet" href="/styles.css"></head><body><main class="content-wrap"><div class="settings-grid" id="root"></div></main><script src="/bundle.js"></script></body></html>');
  } else {
    response.writeHead(500);
    response.end('Unexpected request: every API call must be mocked.');
  }
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || 'chrome' });
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('The Feishu panel must not persist credentials.'); };
  });
  const initialSettings = {
    enabled: false, notifyDrafts: true, notifyPublished: false,
    webhookConfigured: true, signingConfigured: true, encryptionReady: true,
    version: 1, updatedAt: '2026-10-14T08:00:00Z', lastTestAt: null,
    lastTestOk: null, lastTestError: null, lastWorkerAt: '2026-10-14T09:00:00Z',
    lastDeliveryError: 'Delivery rejected https://example.test/fake-private-webhook'
  };
  let settings = { ...initialSettings };
  let getStatus = 200;
  let patchStatus = 200;
  let patchError = 'Access denied';
  let getStatusAfterSave = 200;
  let testStatus = 200;
  let envelope = false;
  let getCount = 0;
  const patches = [];
  const tests = [];
  await page.route(/\/api\/admin\/feishu(?:\/test)?$/, async route => {
    const request = route.request();
    if (request.method() === 'GET') {
      getCount += 1;
      await route.fulfill({ status: getStatus, json: getStatus === 200 ? envelope ? { settings } : settings : { error: 'Access denied' } });
    } else if (request.method() === 'PATCH') {
      const body = request.postDataJSON();
      patches.push(body);
      assert.ok(Object.keys(body).every(field => ['enabled', 'notifyDrafts', 'notifyPublished', 'webhookUrl', 'signingSecret', 'clearWebhook', 'clearSigningSecret'].includes(field)));
      if (patchStatus === 200) {
        settings = { ...settings, enabled: body.enabled, notifyDrafts: body.notifyDrafts, notifyPublished: body.notifyPublished, version: settings.version + 1 };
        if (body.clearWebhook) settings.webhookConfigured = false;
        else if (body.webhookUrl) settings.webhookConfigured = true;
        if (body.clearSigningSecret) settings.signingConfigured = false;
        else if (body.signingSecret) settings.signingConfigured = true;
        getStatus = getStatusAfterSave;
      }
      await route.fulfill({ status: patchStatus, json: patchStatus === 200 ? { success: true } : { error: patchError } });
    } else {
      assert.equal(new URL(request.url()).pathname, '/api/admin/feishu/test');
      assert.equal(request.method(), 'POST');
      const body = request.postDataJSON();
      tests.push(body);
      assert.deepEqual(body, {}, 'Tests must never send unsaved credentials or preferences');
      settings = { ...settings, lastTestAt: '2026-10-14T10:00:00Z', lastTestOk: testStatus === 200 };
      await route.fulfill({ status: testStatus, json: testStatus === 200 ? { success: true } : testStatus === 429 ? {} : { error: 'Access denied' } });
    }
  });
  const mount = async (permission = true, language = 'en') => {
    await page.evaluate(({ permission, language }) => window.mountPanel(permission, language), { permission, language });
    if (permission === true && getStatus === 200 && !envelope) await page.locator('#feishu-webhook').waitFor();
  };
  const save = async () => {
    const previousCount = patches.length;
    await page.getByRole('button', { name: 'Save Feishu settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
    assert.equal(patches.length, previousCount + 1);
  };
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.mountPanel === 'function');
  for (const permission of [false, undefined, null, 'true']) {
    await page.evaluate(permission => window.mountPanel(permission), permission);
    assert.equal(await page.locator('section').count(), 0);
  }
  assert.equal(getCount, 0, 'Non-administrators must not fetch settings');
  await mount();
  assert.equal(await page.getByLabel('New webhook URL').inputValue(), '');
  assert.equal(await page.getByLabel('New signing secret').inputValue(), '');
  assert.equal(await page.getByLabel('New webhook URL').getAttribute('type'), 'password');
  assert.equal(await page.getByLabel('New signing secret').getAttribute('type'), 'password');
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isEnabled(), true);
  await page.getByLabel('Enable Feishu notifications', { exact: true }).check();
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isDisabled(), true);
  assert.match(await page.locator('#feishu-test-help').innerText(), /Save your changes/);
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false });
  console.log('PASS: administrator-only real component; password fields never prefilled; blank values preserve saved credentials; dirty saved-only test gate.');

  await page.getByLabel('New webhook URL').fill('https://open.feishu.cn/open-apis/bot/v2/hook/fake-ui-only');
  await page.getByLabel('New signing secret').fill('fake-ui-secret');
  await save();
  assert.equal(patches.at(-1).signingSecret, 'fake-ui-secret');
  assert.equal(await page.getByLabel('New webhook URL').inputValue(), '');
  assert.equal(await page.getByLabel('New signing secret').inputValue(), '');
  assert.equal(await page.evaluate(() => location.search + localStorage.length + sessionStorage.length), '00');
  await page.getByLabel('Clear the saved signing secret', { exact: true }).check();
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false, clearSigningSecret: true });
  await page.getByLabel('Clear the saved webhook URL', { exact: true }).check();
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false, clearWebhook: true });
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isDisabled(), true);
  console.log('PASS: strict PATCH allowlist, independent explicit clears, credentials cleared after save, no URL or browser-storage persistence.');

  settings = { ...initialSettings };
  await mount();
  patchStatus = 400;
  patchError = 'Rejected fake-current-secret at https://example.test/fake-private-webhook';
  await page.getByLabel('New signing secret').fill('fake-current-secret');
  await save();
  assert.equal(await page.getByLabel('New signing secret').inputValue(), 'fake-current-secret', 'A failed save must remain editable for retry');
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /fake-current-secret|example.test/);
  patchStatus = 200;
  patchError = 'Access denied';
  getStatusAfterSave = 500;
  await save();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  getStatus = getStatusAfterSave = 200;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByLabel('New signing secret').waitFor();
  assert.equal(await page.getByLabel('New signing secret').inputValue(), '', 'A successful save must clear credentials even when the status refresh fails');
  console.log('PASS: failed saves retain editable values but redact errors; successful saves clear credentials despite a failed refresh, with safe retry.');

  settings = { ...initialSettings, encryptionReady: false };
  await mount();
  await page.getByLabel('New webhook URL').fill('fake-unsaved-value');
  assert.equal(await page.getByRole('button', { name: 'Save Feishu settings', exact: true }).isDisabled(), true);
  assert.match(await page.getByRole('alert').innerText(), /FEISHU_ENCRYPTION_KEY/);
  settings = { ...initialSettings };
  await mount();
  await page.getByRole('button', { name: 'Send test message', exact: true }).click();
  await page.getByText('Feishu test message sent using the saved configuration.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
  assert.deepEqual(tests.at(-1), {});
  assert.match(await page.locator('dl').innerText(), /Successful/);
  assert.match(await page.locator('section').innerText(), /Last worker update/);
  assert.match(await page.locator('section').innerText(), /Last delivery error \(redacted\)/);
  assert.doesNotMatch(await page.locator('section').innerText(), /example.test/);
  testStatus = 429;
  await page.getByRole('button', { name: 'Send test message', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Wait before trying again/);
  assert.match(await page.locator('dl').innerText(), /Failed/);
  console.log('PASS: encryption readiness blocks save; test POST is {}, success metadata and worker/redacted errors visible; 429 safe error.');

  for (const status of [401, 403]) {
    for (const action of ['GET', 'PATCH', 'POST']) {
      getStatus = action === 'GET' ? status : 200;
      patchStatus = action === 'PATCH' ? status : 200;
      testStatus = action === 'POST' ? status : 200;
      await mount();
      if (action === 'PATCH') {
        await page.getByLabel('New signing secret').fill('credential-must-disappear');
        await page.getByRole('button', { name: 'Save Feishu settings', exact: true }).click();
      } else if (action === 'POST') {
        await page.getByRole('button', { name: 'Send test message', exact: true }).click();
      }
      await page.waitForFunction(() => document.querySelector('section') === null);
      assert.doesNotMatch(await page.locator('body').innerHTML(), /credential-must-disappear/);
    }
  }
  getStatus = patchStatus = testStatus = 200;
  await mount();
  await page.getByLabel('New signing secret').fill('discard-on-role-change');
  await page.evaluate(() => window.renderPanel(false));
  await page.waitForFunction(() => document.querySelector('section') === null);
  await page.evaluate(() => window.renderPanel(true));
  await page.getByLabel('New signing secret').waitFor();
  assert.equal(await page.getByLabel('New signing secret').inputValue(), '');
  envelope = true;
  await mount();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Could not load Feishu settings/);
  assert.equal(await page.locator('form').count(), 0);
  envelope = false;
  await mount(true, 'zh');
  await page.getByRole('heading', { name: '\u98de\u4e66\u7fa4\u901a\u77e5' }).waitFor();
  for (const language of ['vi', 'th']) {
    await page.evaluate(language => window.renderPanel(true, language), language);
    await page.getByRole('heading', { name: 'Feishu group notifications' }).waitFor();
  }
  assert.deepEqual(browserErrors, []);
  console.log('PASS: GET/PATCH/test 401 and 403 revoke and clear; live role change clears secrets; guessed envelope rejected; Chinese and English fallback; no browser errors.');
} finally {
  if (browser) await browser.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}

// Exercise the actual submission handlers, extracted via the TS AST rather than a copied model.
const studioSource = ts.createSourceFile('ContentStudio.tsx', readFileSync(resolve(repository, 'src/components/ContentStudio.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const studioFunction = studioSource.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'ContentStudio');
const handlers = studioFunction.body.statements.filter(statement => ts.isFunctionDeclaration(statement) && ['submitDraft', 'batchSubmitDrafts'].includes(statement.name?.text));
assert.equal(handlers.length, 2);
const printer = ts.createPrinter();
const handlerSource = handlers.map(handler => printer.printNode(ts.EmitHint.Unspecified, handler, studioSource)).join('\n');
const createHandlers = new Function('dependencies', `${transpile(`
  const { assets, socialAccounts, config, selectedAsset, currentProjectId, fetch, readJson, notify, t,
    setPublishing, setAssets, setSelectedAsset, setPublishModalAsset, setLoading, setSubmissionNotice } = dependencies;
  ${handlerSource}
  return { submitDraft, batchSubmitDrafts };
`)}`);
const assets = ['one', 'two'].map(id => ({ id, platform: 'x', content: 'Fictional draft', publishStatus: 'unpublished' }));
let currentAssets = assets;
const notices = [];
let persistentNotice = '';
let publishCalls = 0;
const handlersUnderTest = createHandlers({
  assets, socialAccounts: [{ id: 'fake-account', name: 'Fake account', identifier: 'x' }], config: {}, selectedAsset: null, currentProjectId: '',
  fetch: async () => { publishCalls += 1; return { ok: true }; },
  readJson: async () => ({ success: true, warning: 'notification_enqueue_failed' }),
  notify: message => notices.push(message), t: message => message,
  setPublishing: () => {}, setAssets: update => { currentAssets = update(currentAssets); },
  setSelectedAsset: () => {}, setPublishModalAsset: () => {}, setLoading: () => {},
  setSubmissionNotice: message => { persistentNotice = message; }
});
assert.deepEqual(await handlersUnderTest.submitDraft(assets[0], 'fake-account'), { success: true, warning: true });
assert.equal(currentAssets[0].publishStatus, 'drafted');
assert.match(notices.at(-1), /Draft submitted, but notifications or status tracking need attention/);
assert.match(persistentNotice, /Do not submit it again/);
assert.equal(publishCalls, 1, 'A warning must not retry a successful submission');
notices.length = 0;
await handlersUnderTest.batchSubmitDrafts();
assert.equal(publishCalls, 3);
assert.equal(notices.length, 1, 'Batch results must be aggregated, not overwritten by per-draft success toasts');
assert.match(notices[0], /Drafts submitted: 2/);
assert.match(notices[0], /Notifications or status tracking need attention: 2/);
assert.match(persistentNotice, /Do not resubmit successful drafts/);
assert.ok(currentAssets.every(asset => asset.publishStatus === 'drafted'));
console.log('PASS: real single/modal and batch handlers retain successful drafted status on warning, never retry, and aggregate warning count.');
