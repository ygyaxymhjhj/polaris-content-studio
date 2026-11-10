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
let updateResult = 'updated';
let createResult = target;
const calls = [];
const sameOriginModule = loadModule('src/lib/same-origin.ts');
const routes = loadModule('src/app/api/auth/users/route.ts', {
  '@/lib/auth': {
    currentUser: async () => auth,
    unauthorized: () => NextResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
    listUsers: async () => { calls.push(['list']); return []; },
    createUser: async (...args) => { calls.push(['create', ...args]); return createResult; },
    updateMember: async (...args) => { calls.push(['update', ...args]); return updateResult; }
  },
  '@/lib/same-origin': sameOriginModule
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
const updates = [
  { action: 'disable' },
  { action: 'enable' },
  { action: 'password', password: 'replacement-password' },
  { action: 'set-role', role: 'admin' },
  { action: 'set-role', role: 'member' }
];
for (const update of updates) {
  calls.length = 0;
  assert.equal((await routes.PATCH(request('PATCH', { id: target, ...update }))).status, 403);
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
assert.deepEqual(calls, [['create', auth, createBody.username, createBody.displayName, createBody.password]]);
calls.length = 0;
assert.equal((await routes.POST(request('POST', { ...createBody, role: 'admin' }))).status, 400, 'Role cannot be assigned on create');
assert.equal(calls.length, 0);
createResult = undefined;
assert.equal((await routes.POST(request('POST', createBody))).status, 403, 'Recheck must be honored on create');
for (const update of updates) {
  calls.length = 0;
  const response = await routes.PATCH(request('PATCH', { id: target, ...update }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['update', auth, target, update]]);
  if (update.action === 'set-role') assert.deepEqual(await response.json(), { ok: true, changed: true });
}
for (const [result, status] of [['unchanged', 200], ['forbidden', 403], ['missing', 404], ['self', 400], ['protected', 400]]) {
  updateResult = result;
  const response = await routes.PATCH(request('PATCH', { id: target, action: 'set-role', role: 'member' }));
  assert.equal(response.status, status, result);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  if (result === 'unchanged') assert.deepEqual(await response.json(), { ok: true, changed: false });
}
calls.length = 0;
for (const body of [
  { id: target, action: 'enable', role: 'admin' },
  { id: target, action: 'disable', password: 'irrelevant' },
  { id: target, action: 'password' },
  { id: target, action: 'set-role' },
  { id: target, action: 'set-role', role: 'owner' },
  { id: target, action: 'set-role', role: 'member', password: 'irrelevant' },
  { id: target, action: 'set-role', role: 'member', extra: true },
  { id: '-'.repeat(36), action: 'set-role', role: 'member' }
]) assert.equal((await routes.PATCH(request('PATCH', body))).status, 400, JSON.stringify(body));
assert.equal((await routes.POST(request('POST', createBody, 'https://untrusted.example'))).status, 403);
assert.equal((await routes.PATCH(request('PATCH', { id: target, action: 'set-role', role: 'admin' }, 'https://untrusted.example'))).status, 403);
assert.equal(calls.length, 0);
console.log('PASS: anonymous and member authorization, admin role updates, strict action schemas, transaction result mapping and same-origin protection.');

let row = { id, username: 'admin', displayName: 'Administrator', role: 'member' };
const users = new Map([
  [id, { username: 'actor', role: 'admin', disabled: 0 }],
  [target, { username: 'target', role: 'member', disabled: 0 }]
]);
const statements = [];
let actorSession = true;
let failRevoke = false;
const connection = {
  beginTransaction: async () => statements.push({ sql: 'BEGIN' }),
  commit: async () => statements.push({ sql: 'COMMIT' }),
  rollback: async () => statements.push({ sql: 'ROLLBACK' }),
  release: () => statements.push({ sql: 'RELEASE' }),
  execute: async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('FROM users')) return [users.has(params[0]) ? [users.get(params[0])] : []];
    if (sql.includes('FROM sessions') && sql.startsWith('SELECT')) return [actorSession ? [{ id: params[0] }] : []];
    if (failRevoke && sql.startsWith('DELETE FROM sessions')) throw new Error('revocation failed');
    return [{ affectedRows: 1 }];
  }
};
const database = {
  getConnection: async () => connection,
  execute: async (sql, params) => { statements.push({ sql, params }); return [[row]]; }
};
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
const actor = { user: { id, role: 'admin' }, sessionHash: 'a'.repeat(64) };
statements.length = 0;
assert.ok(await account.createUser(actor, 'ordinary', 'New account', 'test-password'));
const insert = statements.find(s => s.sql.startsWith('INSERT INTO users'));
assert.match(insert.sql, /VALUES \(\?,\?,\?,\?,'member'\)/);
assert.equal(insert.params[1], 'ordinary');
assert.equal(statements.at(-2).sql, 'COMMIT');

const setRole = (role) => ({ action: 'set-role', role });
statements.length = 0;
assert.equal(await account.updateMember(actor, target, setRole('admin')), 'updated');
assert.deepEqual(statements.map(s => s.sql), [
  'BEGIN',
  'SELECT username, role, disabled FROM users WHERE id=? FOR UPDATE',
  'SELECT username, role, disabled FROM users WHERE id=? FOR UPDATE',
  'SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>? FOR UPDATE',
  'UPDATE users SET role=? WHERE id=?',
  'DELETE FROM sessions WHERE user_id=?',
  'COMMIT', 'RELEASE'
]);
assert.deepEqual(statements.slice(1, 3).map(s => s.params[0]), [id, target]);
assert.deepEqual(statements[4].params, ['admin', target]);
assert.deepEqual(statements[5].params, [target]);
users.get(target).role = 'admin';
statements.length = 0;
assert.equal(await account.updateMember({ ...actor, user: { id: target, role: 'admin' } }, id, setRole('member')), 'updated');
assert.deepEqual(statements.slice(1, 3).map(s => s.params[0]), [id, target], 'Reverse actor/target order must lock in the same order');

const noMutation = () => assert.ok(!statements.some(s => /^(INSERT|UPDATE|DELETE)/.test(s.sql)));
statements.length = 0;
assert.equal(await account.updateMember(actor, target, setRole('admin')), 'unchanged');
assert.equal(await account.updateMember(actor, id, setRole('member')), 'self');
assert.equal(await account.updateMember(actor, id, { action: 'disable' }), 'self');
assert.equal(await account.updateMember(actor, '33333333-3333-4333-8333-333333333333', setRole('admin')), 'missing');
users.get(target).username = 'admin';
assert.equal(await account.updateMember(actor, target, setRole('member')), 'protected');
assert.equal(await account.updateMember(actor, target, { action: 'disable' }), 'protected');
users.get(target).username = 'target';
users.get(id).role = 'member';
assert.equal(await account.updateMember(actor, target, setRole('member')), 'forbidden');
users.get(id).role = 'admin';
users.get(id).disabled = 1;
assert.equal(await account.updateMember(actor, target, setRole('member')), 'forbidden');
assert.equal(await account.createUser(actor, 'ordinary', 'New account', 'test-password'), undefined);
users.get(id).disabled = 0;
actorSession = false;
assert.equal(await account.updateMember(actor, target, setRole('member')), 'forbidden');
actorSession = true;
noMutation();

statements.length = 0;
failRevoke = true;
await assert.rejects(account.updateMember(actor, target, setRole('member')), /revocation failed/);
assert.deepEqual(statements.slice(-4).map(s => s.sql), ['UPDATE users SET role=? WHERE id=?', 'DELETE FROM sessions WHERE user_id=?', 'ROLLBACK', 'RELEASE']);
assert.ok(!statements.some(s => s.sql === 'COMMIT'));
console.log('PASS: live database role mapping, default-member creation, deterministic locking, transactional authorization, protected accounts and atomic role/session updates.');

const MembersPanel = loadModule('src/components/MembersPanel.tsx', {
  '@/lib/i18n': { useTranslation: () => message => message }
}).default;
for (const permission of [false, undefined, null, 'true']) {
  assert.equal(renderToStaticMarkup(createElement(MembersPanel, { canManageMembers: permission })), '', 'The panel must render nothing without explicit administrator permission');
}
const administratorPanel = renderToStaticMarkup(createElement(MembersPanel, { canManageMembers: true }));
assert.match(administratorPanel, /class="member-create"/, 'Administrators must retain the member management form');
console.log('PASS: the members panel itself fails closed without administrator permission.');
