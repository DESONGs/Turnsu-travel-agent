# 模型路由、账号接入与数据能力

## 已配置的模型角色

2026-09-21：新增可选 Jev 结构化判断角色，固定 `jev-1.13.0`，服务端变量为 `TYPESAFE_API_KEY`。它不替换 Pi Parent、不生成地点事实、不执行工具。默认 `TRAVEL_AGENT_JEV_MODE=off`；`shadow` 仅记录，`auto` 接入决策链。自动语义调整还必须匹配模板、目标语言、模型、独立数据集哈希及校准阈值；缺少校准只交给 Parent。不得把返回的 confidence 当成正确率。

账号限额固定为 1,200 RPM / 250,000 输入 TPS，重试也计数。超过本地预算持久延后；账号鉴权失败、合同不合法或重试耗尽明确记录为不可用，由 Parent 根据现有事实处理。Parent/Child/压缩仍使用自己的账号预算，Jev 的额度不能证明整条链路能承载 500 复杂规划。真实中文结果和未通过门槛见[本轮证据](../research/2026-09-21-jev-automatic-planning-implementation.md)。

| 任务 | 首选模型 | 何时调用 | 当前证据 |
| --- | --- | --- | --- |
| 意图理解、追问、约束推理、取舍解释、受限工具调用 | 默认 DeepSeek `deepseek-v4-flash`；用户可切 `deepseek-v4-pro` 或 Kimi `kimi-k3` | 用户按对话选择父 Agent 模型，选择持久化并从下一轮生效 | V4 Flash 完成两轮工具调用黄金路径；V4 Pro 与 K3 分别完成真实旅行草案创建。 |
| 有界子任务与内容提炼 | Kimi `kimi-k2.6` | Pi sub-agent 没有显式覆盖模型时 | 锁定 Pi 0.84.1 的只读 consumer Child已通过；2026-08-28 最新 Web fan-out 双 lane 结构化 smoke 也完整通过，当前可进入受控 fallback。 |
| 用户主动上传图片后的旅行理解与计划构建 | 首选 DeepSeek `deepseek-v4-flash-vision-exp`；Kimi 中国区 `kimi-k2.6` 为可配置对照/回退 | 图片与用户文字进入同一轮 Parent Agent；模型可看图、推理并调用既有旅行工具，但不能直接提交方案 | Web 已支持图片预览后与问题一起发送；Pi 0.84.1 通过受控 Provider catalog 补入实验视觉模型。当前 DeepSeek Key 已通过真实图片 smoke，并在真实浏览器同轮完成图片理解、保存旅行要求、联动研究和方案地图；Kimi 旧 Key 也保留真实图片 smoke。 |
| POI、照片、地址、评分/参考消费、静态地图与地图唤端 | 高德 Web 服务 2.0；必要时降级官方基础 POI / Static Map / URI API | 一次四域检索返回地点资料，模型只解释 | 2026-08-26 当前账号的 POI v5/v3、地理编码、天气与静态地图均真实成功，状态为 `passed_live_smoke`。历史 `10044` 已被最新证据覆盖，不再是当前阻塞。 |
| 旅行日期天气 | 高德天气；开发环境回退 Open-Meteo | 最终候选成立前核验，跨吃住行玩约束方案 | 代码已接入共享状态、候选评估、局部重排和前端；Open-Meteo 免费端点仅用于非商业开发，生产需高德完整 smoke 或付费 Key。 |
| 城市路线与非实时设施参考 | 高德路径规划 2.0 + Static Map paths + URI API；POI `navi/indoor` | 用户确认地点后由 Runtime 强制核验 | 公交、驾车、步行、折线地图与导航已通过当前账号真实 smoke，并贯穿 Runtime、QA、地图和前端。入口/出口/室内图与 `walk_type` 设施仍只表示地图记录或路线参考，全部标记非实时。 |
| 实时到站与设施运行状态 | 授权实时公交、地铁或设施来源 | 选定公共交通方案后下钻 | 尚未接线；计划路线、地图设施记录、首末班、实时到站和当前运行状态必须分别表达。 |
| 小红书/抖音发现 | Travel Agent Plugin 中的组合/获取/消化/去同源 Skills；独立只读 social Worker | search/read/share-url 三个能力 | Skills 与安全合同已完成；待专用账号、固定 SHA Worker 审计和隔离 smoke。 |
| 铁路、航班、酒店与景点库存 | 飞猪 FlyAI；途牛官方 MCP 为第二来源 | 一次联动研究中的商业库存候选、价格提示与供应方跳转 | 两者均已用当前 Key 完成真实只读 smoke；途牛酒店、火车、航班各返回 6 条，飞猪景点/酒店/交通各返回 6 条。 |

DeepSeek V4 Flash 与 Pro 继续承担普通文字轮；Flash 速度与成本更适合作为默认，Pro 用于更复杂的联合取舍。附图轮使用独立多模态 Parent Agent 路由，首选实验性的 `deepseek-v4-flash-vision-exp`，使图片、整段对话与旅行工具处于同一轮，而不是先把图片降成二手摘要。Kimi K3 仍是第三个文字 Parent Agent 选项，Kimi K2.6 继续承担 sub-agent，并可显式配置为视觉路线。函数参数仍由 Runtime 的 TypeBox schema 和 `TravelService` 重新验证，不信任模型输出。任何模型都不替代事实 Provider；视觉模型调用工具不等于获得提交权，多模态观察只能经过 Claim、核验、Proposal 和用户确认进入旅行状态。

## 密钥和隐私边界

- 服务启动时只加载项目根目录被忽略的 `env_travel.local` 中的白名单键，并以 `0600` 权限要求保护该文件；不合规权限会拒绝启动。
- Kimi 只接受官方环境变量 `MOONSHOT_API_KEY`；旧会议项目的别名、飞书、ASR 和文档 Worker 配置不会被 Travel Agent 配置加载器读取。
- `/api/provider-status` 只返回 `blocked`、`credential_configured_pending_smoke`、`passed_live_smoke` 等状态，绝不返回 key、端点 token 或账号信息。
- 多模态入口只接受用户主动上传的 JPEG、PNG、WebP（最多 4 张）；不上传社交平台原媒体，不落盘原图，也不识别人脸或复述证件、支付、手机号、凭据与私密二维码。图片只存在于本次 Agent 请求，已保存的对话仅记录“本轮包含临时图片”。

## 需人工完成的账号配置

按实际申请顺序、ENV 字段和 smoke 操作请直接阅读 [账号与 API 配置说明](./09-account-configuration-guide.md)。

| 项目 | 需要你完成 | 完成后工程动作 | 官方来源 |
| --- | --- | --- | --- |
| DeepSeek 原生多模态轮 | 复用服务端 `DEEPSEEK_API_KEY`，设置 `TRAVEL_AGENT_VISION_PROVIDER=deepseek` 与 `TRAVEL_AGENT_VISION_MODEL=deepseek-v4-flash-vision-exp` | 运行 `npm run smoke:models`，再用非敏感旅行图片完成“看图 → 工具核验 → 方案候选”真实轨迹；通过前保持 pending | [DeepSeek Harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases) |
| Kimi 视觉对照/回退 | `platform.kimi.com` 的旧 Key 继续放入 `MOONSHOT_API_KEY=`；需要切换时选择 `moonshotai-cn` + `kimi-k2.6` | 运行 `npm run smoke:models`；只有匹配 `.cn` 端点仍认证失败时才在同一平台重建 Key | [Kimi 中国区快速开始](https://platform.kimi.com/docs/overview) |
| 高德 | 完成个人认证并创建「Web 服务 API」Key，放入 `AMAP_API_KEY=`；只有控制台开启数字签名时才填写 `AMAP_API_SECRET=` | 先在配额管理确认基础搜索/LBS/天气的实际权益，再运行 `npm run smoke:amap`。POI、照片、静态地图和天气全部通过后才设置 `passed_live_smoke`；路线与设施另行验收 | [创建 Web 服务 Key](https://lbs.amap.com/api/webservice/guide/create-project/get-key)、[配额与价格](https://lbs.amap.com/pages/base_service_price)、[配额管理](https://console.amap.com/dev/flow/manage)、[静态地图](https://lbs.amap.com/api/webservice/guide/api/staticmaps) |
| Open-Meteo 天气回退 | 本地非商业开发无需 Key；商业生产需在 Open-Meteo 购买 customer API 计划并填写 `OPEN_METEO_API_KEY=` | `npm run smoke:weather` 只证明非商业开发链；生产必须使用 customer endpoint，且保留 CC BY 4.0 署名 | [价格与订阅](https://open-meteo.com/en/pricing)、[使用条款](https://open-meteo.com/en/terms)、[天气 API](https://open-meteo.com/en/docs) |
| 飞猪 FlyAI | 已完成：正式 Key 位于服务端 `FLYAI_API_KEY` | 已启用受限 Worker并通过景点、酒店、交通真实只读 smoke | [FlyAI 控制台](https://flyai.open.fliggy.com/console)、[快速开始](https://flyai.open.fliggy.com/docs/quickstart) |
| 途牛官方 MCP | 已完成：个人 Key 位于服务端 `TUNIU_API_KEY` | 已启用固定端点 Provider；酒店、火车、航班真实只读 smoke 均通过 | [途牛 API Keys](https://open.tuniu.com/mcp/apikeys)、[火车 MCP](https://open.tuniu.com/mcp/docs/apidoc/mcp/trainMCP.html) |
| Google 登录（Web 主入口） | 在 Google Cloud 创建 OAuth Web Client、配置同意屏幕与精确回调地址 | OIDC code exchange、state/nonce、Google JWKS 验签和 HTTP 回调合同均已通过；待真实 Client 与账号 smoke | [Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[OpenID Connect](https://developers.google.com/identity/openid-connect/reference) |
| 微信登录 | 微信开放平台创建网站应用；微信公众平台创建小程序，分别登记回调域名与 request domain，并绑定同一开放平台主体 | Web 官方扫码授权、签名 state、服务端 code exchange 和小程序 `code2Session` 合同均已通过；待真实 AppID/Secret 与 Web/真机 smoke | [微信开放平台](https://open.weixin.qq.com/)、[微信小程序登录](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html) |
| 支付宝登录 | 分别创建网页/移动应用和小程序，配置各自 RSA2 密钥、授权回调及服务器域名 | Web 授权页、`alipay.system.oauth.token`、RSA2 请求签名/响应验签和小程序交换合同均已通过；Web 与小程序已支持独立 AppID/密钥，待真实账号 smoke | [支付宝网页/移动应用](https://open.alipay.com/module/webApp)、[小程序 my.getAuthCode](https://miniprogram.alipay.com/docs/miniprogram/mpdev/API_OpenAPI_getAuthCode) |
| Apple 登录 | Apple Developer 中启用主 App ID，创建 Services ID 与 Sign in with Apple Key，登记域名和 Return URL | code exchange、短期 client secret 和 Apple JWKS 验签已实现；待开发者账号与 HTTPS smoke | [Apple Web 配置](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web)、[Token validation](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens) |
| 飞书/Workplace 分发（可选） | 在飞书开放平台创建应用机器人、启用机器人能力、申请所需最小权限并配置事件回调 | 将 Travel Agent 对话作为一个受控渠道，不导入证件/支付或 Cookie | [飞书机器人概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview) |
| 社交数据 | 指定授权主体、专用账号与合规范围；同意只读、遇 challenge 直接降级 | 按已有第三方安全门审计一个候选 Worker；不在 Pi 主进程加载 Cookie | 以各平台当期开发者条款和书面授权为准 |
| 携程商旅/华住会企业直连 | 由企业主体申请、签约并取得 client credentials、网络白名单等授权 | 新增独立企业 Provider；不复用普通用户 Cookie，也不打开自动交易 | [携程商旅开放平台](https://openapi.ctripbiz.com/)、[华住会开放平台](https://docs.huazhu.com/) |

## 当前状态与下一步

普通 DeepSeek 文字路线、DeepSeek Vision、Kimi 视觉路线以及高德、飞猪、途牛均完成无敏感真实调用。Kimi 直接 Pi Child 与最新双 lane 结构化 fallback smoke 均已通过；DeepSeek 最新三 lane 也完整通过。2026-08-26 最新诊断中，高德 POI v5/v3、地理编码、天气、公交、驾车、步行和静态地图成功，本轮自然确认缺陷不是高德错误。航班、票价、余位和酒店 Offer 属于动态库存，只能展示本次 `checkedAt` 快照；例如相邻两次 live fusion 的班次与价格已经变化。Provider smoke 与直接 Service 组合不能替代 Parent Agent 验收；指定的“已购票 → stay-only → 接驳”路径已另以 Safari、真实 HTTP 与 TripState 复测通过。

高德服务组、POI v3/v5 字段差异、IP 诊断、动态地图与路线采用顺序见[高德数据能力全景与 Travel Agent 采用报告](../research/archive/2026-08-16-amap-data-capability-landscape.md)。城市移动的旅行者路径、代码审计、Mobility Gate 与对抗验收见[高德城市移动与产品代码审计](../research/archive/2026-08-16-amap-city-mobility-product-and-code-audit.md)。

```bash
npm run smoke:models
npm run smoke:amap
npm run smoke:weather
npm run smoke:inventory
```

结果只输出模型路线状态和无敏感测试说明。当前配置的多模态模型通过后，还必须完成一次用户主动上传的非敏感旅行图片验收，证明同一轮确实包含图片理解、旅行工具调用和可见方案结果；单独回复“看到了图片”不能作为 Agent 路线已完成的证据。
