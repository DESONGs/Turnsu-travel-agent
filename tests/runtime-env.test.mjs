import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visualCompletionOptions } from "../src/agent/travel-conversation-agent.mjs";
import { loadTravelRuntimeEnv, parseTravelEnvFile } from "../src/http/runtime-env.mjs";

test("runtime env loader accepts only explicit Travel Agent keys and preserves key values out of its public surface", () => {
  const values = parseTravelEnvFile([
    "DEEPSEEK_API_KEY=example-deepseek-key",
    "TRAVEL_AGENT_DEEPSEEK_VISION_SMOKE_STATUS=passed_live_smoke",
    "MOONSHOT_API_KEY=example-kimi-key",
    "AMAP_API_KEY=example-amap-key",
    "AMAP_API_SECRET=example-amap-secret",
    "AMAP_JS_API_KEY=example-amap-js-key",
    "AMAP_JS_SECURITY_CODE=example-amap-js-security-code",
    "TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED=false",
    "TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS=passed_live_smoke",
    "TRAVEL_AGENT_FLYAI_ENABLED=true",
    "FLYAI_API_KEY=example-flyai-key",
    "TRAVEL_AGENT_FLYAI_SMOKE_STATUS=passed_read_only_isolated",
    "TRAVEL_AGENT_TUNIU_ENABLED=true",
    "TUNIU_API_KEY=example-tuniu-key",
    "TRAVEL_AGENT_TUNIU_SMOKE_STATUS=passed_read_only_isolated",
    "TRAVEL_AGENT_PUBLIC_ORIGIN=https://travel.example.com",
    "TRAVEL_AGENT_SESSION_SECRET=example-session-secret-at-least-32-chars",
    "GOOGLE_CLIENT_ID=example-google-client",
    "GOOGLE_CLIENT_SECRET=example-google-secret",
    "TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS=passed_live_smoke",
    "WECHAT_MINIAPP_APP_ID=example-wechat-miniapp",
    "TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS=passed_live_smoke",
    "ALIPAY_WEB_PRIVATE_KEY_PATH=/secure/alipay-web-private.pem",
    "ALIPAY_MINIAPP_APP_ID=alipay-mini-app",
    "TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS=passed_live_smoke",
    "APPLE_PRIVATE_KEY_PATH=/secure/AuthKey_TEST.p8",
    "TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS=passed_live_smoke",
    "FEISHU_APP_SECRET=must-not-load",
    "PI_MODEL=must-not-load",
    "UNRELATED_SECRET=must-not-load",
    "MALFORMED",
  ].join("\n"));
  assert.equal(values.DEEPSEEK_API_KEY, "example-deepseek-key");
  assert.equal(values.TRAVEL_AGENT_DEEPSEEK_VISION_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(values.MOONSHOT_API_KEY, "example-kimi-key");
  assert.equal(values.AMAP_API_KEY, "example-amap-key");
  assert.equal(values.AMAP_API_SECRET, "example-amap-secret");
  assert.equal(values.AMAP_JS_API_KEY, "example-amap-js-key");
  assert.equal(values.AMAP_JS_SECURITY_CODE, "example-amap-js-security-code");
  assert.equal(values.TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED, "false");
  assert.equal(values.TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(values.FLYAI_API_KEY, "example-flyai-key");
  assert.equal(values.TUNIU_API_KEY, "example-tuniu-key");
  assert.equal(values.TRAVEL_AGENT_PUBLIC_ORIGIN, "https://travel.example.com");
  assert.equal(values.GOOGLE_CLIENT_ID, "example-google-client");
  assert.equal(values.TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(values.WECHAT_MINIAPP_APP_ID, "example-wechat-miniapp");
  assert.equal(values.TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(values.ALIPAY_WEB_PRIVATE_KEY_PATH, "/secure/alipay-web-private.pem");
  assert.equal(values.ALIPAY_MINIAPP_APP_ID, "alipay-mini-app");
  assert.equal(values.TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(values.APPLE_PRIVATE_KEY_PATH, "/secure/AuthKey_TEST.p8");
  assert.equal(values.TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS, "passed_live_smoke");
  assert.equal(Object.hasOwn(values, "UNRELATED_SECRET"), false);
  assert.equal(Object.hasOwn(values, "FEISHU_APP_SECRET"), false);
  assert.equal(Object.hasOwn(values, "PI_MODEL"), false);
});

test("runtime env defaults image turns to DeepSeek Vision while preserving the Kimi credential for subagents", async () => {
  const runtime = await loadTravelRuntimeEnv({
    baseEnv: { DEEPSEEK_API_KEY: "deepseek-key", MOONSHOT_API_KEY: "kimi-key" },
    envFile: "/private/tmp/does-not-exist-travel-env",
  });
  assert.equal(runtime.TRAVEL_AGENT_MODEL_PROVIDER, "deepseek");
  assert.equal(runtime.TRAVEL_AGENT_MODEL, "deepseek-v4-flash");
  assert.equal(runtime.MOONSHOT_API_KEY, "kimi-key");
  assert.equal(runtime.TRAVEL_AGENT_VISION_PROVIDER, "deepseek");
  assert.equal(runtime.TRAVEL_AGENT_VISION_MODEL, "deepseek-v4-flash-vision-exp");
});

test("runtime env loads an ignored local file on Windows without interpreting POSIX mode bits", async () => {
  const root = await mkdtemp(join(tmpdir(), "travel-env-win32-"));
  const envFile = join(root, "env_travel.local");
  await writeFile(envFile, "DEEPSEEK_API_KEY=windows-local-key\n", "utf8");
  const runtime = await loadTravelRuntimeEnv({ baseEnv: {}, envFile, platform: "win32" });
  assert.equal(runtime.DEEPSEEK_API_KEY, "windows-local-key");
  assert.equal(runtime.TRAVEL_AGENT_RUNTIME_ENV_FILE_PERMISSIONS_SAFE, "true");
});

test("runtime env keeps Kimi as the visual route when it is the only configured image-capable provider", async () => {
  const runtime = await loadTravelRuntimeEnv({
    baseEnv: { MOONSHOT_API_KEY: "kimi-key" },
    envFile: "/private/tmp/does-not-exist-travel-env",
  });
  assert.equal(runtime.TRAVEL_AGENT_VISION_PROVIDER, "moonshotai-cn");
  assert.equal(runtime.TRAVEL_AGENT_VISION_MODEL, "kimi-k2.6");
});

test("runtime env does not map legacy meeting and Kimi alias keys into Travel Agent roles", async () => {
  const runtime = await loadTravelRuntimeEnv({
    baseEnv: { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-v4-pro", KIMI_API_KEY: "legacy-key", FEISHU_APP_SECRET: "legacy-secret" },
    envFile: "/private/tmp/does-not-exist-travel-env",
  });
  assert.equal(runtime.TRAVEL_AGENT_MODEL_PROVIDER, undefined);
  assert.equal(runtime.MOONSHOT_API_KEY, undefined);
  assert.equal(runtime.FEISHU_APP_SECRET, "legacy-secret");
});

test("runtime env preserves an explicitly selected international Kimi provider", async () => {
  const runtime = await loadTravelRuntimeEnv({
    baseEnv: { MOONSHOT_API_KEY: "kimi-key", TRAVEL_AGENT_VISION_PROVIDER: "moonshotai", TRAVEL_AGENT_VISION_MODEL: "kimi-k3" },
    envFile: "/private/tmp/does-not-exist-travel-env",
  });
  assert.equal(runtime.TRAVEL_AGENT_VISION_PROVIDER, "moonshotai");
  assert.equal(runtime.TRAVEL_AGENT_VISION_MODEL, "kimi-k3");
});

test("visual helper options use the provider-supported reasoning mode", () => {
  const k26 = visualCompletionOptions("kimi-k2.6", { maxTokens: 1200 });
  assert.deepEqual(k26.onPayload({ model: "kimi-k2.6" }).thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(visualCompletionOptions("kimi-k3", { maxTokens: 1200 }), "onPayload"), false);
  assert.equal(visualCompletionOptions("deepseek-v4-flash-vision-exp", { maxTokens: 1200, reasoning: "low" }).reasoning, "high");
});

test('hosted MCP, global providers and alert email settings survive the explicit env-file loader',()=>{
 const values=parseTravelEnvFile('TRAVEL_AGENT_MCP_PORT=8798\nTRAVEL_AGENT_MCP_REDIRECT_URIS=https://host.example/callback\nTRAVEL_AGENT_GOOGLE_MAPS_ENABLED=false\nTRAVEL_NOTIFICATION_EMAIL_KEY=fixture-mail-key\nTRAVEL_NOTIFICATION_EMAIL_FROM=Travel <alerts@example.test>\nUNREGISTERED_PROVIDER_SECRET=ignored');
 assert.equal(values.TRAVEL_AGENT_MCP_PORT,'8798');assert.equal(values.TRAVEL_AGENT_MCP_REDIRECT_URIS,'https://host.example/callback');assert.equal(values.TRAVEL_AGENT_GOOGLE_MAPS_ENABLED,'false');assert.equal(values.TRAVEL_NOTIFICATION_EMAIL_KEY,'fixture-mail-key');assert.equal(values.TRAVEL_NOTIFICATION_EMAIL_FROM,'Travel <alerts@example.test>');assert.equal(values.UNREGISTERED_PROVIDER_SECRET,undefined);
});
