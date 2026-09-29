import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { createTravelService } from "../src/api/create-travel-service.mjs";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";

const env = await loadTravelRuntimeEnv();
assert.equal(env.TRAVEL_AGENT_MODEL_PROVIDER, "deepseek", "DeepSeek reasoning route is not configured");
assert.ok(env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY is not configured");
const tripStart = new Date();
tripStart.setUTCDate(tripStart.getUTCDate() + 14);
const tripEnd = new Date(tripStart);
tripEnd.setUTCDate(tripEnd.getUTCDate() + 4);
const tripDates = `${tripStart.toISOString().slice(0, 10)} 至 ${tripEnd.toISOString().slice(0, 10)}`;

const rootDir = await mkdtemp(join(tmpdir(), "travel-agent-live-conversation-"));
const travelService = createTravelService(env, {
  store: new TripStore({ rootDir: join(rootDir, "trips") }),
});
const conversationRepository = new FileConversationRepository({ rootDir: join(rootDir, "conversations") });
const agent = new TravelConversationAgent({ travelService, conversationRepository, env });
const userId = "live_smoke_traveler";
const conversation = await agent.createConversation({ userId });

const first = await agent.reply({
  conversationId: conversation.conversationId,
  userId,
  text: `${tripDates} 和父母去上海 5 天，轻松一点，住得方便，想吃本地菜。父亲需要少走路并避开楼梯，总预算 12000 元。`,
});
assert.equal(first.status, "completed", JSON.stringify({ code: first.code ?? null, activities: first.activities }));
assert.ok(first.tripId, "The first natural-language request did not create a trip understanding");
assert.ok(first.activities.some((activity) => activity.toolName === "save_trip_understanding"), "The model did not save the first request");

const second = await agent.reply({
  conversationId: conversation.conversationId,
  userId,
  text: "北京出发，飞机。还没决定住宿位置，需要你帮忙设计。",
});
assert.equal(second.status, "completed", JSON.stringify({ code: second.code ?? null, activities: second.activities }));
assert.equal(second.tripId, first.tripId);
assert.ok(second.activities.some((activity) => activity.toolName === "save_trip_understanding"), "The model did not merge the short follow-up");
assert.ok(second.activities.some((activity) => activity.toolName === "research_trip_options"), "The model did not continue linked trip research");

const control = await travelService.getTripControlView(first.tripId);
assert.equal(control.brief.destination, "上海");
assert.equal(control.brief.durationDays, 5);
assert.equal(control.brief.origin, "北京");
assert.match(String(control.brief.arrivalMode), /飞/);
assert.ok(String(control.brief.lodgingPreference ?? "").trim(), "The lodging preference from the conversation was not preserved");
assert.equal(control.brief.totalBudget, 12_000, "The model did not preserve the total budget");
const father = control.travelers.find((traveler) => traveler.displayName === "父亲" || traveler.relationship === "父亲");
assert.ok(father, "The model did not preserve the father as an individual traveler");
assert.equal(father.careNeeds?.mobility?.reduceWalking, true, "The father's reduced-walking need was not bound to him");
assert.equal(father.careNeeds?.mobility?.avoidStairs, true, "The father's avoid-stairs need was not bound to him");

const stagedPlan = await travelService.getTripPlanView(first.tripId);
assert.equal(stagedPlan.pendingProposals.length, 1, "Live providers did not stage a proposal for user comparison");
assert.equal(stagedPlan.weather?.status, "completed", "The linked trip proposal did not persist verified weather into shared trip state");
assert.ok(["covered", "partial", "outside_forecast_window"].includes(stagedPlan.weather.coverage), `Trip weather returned an invalid coverage state: ${stagedPlan.weather.coverage}`);
if (stagedPlan.weather.coverage === "outside_forecast_window") {
  assert.equal(stagedPlan.weather.planningImpact.active, false, "Out-of-window weather must not pretend to affect the itinerary");
}
const proposal = stagedPlan.pendingProposals[0];
assert.ok((proposal.analysis?.taskCount ?? 0) >= 2, "The live Web service path did not trigger at least two distinct semantic analysis lanes");
assert.equal(proposal.analysis.joinCount, 1, "The live semantic analysis must Join exactly once");
const laneStarts = (proposal.analysis.events ?? []).filter((event) => event.type === "analysis_lane_started");
const laneEnds = (proposal.analysis.events ?? []).filter((event) => event.type === "analysis_lane_completed");
assert.ok(laneStarts.length >= 2 && laneEnds.length >= 2, "The live analysis trace did not contain two lane start/end pairs");
assert.ok(new Date(laneStarts[1].at).getTime() <= Math.min(...laneEnds.map((event) => new Date(event.at).getTime())), "The live semantic lane intervals did not overlap");
const candidateCounts = Object.fromEntries(Object.entries(proposal.byDomain).map(([domain, candidates]) => [domain, candidates.length]));
assert.ok(Object.values(candidateCounts).some((count) => count > 0), "Live providers returned no candidate in any domain");
const selections = Object.fromEntries(Object.entries(proposal.byDomain).filter(([, candidates]) => candidates.length).map(([domain, candidates]) => [domain, candidates[0].nodeId]));
const accepted = await travelService.acceptTripChange({ tripId: first.tripId, proposalId: proposal.proposalId, selections });
if (accepted.status !== "committed") process.stdout.write(`${JSON.stringify({ status: "blocked_live_golden_path", candidateCounts, analysisCoverage: proposal.analysis?.coverage, validation: accepted.validation, feasibility: accepted.feasibility, artifactDir: rootDir })}\n`);
assert.equal(accepted.status, "committed", "User selections did not commit through the Parent Agent service boundary");
const acceptedPlan = await travelService.getTripPlanView(first.tripId);
const acceptedDomains = Object.entries(acceptedPlan.byDomain).filter(([, candidates]) => candidates.some((candidate) => candidate.selected)).map(([domain]) => domain).sort();
const missingDomains = Object.entries(candidateCounts).filter(([, count]) => count === 0).map(([domain]) => domain).sort();

const visibleText = second.conversation.messages.map((message) => message.text).join("\n");
assert.doesNotMatch(visibleText, /Schema|Runtime|Provider|Smoke|TripState|Evidence|TripPatch|revision|write set|weatherFit|preferred|caution|contextual/i);
if (stagedPlan.weather.provider === "open_meteo") {
  assert.doesNotMatch(visibleText, /官方(?:预报|天气)/, "The Agent mislabeled Open-Meteo as an official forecast source");
}

const analysisCoverage = proposal.analysis.coverage;
const smokeStatus = analysisCoverage === "complete" ? "passed_live_smoke" : `${analysisCoverage}_live_smoke`;
const output = JSON.stringify({
  status: smokeStatus,
  model: `${env.TRAVEL_AGENT_MODEL_PROVIDER}/${env.TRAVEL_AGENT_MODEL}`,
  turns: 2,
  tripUnderstanding: {
    destination: control.brief.destination,
    durationDays: control.brief.durationDays,
    origin: control.brief.origin,
    arrivalMode: control.brief.arrivalMode,
    travelerCount: control.travelers.length,
    totalBudget: control.brief.totalBudget,
    constrainedTraveler: { displayName: father.displayName, mobility: father.careNeeds.mobility },
  },
  secondTurnActivities: second.activities.map(({ toolName, status }) => ({ toolName, status })),
  agentTrace: second.agentTrace,
  analysis: { status: proposal.analysis.status, coverage: analysisCoverage, engine: proposal.analysis.engine, requiredLanes: proposal.analysis.requiredLanes, startedLanes: proposal.analysis.startedLanes, completedLanes: proposal.analysis.completedLanes, failedLanes: proposal.analysis.failedLanes, timedOutLanes: proposal.analysis.timedOutLanes, degradedReasons: proposal.analysis.degradedReasons, lanes: proposal.analysis.lanes.map((lane) => lane.lane), joinCount: proposal.analysis.joinCount, conditionRevision: proposal.analysis.conditionRevision },
  providerCalls: travelService.researchProvider.lastResearchTrace,
  weather: {
    provider: stagedPlan.weather.provider,
    coverage: stagedPlan.weather.coverage,
    severity: stagedPlan.weather.planningImpact.severity,
    affectedDomains: stagedPlan.weather.planningImpact.affectedDomains,
  },
  liveProposal: { candidateCounts, acceptedDomains, missingDomains },
  note: analysisCoverage !== "complete"
    ? "The natural-language path returned honest partial evidence, but required semantic analysis did not complete; this is not a complete planning pass."
    : missingDomains.length
      ? "Live model, provider, proposal and commit path passed for available domains; missing domains remain visible instead of being fabricated."
      : "Live model, provider, proposal and commit path passed for all domains.",
}, null, 2);
process.stdout.write(`${output}\n`, () => process.exit(analysisCoverage === "complete" ? 0 : 1));
