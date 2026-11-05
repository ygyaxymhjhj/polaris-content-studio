import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "@/lib/project-db";
import type { SocialAccount, SocialAccountAssignee } from "@/lib/types";

/**
 * MySQL DATETIME values are written and compared as explicit UTC strings. The pool sets timezone "Z",
 * but the database server's own timezone is unknown, so NOW() would disagree with a JavaScript-computed expiry.
 */
const utc = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");

/** Authorisation attempts stop being trusted after the same 10 minutes as the connect cookie. */
export const CONNECT_ATTEMPT_TTL_MS = 600_000;

export type AccountOrigin = "connect" | "admin";

export interface SocialAccountRecord {
  integrationId: string;
  provider: string;
  accountName: string;
  origin: AccountOrigin | null;
  /** Empty = unassigned (administrators only). */
  assignedUsers: SocialAccountAssignee[];
}

const ACCOUNT_SELECT = `SELECT a.integration_id, a.provider, a.account_name, a.origin,
         u.id AS assigned_user_id, u.display_name AS assigned_user_name
    FROM social_accounts a
    LEFT JOIN social_account_assignments sa ON sa.integration_id = a.integration_id
    LEFT JOIN users u ON u.id = sa.user_id`;

function foldRecords(rows: RowDataPacket[]): Map<string, SocialAccountRecord> {
  const records = new Map<string, SocialAccountRecord>();
  for (const row of rows) {
    const integrationId = String(row.integration_id);
    let record = records.get(integrationId);
    if (!record) {
      record = {
        integrationId,
        provider: String(row.provider || ""),
        accountName: String(row.account_name || ""),
        origin: row.origin === "connect" || row.origin === "admin" ? row.origin : null,
        assignedUsers: []
      };
      records.set(integrationId, record);
    }
    if (row.assigned_user_id) {
      record.assignedUsers.push({ id: String(row.assigned_user_id), name: String(row.assigned_user_name || "") });
    }
  }
  return records;
}

/** One predicate for every account-visibility decision; admins bypass it at the call site. */
export function isAccountAssignedTo(
  account: { assignedUsers?: readonly SocialAccountAssignee[] } | null | undefined,
  userId: string
): boolean {
  return Boolean(account?.assignedUsers?.some(user => user.id === userId));
}

/**
 * Registers every channel Postiz currently reports. Missing rows are inserted as unassigned
 * (administrators assign them); existing rows only have their display snapshot refreshed —
 * the ownership columns are never touched here, so a sync can never steal or move an account.
 */
export async function syncSocialAccounts(accounts: SocialAccount[]): Promise<void> {
  if (!accounts.length) return;
  const values = accounts.map((account) => [account.id, account.identifier, account.name]);
  const placeholders = values.map(() => "(?,?,?)").join(",");
  await database().execute(
    `INSERT INTO social_accounts (integration_id, provider, account_name) VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE provider=VALUES(provider), account_name=VALUES(account_name)`,
    values.flat()
  );
}

/** Every registered channel with its assigned users, keyed by integration id. */
export async function listSocialAccounts(): Promise<Map<string, SocialAccountRecord>> {
  const [rows] = await database().execute<RowDataPacket[]>(
    `${ACCOUNT_SELECT} ORDER BY a.integration_id, u.display_name, u.id`
  );
  return foldRecords(rows);
}

/** Single registry row; null when the channel has never been synced (or does not exist). */
export async function getSocialAccount(integrationId: string): Promise<SocialAccountRecord | null> {
  const [rows] = await database().execute<RowDataPacket[]>(
    `${ACCOUNT_SELECT} WHERE a.integration_id = ?`,
    [integrationId]
  );
  return foldRecords(rows).get(integrationId) ?? null;
}

/**
 * Records who started an authorisation and which channels existed beforehand, so the return
 * callback can tell exactly which channel this member just added. Expired rows are swept here
 * instead of by a scheduled job; this table only ever holds live attempts.
 */
export async function createConnectAttempt(entry: {
  stateHash: string;
  userId: string;
  provider: string;
  snapshotIds: string[] | null;
  returnView?: string;
}): Promise<void> {
  await database().execute(
    "INSERT INTO social_connect_attempts (state_hash, user_id, provider, snapshot_ids, return_view, expires_at) VALUES (?,?,?,?,?,?)",
    [
      entry.stateHash,
      entry.userId,
      entry.provider,
      entry.snapshotIds ? JSON.stringify(entry.snapshotIds) : null,
      entry.returnView || "accounts",
      utc(new Date(Date.now() + CONNECT_ATTEMPT_TTL_MS))
    ]
  );
  await database().execute("DELETE FROM social_connect_attempts WHERE expires_at < ?", [utc(new Date())]);
}

function parseSnapshot(value: unknown): string[] | null {
  if (value == null) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : null;
  } catch {
    return null;
  }
}

export interface ConnectCompletion {
  outcome: "returned" | "invalid" | "unconfirmed" | "conflict";
  returnView: string;
}

/** Claims one new integration and consumes its browser attempt in the same short transaction. */
export async function completeConnectAttempt(
  stateHash: string,
  userId: string,
  liveAccounts: SocialAccount[]
): Promise<ConnectCompletion> {
  const connection = await database().getConnection();
  try {
    // READ COMMITTED avoids REPEATABLE READ gap locks on the assignment range: different accounts
    // can be assigned concurrently without deadlocking; the account row lock serializes one account.
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const [attempts] = await connection.execute<RowDataPacket[]>(
      "SELECT user_id, provider, snapshot_ids, return_view, expires_at, consumed_at FROM social_connect_attempts WHERE state_hash=? FOR UPDATE",
      [stateHash]
    );
    const attempt = attempts[0];
    const now = utc(new Date());
    if (!attempt || String(attempt.user_id) !== userId || attempt.consumed_at != null || String(attempt.expires_at) <= now) {
      await connection.rollback();
      return { outcome: "invalid", returnView: "accounts" };
    }
    const returnView = String(attempt.return_view || "accounts");
    const snapshotIds = parseSnapshot(attempt.snapshot_ids);
    const provider = String(attempt.provider).toLowerCase();
    const existedBefore = new Set(snapshotIds ?? []);
    const candidates = liveAccounts.filter(account =>
      account.id.trim() !== "" && account.id.toLowerCase() !== provider &&
      !existedBefore.has(account.id) && account.identifier.toLowerCase() === provider
    );
    // A provider-only fallback id is not an integration; neither added=<provider> nor the
    // apiKey-only webhook identifies an account. Ambiguous differences must stay unclaimed.
    if (!snapshotIds || candidates.length !== 1) {
      await connection.rollback();
      return { outcome: "unconfirmed", returnView };
    }
    const candidate = candidates[0];
    await connection.execute(
      `INSERT INTO social_accounts (integration_id, provider, account_name) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE provider=VALUES(provider), account_name=VALUES(account_name)`,
      [candidate.id, candidate.identifier, candidate.name]
    );
    // Connect and the admin replace-set serialize on this row.
    await connection.execute("SELECT integration_id FROM social_accounts WHERE integration_id=? FOR UPDATE", [candidate.id]);
    const [assignmentRows] = await connection.execute<RowDataPacket[]>(
      "SELECT user_id FROM social_account_assignments WHERE integration_id=? FOR UPDATE", [candidate.id]
    );
    const assignedUserIds = assignmentRows.map(row => String(row.user_id));
    if (!assignedUserIds.length) {
      await connection.execute(
        "INSERT INTO social_account_assignments (integration_id, user_id, created_at) VALUES (?,?,?)",
        [candidate.id, userId, utc(new Date())]
      );
      await connection.execute(
        "UPDATE social_accounts SET assigned_by_user_id=?, origin='connect' WHERE integration_id=?",
        [userId, candidate.id]
      );
    } else if (!assignedUserIds.includes(userId)) {
      // An existing assignment set is never extended by re-authorisation.
      await connection.rollback();
      return { outcome: "conflict", returnView };
    }
    // Check TTL again after SQL writes; crossing it must roll back the ownership change too.
    const consumedAt = utc(new Date());
    const [consumed] = await connection.execute<ResultSetHeader>(
      "UPDATE social_connect_attempts SET consumed_at=? WHERE state_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at>?",
      [consumedAt, stateHash, userId, consumedAt]
    );
    if (consumed.affectedRows !== 1) {
      await connection.rollback();
      return { outcome: "invalid", returnView: "accounts" };
    }
    await connection.commit();
    return { outcome: "returned", returnView };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Administrator assignment: replaces the complete user set. An empty list returns the channel to
 * the unassigned pool (administrators only). Existence of the channel and users is validated by the
 * caller; a missing row here returns false without changing anything.
 */
export async function replaceAccountAssignments(
  integrationId: string,
  userIds: string[],
  adminUserId: string
): Promise<boolean> {
  const ids = [...new Set(userIds)];
  const connection = await database().getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const [accounts] = await connection.execute<RowDataPacket[]>(
      "SELECT integration_id FROM social_accounts WHERE integration_id=? FOR UPDATE",
      [integrationId]
    );
    if (!accounts.length) {
      await connection.rollback();
      return false;
    }
    await connection.execute("DELETE FROM social_account_assignments WHERE integration_id=?", [integrationId]);
    if (ids.length) {
      const now = utc(new Date());
      await connection.execute(
        `INSERT INTO social_account_assignments (integration_id, user_id, created_at)
         VALUES ${ids.map(() => "(?,?,?)").join(",")}`,
        ids.flatMap(userId => [integrationId, userId, now])
      );
      await connection.execute(
        "UPDATE social_accounts SET assigned_by_user_id=?, origin='admin' WHERE integration_id=?",
        [adminUserId, integrationId]
      );
    } else {
      await connection.execute(
        "UPDATE social_accounts SET assigned_by_user_id=NULL, origin=NULL WHERE integration_id=?",
        [integrationId]
      );
    }
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
