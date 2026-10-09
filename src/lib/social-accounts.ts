import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { database } from "@/lib/project-db";
import type { SocialAccount } from "@/lib/types";

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
  ownerUserId: string | null;
  ownerName: string | null;
  origin: AccountOrigin | null;
}

function toRecord(row: RowDataPacket): SocialAccountRecord {
  return {
    integrationId: String(row.integration_id),
    provider: String(row.provider || ""),
    accountName: String(row.account_name || ""),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null,
    origin: row.origin === "connect" || row.origin === "admin" ? row.origin : null
  };
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

/** Ownership of every registered channel, keyed by integration id. */
export async function listAccountOwners(): Promise<Map<string, SocialAccountRecord>> {
  const [rows] = await database().execute<RowDataPacket[]>(
    `SELECT a.integration_id, a.provider, a.account_name, a.owner_user_id, a.origin,
            u.display_name AS owner_name
       FROM social_accounts a
       LEFT JOIN users u ON u.id = a.owner_user_id`
  );
  return new Map(rows.map((row) => [String(row.integration_id), toRecord(row)]));
}

/** Single registry row; null when the channel has never been synced (or does not exist). */
export async function getSocialAccount(integrationId: string): Promise<SocialAccountRecord | null> {
  const [rows] = await database().execute<RowDataPacket[]>(
    `SELECT a.integration_id, a.provider, a.account_name, a.owner_user_id, a.origin,
            u.display_name AS owner_name
       FROM social_accounts a
       LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.integration_id = ?`,
    [integrationId]
  );
  return rows.length ? toRecord(rows[0]) : null;
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
}): Promise<void> {
  await database().execute(
    "INSERT INTO social_connect_attempts (state_hash, user_id, provider, snapshot_ids, expires_at) VALUES (?,?,?,?,?)",
    [
      entry.stateHash,
      entry.userId,
      entry.provider,
      entry.snapshotIds ? JSON.stringify(entry.snapshotIds) : null,
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

/**
 * Atomically consumes the attempt matching this browser's connect cookie. The single conditional
 * UPDATE is the gate: a replayed return (or a second tab) finds consumed_at already set and gets null.
 */
export async function consumeConnectAttempt(
  stateHash: string,
  userId: string
): Promise<{ provider: string; snapshotIds: string[] | null } | null> {
  const now = utc(new Date());
  const [result] = await database().execute<ResultSetHeader>(
    "UPDATE social_connect_attempts SET consumed_at=? WHERE state_hash=? AND user_id=? AND consumed_at IS NULL AND expires_at>?",
    [now, stateHash, userId, now]
  );
  if (result.affectedRows !== 1) return null;
  const [rows] = await database().execute<RowDataPacket[]>(
    "SELECT provider, snapshot_ids FROM social_connect_attempts WHERE state_hash=?",
    [stateHash]
  );
  return { provider: String(rows[0]?.provider || ""), snapshotIds: parseSnapshot(rows[0]?.snapshot_ids) };
}

/**
 * Attributes channels that appeared after the snapshot to the member who started the flow.
 * Only ids absent from the snapshot and matching the requested provider are considered, and the
 * conditional upsert assigns ownership only while owner_user_id is still NULL — so when two
 * members authorise at the same time, the first return claims and the second lands unassigned
 * for an administrator to place. Rows already owned by anyone are never overwritten.
 */
export async function claimNewAccounts(entry: {
  userId: string;
  provider: string;
  snapshotIds: string[] | null;
  liveAccounts: SocialAccount[];
}): Promise<string[]> {
  // Without a snapshot the pre-authorisation state is unknown; claiming could take a colleague's account.
  if (!entry.snapshotIds) return [];
  const existedBefore = new Set(entry.snapshotIds);
  const provider = entry.provider.toLowerCase();
  const candidates = entry.liveAccounts.filter(
    (account) => !existedBefore.has(account.id) && account.identifier.toLowerCase() === provider
  );
  const claimed: string[] = [];
  for (const account of candidates) {
    // Assignment order matters: MySQL evaluates SET clauses left to right against current values,
    // so every ownership column is guarded by owner_user_id before the last clause changes it.
    const [result] = await database().execute<ResultSetHeader>(
      `INSERT INTO social_accounts (integration_id, provider, account_name, owner_user_id, assigned_by_user_id, origin)
       VALUES (?,?,?,?,?,'connect')
       ON DUPLICATE KEY UPDATE
         assigned_by_user_id = IF(owner_user_id IS NULL, VALUES(assigned_by_user_id), assigned_by_user_id),
         origin = IF(owner_user_id IS NULL, 'connect', origin),
         account_name = IF(owner_user_id IS NULL, VALUES(account_name), account_name),
         provider = IF(owner_user_id IS NULL, VALUES(provider), provider),
         owner_user_id = IF(owner_user_id IS NULL, VALUES(owner_user_id), owner_user_id)`,
      [account.id, account.identifier, account.name, entry.userId, entry.userId]
    );
    // 1 = inserted, 2 = ownership taken; 0 = already owned, so the first member to return keeps it.
    if (result.affectedRows > 0) claimed.push(account.id);
  }
  return claimed;
}

/**
 * Administrator assignment: ownerUserId sets the new owner, null returns the channel to the
 * unassigned pool. Existence of both the channel row and the target member is validated by the
 * caller, so a missing row here simply means nothing changed.
 */
export async function assignAccount(
  integrationId: string,
  ownerUserId: string | null,
  adminUserId: string
): Promise<void> {
  if (ownerUserId) {
    await database().execute(
      "UPDATE social_accounts SET owner_user_id=?, assigned_by_user_id=?, origin='admin' WHERE integration_id=?",
      [ownerUserId, adminUserId, integrationId]
    );
  } else {
    await database().execute(
      "UPDATE social_accounts SET owner_user_id=NULL, assigned_by_user_id=NULL, origin=NULL WHERE integration_id=?",
      [integrationId]
    );
  }
}
