// Real-browser auth regression. Use an isolated app/MySQL; creates and removes its own accounts.
// TEST_BASE_URL=http://localhost:3002 node scripts/test-auth.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { hashPassword } from "./create-user.mjs";
import { openDatabase, ownerHashFor } from "./_login.mjs";

const base = process.env.TEST_BASE_URL || "http://localhost:3002";
const password = "auth-test-password";
const suffix = randomUUID().slice(0, 8);
const db = await openDatabase();
const browser = await chromium.launch();
const userIds = [];
const ownerHashes = [];

async function addUser(label, displayName, role = "member") {
  const id = randomUUID();
  const username = `${label}.${suffix}`;
  await db.execute("INSERT INTO users (id, username, display_name, password_hash, role) VALUES (?,?,?,?,?)", [
    id, username, displayName, hashPassword(password), role
  ]);
  userIds.push(id);
  ownerHashes.push(ownerHashFor(id));
  return { id, username };
}

const login = (context, username, candidate = password) =>
  context.request.post(`${base}/api/auth/login`, { headers: { Origin: base }, data: { username, password: candidate } });
const update = (context, id, action, newPassword) => context.request.patch(`${base}/api/auth/users`, {
  headers: { Origin: base }, data: { id, action, ...(newPassword ? { password: newPassword } : {}) }
});
async function accountState(id) {
  const [users] = await db.execute("SELECT id, password_hash, role, disabled FROM users WHERE id=?", [id]);
  const [sessions] = await db.execute("SELECT id FROM sessions WHERE user_id=? ORDER BY id", [id]);
  return { users, sessions };
}

try {
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(base);
  await anonymousPage.locator(".login-panel").waitFor({ timeout: 20000 });
  assert.equal(new URL(anonymousPage.url()).pathname, "/login");
  for (const path of ["/api/projects", "/api/social/channels", "/api/auth/users"]) {
    assert.equal((await anonymous.request.get(base + path)).status(), 401, `${path} requires a session`);
  }
  for (const path of ["/api/generate", "/api/analyze", "/api/rewrite", "/api/parse", "/api/fetch-article", "/api/crawl-article", "/api/social/publish", "/api/auth/users"]) {
    assert.equal((await anonymous.request.post(base + path, { headers: { Origin: base }, data: {} })).status(), 401, `${path} requires a session`);
  }
  assert.equal((await anonymous.request.patch(`${base}/api/auth/users`, { headers: { Origin: base }, data: {} })).status(), 401);
  await anonymous.close();

  const alice = await addUser("alice", "Alice Tester", "admin");
  const aliceContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${base}/login`);
  await alicePage.locator('.login-panel input[autocomplete="username"]').fill(alice.username);
  await alicePage.locator('.login-panel input[type="password"]').fill("definitely-not-the-password");
  await alicePage.locator(".login-panel button.primary-button").click();
  await alicePage.locator(".login-error").waitFor({ timeout: 15000 });
  assert.match(await alicePage.locator(".login-error").innerText(), /Incorrect username or password/);
  assert.equal(await alicePage.locator(".app-shell").count(), 0);

  await alicePage.locator('.login-panel input[type="password"]').fill(password);
  await alicePage.locator(".login-panel button.primary-button").click();
  await alicePage.locator(".app-shell").waitFor({ timeout: 30000 });
  await alicePage.locator(".project-storage [role=status]").filter({ hasText: "Ready to save" }).waitFor({ timeout: 30000 });
  assert.equal((await alicePage.locator(".user-row strong").innerText()).trim(), "Alice Tester");
  const ownProjects = await aliceContext.request.get(`${base}/api/projects`);
  assert.equal(ownProjects.status(), 200);
  assert.deepEqual((await ownProjects.json()).projects, []);

  // The administrator panel must work without the old re-fetch loop.
  let memberCalls = 0;
  alicePage.on("request", request => { if (request.url().includes("/api/auth/users")) memberCalls += 1; });
  await alicePage.locator(".sidebar-bottom .nav-item").click();
  await alicePage.locator(".member-create").waitFor({ timeout: 15000 });
  await alicePage.waitForTimeout(3000);
  assert.ok(memberCalls >= 1 && memberCalls <= 5, `expected one members fetch, not a loop (got ${memberCalls})`);
  const carol = `carol.${suffix}`;
  const carolPassword = "carol-test-password";
  await alicePage.locator(".member-create input").nth(0).fill(carol);
  await alicePage.locator(".member-create input").nth(1).fill("Carol Tester");
  await alicePage.locator(".member-create input").nth(2).fill(carolPassword);
  await alicePage.locator(".member-create button").click();
  const carolRow = alicePage.locator(".member-row", { hasText: carol });
  await carolRow.waitFor({ timeout: 15000 });
  const [carolRecord] = await db.execute("SELECT id, role FROM users WHERE username=?", [carol]);
  assert.equal(carolRecord.length, 1);
  assert.equal(carolRecord[0].role, "member", "web-created accounts must default to member");
  userIds.push(carolRecord[0].id);
  ownerHashes.push(ownerHashFor(carolRecord[0].id));
  const carolContext = await browser.newContext();
  const carolSignIn = await login(carolContext, carol, carolPassword);
  assert.equal(carolSignIn.status(), 200);
  assert.equal((await carolSignIn.json()).user.role, "member");
  assert.equal((await carolContext.request.get(`${base}/api/auth/users`)).status(), 403);
  await carolRow.locator(".small-button").nth(1).click();
  await carolRow.locator(".member-status.off").waitFor({ timeout: 15000 });
  assert.equal((await carolContext.request.get(`${base}/api/projects`)).status(), 401);
  await carolContext.close();

  const bob = await addUser("bob", "Bob Tester", "member");
  const legacyToken = randomBytes(32).toString("hex");
  const legacyOwner = createHash("sha256").update(legacyToken).digest("hex");
  const legacyProjectId = randomUUID();
  ownerHashes.push(legacyOwner);
  await db.execute("INSERT INTO projects (id, owner_hash, name, snapshot) VALUES (?,?,?,?)", [
    legacyProjectId, legacyOwner, "Legacy project", JSON.stringify({ config: { name: "Legacy project" }, assets: [], sourceText: "legacy" })
  ]);
  const bobContext = await browser.newContext();
  await bobContext.addCookies([{ name: "polaris-project-owner", value: legacyToken, url: base }]);
  const firstSignIn = await login(bobContext, bob.username);
  assert.equal(firstSignIn.status(), 200);
  const firstBody = await firstSignIn.json();
  assert.equal(firstBody.user.role, "member");
  assert.equal(firstBody.claimed, 1);
  const [moved] = await db.execute("SELECT owner_hash FROM projects WHERE id=?", [legacyProjectId]);
  assert.equal(moved[0].owner_hash, ownerHashFor(bob.id));
  await bobContext.addCookies([{ name: "polaris-project-owner", value: legacyToken, url: base }]);
  assert.equal((await (await login(bobContext, bob.username)).json()).claimed, 0);

  // A member cannot read the list, create an account, mutate the target, or revoke its sessions.
  const before = await accountState(alice.id);
  const forbiddenList = await bobContext.request.get(`${base}/api/auth/users`);
  assert.equal(forbiddenList.status(), 403);
  assert.equal((await forbiddenList.json()).users, undefined);
  const forbiddenUsername = `forbidden.${suffix}`;
  assert.equal((await bobContext.request.post(`${base}/api/auth/users`, {
    headers: { Origin: base }, data: { username: forbiddenUsername, displayName: "Forbidden", password, role: "admin" }
  })).status(), 403);
  const [notCreated] = await db.execute("SELECT id FROM users WHERE username=?", [forbiddenUsername]);
  assert.equal(notCreated.length, 0);
  for (const action of ["disable", "enable", "password"]) {
    assert.equal((await update(bobContext, alice.id, action, "forbidden-password")).status(), 403);
    assert.deepEqual(await accountState(alice.id), before);
    assert.equal((await aliceContext.request.get(`${base}/api/projects`)).status(), 200);
  }
  assert.equal((await update(bobContext, bob.id, "disable")).status(), 403);

  const bobPage = await bobContext.newPage();
  let bobMemberCalls = 0;
  bobPage.on("request", request => { if (request.url().includes("/api/auth/users")) bobMemberCalls += 1; });
  await bobPage.goto(base);
  await bobPage.waitForFunction(() => {
    const status = document.querySelector(".project-storage [role=status]")?.textContent || "";
    return status.length > 0 && !status.includes("Connecting storage");
  }, null, { timeout: 30000 });
  await bobPage.locator(".sidebar-bottom .nav-item").click();
  await bobPage.getByRole("button", { name: "Manage accounts", exact: true }).waitFor();
  assert.equal(await bobPage.locator(".member-create, .member-list").count(), 0);
  await bobPage.getByRole("button", { name: "Manage accounts", exact: true }).click();
  // "Manage accounts" opens the standalone accounts view; a member must land there without any
  // member-management UI and without the members API ever being fetched.
  await bobPage.locator(".social-accounts-view").waitFor();
  assert.equal(bobMemberCalls, 0, "member settings must never fetch the members API");
  assert.equal((await bobContext.request.get(`${base}/api/social/channels`)).status(), 200);

  // Only an administrator can disable, enable, and reset another account's password.
  assert.equal((await update(aliceContext, bob.id, "disable")).status(), 200);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 401);
  assert.equal((await update(aliceContext, bob.id, "enable")).status(), 200);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 401, "enable must not resurrect an old session");
  assert.equal((await login(bobContext, bob.username)).status(), 200);
  const newPassword = "bob-replacement-password";
  assert.equal((await update(aliceContext, bob.id, "password", newPassword)).status(), 200);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 401);
  assert.equal((await login(bobContext, bob.username)).status(), 401);
  assert.equal((await login(bobContext, bob.username, newPassword)).status(), 200);
  assert.equal((await update(aliceContext, alice.id, "disable")).status(), 400);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 200);
  assert.equal((await bobContext.request.post(`${base}/api/auth/logout`, { headers: { Origin: base } })).status(), 200);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 401);

  const throttled = await browser.newContext();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt++) lastStatus = (await login(throttled, `nobody.${suffix}`, "wrong")).status();
  assert.equal(lastStatus, 429);
  await throttled.close();

  // A rejected action must discard an already-loaded administrator panel.
  await alicePage.route("**/api/auth/users", route => route.fulfill({
    status: 403, contentType: "application/json",
    body: JSON.stringify({ error: "Only administrators can manage members.", code: "FORBIDDEN" })
  }));
  await carolRow.locator(".small-button").nth(1).click();
  await alicePage.locator(".member-create").waitFor({ state: "hidden", timeout: 15000 });
  assert.equal(await alicePage.locator(".member-list, .member-actions, .member-create").count(), 0, "Revoked permission must hide member data and all management controls");
  await alicePage.unroute("**/api/auth/users");
  console.log("PASS: login/anonymous/logout/throttle and legacy adoption regressions; admin UI and member default; member API 403 without account/session mutation; member settings retain social connections without fetching members; admin password/disable/enable and self-disable protection.");
} finally {
  await browser.close();
  for (const owner of ownerHashes) await db.execute("DELETE FROM projects WHERE owner_hash=?", [owner]);
  for (const id of userIds) await db.execute("DELETE FROM users WHERE id=?", [id]);
  await db.end();
}
