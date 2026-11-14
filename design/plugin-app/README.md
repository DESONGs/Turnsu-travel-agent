# 旅行画布交互设计

本轮设计围绕“宿主持续对话＋动态画布”，复用正式产品的主方案、候选比较和旅行要求组件。设计情境中的京都酒店、价格与班次均为示例，不是可预订数据。

`npm run design:preview` 后打开 `/design/plugin-app/index.html`。可以比较住宿/交通、打开详情、预览修改、采用/撤销、编辑旅行要求、管理偏好以及创建/暂停/删除关注。

可直接审阅的状态：

| 路径参数 | 状态 |
| --- | --- |
| `?view=overview` | 四域主方案与每日安排 |
| `?view=compare` | 酒店完整条件比较；可切换交通等领域 |
| `?view=change` | 局部换酒店的整趟影响、保留项与核验缺口 |
| `?view=overview&dialog=requirements` | 日期、人数、预算与本次偏好 |
| `?view=preferences` | 开关、明确偏好、行为推测确认 |
| `?view=watches&dialog=watch` | 固定条件下创建酒店关注 |

[Figma 文件](https://www.figma.com/design/82SFdSrzhxPby3T44L8ZGx) 保留原有 14 个设计场景，本轮新增以下可编辑界面：主方案 `21:140`、比较 `22:140`、偏好 `23:140`、关注空状态 `24:140`、修改预览 `25:140`、390px 比较 `26:140`、旅行要求 `27:140`、关注创建 `28:140`。本轮导入为可编辑 frame/text 层；Figma 组件实例整理、变量绑定和原型连线受 use_figma 工具套餐额度限制，未完成。浏览器原型提供可操作交互，不能声称 Figma 已完成这些连线。

生产实现的截图与验收边界在 [交付记录](../../wiki/research/2026-11-11-plugin-app-implementation.md)。它使用真实 HTTP、DSH 和隔离 PostgreSQL，但旅行来源与模型响应明确受控。

`host-contract.html` 是明确标注的本地 MCP App 协议验证页面，使用开发登录和本地受控 API；不连接真实宿主。先运行 `npm run mcp:build`、受控 UI 服务与 8809 代理 Vite，再打开该页面。其内嵌/展开结果只用于协议与界面检查。
