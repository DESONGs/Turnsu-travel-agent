import type { DecisionNode, ItineraryPlan, MobilityObservation, TripBrief, TripFeasibility, TripState } from "../contracts/index.js";
import { estimateTripBudget, validateTripCoherence } from "./trip-runtime.js";
import { journeyExecutionIssues } from "./journey-execution.js";

const constraintMessages: Record<string, string> = {
  traveler_step_free_route_unverified: "同行人要求全程无台阶，但连续无台阶路线尚未核验，当前方案不能采用。",
  traveler_stairs_route_conflict: "当前路线存在楼梯，与同行人的无台阶要求冲突。",
  traveler_walk_limit_exceeded: "当前路线超过同行人的步行上限。",
  traveler_transfer_limit_exceeded: "当前路线超过同行人的换乘上限。",
  foreign_guest_stay_unverified: "住宿是否可接待同行人尚未核验。",
  foreign_guest_stay_ineligible: "当前住宿不满足同行人的入住资格。",
};

export function completeItineraryIssues(plan: ItineraryPlan, brief: TripBrief = {}, userRequest = ""): TripFeasibility["issues"] {
  const issues: TripFeasibility["issues"] = [];
  const domains = brief.planningDomains ?? ["play", "food", "stay", "transport"];
  const dates = String(brief.dates ?? "").match(/20\d{2}-\d{2}-\d{2}/g) ?? [];
  const dateDays = dates.length >= 2 ? Math.round((Date.parse(dates[1]!) - Date.parse(dates[0]!)) / 86_400_000) + 1 : 1;
  const days = Math.max(brief.durationDays ?? 1, Number.isFinite(dateDays) ? dateDays : 1);
  for (let dayIndex = 1; dayIndex <= days; dayIndex++) {
    const day = plan.days.find(item => item.dayIndex === dayIndex);
    if (!day) {
      issues.push({ code: "requested_day_missing", severity: "blocking", message: `用户要求的第 ${dayIndex} 天没有安排；补齐这一天，不能缩短已保存的旅行天数。`, stopIds: [], dayIndex, allowedRepairDirections: ["move_to_next_day", "replace_candidate"] });
      continue;
    }
    const declaredException = day.purpose && userRequest.includes(day.purpose.userQuote);
    if (day.purpose && !declaredException) issues.push({ code: "day_scope_not_authorized", severity: "blocking", message: `第 ${dayIndex} 天不能擅自改成休息或自行安排；只允许引用用户已表达的安排。`, stopIds: [], dayIndex, allowedRepairDirections: ["replace_candidate"] });
    if (domains.includes("play") && !declaredException && !day.stops.some(stop => stop.role === "activity")) {
      issues.push({ code: "day_without_activity", severity: "blocking", message: `第 ${dayIndex} 天只有交通、住宿或餐饮，尚未完成这一天的游玩安排。请从有来源的候选补齐；偏好有取舍时解释取舍，不要把整天留空。`, stopIds: [], dayIndex, allowedRepairDirections: ["replace_candidate", "move_to_next_day"] });
    }
  }
  if (plan.needsContext.length) issues.push({ code: "planning_question_unresolved", severity: "blocking", message: `尚有未解决的问题：${plan.needsContext.join("；")}。先用已有事实和可撤销选择解决；仅用户独有的事实才提问，来源未知项应说明影响。`, stopIds: [], dayIndex: null, allowedRepairDirections: ["request_context", "replace_candidate"] });
  const visited = new Set<string>();
  for (const day of plan.days) for (const stop of day.stops.filter(item => item.role === "activity")) {
    if (visited.has(stop.nodeId) && !(day.purpose && userRequest.includes(day.purpose.userQuote))) issues.push({ code: "repeated_activity", severity: "blocking", message: "同一游玩项目被重复用来填充行程。先补查不同的合适项目；偏好是软条件时可选择现有替代项并解释取舍，不能用重复参观充当完整规划。用户明确要求重访或在同一处休息时保留原话作为依据。", stopIds: [stop.nodeId], dayIndex: day.dayIndex, allowedRepairDirections: ["replace_candidate"] });
    visited.add(stop.nodeId);
  }
  if (domains.includes("stay") && (brief.lodgingNights ?? 0) > 0 && !plan.days.some(day => day.stops.some(stop => stop.role === "stay_check_in" || stop.role === "stay_return"))) issues.push({ code: "requested_stay_missing", severity: "blocking", message: `用户要求住宿 ${brief.lodgingNights} 晚，但草案没有安排住宿。`, stopIds: [], dayIndex: null, allowedRepairDirections: ["replace_candidate"] });
  // These are meal opportunities within a planned day, not dietary advice or
  // an assumption that breakfast/late arrival requires a restaurant booking.
  const minutes = (value?: string, durationMinutes = 0) => {
    if (!value) return NaN;
    const local = new Date(Date.parse(value) + (480 + durationMinutes) * 60_000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  };
  for (const day of plan.days) {
    if (!domains.includes("food")) continue;
    if (!day.stops.length) continue;
    const starts = day.stops.map(stop => minutes(stop.timeWindow.startAt)).filter(Number.isFinite);
    const ends = day.stops.map(stop => stop.timeWindow.endAt ? minutes(stop.timeWindow.endAt) : minutes(stop.timeWindow.startAt, stop.durationMinutes)).filter(Number.isFinite);
    if (!starts.length || !ends.length) continue;
    const start = Math.min(...starts);
    // An overnight check-in is not the end of the traveler's day. Merely
    // moving check-in earlier must not make the evening meal disappear.
    const staysOvernight = day.stops.some(stop => stop.role === "stay_check_in" || stop.role === "stay_return");
    const end = Math.max(...ends, staysOvernight ? 20 * 60 : 0);
    for (const meal of [{ name: "午餐", from: 11 * 60, to: 14 * 60 + 30, spanStart: 12 * 60, spanEnd: 14 * 60 }, { name: "晚餐", from: 17 * 60, to: 20 * 60 + 30, spanStart: 18 * 60, spanEnd: 20 * 60 }]) {
      if (start > meal.spanStart || end < meal.spanEnd) continue;
      if (day.purpose && userRequest.includes(day.purpose.userQuote) && day.purpose.kind === "self_arranged") continue;
      if (day.stops.some(stop => stop.role === "meal" && minutes(stop.timeWindow.startAt) >= meal.from && minutes(stop.timeWindow.startAt) <= meal.to)) continue;
      issues.push({ code: "meal_window_missing", severity: "blocking", message: `第 ${day.dayIndex} 天的安排跨过${meal.name}时段，但没有安排用餐；请使用已有餐饮候选补齐并调整灵活活动，不能通过缩短行程隐藏缺口。`, stopIds: [], dayIndex: day.dayIndex, allowedRepairDirections: ["reorder_flexible_stop", "replace_candidate"] });
    }
  }
  return issues;
}

/** Business constraints apply to every commit, including proposals without a UI preview. */
export function tripBusinessIssues(state: TripState): TripFeasibility["issues"] {
  const qa = validateTripCoherence(state);
  const budget = estimateTripBudget(state);
  const issues: TripFeasibility["issues"] = [];
  for (const violation of qa.hardConstraintViolations) {
    const code = "code" in violation ? String(violation.code) : "traveler_constraint_unmet";
    if (!issues.some(issue => issue.code === code)) issues.push({ code, message: constraintMessages[code] ?? "当前方案不满足同行人的必要条件，需要核实或调整后才能采用。", severity: "blocking", stopIds: [], dayIndex: null,
      resolution: code.endsWith("unverified") ? "provider_evidence" : "plan_change",
      allowedRepairDirections: code.endsWith("unverified") ? ["replace_candidate", "fetch_evidence"] : ["replace_candidate", "change_mode"] });
  }
  if (budget.exceedsBudget) issues.unshift({ code: "trip_budget_exceeded", message: `当前方案预计 ${budget.estimated} 元，超过已确认的 ${budget.totalBudget} 元预算；先在相同需求内比较更便宜的候选和交通。不得改预算或删必要项目；确实无解时才说明来源范围与需要用户决定的取舍。`, severity: "blocking", stopIds: [], dayIndex: null, allowedRepairDirections: ["replace_candidate", "change_mode"] });
  return issues;
}

/** One decision for preview, trial and adoption, evaluated on projected TripState. */
export function withTripFeasibility(state: TripState, selectedNodes: DecisionNode[], mobility: MobilityObservation): MobilityObservation {
  const projected = { ...state, nodes: selectedNodes, pendingProposals: [], environment: { ...state.environment, mobility } };
  const base = mobility.feasibility;
  const businessIssues = [...tripBusinessIssues(projected), ...journeyExecutionIssues(state.brief, mobility.itinerary, selectedNodes, mobility, state.travelers)];
  const issues = [...businessIssues, ...(base?.issues ?? []).filter(issue => !businessIssues.some(blocker => blocker.code === issue.code))];
  const blocker = issues.find(issue => issue.severity === "blocking");
  const canConfirm = base?.canConfirm === true && !blocker;
  return { ...mobility, feasibility: {
    schemaVersion: "trip-feasibility-v1", canConfirm,
    status: canConfirm ? "feasible" : blocker ? "blocked" : base?.status ?? "needs_context",
    primaryBlocker: blocker?.message ?? base?.primaryBlocker ?? null,
    issues: issues.slice(0, 24), checkedAt: base?.checkedAt ?? mobility.checkedAt,
  } };
}
