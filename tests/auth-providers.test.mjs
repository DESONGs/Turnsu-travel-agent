import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { TravelService } from "../src/api/travel-service.mjs";
import { createAuthService } from "../src/http/auth-providers.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { authenticatedUserId, DesktopAuthCodeStore, SignedSessionStore } from "../src/http/session.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";

const fixedClock = () => new Date("2026-08-17T08:00:00.000Z");
const sessionSecret = "session-secret-for-tests-only-1234567890";
const stateSecret = "state-secret-for-tests-only-123456789012";

function googleEnv(overrides = {}) {
  return {
    NODE_ENV: "development",
    TRAVEL_AGENT_SESSION_SECRET: sessionSecret,
    TRAVEL_AGENT_AUTH_STATE_SECRET: stateSecret,
    GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-client-secret-for-test",
    ...overrides,
  };
}

function signedGoogleToken({ privateKey, kid, nonce, claims = {} }) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "google-client-id.apps.googleusercontent.com",
    sub: "google-subject-123",
    name: "旅行者 Google",
    nonce,
    iat: Math.floor(fixedClock().getTime() / 1000),
    exp: Math.floor(fixedClock().getTime() / 1000) + 600,
    ...claims,
  })).toString("base64url");
  const content = `${header}.${payload}`;
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url")}`;
}

test("auth provider summary exposes usable login choices without exposing credentials", () => {
  const service = createAuthService({ env: googleEnv(), clock: fixedClock });
  const summary = service.providerSummary({ origin: "http://127.0.0.1:8797" });
  assert.equal(summary.primaryProvider, "google");
  assert.equal(summary.providers.find((provider) => provider.id === "google").available, true);
  assert.equal(summary.providers.find((provider) => provider.id === "wechat").available, false);
  assert.equal(summary.providers.find((provider) => provider.id === "wechat").unavailableReason, "https_required");
  assert.equal(JSON.stringify(summary).includes("google-client-secret-for-test"), false);
});

test("Google authorization uses signed state and verifies the returned identity token", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "google-test-key";
  jwk.alg = "RS256";
  const calls = [];
  let idToken;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    if (String(url) === "https://www.googleapis.com/oauth2/v3/certs") return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const service = createAuthService({ env: googleEnv(), fetchImpl, clock: fixedClock });
  const authorization = service.beginWeb({ provider: "google", origin: "http://127.0.0.1:8797", returnTo: "/?from=login", client: "desktop" });
  const url = new URL(authorization.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "openid email profile");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8797/api/auth/google/callback");
  assert.equal(authorization.authorizationUrl.includes("google-client-secret-for-test"), false);
  idToken = signedGoogleToken({ privateKey, kid: jwk.kid, nonce: authorization.nonce });
  const completed = await service.completeWeb({ provider: "google", code: "single-use-code", state: authorization.state, nonce: authorization.nonce });
  assert.equal(completed.identity.provider, "google");
  assert.equal(completed.identity.subject, "google-subject-123");
  assert.equal(completed.identity.displayName, "旅行者 Google");
  assert.equal(completed.returnTo, "/?from=login");
  assert.equal(completed.client, "desktop");
  assert.deepEqual(calls.map((call) => call.url), ["https://oauth2.googleapis.com/token", "https://www.googleapis.com/oauth2/v3/certs"]);
  await assert.rejects(
    service.completeWeb({ provider: "google", code: "code", state: `${authorization.state}tampered`, nonce: authorization.nonce }),
    (error) => error.code === "auth_state_invalid",
  );
});

test("WeChat Website QR login uses signed state and exchanges the callback code server-side", async () => {
  let requestedUrl;
  const service = createAuthService({
    env: googleEnv({ WECHAT_OPEN_APP_ID: "wx-web-app", WECHAT_OPEN_APP_SECRET: "wx-web-secret" }),
    clock: fixedClock,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({ openid: "wechat-web-open-id", unionid: "wechat-union-id" }), { status: 200 });
    },
  });
  const authorization = service.beginWeb({ provider: "wechat", origin: "https://travel.example.com", returnTo: "/trip/continue" });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://open.weixin.qq.com");
  assert.equal(authorizationUrl.pathname, "/connect/qrconnect");
  assert.equal(authorizationUrl.searchParams.get("scope"), "snsapi_login");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://travel.example.com/api/auth/wechat/callback");
  const completed = await service.completeWeb({ provider: "wechat", code: "wechat-single-use-code", state: authorization.state, nonce: authorization.nonce });
  assert.equal(completed.identity.provider, "wechat");
  assert.equal(completed.identity.subject, "wechat-union-id");
  assert.equal(completed.returnTo, "/trip/continue");
  assert.equal(requestedUrl.origin, "https://api.weixin.qq.com");
  assert.equal(requestedUrl.pathname, "/sns/oauth2/access_token");
  assert.equal(requestedUrl.searchParams.get("code"), "wechat-single-use-code");
});

test("WeChat Mini Program authorization code is exchanged server-side", async () => {
  const env = googleEnv({ WECHAT_MINIAPP_APP_ID: "wx-mini-app", WECHAT_MINIAPP_APP_SECRET: "wx-mini-secret" });
  let requestedUrl;
  const service = createAuthService({
    env,
    clock: fixedClock,
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({ openid: "wechat-open-id", unionid: "wechat-union-id" }), { status: 200 });
    },
  });
  const identity = await service.exchangePlatform({ provider: "wechat", authorizationCode: "wx-one-time-code" });
  assert.equal(identity.subject, "wechat-union-id");
  assert.equal(requestedUrl.origin, "https://api.weixin.qq.com");
  assert.equal(requestedUrl.searchParams.get("js_code"), "wx-one-time-code");
});

test("Alipay Web and Mini Program codes use RSA2 request signing and verified provider responses", async () => {
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const alipay = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const merchantPrivate = merchant.privateKey.export({ type: "pkcs8", format: "pem" });
  const alipayPublic = alipay.publicKey.export({ type: "spki", format: "pem" });
  const responseObject = { code: "10000", msg: "Success", user_id: "alipay-user-123" };
  const responseText = JSON.stringify(responseObject);
  const responseSignature = sign("RSA-SHA256", Buffer.from(responseText), alipay.privateKey).toString("base64");
  const calls = [];
  const service = createAuthService({
    env: googleEnv({
      ALIPAY_WEB_APP_ID: "alipay-web-app-id",
      ALIPAY_WEB_PRIVATE_KEY_PATH: "/secure/merchant-private.pem",
      ALIPAY_WEB_PUBLIC_KEY_PATH: "/secure/alipay-public.pem",
      ALIPAY_MINIAPP_APP_ID: "alipay-mini-app-id",
      ALIPAY_MINIAPP_PRIVATE_KEY_PATH: "/secure/merchant-private.pem",
      ALIPAY_MINIAPP_PUBLIC_KEY_PATH: "/secure/alipay-public.pem",
    }),
    clock: fixedClock,
    readFileImpl: async (path) => path.includes("merchant-private") ? merchantPrivate : alipayPublic,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), parameters: new URLSearchParams(options.body) });
      return new Response(JSON.stringify({ alipay_system_oauth_token_response: responseObject, sign: responseSignature }), { status: 200 });
    },
  });
  const authorization = service.beginWeb({ provider: "alipay", origin: "https://travel.example.com", returnTo: "/saved-trip" });
  const authorizationUrl = new URL(authorization.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://openauth.alipay.com");
  assert.equal(authorizationUrl.searchParams.get("app_id"), "alipay-web-app-id");
  assert.equal(authorizationUrl.searchParams.get("scope"), "auth_user");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://travel.example.com/api/auth/alipay/callback");
  const web = await service.completeWeb({ provider: "alipay", code: "alipay-web-code", state: authorization.state, nonce: authorization.nonce });
  assert.equal(web.identity.subject, "alipay-user-123");
  assert.equal(web.returnTo, "/saved-trip");
  const mini = await service.exchangePlatform({ provider: "alipay", authorizationCode: "alipay-mini-code" });
  assert.equal(mini.subject, "alipay-user-123");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://openapi.alipay.com/gateway.do");
  assert.equal(calls[0].parameters.get("app_id"), "alipay-web-app-id");
  assert.equal(calls[1].parameters.get("app_id"), "alipay-mini-app-id");
  assert.equal(calls[0].parameters.get("method"), "alipay.system.oauth.token");
  assert.equal(calls[0].parameters.get("sign_type"), "RSA2");
  assert.ok(calls[0].parameters.get("sign"));
});

test("signed production sessions survive store recreation and reject tampering or logout reuse", () => {
  const first = new SignedSessionStore({ secret: sessionSecret, clock: fixedClock });
  const userId = authenticatedUserId({ provider: "google", subject: "subject-1" });
  const issued = first.issue({ userId, provider: "google", displayName: "旅行者" });
  const second = new SignedSessionStore({ secret: sessionSecret, clock: fixedClock });
  assert.equal(second.read(issued.opaqueToken).userId, userId);
  assert.equal(second.read(issued.opaqueToken).displayName, "旅行者");
  assert.equal(second.read(`${issued.opaqueToken}x`), null);
  second.revoke(issued.opaqueToken);
  assert.equal(second.read(issued.opaqueToken), null);
});

test("all Mini Program exchanges reject a weak session secret before contacting a provider", async () => {
  for (const provider of ["wechat", "alipay"]) {
    const service = createAuthService({
      env: googleEnv({ TRAVEL_AGENT_SESSION_SECRET: "short", WECHAT_MINIAPP_APP_ID: "app", WECHAT_MINIAPP_APP_SECRET: "secret", ALIPAY_APP_ID: "app", ALIPAY_PRIVATE_KEY_PATH: "/private", ALIPAY_PUBLIC_KEY_PATH: "/public" }),
      fetchImpl: async () => assert.fail("must not exchange with insecure session configuration"),
    });
    await assert.rejects(service.exchangePlatform({ provider, authorizationCode: "code" }), { code: "auth_provider_not_configured" });
  }
});

test("OIDC rejects signed tokens with missing or nonnumeric lifetime claims", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "lifetime-test" };
  let idToken;
  const service = createAuthService({ env: googleEnv(), clock: fixedClock, fetchImpl: async (url) => new Response(JSON.stringify(String(url).endsWith("/token") ? { id_token: idToken } : { keys: [jwk] })) });
  const authorization = service.beginWeb({ provider: "google", origin: "http://localhost:8797" });
  for (const claims of [{ exp: undefined }, { exp: "invalid" }, { iat: undefined }, { iat: "invalid" }]) {
    idToken = signedGoogleToken({ privateKey, kid: jwk.kid, nonce: authorization.nonce, claims });
    await assert.rejects(service.completeWeb({ provider: "google", code: "code", state: authorization.state, nonce: authorization.nonce }), { code: "auth_identity_token_invalid" });
  }
});

test("Apple form_post rejoins the shared Web login with its guest session and verified OIDC identity", async () => {
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...signing.publicKey.export({ format: "jwk" }), kid: "apple-test" };
  const env = googleEnv({ TRAVEL_AGENT_PUBLIC_ORIGIN: "https://travel.example.com", APPLE_CLIENT_ID: "apple-client", APPLE_TEAM_ID: "team", APPLE_KEY_ID: "key", APPLE_PRIVATE_KEY_PATH: "/test/apple.p8" });
  let idToken;
  let exchanges = 0;
  const authService = createAuthService({ env, clock: fixedClock,
    readFileImpl: async () => client.privateKey.export({ type: "pkcs8", format: "pem" }),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/token")) { exchanges += 1; return new Response(JSON.stringify({ id_token: idToken })); }
      return new Response(JSON.stringify({ keys: [jwk] }));
    },
  });
  const sessions = new SignedSessionStore({ secret: sessionSecret, clock: fixedClock });
  const guest = sessions.issue({ userId: "usr_guest_apple", provider: "guest" });
  const claims = [];
  const service = new TravelService({ store: new TripStore() });
  service.transferUserOwnership = async (value) => { claims.push(value); return { transferredTrips: 1 }; };
  const app = createHttpApp({ travelService: service, sessionStore: sessions, authService, runtimeEnv: env, clock: fixedClock,
    conversationRepository: { transferUserOwnership: async () => ({ transferredConversations: 1 }) },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${origin}/api/auth/apple/start`, { redirect: "manual" });
    const authorization = new URL(start.headers.get("location"));
    const cookies = start.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    idToken = signedGoogleToken({ privateKey: signing.privateKey, kid: jwk.kid, nonce: authorization.searchParams.get("nonce"), claims: { iss: "https://appleid.apple.com", aud: "apple-client", sub: "apple-user" } });
    const body = new URLSearchParams({ code: "apple-code", state: authorization.searchParams.get("state"), id_token: "must-not-leak", user: "private-profile" });
    const form = await fetch(`${origin}/api/auth/apple/callback`, { method: "POST", headers: { origin: "https://appleid.apple.com", "content-type": "application/x-www-form-urlencoded", cookie: cookies }, body, redirect: "manual" });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get("access-control-allow-origin"), null);
    assert.equal(form.headers.get("referrer-policy"), "no-referrer");
    const location = form.headers.get("location");
    assert.ok(location.startsWith("/api/auth/apple/callback?"));
    assert.equal(location.includes("must-not-leak"), false);
    assert.equal(location.includes("private-profile"), false);
    assert.equal(exchanges, 0);
    // Simulate the browser's top-level GET carrying its existing Lax session.
    const complete = await fetch(`${origin}${location}`, { headers: { cookie: `${cookies}; travel_session=${guest.opaqueToken}` }, redirect: "manual" });
    assert.equal(complete.headers.get("location"), "/?auth=success");
    assert.equal(exchanges, 1);
    assert.deepEqual(claims, [{ fromUserId: "usr_guest_apple", toUserId: authenticatedUserId({ provider: "apple", subject: "apple-user" }) }]);
    assert.equal(sessions.read(guest.opaqueToken), null);
    assert.ok(complete.headers.getSetCookie().some((cookie) => cookie.startsWith("travel_session=") && cookie.includes("HttpOnly")));
    const tampered = await fetch(`${origin}/api/auth/apple/callback?code=code&state=tampered`, { headers: { cookie: cookies }, redirect: "manual" });
    assert.match(tampered.headers.get("location"), /auth_error=auth_state_invalid/);
    assert.equal(exchanges, 1);
    for (const [path, requestOrigin] of [["/api/auth/apple/callback", "https://attacker.example"], ["/api/auth/platform-exchange", "https://appleid.apple.com"]]) {
      const denied = await fetch(`${origin}${path}`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/x-www-form-urlencoded" }, body, redirect: "manual" });
      assert.equal(denied.status, 403);
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("desktop OAuth codes are short-lived and consumed exactly once", () => {
  const store = new DesktopAuthCodeStore({ clock: fixedClock });
  const issued = store.issue({ identity: { provider: "google", subject: "desktop-subject", displayName: "Desktop User" }, returnTo: "/trip/1" });
  const consumed = store.consume(issued.code);
  assert.equal(consumed.identity.subject, "desktop-subject");
  assert.equal(consumed.returnTo, "/trip/1");
  assert.equal(store.consume(issued.code), null);
});

test("a failed guest claim preserves the old session; a successful Mini Program retry rotates it", async () => {
  const sessions = new SignedSessionStore({ secret: sessionSecret, clock: fixedClock });
  const guest = sessions.issue({ userId: "usr_guest_retry", provider: "guest" });
  const service = new TravelService({ store: new TripStore() });
  let failClaim = true;
  service.transferUserOwnership = async () => {
    if (failClaim) throw new Error("claim_unavailable");
    return { transferredTrips: 1 };
  };
  const app = createHttpApp({ travelService: service, sessionStore: sessions, clock: fixedClock, runtimeEnv: { NODE_ENV: "test" },
    authService: { exchangePlatform: async () => ({ provider: "wechat", subject: "retry-user" }) },
    conversationRepository: { transferUserOwnership: async () => ({ transferredConversations: 1 }) },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const exchange = (authorizationCode) => fetch(`${origin}/api/auth/platform-exchange`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${guest.opaqueToken}` },
    body: JSON.stringify({ provider: "wechat", authorizationCode }),
  });
  try {
    const failed = await exchange("first-code");
    assert.equal(failed.status, 500);
    assert.ok(sessions.read(guest.opaqueToken));
    failClaim = false;
    const retry = await exchange("fresh-code");
    assert.equal(retry.status, 201);
    const session = await retry.json();
    assert.deepEqual(session.claim, { transferredTrips: 1, transferredConversations: 1 });
    assert.ok(sessions.read(session.accessToken));
    assert.equal(sessions.read(guest.opaqueToken), null);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test("HTTP auth routes expose providers, redirect to login, issue Web cookies and return Mini Program bearer sessions", async () => {
  const sessionStore = new SignedSessionStore({ secret: sessionSecret, clock: fixedClock });
  const authService = {
    providerSummary: () => ({ schemaVersion: "auth-providers-v1", primaryProvider: "google", providers: [{ id: "google", label: "Google", available: true, startPath: "/api/auth/google/start" }] }),
    beginWeb: () => ({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test", nonce: "nonce-1", cookieSameSite: "lax", cookieSecure: false, cookieMaxAge: 600_000 }),
    completeWeb: async () => ({ identity: { provider: "google", subject: "subject-http", displayName: "HTTP User" }, returnTo: "/" }),
    exchangePlatform: async ({ provider }) => ({ provider, subject: "miniapp-subject", displayName: null }),
  };
  const store = new TripStore();
  store.mode = "memory";
  const app = createHttpApp({
    travelService: new TravelService({ store }),
    sessionStore,
    authService,
    runtimeEnv: { NODE_ENV: "development", TRAVEL_AGENT_SESSION_SECRET: sessionSecret, TRAVEL_AGENT_DESKTOP_AUTH_ENABLED: "true", TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME: "zhuanshu-travel" },
  });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const providers = await fetch(`${origin}/api/auth/providers`).then((response) => response.json());
    assert.equal(providers.primaryProvider, "google");
    const start = await fetch(`${origin}/api/auth/google/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location"), /^https:\/\/accounts\.google\.com/);
    assert.match(start.headers.get("set-cookie"), /travel_oauth_nonce_google=nonce-1/);

    const callback = await fetch(`${origin}/api/auth/google/callback?code=code&state=state`, { headers: { cookie: "travel_oauth_nonce_google=nonce-1" }, redirect: "manual" });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "/?auth=success");
    assert.match(callback.headers.get("set-cookie"), /travel_session=/);

    const platform = await fetch(`${origin}/api/auth/platform-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "wechat", authorizationCode: "code" }),
    });
    const platformSession = await platform.json();
    assert.equal(platform.status, 201);
    assert.equal(platformSession.provider, "wechat");
    assert.ok(sessionStore.read(platformSession.accessToken));

    const desktopStart = await fetch(`${origin}/api/auth/google/start?client=desktop&returnTo=%2Ftrip%2Fdesktop`, { redirect: "manual" });
    const desktopCookies = desktopStart.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
    assert.match(desktopCookies, /travel_oauth_client_google=desktop/);
    const desktopCallback = await fetch(`${origin}/api/auth/google/callback?code=code&state=state`, { headers: { cookie: desktopCookies }, redirect: "manual" });
    assert.equal(desktopCallback.status, 303);
    const deepLink = new URL(desktopCallback.headers.get("location"));
    assert.equal(deepLink.protocol, "zhuanshu-travel:");
    assert.equal(deepLink.hostname, "auth");
    assert.equal(deepLink.searchParams.has("code"), true);
    assert.equal(deepLink.searchParams.has("access_token"), false);

    const guestResponse = await fetch(`${origin}/api/auth/guest-session`, { method: "POST", headers: { "x-travel-client": "desktop" } });
    const desktopGuest = await guestResponse.json();
    assert.ok(desktopGuest.accessToken);
    const exchange = await fetch(`${origin}/api/auth/desktop-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-travel-client": "desktop", authorization: `Bearer ${desktopGuest.accessToken}` },
      body: JSON.stringify({ code: deepLink.searchParams.get("code") }),
    });
    const desktopSession = await exchange.json();
    assert.equal(exchange.status, 201);
    assert.equal(desktopSession.provider, "google");
    assert.ok(sessionStore.read(desktopSession.accessToken));
    assert.equal(sessionStore.read(desktopGuest.accessToken), null);
    const replay = await fetch(`${origin}/api/auth/desktop-exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-travel-client": "desktop" },
      body: JSON.stringify({ code: deepLink.searchParams.get("code") }),
    });
    assert.equal(replay.status, 400);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
