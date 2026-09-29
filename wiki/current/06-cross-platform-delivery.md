# 跨端交付、数据与登录

## 2026-09-22 持续规划视图（待实现）

各端按 [14](./14-continuous-planning-business-model.md) 共用已采用版/工作草案、核验状态和执行进度；模型输入与用户视图按 [15](./15-model-context-and-handoff.md) 取自同一业务版本。预览过期或任务失败不能清空计划，候选默认时段不能冒充已确认日程，工具结束不能显示为核验通过。必要问题继续使用稳定 answerTo，回答保存后续接原事项。本文下方前序修复记录只代表其当时已测试路径；本轮新增验收见[交接](../research/2026-09-22-continuous-planning-redesign-handoff.md)。

## 一个内核，六个入口

### 自动接续与单问题协议（2026-09-21）

Web/桌面共用客户端，微信/支付宝源码均使用既有 `POST /api/conversations/:id/runs`。回答可附 `answerTo: { runId, questionId, optionId? }`；选项用稳定 ID，自由回答继续使用 `text`。服务端解析选项文字并校验归属、依赖版本和消费状态；相同答案重复点击返回同一任务，冲突答案或陈旧答案被拒绝。原规划目标随回答继续传递。

`queued` 可带 `waitReason`、`nextEligibleAt` 与固定 `expiresAt`，前端保持方案并自动跟随；`awaiting_input` 呈现一个带影响说明的问题。问题状态为 `open / answered / stale`；等待期间客户端每 5 秒核对跨端状态，后台页面停止额外轮询。其他端修改事实后撤下失效选项，服务端仍是最终校验点。断线从已有 run 与事件游标恢复，不重复提交。

新问题直接展开助手，问题整体 `impact` 和可选 `options[].impact` 分别说明为何需要回答及选项影响；重复轮询不会重新打开用户主动收起的助手。可采用草案显示“查看这版行程”。采用和撤回继续使用原入口。图片仅属于当前请求，发生无法保留图片的中断时需重新附图。小程序合同检查不代表微信/支付宝真机或生产 OAuth 验收。

用户验收修复：刷新后恢复的待回答问题同样自动展开；Guest 初始化与正式编辑页使用同一个语言上下文。手机端回答后可查看草案、明确采用并刷新保留；“完整行程”打开已确认站序与路线，不再跳回候选比较。条件性草案在核验摘要中列出未知项；预算或硬条件失败不会显示采用成功。浏览器与 PostgreSQL 的证据见[复测报告](../research/2026-09-21-traveler-acceptance-fixes.md)，真实地图、设备及生产身份验收保持独立。

业务返工：Web／共用 Web 的桌面不再只渲染 `trial_ready`，不可采用的已排草案也能查看并从持久预览恢复；界面显示尚待解决的问题，只有最新核验允许且采用参数有效时才能提交。失败草案不挤掉已采用行程。共享 API 向各端提供同一份结果；本轮具体浏览器证据与未实测端见[返工报告](../research/2026-09-21-traveler-business-rework.md)，不把手机视口当作小程序或原生真机验收。

调整草案的路线差异为零是“耗时、步行、换乘和估算费用与当前行程一致”，不能显示成等待核验；没有路线数据时才保持待核验。已采用站序在新同行人要求后仍可查看，日期未取得时显示未知，不渲染 `undefined`。完整草案采用复用服务端整体提交结果，不在客户端逐领域取消旧选择。

| 入口 | 工程 | 共享能力 | 当前可验证边界 |
| --- | --- | --- | --- |
| Web / PWA | React + Vite | HTTP API、旅行状态、路线详情、分层地图、离线 shell | 已构建，可本地真实交互；高德 JS 薄渲染器与 Leaflet/静态图降级均已接线，但高德 JS 仍需独立 Web Key 与浏览器 live smoke。 |
| macOS / Windows / Linux 桌面壳 | Electron 44 + 同一 React Web Core | 同一 HTTP API、TripState、Evidence Companion；隔离原始来源视图与系统浏览器登录 | E2 安全壳和 E3 同窗阅读代码已完成，真实 Electron 安全 smoke 通过；生产 OAuth、签名/公证、高德自定义 origin live smoke 仍待账号与发布环境。 |
| iOS | Capacitor | 同一 Web bundle 与 HTTPS API | 工程已生成并可 copy；本机缺完整 Xcode/CocoaPods 时不声称已编译。 |
| Android | Capacitor | 同一 Web bundle 与 HTTPS API | 工程已生成并完成 asset copy；签名与 SDK 构建由发布环境完成。 |
| 微信小程序 | 官方原生小程序工程 | HTTP API、`wx.login` 授权码交换、当天原生地图与路线试排 | 当天 marker/polyline、下一段、方式切换和失败保留已进入真实页面代码；真实 AppID、域名白名单、开发工具与真机 smoke 仍需发布主体完成。 |
| 支付宝小程序 | 官方原生小程序工程 | HTTP API、`my.getAuthCode` 授权码交换、当天原生地图与路线试排 | 当天 marker/polyline、下一段、方式切换和失败保留已进入真实页面代码；真实 AppID、RSA2、开发工具与真机 smoke 仍需发布主体完成。 |
| MCP | Node stdio | `TravelService` 业务合同 | 可本地调用，不维护第二份状态。 |

桌面浏览器与大屏折叠屏继续使用响应式 Web。Electron 只提供分发、系统浏览器 OAuth/deep link 和隔离原始来源视图，不维护与 Web 竞争的业务 UI、状态或旅行规则。

## 已锁定技术方案

第一阶段采用 **React Web Core + PWA + 现有 Capacitor iOS/Android + 轻量微信/支付宝原生小程序**。技术调研见 [TREK 技术栈与全平台方案](../research/archive/2026-08-20-trek-technical-stack-and-cross-platform-options.md)。

实施边界：

1. Web Core 是视觉、交互和客户端状态的主实现；桌面浏览器、PWA、折叠屏和 Capacitor 共享该实现。
2. iOS/Android 保持 Capacitor 7，本轮不顺带升级；原生能力通过受控 Plugin 接入。
3. 微信/支付宝继续作为轻量 Chat / Today / Map / 分享与履约入口，不复制桌面工作台。
4. 小程序增长为多页面完整规划器后才重新评估 Taro；桌面当前采用 Electron 增强壳，Tauri 2 只在包体或系统 WebView 约束成为实测瓶颈时重评。
5. 当前不引入 Flutter、React Native、Tauri 或 Taro；Electron 不获得第二份业务实现权。
6. “全平台复用”优先共享合同、API Client、View Model、i18n、设计 Token 和验收场景，不强迫所有平台共享同一 DOM。

### Evidence Companion 桌面壳状态（E2/E3 代码已落地）

D26 已按当前需求选择 Electron：`WebContentsView`、独立 Session、自定义协议与现有 Node/React 工程能以更短因果链完成同窗原文；Tauri 2 更轻，但会同时引入 Rust 与三套系统 WebView 差异。当前实现包括：

1. Trusted App 使用 `travelapp://app` 与 sandbox/contextIsolation；Untrusted Evidence 使用独立持久 Session，关闭 Node、权限、下载、新窗口、跨平台导航和任意 IPC；
2. 系统浏览器完成 OAuth，回传只含两分钟一次性 code，桌面再换取仅内存 Bearer；Provider Cookie 和平台 Cookie 不进入 Agent；
3. 原始小红书/抖音/微信来源可在同窗右侧打开，左侧继续显示可信证据摘要、翻译和路线试排；关闭时显式销毁 WebContents；
4. 20 次打开/关闭、未知导航阻断、Session 隔离与 deep link 合同已通过真实 Electron smoke。

生产发布仍受三项外部门限制：各 OAuth 平台真实回调、高德 Web JS Key 对 `travelapp://app` 的真实授权验证、macOS/Windows 签名与公证。未关闭前只能称为“桌面代码和安全壳通过本地 smoke”，不能称为商店可发布。

## 数据与同步

生产运行设置 `DATABASE_URL`，由 `PostgresTripRepository` 将每个 `trip-control-state-v1` 以 JSONB snapshot 持久化，并在 `storage_version` 条件更新中拒绝并发覆盖。`trip_states` 的迁移由 `npm run db:migrate` 执行。

未设置数据库时，`TripStore` 将单趟旅行写入权限为 0600 的原子 JSON 文件。这只是一种本地开发和合同验证模式；它不被描述为跨设备同步或生产存储。

## 登录与会话

Web 首次价值不要求登录。`POST /api/auth/guest-session` 签发随机 Guest 身份，复用同一 Conversation、TripState 和成员权限；临时访问默认 7 天。用户登录后，服务端把该 Guest 的旅行与对话转移到账号，旧 Guest 不再有访问权。当前已经验证访问阻断和本地开发登录后的无损合并；生产 OAuth 合并仍必须用真实平台回调复核。过期 Guest 的物理数据清理任务尚未实现，不能把访问过期等同于数据已经删除。

旅行对话支持软删除与恢复：普通列表隐藏 `deletedAt` 非空的 Conversation，“最近删除”仍可读取并恢复。删除 Conversation 不删除关联 TripState、确认选择或路线；前端必须在删除前明确说明这一边界。生产后续可增加自动清理周期，但不能把软删除表述为物理删除。

需要保存、跨端、分享或行中恢复时，Web 以 Google 为海外主入口，另提供微信扫码、支付宝扫码和 Apple 登录。`/api/auth/providers` 只返回各渠道是否可用；`/api/auth/:provider/start` 生成带短期签名 state 的官方授权地址，回调校验 OAuth state、OIDC 身份令牌或支付宝 RSA2 响应签名后，才签发本站会话。微信和支付宝小程序继续使用 `/api/auth/platform-exchange`，并向平台交换一次性授权码。

Electron 不复制 OAuth SDK：它在系统浏览器打开同一 `/api/auth/:provider/start?client=desktop`，服务端回调到固定 `zhuanshu-travel://auth/callback`，只携带一次性 code；`POST /api/auth/desktop-exchange` 消费一次后签发 Bearer。桌面 Guest 同样先获得价值，登录时由服务端归并 Guest Trip/Conversation。Bearer 在可信 renderer 中仅存内存，主进程通过 Electron safeStorage 使用系统密钥库加密保存，并按 API Origin 隔离；不写 URL、localStorage、Prompt 或日志。系统安全存储不可用时仅维持本次应用会话，并在账号页提示。服务端账号与会话使用 PostgreSQL（本地开发为 SQLite），退出和一次性 code 的消费不会因重启失效。

运行 `npm run auth:setup` 可生成本站会话/state 密钥并补齐本地 ENV 模板，`npm run auth:check` 会分别检查 Google Web、微信 Web、微信小程序、支付宝 Web、支付宝小程序与 Apple Web 的字段、回调、私钥文件权限和 live smoke。支付宝 Web 与小程序允许使用独立 AppID 和密钥；微信网站应用与小程序应绑定到相同开放平台主体，避免同一用户因缺少 UnionID 被拆成两个账号。平台控制台、生产部署和真实验收步骤统一见[部署与配置指南](./09-account-configuration-guide.md)。

生产会话由 `TRAVEL_AGENT_SESSION_SECRET` 签名，Web 只保存在 `HttpOnly`、`SameSite=Lax` cookie 中；原生和小程序通过 `Authorization` header 使用同一受控会话。Token、平台 access token 和 `session_key` 不进入 Agent、Prompt、日志或旅行状态。注销会清除 Cookie 并在当前服务实例撤销会话；轮换会话密钥会使全部现有会话失效。

本地仍可显式设置 `TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH=true` 创建开发会话，以验证业务交互。它只显示为“本地开发”，在生产环境无效，也不再伪装成邮箱或第三方登录。

## V2 端侧职责

- 桌面 Web：对话可折叠；Trip 工作区先显示四域当前选择，按当前焦点展开一组替代项，地图、时间轴与影响保持同屏。地图默认按 Day 展示，每一段路线与卡片共享焦点、方式、分钟和查询时影响；同一酒店多次到访保留多个序号。单地点完整详情按需展开；容器窄于约 900px 时才改单列。
- Electron 桌面：复用上述 Web Core；用户主动打开公开分享原文时形成可信伴侣 / 不可信原页左右分栏，Esc 或“收起原文”销毁原页视图。原页没有 Tool、Token、Agent 或旅行提交权。
- 移动 Web / 原生壳：固定 Chat / Trip / Map 三入口；确认地点后 Map 显示 Today、当前/下一步、准备缺口和变化恢复。地图使用双指缩放、单指拖动与可见缩放控件，仍共用 Web Core 的路线投影。
- 英文：根据浏览器语言自动选择，并提供中英切换。当前核心执行外壳已本地化；地点英文别名、地址转写和 Provider 长文本仍待统一归一。
- 小程序：复用上述服务状态并采用轻量 Today，只绘制当前 Day、当前方式和 active leg，并在地图下直接显示“下一段怎么走”；切换方式仍由服务端 Mobility Preview 核验，不复制桌面比较工作台。真实扫码授权、域名白名单、开发工具和真机回跳仍是发布门。

## 离线边界

当前 `manifest.webmanifest + public/sw.js` 只提供安装和 App Shell 缓存。V2 目标是 `Today Offline Pack`，不是完整离线工作台：

- `/api` 不进入共享 Service Worker Cache；
- 结构化离线数据按 userId 隔离；
- logout、Guest claim 和 identity switch 清理旧身份缓存；
- 只缓存当天执行资料、有限公开缩略图和有边界的地图切片；
- 保存核验时间、`freshUntil` 与离线状态；
- 不缓存证件、支付、Cookie、Token 或未遮盖预订号；
- V2 首版离线只读，现场变化先留在本机，联网后由用户确认提交，不立即引入完整离线写冲突系统。

## 配置边界

- `VITE_TRAVEL_API_BASE_URL`：Capacitor bundle 的受控 HTTPS API；Web/PWA 留空则使用同源 `/api`。
- 小程序 `app.js` 的 `apiBaseUrl`：已配置到小程序后台 request domain 的 HTTPS API；由授权发布主体在提交前写入环境化配置。
- `TRAVEL_AGENT_CORS_ORIGINS`：逗号分隔的精确生产 origin；本地开发模式仅放行 `localhost` / `127.0.0.1`。
- `DATABASE_URL`：生产 PostgreSQL，不进入 Web bundle、Prompt、日志或 artifact。
- `TRAVEL_AGENT_PUBLIC_ORIGIN`：生产站点唯一 HTTPS Origin；四个平台的回调地址均从这里生成。
- `TRAVEL_AGENT_SESSION_SECRET`、`TRAVEL_AGENT_AUTH_STATE_SECRET`：两个独立的随机服务端密钥，至少 32 字符。
- `AMAP_JS_API_KEY`：高德 Web 平台的浏览器可见 JS Key；不等同于服务端 `AMAP_API_KEY`。
- `AMAP_JS_SECURITY_CODE`：高德 JS 安全密钥，只由固定 `/_AMapService` 服务端代理使用，不进入浏览器响应。
- `TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED`：地图渲染器开关；关闭时保持 Leaflet/静态图降级，不改变路线事实。
- `TRAVEL_AGENT_DESKTOP_AUTH_ENABLED`、`TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME`、`TRAVEL_AGENT_DESKTOP_API_ORIGIN`：桌面 OAuth、固定 deep link 和 HTTPS API；发布时需把 `travelapp://app` 加入精确 CORS Origin。

平台侧 AppID 为空时只能完成工程构建，不能提审或上线；不得填入演示 AppID 冒充可发布配置。
