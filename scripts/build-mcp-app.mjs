import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../plugins/travel-agent-openai/workbench/", import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL("../plugins/travel-agent-openai/workbench/build.mjs", import.meta.url))], { cwd: directory, stdio: "inherit" });
