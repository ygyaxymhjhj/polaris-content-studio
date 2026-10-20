import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "polaris-review-"));
const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error("Real network calls are forbidden in this test"); };
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX };
const compile = source => ts.transpileModule(source, { compilerOptions }).outputText;
try {
  await fs.symlink(path.join(process.cwd(), "node_modules"), path.join(temporaryDirectory, "node_modules"), "dir");
  for (const filename of ["types.ts", "submission-status.ts", "draft-submission-types.ts", "draft-submission-client.ts", "image-upload.ts", "project-schema.ts", "i18n.tsx"]) {
    const source = await fs.readFile(`src/lib/${filename}`, "utf8");
    await fs.writeFile(path.join(temporaryDirectory, filename.replace(/\.tsx?$/, ".js")), compile(source));
  }
  const helpers = require(path.join(temporaryDirectory, "submission-status.js"));
  const { mergeSubmissionStatus, markSubmissionSucceeded, getSubmissionBindingKey, getPublishBadge, getAssetStatusFields, shouldPollSubmission } = helpers;
  const { parseSnapshot } = require(path.join(temporaryDirectory, "project-schema.js"));
  const { translate, LocaleContext } = require(path.join(temporaryDirectory, "i18n.js"));
  const { mergeDraftTask } = require(path.join(temporaryDirectory, "draft-submission-client.js"));
  const { isDraftSubmissionTask } = require(path.join(temporaryDirectory, "draft-submission-types.js"));
  const submittedAt = "2026-10-14T12:00:00.000Z";
  const detectedAt = "2026-10-15T12:00:00.000Z";
  const asset = {
    id: "asset-1", platform: "facebook", assetType: "short_post", title: "Original title", content: "Original copy",
    imageUrl: "https://example.invalid/image.png", meta: { notes: "Keep notes" }, factIds: ["fact-1"], riskFlags: [],
    updatedAt: submittedAt, revisions: [], publishStatus: "drafted", reviewStatus: "pending", targetAccountId: "account-1",
    submission: { auditId: "audit-new", postId: "post-new", submittedAt }
  };
  const rejection = {
    auditId: "audit-new", postId: "post-new", assetId: asset.id, integrationId: "account-1",
    publishStatus: "drafted", reviewStatus: "rejected", rejectedDetectedAt: detectedAt, submittedAt,
    postizState: "DRAFT", saveAction: "pass", publishedUrl: null, publishedAt: null
  };
  const rejected = mergeSubmissionStatus(asset, asset, [rejection]);
  assert.equal(rejected.publishStatus, "drafted", "Rejection is not a publication error");
  assert.equal(getPublishBadge(rejected).label, "Review rejected");
  assert.equal(rejected.rejectedDetectedAt, detectedAt);
  assert.equal(rejected.publishedAt, undefined, "Detection/submission time is not publication time");
  for (const malformed of [null, {}, { ...rejection, reviewStatus: "approved" }, { ...rejection, submittedAt: undefined },
    { ...rejection, submittedAt: "invalid" }, { ...rejection, publishStatus: "deleted" },
    { ...rejection, integrationId: 42 }, { ...rejection, rejectedDetectedAt: {} }, { ...rejection, postId: undefined }]) {
    assert.strictEqual(mergeSubmissionStatus(rejected, rejected, [malformed]), rejected, "Malformed snapshots never clear known rejection or corrupt persisted bindings");
  }
  for (const key of ["title", "content", "imageUrl", "meta", "factIds", "riskFlags", "updatedAt", "revisions"]) {
    assert.strictEqual(rejected[key], asset[key], `Polling preserves ${key}`);
  }
  assert.strictEqual(mergeSubmissionStatus(rejected, rejected, [rejection]), rejected, "Unchanged facts do not dirty the snapshot");
  const olderHistory = Array.from({ length: 70 }, (_, index) => ({ ...rejection, auditId: `old-${index}`, postId: `post-${index}`, publishStatus: "published" }));
  assert.strictEqual(mergeSubmissionStatus(asset, asset, olderHistory), asset, "Older published rows cannot replace the bound draft");
  assert.strictEqual(mergeSubmissionStatus(asset, asset, [{ ...rejection, postId: "other-post" }]), asset);
  assert.strictEqual(mergeSubmissionStatus(asset, asset, [{ ...rejection, assetId: "other-asset" }]), asset);
  for (const publishStatus of ["publishing", "failed"]) {
    const current = { ...asset, publishStatus };
    assert.strictEqual(mergeSubmissionStatus(current, asset, [rejection]), current, "An old response cannot overwrite a new attempt");
    assert.notEqual(getPublishBadge({ ...current, reviewStatus: "rejected" }).label, "Review rejected");
  }
  for (const [publishStatus, label] of [["drafted", "Pending review"], ["queued", "Scheduled"], ["published", "Published"], ["unpublished", "Unpublished"]]) {
    assert.equal(getPublishBadge({ publishStatus, reviewStatus: "unknown" }).label, label);
  }
  assert.equal(getPublishBadge({ publishStatus: "published", reviewStatus: "rejected" }).label, "Published");
  const legacy = { ...asset, submission: undefined };
  assert.strictEqual(mergeSubmissionStatus(legacy, legacy, [{ ...rejection, integrationId: "other-account" }]), legacy);
  const boundLegacy = mergeSubmissionStatus(legacy, legacy, [rejection]);
  assert.equal(boundLegacy.submission.auditId, rejection.auditId);
  assert.strictEqual(mergeSubmissionStatus(boundLegacy, legacy, [rejection]), boundLegacy, "Legacy fallback stops immediately after binding");
  const retry = markSubmissionSucceeded({ ...rejected, publishedUrl: "old-url", publishError: "old-error" }, { auditId: "audit-retry", postId: "post-retry", publishedAt: detectedAt }, "account-1");
  assert.equal(retry.reviewStatus, "pending");
  assert.equal(retry.rejectedDetectedAt, undefined);
  assert.equal(retry.publishError, undefined);
  assert.equal(retry.publishedUrl, undefined);
  assert.equal(retry.submission.submittedAt, detectedAt);
  assert.notEqual(getSubmissionBindingKey(retry), getSubmissionBindingKey(rejected));
  assert.strictEqual(mergeSubmissionStatus(retry, rejected, [rejection]), retry, "A new binding invalidates an old response");
  const untracked = markSubmissionSucceeded(rejected, { auditId: null, publishedAt: detectedAt }, "account-1");
  assert.deepEqual(untracked.submission, { auditId: null, postId: null, submittedAt: detectedAt });
  assert.equal(shouldPollSubmission(untracked), false);
  assert.strictEqual(mergeSubmissionStatus(untracked, untracked, [rejection]), untracked, "Null audit id never falls back to an older submission");
  for (const tracked of [asset, rejected, legacy, { ...legacy, publishStatus: "published" }, { ...asset, publishStatus: "published", reviewStatus: "unknown" }, { ...legacy, publishStatus: "queued" }]) {
    assert.equal(shouldPollSubmission(tracked), true, "Restored pending, rejected, queued and old posted assets are queried");
  }
  const published = mergeSubmissionStatus(rejected, rejected, [{ ...rejection, publishStatus: "published", reviewStatus: "unknown", publishedAt: detectedAt, publishedUrl: "https://example.invalid/post", rejectedDetectedAt: null }]);
  assert.equal(published.publishStatus, "published");
  assert.equal(published.rejectedDetectedAt, undefined);
  assert.equal(published.publishedAt, detectedAt);

  const config = { name: "Test", title: "Article", category: "", language: "en", audience: "", cta: "", websiteUrl: "", sourceUrl: "", tone: "", publishDate: "" };
  const snapshot = { schemaVersion: 1, config, sourceText: "Source", sourceName: "Source", sourcePending: false, importedSource: null, editedConfig: [], analysis: null, assets: [legacy], selectedPlatforms: ["facebook"], threads: {}, usedFallback: false, generationRun: "run-1" };
  const oldAsset = { ...legacy };
  delete oldAsset.submission;
  delete oldAsset.reviewStatus;
  assert.equal(parseSnapshot({ ...snapshot, assets: [oldAsset] }).assets[0].reviewStatus, undefined);
  for (const savedAsset of [rejected, retry, untracked, { ...untracked, submission: { ...untracked.submission, postId: "untracked-post" } }]) {
    const roundTrip = parseSnapshot(JSON.parse(JSON.stringify({ ...snapshot, assets: [savedAsset] })));
    assert.deepEqual(roundTrip.assets[0], JSON.parse(JSON.stringify(savedAsset)));
  }
  console.log("PASS: pure status merging, precise binding, retry/null tracking, old/new snapshot round trips");

  // Execute actual component functions/effect callbacks, rather than restating their implementation.
  const studioSource = await fs.readFile("src/components/ContentStudio.tsx", "utf8");
  const studioTree = ts.createSourceFile("ContentStudio.tsx", studioSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findNode(predicate) {
    let found;
    function visit(node) { if (!found && predicate(node)) found = node; if (!found) ts.forEachChild(node, visit); }
    visit(studioTree);
    assert(found, "Expected actual production code was not found");
    return found;
  }
  const functionSource = name => findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(studioTree);
  const storageSnapshot = findNode(node => ts.isJsxAttribute(node) && node.name.getText(studioTree) === "snapshot").initializer.expression.getText(studioTree);
  const storageContext = {
    ...snapshot, assets: [asset], config, importedSource: { current: null }, editedConfig: { current: new Set() },
    getPersistedAssets: helpers.getPersistedAssets
  };
  const serializeStorageSnapshot = currentAssets => new Function(...Object.keys(storageContext), `return JSON.stringify(${storageSnapshot});`)(
    ...Object.values({ ...storageContext, assets: currentAssets })
  );
  assert.equal(serializeStorageSnapshot([asset]), serializeStorageSnapshot([rejected]), "Actual ProjectStorage snapshot ignores only derived review changes");
  const storedAsset = JSON.parse(serializeStorageSnapshot([rejected])).assets[0];
  const expectedStoredAsset = { ...rejected };
  delete expectedStoredAsset.reviewStatus;
  delete expectedStoredAsset.rejectedDetectedAt;
  assert.deepEqual(storedAsset, JSON.parse(JSON.stringify(expectedStoredAsset)), "All non-review fields and binding persist unchanged");
  assert.notEqual(serializeStorageSnapshot([asset]), serializeStorageSnapshot([retry]), "New submission bindings still dirty the snapshot");
  assert.notEqual(serializeStorageSnapshot([asset]), serializeStorageSnapshot([{ ...asset, publishStatus: "published" }]), "Existing publication autosave policy remains unchanged");
  assert.notEqual(serializeStorageSnapshot([asset]), serializeStorageSnapshot([{ ...asset, content: "User edit" }]), "User edits still autosave");
  function bindProductionFunction(name, context) {
    return new Function(...Object.keys(context), `${compile(functionSource(name))}\nreturn ${name};`)(...Object.values(context));
  }
  const iconImport = studioTree.statements.find(statement => ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === "lucide-react").getText(studioTree);
  const renderingSource = `${iconImport}\nimport { useTranslation } from "./i18n";\nimport { getPublishBadge } from "./submission-status";\nimport { PLATFORM_META, DEFAULT_PLATFORMS } from "./types";\n${["platformIcon", "PublishBadge", "AssetsView"].map(functionSource).join("\n")}\nexport { AssetsView, PublishBadge };`;
  await fs.writeFile(path.join(temporaryDirectory, "rendering.js"), compile(renderingSource));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AssetsView, PublishBadge } = require(path.join(temporaryDirectory, "rendering.js"));
  const translations = {
    en: ["Review rejected", "Pending review", "First detected"],
    zh: ["审核不通过", "待审核", "首次检测"],
    vi: ["Không được duyệt", "Chờ duyệt", "Phát hiện lần đầu"],
    th: ["ไม่ผ่านการอนุมัติ", "รอการอนุมัติ", "ตรวจพบครั้งแรก"]
  };
  const noOperation = () => {};
  for (const [locale, labels] of Object.entries(translations)) {
    ["Review rejected", "Pending review", "First detected"].forEach((label, index) => assert.equal(translate(locale, label), labels[index]));
    const markup = renderToStaticMarkup(React.createElement(LocaleContext.Provider, { value: locale }, React.createElement(AssetsView, {
      assets: [rejected], filteredAssets: [rejected], filter: "all", setFilter: noOperation, onOpen: noOperation,
      onPublish: noOperation, onGenerate: noOperation, onExport: noOperation, loading: null, usedFallback: false,
      pendingPlatforms: [], targetCount: 1, config
    })));
    assert.match(markup, new RegExp(`asset-card-top[\\s\\S]*?publish-pill rejected[^>]*>${labels[0]}`));
    assert.equal(markup.split(labels[0]).length - 1, 1, "The rejection label appears only in the top-right badge");
    assert(markup.includes(asset.title) && markup.includes(asset.content) && markup.includes(asset.imageUrl));
    const pendingMarkup = renderToStaticMarkup(React.createElement(LocaleContext.Provider, { value: locale }, React.createElement(PublishBadge, { asset })));
    assert(pendingMarkup.includes(labels[1]));
  }
  assert.equal(translate("zh", "Draft rejected"), "草稿不通过");
  assert.equal(translate("zh", "When a draft is not approved"), "审核不通过时");
  // The rejection pill must draw from the shared danger token so both themes stay readable.
  assert.match(await fs.readFile("src/app/globals.css", "utf8"), /\.publish-pill\.rejected\s*\{[^}]*var\(--danger-surface\)/);
  console.log("PASS: actual React card/badge SSR and four-locale labels, without changing copy/images");

  let storedAssets = [rejected];
  const staleEditor = { ...asset, content: "Edited copy", title: "Edited title", publishStatus: "unpublished" };
  bindProductionFunction("saveAsset", {
    selectedAsset: staleEditor, imageUploading: false, deliveryDraft: JSON.stringify(staleEditor.meta),
    rewriteSequence: { current: 0 }, setRewriting: noOperation, getAssetStatusFields,
    setAssets: update => { storedAssets = update(storedAssets); }, setSelectedAsset: noOperation,
    clearCandidates: noOperation, notify: noOperation, t: text => text
  })();
  assert.equal(storedAssets[0].content, staleEditor.content);
  assert.deepEqual(getAssetStatusFields(storedAssets[0]), getAssetStatusFields(rejected), "Actual saveAsset preserves current server facts over a stale drawer");
  for (const functionName of ["adoptCandidate", "revertRevision"]) {
    let selected = { ...rejected, revisions: [{ at: submittedAt, instruction: "Edit", before: { title: "Before", content: "Before", factIds: [] } }] };
    const update = bindProductionFunction(functionName, {
      selectedAsset: selected, pendingInstruction: "Edit", MAX_REVISIONS: 3, MAX_TURNS: 40,
      setSelectedAsset: value => { selected = value; }, setDeliveryDraft: noOperation, setThreads: noOperation,
      clearCandidates: noOperation, notify: noOperation
    });
    update(functionName === "adoptCandidate" ? { asset: { ...asset, content: "AI suggestion" }, issues: [], changeSummary: "Edit" } : 0);
    assert.deepEqual(getAssetStatusFields(selected), getAssetStatusFields(rejected), `${functionName} preserves rejection/binding facts`);
  }
  console.log("PASS: actual saveAsset/adoptCandidate/revertRevision preserve server status and bindings");

  let submissionAssets = [rejected];
  let submissionDrawer = { ...rejected, content: "Unsaved drawer copy" };
  let submissionBusy = false;
  let acceptingAssetIds = [];
  let resolveSubmission;
  const submissionRequests = [];
  const submissionContext = {
    currentProjectRef: { current: "project-1" }, packSequence: { current: 1 }, submissionAttempts: { current: new Map() },
    acceptanceFlights: { current: new Set() }, mergeDraftTask, isDraftSubmissionTask,
    config, socialAccounts: [{ id: "account-1", identifier: "facebook", name: "Account" }], markSubmissionSucceeded,
    readJson: response => response.json(), t: text => text, notify: noOperation, setSubmissionNotice: noOperation,
    setAssets: update => { submissionAssets = update(submissionAssets); },
    setSelectedAsset: update => { submissionDrawer = typeof update === "function" ? update(submissionDrawer) : update; },
    setPublishModalAsset: noOperation, setAcceptingAssetIds: update => {
      acceptingAssetIds = typeof update === "function" ? update(acceptingAssetIds) : update;
      submissionBusy = acceptingAssetIds.length > 0;
    },
    fetch: (url, options) => { submissionRequests.push({ url, options }); return new Promise(resolve => { resolveSubmission = resolve; }); }
  };
  const submitDraft = bindProductionFunction("submitDraft", submissionContext);
  const firstSubmission = submitDraft(rejected, "account-1");
  assert.equal(submissionBusy, true);
  assert.equal(submissionAssets[0].publishStatus, "publishing");
  assert.equal(submissionDrawer.publishStatus, "publishing");
  assert.equal(submissionRequests[0].url, "/api/social/publish");
  assert.equal(submissionRequests[0].options.method, "POST", "Retry creates a new draft, not an update");
  const submittedPayload = JSON.parse(submissionRequests[0].options.body);
  assert.equal(submittedPayload.projectId, "project-1");
  assert.equal(submittedPayload.content, rejected.content);
  assert.equal(submittedPayload.postId, undefined, "Never update the old post");
  const acceptedTask = { id: "11111111-1111-4111-8111-111111111111", kind: "asset", sourceId: asset.id, projectId: "project-1",
    integrationId: "account-1", state: "queued", auditId: null, postId: null, warning: null, error: null,
    createdAt: detectedAt, updatedAt: detectedAt, finishedAt: null };
  resolveSubmission(Response.json({ accepted: true, task: acceptedTask }, { status: 202 }));
  await firstSubmission;
  assert.equal(submissionBusy, false);
  assert.equal(submissionDrawer.content, "Unsaved drawer copy");
  assert.deepEqual(getAssetStatusFields(submissionDrawer), getAssetStatusFields(submissionAssets[0]));
  assert.equal(submissionAssets[0].publishStatus, "publishing", "202 never fabricates engine acceptance");
  assert.equal(submissionAssets[0].submission.auditId, "audit-new", "the old review binding is retained until completion");
  const completedTask = { ...acceptedTask, state: "succeeded", auditId: "audit-retry", postId: "post-retry", finishedAt: detectedAt };
  submissionAssets = submissionAssets.map(current => mergeDraftTask(current, completedTask));
  submissionDrawer = mergeDraftTask(submissionDrawer, completedTask);
  assert.equal(submissionAssets[0].submission.auditId, "audit-retry");
  const supersededSubmission = submitDraft(submissionAssets[0], "account-1");
  const generatePack = bindProductionFunction("generatePack", {
    ...submissionContext, rewriteSequence: { current: 1 }, PACK_CONCURRENCY: 5,
    setRewriting: noOperation, setThreads: noOperation, clearCandidates: noOperation, setLoading: noOperation,
    setGenerationRun: noOperation, setUsedFallback: noOperation, setPendingPlatforms: noOperation, setView: noOperation,
    // generatePack only navigates while the user is still inside the AI project shell.
    AI_VIEWS: ["workspace", "facts", "assets"], viewRef: { current: "workspace" },
    setAssets: update => { submissionAssets = typeof update === "function" ? update(submissionAssets) : update; },
    fetch: async () => Response.json({ assets: [] })
  });
  await generatePack(config, {}, ["facebook"], "Generated");
  assert.equal(submissionBusy, false, "Regeneration clears a superseded submission's busy state");
  resolveSubmission(Response.json({ accepted: true, task: { ...acceptedTask, id: "22222222-2222-4222-8222-222222222222" } }, { status: 202 }));
  await supersededSubmission;
  assert.deepEqual(submissionAssets, [], "Old submission completion cannot populate a new generation");
  for (const invalidation of ["project", "generation"]) {
    const finishes = [];
    let submittedCount = 0;
    const loadingStates = [];
    const batchContext = {
      assets: [asset, { ...asset, id: "asset-2" }, { ...asset, id: "asset-3" }], socialAccounts: submissionContext.socialAccounts,
      currentProjectRef: { current: "project-1" }, packSequence: { current: 1 }, t: text => text,
      notify: () => assert.fail("An obsolete batch must not announce results"), setSubmissionNotice: noOperation,
      setLoading: value => loadingStates.push(value),
      submitDraft: () => { submittedCount += 1; return new Promise(resolve => { finishes.push(resolve); }); }
    };
    const batch = bindProductionFunction("batchSubmitDrafts", batchContext)();
    if (invalidation === "project") batchContext.currentProjectRef.current = "project-2";
    else batchContext.packSequence.current += 1;
    finishes.forEach(finish => finish({ success: true, warning: false }));
    await batch;
    assert.equal(submittedCount, 2, "Only the two already-accepted requests may finish after batch invalidation");
    assert.deepEqual(loadingStates, ["export"], "Obsolete batches do not clear a new generation's loading state");
  }
  console.log("PASS: actual POST submission/retry, drawer bindings, superseded busy cleanup and batch epoch cancellation");

  const pollingEffect = findNode(node => ts.isCallExpression(node) && node.expression.getText(studioTree) === "useEffect"
    && node.arguments[0]?.getText(studioTree).includes("async function syncSubmissionStatus")).arguments[0].getText(studioTree);
  function startPolling(initialAssets = [asset], projectId = "project-1") {
    let resolveRequest;
    let intervalCallback;
    let drawer = { ...initialAssets[0], content: "Unsaved drawer copy" };
    const queuedUpdates = [];
    const requests = [];
    const assetsRef = { current: initialAssets };
    const currentProjectRef = { current: projectId };
    const packSequence = { current: 1 };
    const submissionAttempts = { current: new Map() };
    const context = {
      ...helpers, assetsRef, currentProjectId: projectId, currentProjectRef, packSequence, submissionAttempts,
      AbortController, URLSearchParams, readJson: response => response.json(),
      fetch: (url, options) => { requests.push({ url, options }); return new Promise(resolve => { resolveRequest = resolve; }); },
      setInterval: callback => { intervalCallback = callback; return 1; }, clearInterval: noOperation,
      setAssets: update => queuedUpdates.push(() => { assetsRef.current = update(assetsRef.current); }),
      setSelectedAsset: update => queuedUpdates.push(() => { drawer = update(drawer); }), setPublishModalAsset: noOperation
    };
    const effect = new Function(...Object.keys(context), `${compile(`const effect = ${pollingEffect};`)}\nreturn effect;`)(...Object.values(context));
    const cleanup = effect();
    return {
      assetsRef, currentProjectRef, packSequence, submissionAttempts, requests, cleanup,
      getDrawer: () => drawer, tick: () => intervalCallback(),
      respond: async (entries = [rejection]) => { resolveRequest(Response.json({ submissions: entries })); await new Promise(resolve => setImmediate(resolve)); },
      flush: () => { queuedUpdates.splice(0).forEach(update => update()); }
    };
  }
  const normalPoll = startPolling([asset, { ...legacy, id: "legacy-id", publishStatus: "published" }]);
  const parameters = new URL(normalPoll.requests[0].url, "http://unit.invalid").searchParams;
  assert.equal(parameters.get("projectId"), "project-1");
  assert.equal(parameters.get("auditIds"), "audit-new");
  assert.equal(parameters.get("assetIds"), "legacy-id");
  await normalPoll.respond(); normalPoll.flush();
  assert.equal(normalPoll.assetsRef.current[0].reviewStatus, "rejected");
  assert.equal(normalPoll.getDrawer().reviewStatus, "rejected");
  assert.equal(normalPoll.getDrawer().content, "Unsaved drawer copy");
  normalPoll.tick();
  assert.equal(normalPoll.requests.length, 2, "Rejected assets keep polling for later publication");
  await normalPoll.respond(); normalPoll.flush(); normalPoll.cleanup();
  for (const scenario of ["new-attempt", "failed-retry", "new-binding", "other-project", "new-generation", "abort"]) {
    const poll = startPolling();
    await poll.respond();
    // Delay React's functional updaters: the guard must run here, not just before setAssets.
    if (scenario === "new-attempt") poll.submissionAttempts.current.set(asset.id, 1);
    if (scenario === "failed-retry") poll.assetsRef.current = [{ ...asset, publishStatus: "failed" }];
    if (scenario === "new-binding") poll.assetsRef.current = [retry];
    if (scenario === "other-project") poll.currentProjectRef.current = "project-2";
    if (scenario === "new-generation") poll.packSequence.current += 1;
    if (scenario === "abort") poll.cleanup();
    const current = poll.assetsRef.current;
    poll.flush();
    assert.strictEqual(poll.assetsRef.current, current, `${scenario}: old response cannot dirty current assets`);
    poll.cleanup();
  }
  const noProject = startPolling([legacy], "");
  assert.equal(new URL(noProject.requests[0].url, "http://unit.invalid").searchParams.has("projectId"), false);
  await noProject.respond(); noProject.flush(); noProject.cleanup();
  const unavailablePoll = startPolling([untracked]);
  assert.equal(unavailablePoll.requests.length, 0, "Tracking-unavailable submissions never query legacy asset history");
  const malformedPoll = startPolling([rejected]);
  await malformedPoll.respond([{ ...rejection, reviewStatus: "invalid", submittedAt: undefined }]); malformedPoll.flush(); malformedPoll.cleanup();
  assert.strictEqual(malformedPoll.assetsRef.current[0], rejected, "Actual callback discards malformed tracking payloads");
  const scopedProjectId = "11111111-1111-4111-8111-111111111111";
  for (const mode of ["legacy", "bound", "mixed"]) {
    const manyAssets = Array.from({ length: 200 }, (_, index) => ({
      ...asset, id: `${index.toString().padStart(3, "0")}${"a".repeat(61)}`,
      submission: mode === "legacy" || (mode === "mixed" && index % 2 === 0) ? undefined : {
        auditId: `22222222-2222-4222-8222-${index.toString().padStart(12, "0")}`,
        postId: `post-${index}`, submittedAt
      }
    }));
    const queries = helpers.getSubmissionStatusQueries(manyAssets, scopedProjectId);
    assert.equal(queries.length, 4);
    const batchPoll = startPolling(manyAssets, scopedProjectId);
    let seenAssets = 0;
    for (let index = 0; index < queries.length; index += 1) {
      const request = batchPoll.requests[index];
      assert(request, "Actual production polling callback issues each chunk");
      const url = new URL(request.url, "http://unit.invalid");
      assert(new TextEncoder().encode(url.search).length <= 8192, "Encoded request stays below server 8KB limit");
      assert.equal(url.searchParams.get("projectId"), scopedProjectId);
      const assetIds = (url.searchParams.get("assetIds") || "").split(",").filter(Boolean);
      const auditIds = (url.searchParams.get("auditIds") || "").split(",").filter(Boolean);
      assert(assetIds.length + auditIds.length <= 64, "Chunks stay below both 64 and 100 identifier budgets");
      const entries = manyAssets.filter(entry => assetIds.includes(entry.id) || auditIds.includes(entry.submission?.auditId));
      seenAssets += entries.length;
      await batchPoll.respond(entries.map(entry => ({ ...rejection, assetId: entry.id,
        auditId: entry.submission?.auditId ?? `legacy-${entry.id}`, postId: entry.submission?.postId ?? "legacy-post" })));
    }
    batchPoll.flush(); batchPoll.cleanup();
    assert.equal(seenAssets, 200);
    assert(batchPoll.assetsRef.current.every(entry => entry.reviewStatus === "rejected"), "All 200 longest allowed asset IDs synchronize across chunks");
  }
  console.log("PASS: malformed payload preservation, actual 200-asset chunked polling, derived-review-only persistence exclusion");
  console.log("PASS: actual polling callback, scoped query, drawer preservation, rejected polling and delayed-updater race guards");
  console.log("Review status tests passed (all network mocked; no database, AI or real user interaction).");
} finally {
  globalThis.fetch = originalFetch;
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
