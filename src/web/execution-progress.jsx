import { CheckCircle, CircleNotch, StopCircle, WarningCircle } from "@phosphor-icons/react";
import "./execution-progress.css";

export const isRunActive = (run) => ["queued", "running", "cancelling"].includes(run?.status);
const names = {
  save_trip_understanding: ["记住旅行要求", "Saving requirements"], get_trip_control_view: ["读取旅行要求", "Reading requirements"],
  get_trip_plan_view: ["查看当前方案", "Reading your plan"], research_trip_options: ["核验资料与查找候选", "Checking sources and options"],
  plan_itinerary_trial: ["核验按天路线", "Checking the itinerary"], calculate_trip_budget: ["核算旅行预算", "Checking the budget"],
  explain_recommendation: ["整理推荐依据", "Reviewing sources"], confirm_trip_selection: ["保存你确认的选择", "Saving your confirmed choice"],
  confirm_user_arrival: ["保存抵达事实", "Saving your arrival"], update_trip_readiness: ["更新出发准备", "Updating readiness"],
  inventory_budget: ["比较住宿、交通与预算", "Comparing inventory and budget"], local_discovery: ["分析当地体验与来源", "Reviewing local experiences"],
  operability_schedule: ["核对日程与同行人需求", "Checking the schedule and traveler needs"],
};

export function ExecutionProgress({ run, locale, onStop, onContinue, onReconnect, onAnswer, onReviewDraft }) {
  if (!run) return null;
  const en = locale === "en";
  const active = isRunActive(run);
  const question = run.status === "awaiting_input" && run.result?.question?.status === "open" ? run.result.question : null;
  const partial = run.status === "completed" && run.result?.outcome?.status === "partial";
  const labels = { queued: ["请求已保存，等待开始", "Request saved, waiting to start"], running: ["正在规划这趟旅行", "Planning your trip"], cancelling: ["正在停止后续操作", "Stopping further work"], completed: ["本轮已完成", "This step is complete"], failed: ["本轮未完成", "This step did not finish"], cancelled: ["已停止，已保存的内容仍保留", "Stopped. Saved work is kept"], interrupted: ["规划中断，已保存的内容仍保留", "Interrupted. Saved work is kept"] };
  const steps = new Map();
  for (const event of run.events ?? []) {
    const key = event.toolCallId ?? event.lane ?? (event.type.startsWith("compaction_") ? "context" : null);
    if (key) steps.set(key, event);
  }
  const failed = partial || ["failed", "interrupted"].includes(run.status);
  return <section className="travel-execution" aria-label={en ? "Planning progress" : "规划进度"}>
    <div className="travel-execution-heading" role="status">
      {active ? <CircleNotch className="spin" /> : failed ? <WarningCircle /> : <CheckCircle />}
      <strong>{run.status === "queued" && run.waitReason ? en ? "Your plan is saved. Work will resume automatically." : "当前方案已保留，稍后自动继续" : partial ? en ? "Some results are ready; gaps remain" : "已有部分结果，仍有待补充项" : run.status === "awaiting_input" ? question ? en ? "One detail to continue" : "补充一个信息即可继续" : en ? "This question has been updated" : "这个问题已处理或已更新" : (labels[run.status] ?? labels.running)[en ? 1 : 0]}</strong>
      {active && <button type="button" onClick={onStop} disabled={run.status === "cancelling"}><StopCircle />{en ? "Stop" : "停止"}</button>}
    </div>
    {steps.size > 0 && <ol>{[...steps.values()].slice(-5).map((step) => <li key={step.toolCallId ?? step.lane ?? "context"}>
      <span className={`execution-step-dot ${step.status === "running" ? "running" : step.status === "failed" ? "failed" : "done"}`} />
      <span>{step.type.startsWith("compaction_") ? en ? "Organizing conversation context" : "整理对话与未完成事项" : (names[step.toolName] ?? names[step.lane] ?? ["处理旅行资料", "Reviewing trip information"])[en ? 1 : 0]}</span>
      <small>{step.status === "running" ? active ? en ? "In progress" : "进行中" : en ? "Interrupted" : "已中断" : step.status === "failed" ? en ? "Incomplete" : "未完成" : en ? "Finished" : "已结束"}</small>
    </li>)}</ol>}
    {["reconnecting", "offline"].includes(run.connection) && <p role="status">{en ? "Connection interrupted. Your request is saved; reconnect to view its result." : "连接中断，请求已保存。重新连接即可查看结果。"}<button type="button" onClick={onReconnect}>{en ? "Reconnect" : "重新连接"}</button></p>}
    {!active && (partial || !["completed", "awaiting_input"].includes(run.status)) && <p>{run.requiresImage ? en ? "Attach the image again to continue." : "如需继续理解图片，请重新附图。" : en ? "Continue from the current saved plan when ready." : "可以从当前已保存的旅行继续规划。"}<button type="button" onClick={onContinue}>{en ? "Continue planning" : "继续规划"}</button></p>}
    {question && <div className="execution-question"><p>{question.question}</p><p>{question.impact}</p><div>{question.options.map((option) => <button type="button" key={option.optionId} onClick={() => onAnswer(option.label, { runId: run.runId, questionId: question.questionId, optionId: option.optionId })}><span>{option.label}</span>{option.impact && <small>{option.impact}</small>}</button>)}</div></div>}
    {run.status === "completed" && run.result?.itineraryTrial?.itinerary && <p><button type="button" onClick={onReviewDraft}>{en ? "Review this itinerary" : "查看这版行程"}</button></p>}
  </section>;
}
