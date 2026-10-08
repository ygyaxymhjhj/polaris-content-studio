#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { openDatabase } from './_login.mjs';

export async function checkUserRoles(db) {
  const [rows] = await db.execute('SELECT role, disabled FROM users WHERE username=?', ['admin']);
  if (rows.length !== 1 || rows[0].role !== 'admin' || Number(rows[0].disabled) !== 0) {
    throw new Error('The existing admin account must be an enabled administrator. Run the user-roles migration, or bootstrap it with create-user.mjs --admin admin.');
  }
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  let db;
  try {
    db = await openDatabase();
    await checkUserRoles(db);
    console.log('PASS: users.role exists and the admin account is an enabled administrator.');
  } catch (error) {
    console.error(error?.code === 'ER_BAD_FIELD_ERROR'
      ? 'users.role is missing. Apply deploy/mysql/migrations/2026-10-08-user-roles.sql with a schema administrator before starting this version.'
      : error?.code ? `Account storage check failed (${error.code}).` : error.message);
    process.exitCode = 1;
  } finally {
    if (db) await db.end();
  }
}
