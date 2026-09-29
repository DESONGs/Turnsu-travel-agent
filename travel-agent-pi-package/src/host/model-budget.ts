import type { Api, Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { assertTravelExecutionCurrent, currentTravelExecution } from "./execution-context.js";

/** All Parent, Child, fallback and compaction calls use the same reservation. */
export async function streamTravelModel(models: Models, model: Model<Api>, context: Context, options: SimpleStreamOptions = {}) {
  await assertTravelExecutionCurrent();
  const execution = currentTravelExecution();
  const signals = [options.signal, execution?.signal].filter((value): value is AbortSignal => Boolean(value));
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  let hasImage = false;
  const text = JSON.stringify(context, (_key, value: unknown) => {
    if (value && typeof value === "object" && "type" in value && value.type === "image") { hasImage = true; return "[image]"; }
    return value;
  });
  // UTF-8 bytes are a conservative text-token reservation. Images reserve the
  // entire bounded context. Never use base64 length as an image token estimate.
  const reservedTokens = (hasImage ? Math.min(32_768, model.contextWindow) : Buffer.byteLength(text)) + (options.maxTokens ?? 6144);
  const release = await execution?.reserveModel?.(model.provider, reservedTokens, signal);
  try {
    signal?.throwIfAborted();
    const stream = models.streamSimple(model, context, { ...options, maxRetries: 0, ...(signal ? { signal } : {}) });
    if (release) {
      const complete = stream.result().then((message) => {
        const usage = { input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite, output: message.usage.output };
        // An aborted/error response without usage is unknown, not a free call.
        return release(["error", "aborted"].includes(message.stopReason) && usage.input + usage.output === 0 ? undefined : usage);
      }, () => release());
      execution?.track?.(complete);
      // The owning run awaits the original promise and fails closed on errors.
      void complete.catch(() => {});
    }
    return stream;
  } catch (error) { await release?.(); throw error; }
}
