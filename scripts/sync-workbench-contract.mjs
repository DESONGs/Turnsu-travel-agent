import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const root = fileURLToPath(new URL("../", import.meta.url));
export async function syncContract() {
  const bytes = await readFile(resolve(root, "contracts/travel-workbench.json"));
  const contract = JSON.parse(bytes);
  if (contract.schemaVersion !== "travel-workbench-v1" || !Array.isArray(contract.components)
    || contract.components.some(c => !/^[a-z][a-z-]*$/.test(c.type) || c.version !== 1 || typeof c.fixed !== "boolean" || typeof c.label !== "string" || typeof c.binding !== "string")
    || new Set(contract.components.map(c => c.type)).size !== contract.components.length
    || contract.components.filter(c => c.fixed).map(c => c.type).join(",") !== "itinerary,map") throw new Error("Invalid travel component contract");
  await writeFile(resolve(root, "plugins/travel-agent-openai/workbench/src/catalog.mjs"),
    `// Generated from contracts/travel-workbench.json by the workbench build.\nexport const catalog = ${JSON.stringify(contract, null, 2)};\n`);
  return { contract, bytes };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await syncContract();
