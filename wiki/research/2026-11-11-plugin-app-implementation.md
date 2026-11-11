# Plugin App 产品、界面与 DSH 实现记录

日期：2026-11-11。用户已授权完善设计、实施迭代并上传对应仓库。本文记录已实现和实测的结果；**没有部署生产，也没有把模拟来源或本地宿主协议验证算作真实平台验收**。

## 这次交付解决什么

原工作台中，完整草案可能只存在于任务结果中，重载后不直观；候选比较以地点/价格卡片为主，局部更换容易脱离已形成的完整计划。本轮增加四域主方案、条件比较、直接编辑旅行要求、保留其他站点的局部替换、核对后采用与最近一次修改撤销。桌面 Web 保留对话侧栏，嵌入宿主复用宿主对话。

同时接入跨旅行偏好、机酒同条件价格关注、站内消息、邮箱验证和邮件待发送记录。新云端任务切换到原生 DSH Agent，复用现有旅行业务内核、PostgreSQL、供应商和模型接入；会话与任务支持安全的跨实例接续。

实现规范见[当前约定](../current/17-plugin-app-and-dsh.md)，设计入口见[交互原型说明](../../design/plugin-app/README.md)，[Figma 核心界面](https://www.figma.com/design/82SFdSrzhxPby3T44L8ZGx?node-id=21-140)。原迭代计划、架构评估和验证设计保留需求及取舍，不再以其中旧的“尚未授权开发”描述代表当前状态。

本轮在独立工作树 `codex/plugin-app-dsh-20261111` 开发，基于 PR #5 的 `codex/continuous-planning-runtime`（`ecb6998`）。为保留当前项目能力，同时纳入当前工作区已有的 MCP/OAuth、全球来源/地图与部署基础；它们与独立 PR #6 部分重叠，合并前需协调。原工作目录和用户的 `AGENTS.md` 改动未纳入本轮提交。

## 能力与复用

| 结果 | 新增或改善 | 继续复用 |
| --- | --- | --- |
| 完整主方案 | 草案与已采用明确区分，刷新重建当前草案；修正切会话后草案被清空的问题 | TripState、已有 planning/draft/adopted 与行程投影 |
| 酒店/交通比较 | 房型、床型、早餐、退改、人数、站点、时刻、行李和未知条件；保留其他领域入口与全部候选 | 供应商 Evidence、候选、原详情页、地图 |
| 局部替换 | 只替换一个指定节点；同地点多次到访、其他时段与完整行程保留；锁定/已订项目拒绝替换 | `planItineraryTrial`、Mobility、预算、完整性/Checker、原提交门 |
| 采用和撤销 | 采用前看路线/预算；撤销仍需 revision 与内容一致，使用新 revision 恢复；稳定比较兼容 JSONB 字段排序 | 乐观并发、TripStore 与持久日志 |
| 偏好 | 主动开关、明确表达工具、编辑/删除、行为推测确认、当前旅行例外优先 | 原 Parent 工具和每步权威事实刷新 |
| 价格关注 | 完整条件校验、版本与租约、暂停/恢复/已订/删除/到期、同价去重、创建请求重试去重、失败保留最近有效报价 | 原只读供应商 research 与共享账户/Trip 权限 |
| 通知 | 站内消息、验证码验证地址、Resend 待发送/重试/未知结果停止重发；新报价核对后由用户打开供应商 | 原认证仓库事务与现有 Worker 进程 |
| DSH | 原生 Session/Loop/Tools/Executor/Projection/Compaction；PG 日志、writer epoch、业务操作回执 | 现有持久任务队列、Trip Runtime、模型预算和 Pi 模型接入库 |
| 插件 | OpenAI、Claude、WorkBuddy、DSH 包装和同一 MCP 操作合同；内嵌摘要与展开画布 | 共用 TravelService、OAuth、有限操作表和 React 画布 |

### 界面实测证据

以下均为受控样例，截图保留“受控样例”标记。没有为截图注入生产假报价或隐藏失败。

| 画面 | 证据 |
| --- | --- |
| 桌面主方案与持续对话 | [截图](./assets/2026-11-11-plugin-app/implementation/desktop-plan.png) |
| 酒店比较 | [截图](./assets/2026-11-11-plugin-app/implementation/hotel-comparison.png) |
| 局部修改核对 | [截图](./assets/2026-11-11-plugin-app/implementation/change-preview.png) |
| 390px 比较 | [截图](./assets/2026-11-11-plugin-app/implementation/mobile-comparison.png) |
| 偏好保存 | [截图](./assets/2026-11-11-plugin-app/implementation/preferences.png) |
| 主动核对最新报价 | [截图](./assets/2026-11-11-plugin-app/implementation/quote-recheck.png) |
| DSH 原生 Web 侧栏/展开 | [侧栏](./assets/2026-11-11-plugin-app/implementation/dsh-native-sidebar.png) · [展开](./assets/2026-11-11-plugin-app/implementation/dsh-native-canvas.png)；官方宿主，本地受控账号与旅行事实 |
| MCP 内嵌/展开 | [内嵌](./assets/2026-11-11-plugin-app/implementation/mcp-inline.png) · [展开](./assets/2026-11-11-plugin-app/implementation/mcp-expanded.png)；本地协议环境，非真实宿主 |

设计稿新增八个可编辑核心画面。Figma `use_figma` 套餐额度阻止了组件实例整理和原型连线；本轮通过可用的 DOM 导入通道新增 frame/text 层，并保留可点击浏览器原型。不能把设计中的京都示意地图当成正式产品底图。

## 已执行的验证

开发机 Node 26.7.0；本地专用 PostgreSQL 17，端口 55439、数据库 `travel_plugin`。各自动测试使用独立 schema 并清理；UI 样例使用单独 `travel_plugin_ui` schema。未加载生产凭据，未修改原工作目录中的未提交工作。

| 验证 | 观察到的结果与边界 |
| --- | --- |
| `npm run check` | 类型、桌面类型、项目回归、Web 构建、小程序合同通过。默认未配置 PG/live 环境的专用用例明确跳过；不是原生四端或供应商验收 |
| 原生 DSH 上游合同 | 固定源码 SHA 下的 persistence/live-write 两组原合同均通过；执行真正的 PG SessionPersistence 和 session/event → live buffer → DB 写入路径。首次测试曾只证明业务不重复，补足完整原生日志后才作此结论 |
| 两进程故障接管 | A 已提交业务但未返回工具结果时 SIGKILL；B 从原生 PG 会话恢复并核对回执，业务计数保持一次。过期持有者、迟到 close、同 fence 不同 run、只读句柄均被拒绝越权写入 |
| 业务/会话隐私 | 受控多模态输入能到模型；请求图片不进入会话 checkpoint。模型生成的敏感工具参数在写入原生日志前被阻止 |
| 局部更换/撤销 | 文件与真实 PG 两种存储分别验证草案/已采用方案；其他站点及时段不变，预览不采用，采用后可撤销，旧 revision 拒绝 |
| 偏好/关注/邮件 | opt-in、CAS、用户隔离、推测确认、报价条件变化、故障保留、同价去重、暂停/已订结束和邮箱验证、创建关注回执丢失后的同命令去重通过。邮件验证使用受控发送器，未真实发送邮件 |
| 两个关注 Worker | 同一关注仅一方取得租约；暂停使在途查询失去提交权；恢复后只产生一条站内消息，另一用户不可读 |
| DSH 应用组合/冷启动 | 真实 Cordis/DSH 应用启动 HTTP；两个实例可读同一 PG 偏好；`db:migrate` 在空 schema 创建所需业务/会话/通知表 |
| MCP/OAuth | 真实本地 MCP transport + HTTP 共享状态，越权被拒绝；OAuth scope、PKCE、刷新轮换、撤销及 issuer 标识通过。Codex DCR 的动态 loopback 端口仅放开已登记 IP、路径与查询相同的 callback |
| 浏览器操作 | 实际 Chromium 点击酒店比较→替换→核对→采用→刷新→撤销；回读所选节点恢复原值。偏好保存、关注创建/暂停/恢复/主动核对通过；1440px 与 390px 无横向溢出，当前路径无 JS 异常 |
| MCP App 界面 | 本地标准消息桥实际内嵌→fullscreen 展开，完整画布可读相同旅行，内嵌应用中无第二套聊天；不是 Codex/ChatGPT/Claude/WorkBuddy 原生通过 |
| 依赖/打包 | [DSH 审计](./audits/2026-11-11-dsh-third-party-audit-v1.md)；无凭据、非 root、无网络、只读 Docker import smoke 通过。MCP bundle、四类宿主 zip 与 DSH tgz 构建通过，打包使用 example.test 地址，未发布市场 |

网页包存在原有大型地图/Three.js chunk 警告；未以修改警告阈值隐藏。当前 UI 检查不证明首屏性能、真实供应商价格质量或多用户商用容量。

## DSH 原生宿主补充验证

本地原型继续作为设计交付，Figma 额度不阻塞开发。DSH 个人插件现已包含后端授权适配器、原生浏览器模块与共用画布，包中不再只有 MCP 配置。

验证使用官方 npm DSH `0.2.2-rc.1`、独立临时 profile、官方 Web 前端和浏览器真实操作。云端采用既有 HTTP/DSH/PostgreSQL 受控样例；本地开发账号替代生产身份提供方，没有调用真实旅行来源或宿主模型。实际走完 OAuth 同意页表单、回跳及 PKCE 换取凭据后，原生侧栏加载四域摘要，展开读取同一行程并打开候选比较，画布没有第二套聊天。内嵌按钮能请求宿主展开；断开后 iframe 移除，同一工具请求被云端授权适配器拒绝。opaque iframe 的 localStorage 被浏览器拒绝，界面仍正常工作。

原生验证发现并修复了三类合同测试未覆盖的问题：自定义接口必须与 DSH Gateway 并存；OAuth 同意表单的 CSP 必须允许已登记回调的 authority；原生会话需通过官方 SessionController 恢复。画布上下文以非用户请求的 `travel-canvas` 来源保存，不唤醒 Agent。授权取消/保存、断开/刷新、卸载/令牌轮换的竞态另有可重复回归，原生试验曾缺少官方平台持久化可选包，补齐后保存通过。

宿主入口是 owner-only 的 Connection exact Fetch route，不能替换 `/api` 的共享 interceptor。画布只通过消息桥发送有限操作，凭据不进入 iframe、模型上下文或旅行状态。远程部署必须配置精确 HTTPS 回调及云端 allowlist；未配置时明确拒绝，本轮未部署该路径。

最新 `npm run check` 通过类型、项目回归、构建与小程序合同（专用 PG/live 环境用例仍明确跳过）；MCP 和原生 DSH bundle、四类 zip/DSH tgz 打包通过。DSH 宿主/OAuth 聚焦测试还覆盖了完整 HTTP 同意表单与回调源 CSP、跨来源拒绝、冷会话解析和上下文不唤醒。原生 Web 的受控通过不代表其他宿主、供应商或生产邮件已验收。

## 宿主研究后的实际交付结论

| 宿主 | 仓库中的交付 | 尚未完成的真实条件 |
| --- | --- | --- |
| Codex / ChatGPT | OpenAI 插件声明、标准 MCP App、OAuth、共享画布、内嵌/展开 | 公共 HTTPS、真实账号授权、宿主安装、权限与跨宿主继续旅行 |
| Claude | 同一 MCP App 优先；额外保留显式 Artifact connector 合同 | 真实消费端 interactive connector、CSP 和权限验收；不能臆造 Artifact 连接器 API |
| WorkBuddy | 官方 MCP + Skill Connector 元信息、配置、图标与包 | 实际开放平台导入/审核、OAuth 回调登记、客户端 MCP Apps 呈现 |
| DSH 云端 | 真正原生 Agent、共用后端与 PG 会话恢复 | 真实模型、真实来源、生产负载与运行环境验收 |
| DSH 个人宿主 | 原生侧栏/展开画布、一键 OAuth/PKCE、私有凭据续期、官方 MCP client、原生 Session 上下文；隔离官方 Web 宿主受控验证 | 生产登录/来源、真实宿主模型轮次、远程 HTTPS 回调、桌面安装和跨宿主接力 |

官方依据更新于本轮：[OpenAI 插件认证](https://developers.openai.com/plugins/build/auth)、[Codex OAuth 注册](https://learn.chatgpt.com/docs/extend/mcp#oauth-client-registration)、[Claude 交互式连接器](https://support.claude.com/en/articles/13454812-use-interactive-connectors-in-claude)、[WorkBuddy Connector](https://open.workbuddy.cn/docs/connector)、[Buddy 应用](https://open.workbuddy.cn/docs/buddy-app)、[固定 SHA 的 DSH Bundle 规范](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md)。资料建立接入依据，不能证明本产品已经通过这些宿主。

## 运行与部署附录

### 本地与构建

```bash
npm ci --ignore-scripts
npm run check
npm run mcp:build
npm run plugins:pack -- --origin=https://your-actual-public-origin.example
npm run design:preview
```

`dist-mcp/` 与 `dist-plugins/` 可重建、不入库。打包不发布 npm/市场，不会部署服务器。不要将 `travel.example.test` 的本轮检查包当成可访问服务。

### 云端配置与迁移

1. 使用 Node ≥24.9.0，备份 PostgreSQL、现有运行配置和照片持久卷。沿用 `.env.example` 中的认证、模型和来源参数；不把凭据放入插件包。
2. 设置 `DATABASE_URL`、规范的 HTTPS `TRAVEL_AGENT_PUBLIC_ORIGIN`、明确的 `TRAVEL_AGENT_CORS_ORIGINS`。生产登录仍需平台真实回调；开发登录不得用于生产。
3. API/Worker 多实例设置 `TRAVEL_AGENT_WORKFLOW_EXECUTION_MODE=postgres_run`，配置实际账号模型限额 `TRAVEL_AGENT_MODEL_LIMITS`。`compose.hosted.yaml` 显式设置此模式，配合原 `compose.yaml` 使用；云端没有开着的宿主也可检查关注。
4. 运行 `npm run db:migrate`，新增 DSH 会话/事件、操作回执、偏好、关注、站内消息、邮箱验证、待发送和 OAuth 记录等表。不转换原始 Pi 隐藏过程，不删除原 Trip。
5. 分别启动 `npm run api`、`npm run worker`、`npm run mcp:serve`，反向代理 `/mcp` 到 MCP 服务，其余旅行/认证路由到 API。使用 [示例代理](../../deploy/travel-agent.conf) 时替换真实域名和证书。
6. 邮件可选配置 `TRAVEL_NOTIFICATION_EMAIL_KEY` 与 `TRAVEL_NOTIFICATION_EMAIL_FROM`，先完成 Resend 发信域名验证，再实际验证接收地址。未配置时明确显示邮件未开通，站内提醒继续可用。未知投递不换键重发；提供方去重窗口依据 [Resend 官方说明](https://resend.com/changelog/idempotency-keys)。
7. 每个宿主登记实际 OAuth callback。默认包含 ChatGPT 稳定回调、Claude 回调与 Codex `http://127.0.0.1/callback`；最后一项按 RFC 8252 只允许端口变化。其他路径、localhost 别名、查询变化或 WorkBuddy callback 必须明确登记，不开放任意域名。
8. 最后再执行真实宿主安装、真实模型/来源的黄金路径、邮件及跨实例恢复验收。生产公共服务当前没有部署。

### 恢复与回退

先停止接收新任务并排空/终止在途任务，再切换版本。业务表采用加法迁移，原 Trip 与已采用结果保留。新 DSH 日志不能交给 Pi 直接恢复；图片丢失时需重新附图，未知外部效果先核对真实回执。旧版本可能不认识新状态字段，不能在未做兼容验证时直接降级并继续写入；优先使用兼容业务格式的修复版本。确需数据回退时先在备份副本验证转换，不自动删表或覆盖用户新数据。

### 重现专用验证

专用 PG 测试只接受本地 55439 的 `travel_plugin`，避免误连现有用户数据库。先创建隔离测试容器并自行提供其凭据，再设置 `TRAVEL_TEST_DATABASE_URL`。

```bash
node --import tsx --test tests/dsh-cloud.test.mjs tests/dsh-recovery.test.mjs tests/continuity-postgres.test.mjs tests/local-choice.test.mjs
npm run test:dsh:upstream
```

上游合同 runner 下载固定 SHA 并核验哈希，在临时目录按独立 lockfile `npm ci --ignore-scripts` 运行。网络不可用时可用 `TRAVEL_DSH_CONTRACT_SOURCE_DIR` 指向原始合同文件，仍须通过哈希校验。本轮直接下载遇到超时，使用此前取得并匹配哈希的原文件运行通过；没有跳过合同检查。

UI 受控服务：`node --import tsx scripts/smoke-plugin-app.mjs`，随后以 8809 为 API 代理启动 Vite。该脚本明确使用受控模型/来源和独立 schema，不能连生产、不能用其输出宣称实时机酒接通。
