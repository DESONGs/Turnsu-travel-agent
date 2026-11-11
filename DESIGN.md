---
name: "Turnsu 统一旅行工作台"
description: "灰白画布、原版 Turnsu 标识与深橙操作组成的旅行工作空间。"
colors:
  brand-orange: "#FD7106"
  brand-ink: "#121211"
  travel-accent: "#a44300"
  travel-accent-hover: "#823300"
  travel-soft: "#fff1e8"
  travel-ink: "#17191c"
  travel-muted: "#60696d"
  navigation-muted: "#5d666c"
  travel-ground: "#fafbfc"
  travel-paper: "#ffffff"
  navigation-ground: "#f1f3f4"
  navigation-hover: "#e7eaec"
  navigation-current: "#e2e6e8"
  frame-line: "#e4e7e9"
  travel-line: "#dcded8"
  travel-green: "#315b4c"
  success-ground: "#edf4ef"
  travel-error: "#a1352b"
  tag-ground: "#eef1eb"
  tag-ink: "#526557"
typography:
  page-heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", sans-serif"
    fontSize: "29px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  sheet-heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.8
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  field-label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.6
  support:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Noto Sans CJK SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  tag: "4px"
  field: "7px"
  control: "8px"
  media: "10px"
  card: "12px"
spacing:
  micro: "4px"
  compact: "8px"
  related: "12px"
  control: "16px"
  content: "20px"
  section: "24px"
  canvas: "28px"
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
  button-secondary:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.travel-ink}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-danger:
    backgroundColor: "{colors.travel-error}"
    textColor: "{colors.travel-paper}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.travel-accent}"
    rounded: "{rounded.control}"
    padding: "8px 0"
  button-icon:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.travel-ink}"
    rounded: "{rounded.control}"
    padding: "10px"
    width: "44px"
  input:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.travel-ink}"
    rounded: "{rounded.field}"
    padding: "11px 12px"
  navigation-current:
    backgroundColor: "{colors.navigation-current}"
    textColor: "{colors.travel-ink}"
    rounded: "{rounded.control}"
    padding: "11px 12px"
  tag:
    backgroundColor: "{colors.tag-ground}"
    textColor: "{colors.tag-ink}"
    rounded: "{rounded.tag}"
    padding: "4px 8px"
  journal-card:
    backgroundColor: "{colors.travel-paper}"
    textColor: "{colors.travel-ink}"
    rounded: "{rounded.card}"
  sheet:
    backgroundColor: "{colors.travel-ground}"
    textColor: "{colors.travel-ink}"
---

# Design System: Turnsu 统一旅行工作台

## Overview

**Creative North Star: "Turnsu 统一旅行工作台"**

以真实旅行内容构成界面：安排、地点、照片和随记处于同一个清晰、有人情味的工作空间。灰白底色与克制的分隔线提供稳定秩序；原版 Turnsu 标识保留个性，深橙色引导操作。界面密度适中，依靠标题、留白与分组帮助阅读。

照片和目的地场景可以成为内容主角，控件保持安静。状态和限制贴近相关内容，以文字说明其含义；成功、未知与冲突各自可辨。标题先说明当前任务，旅行名称或必要上下文随后出现。

本系统记录已实现的 React／DSH 统一工作台及复用同一 React 画布的 Web 界面，不重新定义旧原生客户端。视觉依据是 `src/web/workspace/` 的组件、样式与本轮实际渲染；方向合同见 `design/unified-workbench/README.md`。视觉记录不表示真实宿主、来源或公开发布已通过验收。

**Key Characteristics:**

- 原版 Turnsu 完整 Logo，保留比例与橙黑配色。
- 灰白画布、深橙操作、扁平分组与适度圆角。
- 内容优先，侧层承载需要专注的编辑、预览与确认。
- 同一导航在宽画布和窄插件栏之间适配。

## Colors

品牌橙保留在原素材中；可点击操作使用更深的橙色，灰白层次承担大部分界面面积。精确值以 frontmatter 为准。

### Primary

- **Turnsu 品牌橙 / 品牌墨色**：来自用户提供的完整 Logo，不用于重新绘制或改色。素材与哈希见 `src/web/brand/README.md`。
- **深橙操作色 / 深橙悬停色**：主要按钮、当前导航图标与交互焦点。白字主按钮使用深橙操作色。
- **浅橙底色**：已选风格、章节等局部状态的背景，配合文字或选中标记使用。

### Secondary

- **沉静绿 / 成功浅底**：明确的保存反馈与成功状态。知悉未知条件后的绿色条目仍保留“待核验”文字。
- **错误红**：危险确认按钮与错误操作入口；风险同时用可读文字说明。

### Neutral

- **正文墨色 / 媒体辅助灰 / 导航辅助灰**：依次承载主内容、媒体侧层说明和框架次要信息。
- **浅白画布 / 纯白表面 / 导航灰底**：分别承载工作空间、控件或侧层头尾、左侧导航。
- **导航悬停灰 / 导航当前灰**：当前页以更深底色、字重和图标共同表达。
- **框架分隔线 / 媒体分隔线**：主框架使用偏冷灰线，媒体与侧层使用略暖灰线；保留当前实现中两个已存在的角色。
- **标签灰绿底 / 标签灰绿字**：紧凑的权限和资料标签，标签文字始终保留。

**The Original Logo Rule.** 完整 Logo 直接使用原素材并保持比例；品牌橙与白字操作按钮的深橙承担不同角色。

## Typography

**Display Font:** 无独立展示字体。
**Body Font:** 平台系统无衬线字体，优先 `-apple-system`、`BlinkMacSystemFont`、`Segoe UI`、`PingFang SC`；侧层继承页面的 CJK 与 Windows 后备字体。

**Character:** 中文正文清楚、平实；标题通过字重和适度紧缩字距建立层级。没有下载字体或装饰性展示字。frontmatter 记录重复使用的角色，局部内容按既有组件响应式缩放。

### Hierarchy

- **页面标题**：手账标题使用页面标题角色，小屏为 25px；主旅行标题在桌面为 30px，窄栏为 26px。
- **侧层标题**：使用侧层标题角色，小屏缩为 20px；旅行或照片上下文位于其下方。
- **内容标题**：记录标题通常为 18–26px；沉浸地点标题为 26px，小屏为 24px。名称允许换行。
- **正文**：通常为 13–15px；随记长文采用更宽松行距并保留换行。解释段落常限制在 58–70ch。
- **控件与说明**：主要控件为 14px，表单标签为 13px；辅助资料为 12px。现有局部元数据在小屏更小，不将其扩大成新的正文标准。

**The Readable Context Rule.** 主标题先说明当前任务；必要上下文紧随其下。来源、状态与权限使用可读名称，不向用户展示内部枚举。

## Layout

宽画布采用固定左栏（216px）加可伸展主画布。左栏停靠视口并可独立滚动；主画布左右通常留 28px。导航内的完整 Logo 实际宽度为 132px。具体页面结构以相应设计合同为准。

视口宽度不超过 760px 时，左栏改为顶部栏（至少 64px 高），Logo 宽度为 124px，菜单由按钮打开。菜单宽度为 `min(300px, calc(100% - 48px))`，背景内容保留在遮罩后。主画布左右留 18px。窄插件栏遵循这一规则，不按设备名称判断布局。

桌面每日安排与关联地图并排，间距为 28px；不超过 1100px 时改为纵向。普通 Web 的既有对话列位于画布内（320px，较窄桌面为 280px）；嵌入界面使用宿主对话。

手账内容最大宽度为 1240px，网格从三列在 1020px 变为两列，在 650px 变为单列。编辑与详情采用内容主栏加上下文栏，小屏上下排列。沉浸场景与章节在宽画布按约 2:1 并排，在 820px 以下上下排列，章节改为横向可滚动控件。

侧层从右侧覆盖当前画布：普通宽度最多 680px，宽版最多 1100px，均不超过可用视口；头部与底部操作保留，正文独立滚动。650px 以下收紧内边距；640px 以下审阅底部说明和操作纵向排列。

间距以 4px、8px、12px、16px、20px、24px、28px 的已用步长建立节奏。表单、图片和长文本允许收缩与换行，不以固定内容宽度撑开插件栏。

## Elevation & Depth

大部分层级由底色、留白和一像素边线形成。手账卡片与地图容器在静止状态没有装饰性大阴影。遮罩降低背景显著度；侧层的柔和侧向阴影说明其位于当前画布之上。

### Shadow Vocabulary

- **侧层阴影**（`-12px 0 40px #18221b20`）：用于右侧任务层。
- **浮动采用栏阴影**（`0 6px 26px #17191c12`）：沿用候选选择栏的轻微浮起感，不用于普通内容卡片。

**The Flat Surface Rule.** 普通内容以分隔和底色建立层级；将阴影留给真正覆盖或浮动在内容之上的控件。

## Shapes

控件使用轻圆角（8px），输入框与选择器更紧凑（7px），标签为小圆角（4px）。照片详情与浮雕舞台使用柔和媒体圆角（10px），手账卡片和地图容器使用 12px。共享账号头像使用圆形；侧层自身是贯穿视口的直边平面。保留这些按功能区分的轮廓。

## Components

### Buttons

主要按钮使用深橙底配白字，常用内边距为 10px 16px，最小高度为 44px。悬停只加深颜色，状态过渡为 150ms。次要按钮使用白底、细边与墨色字；文字按钮去掉可见底色，悬停出现下划线；危险按钮使用错误红。图标按钮通常为 44px 方形，保留可访问名称。禁用状态降低不透明度并禁止操作。

可见焦点使用三像素外描边并留出三像素间隔，工作台及侧层操作主要使用深橙。现有部分媒体控件仍保留蓝色焦点声明；这是局部实现差异，不是新的全局色彩角色。

### Chips

权限和资料标签使用紧凑灰绿色块、小圆角和可读文字。编辑权限使用浅橙变体。标签说明权限或状态，不代替确认按钮。

### Cards / Containers

手账卡片将照片或文字摘录置于上部，日期、记录标题与说明置于下部。照片列表裁切封面，详情与浮雕保留原图比例；纯文字记录使用浅灰绿摘录区域。卡片以细边界分组，悬停加深边线。空记录、图片加载与读取失败保留实际状态和局部重试入口。

### Inputs / Fields

标签始终可见。白底输入配细灰绿边，常用内边距为 11px 12px，最小高度为 45px；文本域允许垂直调整。辅助说明紧邻字段，错误以文字与恢复动作出现。手账正文可独立存在，日期、地点与照片后补；不以缺少图片隐藏文字记录。

### Navigation

Phosphor 线性功能图标配短文字，常用图标为 20px。导航项至少 46px 高，当前页同时改变底色、字重与图标色。窄栏菜单保留当前旅行、同一导航和账号入口；打开后管理焦点，支持 Escape 关闭并返回触发按钮。

完整 Logo 的进入动画仅属于每次新打开的工作台会话：居中出现、放大、回缩，再停靠到当前导航 Logo 位，总长约 1000ms，缓动为 `cubic-bezier(.16,1,.3,1)`。背景淡出为 620ms。启动界面切换接续同一开始时间；切页、切旅行或展开界面不重播。减少动态效果时直接显示已停靠 Logo；窗口尺寸或可见性变化时结束动画。

### Task Sheet

统一侧层承载手账编辑、照片浮雕、目的地沉浸、共享与审阅。标题在上、必要上下文在下，关闭按钮置于右侧。头尾纯白，正文浅白，底部操作区不会随正文滚走。打开时聚焦标题，焦点留在层内；关闭后回到原触发位置。保存中禁用关闭；未保存或结果未确认时使用明确的内联确认与恢复操作。

浮雕把原图对照、风格、远近和视角控件置于同一侧层，效果通过明确的“保存效果”动作保存，原图保留。沉浸把场景、章节、热点和依据放在同一任务层，风格化场景的说明靠近地点标题与场景依据。共享逐步呈现账号核对、权限与确认；审阅将未知条件放在受影响的到访或交通内容旁，以复选框和文字表达知悉状态，已知冲突单独说明并继续阻止采用。

## Do's and Don'ts

### Do:

- **Do** 使用用户提供的完整 Turnsu Logo，并保留比例和素材来源。
- **Do** 以灰白空间、标题、分隔线和克制的深橙操作建立层级。
- **Do** 在手机和窄插件栏提供同一导航、可达操作与可滚动正文。
- **Do** 将保存、未知、冲突和恢复动作放在相关内容旁，同时保留文字含义。
- **Do** 支持减少动态效果、键盘操作和可见焦点。

### Don't:

- **Don't** 用亮品牌橙直接替换白字主按钮的深橙操作色。
- **Don't** 将内部枚举、实现说明或开发指令当作产品标题与来源名称。
- **Don't** 为普通卡片添加宽大装饰阴影、玻璃效果或 AI 紫色渐变。
- **Don't** 在切页、切旅行或展开界面时重播品牌进入动画。
- **Don't** 用颜色、场景或图片暗示尚未核实的旅行事实已经确认。
