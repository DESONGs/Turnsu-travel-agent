import { createHttpApp } from "../http/app.mjs";
import { loadTravelRuntimeEnv } from "../http/runtime-env.mjs";

const env = await loadTravelRuntimeEnv();
if (!env.DATABASE_URL) throw new Error("execution_worker_requires_postgres");
const app = createHttpApp({ runtimeEnv: { ...env, TRAVEL_AGENT_EXECUTION_ROLE: "worker" } });
await app.locals.executionService.repository.migrate();
app.locals.executionService.timer.ref();
process.stdout.write("Travel execution worker ready.\n");
await new Promise((resolve) => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
await app.locals.close();
