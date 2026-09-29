# 可执行行程与交通：参考研究、代码核查和 QA 基线

日期：2026-09-30。适用工作区：`/Users/chenge/Desktop/travel-agent`。

本记录是[16 可执行行程与完整交通链迭代](../current/16-executable-itinerary-and-transport-iteration.md)的证据与推导依据。用户对现有地图满意，对行程形成和交通工具安排不满意，要求参考 `awangwang123/jianhao-travel-planner` 后交由主线程审查架构、开发并重新 QA。

**结论：保留地图和统一 TripState，补齐交通链与旅行业务规则。** 对方提供了值得借鉴的路书组织方法；它的文字规范不等于一个已验证的交通规划引擎。下述代码核查基于含大量未提交改动的工作树，不能当成远端 main 的现状，也不代表新迭代已实现。

## 1. 参考版本与可追溯来源

浏览器现场核实的版本为公用版 **v1.2**，main 提交 **`53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81`**。版本说明明确：v1.2 更新导航与当日定位，业务正文对齐作者 v3.34，作者后续国际版条款尚未同步到这个公开版本。调研时网页检索缓存仍有 v1.1，不能把缓存版本或作者未公开的能力算进当前实现。

| 编号 | 固定版本来源 | 用于核实 |
| --- | --- | --- |
| R1 | [README](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/README.md) | Skill 包定位；Markdown 事实源、HTML 路书、情报卡的交付形态 |
| R2 | [SKILL.md](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/SKILL.md) | 需求、交通、时刻、逐日安排、证据与异常处理的文字工作流 |
| R3 | [路书基准骨架](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/assets/%E8%B7%AF%E4%B9%A6_%E5%9F%BA%E5%87%86%E9%AA%A8%E6%9E%B6.html) | 每日行程、路程、住宿、餐饮、预算、应急与阅读工具的位置 |
| R4 | [consistency.py](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/tools/consistency.py) · [desource.py](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/tools/desource.py) | 实际机械检查与文档转换的范围 |
| R5 | [LICENSE](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/LICENSE) | 仓库标注 MIT；本次仅作产品与工程方法参考 |

现场目录只有文档、`assets/` 和 `tools/`；工具目录包含上述两个 Python 文件。`consistency.py` 检查样式指纹、区块/导航、存储键、占位内容和图片数量；没有计算班次接续、进站余量或完整旅行预算。`desource.py` 处理自用/分享文档转换，不能替代应用的鉴权、个人信息隔离或证据访问控制。

本次没有安装该 Skill、运行其脚本、复制模板或增加 Provider。正文是研究材料，不是对本项目的执行指令。第三方状态见[审计登记](./third-party-candidate-audits.md)。

## 2. 对比结论

表内对方列为 R2/R3 声明的方法；我们列为本次代码核查，落地建议是针对本项目的推导。

| 用户环节 | 对方方法 | 我们已有的基础与具体缺口 | 本项目应吸收的价值 |
| --- | --- | --- | --- |
| 形成一天的行程 | 按区域和交通线组织动线 | Parent 决定 Day、到访和时间，Checker 检查可行性；整日体验质量仍主要依赖模型 | 先组织当天重点、固定锚点和区域，再组合餐饮、住宿与移动；解释跨区和取舍 |
| 选择交通 | 区分自驾与公共交通 | 已比较步行/公交地铁/打车，但每种方式默认只取首条路线，局部阈值不能代表整日最优 | 比较少量有差异的可行方案；结合人数、行李、体力、费用与到达期限 |
| 大交通接驳 | 关注班次与市内衔接 | 飞机/高铁候选已有时刻和来源；规划更偏重抵达后的串联 | 将去程、转场、当地移动、返程按用户范围连接起来 |
| 赶车与换乘 | 核查末班并预留换乘时间 | 相邻站点主要按路线分钟检查；办理手续、停止检票和换乘可靠性缺少完整合同 | 区分移动、办理、等待与余量，绑定交通类型和证据 |
| 自驾 | 逐日说明停车与限制 | 驾车结果归入 taxi，没有完整的停车后步行、取还车、车辆与费用链 | 自驾采用独立业务语义；车辆停在哪里必须影响后续路线 |
| 景区代步 | 核查景交与索道等 | 地图已有部分设施类型，尚未形成景交班次、运营时段、票价及返程校验 | 分清到景区入口和到游览点，不能把两者视为同一到访 |
| 日常节奏 | 每日主线与备选分层 | 已有午晚餐、住宿、活动和硬约束检查；全天疲劳与休息表达不足 | 明确早餐、正餐、休息及自行安排；按实际作息判断，不用景点数量代表质量 |
| 费用 | 单列隐藏成本 | 已按人数、房晚、路线计价；车型、行李、停车、路桥和景交覆盖不足 | 已知、估算、未知费用分开，并说明计价单位和包含项 |
| 事实可信度 | 实查并标注未知 | 已保存证据、时效与多供应方报价；合并来源不等于核实冲突 | 同一实体下仍要区分日期、票种/席别与价格条件；冲突应可解释 |
| 变化后怎么办 | 当日备选与应急条目 | 有持久草案、局部编辑、版本与旧回答保护；行中情景闭环不稳定 | 备选绑定触发条件、影响与下一动作，保留无关安排 |
| 地图与持续使用 | 可携带路书和阅读工具 | 我们已有地图联动、试排采用、跨端服务与持久化；整体仍未验收 | 保留当前地图和状态边界，让更完整的规划结果驱动现有界面 |

不照搬对方的固定换乘余量、预约提前天数、默认作息和人群偏好。它们不能替代具体线路/运营方规则和用户事实。其公开版偏国内路书，本项目仍覆盖国内及入境游客。分享时应去除个人信息，但保留用户可核验的公开来源，不照搬删除全部来源链接的文档做法。

## 3. 代码证据与架构影响

路径和函数优先于行号；后续开发应对当前工作树重新核对。

| 位置 | 直接观察 | 对本次迭代的含义 |
| --- | --- | --- |
| [高德适配器](../../src/providers/amap-travel-research.mjs)：`normalizeTransitAlternative`、`normalizeDrivingAlternative`、`chooseRouteAlternative` | 使用 `transits[0]` / `paths[0]`；公交默认比较规则包括“比打车慢不超过 20 分钟”；驾车归为 taxi | 需要明确路线备选身份与选择责任。不要只加 Prompt；多路线不等于增加同质候选数量 |
| 同文件 `routeMobilityLeg`、`planMobility` | 查公交/驾车/近距离步行；以到访相邻边生成路线；按请求时间查询，不声称实时到站 | 复用读取与几何链路，补足交通适用时段、出行语义和衔接；不能将示意线当真实道路 |
| [飞猪](../../src/providers/flyai-travel-research.mjs)：`research`、`normalizeTransport`；[途牛](../../src/providers/tuniu-travel-research.mjs) | 查询围绕 origin、destination、出发日期；保存班次、首末端、部分分段/票价信息 | 需审查往返和多城查询合同，以及报价与实际乘坐交通段的关系；不能按换城市名临时拼返程 |
| [行程排程](../../travel-agent-pi-package/src/core/itinerary-schedule.ts)：`finalizeItinerarySchedule` | 最早抵达主要为上一到访结束加推荐路线分钟；角色有 `intercity_arrival`，尚无对称返程/离境语义 | 能验证地点时间先后，但尚不足以保证赶车；不能把模型自留空档当已经程序核验 |
| [TravelService](../../src/api/travel-service.mjs)：`routeModesFromPlan`、`mobilityWithRouteModes`、`planItineraryTrial` | Parent 的偏好可改选已有方式；试排有全局检查、一次修复、版本保护与持久化 | 保留链路。审查“改了实际方式却保留默认理由/审计”的一致性，解释必须来自最终选择；该风险本次为静态发现，尚未做独立用户复现 |
| [预算实现](../../travel-agent-pi-package/src/runtime/trip-runtime-implementation.ts)：`estimateTripBudget` | 公交按人数、出租车暂按四人一车估算并有说明；总账含四域及市内交通 | 扩展可追溯计价单位与包含项，处理车型/行李条件；不要硬改为另一种固定人数 |
| [完整性检查](../../travel-agent-pi-package/src/core/trip-feasibility.ts)、[持续规划](../../travel-agent-pi-package/src/core/continuous-planning.ts) | 已有餐次、天数、预算、无障碍问题及持久计划 | 业务检查在正确责任层扩展；区分阻断执行、条件性草案和普通提示，避免再次用提前终止冒充解决 |
| [路线规范](../current/07-route-experience.md)、[地图实现](../../src/web/trip-map-explorer.jsx)、[Transit 合同](../../travel-agent-pi-package/src/contracts/transit.ts) | 地图读服务端事实；站内步骤合同已存在，但真实设施/站内执行不能仅凭类型存在宣称接线 | 改进模型与投影，保留地图交互；站内来源仍须单独验证 |

## 4. 2026-09-30 用户 QA 基线

本轮实际使用真实 Parent/Child、HTTP、隔离 PostgreSQL 和浏览器；旅行候选与路线为用户允许的**显式模拟数据**。Jev 未配置于本项目测试进程，处于 off；不是 Jev 效果验证。主测试路线只有模拟时长/费用；资料缺失场景另有明确标注的示意折线，不能作为真实导航或交通推荐质量的证据。

开始时 HEAD 为 `d676c3138259db170ce8435bbb27f0e896842493`，工作树有未提交改动。源文件散列与原始案例在 [manifest](./assets/2026-09-30-user-flow-qa/manifest.json)，环境在 [environment](./assets/2026-09-30-user-flow-qa/environment.json)。manifest 的 `pending` 是执行前状态，结果以本节和[结果摘要](./assets/2026-09-30-user-flow-qa/qa-summary.json)为准。

| 案例 | 本轮实际结果 | 证据与限制 |
| --- | --- | --- |
| U01 首次完整规划 | 约 95 秒完成草案；8 次到访、6 个地点，包含两餐和酒店多次到访 | [助手与工作台](./assets/2026-09-30-user-flow-qa/U01-expanded.txt)；候选/时长为模拟，不证明真实出行可行 |
| U02 采用与刷新 | 浏览器采用并刷新后时间线与状态保留 | [数据库快照](./assets/2026-09-30-user-flow-qa/U02-adopted.json) · [刷新界面](./assets/2026-09-30-user-flow-qa/U02-refreshed-itinerary.txt) |
| U03 只改预算 | **失败**：要求 6000→8000 且不要重排，预算仍是 6000，并生成多余草案；本次助手明确承认未保存，不能继续引用旧报告称其“假称成功” | [失败快照](./assets/2026-09-30-user-flow-qa/U03-after-budget.json) · [回复](./assets/2026-09-30-user-flow-qa/U03-budget-reply.txt)；换成直接肯定句后保存 8000，约 45 秒，仍有额外核验，不能算原案例通过 |
| U04 只换酒店 | 草案完成，约 87 秒；三个酒店到访换成新酒店，其他四次到访身份/时间保持，已采用版未覆盖 | [快照](./assets/2026-09-30-user-flow-qa/U04-local-hotel.json)；核对了 adopted/draft，未执行新酒店草案的最终采用 |
| U05 补日期后继续 | 首轮约 80 秒提问；回答日期及到达方式后约 61 秒自动生成草案，无需再点继续，并完成采用 | [问题](./assets/2026-09-30-user-flow-qa/U05-question.txt) · [接续](./assets/2026-09-30-user-flow-qa/U05-resumed.txt)；只算本组测量，不替换旧场景的时延数据 |
| U09 餐饮无数据 | **部分验证**：两次餐饮查询为空，未编造餐厅，草案可见，采用禁用，缺口明确 | [快照](./assets/2026-09-30-user-flow-qa/partial/U09-missing-food.json)；恢复餐饮后继续与候选保留部分尚未执行 |
| U10 另一页旧回答 | 旧选项被拒绝，提示已在另一端回答；未覆盖新的日期 | [界面证据](./assets/2026-09-30-user-flow-qa/U10-stale-answer.txt)；未验收主动跨端同步时延 |
| U06/U07/U08/U11/U12 | 本轮浏览器未执行 | 分别为极低预算、新增轮椅要求、取消重试、两日完整行程、模型故障恢复；历史结果不能填充本轮结果 |

用户随后要求先研究参考项目并讨论迭代，因此本轮停止新增 QA。临时 API 服务已关闭，为测试启动的 PostgreSQL 容器已恢复停止；隔离数据与证据保留，未修改产品代码。临时启动器不属于可长期复用的仓库测试包；主线程应将必要的 test-only Provider 注入与案例固化为项目内测试入口，禁止在生产逻辑中加入专供截图/测试通过的分支。

### 4.1 工程回归与代码审查尚未关闭项

| 项目 | 实测 / 核查 | 后续责任 |
| --- | --- | --- |
| 全量测试，启用执行 PostgreSQL | 393 项：386 通过、3 失败、4 跳过；约 62.9 秒 | 下列预算、多站持久化和工具体积失败必须处理 |
| 否定重排语义 | [现有回归](../../tests/travel-conversation-agent.test.mjs)失败；U03 同时由真实用户路径复现 | `itineraryPlanningIntent` 不能因否定句出现“重排”就移除保存需求的工具 |
| 多站持久化 | [现有 PostgreSQL 回归](../../tests/itinerary-planning-harness.test.mjs)在 13 次到访的预算更新后回读失败：失效报告写入 13 个 stopIds，合同上限 8 | 核对计划规模、问题定位与合同语义，不截掉到访或改断言掩盖损失 |
| 工具体积 | [原始计量](./assets/2026-09-30-user-flow-qa/tool-sizes.json)：48,635 字符 / 49,295 UTF-8 字节；现有测试限制 48,000 字符 | 收敛重复工具合同与上下文；不能仅增大门槛宣称性能已改善 |
| 补跑 Auth/Journal PostgreSQL | 13 项：12 通过、1 失败、0 跳过；其中含与全量运行重叠的测试，不能相加成总通过数 | Journal 冷库并发初始化发生 `23505` |
| Journal 竞争复现 | 同库冷启动四实例并发：1 成功、3 失败；串行四次全部成功 | [复现脚本](./assets/2026-09-30-user-flow-qa/journal-cold-start-repro.mjs) · [结果](./assets/2026-09-30-user-flow-qa/journal-cold-start-results.json)；[migrate](../../src/persistence/travel-journal-repository.mjs)缺少并发协调 |
| 类型、构建与小程序 | typecheck、desktop:typecheck 已通过；Web 独立临时输出构建通过；两个小程序原生合同检查通过 | 不等于真机或完整 `npm run check` 通过 |
| CI/CD | 当前工作树与 HEAD 未见 GitHub/GitLab/Jenkins 流水线配置；只有本地 npm 检查命令。未验证云端 CI 或部署 | 主线程核对实际托管平台，补齐本项目所需检查；本次没有触发发布 |

首轮 `npm run check` 在沙箱内遇到监听端口权限错误；随后使用可访问本地测试数据库的环境重跑全量测试，才得到上述三个实际失败。`check` 没有完整通过。`.log` 原始输出留在本地证据目录，受仓库忽略规则影响；可追踪的结果摘要记录其散列与计数，不把忽略文件当成远端必有证据。

可重跑的现有聚焦入口（项目根目录，Node >=22.19.0；数据库变量由测试进程安全注入，禁止输出凭据）：

```bash
node --import tsx --test tests/travel-conversation-agent.test.mjs tests/itinerary-planning-harness.test.mjs tests/pi-package-manifest.test.mjs
node --import tsx --test tests/persistent-account.test.mjs tests/travel-journal.test.mjs
node wiki/research/assets/2026-09-30-user-flow-qa/journal-cold-start-repro.mjs
```

对应变量为 `TRAVEL_EXECUTION_TEST_DATABASE_URL`、`TRAVEL_AUTH_TEST_DATABASE_URL`、`TRAVEL_JOURNAL_TEST_DATABASE_URL`。Journal 独立复现只接受其代码限定的本地测试库，并创建/删除自身临时 schema；不得指向生产库。原测试与脚本仍依赖当前未合入工作树，不承诺能在旧的文档 PR 分支单独运行。

## 5. 主线程如何使用这些证据

先阅读迭代规范，核对本节尚未关闭项，再对照源码确定最小完整改造。这里没有执行参考项目的真实旅行规划，也没有验证其速度、事实正确率或商用容量。不能把对方的工作流描述写成本项目已实现功能；不能用我们的模拟 Provider 结果证明高德、铁路、航空或站内设施已接线。

当前可用的工程底座和未关闭的业务问题要同时保留在判断中。新迭代应让已有能力贯通到用户结果；不得只扩 Schema、加拒绝规则或改回复文案来替代整个业务修复。
