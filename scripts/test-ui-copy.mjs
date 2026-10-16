// Exercise the actual translation boundary and rendered account/connection UI without live APIs.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modules = new Map();
function loadModule(modulePath) {
  if (modules.has(modulePath)) return modules.get(modulePath).exports;
  const source = readFileSync(modulePath, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }
  }).outputText;
  const moduleRecord = { exports: {} };
  modules.set(modulePath, moduleRecord);
  const require = dependency => {
    if (!dependency.startsWith('@/')) return createRequire(modulePath)(dependency);
    const basePath = resolve(repository, 'src', dependency.slice(2));
    return loadModule(existsSync(`${basePath}.ts`) ? `${basePath}.ts` : `${basePath}.tsx`);
  };
  new Function('require', 'module', 'exports', compiled)(require, moduleRecord, moduleRecord.exports);
  return moduleRecord.exports;
}

const translationPath = resolve(repository, 'src/lib/i18n.tsx');
const { translate, LocaleContext } = loadModule(translationPath);
const { default: SocialAccountsView } = loadModule(resolve(repository, 'src/components/SocialAccountsView.tsx'));
const { default: ConnectAccountsDialog } = loadModule(resolve(repository, 'src/components/ConnectAccountsDialog.tsx'));
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
  const accountMarkup = render(React.createElement(SocialAccountsView, {
    accounts: [{ id: 'account', name: 'Postiz Fan', identifier: 'x', disabled: true }],
    configured: true, oauthConfigured: true, uiUrl: consoleUrl, loading: false,
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
