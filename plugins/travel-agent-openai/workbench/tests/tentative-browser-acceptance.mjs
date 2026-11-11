import { click } from "./browser-acceptance.mjs";
const require = (value, message) => { if (!value) throw new Error(message); };
const action = "采用暂定行程并开启风险跟进";

// These functions require a fresh workbench-service-fixture backed by real Java/MCP/PostgreSQL.
// Only identities and the source responses are simulated; adoption is never implemented in JS.
export async function resumePartialReviewAfterReload(tab) {
  const frame=tab.playwright.frameLocator("iframe");
  await frame.getByRole("button",{name:"核验并采用",exact:true}).waitFor({state:"visible"});
  await click(tab,frame,"核验并采用");
  let form=frame.getByRole("form",{name:"确认暂定行程",exact:true});
  await form.waitFor({state:"visible"});
  for(const box of (await form.getByRole("checkbox").all()).slice(0,2)) await box.check();
  await frame.getByRole("button",{name:"返回草案",exact:true}).waitFor({state:"visible"});
  await click(tab,frame,"返回草案");
  await tab.reload();
  await frame.getByRole("button",{name:"核验并采用",exact:true}).waitFor({state:"visible"});
  await click(tab,frame,"核验并采用");
  form=frame.getByRole("form",{name:"确认暂定行程",exact:true});
  await form.waitFor({state:"visible"});
  const checked=await form.locator('input[type="checkbox"]').evaluateAll(boxes=>boxes.map(box=>box.checked));
  require(checked.slice(0,2).every(Boolean)&&checked.slice(2).every(value=>!value),"Partial cloud review was lost or changed after reload");
  require(!await frame.getByRole("button",{name:action,exact:true}).isEnabled(),"Reload enabled adoption with an incomplete saved review");
  await click(tab,frame,"返回草案");
  return {savedAfterReload:2,remainingUnchecked:checked.length-2};
}
export async function reviewTentativeItinerary(tab) {
  const frame = tab.playwright.frameLocator("iframe");
  await frame.getByRole("button", { name: "核验并采用", exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "核验并采用");
  const form = frame.getByRole("form", { name: "确认暂定行程", exact: true });
  await form.waitFor({ state: "visible" });
  const labels = await form.locator("label").allTextContents({});
  for (const topic of ["营业", "费用", "同行人", "往返", "天气"]) require(labels.some(text => text.includes(topic)), "Missing condition: " + topic);
  const boxes = await form.getByRole("checkbox").all();
  const submit = frame.getByRole("button", { name: action, exact: true });
  require(!await submit.isEnabled(), "Adoption is enabled before acknowledgment");
  for (const box of boxes.slice(0, -1)) await box.check();
  await tab.getAXState({ emit: false });
  require(!await submit.isEnabled(), "Partial acknowledgment enables adoption");
  await boxes.at(-1).check(); await tab.getAXState({ emit: false });
  require(await submit.isEnabled(), "Complete acknowledgment does not enable adoption");
  await boxes[0].uncheck(); await tab.getAXState({ emit: false });
  require(!await submit.isEnabled(), "Removing acknowledgment does not disable adoption");
  await boxes[0].check(); await tab.getAXState({ emit: false });
  return { unknownConditions: boxes.length, partialAcknowledgmentBlocked: true };
}
export async function adoptAndReopenTentativeItinerary(tab) {
  const frame = tab.playwright.frameLocator("iframe");
  await click(tab, frame, action);
  await frame.getByRole("heading", { name: "暂定行程", exact: true }).waitFor({ state: "visible" });
  await tab.reload();
  await frame.getByRole("heading", { name: "暂定行程", exact: true }).waitFor({ state: "visible" });
  await frame.getByText(/覆盖缺口：天气仅按当前目的地查询/).waitFor({ state: "visible" });
  require(await frame.getByText(/这份安排尚未完成核验/).isVisible(), "Tentative status lost after reopen");
  require(await frame.getByText(/覆盖缺口：天气仅按当前目的地查询/).isVisible(), "Coverage gaps lost after reopen");
  require(!await frame.getByRole("heading", { name: "已核验行程", exact: true }).isVisible(), "Acknowledgment falsely verified the plan");
  return { persistedAfterReload: true, status: "tentative" };
}
export async function checkWeatherAndPause(tab) {
  const outer = tab.playwright, frame = outer.frameLocator("iframe");
  await click(tab, outer, "模拟天气基准");
  await outer.getByText("隔离天气基准已保存", { exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "刷新跟进");
  await frame.getByText("已取得天气基准", { exact: true }).waitFor({ state: "visible" });
  require(!await frame.getByRole("button", { name: "查看变化依据", exact: true }).isVisible(), "A baseline was misreported as a change");
  await click(tab, outer, "模拟天气变化");
  await outer.getByText("隔离天气变化已保存", { exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "刷新跟进");
  await frame.getByRole("button", { name: "查看变化依据", exact: true }).waitFor({ state: "visible" });
  require(await frame.getByRole("button", { name: "查看变化依据", exact: true }).count() === 1, "Duplicate weather changes shown");
  await click(tab, frame, "查看变化依据");
  await frame.getByText(/白天雨/).waitFor({ state: "visible" });
  await click(tab, frame, "暂停跟进");
  await frame.getByRole("button", { name: "恢复跟进", exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "刷新跟进");
  require(await frame.getByText("当前未安排", { exact: true }).isVisible(), "A paused plan still schedules a check");
  require(await frame.getByText(/覆盖缺口：天气仅按当前目的地查询/).isVisible(), "Pausing hid coverage gaps");
  return { weatherChanges: 1, evidence: "simulated-source-via-real-service", paused: true };
}
