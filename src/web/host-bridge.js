const unwrap = result => {
  if (result?.isError) {
    const value = result.content?.find(c => c.type === "text")?.text;
    let code = "travel_tool_failed"; try { code = JSON.parse(value).code ?? code; } catch { /* Do not surface raw tool output as HTML. */ }
    throw Object.assign(new Error(code), { code });
  }
  if (result?._meta?.["travel/uiData"] !== undefined) return result._meta["travel/uiData"];
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const value = result?.content?.find(c => c.type === "text")?.text;
  if (value) { try { return JSON.parse(value); } catch { /* A connector may return a direct JSON value. */ } }
  return result;
};

export function createMcpHostBridge({ target = window.parent, eventSource = window, timeoutMs = 20_000 } = {}) {
  let sequence = 0; const pending = new Map(); const listeners = new Set(); const contexts = new Set();
  let lastResult; let hostContext = {};
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error("travel_host_bridge_unavailable"), { code: "travel_host_bridge_unavailable" })); }, timeoutMs);
    pending.set(id, { resolve, reject, timer }); target.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  const receive = event => {
    if (event.source !== target || !event.data || event.data.jsonrpc !== "2.0") return;
    const message = event.data;
    if (pending.has(message.id)) {
      const item = pending.get(message.id); pending.delete(message.id); clearTimeout(item.timer);
      message.error ? item.reject(Object.assign(new Error(message.error.message ?? "travel_host_error"), { code: message.error.code })) : item.resolve(message.result);
    } else if (message.method === "ui/notifications/tool-result") {
      const value = message.params?.structuredContent; lastResult = value;
      for (const listener of listeners) listener(value);
    } else if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
  };
  function applyContext(context) {
    hostContext = { ...hostContext, ...context };
    for (const listener of contexts) listener(hostContext);
    if (typeof document === "undefined") return;
    if (["light", "dark"].includes(context?.theme)) document.documentElement.dataset.hostTheme = context.theme;
    if (context?.styles?.css?.properties) for (const [key, value] of Object.entries(context.styles.css.properties)) if (key.startsWith("--")) document.documentElement.style.setProperty(key, value);
  }
  eventSource.addEventListener("message", receive);
  return {
    kind: "mcp-app", publicOrigin: globalThis.TRAVEL_PUBLIC_ORIGIN ?? "",
    async initialize() {
      const result = await request("ui/initialize", { appInfo: { name: "Travel Agent", version: "0.2.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" });
      applyContext(result?.hostContext);
      target.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
      return result;
    },
    callTool: async (name, args) => unwrap(await request("tools/call", { name, arguments: args })),
    updateContext: context => request("ui/update-model-context", { content: [{ type: "text", text: JSON.stringify(context) }] }),
    sendMessage: text => request("ui/message", { role: "user", content: [{ type: "text", text }] }),
    openLink: url => request("ui/open-link", { url }),
    async requestDisplayMode(mode) { const result = await request("ui/request-display-mode", { mode }); if (result?.mode) applyContext({ displayMode: result.mode }); return result; },
    getContext: () => hostContext,
    onContext(listener) { contexts.add(listener); listener(hostContext); return () => contexts.delete(listener); },
    onResult(listener) { listeners.add(listener); if (lastResult !== undefined) listener(lastResult); return () => listeners.delete(listener); },
    dispose() { eventSource.removeEventListener("message", receive); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("travel_host_closed")); } pending.clear(); listeners.clear(); contexts.clear(); },
  };
}

/** Native Artifact bootstrap supplies its documented connector function; no host credentials enter this app. */
export function createClaudeArtifactBridge(connector) {
  if (typeof connector?.callTool !== "function") throw new Error("artifact_connector_not_available");
  return {
    kind: "claude-artifact", publicOrigin: globalThis.TRAVEL_PUBLIC_ORIGIN ?? "",
    initialize: async () => connector.initialize?.(),
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
