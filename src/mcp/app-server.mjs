import { stripGoogleContent } from "../../travel-agent-pi-package/src/core/provider-content.ts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { travelOperation } from "./operations.ts";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const WORKSPACE_URI = "ui://travel/workspace.html";

export function createBackendClient({ origin, token, fetchImpl = fetch }) {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/") throw new Error("invalid_backend_origin");
  return async (path, { method = "GET", body, binary = false } = {}) => {
    if (!path.startsWith("/api/") || path.includes("..")) throw new Error("backend_path_not_allowed");
    const response = await fetchImpl(new URL(path, url), { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw Object.assign(new Error(payload.code ?? "travel_backend_unavailable"), { code: payload.code ?? "travel_backend_unavailable", status: response.status });
    }
    if (response.status === 204) return null;
    if (binary) { const data = Buffer.from(await response.arrayBuffer()); if (data.length > 5_000_000) throw new Error("travel_media_too_large"); return { mimeType: response.headers.get("content-type"), data: data.toString("base64") }; }
    return response.json();
  };
}

export function createTravelMcpApp({ backend, uiRoot = resolve("dist-mcp"), publicOrigin = "" }) {
  const server = new McpServer({ name: "travel-agent-workspace", version: "0.2.0" }, { instructions: "Open and operate the same persistent global trip. Submit planning requests to the backend Travel Parent Agent; it owns research, evidence, validation and commits. Keep conversationId and requestId on retries. Only confirmed actions may adopt a draft. Never buy, pay or modify social services." });
  const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  const register = (name, config, handler) => server.registerTool(name, { ...config, _meta: { ...config._meta, securitySchemes: [{ type: "oauth2", scopes: config.annotations?.readOnlyHint ? ["travel:read"] : ["travel:read", "travel:write"] }] } }, async input => {
    try { const value = await handler(input); return result(name === "travel_app_action" ? value : stripGoogleContent(value)); }
    catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "error", code: error.code ?? error.message ?? "travel_operation_failed" }) }] }; }
  });
  const read = { readOnlyHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  server.registerResource("travel-workspace", WORKSPACE_URI, { mimeType: "text/html;profile=mcp-app" }, async () => ({ contents: [{ uri: WORKSPACE_URI, mimeType: "text/html;profile=mcp-app", text: (await readFile(resolve(uiRoot, "workspace.html"), "utf8")).replaceAll('"__TRAVEL_PUBLIC_ORIGIN__"', JSON.stringify(String(publicOrigin)).replaceAll("<", "\\u003c")),
    _meta: { ui: { prefersBorder: false, csp: { connectDomains: [...(publicOrigin ? [publicOrigin] : []), "https://restapi.amap.com", "https://*.amap.com", "https://*.autonavi.com", "https://maps.googleapis.com", "https://tile.googleapis.com", "https://maps.gstatic.com"], resourceDomains: [...(publicOrigin ? [publicOrigin] : []), "https://webapi.amap.com", "https://*.amap.com", "https://*.autonavi.com", "https://maps.googleapis.com", "https://maps.gstatic.com", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.ggpht.com", "https://*.googleusercontent.com"], frameDomains: [] } } } }] }));
  register("list_travel_workspaces", { title: "My trips", description: "List the authenticated user's existing travel conversations and trips.", inputSchema: {}, annotations: read }, async () => ({ conversations: await backend("/api/conversations"), trips: await backend("/api/trips") }));
  register("open_travel_workspace", { title: "Travel Agent", description: "Open the shared editable travel workspace. Reuse conversationId to continue an existing trip; omit it to show the trip list.", inputSchema: { conversationId: id.optional() }, annotations: read,
    _meta: { ui: { resourceUri: WORKSPACE_URI }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } } }, async ({ conversationId }) => conversationId ? backend(`/api/mcp/workspace?conversationId=${encodeURIComponent(conversationId)}`) : { schemaVersion: "travel-workspace-v1", conversationId: null });
  register("get_travel_workspace", { description: "Read saved plan, current draft, revision, pending questions and durable runs for this travel conversation.", inputSchema: { conversationId: id }, annotations: read }, ({ conversationId }) => backend(`/api/mcp/workspace?conversationId=${encodeURIComponent(conversationId)}`));
  register("create_travel_workspace", { description: "Create a new travel conversation, then retain its conversationId for every subsequent planning request. Existing trips must be selected from list_travel_workspaces.", inputSchema: {}, annotations: { ...write, idempotentHint: false } }, () => backend("/api/conversations", { method: "POST", body: {} }));
  register("submit_travel_request", { description: "Ask the backend Travel Parent Agent to plan or revise a trip, or answer its pending question. Returns a durable run immediately; read get_travel_run for progress. A repeated requestId reuses the original run.", inputSchema: { conversationId: id, requestId: id, text: z.string().min(1).max(12_000), planningContext: z.record(z.string(), z.unknown()).optional(), answerTo: z.object({ runId: id, questionId: id, optionId: id.optional() }).optional() }, annotations: { ...write, openWorldHint: true, idempotentHint: true } }, async input => {
    const conversationId = input.conversationId;
    return backend(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { method: "POST", body: { ...input, conversationId } });
  });
  register("get_travel_run", { description: "Read a durable travel run and new events after the supplied cursor. Reopen saved runs after disconnecting.", inputSchema: { runId: id, after: z.number().int().nonnegative().optional() }, annotations: read }, ({ runId, after = 0 }) => backend(`/api/runs/${encodeURIComponent(runId)}?after=${after}`));
  register("cancel_travel_run", { description: "Stop an existing planning run while keeping its saved trip and draft.", inputSchema: { runId: id }, annotations: { ...write, idempotentHint: true } }, ({ runId }) => backend(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", body: {} }));
  // UI calls use explicit operation names; routing, scopes and ownership are enforced server-side.
  register("travel_app_action", { title: "Travel workspace action", description: "Execute an explicit shared-workspace action. Planning requests must use submit, and changes are still checked by the backend Parent's commit gate.", inputSchema: { action: z.string().max(64), args: z.record(z.string(), z.unknown()).optional(), body: z.record(z.string(), z.unknown()).optional() },
    annotations: { ...write, destructiveHint: true, openWorldHint: true }, _meta: { ui: { visibility: ["app"] } } }, ({ action, args = {}, body }) => {
    const op = travelOperation(action, args);
    return backend(op.path, { method: op.method, ...(op.method !== "GET" ? { body: body ?? {} } : {}), binary: op.binary });
  });
  const artifactUri = "ui://travel/artifact.html";
  server.registerResource("travel-artifact", artifactUri, { mimeType: "text/html" }, async () => ({ contents: [{ uri: artifactUri, mimeType: "text/html", text: (await readFile(resolve(uiRoot, "artifact.html"), "utf8")).replaceAll('"__TRAVEL_PUBLIC_ORIGIN__"', JSON.stringify(String(publicOrigin)).replaceAll("<", "\\u003c")) }] }));
  register("get_travel_artifact", { title: "Travel Agent Artifact", description: "Locate the self-contained Claude Artifact application. Read its resource or the plugin's bundled assets/artifact.html as a file and create/reopen one private Artifact. Bind the host's authorized Travel Agent connector to TRAVEL_ARTIFACT_CONNECTOR.callTool. Native Artifact availability must be checked in the host. Never publish a static itinerary as the live workspace.", inputSchema: {}, annotations: read }, async () => ({ schemaVersion: "travel-artifact-v1", resourceUri: artifactUri, bundledFile: "assets/artifact.html", mimeType: "text/html", connectorTool: "travel_app_action", application: "travel-agent", publicOrigin, connectorContract: { callTool: "(name, arguments) => Promise<MCPToolResult>" }, nativeBindingRequired: true }));
  return server;
}
