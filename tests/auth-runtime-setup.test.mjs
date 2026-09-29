import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

function envValue(text, key) {
  return text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1] ?? "";
}

test("auth setup creates private independent app secrets without printing their values and remains idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "travel-auth-setup-"));
  const envFile = join(root, "env_travel.local");
  const execute = () => run(process.execPath, [join(process.cwd(), "scripts", "setup-auth-runtime.mjs")], { env: { ...process.env, TRAVEL_AGENT_ENV_FILE: envFile } });
  const firstRun = await execute();
  const first = JSON.parse(firstRun.stdout);
  const firstText = await readFile(envFile, "utf8");
  const sessionSecret = envValue(firstText, "TRAVEL_AGENT_SESSION_SECRET");
  const stateSecret = envValue(firstText, "TRAVEL_AGENT_AUTH_STATE_SECRET");
  assert.equal(first.secretValuesPrinted, false);
  assert.ok(sessionSecret.length >= 32);
  assert.ok(stateSecret.length >= 32);
  assert.notEqual(sessionSecret, stateSecret);
  assert.equal(firstRun.stdout.includes(sessionSecret), false);
  assert.equal(firstRun.stdout.includes(stateSecret), false);
  assert.equal((await stat(envFile)).mode & 0o077, 0);
  const second = JSON.parse((await execute()).stdout);
  const secondText = await readFile(envFile, "utf8");
  assert.deepEqual(second.generated, []);
  assert.equal(envValue(secondText, "TRAVEL_AGENT_SESSION_SECRET"), sessionSecret);
  assert.equal(envValue(secondText, "TRAVEL_AGENT_AUTH_STATE_SECRET"), stateSecret);
});

test("auth configuration check reports exact callbacks only when every channel has passed live smoke", async () => {
  const root = await mkdtemp(join(tmpdir(), "travel-auth-check-"));
  const envFile = join(root, "env_travel.local");
  const webPrivate = join(root, "alipay-web-private.pem");
  const webPublic = join(root, "alipay-web-public.pem");
  const miniPrivate = join(root, "alipay-mini-private.pem");
  const miniPublic = join(root, "alipay-mini-public.pem");
  const applePrivate = join(root, "AuthKey_TEST.p8");
  const webKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const miniKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appleKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await Promise.all([
    writeFile(webPrivate, webKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }),
    writeFile(webPublic, webKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 }),
    writeFile(miniPrivate, miniKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }),
    writeFile(miniPublic, miniKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 }),
    writeFile(applePrivate, appleKeys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 }),
  ]);
  await writeFile(envFile, [
    "DATABASE_URL=postgres://localhost/travel_auth_configuration_fixture",
    "TRAVEL_AGENT_PUBLIC_ORIGIN=https://travel.example.com",
    `TRAVEL_AGENT_SESSION_SECRET=${"s".repeat(48)}`,
    `TRAVEL_AGENT_AUTH_STATE_SECRET=${"a".repeat(48)}`,
    "GOOGLE_CLIENT_ID=google-client",
    "GOOGLE_CLIENT_SECRET=google-secret",
    "TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS=passed_live_smoke",
    "WECHAT_OPEN_APP_ID=wechat-web",
    "WECHAT_OPEN_APP_SECRET=wechat-secret",
    "TRAVEL_AGENT_WECHAT_WEB_AUTH_SMOKE_STATUS=passed_live_smoke",
    "WECHAT_MINIAPP_APP_ID=wechat-mini",
    "WECHAT_MINIAPP_APP_SECRET=wechat-mini-secret",
    "TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS=passed_live_smoke",
    "ALIPAY_WEB_APP_ID=alipay-web",
    `ALIPAY_WEB_PRIVATE_KEY_PATH=${webPrivate}`,
    `ALIPAY_WEB_PUBLIC_KEY_PATH=${webPublic}`,
    "TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS=passed_live_smoke",
    "ALIPAY_MINIAPP_APP_ID=alipay-mini",
    `ALIPAY_MINIAPP_PRIVATE_KEY_PATH=${miniPrivate}`,
    `ALIPAY_MINIAPP_PUBLIC_KEY_PATH=${miniPublic}`,
    "TRAVEL_AGENT_ALIPAY_MINIAPP_AUTH_SMOKE_STATUS=passed_live_smoke",
    "APPLE_CLIENT_ID=com.example.travel.web",
    "APPLE_TEAM_ID=TEAM123",
    "APPLE_KEY_ID=KEY123",
    `APPLE_PRIVATE_KEY_PATH=${applePrivate}`,
    "TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS=passed_live_smoke",
  ].join("\n"), { mode: 0o600 });
  const result = await run(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts", "check-auth-configuration.mjs")], { env: { ...process.env, TRAVEL_AGENT_ENV_FILE: envFile } });
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "passed");
  assert.equal(report.secretsPrinted, false);
  assert.deepEqual(report.callbackUrls, {
    google: "https://travel.example.com/api/auth/google/callback",
    wechat: "https://travel.example.com/api/auth/wechat/callback",
    alipay: "https://travel.example.com/api/auth/alipay/callback",
    apple: "https://travel.example.com/api/auth/apple/callback",
    platformExchange: "https://travel.example.com/api/auth/platform-exchange",
    desktopExchange: "https://travel.example.com/api/auth/desktop-exchange",
    desktopDeepLink: "zhuanshu-travel://auth/callback",
  });
  assert.equal(report.desktop.status, "disabled_until_desktop_release");
  assert.equal(report.channels.every((channel) => channel.status === "passed_live_smoke"), true);
  await writeFile(envFile, (await readFile(envFile, "utf8")).replace(/^DATABASE_URL=.*\n/m, ""));
  await assert.rejects(run(process.execPath, ["--import", "tsx", join(process.cwd(), "scripts", "check-auth-configuration.mjs")], { env: { ...process.env, DATABASE_URL: "", TRAVEL_AGENT_ENV_FILE: envFile } }), (error) => {
    const missingDatabase = JSON.parse(error.stdout);
    assert.equal(missingDatabase.status, "needs_manual_configuration");
    assert.ok(missingDatabase.sharedIssues.some((issue) => issue.startsWith("DATABASE_URL")));
    return true;
  });
});
