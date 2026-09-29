import { createHttpApp } from "./app.mjs";
import { loadTravelRuntimeEnv } from "./runtime-env.mjs";

const runtimeEnv = await loadTravelRuntimeEnv();
const port = Number(runtimeEnv.PORT ?? 8797);
const app = createHttpApp({
  runtimeEnv,
  developmentAuthEnabled: runtimeEnv.NODE_ENV !== "production" && runtimeEnv.TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH === "true",
  allowedOrigins: new Set(String(runtimeEnv.TRAVEL_AGENT_CORS_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean)),
});

const server = app.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Travel Agent API listening on http://127.0.0.1:${port}\n`);
});

// Keep the CLI entrypoint attached to the listening socket even when an optional
// provider dependency unrefs other handles during startup (observed on Node 26).
server.ref();
let closing;
const shutdown = () => {
  closing ??= app.locals.executionService.close();
  server.close();
  const timeout = setTimeout(() => server.closeAllConnections(), 5000);
  timeout.unref();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await new Promise((resolve, reject) => {
  server.once("close", resolve);
  server.once("error", reject);
});
await app.locals.close();
