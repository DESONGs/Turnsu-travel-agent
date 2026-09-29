const app = getApp();

function message(error) {
  const code = error && error.code;
  if (code === "question_stale") return "旅行条件已更新，旧问题已撤下。你的文字仍保留。";
  if (code === "question_already_answered") return "这个问题已在另一端回答，请查看最新方案。";
  if (code === "api_base_not_configured") return "旅行服务地址尚未配置。";
  if (code === "auth_provider_not_configured") return "支付宝登录尚未完成服务端授权。";
  if (code === "agent_unavailable") return "旅行助手暂时无法回应，需求会保留。";
  return "这次请求没有完成，请稍后重试。";
}

function travelerCareModel(travelers) {
  return (travelers || []).map((traveler) => {
    const care = traveler.careNeeds || {};
    const labels = [];
    if (care.mobility && care.mobility.maxContinuousWalkMeters != null) labels.push(`单段步行不超过 ${care.mobility.maxContinuousWalkMeters} 米`);
    else if (care.mobility && care.mobility.reduceWalking) labels.push("需要少走路");
    if (care.mobility && care.mobility.maxTransfers != null) labels.push(`最多换乘 ${care.mobility.maxTransfers} 次`);
    if (care.mobility && care.mobility.stepFreeRequired) labels.push("需要连续无台阶");
    else if (care.mobility && care.mobility.avoidStairs) labels.push("尽量避开楼梯");
    if (care.stamina && care.stamina.needsFrequentRest) labels.push("需要频繁休息");
    if (care.facilities && care.facilities.toiletAccessPriority) labels.push("优先卫生间便利");
    return { travelerId: traveler.travelerId, displayName: traveler.displayName || "同行人", labels, labelText: labels.join(" · ") || "暂无额外行动要求" };
  }).filter((traveler) => traveler.labels.length);
}

function mobilityModel(mobility) {
  if (!mobility || !["completed", "partial"].includes(mobility.status)) return null;
  const modeLabels = { walk: "步行", transit: "公交 / 地铁", taxi: "打车" };
  return {
    ...mobility,
    notice: mobility.travelerFit && ["partial", "unverified"].includes(mobility.travelerFit.accessibilityEvidence)
      ? "设施来自高德路线资料，不代表当前正在运行；连续无障碍建议现场确认。"
      : "路线时间为查询时估算，不是实时到站或即时叫车结果。",
    legs: (mobility.legs || []).map((leg) => {
      const recommended = (leg.alternatives || []).find((alternative) => alternative.mode === leg.recommendedMode) || {};
      return { ...leg, modeLabel: modeLabels[leg.recommendedMode] || leg.recommendedMode, minutes: recommended.totalMinutes, walkingMeters: recommended.walkingMeters, transfers: recommended.mode === "transit" ? recommended.transfers : null, facilities: (recommended.accessibilityFeatures || []).map((feature) => ({ ...feature, note: `${feature.label} · 非实时` })) };
    }),
  };
}

const ROUTE_MODE_LABELS = { walk: "步行", transit: "公交 / 地铁", taxi: "打车" };
const ROUTE_MODE_COLORS = { walk: "#2c8053", transit: "#2268c7", taxi: "#c9443b" };
const DOMAIN_LABELS = { play: "玩", food: "吃", stay: "住", transport: "行" };

function validMapCoordinate(point) {
  if (!point) return false;
  const valid = (value, limit) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit;
  return valid(point.longitude, 180) && valid(point.latitude, 90);
}

function miniRouteScene(mobility, { activeDay, activeLegId, routeModes = {} } = {}) {
  if (!mobility || !["completed", "partial"].includes(mobility.status)) return { activeDay: null, availableDays: [], activeLegId: null, markers: [], polylines: [], legs: [], nextLeg: null, drawable: false };
  const itinerary = mobility.itinerary || {};
  const availableDays = [...new Set([...(itinerary.days || []).map((day) => Number(day.dayIndex)), ...(mobility.legs || []).map((leg) => Number(leg.origin && leg.origin.dayIndex || leg.destination && leg.destination.dayIndex))].filter((day) => Number.isInteger(day) && day > 0))].sort((left, right) => left - right);
  const selectedDay = availableDays.includes(Number(activeDay)) ? Number(activeDay) : availableDays[0] || null;
  const visibleLegs = (mobility.legs || []).filter((leg) => selectedDay == null || Number(leg.origin && leg.origin.dayIndex || leg.destination && leg.destination.dayIndex) === selectedDay);
  const legs = visibleLegs.map((leg) => {
    const requestedMode = routeModes[leg.legId];
    const mode = (leg.alternatives || []).some((alternative) => alternative.mode === requestedMode) ? requestedMode : leg.recommendedMode;
    const alternative = (leg.alternatives || []).find((item) => item.mode === mode) || {};
    const rawPoints = alternative.polyline || [];
    const points = rawPoints.every(validMapCoordinate) ? rawPoints.map((point) => ({ longitude: Number(point.longitude), latitude: Number(point.latitude) })) : [];
    return { ...leg, mode, modeLabel: ROUTE_MODE_LABELS[mode] || mode, minutes: alternative.totalMinutes, walkingMeters: alternative.walkingMeters, transfers: mode === "transit" ? alternative.transfers : null, estimatedFareCny: alternative.estimatedFareCny, points, drawable: points.length >= 2, modeOptions: (leg.alternatives || []).map((item) => ({ mode: item.mode, label: ROUTE_MODE_LABELS[item.mode] || item.mode, minutes: item.totalMinutes, walkingMeters: item.walkingMeters, transfers: item.transfers, estimatedFareCny: item.estimatedFareCny })), steps: alternative.steps || [] };
  });
  const selectedLegId = legs.some((leg) => leg.legId === activeLegId) ? activeLegId : legs[0] && legs[0].legId || null;
  const places = legs.flatMap((leg) => [leg.origin, leg.destination]).filter((place) => place && validMapCoordinate(place.coordinates));
  const markers = [...new Map(places.map((place) => [place.nodeId || place.stopId || place.label, place])).values()].map((place, index) => ({ id: index + 1, longitude: Number(place.coordinates.longitude), latitude: Number(place.coordinates.latitude), title: place.label, width: 24, height: 32 }));
  const polylines = legs.filter((leg) => leg.drawable).map((leg) => ({ points: leg.points, color: leg.legId === selectedLegId ? ROUTE_MODE_COLORS[leg.mode] || "#2268c7" : "#7d8f9b", width: leg.legId === selectedLegId ? 7 : 4, dottedLine: false, arrowLine: true }));
  return { activeDay: selectedDay, availableDays, activeLegId: selectedLegId, markers, polylines, legs, nextLeg: legs.find((leg) => leg.legId === selectedLegId) || legs[0] || null, drawable: legs.length > 0 && legs.every((leg) => leg.drawable) };
}

function selectedNodeIds(proposalDomains, accepted) {
  const selected = Object.fromEntries((proposalDomains || []).map((domain) => [domain.key, domain.candidates.find((candidate) => candidate.selected)?.nodeId]).filter((entry) => entry[1]));
  if (Object.keys(selected).length) return selected;
  return Object.fromEntries((accepted || []).map((node) => [node.domain, node.nodeId]).filter((entry) => entry[0] && entry[1]));
}

function candidateRouteImpact(candidate, mobility) {
  const leg = (mobility && mobility.legs || []).find((item) => item.origin && item.origin.nodeId === candidate.nodeId || item.destination && item.destination.nodeId === candidate.nodeId);
  if (!leg) return null;
  const alternative = (leg.alternatives || []).find((item) => item.mode === leg.recommendedMode) || (leg.alternatives || [])[0] || {};
  const facts = [
    ROUTE_MODE_LABELS[alternative.mode || leg.recommendedMode] || alternative.mode || leg.recommendedMode,
    Number.isFinite(Number(alternative.totalMinutes)) ? `约 ${Math.round(Number(alternative.totalMinutes))} 分钟` : null,
    Number.isFinite(Number(alternative.walkingMeters)) ? `步行 ${Math.round(Number(alternative.walkingMeters))} 米` : null,
    alternative.mode === "transit" && Number.isFinite(Number(alternative.transfers)) ? `${Math.round(Number(alternative.transfers))} 次换乘` : null,
  ].filter(Boolean);
  return {
    title: `${leg.origin && leg.origin.label || "起点"} → ${leg.destination && leg.destination.label || "下一站"}`,
    detail: facts.join(" · ") || "路线已返回，但耗时仍待核验",
    rationale: leg.rationale || "",
  };
}

function destinationPreviewModel(candidate, domain, mobility) {
  if (!candidate) return null;
  const routeImpact = candidateRouteImpact(candidate, mobility);
  const facilities = candidate.facilityText ? [candidate.facilityText] : [];
  const facts = [
    candidate.summary ? { label: "为什么值得看", value: candidate.summary } : null,
    candidate.priceLabel ? { label: "费用线索", value: `${candidate.priceLabel}${candidate.priceDetail ? ` · ${candidate.priceDetail}` : ""}` } : null,
    routeImpact ? { label: "路线影响", value: routeImpact.detail } : null,
  ].filter(Boolean);
  const unknowns = [
    !(candidate.location && candidate.location.coordinates) ? "没有可靠坐标时，不展示地图点位，也不开放路线确认。" : null,
    !candidate.photo ? "没有可展示的来源图片；不会用通用风景图替代。" : null,
    !routeImpact ? "尚未形成与住宿、到达点或当日路线的已核验移动关系。" : null,
  ].filter(Boolean);
  return {
    nodeId: candidate.nodeId,
    domain,
    domainLabel: DOMAIN_LABELS[domain] || "地点",
    title: candidate.title,
    photo: candidate.photo || "",
    selected: candidate.selected === true,
    ctaLabel: candidate.selected ? "取消试排" : "加入路线试排",
    sourceLabel: candidate.sourceId || candidate.source && candidate.source.sourceType || "当前候选来源",
    facts,
    facilities,
    routeImpact,
    unknowns,
  };
}

function findCandidate(proposalDomains, domain, nodeId) {
  const domainModel = (proposalDomains || []).find((item) => item.key === domain);
  return domainModel && domainModel.candidates.find((candidate) => candidate.nodeId === nodeId) || null;
}

function priceModel(candidate) {
  const source = candidate && candidate.price;
  const legacy = Number(candidate && candidate.cost);
  const amount = source ? source.amount : (Number.isFinite(legacy) && legacy > 0 ? legacy : null);
  const quality = source && source.quality ? source.quality : amount == null ? "unknown" : "reference";
  if (amount == null || quality === "unknown") return { priceLabel: "待核验", priceDetail: "未取得可靠价格", priceTone: "unknown" };
  const prefix = quality === "reference" ? "≈" : quality === "estimate" ? "~" : "";
  const detail = quality === "firm" ? "本次实价" : quality === "reference" ? "参考价" : "确定性估算";
  return { priceLabel: `${prefix}¥${Math.round(amount)}`, priceDetail: detail, priceTone: quality };
}

function budgetModel(budget) {
  if (!budget) return null;
  const labels = { stay: "住", transport: "行", food: "吃", play: "玩" };
  const rows = Object.keys(labels).map((domain) => {
    const bucket = budget.domains && budget.domains[domain];
    const unknown = !bucket || bucket.quality === "unknown" || (!bucket.estimated && bucket.unknownCount);
    const prefix = bucket && bucket.quality === "reference" ? "≈" : bucket && bucket.quality === "estimate" ? "~" : "";
    return { domain, label: labels[domain], amountLabel: unknown ? "待核验" : `${prefix}¥${Math.round(bucket.estimated || bucket.committed || 0)}`, basis: bucket && bucket.basis && bucket.basis[0] || "" };
  });
  return { summary: `整趟约 ¥${Math.round(budget.estimated || 0)}${budget.totalBudget != null ? ` / ¥${Math.round(budget.totalBudget)}` : ""}`, rows, exceedsBudget: budget.exceedsBudget === true };
}

function planModel(plan) {
  const proposal = plan && plan.pendingProposals && plan.pendingProposals[0];
  const proposalDomains = proposal ? ["transport", "stay", "food", "play"].map((key) => ({
    key,
    label: DOMAIN_LABELS[key],
    candidates: (proposal.byDomain[key] || []).map((candidate) => ({ ...candidate, domain: key, domainLabel: DOMAIN_LABELS[key], ...priceModel(candidate), selected: candidate.selected === true, photo: candidate.media && candidate.media[0] ? candidate.media[0].url : "", facilityText: candidate.operability && candidate.operability.mappedFacilities && candidate.operability.mappedFacilities.length ? `设施参考：${candidate.operability.mappedFacilities.map((facility) => facility.label).join("、")} · 非实时` : "" })),
  })).filter((domain) => domain.candidates.length).map((domain) => ({ ...domain, hasSelection: domain.candidates.some((candidate) => candidate.selected) })) : [];
  const accepted = plan ? Object.entries(plan.byDomain || {}).flatMap(([domain, items]) => items.filter((item) => item.selected).map((item) => ({ ...item, domain }))).map((item) => ({
    ...item,
    scheduleLabel: item.time || (item.operability && (item.operability.departureAt || item.operability.arrivalAt)) || "待排入日程",
    facilities: ((item.operability && item.operability.mappedFacilities) || []).map((facility) => ({ ...facility, note: `${facility.label} · 非实时` })),
  })) : [];
  const mapNodes = proposalDomains.length ? proposalDomains.flatMap((domain) => domain.candidates) : accepted;
  const markers = mapNodes.filter((candidate) => candidate.location && validMapCoordinate(candidate.location.coordinates)).map((candidate, index) => ({
    id: index + 1,
    longitude: candidate.location.coordinates.longitude,
    latitude: candidate.location.coordinates.latitude,
    title: candidate.title,
  }));
  const mobility = mobilityModel(plan && plan.mobility);
  const routeScene = miniRouteScene(mobility);
  return { proposal, proposalDomains, selectedCount: proposalDomains.filter((domain) => domain.hasSelection).length, confirmedMobility: mobility, confirmedMarkers: markers, tripRefreshNeeded: false, activeDomainKey: proposalDomains[0] ? proposalDomains[0].key : "transport", markers: routeScene.markers.length ? routeScene.markers : markers, polylines: routeScene.polylines, accepted, mobility, routeLegs: routeScene.legs, nextLeg: routeScene.nextLeg, activeLegId: routeScene.activeLegId, activeDay: routeScene.activeDay, routeDays: routeScene.availableDays, routeDrawable: routeScene.drawable, routePreviewId: null, routeModes: {}, routeSwitchBlocked: false, routeCanConfirm: false, routeBlocker: "", planRevision: plan && plan.revision, planBudget: budgetModel(plan && plan.budget) };
}

Page({
  data: { historyOpen: false, inputFocus: false, pendingText: "", failedText: "", messageVersion: 0, selectedCount: 0, initializationFailed: false, tripRefreshNeeded: false, confirmedMobility: null, confirmedMarkers: [],  signedIn: false, loading: false, conversations: [], conversation: null, input: "", trip: null, proposal: null, proposalDomains: [], planBudget: null, markers: [], polylines: [], accepted: [], mobility: null, routeLegs: [], nextLeg: null, activeLegId: null, activeDay: null, routeDays: [], routeDrawable: false, routePreviewId: null, routeModes: {}, routeSwitching: false, routeSwitchBlocked: false, routeSheetExpanded: false, activePreview: null, planRevision: null, activeView: "conversation", activeDomainKey: "transport", modelOptions: [], modelIndex: 0, selectedModelId: "deepseek-v4-flash", starterPrompts: [{ label: "带父母轻松旅行", detail: "少走路，住宿位置方便", text: "我想带父母轻松旅行，请优先考虑步行距离、换乘和住宿位置。" }, { label: "第一次探索一座城", detail: "把兴趣和路线连起来", text: "这是我第一次去，请根据我的兴趣把住宿、体验和每天路线连起来。" }, { label: "先控制整趟预算", detail: "看清住宿和交通取舍", text: "请先按整趟预算规划，重点比较住宿、跨城交通和体验之间的取舍。" }], notice: "登录后直接说出旅行想法，不需要先创建行程。" },
  signIn() {
    if (this.data.loading) return;
    this.setData({ loading: true, initializationFailed: false });
    my.getAuthCode({
      scopes: ["auth_user"],
      success: async ({ authCode }) => {
        try {
          const session = await app.request("/api/auth/platform-exchange", { method: "POST", data: { provider: "alipay", authorizationCode: authCode } });
          app.sessionToken = session.accessToken;
          this.setData({ signedIn: true, notice: "说出目的地、时间、同行人或一个模糊想法。" });
          await this.loadModelOptions().catch(() => {});
          await this.loadConversations();
        } catch (error) {
          this.setData({ notice: message(error), initializationFailed: this.data.signedIn && !this.data.conversation });
        } finally {
          this.setData({ loading: false });
        }
      },
      fail: () => this.setData({ loading: false, notice: "没有取得支付宝登录授权。" }),
    });
  },
  dismissNotice() { this.setData({ notice: "" }); },
  toggleHistory() { this.setData({ historyOpen: !this.data.historyOpen }); },
  async retryInitialization() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try { await this.loadConversations(); this.setData({ initializationFailed: false, notice: "" }); }
    catch (error) { this.setData({ initializationFailed: true, notice: message(error) }); }
    finally { this.setData({ loading: false }); }
  },
  async openConversation(event) {
    if (this.data.loading || this.data.routeSwitching) return;
    if (this.data.input.trim() || this.data.failedText || this.data.tripRefreshNeeded) return this.setData({ notice: "请先处理未发送内容或重新读取行程，再切换旅行，避免丢失。" });
    const conversationId = event.currentTarget.dataset.id;
    this.setData({ loading: true });
    try {
      const conversation = conversationId
        ? await app.request(`/api/conversations/${encodeURIComponent(conversationId)}`)
        : await app.request("/api/conversations", { method: "POST", data: { modelId: this.data.selectedModelId } });
      if (conversation.tripId) await this.loadTrip(conversation.tripId);
      else this.setData({ trip: null, ...planModel(null) });
      this.setData({ conversation, selectedModelId: conversation.modelId || this.data.selectedModelId, historyOpen: false, activeView: conversation.tripId ? "itinerary" : "conversation", activePreview: null, failedText: "", notice: "", messageVersion: this.data.messageVersion + 1,
        conversations: [conversation, ...this.data.conversations.filter((item) => item.conversationId !== conversation.conversationId)] });
      await this.refreshExecution();
    } catch (error) { this.setData({ notice: message(error) }); }
    finally { this.setData({ loading: false }); }
  },
  restoreFailedDraft() {
    if (!this.data.failedText) return;
    if (this.data.input.trim()) return this.setData({ notice: "请先保存或清空当前输入，再恢复上一条未发送内容。" });
    this.setData({ input: this.data.failedText, failedText: "", inputFocus: true });
  },
  async retryTrip() {
    const tripId = this.data.conversation && this.data.conversation.tripId || this.data.trip && this.data.trip.tripId;
    if (!tripId || this.data.loading || this.data.routeSwitching) return;
    this.setData({ loading: true });
    try { await this.loadTrip(tripId); this.setData({ tripRefreshNeeded: false, notice: "已重新读取行程。", activeView: "itinerary" }); }
    catch (error) { this.setData({ tripRefreshNeeded: true, notice: "行程暂时读不到，请重试；不会重复发送或确认。" }); }
    finally { this.setData({ loading: false }); }
  },
  async loadModelOptions() {
    const status = await app.request("/api/provider-status");
    const selection = status.modelSelection || {};
    const modelOptions = (selection.options || []).filter((option) => option.available);
    const selectedModelId = modelOptions.some((option) => option.id === selection.defaultModelId) ? selection.defaultModelId : (modelOptions[0] && modelOptions[0].id) || "deepseek-v4-flash";
    this.setData({ modelOptions, selectedModelId, modelIndex: Math.max(0, modelOptions.findIndex((option) => option.id === selectedModelId)) });
  },
  async loadConversations() {
    const result = await app.request("/api/conversations");
    let conversations = result.conversations || [];
    let conversation = conversations[0];
    if (!conversation) {
      conversation = await app.request("/api/conversations", { method: "POST", data: { modelId: this.data.selectedModelId } });
      conversations = [conversation];
    } else {
      conversation = await app.request(`/api/conversations/${encodeURIComponent(conversation.conversationId)}`);
    }
    const modelIndex = Math.max(0, this.data.modelOptions.findIndex((option) => option.id === conversation.modelId));
    this.setData({ conversations, conversation, selectedModelId: conversation.modelId, modelIndex });
    if (conversation.tripId) await this.loadTrip(conversation.tripId);
    await this.refreshExecution();
  },
  onInput(event) { this.setData({ input: event.detail.value }); },
  useStarterPrompt(event) { this.setData({ input: event.currentTarget.dataset.prompt || "" }); },
  switchView(event) {
    const activeView = event.currentTarget.dataset.view;
    if (activeView === "map" && this.data.selectedCount && !this.data.routePreviewId) { void this.reviewDraft(); return; }
    if (activeView && (activeView === "conversation" || this.data.trip)) this.setData({ activeView, ...(activeView === "map" ? { routeSheetExpanded: false } : {}) });
  },
  toggleRouteSheet() { this.setData({ routeSheetExpanded: !this.data.routeSheetExpanded }); },
  switchDecisionDomain(event) {
    const activeDomainKey = event.currentTarget.dataset.domain;
    if (activeDomainKey) this.setData({ activeDomainKey, activePreview: null });
  },
  onModelChange(event) {
    const modelIndex = Number(event.detail.value);
    const selectedModelId = this.data.modelOptions[modelIndex] && this.data.modelOptions[modelIndex].id;
    if (selectedModelId) this.setData({ modelIndex, selectedModelId });
  },
  onLoad() { this.showExecution(null); },
  pauseExecutionWatch() {
    this._executionVersion = (this._executionVersion || 0) + 1;
    clearTimeout(this._executionTimer);
  },
  onHide() { this._executionHidden = true; this.pauseExecutionWatch(); this.setData({ loading: false }); },
  onUnload() { this._executionHidden = true; this.pauseExecutionWatch(); },
  onShow() {
    this._executionHidden = false;
    if (this.data.signedIn && this.data.conversation && !this.data.loading) void this.refreshExecution();
  },
  showExecution(run) {
    const active = run && ["queued", "running", "cancelling"].includes(run.status);
    const labels = { queued: "请求已保存，等待开始", running: "正在规划这趟旅行", cancelling: "正在停止后续操作", completed: "本轮处理已结束", failed: "本轮未完成，已保存的内容仍保留", interrupted: "规划中断，可以从保存的内容继续", cancelled: "已停止，已保存的内容仍保留", awaiting_input: "补充一个信息即可继续" };
    this.setData({ execution: run, executionActive: Boolean(active), executionDisconnected: false,
      executionLabel: run && run.status === "queued" && run.waitReason ? "当前方案已保留，稍后自动继续" : run && run.result && run.result.outcome && run.result.outcome.status === "partial" ? "已有部分结果，仍有待补充项" : run ? labels[run.status] || "正在处理旅行要求" : "",
      executionQuestion: run && run.status === "awaiting_input" && run.result ? run.result.question && run.result.question.status === "open" ? run.result.question : null : null, loading: Boolean(active) });
  },
  async finishExecution(run) {
    const version = this._executionVersion;
    try {
      const conversation = run.result && run.result.conversation || await app.request(`/api/conversations/${encodeURIComponent(run.conversationId)}`);
      if (version !== this._executionVersion || this._executionHidden) return;
      if (!this.data.conversation || this.data.conversation.conversationId !== run.conversationId) return;
      this.setData({ conversation, pendingText: "", notice: "", messageVersion: this.data.messageVersion + 1 });
      if (conversation.tripId) {
        await this.loadTrip(conversation.tripId, version);
        if (version !== this._executionVersion || this._executionHidden) return;
        if (run.status === "completed" && (this.data.proposalDomains.length || this.data.accepted.length)) this.setData({ activeView: "itinerary" });
      }
    } catch (error) { this.setData({ tripRefreshNeeded: true, notice: "消息已发送，但行程暂未刷新。请重新读取，不必重复发送。" }); }
  },
  async pollExecution(runId, version) {
    try {
      const run = await app.request(`/api/runs/${encodeURIComponent(runId)}`);
      if (version !== this._executionVersion || this._executionHidden) return;
      this.showExecution(run);
      if (!this.data.executionActive) {
        await this.finishExecution(run);
        if (this.data.executionQuestion && !this._executionHidden) this._executionTimer = setTimeout(() => { void this.refreshExecution(); }, 5000);
        return;
      }
      this._executionTimer = setTimeout(() => { void this.pollExecution(runId, version); }, 1000);
    } catch (error) {
      if (version === this._executionVersion && !this._executionHidden) this.setData({ loading: false, executionDisconnected: true, notice: "连接中断，请求已保存。重新连接即可查看结果，不必重复发送。" });
    }
  },
  async watchExecution(run) {
    this.pauseExecutionWatch();
    this.showExecution(run);
    if (this._executionHidden) { this.setData({ loading: false }); return; }
    if (!this.data.executionActive) {
        await this.finishExecution(run);
        if (this.data.executionQuestion && !this._executionHidden) this._executionTimer = setTimeout(() => { void this.refreshExecution(); }, 5000);
        return;
      }
    await this.pollExecution(run.runId, this._executionVersion);
  },
  async refreshExecution() {
    const conversationId = this.data.conversation && this.data.conversation.conversationId;
    if (!conversationId) return;
    try {
      const result = await app.request(`/api/conversations/${encodeURIComponent(conversationId)}/runs`);
      if (!this.data.conversation || this.data.conversation.conversationId !== conversationId || this._executionHidden) return;
      const runs = result.runs || [];
      const run = runs.find((item) => ["queued", "running", "cancelling"].includes(item.status)) || runs[0];
      if (run) await this.watchExecution(run);
      else { this.pauseExecutionWatch(); this.showExecution(null); }
    } catch (error) { this.setData({ executionDisconnected: true, notice: "暂时无法读取规划进度，请重新连接后继续。" }); }
  },
  async stopExecution() {
    const run = this.data.execution;
    if (!run || !this.data.executionActive || run.status === "cancelling") return;
    try { await this.watchExecution(await app.request(`/api/runs/${encodeURIComponent(run.runId)}/cancel`, { method: "POST", data: {} })); }
    catch (error) { this.setData({ notice: "停止请求暂未送达，请重新连接后再试。" }); }
  },
  answerExecution(event) {
    const question = this.data.executionQuestion;
    const option = question && question.options.find(item => item.optionId === event.currentTarget.dataset.optionId);
    if (option) return this.sendMessage(option.label, { runId: this.data.execution.runId, questionId: question.questionId, optionId: option.optionId });
  },
  continueExecution() { return this.sendMessage("请读取当前已保存的旅行要求、已完成的工作和未完成事项，继续规划；不要重复确认已提交的安排。"); },
  async sendMessage(override, answerTo = null) {
    const question = this.data.executionQuestion;
    if (!answerTo && question && question.status === "open") answerTo = { runId: this.data.execution.runId, questionId: question.questionId };
    const explicit = typeof override === "string";
    const text = String(explicit ? override : this.data.input || "").trim();
    if (!text || this.data.loading || this.data.executionActive || this.data.routeSwitching || this.data.tripRefreshNeeded || !this.data.conversation) return;
    if (this.data.failedText) return this.setData({ notice: "上一条内容仍待恢复。请先保留当前文字，再清空输入框恢复上一条，避免覆盖。" });
    const conversationId = this.data.conversation.conversationId;
    const fingerprint = JSON.stringify([conversationId, this.data.selectedModelId, text, answerTo]);
    if (!this._pendingCommand || this._pendingCommand.fingerprint !== fingerprint) this._pendingCommand = { fingerprint, requestId: `mini_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}` };
    this.setData({ loading: true, input: explicit ? this.data.input : "", pendingText: text, failedText: "", activeView: "conversation", messageVersion: this.data.messageVersion + 1 });
    try {
      const run = await app.request(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, { method: "POST", data: { requestId: this._pendingCommand.requestId, text, modelId: this.data.selectedModelId, ...(answerTo ? { answerTo } : {}) } });
      this._pendingCommand = null;
      await this.watchExecution(run);
    } catch (error) {
      if (["question_stale", "question_already_answered"].includes(error.code)) this.setData({ executionQuestion: null });
      this.setData({ loading: false, pendingText: "", input: this.data.input || text, failedText: this.data.input ? text : "", notice: message(error) });
    }
  },
  async loadTrip(tripId, executionVersion = null) {
    const [control, plan] = await Promise.all([
      app.request(`/api/trips/${encodeURIComponent(tripId)}/control`),
      app.request(`/api/trips/${encodeURIComponent(tripId)}/plan`),
    ]);
    if (executionVersion !== null && (executionVersion !== this._executionVersion || this._executionHidden)) return;
    this.setData({ trip: { tripId, ...control.brief, timeLabel: control.brief.dates || (control.brief.durationDays ? `${control.brief.durationDays} 天` : "时间待确认"), travelerCount: control.travelers.length, travelerCare: travelerCareModel(control.travelers), budgetLabel: control.brief.totalBudget != null ? `总预算 ¥${control.brief.totalBudget}` : "", paceLabel: control.brief.pace ? `整体节奏：${control.brief.pace}` : "" }, ...planModel(plan), activePreview: null });
  },
  setCandidateSelection(domain, nodeId, extra = {}) {
    if (this.data.loading || this.data.routeSwitching || this.data.tripRefreshNeeded) return false;
    const proposalDomains = this.data.proposalDomains.map((item) => item.key === domain ? { ...item, candidates: item.candidates.map((candidate) => ({ ...candidate, selected: candidate.nodeId === nodeId })) } : item)
      .map((item) => ({ ...item, hasSelection: item.candidates.some((candidate) => candidate.selected) }));
    const scene = miniRouteScene(this.data.confirmedMobility);
    this.setData({ proposalDomains, selectedCount: proposalDomains.filter((item) => item.hasSelection).length, routePreviewId: null, routeModes: {}, routeSwitchBlocked: false, routeCanConfirm: false, routeBlocker: "",
      mobility: this.data.confirmedMobility, markers: scene.markers.length ? scene.markers : this.data.confirmedMarkers,
      polylines: scene.polylines, routeLegs: scene.legs, nextLeg: scene.nextLeg, routeDrawable: scene.drawable, activeLegId: scene.activeLegId, activeDay: scene.activeDay, routeDays: scene.availableDays, ...extra });
    return true;
  },
  selectCandidate(event) {
    const { domain, nodeId } = event.currentTarget.dataset;
    const candidate = findCandidate(this.data.proposalDomains, domain, nodeId);
    if (!candidate) return;
    this.setCandidateSelection(domain, candidate.selected ? null : nodeId, { notice: candidate.selected ? "已取消本地试排，已确认行程不变。" : "已加入本地试排；确认前不会写入行程。" });
  },
  openPlacePreview(event) {
    const { domain, nodeId } = event.currentTarget.dataset;
    const candidate = findCandidate(this.data.proposalDomains, domain, nodeId);
    this.setData({ activePreview: destinationPreviewModel(candidate, domain, this.data.mobility) });
  },
  closePlacePreview() {
    this.setData({ activePreview: null });
  },
  selectPreviewCandidate() {
    const preview = this.data.activePreview;
    if (!preview) return;
    this.setCandidateSelection(preview.domain, preview.selected ? null : preview.nodeId, { activePreview: { ...preview, selected: !preview.selected, ctaLabel: preview.selected ? "加入路线试排" : "取消试排" }, notice: preview.selected ? "已取消试排，已确认行程不变。" : "已加入本地试排；确认前不会写入行程。" });
  },
  selectRouteDay(event) {
    const scene = miniRouteScene(this.data.mobility, { activeDay: Number(event.currentTarget.dataset.day), activeLegId: null, routeModes: this.data.routeModes });
    this.setData({ activeDay: scene.activeDay, activeLegId: scene.activeLegId, routeLegs: scene.legs, nextLeg: scene.nextLeg, markers: scene.markers, polylines: scene.polylines, routeDrawable: scene.drawable, routeSheetExpanded: false });
  },
  selectRouteLeg(event) {
    const scene = miniRouteScene(this.data.mobility, { activeDay: this.data.activeDay, activeLegId: event.currentTarget.dataset.legId, routeModes: this.data.routeModes });
    this.setData({ activeLegId: scene.activeLegId, routeLegs: scene.legs, nextLeg: scene.nextLeg, polylines: scene.polylines, routeSheetExpanded: true });
  },
  async selectRouteMode(event) {
    if (!this.data.trip || this.data.loading || this.data.routeSwitching) return;
    const { legId, mode } = event.currentTarget.dataset;
    const selections = selectedNodeIds(this.data.proposalDomains, this.data.accepted);
    if (!Object.keys(selections).length) return this.setData({ notice: "先选择或确认地点，才能比较真实路线。" });
    const nextModes = { ...this.data.routeModes, [legId]: mode };
    this.setData({ routeSwitching: true, routeSwitchBlocked: false });
    try {
      let previewId = this.data.routePreviewId;
      if (!previewId) {
        const initial = await app.request(`/api/trips/${encodeURIComponent(this.data.trip.tripId)}/mobility/preview`, { method: "POST", data: { baseRevision: this.data.planRevision, selections } });
        if (!initial.previewId) throw { code: initial.reason || "route_preview_unavailable" };
        previewId = initial.previewId;
      }
      const result = await app.request(`/api/trips/${encodeURIComponent(this.data.trip.tripId)}/mobility/preview`, { method: "POST", data: { baseRevision: this.data.planRevision, previewId, routeModes: nextModes } });
      const mobility = mobilityModel(result.mobility);
      const scene = miniRouteScene(mobility, { activeDay: this.data.activeDay, activeLegId: legId, routeModes: nextModes });
      if (!result.feasibility || result.feasibility.canConfirm !== true) throw { code: "route_infeasible", details: result.feasibility && result.feasibility.primaryBlocker };
      if (!scene.nextLeg || !scene.nextLeg.drawable || !scene.drawable) throw { code: "route_geometry_unavailable" };
      this.setData({ mobility, routePreviewId: result.previewId, routeModes: nextModes, activeLegId: scene.activeLegId, routeLegs: scene.legs, nextLeg: scene.nextLeg, markers: scene.markers, polylines: scene.polylines, routeDrawable: scene.drawable, routeSwitchBlocked: false, routeCanConfirm: true, routeBlocker: "", notice: `已核验${scene.nextLeg.modeLabel}方案；时间、步行、换乘和费用已同步。` });
    } catch (error) {
      this.setData({ routeSwitchBlocked: true, routeCanConfirm: false, notice: error && error.details || (error && error.code === "route_geometry_unavailable" ? "这条方式没有返回可绘制路线，已保留上一条路线。" : "这条方式没有通过核验，已保留上一条路线。") });
    } finally {
      this.setData({ routeSwitching: false });
    }
  },
  async reviewDraft() {
    if (!this.data.trip || !this.data.selectedCount || this.data.loading || this.data.routeSwitching || this.data.tripRefreshNeeded) return;
    const selections = Object.fromEntries(this.data.proposalDomains.map((domain) => [domain.key, domain.candidates.find((candidate) => candidate.selected)?.nodeId]).filter((item) => item[1]));
    this.setData({ activeView: "map", routeSwitching: true, routeCanConfirm: false, routeBlocker: "", activePreview: null });
    try {
      const result = await app.request(`/api/trips/${encodeURIComponent(this.data.trip.tripId)}/mobility/preview`, { method: "POST", data: { baseRevision: this.data.planRevision, selections } });
      if (!result.previewId) throw new Error("route_preview_unavailable");
      const mobility = mobilityModel(result.mobility);
      const scene = miniRouteScene(mobility);
      const incompleteGeometry = scene.legs.length > 0 && !scene.drawable;
      const canConfirm = result.feasibility && result.feasibility.canConfirm === true && !incompleteGeometry;
      const blocker = result.feasibility && result.feasibility.primaryBlocker;
      this.setData({ mobility, routePreviewId: result.previewId, routeModes: {}, routeCanConfirm: canConfirm,
        routeBlocker: canConfirm ? "" : typeof blocker === "string" ? blocker : incompleteGeometry ? "部分路段缺少可靠路线，暂不能确认。" : "日期、地点或路线资料尚未通过核验，请补充后重新试排。",
        markers: scene.markers, polylines: scene.polylines, routeLegs: scene.legs, nextLeg: scene.nextLeg,
        routeDrawable: scene.drawable, activeLegId: scene.activeLegId, activeDay: scene.activeDay, routeDays: scene.availableDays, routeSwitchBlocked: !canConfirm, notice: "" });
    } catch {
      this.setData({ routeCanConfirm: false, routeSwitchBlocked: true, routeBlocker: "路线核验暂未完成，候选已保留。可以重试，不会改动行程。" });
    } finally { this.setData({ routeSwitching: false }); }
  },
  async acceptProposal() {
    if (!this.data.proposal || !this.data.trip || this.data.loading || this.data.routeSwitching || this.data.tripRefreshNeeded) return;
    if (!this.data.proposalDomains.some((domain) => domain.candidates.some((candidate) => candidate.selected))) {
      this.setData({ notice: "请先选择一个想确认的候选；其他领域可以稍后再决定。" });
      return;
    }
    if (this.data.routePreviewId && this.data.routeLegs.length > 0 && !this.data.routeDrawable) {
      this.setData({ notice: "当前日仍有路段缺少真实折线，暂不能确认这次路线调整。" });
      return;
    }
    if (!this.data.routePreviewId || !this.data.routeCanConfirm || this.data.routeSwitchBlocked) {
      this.setData({ notice: "请先查看路线并完成核验，再确认加入行程。" });
      return;
    }
    const selections = Object.fromEntries(this.data.proposalDomains.map((domain) => [domain.key, domain.candidates.find((candidate) => candidate.selected)?.nodeId]).filter((item) => item[1]));
    this.setData({ loading: true });
    let committed = false;
    try {
      const result = await app.request(`/api/trips/${encodeURIComponent(this.data.trip.tripId)}/proposals/${encodeURIComponent(this.data.proposal.proposalId)}/accept`, { method: "POST", data: { selections, partial: true, baseRevision: this.data.planRevision, ...(this.data.routePreviewId ? { previewId: this.data.routePreviewId, baseRevision: this.data.planRevision, routeModes: this.data.routeModes } : {}) } });
      if (!result || result.status !== "committed") throw { code: result && result.validation && result.validation.reason || result && result.status || "confirmation_not_committed" };
      committed = true;
      this.setData({ proposal: null, proposalDomains: [], selectedCount: 0, routePreviewId: null });
      let routeRefreshFailed = false;
      try { await app.request(`/api/trips/${encodeURIComponent(this.data.trip.tripId)}/mobility/refresh`, { method: "POST" }); }
      catch { routeRefreshFailed = true; }
      await this.loadTrip(this.data.trip.tripId);
      this.setData({ notice: routeRefreshFailed ? "所选安排已确认。路线刷新暂未完成，现有路线保留。" : "已确认所选候选；其他领域仍可继续比较。", activeView: "itinerary" });
    } catch (error) {
      this.setData({ tripRefreshNeeded: committed, notice: committed ? "所选安排已确认，但页面暂未刷新。请重新读取行程，不必再次确认。" : message(error) });
    } finally {
      this.setData({ loading: false });
    }
  },
});
