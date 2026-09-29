// Installed-SDK behavior only. Faux responses; no external API or business writes.
import assert from "node:assert/strict";
import { Agent } from "../../../../node_modules/@earendil-works/pi-agent-core/dist/index.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "../../../../node_modules/@earendil-works/pi-ai/dist/index.js";
import { Type } from "../../../../node_modules/typebox/build/index.mjs";

let sequence = 0;
function makeAgent(responses, options = {}) {
  const faux = fauxProvider({ provider: `context-probe-${++sequence}`, models: [{ id: "probe" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const calls = [];
  const agent = new Agent({
    ...options,
    initialState: { ...options.initialState, model: faux.getModel("probe") },
    streamFn: (model, context, streamOptions) => {
      calls.push({ systemPrompt: context.systemPrompt, tools: (context.tools ?? []).map(t => t.name), messages: structuredClone(context.messages) });
      return models.streamSimple(model, context, streamOptions);
    },
  });
  return { agent, calls };
}
const textOf = messages => JSON.stringify(messages);
const tool = (name, execute) => ({ name, label: name, description: "Read-only local probe", parameters: Type.Object({}), execute });
const collected = tool("collect_probe", async () => ({ content: [{ type: "text", text: "large evidence body" }], details: {} }));
const checked = tool("check_probe", async () => ({ content: [{ type: "text", text: "checked" }], details: {} }));
let prepareCalls = 0;
let transformCalls = 0;
const dynamic = makeAgent([
  fauxAssistantMessage([fauxToolCall("collect_probe", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("check_probe", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage("finished"),
], {
  initialState: { systemPrompt: "phase:collect", tools: [collected], messages: [{ role: "user", content: "old-parent-note", timestamp: 1 }] },
  transformContext: async messages => {
    transformCalls++;
    return messages.filter(message => !(message.role === "user" && message.content === "old-parent-note"));
  },
  afterToolCall: async ({ toolCall }) => toolCall.name === "collect_probe" ? { content: [{ type: "text", text: "evidence-ref:fixture-1" }] } : undefined,
  prepareNextTurnWithContext: async ({ context }) => {
    prepareCalls++;
    return { context: { ...context, systemPrompt: "phase:check", tools: [checked] } };
  },
});
await dynamic.agent.prompt("plan-fixture");
assert.deepEqual(dynamic.calls.map(call => call.tools), [["collect_probe"], ["check_probe"], ["check_probe"]]);
assert.equal(dynamic.calls[0].systemPrompt, "phase:collect");
assert.equal(dynamic.calls[1].systemPrompt, "phase:check");
assert.equal(dynamic.calls.some(call => textOf(call.messages).includes("old-parent-note")), false);
assert.equal(textOf(dynamic.agent.state.messages).includes("old-parent-note"), true);
assert.equal(textOf(dynamic.calls[1].messages).includes("large evidence body"), false);
assert.equal(textOf(dynamic.calls[1].messages).includes("evidence-ref:fixture-1"), true);

let forbiddenExecuted = false;
const denied = makeAgent([
  fauxAssistantMessage([fauxToolCall("forbidden_probe", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage("blocked"),
], {
  initialState: { tools: [tool("forbidden_probe", async () => { forbiddenExecuted = true; return { content: [], details: {} }; })] },
  beforeToolCall: async () => ({ block: true, reason: "role_denied" }),
});
await denied.agent.prompt("permission-fixture");
assert.equal(forbiddenExecuted, false);

const a = makeAgent([fauxAssistantMessage("result-A")]);
const b = makeAgent([fauxAssistantMessage("result-B")]);
await Promise.all([a.agent.prompt("shared-ref:S1 task:A private:A"), b.agent.prompt("shared-ref:S1 task:B private:B")]);
assert.equal(textOf(a.calls).includes("private:B"), false);
assert.equal(textOf(b.calls).includes("private:A"), false);

console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  sdk: "installed @earendil-works/pi-agent-core 0.84.1",
  scope: "Faux SDK hooks and request isolation only; not the proposed business handoff, token estimator, or commercial execution implementation.",
  modelRequestToolSets: dynamic.calls.map(call => call.tools),
  initialRequestUsesInitialState: dynamic.calls[0].systemPrompt === "phase:collect",
  prepareCalls, transformCalls,
  transformPrunesRequestButNotStoredAgentMessages: true,
  resultPostprocessingReachesNextModelRequest: true,
  blockedToolWasNotExecuted: !forbiddenExecuted,
  independentAgentsDoNotReceiveEachOthersMessages: true,
  agentStateToolsAfterLoop: dynamic.agent.state.tools.map(t => t.name),
}, null, 2));
