import { createHash } from "node:crypto";

export interface AnalysisAssignment {
  runId: string;
  tripId: string;
  baseRevision: number;
  criteriaFingerprint: string;
  lane: string;
  candidateIds: string[];
  evidenceRefs: string[];
}

/** Immutable, bounded shared facts. A Child has its own window and no write authority. */
export function analysisAssignment(input: AnalysisAssignment, facts: unknown = null) {
  if (!Number.isInteger(input.baseRevision) || input.baseRevision < 0 || !input.criteriaFingerprint) throw new Error("invalid_analysis_assignment");
  return Object.freeze({ ...input, candidateIds: Object.freeze([...new Set(input.candidateIds)]), evidenceRefs: Object.freeze([...new Set(input.evidenceRefs)]),
    contextHash: createHash("sha256").update(JSON.stringify({ assignment: input, facts })).digest("hex"), allowedActions: Object.freeze(["read_analysis_context", "read_analysis_evidence"]), writeAuthority: "none" as const });
}

/** Reject malformed or foreign references before normalization can discard them. */
export function analysisContentIssue(value: unknown, assignment: ReturnType<typeof analysisAssignment> | null = null): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "child_result_shape";
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.findings)) return "findings_array_required";
  for (const key of ["recommendedCandidateIds", "rejectedCandidateIds", "reasonCodes", "unknowns", "needsContext", "evidenceRefs"]) {
    const items = result[key];
    if (items !== undefined && (!Array.isArray(items) || items.some((item) => typeof item !== "string"))) return `${key}_string_array_required`;
  }
  const findings: Record<string, unknown>[] = [];
  for (const item of result.findings) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.summary !== "string" || !item.summary.trim()) return "finding_summary_required";
    for (const key of ["candidateIds", "evidenceRefs"]) {
      const items = item[key];
      if (items !== undefined && (!Array.isArray(items) || items.some((ref: unknown) => typeof ref !== "string"))) return `finding_${key}_string_array_required`;
    }
    findings.push(item);
  }
  if (!findings.length && !["reasonCodes", "unknowns", "needsContext"].some((key) => (result[key] as string[] | undefined)?.some((item) => item.trim()))) return "analysis_content_required";
  if (!assignment) return null;
  for (const key of ["runId", "tripId", "baseRevision", "criteriaFingerprint", "lane"] as const) {
    if (result[key] !== undefined && result[key] !== assignment[key]) return "analysis_handoff_identity_mismatch";
  }
  const candidates = [...(result.recommendedCandidateIds as string[] ?? []), ...(result.rejectedCandidateIds as string[] ?? []), ...findings.flatMap((finding) => finding.candidateIds as string[] ?? [])];
  const evidence = [...(result.evidenceRefs as string[] ?? []), ...findings.flatMap((finding) => finding.evidenceRefs as string[] ?? [])];
  if (candidates.some((id) => !assignment.candidateIds.includes(id)) || evidence.some((ref) => !assignment.evidenceRefs.includes(ref))) return "analysis_handoff_scope_violation";
  return null;
}

export function acceptAnalysisHandoff(assignment: ReturnType<typeof analysisAssignment>, result: {
  runId: string; tripId: string; baseRevision: number; criteriaFingerprint: string; lane: string;
  evidenceRefs: string[]; recommendedCandidateIds: string[]; rejectedCandidateIds: string[];
}) {
  for (const key of ["runId", "tripId", "baseRevision", "criteriaFingerprint", "lane"] as const) {
    if (result[key] !== assignment[key]) throw new Error("analysis_handoff_identity_mismatch");
  }
  if (result.evidenceRefs.some((id) => !assignment.evidenceRefs.includes(id)) || [...result.recommendedCandidateIds, ...result.rejectedCandidateIds].some((id) => !assignment.candidateIds.includes(id))) throw new Error("analysis_handoff_scope_violation");
  return { schemaVersion: "travel-analysis-handoff-v1", runId: assignment.runId, lane: assignment.lane,
    baseRevision: assignment.baseRevision, criteriaFingerprint: assignment.criteriaFingerprint, contextHash: assignment.contextHash,
    status: "accepted" as const, writeAuthority: "none" as const };
}
