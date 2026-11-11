import { structured } from "./host-errors.mjs";

const PRIVATE_RESULTS = new Set(["get_trip_result_reference", "list_trip_share_members", "resolve_trip_share_email", "grant_trip_share_email",
  "grant_trip_access", "revoke_trip_access", "list_trip_journal", "read_trip_journal_photo", "create_trip_journal", "delete_trip_journal",
  "get_trip_journal_entry", "read_trip_journal_image", "save_trip_journal_entry", "save_trip_photo_relief"]);
const ACCESS_ERRORS = new Set(["authentication_required", "permission_denied", "trip_not_found"]);
const noop = () => {};
export function hostError(code, message) { return Object.assign(new Error(message), { code }); }

/** Shared MCP lifecycle; file and message extensions stay in their host adapter. */
export class TravelHostPort {
  constructor(app, callbacks = {}) {
    this.app = app;
    this.callbacks = { onInitial: noop, onOpenTrip: noop, onError: noop, onIdentityChanged: noop, onAccessLost: noop, onContextChanged: noop, ...callbacks };
    this.openTool = "open_travel_mcp_workbench"; this.intent = 0; this.identityEpoch = 0; this.profileValue = null; this.link = null; this.ready = false; this.service = null;
    this.sender = input => app.sendMessage(input);
    this.messageAvailable = () => Boolean(app.getHostCapabilities?.()?.message);
  }
  invalidate() {
    this.identityEpoch++; this.intent++; this.link = null; this.pendingInput = null;
    this.callbacks.onContextChanged({ linkedTripId: null });
  }
  async profile() {
    const value = structured(await this.app.callServerTool({ name: "get_profile", arguments: {} }));
    if (typeof value.id !== "string" || !value.id) throw hostError("authentication_required", "无法识别当前账号，请重新连接。");
    const previous = this.profileValue; this.profileValue = value;
    if (previous && previous.id !== value.id) {
      this.invalidate(); this.callbacks.onIdentityChanged(value);
      throw hostError("account_changed", "账号已切换，请重新选择旅行。");
    }
    return value;
  }
  async call(name, args = {}) {
    try {
      if (name === "get_profile") return await this.profile();
      await this.profile();
      const epoch = this.identityEpoch;
      const result = await this.app.callServerTool({ name, arguments: args });
      await this.profile();
      if (epoch !== this.identityEpoch) throw hostError("account_changed", "账号已变化，请重新打开旅行。");
      const summary = structured(result);
      if (PRIVATE_RESULTS.has(name)) {
        const data = result?._meta?.["travel/uiData"];
        if (!data || typeof data !== "object") throw new Error("资料暂时无法读取，请刷新重试。");
        return data;
      }
      return summary;
    } catch (error) {
      if (ACCESS_ERRORS.has(error.code)) { this.invalidate(); this.callbacks.onAccessLost(); }
      throw error;
    }
  }
  report(error) { this.callbacks.onError(error.message || "无法连接旅行工作台，请重新打开。"); }
  async refreshInitial(tripId) {
    const intent = this.intent;
    // A replayed host result can belong to a previous account: re-read its pointer.
    const value = await this.call(this.openTool, tripId ? { tripId } : {});
    if (intent !== this.intent) return;
    if (typeof value.service !== "string") throw new Error("旅行服务没有返回有效的连接信息。");
    this.service = value.service;
    this.callbacks.onInitial({ ...value, profile: this.profileValue });
  }
  input(args = {}) {
    const intent = ++this.intent;
    this.link = typeof args.tripId === "string" && typeof args.instruction === "string" && args.instruction.trim() && !args.file
      ? { tripId: args.tripId, instruction: args.instruction.trim(), accountId: this.profileValue?.id } : null;
    this.callbacks.onContextChanged({ ...this.app.getHostContext?.(), linkedTripId: this.link?.tripId ?? null });
    if (!this.ready) { this.pendingInput = { args, intent }; return; }
    this.receive(args, intent).catch(error => { if (intent === this.intent) this.report(error); });
  }
  async receive(args, intent) {
    if (args.file) throw new Error("当前宿主不支持读取旅行文件。");
    if (typeof args.tripId !== "string") return;
    const trip = await this.call("get_travel_workspace", { tripId: args.tripId });
    if (intent === this.intent) this.callbacks.onOpenTrip(trip);
  }
  canMessage(tripId) {
    return Boolean(tripId && this.ready && this.link?.tripId === tripId
      && this.link.accountId === this.profileValue?.id && this.messageAvailable());
  }
  async sendMessage(text, tripId) {
    await this.call("get_profile");
    if (!this.canMessage(tripId)) throw hostError("unlinked_conversation", "请求已保存，请回到关联旅行的对话继续。");
    const result = await this.sender({ role: "user", content: [{ type: "text", text }] });
    return result?.isError ? "failed" : "sent";
  }
  async checkIdentity() { try { await this.call("get_profile"); } catch (error) { this.report(error); } }
  async connect() {
    this.app.ontoolinput = ({ arguments: args }) => this.input(args || {});
    this.app.ontoolresult = result => {
      try {
        const value = structured(result);
        if (typeof value.service !== "string" || !value.workspaces) return;
        if (!this.ready) { this.pendingInitial = value.trip?.tripId; return; }
        this.refreshInitial(value.trip?.tripId).catch(error => this.report(error));
      } catch (error) { this.report(error); }
    };
    this.app.onhostcontextchanged = context => this.callbacks.onContextChanged({ ...context, linkedTripId: this.link?.tripId ?? null });
    try {
      await this.app.connect();
      const value = await this.call(this.openTool, {});
      if (typeof value.service !== "string") throw new Error("旅行服务没有返回有效的连接信息。");
      this.service = value.service; this.ready = true;
      this.callbacks.onInitial({ ...value, profile: this.profileValue });
      this.callbacks.onContextChanged({ ...this.app.getHostContext?.(), linkedTripId: this.link?.tripId ?? null });
      if (this.pendingInput) {
        const pending = this.pendingInput; this.pendingInput = null;
        if (this.link) this.link.accountId = this.profileValue.id;
        await this.receive(pending.args, pending.intent);
      } else if (this.pendingInitial) await this.receive({ tripId: this.pendingInitial }, ++this.intent);
    } catch (error) { this.report(error); }
  }
  close() { this.ready = false; this.invalidate(); return this.app.close?.(); }
}
