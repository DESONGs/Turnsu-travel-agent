// Server-only channel registry shared by login discovery, exchanges and auth:check.
// Never serialize resolved configuration: it contains provider credentials.
export const AUTH_CHANNELS = Object.freeze([
  { id: "google_web", provider: "google", channel: "web", label: "Google", interaction: "redirect", fields: { clientId: ["GOOGLE_CLIENT_ID"], clientSecret: ["GOOGLE_CLIENT_SECRET"] }, smokeKey: "TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS", manual: "Create a Google Web OAuth client and register the exact callback URI." },
  { id: "wechat_web", provider: "wechat", channel: "web", label: "微信", interaction: "qr", fields: { appId: ["WECHAT_OPEN_APP_ID"], appSecret: ["WECHAT_OPEN_APP_SECRET"] }, smokeKey: "TRAVEL_AGENT_WECHAT_WEB_AUTH_SMOKE_STATUS", manual: "Create and approve a WeChat Website Application and register its callback domain." },
  { id: "wechat_miniapp", provider: "wechat", channel: "miniapp", fields: { appId: ["WECHAT_MINIAPP_APP_ID"], appSecret: ["WECHAT_MINIAPP_APP_SECRET"] }, smokeKey: "TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS", manual: "Create the Mini Program, bind it to the same WeChat Open Platform account, and register the HTTPS request domain." },
  { id: "alipay_web", provider: "alipay", channel: "web", label: "支付宝", interaction: "qr", fields: { appId: ["ALIPAY_WEB_APP_ID", "ALIPAY_APP_ID"], privateKeyPath: ["ALIPAY_WEB_PRIVATE_KEY_PATH", "ALIPAY_PRIVATE_KEY_PATH"], publicKeyPath: ["ALIPAY_WEB_PUBLIC_KEY_PATH", "ALIPAY_PUBLIC_KEY_PATH"] }, smokeKey: "TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS", manual: "Create an Alipay Web/Mobile application in public-key mode and register the callback URL." },
  { id: "alipay_miniapp", provider: "alipay", channel: "miniapp", fields: { appId: ["ALIPAY_MINIAPP_APP_ID", "ALIPAY_APP_ID"], privateKeyPath: ["ALIPAY_MINIAPP_PRIVATE_KEY_PATH", "ALIPAY_PRIVATE_KEY_PATH"], publicKeyPath: ["ALIPAY_MINIAPP_PUBLIC_KEY_PATH", "ALIPAY_PUBLIC_KEY_PATH"] }, smokeKey: "TRAVEL_AGENT_ALIPAY_MINIAPP_AUTH_SMOKE_STATUS", manual: "Associate the Alipay Mini Program with the application and register its server domain." },
  { id: "apple_web", provider: "apple", channel: "web", label: "Apple", interaction: "redirect", fields: { clientId: ["APPLE_CLIENT_ID"], teamId: ["APPLE_TEAM_ID"], keyId: ["APPLE_KEY_ID"], privateKeyPath: ["APPLE_PRIVATE_KEY_PATH"] }, smokeKey: "TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS", manual: "Create a Sign in with Apple Services ID and key, then register the exact callback URL." },
]);

export function normalizedAuthOrigin(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveAuthChannel(env, provider, channel = "web", origin = env.TRAVEL_AGENT_PUBLIC_ORIGIN) {
  const definition = AUTH_CHANNELS.find((item) => item.provider === provider && item.channel === channel);
  if (!definition) throw Object.assign(new Error("unsupported_auth_provider"), { code: "unsupported_auth_provider", status: 400 });
  const values = {};
  const missing = [];
  for (const [property, keys] of Object.entries(definition.fields)) {
    values[property] = keys.map((key) => env[key]).find((value) => String(value ?? "").trim());
    if (!values[property]) missing.push(keys[0]);
  }
  const normalized = normalizedAuthOrigin(origin);
  const stateSecret = String(env.TRAVEL_AGENT_AUTH_STATE_SECRET ?? "");
  const sessionReady = String(env.TRAVEL_AGENT_SESSION_SECRET ?? "").length >= 32;
  const commonReady = sessionReady && (channel === "miniapp" || (stateSecret.length >= 32 && Boolean(normalized)));
  const reason = !commonReady ? "secure_session_required"
    : channel === "web" && provider !== "google" && !normalized?.startsWith("https://") ? "https_required"
    : missing.length ? "configuration_required" : null;
  return { ...values, origin: normalized, stateSecret, missing, available: reason === null, reason };
}
