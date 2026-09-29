import { createHash, randomUUID } from "node:crypto";
import type { ContinuousPlanning, DecisionNodeInput, ItineraryPlan, ItineraryEdit, ItineraryPlanStop, MobilityObservation, SavedPlan, TripFeasibility, TripItinerary, TripState, TravelDomain } from "../contracts/index.js";
import { itineraryPlanToDraft } from "./itinerary-schedule.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function planningHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function availablePlanningCandidates(state: TripState): Array<DecisionNodeInput & {nodeId: string; domain: TravelDomain}> {
  const pending = state.pendingProposals.filter(item => !item.itineraryPlan).flatMap(item => item.operations.flatMap(op => op.kind === "add_candidate" ? [{ ...op.node, nodeId: op.nodeId }] : []));
  const nodes = [...new Map([...pending, ...state.nodes].map(node => [node.nodeId, node])).values()];
  return nodes.filter((node): node is DecisionNodeInput & {nodeId: string; domain: TravelDomain} => Boolean(node.nodeId && node.domain));
}

// A conservative semantic dependency set. Storage counters and JSONB key order
// have no meaning here; evidence, requirements and selected/locked nodes do.
export function planningDependencies(state: TripState): string {
  return planningHash({ brief: state.brief, travelers: state.travelers, weather: state.environment.weather,
    candidates: availablePlanningCandidates(state).map(node => ({ ...node, updatedAt: undefined })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)) });
}

function validation(mobility: MobilityObservation | null, dependencyFingerprint: string): SavedPlan["validation"] {
  return { status: mobility?.feasibility?.canConfirm ? "checked" : mobility ? "unknown" : "needs_check", dependencyFingerprint,
    checkedAt: mobility?.checkedAt ?? null, freshUntil: mobility?.freshUntil ?? null, invalidatedBy: [], mobility: structuredClone(mobility), feasibility: structuredClone(mobility?.feasibility ?? null) };
}

/** One-time, idempotent migration of trustworthy saved artifacts. Never invent
 * an adopted timetable from selected places or candidate default times. */
export function ensureContinuousPlanning(state: TripState): ContinuousPlanning {
  if (state.planning) return state.planning;
  const timestamp = state.updatedAt;
  const candidates = availablePlanningCandidates(state);
  const basis = planningDependencies(state);
  const document = (id: string, lifecycle: SavedPlan["lifecycle"], plan: ItineraryPlan | null, itinerary: TripItinerary | null, mobility: MobilityObservation | null): SavedPlan => ({
    planId: id, version: 1, lifecycle, previousPlanId: null, plan: structuredClone(plan), itinerary: structuredClone(itinerary),
    candidates: structuredClone(candidates.filter(node => itinerary?.stops.some(stop => stop.nodeId === node.nodeId) || plan?.days.some(day => day.stops.some(stop => stop.nodeId === node.nodeId)))),
    proposalId: null, previewId: null, requireCompletePlan: false, userRequest: "", lastEstimate: null,
    createdAt: timestamp, updatedAt: timestamp, validation: validation(mobility, basis),
  });
  const mobility = state.environment?.mobility ?? null;
  const adopted = mobility?.itinerary && state.nodes.some(node => node.selected)
    ? document(`plan_adopted_${planningHash([state.tripId, mobility.itinerary]).slice(0, 24)}`, "adopted", null, mobility.itinerary, mobility) : null;
  const proposal = state.pendingProposals.find(item => item.itineraryPlan);
  const draft = proposal?.itineraryPlan ? document(`plan_draft_${planningHash([state.tripId, proposal.proposalId]).slice(0, 24)}`, "draft", proposal.itineraryPlan,
    itineraryPlanToDraft(proposal.itineraryPlan, state.brief, candidates.map(node => ({ ...node, operability: { ...node.operability } }))).itinerary, null) : null;
  if (draft && proposal) {
    draft.proposalId = proposal.proposalId; draft.previewId = proposal.itineraryPreviewId ?? null;
    draft.requireCompletePlan = proposal.requireCompletePlan === true;
    draft.userRequest = typeof proposal.planningUserRequest === "string" ? proposal.planningUserRequest : "";
  }
  state.planning = { schemaVersion: "continuous-planning-v1", planningId: `planning_${state.tripId}`, objective: { version: draft ? 1 : 0,
    description: draft?.plan?.objective ?? "", requestRefs: [], completionCriteria: [] }, adopted, draft, history: [] };
  return state.planning;
}

export function stalePlanFeasibility(document: SavedPlan, reason = "旅行条件或核验资料已变化，需要重新核验。") : TripFeasibility {
  return { schemaVersion: "trip-feasibility-v1", status: "needs_context", canConfirm: false, primaryBlocker: reason, checkedAt: null,
    issues: [{ code: "plan_requires_recheck", scope: "plan", severity: "blocking", message: reason, stopIds: [], dayIndex: null,
      resolution: "provider_evidence", allowedRepairDirections: ["fetch_evidence"] }] };
}

/** Invalidating proof never deletes either user's artifact. */
export function invalidateSavedPlans(state: TripState, reasons: string[]): void {
  const planning = ensureContinuousPlanning(state);
  for (const document of [planning.adopted, planning.draft]) {
    if (!document) continue;
    document.validation.status = "stale";
    document.validation.invalidatedBy = [...new Set([...document.validation.invalidatedBy, ...reasons])];
  }
  projectAdoptedPlan(state);
}

export function planNeedsRecheck(document: SavedPlan, at?: string): boolean {
  return ["needs_check", "stale"].includes(document.validation.status)
    || Boolean(at && document.validation.freshUntil && new Date(document.validation.freshUntil).getTime() <= new Date(at).getTime());
}

export function planMobilityProjection(document: SavedPlan, at?: string): MobilityObservation {
  const stale = planNeedsRecheck(document, at);
  const original = document.validation.mobility;
  const routesInvalid = stale && (!document.validation.invalidatedBy.length || document.validation.invalidatedBy.some(reason => reason !== "totalBudget"));
  return {
    schemaVersion: "trip-mobility-v1", status: stale ? "needs_context" : original?.status ?? "needs_context",
    destination: original?.destination ?? null, source: original?.source ?? "saved_plan", checkedAt: stale ? null : original?.checkedAt ?? null,
    freshUntil: stale ? null : original?.freshUntil ?? null,
    coverage: routesInvalid || !original ? { routedNodeIds: [], unresolvedNodeIds: [...new Set(document.itinerary?.stops.map(stop => stop.nodeId) ?? [])],
      routedStopIds: [], unresolvedStopIds: document.itinerary?.stops.map(stop => stop.stopId) ?? [], unscheduled: !document.itinerary } : structuredClone(original.coverage),
    legs: routesInvalid ? [] : structuredClone(original?.legs ?? []), travelerFit: routesInvalid ? {} : structuredClone(original?.travelerFit ?? {}),
    itinerary: structuredClone(document.itinerary), feasibility: stale ? stalePlanFeasibility(document) : document.validation.feasibility,
    reason: stale ? document.validation.invalidatedBy.join(",") || "proof_expired" : original?.reason ?? null,
    caveats: stale ? ["原安排已保留，尚未按当前要求重新核验。"] : original?.caveats ?? [], sourceDocumentation: original?.sourceDocumentation ?? null, fabricatedResults: false,
  };
}

/** Legacy clients read this projection. They never own or edit the plan. */
export function projectAdoptedPlan(state: TripState, at?: string): void {
  const adopted = state.planning?.adopted;
  if (adopted) state.environment.mobility = planMobilityProjection(adopted, at);
}

export function stablePlanVisits(plan: ItineraryPlan, previous?: SavedPlan | null): ItineraryPlan {
  const result = structuredClone(plan);
  const used = new Set<string>();
  for (const day of result.days) for (const stop of day.stops) {
    // Only reuse identity for a demonstrably identical occurrence. Explicit
    // stopId is mandatory when replacing/moving a visit through the edit API.
    const match = previous?.itinerary?.stops.find(item => !used.has(item.stopId) && item.nodeId === stop.nodeId && item.role === stop.role && item.date === day.date
      && (item.startAt === (stop.timeWindow.startAt ?? null) || previous.itinerary?.stops.filter(other => other.nodeId === stop.nodeId && other.role === stop.role && other.date === day.date).length === 1));
    stop.stopId ??= match?.stopId ?? `visit_${randomUUID().replaceAll("-", "")}`;
    if (used.has(stop.stopId)) throw Object.assign(new Error("duplicate_itinerary_stop"), { code: "duplicate_itinerary_stop" });
    used.add(stop.stopId);
  }
  return result;
}

export function saveWorkingPlan(state: TripState, input: {plan: ItineraryPlan; itinerary: TripItinerary | null; mobility: MobilityObservation; proposalId: string; previewId: string; requireCompletePlan: boolean; userRequest: string; estimatedCost?: number}, timestamp: string): SavedPlan {
  const planning = ensureContinuousPlanning(state);
  const previous = planning.draft;
  const document: SavedPlan = { planId: previous?.planId ?? `plan_${randomUUID().replaceAll("-", "")}`, version: (previous?.version ?? 0) + 1, lifecycle: "draft",
    previousPlanId: planning.adopted?.planId ?? null, plan: structuredClone(input.plan), itinerary: structuredClone(input.itinerary),
    candidates: structuredClone(availablePlanningCandidates(state).filter(node => input.plan.days.some(day => day.stops.some(stop => stop.nodeId === node.nodeId)))),
    proposalId: input.proposalId, previewId: input.previewId, requireCompletePlan: input.requireCompletePlan, userRequest: input.userRequest,
    lastEstimate: input.estimatedCost ?? null, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, validation: validation(input.mobility, planningDependencies(state)) };
  if (previous) planning.history.push({ ...previous, lifecycle: "superseded" });
  planning.draft = document;
  if (!planning.objective.description) { planning.objective.description = input.plan.objective; planning.objective.version += 1; }
  return document;
}

export function adoptWorkingPlan(state: TripState, checkedMobility: MobilityObservation, timestamp: string): void {
  const planning = ensureContinuousPlanning(state);
  if (!planning.draft) return;
  if (planning.adopted) planning.history.push({ ...planning.adopted, lifecycle: "superseded" });
  planning.adopted = { ...planning.draft, lifecycle: "adopted", updatedAt: timestamp,
    validation: validation(checkedMobility, planningDependencies(state)) };
  planning.draft = null;
  projectAdoptedPlan(state);
}

export function recordAdoptedValidation(state: TripState, mobility: MobilityObservation): void {
  const adopted = ensureContinuousPlanning(state).adopted;
  if (!adopted) return;
  adopted.validation = validation(mobility, planningDependencies(state));
  projectAdoptedPlan(state);
}

export function discardWorkingPlan(state: TripState, proposalId: string): void {
  const planning = ensureContinuousPlanning(state);
  if (planning.draft?.proposalId !== proposalId) return;
  planning.history.push({ ...planning.draft, lifecycle: "discarded" });
  planning.draft = null;
}

function planError(code: string): never { throw Object.assign(new Error(code), { code }); }

export function editSavedPlan(state: TripState, edit: ItineraryEdit): ItineraryPlan {
  const planning = ensureContinuousPlanning(state);
  const document = [planning.draft, planning.adopted].find(item => item?.planId === edit.basePlanId);
  if (!document || document.version !== edit.basePlanVersion || state.revision !== edit.baseRevision) planError("saved_plan_version_conflict");
  if (!document.plan) planError("legacy_plan_requires_explicit_replan");
  const plan = structuredClone(document.plan);
  plan.runId = edit.runId; plan.attempt = edit.attempt; plan.baseRevision = state.revision; plan.objective = edit.objective;
  const locate = (id: string) => {
    for (const day of plan.days) { const index = day.stops.findIndex(stop => stop.stopId === id); if (index >= 0) return { day, index, stop: day.stops[index]! }; }
    return planError("itinerary_visit_not_found");
  };
  const insert = (stop: ItineraryPlanStop, dayIndex: number, date: string, after: string | null) => {
    let day = plan.days.find(item => item.dayIndex === dayIndex);
    if (!day) { day = { dayIndex, date, stops: [] }; plan.days.push(day); }
    if (day.date !== date) planError("itinerary_day_mismatch");
    const index = after == null ? -1 : day.stops.findIndex(item => item.stopId === after);
    if (after != null && index < 0) planError("itinerary_visit_not_found");
    day.stops.splice(index + 1, 0, stop);
  };
  for (const operation of edit.operations) {
    if (operation.kind === "insert") { insert({ ...operation.stop, stopId: operation.stop.stopId ?? `visit_${randomUUID().replaceAll("-", "")}` }, operation.dayIndex, operation.date, operation.afterStopId); continue; }
    const { day, index, stop } = locate(operation.stopId);
    const locked = stop.fixed || state.nodes.some(node => node.nodeId === stop.nodeId && node.lock);
    if (locked && (operation.kind !== "update" || Object.keys(operation.changes).some(key => !["preferredModes", "rationale"].includes(key)))) planError("locked_visit_mutation_blocked");
    if (operation.kind === "remove") day.stops.splice(index, 1);
    if (operation.kind === "update") day.stops[index] = { ...stop, ...operation.changes, stopId: operation.stopId };
    if (operation.kind === "move") { day.stops.splice(index, 1); insert(stop, operation.dayIndex, operation.date, operation.afterStopId); }
  }
  plan.days = plan.days.filter(day => day.stops.length).sort((a, b) => a.dayIndex - b.dayIndex);
  const available = availablePlanningCandidates(state);
  const nodeIds = new Set(plan.days.flatMap(day => day.stops.map(stop => stop.nodeId)));
  // Evidence follows actual selected candidates, never text invented by a model.
  plan.evidenceRefs = [...new Set(available.filter(node => nodeIds.has(node.nodeId)).flatMap(node => node.sourceRefs ?? []))];
  return plan;
}

/** One authoritative read produces Parent/Child projections. No history summary
 * can overwrite these facts, plan identities or unresolved checks. */
export function continuousPlanningContext(state: TripState) {
  const planning = ensureContinuousPlanning(state);
  const journal = state.changeJournal as Array<Record<string, unknown>>;
  const summarize = (document: SavedPlan | null) => document ? {
    planId: document.planId, version: document.version, lifecycle: document.lifecycle,
    itinerary: document.itinerary, plan: document.plan,
    validation: { status: document.validation.status, checkedAt: document.validation.checkedAt, freshUntil: document.validation.freshUntil, invalidatedBy: document.validation.invalidatedBy },
    lastEstimate: document.lastEstimate,
  } : null;
  const issues = [planning.draft, planning.adopted].flatMap(document => {
    if (!document) return [];
    const feasibility = planNeedsRecheck(document) ? stalePlanFeasibility(document) : document.validation.feasibility;
    return (feasibility?.issues ?? []).map(issue => ({ ...issue,
      issueId: `issue_${planningHash([document.planId, issue.code, issue.stopIds]).slice(0, 24)}`,
      planId: document.planId, planVersion: document.version,
      resolutionOwner: issue.resolution === "user_fact" ? "user" : issue.resolution === "provider_evidence" ? "provider" : "parent",
      completionCondition: "Recheck this issue on the current plan and evidence; semantic confidence does not clear a hard constraint.",
    }));
  });
  const dependencyFingerprint = planningDependencies(state);
  return {
    schemaVersion: "continuous-planning-context-v1",
    basis: { tripId: state.tripId, planningId: planning.planningId, revision: state.revision, objectiveVersion: planning.objective.version,
      snapshotId: `snapshot_${planningHash([dependencyFingerprint, planning.adopted?.version, planning.draft?.version]).slice(0, 24)}`, dependencyFingerprint },
    goal: planning.objective,
    boundaries: { requirements: state.brief, travelers: state.travelers, locks: state.nodes.filter(node => node.lock).map(node => ({ nodeId: node.nodeId, lock: node.lock })),
      authority: "Only explicit user authorization through the existing business submit tool can adopt; evidence and model confidence grant no permission." },
    plan: { adopted: summarize(planning.adopted), workingDraft: summarize(planning.draft) },
    decisions: (planning.draft?.plan ?? planning.adopted?.plan)?.days.flatMap(day => day.stops.map(stop => ({ stopId: stop.stopId, nodeId: stop.nodeId, reason: stop.rationale, nature: "planning_rationale" }))) ?? [],
    assumptions: (planning.draft?.plan ?? planning.adopted?.plan)?.assumptions ?? [],
    issues,
    progress: { completedReceipts: journal.filter(entry => entry.event === "itinerary_trial_saved").slice(-4).map(entry => {
      const result = entry.result && typeof entry.result === "object" ? entry.result as Record<string, unknown> : {};
      return { operationId: entry.operationId, dependencyFingerprint: entry.dependencyFingerprint, businessStatus: result.status, proposalId: result.proposalId };
    }) },
    delta: { invalidatedResults: [planning.adopted, planning.draft].flatMap(document => document?.validation.invalidatedBy.map(reason => ({ planId: document.planId, reason })) ?? []),
      latestChange: [...journal].reverse().find(entry => entry.event === "trip_scope_updated" || entry.event === "weather_context_updated") ?? null },
  };
}
