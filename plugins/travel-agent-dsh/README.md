# DSH 旅行插件 Bundle

固定兼容版本 0.2.2-rc.1；在已有 DSH profile 中启用官方 MCP client。公共旅行服务、后台关注和 PostgreSQL 不运行在用户的个人 DSH 进程中。

先部署共享服务并以 `npm run plugins:pack -- --origin=https://your-service.example` 生成替换地址后的包。在 DSH 的凭据提供方保存个人旅行服务 OAuth access token 为 `TRAVEL_AGENT_ACCESS_TOKEN`，不要把它写进 patch、技能、对话或仓库。未提供凭据时明确拒绝连接。当前 DSH MCP client 不代办旅行 OAuth 登录/续期；需要在服务端完成个人授权，过期后更新凭据。

安装：`dsh plugin --profile travel add /absolute/path/to/travel-agent-dsh`。核对：`dsh --profile travel --dump-config`。卸载：`dsh plugin --profile travel remove dsh-turnsu-travel-agent`。不要把含已展开凭据的运行诊断上传。

工具复用同一个 conversationId 与 requestId。DSH 原生 Web 画布挂载尚未验收；本 Bundle 提供 MCP 工具接入，不能把 HTML 资源下载等同于原生画布可用。CLI/工具结果保留可解释的状态。

依据：固定 SHA 的 [Bundle 规范](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/docs/user/develop/basic/publish.md) 与 [MCP client](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/mcp/mcp-client)。
