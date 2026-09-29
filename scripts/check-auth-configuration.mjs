import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";

import { AUTH_CHANNELS, normalizedAuthOrigin, resolveAuthChannel } from "../src/http/auth-channels.mjs";

const env = await loadTravelRuntimeEnv();

function configured(value) {
  return Boolean(String(value ?? "").trim());
}

function publicOrigin(value) {
  const origin = normalizedAuthOrigin(value);
  return origin?.startsWith("https://") ? origin : null;
}

function normalizedKey(value, kind) {
  const text = String(value ?? "").trim();
  if (text.includes("BEGIN")) return text;
  const lines = text.match(/.{1,64}/g)?.join("\n") ?? text;
  return `-----BEGIN ${kind === "private" ? "PRIVATE" : "PUBLIC"} KEY-----\n${lines}\n-----END ${kind === "private" ? "PRIVATE" : "PUBLIC"} KEY-----`;
}

async function keyFile(path, kind) {
  if (!configured(path)) return { configured: false, exists: false, safePermissions: false };
  try {
    const [metadata, contents] = await Promise.all([stat(path), readFile(path, "utf8")]);
    const mode = metadata.mode & 0o777;
    let validKey = false;
    try {
      if (kind === "private") createPrivateKey(normalizedKey(contents, kind));
      else createPublicKey(normalizedKey(contents, kind));
      validKey = true;
    } catch {
      validKey = false;
    }
    return { configured: true, exists: metadata.isFile(), safePermissions: process.platform === "win32" || (mode & 0o077) === 0, validKey, mode: mode.toString(8) };
  } catch {
    return { configured: true, exists: false, safePermissions: false, validKey: false };
  }
}

function channel({ id, provider, channel: channelType, smokeKey, manual }) {
  const { missing } = resolveAuthChannel(env, provider, channelType);
  const smoke = env[smokeKey] || "not_run";
  return {
    id,
    status: !origin ? "needs_public_https_origin" : missing.length ? "needs_manual_configuration" : smoke === "passed_live_smoke" ? "passed_live_smoke" : "credential_configured_pending_live_smoke",
    missing,
    smoke,
    manual,
  };
}

const origin = publicOrigin(env.TRAVEL_AGENT_PUBLIC_ORIGIN);
const desktopRequested = String(env.TRAVEL_AGENT_DESKTOP_AUTH_ENABLED ?? "false").trim().toLowerCase() === "true";
const desktopScheme = String(env.TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME ?? "zhuanshu-travel").trim().toLowerCase();
const desktopApiOrigin = publicOrigin(env.TRAVEL_AGENT_DESKTOP_API_ORIGIN || env.TRAVEL_AGENT_PUBLIC_ORIGIN);
const desktopSchemeValid = /^[a-z][a-z0-9+.-]{1,62}$/.test(desktopScheme);
const alipayWeb = resolveAuthChannel(env, "alipay", "web");
const alipayMiniapp = resolveAuthChannel(env, "alipay", "miniapp");
const alipayKeyFiles = {
  web: { privateKey: await keyFile(alipayWeb.privateKeyPath, "private"), publicKey: await keyFile(alipayWeb.publicKeyPath, "public") },
  miniapp: { privateKey: await keyFile(alipayMiniapp.privateKeyPath, "private"), publicKey: await keyFile(alipayMiniapp.publicKeyPath, "public") },
};
const applePrivateKey = await keyFile(env.APPLE_PRIVATE_KEY_PATH, "private");
const sharedIssues = [];
if (!configured(env.DATABASE_URL)) sharedIssues.push("DATABASE_URL is required for persistent production accounts and shared session revocation.");
if (!origin) sharedIssues.push("TRAVEL_AGENT_PUBLIC_ORIGIN must be the final HTTPS origin with no path.");
if (String(env.TRAVEL_AGENT_SESSION_SECRET ?? "").length < 32) sharedIssues.push("TRAVEL_AGENT_SESSION_SECRET must contain at least 32 characters.");
if (String(env.TRAVEL_AGENT_AUTH_STATE_SECRET ?? "").length < 32) sharedIssues.push("TRAVEL_AGENT_AUTH_STATE_SECRET must contain at least 32 characters.");
if (configured(env.TRAVEL_AGENT_SESSION_SECRET) && env.TRAVEL_AGENT_SESSION_SECRET === env.TRAVEL_AGENT_AUTH_STATE_SECRET) sharedIssues.push("Session and OAuth state secrets must be different.");
if (origin && env.TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH === "true") sharedIssues.push("TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH must be false before using a public login origin.");
if (desktopRequested && !desktopApiOrigin) sharedIssues.push("TRAVEL_AGENT_DESKTOP_API_ORIGIN (or TRAVEL_AGENT_PUBLIC_ORIGIN) must be the final HTTPS API origin before desktop OAuth is enabled.");
if (desktopRequested && !desktopSchemeValid) sharedIssues.push("TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME must be a valid custom URL scheme.");
for (const [channelId, files] of Object.entries(alipayKeyFiles)) {
  if (files.privateKey.configured && (!files.privateKey.exists || !files.privateKey.safePermissions || !files.privateKey.validKey)) sharedIssues.push(`Alipay ${channelId} private key must be a valid RSA key in a readable file protected with mode 0600.`);
  if (files.publicKey.configured && (!files.publicKey.exists || !files.publicKey.safePermissions || !files.publicKey.validKey)) sharedIssues.push(`Alipay ${channelId} public key must be a valid RSA key in a readable file protected with mode 0600.`);
}
if (applePrivateKey.configured && (!applePrivateKey.exists || !applePrivateKey.safePermissions || !applePrivateKey.validKey)) sharedIssues.push("Apple private key must be a valid private key in a readable file protected with mode 0600.");

const channels = AUTH_CHANNELS.map(channel);

const callbackUrls = origin ? {
  google: `${origin}/api/auth/google/callback`,
  wechat: `${origin}/api/auth/wechat/callback`,
  alipay: `${origin}/api/auth/alipay/callback`,
  apple: `${origin}/api/auth/apple/callback`,
  platformExchange: `${origin}/api/auth/platform-exchange`,
  desktopExchange: `${origin}/api/auth/desktop-exchange`,
  desktopDeepLink: desktopSchemeValid ? `${desktopScheme}://auth/callback` : null,
} : null;
const ready = sharedIssues.length === 0 && channels.every((item) => item.status === "passed_live_smoke");
process.stdout.write(`${JSON.stringify({
  schemaVersion: "travel-auth-configuration-check-v1",
  status: ready ? "passed" : "needs_manual_configuration",
  sharedIssues,
  channels,
  desktop: {
    requested: desktopRequested,
    status: !desktopRequested ? "disabled_until_desktop_release" : desktopApiOrigin && desktopSchemeValid ? "code_ready_pending_provider_live_smoke" : "needs_manual_configuration",
    apiOrigin: desktopApiOrigin,
    deepLink: desktopSchemeValid ? `${desktopScheme}://auth/callback` : null,
    tokenTransport: "one_time_code_then_bearer_os_encrypted_storage",
  },
  callbackUrls,
  alipayKeyFiles,
  applePrivateKey,
  secretsPrinted: false,
})}\n`);
process.exitCode = ready ? 0 : 2;
