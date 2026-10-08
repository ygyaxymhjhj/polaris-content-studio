import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire('next/server');
function loadModule(path, mocks) {
  const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }
  });
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports);
  return compiled.exports;
}

const id = '11111111-1111-4111-8111-111111111111';
const target = '22222222-2222-4222-8222-222222222222';
const url = 'http://localhost:3002/api/auth/users';
let auth;
const calls = [];
const routes = loadModule('src/app/api/auth/users/route.ts', {
  '@/lib/auth': {
    currentUser: async () => auth,
    unauthorized: () => NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
    listUsers: async () => { calls.push(['list']); return []; },
    createUser: async (...args) => { calls.push(['create', ...args]); return target; },
    setPassword: async (...args) => calls.push(['password', ...args]),
    setDisabled: async (...args) => calls.push(['disabled', ...args])
  }
});
function request(method, data, origin = 'http://localhost:3002') {
  return new NextRequest(url, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(method === 'GET' ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) })
  });
}
const createBody = { username: 'new-member', displayName: 'New Member', password: 'test-password' };
for (const [role, expected] of [[undefined, 401], ['member', 403]]) {
  auth = role ? { user: { id, role } } : null;
  for (const method of ['GET', 'POST', 'PATCH']) {
    calls.length = 0;
    const response = await routes[method](request(method, method === 'POST' ? createBody : { id: target, action: 'disable' }));
    assert.equal(response.status, expected, `${role ?? 'anonymous'} ${method}`);
    assert.equal(calls.length, 0, 'Authorization must precede every member read/write');
    if (role) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await response.json()).code, 'FORBIDDEN');
    }
  }
}
auth = { user: { id, role: 'member' } };
for (const action of ['disable', 'enable', 'password']) {
  calls.length = 0;
  assert.equal((await routes.PATCH(request('PATCH', { id: target, action, password: 'replacement-password' }))).status, 403);
  assert.equal(calls.length, 0);
}
assert.equal((await routes.PATCH(request('PATCH', { id, action: 'disable' }))).status, 403, 'Member self-disable must be refused before the administrator self-disable check');
assert.equal((await routes.POST(request('POST', '{'))).status, 403, 'Forbidden users must not reach JSON parsing');
assert.equal((await routes.PATCH(request('PATCH', { id: target, action: 'disable', role: 'admin' }))).status, 403);

auth = { user: { id, role: 'admin' } };
calls.length = 0;
assert.equal((await routes.GET()).status, 200);
assert.deepEqual(calls, [['list']]);
calls.length = 0;
assert.equal((await routes.POST(request('POST', createBody))).status, 200);
assert.deepEqual(calls, [['create', createBody.username, createBody.displayName, createBody.password]]);
calls.length = 0;
assert.equal((await routes.POST(request('POST', { ...createBody, role: 'admin' }))).status, 400, 'Web clients cannot assign roles');
assert.equal(calls.length, 0);
for (const action of ['disable', 'enable', 'password']) {
  calls.length = 0;
  assert.equal((await routes.PATCH(request('PATCH', { id: target, action, password: 'replacement-password' }))).status, 200);
  assert.deepEqual(calls, action === 'password' ? [['password', target, 'replacement-password']] : [['disabled', target, action === 'disable']]);
}
calls.length = 0;
assert.equal((await routes.PATCH(request('PATCH', { id, action: 'disable' }))).status, 400);
assert.equal((await routes.PATCH(request('PATCH', { id: target, action: 'enable', role: 'admin' }))).status, 400);
for (const method of ['POST', 'PATCH']) assert.equal((await routes[method](request(method, createBody, 'https://untrusted.example'))).status, 403);
assert.equal(calls.length, 0);
console.log('PASS: anonymous 401; ordinary-member GET/POST/PATCH 403 with no reads/writes; admin management; self-disable and origin protection; web role injection rejected.');

let row = { id, username: 'admin', displayName: 'Administrator', role: 'member' };
const statements = [];
const database = { execute: async (sql, params) => {
  statements.push({ sql, params });
  return sql.startsWith('SELECT') ? [[row]] : [{ affectedRows: 1 }];
} };
const account = loadModule('src/lib/auth.ts', {
  'next/headers': { cookies: async () => ({ get: () => ({ value: 'a'.repeat(64) }) }) },
  '@/lib/project-db': { databaseConfigured: () => true, database: () => database }
});
assert.equal((await account.currentUser()).user.role, 'member', 'The username admin must not implicitly grant privileges');
row = { ...row, username: 'another-account', role: 'admin' };
assert.equal((await account.currentUser()).user.role, 'admin', 'Privileges come from the current database role');
row.role = 'member';
assert.equal((await account.currentUser()).user.role, 'member', 'Role changes take effect without recreating a session');
assert.ok(statements.filter(s => s.sql.includes('FROM sessions')).every(s => s.sql.includes('u.role')));
statements.length = 0;
await account.createUser('admin', 'New account named admin', 'test-password');
assert.equal(statements.length, 1);
assert.match(statements[0].sql, /VALUES \(\?,\?,\?,\?,'member'\)/);
assert.equal(statements[0].params[1], 'admin');
console.log('PASS: live database role mapping, no username-based privilege escalation, and every web-created account explicitly stored as member.');

const MembersPanel = loadModule('src/components/MembersPanel.tsx', {
  '@/lib/i18n': { useTranslation: () => message => message }
}).default;
for (const permission of [false, undefined, null, 'true']) {
  assert.equal(renderToStaticMarkup(createElement(MembersPanel, { canManageMembers: permission })), '', 'The panel must render nothing without explicit administrator permission');
}
const administratorPanel = renderToStaticMarkup(createElement(MembersPanel, { canManageMembers: true }));
assert.match(administratorPanel, /class="member-create"/, 'Administrators must retain the member management form');
console.log('PASS: the members panel itself fails closed without administrator permission.');
