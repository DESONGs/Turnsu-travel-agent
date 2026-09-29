import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { runJourneyAction } from "../src/web/journey-interaction.js";

// Exercise the real event-handler bodies without pretending this is React or
// browser rendering coverage. Native layout is verified separately.
const source = await readFile(new URL("../src/web/travel-app.jsx", import.meta.url), "utf8");
test("trying a place preserves other choices and never navigates away from comparison", () => {
  const state = {
    selections: { stay: "hotel-a" }, agentTrial: null, loading: false, clearedAgentTrial: false,
    onClearAgentTrial: () => { state.clearedAgentTrial = true; },
    onMobileViewChange: () => { throw new Error("selection must not navigate"); },
    window: { matchMedia: () => ({ matches: true }) },
    setSelections: (update) => { state.selections = update(state.selections); },
  };
  const start = source.indexOf("  const selectCandidate =", source.indexOf("function PlanCanvas("));
  const end = source.indexOf("  const liveDetailNode =", start);
  const select = vm.runInNewContext(source.slice(start, end) + "; selectCandidate;", state);
  select("play", "museum");
  assert.equal(state.selections.stay, "hotel-a");
  assert.equal(state.selections.play, "museum");
  select("play", null);
  assert.equal(state.selections.stay, "hotel-a");
  assert.equal(state.selections.play, undefined);
  state.loading = true;
  select("stay", "stale-hotel");
  assert.equal(state.selections.stay, "hotel-a");
});

test("route confirmation needs current positive feasibility and is not submitted while busy", () => {
  const calls = [];
  const state = { previewModel: { agentTrial: null, routeCanConfirm: false, activeSelections: { stay: "hotel" }, previewId: "preview", routeModes: {} },
    proposal: { proposalId: "proposal" }, plan: { revision: 2 }, loading: false,
    onAcceptProposal: (...args) => calls.push(args),
  };
  const start = source.indexOf("  const confirmDraft =", source.indexOf("function PlanCanvas("));
  const end = source.indexOf('  return <section className="atlas-canvas"', start);
  const confirm = vm.runInNewContext(source.slice(start, end) + "; confirmDraft;", state);
  confirm();
  assert.equal(calls.length, 0);
  state.previewModel.routeCanConfirm = true;
  state.loading = true;
  confirm();
  assert.equal(calls.length, 0);
  state.loading = false;
  confirm();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].previewId, "preview");
  assert.equal(calls[0][2].baseRevision, 2);
});

test("candidate analysis topics are not promoted to verified budget, route or independent-source claims", () => {
  const start = source.indexOf("function candidateReasonChips(");
  const end = source.indexOf("function BudgetBoard(", start);
  const chips = vm.runInNewContext(source.slice(start, end) + "; candidateReasonChips;");
  const result = chips({ sourceRefs: ["same-provider:a", "same-provider:b"], operability: { semanticAnalysis: { reasons: [
    { reasonCode: "budget_pending", evidenceRefs: ["price"] },
    { reasonCode: "route_context", evidenceRefs: ["address"] },
    { reasonCode: "inventory_missing", evidenceRefs: ["provider"] },
  ] } } }, (zh) => zh);
  assert.deepEqual(Array.from(result), ["价格资料可比较", "动线需结合试排核验", "库存仍需核验"]);
  assert.doesNotMatch(result.join(" "), /预算匹配已核验|动线与执行条件已比较|独立来源/);
});
function editor(api) {
  const state = {
    api, runJourneyAction, pick: (zh) => zh, messageError: (error) => error.message,
    conversation: { conversationId: "chat-1" }, trip: { tripId: "trip-1" },
    selectedModelId: "test-model", providerStatus: null,
    draft: "原始需求", imageAttachment: { mimeType: "image/jpeg", data: "test-only" },
    status: {}, pendingSync: null, failedDraft: null, agentTrial: null,
    actionInFlight: { current: false }, requestSequenceRef: { current: 0 }, executionWatchRef: { current: null }, pendingCommandRef: { current: null }, executionView: null,
    AbortController, crypto: { randomUUID },
    refreshConversations: async () => {}, loadTrip: async () => true,
  };
  for (const name of ["Conversation", "SelectedModelId", "Draft", "DraftContext", "ImageAttachment", "MediaStatus", "Status", "PendingText", "PendingSync", "FailedDraft", "PlanningRequestActive", "AgentTrial", "ExecutionView"]) {
    const key = name[0].toLowerCase() + name.slice(1);
    state["set" + name] = (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  }
  const context = vm.createContext(state);
  for (const [name, next] of [["submitMessage", "acceptProposal"], ["acceptProposal", "rejectProposal"], ["retryJourneySync", "restoreFailedDraft"]]) {
    const start = source.indexOf("  const " + name + " =");
    const end = source.indexOf("  const " + next + " =", start);
    assert.ok(start > 0 && end > start);
    vm.runInContext(source.slice(start, end) + "\nglobalThis." + name + " = " + name + ";", context);
  }
  return state;
}

test("web send failure keeps text and attachment added during the wait", async () => {
  let fail;
  const page = editor({ sendConversationMessage: () => new Promise((_, reject) => { fail = reject; }) });
  const pending = page.submitMessage("原始需求");
  page.setDraft("新的补充");
  page.setImageAttachment({ data: "new-photo" });
  fail(new Error("network unavailable"));
  await pending;
  assert.equal(page.draft, "新的补充");
  assert.equal(page.imageAttachment.data, "new-photo");
  assert.equal(page.failedDraft.text, "原始需求");
  assert.equal(page.failedDraft.attachment.data, "test-only");
  assert.equal(page.actionInFlight.current, false);
});

test("web delivered message stays delivered through a failed read and read-only retry", async () => {
  let writes = 0;
  const page = editor({ sendConversationMessage: async () => {
    writes++;
    return { conversation: { conversationId: "chat-1", tripId: "trip-1", modelId: "test-model" } };
  } });
  page.loadTrip = async () => { throw new Error("read unavailable"); };
  await page.submitMessage("请规划");
  assert.equal(page.pendingSync.reason, "message");
  assert.equal(page.failedDraft, null);
  assert.equal(page.draft, "");
  await page.submitMessage("不应该重复发送");
  assert.equal(writes, 1);
  page.loadTrip = async () => true;
  await page.retryJourneySync();
  assert.equal(writes, 1);
  assert.equal(page.pendingSync, null);
});

test("an acknowledged run survives a disconnected view without becoming a new unsent draft", async () => {
  const page = editor({ sendConversationMessage: async (_conversation, _text, _model, _images, _planning, options) => {
    options.onProgress({ runId: "saved_run", status: "running" });
    throw Object.assign(new Error("connection lost"), { runId: "saved_run" });
  } });
  await page.submitMessage("继续规划");
  assert.equal(page.failedDraft, null);
  assert.equal(page.executionView.runId, "saved_run");
  assert.equal(page.executionView.connection, "offline");
});

test("a lost initial response reuses the same command after a new conversation was created", async () => {
  const ids = [];
  const page = editor({ createConversation: async () => ({ conversationId: "new_conversation" }), sendConversationMessage: async (_conversation, _text, _model, _images, _planning, options) => { ids.push(options.requestId); throw new Error("response lost"); } });
  page.conversation = null;
  await page.submitMessage("我的旅行需求");
  page.imageAttachment = page.failedDraft.attachment;
  page.failedDraft = null;
  await page.submitMessage("我的旅行需求");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("web confirmation remains committed after plan read failure and cannot be repeated", async () => {
  let commits = 0;
  const page = editor({ accept: async () => { commits++; return { status: "committed", mobility: { status: "completed" } }; } });
  page.loadTrip = async () => { throw new Error("read unavailable"); };
  await page.acceptProposal("p", { stay: "hotel" });
  assert.equal(page.pendingSync.reason, "confirmation");
  assert.equal(page.status.error, undefined);
  await page.acceptProposal("p", { stay: "hotel" });
  assert.equal(commits, 1);
});

test("web noncommitted response is never shown as a saved confirmation", async () => {
  const page = editor({ accept: async () => ({ status: "needs_rebase" }) });
  await page.acceptProposal("p", { stay: "hotel" });
  assert.equal(page.pendingSync, null);
  assert.match(page.status.error, /needs_rebase/);
});

test("web route refresh failure still reloads the committed plan", async () => {
  let reads = 0;
  const page = editor({
    accept: async () => ({ status: "committed" }),
    refreshMobility: async () => { throw new Error("route unavailable"); },
  });
  page.loadTrip = async () => { reads++; return true; };
  await page.acceptProposal("p", { stay: "hotel" });
  assert.equal(reads, 1);
  assert.equal(page.pendingSync, null);
  assert.match(page.status.error, /安排已确认/);
});
