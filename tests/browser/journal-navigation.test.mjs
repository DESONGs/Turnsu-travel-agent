import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createJournalHost, landscape } from "./huangshan-host.mjs";

let browser, host;
before(async () => {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
  host = await createJournalHost();
});
after(async () => { await browser?.close(); await host?.close(); });

const button = (scope, name) => scope.getByRole("button", { name, exact: true });
const detail = frame => button(frame, "查看 黄山风景区 的详情").click();
const trial = frame => frame.getByRole("complementary", { name: "待确认的试排" });
async function openView(frame, name) {
  await detail(frame);
  await frame.getByRole("button", { name }).click();
}
async function scenario(t) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  page.setDefaultTimeout(5000);
  t.after(() => page.close());
  return host.open(page);
}
async function decide(frame, choice) {
  const prompt = frame.getByRole("alertdialog", { name: "放弃未保存的手账修改？" });
  await button(prompt, choice).click();
  await prompt.waitFor({ state: "hidden" });
}

test("手绘回忆试排前可保留文字，明确放弃后才加入试排", async t => {
  const frame = await scenario(t);
  await openView(frame, /先感受这里/);
  await frame.getByLabel("选择景点照片文件").setInputFiles(landscape);
  await button(frame, "做成旅行手账").click();
  const note = frame.getByRole("textbox", { name: "我想记住" });
  await note.fill("石峰后的云");
  await button(frame, "加入路线试排").click();
  await decide(frame, "继续编辑");
  assert.equal(await note.inputValue(), "石峰后的云");
  assert.equal(await trial(frame).count(), 0);
  await button(frame, "加入路线试排").click();
  await decide(frame, "放弃修改");
  await frame.getByRole("dialog").waitFor({ state: "hidden" });
  await button(trial(frame), "移出试排：黄山风景区").waitFor();
  await openView(frame, /留下旅行记录/);
  await frame.getByText(/记下一个地点和一句想留下的话/).waitFor();
  await button(frame, "写一页").click();
  assert.equal(await note.inputValue(), "");
});

test("同行记录返回前保留照片和备注，放弃后两者都清空", async t => {
  const frame = await scenario(t);
  await openView(frame, /留下旅行记录/);
  await button(frame, "查看同行照片记录").click();
  await frame.getByLabel("拍的是什么").selectOption("food");
  await frame.locator('input[type=file]').setInputFiles(landscape);
  const note = frame.getByRole("textbox", { name: "这次想记住什么？" });
  await note.fill("伙伴的路餐");
  const photo = frame.getByRole("img", {name: "待保存照片 1"});
  await photo.waitFor();
  await button(frame, "回到我的手账").click();
  await decide(frame, "继续编辑");
  assert.equal(await note.inputValue(), "伙伴的路餐");
  assert.equal(await photo.isVisible(), true);
  await button(frame, "回到我的手账").click();
  await decide(frame, "放弃修改");
  await button(frame, "查看同行照片记录").click();
  assert.equal(await note.inputValue(), "");
  assert.equal(await photo.count(), 0);
});

test("宿主禁用原生弹窗时，取消编辑和关闭详情都能主动放弃", async t => {
  const frame = await scenario(t);
  await openView(frame, /留下旅行记录/);
  const note = frame.getByRole("textbox", { name: "我想记住" });
  for (const action of ["取消", "关闭地点详情"]) {
    await button(frame, "写一页").click();
    await note.fill("只想暂时留下");
    await button(frame, action).click();
    await decide(frame, "继续编辑");
    assert.equal(await note.inputValue(), "只想暂时留下");
    await button(frame, action).click();
    await decide(frame, "放弃修改");
    await note.waitFor({ state: "hidden" });
  }
  await frame.getByRole("dialog").waitFor({ state: "hidden" });
  await openView(frame, /留下旅行记录/);
  await frame.getByText(/记下一个地点和一句想留下的话/).waitFor();
  await button(frame, "写一页").click();
  assert.equal(await note.inputValue(), "");
});

test("沉浸页按试排状态显示加入或移出，并执行对应操作", async t => {
  const frame = await scenario(t);
  await openView(frame, /先感受这里/);
  await button(frame, "加入路线试排").click();
  await button(trial(frame), "移出试排：黄山风景区").waitFor();
  await button(frame, "打开按天路书").click();
  const confirmRoute = button(frame, "确认加入行程");
  await confirmRoute.waitFor();
  assert.equal(await confirmRoute.evaluate(el => getComputedStyle(el).backgroundColor), "rgb(253, 113, 6)");
  await button(frame, "返回发现与比较").click();
  await openView(frame, /先感受这里/);
  await button(frame, "移出路线试排").click();
  await trial(frame).waitFor({ state: "hidden" });
  await openView(frame, /先感受这里/);
  await button(frame, "加入路线试排").waitFor();
});

test("窄侧栏跟随宿主主题，观画、写手账和路线操作按页面区分", async t => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  const frame = await host.open(page, { theme: "dark" });
  const root = frame.locator("html");
  await detail(frame);
  const overview = button(frame, "加入行程试排");
  await overview.waitFor();
  const palette = control => control.evaluate(el => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color];
  });
  const brand = ["rgb(253, 113, 6)", "rgb(23, 16, 10)"];
  assert.equal(await root.getAttribute("data-theme"), "dark");
  assert.deepEqual(await palette(overview), brand);
  await frame.getByRole("button", { name: /先感受这里/ }).click();
  await frame.getByLabel("选择景点照片文件").setInputFiles(landscape);
  const journal = button(frame, "做成旅行手账");
  await journal.waitFor();
  assert.deepEqual(await palette(journal), brand);
  assert.notDeepEqual(await palette(button(frame, "加入路线试排")), brand);
  assert.equal(await root.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await button(frame, "对照原照片").click();
  await frame.getByAltText("你选中的景点照片").waitFor();
  await button(frame, "回到手绘").click();
  await button(frame, "向右看").click();
  const moved = frame.locator(".painting-stage canvas").first();
  await moved.evaluate(node => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const offset = await moved.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).m41);
  assert.ok(Math.abs(offset) > 0);
  await button(frame, "回正").click();
  await moved.evaluate(node => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await moved.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).m41), 0);
  await journal.click();
  const note = frame.getByRole("textbox", { name: "我想记住" });
  await note.fill("云开见石峰");
  await page.evaluate(() => document.querySelector("iframe").contentWindow.postMessage({
    jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" },
  }, location.origin));
  await frame.locator('html[data-theme="light"]').waitFor({ state: "attached" });
  assert.equal(await note.inputValue(), "云开见石峰");
});
