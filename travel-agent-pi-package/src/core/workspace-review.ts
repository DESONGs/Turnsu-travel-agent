import type { DecisionNode, MobilityObservation, TripFeasibility, TripItinerary, TripState } from "../contracts/index.js";
import { assertSchema, MobilityObservationSchema } from "../contracts/index.js";
import { acceptStagedTripPatch } from "./trip-runtime.js";
import { adoptWorkingPlan, availablePlanningCandidates } from "./continuous-planning.js";
import { completeItineraryIssues, withTripFeasibility } from "./trip-feasibility.js";
import { withRecentTripChange } from "../product/trip-undo.js";
import { workspaceFailure, workspaceFingerprint, workspaceId, workspaceObject } from "./workspace.js";

export interface ReviewCondition { conditionId: string; label: string; stopIds: string[]; basisHash: string; acknowledged: boolean }
export interface ReviewProgress { version: number; items: Record<string, { basisHash: string; acknowledged: boolean }> }
export interface DraftReview { tripId: string; previewId: string; proposalId: string; revision: number; progressVersion: number; conditions: ReviewCondition[]; blockers: Array<{ code: string; label: string; stopIds: string[] }>; stops: TripItinerary["stops"]; adoptionStatus: "tentative" | "verified"; canAdopt: boolean }
export const reviewProgress = (value: unknown): ReviewProgress => value && typeof value === "object" && "version" in value && "items" in value ? value as ReviewProgress : { version: 0, items: {} };
const uncertainty = (issue: TripFeasibility["issues"][number]): boolean => !/(stale|expired|conflict|exceeded|ineligible)/.test(issue.code) && (/(unverified|not_verified|incomplete|unresolved_stops)/.test(issue.code) || ["required_route_missing", "budget_exchange_rate_required"].includes(issue.code) || issue.resolution === "provider_evidence");
const facts = (value: unknown): unknown => Array.isArray(value) ? value.map(facts) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !["checkedAt", "updatedAt", "createdAt", "queriedAt", "freshUntil"].includes(key)).map(([key, item]) => [key, facts(item)])) : value;
export function buildDraftReview(state: TripState, cacheValue: unknown, input: Record<string, unknown>, progress: ReviewProgress, now: Date, fingerprint: (state: TripState) => string): { view: DraftReview; proposed: TripState | null } {
  const cache = workspaceObject(cacheValue), preview = workspaceObject(cache.preview);
  if (cache.tripId !== state.tripId || cache.revision !== state.revision || typeof cache.planningFingerprint !== "string" || cache.planningFingerprint !== fingerprint(state)) return workspaceFailure("review_preview_stale", 409);
  const previewId = workspaceId(input.previewId), proposalId = workspaceId(input.proposalId);
  if (preview.previewId !== previewId) return workspaceFailure("review_preview_stale", 409);
  const proposal = state.pendingProposals.find(item => item.proposalId === proposalId);
  if (!proposal?.itineraryPlan || (proposal.itineraryPreviewId !== previewId && cache.proposalId !== proposalId)) return workspaceFailure("review_complete_draft_required", 409);
  const mobility = assertSchema(MobilityObservationSchema, preview.mobility, "invalid_review_mobility") as MobilityObservation;
  const itinerary = mobility.itinerary;
  if (!itinerary?.stops.length) return workspaceFailure("review_complete_draft_required", 409);
  const blockers: DraftReview["blockers"] = [];
  const conditions: ReviewCondition[] = [];
  const add = (key: string, label: string, stopIds: string[], basis: unknown) => {
    if (conditions.some(item => item.conditionId === key)) return;
    const basisHash = workspaceFingerprint(basis), saved = progress.items[key];
    conditions.push({ conditionId: key, label, stopIds, basisHash, acknowledged: saved?.basisHash === basisHash && saved.acknowledged === true });
  };
  const block = (code: string, label: string, stopIds: string[] = []) => { if (!blockers.some(item => item.code === code && JSON.stringify(item.stopIds) === JSON.stringify(stopIds))) blockers.push({ code, label, stopIds }); };
  if (proposal.requireCompletePlan) for (const issue of completeItineraryIssues(proposal.itineraryPlan, state.brief, proposal.planningUserRequest ?? "")) block(issue.code, issue.message, issue.stopIds);
  const committed = acceptStagedTripPatch(state, proposalId, { clock: () => now });
  let proposed = committed.status === "committed" ? committed.state : null;
  if (!proposed) block(committed.validation?.ok === false ? committed.validation.reason : "proposal_not_applicable", "草案的版本、来源或锁定项需要重新核对，当前安排保留。请让助手重新核验。");
  const candidates = availablePlanningCandidates(state);
  const nodes = proposed?.nodes ?? candidates.map(node => ({ ...node, selected: true })) as DecisionNode[];
  const checked = withTripFeasibility(proposed ?? state, nodes, mobility);
  const stopById = new Map(itinerary.stops.map(stop => [stop.stopId, stop]));
  for (let index = 1; index < itinerary.stops.length; index++) {
    const previous = itinerary.stops[index - 1]!, next = itinerary.stops[index]!;
    if (previous.date !== next.date || previous.nodeId === next.nodeId) continue;
    const leg = mobility.legs.find(item => item.origin.stopId === previous.stopId && item.destination.stopId === next.stopId)
      ?? mobility.legs.find(item => item.origin.nodeId === previous.nodeId && item.destination.nodeId === next.nodeId);
    const alternative = leg?.alternatives.find(item => item.alternativeId === leg.selectedAlternativeId) ?? leg?.alternatives.find(item => item.mode === leg.recommendedMode);
    if (!alternative || alternative.totalMinutes == null) add(`route_${workspaceFingerprint([previous.stopId, next.stopId]).slice(0, 24)}`, `${previous.title} → ${next.title}：交通、耗时或衔接尚未核实。`, [previous.stopId, next.stopId], { previous: { nodeId: previous.nodeId, date: previous.date, endAt: previous.endAt }, next: { nodeId: next.nodeId, startAt: next.startAt }, route: leg ? facts(leg as unknown as Record<string, unknown>) : null });
  }
  for (const issue of checked.feasibility?.issues ?? []) {
    if (["opening_hours_not_verified", "required_route_missing", "mobility_incomplete"].includes(issue.code)) continue;
    if (uncertainty(issue)) {
      const stops = issue.stopIds.map(id => stopById.get(id)).filter(Boolean);
      const sourceNodes = candidates.filter(node => stops.some(stop => stop?.nodeId === node.nodeId));
      const routeIssue = /(route|mobility|walking|transfer|stairs|step_free|unresolved)/.test(issue.code);
      const routes = routeIssue ? mobility.legs.filter(leg => !stops.length || stops.some(stop => stop?.stopId === leg.origin.stopId || stop?.stopId === leg.destination.stopId || stop?.nodeId === leg.origin.nodeId || stop?.nodeId === leg.destination.nodeId)).map(leg => facts(leg as unknown as Record<string, unknown>)) : [];
      add(`issue_${workspaceFingerprint([issue.code, issue.stopIds]).slice(0, 24)}`, issue.message.replace(/，?当前方案不能采用[。]?/g, "，仍待核验。"), issue.stopIds,
        { code: issue.code, observed: issue.observed, stops, sourceNodes: sourceNodes.map(node => ({ nodeId: node.nodeId, sourceStatus: node.sourceStatus, sourceRefs: node.sourceRefs, operability: facts(workspaceObject(node.operability ?? {})) })), ...(stops.length ? {} : routeIssue ? { travelers: state.travelers } : { brief: state.brief, travelers: state.travelers }), routes });
    } else if (issue.severity === "blocking") block(issue.code, issue.message, issue.stopIds);
  }
  for (const stop of itinerary.stops) {
    const node = candidates.find(item => item.nodeId === stop.nodeId);
    if (!node) { block("review_place_missing", `${stop.title}的候选资料已变化，请重新核验。`, [stop.stopId]); continue; }
    const operability = workspaceObject(node.operability ?? {});
    if (!stop.startAt || !stop.endAt) block("review_visit_time_required", `${stop.title}还缺少具体到访时间。`, [stop.stopId]);
    if (["stale", "expired"].includes(String(node.sourceStatus)) || operability.contentRefreshRequired === true) block("review_source_stale", `${stop.title}的来源资料已失效，请重新核验。`, [stop.stopId]);
    const opening = operability.openingHours ?? operability.openWeek ?? stop.openingHours;
    if (["play", "food"].includes(node.domain) && (!opening || checked.feasibility?.issues.some(issue => issue.code === "opening_hours_not_verified" && issue.stopIds.includes(stop.stopId)))) add(`opening_${stop.stopId}`, `${stop.title}：该日期的开放或营业时间尚未核实。`, [stop.stopId], { nodeId: node.nodeId, date: stop.date, start: stop.startAt, end: stop.endAt, opening, sourceStatus: node.sourceStatus });
    const reservation = operability.reservationPolicy ?? operability.bookingRequirement;
    if (["play", "stay"].includes(node.domain) && !reservation) add(`reservation_${stop.stopId}`, `${stop.title}：预约、入住或购票要求尚未核实。`, [stop.stopId], { nodeId: node.nodeId, date: stop.date, startAt: stop.startAt, endAt: stop.endAt, reservation, travelers: state.travelers.map(({ travelerId, role, operability, hardConstraints, careNeeds }) => ({ travelerId, role, operability: facts(operability), hardConstraints, careNeeds })) });
    if (!node.price || node.price.quality !== "firm") add(`cost_${stop.stopId}`, `${stop.title}：费用或包含项目尚未取得可用实价。`, [stop.stopId], { nodeId: node.nodeId, date: stop.date, price: facts(node.price), travelers: state.travelers.map(({ travelerId, role, operability }) => ({ travelerId, role, operability: facts(operability) })), currency: state.brief.currency });
  }
  if (checked.feasibility?.canConfirm !== true && !conditions.length && !blockers.length) block("review_result_unavailable", "尚未取得可判断的核验结果，请先让助手继续核验。");
  const view: DraftReview = { tripId: state.tripId, previewId, proposalId, revision: state.revision, progressVersion: progress.version, conditions, blockers, stops: itinerary.stops,
    adoptionStatus: conditions.length ? "tentative" : "verified", canAdopt: !blockers.length && conditions.every(condition => condition.acknowledged) };
  if (proposed) {
    proposed.environment = { ...proposed.environment, mobility: checked, updatedAt: now.toISOString() };
    adoptWorkingPlan(proposed, checked, now.toISOString());
    if (!proposed.planning?.adopted) return workspaceFailure("review_complete_draft_required", 409);
    proposed.planning.adopted.adoptionStatus = view.adoptionStatus;
    proposed.planning.adopted.unverifiedConditions = conditions.map(({ conditionId, label, stopIds, basisHash }) => ({ conditionId, label, stopIds, basisHash }));
    proposed.pendingProposals = proposed.pendingProposals.map(item => { if (!item.itineraryPlan) return item; const { itineraryPlan: _plan, itineraryPreviewId: _preview, planningRunId: _run, planningAttempt: _attempt, ...rest } = item; return rest; });
    proposed = withRecentTripChange(state, proposed);
  }
  return { view, proposed };
}
