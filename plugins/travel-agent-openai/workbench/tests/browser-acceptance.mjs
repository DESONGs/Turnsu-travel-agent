// Run through cua_repl with an already-bound tab on workbench-browser-fixture.mjs.
// The fixture uses the actual compiled page and SDK bridge, with synthetic identity/data.
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const title = "账号 A 的私人旅行";
const privateFields = ["CNY 1,200", "核验地点（合成资料）"];

export async function click(tab, scope, name) {
  try { await scope.getByRole("button", { name, exact: true }).click(); }
  catch (error) {
    // The desktop bridge can lose an iframe's native node after its parent changes.
    // Re-observe and use the sole current accessibility button, never a stale index.
    if (!String(error.message).includes("No node found")) throw error;
    const state = await tab.getAXState({ emit: false, disableDiffing: true });
    const buttons = state.split("\n").map(line => line.match(/^\s*(\d+) button (.*)$/)).filter(Boolean)
      .filter(match => match[2] === name || match[2].startsWith(name + ", ID:"));
    if (buttons.length !== 1) throw error;
    await tab.click(Number(buttons[0][1]));
  }
  await tab.getAXState({ emit: false });
}
async function checkCleared(frame) {
  ensure(!await frame.getByRole("heading", { name: title, exact: true }).isVisible(), "Old trip title remains visible");
  for (const value of privateFields) ensure(!await frame.getByText(value, { exact: true }).isVisible(), "Old private field remains visible: " + value);
  ensure(!await frame.getByRole("button", { name: "修改时间", exact: true }).isVisible(), "Old draft actions remain visible");
}
export async function verifyOpenAiHost(tab) {
  const outer = tab.playwright, frame = outer.frameLocator("iframe");
  await frame.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "重新核验");
  await frame.getByText("营业及预约尚未核实。", { exact: false }).waitFor({ state: "visible" });
  await click(tab, frame, "请助手继续核验");
  ensure(!await frame.getByRole("button", { name: "发送到对话", exact: true }).isVisible(), "Unlinked trip exposes send action");
  ensure(await outer.locator("#sent").innerText() === "0", "Unlinked request was sent");
  await click(tab, outer, "关联旅行 A 对话");
  await frame.getByRole("button", { name: "发送到对话", exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "发送到对话");
  ensure(await outer.locator("#sent").innerText() === "1", "Linked request was not sent exactly once");
  await click(tab, outer, "切换账号 B");
  await checkCleared(frame);
  await click(tab, outer, "恢复账号 A");
  await click(tab, outer, "打开旅行 A");
  await click(tab, outer, "暂缓打开文件 A");
  await click(tab, outer, "打开文件 B");
  await frame.getByRole("heading", { name: "文件 B 的旅行", exact: true }).waitFor({ state: "visible" });
  await click(tab, outer, "释放文件 A");
  ensure(await frame.getByRole("heading", { name: "文件 B 的旅行", exact: true }).isVisible(), "Late file A replaced file B");
  await click(tab, outer, "打开旅行 A");
  await frame.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
  await click(tab, outer, "撤销访问");
  await click(tab, frame, "刷新");
  await checkCleared(frame);
  return { host: "openai", identityCleared: true, accessCleared: true, fileOrderPreserved: true, linkedMessages: 1, verification: "unverified" };
}

export async function verifyStandardHost(tab, { placesFirst = false } = {}) {
  const frame = tab.playwright.frameLocator("iframe");
  await frame.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
  await click(tab, frame, "重新核验");
  await frame.getByText("营业及预约尚未核实。", { exact: false }).waitFor({ state: "visible" });
  if (placesFirst) {
    await frame.getByRole("heading", { name: "候选地点", exact: true }).waitFor({ state: "visible" });
    const headings = await frame.locator("h2").allTextContents({});
    ensure(headings.indexOf("候选地点") < headings.indexOf("旅行要求"), "Saved optional component order was not rendered");
  }
  return { host: "standard-mcp", verification: "unverified", ...(placesFirst ? { savedOrder: "places-before-requirements" } : {}) };
}
