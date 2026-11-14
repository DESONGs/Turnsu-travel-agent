---
name: "Turnsu 统一旅行工作台"
description: "暖白工作空间、原版 Turnsu 标识与清晰的旅行任务层级。"
colors:
  brand-orange: "#FD7106"
  brand-ink: "#121211"
  travel-accent: "#C45200"
  travel-accent-hover: "#A74300"
  travel-accent-active: "#803200"
  travel-link: "#A74300"
  travel-soft: "#FFF5EB"
  selection-ground: "#FFE4CC"
  travel-muted: "#625D56"
  travel-caption: "#6F6961"
  travel-ground: "#F5F2ED"
  travel-paper: "#FFFFFF"
  travel-subtle: "#F8F6F2"
  travel-line: "#D9D3CA"
  control-line: "#857E73"
  tag-ground: "#F0ECE6"
  travel-green: "#08784F"
  success-ground: "#defbf0"
  travel-warning: "#925000"
  warning-ground: "#fdf4ea"
  travel-error: "#C92532"
  error-ground: "#fce6e8"
  overlay: "rgba(18,18,17,.55)"
typography:
  page-heading:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "32px"
    fontWeight: 750
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  task-heading:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  compact-heading:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  content-heading:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.4
  support:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  tag: "4px"
  control: "8px"
  media: "12px"
  card: "16px"
spacing:
  space-50: "4px"
  space-100: "8px"
  space-150: "12px"
  space-200: "16px"
  space-250: "20px"
  space-300: "24px"
  canvas: "28px"
  space-400: "32px"
  space-500: "40px"
  space-600: "48px"
components:
  button-primary:
    backgroundColor: "{colors.travel-accent}"
    textColor: "{colors.travel-paper}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.travel-accent-hover}"
    textColor: "{colors.travel-paper}"
  button-primary-active:
    backgroundColor: "{colors.travel-accent-active}"
    textColor: "{colors.travel-paper}"
  button-secondary:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.brand-ink}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.travel-error}"
    textColor: "{colors.travel-paper}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.travel-link}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "8px 0"
  button-icon:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.control}"
    padding: "10px"
    height: "44px"
    width: "44px"
  input:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  navigation-current:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.travel-link}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  tag:
    backgroundColor: "{colors.tag-ground}"
    textColor: "{colors.travel-muted}"
    rounded: "{rounded.tag}"
    padding: "4px 8px"
  journal-card:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.brand-ink}"
    rounded: "{rounded.card}"
  sheet:
    backgroundColor: "{colors.travel-ground}"
    textColor: "{colors.brand-ink}"
    typography: "{typography.control}"
---

# Design System: Turnsu 统一旅行工作台

## Overview

**Creative North Star: "Turnsu 统一旅行工作台"**

以真实旅行内容构成清楚、有人情味的工作空间：安排、地点、照片和随记始终围绕同一次云端旅行。暖白底色与克制的分隔线提供秩序，原版 Turnsu 标识保留个性，深橙色引导操作。界面以完成任务为主（Operate），通过标题、留白、分组和可达控件降低理解与操作成本。

照片和目的地场景可以成为内容主角，控件保持安静。保存结果、未知条件、冲突和恢复动作紧邻相关内容，并保留明确文字。主标题先说明当前任务，旅行名称与必要上下文随后出现；不同页面与侧层保持同一工作台的连续感。

本文件记录已实现的 React／DSH 统一工作台及复用同一画布的 Web 界面。视觉基础为 Turnsu Design System 1.1.2 插件随包提供的 1.1.1 规范，实际实现见 [旅行适配层](src/web/design-system/travel-theme.css)和 [工作台组件](src/web/workspace/)。固定来源、文件哈希和 Inter 许可证见 [资源说明](src/web/design-system/README.md)。本记录覆盖浅色产品界面；旧原生客户端、完整深色适配、真实供应商与原生宿主的验收结论由对应交付记录说明。

**Key Characteristics:**

- 原版完整 Logo，保持比例；品牌橙、操作色与链接色各有职责。
- 暖白画布、墨色文字、Inter 字体与中文系统回退。
- 以内容、底色和细边界建立层级，覆盖层采用共享阴影。
- 桌面左导航、窄栏顶部导航与任务侧层共享同一旅行上下文。

## Colors

暖白、纯白与暖灰承担大部分界面面积；橙色用于品牌和操作，成功、风险与未知各自保留语义。精确值以 frontmatter 为准，代码使用 `--turnsu-*` 变量；旧组件别名由旅行适配层接入同一来源。

### Primary

- **Turnsu 品牌橙 / 品牌墨色**：保留在完整原版 Logo 中。素材与原始校验记录见 [品牌资源](src/web/brand/README.md)。
- **深橙操作色、悬停色、按下色**：白字主按钮的三个状态，不以更亮的 Logo 原橙替换。
- **深橙链接色 / 浅橙选中底**：浅色背景中的文字操作与选中状态；选中同时保留文字、边界或可访问状态。

### Secondary

- **成功绿 / 成功浅底**：明确的保存反馈与已知悉状态。
- **提醒棕 / 提醒浅底**：待核验条件、暂定采用说明与需用户判断的提示。
- **错误红 / 错误浅底**：失败、危险操作和阻止采用的已知冲突。

### Neutral

- **正文墨色、辅助暖灰、说明暖灰**：依次用于主要内容、次要说明和补充资料。地点详情标签、来源与恢复说明使用可读的辅助色。
- **暖白画布、纯白表面、浅暖白内层**：分别承载工作空间、控件与头尾区域、侧层正文与媒体空态。
- **暖灰边界 / 控件边界**：内容分组使用较轻边线；可输入或可点击控件保留更清晰的边界。
- **标签浅灰 / 遮罩**：静态权限标签使用低强调底色；覆盖层遮罩降低背景显著度。

**The Original Logo Rule.** 完整 Logo 直接使用原素材并保持比例；品牌橙、白字按钮操作色与浅底链接色分别使用对应语义变量。

**The Visible State Rule.** 保存、待核验和已知冲突保持不同语义色与可读文字；知悉未知条件不等于条件已经核实。

## Typography

**Display Font:** 与正文共用 Inter，无独立装饰字体。
**Body Font:** 自托管 Inter 4.1 可变字体；中文由设备的苹方、微软雅黑等字体回退。字体文件随产品构建，保留 SIL Open Font License 1.1。

**Character:** 中文正文平实清楚，标题以字重和适度紧缩字距建立层级。frontmatter 仅记录当前工作台实际使用的角色，不将基础包的完整展示字阶视为产品已经采用。价格、日期与时间使用等宽数字，不改变数值口径。

### Hierarchy

- **旅行主标题**：桌面使用页面标题角色（32px），窄栏使用任务标题大小（25px）；旅行身份标题沿用可变字重（750）与紧凑行距。媒体页保留较轻的旅行上下文层级。
- **任务标题**：比较、手账页和侧层标题使用任务标题角色（25px、600）；窄侧层和窄内容页缩到紧凑标题角色（20px）。
- **内容标题**：章节、共享范围和审阅到访使用内容标题角色（18px）；记录详情与地点标题按任务层级呈现，名称允许换行。
- **正文与关键事实**：基础正文和主要到访事实使用正文大小（16px）；手账长文保留换行与较宽松行距，摘要和说明通常限制在 58–70ch。
- **控件与说明**：主要按钮、表单标签与密集正文使用控件大小（14px）；来源、日期和辅助说明使用说明大小（12px）。地点详情的事实标签与事实值保持层级，不将旧局部小字扩大成全局标准。

**The Readable Context Rule.** 主标题说明当前任务，必要上下文紧随其下；来源、状态与权限使用可读名称，关键事实和恢复说明不缩成难读的小字。

## Layout

宽画布采用固定左栏（216px）加可伸展主画布。左栏停靠视口并可独立滚动；主画布左右通常留 28px。完整 Logo 在桌面导航中的实际宽度为 132px。

视口不超过 760px 时，左栏改为顶部栏（至少 64px 高），Logo 宽度为 124px，菜单由按钮打开。菜单宽度为 `min(300px, calc(100% - 48px))`，背景内容保留在遮罩后。主画布左右留 18px；窄插件栏按可用宽度适配。

每日安排与关联地图在宽画布并排，间距为 28px；不超过 1100px 时纵向排列。普通 Web 的既有对话列位于画布内（320px，较窄桌面为 280px）；嵌入界面使用宿主对话。候选卡片在 1000px 以下按可用宽度自动排列，窄栏继续随实际内容宽度收缩。

手账内容最大宽度为 1240px，网格从三列在 1020px 变为两列，在 650px 变为单列。编辑和详情采用内容主栏加上下文栏，小屏上下排列。沉浸场景与章节在宽画布按约 2:1 并排，820px 以下上下排列，章节改为横向可滚动控件。

侧层从右侧覆盖当前画布：普通宽度最多 680px，宽版最多 1100px；宽版在 1020px 以下占满可用宽度。头尾保留，正文独立滚动。650px 以下收紧内边距并照顾底部安全区域；640px 以下审阅底部说明与操作纵向排列。

间距以 4/8 点节奏组织，常用步长已列于 frontmatter；既有主画布保留 28px 间距，侧层在宽画布使用 32px 水平内边距。表单、图片和长文本允许收缩与换行，分段控件在窄栏横向滚动，不撑开整个工作台。

## Elevation & Depth

大部分层级由底色、留白和一像素边线形成。普通手账卡片与地图容器不使用装饰性大阴影。侧层、地点详情和账号对话框使用 Turnsu 共享覆盖层阴影；遮罩与不透明表面共同表达覆盖关系。

### Shadow Vocabulary

- **共享覆盖层**：使用 `--turnsu-shadow-overlay`；精确值记录于 sidecar，适用于右侧任务层、地点详情与账号对话框。
- **局部修改对话框**：保留现有居中对话框阴影（`0 20px 100px #0003`），不推广到普通卡片。

**The Flat Surface Rule.** 普通内容以底色、留白和边界建立层级；阴影用于真正覆盖内容的任务层与对话框。

## Shapes

按钮、输入和选择器使用轻圆角（8px）；静态权限标签为小圆角（4px）。照片详情、浮雕舞台及沉浸场景使用媒体圆角（12px）；手账和候选卡片、主要地图容器使用容器圆角（16px）。共享账号头像为圆形；侧层自身是贯穿视口的直边平面，按功能保留轮廓差异。

## Components

### Buttons

主要按钮使用操作色配白字，常用内边距为 10px 16px，最小高度为 44px。悬停和按下逐步加深颜色，颜色与边界过渡为 150ms。次要按钮使用纯白底、细边和墨色字；文字按钮使用链接色，悬停出现下划线；危险按钮使用错误红。图标按钮通常为 44px 方形，并有可访问名称。返回与共享中的文字动作同样保留 44px 可触区域。

可见焦点使用两像素外描边并留出三像素间隔，颜色与品牌操作焦点一致。禁用状态降低不透明度并禁止操作；保存、失败与未知状态由邻近文字说明，不能只改颜色。

### Chips

权限和资料标签使用浅灰底、辅助暖灰字与小圆角。编辑权限使用浅橙底和链接色变体。标签说明权限或状态，不代替确认按钮；分段类别控件与静态标签分别保留自己的选中语义。

### Cards / Containers

手账卡片将照片或文字摘录置于上部，日期、标题与说明置于下部。照片列表裁切封面，详情与浮雕保留原图比例；纯文字记录使用浅暖白摘录区域，仍有完整入口。卡片以细边界分组，悬停加深边线。图片读取与保存失败保留真实状态和局部恢复入口。

### Inputs / Fields

标签始终可见。纯白输入配清晰暖灰边线，常用内边距为 11px 12px，最小高度为 44px；部分手账字段保留 45px 的实际最小高度。文本域可垂直调整。辅助说明紧邻字段，错误以文字与恢复动作出现。手账正文可独立存在，日期、地点与照片允许后补。

### Navigation

Phosphor 线性功能图标配短文字，常用图标为 20px。导航项至少 46px 高，当前页使用纯白表面、细边界、较高字重和链接色，图标使用操作色。窄栏菜单保留当前旅行、同一导航和账号入口；打开后管理焦点，支持 Escape 关闭并返回触发按钮。

完整 Logo 的进入动画属于每次重新打开的工作台会话：居中出现、放大、回缩，再停靠到应用自己的导航 Logo 位，总长约 1000ms，缓动为 `cubic-bezier(.16,1,.3,1)`，背景淡出为 620ms。启动内容切换接续同一开始时间；切页、切旅行和展开界面不重播。减少动态效果时直接显示已停靠 Logo；窗口尺寸变化或页面转为隐藏时结束动画。

### Task Sheet

统一侧层承载手账编辑、照片浮雕、目的地沉浸、共享与审阅。标题在上，必要上下文在下，关闭按钮在右侧；头尾纯白，正文浅暖白，底部操作不会随正文滚走。打开时聚焦标题，焦点留在层内；关闭后回到原触发位置。保存中禁用关闭，未保存或结果未确认时提供明确的内联确认与恢复操作。

浮雕把原图对照、风格、远近和视角控件放在同一侧层，通过“保存效果”明确保存，原图保留。沉浸把场景、章节、热点和依据置于同一任务层，风格化场景的说明贴近地点与场景依据。共享逐步呈现账号核对、权限与确认；审阅把未知条件放在受影响的到访或交通旁，以复选框和文字表达知悉进度，已知冲突单独说明并继续阻止采用。

## Do's and Don'ts

### Do:

- **Do** 使用用户提供的完整 Turnsu Logo，保留比例、原色与素材来源。
- **Do** 使用旅行适配层的 Turnsu 语义变量，让暖白表面、墨色文字和操作层级保持一致。
- **Do** 在手机和窄插件栏提供同一导航、可达操作与可独立滚动的侧层正文。
- **Do** 将保存、未知、冲突和恢复动作放在相关内容旁，同时保留文字含义。
- **Do** 支持减少动态效果、键盘操作与可见焦点。

### Don't:

- **Don't** 用 Logo 原橙直接替换白字按钮操作色或浅底小字链接色。
- **Don't** 将内部枚举、实现说明或开发指令当作产品标题与来源名称。
- **Don't** 为普通卡片添加宽大装饰阴影、玻璃效果或与品牌无关的渐变。
- **Don't** 在切页、切旅行或展开界面时重播品牌进入动画。
- **Don't** 用颜色、场景或图片暗示尚未核实的旅行事实已经确认。
- **Don't** 因基础包带有深色变量，就把产品写成已完成全界面深色适配。
