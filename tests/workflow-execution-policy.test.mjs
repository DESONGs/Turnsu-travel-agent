import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTravelService, workflowExecutionPolicy } from "../src/api/create-travel-service.mjs";
import { createHttpApp } from "../src/http/app.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";

test("single-process workflow mode fails closed for uncoordinated multi-worker deployment", async () => {
  assert.equal(workflowExecutionPolicy({ TRAVEL_AGENT_INSTANCE_COUNT: "1" }).semanticFanoutEnabled, true);
  const blocked = workflowExecutionPolicy({ TRAVEL_AGENT_INSTANCE_COUNT: "2", TRAVEL_AGENT_WORKFLOW_COORDINATOR: "postgres" });
  assert.equal(blocked.semanticFanoutEnabled, false);
  assert.equal(blocked.status, "blocked_multi_instance_without_coordinator");
  assert.equal(blocked.coordinatorSupported, false);

  const rootDir = await mkdtemp(join(tmpdir(), "travel-workflow-policy-"));
  const service = createTravelService({ TRAVEL_AGENT_INSTANCE_COUNT: "2" }, { store: new TripStore({ rootDir }), researchProvider: { status: "configured" } });
  assert.equal(service.analysisFanout, null);
  const app = createHttpApp({ travelService: service, runtimeEnv: { NODE_ENV: "test" }, developmentAuthEnabled: false });
  const server = await new Promise((resolve) => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const health = await response.json();
    assert.equal(health.workflowExecution.workflowExecutionMode, "single_process");
    assert.equal(health.workflowExecution.status, "blocked_multi_instance_without_coordinator");
    assert.equal(health.workflowExecution.backgroundResumeSupported, false);
    assert.equal(health.workflowExecution.crossInstanceSteerSupported, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("multi-worker semantic analysis requires the PostgreSQL run owner, not a coordinator label", async () => {
  const env = { DATABASE_URL: "postgresql://localhost/travel_execution_test", TRAVEL_AGENT_INSTANCE_COUNT: "2", TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE: "postgres_run" };
  assert.equal(workflowExecutionPolicy(env).semanticFanoutEnabled, true);
  assert.equal(workflowExecutionPolicy(env).backgroundResumeSupported, "read_only_once");
  let calls = 0;
  const service = createTravelService(env, { store: { mode: "postgres" }, researchProvider: { status: "configured" }, analysisFanout: async () => { calls++; } });
  await assert.rejects(service.analysisFanout({}), { code: "analysis_durable_run_required" });
  assert.equal(calls, 0);
});

test("an uncoordinated multi-worker research request exposes failed semantic coverage instead of claiming full planning", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "travel-workflow-degraded-"));
  const checkedAt = "2026-08-28T08:00:00.000Z";
  const stay = {
    candidateId: "stay_degraded_1",
    domain: "stay",
    title: "人民广场酒店候选",
    summary: "Fixture stay evidence",
    cost: 600,
    checkedAt,
    location: { name: "人民广场酒店候选", address: "人民广场" },
    media: [],
    operability: { provider: "workflow_fixture" },
    sourceId: "source_stay_degraded_1",
    entityId: "entity_stay_degraded_1",
    claimId: "claim_stay_degraded_1",
    source: { sourceId: "source_stay_degraded_1", provider: "workflow_fixture", sourceType: "fixture", providerPoiId: "poi_stay_degraded_1", checkedAt, documentationUrl: "https://example.com/workflow-fixture", independenceGroup: "source_stay_degraded_1", commercialBias: "fixture" },
    entity: { entityId: "entity_stay_degraded_1", kind: "stay", canonicalName: "人民广场酒店候选", providerRefs: ["workflow_fixture:stay:1"] },
    claim: { claimId: "claim_stay_degraded_1", entityId: "entity_stay_degraded_1", kind: "fixture_fact", statement: "Fixture stay exists", sourceRefs: ["source_stay_degraded_1"], sourceIndependence: "fixture", commercialBias: "fixture", confidence: 0.9, observedAt: checkedAt },
  };
  const researchProvider = { status: "configured", async research() { return { schemaVersion: "travel-provider-result-v1", status: "completed", provider: "workflow_fixture", checkedAt, byDomain: { play: [], food: [], stay: [stay], transport: [] }, partial: false, errors: [], caveats: [], fabricatedResults: false, fixtureOnly: true }; } };
  const service = createTravelService({ TRAVEL_AGENT_INSTANCE_COUNT: "2" }, { store: new TripStore({ rootDir }), researchProvider, clock: () => new Date(checkedAt) });
  await service.createTrip({ tripId: "trip_workflow_degraded", brief: { destination: "上海" }, travelers: [{ travelerId: "traveler_1", displayName: "Traveler" }] });

  const result = await service.researchTripOptions({ tripId: "trip_workflow_degraded", domains: ["stay"], question: "比较人民广场住宿" });
  assert.equal(result.status, "proposed");
  assert.equal(result.partial, true);
  assert.equal(result.analysis.coverage, "failed");
  assert.deepEqual([...result.analysis.requiredLanes], ["inventory_budget", "operability_schedule"]);
  assert.deepEqual([...result.analysis.completedLanes], []);
  assert.deepEqual([...result.analysis.degradedReasons], ["blocked_multi_instance_without_coordinator"]);
});
