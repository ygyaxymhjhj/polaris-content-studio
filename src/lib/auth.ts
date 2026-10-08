import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { database, databaseConfigured } from "@/lib/project-db";

export const sessionCookie = "polaris-session";
/** Anonymous per-browser cookie from before accounts existed; read once at login to adopt its projects. */
export const legacyOwnerCookie = "polaris-project-owner";

const sessionTtlDays = Number(process.env.SESSION_TTL_DAYS || 30);
// Parameters travel inside each stored hash, so raising them later needs no migration.
const scryptParams = { N: 16384, r: 8, p: 1 };

export type User = { id: string; username: string; displayName: string; role: "admin" | "member" };
export type Member = User & { disabled: boolean; createdAt: string };
export type Account = User & { passwordHash: string; disabled: boolean };
export type Auth = { user: User; ownerHash: string };

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Projects are partitioned by this value. Deriving it from the account makes saved work follow the person. */
export const ownerHashFor = (userId: string) => createHash("sha256").update(`polaris-user:${userId}`).digest("hex");

/**
 * MySQL DATETIME values are written and compared as explicit UTC strings. The pool sets timezone "Z",
 * but the database server's own timezone is unknown, so NOW() would disagree with a JavaScript-computed expiry.
 */
const utc = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, scryptParams);
  return `scrypt$${scryptParams.N}$${scryptParams.r}$${scryptParams.p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, N, r, p, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  try {
    const expectedBytes = Buffer.from(expected, "hex");
    const derived = scryptSync(password, Buffer.from(salt, "hex"), expectedBytes.length, { N: Number(N), r: Number(r), p: Number(p) });
    return derived.length === expectedBytes.length && timingSafeEqual(derived, expectedBytes);
  } catch {
    return false;
  }
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  await database().execute("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)", [
    hashToken(token),
    userId,
    utc(new Date(Date.now() + sessionTtlDays * 86_400_000))
  ]);
  // Expired rows are swept here instead of by a scheduled job; this table only ever holds live sessions.
  await database().execute("DELETE FROM sessions WHERE expires_at < ?", [utc(new Date())]);
  return token;
}

export async function destroySession(token: string | undefined) {
  if (!token) return;
  await database().execute("DELETE FROM sessions WHERE id=?", [hashToken(token)]);
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: sessionTtlDays * 86_400 };
}

/** Returns the signed-in account, or null. Also enforces `disabled`, so a disabled account cannot keep using an issued session. */
export async function currentUser(): Promise<Auth | null> {
  if (!databaseConfigured()) return null;
  const token = (await cookies()).get(sessionCookie)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT u.id, u.username, u.display_name AS displayName, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled=0",
    [hashToken(token), utc(new Date())]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const user: User = { id: String(row.id), username: String(row.username), displayName: String(row.displayName), role: row.role === "admin" ? "admin" : "member" };
  return { user, ownerHash: ownerHashFor(user.id) };
}

export const unauthorized = () =>
  NextResponse.json({ error: "Sign in to continue.", code: "UNAUTHORIZED" }, { status: 401, headers: { "Cache-Control": "no-store" } });

export async function findUserByUsername(username: string): Promise<Account | undefined> {
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT id, username, display_name AS displayName, role, password_hash AS passwordHash, disabled FROM users WHERE username=?",
    [username]
  );
  if (!rows.length) return undefined;
  const row = rows[0];
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.displayName),
    role: row.role === "admin" ? "admin" : "member",
    passwordHash: String(row.passwordHash),
    disabled: Number(row.disabled) === 1
  };
}

export async function listUsers(): Promise<Member[]> {
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT id, username, display_name AS displayName, role, disabled, created_at AS createdAt FROM users ORDER BY created_at"
  );
  return rows.map((row) => ({
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.displayName),
    role: row.role === "admin" ? "admin" : "member",
    disabled: Number(row.disabled) === 1,
    createdAt: String(row.createdAt)
  }));
}

export async function createUser(username: string, displayName: string, password: string) {
  const id = randomUUID();
  await database().execute("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?,?,?,?,'member')", [
    id,
    username,
    displayName,
    hashPassword(password)
  ]);
  return id;
}

/** Changing a password ends every existing session for that account, so a stale or shared login cannot survive it. */
export async function setPassword(userId: string, password: string) {
  await database().execute("UPDATE users SET password_hash=? WHERE id=?", [hashPassword(password), userId]);
  await database().execute("DELETE FROM sessions WHERE user_id=?", [userId]);
}

export async function setDisabled(userId: string, disabled: boolean) {
  await database().execute("UPDATE users SET disabled=? WHERE id=?", [disabled ? 1 : 0, userId]);
  if (disabled) await database().execute("DELETE FROM sessions WHERE user_id=?", [userId]);
}

/**
 * Claims the projects saved under this browser's pre-account anonymous cookie.
 * Only runs when the account owns nothing yet, so signing in on a colleague's machine
 * cannot move their work into your account.
 */
export async function adoptLegacyProjects(userId: string, legacyToken: string | undefined) {
  if (!legacyToken || !/^[a-f0-9]{64}$/.test(legacyToken)) return 0;
  const owner = ownerHashFor(userId);
  const [rows] = await database().execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM projects WHERE owner_hash=?", [owner]);
  if (Number(rows[0].total) > 0) return 0;
  const [result] = await database().execute<ResultSetHeader>("UPDATE projects SET owner_hash=? WHERE owner_hash=?", [owner, hashToken(legacyToken)]);
  return result.affectedRows;
}
