import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextRequest, NextResponse } = nativeRequire("next/server");
function loadModule(path, dependencies = {}) {
  const { outputText } = typescript.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", outputText)(name => dependencies[name] ?? nativeRequire(name), compiled, compiled.exports);
  return compiled.exports;
}

const postId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const task = { id: taskId, kind: "asset", sourceId: "asset-one", projectId: null, integrationId: "account", state: "queued" };

for (const kind of ["manual", "asset"]) {
  test(`${kind}: HTTP 202 acknowledges durable work without awaiting a non-resolving Postiz promise`, async () => {
    const persisted = [];
    const wakeups = [];
    let externalCalls = 0;
    const never = new Promise(() => {});
    const enqueue = async () => {
      persisted.push({ ...task, kind });
      return { kind: "queued", task: persisted[0], post: { id: postId, targets: [{ status: "submitting" }] } };
    };
    const dependencies = {
      "next/server": { NextResponse, after: callback => wakeups.push(callback) },
      "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", displayName: "Owner", role: "member" }, ownerHash: "owner-hash" }) },
      "@/lib/project-db": { databaseConfigured: () => true, database: () => ({ execute: async () => [[{ id: postId }]] }) },
      "@/lib/same-origin": { isSameOrigin: () => true },
      "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
      "@/lib/image-upload": loadModule("../src/lib/image-upload.ts"),
      "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: "owner", provider: "x" }) },
      "@/lib/post-submission": { submitPostTarget: async () => ({ kind: "ok", post: {} }) },
      "@/lib/draft-submissions": { enqueueManualSubmission: enqueue, enqueueAssetSubmission: enqueue },
      "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: async () => { externalCalls++; await never; } },
      "@/lib/postiz": { publishToPostiz: async () => ({ success: true, postId: "old-sync" }), createStrictDraft: async () => { externalCalls++; await never; } },
      "@/lib/social-notifications": { recordSocialSubmission: async () => ({ auditId: "audit" }), deliverSocialNotifications: async () => ({ failed: 0 }) }
    };
    const path = kind === "manual" ? "../src/app/api/posts/[postId]/targets/[integrationId]/submit/route.ts" : "../src/app/api/social/publish/route.ts";
    const route = loadModule(path, dependencies);
    const request = new NextRequest("https://studio.test/api/social/publish", { method: "POST", headers: { "content-type": "application/json", origin: "https://studio.test" },
      body: JSON.stringify(kind === "manual" ? { expectedVersion: 4 } : { assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId }) });
    const response = await route.POST(request, { params: Promise.resolve({ postId, integrationId: "account" }) });
    assert.equal(response.status, 202);
    assert.equal(persisted[0].state, "queued", "queue insertion precedes the response");
    assert.equal((await response.json()).task.state, "queued");
    assert.equal(externalCalls, 0, "HTTP handling does not touch Postiz or deliver notifications");
    assert.equal(wakeups.length, 1, "only a post-response wakeup is registered");
  });
}

export { loadModule };

function createHarness() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT, disabled INTEGER, display_name TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, owner_hash TEXT);
    CREATE TABLE posts (id TEXT PRIMARY KEY, owner_user_id TEXT, title TEXT, content TEXT, image_data TEXT,
      image_thumb TEXT, image_name TEXT, image_width INTEGER, image_height INTEGER, version INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE post_targets (id TEXT, post_id TEXT, integration_id TEXT, platform TEXT, account_name TEXT,
      status TEXT, snapshot_version INTEGER, attempt_id TEXT, attempt_started_at TEXT, postiz_post_id TEXT,
      audit_id TEXT, warning TEXT, error TEXT, submitted_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE social_publishes (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT, integration_id TEXT,
      published_by TEXT, postiz_post_id TEXT, created_at TEXT);
    CREATE TABLE social_post_tracking (publish_audit_id TEXT PRIMARY KEY, postiz_post_id TEXT, review_status TEXT,
      state TEXT, save_action TEXT, postiz_publish_date TEXT, rejected_detected_at TEXT);
    CREATE TABLE draft_submissions (id TEXT PRIMARY KEY, owner_user_id TEXT, kind TEXT, source_id TEXT,
      project_id TEXT, integration_id TEXT, attempt_id TEXT, request_key TEXT UNIQUE, fingerprint TEXT,
      active_key TEXT UNIQUE, snapshot TEXT, state TEXT, lease_token TEXT, lease_expires_at TEXT,
      audit_id TEXT, postiz_post_id TEXT, warning TEXT, error TEXT, created_at TEXT, updated_at TEXT, finished_at TEXT);
    INSERT INTO users VALUES ('owner','member',0,'Owner');
    INSERT INTO projects VALUES ('${postId}','hash-owner');
    INSERT INTO posts VALUES ('${postId}','owner','Title','Frozen text','data:image/png;base64,AAAA',NULL,NULL,NULL,NULL,4,'2020-01-01','2020-01-01');
    INSERT INTO post_targets VALUES ('target','${postId}','account','x','Account','not_started',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2020-01-01','2020-01-01');
  `);
  const harness = { sql, drafts: [], audits: [], accountOwner: "owner", liveDisabled: false,
    draftResult: { success: true, postId: "upstream-one" }, auditFailure: false, failInsert: false,
    livePost: { id: "old-upstream", state: "DRAFT", saveAction: "pass" }, afterLive: null, draftPromise: null };
  let connectionTail = Promise.resolve();
  let transactionOpen = false;
  const execute = async (statement, parameters = []) => {
    if (harness.failInsert && statement.includes("INSERT INTO draft_submissions")) throw new Error("missing table or insert denied");
    let portable = statement.replace(/ FOR UPDATE(?: OF t, tracking| SKIP LOCKED)?\b/g, "")
      .replace(/ FOR SHARE\b/g, "").replace(/ AS BINARY\)/g, " AS BLOB)")
      .replace(/<=>/g, "IS")
      .replace("IF(?='unknown',active_key,NULL)", "CASE WHEN ?='unknown' THEN active_key ELSE NULL END");
    if (portable.startsWith("UPDATE post_targets t JOIN posts")) {
      portable = portable.replace("UPDATE post_targets t JOIN posts p ON p.id = t.post_id", "UPDATE post_targets")
        .replace("p.owner_user_id = ?", "post_id IN (SELECT id FROM posts WHERE owner_user_id=?)")
        .replace("submission.attempt_id=t.attempt_id", "submission.attempt_id=post_targets.attempt_id")
        .replace(/\bt\./g, "");
    }
    const prepared = sql.prepare(portable);
    return /^\s*SELECT/.test(portable) ? [prepared.all(...parameters)] : [{ affectedRows: prepared.run(...parameters).changes }];
  };
  const pool = { execute, getConnection: async () => {
    const preceding = connectionTail;
    let release;
    connectionTail = new Promise(resolve => { release = resolve; });
    await preceding;
    return { execute,
      beginTransaction: async () => { assert.equal(transactionOpen, false); transactionOpen = true; sql.exec("BEGIN"); },
      commit: async () => { sql.exec("COMMIT"); transactionOpen = false; },
      rollback: async () => { if (transactionOpen) sql.exec("ROLLBACK"); transactionOpen = false; },
      release
    };
  } };
  const postTypes = loadModule("../src/lib/post-types.ts");
  const storage = loadModule("../src/lib/posts.ts", { "@/lib/project-db": { database: () => pool }, "./post-types": postTypes });
  const dependencies = {
    "@/lib/project-db": { database: () => pool }, "@/lib/posts": storage,
    "@/lib/auth": { ownerHashFor: owner => `hash-${owner}` },
    "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: harness.accountOwner, provider: "x", accountName: "Account" }) },
    "@/lib/postiz": {
      fetchPostizIntegrations: async () => { assert.equal(transactionOpen, false); return { configured: true, accounts: [{ id: "account", identifier: "x", disabled: harness.liveDisabled }] }; },
      fetchPostizPostDetails: async () => {
        assert.equal(transactionOpen, false);
        const observed = structuredClone(harness.livePost);
        await harness.afterLive?.();
        return new Map(observed ? [[observed.id, observed]] : []);
      },
      createStrictDraft: async input => {
        assert.equal(transactionOpen, false, "external work must not hold database locks");
        harness.drafts.push(input);
        return harness.draftPromise || harness.draftResult;
      }
    },
    "@/lib/social-notifications": { recordSocialSubmission: async entry => {
      harness.audits.push(entry);
      if (harness.auditFailure) throw new Error("audit unavailable");
      return { auditId: "new-audit" };
    } }
  };
  const submission = loadModule("../src/lib/post-submission.ts", dependencies);
  const queue = loadModule("../src/lib/draft-submissions.ts", { ...dependencies, "@/lib/post-submission": submission });
  return Object.assign(harness, { queue, storage,
    enqueueAsset: (overrides = {}) => queue.enqueueAssetSubmission({ userId: "owner", isAdmin: false, assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId, ...overrides }),
    enqueueManual: (overrides = {}) => queue.enqueueManualSubmission({ userId: "owner", userName: "Owner", isAdmin: false, postId, integrationId: "account", expectedVersion: 4, ...overrides }),
    tasks: () => sql.prepare("SELECT * FROM draft_submissions ORDER BY created_at, id").all(),
    target: () => sql.prepare("SELECT * FROM post_targets").get(),
    rejectOriginal: () => sql.exec(`UPDATE post_targets SET status='accepted', audit_id='old-audit', postiz_post_id='old-upstream', submitted_at='2020-01-01 00:00:00.000';
      INSERT INTO social_publishes VALUES ('old-audit',NULL,'${postId}','account','owner','old-upstream','2020-01-01 00:00:00.000');
      INSERT INTO social_post_tracking VALUES ('old-audit','old-upstream','rejected','DRAFT','pass',NULL,NULL);`)
  });
}

test("manual claim and durable insert are one transaction, including insert failure rollback", async () => {
  const harness = createHarness();
  harness.failInsert = true;
  await assert.rejects(harness.enqueueManual());
  assert.equal(harness.target().status, "not_started");
  assert.equal(harness.tasks().length, 0);
  harness.failInsert = false;
  const accepted = await harness.enqueueManual();
  assert.equal(accepted.kind, "queued");
  assert.equal(accepted.post.targets[0].status, "submitting");
  assert.equal(harness.drafts.length, 0);
  assert.equal(JSON.parse(harness.tasks()[0].snapshot).content, "Frozen text");
  assert.equal((await harness.enqueueManual()).kind, "in_flight");
  assert.equal((await harness.storage.updateManualPost("owner", postId, 4, { content: "different" })).kind, "frozen");
  harness.sql.close();
});

test("asset enqueue deduplicates lost responses and concurrent clicks, while later edits remain possible", async () => {
  const harness = createHarness();
  const outcomes = await Promise.all([harness.enqueueAsset(), harness.enqueueAsset({ requestId: taskId })]);
  assert.equal(outcomes[0].task.id, outcomes[1].task.id);
  assert.equal(harness.tasks().length, 1);
  assert.equal((await harness.enqueueAsset({ content: "changed", requestId: postId })).kind, "in_flight");
  let resolveDraft;
  harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
  const firstWorker = harness.queue.processDraftSubmissions();
  while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
  await harness.queue.processDraftSubmissions();
  resolveDraft({ success: true, postId: "upstream-one" });
  await firstWorker;
  assert.equal(harness.drafts.length, 1, "two executors cannot claim the same queued task");
  assert.equal((await harness.enqueueAsset({ requestId: postId })).task.state, "succeeded");
  assert.equal(harness.tasks().length, 1, "a confirmed identical snapshot is never created twice");
  assert.equal((await harness.enqueueAsset({ content: "edited after success", requestId: taskId })).kind, "queued");
  assert.equal(harness.tasks().length, 2);
  harness.sql.close();
});

for (const kind of ["asset", "manual"]) {
  for (const [result, expected] of [[{ success: true, postId: "new-upstream" }, "succeeded"],
    [{ success: false, error: "explicit refusal" }, "failed"], [{ success: false, uncertain: true }, "unknown"]]) {
    test(`${kind} worker persists ${expected} without inventing publication`, async () => {
      const harness = createHarness();
      harness.draftResult = result;
      await (kind === "asset" ? harness.enqueueAsset() : harness.enqueueManual());
      await harness.queue.processDraftSubmissions();
      assert.equal(harness.tasks()[0].state, expected);
      if (kind === "manual") assert.equal(harness.target().status, expected === "succeeded" ? "accepted" : expected === "unknown" ? "pending_unknown" : "failed");
      if (expected === "unknown") {
        await harness.queue.processDraftSubmissions();
        assert.equal(harness.drafts.length, 1);
        if (kind === "asset") assert.equal((await harness.enqueueAsset({ content: "try another text", requestId: postId })).kind, "unconfirmed");
        else assert.equal((await harness.enqueueManual()).kind, "unconfirmed");
      }
      harness.sql.close();
    });
  }
}

test("successful creation with audit failure stays succeeded with a warning and blocks duplicates", async () => {
  const harness = createHarness();
  harness.auditFailure = true;
  await harness.enqueueAsset();
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.tasks()[0].state, "succeeded");
  assert.match(harness.tasks()[0].warning, /Do not submit again/);
  assert.equal((await harness.enqueueAsset({ requestId: taskId })).task.state, "succeeded");
  assert.equal(harness.drafts.length, 1);
  harness.sql.close();
});

test("queued jobs survive age and restart; expired running jobs become unknown without a create retry", async () => {
  const harness = createHarness();
  await harness.enqueueManual();
  harness.sql.exec("UPDATE post_targets SET attempt_started_at='2020-01-01'; UPDATE draft_submissions SET created_at='2020-01-01'");
  await harness.storage.sweepStaleSubmissions("owner");
  assert.equal(harness.target().status, "submitting", "queue wait is not an unknown external result");
  await harness.queue.processDraftSubmissions();
  assert.equal(harness.drafts.length, 1);
  harness.sql.close();
  const crashed = createHarness();
  await crashed.enqueueManual();
  crashed.sql.exec("UPDATE draft_submissions SET state='running',lease_token='dead-process',lease_expires_at='2020-01-01'");
  await crashed.queue.processDraftSubmissions();
  assert.equal(crashed.tasks()[0].state, "unknown");
  assert.equal(crashed.target().status, "pending_unknown");
  assert.equal(crashed.drafts.length, 0);
  crashed.sql.close();
});

for (const mutation of ["UPDATE users SET disabled=1", "UPDATE users SET role='member'", "reassign", "disabled-account"]) {
  test(`worker rechecks current permissions: ${mutation}`, async () => {
    const harness = createHarness();
    harness.sql.exec("UPDATE users SET role='admin'");
    harness.accountOwner = "other";
    await harness.enqueueAsset({ isAdmin: true });
    if (mutation === "reassign") { harness.sql.exec("UPDATE users SET role='member'"); harness.accountOwner = "other"; }
    else if (mutation === "disabled-account") harness.liveDisabled = true;
    else harness.sql.exec(mutation);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.tasks()[0].state, "failed");
    assert.equal(harness.drafts.length, 0);
    harness.sql.close();
  });
}

test("owner-only task reads omit snapshots and lease tokens", async () => {
  const harness = createHarness();
  const accepted = await harness.enqueueAsset();
  assert.deepEqual(await harness.queue.listDraftSubmissions("other", { ids: [accepted.task.id] }), []);
  const [visible] = await harness.queue.listDraftSubmissions("owner", { ids: [accepted.task.id] });
  assert.equal("snapshot" in visible, false);
  assert.equal("lease_token" in visible, false);
  assert.equal("content" in visible, false);
  harness.sql.close();
});

for (const livePost of [null, { id: "old-upstream", state: "DRAFT", saveAction: "draft" }]) {
  test(`rejected manual retry fresh check ${JSON.stringify(livePost)} restores the original frozen binding`, async () => {
    const harness = createHarness();
    harness.rejectOriginal();
    harness.livePost = livePost;
    const accepted = await harness.enqueueManual({ expectedAuditId: "old-audit" });
    assert.equal(accepted.kind, "queued");
    assert.equal(harness.drafts.length, 0);
    await harness.queue.processDraftSubmissions();
    assert.equal(harness.tasks()[0].state, "failed");
    assert.equal(harness.target().audit_id, "old-audit");
    assert.equal(harness.target().postiz_post_id, "old-upstream");
    assert.equal((await harness.storage.getManualPost("owner", postId)).editable, false);
    harness.sql.close();
  });
}

test("a late older worker cannot overwrite a newer manual attempt", async () => {
  const harness = createHarness();
  let resolveDraft;
  harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
  await harness.enqueueManual();
  const worker = harness.queue.processDraftSubmissions();
  while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
  harness.sql.exec("UPDATE post_targets SET attempt_id='newer', audit_id='newer-audit', postiz_post_id='newer-upstream'");
  resolveDraft({ success: true, postId: "old-worker-result" });
  await worker;
  assert.equal(harness.target().audit_id, "newer-audit");
  assert.equal(harness.target().postiz_post_id, "newer-upstream");
  harness.sql.close();
});

for (const kind of ["manual", "asset"]) {
  test(`${kind} real route commits a queued SQL row before a held draft creation`, async () => {
    const harness = createHarness();
    const wakeups = [];
    let resolveDraft;
    harness.draftPromise = new Promise(resolve => { resolveDraft = resolve; });
    const route = loadModule(kind === "manual" ? "../src/app/api/posts/[postId]/targets/[integrationId]/submit/route.ts" : "../src/app/api/social/publish/route.ts", {
      "next/server": { NextResponse, after: callback => wakeups.push(callback) },
      "@/lib/auth": { currentUser: async () => ({ user: { id: "owner", role: "member", displayName: "Owner" } }) },
      "@/lib/project-db": { databaseConfigured: () => true },
      "@/lib/same-origin": { isSameOrigin: () => true },
      "@/lib/request-body": loadModule("../src/lib/request-body.ts"),
      "@/lib/image-upload": loadModule("../src/lib/image-upload.ts"),
      "@/lib/draft-submissions": harness.queue,
      "@/lib/draft-submission-scheduler": { wakeDraftSubmissionWorker: () => harness.queue.processDraftSubmissions() }
    });
    const request = new NextRequest("https://studio.test/api/posts", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(kind === "manual" ? { expectedVersion: 4 } : { assetId: "asset-one", integrationId: "account", content: "Frozen text", requestId }) });
    const response = await route.POST(request, { params: Promise.resolve({ postId, integrationId: "account" }) });
    assert.equal(response.status, 202);
    assert.equal(harness.tasks()[0].state, "queued");
    assert.equal(harness.drafts.length, 0);
    const worker = wakeups[0]();
    while (!harness.drafts.length) await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.tasks()[0].state, "running");
    assert.equal((await response.json()).task.state, "queued", "response never claims external completion");
    resolveDraft({ success: true, postId: "upstream-held" });
    await worker;
    assert.equal(harness.tasks()[0].state, "succeeded");
    harness.sql.close();
  });
}

test("client task projection preserves content, unknown safety and exact review binding", () => {
  const statuses = loadModule("../src/lib/submission-status.ts");
  const client = loadModule("../src/lib/draft-submission-client.ts", {
    "./submission-status": statuses, "./draft-submission-types": loadModule("../src/lib/draft-submission-types.ts")
  });
  const queued = { ...task, auditId: null, postId: null, warning: null, error: null, createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", finishedAt: null };
  const asset = { id: "asset-one", content: "New local edits", imageUrl: "new-image", publishStatus: "unpublished" };
  const pending = client.mergeDraftTask(asset, queued);
  assert.equal(pending.publishStatus, "publishing");
  assert.equal(pending.content, "New local edits");
  const unknown = client.mergeDraftTask(pending, { ...queued, state: "unknown", warning: "Check first" });
  assert.equal(unknown.publishStatus, "pending_unknown");
  assert.equal(client.mergeDraftTask(unknown, queued), unknown, "late queued response cannot downgrade needs-review");
  const succeeded = client.mergeDraftTask(unknown, { ...queued, state: "succeeded", auditId: "audit", postId: "external", finishedAt: "2026-10-19T00:01:00.000Z" });
  assert.equal(succeeded.publishStatus, "drafted");
  assert.equal(succeeded.publishedAt, undefined);
  const rejected = { ...succeeded, reviewStatus: "rejected" };
  assert.equal(client.mergeDraftTask(rejected, { ...queued, state: "succeeded", auditId: "audit", postId: "external" }).reviewStatus, "rejected");
  const confirmedTask = { ...queued, state: "succeeded", auditId: "audit", postId: "external" };
  for (const publishStatus of ["publishing", "pending_unknown"]) {
    const restored = client.mergeDraftTask({ ...rejected, publishStatus, publishError: "Old uncertainty" }, confirmedTask);
    assert.equal(restored.publishStatus, "drafted", "a deduplicated success must release the pending card");
    assert.equal(restored.reviewStatus, "rejected", "recovery must preserve the known review result");
    assert.equal(restored.publishError, undefined);
    assert.strictEqual(client.mergeDraftTask(restored, confirmedTask), restored, "the next poll must keep the stable result");
  }
  const alreadyPublished = { ...succeeded, publishStatus: "publishing", publishedAt: "2026-10-19T01:00:00.000Z", publishedUrl: "https://example.test/post" };
  const restoredPublication = client.mergeDraftTask(alreadyPublished, confirmedTask);
  assert.equal(restoredPublication.publishStatus, "published", "deduplication cannot erase confirmed publication facts");
  assert.equal(restoredPublication.publishedAt, "2026-10-19T01:00:00.000Z");
});
