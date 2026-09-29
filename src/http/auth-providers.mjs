import {
  createHmac,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";

import { AUTH_CHANNELS, normalizedAuthOrigin as normalizedOrigin, resolveAuthChannel } from "./auth-channels.mjs";

const WEB_CHANNELS = AUTH_CHANNELS.filter((item) => item.channel === "web");
const WEB_PROVIDERS = WEB_CHANNELS.map((item) => item.provider);
const AUTH_CLIENTS = new Set(["web", "desktop"]);
const STATE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 12_000;

function authError(code, status = 502, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function requiredSecret(env) {
  const secret = String(env.TRAVEL_AGENT_AUTH_STATE_SECRET || "");
  return secret.length >= 32 ? secret : null;
}

function safeReturnTo(value) {
  const returnTo = String(value ?? "/").trim();
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo.slice(0, 1024) : "/";
}

function stateSignature(body, secret) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function createState({ provider, origin, returnTo, client = "web", linkSessionId = null, secret, clock }) {
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = clock().getTime();
  const body = Buffer.from(JSON.stringify({
    version: 1,
    provider,
    origin,
    returnTo: safeReturnTo(returnTo),
    client: AUTH_CLIENTS.has(client) ? client : "web",
    nonce,
    linkSessionId,
    issuedAt,
    expiresAt: issuedAt + STATE_TTL_MS,
  })).toString("base64url");
  return { state: `${body}.${stateSignature(body, secret)}`, nonce };
}

function verifyState({ state, provider, nonce, secret, clock }) {
  const [body, providedSignature, extra] = String(state ?? "").split(".");
  if (!body || !providedSignature || extra || !safeEqual(providedSignature, stateSignature(body, secret))) {
    throw authError("auth_state_invalid", 400);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw authError("auth_state_invalid", 400);
  }
  if (payload.version !== 1 || payload.provider !== provider || !safeEqual(payload.nonce, nonce)) throw authError("auth_state_invalid", 400);
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= clock().getTime()) throw authError("auth_state_expired", 400);
  const origin = normalizedOrigin(payload.origin);
  if (!origin) throw authError("auth_state_invalid", 400);
  const client = payload.client == null ? "web" : payload.client;
  if (!AUTH_CLIENTS.has(client)) throw authError("auth_state_invalid", 400);
  return { ...payload, client, origin, returnTo: safeReturnTo(payload.returnTo) };
}

function callbackUrl(origin, provider) {
  return `${origin}/api/auth/${provider}/callback`;
}

function providerConfiguration(env, provider, origin) {
  return resolveAuthChannel(env, provider, "web", origin);
}

async function fetchText(fetchImpl, url, options = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: options.signal ?? (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined),
    });
  } catch {
    throw authError("auth_provider_unavailable", 503);
  }
  const text = await response.text();
  if (!response.ok) throw authError("auth_provider_rejected_exchange", 502, { status: response.status });
  return text;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const text = await fetchText(fetchImpl, url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw authError("auth_provider_response_invalid", 502);
  }
}

function formBody(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value != null)).toString();
}

function decodeJwtPart(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw authError("auth_identity_token_invalid", 502);
  }
}

async function verifyIdentityToken(fetchImpl, token, { keysUrl, issuers, audience, nonce, clock }) {
  const [encodedHeader, encodedPayload, encodedSignature, extra] = String(token ?? "").split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra) throw authError("auth_identity_token_invalid", 502);
  const header = decodeJwtPart(encodedHeader);
  const claims = decodeJwtPart(encodedPayload);
  if (header.alg !== "RS256" || !header.kid) throw authError("auth_identity_token_invalid", 502);
  const keySet = await fetchJson(fetchImpl, keysUrl);
  const jwk = keySet.keys?.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!jwk) throw authError("auth_identity_key_unavailable", 503);
  const verified = verifyBytes("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(encodedSignature, "base64url"));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(clock().getTime() / 1000);
  if (!verified || !issuers.includes(claims.iss) || !audiences.includes(audience) || typeof claims.sub !== "string" || !claims.sub.trim() || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= now || claims.iat > now + 60) {
    throw authError("auth_identity_token_invalid", 502);
  }
  if (nonce && claims.nonce !== nonce) throw authError("auth_identity_token_invalid", 502);
  return claims;
}

async function exchangeGoogle({ config, code, nonce, fetchImpl, clock }) {
  const tokens = await fetchJson(fetchImpl, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: callbackUrl(config.origin, "google"), grant_type: "authorization_code" }),
  });
  if (!tokens.id_token) throw authError("auth_provider_response_invalid", 502);
  const claims = await verifyIdentityToken(fetchImpl, tokens.id_token, {
    keysUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    audience: config.clientId,
    nonce,
    clock,
  });
  return { provider: "google", subject: claims.sub, displayName: claims.name ?? null };
}

async function exchangeWechatWeb({ config, code, fetchImpl }) {
  const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  url.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret, code, grant_type: "authorization_code" });
  const token = await fetchJson(fetchImpl, url);
  if (token.errcode || !token.openid) throw authError("auth_provider_rejected_exchange", 502, { providerCode: token.errcode ?? null });
  return { provider: "wechat", subject: token.unionid || token.openid, displayName: null };
}

function normalizePrivateKey(value) {
  const text = String(value ?? "").trim();
  if (text.includes("BEGIN")) return text;
  const lines = text.match(/.{1,64}/g)?.join("\n") ?? text;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function normalizePublicKey(value) {
  const text = String(value ?? "").trim();
  if (text.includes("BEGIN")) return text;
  const lines = text.match(/.{1,64}/g)?.join("\n") ?? text;
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`;
}

function shanghaiTimestamp(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function extractResponseObject(text, key) {
  const marker = `"${key}"`;
  const markerIndex = text.indexOf(marker);
  const start = text.indexOf("{", markerIndex + marker.length);
  if (markerIndex < 0 || start < 0) throw authError("auth_provider_response_invalid", 502);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  throw authError("auth_provider_response_invalid", 502);
}

async function exchangeAlipay({ config, code, fetchImpl, readFileImpl, clock }) {
  const [privateKeyValue, publicKeyValue] = await Promise.all([
    readFileImpl(config.privateKeyPath, "utf8"),
    readFileImpl(config.publicKeyPath, "utf8"),
  ]).catch(() => { throw authError("auth_provider_key_unavailable", 503); });
  const parameters = {
    app_id: config.appId,
    method: "alipay.system.oauth.token",
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: shanghaiTimestamp(clock()),
    version: "1.0",
    grant_type: "authorization_code",
    code,
  };
  const signingContent = Object.keys(parameters).sort().map((key) => `${key}=${parameters[key]}`).join("&");
  const signer = createSign("RSA-SHA256");
  signer.update(signingContent, "utf8");
  parameters.sign = signer.sign(normalizePrivateKey(privateKeyValue), "base64");
  const text = await fetchText(fetchImpl, "https://openapi.alipay.com/gateway.do", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(parameters),
  });
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw authError("auth_provider_response_invalid", 502);
  }
  const responseKey = envelope.alipay_system_oauth_token_response ? "alipay_system_oauth_token_response" : "error_response";
  const responseText = extractResponseObject(text, responseKey);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(responseText, "utf8");
  if (!envelope.sign || !verifier.verify(normalizePublicKey(publicKeyValue), envelope.sign, "base64")) throw authError("auth_provider_signature_invalid", 502);
  const result = envelope[responseKey];
  if (responseKey === "error_response" || !result || (!result.user_id && !result.open_id)) {
    throw authError("auth_provider_rejected_exchange", 502, { providerCode: result?.code ?? null });
  }
  return { provider: "alipay", subject: result.user_id || result.open_id, displayName: null };
}

function appleClientSecret({ config, privateKey, clock }) {
  const issuedAt = Math.floor(clock().getTime() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: config.teamId, iat: issuedAt, exp: issuedAt + 300, aud: "https://appleid.apple.com", sub: config.clientId })).toString("base64url");
  const content = `${header}.${payload}`;
  const signature = signBytes("sha256", Buffer.from(content), { key: normalizePrivateKey(privateKey), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${content}.${signature}`;
}

async function exchangeApple({ config, code, nonce, fetchImpl, readFileImpl, clock }) {
  let privateKey;
  try {
    privateKey = await readFileImpl(config.privateKeyPath, "utf8");
  } catch {
    throw authError("auth_provider_key_unavailable", 503);
  }
  const tokens = await fetchJson(fetchImpl, "https://appleid.apple.com/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      client_id: config.clientId,
      client_secret: appleClientSecret({ config, privateKey, clock }),
      code,
      grant_type: "authorization_code",
      redirect_uri: callbackUrl(config.origin, "apple"),
    }),
  });
  if (!tokens.id_token) throw authError("auth_provider_response_invalid", 502);
  const claims = await verifyIdentityToken(fetchImpl, tokens.id_token, {
    keysUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    audience: config.clientId,
    nonce,
    clock,
  });
  return { provider: "apple", subject: claims.sub, displayName: null };
}

function webAuthorizationUrl(provider, config, state, nonce) {
  const redirectUri = callbackUrl(config.origin, provider);
  if (provider === "google") {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, nonce, prompt: "select_account" });
    return url.toString();
  }
  if (provider === "wechat") {
    const url = new URL("https://open.weixin.qq.com/connect/qrconnect");
    url.search = new URLSearchParams({ appid: config.appId, redirect_uri: redirectUri, response_type: "code", scope: "snsapi_login", state });
    url.hash = "wechat_redirect";
    return url.toString();
  }
  if (provider === "alipay") {
    const url = new URL("https://openauth.alipay.com/oauth2/publicAppAuthorize.htm");
    url.search = new URLSearchParams({ app_id: config.appId, scope: "auth_user", redirect_uri: redirectUri, state });
    return url.toString();
  }
  const url = new URL("https://appleid.apple.com/auth/authorize");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: "code id_token", response_mode: "form_post", scope: "name email", state, nonce });
  return url.toString();
}

export function createAuthService({ env = process.env, fetchImpl = globalThis.fetch, readFileImpl = readFile, clock = () => new Date() } = {}) {
  return Object.freeze({
    providerSummary({ origin } = {}) {
      return {
        schemaVersion: "auth-providers-v1",
        primaryProvider: "google",
        providers: WEB_CHANNELS.map(({ provider, label, interaction }) => {
          const config = providerConfiguration(env, provider, origin);
          return { id: provider, label, interaction, available: config.available, unavailableReason: config.reason, startPath: `/api/auth/${provider}/start` };
        }),
      };
    },

    beginWeb({ provider, origin, returnTo = "/", client = "web", linkSessionId = null }) {
      if (!WEB_PROVIDERS.includes(provider)) throw authError("unsupported_auth_provider", 400, { provider });
      if (!AUTH_CLIENTS.has(client)) throw authError("unsupported_auth_client", 400, { client });
      const config = providerConfiguration(env, provider, origin);
      if (!config.available) throw authError("auth_provider_not_configured", 503, { provider, reason: config.reason });
      const { state, nonce } = createState({ provider, origin: config.origin, returnTo, client, linkSessionId, secret: config.stateSecret, clock });
      return {
        authorizationUrl: webAuthorizationUrl(provider, config, state, nonce),
        state,
        nonce,
        client,
        cookieSameSite: provider === "apple" ? "none" : "lax",
        cookieSecure: provider === "apple" || config.origin.startsWith("https://"),
        cookieMaxAge: STATE_TTL_MS,
      };
    },

    async completeWeb({ provider, code, state, nonce }) {
      if (!WEB_PROVIDERS.includes(provider)) throw authError("unsupported_auth_provider", 400, { provider });
      if (!String(code ?? "").trim()) throw authError("auth_authorization_denied", 400);
      const stateSecret = requiredSecret(env);
      if (!stateSecret) throw authError("auth_provider_not_configured", 503, { provider, reason: "secure_session_required" });
      const verifiedState = verifyState({ state, provider, nonce, secret: stateSecret, clock });
      const config = providerConfiguration(env, provider, verifiedState.origin);
      if (!config.available) throw authError("auth_provider_not_configured", 503, { provider, reason: config.reason });
      let identity;
      if (provider === "google") identity = await exchangeGoogle({ config, code, nonce: verifiedState.nonce, fetchImpl, clock });
      else if (provider === "wechat") identity = await exchangeWechatWeb({ config, code, fetchImpl });
      else if (provider === "alipay") identity = await exchangeAlipay({ config, code, fetchImpl, readFileImpl, clock });
      else identity = await exchangeApple({ config, code, nonce: verifiedState.nonce, fetchImpl, readFileImpl, clock });
      return { identity, returnTo: verifiedState.returnTo, client: verifiedState.client, linkSessionId: verifiedState.linkSessionId ?? null };
    },

    async exchangePlatform({ provider, authorizationCode }) {
      const code = String(authorizationCode ?? "").trim();
      if (!code || code.length > 4096) throw authError("invalid_authorization_code", 400);
      const config = resolveAuthChannel(env, provider, "miniapp");
      if (!config.available) throw authError("auth_provider_not_configured", 503, { provider, channel: "miniapp", reason: config.reason });
      if (provider === "wechat") {
        const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
        url.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret, js_code: code, grant_type: "authorization_code" });
        const result = await fetchJson(fetchImpl, url);
        if (result.errcode || !result.openid) throw authError("auth_provider_rejected_exchange", 502, { providerCode: result.errcode ?? null });
        return { provider, subject: result.unionid || result.openid, displayName: null };
      }
      if (provider === "alipay") {
        return exchangeAlipay({ config, code, fetchImpl, readFileImpl, clock });
      }
      throw authError("unsupported_auth_provider", 400, { provider });
    },
  });
}

export function oauthNonceCookieName(provider) {
  return `travel_oauth_nonce_${provider}`;
}

export function oauthClientCookieName(provider) {
  return `travel_oauth_client_${provider}`;
}
