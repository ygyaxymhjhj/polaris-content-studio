// Shared sign-in for the browser regression scripts.
// The app has no anonymous mode any more, so every UI test needs an account. This creates a
// throwaway one for the run and hands back a cleanup function.
import { createHash, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { hashPassword } from "./create-user.mjs";

export const ownerHashFor = (userId) => createHash("sha256").update(`polaris-user:${userId}`).digest("hex");

export async function openDatabase() {
  try { process.loadEnvFile(".env.local"); } catch { /* Environment may already be set. */ }
  return mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });
}

export async function signIn(page, base, { displayName = "UI Test", password = "ui-test-password", language = "en" } = {}) {
  const db = await openDatabase();
  const userId = randomUUID();
  const username = `uitest.${randomUUID().slice(0, 8)}`;
  await db.execute("INSERT INTO users (id, username, display_name, password_hash) VALUES (?,?,?,?)", [
    userId, username, displayName, hashPassword(password)
  ]);

  try {
    await page.goto(`${base}/login`);
    await page.locator(".login-panel .locale-switcher select").selectOption(language);
    await page.locator('.login-panel input[autocomplete="username"]').fill(username);
    await page.locator('.login-panel input[type="password"]').fill(password);
    await page.locator(".login-panel button.primary-button").click();
    await page.locator(".app-shell").waitFor({ timeout: 30000 });
    // .app-shell is server-rendered, so it appears before React hydrates and clicks are dropped.
    // The storage status only settles once the client effect has run, whatever it settles on.
    await page.waitForFunction(() => {
      const status = document.querySelector(".project-storage [role=status]")?.textContent || "";
      return status.length > 0 && !status.includes("Connecting storage");
    }, null, { timeout: 30000 });
  } catch (error) {
    await db.execute("DELETE FROM users WHERE id=?", [userId]);
    await db.end();
    throw error;
  }

  return {
    username,
    userId,
    ownerHash: ownerHashFor(userId),
    cleanup: async () => {
      try {
        // Projects are keyed by owner_hash, not by a foreign key, so they need removing explicitly.
        await db.execute("DELETE FROM projects WHERE owner_hash=?", [ownerHashFor(userId)]);
        await db.execute("DELETE FROM users WHERE id=?", [userId]);
      } finally { await db.end(); }
    }
  };
}
