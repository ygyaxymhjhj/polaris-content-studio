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
// Font URLs contain semicolons; removing only up to the first one corrupts :root tokens.
const styles = readFileSync(resolve(repository, 'src/app/globals.css'), 'utf8').replace(/@import\s+url\([^)]*\)\s*;/g, '');
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(browserBundle);
  } else if (request.url === '/styles.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(styles);
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><main class="content-wrap"><div class="settings-grid" id="root"></div></main><script src="/bundle.js"></script></body></html>');
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
      if (patchStatus === 200 && body.enabled && body.clearWebhook) {
        await route.fulfill({ status: 400, json: { error: 'A webhook URL is required to enable Feishu notifications.' } });
        return;
      }
      if (patchStatus === 200) {
        settings = { ...settings, enabled: body.enabled, notifyDrafts: body.notifyDrafts, notifyPublished: body.notifyPublished, version: settings.version + 1 };
        if (body.clearWebhook) settings.webhookConfigured = false;
        else if (body.webhookUrl) settings.webhookConfigured = true;
        if (body.clearWebhook || body.clearSigningSecret) settings.signingConfigured = false;
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
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
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
  const signatureToggle = page.getByRole('checkbox', { name: 'Signature verification Optional', exact: true });
  const secretInput = page.getByLabel('Signing secret', { exact: true });
  const notificationsToggle = page.getByRole('checkbox', { name: /^Notifications (on|off)$/ });
  settings = { ...initialSettings, webhookConfigured: false, signingConfigured: false };
  await mount();
  assert.equal(await signatureToggle.isChecked(), false);
  assert.equal(await secretInput.isDisabled(), true);
  assert.equal(await secretInput.evaluate(input => input.required), false);
  await notificationsToggle.check();
  await page.getByLabel('Webhook URL', { exact: true }).fill('https://open.feishu.cn/open-apis/bot/v2/hook/fake-unsigned-ui-only');
  await save();
  assert.deepEqual(patches.at(-1), {
    enabled: true, notifyDrafts: true, notifyPublished: false,
    webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-unsigned-ui-only', clearSigningSecret: true
  });
  assert.equal(settings.signingConfigured, false);
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: 'Send test message', exact: true }).click();
  await page.getByText('Feishu test message sent using the saved configuration.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
  assert.deepEqual(tests.at(-1), {});
  console.log('PASS: new unsigned configuration defaults signature off; disabled non-required secret; webhook-only save and saved-only test succeed.');

  await signatureToggle.check();
  assert.equal(await secretInput.isEnabled(), true);
  assert.equal(await secretInput.evaluate(input => input.required), true);
  assert.equal(await secretInput.isVisible(), true);
  assert.equal(await page.locator('#feishu-signature-help').count(), 0, 'Signature instructions appear only as validation errors, not permanent prose');
  const patchesBeforeMissingSecret = patches.length;
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  assert.equal(await secretInput.evaluate(input => input.validity.valueMissing), true);
  assert.equal(patches.length, patchesBeforeMissingSecret, 'Only newly enabled signature mode requires a secret');
  await secretInput.fill('   ');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /required only when signature verification is enabled/);
  assert.equal(patches.length, patchesBeforeMissingSecret, 'Whitespace is not a signing secret');
  await secretInput.fill('fake-unsaved-secret');
  await signatureToggle.uncheck();
  assert.equal(await secretInput.inputValue(), '', 'Disabling signature mode discards the local secret');
  assert.equal(await secretInput.isDisabled(), true);
  assert.equal(await secretInput.evaluate(input => input.required), false);
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isEnabled(), true);
  await signatureToggle.check();
  await secretInput.fill('fake-new-signed-secret');
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false, signingSecret: 'fake-new-signed-secret' });
  assert.equal(await signatureToggle.isChecked(), true);
  assert.equal(await secretInput.inputValue(), '');
  assert.equal(await secretInput.evaluate(input => input.required), false);
  await signatureToggle.uncheck();
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isDisabled(), true);
  await signatureToggle.check();
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isEnabled(), true);
  console.log('PASS: only new signed mode requires a nonblank secret; signature toggles track dirty state without silently clearing saved credentials.');

  settings = { ...initialSettings };
  await mount();
  assert.equal(await signatureToggle.isChecked(), true);
  assert.equal(await page.getByLabel('Webhook URL', { exact: true }).inputValue(), '');
  assert.equal(await secretInput.inputValue(), '');
  assert.equal(await page.getByLabel('Webhook URL', { exact: true }).getAttribute('type'), 'password');
  assert.equal(await secretInput.getAttribute('type'), 'password');
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isEnabled(), true);
  await notificationsToggle.check();
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isDisabled(), true);
  assert.match(await page.locator('#feishu-test-help').innerText(), /Save your changes/);
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false });
  console.log('PASS: administrator-only real component; password fields never prefilled; blank values preserve saved credentials; dirty saved-only test gate.');

  await page.getByLabel('Webhook URL', { exact: true }).fill('https://open.feishu.cn/open-apis/bot/v2/hook/fake-ui-only');
  await secretInput.fill('fake-ui-secret');
  await save();
  assert.equal(patches.at(-1).signingSecret, 'fake-ui-secret');
  assert.equal(await page.getByLabel('Webhook URL', { exact: true }).inputValue(), '');
  assert.equal(await secretInput.inputValue(), '');
  assert.equal(await page.evaluate(() => location.search + localStorage.length + sessionStorage.length), '00');
  await signatureToggle.uncheck();
  await save();
  assert.deepEqual(patches.at(-1), { enabled: true, notifyDrafts: true, notifyPublished: false, clearSigningSecret: true });
  assert.equal(settings.signingConfigured, false);
  assert.equal(await signatureToggle.isChecked(), false);
  assert.equal(await secretInput.isDisabled(), true);
  assert.equal(await secretInput.evaluate(input => input.required), false);
  await page.getByLabel('Remove connection', { exact: true }).check();
  await save();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /webhook URL is required/);
  assert.equal(settings.webhookConfigured, true, 'An enabled configuration cannot clear its webhook');
  await notificationsToggle.uncheck();
  await save();
  assert.deepEqual(patches.at(-1), { enabled: false, notifyDrafts: true, notifyPublished: false, clearWebhook: true, clearSigningSecret: true });
  assert.equal(await page.getByRole('button', { name: 'Send test message', exact: true }).isDisabled(), true);
  console.log('PASS: strict PATCH allowlist; signature-off save clears saved secret; independent webhook clear; no URL or browser-storage persistence.');

  settings = { ...initialSettings, enabled: true, signingConfigured: false };
  await mount();
  await signatureToggle.check();
  assert.equal(await secretInput.evaluate(input => input.required), true);
  await notificationsToggle.uncheck();
  await page.getByLabel('Remove connection', { exact: true }).check();
  assert.equal(await secretInput.isDisabled(), true);
  assert.equal(await secretInput.evaluate(input => input.required), false);
  await save();
  assert.deepEqual(patches.at(-1), { enabled: false, notifyDrafts: true, notifyPublished: false, clearWebhook: true });
  assert.equal(settings.webhookConfigured, false);
  assert.equal(settings.signingConfigured, false);
  assert.equal(await signatureToggle.isChecked(), false);
  console.log('PASS: clearing webhook with notifications disabled bypasses unused new-signature requirement and reloads signature off.');

  settings = { ...initialSettings };
  await mount();
  patchStatus = 400;
  patchError = 'Rejected fake-current-secret at https://example.test/fake-private-webhook';
  await secretInput.fill('fake-current-secret');
  await save();
  assert.equal(await secretInput.inputValue(), 'fake-current-secret', 'A failed save must remain editable for retry');
  assert.doesNotMatch(await page.getByRole('alert').innerText(), /fake-current-secret|example.test/);
  patchStatus = 200;
  patchError = 'Access denied';
  getStatusAfterSave = 500;
  await save();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  getStatus = getStatusAfterSave = 200;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await secretInput.waitFor();
  assert.equal(await secretInput.inputValue(), '', 'A successful save must clear credentials even when the status refresh fails');
  console.log('PASS: failed saves retain editable values but redact errors; successful saves clear credentials despite a failed refresh, with safe retry.');

  settings = { ...initialSettings, encryptionReady: false };
  await mount();
  await page.getByLabel('Webhook URL', { exact: true }).fill('fake-unsaved-value');
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).isDisabled(), true);
  assert.match(await page.getByRole('alert').innerText(), /FEISHU_ENCRYPTION_KEY/);
  settings = { ...initialSettings };
  await mount();
  await page.getByRole('button', { name: 'Send test message', exact: true }).click();
  await page.getByText('Feishu test message sent using the saved configuration.', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-busy="false"]'));
  assert.deepEqual(tests.at(-1), {});
  assert.match(await page.locator('dl').innerText(), /Successful/);
  assert.match(await page.locator('.feishu-panel').innerText(), /Last worker update/);
  assert.match(await page.locator('.feishu-panel').innerText(), /Last delivery error \(redacted\)/);
  assert.doesNotMatch(await page.locator('.feishu-panel').innerText(), /example.test/);
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
        await secretInput.fill('credential-must-disappear');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      } else if (action === 'POST') {
        await page.getByRole('button', { name: 'Send test message', exact: true }).click();
      }
      await page.waitForFunction(() => document.querySelector('section') === null);
      assert.doesNotMatch(await page.locator('body').innerHTML(), /credential-must-disappear/);
    }
  }
  getStatus = patchStatus = testStatus = 200;
  await mount();
  await secretInput.fill('discard-on-role-change');
  await page.evaluate(() => window.renderPanel(false));
  await page.waitForFunction(() => document.querySelector('section') === null);
  await page.evaluate(() => window.renderPanel(true));
  await secretInput.waitFor();
  assert.equal(await secretInput.inputValue(), '');
  envelope = true;
  await mount();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Could not load Feishu settings/);
  assert.equal(await page.locator('form').count(), 0);
  envelope = false;
  await mount(true, 'zh');
  await page.getByRole('heading', { name: '\u98de\u4e66\u7fa4\u901a\u77e5' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '\u7b7e\u540d\u6821\u9a8c \u53ef\u9009', exact: true }).isChecked(), true);
  for (const language of ['vi', 'th']) {
    await page.evaluate(language => window.renderPanel(true, language), language);
    await page.getByRole('heading', { name: 'Feishu group notifications' }).waitFor();
  }
  settings = { ...initialSettings, enabled: true, lastDeliveryError: null };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mount(true, 'zh');
  const panel = page.locator('.feishu-panel');
  const removedCredentialNotice = /Existing credentials are never displayed|已有凭据不会回填或显示|输入框留空表示保留已保存值/;
  assert.doesNotMatch(await panel.innerHTML(), removedCredentialNotice, 'Removed instructions must not remain hidden in the DOM');
  const desktopLayout = await panel.evaluate(element => {
    const events = element.querySelector('.feishu-events').getBoundingClientRect();
    const connection = element.querySelector('.feishu-connection').getBoundingClientRect();
    return {
      height: element.getBoundingClientRect().height,
      columnsAligned: Math.abs(events.top - connection.top) < 2 && connection.left > events.right,
      paragraphsReset: [...element.querySelectorAll('p')].every(paragraph => getComputedStyle(paragraph).minHeight === '0px'),
      inputHeight: element.querySelector('#feishu-webhook').getBoundingClientRect().height,
      background: getComputedStyle(element).backgroundColor,
      enabledSwitch: getComputedStyle(element.querySelector('.feishu-switch-track')).backgroundColor,
      inlineStyles: element.querySelectorAll('[style]').length
    };
  });
  assert.equal(desktopLayout.columnsAligned, true, 'Desktop events and connection must share a row');
  assert.ok(desktopLayout.height >= 450 && desktopLayout.height <= 650, `Desktop panel must remain compact: ${desktopLayout.height}px`);
  assert.equal(desktopLayout.paragraphsReset, true, 'Shared card paragraph minimum height must not leak in');
  assert.ok(desktopLayout.inputHeight >= 40);
  assert.equal(desktopLayout.inlineStyles, 0);
  assert.equal(desktopLayout.background, 'rgb(255, 254, 250)', 'The harness must preserve the real warm-white tokens');
  assert.equal(desktopLayout.enabledSwitch, 'rgb(22, 21, 27)', 'An enabled switch must have a visible ink track');
  const desktopScreenshot = process.env.TEST_SCREENSHOT_PATH || '/tmp/polaris-feishu-settings-desktop.png';
  await page.screenshot({ path: desktopScreenshot, fullPage: true });
  for (const width of [350, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, `No horizontal overflow at ${width}px`);
    if (width === 375) {
      const mobileLayout = await page.evaluate(() => {
        const events = document.querySelector('.feishu-events').getBoundingClientRect();
        const connection = document.querySelector('.feishu-connection').getBoundingClientRect();
        return connection.top > events.bottom && Math.abs(events.left - connection.left) < 2;
      });
      assert.equal(mobileLayout, true, 'Mobile sections must stack');
      const mobileScreenshot = process.env.TEST_SCREENSHOT_PATH ? process.env.TEST_SCREENSHOT_PATH.replace(/(\.[^.]+)?$/, '-mobile$1') : '/tmp/polaris-feishu-settings-mobile.png';
      await page.screenshot({ path: mobileScreenshot, fullPage: true });
      console.log(`SCREENSHOT: ${mobileScreenshot}`);
    }
  }
  await mount(true, 'en');
  assert.doesNotMatch(await panel.innerHTML(), removedCredentialNotice);
  const visiblyNamedControls = [
    notificationsToggle,
    page.getByRole('checkbox', { name: /Draft review/ }),
    page.getByRole('checkbox', { name: /Post published/ }),
    page.getByRole('checkbox', { name: 'Remove connection', exact: true }),
    signatureToggle,
    page.getByLabel('Webhook URL', { exact: true }),
    secretInput,
    page.getByRole('button', { name: 'Send test message', exact: true }),
    page.getByRole('button', { name: 'Save changes', exact: true })
  ];
  for (const control of visiblyNamedControls) {
    assert.equal(await control.count(), 1, 'Each main control must be discoverable by its visible label');
    if (await control.isEnabled()) {
      await control.focus();
      assert.equal(await control.evaluate(element => document.activeElement === element), true, 'Visibly named enabled controls must receive keyboard focus');
    }
  }
  await signatureToggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await signatureToggle.isChecked(), false);
  assert.equal(await secretInput.isVisible(), false, 'Signature-off must hide the entire secret field');
  assert.equal(await secretInput.isDisabled(), true);
  assert.equal(await signatureToggle.evaluate(input => input.matches(':focus-visible')), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Save changes', exact: true }).evaluate(button => document.activeElement === button), true, 'Tab must skip hidden credentials and the disabled test button');
  await signatureToggle.focus();
  await page.keyboard.press('Space');
  assert.equal(await signatureToggle.isChecked(), true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(await page.locator('.feishu-switch-track').first().evaluate(track => parseFloat(getComputedStyle(track).transitionDuration) <= .001), 'Reduced motion must disable perceptible transitions, including the global minimal-duration override');
  console.log(`PASS: compact desktop ${desktopLayout.height}px; scoped paragraph reset; 350/375/768/1280px layouts; hidden signature field, keyboard Space/Tab, reduced motion and removed instructions.`);
  console.log(`SCREENSHOT: ${desktopScreenshot}`);
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
