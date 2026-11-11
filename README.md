# zhuanshu Travel Agent

## 当前开发主线：OpenAI 旅行插件

当前在隔离分支推进 Java／PostgreSQL 服务与 Preact 插件工作台。请先阅读 [技术方案](wiki/current/17-openai-travel-architecture.md) 和 [开发与验收计划](wiki/current/18-openai-travel-development.md)。宿主适配、组件合同、构建和插件打包已接入新主线；照片手账、浮雕、目的地沉浸与共享交互已接线，设计稿见 [旅行决策与记录](design/2026-11-11-user-journey-review/README.md)；已接入逐项确认后的首次暂定采用与目的地天气跟进；完整已核验采用、其他跟进来源及真实宿主与来源验收仍未完成。

以下介绍和历史运行命令属于旧版本，不能作为新主线已经实现或验收的证明。新入口 `npm run mcp:build` 构建标准 MCP 与 OpenAI 两份页面，`npm run plugins:pack -- --origin=实际HTTPS地址` 生成 OpenAI 插件候选；配置和原生回调参数见开发计划。


一个从自然语言开始、面向真实旅行执行的 AI 旅行助手。

用户可以直接用文字、语音转写或图片描述旅行需求。Travel Agent 会持续理解目的地、日期、同行人、预算和体力限制，在同一份旅行状态上联合研究吃、住、行、玩，并把候选地点、地图、路线、来源和取舍说明放回同一个旅行工作台。

它首先服务来中国自由行、但不熟悉本地信息与执行方式的入境游客，也支持不想花大量时间做攻略的国内旅行者。

> 仓库不内置 API Key、平台账号、虚假地点或静态库存。数据源暂不可用时，产品会明确说明缺少什么，不会用假酒店、假地图或假票价填满页面。

## 一次旅行如何完成

1. **先说需求，不先填表。** Guest 用户可直接开始，例如：“10 月带父母从广州去大理 5 天，少走路，住得方便，想吃本地菜。”
2. **Agent 只追问会改变方案的信息。** 已经说过的日期、同行人和限制会持续保留。
3. **吃、住、行、玩一起规划。** 住宿位置、城际交通、每日动线、天气、预算和个人体力会互相约束，而不是四套彼此隔离的流程。
4. **用地图和证据帮助选择。** 候选会尽量展示真实图片、位置、路线、设施、来源与核验时间；“设施存在”不会被写成“当前正常运行”。
5. **用户确认后才修改行程。** Agent 先提出方案，用户接受后才写入正式计划。
6. **预订仍由用户完成。** 产品只准备官方或授权平台的跳转，不代替用户付款、购票、退改或提交证件。
7. **遇到变化只调整受影响部分。** 下雨、延误、闭店或换住宿时，已锁定且无关的安排会保留。

## 当前已经实现

| 能力 | 当前状态 |
| --- | --- |
| 对话式规划 | Guest 首次使用、多轮需求理解、会话恢复、旅行确认与局部调整已实现。 |
| 多模态 Agent | 图片与文字可进入同一个 Parent Agent 回合，并继续调用旅行工具；需要配置可用的 DeepSeek Vision 或 Kimi 凭据。 |
| 地图与当地路线 | 高德 Adapter 已覆盖中国 POI、坐标、照片、天气、静态地图和城市路线合同；真实结果取决于账号权限与 live smoke。 |
| 酒店与城际交通 | 飞猪 FlyAI、途牛只读 Adapter 已接入酒店、航班、火车和景点候选；价格与库存必须来自真实账号。 |
| 跨端 | Web/PWA、Capacitor iOS/Android、微信小程序、支付宝小程序和 stdio MCP 共用同一服务端旅行状态。 |
| 登录 | Google Web、微信 Web 扫码/小程序、支付宝 Web/小程序和 Apple Web 的服务端流程已实现；上线前必须由平台主体配置并完成真实回调。 |
| 持久化 | 本地开发使用原子 JSON；生产支持 PostgreSQL 与乐观并发检查。 |

代码已经接线不等于第三方服务已经授权。没有通过真实账号、真实网络和对应 smoke 的能力，会继续显示为待配置或不可用。

## 5 分钟本地运行

### 1. 准备环境

- Node.js `>=22.19.0`
- npm

```bash
git clone https://github.com/DESONGs/zhuanshu-travel-agent.git
cd zhuanshu-travel-agent
npm ci --ignore-scripts
cp .env.example env_travel.local
chmod 600 env_travel.local
npm run auth:setup
```

Windows PowerShell 使用：

```powershell
Copy-Item .env.example env_travel.local
```

`env_travel.local` 已被 Git 忽略。不要把它、RSA 私钥、平台 Secret 或运行数据提交到仓库。

### 2. 配置最小开发环境

在 `env_travel.local` 中至少填写：

```dotenv
NODE_ENV=development
PORT=8797
TRAVEL_AGENT_ALLOW_DEVELOPMENT_AUTH=true
TRAVEL_AGENT_DATA_DIR=runtime-data/trips
TRAVEL_AGENT_CORS_ORIGINS=http://127.0.0.1:5173

TRAVEL_AGENT_MODEL_PROVIDER=deepseek
TRAVEL_AGENT_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=你的服务端Key
TRAVEL_AGENT_DEEPSEEK_SMOKE_STATUS=not_run
```

本地开发登录只用于验证产品流程，不会冒充 Google、微信、支付宝或 Apple 账号。

### 3. 验证模型并启动

```bash
npm run smoke:models
npm run smoke:conversation
```

分别启动 API 和 Web：

```bash
npm run api
```

```bash
npm run web:dev
```

访问 [http://127.0.0.1:5173](http://127.0.0.1:5173)。没有配置模型或 Provider 时，用户输入仍会保存，但界面会明确显示相应能力不可用。

## 部署与人工配置

生产部署、PostgreSQL、HTTPS 反向代理、模型与地图、飞猪/途牛、Google/微信/支付宝/Apple 登录、原生应用和小程序的完整步骤统一维护在：

**[部署与配置指南](./wiki/current/09-account-configuration-guide.md)**

这份指南会明确区分：

- 代码已经完成的部分；
- 需要项目所有者申请的平台账号或商业授权；
- 必须人工填写的字段与回调地址；
- 每个渠道上线前必须完成的真实 smoke；
- 配置失败时用户会看到的诚实降级状态。

## 验证项目

```bash
npm run check
```

该命令会检查 TypeScript 核心合同、Runtime、HTTP、Agent、Provider、MCP、持久化、Web 生产构建及微信/支付宝小程序合同。

按需运行真实数据检查：

```bash
npm run auth:check
npm run smoke:models
npm run smoke:conversation
npm run diagnose:amap
npm run smoke:amap
npm run smoke:weather
npm run smoke:inventory
```

Fixture 通过只能证明接口合同正确，不能证明 Provider、账号或生产授权已经可用。

## 项目结构

```text
src/agent/                         Travel Parent Agent 与模型路由
src/http/                          Web、原生和小程序共用的 HTTP API 与登录
src/providers/                     高德、天气、飞猪、途牛等数据 Adapter
src/persistence/                   本地 JSON 与 PostgreSQL 持久化
src/web/                           React Web/PWA 产品界面
src/mcp/                           stdio MCP Server
travel-agent-pi-package/           Pi Runtime、TypeScript 合同与旅行核心
plugins/travel-agent/skills/       可复用旅行 Skills 的唯一来源
apps/miniapp/                      微信与支付宝原生小程序
wiki/current/                      当前产品、架构、部署与安全规范
wiki/research/                     调研、审计和历史决策
```

## 继续阅读

1. [Wiki 索引](./wiki/README.md)
2. [产品定义与用户体验](./wiki/current/01-product.md)
3. [Agent、上下文与决策架构](./wiki/current/02-agent-architecture.md)
4. [部署与配置指南](./wiki/current/09-account-configuration-guide.md)
5. [开发协作约定](./AGENTS.md) 与 [Travel Parent Agent 行为](./agent.md)

## 安全与产品边界

- API Key、Cookie、Token、证件、手机号和支付信息不得进入 Prompt、日志、artifact 或 Git。
- 社交平台只能通过独立受限 Worker 执行只读搜索、阅读和分享链接解析。
- 产品不自动购买、支付、退改签，也不执行社交发布、点赞、评论、收藏、关注或私信。
- 用户确认前，Agent 和 Skill 都不能直接修改正式旅行状态。

## 许可证

原创代码采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。许可证允许符合其定义的非商业使用、修改和分发；商业使用需要著作权人的单独书面授权。

这是带商业用途限制的 source-available 许可证，不是 OSI 认证的开源许可证。第三方组件继续适用各自许可证，来源和归属见 [NOTICE](./NOTICE)。
