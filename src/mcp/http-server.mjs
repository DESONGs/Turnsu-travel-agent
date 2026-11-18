import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBackendClient, createTravelMcpApp } from "./app-server.mjs";
import { loadTravelRuntimeEnv } from "../http/runtime-env.mjs";

export function createMcpHttpApp({ backendOrigin = "http://127.0.0.1:8797", publicOrigin, uiRoot, fetchImpl = fetch }) {
  const app = express(); app.disable("x-powered-by"); app.use(express.json({ limit: "6mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "travel-mcp", backendConfigured: Boolean(backendOrigin), uiRootConfigured: Boolean(uiRoot) }));
  app.post("/mcp", async (request, response) => {
    const token = request.headers.authorization?.match(/^Bearer (mcp_[A-Za-z0-9_-]{43})$/)?.[1];
    let server, transport;
    try {
      if (!token) throw Object.assign(new Error("mcp_authorization_required"), { status: 401 });
      const backend = createBackendClient({ origin: backendOrigin, token, fetchImpl });
      await backend("/api/mcp/session");
      server = createTravelMcpApp({ backend, uiRoot, publicOrigin });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (response.headersSent) return response.end();
      const status = [401, 403].includes(error.status) ? error.status : 503;
      if (status === 401) response.set("WWW-Authenticate", `Bearer resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/mcp"`);
      response.status(status).json({ jsonrpc: "2.0", id: request.body?.id ?? null, error: { code: -32001, message: status === 503 ? "travel_service_unavailable" : "mcp_authorization_required" } });
    }
  });
  app.all("/mcp", (_request, response) => response.status(405).set("Allow", "POST").end());
  return app;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const env = await loadTravelRuntimeEnv();
  if (!env.TRAVEL_AGENT_PUBLIC_ORIGIN) throw new Error("TRAVEL_AGENT_PUBLIC_ORIGIN_required_for_mcp");
  const app = createMcpHttpApp({ backendOrigin: env.TRAVEL_AGENT_BACKEND_ORIGIN ?? "http://127.0.0.1:8797", publicOrigin: env.TRAVEL_AGENT_PUBLIC_ORIGIN, uiRoot: env.TRAVEL_AGENT_MCP_UI_ROOT });
  const port = Number(env.TRAVEL_AGENT_MCP_PORT ?? 8798);
  const server = app.listen(port, env.TRAVEL_AGENT_BIND_HOST ?? "127.0.0.1", () => process.stdout.write(`Travel MCP listening on ${port}\n`));
  process.once("SIGTERM", () => server.close()); process.once("SIGINT", () => server.close());
}
