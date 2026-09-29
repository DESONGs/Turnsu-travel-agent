# Skills、数据、Provider 与 MCP

## 2026-09-22 合同升级依据（待实现）

本次按 [14](./14-continuous-planning-business-model.md) 分清查询、核验、修改草案和采用的写面；按 [15](./15-model-context-and-handoff.md) 为 Parent、Jev、Child 提供同源版本快照与可消费回执。Jev 从候选支持/排序扩展到具体问题的计划须先校准新模板，当前能力不能冒充已支持新合同。相关 Skill、工具 schema 和提示词随实现最小同步，既有只读与权限边界保留。

## Skill 目录

2026-09-21 的判断接线按 `off / shadow / auto` 选择。`off` 使用既有 Parent/Child；`shadow` 把 Jev 结果记录在分析产物中，不交给 Parent 改变决定；`auto` 将结构化判断交给 Parent 并在精确模板/语言校准通过后允许可撤销的候选比较。Jev 固定 `jev-1.13.0`，通过服务端 `POST https://api.typesafe.ai/v1/systemone` 使用 Choice/Score，不作为聊天模型或工具执行器。

同一事实快照上的独立问题合批，超过保守输入预算时按候选拆批；每批保留完整约束。不再每域只取两个候选，保留逐维未知和分歧。后续补查仍调用原 Provider；组合、试排、修复与提交仍调用原业务工具。研究内部通过持久步骤分成准备、判断和完成，不复制公开研究入口。新接入的静态审计及真实接口证据见[审计登记](../research/third-party-candidate-audits.md#jev-结构化判断-api2026-09-21)。

项目内 Skill 的唯一来源位于 `plugins/travel-agent/skills/`。Web Parent Agent 会在每轮真实读取 1–2 个组合 Skill 并记录版本；Pi package 只向外部 Pi 宿主暴露四个组合入口。原有微型 Skill 内容保留在同一目录并被组合入口作为 references 引用，不再要求 Parent 或 Child 同时装载全部内容。

| 组合入口 | 作用 | 引用的既有方法 |
| --- | --- | --- |
| `understand-trip` | 旅行范围、逐人需求和一个关键追问 | request/scope/party Skills |
| `research-trip` | 研究条件、实体、来源独立性和事实核验 | research/social/media/entity/offer Skills |
| `plan-trip` | 预算、天气、路线、逐人适配、日程与解释 | fit/weather/schedule/compare/coherence Skills |
| `recover-trip` | 延误、闭店、天气或约束变化后的局部恢复 | disruption/proposal/fulfillment/feedback Skills |

Provider 仍先以 `Promise.allSettled` 有界并行取数并归一化。只有复杂、多域任务才对同一批无凭据证据运行一次 `travel-analysis-fanout`：库存预算、地方发现、可执行性日程三条 lane 可少于三条并行，Web 通过 Dynamic Workflow library 执行；外部 Pi package 通过三个专用 `pi-subagents` child agent 执行。Child 不调用 Provider、commit、购买、Shell、任意 URL、社交写或递归委派；Parent 只 Join 一次并生成唯一 Proposal。

每个请求域同时返回来源状态：`completed_nonempty`、`empty_verified`、`provider_unavailable`、`rate_limited`、`auth_required` 或 `partial`。`empty_verified` 只表示适用于该域的已查询来源在本次条件下没有返回可核验结果，不表示市场不存在。高德机场、车站、停车场和出入口属于地图/市内移动证据，不能在航班或铁路库存为空时补位；飞猪、途牛等 OTA 不支持的餐饮/游玩域也不能被空数组误记为已核验为空。

首次与后续研究都尊重用户委托的领域；只比较酒店时只查住宿，完整规划按保存的 `planningDomains` 联动。Provider 暂时无结果时保留缺口，不用模型知识补齐。`plan-trip` 要求 Parent 读完全部问题后一次修复：预算内优先替换候选；连续无台阶缺证据时补查设施和通路，不能以改为打车代替证明。

Mobility 的完整路线证据不设展示用截断：Adapter 必须处理已排的全部地点和到访，合同归一化与 Runtime 存储必须保留全部已返回路段。来源失败仍受原有超时、取消与配额约束，显式返回覆盖缺口。移除了原来的 8 地点／16 到访／8 路段静默截断；18 到访适配器检查和跨 PostgreSQL 的 12 路段回归见[返工证据](../research/2026-09-21-traveler-business-rework.md)。这不代表真实高德接口已经在本轮通过。

## Provider 分层

模型路由独立于旅行事实来源：普通文字轮默认由 DeepSeek Parent Agent 推理并调用受限工具；用户主动附图时，图片与文字进入同一个原生多模态 Parent Agent turn，当前首选 `DeepSeek-V4-Flash-Vision-Exp`，Kimi K2.6 保留为可配置的对照/回退路线。视觉模型可以在看图后立即调用 `save_trip_understanding`、`research_trip_options` 等既有旅行工具，但图片文字始终是不可信资料，视觉观察仍需归一为待审查 Claim 并由 Provider 核验。原图不落盘，也不会绕过 Proposal、确认和提交边界。`digest-travel-media` 负责图片/媒体中的视觉 Claim 与 verification targets，不新增第二个视觉 Plugin 或第二套旅行状态。具体账号、状态与验证见 [模型路由、账号接入与数据能力](./08-provider-accounts-and-routing.md)。

| 需求 | 首选来源 | 当前状态 |
| --- | --- | --- |
| 长尾体验发现 | 隔离的 XHS/Douyin 只读 Worker；用户提供微信文章链接 | `blocked`，仅有合同与安全门。 |
| 餐饮与本地菜 | 高德餐饮 POI（类型 `050000`）；大众点评/美团合作接口作为后续增强；XHS/Douyin 作为社交发现层 | 高德当前已通过真实 smoke；菜系/片区条件已进入检索，酒店主实体会被餐厅角色校验拒绝。地图资料不能单独证明“小众/当地人才知道”，此类要求固定保留独立内容或到访证据缺口。大众点评/美团仍需企业或合作方授权；小红书没有已确认可用于本产品的公开笔记搜索 API。 |
| POI 地点发现与地图唤端 | 高德 Web 服务 2.0，权益不足时降级官方基础 POI；Static Map + URI API | Adapter、提案链和当前账号真实 smoke 已通过；历史 `10044` 不再是当前阻塞。应用仍必须验证具名地点和目标片区相关性，不能用宽泛综合排序冒充命中。 |
| 旅行天气 | 高德天气；开发环境可回退 Open-Meteo | 已接入 Environment Plane、候选排序、局部重排和前端。Open-Meteo 免费端点仅限非商业开发，生产需付费 Key 或通过 smoke 的高德。 |
| 城市路线 | 高德路径规划 2.0、Static Map paths、URI API | 代码和当前账号真实路线 smoke 已进入 Runtime Mobility Gate、QA、服务端路线图与前端；`walk_type` 的直梯、扶梯、阶梯和斜坡作为非实时路线参考参与逐人约束。高德交通设施 POI 不能替代跨城航班/铁路库存。 |
| 入口、室内图与设施参考 | 高德 POI `navi/indoor` 与路线 `walk_type` | 有字段时展示入口、出口、室内地图及路线设施，并固定注明“非实时、现场确认”；字段缺失时不补造。 |
| 实时到站与设施运行状态 | 获授权的实时公交、站点或设施来源 | 尚未接线；高德计划路线和公交首末班不能冒充实时到站，地图记录的电梯、卫生间、储物柜和充电宝也不能冒充当前开放或正常运行。 |
| 铁路 | 飞猪 FlyAI；途牛官方 MCP；购买时跳转 12306 或授权渠道 | 两个个人 Key 均已接入并通过真实只读 smoke；展示列车号、准确车站、出发/到达时间、席别价格和可见余票。无公开官方 12306 开发 API，且不自动购票。 |
| 航班/酒店/景点库存 | 飞猪 FlyAI；途牛官方 MCP 为互补来源 | 同一航班按航班号与出发时间合并，保留不同供应方报价、税费、航站楼、机型、舱等与跳转；酒店保留房型、面积、窗户、早餐和退改等已返回字段。价格、余位、房态仍需进入供应方页面再次核验，不自动购买。 |
| 跨城到市内接驳 | FlyAI/途牛城际库存 + 高德地理编码/路径规划 | 用户未指定交通方式时并行比较航班与铁路；明确航班时优先保留航班。选定或用户已确认到达机场/航站楼后，把它作为高德市内路线起点，接到住宿、餐饮和游玩动线；缺少库存或坐标时明确保留缺口。 |
| 企业差旅与酒店直连 | 携程商旅 MCP、华住会 B2B API | 需企业申请/签约；当前没有凭据，不进入 C 端默认路由。 |
| 动态事实 | 官方、地图或授权 Provider | 任何失效时返回 `provider_unavailable`。 |

社交 Worker 仅可暴露 `search_social_content`、`read_social_content`、`resolve_social_share_url`。固定失败码：`AUTH_REQUIRED`、`CHALLENGE`、`RATE_LIMITED`、`SOURCE_CHANGED`、`SOURCE_UNAVAILABLE`、`TERMS_BLOCKED`、`EMPTY_VERIFIED`。

## MCP V1 业务合同

```text
create_trip
update_trip_scope
get_trip_control_view
get_trip_plan_view
get_open_decisions
research_trip_options
propose_trip_change
accept_trip_change
reject_trip_change
prepare_booking_handoff
record_booking_confirmation
report_trip_disruption
submit_trip_feedback
```

`submit_trip_feedback` 既保留原有分类反馈，也支持地点关联的匿名结构化到访记录。共享记录必须绑定已选地点及其稳定来源标识；跨旅行只返回聚合后的推荐、标签、花费、等待和待核验数量，不返回自由文字，也不把用户报告提升为官方事实。

`save_trip_understanding` 是 Parent Agent 的对话工具名，底层首次调用 `create_trip`，后续调用 `update_trip_scope`。`research_trip_options` 会建立待确认提案，因此不是纯读接口。用户可在 Web 画布或聊天中明确点名一个已有候选；`accept_trip_change` 支持 `partial=true`，只提交指定 domain 并保留 residual proposal。已购票到达事实使用独立 user-confirmed arrival node，不以库存选择为前提。所有入口继续经过 revision、write set、锁定、新鲜度和跨域约束检查。

上述逐域部分采用只适用于候选比较。带有 `itineraryPlan` 的试排行程按整份草案提交，`scope=complete_trip` 明确替换原选中集合并保留草案内所有到访；`selected_visits` 用于范围有限的站序优化。Parent 工具必须提供 `scope`，旧 HTTP 合同可继续省略但不能因此获得完整替换语义。Checker 的外部资料缺口通过 `resolution=provider_evidence` 和 `fetch_evidence` 交给 Parent，不能转成向用户索取设施证明的问题。

`create_trip` 的 `travelers` 与 `update_trip_scope.travelerProfiles` 支持逐人称呼、关系与有界 `careNeeds`。`elicit-party-preferences` 负责把自然语言翻译成行动要求，`assess-traveler-operability` 与 `review-trip-coherence` 负责核验它们是否被路线、住宿、活动、餐饮和日程满足；这些 Skill 不能保存诊断或直接修改旅行状态。

当前实现包括 `src/mcp/server.mjs` 的本地 stdio MCP 与 `src/http/server.mjs` 的 HTTP API；两者都直接调用同一个 `TravelService`。生产部署使用 `PostgresTripRepository`（`DATABASE_URL`），本地显式未配置数据库时才使用原子 JSON repository。它们不各自维护业务规则、行程状态或 Provider 结果。
