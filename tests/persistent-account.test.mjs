import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PostgresTripRepository } from "../src/persistence/postgres-trip-repository.mjs";
import { AuthRepository } from "../src/persistence/auth-repository.mjs";
import { AccountService } from "../src/http/account-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { createAuthService } from "../src/http/auth-providers.mjs";

for (const backend of ["sqlite", "postgres"]) {
  test(`${backend}: sessions and revocations survive recreation and are shared by independent instances`, { skip: backend === "postgres" && !process.env.TRAVEL_AUTH_TEST_DATABASE_URL }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "travel-account-store-"));
    const options = backend === "postgres" ? { databaseUrl: process.env.TRAVEL_AUTH_TEST_DATABASE_URL } : { filename: join(directory, "auth.sqlite") };
    let now = Date.now();
    const clock = () => new Date(now);
    const firstRepo = new AuthRepository(options);
    const first = new AccountService({ repository: firstRepo, clock });
    const subject = randomUUID();
    const userId = await first.resolveIdentity({ provider: "google", subject, displayName: "Store test" });
    const a = await first.issue({ userId, provider: "google", device: "Chrome · macOS" });
    const b = await first.issue({ userId, provider: "google", device: "Safari · iOS" });
    const secondRepo = new AuthRepository(options);
    const second = new AccountService({ repository: secondRepo, clock });
    try {
      assert.equal((await second.read(a.opaqueToken)).userId, userId);
      await second.revokeSession(userId, b.sessionId);
      assert.equal(await first.read(b.opaqueToken), null);
      await firstRepo.close();
      const thirdRepo = new AuthRepository(options);
      const third = new AccountService({ repository: thirdRepo, clock });
      try {
        assert.equal((await third.read(a.opaqueToken)).sessionId, a.sessionId);
        assert.equal(await third.read(b.opaqueToken), null);
        const listed = await third.listSessions(userId, a.sessionId);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].current, true);
        assert.equal(JSON.stringify(listed).includes(a.opaqueToken), false);
        const stored = await thirdRepo.query("SELECT token_hash FROM travel_auth_sessions WHERE session_id=$1", [a.sessionId]);
        assert.match(stored.rows[0].token_hash, /^[a-f0-9]{64}$/);
        assert.notEqual(stored.rows[0].token_hash, a.opaqueToken);
        const challenge = await third.issueChallenge("desktop", { identity: { provider: "google", subject } });
        const results = await Promise.all([second.consumeChallenge("desktop", challenge.code), third.consumeChallenge("desktop", challenge.code)]);
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(await third.consumeChallenge("desktop", challenge.code), null);
        const short = await third.issue({ userId, provider: "google", ttlMs: 50 });
        now += 51;
        assert.equal(await second.read(short.opaqueToken), null);
        const c = await third.issue({ userId, provider: "google" });
        await second.revokeOthers(userId, a.sessionId);
        assert.equal(await third.read(c.opaqueToken), null);
        assert.ok(await third.read(a.opaqueToken));
        const otherUser = await third.resolveIdentity({ provider: "apple", subject: randomUUID() });
        await assert.rejects(second.revokeSession(otherUser, a.sessionId), { code: "session_not_found" });
        if (backend === "sqlite" && process.platform !== "win32") assert.equal((await stat(options.filename)).mode & 0o077, 0);
      } finally { await thirdRepo.close(); }
    } finally { await secondRepo.close(); }
  });

  test(`${backend}: linking preserves one account, cannot steal identities, and keeps a usable login method`, { skip: backend === "postgres" && !process.env.TRAVEL_AUTH_TEST_DATABASE_URL }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "travel-account-link-"));
    const repository = new AuthRepository(backend === "postgres" ? { databaseUrl: process.env.TRAVEL_AUTH_TEST_DATABASE_URL } : { filename: join(directory, "auth.sqlite") });
    const auth = new AccountService({ repository });
    try {
      const google = { provider: "google", subject: randomUUID() };
      const wechat = { provider: "wechat", subject: randomUUID() };
      const userId = await auth.resolveIdentity(google);
      const token = await auth.issue({ userId, provider: "google" });
      const session = await auth.read(token.opaqueToken);
      await auth.linkIdentity(session, wechat);
      assert.equal(await auth.resolveIdentity(wechat), userId);
      const identities = await auth.identities(userId);
      assert.equal(identities.length, 2);
      const otherUser = await auth.resolveIdentity({ provider: "apple", subject: randomUUID() });
      const other = await auth.issue({ userId: otherUser, provider: "apple" });
      await assert.rejects(auth.linkIdentity(await auth.read(other.opaqueToken), wechat), { code: "identity_already_linked" });
      const wechatSession = await auth.issue({ userId, provider: "wechat" });
      await auth.unlinkIdentity(session, identities.find((item) => item.provider === "wechat").id);
      assert.equal(await auth.read(wechatSession.opaqueToken), null);
      await assert.rejects(auth.unlinkIdentity(session, identities.find((item) => item.provider === "google").id), { code: "last_login_method_required" });
      await auth.revoke(token.opaqueToken);
      await assert.rejects(auth.linkIdentity(session, { provider: "apple", subject: randomUUID() }), { code: "authentication_required" });
    } finally { await repository.close(); }
  });
}

async function listen(app) {
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: async () => { await new Promise((done) => server.close(done)); await app.locals.close(); } };
}

for (const backend of ["sqlite", "postgres"]) {
test(`${backend} HTTP account: persistent login, profile, device revocation, binding and session-bound callback`, { skip: backend === "postgres" && !process.env.TRAVEL_AUTH_TEST_DATABASE_URL }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "travel-account-http-"));
  const env = { NODE_ENV: "test", TRAVEL_AGENT_DATA_DIR: directory, TRAVEL_AGENT_PUBLIC_ORIGIN: "https://travel.example.com", TRAVEL_AGENT_SESSION_SECRET: "s".repeat(48), TRAVEL_AGENT_AUTH_STATE_SECRET: "a".repeat(48), WECHAT_OPEN_APP_ID: "web", WECHAT_OPEN_APP_SECRET: "secret", WECHAT_MINIAPP_APP_ID: "mini", WECHAT_MINIAPP_APP_SECRET: "secret" };
  if (backend === "postgres") {
    env.DATABASE_URL = process.env.TRAVEL_AUTH_TEST_DATABASE_URL;
    const trips = new PostgresTripRepository({ databaseUrl: env.DATABASE_URL });
    await trips.migrate();
    await trips.close();
  }
  const repository = new AuthRepository({ databaseUrl: env.DATABASE_URL, filename: join(directory, "auth.sqlite") });
  const subject = randomUUID();
  const accountService = new AccountService({ repository });
  const userId = await accountService.resolveIdentity({ provider: "google", subject });
  const token = await accountService.issue({ userId, provider: "google", device: "Test browser" });
  const authService = createAuthService({ env, fetchImpl: async (url) => {
    const params = new URL(url).searchParams;
    return new Response(JSON.stringify({ openid: "openid", unionid: params.get("code") || params.get("js_code") }));
  } });
  const app = createHttpApp({ runtimeEnv: env, authService, accountService });
  const fixture = await listen(app);
  const call = (path, { method = "GET", body, access = token.opaqueToken } = {}) => fetch(`${fixture.origin}${path}`, { method, headers: { ...(access ? { authorization: `Bearer ${access}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  try {
    const view = await (await call("/api/account")).json();
    assert.equal(view.userId, userId);
    assert.equal(view.sessions[0].current, true);
    const profile = await call("/api/account/profile", { method: "POST", body: { displayName: "旅行的名字" } });
    assert.equal((await profile.json()).displayName, "旅行的名字");
    const intent = await (await call("/api/account/link-intent", { method: "POST", body: { provider: "wechat" } })).json();
    const start = await call(intent.startPath, { access: null });
    assert.equal(start.status, 302);
    const redirect = new URL(start.headers.get("location"));
    const cookies = start.headers.getSetCookie().map((item) => item.split(";")[0]).join("; ");
    const callbackPath = `/api/auth/wechat/callback?code=${subject}&state=${encodeURIComponent(redirect.searchParams.get("state"))}`;
    const wrongSession = await accountService.issue({ userId, provider: "google" });
    const wrong = await fetch(`${fixture.origin}${callbackPath}`, { headers: { cookie: cookies, authorization: `Bearer ${wrongSession.opaqueToken}` }, redirect: "manual" });
    assert.match(wrong.headers.get("location"), /auth_error=auth_link_session_changed/);
    assert.equal((await accountService.identities(userId)).length, 1);
    const valid = await fetch(`${fixture.origin}${callbackPath}`, { headers: { cookie: cookies, authorization: `Bearer ${token.opaqueToken}` }, redirect: "manual" });
    assert.match(valid.headers.get("location"), /auth=linked/);
    const mini = await call("/api/auth/platform-exchange", { method: "POST", access: null, body: { provider: "wechat", authorizationCode: subject } });
    const miniSession = await mini.json();
    assert.equal(miniSession.userId, userId);
    assert.ok(miniSession.accessToken);
    await call(`/api/account/sessions/${miniSession.sessionId}`, { method: "DELETE" });
    assert.equal((await call("/api/session", { access: miniSession.accessToken })).status, 401);
    const replay = await call(intent.startPath, { access: null });
    assert.equal(replay.status, 400);
    assert.equal((await call("/api/account", { access: null })).status, 401);
    const guest = await (await call("/api/auth/guest-session", { method: "POST", access: null })).json();
    assert.equal(guest.guest, true);
    assert.equal((await call("/api/account/link-intent", { method: "POST", body: { provider: "wechat" }, access: null })).status, 401);
    await fixture.close();
    await repository.close();
    const restarted = await listen(createHttpApp({ runtimeEnv: env, authService }));
    try {
      const restored = await fetch(`${restarted.origin}/api/session`, { headers: { authorization: `Bearer ${token.opaqueToken}` } });
      assert.equal((await restored.json()).displayName, "旅行的名字");
      const revoked = await fetch(`${restarted.origin}/api/session`, { headers: { authorization: `Bearer ${miniSession.accessToken}` } });
      assert.equal(revoked.status, 401);
    } finally { await restarted.close(); }
  } catch (error) { await fixture.close().catch(() => {}); await repository.close().catch(() => {}); throw error; }
});

}
