# DSH 云端最小基座审计

协议：`third-party-audit-v1`。审计对象是 npm `0.2.2-rc.1` 云端核心组合，Cordis `4.1.0`。上游研究固定源码为 `deepseek-ai/deepseek-harness@fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`；npm 未公布 gitHead，不能宣称发布产物与该 SHA 已完成逐字节映射。实际安装完整性由 package-lock.json 的 tarball integrity 固定。

维护状态：官方活跃维护的预发布版本，适配边界需合同和跨进程回归保护。Node 要求 >=24.9.0。

云端仅组合 Cordis、Agent/loop、Scope、Session/Projection/Persistence、LLM、SystemPrompt、Tools、Native Executor、Checkpoint Policy。无 Goal/Schedule、任意 Shell/FS、插件安装器、远程管理 API、本地附件服务。业务任务调度仍由旅行租约控制。

## 依赖与写面

静态安装使用临时目录、`--ignore-scripts`、未提供凭据；以下 22 包全部 MIT，无 preinstall/install/postinstall。完整 sdk-minimal 的依赖检查发现 PTY/本地子进程安装脚本及 LGPL/MPL 包，因此未纳入云端依赖。没有运行 Coding profile。

| 包 | 固定版本 | 许可 |
| --- | --- | --- |
| @deepseek-ai/cordis | 4.1.0 | MIT |
| @deepseek-ai/cosmokit | 1.9.0 | MIT |
| @deepseek-ai/dsh-agent | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-agent-loop | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-brand | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-llm | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-scope | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-session | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-session-checkpoint-policy | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-session-persistence | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-session-projection | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-system-prompt | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-timeout | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-tool-executor-native | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-tools | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-typert-protocol | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-user-approval | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-util-crypto | 0.2.2-rc.1 | MIT |
| @deepseek-ai/dsh-util-values | 0.2.2-rc.1 | MIT |
| @deepseek-ai/schemastery | 3.19.0 | MIT |
| @standard-schema/spec | 1.1.0 | MIT |
| zod | 4.4.3 | MIT |

Agent/Executor 只能执行旅行工具注册表；业务提交仍由旅行服务校验。新 PostgreSQL SessionPersistence 是唯一原生日志写面；图片原始字节仅在本次请求内，由模型桥直接传入，DSH 日志只保存文字。模型路由在服务内部持有凭据，不写入 Session。跨实例权限必须与 travel_runs 有效租约绑定，不能用 Cordis scope 代替用户鉴权。

## 验证

静态依赖检查已完成。无凭据、非 root、无网络、只读文件系统的 Docker import smoke 及真实原生 Agent/PG 故障测试结果以本轮交付验证记录为准；本审计文件不预先宣称通过。

### 原生上下文压缩补充审计

追加 `dsh-compaction-basic`、`dsh-token-meter` 同版本 `0.2.2-rc.1`。临时静态安装的 23 包均 MIT、无安装生命周期脚本；与既有核心组合重叠，项目实际新增 7 包。未挂载图片落盘、Shell、命令执行、Goal 或原生 Schedule。已在无网络、非 root、只读 Docker 容器通过这两个发布包的 import smoke。压缩调用仍走旅行模型适配和同一任务配额，当前旅行事实在每个步骤从业务服务重新读取。
