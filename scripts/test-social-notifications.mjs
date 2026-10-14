// Real service module, transactional fake MySQL and synthetic upstreams only; no credentials/network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const utc = date => new Date(date).toISOString().slice(0, 23).replace("T", " ");
const submission = {
  assetId: "asset-one", platform: "x", integrationId: "integration-one", accountName: "Original account",
  publishedBy: "original-applicant", publishedByName: "原申请人", contentPreview: "Original summary",
  postizPostId: "real-post-one", status: "drafted"
};

function setup() {
  const state = {
    audits: new Map(), tracking: new Map(), outbox: new Map(), health: {}, failure: null,
    now: Date.parse("2026-10-14T12:00:00.000Z"), transactions: 0, queries: [],
    config: { enabled: true, notifyDrafts: true, notifyPublished: true, version: 1, webhookUrl: "https://synthetic.invalid/hook" },
    configError: null, deliveryError: null, postizError: null, details: new Map(),
    messages: [], ranges: [], spacing: [], lock: null, lockAllowed: true, beforeSend: null, beforeReadConfig: null,
    beforeQuery: null, beforeFetchDetails: null
  };
  let transactionQueue = Promise.resolve();
  function createConnection() {
    let snapshot;
    let unlockTransaction;
    const owner = {};
    return {
      async beginTransaction() {
        const previousTransaction = transactionQueue;
        transactionQueue = new Promise(resolve => { unlockTransaction = resolve; });
        await previousTransaction;
        snapshot = structuredClone({ audits: state.audits, tracking: state.tracking, outbox: state.outbox });
        state.transactions++;
      },
      async commit() { snapshot = null; state.transactions--; unlockTransaction(); },
      async rollback() {
        if (!snapshot) return;
        Object.assign(state, snapshot); snapshot = null; state.transactions--; unlockTransaction();
      },
      release() {},
      async execute(sql, parameters = []) {
        const statement = sql.replace(/\s+/g, " ").trim();
        state.queries.push({ statement, parameters });
        if (state.beforeQuery) await state.beforeQuery(statement);
        if (state.failure && statement.includes(state.failure)) throw new Error("secret=https://hook.invalid/token credentials");
        if (statement === "SELECT DATABASE() AS database_name") return [[{ database_name: "synthetic_polaris" }]];
        if (statement.includes("GET_LOCK")) {
          const acquired = state.lockAllowed && (!state.lock || state.lock === owner);
          if (acquired) state.lock = owner;
          return [[{ acquired: acquired ? 1 : 0 }]];
        }
        if (statement.includes("RELEASE_LOCK")) { if (state.lock === owner) state.lock = null; return [[{ released: 1 }]]; }
        if (statement.startsWith("INSERT INTO social_publishes")) {
          const [auditId, projectId, assetId, platform, integrationId, accountName, applicantId, applicantName, summary, postId, status, error, createdAt] = parameters;
          state.audits.set(auditId, { id: auditId, project_id: projectId, asset_id: assetId, platform, integration_id: integrationId,
            account_name: accountName, published_by: applicantId, published_by_name: applicantName, content_preview: summary,
            postiz_post_id: postId, status, error, created_at: createdAt });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("INSERT INTO social_post_tracking")) {
          const [auditId, postId, submittedAt, nextCheckAt, notifyPublished, version] = parameters;
          state.tracking.set(auditId, { publish_audit_id: auditId, postiz_post_id: postId, submitted_at: submittedAt,
            next_check_at: nextCheckAt, notify_published: notifyPublished, config_version: version, state: "DRAFT", check_attempts: 0, confirmed_at: null });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("INSERT INTO social_notification_outbox")) {
          const [notificationId, auditId, eventType, eventTime, nextAttemptAt, version, payload] = parameters;
          const existing = [...state.outbox.values()].find(row => row.publish_audit_id === auditId && row.event_type === eventType);
          if (existing) return [{ affectedRows: 0 }];
          state.outbox.set(notificationId, { id: notificationId, publish_audit_id: auditId, event_type: eventType, event_time: eventTime,
            next_attempt_at: nextAttemptAt, config_version: version, payload: JSON.parse(payload), status: "pending", attempts: 0 });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("SELECT") && statement.includes("FROM social_notification_outbox AS notification")) {
          const [now, ...remaining] = parameters;
          const auditId = remaining.length ? remaining[0] : null;
          const candidates = [...state.outbox.values()].filter(row => row.status === "pending" && row.next_attempt_at <= now && row.attempts < 5 &&
            (!auditId || row.publish_audit_id === auditId) && (row.event_type !== "published" || ![...state.outbox.values()].some(draft =>
              draft.publish_audit_id === row.publish_audit_id && draft.event_type === "draft_submitted" && ["pending", "sending"].includes(draft.status))));
          candidates.sort((first, second) => first.event_time.localeCompare(second.event_time) || first.event_type.localeCompare(second.event_type));
          return [candidates.slice(0, 1).map(row => ({ ...row }))];
        }
        if (statement.startsWith("UPDATE social_notification_outbox") && statement.includes("lease_expires_at <=")) {
          const [now] = parameters;
          for (const row of state.outbox.values()) if (row.status === "sending" && row.lease_expires_at <= now) {
            row.status = row.attempts >= 5 ? "failed" : "pending"; row.lease_token = null; row.lease_expires_at = null;
          }
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_notification_outbox") && statement.includes("attempts=attempts+1")) {
          const [leaseToken, leaseExpiresAt, notificationId] = parameters;
          const row = state.outbox.get(notificationId);
          if (!row || row.status !== "pending") return [{ affectedRows: 0 }];
          Object.assign(row, { status: "sending", lease_token: leaseToken, lease_expires_at: leaseExpiresAt, attempts: row.attempts + 1 });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_notification_outbox") && statement.includes("SET lease_expires_at=?")) {
          const [leaseExpiresAt, notificationId, leaseToken, now] = parameters;
          const row = state.outbox.get(notificationId);
          if (!row || row.status !== "sending" || row.lease_token !== leaseToken || row.lease_expires_at <= now) return [{ affectedRows: 0 }];
          row.lease_expires_at = leaseExpiresAt;
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_notification_outbox") && statement.includes("attempts=GREATEST(attempts-1,0)")) {
          const [nextAttemptAt, notificationId, leaseToken] = parameters;
          const row = state.outbox.get(notificationId);
          if (!row || row.status !== "sending" || row.lease_token !== leaseToken) return [{ affectedRows: 0 }];
          Object.assign(row, { status: "pending", attempts: Math.max(row.attempts - 1, 0), next_attempt_at: nextAttemptAt,
            lease_token: null, lease_expires_at: null });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_notification_outbox")) {
          const [status, sentAt, nextAttemptAt, lastError, notificationId, leaseToken] = parameters;
          const row = state.outbox.get(notificationId);
          if (!row || row.status !== "sending" || row.lease_token !== leaseToken) return [{ affectedRows: 0 }];
          Object.assign(row, { status, sent_at: sentAt, next_attempt_at: nextAttemptAt, last_error: lastError, lease_token: null, lease_expires_at: null });
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("SELECT") && statement.includes("FROM social_post_tracking AS tracking")) {
          const [now] = parameters;
          return [[...state.tracking.values()].filter(row => (!statement.includes("WHERE tracking.notify_published=1") || row.notify_published) && !row.confirmed_at && row.next_check_at <= now)
            .sort((first, second) => first.next_check_at.localeCompare(second.next_check_at)).slice(0, 100)
            .map(row => ({ ...row, ...state.audits.get(row.publish_audit_id) }))];
        }
        if (statement.startsWith("SELECT") && statement.includes("FROM social_post_tracking")) {
          return [[state.tracking.get(parameters[0])].filter(Boolean).map(row => ({ ...row }))];
        }
        if (statement.startsWith("UPDATE social_post_tracking") && statement.includes("notify_published=0")) {
          const [version, enabled] = statement.includes("JOIN workspace_feishu_config")
            ? [state.config?.version ?? 0, state.config?.enabled && state.config.notifyPublished]
            : parameters;
          for (const row of state.tracking.values()) if (row.config_version !== version || !enabled) row.notify_published = 0;
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_post_tracking") && statement.includes("confirmed_at=?")) {
          const [releaseUrl, publishDate, confirmedAt, lastCheckedAt, nextCheckAt, auditId] = parameters;
          const row = state.tracking.get(auditId);
          Object.assign(row, { state: "PUBLISHED", release_url: releaseUrl, postiz_publish_date: publishDate,
            confirmed_at: confirmedAt, last_checked_at: lastCheckedAt, next_check_at: nextCheckAt, last_error: null });
          row.check_attempts++;
          return [{ affectedRows: 1 }];
        }
        if (statement.startsWith("UPDATE social_post_tracking")) {
          const [postState, nextCheckAt, lastCheckedAt, lastError, auditId] = parameters;
          const row = state.tracking.get(auditId);
          if (row && !row.confirmed_at) Object.assign(row, { state: postState, next_check_at: nextCheckAt,
            last_checked_at: lastCheckedAt, last_error: lastError, check_attempts: row.check_attempts + 1 });
          return [{ affectedRows: row ? 1 : 0 }];
        }
        if (statement.startsWith("UPDATE workspace_feishu_config")) {
          if (statement.includes("last_worker_at")) state.health.lastWorkerAt = parameters[0];
          if (statement.includes("last_delivery_error")) state.health.lastDeliveryError = parameters[statement.includes("last_worker_at") ? 1 : 0];
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL: ${statement}`);
      }
    };
  }
  const pool = { execute: (...argumentsList) => createConnection().execute(...argumentsList), getConnection: async () => createConnection() };
  class ClockDate extends Date {
    constructor(...argumentsList) { super(...(argumentsList.length ? argumentsList : [state.now])); }
    static now() { return state.now; }
  }
  const mocks = {
    "@/lib/project-db": { database: () => pool },
    "@/lib/feishu": {
      readFeishuConfig: async () => {
        if (state.beforeReadConfig) await state.beforeReadConfig();
        if (state.configError) throw state.configError;
        return structuredClone(state.config);
      },
      sendFeishuMessage: async (config, text) => {
        assert.equal(state.transactions, 0, "Feishu network must run outside transactions");
        if (state.beforeSend) await state.beforeSend();
        if (state.deliveryError) throw state.deliveryError;
        state.messages.push({ config, text });
      }
    },
    "@/lib/postiz": {
      getPostizUiUrl: () => "https://postiz.example.test",
      fetchPostizPostDetails: async (postIds, range) => {
        assert.equal(state.transactions, 0, "Postiz network must run outside transactions");
        state.ranges.push({ postIds, ...range });
        if (state.beforeFetchDetails) await state.beforeFetchDetails();
        if (state.postizError) throw state.postizError;
        return new Map([...state.details].filter(([, post]) => !post.publishDate ||
          (new Date(post.publishDate) >= range.startDate && new Date(post.publishDate) <= range.endDate)));
      }
    },
    "node:timers/promises": { setTimeout: async delay => { state.spacing.push(delay); } }
  };
  const { outputText } = typescript.transpileModule(readFileSync("src/lib/social-notifications.ts", "utf8"), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true }
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", "Date", outputText)(name => mocks[name] ?? nativeRequire(name), compiled, compiled.exports, ClockDate);
  return { state, service: compiled.exports, advance: milliseconds => { state.now += milliseconds; } };
}

test("submission persists original applicant, bounded summary and explicit UTC; failed submissions never notify", async () => {
  const { state, service } = setup();
  const result = await service.recordSocialSubmission({ ...submission, contentPreview: "文".repeat(230) });
  assert.ok(result.auditId);
  assert.equal(state.audits.get(result.auditId).published_by, submission.publishedBy);
  const notification = [...state.outbox.values()][0];
  assert.equal(notification.payload.applicantName, submission.publishedByName);
  assert.equal(notification.payload.applicantId, submission.publishedBy);
  assert.equal(notification.payload.summary.length, 200);
  assert.equal(notification.event_time, "2026-10-14 12:00:00.000");
  await service.recordSocialSubmission({ ...submission, status: "failed", error: "token=secret" });
  assert.equal(state.audits.size, 2); assert.equal(state.outbox.size, 1); assert.equal(state.tracking.size, 1);
});

test("disabled/missing/broken config preserves audit without later historical publication notifications", async () => {
  for (const variant of ["disabled", "missing", "broken"]) {
    const { state, service } = setup();
    if (variant === "disabled") state.config.enabled = false;
    if (variant === "missing") state.config = null;
    if (variant === "broken") state.configError = new Error("secret=https://hook.invalid/private");
    const result = await service.recordSocialSubmission(submission);
    assert.ok(result.auditId); assert.equal(state.outbox.size, 0);
    assert.equal(state.tracking.get(result.auditId).notify_published, 0);
    if (variant === "broken") { assert.ok(result.warning); assert.doesNotMatch(result.warning, /hook|private/); }
    state.configError = null;
    state.config = { enabled: true, notifyDrafts: true, notifyPublished: true, version: 2, webhookUrl: "synthetic" };
    state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED" });
    await service.processSocialNotifications(); assert.equal(state.messages.length, 0);
  }
});

test("missing genuine Postiz id warns without rejecting upstream success or fabricating tracking id", async () => {
  const { state, service } = setup();
  const result = await service.recordSocialSubmission({ ...submission, postizPostId: undefined });
  assert.ok(result.auditId); assert.ok(result.warning); assert.equal(state.tracking.size, 0);
  assert.equal(state.audits.get(result.auditId).status, "drafted");
  assert.equal(state.audits.get(result.auditId).postiz_post_id, null);
});

test("tracking or outbox SQL failure rolls back all writes and returns only a safe local warning", async () => {
  for (const failingTable of ["INSERT INTO social_post_tracking", "INSERT INTO social_notification_outbox"]) {
    const { state, service } = setup(); state.failure = failingTable;
    const result = await service.recordSocialSubmission(submission);
    assert.equal(result.auditId, undefined); assert.ok(result.warning); assert.doesNotMatch(result.warning, /hook|credentials/);
    assert.equal(state.audits.size, 0); assert.equal(state.tracking.size, 0); assert.equal(state.outbox.size, 0);
  }
});

test("immediate audit-limited delivery sends once and concurrent claim cannot send the same event", async () => {
  const { state, service } = setup();
  const first = await service.recordSocialSubmission(submission);
  const second = await service.recordSocialSubmission({ ...submission, assetId: "asset-two" });
  await Promise.all([service.deliverSocialNotifications({ auditId: first.auditId, limit: 1 }), service.deliverSocialNotifications({ auditId: first.auditId, limit: 1 })]);
  assert.equal(state.messages.length, 1); assert.match(state.messages[0].text, /^\[Polaris\] 新草稿待审核/);
  assert.match(state.messages[0].text, /原申请人/); assert.match(state.messages[0].text, /UTC/);
  assert.equal([...state.outbox.values()].find(row => row.publish_audit_id === second.auditId).status, "pending");
  await service.deliverSocialNotifications({ auditId: first.auditId, limit: 1 }); assert.equal(state.messages.length, 1);
});

test("expired leases recover, stale owners cannot ACK a replacement lease, and fifth attempt terminates", async () => {
  const { state, service, advance } = setup();
  await service.recordSocialSubmission(submission);
  const notification = [...state.outbox.values()][0];
  Object.assign(notification, { status: "sending", attempts: 1, lease_token: "dead-owner", lease_expires_at: utc(state.now - 1) });
  await service.deliverSocialNotifications({ limit: 1 }); assert.equal(notification.status, "sent");
  const second = await service.recordSocialSubmission(submission);
  const replacement = [...state.outbox.values()].find(row => row.publish_audit_id === second.auditId);
  state.beforeSend = () => { replacement.lease_token = "replacement-owner"; };
  const summary = await service.deliverSocialNotifications({ limit: 1 });
  assert.equal(replacement.status, "sending"); assert.equal(summary.sent, 0); assert.equal(summary.skipped, 1);
  state.beforeSend = null; replacement.attempts = 5; advance(600_000);
  await service.deliverSocialNotifications({ limit: 1 }); assert.equal(replacement.status, "failed");
});

test("retry delays are 60/300/900/3600 seconds, terminal on attempt five, and errors are masked", async () => {
  const { state, service, advance } = setup();
  await service.recordSocialSubmission(submission); state.deliveryError = new Error("https://hook.invalid/private secret=token");
  const notification = [...state.outbox.values()][0];
  for (const delay of [60, 300, 900, 3600]) {
    const summary = await service.deliverSocialNotifications({ limit: 1 });
    assert.equal(summary.failed, 1); assert.equal(notification.status, "pending");
    assert.equal(notification.next_attempt_at, utc(state.now + delay * 1000));
    assert.doesNotMatch(notification.last_error, /hook|private|token/); advance(delay * 1000);
  }
  await service.deliverSocialNotifications({ limit: 1 }); assert.equal(notification.status, "failed"); assert.equal(notification.attempts, 5);
  state.deliveryError = null; advance(86400_000); await service.deliverSocialNotifications(); assert.equal(state.messages.length, 0);
});

test("old owner paused before send cannot send after lease replacement has delivered", async () => {
  const { state, service, advance } = setup(); await service.recordSocialSubmission(submission);
  let releaseOldOwner;
  let reportPaused;
  const paused = new Promise(resolve => { reportPaused = resolve; });
  const resumeOldOwner = new Promise(resolve => { releaseOldOwner = resolve; });
  let pausedOnce = false;
  state.beforeReadConfig = async () => {
    if (pausedOnce) return;
    pausedOnce = true; reportPaused(); await resumeOldOwner;
  };
  const oldDelivery = service.deliverSocialNotifications({ limit: 1 });
  await paused; advance(600_000);
  const replacement = await service.deliverSocialNotifications({ limit: 1 });
  assert.equal(replacement.sent, 1); assert.equal(state.messages.length, 1);
  releaseOldOwner(); const oldSummary = await oldDelivery;
  assert.equal(oldSummary.sent, 0); assert.equal(oldSummary.skipped, 1); assert.equal(state.messages.length, 1);
});

test("changed destination version or disabled event permanently cancels queued delivery", async () => {
  for (const variant of ["version", "disabled", "event-disabled", "missing"]) {
    const { state, service } = setup(); await service.recordSocialSubmission(submission);
    if (variant === "version") state.config.version++;
    if (variant === "disabled") state.config.enabled = false;
    if (variant === "event-disabled") state.config.notifyDrafts = false;
    if (variant === "missing") state.config = null;
    await service.deliverSocialNotifications(); assert.equal([...state.outbox.values()][0].status, "cancelled");
    assert.equal(state.messages.length, 0);
  }
});

test("first verified PUBLISHED creates one event using immutable audit identity and real release URL; repeated polls are inert", async () => {
  const { state, service, advance } = setup(); const result = await service.recordSocialSubmission(submission);
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED", releaseUrl: "https://social.example.test/real-post", publishDate: "2026-10-14T11:59:00Z" });
  const summary = await service.processSocialNotifications();
  assert.equal(summary.confirmed, 1); assert.equal(state.messages.length, 2); assert.deepEqual(state.spacing, [1000]);
  assert.match(state.messages[1].text, /^\[Polaris\] 内容已发布/); assert.match(state.messages[1].text, /原申请人/);
  assert.match(state.messages[1].text, /https:\/\/social.example.test\/real-post/);
  assert.equal(state.audits.get(result.auditId).status, "drafted");
  advance(120_000); await service.processSocialNotifications(); assert.equal(state.outbox.size, 2); assert.equal(state.messages.length, 2);
  assert.equal(state.lock, null); assert.ok(state.health.lastWorkerAt);
});

test("published waits for pending draft, but proceeds after terminal draft failure or absent draft event", async () => {
  const { state, service } = setup(); await service.recordSocialSubmission(submission);
  state.deliveryError = new Error("synthetic");
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED" });
  await service.processSocialNotifications();
  const draft = [...state.outbox.values()].find(row => row.event_type === "draft_submitted");
  const published = [...state.outbox.values()].find(row => row.event_type === "published");
  assert.equal(draft.attempts, 1); assert.equal(published.attempts, 0);
  draft.status = "failed"; state.deliveryError = null;
  await service.deliverSocialNotifications(); assert.equal(published.status, "sent"); assert.match(state.messages[0].text, /确认时间/);
  const withoutDraft = setup(); withoutDraft.state.config.notifyDrafts = false;
  await withoutDraft.service.recordSocialSubmission(submission); withoutDraft.state.details = state.details;
  await withoutDraft.service.processSocialNotifications(); assert.equal(withoutDraft.state.messages.length, 1);
});

test("range includes submissions older than 32 days, missing/unknown/error post results never assert publication", async () => {
  for (const variant of ["missing", "unknown", "error", "mismatched-id"]) {
    const { state, service } = setup(); state.config.notifyDrafts = false;
    const result = await service.recordSocialSubmission(submission);
    const tracking = state.tracking.get(result.auditId); tracking.submitted_at = "2026-08-01 00:00:00.000";
    if (variant === "unknown") state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "ALIEN" });
    if (variant === "error") state.postizError = new Error("secret=https://api.invalid/key");
    if (variant === "mismatched-id") state.details.set(submission.postizPostId, { id: "invented-post", state: "PUBLISHED" });
    await service.processSocialNotifications();
    assert.ok(state.ranges[0].startDate <= new Date("2026-08-01T00:00:00Z"));
    assert.equal(state.ranges[0].endDate.toISOString(), "2026-10-15T12:00:00.000Z");
    assert.equal(state.outbox.size, 0); assert.equal(tracking.confirmed_at, null); assert.equal(tracking.check_attempts, 1);
    assert.ok(tracking.next_check_at > utc(state.now)); assert.doesNotMatch(tracking.last_error ?? "", /secret|api.invalid/);
  }
});

test("invalid release URL is omitted and worker lock failure skips all upstream operations", async () => {
  const { state, service } = setup(); state.config.notifyDrafts = false;
  await service.recordSocialSubmission(submission);
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED", releaseUrl: "javascript:alert(1)" });
  await service.processSocialNotifications(); assert.doesNotMatch(state.messages[0].text, /javascript/);
  const competing = setup(); competing.state.lockAllowed = false;
  const summary = await competing.service.processSocialNotifications(); assert.equal(summary.locked, true); assert.equal(competing.state.ranges.length, 0);
});

test("health-storage failure cannot convert a successful delivery into a retry or failed delivery count", async () => {
  const { state, service } = setup(); await service.recordSocialSubmission(submission);
  state.failure = "UPDATE workspace_feishu_config";
  const summary = await service.deliverSocialNotifications({ limit: 1 });
  assert.deepEqual(summary, { sent: 1, failed: 0, skipped: 0 });
  assert.equal([...state.outbox.values()][0].status, "sent"); assert.equal(state.messages.length, 1);
});

test("publication confirmation rolls back with outbox failure and later retry confirms old real posts once", async () => {
  const { state, service } = setup(); state.config.notifyDrafts = false;
  const result = await service.recordSocialSubmission(submission);
  state.tracking.get(result.auditId).submitted_at = "2026-08-01 00:01:00.000";
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED", publishDate: "2026-08-01T00:00:30Z" });
  state.failure = "INSERT INTO social_notification_outbox";
  const failed = await service.processSocialNotifications();
  assert.ok(failed.warning); assert.equal(state.lock, null); assert.equal(state.outbox.size, 0);
  assert.equal(state.tracking.get(result.auditId).confirmed_at, null);
  state.failure = null;
  const recovered = await service.processSocialNotifications();
  assert.equal(recovered.confirmed, 1); assert.equal(recovered.sent, 1); assert.equal(state.outbox.size, 1);
  assert.match(state.messages[0].text, /2026-08-01 00:00:30/);
});

test("verified DRAFT and QUEUE retain fixed sixty-second polling even after many checks", async () => {
  for (const postState of ["DRAFT", "QUEUE"]) {
    const { state, service, advance } = setup(); state.config.notifyDrafts = false;
    const result = await service.recordSocialSubmission(submission);
    const tracking = state.tracking.get(result.auditId); tracking.check_attempts = 12;
    state.details.set(submission.postizPostId, { id: submission.postizPostId, state: postState });
    for (let iteration = 0; iteration < 3; iteration++) {
      await service.processSocialNotifications();
      assert.equal(tracking.next_check_at, utc(state.now + 60_000)); assert.equal(tracking.last_error, null);
      advance(60_000);
    }
  }
});

test("worker stops starting tracking tasks with five seconds remaining in the forty-five-second budget", async () => {
  const { state, service, advance } = setup(); state.config.notifyDrafts = false;
  const first = await service.recordSocialSubmission(submission);
  const second = await service.recordSocialSubmission({ ...submission, postizPostId: "real-post-two" });
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "DRAFT" });
  state.details.set("real-post-two", { id: "real-post-two", state: "QUEUE" });
  state.beforeFetchDetails = () => advance(39_000);
  state.beforeQuery = statement => { if (statement.startsWith("UPDATE social_post_tracking SET state=")) advance(1000); };
  const summary = await service.processSocialNotifications();
  assert.equal(summary.checked, 1); assert.equal(state.tracking.get(first.auditId).check_attempts, 1);
  assert.equal(state.tracking.get(second.auditId).check_attempts, 0); assert.equal(state.lock, null);
  assert.ok(state.health.lastWorkerAt);
});

test("worker budget also stops delivery between sends without claiming remaining notifications", async () => {
  const { state, service, advance } = setup(); state.config.notifyPublished = false;
  await service.recordSocialSubmission(submission); await service.recordSocialSubmission(submission);
  state.beforeQuery = statement => {
    if (statement.startsWith("UPDATE social_post_tracking") && statement.includes("notify_published=0")) advance(39_000);
  };
  state.beforeSend = () => advance(1000);
  const summary = await service.processSocialNotifications();
  assert.equal(summary.sent, 1); assert.equal(state.messages.length, 1);
  assert.equal([...state.outbox.values()].filter(row => row.status === "pending" && row.attempts === 0).length, 1);
  assert.equal(state.lock, null);
});

test("query lower boundary is exactly oldest submission minus one day and missing release URL uses management entry", async () => {
  const { state, service } = setup(); state.config.notifyDrafts = false;
  const result = await service.recordSocialSubmission(submission);
  state.tracking.get(result.auditId).submitted_at = "2026-08-01 00:01:00.000";
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED" });
  await service.processSocialNotifications();
  assert.equal(state.ranges[0].startDate.toISOString(), "2026-07-31T00:01:00.000Z");
  assert.match(state.messages[0].text, /管理入口：https:\/\/postiz.example.test/);
  assert.doesNotMatch(state.messages[0].text, /发布链接：|\/posts\/|real-post-one/);
});

test("worker eligibility update uses current V2 config and never retires a new V2 submission from its old V1 snapshot", async () => {
  const { state, service } = setup(); state.config.notifyDrafts = false;
  const historical = await service.recordSocialSubmission(submission);
  let newAuditId;
  let changedConfig = false;
  state.beforeQuery = async statement => {
    if (!statement.startsWith("UPDATE social_post_tracking") || !statement.includes("notify_published=0") || changedConfig) return;
    changedConfig = true; state.config.version = 2;
    newAuditId = (await service.recordSocialSubmission({ ...submission, postizPostId: "real-v2-post" })).auditId;
    state.details.set("real-v2-post", { id: "real-v2-post", state: "PUBLISHED" });
  };
  const summary = await service.processSocialNotifications();
  assert.equal(state.tracking.get(historical.auditId).notify_published, 0);
  assert.equal(state.tracking.get(newAuditId).notify_published, 1);
  assert.ok(state.tracking.get(newAuditId).confirmed_at); assert.equal(summary.sent, 1);
  assert.equal([...state.outbox.values()].find(row => row.publish_audit_id === newAuditId).config_version, 2);
});

test("disabled or missing notifications still confirm real published facts without generating events", async () => {
  for (const variant of ["disabled", "missing", "event-disabled"]) {
    const { state, service } = setup();
    if (variant === "disabled") state.config.enabled = false;
    if (variant === "missing") state.config = null;
    if (variant === "event-disabled") { state.config.notifyDrafts = false; state.config.notifyPublished = false; }
    const result = await service.recordSocialSubmission(submission);
    state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED", releaseUrl: "https://social.example.test/real" });
    const summary = await service.processSocialNotifications();
    const tracking = state.tracking.get(result.auditId);
    assert.equal(summary.confirmed, 1); assert.equal(tracking.state, "PUBLISHED"); assert.ok(tracking.confirmed_at);
    assert.equal(tracking.release_url, "https://social.example.test/real");
    assert.equal(state.outbox.size, 0); assert.equal(state.messages.length, 0);
    assert.equal(state.audits.get(result.auditId).status, "drafted");
  }
});

test("eligibility SQL failure preserves subscription and safely retries instead of clearing it", async () => {
  const { state, service } = setup(); state.config.notifyDrafts = false;
  const result = await service.recordSocialSubmission(submission);
  state.failure = "UPDATE social_post_tracking";
  const summary = await service.processSocialNotifications();
  assert.ok(summary.warning); assert.doesNotMatch(summary.warning, /secret|credentials|hook/);
  assert.equal(state.tracking.get(result.auditId).notify_published, 1); assert.equal(state.lock, null);
  state.failure = null;
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED" });
  assert.equal((await service.processSocialNotifications()).sent, 1);
});

test("fifth claim deferred before send returns attempt and preserves error so next worker can send draft then published", async () => {
  const { state, service, advance } = setup(); await service.recordSocialSubmission(submission);
  const draft = [...state.outbox.values()][0];
  draft.attempts = 4; draft.last_error = "Existing sanitized failure";
  state.details.set(submission.postizPostId, { id: submission.postizPostId, state: "PUBLISHED" });
  state.beforeReadConfig = () => advance(40_000);
  const deferred = await service.processSocialNotifications();
  assert.equal(deferred.skipped, 1); assert.equal(deferred.failed, 0); assert.equal(state.messages.length, 0);
  assert.equal(draft.status, "pending"); assert.equal(draft.attempts, 4);
  assert.equal(draft.next_attempt_at, utc(state.now + 60_000)); assert.equal(draft.last_error, "Existing sanitized failure");
  assert.equal(draft.lease_token, null); assert.equal(draft.lease_expires_at, null);
  state.beforeReadConfig = null; advance(60_000);
  const delivered = await service.processSocialNotifications();
  assert.equal(delivered.sent, 2); assert.equal(draft.status, "sent"); assert.equal(draft.attempts, 5);
  assert.equal([...state.outbox.values()].find(row => row.event_type === "published").status, "sent");
});

test("deadline deferral by an obsolete owner cannot return the replacement owner's attempt or lease", async () => {
  const { state, service, advance } = setup(); state.config.notifyPublished = false;
  await service.recordSocialSubmission(submission);
  const draft = [...state.outbox.values()][0]; draft.attempts = 4;
  state.beforeReadConfig = () => advance(40_000);
  state.beforeQuery = statement => {
    if (statement.includes("attempts=GREATEST(attempts-1,0)")) draft.lease_token = "replacement-owner";
  };
  const summary = await service.processSocialNotifications();
  assert.equal(summary.skipped, 1); assert.equal(state.messages.length, 0);
  assert.equal(draft.status, "sending"); assert.equal(draft.attempts, 5); assert.equal(draft.lease_token, "replacement-owner");
});
