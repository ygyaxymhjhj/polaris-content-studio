// Isolated authorization regression: synthetic secrets, mocked Postiz, no database or real OAuth.
// node scripts/test-postiz-connect.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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

const environmentNames = ["POSTIZ_API_URL", "POSTIZ_API_KEY", "POSTIZ_JWT_SECRET", "POSTIZ_UI_URL"];
const previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
const previousFetch = globalThis.fetch;
const platformTypes = loadModule("src/lib/types.ts");
const postiz = loadModule("src/lib/postiz.ts", { "./types": platformTypes, "./post-types": loadModule("src/lib/post-types.ts"), "./image-types": loadModule("src/lib/image-types.ts") });
const capturedRequests = [];
const savedAttempts = [];
let upstreamBody = JSON.stringify("https://twitter.com/i/oauth2/authorize?state=synthetic-provider-state");
let upstreamStatus = 200;
let currentAccount = null;
const sameOriginModule = loadModule("src/lib/same-origin.ts");
const routes = loadModule("src/app/api/social/connect/route.ts", {
  "@/lib/postiz": postiz,
  "@/lib/auth": { currentUser: async () => currentAccount, unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 }) },
  "@/lib/same-origin": sameOriginModule,
  // Ownership transactions are tested against the real library in test-social-connect-completion.
  // This JWT regression models a saved attempt but no newly confirmed integration on return.
  "@/lib/social-accounts": {
    createConnectAttempt: async entry => { savedAttempts.push(entry); },
    completeConnectAttempt: async () => ({ outcome: "unconfirmed", returnView: "workspace" })
  }
});
const baseUrl = "https://studio.example.test";
function startRequest(body, origin = baseUrl) {
  return new NextRequest(`${baseUrl}/api/social/connect`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
function returnRequest(url, cookie = "") {
  return new NextRequest(url, { headers: { Cookie: cookie } });
}

try {
  process.env.POSTIZ_API_URL = "https://postiz.example.test/";
  process.env.POSTIZ_API_KEY = "synthetic-postiz-api-key";
  process.env.POSTIZ_JWT_SECRET = "synthetic-postiz-jwt-secret-for-testing";
  delete process.env.POSTIZ_UI_URL;
  globalThis.fetch = async (url, options) => {
    capturedRequests.push({ url, options });
    if (String(url).endsWith("/public/v1/integrations")) return new Response("[]", { status: 200 });
    return new Response(upstreamBody, { status: upstreamStatus });
  };

  for (const suffix of ["", "/", "/api", "/api/", "/api/public/v1/"]) {
    assert.equal(postiz.getPostizApiBaseUrl(`https://postiz.example.test${suffix}`), "https://postiz.example.test/api");
  }
  assert.equal((await routes.POST(startRequest({ provider: "x" }))).status, 401);
  currentAccount = { user: { id: "member-one", role: "member" } };
  assert.equal((await routes.POST(startRequest({ provider: "x" }, "https://untrusted.example.test"))).status, 403);
  for (const body of ["{", { provider: "unsupported" }, { provider: "x", redirectUrl: "https://untrusted.example.test" }]) {
    assert.equal((await routes.POST(startRequest(body))).status, 400);
  }
  assert.equal(capturedRequests.length, 0, "Rejected requests must not contact Postiz");

  const startResponse = await routes.POST(startRequest({ provider: "x" }));
  assert.equal(startResponse.status, 200, "Members can start connecting an account for themselves");
  const responseData = await startResponse.json();
  assert.deepEqual(responseData, { url: JSON.parse(upstreamBody) });
  const upstreamRequest = capturedRequests.at(-1);
  assert.equal(upstreamRequest.url, "https://postiz.example.test/api/enterprise/url");
  assert.equal(upstreamRequest.options.redirect, "error", "The signed token must never follow an upstream redirect");
  const { params } = JSON.parse(upstreamRequest.options.body);
  const [header, payload, signature] = params.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
  assert.equal(signature, createHmac("sha256", process.env.POSTIZ_JWT_SECRET).update(`${header}.${payload}`).digest("base64url"));
  const tokenPayload = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(tokenPayload.apiKey, process.env.POSTIZ_API_KEY);
  assert.equal(tokenPayload.provider, "x");
  assert.equal(tokenPayload.exp - tokenPayload.iat, 600);
  assert.equal(tokenPayload.webhookUrl, "");
  assert.equal(new URL(tokenPayload.redirectUrl).origin, baseUrl);
  assert.match(new URL(tokenPayload.redirectUrl).searchParams.get("state"), /^[a-f0-9]{64}$/);
  const cookie = startResponse.cookies.get("polaris-postiz-connect");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "lax");
  assert.equal(cookie.maxAge, 600);
  const cookieHeader = `${cookie.name}=${cookie.value}`;
  const callbackResponse = await routes.GET(returnRequest(tokenPayload.redirectUrl, cookieHeader));
  assert.equal(new URL(callbackResponse.headers.get("location"), baseUrl).searchParams.get("connection"), "unconfirmed");
  assert.equal(callbackResponse.cookies.get(cookie.name), undefined, "Unconfirmed callbacks preserve the state cookie for retry");
  for (const callback of [returnRequest(tokenPayload.redirectUrl), returnRequest(`${baseUrl}/api/social/connect?state=forged`, cookieHeader)]) {
    assert.equal(new URL((await routes.GET(callback)).headers.get("location"), baseUrl).searchParams.get("connection"), "invalid");
  }
  currentAccount = { user: { id: "another-member", role: "member" } };
  assert.equal(new URL((await routes.GET(returnRequest(tokenPayload.redirectUrl, cookieHeader))).headers.get("location"), baseUrl).searchParams.get("connection"), "invalid");
  currentAccount = null;
  assert.equal(new URL((await routes.GET(returnRequest(tokenPayload.redirectUrl, cookieHeader))).headers.get("location"), baseUrl).searchParams.get("connection"), "unauthenticated");

  currentAccount = { user: { id: "member-one", role: "member" } };
  const linkedInResponse = await routes.POST(startRequest({ provider: "linkedin" }));
  assert.equal(linkedInResponse.status, 200);
  const linkedInToken = JSON.parse(capturedRequests.at(-1).options.body).params;
  const linkedInPayload = JSON.parse(Buffer.from(linkedInToken.split(".")[1], "base64url"));
  assert.equal(linkedInPayload.provider, "linkedin-page", "LinkedIn must authorize a company Page rather than a personal profile");
  assert.equal(savedAttempts.at(-1).provider, "linkedin-page", "Callback ownership must match the provider requested from Postiz");
  const youtubeResponse = await routes.POST(startRequest({ provider: "youtube", returnView: "accounts" }));
  assert.equal(youtubeResponse.status, 200);
  const youtubeToken = JSON.parse(capturedRequests.at(-1).options.body).params;
  assert.equal(JSON.parse(Buffer.from(youtubeToken.split(".")[1], "base64url")).provider, "youtube");
  assert.equal(savedAttempts.at(-1).provider, "youtube");
  assert.equal(platformTypes.DEFAULT_PLATFORMS.includes("youtube"), false, "YouTube is a manual video channel, not an AI generation platform");
  const originalUpstreamBody = upstreamBody;
  for (const host of ["api.x.com", "api.twitter.com", "x.com", "twitter.com"]) {
    for (const path of ["/oauth/authenticate", "/oauth/authorize"]) {
      const originalUrl = `https://${host}${path}?oauth_token=synthetic-request-token&force_login=false`;
      upstreamBody = JSON.stringify(originalUrl);
      const response = await routes.POST(startRequest({ provider: "x" }));
      assert.equal(response.status, 200);
      const authorizationUrl = new URL((await response.json()).url);
      assert.equal(authorizationUrl.searchParams.get("force_login"), "true", "Adding X accounts must allow signing in to a different account");
      assert.equal(authorizationUrl.searchParams.getAll("force_login").length, 1);
      authorizationUrl.searchParams.set("force_login", "false");
      assert.equal(authorizationUrl.href, originalUrl, "Preserve the Postiz request token, endpoint and other parameters");
    }
  }
  for (const [provider, originalUrl] of [
    ["x", "https://api.x.com/oauth/authenticate?oauth_token=synthetic-request-token"],
    ["x", "https://twitter.com/i/oauth2/authorize?state=synthetic&code_challenge=synthetic-challenge"],
    ["facebook", "https://www.facebook.com/dialog/oauth?state=synthetic"],
    ["x", "https://other.example.test/oauth/authenticate?oauth_token=synthetic"],
    ["facebook", "https://api.x.com/oauth/authenticate?oauth_token=synthetic"]
  ]) {
    upstreamBody = JSON.stringify(originalUrl);
    const actualUrl = await postiz.createPostizAuthorizationUrl(provider, `${baseUrl}/api/social/connect`);
    const expectedUrl = new URL(originalUrl);
    if (provider === "x" && expectedUrl.hostname === "api.x.com") expectedUrl.searchParams.set("force_login", "true");
    assert.equal(actualUrl, expectedUrl.href);
  }
  upstreamBody = originalUpstreamBody;
  delete process.env.POSTIZ_JWT_SECRET;
  assert.equal((await routes.POST(startRequest({ provider: "x" }))).status, 503);
  process.env.POSTIZ_JWT_SECRET = "synthetic-postiz-jwt-secret-for-testing";
  for (const invalidUrl of ["javascript:alert(1)", "http://untrusted.example.test/", "https://user:password@example.test/", "", "<html>failure</html>"]) {
    upstreamBody = JSON.stringify(invalidUrl);
    const failure = await routes.POST(startRequest({ provider: "x" }));
    assert.equal(failure.status, 502);
    const failureText = await failure.text();
    assert.ok(!failureText.includes(process.env.POSTIZ_API_KEY) && !failureText.includes(params), "Failures must not expose server credentials or signed tokens");
    assert.equal(failure.cookies.get("polaris-postiz-connect"), undefined);
  }
  upstreamStatus = 404;
  assert.match((await (await routes.POST(startRequest({ provider: "x" }))).json()).error, /does not support direct/);
  globalThis.fetch = async () => { throw new Error("synthetic-postiz-api-key should not be exposed"); };
  assert.ok(!(await (await routes.POST(startRequest({ provider: "x" }))).text()).includes(process.env.POSTIZ_API_KEY));

  const translations = loadModule("src/lib/i18n.tsx");
  const connectionResults = loadModule("src/lib/social-connect-result.ts");
  const Dialog = loadModule("src/components/ConnectAccountsDialog.tsx", {
    "@/lib/types": platformTypes, "@/lib/i18n": translations, "@/lib/social-connect-result": connectionResults
  }).default;
  const dialogMarkup = renderToStaticMarkup(createElement(translations.LocaleContext.Provider, { value: "zh" }, createElement(Dialog, {
    open: true, configured: true, oauthConfigured: false, loading: false, uiUrl: "https://postiz.example.test", accounts: [], error: "", onClose() {}, async onRefresh() {}
  })));
  assert.match(dialogMarkup, /请联系管理员检查配置/);
  assert.match(dialogMarkup, /role="dialog"/);
  assert.ok(dialogMarkup.includes("<strong>LinkedIn Page</strong>"), "The picker must identify the company Page connection");
  const linkedInDialogMarkup = renderToStaticMarkup(createElement(translations.LocaleContext.Provider, { value: "zh" }, createElement(Dialog, {
    open: true, configured: true, oauthConfigured: true, loading: false, accounts: [
      { id: "personal", name: "Personal profile", identifier: "linkedin" },
      { id: "company", name: "Company page", identifier: "linkedin-page" }
    ], error: "", onClose() {}, async onRefresh() {}
  })));
  assert.ok(linkedInDialogMarkup.includes(`<strong>LinkedIn Page</strong><small>1 ${translations.translate("zh", "connected")}</small>`), "The Page connection count must exclude personal profiles");
  assert.equal((dialogMarkup.match(/type="radio"/g) || []).length, 6);
  assert.ok(dialogMarkup.includes('value="youtube"'));
  assert.ok(dialogMarkup.includes("<strong>YouTube</strong>"));
  assert.ok(!dialogMarkup.includes('type="password"'), "The connection UI must never collect social passwords");
  assert.ok(!dialogMarkup.includes("前往发布控制台连接"), "Members must not be offered the direct Postiz hand-off");
  const adminDialogMarkup = renderToStaticMarkup(createElement(translations.LocaleContext.Provider, { value: "zh" }, createElement(Dialog, {
    open: true, configured: true, oauthConfigured: false, loading: false, uiUrl: "https://postiz.example.test", accounts: [], error: "", onClose() {}, async onRefresh() {}, canUsePostizUi: true
  })));
  assert.ok(adminDialogMarkup.includes("前往发布控制台连接"), "Administrators keep the direct Postiz hand-off");
  const previousWindow = globalThis.window;
  try {
    for (const retryOutcome of ["error", "unconfirmed"]) {
      const listeners = new Map();
      const references = [];
      const stateUpdates = new Map();
      let stateIndex = 0;
      let closeCount = 0;
      let refreshCount = 0;
      globalThis.window = {
        location: { origin: baseUrl },
        addEventListener: (type, listener) => listeners.set(type, listener),
        setInterval: () => 1
      };
      const ReturnDialog = loadModule("src/components/ConnectAccountsDialog.tsx", {
        react: {
          useRef: initial => { const reference = { current: initial }; references.push(reference); return reference; },
          useState: initial => { const index = stateIndex++; return [initial, value => stateUpdates.set(index, value)]; },
          useEffect: effect => { effect(); }
        },
        "@/lib/types": platformTypes,
        "@/lib/i18n": { useTranslation: () => text => text },
        "@/lib/social-connect-result": connectionResults
      }).default;
      ReturnDialog({ open: false, onClose: () => { closeCount++; }, onRefresh: async () => { refreshCount++; } });
      const popup = { closed: false };
      references[0].current = popup;
      const handleReturn = listeners.get("message");
      const sendReturn = (outcome, source = popup, origin = baseUrl) => handleReturn({ origin, source, data: { type: "POLARIS_POSTIZ_RETURNED", outcome } });
      sendReturn("returned", {}, baseUrl);
      sendReturn("returned", popup, "https://untrusted.example.test");
      assert.equal(closeCount, 0, "Foreign source/origin messages cannot complete authorisation");
      sendReturn(retryOutcome);
      assert.equal(references[0].current, popup, "Retryable returns must preserve the popup source");
      assert.equal(stateUpdates.get(2), true, "The existing popup remains the active authorisation attempt");
      sendReturn("returned");
      assert.equal(references[0].current, null);
      assert.equal(stateUpdates.get(2), false);
      assert.equal(closeCount, 1, "Retry success closes the original connection dialog");
      assert.equal(refreshCount, 2);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  console.log("PASS: retryable popup messages preserve origin/source validation; retry success refreshes accounts and closes the connection dialog.");
  console.log("PASS: URL normalization; server-only JWT signature and expiry; authenticated member access; CSRF/input rejection; user-bound callback state; credential-safe errors; unsupported Postiz fallback; accessible translated platform picker; member Postiz hand-off hidden.");
} finally {
  globalThis.fetch = previousFetch;
  for (const name of environmentNames) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
}
