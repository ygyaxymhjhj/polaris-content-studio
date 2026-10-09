// Ownership-isolation regression: synthetic accounts, fake database, mocked Postiz, no network.
// Covers channel filtering, publish enforcement, connect-return claiming, and admin assignment.
// node scripts/test-social-ownership.mjs
import assert from "node:assert/strict";
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

// The routes log expected best-effort failures (snapshot, claim) through console.error; keep the
// regression output readable while still failing loudly on assertion errors.
const originalConsoleError = console.error;
const loggedErrors = [];
console.error = (...args) => { loggedErrors.push(args); };

/**
 * In-memory stand-in for the two ownership tables plus the publish audit, dispatching on the SQL
 * text. It mirrors the MySQL semantics the app relies on: conditional claim upserts report 0 when
 * a row is already owned, and consume is a single atomic conditional update.
 */
function createFakeDatabase() {
  const state = {
    users: new Map(),
    accounts: new Map(),
    attempts: new Map(),
    publishes: [],
    statements: []
  };
  const database = {
    state,
    execute: async (sql, params = []) => {
      state.statements.push({ sql, params });
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("INSERT INTO social_accounts") && text.includes("'connect'")) {
        const [integrationId, provider, accountName, ownerUserId, assignedBy] = params;
        const existing = state.accounts.get(integrationId);
        if (!existing) {
          state.accounts.set(integrationId, {
            integration_id: integrationId, provider, account_name: accountName,
            owner_user_id: ownerUserId, assigned_by_user_id: assignedBy, origin: "connect"
          });
          return [{ affectedRows: 1 }];
        }
        if (existing.owner_user_id == null) {
          existing.owner_user_id = ownerUserId;
          existing.assigned_by_user_id = assignedBy;
          existing.origin = "connect";
          return [{ affectedRows: 2 }];
        }
        return [{ affectedRows: 0 }];
      }
      if (text.startsWith("INSERT INTO social_accounts")) {
        for (let i = 0; i < params.length; i += 3) {
          const [integrationId, provider, accountName] = params.slice(i, i + 3);
          const existing = state.accounts.get(integrationId);
          if (existing) {
            existing.provider = provider;
            existing.account_name = accountName;
          } else {
            state.accounts.set(integrationId, {
              integration_id: integrationId, provider, account_name: accountName,
              owner_user_id: null, assigned_by_user_id: null, origin: null
            });
          }
        }
        return [{ affectedRows: params.length / 3 }];
      }
      if (text.startsWith("SELECT") && text.includes("FROM social_accounts a")) {
        let rows = [...state.accounts.values()].map((row) => ({
          ...row,
          owner_name: row.owner_user_id ? state.users.get(row.owner_user_id)?.displayName ?? null : null
        }));
        if (text.includes("WHERE a.integration_id = ?")) {
          rows = rows.filter((row) => row.integration_id === params[0]);
        }
        return [rows];
      }
      if (text.startsWith("INSERT INTO social_connect_attempts")) {
        const [stateHash, userId, provider, snapshotIds, expiresAt] = params;
        state.attempts.set(stateHash, {
          state_hash: stateHash, user_id: userId, provider,
          snapshot_ids: snapshotIds, expires_at: expiresAt, consumed_at: null
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
      if (text.startsWith("SELECT provider, snapshot_ids FROM social_connect_attempts")) {
        const row = state.attempts.get(params[0]);
        return [row ? [{ provider: row.provider, snapshot_ids: row.snapshot_ids }] : []];
      }
      if (text.startsWith("UPDATE social_accounts SET owner_user_id=?")) {
        const row = state.accounts.get(params[2]);
        if (!row) return [{ affectedRows: 0 }];
        row.owner_user_id = params[0];
        row.assigned_by_user_id = params[1];
        row.origin = "admin";
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("UPDATE social_accounts SET owner_user_id=NULL")) {
        const row = state.accounts.get(params[0]);
        if (!row) return [{ affectedRows: 0 }];
        row.owner_user_id = null;
        row.assigned_by_user_id = null;
        row.origin = null;
        return [{ affectedRows: 1 }];
      }
      if (text.startsWith("INSERT INTO social_publishes")) {
        state.publishes.push({ integrationId: params[4], publishedBy: params[6], status: params[12] });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Fake DB: unsupported statement: ${text}`);
    }
  };
  return database;
}

try {
  const fake = createFakeDatabase();
  const users = [
    { id: "11111111-1111-4111-8111-111111111111", displayName: "Admin", role: "admin" },
    { id: "22222222-2222-4222-8222-222222222222", displayName: "Ana", role: "member" },
    { id: "33333333-3333-4333-8333-333333333333", displayName: "Ben", role: "member" }
  ];
  const [adminUser, anaUser, benUser] = users;
  for (const user of users) fake.state.users.set(user.id, user);
  fake.state.accounts.set("acct-ana", { integration_id: "acct-ana", provider: "x", account_name: "Ana X", owner_user_id: anaUser.id, assigned_by_user_id: anaUser.id, origin: "connect" });
  fake.state.accounts.set("acct-ben", { integration_id: "acct-ben", provider: "x", account_name: "Ben X", owner_user_id: benUser.id, assigned_by_user_id: adminUser.id, origin: "admin" });

  let currentAuth = null;
  const authMock = {
    currentUser: async () => currentAuth,
    unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 }),
    findUserById: async (id) => {
      const user = fake.state.users.get(id);
      return user ? { ...user, username: user.id, disabled: false, createdAt: "2026-10-08 00:00:00" } : undefined;
    }
  };
  const projectDbModule = { databaseConfigured: () => true, database: () => fake };
  const socialAccountsModule = loadModule("src/lib/social-accounts.ts", { "@/lib/project-db": projectDbModule });

  // ---------- 1. Channels list: members see only their own; admins see everything with owners ----------
  const liveAccounts = [
    { id: "acct-old", name: "Distant", identifier: "x", disabled: false },
    { id: "acct-ana", name: "Ana X", identifier: "x", disabled: false },
    { id: "acct-ben", name: "Ben X", identifier: "x", disabled: true }
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
  assert.deepEqual(anaChannels.accounts.map((account) => account.id), ["acct-ana"], "Members only see their own channels");
  assert.equal(anaChannels.accounts[0].ownerUserId, anaUser.id);
  assert.equal(anaChannels.accounts[0].ownerName, "Ana");
  assert.equal(fake.state.accounts.get("acct-old").owner_user_id, null, "Unseen Postiz channels are registered as unassigned");

  currentAuth = { user: adminUser };
  const adminChannels = await (await channelsRoute.GET()).json();
  assert.deepEqual(adminChannels.accounts.map((account) => account.id).sort(), ["acct-ana", "acct-ben", "acct-old"], "Admins see every channel");
  assert.equal(adminChannels.accounts.find((account) => account.id === "acct-old").ownerUserId, null);
  assert.equal(adminChannels.accounts.find((account) => account.id === "acct-ben").ownerName, "Ben");

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

  // ---------- 2. Publish: ownership is enforced server-side, before Postiz is ever called ----------
  const publishCalls = [];
  const publishPostiz = {
    publishToPostiz: async (request) => {
      publishCalls.push(request);
      return { success: true, postId: "post-1", url: "https://x.example/p1" };
    }
  };
  const publishRoute = loadModule("src/app/api/social/publish/route.ts", {
    "@/lib/postiz": publishPostiz, "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule, "@/lib/project-db": projectDbModule
  });
  const publishRequest = (integrationId) => new Request("https://studio.example.test/api/social/publish", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assetId: "asset_1", integrationId, content: "hello world", platform: "x", accountName: "X" })
  });

  currentAuth = { user: anaUser };
  for (const blockedId of ["acct-ben", "acct-old", "acct-unknown"]) {
    const response = await publishRoute.POST(publishRequest(blockedId));
    assert.equal(response.status, 403, `Member publishing to ${blockedId} must be refused`);
  }
  assert.equal(publishCalls.length, 0, "Refused publishes must never reach Postiz");
  assert.equal(fake.state.publishes.length, 0, "Refused publishes must never write an audit row");

  const ownPublish = await publishRoute.POST(publishRequest("acct-ana"));
  assert.equal(ownPublish.status, 200);
  assert.equal((await ownPublish.json()).success, true);
  assert.equal(publishCalls.length, 1);
  assert.equal(fake.state.publishes.length, 1);
  assert.equal(fake.state.publishes[0].publishedBy, anaUser.id);

  currentAuth = { user: adminUser };
  assert.equal((await publishRoute.POST(publishRequest("acct-old"))).status, 200, "Admins may publish to unassigned channels");
  assert.equal(publishCalls.length, 2);

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
    "@/lib/postiz": connectPostiz, "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule
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
    new URL(response.headers.get("location")).searchParams.get("connection");

  connectLive = [...liveAccounts];
  const claimCookie = await startConnect();
  connectLive = [...liveAccounts, { id: "acct-new", name: "New X", identifier: "x", disabled: false }];
  const claimResponse = await returnFromConnect(capturedRedirect, claimCookie);
  assert.equal(await connectionOutcome(claimResponse), "returned");
  assert.equal(fake.state.accounts.get("acct-new").owner_user_id, anaUser.id, "A channel created after the snapshot is claimed for the initiator");
  assert.equal(fake.state.accounts.get("acct-new").origin, "connect");
  assert.equal(fake.state.accounts.get("acct-old").owner_user_id, null, "Pre-existing channels stay untouched");
  assert.ok(fake.state.attempts.get(claimCookie).consumed_at, "The attempt is consumed exactly once");

  connectLive = [...connectLive, { id: "acct-replay", name: "Replay X", identifier: "x", disabled: false }];
  await returnFromConnect(capturedRedirect, claimCookie);
  const replayRow = fake.state.accounts.get("acct-replay");
  assert.ok(!replayRow || replayRow.owner_user_id === null, "A replayed return must not claim again");

  const providerCookie = await startConnect("x");
  connectLive = [...connectLive, { id: "acct-fb", name: "FB Page", identifier: "facebook", disabled: false }];
  await returnFromConnect(capturedRedirect, providerCookie);
  const fbRow = fake.state.accounts.get("acct-fb");
  assert.ok(!fbRow || fbRow.owner_user_id === null, "Channels of another provider are not claimed");

  const ownedCookie = await startConnect("x");
  fake.state.accounts.set("acct-owned", { integration_id: "acct-owned", provider: "x", account_name: "Owned", owner_user_id: benUser.id, assigned_by_user_id: adminUser.id, origin: "admin" });
  connectLive = [...connectLive, { id: "acct-owned", name: "Owned", identifier: "x", disabled: false }];
  await returnFromConnect(capturedRedirect, ownedCookie);
  assert.equal(fake.state.accounts.get("acct-owned").owner_user_id, benUser.id, "An already-owned channel is never overwritten");

  connectPostiz.fetchPostizIntegrations = async () => { throw new Error("Postiz unreachable"); };
  const noSnapshotCookie = await startConnect("x");
  assert.equal(fake.state.attempts.get(noSnapshotCookie).snapshot_ids, null, "A failed snapshot is recorded as null");
  connectPostiz.fetchPostizIntegrations = async () => ({ configured: true, accounts: connectLive });
  connectLive = [...connectLive, { id: "acct-nosnap", name: "No Snapshot", identifier: "x", disabled: false }];
  await returnFromConnect(capturedRedirect, noSnapshotCookie);
  const noSnapshotRow = fake.state.accounts.get("acct-nosnap");
  assert.ok(!noSnapshotRow || noSnapshotRow.owner_user_id === null, "Without a snapshot nothing is claimed");

  const expiredCookie = await startConnect("x");
  fake.state.attempts.get(expiredCookie).expires_at = "2020-01-01 00:00:00";
  connectLive = [...connectLive, { id: "acct-expired", name: "Expired", identifier: "x", disabled: false }];
  const expiredResponse = await returnFromConnect(capturedRedirect, expiredCookie);
  assert.equal(await connectionOutcome(expiredResponse), "returned");
  const expiredRow = fake.state.accounts.get("acct-expired");
  assert.ok(!expiredRow || expiredRow.owner_user_id === null, "An expired attempt claims nothing");

  const pollutedCookie = await startConnect("x");
  connectLive = [...connectLive, { id: "acct-polluted", name: "Polluted", identifier: "x", disabled: false }];
  const pollutedResponse = await returnFromConnect(`${capturedRedirect}?added=x&msg=Channel+Updated`, pollutedCookie);
  assert.equal(await connectionOutcome(pollutedResponse), "returned", "Postiz-appended params must not break the return");
  assert.equal(fake.state.accounts.get("acct-polluted").owner_user_id, anaUser.id, "Claiming still works with appended params");

  const forgedResponse = await returnFromConnect(`${capturedRedirect}?added=x`, "f".repeat(64));
  assert.equal(await connectionOutcome(forgedResponse), "invalid");

  // ---------- 4. Assignment API: admins only, validated targets ----------
  const assignRoute = loadModule("src/app/api/social/accounts/[integrationId]/route.ts", {
    "@/lib/auth": authMock, "@/lib/social-accounts": socialAccountsModule
  });
  const assignRequest = (integrationId, body, origin = "https://studio.example.test") => new NextRequest(`https://studio.example.test/api/social/accounts/${integrationId}`, {
    method: "PATCH", headers: { Origin: origin, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const context = (integrationId) => ({ params: Promise.resolve({ integrationId }) });

  currentAuth = { user: anaUser };
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: anaUser.id }), context("acct-old"))).status, 403);
  assert.equal(fake.state.accounts.get("acct-old").owner_user_id, null, "Members cannot assign channels");

  currentAuth = { user: adminUser };
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: anaUser.id }, "https://untrusted.example.test"), context("acct-old"))).status, 403);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: "not-a-uuid" }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: anaUser.id, extra: 1 }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: "99999999-9999-4999-8999-999999999999" }), context("acct-old"))).status, 400);
  assert.equal((await assignRoute.PATCH(assignRequest("acct-missing", { ownerUserId: anaUser.id }), context("acct-missing"))).status, 404);

  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: anaUser.id }), context("acct-old"))).status, 200);
  assert.equal(fake.state.accounts.get("acct-old").owner_user_id, anaUser.id);
  assert.equal(fake.state.accounts.get("acct-old").origin, "admin");
  assert.equal(fake.state.accounts.get("acct-old").assigned_by_user_id, adminUser.id);

  assert.equal((await assignRoute.PATCH(assignRequest("acct-old", { ownerUserId: null }), context("acct-old"))).status, 200);
  assert.equal(fake.state.accounts.get("acct-old").owner_user_id, null, "Unassigning returns the channel to the admin-only pool");
  assert.equal(fake.state.accounts.get("acct-old").origin, null);

  originalConsoleError(`(expected route diagnostics captured: ${loggedErrors.length})`);
  console.log("PASS: member list filtered and admin list decorated; publish refused for others' and unassigned channels without touching Postiz; claims limited to new, provider-matching, unowned channels with single-use attempts; assignment API admin-only with validation; polluted and forged returns handled.");
} finally {
  console.error = originalConsoleError;
}
