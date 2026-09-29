# 第三方候选与审计台账

## 见好旅行规划器：业务参考（2026-09-30）

`awangwang123/jianhao-travel-planner@53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81`，现场核对公用版 v1.2，仓库 [LICENSE](https://github.com/awangwang123/jianhao-travel-planner/blob/53e1899d5d1e97a4bd2a2392d8bf4189b8dc0b81/LICENSE) 标注 MIT。采用范围仅为路书组织、交通衔接、证据与验收方法研究；未安装 Skill、运行脚本、复制代码/模板或接入其依赖，没有新增运行时权限与 Provider 写面。

该仓库由 Skill 文档、HTML 骨架及两项 Python 文档工具组成；最近观察到导航与版本说明更新，这不足以证明长期维护承诺或生产 SLA。其交通可行性主要为文字工作流，不能把版式校验算作班次/路线验证。来源与比较见[研究记录](./2026-09-30-transport-itinerary-reference-research.md)，开发依据见 [16 迭代规范](../current/16-executable-itinerary-and-transport-iteration.md)。

状态为 **reference_only**，不是新的 Provider 已获接入批准。若后续实际引入代码/资产或服务，按项目规则另做对应 `third-party-audit-v1`，核对固定版本、依赖、许可与写面；不以本条替代该接入审计。

## Jev 结构化判断 API（2026-09-21）

使用项目自写的 HTTP 适配器，固定模型 `jev-1.13.0`、固定 HTTPS 端点，不安装或复制 TypeSafe SDK/Skill 源码。远端服务无可固定的客户端仓库提交，因此仓库 SHA 字段不适用；适配器文件 SHA256、核验时间与官方合同来源记录在 [third-party-audit-v1](./assets/2026-09-20-jev-iteration/jev-third-party-audit.json)。不以某个 SDK 的开源许可代替远端 API 的产品协议。

写面只有受预算约束的模型请求及项目自己的调用记账；远端不能获取工具、购买、浏览器、任意 URL 或状态提交权。快照仅含标准化旅行事实，账号密钥只在请求头，原始响应错误不入日志。取消、20 秒超时、响应体上限、严格答案校验、重试上限和账号冷却已实现。

[官方模型文档](https://docs.typesafe.ai/models)、[HTTP 合同](https://docs.typesafe.ai/api)与[置信度说明](https://docs.typesafe.ai/confidence)已核验。真实只读测试通过了 HTTP 合同，但中文支持判断未全部正确；自动放行仍关闭。[网站条款](https://typesafe.ai/legal/terms)不构成本项目的生产 SLA 或账号产品协议核验。当前采用范围为本地接入与评估，商业上线仍需账号协议、目标语言独立校准和容量证据。

更新时间：2026-08-19。此文记录调研、固定版本和采纳门槛；每一行的状态以该行结论为准，不能把候选或开发 smoke 推断成生产授权。

## 结论矩阵

| 能力 | 候选 / 固定版本 | 许可与状态 | 决策 |
| --- | --- | --- | --- |
| 参考 Runtime | `DESONGs/assignment-agent@0602f134f65052f7617d417a221f7d31d29746ef` | 用户授权内部迁移来源 | 迁移控制面模式；不迁移会议/飞书代码。 |
| 小红书主候选 | `jackwener/OpenCLI@a86d64705c526dc710f790e66cfcabf6ecf786b9` | Apache-2.0；有浏览器与账户风险 | 仅隔离审计候选，限定读操作。禁用其全部写面。 |
| 小红书对照 | `xpzouying/xiaohongshu-mcp@da9ba0365e176bc0eb11885f1941271d895feb73` | Apache-2.0 | 同上。仅 search/read/comments，comments 只读。 |
| 小红书对照 | `lucasygu/redbook@1435483c64d8290dcf6e10a74be3586b8921cd66` | MIT | 仅审计；Cookie/签名与浏览器读取是高风险点。 |
| 抖音主候选 | `jackwener/OpenCLI@a86d64705c526dc710f790e66cfcabf6ecf786b9` | Apache-2.0 | 仅检索、详情、分享链接；禁用发布。 |
| 抖音对照 | `tamnd/douyin-cli@b70c8d7e3f650023aada02013aa75850f67f0222` | Apache-2.0 | 仅隔离只读 smoke 后考虑。 |
| 抖音对照 | `Youhai020616/douyin@deab86dfa0168b911004cba6336b597f500be858` | MIT | 仅借鉴/对照，需验证维护与写面。 |
| 微信 | 用户提供文章链接 + 自研受限读取器 | 依平台条款 | 生产读取受链接与条款约束。 |
| 微信借鉴 | `jj-cheng25/weixin-articles-mcp@060fb3dd7e41d1c0950a19bc1367d66a6881f915` | MIT，但声明个人/研究用途 | 不作为商业生产依赖。 |
| 地图/天气 | 高德官方 MCP | 官方服务，需账号/条款 | 中国 POI、路线、天气与导航主路径。 |
| Web 地图渲染 | `leaflet@1.9.4` | BSD-2-Clause；零运行依赖 | 以 `--ignore-scripts --save-exact` 安装并通过 `npm audit`；只负责客户端地图交互，不提供地点或路线事实。 |
| 本地开发底图 | OpenStreetMap 标准瓦片 | ODbL 数据与官方 Tile Usage Policy；无 SLA | 仅 `import.meta.env.DEV` 且未配置其他底图时启用，保留可见 attribution；生产不默认使用公共瓦片服务。 |
| 飞猪库存 | `alibaba-flyai/flyai-skill@54277b27b68e53741954c08541faedba1d45cc7b`、`@fly-ai/flyai-cli@1.0.16` | MIT；官方项目和 npm 包 | 固定包已以 `--ignore-scripts` 安装；酒店、航班、火车、POI 通过受限 child process 完成 guest 只读 smoke。生产仍需 FlyAI Key。 |
| 途牛库存 | `tuniucorp/tuniu-cli@a47243dae54e010a993908fcfe4b3edcf716fb7c`；本项目不安装 CLI | MIT；官方项目 | CLI postinstall 会写多个用户 Home，故只审计不安装。使用自研固定官方端点 MCP 客户端，Key 与真实 smoke 前禁用。 |
| 铁路社区候选 | `Joooook/12306-mcp@ff6439da6f63d7d72181abea4568abd69878c600` | MIT，但 README 声明仅学习；直接访问 12306 并处理 Cookie | 不合入生产。许可证不代表铁路数据与账号调用授权；改用飞猪/途牛查询和官方/授权渠道跳转。 |
| 携程商旅/华住会 | 官方企业 MCP 或 B2B API | 商务合同与企业凭据 | 作为企业版候选，未获授权前不进入 Capability Registry。 |
| 本地生活 | 高德、商家官方资料 | 取决于 Provider | `mcp-dianping` 有同步/异步混用与城市表硬编码风险，不直接复用。 |

## 只借鉴或排除

| 项目 | 处理 | 原因 |
| --- | --- | --- |
| `LAMDA-NeSy/ChinaTravel@456b60…` | 只借鉴 | 约束分类与符号校验有价值，许可不明确，不复制代码或数据。 |
| `OSU-NLP-Group/TravelPlanner@e52c87…` | 只借鉴 | 四域完整性与约束评测有价值；MIT 审计后才考虑少量评测结构。 |
| `AMAP-ML/MobilityBench@c05a…` | 只借鉴 | 路线调用、结果有效性和回放沙箱有价值；许可明确前不复制。 |
| GroupTravelBench | 只借鉴 | 多人偏好获取、冲突协调与公平可作为验收维度。 |
| `borski/travel-hacking-toolkit@593dd…` | 只借鉴 | Tool/Reference Skill、来源优先级与失败回退模式可参考。 |
| `liketrek/TREK@e60427f813dc35f688d5d9169b79ac8c43974719` | 排除代码依赖；允许产品研究 | AGPL-3.0，与项目第三方边界不兼容。只借鉴地图工作台、候选/日程状态和离线/协作产品思想，不复制代码、Schema、数据或资产。详见 [TREK 调研](./archive/2026-08-20-trek-workbench-product-research.md)。 |
| `trvl` | 排除 | 非商业许可。 |
| `yzfly/douyin-mcp-server` | 排除 | 已归档，且含下载/再分发风险。 |

## `third-party-audit-v1` 最小记录

每个候选的真实审计需生成如下字段，存放在受控研究目录而非主代码：

```json
{
  "schemaVersion": "third-party-audit-v1",
  "candidate": "owner/repo",
  "commit": "40-char-sha",
  "license": "SPDX-or-unresolved",
  "maintenance": "active|stale|archived",
  "installMode": "lockfile-ignore-scripts",
  "outboundDomains": [],
  "credentials": "none|dedicated-browser-profile|api-key",
  "writeSurface": [],
  "disabledPaths": [],
  "staticReview": "pending|passed|failed",
  "isolatedSmoke": "not-run|passed_read_only_isolated|failed",
  "adoption": "blocked|borrow-only|eligible"
}
```

Web 地图渲染的补充审计：`leaflet@1.9.4` 的 npm 包无运行依赖；包元数据只包含 `prepare: husky install`，安装时已由 `--ignore-scripts` 禁用。它没有 Provider 凭据、出站域或写面。底图 URL 通过 `VITE_TRAVEL_MAP_TILE_URL` 显式配置；前端不能据此增加地点、路线或设施事实。

## 2026-09-14 目的地墨线场景

`three@0.180.0` 精确版本（npm `gitHead: 0af9729d0c143a86a1d725d6e2c3ad83301f3f34`，MIT）用于客户端原创风格化 Mesh、OrbitControls、墨线及点云展示。npm 元数据和包内 LICENSE 已核验：零运行依赖，无 preinstall/install/postinstall/prepare 生命周期；开发 build/test 脚本没有执行。安装使用 `--save-exact --ignore-scripts --userconfig=/dev/null` 并保留 lockfile integrity。只引用该包中的 OrbitControls 和 BufferGeometryUtils，不新增 R3F/Drei、引擎、账号或出站服务。

原始输入不含用户照片或凭据；几何、材质、线条和点云由项目本地生成。CPU 聚焦检查覆盖六类实体、有限坐标、确定性线条、按需 RAF、导览终止及资源释放；Web 构建通过。上述证据不是用户实拍重建或浏览器/真机验收。导入第三方模型、上传用户照片到建模云端及付费生成不包含在此依赖采用范围内。

用户新增参考：[木渡川的建模流程](https://x.com/tanglele0318/status/2098996808936734986)，已对照 [Rodin 官方文档](https://docs.hyper3d.ai/en)、[API 数据保留政策](https://docs.hyper3d.ai/en/legal/data-retention-policy) 与 [定价页](https://hyper3d.ai/pricing?lang=en)。Hyper3D 暂为候选，尚未接入或发送照片；需要明确的云端处理选择、API 配置和测试预算。文章中的 museum-relic-stamp 是图章图片工作流，不是照片自动生成 3D 的运行时依赖，本项目没有安装或复制其素材。

只有 `isolatedSmoke: passed_read_only_isolated` 和 `adoption: eligible` 才可以把 Provider 从 Registry 的 `blocked` 改为可用。

## 2026-08-31 Evidence Companion E1 采用说明

E1 没有下载、安装或合入新的第三方仓库。公开链接读取器、Evidence projection 与 UI 均为项目内实现；只复用现有已审计 Provider 和浏览器标准能力。因此本轮没有新增可标记为 `eligible` 的社交 Worker 候选。E4 继续保持 blocked，直到专用账号、平台条款、固定 SHA 静态审计与 `passed_read_only_isolated` 真实 smoke 全部具备。

## 2026-09-01 Electron 与 E4 记录

| 候选 | 固定版本 | 许可 | 安装与写面 | 结论 |
| --- | --- | --- | --- | --- |
| `electron` | `44.1.0` | MIT | npm lifecycle 已禁用；官方二进制另行下载并用包内 checksum 校验。运行时可创建 renderer、Session、协议与系统浏览器跳转 | 仅桌面增强壳采用；安全 smoke 通过，生产签名/公证和 AMap 自定义 origin 未通过 |
| `@electron/packager` | `20.3.0` | BSD-2-Clause | lifecycle 禁用；只消费生成后的桌面 JS、Web bundle 与固定 host JSON，不打包 ENV、Wiki、测试或 runtime data | 允许生成未签名本地包；不能替代三平台发布验收 |
| OpenCLI / 小红书 MCP / 抖音 CLI | 既有候选 SHA | 见上表 | 本轮未下载、未安装、未执行 | 保持 blocked；项目内 Worker skeleton 不是这些第三方候选的审计通过证据 |

本轮 no-login Worker smoke 只证明写操作、任意 URL、搜索无账号、执行字段均 fail closed；`isolatedSmoke` 仍不能填 `passed_read_only_isolated`，因为没有专用账号和真实读取。

## 已采用 Provider 审计摘要

```json
{
  "schemaVersion": "third-party-audit-v1",
  "candidate": "@fly-ai/flyai-cli",
  "version": "1.0.16",
  "sourceRepo": "alibaba-flyai/flyai-skill",
  "commit": "54277b27b68e53741954c08541faedba1d45cc7b",
  "license": "MIT",
  "installMode": "lockfile-ignore-scripts",
  "outboundDomains": ["flyai.open.fliggy.com", "router.feizhu.com", "*.alicdn.com"],
  "credentials": "optional-server-api-key",
  "writeSurface": ["dedicated-worker-home/device-id"],
  "disabledPaths": ["arbitrary-command", "shell", "booking", "global-config", "user-home"],
  "staticReview": "passed_with_isolation_required",
  "isolatedSmoke": "passed_read_only_isolated_guest",
  "adoption": "eligible_development_only_until_production_key"
}
```
