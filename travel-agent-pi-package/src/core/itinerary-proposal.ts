import type { DecisionNodeInput, ItineraryPlan, TripFeasibility, TripPatchProposal, TripState } from "../contracts/index.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Invalid references are input errors, not a failed business repair. Validate
 * before registering the attempt, without repairing or dropping any input. */
export function itineraryInputValidation(state: TripState, plan: ItineraryPlan, nodes: DecisionNodeInput[]) {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const ids = [...new Set(plan.days.flatMap(day => day.stops.map(stop => stop.nodeId)))];
  const unknown = ids.filter(id => !byId.has(id));
  const allowedEvidenceRefs = [...new Set(ids.flatMap(id => {
    const node = byId.get(id);
    const refs = record(node?.operability).evidenceRefs;
    return [...(node?.sourceRefs ?? []), ...(Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [])];
  }))];
  const invalidEvidenceRefs = plan.evidenceRefs.filter(ref => !allowedEvidenceRefs.includes(ref));
  const invalidLocks = plan.lockedNodeIds.filter(id => !state.nodes.some(node => node.nodeId === id && (node.selected || node.lock)));
  const invalidAnchors = plan.fixedAnchors.filter(anchor => {
    const node = byId.get(anchor.nodeId);
    if (!node) return true;
    const facts = record(node.operability);
    const actual = anchor.kind === "arrival" ? facts.arrivalAt ?? record(facts.arrivalRouteAnchor).time ?? record(facts.planningWindow).endAt : record(facts.planningWindow).startAt ?? node.time;
    return typeof actual !== "string" || new Date(actual).getTime() !== new Date(anchor.startAt).getTime();
  });
  const issues: TripFeasibility["issues"] = [];
  const add = (code: string, message: string, stopIds: string[] = []) => issues.push({ code, message, stopIds: stopIds.slice(0, 8), dayIndex: null, severity: "blocking", resolution: "plan_change", allowedRepairDirections: [] });
  if (unknown.length) add("plan_node_not_found", "计划引用了当前候选中不存在的地点。请使用最新候选 ID 修正参数。", unknown);
  if (invalidEvidenceRefs.length) add("plan_evidence_not_allowed", "计划引用了不属于所选候选的资料。请复制允许的来源引用，不要创造或猜测引用。无需增加业务修复次数。");
  if (invalidLocks.length) add("plan_lock_not_authoritative", "计划把尚未确认的地点当成了锁定安排。", invalidLocks);
  if (invalidAnchors.length) add("fixed_anchor_fact_mismatch", "固定抵达或预约时间与当前候选事实不符。", invalidAnchors.map(anchor => anchor.nodeId));
  return { issues, allowedEvidenceRefs, invalidEvidenceRefs, knownNodeIds: nodes.map(node => node.nodeId) };
}

/** A reviewed itinerary selects visits across domains; the comparison UI's
 * one-choice-per-domain map must not truncate it. This only stages a proposal. */
export function itinerarySelectionProposal(state: TripState, plan: ItineraryPlan, proposalId: string, { replaceSelected = false } = {}): TripPatchProposal {
  const planned = new Set(plan.days.flatMap(day => day.stops.map(stop => stop.nodeId)));
  const existing = new Map(state.nodes.map(node => [node.nodeId, node]));
  const pending = state.pendingProposals.flatMap(proposal => proposal.operations).filter(op => op.kind === "add_candidate");
  const operations: TripPatchProposal["operations"] = [];
  // A complete replacement changes exactly the reviewed visits. Retain old
  // nodes as alternatives; mutation/lock checks still run at stage and commit.
  for (const node of state.nodes) {
    if (replaceSelected && node.selected && !planned.has(node.nodeId)) operations.push({ kind: "reject", nodeId: node.nodeId });
  }
  for (const nodeId of planned) {
    const current = existing.get(nodeId);
    if (current) { if (!current.selected) operations.push({ kind: "select", nodeId }); continue; }
    const candidate = pending.find(op => op.nodeId === nodeId);
    if (!candidate?.node) throw new Error("itinerary_plan_node_not_found");
    operations.push({ kind: "add_candidate", nodeId, node: { ...structuredClone(candidate.node), selected: true, status: "selected" } });
  }
  const writeSet = [...new Set([...planned, ...operations.map(operation => operation.nodeId)])];
  const sources = state.pendingProposals.filter(proposal => proposal.operations.some(op => planned.has(op.nodeId))).flatMap(proposal => proposal.evidenceBundle ? [proposal.evidenceBundle] : []);
  // A research result also contains alternatives that are not being adopted.
  // Keep the selected evidence graph closed over this proposal's actual nodes.
  const claims = [...new Map(sources.flatMap(source => source.claims).filter(claim => planned.has(claim.nodeId)).map(claim => [claim.claimId, claim])).values()];
  const entityIds = new Set(claims.map(claim => claim.entityId));
  const sourceIds = new Set([...claims.flatMap(claim => claim.sourceRefs), ...operations.flatMap(op => op.kind === "add_candidate" ? op.node.sourceRefs ?? [] : [])]);
  const evidenceBundle = {
    claims,
    entities: [...new Map(sources.flatMap(source => source.entities).filter(entity => entityIds.has(entity.entityId)).map(entity => [entity.entityId, entity])).values()],
    contentItems: [...new Map(sources.flatMap(source => source.contentItems).filter(item => sourceIds.has(item.contentItemId)).map(item => [item.contentItemId, item])).values()],
  };
  return {
    schemaVersion: "trip-patch-proposal-v1", proposalId, tripId: state.tripId, baseRevision: state.revision,
    title: "行程试排", summary: plan.objective, writeSet, writeContract: { allowedNodeIds: writeSet },
    readSet: state.nodes.filter(node => writeSet.includes(node.nodeId)).map(node => ({ nodeId: node.nodeId, version: node.version })),
    operations, itineraryPlan: structuredClone(plan), planningRunId: plan.runId, planningAttempt: plan.attempt === 2 ? 2 : 1,
    ...(sources.length ? { evidenceBundle } : {}),
  };
}
