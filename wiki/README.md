# Travel Agent V2 Wiki

Travel Agent 的文档总入口。三层结构：

- `current/`：唯一工作基准（产品、架构、交付规范），随用户决策持续修订；
- `research/`：**进行中迭代**的工作文档，根目录只保留当前一期；
- `research/archive/`：已关闭迭代的研究与审计，结论已吸收进 `current/`，只供追溯，不作为当前开发依据。

文档之间冲突时以最新用户决策为准并同步修订；文档更新不代表相应代码已实现。

## 当前优先迭代：可执行行程与完整交通链（2026-09-30）

用户满意现有地图，要求参考见好旅行规划器改善行程形成与交通安排，并交由主线程审查必要架构调整后开发。新增 [16 迭代与开发交接](./current/16-executable-itinerary-and-transport-iteration.md)规定完整往返/转场、方式比较、时间衔接、自驾/景交、费用、每日路书和验收路径；[参考研究与 QA 基线](./research/2026-09-30-transport-itinerary-reference-research.md)保存固定参考版本、代码位置、本轮真实模型加模拟旅行来源的用户测试、工程失败及未验证范围。

**开发方向已授权，主线程已接入基础修复和交通链服务层，完整用户路径仍未验收。** 否定重排、13 次到访 PostgreSQL 回读和 Journal 并发初始化的工程回归已通过；新增两日往返等六项受控测试通过。真实模型/浏览器复测、完整交通客户端与容量门槛仍开，不能将修复前的 QA 基线改写为修复后的通过证据。代码提交范围、检查记录和待办见[本轮代码提交记录](./research/2026-09-30-runtime-implementation-pr.md)。

本轮阅读顺序：16 → 配套研究的代码/QA 证据 → 14/15 → 对应实现。具体主线程入口与交接状态见 16 的最后一节。

## 延续基础：持续规划与模型上下文（2026-09-22）

用户确认：业务模型与 Parent LLM、Jev 必须围绕同一规划目标连续推进，上下文一起重设计。下列规范继续作为本轮基础；**代码改造尚未通过完整业务验收**。2026-09-22 的电脑操作复测曾发现预算假成功、未核验草案不可见、候选展示缩减及问题交付被压缩超时覆盖；详见[第二轮电脑 QA](./research/2026-09-22-computer-user-retest.md)。这些是当时的结果，2026-09-30 已复测部分场景，最新逐项结论见页首 QA 基线；未复测项不推断已修复。

| 文档 | 本次职责 | 状态 |
| --- | --- | --- |
| [14 持续规划业务模型](./current/14-continuous-planning-business-model.md) | 持久计划、具体到访、问题、依赖、局部变更与恢复 | 已确认方向 / 实现中、未验收 |
| [15 上下文与模型交接](./current/15-model-context-and-handoff.md) | Parent/Jev/Child 输入、变化交接、压缩、工具回执与接续 | 已确认方向 / 实现中、未验收 |
| [前序主线程开发交接](./research/2026-09-22-continuous-planning-redesign-handoff.md) | 根因证据、改造顺序、业务与上下文共同验收 | 延续基础；本轮入口见 16 |

这部分的阅读顺序：交接 → 14 → 15 → 相关现有实现。14/15 对旧文档中冲突的计划存储、上下文和恢复约定具有优先级；16 补充本轮行程与交通范围，其他权限与产品边界保留。

## 前序迭代与验证记录

2026-09-18 执行架构迭代：按用户最终确认，借鉴 LinkCode 改造现有旅行工作台，接入原生 Pi Session、持久任务、取消恢复、Child 交接和模型预算。[实现与验收记录](./research/2026-09-18-workbench-native-pi-execution-implementation.md)明确区分受控 500 短时容量、真实模型结果及尚未关闭的商用门槛；整体嵌入 LinkCode 的旧稿已被取代。

2026-09-21 自动推进迭代：依据[第二版方案](./research/2026-09-20-jev-travel-decision-team-design.md)，已接入 Jev HTTP 判断、持久配额等待、原生 Pi 接续、稳定问题回答协议及 Web／小程序适配。默认 `off`，未校准模板不能自动改草案。真实 Jev 中文评估、浏览器闭环、500 在线重连和 30 分钟受控规划负载已执行；接入时延与真实商用容量仍未通过，不能据此宣布生产验收完成。最新结果、复现命令及剩余门槛见[实现与验证记录](./research/2026-09-21-jev-automatic-planning-implementation.md)。

2026-09-21 真实旅行者复核：新增 15 组场景，真实模型／PostgreSQL／浏览器复核为 **5 通过、3 部分通过、7 失败**。已复现预算和硬性无障碍缺口仍能采用、回答后草案消失、回复与真实状态不一致等问题；工程回归通过不能替代这些用户路径。详见[用户验收报告与原始证据](./research/2026-09-21-real-traveler-acceptance-report.md)，本轮未修改产品代码修复问题。

2026-09-21 后续修复与返工：第一次修复中的预算拦截和 JSONB 往返修正保留；其中“工具早停＋固定文案”未完成实际规划业务，已按用户纠正返工。核验结果现在继续交给 Parent 比较、补查、修复和解释，失败草案持久可见；完整性覆盖日期、餐次、住宿与全部到访路线，新要求保留原站序但撤销旧路线证明。**真实来源、偏好满足、稳定时延与 500 商用容量仍需独立验收。** 当前代码证据和真实模型／HTTP／PostgreSQL／浏览器结果见[业务返工报告](./research/2026-09-21-traveler-business-rework.md)；[第一次修复报告](./research/2026-09-21-traveler-acceptance-fixes.md)只作历史追溯。

2026-09-22 电脑操作复测：桌面与手机视口实际执行补日期、采用、刷新、局部调整、硬约束与真实来源场景。普通路径部分通过；**新增无障碍要求后已采用的时间线丢失、恢复循环失败，以及局部补查后其他候选丢失仍未通过验收**。测试末段另确认模型账号余额不足，取消及部分接续路径未验证。完整案例、截图、数据库证据和环境边界见[电脑操作用户 QA 报告](./research/2026-09-22-computer-user-qa.md)。本轮未修改产品逻辑；“选中地点保留”不等于“已采用行程保留”。

2026-09-22 第二轮电脑复测：使用真实 Kimi/Jev、HTTP、PostgreSQL 和桌面/手机视口，另跑飞猪/途牛真实来源。普通补日期与采用刷新、取消、旧答案拒绝、硬约束下原时间线保留已验证；**仅改预算假成功、未核验草案不可见、候选 15→4 的显示缩减、生成的问题被压缩超时覆盖，以及多站预算更新后 PostgreSQL 回读失败仍未通过**。本轮仅修复工具 schema 的真实接口 400 和类型检查阻塞，保留业务失败回归；没有把 500 商用容量算作已验收。详见[第二轮电脑 QA 报告及证据](./research/2026-09-22-computer-user-retest.md)。

## 当前迭代：Evidence Companion（2026-08-31 启动）

| 文档 | 角色 | 状态 |
| --- | --- | --- |
| [PRD v0.2](./research/2026-08-31-travel-evidence-companion-prd.md) | 图文证据产品需求 | E0 / E1 已实现；E2 / E3 代码与本地安全 smoke 已完成，发布门仍开 |
| [初步技术方案 v0.2](./research/2026-08-31-travel-evidence-companion-technical-proposal.md) | E0–E5 分阶段技术方案 | E0–E3 已形成纵向代码链；E4 仅受限骨架，E5 未开始 |
| [下一阶段技术调研](./research/2026-08-31-evidence-companion-next-iteration-technical-research.md) | 官方能力、开源候选与 Electron 证据 | 调研收敛 |
| [技术审核报告](./research/2026-08-31-evidence-companion-technical-review.md) | 对照真实代码的独立审核 | D26/桌面登录/安全壳已关闭；AMap/生产 OAuth/签名仍是外部门 |
| [第三方候选审计登记](./research/third-party-candidate-audits.md) | third-party-audit-v1 持续登记 | 持续维护 |

实施顺序：E0 地图 baseline（完成）→ E1 无账号图文证据（完成）→ E2 Electron 安全壳（代码与本地安全 smoke 完成）→ E3 同窗原页阅读（代码完成）→ E4 隔离 Worker（仅无登录安全骨架；专用账号/条款/live smoke 未完成）→ E5 待后续。Electron 生产发布仍需高德 JS 自定义 origin、真实 OAuth、签名与公证。

2026-09-05 新增目的地体验迭代：走进目的地：墨线旅行岛（[实现入口](../src/web/destination-sketch-world.jsx)）。用户已纠正“直接用高德 3D 俯仰作为沉浸体验”的方向，改为轻量游戏感、手绘线条与真实 3D 结合的可探索场景，沿用证据与路线试排链；指定任务开发中，尚待真实浏览器验收。

## 现行规范（current/）

| # | 文档 | 主题 |
| --- | --- | --- |
| 1 | [01-product](./current/01-product.md) | V2 产品定义与用户体验 |
| 2 | [02-agent-architecture](./current/02-agent-architecture.md) | Parent Agent、上下文与决策架构 |
| 3 | [03-skills-providers-and-mcp](./current/03-skills-providers-and-mcp.md) | Skills、数据、Provider 与 MCP |
| 4 | [04-runtime-and-development](./current/04-runtime-and-development.md) | Pi Runtime 迁移与开发计划 |
| 5 | [05-security-and-third-party](./current/05-security-and-third-party.md) | 安全、第三方与上线边界 |
| 6 | [06-cross-platform-delivery](./current/06-cross-platform-delivery.md) | 跨端交付、数据与登录 |
| 7 | [07-route-experience](./current/07-route-experience.md) | 界面与路线执行信息、Mobility 合同 |
| 8 | [08-provider-accounts-and-routing](./current/08-provider-accounts-and-routing.md) | 模型路由、账号接入与数据能力 |
| 9 | [09-account-configuration-guide](./current/09-account-configuration-guide.md) | 部署与配置指南 |
| 10 | [10-v2-implementation-decisions](./current/10-v2-implementation-decisions.md) | V2 实施决策记录（D22–D25） |
| 11 | [11-intelligent-planning-iteration](./current/11-intelligent-planning-iteration.md) | 智能规划迭代：M0/A0/A/B/C/D 路线图与实施状态 |
| 12 | [12-agent-runtime-and-parallelism-architecture](./current/12-agent-runtime-and-parallelism-architecture.md) | Agent Runtime、Skills 与动态并行架构 |
| 13 | [13-tiered-map-experience-and-rendering-iteration](./current/13-tiered-map-experience-and-rendering-iteration.md) | 分层地图与跨端渲染迭代 |
| 14 | [14-continuous-planning-business-model](./current/14-continuous-planning-business-model.md) | 持续规划业务模型：计划、问题、局部变更、依赖与恢复（实现中、未验收） |
| 15 | [15-model-context-and-handoff](./current/15-model-context-and-handoff.md) | 模型上下文与交接：Parent、Jev、Child、压缩与接续（实现中、未验收） |
| 16 | [16-executable-itinerary-and-transport-iteration](./current/16-executable-itinerary-and-transport-iteration.md) | 完整交通链、可执行每日行程、架构审查、开发交接与验收（实现中，完整用户路径未验收） |

本次迭代按页首交接路径；产品与地图背景按 01 → 11 §11/§12 → 13 查阅。

## 当前状态

- **产品方向：** V2 锁定入境优先、免登录首次价值，agentic 规划智能体为产品核心；吃住行玩在同一 TripState 上联动，不拆四个 Workflow（01、11）。
- **已落地基线：** V2 纵向路径（Guest Trip、登录合并、候选可见工作台、多点试排、移动端 Today、变化恢复）；Agentic Runtime 四 Changeset；智能规划 M0/A/B（价格三级、分域账本、确定性估算、Agent 预算/推荐工具）；A0 行程正确性门禁与 Plan–Check–Repair；分层地图核心链路；Evidence Companion E0/E1（统一展示合同、证据侧车、受限公开链接、快速翻译、候选与详情入口、路线试排联动）。实施证据见 10、11 §12–§14、12、13。
- **进行中：** Evidence Companion E2/E3 已完成代码与真实本地 Electron 安全 smoke；localhost 高德 JS 底图、Marker、部分真实路线和交互已通过，但安全代理仍返回 `10009 USERKEY_PLAT_NOMATCH`，所以 JS smoke 维持 `not_run`，Electron 自定义 origin 仍 blocked。生产 OAuth、三平台签名/公证未关闭。E4 只有项目内受限 Worker 与 no-login safety smoke，专用账号、条款、固定 SHA 账号审计、Provider routing 与真实隔离读取仍未完成；E5 未启动。
- **未关闭（C/D 与上线门）：** 全程出行总账、执行事件、租车判断、四端真机、生产 OAuth、实时设施、外宾住宿资格、社交独立证据、Guest 清理、地点英文归一、高德 JS Key 配置（11 §12、13 §13）。
- **模型与 Provider：** DeepSeek V4 Flash 默认，可按对话切 V4 Pro / Kimi K3。DeepSeek、Kimi、飞猪、途牛已有真实 smoke；高德 WebService 在 2026-09-01 定向真实 smoke 中四域各 6 条、静态图、天气和 Mobility 全部通过，状态恢复为 `passed_live_smoke`。高德 JS 安全代理仍是独立阻塞，WebService 通过不能替代它。Provider/模型 smoke 不等于用户路径通过；partial 不冒充完整（08）。
- **不在 V2 交付：** 内容 Feed、创作者激励、商家自助入驻、广告竞价、统一收单、自动退改签、自动购买、完整 B 端后台、六端完全同版。

## 历史研究归档

[research/archive/](./research/archive/) 按日期收录已关闭迭代（一句话定位，正文含完整证据与截图资产）：

| 日期 | 文档 | 定位 |
| --- | --- | --- |
| 08-13 | [会议追溯](./research/archive/2026-08-13-meeting-traceability.md) | rwa-docs 会议证据的公开追溯副本 |
| 08-14 | [全链路用户路径审计](./research/archive/2026-08-14-full-user-path-audit.md) · [产品偏移与修正](./research/archive/2026-08-14-product-drift-and-correction.md) | V1→V2 偏移原因与修复证据 |
| 08-15 | [旅行者可用性审计](./research/archive/2026-08-15-traveler-usability-audit.md) · [库存 Provider 调研](./research/archive/2026-08-15-china-travel-inventory-provider-research.md) | 真实旅行者实测；铁路/飞猪/途牛库存来源 |
| 08-16 | [高德数据能力全景](./research/archive/2026-08-16-amap-data-capability-landscape.md) · [配额、成本与天气](./research/archive/2026-08-16-amap-quota-cost-and-weather-integration.md) · [城市移动审计](./research/archive/2026-08-16-amap-city-mobility-product-and-code-audit.md) · [能力申请与旅行关怀](./research/archive/2026-08-16-amap-entitlements-and-traveler-care.md) | 高德采用依据、Mobility Gate 与逐人关怀来源 |
| 08-20 | [入境市场验证](./research/archive/2026-08-20-inbound-china-market-validation.md) · [Brainstorm V2](./research/archive/2026-08-20-next-iteration-product-brainstorm-v2.md)（[V1](./research/archive/2026-08-20-next-iteration-product-brainstorm.md)）· [TREK 产品调研](./research/archive/2026-08-20-trek-workbench-product-research.md) · [TREK 技术栈与全平台](./research/archive/2026-08-20-trek-technical-stack-and-cross-platform-options.md) | V2 入境定位的市场与竞品依据 |
| 08-26 | [黄金路径与 Provider 融合审计](./research/archive/2026-08-26-user-golden-path-provider-fusion-bug-audit.md) | 上海家庭旅行验收基线 |
| 08-27 | [工作台与路线 QA](./research/archive/2026-08-27-visible-planning-workbench-and-route-preview-qa.md) · [UI/UX 优化记录](./research/archive/2026-08-27-travel-workbench-ui-ux-reference-and-impeccable-pass.md) | 候选可见工作台与三端实测 |
| 08-29 | [真实用户审计与 Fix Checklist](./research/archive/2026-08-29-real-user-product-audit-and-fix-checklist.md) · [前端组件调研与 V3 方案](./research/archive/2026-08-29-ui-component-sources-and-first-principles-redesign.md) | 14 项问题全部 VERIFIED；V3 Spatial Decision Workspace 与合并路线图来源 |

## 资料说明

- 父 Agent 行为与 Runtime 合同：`agent.md`、`.pi/SYSTEM.md`、`travel-agent-pi-package/runtime/`。
- 可装载 Skills 统一维护在 `plugins/travel-agent/skills/`；Pi package 只引用该目录，不另存副本。
- 本地私有 `rwa-docs/`：不可改写且不随公开仓库分发的会议原始证据；公开追溯以 `research/archive/` 为准。
