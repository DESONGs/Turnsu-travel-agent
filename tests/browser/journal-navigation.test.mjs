import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  await button(frame, "记一笔").click();
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
  await button(frame, "写第一页").click();
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
    await button(frame, "写第一页").click();
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
  await button(frame, "写第一页").click();
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
  const journal = button(frame, "记一笔");
  await journal.waitFor();
  assert.deepEqual(await palette(journal), brand);
  assert.notDeepEqual(await palette(button(frame, "加入路线试排")), brand);
  assert.equal(await root.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await button(frame, "对照原照片").click();
  await frame.getByAltText("你选中的景点照片").waitFor();
  const split = frame.getByRole("slider", { name: "原照显示比例" });
  await split.press("Home");
  assert.equal(await split.inputValue(), "0");
  await split.press("End");
  assert.equal(await split.inputValue(), "100");
  await frame.getByRole("img", { name: "黄山风景区的分层手绘" }).waitFor();
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

test("同画面对照后可原位写字，装帧随一篇回忆保存、重开和导出", async t => {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}});
  t.after(() => page.close());
  let downloaded = Promise.withResolvers();
  const frame = await host.open(page, {onDownload: file => downloaded.resolve(file)});
  await openView(frame, /先感受这里/);
  await frame.getByLabel("选择景点照片文件").setInputFiles(landscape);
  const picture = frame.getByRole("img", {name:"黄山风景区的分层手绘"});
  await picture.waitFor();
  const originalCanvas = await picture.locator("canvas").first().elementHandle();
  await button(frame, "对照原照片").click();
  const slider = frame.getByRole("slider",{name:"原照显示比例"});
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width*.76, box.y + box.height/2, {steps: 8});
  await page.mouse.up();
  assert.ok(Number(await slider.inputValue()) > 70);
  await button(frame, "记一笔").click();
  const note = frame.getByLabel("我想记住", {exact:true});
  await note.fill("这是写在画旁的回忆");
  const [artBox, noteBox] = await Promise.all([picture.boundingBox(), note.boundingBox()]);
  assert.ok(noteBox.x >= artBox.x + artBox.width, "wide view keeps both leaves side by side");
  await slider.press("ArrowLeft");
  await button(frame, "回到手绘").click();
  assert.equal(await originalCanvas.evaluate(c => c.isConnected && c === c.parentElement.firstElementChild), true);
  assert.equal(await note.inputValue(), "这是写在画旁的回忆");
  await frame.locator("summary").filter({hasText:"选择装帧"}).click();
  const persian = frame.getByRole("radio", {name:"波斯 · 萨法维画册"});
  await persian.check();
  const artAfter = await picture.boundingBox();
  await page.setViewportSize({width:390,height:844});
  const narrowArt = await picture.boundingBox(), narrowNote = await note.boundingBox();
  assert.ok(narrowNote.y >= narrowArt.y+narrowArt.height, "narrow view puts notes below artwork");
  assert.ok(artAfter.width > 0);
  await button(frame, "收进我的手账").click();
  await frame.getByText("已收入私人手账").waitFor();

  // Leave the widget and ask the real repository for this author's journal again.
  await page.reload();
  await openView(frame, /留下旅行记录/);
  await button(frame, "翻开手账").click();
  await frame.getByText("这是写在画旁的回忆", {exact:true}).waitFor();
  await frame.getByText("波斯 · 萨法维画册", {exact:true}).waitFor();
  await button(frame, "做成明信片").click();
  await frame.getByLabel("分享格式").selectOption("png");
  await button(frame, "生成分享文件").click();
  await button(frame, "下载明信片").click();
  const file = await downloaded.promise;
  assert.equal(file.mimeType,"image/png");
  const atlas = await readFile(new URL("../../src/web/journal-bindings-world.webp", import.meta.url));
  const exported = await page.evaluate(async ({data, texture}) => {
    const bitmap = (encoded, type) => createImageBitmap(new Blob([Uint8Array.from(atob(encoded), char => char.charCodeAt(0))], {type}));
    const img = await bitmap(data,"image/png");
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d"); ctx.drawImage(img,0,0); img.close();
    const samples = ctx.getImageData(40,0,c.width-80,8).data;
    const bindings = await bitmap(texture,"image/webp");
    // The Safavid binding is the upper-right cover on the design sheet.
    const w = bindings.width/2, h = bindings.height/2;
    ctx.drawImage(bindings,w,0,w,h,0,0,c.width,c.height); bindings.close();
    const reference = ctx.getImageData(40,0,c.width-80,8).data;
    const error = samples.reduce((sum, pixel, i) => sum + Math.abs(pixel-reference[i]), 0)/samples.length;
    return {width:c.width,height:c.height,error};
  }, {data:file.blob,texture:atlas.toString("base64")});
  assert.deepEqual([exported.width, exported.height], [720,540]);
  assert.ok(exported.error < 3, "the exported border differs from the chosen binding by " + exported.error);
  downloaded = Promise.withResolvers();
  await frame.getByLabel("分享格式").selectOption("gif");
  await button(frame,"生成分享文件").click(); await button(frame,"下载明信片").click();
  const gif = await downloaded.promise;
  assert.equal(gif.mimeType,"image/gif");
  const gifBytes = Buffer.from(gif.blob,"base64");
  assert.equal(gifBytes.subarray(0,3).toString(),"GIF");
  assert.deepEqual([gifBytes.readUInt16LE(6),gifBytes.readUInt16LE(8)],[720,540]);
});

test("合上再翻开从最近一页读起，页角和键盘翻到不同回忆", async t => {
  const isolated = await createJournalHost();
  t.after(() => isolated.close());
  const page = await browser.newPage();
  t.after(() => page.close());
  const frame = await isolated.open(page);
  await openView(frame, /留下旅行记录/);
  const open = button(frame, "翻开手账");
  await button(frame, "写第一页").click();
  const write = async (text, date) => {
    await frame.getByLabel("我想记住",{exact:true}).fill(text);
    await frame.getByLabel("记录日期",{exact:true}).fill(date);
    await button(frame, "收进我的手账").click();
    await frame.getByText(text,{exact:true}).waitFor();
  };
  await write("山下的回忆", "2025-03-02");
  await button(frame, "写一页").click();
  await write("山上的回忆", "2025-03-03");
  await button(frame, "合上手账").click();
  await open.click();
  await frame.getByText("山上的回忆",{exact:true}).waitFor();
  const next = button(frame, "从页角翻至下一页");
  await next.click();
  await frame.getByText("山下的回忆",{exact:true}).waitFor();
  await page.keyboard.press("ArrowLeft");
  await frame.getByText("山上的回忆",{exact:true}).waitFor();
});

test("切换景点标签时游标向目标伸展，开启减少动态后直接定位", async t => {
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  t.after(() => page.close());
  const frame = await host.open(page);
  await detail(frame);
  const tabs = frame.getByRole("tablist", { name: "切换地点阅读视角" });
  const indicator = tabs.locator(".sliding-tabs-indicator");
  await indicator.waitFor();
  for (const [name, direction] of [["手账","right"], ["概览","left"]]) {
    const start = await indicator.boundingBox();
    const target = tabs.getByRole("tab", {name, exact:true});
    await target.click();
    const goal = await target.boundingBox();
    // Sample both actual CSS transitions at the same instant, independent of machine speed.
    const sample = await indicator.evaluate(async pill => {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const edges = pill.getAnimations().filter(a => ["left","right"].includes(a.transitionProperty));
      for (const animation of edges) { animation.pause(); animation.currentTime = 105; }
      const width = pill.getBoundingClientRect().width;
      for (const animation of edges) animation.finish();
      return {width, direction:pill.dataset.activationDirection};
    });
    assert.equal(sample.direction, direction);
    assert.ok(sample.width > Math.max(goal.width,start.width)+4, name + " should stretch toward the next tab");
  }
  await page.emulateMedia({reducedMotion:"reduce"});
  const next = tabs.getByRole("tab",{name:"真实资料"});
  await next.click();
  const [pill, selected] = await Promise.all([indicator.boundingBox(), next.boundingBox()]);
  assert.ok(Math.abs(pill.x-selected.x) < 2 && Math.abs(pill.width-selected.width) < 2);
  assert.equal(await indicator.evaluate(el => el.getAnimations().length), 0);
});

test("把新手绘补到已有的文字回忆，采用那一篇的文字与装帧", async t => {
  const isolated = await createJournalHost();
  t.after(() => isolated.close());
  const page = await browser.newPage({reducedMotion:"reduce"});
  t.after(() => page.close());
  const frame = await isolated.open(page);
  await openView(frame, /留下旅行记录/);
  await button(frame, "写第一页").click();
  const note = frame.getByRole("textbox",{name:"我想记住",exact:true});
  await note.fill("先在路上记下的那句话");
  await frame.locator("summary").filter({hasText:"选择装帧"}).click();
  await frame.getByRole("radio",{name:"加纳 · 阿散蒂织纹"}).check();
  await button(frame,"收进我的手账").click();
  await frame.getByRole("article").getByText("先在路上记下的那句话",{exact:true}).waitFor();
  await frame.getByRole("tab",{name:"立体视角",exact:true}).click();
  await frame.getByLabel("选择景点照片文件").setInputFiles(landscape);
  await button(frame,"记一笔").click(); await note.fill("尚未保存的另一段文字");
  await frame.locator("summary").filter({hasText:"把画补到已有回忆"}).click();
  const select = frame.getByRole("combobox",{name:"选择要更新插画的篇章"});
  await select.selectOption({index:1});
  await decide(frame,"继续编辑");
  assert.equal(await note.inputValue(),"尚未保存的另一段文字");
  await select.selectOption({index:1});
  await decide(frame,"放弃修改");
  assert.equal(await note.inputValue(),"先在路上记下的那句话");
  await button(frame,"把手绘存入这一页").click();
  await frame.getByText("已收入私人手账").waitFor();
  await page.reload(); await openView(frame,/留下旅行记录/);
  await button(frame,"翻开手账").click();
  await frame.getByText("第 1 页，共 1 页").waitFor();
  await frame.getByText("加纳 · 阿散蒂织纹",{exact:true}).waitFor();
  await frame.getByRole("img",{name:"黄山风景区的分层手绘"}).waitFor();
});
