import type { MobilityObservation } from "../contracts/index.js";

type RouteEvidence = Partial<Pick<MobilityObservation, "status" | "source" | "checkedAt" | "freshUntil" | "coverage" | "legs" | "caveats">>;

/** A model handoff, not a new feasibility check or business state. Unknowns
 * remain unknown; the existing Checker alone determines adoption eligibility. */
export function planningRouteEvidence(mobility?: RouteEvidence | null) {
  const legs = mobility?.legs ?? [];
  const alternatives = legs.map(leg => leg.alternatives.find(option => option.mode === leg.recommendedMode));
  const coverage = mobility?.coverage ?? null;
  const complete = mobility?.status === "completed" && coverage !== null && !coverage.unscheduled
    && coverage.unresolvedNodeIds.length === 0 && (coverage.unresolvedStopIds?.length ?? 0) === 0
    && legs.length > 0 && alternatives.every(Boolean);
  const total = (key: "totalMinutes" | "walkingMeters" | "transfers" | "estimatedFareCny") => {
    const values = alternatives.map(option => option?.[key]);
    return complete && values.every(value => typeof value === "number" && Number.isFinite(value))
      ? values.reduce<number>((sum, value) => sum + (value as number), 0) : null;
  };
  return {
    status: mobility?.status ?? "not_checked",
    source: mobility?.source ?? null,
    checkedAt: mobility?.checkedAt ?? null,
    freshUntil: mobility?.freshUntil ?? null,
    coverage,
    modes: [...new Set(alternatives.flatMap(option => option ? [option.mode] : []))],
    legCount: legs.length,
    totalMinutes: total("totalMinutes"),
    walkingMeters: total("walkingMeters"),
    transfers: total("transfers"),
    estimatedFareCny: total("estimatedFareCny"),
    accessibility: legs.map((leg, index) => ({
      legId: leg.legId,
      hasStairs: alternatives[index]?.accessibilityAssessment?.hasStairs ?? null,
      stepFreeContinuity: alternatives[index]?.accessibilityAssessment?.stepFreeContinuity ?? null,
      realTimeStatus: alternatives[index]?.accessibilityAssessment?.realTimeStatus ?? null,
    })),
    caveats: mobility?.caveats ?? [],
  };
}

// Shared by ordinary conversation, complete planning and focused route changes.
// This guides the existing Parent; it does not stop tools or rewrite its reply.
export const TRAVEL_DELIVERY_RULES = `面向旅行者交付：
- 先说本轮结果：具体改了什么、草案能否采用、原安排是否保留。局部修改只展开变化、实际影响和必要缺口，完整新行程才展开按天安排；不重复用户已知的整套过程。简洁不能删掉影响采用的未知项。
- 执行次数、修复预算、工具调用、固定锚点、候选编号、试算版本等内部控制不作为业务解释。不要说“修复尝试已经用完”“核验只做了一次”；说具体哪段通路或哪项资料仍未查明、会影响什么。地点用实际名称；没有名称就用来源给出的称呼，不发明商家。
- planSummary 的 rationale、priorities、assumptions 都是规划解释与假设，不是已查实的外部事实。室内、安静、打车、没有标出楼梯，都不能推出轮椅通行更安全、全程无台阶或电梯可用。不能据此将某处说成风险更低或最高，也不能为了消除未知而无根据地换店、删活动；选择可由有依据的其他偏好决定，无障碍未知继续保留。
- 路线数字是来源在 checkedAt 的查询估算。walkingMeters=0 只表示路线返回未计入步行，不能说游客完全不用走路；特别是车门到入口、室内通路仍可能未覆盖。null 表示未知，不能说成 0 或免费。source/caveats/sourceStatus 表示测试资料时明确这不是实际出行查询；既不能隐藏这个边界，也不能用这些数字保证真实可达性。
- 实际改变了用餐时间就说明时间变化，不能把“餐厅未换”说成“午餐安排完全未变”。没有可靠证据的寄存、隔音、叫车供给、可预订性只列为待核实；不得从规划假设改写成承诺。
- 真正需要用户补事实或选取舍时走 ask_travel_question，只问一个必要问题。其余交付到结果为止，不追加“如果你愿意／需要，我还可以……”或让用户重新授权已委托的比较、补查、保存。来源仍无资料时交代具体缺口和恢复条件，不承诺未经登记的后台补查或自动通知。`;
