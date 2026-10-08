// Regression test for the internal sign-in system. Needs a running app and a real MySQL
// (see docs/mysql-storage.md); it creates and removes its own accounts.
//
//   TEST_BASE_URL=http://localhost:3002 node scripts/test-auth.mjs
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

async function addUser(label, displayName) {
  const id = randomUUID();
  const username = `${label}.${suffix}`;
  await db.execute("INSERT INTO users (id, username, display_name, password_hash) VALUES (?,?,?,?)", [
    id, username, displayName, hashPassword(password)
  ]);
  userIds.push(id);
  ownerHashes.push(ownerHashFor(id));
  return { id, username };
}

const login = (context, username, candidate = password) =>
  context.request.post(`${base}/api/auth/login`, { headers: { Origin: base }, data: { username, password: candidate } });

try {
  // 1. Nothing is reachable without a session.
  const anonymous = await browser.newContext();
  const anonymousPage = await anonymous.newPage();
  await anonymousPage.goto(base);
  await anonymousPage.locator(".login-panel").waitFor({ timeout: 20000 });
  assert.equal(new URL(anonymousPage.url()).pathname, "/login", "an anonymous visit must land on the sign-in page");
  for (const path of ["/api/projects", "/api/social/channels"]) {
    assert.equal((await anonymous.request.get(base + path)).status(), 401, `${path} must require a session`);
  }
  for (const path of ["/api/generate", "/api/analyze", "/api/rewrite", "/api/parse", "/api/fetch-article", "/api/crawl-article", "/api/social/publish"]) {
    assert.equal((await anonymous.request.post(base + path, { data: {} })).status(), 401, `${path} must require a session`);
  }
  await anonymous.close();

  // 2. A wrong password is refused and does not open the workspace.
  const alice = await addUser("alice", "Alice Tester");
  const aliceContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  await alicePage.goto(`${base}/login`);
  await alicePage.locator('.login-panel input[autocomplete="username"]').fill(alice.username);
  await alicePage.locator('.login-panel input[type="password"]').fill("definitely-not-the-password");
  await alicePage.locator(".login-panel button.primary-button").click();
  await alicePage.locator(".login-error").waitFor({ timeout: 15000 });
  assert.match(await alicePage.locator(".login-error").innerText(), /Incorrect username or password/);
  assert.equal(await alicePage.locator(".app-shell").count(), 0, "a failed sign-in must not open the workspace");

  // 3. The right password opens it, and the signed-in identity is shown.
  await alicePage.locator('.login-panel input[type="password"]').fill(password);
  await alicePage.locator(".login-panel button.primary-button").click();
  await alicePage.locator(".app-shell").waitFor({ timeout: 30000 });
  // Wait for hydration: .app-shell is server-rendered, so clicks before this are dropped.
  await alicePage.locator(".project-storage [role=status]").filter({ hasText: "Ready to save" }).waitFor({ timeout: 30000 });
  assert.equal((await alicePage.locator(".user-row strong").innerText()).trim(), "Alice Tester");
  const ownProjects = await aliceContext.request.get(`${base}/api/projects`);
  assert.equal(ownProjects.status(), 200);
  assert.deepEqual((await ownProjects.json()).projects, [], "a new account starts with no projects");

  // 4. The Settings page manages members end to end.
  // Count requests while the panel sits idle: a re-render loop still lets the assertions below
  // pass, but it hammers the server and makes the form unusable to a real person.
  let memberCalls = 0;
  alicePage.on("request", (request) => { if (request.url().includes("/api/auth/users")) memberCalls += 1; });
  await alicePage.locator(".sidebar-bottom .nav-item").click();
  await alicePage.locator(".settings-card-wide").waitFor({ timeout: 15000 });
  await alicePage.waitForTimeout(3000);
  assert.ok(memberCalls <= 5, `the members panel must not re-fetch in a loop (saw ${memberCalls} calls in 3s)`);
  const carol = `carol.${suffix}`;
  const carolPassword = "carol-test-password";
  await alicePage.locator(".member-create input").nth(0).fill(carol);
  await alicePage.locator(".member-create input").nth(1).fill("Carol Tester");
  await alicePage.locator(".member-create input").nth(2).fill(carolPassword);
  await alicePage.locator(".member-create button").click();
  const carolRow = alicePage.locator(".member-row", { hasText: carol });
  await carolRow.waitFor({ timeout: 15000 });

  const [carolRecord] = await db.execute("SELECT id FROM users WHERE username=?", [carol]);
  assert.equal(carolRecord.length, 1, "the member created in the UI must exist in the database");
  userIds.push(carolRecord[0].id);
  ownerHashes.push(ownerHashFor(carolRecord[0].id));

  const carolContext = await browser.newContext();
  assert.equal((await login(carolContext, carol, carolPassword)).status(), 200, "the new member must be able to sign in");

  // Disabling from the same page must end that member's session.
  await carolRow.locator(".small-button").nth(1).click();
  await carolRow.locator(".member-status.off").waitFor({ timeout: 15000 });
  assert.equal((await carolContext.request.get(`${base}/api/projects`)).status(), 401, "disabling from the UI must end the member's session");
  await carolContext.close();

  // 5. Projects saved by this browser before accounts existed are adopted once.
  const bob = await addUser("bob", "Bob Tester");
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
  assert.equal((await firstSignIn.json()).claimed, 1, "the first sign-in must adopt this browser's anonymous projects");
  const [moved] = await db.execute("SELECT owner_hash FROM projects WHERE id=?", [legacyProjectId]);
  assert.equal(moved[0].owner_hash, ownerHashFor(bob.id), "the project must now belong to the account");

  // Signing in again with the same anonymous cookie must not adopt a second time.
  await bobContext.addCookies([{ name: "polaris-project-owner", value: legacyToken, url: base }]);
  const secondSignIn = await login(bobContext, bob.username);
  assert.equal((await secondSignIn.json()).claimed, 0, "an account that already owns projects must not adopt again");

  // 6. Disabling an account ends its live session.
  const disabled = await bobContext.request.patch(`${base}/api/auth/users`, { headers: { Origin: base }, data: { id: alice.id, action: "disable" } });
  assert.equal(disabled.status(), 200);
  assert.equal((await aliceContext.request.get(`${base}/api/projects`)).status(), 401, "a disabled account's session must stop working");

  // 7. Nobody can lock themselves out.
  const selfDisable = await bobContext.request.patch(`${base}/api/auth/users`, { headers: { Origin: base }, data: { id: bob.id, action: "disable" } });
  assert.equal(selfDisable.status(), 400);

  // 8. Signing out kills the token server-side, not just in the browser.
  assert.equal((await bobContext.request.post(`${base}/api/auth/logout`, { headers: { Origin: base } })).status(), 200);
  assert.equal((await bobContext.request.get(`${base}/api/projects`)).status(), 401, "the token must be dead after signing out");

  // 9. Repeated failures are throttled.
  const throttled = await browser.newContext();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastStatus = (await login(throttled, `nobody.${suffix}`, "wrong")).status();
  }
  assert.equal(lastStatus, 429, "the sixth failure inside the window must be throttled");
  await throttled.close();

  console.log("PASS: anonymous access refused on page and every API route; wrong password rejected; sign-in shows the account; pre-account projects adopted once only; disabling ends live sessions; self-disable refused; sign-out invalidates the token; failures throttled.");
} finally {
  await browser.close();
  for (const owner of ownerHashes) await db.execute("DELETE FROM projects WHERE owner_hash=?", [owner]);
  for (const id of userIds) await db.execute("DELETE FROM users WHERE id=?", [id]);
  await db.end();
}
