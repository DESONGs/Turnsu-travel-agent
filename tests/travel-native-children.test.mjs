import assert from "node:assert/strict";
import test from "node:test";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createTravelAnalysisAgentRunner } from "../src/agent/travel-analysis-fanout.mjs";
import { analysisAssignment, analysisContentIssue } from "../travel-agent-pi-package/src/host/analysis-handoff.ts";

test("a Child's foreign references or identity are rejected before normalization, including nested findings", () => {
  const assignment = analysisAssignment({ runId: "analysis_1", tripId: "trip_1", baseRevision: 2, criteriaFingerprint: "criteria", lane: "local_discovery", candidateIds: ["food_1"], evidenceRefs: ["source_food"] });
  const valid = { findings: [{ summary: "已提供餐厅来源", candidateIds: ["food_1"], evidenceRefs: ["source_food"] }] };
  assert.equal(analysisContentIssue(valid, assignment), null);
  assert.equal(analysisContentIssue({ ...valid, lane: "inventory_budget" }, assignment), "analysis_handoff_identity_mismatch");
  assert.equal(analysisContentIssue({ findings: [{ ...valid.findings[0], candidateIds: ["foreign_food"] }] }, assignment), "analysis_handoff_scope_violation");
  assert.equal(analysisContentIssue({ findings: [{ ...valid.findings[0], evidenceRefs: ["foreign_source"] }] }, assignment), "analysis_handoff_scope_violation");
  assert.equal(analysisContentIssue({ findings: [], unknowns: ["营业时间缺少证据"] }, assignment), null);
  assert.equal(analysisContentIssue({ findings: [], unknowns: [{ fabricated: true }] }, assignment), "unknowns_string_array_required");
});

for (const repaired of [true, false]) test(`a native Child gets one bounded handoff correction and ${repaired ? "returns valid evidence" : "fails if still invalid"}`, async () => {
  const faux = fauxProvider({ provider: "fixture-child", models: [{ id: "child" }] });
  const models = createModels(); models.setProvider(faux.provider);
  let calls = 0;
  faux.setResponses([
    () => { calls++; return fauxAssistantMessage(fauxToolCall("read_analysis_evidence", { candidateIds: ["food_1"] }), { stopReason: "toolUse" }); },
    () => { calls++; return fauxAssistantMessage(JSON.stringify({ summary: "field outside the handoff format" })); },
    (context) => {
      calls++;
      assert.match(JSON.stringify(context.messages.at(-1)), /findings_array_required/);
      assert.equal(context.tools?.length ?? 0, 0, "format correction cannot reopen tools or research");
      return fauxAssistantMessage(JSON.stringify(repaired ? { findings: [{ summary: "价格仍待确认", candidateIds: ["food_1"], evidenceRefs: ["source_food"] }], unknowns: ["price"] } : { summary: "still wrong" }));
    },
  ]);
  const runner = await createTravelAnalysisAgentRunner({}, { models, forceRoute: { provider: "fixture-child", model: "child" },
    input: { runId: "analysis_1", tripId: "trip_1", baseRevision: 2, criteriaFingerprint: "criteria", brief: {}, travelers: [], weather: null, locks: [], candidates: [{ candidateId: "food_1", domain: "food", summary: "已核验的餐厅来源", evidenceRefs: ["source_food"] }] },
    tasks: [{ lane: "local_discovery" }], validateCurrent: async () => true,
  });
  if (repaired) {
    const handoff = await runner.run("分析分工内的餐厅", { label: "local_discovery" });
    assert.equal(handoff.__runtime.modelCalls, 3);
    assert.equal(handoff.__runtime.toolCalls, 1);
    assert.deepEqual(handoff.findings[0].evidenceRefs, ["source_food"]);
  } else await assert.rejects(runner.run("分析分工内的餐厅", { label: "local_discovery" }), /invalid_travel_analysis_output/);
  assert.equal(calls, 3);
});

test("a native Child reads its scoped evidence with tools and cannot read a sibling's candidates", async () => {
  const faux = fauxProvider({ provider: "fixture-child", models: [{ id: "child" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    (context) => {
      assert.deepEqual(context.tools.map((tool) => tool.name).sort(), ["read_analysis_context", "read_analysis_evidence"]);
      return fauxAssistantMessage(fauxToolCall("read_analysis_evidence", { candidateIds: ["private_stay"] }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(JSON.stringify(context.messages.at(-1)), /scope_violation/);
      assert.doesNotMatch(JSON.stringify(context), /SIBLING_PRIVATE_DETAIL/);
      return fauxAssistantMessage(fauxToolCall("read_analysis_evidence", { candidateIds: ["food_1"] }), { stopReason: "toolUse" });
    },
    (context) => {
      assert.match(JSON.stringify(context.messages.at(-1)), /ALLOWED_EVIDENCE_DETAIL/);
      return fauxAssistantMessage(JSON.stringify({ findings: [{ summary: "餐厅有官方证据，价格仍待确认。", evidenceRefs: ["source_food"] }], unknowns: ["price"] }));
    },
  ]);
  const runner = await createTravelAnalysisAgentRunner({}, { models, forceRoute: { provider: "fixture-child", model: "child" },
    input: { runId: "analysis_1", tripId: "trip_1", baseRevision: 2, criteriaFingerprint: "criteria", brief: {}, travelers: [], weather: null, locks: [], candidates: [
      { candidateId: "food_1", domain: "food", summary: "ALLOWED_EVIDENCE_DETAIL", evidenceRefs: ["source_food"] },
      { candidateId: "private_stay", domain: "stay", summary: "SIBLING_PRIVATE_DETAIL", evidenceRefs: ["source_stay"] },
    ] }, tasks: [{ lane: "local_discovery" }], validateCurrent: async () => true,
  });
  const handoff = await runner.run("分析分工内的餐厅，不改变旅行。", { label: "local_discovery" });
  assert.equal(handoff.__runtime.toolCalls, 2);
  assert.equal(handoff.__runtime.modelCalls, 3);
  assert.ok(handoff.__runtime.contextHash);
});
