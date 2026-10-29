// Real route/library with synthetic Postiz and transactional fake MySQL; no real OAuth or database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
function loadModule(path, mocks = {}) {
  const { outputText } = typescript.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports);
  return compiled.exports;
}

function createTransactionalDatabase() {
  const state = { accounts: new Map(), attempts: new Map(), events: [], failure: null };
  let snapshot;
  const connection = {
    async beginTransaction() {
      state.events.push("begin");
      snapshot = structuredClone({ accounts: state.accounts, attempts: state.attempts });
    },
    async commit() { state.events.push("commit"); snapshot = undefined; },
    async rollback() {
      state.events.push("rollback");
      if (snapshot) { state.accounts = snapshot.accounts; state.attempts = snapshot.attempts; snapshot = undefined; }
    },
    release() { state.events.push("release"); },
    async execute(sql, parameters = []) {
      const statement = sql.replace(/\s+/g, " ").trim();
      state.events.push(statement);
      if (state.failure && statement.includes(state.failure)) throw new Error("Synthetic database failure");
      if (statement.startsWith("INSERT INTO social_connect_attempts")) {
        const [stateHash, userId, provider, snapshotIds, returnView, expiresAt] = parameters;
        state.attempts.set(stateHash, {
          state_hash: stateHash, user_id: userId, provider, snapshot_ids: snapshotIds,
          return_view: returnView, expires_at: expiresAt, consumed_at: null
        });
        return [{ affectedRows: 1 }];
      }
      if (statement.startsWith("DELETE FROM social_connect_attempts")) return [{ affectedRows: 0 }];
      if (statement.startsWith("SELECT") && statement.includes("FROM social_connect_attempts")) {
        return [[state.attempts.get(parameters[0])].filter(Boolean).map(row => ({ ...row }))];
      }
      if (statement.startsWith("UPDATE social_connect_attempts")) {
        const [now, stateHash, userId, boundary] = parameters;
        const attempt = state.attempts.get(stateHash);
        if (!attempt || attempt.user_id !== userId || attempt.consumed_at || attempt.expires_at <= boundary) return [{ affectedRows: 0 }];
        attempt.consumed_at = now;
        return [{ affectedRows: 1 }];
      }
      if (statement.startsWith("INSERT INTO social_accounts")) {
        const [integrationId, provider, accountName, ownerUserId] = parameters;
        const existing = state.accounts.get(integrationId);
        if (!existing) state.accounts.set(integrationId, { integration_id: integrationId, provider, account_name: accountName, owner_user_id: ownerUserId, origin: "connect" });
        else if (existing.owner_user_id == null) { existing.owner_user_id = ownerUserId; existing.origin = "connect"; }
        // FOUND_ROWS may report an existing row as affected; production must SELECT actual ownership.
        return [{ affectedRows: 1 }];
      }
      if (statement.startsWith("SELECT") && statement.includes("FROM social_accounts")) {
        return [[state.accounts.get(parameters[0])].filter(Boolean).map(row => ({ ...row }))];
      }
      throw new Error(`Unexpected SQL: ${statement}`);
    }
  };
  return { state, execute: connection.execute, async getConnection() { state.events.push("acquire"); return connection; } };
}

const browserOrigin = "https://studio.example.test:8443";
const memberId = "member-one";
const stateCookie = "polaris-postiz-connect";
const account = (id, identifier = "x") => ({ id, identifier, name: id, disabled: false });

function setup() {
  const database = createTransactionalDatabase();
  const socialAccounts = loadModule("src/lib/social-accounts.ts", { "@/lib/project-db": { database: () => database } });
  const state = { auth: { user: { id: memberId } }, liveAccounts: [account("historical")], configured: true, upstreamError: null, authorizationCalls: [] };
  const postiz = {
    async fetchPostizIntegrations() {
      const lastBegin = database.state.events.lastIndexOf("begin");
      assert.ok(lastBegin < 0 || database.state.events.lastIndexOf("release") > lastBegin, "Network must run outside the transaction");
      if (state.upstreamError instanceof Error) throw state.upstreamError;
      return { configured: state.configured, accounts: state.liveAccounts, error: state.upstreamError || undefined };
    },
    async createPostizAuthorizationUrl(provider, redirectUrl) {
      state.authorizationCalls.push({ provider, redirectUrl });
      return "https://twitter.com/i/oauth2/authorize?state=synthetic";
    },
    PostizConnectionError: class extends Error {}
  };
  const routes = loadModule("src/app/api/social/connect/route.ts", {
    "@/lib/social-accounts": socialAccounts, "@/lib/postiz": postiz,
    "@/lib/auth": { currentUser: async () => {
      if (state.auth instanceof Error) throw state.auth;
      return state.auth;
    }, unauthorized: () => NextResponse.json({}, { status: 401 }) },
    "@/lib/same-origin": loadModule("src/lib/same-origin.ts")
  });
  const startRequest = (body = { provider: "x", returnView: "assets" }, origin = browserOrigin) => new NextRequest("http://localhost:3000/api/social/connect", {
    method: "POST", headers: { Origin: origin, Host: "localhost:3000", "X-Forwarded-Host": "studio.example.test:8443", "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  async function start(provider = "x") {
    const response = await routes.POST(startRequest({ provider, returnView: "assets" }));
    assert.equal(response.status, 200);
    return { cookie: response.cookies.get(stateCookie).value, url: state.authorizationCalls.at(-1).redirectUrl };
  }
  const callback = (url, cookie) => routes.GET(new NextRequest(url, { headers: cookie ? { Cookie: `${stateCookie}=${cookie}` } : {} }));
  return { database, socialAccounts, state, routes, startRequest, start, callback };
}

function inspectCompletion(response, outcome, view = "assets") {
  assert.equal(response.status, 303);
  const location = response.headers.get("location");
  assert.ok(location.startsWith("/social/connect/complete?"), "Completion redirect must be relative, not proxy localhost");
  const destination = new URL(location, browserOrigin);
  assert.equal(destination.searchParams.get("connection"), outcome);
  assert.equal(destination.searchParams.get("view"), view);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  return destination;
}

test("proxy callback uses guarded browser Origin and secure browser protocol", async () => {
  const context = setup();
  const response = await context.routes.POST(context.startRequest());
  assert.equal(response.status, 200);
  assert.equal(new URL(context.state.authorizationCalls[0].redirectUrl).origin, browserOrigin);
  assert.equal(response.cookies.get(stateCookie).secure, true);
  const insecure = await context.routes.POST(context.startRequest({ provider: "x" }, "http://studio.example.test:8080"));
  assert.equal(new URL(context.state.authorizationCalls.at(-1).redirectUrl).origin, "http://studio.example.test:8080");
  assert.equal(insecure.cookies.get(stateCookie).secure, false);
});

test("returnView whitelist matches Studio views and rejects other protocols", async () => {
  const context = setup();
  for (const returnView of ["workspace", "facts", "assets", "export", "accounts", "settings"]) {
    assert.equal((await context.routes.POST(context.startRequest({ provider: "x", returnView }))).status, 200);
  }
  for (const returnView of ["admin", "https://evil.test", "", "assets&connection=returned"]) {
    assert.equal((await context.routes.POST(context.startRequest({ provider: "x", returnView }))).status, 400);
  }
  assert.equal((await context.routes.POST(context.startRequest({ provider: "x" }, "ftp://studio.example.test"))).status, 403);
});

for (const failure of ["unconfigured", "snapshot-error", "snapshot-throw", "attempt-write"]) {
  test(`authorization is fail-closed on ${failure}`, async () => {
    const context = setup();
    if (failure === "unconfigured") context.state.configured = false;
    if (failure === "snapshot-error") context.state.upstreamError = "Synthetic upstream error";
    if (failure === "snapshot-throw") context.state.upstreamError = new Error("Synthetic upstream error");
    if (failure === "attempt-write") context.database.state.failure = "INSERT INTO social_connect_attempts";
    const response = await context.routes.POST(context.startRequest());
    assert.equal(response.status, failure === "unconfigured" || failure === "attempt-write" ? 503 : 502, failure);
    assert.equal(context.state.authorizationCalls.length, 0, failure);
    assert.equal(response.cookies.get(stateCookie), undefined);
  });
}

test("unique real provider id is owned and consumed atomically; double-question callback succeeds", async () => {
  const context = setup();
  context.database.state.accounts.set("historical", { owner_user_id: null });
  const attempt = await context.start();
  context.state.liveAccounts.push(account("new-real-integration"));
  const response = await context.callback(`${attempt.url}?added=x&msg=Channel+Updated`, attempt.cookie);
  const destination = inspectCompletion(response, "returned");
  assert.equal(destination.searchParams.has("retry"), false);
  assert.equal(context.database.state.accounts.get("new-real-integration").owner_user_id, memberId);
  assert.equal(context.database.state.accounts.get("historical").owner_user_id, null);
  assert.ok(context.database.state.attempts.get(attempt.cookie).consumed_at);
  assert.equal(response.cookies.get(stateCookie).maxAge, 0);
  assert.ok(context.database.state.events.some(event => event.includes("social_connect_attempts") && event.includes("FOR UPDATE")));
  assert.ok(context.database.state.events.includes("commit"));
  inspectCompletion(await context.callback(attempt.url, attempt.cookie), "invalid", "accounts");
});

test("a member can connect two different X accounts sequentially; repeating an existing account stays unconfirmed", async () => {
  const context = setup();
  for (const id of ["first-x-account", "second-x-account"]) {
    const attempt = await context.start();
    context.state.liveAccounts.push(account(id));
    inspectCompletion(await context.callback(attempt.url, attempt.cookie), "returned");
    assert.equal(context.database.state.accounts.get(id).owner_user_id, memberId);
  }
  const repeated = await context.start();
  inspectCompletion(await context.callback(`${repeated.url}?added=x&msg=Channel+Updated`, repeated.cookie), "unconfirmed");
  assert.equal(context.database.state.attempts.get(repeated.cookie).consumed_at, null);
  assert.equal(context.database.state.accounts.size, 2);
  assert.ok([...context.database.state.accounts.values()].every(account => account.owner_user_id === memberId));
});

test("LinkedIn authorizes and claims a company Page; a personal profile cannot complete the attempt", async () => {
  const context = setup();
  const attempt = await context.start("linkedin");
  assert.equal(context.state.authorizationCalls.at(-1).provider, "linkedin-page");
  assert.equal(context.database.state.attempts.get(attempt.cookie).provider, "linkedin-page");
  context.state.liveAccounts.push(account("personal-profile", "linkedin"));
  inspectCompletion(await context.callback(attempt.url, attempt.cookie), "unconfirmed");
  assert.equal(context.database.state.accounts.size, 0);
  context.state.liveAccounts.push(account("company-page", "linkedin-page"));
  inspectCompletion(await context.callback(`${attempt.url}?added=linkedin-page`, attempt.cookie), "returned");
  assert.equal(context.database.state.accounts.get("company-page").owner_user_id, memberId);
  assert.equal(context.database.state.accounts.has("personal-profile"), false);
});

test("YouTube channel authorization claims the new channel only for its initiating member", async () => {
  const context = setup();
  const attempt = await context.start("youtube");
  assert.equal(context.state.authorizationCalls.at(-1).provider, "youtube");
  context.state.liveAccounts.push(account("youtube-channel-one", "youtube"));
  inspectCompletion(await context.callback(`${attempt.url}?added=youtube`, attempt.cookie), "returned");
  assert.equal(context.database.state.accounts.get("youtube-channel-one").owner_user_id, memberId);
  assert.equal(context.database.state.accounts.get("youtube-channel-one").provider, "youtube");
});

test("already-owned unique candidate is confirmed only for the same member", async () => {
  for (const owner of [memberId, "other-member"]) {
    const context = setup();
    const attempt = await context.start();
    context.state.liveAccounts.push(account("new-real-integration"));
    context.database.state.accounts.set("new-real-integration", { owner_user_id: owner, origin: "admin" });
    inspectCompletion(await context.callback(attempt.url, attempt.cookie), owner === memberId ? "returned" : "conflict");
    assert.equal(context.database.state.accounts.get("new-real-integration").owner_user_id, owner);
    assert.equal(context.database.state.accounts.get("new-real-integration").origin, "admin");
    assert.equal(Boolean(context.database.state.attempts.get(attempt.cookie).consumed_at), owner === memberId);
  }
});

test("zero, multiple, wrong-provider and provider-as-id candidates are unconfirmed and retryable", async () => {
  for (const additions of [[], [account("new-one"), account("new-two")], [account("facebook-one", "facebook")], [account("x")]]) {
    const context = setup();
    const attempt = await context.start();
    context.state.liveAccounts.push(...additions);
    const response = await context.callback(attempt.url, attempt.cookie);
    const destination = inspectCompletion(response, "unconfirmed");
    assert.equal(destination.searchParams.get("retry"), `/api/social/connect?state=${new URL(attempt.url).searchParams.get("state")}`);
    assert.equal(response.cookies.get(stateCookie), undefined, "Keep the browser cookie for manual retry");
    assert.equal(context.database.state.attempts.get(attempt.cookie).consumed_at, null);
    assert.equal(context.database.state.accounts.size, 0, "Ambiguous candidates must not be claimed");
  }
});

test("consume failure rolls back ownership and preserves attempt/cookie for successful retry", async () => {
  const context = setup();
  const attempt = await context.start();
  context.state.liveAccounts.push(account("new-real-integration"));
  context.database.state.failure = "UPDATE social_connect_attempts";
  const failedResponse = await context.callback(attempt.url, attempt.cookie);
  const destination = inspectCompletion(failedResponse, "error", "accounts");
  assert.ok(destination.searchParams.get("retry"));
  assert.equal(failedResponse.cookies.get(stateCookie), undefined);
  assert.equal(context.database.state.attempts.get(attempt.cookie).consumed_at, null);
  assert.equal(context.database.state.accounts.has("new-real-integration"), false);
  assert.ok(context.database.state.events.includes("rollback"));
  assert.equal(context.database.state.events.at(-1), "release");
  context.database.state.failure = null;
  inspectCompletion(await context.callback(attempt.url, attempt.cookie), "returned");
});

test("upstream callback failure does not consume and manual retry can recover", async () => {
  const context = setup();
  const attempt = await context.start();
  context.state.upstreamError = "Synthetic upstream error";
  const failed = await context.callback(attempt.url, attempt.cookie);
  inspectCompletion(failed, "error", "accounts");
  assert.equal(failed.cookies.get(stateCookie), undefined);
  assert.equal(context.database.state.attempts.get(attempt.cookie).consumed_at, null);
  context.state.upstreamError = null;
  context.state.liveAccounts.push(account("new-real-integration"));
  inspectCompletion(await context.callback(attempt.url, attempt.cookie), "returned");
});

test("missing cookie, unauthenticated, expired, mismatched and forged callbacks never claim", async () => {
  for (const failure of ["cookie", "auth", "expired", "user", "forged", "missing-attempt"]) {
    const context = setup();
    const attempt = await context.start();
    context.state.liveAccounts.push(account("new-real-integration"));
    if (failure === "auth") context.state.auth = null;
    if (failure === "expired") context.database.state.attempts.get(attempt.cookie).expires_at = "2020-01-01 00:00:00";
    if (failure === "user") context.database.state.attempts.get(attempt.cookie).user_id = "other-member";
    if (failure === "missing-attempt") context.database.state.attempts.delete(attempt.cookie);
    const response = await context.callback(failure === "forged" ? `${browserOrigin}/api/social/connect?state=forged` : attempt.url, failure === "cookie" ? undefined : attempt.cookie);
    inspectCompletion(response, failure === "auth" ? "unauthenticated" : "invalid", "accounts");
    assert.equal(response.cookies.get(stateCookie).maxAge, 0);
    assert.equal(context.database.state.accounts.size, 0);
  }
});

test("authentication database failure redirects to retryable error and preserves cookie", async () => {
  const context = setup();
  const attempt = await context.start();
  context.state.auth = new Error("Synthetic authentication database failure");
  const response = await context.callback(attempt.url, attempt.cookie);
  const destination = inspectCompletion(response, "error", "accounts");
  assert.equal(destination.searchParams.get("retry"), `/api/social/connect?state=${new URL(attempt.url).searchParams.get("state")}`);
  assert.equal(response.cookies.get(stateCookie), undefined);
  assert.equal(context.database.state.attempts.get(attempt.cookie).consumed_at, null);
});

test("unknown persisted return view is normalized and malformed snapshot is never claimed", async () => {
  const context = setup();
  const attempt = await context.start();
  const record = context.database.state.attempts.get(attempt.cookie);
  record.return_view = "assets&connection=returned";
  record.snapshot_ids = "malformed";
  context.state.liveAccounts.push(account("new-real-integration"));
  inspectCompletion(await context.callback(attempt.url, attempt.cookie), "unconfirmed", "accounts");
  assert.equal(context.database.state.accounts.size, 0);
});
