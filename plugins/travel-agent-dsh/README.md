# DSH 旅行 Plugin App

兼容官方 DSH `0.2.2-rc.1` 的 Web 宿主。安装后，从右侧边栏的「旅行画布」打开，点击「连接旅行账户」，在旅行服务页面登录并同意授权。画布展示行程、比较、修改、偏好和价格关注；用户对话继续使用 DSH。云端后台关注独立运行，不依赖个人 DSH 一直开着。

## 构建与安装

先部署共享旅行服务，配置生产登录和 HTTPS，并将 `/mcp` 代理至 MCP 服务、其余 API/OAuth 路径代理至旅行 API。然后在项目根目录运行：

```bash
npm ci --ignore-scripts
npm run mcp:build
npm run plugins:pack -- --origin=https://your-travel-service.example
```

生成的 `dist-plugins/dsh-turnsu-travel-agent-0.2.0.tgz` 包含原生后端适配器、浏览器侧栏模块和同一份旅行画布。`dist-dsh/`、`dist-mcp/` 与 `dist-plugins/` 都是可重建输出，不提交。

在已有 DSH Web profile 中安装：

```bash
dsh plugin --profile web add /absolute/path/to/dsh-turnsu-travel-agent-0.2.0.tgz --ignore-scripts
dsh --profile web --dump-config
dsh web
```

DSH 本身需按官方说明完成平台依赖安装，包括凭据与会话持久化所需的原生包。此插件不提供 DSH 模型账户。桌面 DSH 复用相同扩展接口，但本轮只验证官方 Web 宿主，未验收桌面安装包。

## 授权、接续与断开

- OAuth 使用动态客户端注册、PKCE、一次性 state 和 issuer 校验；用户不需要复制 token。
- 访问/刷新凭据保存在 DSH 凭据服务的私有 grant record。官方 MCP client 引用按服务地址生成的专用凭据名，插件自动刷新；画布 iframe 不接触凭据。该引用由插件管理，不要手工填写或设置同名环境变量。
- 原生右侧标签页承载 opaque iframe，没有 `allow-same-origin`；画布只能调用有限旅行操作。宿主接口沿用 DSH Connection 的 owner 校验，云端再校验当前旅行权限。
- 当前画布的旅行引用作为 `travel-canvas` 上下文进入同一宿主 Session，先从云端核对真实行程与 revision；上下文同步不会唤醒新对话。宿主 Session 由官方 SessionController 解析和恢复，不接管其子 Agent。
- 同一旅行服务在一份私有 DSH 凭据存储中连接一个账户。DSH profile 本身不隔离凭据；多人使用须分别设置 DSH_HOME 或独立凭据文件，并使用各自 OS 账户，不能共用 owner 登录。
- 「断开连接」立即使托管引用失效，并撤销云端连接。若撤销回执未知，界面保留「重试确认断开」；不报告假成功。卸载插件停止刷新并移除本次挂载；需要撤销授权时先断开。

DSH 本地凭据文件遵循宿主的 OS 用户权限；同一 OS 用户运行的 Shell 工具能够读取该文件，这是 DSH 的信任边界。不要将包含凭据的诊断、整个 profile 或授权链接上传。

## 远程 DSH

本机 Web DSH 默认使用临时 `127.0.0.1` 回调端口。存在远程受信任 authority 时，插件拒绝这一方式，要求在 profile 的 patch 中明确填写：

```yaml
- id: turnsu-travel-app
  config:
    origin: https://your-travel-service.example
    oauthCallbackUrl: https://your-dsh.example/travel-agent/oauth/callback
```

DSH 的 HTTPS 反向代理须保留该回调路径，并按官方规则配置 trusted host；旅行云端的 `TRAVEL_AGENT_MCP_REDIRECT_URIS` 须保留其他宿主地址，并添加这个精确 HTTPS 回调。此远程代理路径本轮仅完成拒绝/配置合同检查，尚未真实部署验收。

卸载：`dsh plugin --profile web remove dsh-turnsu-travel-agent`。

本轮验证了隔离官方 Web 宿主的授权同意页、回跳、侧栏、opaque 画布展开和同一云端行程读取；使用本地受控账号、旅行事实与模型响应，没有验收生产登录、真实供应商、真实宿主模型轮次或多宿主接力。详见[交付记录](../../wiki/research/2026-11-11-plugin-app-implementation.md)。

官方依据固定在 [Bundle 规范](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md)、[右侧标签页](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-sidebar-right/README.md)、[Connection](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/connection/README.md) 与 [MCP client](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client)。
