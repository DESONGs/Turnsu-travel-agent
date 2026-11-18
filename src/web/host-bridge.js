import { setHostTheme } from "./design-system/workspace-theme.js";
import { blobBase64 } from "./travel-journal-photo.js";
const unwrap = result => {
  if (result?.isError) {
    const value = result.content?.find(c => c.type === "text")?.text;
    let code = "travel_tool_failed"; try { code = JSON.parse(value).code ?? code; } catch { /* Do not surface raw tool output as HTML. */ }
    throw Object.assign(new Error(code), { code });
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const value = result?.content?.find(c => c.type === "text")?.text;
  if (value) { try { return JSON.parse(value); } catch { /* A connector may return a direct JSON value. */ } }
  return result;
};

export function createMcpHostBridge({ target = window.parent, eventSource = window, timeoutMs = 20_000 } = {}) {
  let sequence = 0; const pending = new Map(); const listeners = new Set();
  let capabilities = {};
  let lastResult;
  const request = (method, params = {}, { signal, timeout = timeoutMs } = {}) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const id = ++sequence;
    const abort = () => {
      pending.delete(id); clearTimeout(timer); reject(signal.reason);
      target.postMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }, "*");
    };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const timer = setTimeout(() => { cleanup(); pending.delete(id); reject(new Error("travel_host_bridge_timeout")); }, timeout);
    pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener("abort", abort, { once: true });
    target.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const receive = event => {
    if (event.source !== target || !event.data || event.data.jsonrpc !== "2.0") return;
    const message = event.data;
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); item.cleanup();
      message.error ? item.reject(Object.assign(new Error(message.error.message ?? "travel_host_error"), { code: message.error.code })) : item.resolve(message.result);
    } else if (message.method === "ui/notifications/tool-result") {
      lastResult = message.params?.structuredContent;
      for (const listener of listeners) listener(lastResult);
    } else if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
  };
  function applyContext(context) {
    if (typeof document === "undefined") return;
    setHostTheme(context?.theme);
    if (context?.styles?.css?.properties) for (const [key, value] of Object.entries(context.styles.css.properties)) if (key.startsWith("--")) document.documentElement.style.setProperty(key, value);
  }
  eventSource.addEventListener("message", receive);
  return {
    kind: "mcp-app", publicOrigin: globalThis.TRAVEL_PUBLIC_ORIGIN ?? "",
    async initialize() {
      const result = await request("ui/initialize", { appInfo: { name: "Travel Agent", version: "0.2.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
      capabilities = result?.hostCapabilities ?? {};
      applyContext(result?.hostContext);
      target.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      return result;
    },
    callTool: async (name, args) => unwrap(await request("tools/call", { name, arguments: args })),
    updateContext: context => request("ui/update-model-context", { content: [{ type: "text", text: JSON.stringify(context) }] }),
    sendMessage: text => request("ui/message", { role: "user", content: [{ type: "text", text }] }),
    get supportsDownload() { return Boolean(capabilities.downloadFile); },
    async downloadFile(file) {
      const resource = { uri: "file:///" + encodeURIComponent(file.name), mimeType: file.type, blob: await blobBase64(file) };
      const result = await request("ui/download-file", { contents: [{type: "resource", resource}] }, { timeout: 120_000 });
      if (result?.isError) throw new Error("download_incomplete");
    },
    get supportsImageMessage() { return Boolean(capabilities.message?.image && capabilities.message?.text); },
    sendImageMessage: (content, signal) => request("ui/message", { role: "user", content }, { signal }),
    get supportsSampling() { return Boolean(capabilities.sampling); },
    sample: (content, signal) => request("sampling/createMessage", { messages: [{ role: "user", content }], maxTokens: 6000, includeContext: "none" }, { signal, timeout: 240_000 }),
    openLink: url => request("ui/open-link", { url }),
    requestDisplayMode: mode => request("ui/request-display-mode", { mode }),
    onResult(listener) {
      listeners.add(listener);
      if (lastResult !== undefined) listener(lastResult);
      return () => listeners.delete(listener);
    },
    dispose() { eventSource.removeEventListener("message", receive); for (const item of pending.values()) { item.cleanup(); item.reject(new Error("travel_host_closed")); } pending.clear(); listeners.clear(); },
  };
}

/** Native Artifact bootstrap supplies its documented connector function; no host credentials enter this app. */
export function createClaudeArtifactBridge(connector) {
  if (typeof connector?.callTool !== "function") throw new Error("artifact_connector_not_available");
  return {
    kind: "claude-artifact", publicOrigin: globalThis.TRAVEL_PUBLIC_ORIGIN ?? "",
    ...(typeof connector.generateDestinationArtwork === "function" ? { generateDestinationArtwork: (input, signal) => connector.generateDestinationArtwork(input, signal) } : {}),
    async initialize() {
      const result = await connector.initialize?.();
      setHostTheme(result?.hostContext?.theme);
      return result;
    },
    callTool: async (name, args) => unwrap(await connector.callTool(name, args)),
    updateContext: context => connector.updateContext?.(context),
    sendMessage: text => connector.sendMessage?.(text),
    openLink: url => connector.openLink ? connector.openLink(url) : window.open(url, "_blank", "noopener,noreferrer"),
    requestDisplayMode: mode => connector.requestDisplayMode?.(mode),
    onResult: listener => connector.onResult?.(listener) ?? (() => {}),
    dispose: () => connector.dispose?.(),
  };
}

export const webHostBridge = { kind: "web", updateContext() {}, onResult: () => () => {}, openLink: url => window.open(url, "_blank", "noopener,noreferrer") };
