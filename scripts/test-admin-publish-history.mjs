// Run the route with an isolated SQL fixture and UTC-agnostic timestamp assertions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);
const { NextResponse } = nativeRequire("next/server");
const { outputText } = typescript.transpileModule(readFileSync(new URL("../src/app/api/admin/publishes/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
});
const timestamp = "2026-11-10 09:00:00.000";
const publishedAt = "2026-11-10 10:00:00.000";
const scheduledAt = "2026-11-10 11:00:00.000";

function harness(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE social_publishes (id TEXT PRIMARY KEY, project_id TEXT, asset_id TEXT NOT NULL, platform TEXT NOT NULL,
      integration_id TEXT NOT NULL, account_name TEXT NOT NULL, published_by TEXT NOT NULL, published_by_name TEXT NOT NULL,
      status TEXT NOT NULL, postiz_post_id TEXT COLLATE NOCASE, created_at TEXT NOT NULL, scheduled_at TEXT,
      content_preview TEXT, published_url TEXT, error TEXT);
    CREATE TABLE social_post_tracking (publish_audit_id TEXT PRIMARY KEY, postiz_post_id TEXT, state TEXT, review_status TEXT,
      postiz_publish_date TEXT, confirmed_at TEXT, last_checked_at TEXT, rejected_detected_at TEXT, release_url TEXT, last_error TEXT);
    CREATE TABLE draft_submissions (audit_id TEXT, kind TEXT, owner_user_id TEXT, project_id TEXT, source_id TEXT, integration_id TEXT,
      snapshot TEXT, error TEXT);
  `);
  const state = { auth: { user: { role: "admin" } }, queries: 0, fail: false };
  const compiled = { exports: {} };
  const deps = {
    "next/server": { NextResponse },
    "@/lib/auth": {
      currentUser: async () => state.auth,
      unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401, headers: { "Cache-Control": "no-store" } })
    },
    "@/lib/project-db": { database: () => ({ execute: async (statement, params) => {
      state.queries++;
      if (state.fail) throw new Error("database error with PRIVATE DATA");
      // SQLite equivalents for MySQL null-safe equality and byte-for-byte comparison.
      return [db.prepare(statement.replaceAll("<=>", "IS").replaceAll("AS BINARY)", "AS BLOB)")).all(...params)];
    } }) }
  };
  new Function("require", "module", "exports", "console", outputText)(
    (dependency) => deps[dependency], compiled, compiled.exports, { error() {} }
  );
  return {
    state,
    addAudit(id, { project = null, asset = "ai-x-1", status = "drafted", created = timestamp, scheduled = null } = {}) {
      db.prepare("INSERT INTO social_publishes VALUES (?, ?, ?, 'x', 'channel-1', 'Account One', 'user-1', 'Member One', ?, ?, ?, ?, 'PRIVATE CONTENT', 'https://private.test/project', 'PRIVATE ERROR')")
        .run(id, project, asset, status, `upstream-${id}`, created, scheduled);
    },
    addTracking(id, { upstream = `upstream-${id}`, state = "DRAFT", review = "pending", date = null, confirmed = null, rejected = null } = {}) {
      db.prepare("INSERT INTO social_post_tracking VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'https://private.test/release', 'PRIVATE TRACKING ERROR')")
        .run(id, upstream, state, review, date, confirmed, timestamp, rejected);
    },
    addTask(id, { kind = "asset", project = null, asset = "ai-x-1", owner = "user-1", integration = "channel-1" } = {}) {
      db.prepare("INSERT INTO draft_submissions VALUES (?, ?, ?, ?, ?, ?, 'PRIVATE SNAPSHOT', 'PRIVATE TASK ERROR')").run(id, kind, owner, project, asset, integration);
    },
    async get(search = "") {
      const response = await compiled.exports.GET(new Request(`https://studio.test/api/admin/publishes${search}`));
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      return { status: response.status, body: await response.json() };
    }
  };
}

test("requires an authenticated administrator before reading audits", async (t) => {
  const { state, get } = harness(t);
  state.auth = null;
  assert.equal((await get()).status, 401);
  state.auth = { user: { role: "member" } };
  assert.equal((await get()).status, 403);
  assert.equal(state.queries, 0);
});

test("uses bound asset tasks and known legacy sources, excluding manual and ambiguous audits", async (t) => {
  const { addAudit, addTask, get } = harness(t);
  addAudit("new-unlinked-ai", { asset: "unlinked-custom-asset" });
  addTask("new-unlinked-ai", { asset: "unlinked-custom-asset" });
  addAudit("legacy-project", { project: "private-project", asset: "old-asset" });
  addAudit("legacy-local", { asset: "local-x" });
  addAudit("legacy-ai", { asset: "ai-x-1" });
  addAudit("legacy-fallback", { asset: "fallback-x-1-aaaaa" });
  addAudit("manual", { asset: "6ca907ab-2241-491f-801c-3fecf1839a08" });
  addTask("manual", { kind: "manual", asset: "6ca907ab-2241-491f-801c-3fecf1839a08" });
  addAudit("legacy-deleted-manual", { asset: "6ca907ab-2241-491f-801c-3fecf1839a07", status: "failed" });
  addAudit("conflicting-manual", { project: "inconsistent-project-id", asset: "ai-x-1" });
  addTask("conflicting-manual", { kind: "manual" });
  addAudit("ambiguous", { asset: "custom-old-asset" });
  addTask("ambiguous", { asset: "custom-old-asset", owner: "wrong-owner" });
  addAudit("ambiguous-target", { asset: "custom-old-asset" });
  addTask("ambiguous-target", { asset: "custom-old-asset", integration: "wrong-channel" });
  const { status, body } = await get();
  assert.equal(status, 200);
  assert.deepEqual(body.publishes.map(({ id }) => id), ["new-unlinked-ai", "legacy-project", "legacy-local", "legacy-fallback", "legacy-ai"]);
  assert.equal(body.hasNext, false);
});

test("shows only bound tracking status and safe details; reports times in UTC", async (t) => {
  const { addAudit, addTracking, get } = harness(t);
  addAudit("published", { project: "private-project", status: "queued", scheduled: scheduledAt });
  addTracking("published", { state: "PUBLISHED", date: publishedAt, confirmed: scheduledAt });
  addAudit("pending");
  addTracking("pending");
  addAudit("rejected");
  addTracking("rejected", { review: "rejected", rejected: publishedAt });
  addAudit("queued");
  addTracking("queued", { state: "QUEUE", review: "rejected", rejected: publishedAt });
  addAudit("publishing-failed");
  addTracking("publishing-failed", { state: "ERROR", date: publishedAt });
  addAudit("submit-failed", { status: "failed" });
  addAudit("case-mismatch");
  addTracking("case-mismatch", { upstream: "UPSTREAM-case-mismatch", state: "PUBLISHED", date: publishedAt });
  addAudit("id-mismatch");
  addTracking("unrelated-audit", { upstream: "upstream-id-mismatch", state: "ERROR" });
  addAudit("legacy-published", { status: "published" });
  const { body } = await get();
  const byId = Object.fromEntries(body.publishes.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId.published, {
    id: "published", submitter: "Member One", accountName: "Account One", platform: "x", status: "published",
    attemptedAt: "2026-11-10T09:00:00.000Z", scheduledAt: "2026-11-10T11:00:00.000Z", publishedAt: "2026-11-10T10:00:00.000Z",
    rejectedAt: null, lastCheckedAt: "2026-11-10T09:00:00.000Z", errorCode: null
  });
  assert.equal(byId.pending.status, "pending_review");
  assert.equal(byId.rejected.status, "rejected");
  assert.equal(byId.rejected.rejectedAt, "2026-11-10T10:00:00.000Z");
  assert.equal(byId.queued.status, "queued");
  assert.equal(byId.queued.rejectedAt, null);
  assert.equal(byId["publishing-failed"].status, "failed");
  assert.equal(byId["publishing-failed"].errorCode, "publishing_failed");
  assert.equal(byId["publishing-failed"].publishedAt, null);
  assert.equal(byId["submit-failed"].errorCode, "submission_failed");
  assert.equal(byId["case-mismatch"].status, "drafted");
  assert.equal(byId["id-mismatch"].status, "drafted");
  assert.equal(byId["legacy-published"].status, "published");
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE|private\.test|private-project|upstream-/);
});

test("paginates a stable newest-first order, including timestamp ties", async (t) => {
  const { addAudit, get } = harness(t);
  addAudit("c", { created: "2026-11-09 09:00:00.000" });
  addAudit("a");
  addAudit("b");
  const first = (await get("?page=1&perPage=2")).body;
  const second = (await get("?page=2&perPage=2")).body;
  const third = (await get("?page=3&perPage=2")).body;
  assert.deepEqual(first.publishes.map(({ id }) => id), ["b", "a"]);
  assert.equal(first.hasNext, true);
  assert.deepEqual(second.publishes.map(({ id }) => id), ["c"]);
  assert.equal(second.hasNext, false);
  assert.deepEqual(third, { publishes: [], hasNext: false });
});

test("rejects unsafe paging and hides database error details", async (t) => {
  const { state, get } = harness(t);
  for (const search of ["?page=0", "?page=1.5", "?page=2oops", "?page=999999999999999999", "?perPage=51"]) {
    assert.equal((await get(search)).status, 400);
  }
  assert.equal(state.queries, 0);
  state.fail = true;
  assert.deepEqual(await get(), { status: 503, body: { error: "Could not load AI publish history." } });
});
