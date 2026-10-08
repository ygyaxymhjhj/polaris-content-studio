#!/usr/bin/env node
// Bootstraps the first account. The member-management UI needs a signed-in user, so the
// very first one has to be created out of band. Afterwards use the Settings page.
//
//   node scripts/create-user.mjs <username> ["Display name"]
//   node scripts/create-user.mjs --self-check
//
// Password is prompted without echo, or taken from POLARIS_PASSWORD for automation.
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';

// Kept byte-compatible with src/lib/auth.ts, a TypeScript module this plain-node script cannot import.
// The round trip is asserted by --self-check and by scripts/test-auth.mjs, which logs in with a password
// this script hashed.
const PARAMS = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, expected] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  try {
    const expectedBytes = Buffer.from(expected, 'hex');
    const derived = scryptSync(password, Buffer.from(salt, 'hex'), expectedBytes.length, { N: Number(N), r: Number(r), p: Number(p) });
    return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
  } catch {
    return false;
  }
}

function selfCheck() {
  const stored = hashPassword('correct horse battery staple');
  if (!/^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(stored)) throw new Error(`unexpected hash format: ${stored}`);
  if (!verifyPassword('correct horse battery staple', stored)) throw new Error('correct password rejected');
  if (verifyPassword('wrong password', stored)) throw new Error('wrong password accepted');
  if (verifyPassword('correct horse battery staple', 'garbage')) throw new Error('malformed hash accepted');
  if (hashPassword('same input') === hashPassword('same input')) throw new Error('salt is not random');
  console.log('PASS: scrypt hash format, correct/wrong/malformed verification, random salt.');
}

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (char === '\u0003') {
        process.stdout.write('\n');
        process.exit(130);
      } else if (char === '\u007f' || char === '\b') {
        if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (char >= ' ') {
        value += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const [username, displayName] = process.argv.slice(2);
  if (!username) {
    console.error('usage: node scripts/create-user.mjs <username> ["Display name"]');
    process.exit(2);
  }
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
    console.error('username must be 3-64 characters of letters, digits, dot, underscore or hyphen');
    process.exit(2);
  }

  process.loadEnvFile('.env.local');
  const password = process.env.POLARIS_PASSWORD || (await askHidden(`Password for ${username}: `));
  if (password.length < 8) {
    console.error('password must be at least 8 characters');
    process.exit(2);
  }

  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });
  try {
    const id = randomUUID();
    await db.execute('INSERT INTO users (id, username, display_name, password_hash) VALUES (?,?,?,?)', [
      id, username, displayName || username, hashPassword(password)
    ]);
    console.log(`created ${username} (${id})`);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      console.error(`username "${username}" already exists. Change its password from the Settings page instead.`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.end();
  }
}

// Only run when invoked directly; test scripts import hashPassword from this module.
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  if (process.argv.includes('--self-check')) selfCheck();
  else await main();
}
