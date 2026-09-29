// Targeted live Parent QA. No HTTP/PG/Jev/capacity claim: travel facts are the
// existing explicit fixture and persistence uses an isolated local directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTravelRuntimeEnv } from "../src/http/runtime-env.mjs";
import { TravelConversationAgent } from "../src/agent/travel-conversation-agent.mjs";
import { TravelService } from "../src/api/travel-service.mjs";
import { FileConversationRepository } from "../src/persistence/conversation-repository.mjs";
import { TripStore } from "../travel-agent-pi-package/src/core/index.ts";
import { createTravelAnalysisRunCoordinator } from "../src/agent/travel-analysis-run-coordinator.mjs";
import { planningProvider } from "../tests/fixtures/jev-planning.mjs";
import { travelerBusinessCases } from "../tests/fixtures/traveler-business-cases.mjs";

if (process.env.TRAVEL_DELIVERY_LIVE !== "true") throw new Error("explicit_live_opt_in_required");
const env = await loadTravelRuntimeEnv();
if (!env.DEEPSEEK_API_KEY) throw new Error("project_parent_credentials_required");
const output = resolve(process.env.TRAVEL_DELIVERY_TEST_OUTPUT ?? `/tmp/travel-delivery-${Date.now()}`);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "travel-delivery-state-"));
const results = {
  scope: "Real configured Parent and product tools, fictional travel sources, isolated file persistence. No Jev, HTTP, PostgreSQL, browser, real route or capacity acceptance.",
  startedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(await Promise.all([
    "src/agent/travel-conversation-agent.mjs", "travel-agent-pi-package/src/host/travel-planning-delivery.ts", "tests/fixtures/traveler-business-cases.mjs",
  ].map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")]))),
  rows: [],
};
const selected = process.env.TRAVEL_DELIVERY_TEST_CASES?.split(",") ?? ["B04", "B03"];
const cases = travelerBusinessCases.filter(item => selected.includes(item.id) && ["B03", "B04"].includes(item.id));
assert.ok(cases.length, "a supported case must be selected");
try {
  for (const item of cases) {
    const row = { id: item.id, input: item.text, adjustment: item.adjustment, turns: [], checks: [], manualReview: "pending" };
    results.rows.push(row);
    const check = (name, ok) => row.checks.push({ name, passed: Boolean(ok) });
    const store = new TripStore({ rootDir: join(root, item.id, "trips") });
    const provider = planningProvider();
    const original = provider.research.bind(provider);
    provider.research = async input => {
      const result = await original(input);
      result.byDomain = Object.fromEntries(Object.entries(result.byDomain).filter(([domain]) => input.domains.includes(domain)));
      return result;
    };
    const service = new TravelService({ store, researchProvider: provider, planningRunCoordinator: createTravelAnalysisRunCoordinator() });
    const agent = new TravelConversationAgent({ travelService: service, env, conversationRepository: new FileConversationRepository({ rootDir: join(root, item.id, "conversations") }) });
    const userId = "delivery_qa";
    const conversation = await agent.createConversation({ userId });
    const reply = async text => {
      const started = Date.now();
      const result = await agent.reply({ conversationId: conversation.conversationId, userId, text });
      row.turns.push({ status: result.status, code: result.code ?? null, elapsedMs: Date.now() - started, reply: result.conversation.messages.at(-1).text,
        trial: result.itineraryTrial ?? null, question: result.question ?? null, trace: result.agentTrace ?? null, activities: result.activities });
      await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
      process.stdout.write(JSON.stringify({ id: item.id, turn: row.turns.length, status: result.status, elapsedMs: Date.now() - started }) + "\n");
      return result;
    };
    try {
      const first = await reply(item.text);
      assert.ok(first.itineraryTrial?.accept, "baseline draft must actually be adoptable");
      const adopted = await service.acceptTripChange({ tripId: first.tripId, ...first.itineraryTrial.accept });
      assert.equal(adopted.status, "committed");
      const before = await store.get(first.tripId);
      const changed = await reply(item.adjustment);
      const after = await store.get(first.tripId);
      const latest = await service.getTripPlanView(first.tripId);
      const copy = row.turns.at(-1).reply;
      check("调整仍由 Parent 完成交付", changed.status === "completed");
      check("没有不必要的问题卡", !changed.question);
      check("没有内部次数或泛泛收尾邀请", !/修复尝试|尝试.*用完|修复.*次数|核验.*只做.*次|如果你(?:愿意|需要|更想)|我还可以|再帮你|固定锚点/.test(copy));
      check("不把未知无障碍描述为更安全", !/(?:室内|打车).{0,24}(?:风险更低|更安全|保证无台阶)/.test(copy));
      check("预览不改变已采用选择", JSON.stringify(before.nodes.filter(n => n.selected).map(n => n.nodeId).sort()) === JSON.stringify(after.nodes.filter(n => n.selected).map(n => n.nodeId).sort()));
      if (item.id === "B03") {
        check("新增硬要求保留且失败草案不可采用", after.travelers.some(t => t.careNeeds?.mobility?.stepFreeRequired) && latest.itineraryTrial?.itinerary?.stops.length > 0 && !latest.itineraryTrial.accept);
        check("轮椅通路缺口仍明确", /无台阶|无障碍/.test(copy) && /未|缺|不能|尚/.test(copy));
      } else {
        const previous = before.environment.mobility.itinerary.stops;
        const stops = changed.itineraryTrial?.itinerary?.stops ?? [];
        const meals = rows => rows.filter(s => s.role === "meal").sort((a,b) => a.startAt.localeCompare(b.startAt));
        check("调整草案可采用", changed.itineraryTrial?.status === "trial_ready");
        check("酒店和晚餐替换，午餐保留", stops.find(s => s.role === "stay_check_in")?.nodeId !== previous.find(s => s.role === "stay_check_in")?.nodeId
          && meals(stops)[0]?.nodeId === meals(previous)[0]?.nodeId && meals(stops).at(-1)?.nodeId !== meals(previous).at(-1)?.nodeId);
      }
    } catch (error) { row.error = error.code ?? error.message; }
    row.automatedStatus = !row.error && row.checks.every(c => c.passed) ? "passed" : "failed";
    await writeFile(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  }
} finally { await rm(root, { recursive: true, force: true }); }
process.stdout.write(JSON.stringify({ output, results: results.rows.map(row => ({ id: row.id, status: row.automatedStatus })) }) + "\n");
if (results.rows.some(row => row.automatedStatus !== "passed")) process.exitCode = 1;
