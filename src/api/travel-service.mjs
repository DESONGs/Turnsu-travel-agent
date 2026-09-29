import { createHash, randomUUID } from "node:crypto";
import { currentTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { decisionHash, rankDecisionCandidates, TravelExecutionDeferred } from "../../travel-agent-pi-package/src/host/travel-decision-policy.ts";
import { buildJudgmentSnapshot } from "../../travel-agent-pi-package/src/host/travel-judgment.ts";
import { completeItineraryIssues, tripBusinessIssues, withTripFeasibility } from "../../travel-agent-pi-package/src/core/trip-feasibility.ts";
import { withScheduledRides, selectRoute, selectedRoute } from "../../travel-agent-pi-package/src/core/journey-execution.ts";
import { itinerarySelectionProposal, itineraryInputValidation } from "../../travel-agent-pi-package/src/core/itinerary-proposal.ts";
import { ensureContinuousPlanning, projectAdoptedPlan, saveWorkingPlan, adoptWorkingPlan, discardWorkingPlan, stablePlanVisits, planMobilityProjection, planNeedsRecheck, planningHash, editSavedPlan, continuousPlanningContext } from "../../travel-agent-pi-package/src/core/continuous-planning.ts";
import {
  acceptStagedTripPatch,
  applyMobilityObservation,
  applyWeatherObservation,
  buildItineraryDraft,
  commitTripPatch,
  createTripControlState,
  estimateTripBudget,
  finalizeItinerarySchedule,
  itineraryPlanToDraft,
  itineraryPreviewId,
  recordBookingConfirmation,
  recordTripFeedback,
  rejectStagedTripPatch,
  stageTripPatch,
  supersedeStagedTripPatch,
  updateTripControlScope,
  updateTripReadiness as applyTripReadinessUpdate,
  validateTripCoherence,
  assertSchema,
  ItineraryPlanSchema,
  ItineraryEditSchema,
} from "../../travel-agent-pi-package/src/core/index.ts";
import { createTripRepository } from "../persistence/trip-repository.mjs";
import { validateTravelMcpRequest } from "../../travel-agent-pi-package/src/mcp/index.ts";
import { normalizeTripMobility, transitSegmentFromNode } from "../../travel-agent-pi-package/src/contracts/public.ts";
import { buildTravelResearchCriteria, researchCriteriaMatchesProposal } from "../providers/research-criteria.mjs";

const FOUR_DOMAINS = Object.freeze(["play", "food", "stay", "transport"]);
const DOMAIN_LABELS = Object.freeze({ play: "玩", food: "吃", stay: "住", transport: "行" });
const READINESS_SIGNAL_IDS = new Set(["travel_documents", "mobile_access", "cashless_access", "china_account_continuity"]);
const READINESS_SIGNAL_STATUSES = new Set(["unknown", "ready", "needs_help", "not_applicable"]);
const GUEST_TRIP_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function serviceError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function requireTrip(state, tripId) {
  if (!state) throw serviceError("trip_not_found", { tripId });
  ensureContinuousPlanning(state);
  projectAdoptedPlan(state);
  return state;
}

function isInboundTrip(state) {
  return state.travelers.some((traveler) => !String(traveler.language ?? "zh-CN").toLowerCase().startsWith("zh")
    || traveler.hardConstraints?.some((constraint) => constraint?.type === "foreign_guest_required"));
}

function signalStatus(signal, { applicable = true } = {}) {
  if (!applicable || signal === "not_applicable") return "not_applicable";
  if (signal === "ready") return "ready";
  return signal === "needs_help" ? "action_required" : "needs_verification";
}

function readinessView(state) {
  const inbound = isInboundTrip(state);
  const signals = state.readiness?.signals ?? {};
  const selectedStay = state.nodes.find((node) => node.domain === "stay" && node.selected);
  const mobility = state.environment?.mobility;
  const guest = state.collaboration?.accessMode === "guest" || String(state.collaboration?.ownerUserId ?? "").startsWith("usr_guest_");
  const items = [
    {
      itemId: "trip_scope",
      title: "目的地与旅行日期",
      status: state.brief?.destination && state.brief?.dates ? "ready" : "action_required",
      reason: state.brief?.destination && state.brief?.dates ? "已经可以核验指定日期的路线与库存。" : "缺少目的地或日期会限制天气、库存和每日节奏核验。",
      action: "补充目的地和具体日期",
      editable: false,
      sourceNature: "traveler_input",
    },
    {
      itemId: "travel_documents",
      title: "入境与旅行证件",
      status: signalStatus(signals.travel_documents, { applicable: inbound }),
      reason: inbound ? "只记录是否已核对，不收集证件号码或影像。" : "国内旅行不需要入境准备检查。",
      action: inbound ? "按国籍与行程核对官方要求" : null,
      editable: inbound,
      sourceNature: "traveler_confirmation",
      guidanceUrl: inbound ? "https://english.www.gov.cn/2025special/bizexpatsinchina2025" : null,
    },
    {
      itemId: "mobile_access",
      title: "手机网络与可用联系方式",
      status: signalStatus(signals.mobile_access, { applicable: inbound }),
      reason: inbound ? "地图、票务、酒店沟通和账号恢复都依赖可用网络。" : "国内旅行默认沿用现有手机网络。",
      action: inbound ? "确认漫游、eSIM 或本地网络方案" : null,
      editable: inbound,
      sourceNature: "traveler_confirmation",
    },
    {
      itemId: "cashless_access",
      title: "支付与备用方式",
      status: signalStatus(signals.cashless_access, { applicable: inbound }),
      reason: inbound ? "只记录是否准备完成，不收集卡号、账户或支付凭据。" : "国内旅行不展示入境支付教育。",
      action: inbound ? "确认可用方式并保留备用方案" : null,
      editable: inbound,
      sourceNature: "traveler_confirmation",
      guidanceUrl: inbound ? "https://english.www.gov.cn/news/202404/11/content_WS6617c858c6d0868f4e8e5f4d.html" : null,
    },
    {
      itemId: "lodging_eligibility",
      title: "住宿与外宾接待资格",
      status: !inbound ? "not_applicable" : !selectedStay ? "action_required" : selectedStay.foreignGuestEligible === true ? "ready" : selectedStay.foreignGuestEligible === false ? "blocked" : "needs_verification",
      reason: !inbound ? "国内旅行不需要外宾资格检查。" : !selectedStay ? "选定住宿后才能核验指定酒店。" : selectedStay.foreignGuestEligible === true ? "当前已选住宿有外宾资格证据。" : selectedStay.foreignGuestEligible === false ? "当前资料显示该住宿不适合外宾入住。" : "当前来源尚未证明指定酒店可接待外宾。",
      action: inbound ? (selectedStay ? "在酒店或授权平台再次确认" : "先比较并选择住宿") : null,
      editable: false,
      sourceNature: selectedStay ? "selected_place_evidence" : "trip_decision",
    },
    {
      itemId: "china_account_continuity",
      title: "在中国境内继续打开旅行",
      status: guest ? "action_required" : signalStatus(signals.china_account_continuity, { applicable: inbound }),
      reason: guest ? "当前是临时旅行；登录后才能跨设备保存并在行中恢复。" : inbound ? "账号已经绑定，仍建议确认在中国境内可使用的登录方式。" : "账号已保存这趟旅行。",
      action: guest ? "登录并保存旅行" : inbound ? "确认中国境内连续方式" : null,
      editable: !guest && inbound,
      sourceNature: "account_state",
    },
    {
      itemId: "city_navigation",
      title: "市内路线与导航",
      status: mobility?.status === "completed" ? "ready" : mobility?.status === "partial" ? "needs_verification" : "action_required",
      reason: mobility?.status === "completed" ? "已取得查询时路线、步行与换乘参考。" : "确认地点后仍需核验市内移动；计划路线不等于实时到站。",
      action: "确认地点并刷新路线",
      editable: false,
      sourceNature: mobility ? "route_provider" : "trip_decision",
    },
  ];
  const counts = items.reduce((summary, item) => ({ ...summary, [item.status]: (summary[item.status] ?? 0) + 1 }), {});
  return {
    schemaVersion: "trip-readiness-view-v1",
    version: state.readiness?.version ?? 0,
    inbound,
    status: items.some((item) => item.status === "blocked") ? "blocked" : items.some((item) => ["action_required", "needs_verification"].includes(item.status)) ? "needs_attention" : "ready",
    counts,
    items,
    updatedAt: state.readiness?.updatedAt ?? state.updatedAt,
  };
}

function nodeScheduleValue(node) {
  if (node.domain === "transport" && ["intercity_inventory", "user_confirmed_arrival"].includes(node.operability?.mobilityRole)) {
    return node.operability?.arrivalAt ?? node.operability?.planningWindow?.endAt ?? node.time ?? null;
  }
  return node.operability?.planningWindow?.startAt ?? node.time ?? node.operability?.arrivalAt ?? node.operability?.departureAt ?? null;
}

function todayView(state, { clock } = {}) {
  const selectedNodes = state.nodes.filter((node) => node.selected);
  const nodesById = new Map(selectedNodes.map((node) => [node.nodeId, node]));
  const itineraryStops = state.environment?.mobility?.itinerary?.stops ?? [];
  const selected = itineraryStops.length ? itineraryStops.map((stop) => {
    const node = nodesById.get(stop.nodeId);
    const timestamp = stop.startAt ? new Date(stop.startAt).getTime() : Number.NaN;
    const roleLabel = { intercity_arrival: "抵达", bag_drop: "寄存行李", stay_check_in: "入住", stay_departure: "从住宿出发", stay_return: "返回住宿", meal: "用餐", activity: "游玩", local_transport: "市内移动" }[stop.role] ?? "安排";
    return {
      taskId: `task_${stop.stopId}`, stopId: stop.stopId, nodeId: stop.nodeId, domain: stop.domain,
      title: stop.role === "intercity_arrival" ? stop.title : node?.title ?? stop.title,
      role: stop.role, roleLabel, dayIndex: stop.dayIndex, date: stop.date, scheduledAt: stop.startAt,
      timestamp: Number.isFinite(timestamp) ? timestamp : null, summary: node?.summary ?? "", location: node?.location ?? null,
      media: node?.media ?? [], sourceStatus: node?.sourceStatus ?? "unverified", foreignGuestEligible: node?.foreignGuestEligible ?? null, operability: node?.operability ?? {},
    };
  }) : selectedNodes.map((node) => {
    const scheduledAt = nodeScheduleValue(node);
    const timestamp = scheduledAt ? new Date(scheduledAt).getTime() : Number.NaN;
    return {
      taskId: `task_${node.nodeId}`,
      nodeId: node.nodeId,
      domain: node.domain,
      title: node.title,
      summary: node.summary,
      scheduledAt,
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
      location: node.location,
      media: node.media ?? [],
      sourceStatus: node.sourceStatus,
      foreignGuestEligible: node.foreignGuestEligible,
      operability: node.operability ?? {},
    };
  });
  selected.sort((left, right) => {
    if (left.timestamp != null && right.timestamp != null) return left.timestamp - right.timestamp;
    if (left.timestamp != null) return -1;
    if (right.timestamp != null) return 1;
    return FOUR_DOMAINS.indexOf(left.domain) - FOUR_DOMAINS.indexOf(right.domain);
  });
  const nowValue = new Date(clock?.() ?? Date.now()).getTime();
  let currentIndex = selected.findIndex((task) => task.timestamp != null && task.timestamp >= nowValue);
  if (currentIndex < 0) currentIndex = selected.length ? 0 : -1;
  const currentTask = currentIndex >= 0 ? selected[currentIndex] : null;
  const nextTask = currentIndex >= 0 ? selected[currentIndex + 1] ?? null : null;
  const route = currentTask
    ? (state.environment?.mobility?.legs ?? []).find((leg) => nextTask
      ? (currentTask.stopId && nextTask.stopId ? leg.origin?.stopId === currentTask.stopId && leg.destination?.stopId === nextTask.stopId : leg.origin?.nodeId === currentTask.nodeId && leg.destination?.nodeId === nextTask.nodeId)
      : currentTask.stopId ? leg.origin?.stopId === currentTask.stopId || leg.destination?.stopId === currentTask.stopId : leg.origin?.nodeId === currentTask.nodeId || leg.destination?.nodeId === currentTask.nodeId) ?? null
    : null;
  const readiness = readinessView(state);
  return {
    schemaVersion: "trip-today-view-v1",
    status: !selected.length ? "planning" : selected.some((task) => task.timestamp != null) ? "ready" : "needs_schedule",
    currentTask,
    nextTask,
    route,
    tasks: selected,
    attentionItems: readiness.items.filter((item) => ["blocked", "action_required", "needs_verification"].includes(item.status)).slice(0, 3),
    routeCheckedAt: state.environment?.mobility?.checkedAt ?? null,
    routeRealTime: false,
  };
}

function controlView(state, providerStatus = "provider_unavailable") {
  return {
    schemaVersion: "trip-control-view-v1",
    tripId: state.tripId,
    revision: state.revision,
    storageVersion: state.storageVersion,
    activeBranchId: state.activeBranchId,
    brief: state.brief,
    travelers: state.travelers,
    nodes: state.nodes.filter(node => node.selected).map(({ nodeId, title, domain, selected, status, lock }) => ({ nodeId, title, domain, selected, status, lock })),
    locks: state.locks,
    openDecisions: state.openDecisions.filter((decision) => decision.status === "open"),
    dirtySet: state.dirtySet,
    taskQueues: state.taskQueues,
    pendingProposals: state.pendingProposals.map(({ operations, ...proposal }) => ({ ...proposal, operationCount: operations.length })),
    weather: state.environment?.weather ?? null,
    mobility: state.environment?.mobility ?? null,
    itinerary: state.environment?.mobility?.itinerary ?? null,
    feasibility: state.environment?.mobility?.feasibility ?? null,
    readiness: readinessView(state),
    providerStatus,
  };
}

function matchingVisitFeedback(node, sharedFeedback = []) {
  const sourceRefs = new Set(Array.isArray(node?.sourceRefs) ? node.sourceRefs : []);
  if (!sourceRefs.size) return [];
  const latest = new Map();
  for (const entry of sharedFeedback) {
    const feedback = entry?.feedback;
    if (feedback?.visibility !== "anonymous_travelers" || !feedback.place?.sourceRefs?.some((sourceRef) => sourceRefs.has(sourceRef))) continue;
    const key = `${entry.contributorKey ?? entry.tripId}:${feedback.category}`;
    const previous = latest.get(key);
    if (!previous || String(previous.feedback.recordedAt).localeCompare(String(feedback.recordedAt)) < 0) latest.set(key, entry);
  }
  return [...latest.values()];
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function visitFeedbackSummary(node, sharedFeedback = []) {
  const matches = matchingVisitFeedback(node, sharedFeedback);
  const experiences = matches.map((entry) => entry.feedback).filter((feedback) => feedback.category === "personal_experience" && feedback.verdict);
  const pendingFactChecks = matches.filter((entry) => ["fact_correction", "unverified_public_info"].includes(entry.feedback.category));
  if (!experiences.length && !pendingFactChecks.length) return null;
  const tagCounts = new Map();
  for (const feedback of experiences) {
    for (const tag of feedback.tags ?? []) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const timestamps = matches.map((entry) => entry.feedback.recordedAt).filter(Boolean).sort().reverse();
  return {
    schemaVersion: "place-visit-feedback-summary-v1",
    experienceCount: experiences.length,
    recommendation: {
      recommend: experiences.filter((feedback) => feedback.verdict === "recommend").length,
      mixed: experiences.filter((feedback) => feedback.verdict === "mixed").length,
      notRecommend: experiences.filter((feedback) => feedback.verdict === "not_recommend").length,
    },
    topTags: [...tagCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 6).map(([key, count]) => ({ key, count })),
    typicalSpendCny: median(experiences.map((feedback) => feedback.spendCny)),
    typicalWaitMinutes: median(experiences.map((feedback) => feedback.waitMinutes)),
    pendingFactCheckCount: pendingFactChecks.length,
    lastRecordedAt: timestamps[0] ?? null,
    evidenceNature: "anonymous_structured_visit_feedback",
  };
}

function evidenceSummaryForNode(node, evidence = {}) {
  const claimIds = new Set(node?.claimRefs ?? []);
  const sourceIds = new Set(node?.sourceRefs ?? []);
  const claims = (evidence?.claims ?? []).filter((claim) => claimIds.has(claim.claimId) || claim.nodeId === node?.nodeId);
  for (const claim of claims) for (const sourceRef of claim.sourceRefs ?? []) sourceIds.add(sourceRef);
  const sources = (evidence?.contentItems ?? []).filter((item) => sourceIds.has(item.contentItemId));
  if (!claims.length && !sources.length) return null;
  const independenceGroups = sources.map((item) => item.independenceGroup || item.contentItemId).filter(Boolean);
  const independentSourceCount = new Set(independenceGroups).size;
  const checkedAt = sources.map((item) => item.checkedAt).filter(Boolean).sort().at(-1) ?? null;
  const hasLocalVoice = sources.some((item) => /social|community|review|visit|traveler|ugc/i.test(`${item.sourceType} ${item.provider}`));
  return {
    headline: claims.sort((left, right) => Number(right.confidence ?? 0) - Number(left.confidence ?? 0))[0]?.statement ?? node?.summary ?? "",
    sourceCount: sources.length,
    independentSourceCount,
    repeatedSourceCount: Math.max(0, sources.length - independentSourceCount),
    hasLocalVoice,
    checkedAt,
    access: sources.some((item) => item.access === "login_required") ? "login_required" : sources.some((item) => item.access === "unavailable") ? "unavailable" : "public",
  };
}

function proposalView(proposal, sharedFeedback = []) {
  const byDomain = Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, []]));
  for (const operation of proposal.operations ?? []) {
    if (!["add_candidate", "select"].includes(operation.kind) || !FOUR_DOMAINS.includes(operation.node?.domain)) continue;
    const feedback = visitFeedbackSummary(operation.node, sharedFeedback);
    const evidenceSummary = evidenceSummaryForNode(operation.node, proposal.evidenceBundle);
    byDomain[operation.node.domain].push({
      nodeId: operation.nodeId,
      domain: operation.node.domain,
      title: operation.node.title,
      summary: operation.node.summary,
      selected: operation.node.selected === true,
      sourceStatus: operation.node.sourceStatus ?? "unverified",
      sourceRefs: operation.node.sourceRefs ?? [],
      claimRefs: operation.node.claimRefs ?? [],
      location: operation.node.location ?? null,
      cost: Number(operation.node.cost ?? 0),
      price: operation.node.price ?? null,
      foreignGuestEligible: operation.node.foreignGuestEligible ?? null,
      spoilerLevel: operation.node.spoilerLevel ?? "low",
      media: operation.node.media ?? [],
      operability: operation.node.operability ?? {},
      ...(feedback ? { visitFeedback: feedback } : {}),
      ...(evidenceSummary ? { evidenceSummary } : {}),
    });
  }
  return {
    schemaVersion: "trip-proposal-view-v1",
    proposalId: proposal.proposalId,
    baseRevision: proposal.baseRevision,
    title: proposal.title ?? "待确认旅行方案",
    summary: proposal.summary ?? "",
    provider: proposal.provider ?? null,
    providerLabel: proposal.providerLabel ?? null,
    checkedAt: proposal.checkedAt ?? null,
    sourceDocumentation: proposal.sourceDocumentation ?? null,
    caveats: proposal.caveats ?? [],
    partial: proposal.partial === true,
    fixtureOnly: proposal.fixtureOnly === true,
    analysis: proposal.analysis ?? null,
    comparison: proposal.comparison ?? null,
    domainStatuses: proposal.domainStatuses ?? null,
    stagedAt: proposal.stagedAt ?? null,
    itineraryPlan: proposal.itineraryPlan ?? null,
    itineraryPreviewId: proposal.itineraryPreviewId ?? null,
    planningRunId: proposal.planningRunId ?? null,
    planningAttempt: proposal.planningAttempt ?? null,
    byDomain,
  };
}

function planView(state, { mapPreviewAvailable = false, sharedFeedback = [], clock } = {}) {
  const nodeView = (node) => {
    const feedback = visitFeedbackSummary(node, sharedFeedback);
    const evidenceSummary = evidenceSummaryForNode(node, state.evidence);
    return {
      nodeId: node.nodeId,
      title: node.title,
      summary: node.summary,
      selected: node.selected,
      status: node.status,
      cost: node.cost,
      price: node.price ?? null,
      time: node.time,
      location: node.location,
      lock: node.lock,
      sourceStatus: node.sourceStatus,
      foreignGuestEligible: node.foreignGuestEligible,
      spoilerLevel: node.spoilerLevel,
      media: node.media ?? [],
      sourceRefs: node.sourceRefs,
      claimRefs: node.claimRefs,
      operability: node.operability,
      ...(feedback ? { visitFeedback: feedback } : {}),
      ...(evidenceSummary ? { evidenceSummary } : {}),
    };
  };
  const byDomain = Object.fromEntries(
    ["transport", "stay", "play", "food"].map((domain) => [
      domain,
      state.nodes.filter((node) => node.domain === domain).map(nodeView),
    ]),
  );
  return {
    schemaVersion: "trip-plan-view-v1",
    tripId: state.tripId,
    revision: state.revision,
    byDomain,
    budget: validateTripCoherence(state).budget,
    qa: validateTripCoherence(state),
    fulfillment: state.fulfillmentEvents,
    pendingProposals: state.pendingProposals.map((proposal) => proposalView(proposal, sharedFeedback)),
    transitSegments: state.nodes
      .filter((node) => node.domain === "transport")
      .flatMap((node) => {
        const segment = transitSegmentFromNode(node);
        return segment ? [{ nodeId: node.nodeId, segment }] : [];
      }),
    mapPreviewAvailable,
    weather: state.environment?.weather ?? null,
    mobility: state.environment?.mobility ?? null,
    readiness: readinessView(state),
    today: todayView(state, { clock }),
  };
}

function likelyIndoor(candidate) {
  return candidate?.operability?.indoorMap === true || /博物馆|美术馆|科技馆|剧院|影院|室内|商场|展览|艺术中心/.test(`${candidate?.title ?? ""} ${candidate?.summary ?? ""}`);
}

function weatherAwareCandidate(candidate, domain, weather) {
  const impact = weather?.planningImpact;
  if (!impact?.active || !impact.affectedDomains?.includes(domain)) return candidate;
  let weatherFit = "contextual";
  if (domain === "play") weatherFit = likelyIndoor(candidate) ? "preferred" : "caution";
  else if (domain === "transport") weatherFit = "caution";
  return {
    ...candidate,
    operability: {
      ...(candidate.operability ?? {}),
      weatherFit,
      weatherSeverity: impact.severity,
      weatherGuidance: impact.guidance?.[domain] ?? null,
      weatherCheckedAt: weather.checkedAt,
    },
  };
}

function applySemanticAnalysis(providerResult, analysis) {
  const partial = providerResult.partial === true || (analysis && analysis.coverage !== "complete");
  if (analysis?.judgment && analysis.judgment.mode === "auto") {
    const judgments = analysis.judgment.judgments;
    return { ...providerResult, partial, analysis, byDomain: Object.fromEntries(Object.entries(providerResult.byDomain ?? {}).map(([domain, candidates]) => [domain,
      rankDecisionCandidates(candidates, judgments).map(candidate => ({ ...candidate, operability: { ...candidate.operability, decisionJudgment: judgments.find(item => item.candidateId === candidate.candidateId) ?? null } }))])) };
  }
  if (!analysis?.lanes?.length) return { ...providerResult, partial, analysis: analysis ?? null };
  const recommended = new Set(analysis.lanes.flatMap((lane) => lane.recommendedCandidateIds ?? []));
  const rejected = new Set(analysis.lanes.flatMap((lane) => lane.rejectedCandidateIds ?? []));
  const disputed = new Set([...recommended].filter(id => rejected.has(id)));
  for (const id of disputed) { recommended.delete(id); rejected.delete(id); }
  const reasonsByCandidate = new Map();
  for (const lane of analysis.lanes) {
    for (const finding of lane.findings ?? []) {
      for (const candidateId of finding.candidateIds ?? []) {
        const current = reasonsByCandidate.get(candidateId) ?? [];
        current.push({ lane: lane.lane, reasonCode: finding.reasonCode, summary: finding.summary, evidenceRefs: finding.evidenceRefs ?? [] });
        reasonsByCandidate.set(candidateId, current);
      }
    }
  }
  const byDomain = Object.fromEntries(Object.entries(providerResult.byDomain ?? {}).map(([domain, candidates]) => [domain, [...candidates].map((candidate) => ({
    ...candidate,
    operability: {
      ...(candidate.operability ?? {}),
      semanticAnalysis: {
        recommended: recommended.has(candidate.candidateId),
        rejected: rejected.has(candidate.candidateId),
        disputed: disputed.has(candidate.candidateId),
        reasons: reasonsByCandidate.get(candidate.candidateId) ?? [],
      },
    },
  })).sort((left, right) => Number(recommended.has(right.candidateId)) - Number(recommended.has(left.candidateId)) || Number(rejected.has(left.candidateId)) - Number(rejected.has(right.candidateId)))]));
  return { ...providerResult, byDomain, partial, analysis };
}

function requiredAnalysisLanes(domains, state) {
  const lanes = [];
  if (domains.some((domain) => ["stay", "transport"].includes(domain))) lanes.push("inventory_budget");
  if (domains.some((domain) => ["food", "play"].includes(domain))) lanes.push("local_discovery");
  if (domains.length >= 2 || state.travelers.length || state.environment?.weather) lanes.push("operability_schedule");
  return [...new Set(lanes)].slice(0, 3);
}

function linkedCandidates(byDomain, weather, criteria = null) {
  return Object.fromEntries(FOUR_DOMAINS.map((domain) => {
    const candidates = [...(byDomain[domain] ?? [])].map((candidate) => weatherAwareCandidate(candidate, domain, weather));
    if (domain === "play" && weather?.planningImpact?.active) {
      candidates.sort((left, right) => Number(right.operability?.weatherFit === "preferred") - Number(left.operability?.weatherFit === "preferred"));
    }
    if (domain === "transport") {
      const ordered = [...candidates].sort((left, right) => {
        const fit = Number(right.operability?.researchFit?.score ?? 0) - Number(left.operability?.researchFit?.score ?? 0);
        if (fit) return fit;
        const availability = Number((right.operability?.availableSeats ?? -1) > 0) - Number((left.operability?.availableSeats ?? -1) > 0)
          || Number(left.operability?.availableSeats === 0) - Number(right.operability?.availableSeats === 0);
        if (availability) return availability;
        const leftCost = Number(left.cost) > 0 ? Number(left.cost) : Number.POSITIVE_INFINITY;
        const rightCost = Number(right.cost) > 0 ? Number(right.cost) : Number.POSITIVE_INFINITY;
        return leftCost - rightCost;
      });
      const intercity = ordered.filter((candidate) => candidate.operability?.mobilityRole === "intercity_inventory" || ["FLIGHT", "TRAIN"].includes(candidate.operability?.transportType));
      const executable = intercity.filter((candidate) => candidate.operability?.availableSeats !== 0 && candidate.operability?.inventoryUsability !== "unavailable");
      const highSpeedRequested = (criteria?.byDomain?.transport?.preferenceHints ?? []).includes("high_speed_train");
      const eligible = highSpeedRequested ? executable.filter((candidate) => candidate.operability?.transportType === "FLIGHT" || candidate.operability?.highSpeed === true) : executable;
      if (criteria?.intercityIntent === "flight") return [domain, eligible.filter((candidate) => candidate.operability?.transportType === "FLIGHT").slice(0, 6)];
      if (criteria?.intercityIntent === "train") return [domain, eligible.filter((candidate) => candidate.operability?.transportType === "TRAIN").slice(0, 6)];
      if (criteria?.intercityIntent === "flexible") {
        if (!eligible.length) return [domain, []];
        const representative = ["FLIGHT", "TRAIN"].flatMap((type) => eligible.find((candidate) => candidate.operability?.transportType === type) ?? []);
        return [domain, [...representative, ...eligible.filter((candidate) => !representative.includes(candidate))].filter((candidate, index, items) => items.indexOf(candidate) === index).slice(0, 6)];
      }
      const representative = ["FLIGHT", "TRAIN"].flatMap((type) => eligible.find((candidate) => candidate.operability?.transportType === type) ?? []);
      const balanced = [...representative, ...eligible.filter((candidate) => !representative.includes(candidate))]
        .filter((candidate, index, items) => items.indexOf(candidate) === index);
      return [domain, balanced.slice(0, 6)];
    }
    return [domain, candidates.slice(0, 6)];
  }));
}

function isoTripDates(value) {
  const matches = [...String(value ?? "").matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  if (!matches.length) return [];
  const start = new Date(`${matches[0]}T00:00:00.000Z`);
  const end = new Date(`${matches[1] ?? matches[0]}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates = [];
  for (let cursor = start; cursor <= end && dates.length < 60; cursor = new Date(cursor.getTime() + 86_400_000)) dates.push(cursor.toISOString().slice(0, 10));
  return dates;
}

function normalizedScheduleAt(value, fallbackDate = null) {
  const raw = String(value ?? "").trim();
  const full = raw.match(/^(20\d{2}-\d{2}-\d{2})[ T](\d{1,2}:\d{2})(?::\d{2})?/);
  if (full) return `${full[1]}T${full[2]}:00+08:00`;
  const time = raw.match(/^(\d{1,2}:\d{2})$/);
  if (time && fallbackDate) return `${fallbackDate}T${time[1]}:00+08:00`;
  return raw || null;
}

function planningWindow(candidate, domain, criteria) {
  const dates = isoTripDates(criteria?.dates);
  const firstDate = dates[0] ?? null;
  const secondDate = dates[1] ?? firstDate;
  if (domain === "transport" && candidate.operability?.mobilityRole === "intercity_inventory") {
    const startAt = normalizedScheduleAt(candidate.operability?.departureAt, firstDate) ?? (firstDate ? `${firstDate}T09:00:00+08:00` : null);
    const endAt = normalizedScheduleAt(candidate.operability?.arrivalAt, firstDate) ?? (firstDate && criteria?.arrival?.time ? `${firstDate}T${criteria.arrival.time}:00+08:00` : null);
    return { startAt, endAt, label: "出发日 · 城际抵达", basis: candidate.operability?.scheduleVerified ? "provider_schedule" : "planning_window", confirmed: false };
  }
  if (!firstDate) return null;
  if (domain === "stay") return { startAt: `${firstDate}T16:00:00+08:00`, endAt: `${firstDate}T18:00:00+08:00`, label: "第 1 天 16:00–18:00 · 抵达后入住", basis: "agent_suggested_window", confirmed: false };
  if (domain === "food") return { startAt: `${firstDate}T18:00:00+08:00`, endAt: `${firstDate}T19:30:00+08:00`, label: "第 1 天 18:00–19:30 · 晚餐", basis: "agent_suggested_window", confirmed: false };
  if (domain === "play") return { startAt: `${secondDate}T10:00:00+08:00`, endAt: `${secondDate}T12:00:00+08:00`, label: `${secondDate === firstDate ? "第 1 天" : "第 2 天"} 10:00–12:00 · 轻松体验`, basis: "agent_suggested_window", confirmed: false };
  return null;
}

function evidenceForOperations(proposal, operations) {
  const nodeIds = new Set(operations.map((operation) => operation.nodeId));
  const claims = (proposal?.evidenceBundle?.claims ?? []).filter((claim) => nodeIds.has(claim.nodeId));
  const claimEntityIds = new Set(claims.map((claim) => claim.entityId));
  const sourceIds = new Set(operations.flatMap((operation) => operation.node?.sourceRefs ?? []));
  return {
    contentItems: (proposal?.evidenceBundle?.contentItems ?? []).filter((item) => sourceIds.has(item.contentItemId)),
    entities: (proposal?.evidenceBundle?.entities ?? []).filter((entity) => claimEntityIds.has(entity.entityId)),
    claims,
  };
}

function mergeEvidenceBundles(...bundles) {
  const uniqueBy = (items, key) => [...new Map(items.map((item) => [item[key], item])).values()];
  return {
    contentItems: uniqueBy(bundles.flatMap((bundle) => bundle?.contentItems ?? []), "contentItemId"),
    entities: uniqueBy(bundles.flatMap((bundle) => bundle?.entities ?? []), "entityId"),
    claims: uniqueBy(bundles.flatMap((bundle) => bundle?.claims ?? []), "claimId"),
  };
}

function combineResearchProposal(existing, refreshed, requestedDomains, criteria) {
  if (!existing) return refreshed;
  const requested = new Set(requestedDomains);
  const retainedOperations = (existing.operations ?? []).filter((operation) => !requested.has(operation.node?.domain));
  const operations = [...retainedOperations, ...(refreshed.operations ?? [])].sort((left, right) => {
    const leftValue = left.node?.operability?.planningWindow?.startAt ?? left.node?.time ?? "";
    const rightValue = right.node?.operability?.planningWindow?.startAt ?? right.node?.time ?? "";
    return String(leftValue).localeCompare(String(rightValue));
  });
  const retainedEvidence = evidenceForOperations(existing, retainedOperations);
  const oldCriteria = existing.researchCriteria;
  return {
    ...refreshed,
    operations,
    writeSet: operations.map((operation) => operation.nodeId),
    writeContract: { allowedNodeIds: operations.map((operation) => operation.nodeId) },
    evidenceBundle: mergeEvidenceBundles(retainedEvidence, refreshed.evidenceBundle),
    researchCriteria: {
      ...criteria,
      byDomain: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, requested.has(domain) ? criteria.byDomain[domain] : (oldCriteria?.byDomain?.[domain] ?? criteria.byDomain[domain])])),
      domainFingerprints: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, requested.has(domain) ? criteria.domainFingerprints[domain] : (oldCriteria?.domainFingerprints?.[domain] ?? criteria.domainFingerprints[domain])])),
    },
  };
}

function stageUnaffectedResearchProposal(state, existing, requestedDomains, criteria, clock) {
  if (!existing) return state;
  const requested = new Set(requestedDomains);
  const operations = (existing.operations ?? []).filter((operation) => !requested.has(operation.node?.domain));
  if (!operations.length) return state;
  const writeSet = operations.map((operation) => operation.nodeId);
  const oldCriteria = existing.researchCriteria;
  const proposal = {
    ...existing,
    proposalId: `proposal_research_${randomUUID().slice(0, 8)}`,
    baseRevision: state.revision,
    summary: "原有其他旅行候选已经保留；本次调整涉及的候选未取得可靠新结果，因此没有继续显示旧匹配。",
    partial: true,
    caveats: [...new Set([...(existing.caveats ?? []), "本次调整涉及的候选暂未取得可靠新结果；未受影响的候选保持不变。"])],
    writeSet,
    writeContract: { allowedNodeIds: writeSet },
    readSet: [],
    operations,
    evidenceBundle: evidenceForOperations(existing, operations),
    researchCriteria: {
      ...criteria,
      byDomain: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, requested.has(domain) ? criteria.byDomain[domain] : (oldCriteria?.byDomain?.[domain] ?? criteria.byDomain[domain])])),
      domainFingerprints: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, requested.has(domain) ? criteria.domainFingerprints[domain] : (oldCriteria?.domainFingerprints?.[domain] ?? criteria.domainFingerprints[domain])])),
    },
  };
  delete proposal.stagedAt;
  const staged = stageTripPatch(state, proposal, { clock });
  if (staged.status !== "proposed") throw serviceError("research_preservation_failed", { reason: staged.validation?.reason, originalProposalId: existing.proposalId, requestedDomains });
  return staged.state;
}

function candidateSourceLabel(candidate, fallback = "旅行资料来源") {
  const labels = {
    amap_web_service: "高德地图",
    fliggy_flyai: "飞猪",
    tuniu_official_mcp: "途牛",
  };
  const providers = candidate?.operability?.providerSources ?? [candidate?.operability?.provider];
  const resolved = [...new Set(providers.map((provider) => labels[provider] ?? provider).filter(Boolean))];
  return resolved.length ? resolved.join("、") : fallback;
}

function conciseProviderSummary(candidate) {
  const raw = String(candidate?.summary ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "资料说明仍待补充。";
  const promotional = /必打卡|网红|震撼|超值|奢华|豪华|顶级|极致|名优|吸引着|正如|人们常说|遗憾|惬意|一览无余|尽收眼底|一生必去|不容错过|爆款|种草|宝藏/u;
  const facts = [...new Set(raw.split(/\s*[·。；;]\s*/u).map((item) => item.trim()).filter((item) => item && !promotional.test(item)))];
  const factLimit = candidate?.domain === "play" ? 3 : 5;
  return (facts.length ? facts.slice(0, factLimit).join(" · ") : raw).slice(0, 360);
}

function buildResearchProposal(state, providerResult, criteria) {
  const byDomain = linkedCandidates(providerResult.byDomain ?? {}, providerResult.weather, criteria);
  const highSpeedRequested = (criteria?.byDomain?.transport?.preferenceHints ?? []).includes("high_speed_train");
  const highSpeedReturned = byDomain.transport.some((candidate) => candidate.operability?.transportType === "TRAIN" && candidate.operability?.highSpeed === true);
  const transportNotices = [
    ...(highSpeedRequested && !highSpeedReturned ? ["本次已查询来源没有返回可核验且可用的高铁候选；这不代表市场没有车次或余票，建议在官方 12306 再核验。"] : []),
    ...((providerResult.byDomain?.transport ?? []).some((candidate) => candidate.operability?.availableSeats === 0) ? ["无票班次只作为本次库存对照，不进入可采用候选。"] : []),
  ];
  const proposalSuffix = providerResult.analysis?.runId ? String(providerResult.analysis.runId).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(-24) : randomUUID().slice(0, 8);
  const candidateEntries = FOUR_DOMAINS.flatMap((domain) => byDomain[domain].map((candidate, index) => {
    const nodeId = `${candidate.candidateId}_${proposalSuffix}_${index + 1}`.slice(0, 128);
    const evidenceItems = [
      { sourceId: candidate.sourceId, claimId: candidate.claimId, entityId: candidate.entityId, source: candidate.source, entity: candidate.entity, claim: candidate.claim },
      ...(candidate.additionalEvidence ?? []),
    ].filter((item) => item?.sourceId && item?.source && item?.entity && item?.claim)
      .filter((item, evidenceIndex, items) => items.findIndex((other) => other.sourceId === item.sourceId) === evidenceIndex)
      .map((item, evidenceIndex) => ({ ...item, proposalClaimId: `${item.claimId}_${proposalSuffix}_${index + 1}_${evidenceIndex + 1}`.slice(0, 128) }));
    return { domain, candidate, nodeId, evidenceItems, selected: false };
  }));
  const operations = candidateEntries.map((entry) => {
    const window = planningWindow(entry.candidate, entry.domain, criteria);
    return ({
    kind: "add_candidate",
    nodeId: entry.nodeId,
    node: {
      nodeId: entry.nodeId,
      domain: entry.domain,
      title: entry.candidate.title,
      summary: conciseProviderSummary(entry.candidate),
      selected: entry.selected,
      status: "candidate",
      sourceStatus: providerResult.fixtureOnly ? "contract_fixture" : "verified_provider",
      sourceRefs: entry.evidenceItems.map((item) => item.sourceId),
      claimRefs: entry.evidenceItems.map((item) => item.proposalClaimId),
      location: entry.candidate.location,
      media: entry.candidate.media ?? [],
      cost: Number(entry.candidate.cost ?? 0),
      price: entry.candidate.price ?? {
        amount: Number(entry.candidate.cost) > 0 ? Number(entry.candidate.cost) : null,
        currency: state.brief?.currency ?? "CNY",
        quality: Number(entry.candidate.cost) > 0 ? "reference" : "unknown",
        basis: entry.domain === "stay" ? "per_night_room" : entry.domain === "transport" ? "per_person_one_way" : "per_person",
        checkedAt: entry.candidate.checkedAt ?? null,
      },
      foreignGuestEligible: null,
      spoilerLevel: "low",
      impactsNodeIds: [],
      time: entry.domain === "transport" ? window?.endAt ?? null : window?.startAt ?? null,
      operability: {
        ...entry.candidate.operability,
        providerSummary: String(entry.candidate.summary ?? "").slice(0, 1_000),
        checkedAt: entry.candidate.checkedAt,
        sourceLabel: candidateSourceLabel(entry.candidate, providerResult.providerLabel),
        researchDepth: entry.candidate.operability?.researchDepth ?? "provider_search",
        ...(entry.domain === "transport" && entry.candidate.operability?.routeVerified == null ? { routeVerified: false } : {}),
        ...(window ? { planningWindow: window } : {}),
        requestedFacilityNeeds: (criteria?.travelerConstraintHints ?? []).filter((hint) => /楼梯|台阶|卫生间|无障碍|少走路/u.test(hint)),
      },
    },
  });
  });
  const contentItems = [...new Map(candidateEntries.flatMap(({ evidenceItems, candidate }) => evidenceItems.map((item) => [item.sourceId, {
    contentItemId: item.sourceId,
    provider: item.source.provider,
    sourceType: item.source.sourceType,
    providerRef: item.source.providerPoiId,
    checkedAt: item.source.checkedAt,
    documentationUrl: item.source.documentationUrl,
    independenceGroup: item.source.independenceGroup,
    commercialBias: item.source.commercialBias,
    title: candidate.title ?? null,
    originalLanguage: candidate.operability?.originalLanguage ?? "zh-CN",
    access: "public",
  }]))).values()];
  const entities = [...new Map(candidateEntries.flatMap(({ evidenceItems }) => evidenceItems.map((item) => [item.entity.entityId, item.entity]))).values()];
  const claims = candidateEntries.flatMap(({ evidenceItems, nodeId }) => evidenceItems.map((item) => ({ ...item.claim, claimId: item.proposalClaimId, nodeId })));
  const writeSet = operations.map((operation) => operation.nodeId);
  const destination = state.brief?.destination ?? providerResult.destination ?? "本次目的地";
  const weatherVerified = providerResult.weather?.status === "completed";
  return {
    schemaVersion: "trip-patch-proposal-v1",
    proposalId: providerResult.analysis?.runId ? `proposal_research_${String(providerResult.analysis.runId).replace(/[^A-Za-z0-9_.:-]/g, "_")}`.slice(0, 128) : `proposal_research_${proposalSuffix}`,
    tripId: state.tripId,
    baseRevision: state.revision,
    title: `${destination}吃住行玩候选`,
    summary: !weatherVerified
      ? "地点候选已经整理，但旅行日期对应的天气资料暂时不可用；这是一版可比较的暂定候选，不是已经排好的完整日程。"
      : providerResult.weather?.planningImpact?.active
      ? "已先根据旅行日期核验天气，再联动整理吃、住、行、玩候选；受影响的户外体验、换乘缓冲、住宿衔接和餐饮动线已标出。"
      : "已按同一目的地范围整理吃、住、行、玩候选。住宿不会被系统擅自选作锚点，你可以先比较位置、节奏和取舍，再确认每一类选择。",
    provider: providerResult.provider,
    providerLabel: providerResult.providerLabel,
    checkedAt: providerResult.checkedAt,
    sourceDocumentation: providerResult.sourceDocumentation,
    partial: providerResult.partial || !weatherVerified,
    fixtureOnly: providerResult.fixtureOnly === true,
    weatherSnapshot: providerResult.weather?.status === "completed" ? providerResult.weather : null,
    researchCriteria: criteria,
    analysis: providerResult.analysis ?? null,
    domainStatuses: providerResult.domainStatuses ?? null,
    caveats: [
      ...(providerResult.fixtureOnly ? ["这是界面与合同 QA Fixture，不代表真实 Provider 已接线。"] : []),
      ...(providerResult.caveats ?? []),
      ...transportNotices,
      ...(!weatherVerified ? ["天气尚未核验完成；户外项目、步行换乘、住宿衔接和餐饮动线都需要在取得对应日期预报后再确认。"] : []),
      ...(providerResult.weather?.planningImpact?.active ? ["当前方案已把天气作为跨吃住行玩的约束；预报更新后需要重新核验受影响部分。"] : []),
      "价格、房态、班次、排队和营业状态仍需在预订或出发前再次核验。",
      ...(providerResult.partial ? ["部分任务链暂未返回候选，接受后仍会保持为开放决定。"] : []),
    ],
    writeSet,
    writeContract: { allowedNodeIds: writeSet },
    readSet: [],
    operations,
    evidenceBundle: { contentItems, entities, claims },
  };
}

function validateRequest(operation, payload, actor = "travel_parent_agent", explicitUserConfirmation = false) {
  const validation = validateTravelMcpRequest({ operation, actor, explicitUserConfirmation, payload });
  if (!validation.ok) throw serviceError(validation.reason, validation);
}

function providerUnavailable(operation, capability) {
  return {
    schemaVersion: "travel-provider-result-v1",
    status: "provider_unavailable",
    operation,
    capability,
    reason: "no_provider_has_passed_read_only_isolated_or_official_smoke",
    fabricatedResults: false,
  };
}

function canonicalArrivalAirport(value, destination = "") {
  const raw = String(value ?? "").replace(/\s+/g, "").trim();
  if (/浦东/u.test(raw)) return "上海浦东国际机场";
  if (/虹桥/u.test(raw)) return "上海虹桥国际机场";
  if (/白云/u.test(raw)) return "广州白云国际机场";
  if (/大兴/u.test(raw)) return "北京大兴国际机场";
  if (/首都/u.test(raw)) return "北京首都国际机场";
  if (/机场$/u.test(raw)) return raw;
  return raw ? `${destination || ""}${raw}机场`.slice(0, 120) : "";
}

function placeSourceRefs(state) {
  const nodes = [
    ...state.nodes,
    ...state.pendingProposals.flatMap((proposal) => (proposal.operations ?? [])
      .filter((operation) => operation.kind === "add_candidate")
      .map((operation) => operation.node)),
  ];
  return [...new Set(nodes.flatMap((node) => Array.isArray(node?.sourceRefs) ? node.sourceRefs : []).filter(Boolean))];
}

function stayTargetAreas(state) {
  return [...new Set(state.pendingProposals.flatMap((proposal) => proposal.researchCriteria?.byDomain?.stay?.targetAreas ?? []).map(String).filter(Boolean))].slice(0, 2);
}

function mobilityTotals(mobility) {
  const recommended = (mobility?.legs ?? []).map((leg) => selectedRoute(leg)).filter(Boolean);
  return {
    legCount: recommended.length,
    totalMinutes: recommended.reduce((sum, item) => sum + Number(item.totalMinutes ?? 0), 0),
    walkingMeters: recommended.reduce((sum, item) => sum + Number(item.walkingMeters ?? 0), 0),
    transfers: recommended.reduce((sum, item) => sum + Number(item.transfers ?? 0), 0),
    estimatedFareCny: recommended.reduce((sum, item) => sum + Number(item.estimatedFareCny ?? 0), 0),
  };
}

function mobilityPlaceForNode(mobility, nodeId) {
  return (mobility?.legs ?? []).flatMap((leg) => [leg.origin, leg.destination])
    .find((place) => place?.nodeId === nodeId && Number.isFinite(place?.coordinates?.longitude) && Number.isFinite(place?.coordinates?.latitude)) ?? null;
}

function previewNodeView(node, mobility = null) {
  const mobilityPlace = mobilityPlaceForNode(mobility, node.nodeId);
  const location = mobilityPlace && !Number.isFinite(node.location?.coordinates?.longitude)
    ? { ...(node.location && typeof node.location === "object" ? node.location : {}), label: node.location?.label ?? mobilityPlace.label, coordinates: mobilityPlace.coordinates }
    : node.location ?? null;
  return {
    nodeId: node.nodeId,
    domain: node.domain,
    title: node.title,
    summary: node.summary,
    time: node.time ?? null,
    location,
    media: node.media ?? [],
    cost: Number(node.cost ?? 0),
    price: node.price ?? null,
    sourceStatus: node.sourceStatus ?? "unverified",
    operability: node.operability ?? {},
  };
}

function mobilityWithItinerary(observation, draft, options = {}) {
  observation = withScheduledRides(observation, draft.itinerary, options.selectedNodes ?? []);
  const base = normalizeTripMobility({
    ...observation,
    itinerary: draft.itinerary,
    feasibility: draft.feasibility,
    coverage: { ...(observation?.coverage ?? {}), unscheduled: !draft.itinerary },
  });
  const finalized = finalizeItinerarySchedule(draft, base, base.checkedAt, options);
  return normalizeTripMobility({
    ...base,
    itinerary: finalized.itinerary,
    feasibility: finalized.feasibility,
    coverage: { ...base.coverage, unscheduled: !finalized.itinerary },
  });
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function itineraryPlanningNodes(state) {
  const pending = state.pendingProposals.filter(proposal => !proposal.itineraryPlan).flatMap((proposal) => (proposal.operations ?? [])
    .filter((operation) => operation.kind === "add_candidate" && operation.node)
    .map((operation) => ({ ...operation.node, nodeId: operation.nodeId, selected: false })));
  return [...new Map([...state.nodes, ...pending].map((node) => [node.nodeId, node])).values()];
}

function planningStateFingerprint(state, ownRunId = null) {
  return decisionHash({
    tripId: state.tripId,
    revision: state.revision,
    brief: {
      destination: state.brief?.destination ?? null,
      dates: state.brief?.dates ?? null,
      durationDays: state.brief?.durationDays ?? null,
      origin: state.brief?.origin ?? null,
      arrivalAirport: state.brief?.arrivalAirport ?? null,
      arrivalTerminal: state.brief?.arrivalTerminal ?? null,
      arrivalTime: state.brief?.arrivalTime ?? null,
      totalBudget: state.brief?.totalBudget ?? null,
      pace: state.brief?.pace ?? null,
    },
    travelers: state.travelers.map((traveler) => ({ travelerId: traveler.travelerId, version: traveler.version ?? null, hardConstraints: traveler.hardConstraints ?? [], careNeeds: traveler.careNeeds ?? {} })),
    nodes: itineraryPlanningNodes(state).map((node) => ({ nodeId: node.nodeId, version: node.version ?? 0, selected: node.selected === true, domain: node.domain, lock: node.lock ?? null, time: node.time ?? null, sourceRefs: node.sourceRefs ?? [], price: node.price ?? node.cost, operability: node.operability })),
    proposals: state.pendingProposals.filter(proposal => !proposal.itineraryPlan).map((proposal) => ({ proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, operationNodeIds: (proposal.operations ?? []).map((operation) => operation.nodeId) })),
  });
}

function planNodeIds(plan) {
  return [...new Set(plan.days.flatMap((day) => day.stops.map((stop) => stop.nodeId)))];
}

function planSelections(state, plan) {
  const byNodeId = new Map(itineraryPlanningNodes(state).map((node) => [node.nodeId, node]));
  const selections = {};
  for (const nodeId of planNodeIds(plan)) {
    const node = byNodeId.get(nodeId);
    if (!node || node.selected === true || node.operability?.mobilityRole === "user_confirmed_arrival") continue;
    if (selections[node.domain] && selections[node.domain] !== nodeId) return null;
    selections[node.domain] = nodeId;
  }
  return selections;
}

function routeModesFromPlan(plan, itinerary) {
  const byOccurrence = new Map();
  const matchedStops = new Set();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      const itineraryStop = itinerary?.stops?.find((item) => item.nodeId === stop.nodeId && item.dayIndex === day.dayIndex && item.role === stop.role && !matchedStops.has(item.stopId));
      if (itineraryStop) {
        matchedStops.add(itineraryStop.stopId);
        if (stop.alternativeId || stop.preferredModes.length) byOccurrence.set(itineraryStop.stopId, stop.alternativeId ? [stop.alternativeId] : stop.preferredModes);
      }
    }
  }
  return byOccurrence;
}

function mobilityWithRouteModes(mobility, routeModes = {}, preferredByDestination = new Map()) {
  const next = structuredClone(mobility);
  next.legs = (next.legs ?? []).map((leg) => {
    const requested = routeModes?.[leg.legId];
    const preferences = requested ? [requested] : preferredByDestination.get(leg.destination?.stopId) ?? [];
    const selected = preferences.find((choice) => leg.alternatives?.some((alternative) => alternative.alternativeId === choice || alternative.mode === choice));
    return selectRoute(leg, selected);
  });
  return next;
}

function candidateEvidenceRefs(nodes) {
  return new Set(nodes.flatMap((node) => [
    ...(Array.isArray(node.sourceRefs) ? node.sourceRefs : []),
    ...(Array.isArray(node.operability?.evidenceRefs) ? node.operability.evidenceRefs : []),
  ]).filter(Boolean));
}

function planningProposalCarrier(state, plan, selections) {
  const pendingNodeIds = Object.values(selections);
  if (!pendingNodeIds.length) return null;
  return state.pendingProposals.find((proposal) => pendingNodeIds.every((nodeId) => (proposal.operations ?? []).some((operation) => operation.nodeId === nodeId))) ?? null;
}

function planningProposalId(runId) {
  return `itinerary_${stableHash(runId).slice(0, 24)}`;
}

export class TravelService {
  constructor({ store = createTripRepository(), clock, researchProvider = null, analysisFanout = null, analysisRunCoordinator = null, planningRunCoordinator = null, analysisDegradedReason = null } = {}) {
    this.store = store;
    this.clock = clock;
    this.researchProvider = researchProvider;
    this.analysisFanout = analysisFanout;
    this.analysisRunCoordinator = analysisRunCoordinator;
    this.planningRunCoordinator = planningRunCoordinator;
    this.analysisDegradedReason = analysisDegradedReason;
    this.mobilityPreviewCache = new Map();
  }

  providerStatus() {
    return this.researchProvider?.status === "configured" ? "configured" : "provider_unavailable";
  }

  itineraryPlanningAvailability() {
    const available = this.researchProvider?.status === "configured"
      && this.researchProvider.canPlanMobility !== false
      && typeof this.researchProvider.planMobility === "function";
    return available
      ? { status: "available" }
      : { status: "provider_unavailable", code: "route_provider_unavailable", message: "市内路线资料暂时不可用，无法核验每天的交通、步行量和衔接时间。已有候选可以继续比较；资料服务恢复后可从当前旅行继续，无需为此重新填写旅行要求。" };
  }

  async readMobilityPreview(previewId) {
    const now = new Date(this.clock?.() ?? Date.now()).getTime();
    if (this.store.getMobilityPreview) return this.store.getMobilityPreview(previewId, now);
    const cached = this.mobilityPreviewCache.get(previewId);
    return cached?.expiresAt > now ? cached : null;
  }

  async saveMobilityPreview(previewId, value) {
    const now = new Date(this.clock?.() ?? Date.now()).getTime();
    const sourceExpiry = new Date(value.preview?.mobility?.freshUntil ?? now + 900_000).getTime();
    const expiresAt = Math.min(value.expiresAt ?? now + 900_000, Number.isFinite(sourceExpiry) ? sourceExpiry : now);
    const record = { ...value, expiresAt };
    if (this.store.saveMobilityPreview) await this.store.saveMobilityPreview(previewId, record, expiresAt, now);
    this.mobilityPreviewCache.set(previewId, record);
    while (this.mobilityPreviewCache.size > 20) this.mobilityPreviewCache.delete(this.mobilityPreviewCache.keys().next().value);
  }

  async createTrip(input = {}) {
    validateRequest("create_trip", input);
    const state = createTripControlState({
      tripId: input.tripId ?? `trip_${randomUUID().slice(0, 8)}`,
      brief: input.brief ?? {},
      travelers: input.travelers ?? [],
      clock: this.clock,
    });
    if (input.ownerUserId) {
      const guest = String(input.ownerUserId).startsWith("usr_guest_");
      const nowValue = new Date(this.clock?.() ?? Date.now()).getTime();
      state.collaboration = {
        ownerUserId: input.ownerUserId,
        memberUserIds: [...new Set([input.ownerUserId, ...(Array.isArray(input.memberUserIds) ? input.memberUserIds : [])])],
        accessMode: guest ? "guest" : "account",
        guestExpiresAt: guest ? new Date(nowValue + GUEST_TRIP_TTL_MS).toISOString() : null,
      };
    }
    return controlView(await this.store.create(state), this.providerStatus());
  }

  async updateTripScope(input = {}) {
    validateRequest("update_trip_scope", input);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    this.analysisRunCoordinator?.supersedeTrip(state.tripId, "trip_scope_changed");
    this.planningRunCoordinator?.supersedeTrip(state.tripId, "trip_scope_changed");
    const next = updateTripControlScope(state, input, { clock: this.clock });
    const saved = await this.store.save(next, { expectedStorageVersion: state.storageVersion });
    return controlView(saved, this.providerStatus());
  }

  async confirmUserArrival(input = {}) {
    if (input.explicitUserConfirmation !== true) throw serviceError("user_confirmation_required");
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    this.planningRunCoordinator?.supersedeTrip(state.tripId, "arrival_anchor_changed");
    const airport = canonicalArrivalAirport(input.airport, state.brief?.destination).slice(0, 120);
    const terminal = String(input.terminal ?? "").trim().slice(0, 40);
    const time = String(input.time ?? "").trim().slice(0, 40);
    if (!airport || !time) throw serviceError("arrival_airport_and_time_required");
    const scoped = updateTripControlScope(state, {
      brief: {
        arrivalAirport: airport,
        arrivalTerminal: terminal || null,
        arrivalTime: time,
        arrivalConfirmed: true,
        intercityBooked: input.intercityBooked === true,
      },
    }, { clock: this.clock });
    const existing = scoped.nodes.find((node) => node.domain === "transport" && node.operability?.mobilityRole === "user_confirmed_arrival");
    const nodeId = existing?.nodeId ?? `transport_user_arrival_${randomUUID().slice(0, 8)}`;
    const date = isoTripDates(scoped.brief?.dates)[0] ?? null;
    const timeValue = date && /^\d{1,2}:\d{2}$/.test(time) ? `${date}T${time.padStart(5, "0")}:00+08:00` : time;
    const label = [airport, terminal].filter(Boolean).join(" ");
    const title = `已确认抵达：${label}`;
    const summary = `你已确认${date ? `${date} ` : ""}${time}抵达${label}${input.intercityBooked === true ? "，城际票已自行安排" : ""}；该节点只用于接驳，不代表库存航班。`;
    const operability = {
      mobilityRole: "user_confirmed_arrival",
      userConfirmed: true,
      userConfirmedAt: new Date(this.clock?.() ?? Date.now()).toISOString(),
      inventoryVerified: false,
      scheduleVerified: true,
      arrivalPlace: { kind: "airport", city: scoped.brief?.destination ?? null, label, terminal: terminal || null },
      arrivalRouteAnchor: { kind: "airport", city: scoped.brief?.destination ?? null, label, terminal: terminal || null, time, sourceNature: "user_confirmed_arrival" },
    };
    const operations = existing
      ? [
          { kind: "update", nodeId, changes: { title, summary, time: timeValue, location: { name: label, address: label }, operability } },
          ...(existing.selected ? [] : [{ kind: "select", nodeId }]),
        ]
      : [{ kind: "add_candidate", nodeId, node: { nodeId, domain: "transport", kind: "arrival_anchor", title, summary, selected: true, status: "selected", sourceStatus: "user_input", sourceRefs: [], claimRefs: [], travelerIds: [], impactsNodeIds: scoped.nodes.filter((node) => node.domain === "stay" && node.selected).map((node) => node.nodeId), operability, spoilerLevel: "low", time: timeValue, location: { name: label, address: label }, media: [], cost: 0, foreignGuestEligible: null } }];
    const proposal = {
      schemaVersion: "trip-patch-proposal-v1",
      proposalId: `proposal_user_arrival_${randomUUID().slice(0, 8)}`,
      tripId: scoped.tripId,
      baseRevision: scoped.revision,
      title: "确认抵达事实",
      summary,
      writeSet: [nodeId],
      writeContract: { allowedNodeIds: [nodeId] },
      readSet: existing ? [{ nodeId, version: existing.version }] : [],
      operations,
    };
    const committed = commitTripPatch(scoped, proposal, { clock: this.clock });
    if (committed.status !== "committed") return committed;
    committed.state.proposalHistory.push({ proposalId: proposal.proposalId, status: "accepted_user_arrival", decidedAt: new Date(this.clock?.() ?? Date.now()).toISOString(), revision: committed.state.revision });
    const saved = await this.store.save(committed.state, { expectedStorageVersion: state.storageVersion });
    return {
      schemaVersion: "user-arrival-confirmation-v1",
      status: "committed",
      tripId: saved.tripId,
      revision: saved.revision,
      selectedNode: { nodeId, domain: "transport", title },
      openDomains: saved.openDecisions.filter((decision) => decision.status === "open").map((decision) => decision.domain),
      pendingProposalIds: saved.pendingProposals.map((pending) => pending.proposalId),
      arrival: { airport, terminal: terminal || null, time, intercityBooked: input.intercityBooked === true },
    };
  }

  async listTrips({ userId } = {}) {
    if (typeof this.store.list !== "function") throw serviceError("trip_listing_unavailable");
    const states = await this.store.list();
    return {
      schemaVersion: "trip-list-view-v1",
      storageMode: this.store.mode ?? "unknown",
      trips: states
        .filter((state) => {
          if (userId && !state.collaboration?.memberUserIds?.includes(userId)) return false;
          if (String(userId ?? "").startsWith("usr_guest_") && state.collaboration?.guestExpiresAt && new Date(state.collaboration.guestExpiresAt).getTime() <= Date.now()) return false;
          return true;
        })
        .map((state) => ({
        tripId: state.tripId,
        revision: state.revision,
        destination: state.brief?.destination ?? null,
        dates: state.brief?.dates ?? null,
        travelerCount: state.travelers.length,
        updatedAt: state.updatedAt,
        openDecisionCount: state.openDecisions.filter((decision) => decision.status === "open").length,
        collaboration: state.collaboration ? { memberCount: state.collaboration.memberUserIds.length } : null,
        })),
    };
  }

  async getTripControlView(tripId) {
    validateRequest("get_trip_control_view", { tripId }, "mcp_client");
    return controlView(requireTrip(await this.store.get(tripId), tripId), this.providerStatus());
  }

  async getPlanningContext(tripId) {
    const state = requireTrip(await this.store.get(tripId), tripId);
    const context = continuousPlanningContext(state);
    return { ...controlView(state, this.providerStatus()), ...context };
  }

  async getTripPlanView(tripId) {
    validateRequest("get_trip_plan_view", { tripId }, "mcp_client");
    const state = requireTrip(await this.store.get(tripId), tripId);
    const at = new Date(this.clock?.() ?? Date.now()).toISOString();
    projectAdoptedPlan(state, at);
    const sourceRefs = placeSourceRefs(state);
    const sharedFeedback = typeof this.store.listSharedPlaceFeedback === "function"
      ? await this.store.listSharedPlaceFeedback(sourceRefs)
      : [];
    const view = planView(state, { mapPreviewAvailable: this.researchProvider?.canRenderMap === true, sharedFeedback, clock: this.clock });
    view.planningAvailability = this.itineraryPlanningAvailability();
    const planningProposal = state.pendingProposals.find((proposal) => proposal.itineraryPreviewId && proposal.itineraryPlan) ?? null;
    const cached = planningProposal ? await this.readMobilityPreview(planningProposal.itineraryPreviewId) : null;
    if (cached?.tripId === state.tripId && cached.revision === state.revision && (!cached.planningFingerprint || cached.planningFingerprint === planningStateFingerprint(state))) {
      view.itineraryTrial = {
        ...cached.preview,
        schemaVersion: "itinerary-planning-trial-v1",
        status: cached.trialStatus ?? (cached.preview.feasibility?.canConfirm ? "trial_ready" : "blocked"),
        issues: cached.preview.feasibility?.issues ?? [],
        runId: planningProposal.planningRunId,
        attempt: planningProposal.planningAttempt,
        proposalId: planningProposal.proposalId,
        baseRevision: state.revision,
        selections: cached.selectionValues ?? {},
        accept: cached.preview.feasibility?.canConfirm ? { proposalId: planningProposal.proposalId, selections: cached.selectionValues ?? {}, partial: Object.keys(cached.selectionValues ?? {}).length > 0, previewId: cached.preview.previewId, baseRevision: state.revision } : null,
        committed: false,
      };
    } else if (cached?.tripId === state.tripId && planningProposal) {
      // Changed evidence invalidates adoption, not the saved itinerary artifact.
      // Keep the timeline for comparison, but never present old route readings
      // or an old accept receipt as valid for the new facts.
      const issues = [{ code: "trial_dependencies_changed", severity: "blocking", resolution: "plan_change", message: "草案已保留，但旅行条件或候选资料已变化，需要重新核验后才能采用。", stopIds: [], dayIndex: null, allowedRepairDirections: ["fetch_evidence"] }];
      const feasibility = { schemaVersion: "trip-feasibility-v1", status: "needs_context", canConfirm: false, primaryBlocker: issues[0].message, issues, checkedAt: null };
      view.itineraryTrial = {
        ...cached.preview, schemaVersion: "itinerary-planning-trial-v1", status: "needs_recheck",
        runId: planningProposal.planningRunId, attempt: planningProposal.planningAttempt,
        proposalId: planningProposal.proposalId, baseRevision: state.revision, issues, feasibility,
        mobility: { ...cached.preview.mobility, status: "needs_context", checkedAt: null, freshUntil: null, legs: [], feasibility },
        impact: null, checkedAt: null, accept: null, committed: false,
      };
    } else if (planningProposal) {
      view.itineraryTrial = { schemaVersion: "itinerary-planning-trial-v1", status: "needs_recheck", runId: planningProposal.planningRunId, attempt: planningProposal.planningAttempt, proposalId: planningProposal.proposalId, baseRevision: state.revision, committed: false };
    }
    const draft = state.planning?.draft;
    if (draft && (!view.itineraryTrial?.itinerary || planNeedsRecheck(draft, at))) {
      const mobility = planMobilityProjection(draft, at);
      view.itineraryTrial = {
        schemaVersion: "itinerary-planning-trial-v1", status: "needs_recheck", tripId: state.tripId,
        planId: draft.planId, planVersion: draft.version, runId: draft.plan?.runId, attempt: draft.plan?.attempt,
        proposalId: draft.proposalId, previewId: draft.previewId, baseRevision: state.revision, selections: {},
        itinerary: draft.itinerary, mobility, feasibility: mobility.feasibility, issues: mobility.feasibility?.issues ?? [],
        planSummary: draft.plan ? { objective: draft.plan.objective, priorities: draft.plan.priorities, assumptions: draft.plan.assumptions, needsContext: draft.plan.needsContext } : null,
        selectedNodes: draft.candidates.map(node => previewNodeView(node)),
        impact: draft.lastEstimate == null ? null : { estimatedDecisionCostCny: draft.lastEstimate, estimateStatus: "previous_estimate" },
        accept: null, committed: false,
      };
    }
    view.planning = continuousPlanningContext(state);
    view.brief = state.brief;
    return view;
  }

  async updateTripReadiness({ tripId, signalId, status } = {}) {
    if (!READINESS_SIGNAL_IDS.has(signalId)) throw serviceError("invalid_readiness_signal", { signalId });
    if (!READINESS_SIGNAL_STATUSES.has(status)) throw serviceError("invalid_readiness_status", { status });
    const state = requireTrip(await this.store.get(tripId), tripId);
    const next = applyTripReadinessUpdate(state, { signalId, status }, { clock: this.clock });
    if (next.readiness.version === state.readiness.version) {
      return { schemaVersion: "trip-readiness-update-result-v1", status: "unchanged", tripId, revision: state.revision, readiness: readinessView(state) };
    }
    const saved = await this.store.save(next, { expectedStorageVersion: state.storageVersion });
    return { schemaVersion: "trip-readiness-update-result-v1", status: "updated", tripId, revision: saved.revision, readiness: readinessView(saved) };
  }

  async transferUserOwnership({ fromUserId, toUserId } = {}) {
    if (!fromUserId || !toUserId || fromUserId === toUserId) return { transferredTrips: 0 };
    if (typeof this.store.list !== "function") throw serviceError("trip_listing_unavailable");
    const states = await this.store.list();
    let transferredTrips = 0;
    for (const state of states) {
      if (!state.collaboration?.memberUserIds?.includes(fromUserId)) continue;
      const next = structuredClone(state);
      next.collaboration = {
        ownerUserId: next.collaboration.ownerUserId === fromUserId ? toUserId : next.collaboration.ownerUserId,
        memberUserIds: [...new Set(next.collaboration.memberUserIds.map((userId) => userId === fromUserId ? toUserId : userId))],
        accessMode: "account",
        guestExpiresAt: null,
      };
      next.updatedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
      next.changeJournal.push({
        changeId: `ownership_${randomUUID().slice(0, 8)}`,
        baseRevision: state.revision,
        revision: state.revision,
        event: "guest_trip_claimed",
        committedAt: next.updatedAt,
      });
      await this.store.save(next, { expectedStorageVersion: state.storageVersion });
      transferredTrips += 1;
    }
    return { transferredTrips };
  }

  async renderTripMap(tripId) {
    const state = requireTrip(await this.store.get(tripId), tripId);
    if (!this.researchProvider?.canRenderMap || typeof this.researchProvider.renderStaticMap !== "function") {
      throw serviceError("trip_map_unavailable");
    }
    const proposalNodes = state.pendingProposals.flatMap((proposal) => (proposal.operations ?? [])
      .filter((operation) => operation.kind === "add_candidate")
      .map((operation) => operation.node));
    const nodes = proposalNodes.length ? proposalNodes : state.nodes.filter((node) => node.selected);
    const points = nodes.map((node) => ({
      label: node.title,
      domain: node.domain,
      coordinates: node.location?.coordinates,
    })).filter((point) => Number.isFinite(point.coordinates?.longitude) && Number.isFinite(point.coordinates?.latitude)).slice(0, 12);
    if (!points.length) throw serviceError("trip_map_points_unavailable");
    const paths = (state.environment?.mobility?.legs ?? []).map((leg) => {
      const recommended = selectedRoute(leg);
      return recommended?.polyline ?? [];
    }).filter((path) => path.length >= 2);
    return this.researchProvider.renderStaticMap({ points, paths });
  }

  async previewTripMobility(input = {}) {
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    if (input.baseRevision != null && input.baseRevision !== state.revision) {
      return { schemaVersion: "trip-mobility-preview-v1", status: "needs_refresh", tripId: state.tripId, revision: state.revision, reason: "trip_revision_changed", fabricatedResults: false };
    }
    if (input.previewId && input.routeModes && typeof input.routeModes === "object") {
      const cached = await this.readMobilityPreview(input.previewId);
      if (!cached || cached.tripId !== state.tripId || cached.revision !== state.revision) {
        return { schemaVersion: "trip-mobility-preview-v1", status: "needs_refresh", tripId: state.tripId, revision: state.revision, reason: "itinerary_preview_stale", fabricatedResults: false };
      }
      const routed = mobilityWithRouteModes(cached.preview.mobility, input.routeModes);
      const mobility = withTripFeasibility(state, cached.preview.selectedNodes.map(node => ({ ...node, selected: true })), mobilityWithItinerary(routed, cached.sourceDraft, { selectedNodes: cached.preview.selectedNodes }));
      if (cached.requireCompletePlan && cached.itineraryPlan) {
        const issues = completeItineraryIssues(cached.itineraryPlan, state.brief, cached.planningUserRequest ?? "");
        if (issues.length) mobility.feasibility = { ...mobility.feasibility, canConfirm: false, status: "blocked", primaryBlocker: issues[0].message, issues: [...issues, ...mobility.feasibility.issues] };
      }
      const totals = mobilityTotals(mobility);
      const baselineMobility = state.environment?.mobility;
      const baselineAvailable = baselineMobility?.status === "completed" && baselineMobility?.feasibility?.canConfirm === true;
      const baseline = baselineAvailable ? mobilityTotals(baselineMobility) : null;
      const next = {
        ...cached.preview,
        status: mobility.status,
        previewId: itineraryPreviewId({ tripId: state.tripId, revision: state.revision, selections: { ...(cached.selectionValues ?? {}), routeModes: input.routeModes }, itinerary: mobility.itinerary, checkedAt: mobility.checkedAt }),
        mobility,
        itinerary: mobility.itinerary,
        feasibility: mobility.feasibility,
        routeModes: structuredClone(input.routeModes),
        impact: {
          ...cached.preview.impact,
          route: totals,
          baseline: baselineAvailable ? { kind: "confirmed_plan", route: baseline } : { kind: "none", route: null },
          deltaFromConfirmed: baseline ? {
            totalMinutes: totals.totalMinutes - baseline.totalMinutes,
            walkingMeters: totals.walkingMeters - baseline.walkingMeters,
            transfers: totals.transfers - baseline.transfers,
            estimatedFareCny: totals.estimatedFareCny - baseline.estimatedFareCny,
          } : null,
        },
      };
      await this.saveMobilityPreview(next.previewId, { ...cached, preview: next, routeModes: structuredClone(input.routeModes) });
      return next;
    }
    const itineraryPlan = input.itineraryPlan ? assertSchema(ItineraryPlanSchema, input.itineraryPlan, "invalid_itinerary_plan") : null;
    const knownNodes = itineraryPlanningNodes(state);
    const selections = itineraryPlan
      ? (planSelections(state, itineraryPlan) ?? {})
      : input.selections && typeof input.selections === "object" && !Array.isArray(input.selections) ? input.selections : {};
    const chosen = [];
    if (itineraryPlan) {
      for (const nodeId of planNodeIds(itineraryPlan)) {
        const node = knownNodes.find((candidate) => candidate.nodeId === nodeId);
        if (!node) throw serviceError("itinerary_plan_node_not_found", { nodeId });
        chosen.push({ ...structuredClone(node), selected: true });
      }
    } else {
      const confirmedArrival = state.nodes.find((node) => node.selected && node.domain === "transport" && node.operability?.mobilityRole === "user_confirmed_arrival");
      if (confirmedArrival) chosen.push(confirmedArrival);
      for (const domain of FOUR_DOMAINS) {
        if (domain === "transport" && confirmedArrival) continue;
        const selectedNodeId = selections[domain];
        if (selectedNodeId) {
          const node = knownNodes.find((candidate) => candidate.nodeId === selectedNodeId && candidate.domain === domain);
          if (!node) throw serviceError("preview_candidate_not_found", { domain, nodeId: selectedNodeId });
          chosen.push({ ...structuredClone(node), selected: true });
          continue;
        }
        chosen.push(...state.nodes.filter((node) => node.selected && node.domain === domain));
      }
    }
    const selectedNodes = [...new Map(chosen.map((node) => [node.nodeId, { ...node, selected: true }])).values()];
    const itineraryDraft = itineraryPlan
      ? itineraryPlanToDraft(itineraryPlan, state.brief, selectedNodes)
      : buildItineraryDraft(state.brief, selectedNodes);
    let observation;
    if (selectedNodes.length < 2) {
      observation = { schemaVersion: "trip-mobility-v1", status: "needs_context", destination: state.brief?.destination ?? null, source: "amap_routes_v5", reason: "select_arrival_and_at_least_one_place", fabricatedResults: false };
    } else if (!this.researchProvider || this.researchProvider.canPlanMobility === false || typeof this.researchProvider.planMobility !== "function") {
      observation = { schemaVersion: "trip-mobility-v1", status: "provider_unavailable", destination: state.brief?.destination ?? null, source: "amap_routes_v5", reason: "amap_routes_provider_not_configured", fabricatedResults: false };
    } else {
      try {
        observation = await this.researchProvider.planMobility({ tripId: state.tripId, brief: state.brief, travelers: state.travelers, selectedNodes, itineraryStops: itineraryDraft.itinerary?.stops ?? [], targetAreas: stayTargetAreas(state), signal: input.signal ?? null });
      } catch (error) {
        observation = { schemaVersion: "trip-mobility-v1", status: "provider_unavailable", destination: state.brief?.destination ?? null, source: "amap_routes_v5", reason: error?.code ?? "SOURCE_UNAVAILABLE", fabricatedResults: false };
      }
    }
    const preferredModes = itineraryPlan && itineraryDraft.itinerary ? routeModesFromPlan(itineraryPlan, itineraryDraft.itinerary) : new Map();
    const mobility = withTripFeasibility(state, selectedNodes, mobilityWithItinerary(mobilityWithRouteModes(observation, {}, preferredModes), itineraryDraft, { selectedNodes }));
    const itineraryOrder = new Map((mobility.itinerary?.stops ?? []).map((stop, index) => [stop.nodeId, index]));
    const nodesBySchedule = [...selectedNodes].sort((left, right) => {
      const order = (itineraryOrder.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) - (itineraryOrder.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER);
      if (order) return order;
      const leftValue = new Date(nodeScheduleValue(left) ?? 0).getTime();
      const rightValue = new Date(nodeScheduleValue(right) ?? 0).getTime();
      return (Number.isFinite(leftValue) ? leftValue : Number.MAX_SAFE_INTEGER) - (Number.isFinite(rightValue) ? rightValue : Number.MAX_SAFE_INTEGER);
    });
    const totals = mobilityTotals(mobility);
    const baselineMobility = state.environment?.mobility;
    const baselineAvailable = baselineMobility?.status === "completed" && baselineMobility?.feasibility?.canConfirm === true;
    const baseline = baselineAvailable ? mobilityTotals(baselineMobility) : null;
    const previewBudget = estimateTripBudget({ ...state, nodes: selectedNodes, pendingProposals: [], environment: { ...state.environment, mobility } });
    const baselineBudget = estimateTripBudget(state);
    const weather = state.environment?.weather ?? null;
    const previewResult = {
      schemaVersion: "trip-mobility-preview-v1",
      status: mobility.status,
      tripId: state.tripId,
      revision: state.revision,
      committed: false,
      previewId: itineraryPreviewId({ tripId: state.tripId, revision: state.revision, selections, itinerary: mobility.itinerary, checkedAt: mobility.checkedAt }),
      planningSource: itineraryPlan ? "model_plan" : "conservative_fallback",
      planSummary: itineraryPlan ? {
        objective: itineraryPlan.objective,
        priorities: itineraryPlan.priorities,
        assumptions: itineraryPlan.assumptions,
        needsContext: itineraryPlan.needsContext,
        stopRationales: itineraryPlan.days.flatMap((day) => day.stops.map((stop) => ({ nodeId: stop.nodeId, dayIndex: day.dayIndex, role: stop.role, rationale: stop.rationale }))),
      } : null,
      selectedNodes: nodesBySchedule.map((node) => previewNodeView(node, mobility)),
      mobility,
      itinerary: mobility.itinerary,
      feasibility: mobility.feasibility,
      impact: {
        stopCount: selectedNodes.length,
        estimatedDecisionCostCny: previewBudget.estimated,
        budget: previewBudget,
        budgetDelta: {
          committed: previewBudget.committed - baselineBudget.committed,
          estimated: previewBudget.estimated - baselineBudget.estimated,
          exceedsBudget: previewBudget.exceedsBudget,
        },
        route: totals,
        baseline: baselineAvailable ? { kind: "confirmed_plan", route: baseline } : { kind: "none", route: null },
        deltaFromConfirmed: baseline ? {
          totalMinutes: totals.totalMinutes - baseline.totalMinutes,
          walkingMeters: totals.walkingMeters - baseline.walkingMeters,
          transfers: totals.transfers - baseline.transfers,
          estimatedFareCny: totals.estimatedFareCny - baseline.estimatedFareCny,
        } : null,
        weather: weather ? {
          status: weather.status,
          coverage: weather.coverage,
          checkedAt: weather.checkedAt ?? null,
          forecastDays: (weather.forecastDays ?? []).filter((day) => (weather.tripDates ?? []).includes(day.date)).slice(0, 5),
          guidance: weather.planningImpact?.guidance ?? {},
          affectedDomains: weather.planningImpact?.affectedDomains ?? [],
          severity: weather.planningImpact?.severity ?? "none",
        } : null,
        stayAnchorFits: mobility.travelerFit?.stayAnchorFits ?? [],
      },
      caveats: [
        "这是试选路线，不会修改已确认行程。",
        ...(!itineraryPlan && selectedNodes.length > 2 ? ["当前按保守顺序快速连线，用于比较候选；只有运行 AI 规划并通过路线核验后，才能称为优化站序。"] : []),
        ...(mobility.caveats ?? []),
      ],
      fabricatedResults: false,
    };
    await this.saveMobilityPreview(previewResult.previewId, {
      tripId: state.tripId,
      revision: state.revision,
      selections: JSON.stringify(Object.entries(selections).sort(([left], [right]) => left.localeCompare(right))),
      selectionValues: structuredClone(selections),
      sourceDraft: itineraryDraft,
      itineraryPlan: itineraryPlan ? structuredClone(itineraryPlan) : null,
      preview: previewResult,
      routeModes: {},
    });
    return previewResult;
  }

  // Keep work visible even when it is not adoptable. The same proposal and
  // preview repositories own both partial and checked drafts; no second state.
  async stageItineraryTrial(state, plan, preview, { status, requireCompletePlan, userRequest, inputFingerprint, providerCallCount }) {
    // An itinerary's full visit set is the selection. The comparison dictionary
    // cannot express two meals and must not deselect a retained lunch on adopt.
    const selections = {};
    const proposalId = planningProposalId(plan.runId);
    const proposal = { ...itinerarySelectionProposal(state, plan, proposalId, { replaceSelected: requireCompletePlan }), itineraryPreviewId: preview.previewId, requireCompletePlan, planningUserRequest: userRequest };
    const withoutPrevious = { ...state, pendingProposals: state.pendingProposals.filter(item => !item.itineraryPlan) };
    const staged = stageTripPatch(withoutPrevious, proposal, { clock: this.clock });
    if (staged.status !== "proposed") throw serviceError(staged.validation?.reason ?? "itinerary_trial_proposal_rejected");
    const pendingState = staged.state;
    saveWorkingPlan(pendingState, { plan, itinerary: preview.itinerary, mobility: preview.mobility, proposalId, previewId: preview.previewId,
      requireCompletePlan, userRequest, estimatedCost: preview.impact?.estimatedDecisionCostCny }, new Date(this.clock?.() ?? Date.now()).toISOString());
    const savedState = { activeDraftCount: 1, replacesEarlierTrial: true, adoptedNodeCount: state.nodes.filter(node => node.selected).length, adoptedTimelineAvailable: !!state.environment?.mobility?.itinerary, adoptedRouteStatus: state.environment?.mobility?.status ?? "not_checked" };
    const cached = await this.readMobilityPreview(preview.previewId);
    if (cached) await this.saveMobilityPreview(preview.previewId, { ...cached, selections: "[]", selectionValues: selections, preview: { ...preview, savedState }, proposalId, planningRunId: plan.runId, trialStatus: status, requireCompletePlan, planningUserRequest: userRequest, planningFingerprint: planningStateFingerprint(state) });
    const payload = {
      ...preview, schemaVersion: "itinerary-planning-trial-v1", status, operationId: `${plan.runId}:${plan.attempt}`,
      runId: plan.runId, tripId: state.tripId, baseRevision: state.revision, attempt: plan.attempt,
      proposalId, selections, savedState, issues: preview.feasibility?.issues ?? [],
      accept: status === "trial_ready" ? { proposalId, selections, partial: false, previewId: preview.previewId, baseRevision: state.revision } : null,
      committed: false, checkedAt: preview.mobility?.checkedAt ?? null, providerCallCount,
    };
    pendingState.changeJournal.push({ event: "itinerary_trial_saved", operationId: payload.operationId, inputFingerprint,
      dependencyFingerprint: planningStateFingerprint(pendingState), result: payload });
    // Artifact and business receipt are one optimistic/fenced write. The
    // disposable preview cache is never the only copy of the user's draft.
    await this.store.save(pendingState, { expectedStorageVersion: state.storageVersion });
    return payload;
  }

  async planItineraryTrial(input = {}) {
    input.signal?.throwIfAborted();
    if (!this.planningRunCoordinator) throw serviceError("itinerary_planning_runtime_unavailable");
    const submitted = assertSchema(input.plan?.schemaVersion === "itinerary-edit-v1" ? ItineraryEditSchema : ItineraryPlanSchema, input.plan, "invalid_itinerary_plan");
    const state = requireTrip(await this.store.get(submitted.tripId), submitted.tripId);
    const operationId = `${submitted.runId}:${submitted.attempt}`;
    const planFingerprint = planningHash(submitted);
    const savedReceipt = state.changeJournal.find(entry => entry.event === "itinerary_trial_saved" && entry.operationId === operationId);
    if (savedReceipt && savedReceipt.dependencyFingerprint === planningStateFingerprint(state)) {
      if (savedReceipt.inputFingerprint !== planFingerprint) throw serviceError("itinerary_planning_attempt_identity_conflict");
      return structuredClone(savedReceipt.result);
    }
    const resolved = submitted.schemaVersion === "itinerary-edit-v1" ? editSavedPlan(state, submitted) : submitted;
    const plan = stablePlanVisits(resolved, state.planning?.draft ?? state.planning?.adopted);
    const requireCompletePlan = input.requireCompletePlan === true || plan.scope === "complete_trip";
    if (plan.tripId !== input.tripId || plan.baseRevision !== state.revision) {
      return { schemaVersion: "itinerary-planning-trial-v1", status: "stale_discarded", operationId, runId: plan.runId, tripId: state.tripId, baseRevision: plan.baseRevision, currentRevision: state.revision, attempt: plan.attempt, committed: false };
    }
    const availability = this.itineraryPlanningAvailability();
    const criteriaFingerprint = planningStateFingerprint(state, plan.runId);
    const inputValidation = itineraryInputValidation(state, plan, itineraryPlanningNodes(state));
    if (inputValidation.issues.length) throw serviceError("invalid_itinerary_plan_references", { ...inputValidation, attempt: plan.attempt, instruction: "Correct the arguments and retry the same attempt. No route call or business repair was consumed. Keep the user constraints unchanged." });
    const coordinatorId = `${plan.runId}:${plan.attempt}:${criteriaFingerprint.slice(0, 12)}`;
    const run = this.planningRunCoordinator.begin({
      runId: coordinatorId,
      tripId: state.tripId,
      baseRevision: state.revision,
      criteriaFingerprint,
      requiredLanes: ["itinerary_plan"],
      scopeFingerprint: decisionHash({ brief: state.brief, travelers: state.travelers, nodes: state.nodes }),
      deadlineAt: new Date(Date.now() + 90_000).toISOString(),
    });
    if (!this.planningRunCoordinator.isCurrent({ runId: coordinatorId, tripId: state.tripId, baseRevision: state.revision, criteriaFingerprint })) {
      return { schemaVersion: "itinerary-planning-trial-v1", status: "stale_discarded", operationId, runId: plan.runId, tripId: state.tripId, baseRevision: state.revision, attempt: plan.attempt, committed: false };
    }
    const startedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    this.planningRunCoordinator.recordLaneStarted(coordinatorId, { lane: "itinerary_plan", attempt: plan.attempt, queuedAt: startedAt, startedAt });
    let payload;
    let terminal = false;
    try {
      const completenessIssues = requireCompletePlan ? completeItineraryIssues(plan, state.brief, input.userRequest) : [];
      {
        const combinedSignal = input.signal ? AbortSignal.any([run.abortController.signal, input.signal]) : run.abortController.signal;
        let preview = await this.previewTripMobility({ tripId: state.tripId, baseRevision: state.revision, itineraryPlan: plan, signal: combinedSignal });
        combinedSignal.throwIfAborted();
        const checkIssues = [...completenessIssues, ...(availability.status === "available" ? [] : [{ code: availability.code, severity: "blocking", message: availability.message, stopIds: [], dayIndex: null, allowedRepairDirections: [] }]), ...(preview.feasibility?.issues ?? [])];
        const firstBlocker = checkIssues.find(issue => issue.severity === "blocking");
        preview.feasibility = { ...preview.feasibility, issues: checkIssues, ...(firstBlocker ? { canConfirm: false, status: "blocked", primaryBlocker: firstBlocker.message } : {}) };
        preview.mobility = { ...preview.mobility, feasibility: preview.feasibility };
        const baselinePreview = input.baselinePreviewId ? await this.readMobilityPreview(input.baselinePreviewId) : null;
        if (baselinePreview?.tripId === state.tripId && baselinePreview.revision === state.revision && baselinePreview.preview?.mobility) {
          const baselineRoute = mobilityTotals(baselinePreview.preview.mobility);
          const route = mobilityTotals(preview.mobility);
          preview = {
            ...preview,
            impact: {
              ...preview.impact,
              baseline: { kind: "current_trial", route: baselineRoute },
              deltaFromConfirmed: {
                totalMinutes: route.totalMinutes - baselineRoute.totalMinutes,
                walkingMeters: route.walkingMeters - baselineRoute.walkingMeters,
                transfers: route.transfers - baselineRoute.transfers,
                estimatedFareCny: route.estimatedFareCny - baselineRoute.estimatedFareCny,
              },
            },
          };
          const cachedPlanned = await this.readMobilityPreview(preview.previewId);
          if (cachedPlanned) await this.saveMobilityPreview(preview.previewId, { ...cachedPlanned, preview });
        }
        const latest = requireTrip(await this.store.get(state.tripId), state.tripId);
        if (!this.planningRunCoordinator.isCurrent({ runId: coordinatorId, tripId: state.tripId, baseRevision: state.revision, criteriaFingerprint })
          || latest.revision !== state.revision
          || planningStateFingerprint(latest, plan.runId) !== criteriaFingerprint) {
          this.planningRunCoordinator.markStale(coordinatorId, "stale_discarded");
          payload = { schemaVersion: "itinerary-planning-trial-v1", status: "stale_discarded", operationId, runId: plan.runId, tripId: state.tripId, baseRevision: state.revision, currentRevision: latest.revision, attempt: plan.attempt, committed: false };
          payload.providerCallCount = 1;
          terminal = true;
        } else {
          const issues = preview.feasibility?.issues ?? [];
          const repairable = availability.status === "available" && issues.some(issue => (issue.allowedRepairDirections ?? []).length > 0);
          const ready = preview.feasibility?.canConfirm === true;
          const status = ready ? "trial_ready" : plan.attempt === 1 && repairable ? "needs_repair" : "blocked";
          payload = await this.stageItineraryTrial(latest, plan, preview, { status, requireCompletePlan, userRequest: input.userRequest ?? "",
            inputFingerprint: planFingerprint, providerCallCount: availability.status === "available" ? 1 : 0 });
          terminal = ready || plan.attempt === 2 || !repairable;
        }
      }
    } catch (error) {
      const stale = input.signal?.aborted || run.abortController.signal.aborted || error?.code === "itinerary_preview_stale";
      payload = { schemaVersion: "itinerary-planning-trial-v1", status: stale ? "stale_discarded" : plan.attempt === 1 ? "needs_repair" : "blocked", operationId, runId: plan.runId, tripId: state.tripId, baseRevision: state.revision, attempt: plan.attempt, issues: [{ code: error?.code ?? "itinerary_planning_failed", severity: "blocking", message: stale ? "旅行条件已经变化，这份旧试排不会继续使用。" : "这次没有完成路线核验，当前方案保持不变。", stopIds: [], dayIndex: null, allowedRepairDirections: stale ? [] : ["request_context"] }], committed: false, checkedAt: null };
      terminal = stale || plan.attempt === 2;
    }
    const completedAt = new Date(this.clock?.() ?? Date.now()).toISOString();
    if (payload.providerCallCount == null) payload.providerCallCount = 0;
    this.planningRunCoordinator.recordLaneCompletion(coordinatorId, { lane: "itinerary_plan", attempt: plan.attempt, completedAt, status: payload.status, result: { planFingerprint, payload } });
    if (terminal) {
      const acquired = this.planningRunCoordinator.tryJoin(coordinatorId);
      if (acquired.acquired) this.planningRunCoordinator.completeJoin(coordinatorId, { joinArtifactId: `join_${plan.runId}`, operationId, status: payload.status, completedAt });
    }
    return payload;
  }

  async refreshTripMobility(input) {
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    const selectedNodes = state.nodes.filter((node) => node.selected);
    const adopted = state.planning?.adopted;
    const itineraryDraft = adopted?.itinerary ? { itinerary: structuredClone(adopted.itinerary), feasibility: adopted.validation.feasibility } : buildItineraryDraft(state.brief, selectedNodes);
    let observation;
    if (!this.researchProvider || this.researchProvider.canPlanMobility === false || typeof this.researchProvider.planMobility !== "function") {
      observation = {
        schemaVersion: "trip-mobility-v1",
        status: "provider_unavailable",
        destination: state.brief?.destination ?? null,
        source: "amap_routes_v5",
        reason: "amap_routes_provider_not_configured",
        fabricatedResults: false,
      };
    } else {
      try {
        observation = await this.researchProvider.planMobility({
          tripId: state.tripId,
          brief: state.brief,
          travelers: state.travelers,
          selectedNodes,
          itineraryStops: itineraryDraft.itinerary?.stops ?? [],
          targetAreas: stayTargetAreas(state),
        });
      } catch (error) {
        observation = {
          schemaVersion: "trip-mobility-v1",
          status: "provider_unavailable",
          destination: state.brief?.destination ?? null,
          source: "amap_routes_v5",
          reason: error?.code ?? "SOURCE_UNAVAILABLE",
          fabricatedResults: false,
        };
      }
    }
    const normalized = mobilityWithItinerary({
      ...observation,
      status: ["completed", "partial", "needs_context", "provider_unavailable"].includes(observation?.status) ? observation.status : "provider_unavailable",
      reason: ["completed", "partial"].includes(observation?.status) ? observation.reason : observation?.reason ?? observation?.status ?? "SOURCE_UNAVAILABLE",
    }, itineraryDraft, { preserveSchedule: Boolean(adopted), selectedNodes });
    const next = applyMobilityObservation(state, normalized, { clock: this.clock });
    const saved = await this.store.save(next, { expectedStorageVersion: state.storageVersion });
    return {
      schemaVersion: "trip-mobility-refresh-result-v1",
      status: normalized.status,
      tripId: saved.tripId,
      revision: saved.revision,
      mobility: saved.environment?.mobility ?? normalized,
      qa: validateTripCoherence(saved),
      fabricatedResults: false,
    };
  }

  async getOpenDecisions(tripId) {
    validateRequest("get_open_decisions", { tripId }, "mcp_client");
    const state = requireTrip(await this.store.get(tripId), tripId);
    return { schemaVersion: "open-decisions-v1", tripId, revision: state.revision, decisions: state.openDecisions.filter((decision) => decision.status === "open"), pendingProposals: state.pendingProposals };
  }

  async compareTripCandidates({ tripId, objective, signal }) {
    if (this.judgment?.mode !== "auto") return null;
    const state = requireTrip(await this.store.get(tripId), tripId);
    const proposal = state.pendingProposals.find(item => String(item.proposalId).startsWith("proposal_research_") && !item.itineraryPlan);
    // Only a fresh, unconfirmed comparison can finish without a planning turn.
    if (!proposal || state.environment?.mobility?.itinerary || !proposal.checkedAt || Date.now() - Date.parse(proposal.checkedAt) > 60_000) return null;
    const view = proposalView(proposal);
    const byDomain = Object.fromEntries(Object.entries(view.byDomain).map(([domain, candidates]) => [domain, candidates.map(candidate => ({ ...candidate, candidateId: candidate.nodeId, evidenceRefs: [...(candidate.sourceRefs ?? []), ...(candidate.claimRefs ?? [])] }))]));
    const snapshot = buildJudgmentSnapshot({ tripId, baseRevision: state.revision, criteriaFingerprint: decisionHash(proposal.researchCriteria ?? proposal.proposalId), objective, planningContext: continuousPlanningContext(state), brief: state.brief, travelers: state.travelers, locks: state.nodes.filter(node => node.lock).map(node => node.nodeId), providerResult: { byDomain, weather: state.environment?.weather } });
    const previous = proposal.comparison?.judgment;
    const cached = previous?.snapshotHash === this.judgment.snapshotHash(snapshot)
      && previous.status === "evaluated" && Date.now() - Date.parse(previous.checkedAt) < 60_000;
    const judgment = cached ? previous : await this.judgment.evaluate(snapshot);
    if (!judgment.automatic || judgment.scope !== "compare") return null;
    signal?.throwIfAborted();
    const current = requireTrip(await this.store.get(tripId), tripId);
    if (current.revision !== state.revision || current.storageVersion !== state.storageVersion) return null;
    const ordered = rankDecisionCandidates(proposal.operations.filter(op => op.node).map(op => ({ ...op, candidateId: op.nodeId })), judgment.judgments);
    const ranks = new Map(ordered.map((op, index) => [op.nodeId, index]));
    const updated = { ...proposal, comparison: { objective, judgment, previousOrder: proposal.operations.map(op => op.nodeId), checkedAt: new Date().toISOString() },
      operations: [...proposal.operations].sort((a, b) => a.node?.domain === b.node?.domain ? (ranks.get(a.nodeId) ?? 0) - (ranks.get(b.nodeId) ?? 0) : 0) };
    const saved = await this.store.save({ ...state, pendingProposals: state.pendingProposals.map(item => item.proposalId === proposal.proposalId ? updated : item) }, { expectedStorageVersion: state.storageVersion });
    return { status: "compared", tripId, revision: saved.revision, proposalId: proposal.proposalId, judgment, nextAction: "review_comparison" };
  }

  async researchTripOptions(input) {
    input.signal?.throwIfAborted();
    validateRequest("research_trip_options", input);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    input.signal?.throwIfAborted();
    this.planningRunCoordinator?.supersedeTrip(state.tripId, "candidate_set_changed");
    const rawRequestedDomains = Array.isArray(input.domains) && input.domains.length ? input.domains : FOUR_DOMAINS;
    const hasConfirmedBookedArrival = state.brief?.intercityBooked === true
      && state.nodes.some((node) => node.selected && node.domain === "transport" && node.operability?.mobilityRole === "user_confirmed_arrival");
    const requestedDomains = hasConfirmedBookedArrival ? rawRequestedDomains.filter((domain) => domain !== "transport") : rawRequestedDomains;
    if (!requestedDomains.length) {
      return {
        schemaVersion: "travel-provider-result-v1",
        status: "EMPTY_VERIFIED",
        operation: "research_trip_options",
        capability: input.capability ?? "travel_research",
        tripId: state.tripId,
        revision: state.revision,
        requestedDomains: [],
        excludedDomains: ["transport"],
        reason: "user_confirmed_intercity_arrival_already_selected",
        fabricatedResults: false,
      };
    }
    const criteria = buildTravelResearchCriteria({
      brief: state.brief,
      travelers: state.travelers,
      question: input.question ?? input.query ?? "",
      criteria: input.criteria ?? {},
      domains: requestedDomains,
    });
    const existingResearchProposal = state.pendingProposals.find((proposal) => String(proposal.proposalId).startsWith("proposal_research_"));
    const existingProposalView = existingResearchProposal ? proposalView(existingResearchProposal) : null;
    const existingProposalCoversRequest = existingProposalView
      && requestedDomains.every((domain) => existingProposalView.byDomain[domain]?.length > 0)
      && (!this.analysisFanout || existingResearchProposal.analysis?.coverage === "complete")
      && researchCriteriaMatchesProposal(existingResearchProposal, criteria, requestedDomains);
    if (existingProposalCoversRequest) {
      const existingView = existingProposalView;
      return {
        schemaVersion: "travel-research-proposal-result-v1",
        status: "proposed",
        tripId: state.tripId,
        revision: state.revision,
        proposal: existingView,
        candidateCounts: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, existingView.byDomain[domain].length])),
        provider: existingResearchProposal.provider ?? null,
        providerLabel: existingResearchProposal.providerLabel ?? null,
        checkedAt: existingResearchProposal.checkedAt ?? null,
        partial: existingResearchProposal.partial === true,
        fixtureOnly: existingResearchProposal.fixtureOnly === true,
        analysis: existingResearchProposal.analysis ?? null,
        reusedPendingProposal: true,
        requestedDomains,
        researchCriteriaFingerprint: criteria.fingerprint,
        fabricatedResults: false,
      };
    }
    if (!this.researchProvider) {
      if (existingResearchProposal && !researchCriteriaMatchesProposal(existingResearchProposal, criteria, requestedDomains)) {
        const superseded = supersedeStagedTripPatch(state, existingResearchProposal.proposalId, "research_criteria_changed", { clock: this.clock });
        const retained = stageUnaffectedResearchProposal(superseded, existingResearchProposal, requestedDomains, criteria, this.clock);
        const saved = await this.store.save(retained, { expectedStorageVersion: state.storageVersion });
        return { ...providerUnavailable("research_trip_options", input.capability ?? "travel_research"), tripId: saved.tripId, revision: saved.revision, requestedDomains, staleProposalRemoved: true, researchCriteriaFingerprint: criteria.fingerprint };
      }
      return { ...providerUnavailable("research_trip_options", input.capability ?? "travel_research"), tripId: state.tripId, revision: state.revision, requestedDomains, researchCriteriaFingerprint: criteria.fingerprint };
    }
    const potentialRequiredLanes = requiredAnalysisLanes(requestedDomains, state);
    const requiredLanes = this.analysisFanout ? potentialRequiredLanes : [];
    const execution = currentTravelExecution();
    const researchIdentity = { tripId: state.tripId, revision: state.revision, criteria: criteria.fingerprint, requestedDomains, question: input.question ?? input.query ?? "" };
    const analysisRunId = requiredLanes.length > 0 ? `analysis_run_${execution ? decisionHash([execution.runId, researchIdentity]).slice(0, 24) : randomUUID().slice(0, 8)}` : null;
    const analysisRun = analysisRunId ? this.analysisRunCoordinator?.begin({
      runId: analysisRunId,
      tripId: state.tripId,
      baseRevision: state.revision,
      criteriaFingerprint: criteria.fingerprint,
      requiredLanes,
      deadlineAt: new Date(execution?.deadlineAt ?? Date.now() + 90_000).toISOString(),
    }) : null;
    let providerResult;
    try {
      const prepare = () => this.researchProvider.research({
        tripId: state.tripId,
        brief: state.brief,
        travelers: state.travelers,
        domains: requestedDomains,
        question: input.question ?? input.query ?? "",
        criteria,
        existingWeather: state.environment?.weather ?? null,
        signal: input.signal,
      });
      providerResult = execution?.readStep ? await execution.readStep(`research_${decisionHash(researchIdentity)}`, researchIdentity, prepare) : await prepare();
    } catch (error) {
      if (analysisRunId) this.analysisRunCoordinator?.markStale(analysisRunId, "provider_failed");
      input.signal?.throwIfAborted();
      return {
        schemaVersion: "travel-provider-result-v1",
        status: error?.code ?? "SOURCE_UNAVAILABLE",
        operation: "research_trip_options",
        capability: input.capability ?? "travel_research",
        tripId: state.tripId,
        revision: state.revision,
        requestedDomains,
        reason: error?.code ?? "SOURCE_UNAVAILABLE",
        fabricatedResults: false,
      };
    }
    input.signal?.throwIfAborted();
    if (providerResult.status !== "completed") {
      if (analysisRunId) this.analysisRunCoordinator?.markStale(analysisRunId, `provider_${providerResult.status}`);
      if (existingResearchProposal && !researchCriteriaMatchesProposal(existingResearchProposal, criteria, requestedDomains)) {
        const superseded = supersedeStagedTripPatch(state, existingResearchProposal.proposalId, "research_criteria_changed", { clock: this.clock });
        const retained = stageUnaffectedResearchProposal(superseded, existingResearchProposal, requestedDomains, criteria, this.clock);
        const saved = await this.store.save(retained, { expectedStorageVersion: state.storageVersion });
        return { ...providerResult, operation: "research_trip_options", capability: input.capability ?? "travel_research", tripId: saved.tripId, revision: saved.revision, requestedDomains, staleProposalRemoved: true, researchCriteriaFingerprint: criteria.fingerprint };
      }
      return { ...providerResult, operation: "research_trip_options", capability: input.capability ?? "travel_research", tripId: state.tripId, revision: state.revision, requestedDomains, researchCriteriaFingerprint: criteria.fingerprint };
    }
    let semanticAnalysis = null;
    if (!this.analysisFanout && this.analysisDegradedReason && potentialRequiredLanes.length) {
      const now = new Date(this.clock?.() ?? Date.now()).toISOString();
      const blockedRunId = `analysis_blocked_${criteria.fingerprint.slice(0, 16)}`;
      semanticAnalysis = {
        schemaVersion: "travel-analysis-fanout-v1",
        analysisId: `analysis_${blockedRunId}`,
        runId: blockedRunId,
        tripId: state.tripId,
        baseRevision: state.revision,
        criteriaFingerprint: criteria.fingerprint,
        status: "failed",
        engine: "dynamic_workflow",
        lanes: [],
        requiredLanes: potentialRequiredLanes,
        startedLanes: [],
        completedLanes: [],
        failedLanes: potentialRequiredLanes,
        timedOutLanes: [],
        coverage: "failed",
        degradedReasons: [this.analysisDegradedReason],
        joinCount: 0,
        joinArtifactId: null,
        taskCount: 0,
        childConcurrency: 1,
        modelFallback: { primaryStatus: "not_started", fallbackStatus: "not_started", fallbackModel: null },
        startedAt: now,
        completedAt: now,
        deadlineAt: now,
        conditionRevision: { status: "not_needed", reasonCodes: ["analysis_execution_unavailable"] },
        events: [],
      };
    }
    if (this.analysisFanout && analysisRunId) {
      const currentBeforeAnalysis = await this.store.get(state.tripId);
      if (currentBeforeAnalysis?.revision !== state.revision || this.analysisRunCoordinator?.isCurrent({ runId: analysisRunId, tripId: state.tripId, baseRevision: state.revision, criteriaFingerprint: criteria.fingerprint }) === false) {
        this.analysisRunCoordinator?.markStale(analysisRunId, "revision_or_fingerprint_changed_before_analysis");
        return { schemaVersion: "travel-research-proposal-result-v1", status: "stale_discarded", tripId: state.tripId, revision: currentBeforeAnalysis?.revision ?? state.revision, requestedDomains, researchCriteriaFingerprint: criteria.fingerprint, fabricatedResults: false };
      }
      try {
        semanticAnalysis = await this.analysisFanout({
          runId: analysisRunId,
          tripId: state.tripId,
          baseRevision: state.revision,
          criteriaFingerprint: criteria.fingerprint,
          requiredLanes,
          brief: state.brief,
          travelers: state.travelers,
          providerResult,
          planningContext: continuousPlanningContext(state),
          objective: input.question ?? input.query ?? "Review the linked trip candidates",
          locks: state.nodes.filter((node) => node.lock).map((node) => node.nodeId),
          signal: input.signal && analysisRun?.abortController.signal ? AbortSignal.any([input.signal, analysisRun.abortController.signal]) : input.signal ?? analysisRun?.abortController.signal,
          deadlineAt: analysisRun?.deadlineAt,
          validateCurrent: async (identity) => {
            const current = await this.store.get(state.tripId);
            return current?.revision === identity.baseRevision
              && this.analysisRunCoordinator?.isCurrent(identity) !== false;
          },
        });
      } catch (error) {
        if (error instanceof TravelExecutionDeferred || execution?.defer) throw error;
        const now = new Date(this.clock?.() ?? Date.now()).toISOString();
        const failed = {
          schemaVersion: "travel-analysis-fanout-v1",
          analysisId: `analysis_${analysisRunId}`.slice(0, 128),
          runId: analysisRunId,
          tripId: state.tripId,
          baseRevision: state.revision,
          criteriaFingerprint: criteria.fingerprint,
          status: "failed",
          engine: "dynamic_workflow",
          lanes: [],
          requiredLanes,
          startedLanes: [],
          completedLanes: [],
          failedLanes: requiredLanes,
          timedOutLanes: [],
          coverage: "failed",
          degradedReasons: [error?.code ?? "analysis_fanout_failed"],
          joinCount: 1,
          joinArtifactId: `join_${analysisRunId}`.slice(0, 128),
          taskCount: requiredLanes.length,
          childConcurrency: 1,
          modelFallback: { primaryStatus: "unknown", fallbackStatus: "unknown", fallbackModel: null },
          startedAt: now,
          completedAt: now,
          deadlineAt: analysisRun?.deadlineAt ?? now,
          conditionRevision: { status: "not_needed", reasonCodes: [error?.code ?? "analysis_fanout_failed"] },
          events: [],
        };
        const join = this.analysisRunCoordinator?.tryJoin(analysisRunId);
        semanticAnalysis = join?.artifact ?? failed;
        if (join?.acquired) this.analysisRunCoordinator.completeJoin(analysisRunId, failed);
      }
      if (semanticAnalysis?.status === "stale_discarded") {
        return {
          schemaVersion: "travel-research-proposal-result-v1",
          status: "stale_discarded",
          tripId: state.tripId,
          revision: (await this.store.get(state.tripId))?.revision ?? state.revision,
          requestedDomains,
          researchCriteriaFingerprint: criteria.fingerprint,
          analysis: semanticAnalysis,
          fabricatedResults: false,
        };
      }
      input.signal?.throwIfAborted();
      providerResult = applySemanticAnalysis(providerResult, semanticAnalysis);
    }
    if (!this.analysisFanout && semanticAnalysis) providerResult = applySemanticAnalysis(providerResult, semanticAnalysis);
    let workingState = state;
    if (providerResult.weather?.status === "completed") {
      workingState = applyWeatherObservation(state, providerResult.weather, { clock: this.clock });
    }
    const mergeSource = existingResearchProposal && workingState.pendingProposals.some((proposal) => proposal.proposalId === existingResearchProposal.proposalId)
      ? existingResearchProposal
      : null;
    const refreshedProposal = buildResearchProposal(workingState, providerResult, criteria);
    const proposal = combineResearchProposal(mergeSource, refreshedProposal, requestedDomains, criteria);
    if (mergeSource) workingState = supersedeStagedTripPatch(workingState, mergeSource.proposalId, "research_criteria_changed", { clock: this.clock });
    if (!proposal.operations.length) {
      if (workingState !== state) await this.store.save(workingState, { expectedStorageVersion: state.storageVersion });
      return { ...providerResult, status: "EMPTY_VERIFIED", operation: "research_trip_options", tripId: workingState.tripId, revision: workingState.revision, requestedDomains, researchCriteriaFingerprint: criteria.fingerprint, fabricatedResults: false };
    }
    const staged = stageTripPatch(workingState, proposal, { clock: this.clock });
    if (staged.status !== "proposed") return staged;
    input.signal?.throwIfAborted();
    const saved = await this.store.save(staged.state, { expectedStorageVersion: state.storageVersion });
    const stagedProposalView = proposalView({ ...proposal, stagedAt: saved.pendingProposals.find((item) => item.proposalId === proposal.proposalId)?.stagedAt });
    return {
      schemaVersion: "travel-research-proposal-result-v1",
      status: "proposed",
      tripId: saved.tripId,
      revision: saved.revision,
      proposal: stagedProposalView,
      candidateCounts: Object.fromEntries(FOUR_DOMAINS.map((domain) => [domain, stagedProposalView.byDomain[domain].length])),
      provider: providerResult.provider,
      providerLabel: providerResult.providerLabel,
      checkedAt: providerResult.checkedAt,
      weather: providerResult.weather ?? null,
      partial: proposal.partial,
      fixtureOnly: providerResult.fixtureOnly === true,
      analysis: semanticAnalysis,
      requestedDomains,
      researchCriteriaFingerprint: criteria.fingerprint,
      fabricatedResults: false,
    };
  }

  async proposeTripChange(input, actor = "skill") {
    validateRequest("propose_trip_change", input, actor);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    this.planningRunCoordinator?.supersedeTrip(state.tripId, "candidate_set_changed");
    const result = stageTripPatch(state, input.proposal, { clock: this.clock });
    if (result.status !== "proposed") return result;
    const saved = await this.store.save(result.state, { expectedStorageVersion: state.storageVersion });
    return { ...result, state: undefined, tripId: saved.tripId, revision: saved.revision, storageVersion: saved.storageVersion };
  }

  async acceptTripChange(input) {
    validateRequest("accept_trip_change", input);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    if (input.baseRevision != null && Number(input.baseRevision) !== state.revision) {
      return { schemaVersion: "trip-commit-result-v1", status: "needs_rebase", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "itinerary_preview_stale" } };
    }
    const pendingProposal = state.pendingProposals.find((proposal) => proposal.proposalId === input.proposalId) ?? null;
    if (!pendingProposal?.itineraryPlan) this.planningRunCoordinator?.supersedeTrip(state.tripId, "selection_changed");
    const hasSelections = input.selections && Object.values(input.selections).some(Boolean);
    const hasItineraryPlan = Boolean(pendingProposal?.itineraryPlan);
    if (hasItineraryPlan && pendingProposal.requireCompletePlan) {
      const issues = completeItineraryIssues(pendingProposal.itineraryPlan, state.brief, pendingProposal.planningUserRequest ?? "");
      if (issues.length) return { schemaVersion: "trip-commit-result-v1", status: "rejected", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "itinerary_incomplete" }, feasibility: { schemaVersion: "trip-feasibility-v1", canConfirm: false, status: "blocked", primaryBlocker: issues[0].message, issues, checkedAt: null } };
    }
    let preflight = null;
    if (hasSelections || hasItineraryPlan) {
      const selectionKey = JSON.stringify(Object.entries(input.selections ?? {}).sort(([left], [right]) => left.localeCompare(right)));
      const cached = input.previewId ? await this.readMobilityPreview(input.previewId) : null;
      if (cached?.planningFingerprint && cached.planningFingerprint !== planningStateFingerprint(state)) return { schemaVersion: "trip-commit-result-v1", status: "needs_rebase", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "itinerary_preview_stale" } };
      let preview = cached?.tripId === state.tripId && cached.revision === state.revision && cached.selections === selectionKey
        ? cached.preview
        : await this.previewTripMobility({ tripId: input.tripId, baseRevision: state.revision, ...(hasItineraryPlan ? { itineraryPlan: pendingProposal.itineraryPlan } : { selections: input.selections }) });
      if (input.routeModes && Object.keys(input.routeModes).length) {
        preview = await this.previewTripMobility({ tripId: input.tripId, baseRevision: state.revision, previewId: preview.previewId, routeModes: input.routeModes });
      }
      preflight = preview;
      if (preview.feasibility?.canConfirm !== true) {
        return { schemaVersion: "trip-commit-result-v1", status: "rejected", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "itinerary_not_executable" }, feasibility: preview.feasibility, previewId: preview.previewId };
      }
    }
    const result = acceptStagedTripPatch(state, input.proposalId, { clock: this.clock, selections: hasItineraryPlan ? undefined : input.selections, partial: !hasItineraryPlan && input.partial === true });
    if (result.status !== "committed") return result;
    if (preflight?.mobility && preflight.feasibility?.canConfirm === true) {
      const checkedMobility = withTripFeasibility(result.state, result.state.nodes, preflight.mobility);
      if (checkedMobility.feasibility.canConfirm !== true) {
        return { schemaVersion: "trip-commit-result-v1", status: "rejected", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "itinerary_not_executable" }, feasibility: checkedMobility.feasibility };
      }
      result.state.environment = { ...result.state.environment, mobility: checkedMobility, updatedAt: new Date(this.clock?.() ?? Date.now()).toISOString() };
      if (hasItineraryPlan) adoptWorkingPlan(result.state, checkedMobility, new Date(this.clock?.() ?? Date.now()).toISOString());
      result.state.pendingProposals = result.state.pendingProposals.map((proposal) => {
        if (!proposal.itineraryPlan) return proposal;
        const { itineraryPlan, itineraryPreviewId, planningRunId, planningAttempt, ...rest } = proposal;
        return rest;
      });
      result.qa = validateTripCoherence(result.state);
    }
    const businessIssues = tripBusinessIssues(result.state);
    if (businessIssues.length) return { schemaVersion: "trip-commit-result-v1", status: "rejected", tripId: state.tripId, revision: state.revision, validation: { ok: false, reason: "trip_constraints_unmet" }, feasibility: { schemaVersion: "trip-feasibility-v1", canConfirm: false, status: "blocked", primaryBlocker: businessIssues[0].message, issues: businessIssues, checkedAt: null } };
    const saved = await this.store.save(result.state, { expectedStorageVersion: state.storageVersion });
    const selectedNodeIds = hasItineraryPlan ? planNodeIds(pendingProposal.itineraryPlan) : Object.values(input.selections ?? {}).filter(Boolean);
    return {
      schemaVersion: result.schemaVersion,
      status: result.status,
      tripId: saved.tripId,
      revision: saved.revision,
      storageVersion: saved.storageVersion,
      qa: result.qa,
      partial: !hasItineraryPlan && input.partial === true,
      selectedNodes: saved.nodes.filter((node) => selectedNodeIds.includes(node.nodeId)).map((node) => ({ nodeId: node.nodeId, domain: node.domain, title: node.title })),
      openDomains: saved.openDecisions.filter((decision) => decision.status === "open").map((decision) => decision.domain),
      pendingProposalIds: saved.pendingProposals.map((proposal) => proposal.proposalId),
      mobility: preflight?.mobility ?? null,
      feasibility: preflight?.feasibility ?? null,
      routeModes: preflight?.routeModes ?? input.routeModes ?? {},
    };
  }

  async rejectTripChange(input) {
    validateRequest("reject_trip_change", input);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    const result = rejectStagedTripPatch(state, input.proposalId, { clock: this.clock });
    if (result.status !== "rejected_by_user") return result;
    const saved = await this.store.save(result.state, { expectedStorageVersion: state.storageVersion });
    return { schemaVersion: result.schemaVersion, status: result.status, tripId: saved.tripId, revision: saved.revision, storageVersion: saved.storageVersion };
  }

  async discardItineraryTrial(input) {
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    if (input.baseRevision != null && Number(input.baseRevision) !== state.revision) return { schemaVersion: "itinerary-trial-discard-result-v1", status: "needs_rebase", tripId: state.tripId, revision: state.revision };
    const proposal = state.pendingProposals.find((item) => item.proposalId === input.proposalId && item.itineraryPlan);
    if (!proposal) return { schemaVersion: "itinerary-trial-discard-result-v1", status: "unchanged", tripId: state.tripId, revision: state.revision };
    this.planningRunCoordinator?.supersedeTrip(state.tripId, "trial_discarded_by_user");
    const next = structuredClone(state);
    discardWorkingPlan(next, input.proposalId);
    next.pendingProposals = next.pendingProposals.flatMap((item) => {
      if (item.proposalId !== proposal.proposalId) return [item];
      if (!(item.operations ?? []).length) return [];
      const { itineraryPlan, itineraryPreviewId, planningRunId, planningAttempt, ...rest } = item;
      return [rest];
    });
    const saved = await this.store.save(next, { expectedStorageVersion: state.storageVersion });
    return { schemaVersion: "itinerary-trial-discard-result-v1", status: "discarded", tripId: saved.tripId, revision: saved.revision, storageVersion: saved.storageVersion };
  }

  async prepareBookingHandoff(input) {
    validateRequest("prepare_booking_handoff", input, "travel_parent_agent", input.explicitUserConfirmation === true);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    const node = state.nodes.find((item) => item.nodeId === input.nodeId);
    if (!node) throw serviceError("booking_node_not_found");
    if (!node.selected) throw serviceError("booking_node_not_selected");
    const offer = input.offerId
      ? state.fulfillmentLedger.find((item) => item.offerId === input.offerId)
      : state.fulfillmentLedger.find((item) => item.offerId === node.offerRef);
    if (!offer) throw serviceError("offer_not_found");
    if (offer.expiresAt && new Date(offer.expiresAt).getTime() <= new Date(this.clock?.() ?? Date.now()).getTime()) throw serviceError("offer_stale");
    return {
      schemaVersion: "booking-handoff-v1",
      status: "ready",
      tripId: state.tripId,
      revision: state.revision,
      nodeId: node.nodeId,
      offerId: offer.offerId,
      source: offer.source,
      handoffUrl: offer.handoffUrl,
      totalPrice: offer.totalPrice,
      currency: offer.currency,
      automaticPurchase: false,
      sensitiveDataHandled: false,
    };
  }

  async recordBookingConfirmation(input) {
    validateRequest("record_booking_confirmation", input, "travel_parent_agent", input.explicitUserConfirmation === true);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    const result = recordBookingConfirmation(state, input, { clock: this.clock });
    if (result.status !== "committed") return result;
    const saved = await this.store.save(result.state, { expectedStorageVersion: state.storageVersion });
    return { schemaVersion: result.schemaVersion, status: result.status, tripId: saved.tripId, revision: saved.revision, storageVersion: saved.storageVersion, qa: result.qa };
  }

  async reportTripDisruption(input, actor = "skill") {
    validateRequest("report_trip_disruption", input, actor);
    return this.proposeTripChange({ tripId: input.tripId, proposal: input.proposal }, actor);
  }

  async submitTripFeedback(input, actor = "mcp_client") {
    validateRequest("submit_trip_feedback", input, actor);
    const state = requireTrip(await this.store.get(input.tripId), input.tripId);
    const result = recordTripFeedback(state, input, { clock: this.clock });
    if (result.status !== "committed") return result;
    const saved = await this.store.save(result.state, { expectedStorageVersion: state.storageVersion });
    return { schemaVersion: result.schemaVersion, status: result.status, tripId: saved.tripId, revision: saved.revision, storageVersion: saved.storageVersion };
  }
}

export { controlView, planView };
