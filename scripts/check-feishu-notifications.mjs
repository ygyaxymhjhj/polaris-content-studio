#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import nextEnvironment from "@next/env";
import { openDatabase } from "./_login.mjs";
import { readWorkerConfiguration } from "./run-social-notifications.mjs";

const requiredColumns = {
  workspace_feishu_config: ["id", "enabled", "notify_drafts", "notify_published", "encrypted_credentials", "version", "updated_by", "updated_at", "last_test_at", "last_test_ok", "last_test_error", "last_worker_at", "last_delivery_error"],
  social_post_tracking: ["publish_audit_id", "postiz_post_id", "state", "release_url", "postiz_publish_date", "confirmed_at", "submitted_at", "next_check_at", "last_checked_at", "check_attempts", "last_error", "notify_published", "config_version"],
  social_notification_outbox: ["id", "publish_audit_id", "event_type", "event_time", "status", "attempts", "next_attempt_at", "lease_token", "lease_expires_at", "sent_at", "last_error", "config_version", "payload"]
};

function verifyGrants(grantRows, schemaName) {
  const grantedPrivileges = new Map(Object.keys(requiredColumns).map((tableName) => [tableName, new Set()]));
  for (const row of grantRows) {
    const grantText = Object.values(row)[0];
    const match = typeof grantText === "string" && grantText.match(/^GRANT (.+?) ON (.+?) TO /i);
    if (!match) continue;
    const target = match[2].replaceAll("`", "");
    const [grantSchema, grantTable] = target.split(".");
    if (grantSchema !== "*" && grantSchema !== schemaName) continue;
    const privileges = match[1].toUpperCase().split(",").map((privilege) => privilege.trim());
    for (const [tableName, tablePrivileges] of grantedPrivileges) {
      if (grantTable !== "*" && grantTable !== tableName) continue;
      for (const privilege of privileges) tablePrivileges.add(privilege);
    }
  }
  for (const [tableName, privileges] of grantedPrivileges) {
    if (!privileges.has("ALL PRIVILEGES") && ["SELECT", "INSERT", "UPDATE"].some((privilege) => !privileges.has(privilege))) {
      throw new Error(`Missing SELECT/INSERT/UPDATE grants for ${tableName}. Apply the notification migration as a schema administrator.`);
    }
  }
}

function verifyEncryptionKey(encodedKey) {
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
    throw new Error("FEISHU_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key when notifications are enabled.");
  }
  const decodedKey = Buffer.from(encodedKey, "base64");
  if (decodedKey.length !== 32 || decodedKey.toString("base64") !== encodedKey) {
    throw new Error("FEISHU_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key when notifications are enabled.");
  }
}

export async function checkFeishuNotifications(connection, { environment = process.env, requireWorker = false } = {}) {
  const [schemaRows] = await connection.execute("SELECT DATABASE() AS schema_name");
  const schemaName = schemaRows[0]?.schema_name;
  if (!schemaName) throw new Error("Notification database is not configured.");
  for (const [tableName, columnNames] of Object.entries(requiredColumns)) {
    const [columnRows] = await connection.execute(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?", [schemaName, tableName]
    );
    const availableColumns = new Set(columnRows.map((row) => row.COLUMN_NAME));
    if (columnNames.some((columnName) => !availableColumns.has(columnName))) {
      throw new Error(`Notification schema is incomplete for ${tableName}. Apply deploy/mysql/migrations/2026-10-14-feishu-notifications.sql.`);
    }
  }
  const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  verifyGrants(grantRows, schemaName);
  // Never retrieve or print encrypted webhook credentials during deployment preflight.
  const [configurationRows] = await connection.execute("SELECT enabled FROM workspace_feishu_config WHERE id=?", [1]);
  const enabled = Number(configurationRows[0]?.enabled) === 1;
  if (enabled) verifyEncryptionKey(environment.FEISHU_ENCRYPTION_KEY);
  if (requireWorker) readWorkerConfiguration(environment);
  // workerReady only describes explicit external HTTP worker validation, not scheduler health.
  return { enabled, workerReady: requireWorker };
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  nextEnvironment.loadEnvConfig(process.cwd());
  let connection;
  try {
    connection = await openDatabase();
    const summary = await checkFeishuNotifications(connection, { requireWorker: process.argv.includes("--require-worker") });
    console.log(summary.enabled
      ? "PASS: notification schema and grants are ready; encryption key ready; automatic scheduling starts with production application."
      : "PASS: notification schema and grants are ready; Feishu notifications are not enabled.");
    if (summary.workerReady) console.log("PASS: external HTTP worker configuration validated; scheduling has not been verified.");
  } catch (error) {
    console.error(error?.code ? "Notification database preflight failed. Check migration and application grants." : error.message);
    process.exitCode = 1;
  } finally { if (connection) await connection.end(); }
}
