import { Pool } from "pg";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";

const url = new URL(process.env.TRAVEL_EXECUTION_TEST_DATABASE_URL);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/travel_execution_test") throw new Error("isolated_local_test_database_required");
const admin = new Pool({ connectionString: url.toString() });
const schema = `ui_${randomUUID().replaceAll("-", "")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
url.searchParams.set("options", `-c search_path=${schema}`);
const port = process.env.TRAVEL_EXECUTION_TEST_PORT ?? "18897";
const child = fork(new URL("./execution-worker.mjs", import.meta.url), [], { execArgv: ["--import", "tsx"],
  env: { PATH: process.env.PATH, TRAVEL_EXECUTION_TEST_DATABASE_URL: url.toString(), TRAVEL_EXECUTION_TEST_PORT: port, ...(process.env.TRAVEL_EXECUTION_TEST_PROFILE ? { TRAVEL_EXECUTION_TEST_PROFILE: process.env.TRAVEL_EXECUTION_TEST_PROFILE } : {}) }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.on("message", (message) => { if (message.type === "ready") process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${message.port}`, schema, pid: process.pid, fixtureOnly: true })}\n`); });
let closing = false;
const close = () => { if (!closing) { closing = true; child.kill("SIGTERM"); } };
process.once("SIGTERM", close); process.once("SIGINT", close);
child.once("exit", async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); process.exit(0); });
