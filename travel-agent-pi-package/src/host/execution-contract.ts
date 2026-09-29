export const RUN_TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "awaiting_input"]);
export type RunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled" | "interrupted" | "awaiting_input";

/** Execution finishing is different from having all requested travel evidence. */
export function travelTurnOutcome(input: {
  requestedDomains: string[];
  availableDomains: string[];
  researchStatus: string | null;
  incompleteAnalysis: string[];
  planningStatus: string | null;
}) {
  const missingDomains = [...new Set(input.requestedDomains)].filter((domain) => !input.availableDomains.includes(domain));
  const incompleteAnalysis = [...new Set(input.incompleteAnalysis)];
  const partial = missingDomains.length > 0 || incompleteAnalysis.length > 0
    || (input.researchStatus !== null && input.researchStatus !== "proposed")
    || (input.planningStatus !== null && input.planningStatus !== "trial_ready");
  return { status: partial ? "partial" as const : "ready" as const, missingDomains, incompleteAnalysis, planningStatus: input.planningStatus };
}

export function executionError(code: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status });
}

export function executionId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw executionError("invalid_execution_id", 400);
  return value;
}

/** Only product progress crosses the transport; model thinking, args and raw results never do. */
export function publicExecutionEvent(value: Record<string, unknown>): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  for (const key of ["type", "status", "toolName", "toolCallId", "lane", "runId", "tripId", "code", "attempt", "revision", "modelCallCount", "toolCallCount", "inputTokens", "outputTokens", "waitReason", "notBefore"]) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) event[key] = field;
    else if (typeof field === "string" && /^[A-Za-z0-9_.:/-]{1,160}$/.test(field)) event[key] = field;
  }
  if (!event.type) throw executionError("invalid_execution_event", 400);
  return event;
}

export function positiveLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
