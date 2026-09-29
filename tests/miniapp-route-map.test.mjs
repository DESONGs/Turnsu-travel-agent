import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const point = (longitude, latitude) => ({ longitude, latitude, coordinateSystem: "GCJ-02" });

function mobility(recommendedMode = "taxi") {
  return {
    status: "completed",
    checkedAt: "2026-08-31T08:00:00.000Z",
    itinerary: { days: [{ dayIndex: 1, date: "2026-10-15", stopIds: ["arrival", "stay"] }], stops: [{ stopId: "arrival", nodeId: "airport", dayIndex: 1 }, { stopId: "stay", nodeId: "hotel", dayIndex: 1 }] },
    travelerFit: { accessibilityEvidence: "partial" },
    legs: [{
      legId: "airport-hotel",
      origin: { stopId: "arrival", nodeId: "airport", label: "浦东 T2", dayIndex: 1, coordinates: point(121.8, 31.15) },
      destination: { stopId: "stay", nodeId: "hotel", label: "人民广场酒店", dayIndex: 1, coordinates: point(121.47, 31.23) },
      recommendedMode,
      rationale: "父亲单段步行不超过 600 米",
      alternatives: [
        { mode: "taxi", totalMinutes: 52, walkingMeters: 0, transfers: 0, estimatedFareCny: 151, polyline: [point(121.8, 31.15), point(121.47, 31.23)], steps: [{ kind: "taxi", instruction: "打车前往酒店" }], accessibilityFeatures: [] },
        { mode: "transit", totalMinutes: 110, walkingMeters: 420, transfers: 1, estimatedFareCny: 8, polyline: [point(121.8, 31.15), point(121.65, 31.2), point(121.47, 31.23)], steps: [{ kind: "ride", line: "地铁 2 号线", instruction: "浦东机场上车，人民广场下车" }], accessibilityFeatures: [] },
      ],
    }],
  };
}

const control = { brief: { destination: "上海", dates: "2026-10-15 至 2026-10-17", totalBudget: 8_000 }, travelers: [{ travelerId: "father", displayName: "父亲", careNeeds: { mobility: { maxContinuousWalkMeters: 600, avoidStairs: true } } }] };
const plan = { revision: 3, pendingProposals: [], byDomain: { transport: [{ nodeId: "airport", domain: "transport", title: "浦东 T2", selected: true }], stay: [{ nodeId: "hotel", domain: "stay", title: "人民广场酒店", selected: true }], food: [], play: [] }, mobility: mobility(), budget: null };
const candidatePlan = {
  ...plan,
  pendingProposals: [{
    proposalId: "proposal-preview",
    byDomain: {
      transport: [],
      stay: [{
        nodeId: "hotel",
        domain: "stay",
        title: "人民广场酒店",
        summary: "靠近地铁与主要景点，适合带父母减少换乘。",
        selected: false,
        sourceId: "amap:hotel",
        media: [{ url: "https://example.com/hotel.jpg", source: "amap_web_service" }],
        price: { amount: 680, quality: "reference" },
        location: { coordinates: point(121.47, 31.23) },
        operability: { mappedFacilities: [{ label: "电梯" }, { label: "地铁近" }] },
      }],
      food: [],
      play: [],
    },
  }],
  byDomain: { transport: [{ nodeId: "airport", domain: "transport", title: "浦东 T2", selected: true }], stay: [], food: [], play: [] },
};

async function loadMiniPage(platform, request) {
  const filename = new URL(`../apps/miniapp/${platform}/pages/index/index.js`, import.meta.url);
  const source = await readFile(filename, "utf8");
  let page = null;
  vm.runInNewContext(source, { getApp: () => ({ request }), Page: (definition) => { page = definition; }, encodeURIComponent, Object, Array, Set, Map, Number, String, Promise, console, setTimeout, clearTimeout }, { filename: filename.pathname });
  const instance = { ...page, data: structuredClone(page.data), setData(values) { Object.assign(this.data, values); } };
  return instance;
}

for (const platform of ["wechat", "alipay"]) {
  test(`${platform} reconnects an accepted task without resending and preserves a draft written during the wait`, async () => {
    const calls = [];
    let disconnected = true;
    const completed = { runId: "run-1", conversationId: "chat-1", status: "completed", result: { conversation: { conversationId: "chat-1", tripId: null, messages: [{ text: "需求已经保存" }] } } };
    const page = await loadMiniPage(platform, async (path, options = {}) => {
      calls.push({ path, method: options.method || "GET", data: options.data });
      if (options.method === "POST") return { runId: "run-1", conversationId: "chat-1", status: "queued" };
      if (disconnected) throw { code: "network_unavailable" };
      if (path.endsWith("/runs")) return { runs: [completed] };
      throw new Error("unexpected request");
    });
    page.setData({ conversation: { conversationId: "chat-1" }, input: "原始需求" });
    await page.sendMessage();
    assert.equal(page.data.executionDisconnected, true);
    assert.equal(page.data.executionActive, true);
    assert.equal(page.data.failedText, "", "accepted work must not be offered for duplicate submission");
    page.onInput({ detail: { value: "等候时写下的补充" } });
    disconnected = false;
    await page.refreshExecution();
    assert.equal(calls.filter((item) => item.method === "POST").length, 1);
    assert.equal(page.data.execution.status, "completed");
    assert.equal(page.data.input, "等候时写下的补充");
    assert.equal(page.data.conversation.messages[0].text, "需求已经保存");
    assert.equal(page.data.loading, false);
  });

  test(`${platform} an uncertain submission reuses its idempotency key and cancellation does not resend`, async () => {
    const ids = [];
    let sends = 0;
    const page = await loadMiniPage(platform, async (path, options = {}) => {
      if (path.endsWith("/cancel")) return { runId: "run-1", conversationId: "chat-1", status: "cancelled", result: { conversation: { conversationId: "chat-1", tripId: null, messages: [] } } };
      if (options.method === "POST") {
        ids.push(options.data.requestId);
        if (++sends === 1) throw { code: "network_unavailable" };
        return { runId: "run-1", conversationId: "chat-1", status: "running" };
      }
      return { runId: "run-1", conversationId: "chat-1", status: "running" };
    });
    page.setData({ conversation: { conversationId: "chat-1" }, input: "上海三天" });
    await page.sendMessage();
    await page.sendMessage();
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    await page.stopExecution();
    assert.equal(page.data.execution.status, "cancelled");
    assert.equal(page.data.loading, false);
    assert.equal(sends, 2);
    page.onUnload();
  });

  test(`${platform} only reviews on explicit request, and review never commits the trip`, async () => {
    const calls = [];
    const page = await loadMiniPage(platform, async (path) => {
      calls.push(path);
      if (path.endsWith("/control")) return control;
      if (path.endsWith("/plan")) return candidatePlan;
      if (path.endsWith("/mobility/preview")) return { previewId: "reviewed", mobility: mobility(), feasibility: { canConfirm: true } };
      throw new Error("unexpected write: " + path);
    });
    await page.loadTrip("trip-1");
    page.setData({ activeView: "itinerary" });
    page.selectCandidate({ currentTarget: { dataset: { domain: "stay", nodeId: "hotel" } } });
    assert.equal(page.data.activeView, "itinerary");
    assert.equal(page.data.routeCanConfirm, false);
    assert.equal(calls.filter((path) => path.includes("/mobility/preview")).length, 0);
    await page.acceptProposal();
    assert.equal(calls.some((path) => path.endsWith("/accept")), false);
    await page.reviewDraft();
    assert.equal(page.data.activeView, "map");
    assert.equal(page.data.routePreviewId, "reviewed");
    assert.equal(page.data.routeCanConfirm, true);
    assert.equal(calls.filter((path) => path.includes("/mobility/preview")).length, 1);
    assert.equal(calls.some((path) => path.endsWith("/accept")), false);
    page.selectCandidate({ currentTarget: { dataset: { domain: "stay", nodeId: "hotel" } } });
    assert.equal(page.data.routeCanConfirm, false);
    assert.equal(page.data.routePreviewId, null);
  });
  test(`${platform} failed review retains the choice and blocks confirmation`, async () => {
    const page = await loadMiniPage(platform, async () => { throw new Error("source unavailable"); });
    page.setData({ trip: { tripId: "trip-1" }, selectedCount: 1, proposalDomains: [{ key: "stay", candidates: [{ nodeId: "hotel", selected: true }] }] });
    await page.reviewDraft();
    assert.equal(page.data.proposalDomains[0].candidates[0].selected, true);
    assert.equal(page.data.routeCanConfirm, false);
    assert.equal(page.data.routeSwitching, false);
    assert.match(page.data.routeBlocker, /候选已保留/);
  });
  test(`${platform} redesigned native template has balanced elements and implemented event handlers`, async () => {
    const extension = platform === "wechat" ? "wxml" : "axml";
    const source = await readFile(new URL(`../apps/miniapp/${platform}/pages/index/index.${extension}`, import.meta.url), "utf8");
    const page = await loadMiniPage(platform, async () => ({}));
    for (const match of source.matchAll(/(?:bind\w+|catch\w+|on[A-Z]\w*)="([A-Za-z]\w*)"/g)) assert.equal(typeof page[match[1]], "function", match[1]);
    const stack = [];
    const markup = source.replace(/\{\{[\s\S]*?\}\}/g, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const match of markup.matchAll(/<(\/)?([a-z][\w-]*)\b[^>]*?(\/?)>/g)) {
      if (match[1]) assert.equal(stack.pop(), match[2], `closing ${match[2]}`);
      else if (!match[3]) stack.push(match[2]);
    }
    assert.deepEqual(stack, []);
  });

  test(`${platform} does not mistake a noncommitted HTTP result for confirmation`, async () => {
    let requests = 0;
    const page = await loadMiniPage(platform, async () => { requests++; return { status: "needs_rebase" }; });
    page.setData({ trip: { tripId: "trip-1" }, routePreviewId: "checked-preview", routeCanConfirm: true, proposal: { proposalId: "p" }, proposalDomains: [{ key: "stay", candidates: [{ nodeId: "hotel", selected: true }] }] });
    await page.acceptProposal();
    assert.equal(requests, 1);
    assert.equal(page.data.proposal.proposalId, "p");
    assert.equal(page.data.tripRefreshNeeded, false);
    assert.doesNotMatch(page.data.notice, /已确认/);
  });

  test(`${platform} does not draw corrupt coordinates or connect across missing route points`, async () => {
    const brokenPlan = structuredClone(plan);
    brokenPlan.mobility.legs[0].origin.coordinates = { longitude: null, latitude: null };
    brokenPlan.mobility.legs[0].alternatives[0].polyline.splice(1, 0, { longitude: null, latitude: null });
    const page = await loadMiniPage(platform, async (path) => path.endsWith("/control") ? control : brokenPlan);
    await page.loadTrip("trip-1");
    assert.equal(page.data.polylines.length, 0);
    assert.equal(page.data.routeDrawable, false);
    assert.equal(page.data.markers.length, 1);
  });

  test(`${platform} cancels a first draft and clears the previous route preview`, async () => {
    const page = await loadMiniPage(platform, async (path) => path.endsWith("/control") ? control : candidatePlan);
    await page.loadTrip("trip-1");
    const event = { currentTarget: { dataset: { domain: "stay", nodeId: "hotel" } } };
    page.selectCandidate(event);
    assert.equal(page.data.selectedCount, 1);
    page.setData({ routePreviewId: "stale-route", mobility: null, routeModes: { "airport-hotel": "transit" }, polylines: [] });
    page.selectCandidate(event);
    assert.equal(page.data.selectedCount, 0);
    assert.equal(page.data.proposalDomains[0].candidates[0].selected, false);
    assert.equal(page.data.routePreviewId, null);
    assert.equal(page.data.nextLeg.mode, "taxi");
    assert.equal(page.data.polylines.length, 1);
  });

  test(`${platform} failed send preserves newly typed text and offers the original draft`, async () => {
    let rejectSend;
    const page = await loadMiniPage(platform, () => new Promise((resolve, reject) => { rejectSend = reject; }));
    page.setData({ conversation: { conversationId: "chat-1" }, input: "原始旅行需求" });
    const sending = page.sendMessage();
    assert.equal(page.data.pendingText, "原始旅行需求");
    page.onInput({ detail: { value: "等待时新写的补充" } });
    rejectSend({ code: "network_unavailable" });
    await sending;
    assert.equal(page.data.input, "等待时新写的补充");
    assert.equal(page.data.failedText, "原始旅行需求");
    page.restoreFailedDraft();
    assert.equal(page.data.input, "等待时新写的补充");
    page.onInput({ detail: { value: "" } });
    page.restoreFailedDraft();
    assert.equal(page.data.input, "原始旅行需求");
    assert.equal(page.data.loading, false);
  });

  test(`${platform} sent message followed by a failed plan read is not offered for resend`, async () => {
    const page = await loadMiniPage(platform, async (path) => {
      if (path.endsWith("/runs")) return { runId: "run-1", conversationId: "chat-1", status: "completed", result: { conversation: { conversationId: "chat-1", tripId: "trip-1", messages: [{ text: "已保存" }] } } };
      throw { code: "network_unavailable" };
    });
    page.setData({ conversation: { conversationId: "chat-1" }, input: "请规划大理" });
    await page.sendMessage();
    assert.equal(page.data.input, "");
    assert.equal(page.data.tripRefreshNeeded, true);
    assert.match(page.data.notice, /消息已发送/);
  });

  test(`${platform} commit success followed by a read failure cannot trigger a duplicate confirmation`, async () => {
    let commits = 0;
    const page = await loadMiniPage(platform, async (path, options) => {
      if (path.endsWith("/accept")) { commits++; assert.equal(options.data.baseRevision, 3); return { status: "committed" }; }
      throw { code: "network_unavailable" };
    });
    page.setData({ trip: { tripId: "trip-1" }, planRevision: 3, routePreviewId: "checked-preview", routeCanConfirm: true, proposal: { proposalId: "proposal-1" }, proposalDomains: [{ key: "stay", candidates: [{ nodeId: "hotel", selected: true }] }] });
    await page.acceptProposal();
    assert.equal(commits, 1);
    assert.equal(page.data.tripRefreshNeeded, true);
    assert.equal(page.data.proposal, null);
    assert.match(page.data.notice, /已确认.*暂未刷新/);
    await page.acceptProposal();
    assert.equal(commits, 1);
  });

  test(`${platform} blocks selection and confirmation during route recomputation`, async () => {
    const page = await loadMiniPage(platform, async () => { throw new Error("no requests allowed"); });
    page.setData({ routeSwitching: true, trip: { tripId: "trip-1" }, proposal: { proposalId: "p" }, proposalDomains: [{ key: "stay", candidates: [{ nodeId: "hotel", selected: false }] }] });
    page.selectCandidate({ currentTarget: { dataset: { domain: "stay", nodeId: "hotel" } } });
    assert.equal(page.data.proposalDomains[0].candidates[0].selected, false);
    await page.acceptProposal();
  });

  test(`${platform} preserves an unsent draft when history requests a new trip`, async () => {
    const page = await loadMiniPage(platform, async () => { throw new Error("draft must be preserved"); });
    page.setData({ input: "尚未发送的需求", conversation: { conversationId: "old-chat" } });
    await page.openConversation({ currentTarget: { dataset: {} } });
    assert.equal(page.data.conversation.conversationId, "old-chat");
    assert.equal(page.data.input, "尚未发送的需求");
  });
}

for (const platform of ["wechat", "alipay"]) {
  test(`${platform} opens a lightweight place preview and only stages selection locally`, async () => {
    const calls = [];
    const page = await loadMiniPage(platform, async (path, options = {}) => {
      calls.push({ path, options });
      if (path.endsWith("/control")) return control;
      if (path.endsWith("/plan")) return candidatePlan;
      throw new Error(`unexpected ${path}`);
    });
    await page.loadTrip("trip-shanghai");
    assert.equal(page.data.proposalDomains[0].key, "stay");
    page.openPlacePreview({ currentTarget: { dataset: { domain: "stay", nodeId: "hotel" } } });
    assert.equal(page.data.activePreview.title, "人民广场酒店");
    assert.equal(page.data.activePreview.domainLabel, "住");
    assert.equal(page.data.activePreview.photo, "https://example.com/hotel.jpg");
    assert.match(page.data.activePreview.facts.map((fact) => fact.value).join(" "), /约 52 分钟/);
    page.selectPreviewCandidate();
    assert.equal(page.data.proposalDomains[0].candidates[0].selected, true);
    assert.equal(page.data.activePreview.selected, true);
    assert.equal(page.data.routePreviewId, null);
    assert.equal(calls.length, 2);
    assert.match(page.data.notice, /确认前不会写入行程/);
  });

  test(`${platform} projects a real current-day polyline and updates it only after a checked mode preview`, async () => {
    const calls = [];
    const page = await loadMiniPage(platform, async (path, options = {}) => {
      calls.push({ path, options });
      if (path.endsWith("/control")) return control;
      if (path.endsWith("/plan")) return plan;
      if (path.endsWith("/mobility/preview") && !options.data.previewId) return { status: "completed", previewId: "preview-base", mobility: mobility(), feasibility: { canConfirm: true } };
      if (path.endsWith("/mobility/preview")) return { status: "completed", previewId: "preview-transit", mobility: mobility(), feasibility: { canConfirm: true } };
      throw new Error(`unexpected ${path}`);
    });
    await page.loadTrip("trip-shanghai");
    assert.equal(page.data.activeDay, 1);
    assert.equal(page.data.polylines.length, 1);
    assert.equal(page.data.nextLeg.mode, "taxi");
    await page.selectRouteMode({ currentTarget: { dataset: { legId: "airport-hotel", mode: "transit" } } });
    assert.equal(page.data.nextLeg.mode, "transit");
    assert.equal(page.data.nextLeg.steps[0].line, "地铁 2 号线");
    assert.equal(page.data.routePreviewId, "preview-transit");
    assert.equal(page.data.routeSwitchBlocked, false);
    const previewCalls = calls.filter((call) => call.path.endsWith("/mobility/preview"));
    assert.equal(previewCalls.length, 2);
    assert.equal(previewCalls[1].options.data.previewId, "preview-base");
    assert.equal(JSON.stringify(previewCalls[1].options.data.routeModes), JSON.stringify({ "airport-hotel": "transit" }));
  });
}

test("a blocked miniapp mode switch preserves the previous drawn route", async () => {
  let previewCalls = 0;
  const page = await loadMiniPage("wechat", async (path, options = {}) => {
    if (path.endsWith("/control")) return control;
    if (path.endsWith("/plan")) return plan;
    if (path.endsWith("/mobility/preview")) {
      previewCalls += 1;
      if (previewCalls === 1) return { status: "completed", previewId: "preview-base", mobility: mobility(), feasibility: { canConfirm: true } };
      return { status: "blocked", previewId: "preview-blocked", mobility: mobility(), feasibility: { canConfirm: false, primaryBlocker: "公交步行 1145 米，超过 600 米上限" } };
    }
    throw new Error(`unexpected ${path} ${JSON.stringify(options)}`);
  });
  await page.loadTrip("trip-shanghai");
  const previousPolyline = structuredClone(page.data.polylines);
  await page.selectRouteMode({ currentTarget: { dataset: { legId: "airport-hotel", mode: "transit" } } });
  assert.equal(JSON.stringify(page.data.polylines), JSON.stringify(previousPolyline));
  assert.equal(page.data.nextLeg.mode, "taxi");
  assert.equal(page.data.routeSwitchBlocked, true);
  assert.match(page.data.notice, /1145 米.*600 米/);
});

for (const platform of ["wechat", "alipay"]) {
  test(`${platform} does not confirm a route preview while the displayed day has missing geometry`, async () => {
    const calls = [];
    const page = await loadMiniPage(platform, async (path, options = {}) => {
      calls.push({ path, options });
      throw new Error(`confirmation should not call ${path}`);
    });
    page.setData({
      trip: { tripId: "trip-shanghai" },
      proposal: { proposalId: "proposal-1" },
      proposalDomains: [{ key: "stay", candidates: [{ nodeId: "hotel", selected: true }] }],
      routePreviewId: "preview-incomplete",
      routeLegs: [{ legId: "missing-geometry" }],
      routeDrawable: false,
      routeSwitchBlocked: false,
    });
    await page.acceptProposal();
    assert.equal(calls.length, 0);
    assert.match(page.data.notice, /缺少真实折线/);
  });
}
