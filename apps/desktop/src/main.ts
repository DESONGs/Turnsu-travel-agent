import { app, BaseWindow, ipcMain, protocol, safeStorage, session, shell, WebContentsView, webContents, type IpcMainInvokeEvent, type Session } from "electron";
import { SessionVault } from "./session-vault.js";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DEEP_LINK_SCHEME,
  evidencePlatform,
  isAllowedEvidenceUrl,
  isAllowedExternalUrl,
  isTrustedRendererUrl,
  normalizedApiOrigin,
  normalizedDeepLinkScheme,
  oauthStartUrl,
  parseDesktopAuthCallback,
  TRUSTED_APP_ORIGIN,
  TRUSTED_APP_SCHEME,
  type DesktopAuthCallback,
} from "./security-policy.js";

protocol.registerSchemesAsPrivileged([{ scheme: TRUSTED_APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB_ROOT = resolve(HERE, "../../../dist");
const PRELOAD_PATH = resolve(HERE, "trusted-preload.cjs");
const DESKTOP_SMOKE = process.env.TRAVEL_AGENT_DESKTOP_SMOKE === "1";
if (DESKTOP_SMOKE && process.env.TRAVEL_AGENT_DESKTOP_SMOKE_DATA_DIR) app.setPath("userData", process.env.TRAVEL_AGENT_DESKTOP_SMOKE_DATA_DIR);
function packagedRuntimeConfig(): { apiOrigin?: string; deepLinkScheme?: string } {
  try {
    return JSON.parse(readFileSync(resolve(app.getAppPath(), "desktop-runtime.json"), "utf8"));
  } catch {
    return {};
  }
}
const FILE_CONFIG = packagedRuntimeConfig();
const API_ORIGIN = normalizedApiOrigin(process.env.TRAVEL_AGENT_DESKTOP_API_ORIGIN ?? process.env.TRAVEL_AGENT_PUBLIC_ORIGIN ?? FILE_CONFIG.apiOrigin ?? "", !app.isPackaged);
const DEVELOPMENT_URL = process.env.TRAVEL_AGENT_DESKTOP_DEV_URL?.trim() || null;
const DEEP_LINK_SCHEME = normalizedDeepLinkScheme(process.env.TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME ?? FILE_CONFIG.deepLinkScheme ?? DEFAULT_DEEP_LINK_SCHEME) ?? DEFAULT_DEEP_LINK_SCHEME;
const TRUSTED_PARTITION = "persist:zhuanshu-trusted";
const EVIDENCE_PARTITION = "persist:zhuanshu-evidence";

let mainWindow: BaseWindow | null = null;
let trustedView: WebContentsView | null = null;
let evidenceView: WebContentsView | null = null;
let evidenceSourcePlatform: string | null = null;
let pendingAuthCallback: DesktopAuthCallback | null = null;
let blockedNavigationCount = 0;
const lockedDownSessions = new WeakSet<Session>();

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2",
};

function contentSecurityPolicy(): string {
  const api = API_ORIGIN ?? "";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "script-src 'self' https://webapi.amap.com https://*.amap.com https://*.autonavi.com 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://*.amap.com https://*.autonavi.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${api} https://*.amap.com https://*.autonavi.com`,
    "font-src 'self' data:",
  ].join("; ");
}

async function trustedAssetResponse(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname || "/index.html");
  if (pathname === "/") pathname = "/index.html";
  const candidate = resolve(WEB_ROOT, `.${pathname}`);
  if (candidate !== WEB_ROOT && !candidate.startsWith(`${WEB_ROOT}${sep}`)) return new Response("blocked", { status: 403 });
  try {
    const body = await readFile(candidate);
    return new Response(body, { status: 200, headers: { "content-type": mimeTypes[extname(candidate).toLowerCase()] ?? "application/octet-stream", "content-security-policy": contentSecurityPolicy(), "cache-control": DESKTOP_SMOKE ? "no-store" : "public, max-age=3600" } });
  } catch {
    if (!pathname.includes(".")) return trustedAssetResponse(new Request(`${TRUSTED_APP_ORIGIN}/index.html`));
    return new Response("not found", { status: 404 });
  }
}

function lockDownSession(target: Session): void {
  if (lockedDownSessions.has(target)) return;
  lockedDownSessions.add(target);
  target.setPermissionCheckHandler(() => false);
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.on("will-download", (event) => event.preventDefault());
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!trustedView || event.sender.id !== trustedView.webContents.id || !event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url, DEVELOPMENT_URL)) {
    throw new Error("desktop_ipc_sender_blocked");
  }
}

function emitEvidenceState(open: boolean, sourceUrl: string | null = null): void {
  trustedView?.webContents.send("desktop:evidence-state", { open, sourceUrl });
}

function layoutViews(): void {
  if (!mainWindow || !trustedView) return;
  const { width, height } = mainWindow.getContentBounds();
  if (!evidenceView) {
    trustedView.setBounds({ x: 0, y: 0, width, height });
    return;
  }
  const trustedWidth = Math.max(560, Math.round(width * 0.56));
  trustedView.setBounds({ x: 0, y: 0, width: trustedWidth, height });
  evidenceView.setBounds({ x: trustedWidth, y: 0, width: Math.max(320, width - trustedWidth), height });
}

function destroyEvidenceView(): void {
  if (!evidenceView) return;
  mainWindow?.contentView.removeChildView(evidenceView);
  const target = evidenceView;
  evidenceView = null;
  evidenceSourcePlatform = null;
  if (!target.webContents.isDestroyed()) target.webContents.close();
  layoutViews();
  emitEvidenceState(false);
}

async function createEvidenceView(sourceUrl: string): Promise<void> {
  const platform = evidencePlatform(sourceUrl);
  if (!platform) throw new Error("desktop_evidence_url_blocked");
  destroyEvidenceView();
  const evidenceSession = session.fromPartition(EVIDENCE_PARTITION, { cache: true });
  lockDownSession(evidenceSession);
  if (DESKTOP_SMOKE && !evidenceSession.protocol.isProtocolHandled("https")) {
    await evidenceSession.protocol.handle("https", (request) => {
      if (!isAllowedEvidenceUrl(request.url)) return new Response("blocked", { status: 403 });
      return new Response("<!doctype html><meta charset=utf-8><title>Evidence fixture</title><a id=blocked href=https://example.com>blocked</a><main>untrusted source fixture</main>", { headers: { "content-type": "text/html; charset=utf-8" } });
    });
  }
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, session: evidenceSession } });
  evidenceView = view;
  evidenceSourcePlatform = platform;
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const guardNavigation = (event: Electron.Event, targetUrl: string) => {
    if (!isAllowedEvidenceUrl(targetUrl, evidenceSourcePlatform)) {
      blockedNavigationCount += 1;
      event.preventDefault();
    }
  };
  view.webContents.on("will-navigate", guardNavigation);
  view.webContents.on("will-redirect", guardNavigation);
  view.webContents.on("before-input-event", (event, input) => {
    if (input.key === "Escape") {
      event.preventDefault();
      destroyEvidenceView();
    }
  });
  mainWindow?.contentView.addChildView(view);
  layoutViews();
  emitEvidenceState(true, sourceUrl);
  await view.webContents.loadURL(sourceUrl);
}

function installTrustedNavigationGuards(view: WebContentsView): void {
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedEvidenceUrl(url)) void createEvidenceView(url).catch(() => undefined);
    else if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl, DEVELOPMENT_URL)) return;
    event.preventDefault();
    if (isAllowedEvidenceUrl(targetUrl)) void createEvidenceView(targetUrl).catch(() => undefined);
    else if (isAllowedExternalUrl(targetUrl)) void shell.openExternal(targetUrl);
  });
}

function dispatchAuthCallback(value: string): boolean {
  const parsed = parseDesktopAuthCallback(value, DEEP_LINK_SCHEME);
  if (!parsed) return false;
  pendingAuthCallback = parsed;
  trustedView?.webContents.send("desktop:auth-callback", parsed);
  return true;
}

function installIpc(): void {
  const vault = API_ORIGIN ? new SessionVault(resolve(app.getPath("userData"), "accounts"), API_ORIGIN, safeStorage) : null;
  ipcMain.handle("desktop:session-restore", (event) => {
    assertTrustedSender(event);
    return vault?.restore() ?? { accessToken: null, persistent: false };
  });
  ipcMain.handle("desktop:session-save", (event, token: unknown) => {
    assertTrustedSender(event);
    return vault?.save(token) ?? { persistent: false };
  });
  ipcMain.handle("desktop:session-clear", (event) => {
    assertTrustedSender(event);
    return vault?.clear();
  });
  ipcMain.handle("desktop:oauth-begin", async (event, input: { provider?: string; returnTo?: string; link?: string }) => {
    assertTrustedSender(event);
    if (!API_ORIGIN) throw new Error("desktop_api_origin_not_configured");
    const url = oauthStartUrl(API_ORIGIN, String(input?.provider ?? ""), String(input?.returnTo ?? "/"), input?.link);
    if (!url) throw new Error("desktop_oauth_request_blocked");
    await shell.openExternal(url);
    return { status: "opened_system_browser" };
  });
  ipcMain.handle("desktop:evidence-open", async (event, input: { url?: string }) => {
    assertTrustedSender(event);
    await createEvidenceView(String(input?.url ?? ""));
    return { status: "opened" };
  });
  ipcMain.handle("desktop:evidence-close", (event) => {
    assertTrustedSender(event);
    destroyEvidenceView();
    return { status: "closed" };
  });
  ipcMain.handle("desktop:evidence-capture", async (event) => {
    assertTrustedSender(event);
    if (!evidenceView || evidenceView.webContents.isDestroyed()) throw new Error("desktop_evidence_not_open");
    const image = await evidenceView.webContents.capturePage();
    return { mimeType: "image/png", data: image.toPNG().toString("base64"), persistence: "none" };
  });
  ipcMain.handle("desktop:external-open", async (event, input: { url?: string }) => {
    assertTrustedSender(event);
    const url = String(input?.url ?? "");
    if (!isAllowedExternalUrl(url)) throw new Error("desktop_external_url_blocked");
    await shell.openExternal(url);
    return { status: "opened" };
  });
  ipcMain.handle("desktop:auth-take-pending", (event) => {
    assertTrustedSender(event);
    const value = pendingAuthCallback;
    pendingAuthCallback = null;
    return value;
  });
}

async function createWindow(): Promise<void> {
  const trustedSession = session.fromPartition(TRUSTED_PARTITION, { cache: true });
  lockDownSession(trustedSession);
  if (!trustedSession.protocol.isProtocolHandled(TRUSTED_APP_SCHEME)) await trustedSession.protocol.handle(TRUSTED_APP_SCHEME, trustedAssetResponse);
  mainWindow = new BaseWindow({ width: 1440, height: 960, minWidth: 900, minHeight: 640, show: !DESKTOP_SMOKE, title: "Zhuanshu Travel Agent" });
  trustedView = new WebContentsView({ webPreferences: { preload: PRELOAD_PATH, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, session: trustedSession, additionalArguments: [`--travel-api-origin=${API_ORIGIN ?? ""}`] } });
  installTrustedNavigationGuards(trustedView);
  mainWindow.contentView.addChildView(trustedView);
  mainWindow.on("resize", layoutViews);
  mainWindow.on("closed", () => {
    destroyEvidenceView();
    if (trustedView && !trustedView.webContents.isDestroyed()) trustedView.webContents.close();
    trustedView = null;
    mainWindow = null;
  });
  layoutViews();
  await trustedView.webContents.loadURL(DEVELOPMENT_URL ?? `${TRUSTED_APP_ORIGIN}/index.html`);
}

async function runSmoke(): Promise<void> {
  if (!mainWindow || !trustedView) throw new Error("desktop_smoke_window_missing");
  const vault = new SessionVault(resolve(app.getPath("userData"), "vault-smoke"), "https://vault-smoke.example", safeStorage);
  const testToken = randomBytes(32).toString("base64url");
  const saved = await vault.save(testToken);
  let vaultStatus = "os_storage_unavailable_memory_fallback";
  if (saved.persistent) {
    const reopened = new SessionVault(resolve(app.getPath("userData"), "vault-smoke"), "https://vault-smoke.example", safeStorage);
    const restored = await reopened.restore();
    const encrypted = !(await readFile(vault.filename)).includes(testToken);
    await reopened.clear();
    const cleared = !(await vault.restore()).accessToken;
    vaultStatus = restored.accessToken === testToken && encrypted && cleared ? "passed_os_encryption_restore_and_clear" : "failed";
  }
  const baselineCount = webContents.getAllWebContents().length;
  for (let index = 0; index < 20; index += 1) {
    await createEvidenceView(`https://www.xiaohongshu.com/explore/smoke-${index}`);
    await evidenceView?.webContents.executeJavaScript("document.getElementById('blocked').click()", true);
    destroyEvidenceView();
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  const finalCount = webContents.getAllWebContents().length;
  const deepLinkAccepted = dispatchAuthCallback(`${DEEP_LINK_SCHEME}://auth/callback?code=smoke-code&returnTo=%2F`);
  const pendingAuthShape = pendingAuthCallback?.code === "smoke-code";
  pendingAuthCallback = null;
  const result = {
    schemaVersion: "travel-desktop-electron-smoke-v1",
    status: baselineCount === finalCount && blockedNavigationCount >= 20 && deepLinkAccepted && pendingAuthShape && vaultStatus !== "failed" ? "passed_security_smoke" : "failed",
    sessionVault: vaultStatus,
    electronVersion: process.versions.electron,
    trustedProtocolLoaded: trustedView.webContents.getURL().startsWith(TRUSTED_APP_ORIGIN),
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    independentEvidenceSession: trustedView.webContents.session !== session.fromPartition(EVIDENCE_PARTITION),
    blockedUnknownNavigations: blockedNavigationCount,
    openCloseCycles: 20,
    residualWebContents: finalCount - baselineCount,
    deepLinkContract: deepLinkAccepted && pendingAuthShape ? "passed_without_access_token_in_url" : "failed",
    amapCustomOrigin: process.env.TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS === "passed_live_smoke" ? "passed_live_smoke" : "blocked_missing_amap_js_credentials_or_live_smoke",
    productionOAuth: "not_exercised_without_platform_credentials",
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  app.exit(result.status === "passed_security_smoke" ? 0 : 1);
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const deepLink = argv.find((value) => value.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (deepLink) dispatchAuthCallback(deepLink);
    mainWindow?.show();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    dispatchAuthCallback(url);
  });
  app.whenReady().then(async () => {
    if (app.isPackaged && !API_ORIGIN) {
      const { dialog } = await import("electron");
      dialog.showErrorBox("Travel Agent 尚未配置", "该桌面包没有生产 HTTPS API 地址。请由发布者重新打包并配置 TRAVEL_AGENT_DESKTOP_API_ORIGIN。");
      app.exit(1);
      return;
    }
    if (!DESKTOP_SMOKE) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    installIpc();
    await createWindow();
    if (DESKTOP_SMOKE) await runSmoke();
  }).catch((error: unknown) => {
    process.stderr.write(`desktop_start_failed:${error instanceof Error ? error.message : "unknown"}\n`);
    app.exit(1);
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin" || DESKTOP_SMOKE) app.quit(); });
}
