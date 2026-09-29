import test from "node:test";
import assert from "node:assert/strict";
import { decideTravelAdvance, decisionHash, createTravelQuestion, validateTravelAnswer, rankDecisionCandidates, completePlanningRequested, selectPlanningContext, planningQuestionAction } from "../travel-agent-pi-package/src/host/travel-decision-policy.ts";
import { selectReadyRuns } from "../travel-agent-pi-package/src/host/execution-scheduling.ts";

test("complete planning continues from ordinary Chinese requests while preserving negation", () => {
  assert.equal(completePlanningRequested("去上海，请做完整行程"), true);
  assert.equal(completePlanningRequested("先比较酒店，不需要完整行程"), false);
  assert.equal(completePlanningRequested("只比较预算"), false);
  assert.equal(completePlanningRequested("做完整行程，算了，先只比较候选"), false);
  assert.equal(completePlanningRequested("做完整行程。先不要做完整行程，只比较候选"), false);
  assert.equal(completePlanningRequested("只比较候选。现在做完整行程，不要替我确认"), true);
  assert.equal(completePlanningRequested("做完整行程。2026年10月15日"), true);
});

test("confidence cannot authorize a locked change or turn missing evidence into a fact", () => {
  assert.equal(decideTravelAdvance({ hardConflicts: ["locked_hotel"], confidence: 1, calibrated: true }).type, "ask_user");
  assert.equal(decideTravelAdvance({ missingFacts: ["opening_hours"], canRead: true, confidence: 1, calibrated: true }).type, "execute_read");
  assert.equal(decideTravelAdvance({ confidence: 1, calibrated: false }).type, "delegate_parent");
  assert.equal(decideTravelAdvance({ deterministic: true, draftReady: true }).type, "deliver");
  assert.equal(decideTravelAdvance({ confidence: .97, threshold: .95, calibrated: true, reversible: true }).type, "revise_draft");
});

test("provider evidence gaps stay with Parent while personal facts and real budget tradeoffs can be asked", () => {
  const unknown = { code: "traveler_step_free_route_unverified", severity: "blocking", resolution: "provider_evidence", message: "入口设施未知", stopIds: [], dayIndex: null };
  assert.equal(planningQuestionAction({ missingPersonalFact: false, issues: [unknown] }), "continue_parent");
  assert.equal(planningQuestionAction({ missingPersonalFact: true, issues: [unknown] }), "ask_user");
  assert.equal(planningQuestionAction({ missingPersonalFact: false, issues: [unknown, { ...unknown, code: "trip_budget_exceeded", resolution: "plan_change" }] }), "ask_user");
  assert.equal(planningQuestionAction({ missingPersonalFact: false, providerUnavailable: true }), "continue_parent");
});

test("short interactions and continuations share slots 2:1, borrow idle capacity, and age fairly", () => {
  const ready = Array.from({ length: 12 }, (_, i) => ({ runId: `run_${i}`, userId: `user_${i}`, queueClass: i < 8 ? "interactive" : "continuation", updatedAt: 1000 }));
  const result = selectReadyRuns(ready, 9, 0, 1500);
  assert.equal(result.runs.filter(run => run.queueClass === "interactive").length, 6);
  assert.equal(result.runs.filter(run => run.queueClass === "continuation").length, 3);
  assert.equal(selectReadyRuns(ready.slice(8), 4, 0, 1500).runs.length, 4);
  assert.equal(selectReadyRuns([{ ...ready[9], updatedAt: 0 }, ready[0]], 1, 0, 11000).runs[0].runId, ready[9].runId);
});

test("stable questions reject stale facts and invalid options; text remains an answer rather than authorization", () => {
  const facts = { tripId: "trip_a", brief: { destination: "杭州" }, revision: 1 };
  const question = createTravelQuestion({ runId: "run_one", questionId: "q_one", question: "预算包含往返机票吗？", choices: ["包含", "不包含"], optionImpacts: ["住宿和活动共用剩余预算", "机票单列，不占目的地预算"], facts });
  const answer = { runId: "run_one", questionId: "q_one", optionId: question.options[1].optionId };
  assert.equal(validateTravelAnswer(question, answer, facts).text, "不包含");
  assert.equal(question.options[1].impact, "机票单列，不占目的地预算");
  assert.throws(() => validateTravelAnswer(question, { ...answer, optionId: "wrong" }, facts), { code: "question_option_invalid" });
  assert.throws(() => validateTravelAnswer(question, answer, { ...facts, brief: { destination: "上海" } }), { code: "question_stale" });
  assert.equal(validateTravelAnswer(question, { runId: "run_one", questionId: "q_one" }, facts, "预算只包括酒店").text, "预算只包括酒店");
  assert.equal(decisionHash({ b: 2, a: 1 }), decisionHash({ a: 1, b: 2 }));
});

test("ranking preserves every candidate and retains current order for unresolved or tied judgments", () => {
  const candidates = [{ candidateId: "named" }, { candidateId: "b" }, { candidateId: "c" }];
  assert.deepEqual(rankDecisionCandidates(candidates, [{ candidateId: "b", fit: 3, support: "unknown", eligible: false }]).map(x => x.candidateId), ["named", "b", "c"]);
  const ranked = rankDecisionCandidates(candidates, [{ candidateId: "c", fit: 3, support: "supported", eligible: true }]);
  assert.deepEqual(ranked.map(x => x.candidateId), ["c", "named", "b"]);
});

test("planning context retains locked and named choices beyond its ordinary budget and keeps domain coverage", () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ nodeId: `node_${i}`, title: `地点${i}`, domain: ["play", "food", "stay", "transport"][Math.floor(i / 10)] }));
  nodes[38].selected = true; nodes[38].lock = { reason: "user" };
  const context = selectPlanningContext(nodes, { objective: "请保留地点39，完成规划" });
  assert.equal(context.length, 24);
  assert.ok(context.includes(nodes[38])); assert.ok(context.includes(nodes[39]));
  assert.equal(new Set(context.map(node => node.domain)).size, 4);
  const allLocked = nodes.map(node => ({ ...node, lock: { reason: "user" } }));
  assert.equal(selectPlanningContext(allLocked).length, 40);
});
