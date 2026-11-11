---
name: Travel Agent OpenAI 工作台
description: 让旅行内容与具体选择清楚可见的中性工作界面
colors:
  ink: "#282c2f"
  muted: "#60696d"
  line: "#dcded8"
  paper: "#fff"
  ground: "#fafaf7"
  accent: "#b84232"
  accent-hover: "#963525"
  soft: "#fbefea"
  green: "#315b4c"
  warning: "#78511b"
  error: "#a1352b"
  focus: "#365f89"
  tag-background: "#eef1eb"
  tag-text: "#526557"
typography:
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "29px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.9
  reading:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 2.1
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.6
  control:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
rounded:
  tag: "4px"
  field: "7px"
  control: "8px"
  media: "10px"
  card: "12px"
spacing:
  tight: "8px"
  control-gap: "12px"
  content: "16px"
  group: "20px"
  section: "24px"
  sheet: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.paper}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.paper}"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "{colors.paper}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 0"
  field:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  tag:
    backgroundColor: "{colors.tag-background}"
    textColor: "{colors.tag-text}"
    rounded: "{rounded.tag}"
    padding: "4px 8px"
  record-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "0"
  chapter-current:
    backgroundColor: "{colors.soft}"
    textColor: "#9a4231"
    padding: "14px 11px"
  sheet:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    width: "min(680px,100%)"
  sheet-wide:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    width: "min(1100px,100%)"
---

# Design System: Travel Agent OpenAI 工作台

## Overview

**Creative North Star: "当代博物馆访客信息"**

清楚的标题、可辨认的选项和安静的界面，让旅行照片、地点和实际决定成为主角。瓷白背景、石墨文字与克制的朱红强调形成日常工具的秩序，不模拟纸张或展板。

本文件记录当前 OpenAI 插件公共控件及手账、浮雕、沉浸、共享四项扩展的实现。宿主承担对话，工作台承担查看、编辑与确认。六个核心规划场景仍是独立设计稿；范围与证据见[界面说明](.impeccable/surfaces/travel-journey-redesign.md)。当前视觉来源为 [media-workspace.css](plugins/travel-agent-openai/workbench/src/media-workspace.css) 和 [workbench.css](plugins/travel-agent-openai/workbench/src/workbench.css)，旧版 map-pulse 和被否定的蓝绿原型不再指导新界面。

**Key Characteristics:**

- 中性色组织信息，朱红明确主动作和当前选择。
- 一套系统无衬线字体，依靠字号、字重和留白形成层级。
- 照片与可操作的三维内容承担表达，边框和分隔线承担结构。
- 侧层保持上下文，保存、权限与恢复状态清楚可见。

## Colors

色值以前置 token 为准；CSS 中对应 `--travel-*`，焦点与标签色来自重复使用的控件规则。

### Primary

朱红 `accent` 用于保存等主动作、文字动作、选中下划线及照片选中边框；`accent-hover` 是主按钮悬停态。`soft` 为当前选择或提示提供轻底色。

### Neutral

瓷白 `ground` 是页面和侧层底色，纯白 `paper` 是控件、记录和侧层头尾。石墨 `ink` 承担主文字，`muted` 承担日期和辅助信息，`line` 承担分隔。`tag-background` 与 `tag-text` 用于有文字说明的状态标签。

成功 `green`、注意 `warning`、错误 `error` 只表达具体状态；焦点 `focus` 标识键盘操作位置。这些功能色不构成另一套页面主题，状态同时提供文字或图标。

**The Quiet Frame Rule.** 中性色承担结构，朱红用于主动作和选中状态；照片和三维内容承担目的地表达。

## Typography

正文、标题与控件共用前置 token 中的系统字体栈，无独立展示字体或运行时字体下载。正文常用 `body`，完整手账内容使用更宽松的 `reading`；表单标签使用 `label`，主按钮在 `control` 基础上加粗（600）。日期和计数需要对齐时使用等宽数字。

页面标题使用 `headline`，侧层任务标题使用 `title`；手机分别降到（25px）与（20px）。记录卡标题为（18px），手机为（20px）；其余小标题按内容落在（15–18px）。辅助信息常用（11–12px）；少量手机辅助文字仍为（10px），未将其提升为通用字号。关键决定不压成小字。

**The One Typeface Rule.** 用同一字体的字号、字重和间距区分任务层级，不新增装饰字体或重复标题。

## Layout

公共外壳上限为（1184px），桌面水平内边距为（32px）；手账自身上限为（1240px），实际宽度受宿主区域约束。手账画廊从三列，在（1020px）以下变两列，在（650px）以下变单列。卡片间距依次为（23px）、（20px）、（21px），保留内容自然高度。

标准侧层从右侧打开，宽度见 `sheet`；编辑、浮雕与沉浸使用 `sheet-wide`，在（1020px）以下占满可用宽度。侧层高度为（100dvh），头尾固定在布局中，中间内容独立滚动。桌面头部与内容横向内边距为 `sheet`，手机为（18px）。手机完整铺满视口，操作栏保持可见。

手账编辑将内容与日期／到访分成两栏，手机依次排列；侧层内只保留自身任务标题，不复制外层手账页面标题。沉浸场景与章节在桌面并列，在（820px）以下上下排列，章节入口可横向滚动。通用动作至少高（44px）；照片排序等紧凑按钮在手机增高到（44px）。

## Elevation & Depth

**The Flat Surface Rule.** 普通内容通过留白、底色与细边框区分；阴影只用于覆盖当前页面的侧层。

侧层使用柔和的左向阴影（`-12px 0 40px #18221b20`），遮罩为（`#24302a59`），层级为（2000）。三维深度属于照片效果或目的地内容，不扩展为玻璃控件或立体按钮。控件颜色与边框过渡为（150ms）；减少动态效果偏好会关闭相关过渡，三维导览也遵守该偏好。

## Shapes

标签、输入、按钮、媒体与记录卡依次使用前置圆角 token。外层页面不套大卡片；记录卡裁切照片，详情图片保留完整比例。普通控件和记录使用细边框（1px），照片选中边框为（2px）。圆形只用于共享成员头像等已有对象，不作为装饰图案。

## Components

- **按钮与字段：** 主按钮朱红底白字，次按钮白底细边，文字动作用朱红，删除确认使用错误色。禁用态保留文案并降低不透明度。字段始终有可见标签；新媒体控件的键盘焦点为（3px）轮廓，外移（3px）。
- **导航与状态：** 当前页有朱红文字及下划线；当前章节和照片使用明确选中态与 `aria-current`／`aria-pressed`。标签不能只靠色彩说明已到访、仅查看或错误。
- **手账：** 照片记录和纯文字记录共享画廊。标题、日期、到访可以后补；编辑、照片排序和关联使用原记录及稳定照片身份。冲突保留本地编辑，载入云端版本前说明会放弃什么。
- **侧层：** 打开后焦点进入任务标题，Tab 保留在侧层，关闭后回到原触发控件。Escape、遮罩和关闭按钮走同一关闭逻辑；未保存或结果未知时提供明确选择，保存中阻止关闭。
- **浮雕：** 先选择照片，再在本机调整。只有“保存效果”成功后更新同一照片的效果，源图片不变；查看者只预览。离开未保存调整时保留继续编辑或放弃的选择。
- **沉浸与共享：** 三维场景带键盘、视角与章节入口，并清楚说明风格化内容的性质。共享先查找已注册 Google 账号，再核对身份与查看／编辑权限影响；权限变更和撤销都有独立确认。

记录、效果与共享都以明确保存为边界；结果未知时显示待确认，并提供原次操作的恢复入口，不把预览或已发送请求显示为已保存。功能图标使用项目内联的 Phosphor SVG（MIT），保留许可；不使用字符或 emoji 代替图标。

## Do's and Don'ts

### Do:

- **Do** 让照片、文字和实际选择先于界面装饰，沿用瓷白、石墨与朱红的层级。
- **Do** 保留可见字段标签、键盘焦点、手机操作栏与具体恢复动作。
- **Do** 区分本地预览、未保存、保存结果未知和服务确认后的已保存。
- **Do** 在共享确认中同时展示账号、权限及对旅行和照片的影响。

### Don't:

- **Don't** 继承被否定的蓝绿页面主题、旧 map-pulse 布局或并列的产品聊天框。
- **Don't** 用玻璃效果、渐变、大数字面板或层层卡片填补内容。
- **Don't** 在编辑侧层重复外层页面标题，或把技术验收文字写进产品流程。
- **Don't** 将风格化三维、设计情景或本机服务结果说成真实来源或宿主验收。
