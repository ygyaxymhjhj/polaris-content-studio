// Actual modules with synthetic timers, environment and dependencies; no network or credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { setImmediate as settleMicrotasks } from "node:timers/promises";
import vm from "node:vm";
import typescript from "typescript";

function setup(environment = {}, configured = true) {
  const timers = new Map();
  const warnings = [];
  const processMock = new EventEmitter();
  processMock.env = { NODE_ENV: "production", NEXT_RUNTIME: "nodejs", ...environment };
  let currentTime = 0;
  let calls = 0;
  let imports = 0;
  let implementation = async () => ({ warning: undefined, failed: 0 });
  const context = vm.createContext({
    process: processMock,
    console: { warn: (...argumentsList) => warnings.push(argumentsList) },
    setTimeout(callback, milliseconds) {
      const handle = { unreferenced: false, unref() { this.unreferenced = true; } };
      timers.set(handle, { callback, time: currentTime + milliseconds });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); }
  });
  function load(relativePath, dependencies) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const compiled = typescript.transpileModule(source, {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 }
    }).outputText;
    const exports = {};
    const execute = vm.runInContext(`(function(require, exports) { ${compiled}\n })`, context);
    execute(specifier => {
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency: ${specifier}`);
      return dependencies[specifier]();
    }, exports);
    return exports;
  }
  const loadScheduler = () => load("../src/lib/social-notification-scheduler.ts", {
    "./social-notifications": () => ({ processSocialNotifications: () => { calls++; return implementation(); } }),
    "./project-db": () => ({ databaseConfigured: () => configured })
  });
  const loadInstrumentation = () => load("../src/instrumentation.ts", {
    "./lib/draft-submission-scheduler": () => ({ startDraftSubmissionScheduler() {} }),
    "./lib/social-notification-scheduler": () => { imports++; return loadScheduler(); }
  });
  async function advance(milliseconds) {
    await settleMicrotasks();
    const target = currentTime + milliseconds;
    while (true) {
      const next = [...timers.entries()].sort((first, second) => first[1].time - second[1].time)[0];
      if (!next || next[1].time > target) break;
      currentTime = next[1].time;
      timers.delete(next[0]);
      next[1].callback();
      await settleMicrotasks();
    }
    currentTime = target;
  }
  return {
    timers, warnings, processMock, loadScheduler, loadInstrumentation, advance,
    get calls() { return calls; }, get imports() { return imports; },
    set implementation(callback) { implementation = callback; }
  };
}

test("production register automatically calls core without a runner token and does not block readiness", async () => {
  const fixture = setup();
  assert.equal(fixture.processMock.env.SOCIAL_NOTIFICATIONS_TOKEN, undefined);
  await fixture.loadInstrumentation().register();
  assert.equal(fixture.calls, 0);
  assert.equal(fixture.timers.size, 1);
  assert.ok([...fixture.timers.keys()].every(timer => timer.unreferenced));
  await fixture.advance(4_999);
  assert.equal(fixture.calls, 0);
  await fixture.advance(1);
  assert.equal(fixture.calls, 1);
  await fixture.advance(60_000);
  assert.equal(fixture.calls, 2);
});

for (const [description, environment] of [
  ["development by default", { NODE_ENV: "development" }],
  ["test by default", { NODE_ENV: "test" }],
  ["explicit disable", { SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "false" }],
  ["build even with explicit opt-in", { NEXT_PHASE: "phase-production-build", SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "true" }],
  ["edge even with explicit opt-in", { NEXT_RUNTIME: "edge", SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "true" }],
  ["unknown runtime", { NEXT_RUNTIME: undefined }],
  ["Vercel", { VERCEL: "1" }],
  ["Vercel even with explicit opt-in", { VERCEL: "1", SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "true" }]
]) {
  test(`register refuses ${description} without importing database dependencies`, async () => {
    const fixture = setup(environment);
    await fixture.loadInstrumentation().register();
    assert.equal(fixture.imports, 0);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.calls, 0);
    if (environment.VERCEL) assert.match(fixture.warnings.flat().join(" "), /external/i);
  });
  test(`direct start refuses ${description}`, () => {
    const fixture = setup(environment);
    fixture.loadScheduler().startSocialNotificationScheduler();
    assert.equal(fixture.timers.size, 0);
  });
}

test("development only starts after explicit true opt-in", async () => {
  const fixture = setup({ NODE_ENV: "development", SOCIAL_NOTIFICATIONS_SCHEDULER_ENABLED: "true" });
  await fixture.loadInstrumentation().register();
  await fixture.advance(5_000);
  assert.equal(fixture.calls, 1);
});

test("unconfigured database does not start timers or shutdown listeners", async () => {
  const fixture = setup({}, false);
  await fixture.loadInstrumentation().register();
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.processMock.listenerCount("SIGTERM"), 0);
});

test("repeated register, start and module reload share exactly one timer and signal listener", async () => {
  const fixture = setup();
  await Promise.all([fixture.loadInstrumentation().register(), fixture.loadInstrumentation().register()]);
  fixture.loadScheduler().startSocialNotificationScheduler();
  assert.equal(fixture.timers.size, 1);
  assert.equal(fixture.processMock.listenerCount("SIGTERM"), 1);
  assert.equal(fixture.processMock.listenerCount("SIGINT"), 1);
  await fixture.advance(125_000);
  assert.equal(fixture.calls, 3);
});

test("long or hanging tasks never overlap and subsequent ticks retain their cadence", async () => {
  const fixture = setup();
  let finish;
  fixture.implementation = () => new Promise(resolve => { finish = resolve; });
  await fixture.loadInstrumentation().register();
  await fixture.advance(185_000);
  assert.equal(fixture.calls, 1);
  finish({ failed: 0 });
  await fixture.advance(0);
  await fixture.advance(60_000);
  assert.equal(fixture.calls, 2);
});

test("exceptions and summary warnings are redacted and later ticks continue", async () => {
  const fixture = setup();
  fixture.implementation = () => { throw new Error("secret=https://synthetic.invalid/token applicant-name"); };
  await fixture.loadInstrumentation().register();
  await fixture.advance(5_000);
  fixture.implementation = async () => { throw new Error("secret=synthetic-token applicant-name"); };
  await fixture.advance(60_000);
  fixture.implementation = async () => ({ warning: "secret=synthetic-token applicant-name", failed: 1 });
  await fixture.advance(60_000);
  fixture.implementation = async () => ({ failed: 0 });
  await fixture.advance(60_000);
  assert.equal(fixture.calls, 4);
  assert.equal(fixture.warnings.length, 3);
  assert.ok(fixture.warnings.every(argumentsList => argumentsList.length === 1));
  assert.doesNotMatch(JSON.stringify(fixture.warnings), /secret|synthetic|applicant-name/);
});

for (const signal of ["SIGTERM", "SIGINT", "stop"]) {
  test(`${signal} stops future ticks without exiting and permits clean restart`, async () => {
    const fixture = setup();
    const scheduler = fixture.loadScheduler();
    scheduler.startSocialNotificationScheduler();
    await fixture.advance(5_000);
    if (signal === "stop") scheduler.stopSocialNotificationScheduler();
    else fixture.processMock.emit(signal);
    assert.equal(fixture.timers.size, 0);
    assert.equal(fixture.processMock.listenerCount("SIGTERM"), 0);
    assert.equal(fixture.processMock.listenerCount("SIGINT"), 0);
    await fixture.advance(180_000);
    assert.equal(fixture.calls, 1);
    scheduler.startSocialNotificationScheduler();
    await fixture.advance(5_000);
    assert.equal(fixture.calls, 2);
  });
}

test("stop and restart while a task is pending still cannot overlap", async () => {
  const fixture = setup();
  let finish;
  fixture.implementation = () => new Promise(resolve => { finish = resolve; });
  const scheduler = fixture.loadScheduler();
  scheduler.startSocialNotificationScheduler();
  await fixture.advance(5_000);
  scheduler.stopSocialNotificationScheduler();
  fixture.loadScheduler().startSocialNotificationScheduler();
  await fixture.advance(65_000);
  assert.equal(fixture.calls, 1);
  finish({ failed: 0 });
  await fixture.advance(60_000);
  assert.equal(fixture.calls, 2);
});
