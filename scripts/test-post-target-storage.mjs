// Exercise the real storage entry points and validate their emitted target INSERT statements.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import typescript from "typescript";

const nativeRequire = createRequire(import.meta.url);

function loadModule(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const { outputText } = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
  });
  const compiledModule = { exports: {} };
  new Function("require", "module", "exports", outputText)(
    dependency => dependencies[dependency] ?? nativeRequire(dependency), compiledModule, compiledModule.exports
  );
  return compiledModule.exports;
}

const postTypes = loadModule("../src/lib/post-types.ts");
const postId = "11111111-1111-4111-8111-111111111111";

function createStorageHarness(expectedTargets) {
  const targetInserts = [];
  let commits = 0;
  const execute = async (statement, parameters = []) => {
    if (statement.includes("INSERT INTO post_targets")) {
      targetInserts.push({ statement, parameters });
      const columns = statement.match(/INSERT INTO post_targets\s*\(([^)]+)\)/)[1].split(",").map(column => column.trim());
      const valueClause = statement.split(/\bVALUES\s+/)[1].split("ON DUPLICATE KEY")[0];
      const tuples = [...valueClause.matchAll(/\(([^)]+)\)/g)];
      assert.equal(tuples.length, expectedTargets.length);
      for (const tuple of tuples) {
        assert.equal(tuple[1].split(",").length, columns.length, "each target row must supply one value per INSERT column");
      }
      assert.equal((valueClause.match(/\?/g) || []).length, parameters.length, "placeholder count must match bound parameters");
      for (const [targetIndex, target] of expectedTargets.entries()) {
        const row = Object.fromEntries(columns.map((column, columnIndex) => [column, parameters[targetIndex * columns.length + columnIndex]]));
        assert.match(row.id, /^[a-f0-9-]{36}$/i);
        assert.equal(row.integration_id, target.integrationId);
        assert.equal(row.platform, target.platform);
        assert.equal(row.account_name, target.accountName);
        assert.equal(row.status, "not_started");
        assert.ok(row.post_id);
        assert.ok(row.created_at);
        assert.equal(row.created_at, row.updated_at);
      }
      assert.equal(new Set(parameters.filter((_, index) => index % columns.length === 0)).size, expectedTargets.length);
      return [{ affectedRows: expectedTargets.length }];
    }
    if (statement.startsWith("SELECT t.integration_id")) return [[]];
    if (statement.startsWith("SELECT id")) return [[{
      id: postId, title: "", content: "Draft", version: 1,
      created_at: "2026-10-16 10:00:00.000", updated_at: "2026-10-16 10:00:00.000"
    }]];
    if (/^(INSERT INTO posts|UPDATE posts|DELETE FROM post_targets)/.test(statement.trim())) return [{ affectedRows: 1 }];
    throw new Error(`Unexpected SQL: ${statement}`);
  };
  const connection = {
    execute, beginTransaction: async () => {}, rollback: async () => {}, release: () => {},
    commit: async () => { commits += 1; }
  };
  const storage = loadModule("../src/lib/posts.ts", {
    "@/lib/project-db": { database: () => ({ execute, getConnection: async () => connection }) },
    "./post-types": postTypes
  });
  return { storage, targetInserts, getCommits: () => commits };
}

for (const targetCount of [0, 1, 3]) {
  const targets = Array.from({ length: targetCount }, (_, index) => ({
    integrationId: `account-${index}`, platform: "x", accountName: `Account ${index}`
  }));
  test(`createManualPost binds all eight target columns for ${targetCount} accounts`, async () => {
    const harness = createStorageHarness(targets);
    await harness.storage.createManualPost("owner-one", { title: "", content: "Draft", image: null, targets });
    assert.equal(harness.targetInserts.length, targetCount ? 1 : 0);
    assert.equal(harness.getCommits(), 1);
  });
  test(`updateManualPost binds all eight target columns for ${targetCount} accounts`, async () => {
    const harness = createStorageHarness(targets);
    const result = await harness.storage.updateManualPost("owner-one", postId, 1, { targets });
    assert.equal(result.kind, "ok");
    assert.equal(harness.targetInserts.length, targetCount ? 1 : 0);
    assert.equal(harness.getCommits(), 1);
  });
}

test("the list exposes deletion for local drafts and protects every frozen target state", async () => {
  const records = [
    { id: "local", status: "draft", accepted_count: 0, submitting_count: 0, unsettled_count: 0, unknown_count: 0 },
    { id: "failed", status: "attention", accepted_count: 0, submitting_count: 0, unsettled_count: 1, unknown_count: 0 },
    { id: "accepted", status: "pushed", accepted_count: 1, submitting_count: 0, unsettled_count: 0, unknown_count: 0 },
    { id: "rejected", status: "attention", accepted_count: 0, rejected_count: 1, submitting_count: 0, unsettled_count: 1, unknown_count: 0 },
    { id: "submitting", status: "pushing", accepted_count: 0, submitting_count: 1, unsettled_count: 0, unknown_count: 0 },
    { id: "unknown", status: "attention", accepted_count: 0, submitting_count: 0, unsettled_count: 1, unknown_count: 1 }
  ];
  const execute = async statement => {
    if (statement.includes("SELECT status, COUNT(*) AS total")) return [[]];
    const projection = statement.match(/SELECT r\.id,([\s\S]+?)FROM post_status r/);
    assert.ok(projection, "exercise the actual list query");
    const selectedColumns = ["r.id", ...projection[1].split(",")].map(column => column.trim().replace(/^r\./, ""));
    // Match SQL projection semantics: absent SELECT columns must not appear in returned rows.
    return [records.map(record => Object.fromEntries(selectedColumns.map(column => [column, record[column]])))];
  };
  const storage = loadModule("../src/lib/posts.ts", {
    "@/lib/project-db": { database: () => ({ execute }) },
    "./post-types": postTypes
  });
  const result = await storage.listManualPosts("owner-one", {
    status: "all", search: "", platform: "", integrationId: "", updatedSince: 0, page: 1, perPage: 20
  });
  assert.deepEqual(result.items.map(post => [post.id, post.editable, post.deletable]), [
    ["local", true, true], ["failed", true, true], ["accepted", false, false],
    ["rejected", false, false], ["submitting", false, false], ["unknown", false, false]
  ]);
});
