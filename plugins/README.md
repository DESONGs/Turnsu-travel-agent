# Travel Agent 插件交付

旅行工具、共享账户和画布共用一个云端服务，宿主负责对话，旅行插件执行与展示。当前产品/安全边界见 [Plugin App 与 DSH](../wiki/current/17-plugin-app-and-dsh.md)。

| 包 | 使用方式 |
| --- | --- |
| `travel-agent-openai` | Codex / ChatGPT 插件声明、MCP OAuth 和同一 MCP App |
| `travel-agent-claude` | Claude 标准交互式 MCP App 优先；Artifact 需宿主真实连接器绑定 |
| `travel-agent-workbuddy` | WorkBuddy 官方 MCP + Skill Connector，需开放平台导入与审核 |
| `travel-agent-dsh` | DSH profile Bundle，使用官方 MCP client；个人 OAuth 凭据/续期与原生画布接入仍有缺口，见包内 README |
| `travel-agent` | 原有业务 Skills，继续由内部旅行 Agent 使用 |

先部署共享 HTTPS 旅行服务并登记宿主的实际 OAuth callback，再运行：

```bash
npm run mcp:build
npm run plugins:pack -- --origin=https://your-actual-service.example
```

输出在 `dist-plugins/`。用户购买、支付、自动退改、社交写操作不在这些插件的权限范围内。包内不含用户/provider 凭据。不要把 example.test 打包检查、协议用例或 HTML 下载当成真实宿主已经可用；本轮状态见[交付记录](../wiki/research/2026-11-11-plugin-app-implementation.md)。
