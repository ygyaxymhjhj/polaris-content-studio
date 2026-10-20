import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import typescript from "typescript";

function createScheduler(environment = {}, configured = true) {
  const timers = new Map();
  const processMock = new EventEmitter();
  processMock.env = { NODE_ENV: "production", NEXT_RUNTIME: "nodejs", ...environment };
  let implementation = async () => 0;
  const context = vm.createContext({
    process: processMock,
    console: { warn() {} },
    setTimeout(callback, milliseconds) {
      const handle = { unref() {} };
      timers.set(handle, { callback, milliseconds });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); }
  });
  const source = readFileSync(new URL("../src/lib/draft-submission-scheduler.ts", import.meta.url), "utf8");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  }).outputText;
  const exports = {};
  const dependencies = {
    "./draft-submissions": { processDraftSubmissions: size => implementation(size) },
    "./project-db": { databaseConfigured: () => configured }
  };
  vm.runInContext(`(function(require, exports) { ${compiled}\n })`, context)(specifier => dependencies[specifier], exports);
  return { exports, timers, processMock, setImplementation(callback) { implementation = callback; } };
}

test("overlapping wakeups share one drain and process more than a single batch", async () => {
  const fixture = createScheduler({ DRAFT_SUBMISSIONS_SCHEDULER_ENABLED: "false" });
  let releaseFirstBatch;
  const firstBatch = new Promise(resolve => { releaseFirstBatch = resolve; });
  let remaining = 12;
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  fixture.setImplementation(async size => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    calls += 1;
    if (calls === 1) await firstBatch;
    const processed = Math.min(size, remaining);
    remaining -= processed;
    active -= 1;
    return processed;
  });
  const firstWakeup = fixture.exports.wakeDraftSubmissionWorker();
  const wakeups = Array.from({ length: 12 }, () => fixture.exports.wakeDraftSubmissionWorker());
  assert(wakeups.every(promise => promise === firstWakeup), "every after callback waits for the same running drain");
  releaseFirstBatch();
  await Promise.all(wakeups);
  assert.equal(remaining, 0, "accepted tasks are not stranded after the first four");
  assert.equal(calls, 4, "the final empty read confirms the queue is drained");
  assert.equal(maximumActive, 1);
  assert.equal(fixture.timers.size, 0, "draining does not depend on a periodic scheduler");
});

test("a wakeup arriving during the final empty read is not lost", async () => {
  const fixture = createScheduler();
  let finishEmptyRead;
  let calls = 0;
  fixture.setImplementation(() => {
    calls += 1;
    return calls === 1 ? new Promise(resolve => { finishEmptyRead = resolve; }) : Promise.resolve(0);
  });
  const pending = fixture.exports.wakeDraftSubmissionWorker();
  fixture.exports.wakeDraftSubmissionWorker();
  finishEmptyRead(0);
  await pending;
  assert.equal(calls, 2);
});

for (const [description, environment, configured] of [
  ["development", { NODE_ENV: "development" }, true],
  ["tests", { NODE_ENV: "test" }, true],
  ["explicit disable", { DRAFT_SUBMISSIONS_SCHEDULER_ENABLED: "false" }, true],
  ["build", { NEXT_PHASE: "phase-production-build" }, true],
  ["edge", { NEXT_RUNTIME: "edge" }, true],
  ["serverless", { VERCEL: "1" }, true],
  ["unconfigured database", {}, false]
]) {
  test(`periodic draft processing refuses ${description}`, () => {
    const fixture = createScheduler(environment, configured);
    fixture.exports.startDraftSubmissionScheduler();
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.processMock.listenerCount("SIGTERM"), 0);
  });
}

test("production starts independently from notifications and developer opt-in is explicit", () => {
  for (const environment of [{ SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "false" },
    { NODE_ENV: "development", DRAFT_SUBMISSIONS_SCHEDULER_ENABLED: "true" }]) {
    const fixture = createScheduler(environment);
    fixture.exports.startDraftSubmissionScheduler();
    fixture.exports.startDraftSubmissionScheduler();
    assert.equal(fixture.timers.size, 1);
    assert.equal(fixture.processMock.listenerCount("SIGTERM"), 1);
    fixture.processMock.emit("SIGTERM");
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.processMock.listenerCount("SIGTERM"), 0);
  }
});

test("an AI enqueue reads its committed result without requesting a second pooled connection", async () => {
  const source = readFileSync(new URL("../src/lib/draft-submissions.ts", import.meta.url), "utf8");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  }).outputText;
  let checkedOut = false;
  let inserted;
  const execute = async (statement, parameters = []) => {
    if (statement.startsWith("SELECT id FROM users")) return [[{ id: "owner" }]];
    if (statement.includes("request_key=? OR active_key=?")) return [[]];
    if (statement.includes("INSERT INTO draft_submissions")) {
      inserted = {
        id: parameters[0], owner_user_id: parameters[1], kind: parameters[2], source_id: parameters[3],
        project_id: parameters[4], integration_id: parameters[5], state: "queued", audit_id: null,
        postiz_post_id: null, warning: null, error: null, created_at: parameters[11], updated_at: parameters[12], finished_at: null
      };
      return [{ affectedRows: 1 }];
    }
    if (statement.includes("FROM draft_submissions")) return [[inserted]];
    throw new Error(`Unexpected SQL: ${statement}`);
  };
  const pool = {
    execute: async (...parameters) => {
      assert.equal(checkedOut, false, "a saturated pool cannot supply another connection for readback");
      return execute(...parameters);
    },
    getConnection: async () => {
      checkedOut = true;
      return { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() { checkedOut = false; } };
    }
  };
  const { createRequire } = await import("node:module");
  const nativeRequire = createRequire(import.meta.url);
  const dependencies = {
    "@/lib/project-db": { database: () => pool },
    "@/lib/auth": { ownerHashFor: () => "owner-hash" },
    "@/lib/social-accounts": { getSocialAccount: async () => ({ ownerUserId: "owner", provider: "x", accountName: "Account" }) },
    "@/lib/post-submission": {},
    "@/lib/posts": { databaseEpoch: value => Date.parse(`${value.replace(" ", "T")}Z`) },
    "@/lib/postiz": {}, "@/lib/social-notifications": {}
  };
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(specifier => dependencies[specifier] ?? nativeRequire(specifier), compiledModule, compiledModule.exports);
  const result = await compiledModule.exports.enqueueAssetSubmission({
    userId: "owner", isAdmin: false, assetId: "asset", integrationId: "account", content: "News update",
    requestId: "11111111-1111-4111-8111-111111111111"
  });
  assert.equal(result.kind, "queued");
  assert.equal(result.task.state, "queued");
  assert.equal(checkedOut, false);
});
