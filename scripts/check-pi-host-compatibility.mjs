import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { piHostCompatibility, SUPPORTED_PI_HOST } from "../src/agent/pi-host-compatibility.mjs";

const execFileAsync = promisify(execFile);
const commands = [
  { name: "project_local", command: new URL("../node_modules/.bin/pi", import.meta.url).pathname, expected: "compatible" },
  { name: "target_global", command: process.env.TRAVEL_AGENT_GLOBAL_PI_COMMAND ?? join(homedir(), ".nvm", "current", "bin", "pi") },
];
const matrix = [];
for (const entry of commands) {
  const { stdout, stderr } = await execFileAsync(entry.command, ["--version"], { env: { ...process.env, PI_CODING_AGENT_DIR: `/private/tmp/zhuanshu-pi-host-${entry.name}`, PI_TELEMETRY: "0" } });
  const version = `${stdout}\n${stderr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "";
  const compatibility = piHostCompatibility(version);
  if (entry.expected) assert.equal(compatibility.status, entry.expected, `${entry.name} compatibility changed`);
  matrix.push({ host: entry.name, version, ...compatibility });
}
const globalHost = matrix.find((entry) => entry.host === "target_global");
if (globalHost && !globalHost.supported) {
  globalHost.loadGate = "blocked_before_business_extensions";
  globalHost.diagnostic = `unsupported_pi_host_version:${globalHost.version};required>=${SUPPORTED_PI_HOST.minimum}<${SUPPORTED_PI_HOST.maximumExclusive}`;
}
const status = globalHost?.supported ? "passed_compatibility_gate" : "incompatible_global_host_blocked";
process.stdout.write(`${JSON.stringify({ status, matrix })}\n`);
if (!globalHost?.supported) process.exitCode = 2;
