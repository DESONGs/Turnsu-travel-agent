import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { researchFixture } from "./jev-travel.mjs";

// Fictional facts and model replies. The real service still runs the contract,
// Mobility, budget, Checker and persistence; this does not test provider quality.
export function planningProvider({ onResearch = () => {}, onRoute = () => {} } = {}) {
  return {
    status: "configured", canPlanMobility: true,
    async research() {
      onResearch();
      const value = researchFixture();
      for (const rows of Object.values(value.byDomain)) for (const candidate of rows) {
        candidate.operability.openWeek = "00:00-23:59";
        candidate.operability.checkedAt = value.checkedAt;
        if (candidate.domain === "transport") Object.assign(candidate.operability, { mobilityRole: "intercity_inventory", transportType: "TRAIN", scheduleVerified: true, inventoryVerified: true, highSpeed: true, departureAt: "2026-10-15T08:00:00+08:00", arrivalAt: "2026-10-15T09:00:00+08:00", departurePlace: { label: "杭州东" }, arrivalPlace: { label: "上海虹桥" } });
        candidate.summary = candidate.candidateId.endsWith("_0") ? "室内环境安静，有本地文化介绍" : "户外活动，白天环境热闹";
      }
      return value;
    },
    async planMobility({ itineraryStops }) {
      onRoute();
      const place = stop => ({ nodeId: stop.nodeId, stopId: stop.stopId, label: stop.title, coordinates: null, dayIndex: stop.dayIndex, date: stop.date, role: stop.role, startAt: stop.startAt, endAt: stop.endAt });
      return { schemaVersion: "trip-mobility-v1", status: "completed", destination: "上海", source: "fixture", checkedAt: new Date().toISOString(), freshUntil: new Date(Date.now() + 3600000).toISOString(),
        coverage: { routedNodeIds: [...new Set(itineraryStops.map(stop => stop.nodeId))], unresolvedNodeIds: [], routedStopIds: itineraryStops.map(stop => stop.stopId), unresolvedStopIds: [], unscheduled: false },
        legs: itineraryStops.slice(0, -1).map((stop, i) => ({ legId: `fixture_leg_${i}`, origin: place(stop), destination: place(itineraryStops[i + 1]), recommendedMode: "taxi", rationale: "受控路线",
          alternatives: [{ mode: "taxi", totalMinutes: 20, distanceMeters: 3000, walkingMeters: 0, transfers: 0, estimatedFareCny: 25, scheduleBasis: "query_time_estimate", realTimeArrival: false, navigationUrl: null, polyline: [], steps: [], accessibilityFeatures: [], accessibilityAssessment: { hasStairs: false, hasElevator: false, hasEscalator: false, hasRamp: false, stepFreeContinuity: "not_verified", realTimeStatus: false } }] })),
        travelerFit: {}, reason: null, caveats: ["Controlled fixture, not a real route"], sourceDocumentation: null, fabricatedResults: false };
    },
  };
}

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
export function planningResponse(context) {
  try { return response(context); }
  catch (error) { process.stderr.write(`Planning fixture failed: ${error.stack}\n`); throw error; }
}
function response(context) {
  let last = context.messages.at(-1);
  const controlMessage = /travel-operation-result|travel-resume|travel-advance|deferred read has finished|Model capacity is available again|requested complete planning is not finished/;
  const lastUser = context.messages.findLast(message => message.role === "user" && !controlMessage.test(JSON.stringify(message)));
  const text = JSON.stringify(lastUser?.content ?? "");
  if (/Model capacity is available again|requested complete planning is not finished/.test(JSON.stringify(last))) {
    const userIndex = context.messages.indexOf(lastUser);
    last = context.messages.slice(userIndex + 1).findLast(message => message.role === "toolResult" && !message.isError) ?? lastUser;
  }
  if (controlMessage.test(JSON.stringify(last))) {
    if (text.includes("日期还没定")) return call("ask_travel_question", { question: "哪天出发？", choices: ["2026年10月15日", "2026年10月16日"], impact: "日期决定开放时间与交通时刻的核验范围。" });
    return call("get_trip_plan_view", {});
  }
  if (last?.role === "user") return call("save_trip_understanding", {
    destination: "上海", origin: "杭州", totalBudget: 6000, durationDays: 1,
    ...(!text.includes("日期还没定") ? { dates: "2026-10-15" } : {}),
  });
  if (last?.toolName === "save_trip_understanding") return call("research_trip_options", { question: "根据已有要求完成一天吃住行玩草案，保留安静的候选", domains: ["play", "food", "stay", "transport"] });
  if (last?.toolName === "research_trip_options" || JSON.stringify(last).includes("travel-operation-result")) {
    if (text.includes("日期还没定")) return call("ask_travel_question", { question: "哪天出发？", choices: ["2026年10月15日", "2026年10月16日"], impact: "日期决定开放时间与交通时刻的核验范围。" });
    return call("get_trip_plan_view", {});
  }
  if (last?.toolName === "get_trip_plan_view") {
    const view = JSON.parse(last.content.find(item => item.type === "text").text);
    if (!Array.isArray(view.nodes)) throw new Error(`planning_context_missing: ${JSON.stringify(view)}`);
    const runId = context.systemPrompt.match(/runId[：=]([A-Za-z0-9_.:-]+)/)?.[1];
    const selections = ["transport", "play", "food", "stay"].map(domain => view.nodes.find(node => node.domain === domain));
    if (selections.some(node => !node)) throw new Error(`planning_candidates_missing: ${JSON.stringify(view.nodes.map(node => ({ nodeId: node.nodeId, domain: node.domain })))}`);
    return call("plan_itinerary_trial", {
      schemaVersion: "itinerary-plan-v1", scope: "complete_trip", runId, tripId: view.tripId, baseRevision: view.baseRevision, attempt: 1,
      objective: "一天的完整吃住行玩草案", priorities: ["保留用户预算", "保留来源"], lockedNodeIds: view.lockedNodeIds, fixedAnchors: [],
      days: [{ dayIndex: 1, date: "2026-10-15", stops: [...selections.map((node, i) => ({ nodeId: node.nodeId, role: ["intercity_arrival", "activity", "meal", "stay_check_in"][i],
        timeWindow: { startAt: `2026-10-15T${String(9 + i * 2).padStart(2, "0")}:00:00+08:00`, endAt: `2026-10-15T${String(10 + i * 2).padStart(2, "0")}:00:00+08:00` },
        durationMinutes: 60, fixed: false, preferredModes: ["taxi"], rationale: "受控模型基于已有候选安排" })), { nodeId: selections[2].nodeId, role: "meal", timeWindow: { startAt: "2026-10-15T18:00:00+08:00", endAt: "2026-10-15T19:00:00+08:00" }, durationMinutes: 60, fixed: false, preferredModes: ["taxi"], rationale: "住一晚的完整行程保留晚餐" }] }],
      assumptions: ["候选价格仍是估算"], needsContext: [], evidenceRefs: selections.flatMap(node => node.sourceRefs),
    });
  }
  if (last?.toolName === "plan_itinerary_trial") return fauxAssistantMessage("草案与路线核验已完成，可以查看取舍并采用。");
  if (JSON.stringify(last).includes("travel-resume")) return call("get_trip_plan_view", {});
  return fauxAssistantMessage("当前资料已处理。");
}
