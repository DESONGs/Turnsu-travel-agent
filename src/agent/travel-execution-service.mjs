import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { executionError, executionId, positiveLimit, RUN_TERMINAL } from "../../travel-agent-pi-package/src/host/execution-contract.ts";
import { withTravelExecution } from "../../travel-agent-pi-package/src/host/execution-context.ts";
import { validateTravelMessage } from "./travel-conversation-agent.mjs";
import { decisionHash, questionFacts, validateTravelAnswer, TravelExecutionDeferred } from "../../travel-agent-pi-package/src/host/travel-decision-policy.ts";

const imageKey = (run) => JSON.stringify([run.conversationId, run.requestId]);

export function runView(run) {
  return { schemaVersion: "travel-execution-v1", runId: run.runId, conversationId: run.conversationId,
    requestId: run.requestId, status: run.status, sequence: run.sequence,
    createdAt: run.createdAt, updatedAt: run.updatedAt, inputText: run.input.text,
    requiresImage: run.requiresImage, result: run.result, waitReason: run.waitReason, nextEligibleAt: run.notBefore || null, expiresAt: run.expiresAt };
}

/** A run owns exactly one Parent. All clients submit to the same durable intake. */
export class TravelExecutionService {
  constructor({ repository, conversationAgent, conversationRepository = conversationAgent?.conversationRepository, env = {}, pollMs = 250, leaseMs = 30_000 } = {}) {
    this.repository = repository;
    this.agent = conversationAgent;
    this.conversationRepository = conversationRepository;
    this.workerId = `worker_${randomUUID()}`;
    this.active = new Map();
    this.images = new Map();
    this.localLimit = positiveLimit(env.TRAVEL_AGENT_WORKER_RUNS, 16, 500);
    this.globalLimit = positiveLimit(env.TRAVEL_AGENT_MAX_ACTIVE_RUNS, 32, 500);
    this.perUserLimit = positiveLimit(env.TRAVEL_AGENT_USER_ACTIVE_RUNS, 2, 4);
    this.maxQueued = positiveLimit(env.TRAVEL_AGENT_MAX_QUEUED_RUNS, 1000, 5000);
    this.leaseMs = leaseMs;
    this.modelLimits = JSON.parse(env.TRAVEL_AGENT_MODEL_LIMITS ?? "{}");
    this.requireModelLimits = env.NODE_ENV === "production";
    // Two research passes can use 18 Child turns; leave room for Parent tools,
    // one repair and native compaction within the same hard run limit.
    this.runModelCalls = positiveLimit(env.TRAVEL_AGENT_RUN_MODEL_CALLS, 32, 32);
    this.runModelTokens = positiveLimit(env.TRAVEL_AGENT_RUN_TOKEN_BUDGET, 400_000, 1_000_000);
    this.role = ["api", "worker", "combined"].includes(env.TRAVEL_AGENT_EXECUTION_ROLE) ? env.TRAVEL_AGENT_EXECUTION_ROLE : "combined";
    this.timer = setInterval(() => void this.pump(), pollMs);
    this.timer.unref();
    this.heartbeatTimer = setInterval(() => void this.renew(), Math.min(2000, this.leaseMs / 3));
    this.heartbeatTimer.unref();
    this.closed = false;
  }
  async submit({ conversationId, userId, requestId, text, images, modelId, planningContext, answerTo }) {
    executionId(conversationId); executionId(requestId);
    const conversation = await this.agent.getConversation({ conversationId, userId });
    let question;
    let continuationObjective;
    if (answerTo) {
      executionId(answerTo.runId); executionId(answerTo.questionId);
      if (answerTo.optionId !== undefined) executionId(answerTo.optionId);
      const source = await this.owned(answerTo.runId, userId);
      if (source.conversationId !== conversationId) throw executionError("question_not_found", 404);
      question = source.result?.question;
      continuationObjective = source.input.continuationObjective ?? source.input.text;
      if (question?.consumedByRunId) {
        // Let atomic admission check an identical answer before checking newer facts.
        const option = question.options?.find(item => item.optionId === answerTo.optionId);
        if (answerTo.optionId && !option) throw executionError("question_option_invalid", 400);
        text = option?.label ?? text;
      } else {
        const facts = questionFacts(conversation.tripId ? await this.agent.travelService.getTripControlView(conversation.tripId) : null);
        text = validateTravelAnswer(question, answerTo, facts, text).text;
      }
    }
    const input = { ...validateTravelMessage({ text, images, modelId, planningContext }), ...(answerTo ? { answerTo: { runId: answerTo.runId, questionId: answerTo.questionId, ...(answerTo.optionId ? { optionId: answerTo.optionId } : {}) }, answerDependencyHash: question.dependencyHash, continuationObjective } : {}) };
    const { images: media, ...persisted } = input;
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const key = imageKey({ conversationId, requestId });
    let reserved = false;
    if (media.length) {
      const existing = await this.repository.byRequest(conversationId, requestId);
      if (existing) {
        if (existing.requestHash !== hash) throw executionError("execution_request_id_conflict");
        return { ...runView(existing), duplicate: true };
      }
      if (this.images.has(key) && this.images.get(key).hash !== hash) throw executionError("execution_request_id_conflict");
      if (!this.images.has(key)) {
        if (this.images.size >= 4) throw executionError("execution_image_capacity_full", 429);
        // Reserve request-only bytes before the durable command becomes visible.
        this.images.set(key, { media, hash, createdAt: Date.now() }); reserved = true;
      }
    }
    try {
      const result = await this.repository.submit({ conversationId, userId, requestId, requestHash: hash, input: persisted, requiresImage: media.length > 0, workerId: this.workerId, maxQueued: this.maxQueued, tripId: conversation.tripId });
      if (reserved && result.duplicate) this.images.delete(key);
      void this.pump();
      return { ...runView(result.run), duplicate: result.duplicate };
    } catch (error) { if (reserved) this.images.delete(key); throw error; }
  }
  async owned(runId, userId) {
    const run = await this.repository.get(executionId(runId));
    if (!run) throw executionError("execution_not_found", 404);
    // Current conversation ownership survives guest-to-account transfer.
    await this.agent.getConversation({ conversationId: run.conversationId, userId });
    return run;
  }
  async snapshot({ runId, userId, after = 0 }) {
    const cursor = Number(after);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw executionError("invalid_execution_cursor", 400);
    if (this.repository.mode === "postgres" && this.conversationRepository.mode === "postgres") {
      const value = await this.repository.publicSnapshot(executionId(runId), userId, cursor);
      return { ...await this.present(value.run), events: value.events };
    }
    const run = await this.owned(runId, userId);
    return { ...await this.present(run), events: await this.repository.events(runId, cursor) };
  }
  async list({ conversationId, userId }) {
    await this.agent.getConversation({ conversationId, userId });
    return { runs: await Promise.all((await this.repository.list(conversationId)).map(run => this.present(run))) };
  }
  async present(run) {
    const view = runView(run);
    if (view.status === "awaiting_input" && view.result?.question?.status === "open") {
      const conversation = await this.conversationRepository.get(run.conversationId);
      const facts = questionFacts(conversation?.tripId ? await this.agent.travelService.getTripControlView(conversation.tripId) : null);
      if (decisionHash(facts) !== view.result.question.dependencyHash) view.result = { ...view.result, question: { ...view.result.question, status: "stale" } };
    }
    return view;
  }
  async cancel({ runId, userId }) {
    const owned = await this.owned(runId, userId);
    const run = await this.repository.cancel(runId);
    this.active.get(runId)?.controller.abort(executionError("execution_cancelled"));
    this.images.delete(imageKey(owned));
    return runView(run);
  }
  async pump() {
    for (const [key, entry] of this.images) if (entry.createdAt + 240_000 < Date.now()) this.images.delete(key);
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      if (this.role === "api" && this.images.size === 0) {
        // Keep expiry/recovery visible even when every Worker is unavailable.
        // A zero-slot claim reconciles timeouts without executing text jobs.
        if (Date.now() - (this.lastMaintenance ?? 0) >= 2000) {
          this.lastMaintenance = Date.now();
          await this.repository.claimMany({ workerId: this.workerId, leaseMs: this.leaseMs, globalLimit: this.globalLimit, perUserLimit: this.perUserLimit, count: 0 });
        }
        return;
      }
      while (!this.closed && this.active.size < this.localLimit) {
        const runs = await this.repository.claimMany({ workerId: this.workerId, leaseMs: this.leaseMs, globalLimit: this.globalLimit, perUserLimit: this.perUserLimit, count: Math.min(32, this.localLimit - this.active.size), imagesOnly: this.role === "api" });
        if (!runs.length) break;
        for (const run of runs) {
          if (this.closed) { await this.repository.finish(run, "interrupted"); continue; }
          const controller = new AbortController();
          const slot = { controller, fence: run.fence, done: null };
          this.active.set(run.runId, slot);
          slot.done = this.execute(run, controller).finally(() => { this.active.delete(run.runId); this.images.delete(imageKey(run)); });
        }
      }
      this.lastError = null;
    } catch (error) { this.lastError = error?.code ?? "execution_dispatch_failed"; }
    finally { this.pumping = false; }
  }
  async renew() {
    if (this.renewing || this.closed || !this.active.size) return;
    this.renewing = true;
    const checking = [...this.active.entries()];
    try {
      const renewed = await this.repository.renewWorker(this.workerId, this.leaseMs);
      for (const [runId, slot] of checking) if (renewed.get(runId) !== slot.fence) slot.controller.abort(executionError("execution_ownership_lost"));
    } catch { for (const slot of this.active.values()) slot.controller.abort(executionError("execution_ownership_lost")); }
    finally { this.renewing = false; }
  }
  async execute(run, controller) {
    const deadlineAt = run.expiresAt;
    const deadline = setTimeout(() => controller.abort(executionError("execution_deadline")), Math.max(1, deadlineAt - Date.now()));
    const accounting = [];
    const continuation = run.continuation ?? { schemaVersion: "travel-continuation-v1", steps: {}, turn: {}, pending: null };
    let savedCheckpoint = run.checkpoint;
    let continuationWrites = Promise.resolve();
    const saveContinuation = () => {
      const pending = continuationWrites.then(() => this.repository.continuation(run, continuation));
      continuationWrites = pending.catch(() => {});
      return pending;
    };
    const context = { ...run, signal: controller.signal, assertCurrent: () => this.repository.assertCurrent(run), emit: (event) => this.repository.event(run, event),
      deadlineAt, defer: null,
      retryAttempt: async (key, mark = false) => {
        continuation.retries ??= {};
        if (mark) { continuation.retries[key] = true; await saveContinuation(); }
        return continuation.retries[key] === true;
      },
      track: (pending) => accounting.push(pending),
      readStep: async (key, input, execute, ttlMs = 60_000) => {
        const hash = decisionHash(input);
        const cached = continuation.steps[key];
        if (cached?.hash === hash && cached.expiresAt > Date.now()) return structuredClone(cached.value);
        controller.signal.throwIfAborted();
        const value = await execute();
        await context.assertCurrent();
        continuation.steps[key] = { hash, value, expiresAt: Date.now() + ttlMs };
        await saveContinuation();
        return value;
      },
      reserveJudgment: async (reservedTokens, retry) => {
        const reservation = await this.repository.reserveJudgment(run, { reservedTokens, retry, runCalls: this.runModelCalls, runTokens: this.runModelTokens });
        if (!reservation.callId) throw new TravelExecutionDeferred(reservation.notBefore, reservation.waitReason);
        return usage => this.repository.finishModel(reservation.callId, usage);
      },
      cooldownJudgment: until => this.repository.cooldownJudgment(until),
      reserveModel: async (provider, reservedTokens, signal) => {
        const configured = this.modelLimits[provider];
        if (!configured && this.requireModelLimits) throw executionError("model_account_limits_not_configured", 503);
        const limits = configured ?? { account: provider, concurrent: 8, rpm: 120, tpm: 600_000 };
        if (!limits || typeof limits !== "object" || ![limits.concurrent, limits.rpm, limits.tpm].every((value) => Number.isSafeInteger(value) && value > 0)
          || limits.concurrent > 2000 || limits.rpm > 100_000 || limits.tpm > 1_000_000_000) throw executionError("model_account_limits_invalid", 503);
        const scope = executionId(limits.account ?? provider);
        const options = { scope, reservedTokens, concurrency: positiveLimit(limits.concurrent, 8, 2000), rpm: positiveLimit(limits.rpm, 120, 100_000), tpm: positiveLimit(limits.tpm, 600_000, 1_000_000_000), runCalls: this.runModelCalls, runTokens: this.runModelTokens };
        signal?.throwIfAborted();
        const reservation = await this.repository.reserveModel(run, options);
        if (reservation?.callId) return usage => this.repository.finishModel(reservation.callId, usage);
        context.defer = { notBefore: reservation?.notBefore ?? Date.now() + 1000, waitReason: "model_capacity" };
        throw new TravelExecutionDeferred(context.defer.notBefore);
      },
    };
    try {
      const images = this.images.get(imageKey(run))?.media ?? [];
      if (run.requiresImage && !images.length) { await this.repository.finish(run, "interrupted"); return; }
      let conversation = await this.conversationRepository.get(run.conversationId);
      if (!conversation || conversation.deletedAt) throw executionError("conversation_not_found", 404);
      if (run.input.answerTo) {
        const facts = questionFacts(conversation.tripId ? await this.agent.travelService.getTripControlView(conversation.tripId) : null);
        if (!run.continuation && decisionHash(facts) !== run.input.answerDependencyHash) throw executionError("question_stale");
      }
      // A Worker can die after the Trip transaction commits but before the
      // conversation points at it. Reattach that recorded Trip on a NEW user
      // command; never replay the uncertain write or create a second draft.
      const tripId = conversation.tripId ?? await this.repository.previousTrip(run.conversationId);
      if (tripId && tripId !== conversation.tripId) {
        conversation = await withTravelExecution(context, () => this.conversationRepository.save({ ...conversation, tripId }, { expectedStorageVersion: conversation.storageVersion }));
      }
      if (tripId && run.tripId !== tripId) await this.repository.bindTrip(run, tripId);
      const checkpoint = run.checkpoint ?? await this.repository.previousCheckpoint(run.conversationId, run.runId);
      const result = await withTravelExecution(context, () => this.agent.reply({
        ...run.input, conversationId: run.conversationId, userId: conversation.userId, images,
        execution: { runId: run.runId, signal: controller.signal, checkpoint, continuation, saveContinuation, recovering: run.fence > 1 && !run.continuation, deadlineAt,
          saveCheckpoint: async (value) => { await this.repository.checkpoint(run, value); savedCheckpoint = value; },
          call: (value) => this.repository.call(run, value), emit: context.emit },
      }));
      await Promise.all(accounting);
      if (result.status === "deferred" && !controller.signal.aborted) {
        if (run.requiresImage) { await this.repository.finish(run, "interrupted"); return; }
        await this.repository.defer(run, { notBefore: result.notBefore, waitReason: result.waitReason, checkpoint: savedCheckpoint, continuation });
        return;
      }
      const abortedStatus = ["worker_stopping", "execution_ownership_lost"].includes(controller.signal.reason?.code) ? "interrupted" : controller.signal.reason?.code === "execution_deadline" ? "failed" : "cancelled";
      const status = controller.signal.aborted ? abortedStatus : result.status === "needs_context" ? "awaiting_input" : result.status === "completed" ? "completed" : "failed";
      await this.repository.finish(run, status, result);
    } catch (error) {
      const status = ["worker_stopping", "execution_ownership_lost"].includes(controller.signal.reason?.code) ? "interrupted" : controller.signal.aborted && controller.signal.reason?.code !== "execution_deadline" ? "cancelled" : "failed";
      await this.repository.finish(run, status, { status: "agent_failed", code: typeof error?.code === "string" && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : "agent_turn_failed" }).catch(() => {});
    } finally { clearTimeout(deadline); await Promise.allSettled(accounting); }
  }
  async wait({ runId, userId, signal }) {
    while (!signal?.aborted) {
      const value = await this.snapshot({ runId, userId });
      if (RUN_TERMINAL.has(value.status)) return value;
      await delay(100, undefined, { signal });
    }
    throw executionError("execution_wait_aborted");
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    for (const slot of this.active.values()) slot.controller.abort(executionError("worker_stopping"));
    while (this.pumping || this.renewing) await delay(10);
    await Promise.allSettled([...this.active.values()].map((slot) => slot.done));
  }
}
