import { setTimeout as delay } from "node:timers/promises";
import { RUN_TERMINAL } from "../../travel-agent-pi-package/src/host/execution-contract.ts";

export function registerTravelExecutionRoutes({ app, asyncRoute, requireSession, requireConversationOwner, executionService }) {
  app.post("/api/conversations/:conversationId/runs", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    const result = await executionService.submit({ ...request.body, conversationId: request.params.conversationId, userId: session.userId });
    response.status(result.duplicate ? 200 : 202).json(result);
  }));
  app.get("/api/conversations/:conversationId/runs", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await executionService.list({ conversationId: request.params.conversationId, userId: session.userId }));
  }));
  app.get("/api/runs/:runId", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await executionService.snapshot({ runId: request.params.runId, userId: session.userId, after: request.query.after ?? 0 }));
  }));
  app.post("/api/runs/:runId/cancel", asyncRoute(async (request, response) => {
    const session = await requireSession(request);
    response.json(await executionService.cancel({ runId: request.params.runId, userId: session.userId }));
  }));
  app.get("/api/runs/:runId/events", asyncRoute(async (request, response) => {
    let session = await requireSession(request);
    let cursor = Number(request.query.after ?? request.headers["last-event-id"] ?? 0);
    let snapshot = await executionService.snapshot({ runId: request.params.runId, userId: session.userId, after: cursor });
    response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    response.flushHeaders();
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    let authCheckedAt = Date.now();
    try {
      while (!controller.signal.aborted && !executionService.closed) {
        const lastEvent = snapshot.events.at(-1)?.sequence ?? cursor;
        // Slow clients reconnect from a durable cursor instead of growing a RAM buffer.
        if (!response.write(`id: ${lastEvent}\nevent: progress\ndata: ${JSON.stringify(snapshot)}\n\n`)) break;
        cursor = lastEvent;
        if (RUN_TERMINAL.has(snapshot.status) && cursor >= snapshot.sequence) break;
        await delay(1000, undefined, { signal: controller.signal });
        if (Date.now() - authCheckedAt > 15_000) { session = await requireSession(request); authCheckedAt = Date.now(); }
        snapshot = await executionService.snapshot({ runId: request.params.runId, userId: session.userId, after: cursor });
      }
    } catch (error) {
      if (!controller.signal.aborted) response.write(`event: unavailable\ndata: {"code":"execution_stream_interrupted"}\n\n`);
    } finally { response.end(); }
  }));
}
