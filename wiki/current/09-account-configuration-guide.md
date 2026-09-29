# 部署与配置指南

这份文档是 Travel Agent 的统一部署入口。它覆盖本地开发、生产 Web/PWA、PostgreSQL、模型与旅行数据源、Google/微信/支付宝/Apple 登录、Capacitor 原生应用和两个小程序。

文档中的“已接入”只表示代码路径存在；只有填入真实平台凭据并完成 live smoke，才能把对应能力视为可用。任何 Secret、Cookie、Token、证件或支付资料都不能进入 Git、浏览器变量、Prompt 或日志。

## 1. 部署形态

### Jev 接入与验收（2026-09-21）

在服务端私有环境设置 `TYPESAFE_API_KEY`、`TRAVEL_AGENT_JEV_MODE=off|shadow|auto`；校准文件路径使用 `TRAVEL_AGENT_JEV_CALIBRATION_FILE`。不要将密钥放入 `VITE_*`、小程序或 Wiki。当前默认 `off`，真实小样本尚不构成自动上线校准。校准文件由服务端发布，结构为 `{ "travel-candidate-fit-v1": { "zh": { "model": "jev-1.13.0", "validatedLive": true, "datasetHash": "独立评估集的64位SHA256", "threshold": 0.95 } } }`；此处仅说明字段，**不是可以直接采用的阈值或校准证据**。

多实例使用 `DATABASE_URL` 与 `TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE=postgres_run`，API/Worker 共享数据库和账号预算。按真实 Parent/Child 账号权益配置 `TRAVEL_AGENT_MODEL_LIMITS`；生产缺少配额配置会拒绝模型调用。Jev 的固定额度不可用多个 API Key 绕过。本地 SQLite 仅用于开发和合同验证。

复现命令：

```bash
node --import tsx --test tests/travel-jev.test.mjs tests/travel-decision-policy.test.mjs tests/travel-execution.test.mjs
npm run evaluate:jev
npm run evaluate:jev-product
npm run smoke:execution-capacity
npm run smoke:jev-capacity
npm run check
```

真实评估显式设置 `TRAVEL_JEV_LIVE_EVAL=true`，可用 `TRAVEL_JEV_TEST_ENV_FILE` 在测试进程读取受控账户文件；输出由 `TRAVEL_JEV_EVAL_OUTPUT` 指定。产品三模式对照使用 `TRAVEL_JEV_PRODUCT_EVAL=true`、`TRAVEL_JEV_PRODUCT_OUTPUT` 和隔离数据库。负载测试要求 `TRAVEL_EXECUTION_TEST_DATABASE_URL` 指向本机独立 `/travel_execution_test` 数据库，只创建/删除本次随机 schema；`TRAVEL_EXECUTION_TEST_USERS` 默认 500，`TRAVEL_EXECUTION_TEST_DURATION_MS` 默认 1,800,000，输出为 `TRAVEL_EXECUTION_TEST_OUTPUT`。它调用受控模型与旅行 Provider，不能作为真实接口容量证据。测试凭据不可复用生产数据。多进程负载与数据库故障注入应独立运行，避免各测试的连接池之和超过测试库的 `max_connections`。

```text
Web / PWA / iOS / Android / 微信小程序 / 支付宝小程序
                              │
                              ▼
                      HTTPS 反向代理
                              │
                              ▼
              Node API + Travel Parent Agent
                    │                   │
                    ▼                   ▼
               PostgreSQL        模型与旅行 Provider
```

- API 和 Web 由同一个 Node 进程提供：生产构建后的 `dist/` 会作为静态站点返回，`/api/*` 由服务端处理。
- 服务端只监听 `127.0.0.1:8797`，生产环境必须通过 HTTPS 反向代理对外开放。
- Web/PWA 可同源访问 API；Capacitor 和小程序使用同一公开 HTTPS API。
- 本地 JSON repository 只用于开发。需要跨设备保存、并发保护和正式账号时必须使用 PostgreSQL。
- MCP 通过 stdio 调用同一个 `TravelService`，不维护第二份旅行状态。

## 2. 部署前准备

### 基础环境

- Node.js `>=22.19.0`
- npm
- 生产环境 PostgreSQL
- 一个最终 HTTPS 域名
- 可持续运行 Node 进程的进程管理器或容器
- 需要启用的模型、地图、OTA 和登录平台账号

### 获取代码与安装依赖

```bash
git clone https://github.com/DESONGs/zhuanshu-travel-agent.git
cd zhuanshu-travel-agent
npm ci --ignore-scripts
```

项目固定使用 lockfile。不要在部署时执行第三方 lifecycle script，也不要复制另一台电脑的 `node_modules`、`dist/`、运行数据或密钥。

## 3. 配置文件与 Secret

本地开发可以从示例文件开始：

```bash
cp .env.example env_travel.local
chmod 600 env_travel.local
npm run auth:setup
```

Windows PowerShell：

```powershell
Copy-Item .env.example env_travel.local
```

API 会自动读取项目根目录的 `env_travel.local`。该文件已被 Git 忽略；macOS/Linux 必须保持 `0600`，Windows 应只允许部署账号读取。

生产环境更推荐由部署平台的 Secret Manager 注入同名环境变量。支付宝 RSA 私钥、Apple `.p8` 文件和其他签名材料必须放在仓库外，并限制为部署账号可读。

绝对不能放进浏览器或小程序的字段包括：

- 所有 `*_SECRET`、服务端 Provider API Key、平台 access token；
- `DATABASE_URL`；
- RSA 私钥、Apple `.p8`；
- Session 和 OAuth state 密钥。

`VITE_*` 只允许公开地址、公开地图瓦片模板和署名，不能承载任何 Secret。高德 Web 平台 JS Key 按官方机制本来就会在浏览器载入脚本时可见；它由认证后的 Provider Status 返回，不写入 `VITE_*`。配套 `securityJsCode` 始终留在服务端。

## 4. 本地开发

在 `env_travel.local` 中填写：

```dotenv
NODE_ENV=development
PORT=8797
TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH=true
TRAVEL_AGENT_DATA_DIR=runtime-data/trips
TRAVEL_AGENT_CORS_ORIGINS=http://127.0.0.1:5173

TRAVEL_AGENT_MODEL_PROVIDER=deepseek
TRAVEL_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=
TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS=not_run
```

先验证模型，再启动两个进程：

```bash
npm run smoke:models
npm run smoke:conversation
```

```bash
npm run api
```

```bash
npm run web:dev
```

访问 [http://127.0.0.1:5173](http://127.0.0.1:5173)。本地开发身份只用于产品 QA，不能冒充生产 Google、微信、支付宝或 Apple 登录。

## 5. 生产 Web/PWA

### 必填服务端设置

```dotenv
NODE_ENV=production
PORT=8797
TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH=false

TRAVEL_AGENT_PUBLIC_ORIGIN=https://travel.example.com
TRAVEL_AGENT_CORS_ORIGINS=https://travel.example.com
TRAVEL_AGENT_SESSION_SECRET=至少32字符的独立随机值
TRAVEL_AGENT_AUTH_STATE_SECRET=另一组至少32字符的独立随机值

DATABASE_URL=postgresql://user:password@host:5432/travel_agent

TRAVEL_AGENT_MODEL_PROVIDER=deepseek
TRAVEL_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=
TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS=not_run
```

`TRAVEL_AGENT_SESSION_SECRET` 与 `TRAVEL_AGENT_AUTH_STATE_SECRET` 不能相同。当前会话改为数据库中的随机令牌摘要，轮换 Session Secret 不再撤销这些会话；应通过账号设备管理或数据库会话撤销操作退出设备。OAuth State Secret 轮换会使尚未完成的授权请求失效。

账号、平台身份映射、会话撤销和桌面一次性 code 共用持久存储。生产必须设置 `DATABASE_URL`，多个 API 实例使用同一 PostgreSQL；本地未配置时使用 `TRAVEL_AGENT_DATA_DIR/auth.sqlite`（默认 `runtime-data/auth.sqlite`）。账号登录固定有效 14 天，游客 7 天，不自动无限续期。Web 使用 HttpOnly Cookie；桌面和小程序沿用 Bearer API。数据库仅保存会话令牌的 SHA-256 摘要。

升级前注意：旧版签名 Cookie 不导入新会话库，以免重新激活旧版已撤销但只在内存中记录的会话。既有正式账号重新完成平台登录后沿用原 userId，保留旅行归属；旧版匿名 Guest Cookie 不会自动认领，部署前应让有待保存旅行的游客先登录。不同平台的已存在账号不会自动合并。

### 构建、迁移与启动

```bash
npm run check
npm run db:migrate
npm run web:build
npm run api
```

反向代理应完成以下工作：

- 为 `TRAVEL_AGENT_PUBLIC_ORIGIN` 提供有效 HTTPS；
- 将该域名的请求转发到 `127.0.0.1:8797`；
- 保留 `X-Forwarded-Proto` 和原始 Host；
- 不缓存 `/api/*`、登录回调或用户旅行数据；
- 允许静态资源按文件指纹缓存，但不要长期缓存 `index.html`。

部署后先检查：

```bash
curl https://travel.example.com/api/health
```

然后在真实浏览器完成 Guest 对话、刷新恢复、登录合并、地点地图、候选确认和注销。

## 6. 模型与多模态 Agent

### DeepSeek：文字推理、工具调用和首选视觉路线

申请入口：[DeepSeek API Keys](https://platform.deepseek.com/api_keys)

```dotenv
TRAVEL_AGENT_MODEL_PROVIDER=deepseek
TRAVEL_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=
TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS=not_run

TRAVEL_AGENT_VISION_PROVIDER=deepseek
TRAVEL_AGENT_VISION_MODEL=deepseek-v4-flash-vision-exp
TRAVEL_AGENT_DEEPSEEK_VISION_SMOKE_STATUS=not_run
```

图片与用户文字会进入同一个 Parent Agent 回合，视觉模型可以继续调用既有旅行工具。图片中“可见电梯标识”只能成为图片证据，不能推断为“电梯当前正常运行”。

### Kimi：中国区备用视觉路线与 sub-agent

申请入口：[Kimi API Keys](https://platform.kimi.com/console/api-keys)

```dotenv
MOONSHOT_API_KEY=
TRAVEL_AGENT_KIMI_SMOKE_STATUS=not_run
```

需要把 Kimi 设为视觉路线时：

```dotenv
TRAVEL_AGENT_VISION_PROVIDER=moonshotai-cn
TRAVEL_AGENT_VISION_MODEL=kimi-k2.6
```

中国区 Key 使用 `https://api.moonshot.cn/v1`。不要把 `.cn` Key 配到国际区端点。

### 模型验收

```bash
npm run smoke:models
npm run smoke:conversation
```

换 Key、模型或端点后必须重新运行。通过脚本后还要从真实聊天入口发送一张非敏感旅行图片，确认同一回合完成看图、理解需求、调用工具并生成可确认方案。

## 7. 地图、天气与旅行库存

### 高德：地点、照片、静态地图、天气和城市路线

申请入口：[高德开放平台控制台](https://console.amap.com/dev/key/app)

创建 **Web 服务** Key，而不是把服务端 Key 暴露给浏览器：

```dotenv
AMAP_API_KEY=
AMAP_API_SECRET=
TRAVEL_AGENT_AMAP_SMOKE_STATUS=not_run
```

只有控制台为该 Key 开启数字签名时才填写 `AMAP_API_SECRET`。

```bash
npm run diagnose:amap
npm run smoke:amap
```

高德账号返回配额、权限或风控错误时，地点与路线会诚实降级。短暂成功或静态 fixture 不能作为生产接通证据。

### 浏览器互动底图

中国境内桌面 Web/PWA/Capacitor 的首选互动底图是高德 JS API 2.0。需要在高德控制台另建 **Web 端（JS API）** Key，不能复用服务端 WebService Key：

```dotenv
AMAP_JS_API_KEY=
AMAP_JS_SECURITY_CODE=
TRAVEL_AGENT_AMAP_JS_RENDERER_ENABLED=true
TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS=not_run
```

- `AMAP_JS_API_KEY` 是浏览器可见的 Web JS Key；
- `AMAP_JS_SECURITY_CODE` 只由同源 `/_AMapService` 固定代理追加，代理会覆盖客户端传入的 `key/jscode`，不能转发任意域名；
- 在控制台配置生产域名白名单，并分别验证 Web/PWA 与 Capacitor 来源；
- 真实浏览器成功载入、点击路线、缩放和切换方式后，才能把 smoke 状态改为 `passed_live_smoke`。

2026-09-01 当前实测：Web JS SDK 已在 localhost 真实显示高德底图、Marker、Polyline/路线 chip，并通过拖动、可见 `+ / −`、Day 切换、Marker/路线卡联动和交通方式切换；浏览器控制台无新增错误。服务端 WebService 的定向 POI、照片、路线、静态图和天气完整 smoke 也已通过。可是 `/_AMapService` 的独立真实请求仍返回 `10009 USERKEY_PLAT_NOMATCH`，因此 `TRAVEL_AGENT_AMAP_JS_SMOKE_STATUS` 继续保持 `not_run`。请在高德控制台确认：JS Key 的平台必须是 **Web 端（JS API）**，securityJsCode 必须来自同一个 Key；不要把 WebService Key 填到 JS Key，也不要把 `travelapp://app` 当普通域名加入白名单。两项确认后重跑浏览器和 Electron，不通过时依据[高德官方错误码说明](https://lbs.amap.com/api/maps-javascript-api/guide/abc/state)提交工单。

官方入口：[准备与创建 Web 端 Key](https://lbs.amap.com/api/javascript-api-v2/prerequisites)、[安全密钥与服务端代理](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。

开发模式未配置高德 JS 时可使用带署名的 OpenStreetMap 公共瓦片做本地 QA；生产不会默认依赖该公共服务。需要替代底图时可配置：

```dotenv
VITE_TRAVEL_MAP_TILE_URL=
VITE_TRAVEL_MAP_ATTRIBUTION=
```

高德 JS 未配置或加载失败时，界面先诚实降级到 Leaflet；生产没有合规瓦片时再回退到服务端高德静态地图。不要把 `AMAP_API_KEY` 或 `AMAP_JS_SECURITY_CODE` 放进 `VITE_*`。

### 天气

高德天气通过完整 smoke 时优先使用。Open-Meteo 免费端点只允许本地非商业评估；商业生产必须购买计划并配置 Customer API Key。

- 价格与申请：[Open-Meteo Pricing](https://open-meteo.com/en/pricing)

```dotenv
TRAVEL_AGENT_OPEN_METEO_ENABLED=true
OPEN_METEO_API_KEY=
```

```bash
npm run smoke:weather
```

### 飞猪 FlyAI 与途牛

- 飞猪申请：[FlyAI 控制台](https://flyai.open.fliggy.com/console)
- 途牛申请：[途牛 MCP 开放平台](https://open.tuniu.com/mcp)

```dotenv
TRAVEL_AGENT_FLYAI_ENABLED=true
FLYAI_API_KEY=
TRAVEL_AGENT_FLYAI_SMOKE_STATUS=not_run

TRAVEL_AGENT_TUNIU_ENABLED=true
TUNIU_API_KEY=
TRAVEL_AGENT_TUNIU_SMOKE_STATUS=not_run
```

```bash
npm run smoke:inventory
```

两者只允许搜索酒店、航班、火车和景点并返回候选或跳转。它们不提供可靠餐饮数据，也不能自动下单、付款或退改。

## 8. Google、微信、支付宝与 Apple 登录

### 先固定唯一 HTTPS Origin

```dotenv
TRAVEL_AGENT_PUBLIC_ORIGIN=https://travel.example.com
TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH=false
```

运行：

```bash
npm run auth:setup
npm run auth:check
```

`auth:check` 会检查共享 Secret、HTTPS Origin、支付宝 RSA 文件和各渠道 smoke，并输出精确回调。渠道未全部配置时退出码为 `2` 是预期结果，不代表脚本损坏。

需要登记的地址为：

```text
https://travel.example.com/api/auth/google/callback
https://travel.example.com/api/auth/wechat/callback
https://travel.example.com/api/auth/alipay/callback
https://travel.example.com/api/auth/apple/callback
https://travel.example.com/api/auth/platform-exchange
```

### Google Web

人工操作：

1. 在 [Google Cloud Credentials](https://console.cloud.google.com/apis/credentials) 创建 Web application OAuth Client。
2. 完成 Branding、Audience 和 Data Access，并准备可公开访问的首页、隐私政策与服务条款。
3. Authorized redirect URI 逐字符填写 `https://travel.example.com/api/auth/google/callback`。
4. 配置：

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TRAVEL_AGENT_GOOGLE_AUTH_SMOKE_STATUS=not_run
```

参考：[Google Web Server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)。

### 微信 Web 扫码与微信小程序

人工操作：

1. 在[微信开放平台](https://open.weixin.qq.com/)创建并审核网站应用，登记正式回调域。
2. 在[微信公众平台](https://mp.weixin.qq.com/)创建小程序并登记 HTTPS request domain。
3. 将网站应用和小程序绑定到同一开放平台主体，尽量取得统一 UnionID，避免同一用户被拆成两个账号。
4. 配置：

```dotenv
WECHAT_OPEN_APP_ID=
WECHAT_OPEN_APP_SECRET=
WECHAT_MINIAPP_APP_ID=
WECHAT_MINIAPP_APP_SECRET=
TRAVEL_AGENT_WECHAT_WEB_AUTH_SMOKE_STATUS=not_run
TRAVEL_AGENT_WECHAT_MINIAPP_AUTH_SMOKE_STATUS=not_run
```

Web 会进入微信官方二维码页面；小程序只把 `wx.login` 返回的一次性 code 发给服务端。参考：[网站应用微信登录](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Development_Guide.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)。

### 支付宝 Web 与支付宝小程序

人工操作：

1. 在[支付宝开放平台](https://open.alipay.com/)分别创建网页/移动应用和小程序，开通用户授权并登记回调或服务器域名。
2. 使用公钥模式生成 RSA2 密钥；上传应用公钥，下载支付宝公钥。
3. 把私钥和支付宝公钥放在仓库外，macOS/Linux 权限设为 `0600`。
4. Web 与小程序可使用不同 AppID 和密钥：

```dotenv
ALIPAY_WEB_APP_ID=
ALIPAY_WEB_PRIVATE_KEY_PATH=/仓库外/alipay-web-private.pem
ALIPAY_WEB_PUBLIC_KEY_PATH=/仓库外/alipay-web-public.pem
TRAVEL_AGENT_ALIPAY_WEB_AUTH_SMOKE_STATUS=not_run

ALIPAY_MINIAPP_APP_ID=
ALIPAY_MINIAPP_PRIVATE_KEY_PATH=/仓库外/alipay-mini-private.pem
ALIPAY_MINIAPP_PUBLIC_KEY_PATH=/仓库外/alipay-mini-public.pem
TRAVEL_AGENT_ALIPAY_MINIAPP_AUTH_SMOKE_STATUS=not_run
```

小程序通过 `my.getAuthCode({ scopes: ["auth_user"] })` 获取一次性 code，随后由服务端兑换。参考：[my.getAuthCode](https://miniprogram.alipay.com/docs/miniprogram/mpdev/API_OpenAPI_getAuthCode)、[用户授权流程](https://miniprogram.alipay.com/docs/miniprogram/mpdev/api_openapi_userauthorization)。

### Apple Web

人工操作：

1. 加入 Apple Developer Program，创建支持 Sign in with Apple 的 Services ID。
2. 登记站点域名和 `https://travel.example.com/api/auth/apple/callback`。
3. 创建 Sign in with Apple Key，把 `.p8` 文件放在仓库外。
4. 配置：

```dotenv
APPLE_CLIENT_ID=
APPLE_TEAM_ID=
APPLE_KEY_ID=
APPLE_PRIVATE_KEY_PATH=/仓库外/AuthKey.p8
TRAVEL_AGENT_APPLE_AUTH_SMOKE_STATUS=not_run
```

参考：[Configure Sign in with Apple for the web](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/)。

### 每个渠道都要做的真实验收

1. 从 Guest Trip 发起登录。
2. 进入官方授权页或二维码页。
3. 平台回调后回到原旅行。
4. 确认 Guest 对话和 TripState 无损合并。
5. 刷新页面后仍能恢复会话。
6. 注销后旧会话不能继续读取旅行。
7. 只把该渠道的 smoke 字段改为 `passed_live_smoke`，再次运行 `npm run auth:check`。

## 9. iOS、Android 与小程序

### Capacitor iOS/Android

```dotenv
VITE_TRAVEL_API_BASE_URL=https://travel.example.com
```

```bash
npm run native:sync
```

然后分别在 Xcode 和 Android Studio 中配置签名、权限和商店资料，并在真机验证登录、图片上传、地图唤端、会话恢复和网络中断恢复。完成资源同步不等于原生包已经通过商店验收。

### 微信小程序

1. 在微信开发者工具导入 `apps/miniapp/wechat/`。
2. 由发布主体填写真实 AppID。
3. 将 `app.js` 的 `apiBaseUrl` 设置为生产 HTTPS Origin。
4. 在后台登记 request domain，并完成真机登录与旅行对话。

### 支付宝小程序

1. 在支付宝开发者工具导入 `apps/miniapp/alipay/`。
2. 由发布主体填写真实 AppID。
3. 将 `app.js` 的 `apiBaseUrl` 设置为生产 HTTPS Origin。
4. 在后台登记服务器域名，并完成真机授权与旅行对话。

检查两个小程序合同：

```bash
npm run miniapp:weapp
npm run miniapp:alipay
```

## 10. 上线验收

### 自动检查

```bash
npm ci --ignore-scripts
npm run check
npm run auth:check
npm run smoke:models
npm run smoke:conversation
npm run diagnose:amap
npm run smoke:amap
npm run smoke:weather
npm run smoke:inventory
```

### 人工黄金路径

- Guest 用一句话和一张旅行图片开始规划；
- Agent 正确保留日期、同行人、预算、体力和入境执行限制；
- 吃、住、行、玩候选来自真实 Provider，并能在地图中定位；
- 设施、路线、库存、价格和天气都显示来源与新鲜度；
- 用户接受方案后才写入正式旅行；
- 登录后 Guest 数据无损合并，刷新可恢复，注销会失效；
- 下雨、延误或闭店只重排受影响部分；
- Provider 不可用时显示明确原因，不返回 fixture 或静态假数据。

### 常见状态如何理解

| 状态 | 含义 | 处理方式 |
| --- | --- | --- |
| `not_run` | 已填或未填配置，但尚未做真实 smoke | 运行对应 smoke，不要直接改成通过。 |
| `auth_provider_not_configured` | 登录代码存在，但平台账号、回调或 Secret 不完整 | 继续完成该平台人工配置。 |
| `provider_unavailable` | 当前 Provider 无法提供可靠结果 | 检查账号、权限、配额与网络，界面保持诚实降级。 |
| `credential_configured_pending_live_smoke` | 凭据格式完整，但未验证真实用户路径 | 完成真实回调或 Provider 黄金路径。 |
| `passed_live_smoke` | 指定版本、账号和环境完成了真实验证 | 换 Key、域名、版本或权限后必须重跑。 |

## 11. 当前仍需项目所有者完成

- 选择最终 HTTPS 域名和部署平台；
- 提供生产 PostgreSQL 与备份策略；
- 在 Google、微信、支付宝和 Apple 控制台创建并审核应用；
- 配置微信/支付宝小程序真实 AppID、服务器域名和发布主体；
- 提供高德、飞猪、途牛和生产天气的商业账号或授权；
- 创建高德 Web JS Key、安全码与域名白名单，并完成真实浏览器/Capacitor smoke；
- 在目标 Windows、macOS、iOS、Android、微信和支付宝设备完成真实验收。

在这些人工门槛关闭前，可以说明“代码与配置入口已完成”，不能说明“生产渠道已经上线”。

## 12. Electron 桌面壳、deep link 与社交 Worker

### 桌面运行配置

```dotenv
TRAVEL_AGENT_DESKTOP_AUTH_ENABLED=true
TRAVEL_AGENT_DESKTOP_DEEP_LINK_SCHEME=zhuanshu-travel
TRAVEL_AGENT_DESKTOP_API_ORIGIN=https://你的-api-域名
TRAVEL_AGENT_CORS_ORIGINS=https://你的-web-域名,travelapp://app
```

生产 OAuth 仍在各平台登记同一 HTTPS 回调：`https://你的-api-域名/api/auth/{provider}/callback`。Electron 只把系统浏览器成功结果转成 `zhuanshu-travel://auth/callback?code=...`；该 code 在共享数据库中保存摘要，两分钟、只消费一次，不是 access token。Electron 主进程使用系统安全存储加密保存 Bearer，按 API Origin 隔离；可信 renderer 只在内存持有令牌，不写 localStorage。Linux `basic_text` 存储不启用持久保存；系统密钥库不可用时，账号页明确提示重启后重新登录。运行 `npm run auth:check` 会同时显示 Web/小程序渠道与桌面 deep link 状态。

本地验证：

```bash
npm run desktop:typecheck
npm run desktop:smoke
npm run desktop:package
```

`desktop:smoke` 是真实 Electron 进程安全验证；`desktop:package` 只生成未签名包，不能替代 Apple notarization、Windows code signing 或三平台安装测试。Electron 官方安全基准：[Security](https://www.electronjs.org/docs/latest/tutorial/security)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view)、[Session](https://www.electronjs.org/docs/latest/api/session)。

### 高德 JS Web Key

在[高德控制台](https://console.amap.com/dev/key/app)创建独立 Web 端 Key 与安全密钥，先登记 Web/PWA HTTPS 域名。Electron 的 `travelapp://app` 不是普通 HTTPS 域名，必须在发布前向高德确认并完成真实加载；未通过时保留 Leaflet/服务端静态图，不切换状态为 `passed_live_smoke`。

```bash
npm run diagnose:amap-js
```

### E4 专用账号 Worker

```dotenv
TRAVEL_AGENT_SOCIAL_WORKER_ENABLED=false
TRAVEL_AGENT_SOCIAL_WORKER_AUDIT_STATUS=not_run
TRAVEL_AGENT_SOCIAL_WORKER_TERMS_STATUS=not_reviewed
TRAVEL_AGENT_SOCIAL_WORKER_ACCOUNT_PROFILE=
TRAVEL_AGENT_SOCIAL_WORKER_SMOKE_STATUS=not_run
```

先运行 `npm run smoke:social-worker` 只能证明“无账号时不越界”。启用前仍需项目所有者：审阅小红书/抖音当前平台条款；建立不含个人资料的专用账号和独立浏览器 profile；对固定 SHA 候选完成静态审计；在受限网络、临时 Home、只读文件系统中完成真实只读 smoke。四项全部完成前保持 `false`，不得把 `AUTH_REQUIRED` 当作空搜索结果，也不得绕过 challenge。
