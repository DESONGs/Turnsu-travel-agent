import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTravelMcpApp, createBackendClient } from "../src/mcp/app-server.mjs";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";
const env = await loadTravelRuntimeEnv();
if (env.TRAVEL_AGENT_MCP_ACCESS_TOKEN && env.TRAVEL_AGENT_BACKEND_ORIGIN) {
  const server = createTravelMcpApp({ backend: createBackendClient({ origin: env.TRAVEL_AGENT_BACKEND_ORIGIN, token: env.TRAVEL_AGENT_MCP_ACCESS_TOKEN }), publicOrigin: env.TRAVEL_AGENT_PUBLIC_ORIGIN, uiRoot: env.TRAVEL_AGENT_MCP_UI_ROOT });
  await server.connect(new StdioServerTransport());
} else if (env.NODE_ENV !== "production") {
  process.stderr.write("Local development MCP. Hosted plugins use the authenticated shared HTTP gateway.\n");
  await import("../src/mcp/server.mjs");
} else throw new Error("authenticated_shared_backend_required_for_mcp");
