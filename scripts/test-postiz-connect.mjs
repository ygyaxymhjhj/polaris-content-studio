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
// The route logs expected best-effort failures (attempt record without a database) through
// console.error; keep the regression output readable while assertion failures still surface.
const originalConsoleError = console.error;
console.error = () => {};
const platformTypes = loadModule("src/lib/types.ts");
const postiz = loadModule("src/lib/postiz.ts", { "./types": platformTypes });
const capturedRequests = [];
let upstreamBody = JSON.stringify("https://twitter.com/i/oauth2/authorize?state=synthetic-provider-state");
let upstreamStatus = 200;
let currentAccount = null;
const sameOriginModule = loadModule("src/lib/same-origin.ts");
const routes = loadModule("src/app/api/social/connect/route.ts", {
  "@/lib/postiz": postiz,
  "@/lib/auth": { currentUser: async () => currentAccount, unauthorized: () => NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 }) },
  "@/lib/same-origin": sameOriginModule,
  // The route records a best-effort connect attempt for ownership claiming; this regression has no
  // database, and the route must treat a missing database as "claim later, by an administrator".
  "@/lib/social-accounts": {
    createConnectAttempt: async () => { throw new Error("database is not configured in this regression"); },
    consumeConnectAttempt: async () => null,
    claimNewAccounts: async () => []
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
  assert.equal(new URL(callbackResponse.headers.get("location")).searchParams.get("connection"), "returned");
  assert.equal(callbackResponse.cookies.get(cookie.name).maxAge, 0);
  for (const callback of [returnRequest(tokenPayload.redirectUrl), returnRequest(`${baseUrl}/api/social/connect?state=forged`, cookieHeader)]) {
    assert.equal(new URL((await routes.GET(callback)).headers.get("location")).searchParams.get("connection"), "invalid");
  }
  currentAccount = { user: { id: "another-member", role: "member" } };
  assert.equal(new URL((await routes.GET(returnRequest(tokenPayload.redirectUrl, cookieHeader))).headers.get("location")).searchParams.get("connection"), "invalid");
  currentAccount = null;
  assert.equal(new URL((await routes.GET(returnRequest(tokenPayload.redirectUrl, cookieHeader))).headers.get("location")).pathname, "/login");

  currentAccount = { user: { id: "member-one", role: "member" } };
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
  const Dialog = loadModule("src/components/ConnectAccountsDialog.tsx", { "@/lib/types": platformTypes, "@/lib/i18n": translations }).default;
  const dialogMarkup = renderToStaticMarkup(createElement(translations.LocaleContext.Provider, { value: "zh" }, createElement(Dialog, {
    open: true, configured: true, oauthConfigured: false, loading: false, uiUrl: "https://postiz.example.test", accounts: [], error: "", onClose() {}, async onRefresh() {}
  })));
  assert.match(dialogMarkup, /POSTIZ_JWT_SECRET/);
  assert.match(dialogMarkup, /role="dialog"/);
  assert.equal((dialogMarkup.match(/type="radio"/g) || []).length, 5);
  assert.ok(!dialogMarkup.includes('type="password"'), "The connection UI must never collect social passwords");
  assert.ok(!dialogMarkup.includes("改用 Postiz 连接"), "Members must not be offered the direct Postiz hand-off");
  const adminDialogMarkup = renderToStaticMarkup(createElement(translations.LocaleContext.Provider, { value: "zh" }, createElement(Dialog, {
    open: true, configured: true, oauthConfigured: false, loading: false, uiUrl: "https://postiz.example.test", accounts: [], error: "", onClose() {}, async onRefresh() {}, canUsePostizUi: true
  })));
  assert.ok(adminDialogMarkup.includes("改用 Postiz 连接"), "Administrators keep the direct Postiz hand-off");
  console.log("PASS: URL normalization; server-only JWT signature and expiry; authenticated member access; CSRF/input rejection; user-bound callback state; credential-safe errors; unsupported Postiz fallback; accessible translated platform picker; member Postiz hand-off hidden.");
} finally {
  globalThis.fetch = previousFetch;
  console.error = originalConsoleError;
  for (const name of environmentNames) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
}
