import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
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
export type Auth = { user: User; ownerHash: string; sessionHash: string };
export type MemberUpdate =
  | { action: "password"; password: string }
  | { action: "disable" | "enable" }
  | { action: "set-role"; role: User["role"] };

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
  const sessionHash = hashToken(token);
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT u.id, u.username, u.display_name AS displayName, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>? AND u.disabled=0",
    [sessionHash, utc(new Date())]
  );
  if (!rows.length) return null;
  const row = rows[0];
  const user: User = { id: String(row.id), username: String(row.username), displayName: String(row.displayName), role: row.role === "admin" ? "admin" : "member" };
  return { user, ownerHash: ownerHashFor(user.id), sessionHash };
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

/** Single member lookup, used to validate assignment targets before writing them to a foreign key. */
export async function findUserById(userId: string): Promise<Member | undefined> {
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT id, username, display_name AS displayName, role, disabled, created_at AS createdAt FROM users WHERE id=?",
    [userId]
  );
  if (!rows.length) return undefined;
  const row = rows[0];
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.displayName),
    role: row.role === "admin" ? "admin" : "member",
    disabled: Number(row.disabled) === 1,
    createdAt: String(row.createdAt)
  };
}

async function withAdminUsers<T>(
  auth: Auth,
  targetId: string,
  mutate: (connection: PoolConnection, target: RowDataPacket | undefined) => Promise<T>
) {
  const actorId = auth.user.id;
  const connection = await database().getConnection();
  try {
    await connection.beginTransaction();
    const users = new Map<string, RowDataPacket>();
    // Point reads in primary-key order keep two administrators editing each other from deadlocking.
    for (const id of [...new Set([actorId, targetId])].sort()) {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT username, role, disabled FROM users WHERE id=? FOR UPDATE", [id]
      );
      if (rows[0]) users.set(id, rows[0]);
    }
    const actor = users.get(actorId);
    let result: T | undefined;
    if (actor?.role === "admin" && Number(actor.disabled) === 0) {
      // A stale request cannot regain authorization if its account is later re-enabled or promoted.
      const [sessions] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM sessions WHERE id=? AND user_id=? AND expires_at>? FOR UPDATE",
        [auth.sessionHash, actorId, utc(new Date())]
      );
      if (sessions.length) result = await mutate(connection, users.get(targetId));
    }
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function createUser(auth: Auth, username: string, displayName: string, password: string) {
  const id = randomUUID();
  const passwordHash = hashPassword(password);
  return withAdminUsers(auth, auth.user.id, async (connection) => {
    await connection.execute("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?,?,?,?,'member')", [id, username, displayName, passwordHash]);
    return id;
  });
}

export async function updateMember(auth: Auth, userId: string, update: MemberUpdate) {
  const { action } = update;
  if (auth.user.id === userId && (action === "disable" || action === "set-role")) return "self";
  const passwordHash = action === "password" ? hashPassword(update.password) : null;
  const result = await withAdminUsers(auth, userId, async (connection, target) => {
    if (!target) return "missing";
    if (target.username === "admin" && (action === "disable" || (action === "set-role" && update.role === "member"))) return "protected";
    if (action === "set-role") {
      if (target.role === update.role) return "unchanged";
      await connection.execute("UPDATE users SET role=? WHERE id=?", [update.role, userId]);
    } else if (action === "password") {
      await connection.execute("UPDATE users SET password_hash=? WHERE id=?", [passwordHash, userId]);
    } else {
      if (action === "enable" && Number(target.disabled) === 0) return "unchanged";
      await connection.execute("UPDATE users SET disabled=? WHERE id=?", [action === "disable" ? 1 : 0, userId]);
    }
    await connection.execute("DELETE FROM sessions WHERE user_id=?", [userId]);
    return "updated";
  });
  return result ?? "forbidden";
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
