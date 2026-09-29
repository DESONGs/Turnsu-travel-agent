// Read-only planning-entry probe. No model, Provider, network, or business writes.
// Run from the repository root: node --import tsx wiki/research/assets/2026-09-15-runtime-architecture/planning-entry-probe.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { itineraryPlanningIntent } from "../../../../src/agent/travel-conversation-agent.mjs";
import { selectParentTravelSkills } from "../../../../src/agent/travel-skill-loader.mjs";

const cases = [
  "Plan a relaxed four-day trip to Shanghai for my parents. We arrive at Pudong at 15:00 and want to avoid long walks.",
  "帮我安排上海三天行程，带父母，少走路，预算八千。",
  "plan the itinerary",
  "优化路线",
];
const contexts = [
  { name: "new_conversation", control: null },
  { name: "existing_trip_without_proposal", control: { pendingProposals: [], openDecisions: [] } },
  { name: "existing_trip_with_proposal", control: { pendingProposals: [{ proposalId: "fixture" }], openDecisions: [] } },
];
const sourceFiles = ["src/agent/travel-conversation-agent.mjs", "src/agent/travel-skill-loader.mjs"];
const results = contexts.flatMap(({ name, control }) => cases.map((input) => {
  const skills = selectParentTravelSkills({ control, input }).map((skill) => skill.skillId);
  const intent = itineraryPlanningIntent(input);
  return { context: name, input, skills, itineraryPlanningIntent: intent, planningTurn: skills.includes("plan-trip") && intent };
}));
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  node: process.version,
  scope: "Pure entry-gate behavior only; not an end-to-end model, itinerary-quality, or production-capacity test.",
  sources: sourceFiles.map((path) => ({ path, sha256: createHash("sha256").update(readFileSync(new URL(`../../../../${path}`, import.meta.url))).digest("hex") })),
  results,
}, null, 2));
