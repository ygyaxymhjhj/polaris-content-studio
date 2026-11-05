// Ownership-isolation regression: synthetic accounts, fake database, mocked Postiz, no network.
// Covers channel filtering, publish enforcement, connect-return claiming, and admin assignment.
// node scripts/test-social-ownership.mjs
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
function loadModule(path, mocks = {}) {
  const { outputText } = typescript.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true, jsx: typescript.JsxEmit.ReactJSX }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports);
  return compiled.exports;
}

// Capture expected diagnostics from the channel and publish routes without hiding assertions.
const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => { loggedErrors.push(args); };

/**
 * In-memory stand-in for the two ownership tables plus the publish audit, dispatching on the SQL
 * text. It mirrors the MySQL semantics the app relies on: conditional claim upserts report 0 when
 * a row is already owned. Transaction snapshots model ownership/attempt rollback together.
 */
function createFakeDatabase() {
  const state = {
    users: new Map(),
    accounts: new Map(),
    assignments: new Map(),
    attempts: new Map(),
    draftTasks: new Map(),
    publishes: [],
    statements: []
  };
  const assignmentsFor = (integrationId) => state.assignments.get(integrationId) ?? new Set();
  const database = {
    state,
    execute: async (sql, params = []) => {
      state.statements.push({ sql, params });
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("SELECT id FROM users WHERE id=? FOR UPDATE")) {
        return [state.users.has(params[0]) ? [{ id: params[0] }] : []];
      }
      if (text.includes("FROM draft_submissions") && text.includes("request_key=? OR active_key=?")) return [[]];
      if (text.startsWith("INSERT INTO draft_submissions")) {
        const [id, ownerUserId, kind, sourceId, projectId, integrationId, , , , , snapshot, createdAt, updatedAt] = params;
        state.draftTasks.set(id, {
          id, owner_user_id: ownerUserId, kind, source_id: sourceId, project_id: projectId, integration_id: integrationId,
          snapshot: JSON.parse(snapshot), state: "queued", audit_id: null, postiz_post_id: null, warning: null,
          error: null, created_at: createdAt, updated_at: updatedAt, finished_at: null
        });
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("SELECT * FROM draft_submissions WHERE id=?")) {
        const task = state.draftTasks.get(params[0]);
        return [task && task.owner_user_id === params[1] ? [task] : []];
      }
      if (text.startsWith("INSERT INTO social_accounts")) {
        let affectedRows = 0;
        for (let i = 0; i < params.length; i += 3) {
          const [integrationId, provider, accountName] = params.slice(i, i + 3);
          const existing = state.accounts.get(integrationId);
          if (existing) {
            existing.provider = provider;
            existing.account_name = accountName;
            affectedRows += 2;
          } else {
            state.accounts.set(integrationId, {
              integration_id: integrationId, provider, account_name: accountName,
              assigned_by_user_id: null, origin: null
            });
            affectedRows += 1;
          }
        }
        return [{ affectedRows }];
      }
      if (text.startsWith("SELECT") && text.includes("FROM social_accounts a")) {
        let accounts = [...state.accounts.values()];
        if (text.includes("WHERE a.integration_id = ?")) {
          accounts = accounts.filter((account) => account.integration_id === params[0]);
        }
        const rows = [];
        for (const account of accounts) {
          const assignees = [...assignmentsFor(account.integration_id)]
            .map(userId => state.users.get(userId))
            .filter(Boolean)
            .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id));
          for (const assignee of assignees.length ? assignees : [null]) {
            rows.push({
              ...account,
              assigned_user_id: assignee?.id ?? null,
              assigned_user_name: assignee?.displayName ?? null
            });
          }
        }
        return [rows];
      }
      if (text.startsWith("SELECT integration_id FROM social_accounts")) {
        const account = state.accounts.get(params[0]);
        return [account ? [{ integration_id: account.integration_id }] : []];
      }
      if (text.startsWith("SELECT user_id FROM social_account_assignments")) {
        return [[...assignmentsFor(params[0])].map(userId => ({ user_id: userId }))];
      }
      if (text.startsWith("INSERT INTO social_account_assignments")) {
        for (let i = 0; i < params.length; i += 3) {
          const [integrationId, userId] = params.slice(i, i + 3);
          const assigned = assignmentsFor(integrationId);
          assigned.add(userId);
          state.assignments.set(integrationId, assigned);
        }
        return [{ affectedRows: params.length / 3 }];
      }
      if (text.startsWith("DELETE FROM social_account_assignments")) {
        return [{ affectedRows: state.assignments.delete(params[0]) ? 1 : 0 }];
      }
      if (text.startsWith("UPDATE social_accounts SET assigned_by_user_id=?, origin='connect'")) {
        const account = state.accounts.get(params[1]);
        if (!account) return [{ affectedRows: 0 }];
        account.assigned_by_user_id = params[0];
        account.origin = "connect";
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE social_accounts SET assigned_by_user_id=?, origin='admin'")) {
        const account = state.accounts.get(params[1]);
        if (!account) return [{ affectedRows: 0 }];
        account.assigned_by_user_id = params[0];
        account.origin = "admin";
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE social_accounts SET assigned_by_user_id=NULL")) {
        const account = state.accounts.get(params[0]);
        if (!account) return [{ affectedRows: 0 }];
        account.assigned_by_user_id = null;
        account.origin = null;
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("INSERT INTO social_connect_attempts")) {
        const [stateHash, userId, provider, snapshotIds, returnView, expiresAt] = params;
        state.attempts.set(stateHash, {
          state_hash: stateHash, user_id: userId, provider,
          snapshot_ids: snapshotIds, return_view: returnView, expires_at: expiresAt, consumed_at: null
        });
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("DELETE FROM social_connect_attempts")) {
        let removed = 0;
        for (const [key, row] of state.attempts) {
          if (row.expires_at < params[0]) { state.attempts.delete(key); removed += 1; }
        }
        return [{ affectedRows: removed }];
      }
      if (text.startsWith("UPDATE social_connect_attempts SET consumed_at=?")) {
        const [now, stateHash, userId, expiryBoundary] = params;
        const row = state.attempts.get(stateHash);
        if (row && row.user_id === userId && row.consumed_at == null && row.expires_at > expiryBoundary) {
          row.consumed_at = now;
          return [{ affectedRows: 1 }];
        }
        return [{ affectedRows: 0 }];
      }
      if (text.startsWith("SELECT") && text.includes("FROM social_connect_attempts")) {
        const row = state.attempts.get(params[0]);
        return [row ? [{ ...row }] : []];
      }
      if (text.startsWith("INSERT INTO social_publishes")) {
        state.publishes.push({ integrationId: params[4], publishedBy: params[6], status: params[12] });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Fake DB: unsupported statement: ${text}`);
    }
  };
  database.getConnection = async () => {
    let snapshot;
    return {
      execute: (sql, params) => database.execute(sql, params),
      query: async () => [{ affectedRows: 0 }],
      beginTransaction: async () => { snapshot = structuredClone({ accounts: state.accounts, assignments: state.assignments, attempts: state.attempts }); },
      commit: async () => { snapshot = undefined; },
      rollback: async () => {
        if (snapshot) {
          state.accounts = snapshot.accounts;
          state.assignments = snapshot.assignments;
          state.attempts = snapshot.attempts;
          snapshot = undefined;
        }
      },
      release() {}
    };
  };
  return database;
}

try {
  const fake = createFakeDatabase();
  const users = [
    { id: "11111111-1111-4111-8111-111111111111", displayName: "Admin", role: "admin" },
    { id: "22222222-2222-4222-8222-222222222222", displayName: "Ana", role: "member" },
    { id: "33333333-3333-4333-8333-333333333333", displayName: "Ben", role: "member" },
    { id: "44444444-4444-4444-8444-444444444444", displayName: "Disabled", role: "member", disabled: true }
  ];
  const [adminUser, anaUser, benUser, disabledUser] = users;
  for (const user of users) fake.state.users.set(user.id, user);
  fake.state.accounts.set("acct-ana", { integration_id: "acct-ana", provider: "x", account_name: "Ana X", assigned_by_user_id: anaUser.id, origin: "connect" });
  fake.state.accounts.set("acct-ben", { integration_id: "acct-ben", provider: "x", account_name: "Ben X", assigned_by_user_id: adminUser.id, origin: "admin" });
  fake.state.accounts.set("acct-shared", { integration_id: "acct-shared", provider: "x", account_name: "Shared X", assigned_by_user_id: adminUser.id, origin: "admin" });
  fake.state.assignments.set("acct-ana", new Set([anaUser.id]));
  fake.state.assignments.set("acct-ben", new Set([benUser.id]));
  fake.state.assignments.set("acct-shared", new Set([anaUser.id, benUser.id]));

  let currentAuth = null;
  const authMock = {
    currentUser: async () => currentAuth,
    unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 }),
    findUserById: async (id) => {
      const user = fake.state.users.get(id);
      return user ? { ...user, username: user.id, disabled: Boolean(user.disabled), createdAt: "2026-10-08 00:00:00" } : undefined;
    }
  };
  const projectDbModule = { databaseConfigured: () => true, database: () => fake };
  const socialAccountsModule = loadModule("src/lib/social-accounts.ts", { "@/lib/project-db": projectDbModule });
  const sameOriginModule = loadModule("src/lib/same-origin.ts");

  // ---------- 1. Channels list: members see only their own; admins see everything with owners ----------
  const liveAccounts = [
    { id: "acct-old", name: "Distant", identifier: "x", disabled: false },
    { id: "acct-ana", name: "Ana X", identifier: "x", disabled: false },
    { id: "acct-ben", name: "Ben X", identifier: "x", disabled: true },
    { id: "acct-shared", name: "Shared X", identifier: "x", disabled: false }
  ];
  const channelsPostiz = {
    fetchPostizIntegrations: async () => ({ configured: true, accounts: liveAccounts }),
    getPostizUiUrl: () => "https://postiz.example.test",
    isPostizOAuthConfigured: () => true
  };
  const channelsRoute = loadModule("src/app/api/social/channels/route.ts", {
    "@/lib/postiz": channelsPostiz, "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule
  });

  currentAuth = { user: anaUser };
  const anaChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(anaChannels.accounts.map((account) => account.id), ["acct-ana", "acct-shared"], "Members see every channel assigned to them");
  assert.deepEqual(anaChannels.accounts[0].assignedUsers, [{ id: anaUser.id, name: "Ana" }]);
  assert.deepEqual(anaChannels.accounts[1].assignedUsers.map((user) => user.name), ["Ana", "Ben"]);
  assert.equal(fake.state.accounts.get("acct-old").assigned_by_user_id, null, "Unseen Postiz channels are registered as unassigned");

  currentAuth = { user: benUser };
  const benChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(benChannels.accounts.map((account) => account.id), ["acct-ben", "acct-shared"], "A shared channel is visible to both assignees");

  currentAuth = { user: adminUser };
  const adminChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(adminChannels.accounts.map((account) => account.id).sort(), ["acct-ana", "acct-ben", "acct-old", "acct-shared"], "Admins see every channel");
  assert.deepEqual(adminChannels.accounts.find((account) => account.id === "acct-old").assignedUsers, []);
  assert.deepEqual(adminChannels.accounts.find((account) => account.id === "acct-ben").assignedUsers, [{ id: benUser.id, name: "Ben" }]);

  channelsPostiz.fetchPostizIntegrations = async () => ({ configured: true, accounts: [], error: "Postiz API error (500): upstream" });
  currentAuth = { user: anaUser };
  const errorChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(errorChannels.accounts, [], "A Postiz error must not leak registry rows");
  assert.match(errorChannels.error, /Postiz API error/);
  channelsPostiz.fetchPostizIntegrations = async () => ({ configured: true, accounts: liveAccounts });

  // An ownership-store failure fails closed silently: no channels and no raw error text to the client.
  const originalExecute = fake.execute;
  fake.execute = async () => { throw new Error("ER_NO_SUCH_TABLE: social_accounts"); };
  currentAuth = { user: anaUser };
  const brokenChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(brokenChannels.accounts, [], "An ownership failure returns no channels");
  assert.equal(brokenChannels.error, undefined, "Ownership failures must not surface raw errors to clients");
  fake.execute = originalExecute;

  // Ownership is enforced by the real enqueue function before a durable task is inserted.
  const wakeups = [];
  const draftQueue = loadModule("src/lib/draft-submissions.ts", {
    "@/lib/project-db": projectDbModule, "@/lib/auth": authMock,
    "@/lib/social-accounts": socialAccountsModule, "@/lib/post-submission": {},
    "@/lib/posts": { databaseEpoch: value => Date.parse(`${value.replace(" ", "T")}Z`) },
    "@/lib/postiz": {}, "@/lib/social-notifications": {},
    "@/lib/post-types": loadModule("src/lib/post-types.ts"),
    "@/lib/image-types": loadModule("src/lib/image-types.ts"),
    "./image-types": loadModule("src/lib/image-types.ts"),
    "@/lib/image-uploads": { getImageUploads: async () => [] },
    "@/lib/video-uploads": { getVideoUpload: async () => { throw new Error("Legacy image tasks must not query video uploads"); } }
  });
  const publishRoute = loadModule("src/app/api/social/publish/route.ts", {
    "next/server": { NextResponse, after: callback => wakeups.push(callback) },
    "@/lib/auth": authMock, "@/lib/project-db": projectDbModule, "@/lib/same-origin": sameOriginModule,
    "@/lib/request-body": loadModule("src/lib/request-body.ts"),
    "@/lib/image-upload": loadModule("src/lib/image-upload.ts"),
    "@/lib/image-types": loadModule("src/lib/image-types.ts"),
    "./image-types": loadModule("src/lib/image-types.ts"),
    "@/lib/draft-submissions": draftQueue, "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: async () => {} }
  });
  const publishRequest = (integrationId) => new NextRequest("https://studio.example.test/api/social/publish", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://studio.example.test" },
    body: JSON.stringify({ assetId: "asset_1", integrationId, content: "hello world", platform: "x", accountName: "X", requestId: randomUUID() })
  });

  currentAuth = { user: anaUser };
  for (const blockedId of ["acct-ben", "acct-old", "acct-unknown"]) {
    const response = await publishRoute.POST(publishRequest(blockedId));
    assert.equal(response.status, 403, `Member publishing to ${blockedId} must be refused`);
  }
  assert.equal(fake.state.draftTasks.size, 0, "Refused submissions never create durable work");
  assert.equal(fake.state.publishes.length, 0, "Refused publishes must never write an audit row");
  assert.equal(wakeups.length, 0, "Refused submissions must not wake external work");

  const ownPublish = await publishRoute.POST(publishRequest("acct-ana"));
  assert.equal(ownPublish.status, 202);
  assert.equal((await ownPublish.json()).accepted, true);
  const [ownedTask] = fake.state.draftTasks.values();
  assert.equal(ownedTask.owner_user_id, anaUser.id);
  assert.equal(ownedTask.state, "queued");
  assert.equal(ownedTask.snapshot.accountName, "Ana X", "Registry identity overrides the client account label");
  assert.equal(fake.state.publishes.length, 0, "Acceptance alone never invents a successful audit");
  assert.equal(wakeups.length, 1);

  const sharedPublish = await publishRoute.POST(publishRequest("acct-shared"));
  assert.equal(sharedPublish.status, 202, "Any assignee may publish to a shared channel");
  currentAuth = { user: benUser };
  assert.equal((await publishRoute.POST(publishRequest("acct-shared"))).status, 202, "Sharing grants equal publish access");
  assert.equal(fake.state.draftTasks.size, 3);

  currentAuth = { user: adminUser };
  assert.equal((await publishRoute.POST(publishRequest("acct-old"))).status, 202, "Admins may submit to unassigned channels");
  assert.equal(fake.state.draftTasks.size, 4);
  assert.equal(wakeups.length, 4);

  // ---------- 3. Connect return: claim only channels that appeared after the snapshot ----------
  let capturedRedirect = "";
  let connectLive = [];
  const connectPostiz = {
    createPostizAuthorizationUrl: async (provider, redirectUrl) => {
      capturedRedirect = redirectUrl;
      return "https://twitter.com/i/oauth2/authorize?state=synthetic";
    },
    fetchPostizIntegrations: async () => ({ configured: true, accounts: connectLive }),
    PostizConnectionError: class PostizConnectionError extends Error {
      constructor(message, status = 502) { super(message); this.status = status; }
    }
  };
  const connectRoute = loadModule("src/app/api/social/connect/route.ts", {
    "@/lib/postiz": connectPostiz, "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule, "@/lib/same-origin": sameOriginModule
  });
  const startConnect = async (provider = "x") => {
    currentAuth = { user: anaUser };
    const response = await connectRoute.POST(new NextRequest("https://studio.example.test/api/social/connect", {
      method: "POST", headers: { Origin: "https://studio.example.test", "Content-Type": "application/json" },
      body: JSON.stringify({ provider })
    }));
    assert.equal(response.status, 200);
    return response.cookies.get("polaris-postiz-connect").value;
  };
  const returnFromConnect = async (url, cookieValue) => connectRoute.GET(new NextRequest(url, {
    headers: { Cookie: `polaris-postiz-connect=${cookieValue}` }
  }));
  const connectionOutcome = async (response) =>
    new URL(response.headers.get("location"), "https://studio.example.test").searchParams.get("connection");

  connectLive = [...liveAccounts];
  const claimCookie = await startConnect();
  connectLive = [...liveAccounts, { id: "acct-new", name: "New X", identifier: "x", disabled: false }];
  const claimResponse = await returnFromConnect(capturedRedirect, claimCookie);
  assert.equal(await connectionOutcome(claimResponse), "returned");
  assert.deepEqual([...(fake.state.assignments.get("acct-new") ?? [])], [anaUser.id], "A channel created after the snapshot is assigned to the initiator");
  assert.equal(fake.state.accounts.get("acct-new").origin, "connect");
  assert.equal((fake.state.assignments.get("acct-old") ?? new Set()).size, 0, "Pre-existing channels stay untouched");
  assert.ok(fake.state.attempts.get(claimCookie).consumed_at, "The attempt is consumed exactly once");

  connectLive = [...connectLive, { id: "acct-replay", name: "Replay X", identifier: "x", disabled: false }];
  assert.equal(await connectionOutcome(await returnFromConnect(capturedRedirect, claimCookie)), "invalid", "Consumed attempts cannot report success on replay");
  assert.equal((fake.state.assignments.get("acct-replay") ?? new Set()).size, 0, "A replayed return must not claim again");

  const providerCookie = await startConnect("x");
  connectLive = [...connectLive, { id: "acct-fb", name: "FB Page", identifier: "facebook", disabled: false }];
  assert.equal(await connectionOutcome(await returnFromConnect(capturedRedirect, providerCookie)), "unconfirmed");
  assert.equal(fake.state.attempts.get(providerCookie).consumed_at, null);
  assert.equal((fake.state.assignments.get("acct-fb") ?? new Set()).size, 0, "Channels of another provider are not claimed");

  const ownedCookie = await startConnect("x");
  fake.state.accounts.set("acct-owned", { integration_id: "acct-owned", provider: "x", account_name: "Owned", assigned_by_user_id: adminUser.id, origin: "admin" });
  fake.state.assignments.set("acct-owned", new Set([benUser.id]));
  connectLive = [...connectLive, { id: "acct-owned", name: "Owned", identifier: "x", disabled: false }];
  assert.equal(await connectionOutcome(await returnFromConnect(capturedRedirect, ownedCookie)), "conflict");
  assert.deepEqual([...(fake.state.assignments.get("acct-owned") ?? [])], [benUser.id], "An already-assigned channel is never extended by re-authorisation");

  const sharedCookie = await startConnect("x");
  fake.state.accounts.set("acct-already-shared", { integration_id: "acct-already-shared", provider: "x", account_name: "Already Shared", assigned_by_user_id: adminUser.id, origin: "admin" });
  fake.state.assignments.set("acct-already-shared", new Set([anaUser.id, benUser.id]));
  connectLive = [...connectLive, { id: "acct-already-shared", name: "Already Shared", identifier: "x", disabled: false }];
  assert.equal(await connectionOutcome(await returnFromConnect(capturedRedirect, sharedCookie)), "returned", "An existing assignee re-authorising is idempotent");
  assert.deepEqual([...(fake.state.assignments.get("acct-already-shared") ?? [])].sort(), [anaUser.id, benUser.id].sort(), "Re-authorisation never changes the set");

  connectPostiz.fetchPostizIntegrations = async () => { throw new Error("Postiz unreachable"); };
  const previousRedirect = capturedRedirect;
  const snapshotFailure = await connectRoute.POST(new NextRequest("https://studio.example.test/api/social/connect", {
    method: "POST", headers: { Origin: "https://studio.example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "x" })
  }));
  assert.equal(snapshotFailure.status, 502);
  assert.equal(snapshotFailure.cookies.get("polaris-postiz-connect"), undefined);
  assert.equal(capturedRedirect, previousRedirect, "A failed snapshot must not issue an authorization URL");
  connectPostiz.fetchPostizIntegrations = async () => ({ configured: true, accounts: connectLive });

  const expiredCookie = await startConnect("x");
  fake.state.attempts.get(expiredCookie).expires_at = "2020-01-01 00:00:00";
  connectLive = [...connectLive, { id: "acct-expired", name: "Expired", identifier: "x", disabled: false }];
  const expiredResponse = await returnFromConnect(capturedRedirect, expiredCookie);
  assert.equal(await connectionOutcome(expiredResponse), "invalid");
  assert.equal((fake.state.assignments.get("acct-expired") ?? new Set()).size, 0, "An expired attempt claims nothing");

  const pollutedCookie = await startConnect("x");
  connectLive = [...connectLive, { id: "acct-polluted", name: "Polluted", identifier: "x", disabled: false }];
  const pollutedResponse = await returnFromConnect(`${capturedRedirect}?added=x&msg=Channel+Updated`, pollutedCookie);
  assert.equal(await connectionOutcome(pollutedResponse), "returned", "Postiz-appended params must not break the return");
  assert.deepEqual([...(fake.state.assignments.get("acct-polluted") ?? [])], [anaUser.id], "Claiming still works with appended params");

  const forgedResponse = await returnFromConnect(`${capturedRedirect}?added=x`, "f".repeat(64));
  assert.equal(await connectionOutcome(forgedResponse), "invalid");

  // ---------- 4. Assignment API: admins only, validated targets ----------
  const assignRoute = loadModule("src/app/api/social/accounts/[integrationId]/route.ts", {
    "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule, "@/lib/same-origin": sameOriginModule
  });
  const assignRequest = (integrationId, body, origin = "https://studio.example.test") => new NextRequest(`https://studio.example.test/api/social/accounts/${integrationId}`, {
    method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const context = (integrationId) => ({ params: Promise.resolve({ integrationId }) });

  currentAuth = { user: anaUser };
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [anaUser.id] }), context("acct-old"))).status, 403);
  assert.equal((fake.state.assignments.get("acct-old") ?? new Set()).size, 0, "Members cannot assign channels");

  currentAuth = { user: adminUser };
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [anaUser.id] }, "https://untrusted.example.test"), context("acct-old"))).status, 403);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: ["not-a-uuid"] }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [anaUser.id], extra: 1 }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: ["99999999-9999-4999-8999-999999999999"] }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [disabledUser.id] }), context("acct-old"))).status, 400, "A disabled member cannot be newly assigned");
  assert.equal((await assignRoute.PATCH(assignRequest("acct-missing", { userIds: [anaUser.id] }), context("acct-missing"))).status, 404);

  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [anaUser.id, benUser.id] }), context("acct-old"))).status, 200);
  assert.deepEqual([...(fake.state.assignments.get("acct-old") ?? [])].sort(), [anaUser.id, benUser.id].sort(), "The API replaces the complete assignment set");
  assert.equal(fake.state.accounts.get("acct-old").origin, "admin");
  assert.equal(fake.state.accounts.get("acct-old").assigned_by_user_id, adminUser.id);

  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [benUser.id] }), context("acct-old"))).status, 200);
  assert.deepEqual([...(fake.state.assignments.get("acct-old") ?? [])], [benUser.id], "Removing one member keeps the others");

  fake.state.assignments.get("acct-old").add(disabledUser.id);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [benUser.id, disabledUser.id] }), context("acct-old"))).status, 200, "An existing disabled assignee stays editable");

  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { userIds: [] }), context("acct-old"))).status, 200);
  assert.deepEqual([...(fake.state.assignments.get("acct-old") ?? [])], [], "Unassigning returns the channel to the admin-only pool");
  assert.equal(fake.state.accounts.get("acct-old").origin, null);

  originalConsoleError(`(expected route diagnostics captured: ${loggedErrors.length})`);
  console.log("PASS: assignment-based channel filtering for members and admins; shared accounts usable by every assignee; publish refused for non-assignees and unassigned channels; claims limited to new, provider-matching, unassigned channels with single-use attempts and no re-auth widening; assignment API admin-only with replace-set validation.");
} finally {
  console.error = originalConsoleError;
}
