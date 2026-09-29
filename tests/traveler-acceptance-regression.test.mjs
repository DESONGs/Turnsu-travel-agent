import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { TravelService } from "../src/api/travel-service.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { planningProvider, planningResponse } from "./fixtures/jev-planning.mjs";

const tool = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "traveler-behavior-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = planningProvider();
  const research = provider.research.bind(provider);
  provider.research = async input => { const result = await research(input); result.byDomain = Object.fromEntries(Object.entries(result.byDomain).filter(([domain]) => input.domains.includes(domain))); return result; };
  const service = new TravelService({ store: new TripStore({ rootDir: join(root, "trips") }), researchProvider: provider, planningRunCoordinator: createTravelAnalysisRunCoordinator() });
  const faux = fauxProvider({ provider: "fixture-traveler", models: [{ id: "parent" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const agent = new TravelConversationAgent({ travelService: service, conversationRepository: new FileConversationRepository({ rootDir: join(root, "conversations") }), modelRuntime: { models, model: faux.getModel("parent") } });
  const conversation = await agent.createConversation({ userId: "traveler" });
  const reply = (text, extra = {}) => agent.reply({ conversationId: conversation.conversationId, userId: "traveler", text, ...extra });
  return { service, provider, faux, reply };
}

test("only-hotel comparison produces only hotel candidates on a new trip", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", travelerCount: 1, totalBudget: 3000 }),
    tool("research_trip_options", { question: "只比较安静酒店", domains: ["stay"] }),
    fauxAssistantMessage("酒店候选已放入方案。"),
  ]);
  const result = await f.reply("只比较酒店，不要完整行程，也不要餐厅或景点。");
  const plan = await f.service.getTripPlanView(result.tripId);
  const domains = [...new Set(plan.pendingProposals.flatMap(p => Object.entries(p.byDomain).filter(([, nodes]) => nodes.length).map(([domain]) => domain)))];
  assert.deepEqual(domains, ["stay"]);
});

test("Parent receives the checked draft and delivers the actual business tradeoff instead of being terminated", async t => {
  const f = await fixture(t);
  let reviewed = false;
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 6000 }),
    tool("research_trip_options", { question: "安静室内优先的一天行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), context => planningResponse(context),
    context => {
      assert.equal(context.messages.at(-1).toolName, "plan_itinerary_trial");
      const checked = JSON.parse(context.messages.at(-1).content[0].text);
      assert.deepEqual(checked.route.modes, ["taxi"], "handoff must name observed route modes, not infer them from preferred modes");
      assert.equal(checked.route.source, "fixture", "source identity survives the real tool boundary");
      assert.ok(checked.route.checkedAt);
      assert.ok(checked.route.accessibility.every(leg => leg.stepFreeContinuity === "not_verified"));
      assert.ok(checked.route.caveats.includes("Controlled fixture, not a real route"));
      reviewed = true;
      return fauxAssistantMessage("已核对草案。先安排室内活动，再顺路用餐；第二家活动更热闹，作为备选保留。路线时间是查询时估算，采用不代表预订。");
    },
  ]);
  const result = await f.reply("帮我做一天的完整行程，偏好安静室内活动。不要确认。");
  assert.equal(reviewed, true, "a successful tool result is input to Parent, not permission to end its task");
  assert.match(result.conversation.messages.at(-1).text, /第二家活动更热闹/);
});

test("asking the assistant to choose suitable draft candidates does not become a confirmation command", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 6000, requestedWork: "complete_itinerary" }),
    tool("research_trip_options", { question: "预算内比较并自动选择可撤销草案", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), context => planningResponse(context), fauxAssistantMessage("已选择适合的草案组合，尚未采用。"),
  ]);
  const result = await f.reply("你比较并选择合适的酒店、两顿饭、游玩和高铁，排好完整草案。不要确认或购买。");
  assert.equal(result.itineraryTrial?.status, "trial_ready", JSON.stringify(result));
  assert.equal((await f.service.getTripControlView(result.tripId)).nodes.length, 0);
});

test("fresh reads after a repair remain available and do not force a generic research completion", async t => {
  const f = await fixture(t);
  let delivered = false;
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 6000 }),
    tool("research_trip_options", { question: "完整的一天行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), tool("get_trip_plan_view", {}), tool("get_trip_plan_view", {}),
    context => planningResponse(context),
    context => { delivered = true; return fauxAssistantMessage("已重新读取最新候选并核验，完整草案可供审阅，尚未采用。"); },
  ]);
  const result = await f.reply("做完整一天草案，不要确认。");
  assert.equal(delivered, true);
  assert.equal(result.itineraryTrial?.status, "trial_ready");
  assert.match(result.conversation.messages.at(-1).text, /完整草案可供审阅/);
});

test("exhausting the total tool budget reports unfinished work instead of a successful fallback", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海" }),
    ...Array.from({ length: 12 }, () => tool("get_trip_control_view", {})),
  ]);
  const result = await f.reply("先记录去上海的想法，查看当前要求，不做规划。");
  assert.equal(result.status, "agent_failed");
  assert.equal(result.code, "travel_agent_tool_budget_exhausted");
  assert.match(result.conversation.messages.at(-1).text, /没有处理完成/);
});

test("an undecided traveler is asked one destination question instead of three bundled facts", async t => {
  const f = await fixture(t);
  f.faux.setResponses([tool("ask_travel_question", { question: "去哪座城市，哪天出发，一共几位？", impact: "目的地、日期、人数影响安排。" })]);
  const result = await f.reply("想出去玩几天，帮我安排一下。");
  assert.equal(result.status, "needs_context");
  assert.doesNotMatch(result.question.question, /哪天|几位|人数|日期/);
  assert.match(result.question.question, /城市|目的地/);
});

test("a missing departure date is resolved before asking about arrival preferences", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", origin: "杭州", travelerCount: 1, totalBudget: 6000 }),
    tool("ask_travel_question", { question: "你想几点到上海？", choices: ["上午", "中午"] }),
  ]);
  const result = await f.reply("请做完整行程，出发日期还没定。");
  assert.match(result.question.question, /日期|哪天/);
  assert.doesNotMatch(result.question.question, /几点|到上海/);
});

test("unknown family size does not discard the destination, dates or budget already provided", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", partyProfile: "和家人", totalBudget: 6000 }),
    tool("ask_travel_question", { question: "包括你在内一共几位同行？" }),
  ]);
  const result = await f.reply("10月15日和家人去上海，总预算6000，做完整行程。");
  assert.ok(result.tripId, "known facts must survive the necessary question");
  const saved = await f.service.getTripControlView(result.tripId);
  assert.equal(saved.brief.destination, "上海");
  assert.equal(saved.brief.totalBudget, 6000);
  assert.equal(saved.travelers.length, 0, "unknown group size is not one traveler");
  assert.match(result.question.question, /几位|人数/);
});

test("answering a planning question continues to a checked draft even if the model stops after saving", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", origin: "杭州", durationDays: 1, travelerCount: 1, totalBudget: 6000 }),
    tool("ask_travel_question", { question: "哪天出发？" }),
    tool("save_trip_understanding", { dates: "2026-10-15" }),
    fauxAssistantMessage("日期已记下。"),
    tool("research_trip_options", { question: "完成原来的一天行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}),
    context => planningResponse(context),
    fauxAssistantMessage("草案已生成。"),
  ]);
  const first = await f.reply("请做完整的一天行程，出发日期还没定。");
  assert.equal(first.status, "needs_context");
  const result = await f.reply("2026年10月15日", { continuationObjective: "请做完整的一天行程，出发日期还没定。" });
  assert.equal(result.itineraryTrial?.status, "trial_ready", JSON.stringify(result));
  const plan = await f.service.getTripPlanView(result.tripId);
  assert.ok(plan.itineraryTrial?.accept);
});

test("a budget-only update gives Parent adopted facts and preserves its explanation of the remaining budget", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 6000 }),
    tool("research_trip_options", { question: "完整的一天行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), context => planningResponse(context), fauxAssistantMessage("核验完成，草案待采用。"),
  ]);
  const first = await f.reply("请做完整的一天行程。");
  assert.equal(first.itineraryTrial?.status, "trial_ready");
  const accepted = await f.service.acceptTripChange({ tripId: first.tripId, ...first.itineraryTrial.accept });
  assert.equal(accepted.status, "committed");
  let receivedAdoptedFacts = false;
  f.faux.setResponses([tool("save_trip_understanding", { totalBudget: 3000 }), tool("estimate_costs", {}), context => {
    const receipt = [...context.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "estimate_costs");
    const result = JSON.parse(receipt.content.find(item => item.type === "text").text);
    assert.equal(result.selectedCount, 4);
    assert.equal(result.budget.totalBudget, 3000);
    const facts = JSON.parse(context.systemPrompt.match(/<current-travel-facts>([\s\S]*?)<\/current-travel-facts>/)[1]);
    assert.equal(facts.travelerCount, 1);
    assert.deepEqual(facts.adoption.route.modes, ["taxi"]);
    receivedAdoptedFacts = true;
    return fauxAssistantMessage("预算已改成3000元，4项已采用安排保留，费用没有重新粗估。余量仍足够，不需要重排或再次确认。");
  }]);
  const result = await f.reply("只把预算改成3000，保留已采用安排。");
  assert.equal(receivedAdoptedFacts, true);
  assert.match(result.conversation.messages.at(-1).text, /4项已采用安排保留/);
  assert.match(result.conversation.messages.at(-1).text, /余量仍足够，不需要重排或再次确认/);
  assert.equal((await f.service.getTripControlView(first.tripId)).nodes.length, 4);
  f.faux.setResponses([
    tool("save_trip_understanding", { travelerProfiles: [{ travelerId: "traveler_1", displayName: "你", careNeeds: { mobility: { stepFreeRequired: true } } }] }),
    context => {
      const facts = JSON.parse(context.systemPrompt.match(/<current-travel-facts>([\s\S]*?)<\/current-travel-facts>/)[1]);
      assert.equal(facts.adoption.route.status, "needs_context");
      assert.deepEqual(facts.adoption.route.modes, [], "invalidated route preferences are not current observed modes");
      assert.ok(facts.adoption.itinerary.stops.length > 0);
      return fauxAssistantMessage("新要求已保存，原站序保留供对照，原路线需要重新核验。暂不重排。");
    },
  ]);
  await f.reply("只更新为必须全程无台阶，先别重排。");
});

test("unknown accessibility evidence stays with Parent through native compaction and argument correction", async t => {
  const f = await fixture(t);
  let rejectionReviewed = false;
  let correctedPlan;
  let responseIndex = 0;
  let compactions = 0;
  const responses = [
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 6000, travelerProfiles: [{ travelerId: "traveler_1", displayName: "你", careNeeds: { mobility: { stepFreeRequired: true } } }] }),
    tool("research_trip_options", { question: "核验全程无台阶的一天行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), context => planningResponse(context),
    tool("ask_travel_question", { question: "无台阶仍缺证据，你希望怎么补？", choices: ["你提供已知场所", "我继续找", "你到店前自行确认"] }),
    context => {
      const receipt = JSON.parse(context.messages.at(-1).content[0].text);
      assert.equal(receipt.status, "question_not_actionable");
      rejectionReviewed = true;
      return tool("research_trip_options", { question: "只补查现有候选的入口台阶、电梯与连续无台阶来源", domains: ["play", "food", "stay", "transport"] });
    },
    tool("get_trip_plan_view", {}), context => {
      const result = planningResponse(context);
      const args = result.content.find(block => block.type === "toolCall").arguments;
      args.attempt = 2;
      correctedPlan = structuredClone(args);
      args.evidenceRefs = ["invented:reference"];
      // Exercise the real compaction boundary before the rejected input is
      // corrected, rather than relying on the fixture's incidental byte size.
      result.usage.input = 34_000;
      return result;
    },
    context => {
      assert.equal(JSON.parse(context.messages.at(-1).content[0].text).status, "input_rejected");
      assert.match(JSON.stringify(context.messages), /无台阶/);
      return tool("plan_itinerary_trial", correctedPlan);
    },
    fauxAssistantMessage("我补查了场所入口和连续通路，仍没有可核验依据。已保留最新草案供查看，尚不能采用；全程无台阶要求保持不变。"),
  ];
  f.faux.setResponses(Array.from({ length: responses.length + 4 }, () => context => {
    if (!context.tools?.length) {
      compactions++;
      assert.match(JSON.stringify(context.messages), /无台阶/);
      return fauxAssistantMessage("用户要上海一天完整草案，必须全程无台阶，不得擅自放宽。已补查公开设施资料，未知仍是未知；不要让用户证明公开设施。保留当前草案和工具回执，修正参数后继续核验，不重复业务写入。采用尚未授权。");
    }
    const response = responses[responseIndex++];
    assert.ok(response, "unexpected additional business model call");
    return typeof response === "function" ? response(context) : response;
  }));
  const result = await f.reply("做一天完整行程，必须全程无台阶，未知的地方请你查，不要让我证明设施。");
  assert.equal(rejectionReviewed, true);
  assert.ok(compactions >= 1, "the repair resumes after native summary generation");
  assert.equal(responseIndex, responses.length);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.question, undefined);
  assert.equal(result.itineraryTrial?.feasibility?.canConfirm, false);
  assert.equal(result.agentTrace.planningCallCount, 2, "argument correction does not consume an extra business repair");
  assert.match(result.conversation.messages.at(-1).text, /我补查了/);
  assert.ok((await f.service.getTripPlanView(result.tripId)).itineraryTrial?.itinerary?.stops.length > 0);
});

test("a budget decision uses the whole-trip ledger rather than model-authored subtotals", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    tool("save_trip_understanding", { destination: "上海", dates: "2026-10-15", durationDays: 1, travelerCount: 1, totalBudget: 100 }),
    tool("research_trip_options", { question: "预算100内的完整行程", domains: ["play", "food", "stay", "transport"] }),
    tool("get_trip_plan_view", {}), context => planningResponse(context),
    tool("ask_travel_question", { question: "四人只需400元，你要加预算吗？", choices: ["提高到400元即可全部满足", "删去酒店"] }),
  ]);
  const result = await f.reply("一天完整行程100元，包含酒店、交通、餐食和游玩；不要默默删要求或增加预算。");
  assert.equal(result.status, "needs_context");
  const total = result.itineraryTrial.impact.budget.estimated;
  assert.ok(total > 400, "the whole-trip estimate includes local mobility");
  assert.match(result.question.question, new RegExp(String(total)));
  assert.doesNotMatch(JSON.stringify(result.question), /四人|400元即可|删去酒店/);
  assert.equal((await f.service.getTripControlView(result.tripId)).brief.totalBudget, 100, "displaying an option grants no write permission");
});
