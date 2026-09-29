import { createHash } from "node:crypto";
import { executionError } from "./execution-contract.js";
import type { TripFeasibility } from "../contracts/index.js";

export function decisionHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)])) : item;
  return createHash("sha256").update(JSON.stringify(stable(value)) ?? "null").digest("hex");
}

export type AdvanceType = "execute_read" | "revise_draft" | "delegate_parent" | "ask_user" | "deliver";
export function completePlanningRequested(text: string): boolean {
  let requested = false;
  for (const clause of text.split(/[。；;，,\n]/u)) {
    const planning = /(?:完整|详细|按天).{0,8}(?:行程|规划)|(?:complete|full|day.by.day).{0,16}(?:itinerary|plan)/iu.test(clause);
    const negated = /(?:不要|不用|不需要|无需|暂不|先不|先别|don't|do not).{0,12}(?:完整|详细|按天|complete|full|itinerary|plan)/iu.test(clause);
    const cancelled = /算了|取消规划|不用了|先别做|先不做|(?:先只|只|先)(?:比较|查资料|看候选)|(?:just|only)\s+compare/iu.test(clause);
    if (negated || cancelled) requested = false;
    else if (planning) requested = true;
  }
  return requested;
}
export interface AdvanceInput {
  hardConflicts?: string[]; missingFacts?: string[]; userUnknowns?: string[];
  canRead?: boolean; deterministic?: boolean; draftReady?: boolean;
  calibrated?: boolean; confidence?: number; threshold?: number; reversible?: boolean;
  repairCount?: number; expired?: boolean;
}

/** Authority and exact facts precede semantic confidence. This never returns a commit. */
export function decideTravelAdvance(input: AdvanceInput): { type: AdvanceType; reason: string; targets: string[] } {
  const action = (type: AdvanceType, reason: string, targets: string[] = []) => ({ type, reason, targets });
  if (input.expired) return action("deliver", "partial_deadline");
  if (input.hardConflicts?.length) return action("ask_user", "constraint_tradeoff", input.hardConflicts);
  if (input.missingFacts?.length && input.canRead) return action("execute_read", "obtainable_facts", input.missingFacts);
  if (input.userUnknowns?.length) return action("ask_user", "user_owned_fact", input.userUnknowns);
  if (input.missingFacts?.length) return action("deliver", "evidence_unavailable", input.missingFacts);
  if (input.draftReady) return action("deliver", "reviewable_draft");
  if ((input.repairCount ?? 0) >= 1) return action("deliver", "repair_budget_exhausted");
  if (input.deterministic || (input.calibrated && input.reversible && input.threshold !== undefined && (input.confidence ?? 0) >= input.threshold)) return action("revise_draft", "within_confirmed_bounds");
  return action("delegate_parent", "open_or_uncalibrated_judgment");
}

export interface TravelQuestion {
  schemaVersion: "travel-question-v2"; runId: string; questionId: string; question: string;
  choices: string[]; options: { optionId: string; label: string; impact?: string }[];
  dependencyHash: string; readSet: string[]; status: "open" | "answered" | "stale";
  impact: string; consumedByRunId?: string;
}
export interface TravelAnswer { runId: string; questionId: string; optionId?: string }

/** Provider-owned unknowns do not become mandatory questions after a failed
 * repair. Missing personal facts and actual budget/scope choices remain valid. */
export function planningQuestionAction(input: { missingPersonalFact: boolean; providerUnavailable?: boolean; issues?: TripFeasibility["issues"] }): "ask_user" | "continue_parent" {
  if (input.missingPersonalFact) return "ask_user";
  const blocking = (input.issues ?? []).filter(issue => issue.severity === "blocking");
  const legacyEvidenceCodes = new Set(["traveler_step_free_route_unverified", "foreign_guest_stay_unverified", "required_route_missing", "mobility_stale"]);
  if (input.providerUnavailable || (blocking.length > 0 && blocking.every(issue => issue.resolution === "provider_evidence" || (!issue.resolution && legacyEvidenceCodes.has(issue.code))))) return "continue_parent";
  return "ask_user";
}

/** Arithmetic in a material user decision belongs to the ledger, not model
 * prose. This presents choices only; the stable answer protocol owns consent. */
export function budgetTradeoffQuestion(budget?: { totalBudget?: number | null; estimated?: number; domains?: Record<string, { unknownCount?: number }> } | null) {
  if (!budget || !Number.isFinite(budget.totalBudget) || !Number.isFinite(budget.estimated) || budget.estimated! <= budget.totalBudget!) return null;
  const format = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  const limit = format(budget.totalBudget!);
  const estimate = format(budget.estimated!);
  const unknown = Object.values(budget.domains ?? {}).some(bucket => (bucket.unknownCount ?? 0) > 0);
  return {
    question: `当前草案${unknown ? "已知部分至少" : "整趟估算约"}${estimate}元，超过${limit}元预算；已计入市内交通的已知费用。${unknown ? "另有费用待核验。" : ""}你希望如何处理这个差额？`,
    choices: [
      `保持${limit}元，我补充可调整的要求`,
      unknown ? "我重新说明可接受的预算" : `预算改为${estimate}元，原要求不变，重新核验`,
      "预算和要求都不变，先保留待核验草案",
    ],
    optionImpacts: [
      "在你明确说明前保留原要求；不会自动删酒店、餐食或其他必要安排。",
      unknown ? "先取得你的新上限再重算，当前预算不自动改变。" : "采用这个选项后按新上限重算；估算不是最低报价或费用保证，仍需通过完整核验。",
      "保存草案与费用缺口，停止本轮调整；不会采用超预算安排。",
    ],
    impact: "这是当前草案的完整账本，不代表所有来源中的最低价。只有你的回答可以改变预算或要求；行程采用仍需单独授权。",
  };
}

/** Ask for the first blocking fact, never a form disguised as one question. */
export function nextPlanningQuestion(control: { brief?: { destination?: unknown; dates?: unknown }; travelers?: unknown[] } | null, completePlanning: boolean, proposedQuestion = ""): { question: string; choices: string[]; impact: string } | null {
  const dateQuestion = /日期|哪天|几号|什么时候出发/u.test(proposedQuestion);
  const peopleQuestion = /几位|几人|多少人|人数/u.test(proposedQuestion);
  const destinationQuestion = /城市|目的地|去哪里|去哪/u.test(proposedQuestion);
  if (!control?.brief?.destination) return destinationQuestion && !dateQuestion && !peopleQuestion ? null : { question: "你想去哪个城市？", choices: [], impact: "确定目的地后，我会先查可用的旅行选择。" };
  if (completePlanning && !control.brief.dates) return dateQuestion && !peopleQuestion && !destinationQuestion ? null : { question: "你打算哪天出发？", choices: [], impact: "日期会影响营业时间、天气与安排；回答后我会接着完成行程。" };
  if (completePlanning && control.travelers?.length === 0) return peopleQuestion && !dateQuestion && !destinationQuestion ? null : { question: "包括你在内，一共几位同行？", choices: [], impact: "已提供的要求已经保存。人数决定房间、交通与餐饮的预算。" };
  return null;
}

export function questionFacts(control: Record<string, unknown> | null): unknown {
  // Conservatively bind the complete decision inputs, not timestamps, provider
  // progress or storageVersion. Unrelated storage writes cannot invalidate a card.
  if (!control) return { tripId: null };
  return Object.fromEntries(["tripId", "revision", "brief", "travelers", "nodes", "locks"].filter(key => control[key] !== undefined).map(key => [key, control[key]]));
}

export function createTravelQuestion(input: { runId: string; questionId: string; question: string; choices?: string[]; optionImpacts?: string[]; facts: unknown; impact?: string }): TravelQuestion {
  const choices = [...new Set(input.choices ?? [])].slice(0, 3);
  return { schemaVersion: "travel-question-v2", runId: input.runId, questionId: input.questionId, question: input.question,
    choices, options: choices.map(label => {
      const impact = input.optionImpacts?.[input.choices?.indexOf(label) ?? -1]?.trim();
      return { optionId: `option_${decisionHash([input.questionId, label]).slice(0, 16)}`, label, ...(impact ? { impact } : {}) };
    }),
    dependencyHash: decisionHash(input.facts), readSet: ["tripId", "revision", "brief", "travelers", "nodes", "locks"], status: "open",
    impact: input.impact ?? "这个回答将用于继续安排当前旅行。" };
}

export function validateTravelAnswer(question: TravelQuestion, answer: TravelAnswer, facts: unknown, text = ""): { text: string } {
  if (!question || question.schemaVersion !== "travel-question-v2" || question.runId !== answer.runId || question.questionId !== answer.questionId) throw executionError("question_not_found", 404);
  if (question.status !== "open") throw executionError("question_already_answered");
  if (question.dependencyHash !== decisionHash(facts)) throw executionError("question_stale");
  if (answer.optionId) {
    const option = question.options.find(item => item.optionId === answer.optionId);
    if (!option) throw executionError("question_option_invalid", 400);
    return { text: option.label };
  }
  if (!text.trim()) throw executionError("question_answer_empty", 400);
  return { text: text.trim() };
}

export interface CandidateJudgment { candidateId: string; fit: number; support: string; eligible: boolean; confidence?: number }
export function selectPlanningContext<T extends { nodeId: string; title?: string; domain?: string; selected?: boolean; lock?: unknown }>(
  nodes: T[], { focusedIds = [], objective = "", limit = 24 }: { focusedIds?: string[]; objective?: string; limit?: number } = {},
): T[] {
  const focused = new Set(focusedIds);
  const protectedNode = (node: T) => node.selected || Boolean(node.lock) || focused.has(node.nodeId)
    || (Boolean(node.title && node.title.length > 1) && objective.toLocaleLowerCase().includes(node.title!.toLocaleLowerCase()));
  if (focused.size) return nodes.filter(protectedNode);
  if (nodes.length <= limit) return nodes;
  const selected = nodes.filter(protectedNode);
  const groups = new Map<string, T[]>();
  for (const node of nodes.filter(node => !protectedNode(node))) {
    const group = groups.get(node.domain ?? "other") ?? [];
    group.push(node); groups.set(node.domain ?? "other", group);
  }
  while (selected.length < limit && [...groups.values()].some(group => group.length)) {
    for (const group of groups.values()) {
      if (selected.length >= limit) break;
      const node = group.shift(); if (node) selected.push(node);
    }
  }
  // A soft context budget never silently drops locked or user-named facts.
  // The caller's byte budget fails explicitly if protected context is too big.
  return selected;
}
export function rankDecisionCandidates<T extends { candidateId?: string }>(candidates: T[], judgments: CandidateJudgment[]): T[] {
  const score = (candidate: T) => {
    const value = judgments.find(item => item.candidateId === candidate.candidateId);
    return value?.eligible && value.support === "supported" ? value.fit : 0;
  };
  // Four-point ordinal judgments do not justify churn for a tiny score gap.
  // Group by a fixed band so comparison stays transitive and ties stay stable.
  return [...candidates].sort((a, b) => Math.floor(score(b) * 4) - Math.floor(score(a) * 4));
}

export class TravelExecutionDeferred extends Error {
  readonly code = "execution_deferred";
  constructor(readonly notBefore: number, readonly waitReason = "model_capacity") { super("execution_deferred"); }
}
