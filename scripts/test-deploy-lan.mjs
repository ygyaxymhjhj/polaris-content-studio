import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUserRoles } from './check-user-roles.mjs';

const root = mkdtempSync(join(tmpdir(), 'polaris-deploy-test-'));
try {
  for (const dir of ['scripts', 'bin', '.next/server/app/api/auth/users', 'deploy/mysql', 'src/app/api/auth/users']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  copyFileSync('scripts/deploy-lan.sh', join(root, 'scripts/deploy-lan.sh'));
  copyFileSync('deploy/mysql/init.sql', join(root, 'deploy/mysql/init.sql'));
  copyFileSync('src/app/api/auth/users/route.ts', join(root, 'src/app/api/auth/users/route.ts'));
  const artifact = join(root, '.next/server/app/api/auth/users/route.js');
  const oldBuild = 'module.exports = { GET: () => ({ status: 200, permission: "any-signed-in-user" }) };\n';
  writeFileSync(artifact, oldBuild);
  writeFileSync(join(root, 'users.json'), JSON.stringify([{ username: 'admin', role: 'admin', disabled: false }]));
  assert.match(readFileSync(join(root, 'deploy/mysql/init.sql'), 'utf8'), /role ENUM\('admin','member'\)/);
  await checkUserRoles({ execute: async () => [JSON.parse(readFileSync(join(root, 'users.json'), 'utf8'))] });
  const calls = join(root, 'calls.log');
  for (const command of ['git', 'ssh', 'rsync']) {
    writeFileSync(join(root, 'bin', command), `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$POLARIS_TEST_CALLS"\n${command === 'git' ? "printf '%s\\n' 'b0885a6fd90b693f3c7996a59d4a85148fa7d586'" : command === 'ssh' ? 'cat >/dev/null' : ':'}\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, POLARIS_SERVER: 'not-a-real-server', POLARIS_TEST_CALLS: calls };
  for (const flags of [['--worktree', '--no-build', '--no-db'], ['--dry-run', '--no-build', '--worktree'], ['--no-build']]) {
    const result = spawnSync('bash', ['scripts/deploy-lan.sh', ...flags], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 2, '--no-build must be refused even when the role schema/admin preflight would pass');
    assert.match(result.stderr, /--no-build.*rebuild/);
    assert.equal(existsSync(calls), false, 'Refusal must happen before any git, service, database or sync action');
    assert.equal(readFileSync(artifact, 'utf8'), oldBuild);
  }
  const preview = spawnSync('bash', ['scripts/deploy-lan.sh', '--dry-run', '--worktree'], { cwd: root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(preview.status, 0, preview.stderr);
  const previewCalls = readFileSync(calls, 'utf8').trim().split('\n');
  assert.ok(previewCalls.includes('rsync'));
  assert.ok(!previewCalls.includes('ssh'), 'Dry-run must not stop/start a remote service or check/mutate its DB');
  assert.equal(readFileSync(artifact, 'utf8'), oldBuild);
  console.log('PASS: old production build + new role schema/source cannot deploy with --no-build; rejected before transport/service actions; safe dry-run preserved.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
