import { assertTravelExecutionCurrent, currentTravelExecution } from "./execution-context.js";
import { executionError } from "./execution-contract.js";
import { TravelExecutionDeferred } from "./travel-decision-policy.js";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_LIMITS = Object.freeze({ rpm: 1200, normalRpm: 1080, retryRpm: 60, tps: 250_000, inputBudget: 12_000, concurrency: 32 });
export type JevQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, string> } | { type: "score"; instructions: unknown; criteria: string[] };
export interface JevAnswer { type: "choice" | "score"; choice?: string; score?: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, string> }
export interface JevResponse { model: string; answers: Record<string, JevAnswer>; usage: { input_tokens: number; output_tokens: number } }

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function probability(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }

export function validateJevResponse(value: unknown, questions: Record<string, JevQuestion>): JevResponse {
  const invalid = () => executionError("jev_response_invalid", 502);
  if (!object(value) || value.model !== JEV_MODEL || !object(value.answers) || !object(value.usage)) throw invalid();
  if (![value.usage.input_tokens, value.usage.output_tokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0)) throw invalid();
  if (Object.keys(value.answers).length !== Object.keys(questions).length) throw invalid();
  for (const [key, question] of Object.entries(questions)) {
    const answer = value.answers[key];
    if (!object(answer) || answer.type !== question.type || !probability(answer.confidence) || !object(answer.probabilities)) throw invalid();
    const expected = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    const probs = answer.probabilities;
    if (Object.keys(probs).length !== expected.length || expected.some(k => !probability(probs[k])) || Math.abs(Object.values(probs).reduce<number>((a, n) => a + Number(n), 0) - 1) > .01) throw invalid();
    if (question.type === "choice" && (typeof answer.choice !== "string" || !expected.includes(answer.choice))) throw invalid();
    if (question.type === "score" && (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > expected.length - 1)) throw invalid();
  }
  return value as unknown as JevResponse;
}

/** One counted HTTP attempt. Retries are durable steps owned by the host. */
export function createJevClient({ apiKey, fetchImpl = fetch }: { apiKey?: string; fetchImpl?: typeof fetch }) {
  return async (state: unknown, questions: Record<string, JevQuestion>, { retry = false, signal }: { retry?: boolean; signal?: AbortSignal } = {}): Promise<JevResponse> => {
    if (!apiKey) throw executionError("jev_not_configured", 503);
    const execution = currentTravelExecution();
    if (!execution?.reserveJudgment) throw executionError("jev_durable_run_required", 503);
    const body = JSON.stringify({ model: JEV_MODEL, state, questions });
    // UTF-8 bytes conservatively bound text tokens, including question text.
    const reservedTokens = Buffer.byteLength(body);
    if (reservedTokens > JEV_LIMITS.inputBudget) throw executionError("jev_batch_too_large", 400);
    const release = await execution.reserveJudgment(reservedTokens, retry);
    const signals = [execution.signal, signal, AbortSignal.timeout(20_000)].filter((v): v is AbortSignal => !!v);
    let usage: { input: number; output: number } | undefined;
    try {
      await assertTravelExecutionCurrent();
      const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body, signal: AbortSignal.any(signals), redirect: "error" });
      if ([429, 529, 503].includes(response.status)) {
        const raw = response.headers.get("retry-after");
        const seconds = raw === null ? NaN : Number(raw);
        const parsed = raw && !Number.isFinite(seconds) ? Date.parse(raw) - Date.now() : seconds * 1000;
        const notBefore = Date.now() + Math.max(1000, Number.isFinite(parsed) ? parsed : 2000);
        await execution.cooldownJudgment?.(notBefore);
        if (retry) throw executionError("jev_retry_exhausted", 503);
        throw new TravelExecutionDeferred(notBefore, "jev_rate_limited");
      }
      if (!response.ok) throw executionError(response.status === 401 ? "jev_auth_failed" : "jev_request_failed", 502);
      // Bound the body while reading; never log raw provider errors or prompts.
      const reader = response.body?.getReader();
      if (!reader) throw executionError("jev_response_invalid", 502);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256_000) { await reader.cancel(); throw executionError("jev_response_too_large", 502); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const result = validateJevResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")), questions);
      usage = { input: result.usage.input_tokens, output: result.usage.output_tokens };
      await assertTravelExecutionCurrent();
      return result;
    } finally { await release(usage); }
  };
}
