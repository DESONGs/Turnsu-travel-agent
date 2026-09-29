import SOCIAL_HOSTS from "../../../travel-agent-pi-package/src/workers/social-worker-hosts.json" with { type: "json" };

export const TRUSTED_APP_SCHEME = "travelapp";
export const TRUSTED_APP_ORIGIN = `${TRUSTED_APP_SCHEME}://app`;
export const DEFAULT_DEEP_LINK_SCHEME = "zhuanshu-travel";

const AUTH_PROVIDERS = new Set(["google", "wechat", "alipay", "apple"]);
const EXTERNAL_HOSTS = new Set([
  "uri.amap.com", "www.amap.com", "ditu.amap.com", "lbs.amap.com",
  "www.fliggy.com", "fliggy.com", "flyai.open.fliggy.com",
  "www.tuniu.com", "tuniu.com", "open.tuniu.com",
  "open-meteo.com", "english.www.gov.cn",
]);

function parsedHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function normalizedApiOrigin(value: string, allowLocalhost = false): string | null {
  let url: URL | null = parsedHttps(value);
  if (!url && allowLocalhost) {
    try {
      const local = new URL(value);
      if (local.protocol === "http:" && ["127.0.0.1", "localhost"].includes(local.hostname) && !local.username && !local.password) url = local;
    } catch { /* invalid origin */ }
  }
  if (!url || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

export function normalizedDeepLinkScheme(value: string): string | null {
  const scheme = String(value ?? "").trim().toLowerCase();
  return /^[a-z][a-z0-9+.-]{1,62}$/.test(scheme) ? scheme : null;
}

export function safeReturnTo(value: string): string {
  const returnTo = String(value ?? "/").trim();
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo.slice(0, 1024) : "/";
}

export function evidencePlatform(value: string): string | null {
  const url = parsedHttps(value);
  if (!url) return null;
  for (const [platform, hosts] of Object.entries(SOCIAL_HOSTS)) {
    if (hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return platform;
  }
  return null;
}

export function isAllowedEvidenceUrl(value: string, expectedPlatform: string | null = null): boolean {
  const platform = evidencePlatform(value);
  return Boolean(platform && (!expectedPlatform || platform === expectedPlatform));
}

export function oauthStartUrl(apiOrigin: string, provider: string, returnTo = "/", link?: string): string | null {
  const origin = normalizedApiOrigin(apiOrigin);
  if (!origin || !AUTH_PROVIDERS.has(provider)) return null;
  const url = new URL(`/api/auth/${provider}/start`, origin);
  url.searchParams.set("client", "desktop");
  if (link !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(link)) return null;
    url.searchParams.set("link", link);
  }
  url.searchParams.set("returnTo", safeReturnTo(returnTo));
  return url.toString();
}

export function isAllowedExternalUrl(value: string): boolean {
  const url = parsedHttps(value);
  if (!url) return false;
  return [...EXTERNAL_HOSTS].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export type DesktopAuthCallback = { code?: string; authError?: string; returnTo: string };

export function parseDesktopAuthCallback(value: string, scheme = DEFAULT_DEEP_LINK_SCHEME): DesktopAuthCallback | null {
  const normalizedScheme = normalizedDeepLinkScheme(scheme);
  if (!normalizedScheme) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== `${normalizedScheme}:` || url.hostname !== "auth" || url.pathname !== "/callback" || url.username || url.password) return null;
  const code = url.searchParams.get("code")?.trim();
  const authError = url.searchParams.get("auth_error")?.trim();
  if ((code && authError) || (!code && !authError) || (code && code.length > 512) || (authError && authError.length > 120)) return null;
  return { ...(code ? { code } : {}), ...(authError ? { authError } : {}), returnTo: safeReturnTo(url.searchParams.get("returnTo") ?? "/") };
}

export function isTrustedRendererUrl(value: string, developmentUrl: string | null = null): boolean {
  if (value === `${TRUSTED_APP_ORIGIN}/` || value.startsWith(`${TRUSTED_APP_ORIGIN}/`)) return true;
  if (!developmentUrl) return false;
  try {
    return new URL(value).origin === new URL(developmentUrl).origin;
  } catch {
    return false;
  }
}
