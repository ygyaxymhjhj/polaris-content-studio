// Uses the public completion route and synthetic callback states; no login or Postiz credentials.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.TEST_BASE_URL || "http://localhost:3000";
const completionPath = "/social/connect/complete";
const retryPath = `/api/social/connect?state=${"a".repeat(64)}`;
const browser = await chromium.launch({ channel: process.env.TEST_BROWSER_CHANNEL || "chrome" });
const pageErrors = [];
let passedChecks = 0;

function reportPassed(description) {
  passedChecks += 1;
  console.log(`AFTER PASS: ${description}`);
}

function completionUrl(outcome, parameters = {}) {
  return `${completionPath}?${new URLSearchParams({ connection: outcome, ...parameters })}`;
}

async function createOpener({ locale = "en-US" } = {}) {
  const context = await browser.newContext({ locale });
  context.on("page", page => page.on("pageerror", error => pageErrors.push(error.message)));
  const page = await context.newPage();
  // A browser-side fixture at the app's origin supplies an opener without an authenticated workspace.
  await page.route("**/__postiz_popup_regression", route => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><head><title>Popup regression</title></head><body><p>Local popup opener</p><script>window.returnMessages = []; window.addEventListener('message', event => { if (event.origin === location.origin && event.data?.type === 'POLARIS_POSTIZ_RETURNED') window.returnMessages.push({outcome: event.data.outcome, fromPopup: event.source === window.authorizationPopup}); });</script></body></html>"
  }));
  await page.goto(`${baseUrl}/__postiz_popup_regression`);
  return { context, page };
}

async function openPopup(page, path, { isolated = false } = {}) {
  const popupPromise = isolated ? page.context().waitForEvent("page") : page.waitForEvent("popup");
  if (isolated) {
    await page.context().addInitScript(({ origin }) => {
      if (location.origin === origin) sessionStorage.setItem("polaris-postiz-authorization-popup", "1");
    }, { origin: new URL(baseUrl).origin });
  }
  await page.evaluate(({ path, isolated }) => {
    window.returnMessages = [];
    window.authorizationPopup = window.open(path, "_blank", `popup,width=760,height=780${isolated ? ",noopener" : ""}`);
  }, { path, isolated });
  return popupPromise;
}

async function waitForReturn(page, outcome) {
  await page.waitForFunction(expected => window.returnMessages.some(message => message.outcome === expected && message.fromPopup), outcome);
}

try {
  if (process.argv.includes("--before")) {
    const { context, page } = await createOpener();
    for (const path of ["/?view=accounts&connection=invalid", "/login"]) {
      const popup = await openPopup(page, path);
      await popup.waitForURL("**/login**");
      await popup.waitForLoadState("domcontentloaded");
      await popup.waitForTimeout(1000);
      console.log(`BEFORE ${popup.isClosed() ? "PASS" : "OBSERVED FAIL"}: ${path}; closed=${popup.isClosed()}; returned=${await page.evaluate(() => window.returnMessages.length)}; destination=${new URL(popup.url()).pathname}`);
      if (!popup.isClosed()) await popup.close();
    }
    await context.close();
  } else {
    const { context, page } = await createOpener();
    const successPopup = await openPopup(page, completionUrl("returned", { view: "accounts" }));
    await waitForReturn(page, "returned");
    if (!successPopup.isClosed()) await successPopup.waitForEvent("close");
    assert.equal(successPopup.isClosed(), true);
    reportPassed("window.open success posts a same-origin message from the popup and closes it");

    const callbackPopup = await openPopup(page, `${retryPath}?added=x&msg=Channel%20Updated`);
    await waitForReturn(page, "unauthenticated");
    assert.equal(new URL(callbackPopup.url()).pathname, completionPath);
    await callbackPopup.getByRole("link", { name: "Return to sign in" }).waitFor();
    await callbackPopup.close();
    reportPassed("the real double-question callback returns explicit session guidance and notifies its opener instead of stranding it on login");

    for (const [outcome, expectedMessage] of [
      ["invalid", "expired or belongs to another session"],
      ["unauthenticated", "session expired"],
      ["error", "No successful connection has been confirmed"],
      ["unconfirmed", "No new account was confirmed"],
      ["conflict", "belongs to another Polaris user"]
    ]) {
      const popup = await openPopup(page, completionUrl(outcome));
      await waitForReturn(page, outcome);
      assert.match(await popup.locator('main [role="alert"]').innerText(), new RegExp(expectedMessage));
      assert.equal(popup.isClosed(), false);
      assert.equal(await popup.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
      assert.equal(await popup.getByRole("link", { name: outcome === "unauthenticated" ? "Return to sign in" : "Return to workspace" }).getAttribute("href"), outcome === "unauthenticated" ? "/login" : "/?view=workspace");
      assert.equal(await popup.getByRole("link", { name: "Retry return check" }).count(), 0);
      await popup.getByRole("button", { name: "Close window" }).click();
      if (!popup.isClosed()) await popup.waitForEvent("close");
      reportPassed(`${outcome} posts its outcome, keeps an explicit error visible, and supports manual close`);
    }

    const fallbackPage = await context.newPage();
    // A normal tab with no popup marker must retain its result, even with only one history entry.
    await fallbackPage.goto(`${baseUrl}${completionUrl("returned", { view: "accounts" })}`);
    await fallbackPage.getByRole("heading", { name: "Authorisation completed", exact: true }).waitFor();
    assert.equal(await fallbackPage.evaluate(() => window.opener === null), true);
    assert.equal(await fallbackPage.getByRole("link", { name: "Return to workspace" }).getAttribute("href"), "/?view=accounts");
    reportPassed("no-opener normal tab retains success and workspace return without requesting automatic close");

    for (const outcome of ["error", "unconfirmed"]) {
      await fallbackPage.goto(`${baseUrl}${completionUrl(outcome, { retry: retryPath })}`);
      assert.equal(await fallbackPage.getByRole("link", { name: "Retry return check" }).getAttribute("href"), retryPath);
      reportPassed(`${outcome} permits only the exact relative 64-hex retry link`);
    }

    for (const unsafeRetry of [
      "https://evil.example/api/social/connect?state=" + "a".repeat(64),
      "//evil.example/api/social/connect?state=" + "a".repeat(64),
      retryPath + "&next=https://evil.example",
      retryPath + "\n",
      "/api/social/connect?state=" + "A".repeat(64),
      "/api/social/connect?state=" + "a".repeat(63),
      "/api/social/connect?state=" + "g".repeat(64)
    ]) {
      await fallbackPage.goto(`${baseUrl}${completionUrl("error", { retry: unsafeRetry, view: "https://evil.example" })}`);
      assert.equal(await fallbackPage.getByRole("link", { name: "Retry return check" }).count(), 0, `Rejected unsafe retry ${JSON.stringify(unsafeRetry)}`);
      assert.equal(await fallbackPage.getByRole("link", { name: "Return to workspace" }).getAttribute("href"), "/?view=workspace");
    }
    reportPassed("external, protocol-relative, extra-query, newline, uppercase, short and non-hex retry paths are rejected");

    await fallbackPage.goto(`${baseUrl}${completionUrl("invalid", { retry: retryPath })}`);
    assert.equal(await fallbackPage.getByRole("link", { name: "Retry return check" }).count(), 0);
    await fallbackPage.goto(`${baseUrl}${completionUrl("unknown")}&connection=returned&view=accounts&view=settings&retry=${encodeURIComponent(retryPath)}`);
    assert.match(await fallbackPage.locator('main [role="alert"]').innerText(), /expired or belongs to another session/);
    assert.equal(await fallbackPage.getByRole("link", { name: "Return to workspace" }).getAttribute("href"), "/?view=workspace");
    reportPassed("invalid/unknown/duplicate callback parameters cannot claim success or create retry/return redirects");

    await fallbackPage.setViewportSize({ width: 375, height: 812 });
    await fallbackPage.goto(`${baseUrl}${completionUrl("invalid")}`);
    assert.equal(await fallbackPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await fallbackPage.screenshot({ path: process.env.TEST_SCREENSHOT_PATH || "/tmp/polaris-postiz-completion-invalid.png", fullPage: true });
    reportPassed("375px completion screen has no horizontal overflow; screenshot captured");
    await context.close();

    const isolated = await createOpener();
    const isolatedPopup = await openPopup(isolated.page, completionUrl("returned"), { isolated: true });
    if (!isolatedPopup.isClosed()) await isolatedPopup.waitForEvent("close");
    assert.equal(isolatedPopup.isClosed(), true);
    assert.deepEqual(await isolated.page.evaluate(() => window.returnMessages), []);
    reportPassed("success popup closes even when the opener is isolated and unavailable");
    await isolated.context.close();

    const chinese = await createOpener({ locale: "zh-CN" });
    const chinesePopup = await openPopup(chinese.page, completionUrl("unauthenticated"));
    await waitForReturn(chinese.page, "unauthenticated");
    await chinesePopup.getByRole("heading", { name: "授权尚未完成" }).waitFor();
    assert.match(await chinesePopup.locator('main [role="alert"]').innerText(), /登录会话已过期/);
    assert.equal(await chinesePopup.getByRole("link", { name: "返回登录" }).getAttribute("href"), "/login");
    reportPassed("Chinese browser renders localized unauthenticated guidance without sign-in");
    await chinese.context.close();

    assert.deepEqual(pageErrors, [], "No uncaught browser JavaScript errors");
    console.log(`PASS: ${passedChecks} focused popup checks; no login, credentials, or external API calls.`);
  }
} finally {
  await browser.close();
}
