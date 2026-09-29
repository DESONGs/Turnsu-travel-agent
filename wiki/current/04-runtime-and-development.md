# Pi Runtime 迁移与开发计划

## 当前开发入口（2026-09-22）

本次开发依据为 [14 持续规划业务模型](./14-continuous-planning-business-model.md)、[15 上下文与模型交接](./15-model-context-and-handoff.md)和[主线程交接](../research/2026-09-22-continuous-planning-redesign-handoff.md)。**规范已更新，代码/迁移/验收尚待实施。**

先建立失败行为回归，再把持久计划、每轮上下文、局部变更、核验和视图沿同一调整路径接通；随后完成 Jev 问题交接、跨端/压缩/Worker 恢复及数据迁移。沿用原生 Pi 与现有 execution repository，进程内 Coordinator 不再独占规划去重和修复额度。下文旧实现记录不是本次完整验收依据，原期限、取消、fence、配额及权限保护继续保留。

## 已迁移的控制面

本项目以参考项目 `DESONGs/assignment-agent` 的固定提交 `0602f134f65052f7617d417a221f7d31d29746ef` 为模式来源，锁定 Pi `0.85.1`、`pi-subagents@0.46.0`、`@quintinshaw/pi-dynamic-workflows@3.5.1`。Web Parent 与业务 Child 使用原生 Pi `AgentSession`，既有 Child fan-out 复用 Dynamic Workflow library；Jev 是可选的有界判断适配器。外部 Pi package 使用 `pi-subagents`，不向同一 Parent 暴露两套编排入口。会议领域代码没有复制。

### 持久等待与接续（2026-09-21）

原 execution repository 增加 `not_before`、`expires_at`、`wait_reason`、`continuation_json` 和队列类别。首次入队确定四分钟总期限，额度等待或 Worker 接续不会重置；旧的“排队 30 秒失败”和“等模型额度 10 秒失败”已移除。达到期限仍保留已提交的事实和草案，但该任务停止。

配额不足返回非终态 `queued` 并释放 Worker；完整的工具延后回执先进入原生检查点，再保存续执行步骤。恢复使用 `travel-operation-result` / `travel-resume` 原生自定义消息，只继续未完成步骤。原始要求保持顺序，已完成读取按依赖和时效复用；取消、租约与 fence 继续限制迟到写入。结果不明的业务写入和请求内图片不自动重放。硬崩溃后的通用写入恢复仍保留保守中断边界。

Jev 配额以 PostgreSQL 数据库时间和账号原子预留执行：正常 1,080 RPM、重试 60 RPM、60 次余量，任意滚动 60 秒总计不超过 1,200；同时检查输入 TPS、输入预算、在途数与同一 Trip 单在途。首次请求按 56 ms 间隔平滑，重试至少 1 s 间隔；429/503/529 形成账号冷却，每批最多重试一次。队列按用户公平、短交互/续算 2:1、空闲互借、等待提升优先级。

新增业务规则置于严格 TypeScript `src/host/`、`src/core/` 与 Runtime；HTTP、Pi 对话编排与持久化适配仍为 JavaScript。验证入口见[配置指南](./09-account-configuration-guide.md#jev-接入与验收2026-09-21)。

用户验收后的容量修正：Parent/Child 的已完成调用有真实 usage 时，用实际输入／输出量替换未用完的预留；结果不明仍保留原预留。RPM/TPM 不足按数据库时间返回实际窗口释放时间，持久 `queued` 后释放 Worker；在途数占满仍短间隔重试。单次输入大于账户 TPM 上限明确拒绝，不无限排队。这不提高账户配额，Jev 的 1,200 RPM 上限不变。原生 Pi 会话上下文上限为 65,536、输出上限 8,192，压缩预留与保留近期消息仍有界。

业务返工补充：新请求继承的原生消息超过 32,768 UTF-8 字节、且存在可安全摘要的前缀时，先调用 Pi `session.compact()`，避免把整份旧研究和试排在新规划的每一轮反复发送。这个值是摘要触发点，不是裁剪长度；原工具记录留在原运行检查点，近期完整工具对和摘要继续参与对话，事实每次从 TripState 加载。压缩仍计入同一账号及运行预算。`hasPrompt` 只有新输入实际进入 Pi 才为真，压缩等待恢复后必须继续处理该输入；已执行任务仍按原检查点和续执行信息恢复。

同一请求内也沿用 Pi 原生工具轮间 compaction：`reserveTokens=32768`、`keepRecentTokens=4096`，在 65,536 上下文窗口约过半时预留后续研究、修复和交付空间；它不增加账号配额或运行 token 预算。发送模型前，同一 Trip 的重复状态快照只保留最新完整内容，旧快照替换为带版本和后继工具调用 ID 的回执；用户原话、不同领域的研究结果、错误和延后回执不按此规则合并。原生检查点保留原回执。原生轮间摘要、配额等待恢复和当前状态投影分别有回归证据。

真实 PostgreSQL 验证必须覆盖 JSONB 往返：仅改预算不得使同行人或路线失效。通过 `isDeepStrictEqual` 按值比较同行人，避免对序列化字符串比较造成虚假变化。最新红转绿证据、Worker 进程恢复与整体验证见[验收修复报告](../research/2026-09-21-traveler-acceptance-fixes.md)。

业务返工验证不能仅断言状态为 `completed`／`trial_ready`：检查受托日期、餐次、住宿、领域、逐次到访路线、真实金额和实际数据库写入。Parent 必须收到核验结果并保留自己的业务解释；对话回归另检查通用“请你选择合适候选”不会被误判为采用授权。紧凑规划参数的 `startAt + durationMinutes` 与显式 `endAt` 使用相同餐次核验，不能因省略冗余字段漏检。当前证据及保留的失败轮次见[业务闭环返工](../research/2026-09-21-traveler-business-rework.md)。

参数错误与业务修复分开：引用不存在的节点、来源、锁定或固定锚点，在严格 TypeScript 校验阶段退回参数和可用引用，不调用路线来源、不占用 attempt，也不登记一次已完成修复；纠正后可重试同一个 attempt。两次有效核验的上限不变。补查后的新状态读取不再被“同参数两次”提前终止；重复写入、两次研究与一次修复仍受控，达到总工具预算明确返回未完成，不能回退成研究成功。

候选证据更新导致预览过期时，原草案时间线继续可见、采用凭据撤销，旧路线与金额不再作为当前核验结果。过期预览与通过预览使用同一仓库，没有新增草案状态源。

`travel-agent-pi-package/` 的旅行专属 Runtime 已实现，并采用核心 TypeScript、外围 JavaScript 的明确边界：

- `src/contracts/*.ts`：TypeBox Schema 与 `Static` 类型的单一合同源，覆盖 Trip State、Traveler、Decision/Evidence、Patch、Context、QA、Mobility、Transit 和 ProviderResult；构建时派生 JSON Schema。
- `src/core/`：严格 TypeScript 的 TripStore、TravelService/Persistence 接口，以及经过 Runtime Schema 校验的 Trip Runtime 公共入口。
- `src/runtime/trip-runtime-implementation.ts`：Trip State、Decision Graph、dirty set、Context Pack、Patch validate/commit 与旅行 QA 的 TypeScript 实现；动态 Provider/持久化 JSON 只在这一内部归一化边界进入，公共返回值继续经过 TypeBox 校验。
- `src/mcp/`、`src/providers/`、`src/pi/`：MCP 权限合同、ProviderResult discriminated union 和不含 `Type.Any` 的核心 Pi tools。
- `extensions/`：Pi package 只默认加载动态 Capability Status、当前模型路由、TravelService 业务接口和 `pi-subagents`。Planner、Policy、Observability、Social Worker 与低层 State/Patch/QA Extension 包装已经移除；对应强制逻辑继续由 Pi Hook、TravelService 和核心 Runtime 持有。
- `plugins/travel-agent/skills/`：Parent/Child 实际加载 `understand-trip`、`research-trip`、`plan-trip`、`recover-trip` 四个组合入口；原有微 Skill 内容保留为 references。
- `runtime/`：Capability Registry 只存能力说明和安全要求；动态 Provider 状态从当前运行配置派生。静态模型路由 JSON 已移除。

未迁移：ASR、会议 intelligence、标题/segment、飞书评论与文档、Rokid、Office lifecycle 和旧 agent-team fallback。

## 实施状态

1. **已完成：旅行内核。** 可创建共享状态、关联四域、构建 Context Pack、stage/accept/reject Patch、处理锁定和新鲜度，并局部重排。
2. **已完成：持久化、Chat-first 入口与 Pi 对话控制链。** 生产使用 PostgreSQL 的 JSONB snapshot 与乐观 storage version；本地开发可显式采用单目录原子 JSON repository。`travel-conversation-v1` 持久化对话归属与可见短消息，Pi `Agent` 只可调用受限的 Parent Agent 工具；`TravelService` 仍是唯一旅行状态入口。
3. **已实现：对话到待确认方案的控制链。** Parent Agent 用完整对话理解短句，目的地明确即保存，后续信息增量合并；按用户本次目标研究对应领域，完整规划继续四域联动。缺少出发地不阻塞目的地内研究。外部结果被归一为候选与待确认提案；支持逐域比较，也支持完整行程中的同域多个候选，接受后才写入已确认旅行。
4. **已实现、待真实账号验收：高德地点 Adapter。** 固定官方端点检索四域，返回核验时间、POI、照片、地址、评分/参考消费、位置、服务端静态地图与高德跳转；支持可选数字签名，不接受任意 URL，不把 Key 或私钥放入前端、状态或输出。真实地点链是否可用由配置后的 live smoke 与聊天黄金路径共同证明。
5. **已实现：天气由 Runtime Environment Gate 强制贯穿旅行控制链。** 高德天气和 Open-Meteo 开发回退均归一为 `trip-weather-v1`；目的地或日期变化会先使旧天气失效，研究入口确定性查询并把预报放入 Environment Plane、Context Pack、四域候选评估、方案画布和 QA。天气失败时提案明确降为暂定；预报变化会使旧提案失效并局部重排；超出预报窗口时不编造未来天气。`assess-trip-weather` 只做语义影响评估，不拥有抓取或新鲜度。
6. **已实现并通过当前账号真实 smoke：城市移动由 Runtime Mobility Gate 强制贯穿确认后链路。** 高德路径规划 2.0 的步行、公交/地铁和驾车结果归一为 `trip-mobility-v1`，进入 Environment Plane、Context Pack、QA、静态路线图和前端路线卡；步行 `walk_type` 继续贯通为直梯、扶梯、阶梯和斜坡参考，并参与逐人避开台阶约束。地点或范围变化使旧路线失效。公交计划结果固定标记为非实时到站，驾车结果只作为打车时间/费用估算，路线设施也固定标记为非实时。2026-08-26 的 POI、天气、三类路线与折线地图 smoke 已通过；这不替代浏览器组合链验收。
7. **已验证：DeepSeek 基础认证与无地点资料时的诚实失败。** 父 Agent 的 Prompt、工具或模型版本改变后，必须重新运行多轮自然语言轨迹，并在真实浏览器桌面与移动视口复核。自动化测试只证明合同，不能替代这项验收。
8. **已实现：逐人旅行关怀进入共享状态与 QA。** 对话工具把具体同行人的步行、换乘、台阶、休息、时间、设施、感官与饮食要求绑定到稳定 ID；路线 Adapter 只读取具名 Traveler 约束，不再从整团描述猜测归属。明确阶梯与避开台阶要求冲突时 QA 拒绝，直梯或斜坡存在则作为非实时部分证据；变化时只使旧城市路线失效。方案画布回显预算、节奏与逐人要求，设施或连续无障碍证据缺失时保持待核验。
9. **已完成：跨平台源码运行边界。** API、MCP、测试和 Pi package 直接加载 TypeScript 源码，不依赖未提交的 `dist/`；文件名、ENV 权限检查和 npm scripts 不依赖单一平台的路径或 Shell 语法。Windows、macOS 和 Linux 使用同一组 `npm ci --ignore-scripts`、`npm run check` 与启动命令。npm package 保持 `private`，发布工作延期到公共 API 与完整分发内容稳定后。
10. **已实现：V2 匿名旅行与准备状态。** Guest 会话复用现有 Conversation、TripState、TripStore 和成员权限，登录后把临时旅行与对话转移到账号，旧 Guest 失去访问权。Readiness 写入 TripState 的独立版本，不增加 Trip revision，也不使无关待确认提案失效；父 Agent 只在用户明确确认或求助时更新，不收集证件、支付或账号内容。
11. **已实现：V2 第一结果与 Today 读模型。** `get_trip_plan_view` 从同一 TripState 派生准备清单、当前/下一步、移动段、新鲜度和待处理项；没有可靠时间时返回 `needs_schedule`，不冒充按天日程。Web 已将地图路线骨架前置，详细候选按需展开；移动端 Map 入口承担 Today 和变化恢复。
12. **待外部授权或后续实现：更深 Provider 与执行事件。** 社交 Worker、实时公交到站、站内设施、生产天气授权、生产登录、更深库存、Guest 过期物理清理，以及“已完成/跳过/现场确认”的执行事件持久化必须完成真实实现和 smoke 后才能启用。
13. **已实现：组合 Skills 与一次有界并行语义分析。** Provider 先完成一次确定性并行取数；复杂结果再由 `travel-analysis-fanout` 对同一批归一化证据运行最多三条不同 lane。Web 使用 Dynamic Workflow library；Pi package 提供三个只读 package child agent。默认并发 2、Child 45 秒、总轮 90 秒；单一 required lane 也真实执行。Lane 失败保留其他结果，只有 Parent 生成一份待确认 Proposal，Provider 调用数不随 lane 数增长。
14. **已实现：并行状态一致性与部署门。** Run/lane 绑定 revision、criteria fingerprint、attempt 与起止时间；Join 前重读当前状态，旧结果 `stale_discarded`；completion、Join 和 Proposal 幂等。Agent/API/UI 共用覆盖对象，partial 不冒充完整。模型 fallback 受专用 Child smoke ledger 约束。进程内 coordinator 只支持 `single_process`；多 worker 无 coordinator 时关闭语义 fan-out，并在健康检查中公开不支持跨实例 resume/steer。

## 类型迁移边界

本轮不通过机械改名提高语言占比。严格 TypeScript 覆盖合同、Trip Runtime 实现与公共校验边界、文件 Persistence、Mobility/Transit、MCP 权限、TravelService Port 和核心 Pi 注册；HTTP、Auth、TravelService 实现、具体 Provider、对话 Agent 与 Web 继续使用 JavaScript。它们直接导入源码合同并由 `tsx` 加载，不通过 npm 包名绕到 `dist/`。读取旧 `trip-control-state-v1` 时只补齐确实缺失的新增字段；已有字段类型错误会拒绝加载，不能静默替换为数组或空对象。

## 验收情景

- 国内情侣五日旅行：四域完整并进行预算取舍。
- 入境游客城市旅行：英文交互、外宾住宿、证件、手机、支付和导航限制可见。
- 亲子/长辈小团体：个人偏好独立保存，能够折中、轮换或分组。
- 人文关怀：父亲单段步行不超过 800 米、少换乘的要求绑定到本人；预算与节奏在方案摘要可见；无障碍设施没有来源时明确待核验。
- 长尾美食旅行：社交与地图结果完成实体归一、去重和营业核验。
- 低剧透自然旅行：可先不看图片选择，再展开证据。
- 航延、下雨、闭店、换住宿：只重排影响邻域。
- 城市移动：住宿、活动和餐饮地点确认后自动生成步行/公交地铁/打车比较；地点变化使旧路线失效，超出同行人步行或换乘限制时不能通过 QA。
- 路线语义：公交计划路线不能显示为实时到站，驾车估算不能显示为即时叫车供给；历史 `10044` 可保留为诊断证据，但当前账号状态以最新 live smoke 为准。
- 高度雷同/相互抹黑的来源：不能形成虚假多数。
- 覆盖广州/上海、大理或西双版纳、北京和一个未专项调优目的地。

## V2 后续开发顺序

1. **自然局部确认路径已通过：** 结构化 Research Criteria、逐域 fingerprint、Provider 角色融合、局部失效/重基、user-confirmed arrival 和 stay-only commit 已进入 Parent Agent 确定性控制。HTTP 等价测试与 Safari Computer Use 均证明其他领域保留、arrival → stay 路线和文案/TripState 一致；脚本 Service smoke 继续只作为较低层证据。
2. 建立地点英文别名、地址转写和 Provider 文本双语归一；核心英文界面已经可操作，但原始中文地点与长描述仍不能作为“完整英文产品”验收证据。
3. 实现受限的分享链接读取器；只接受允许的 `http/https`、域名策略、响应上限和纯内容提取，不把任意页面脚本或指令交给 Agent。
4. 先在现有 Decision Node 上生成有来源依据的日期/时间窗，并让 Today 按它排序；只有现有状态无法表达执行事件时再增加最小持久化合同。未知时间继续显示开放决定，不能伪造精确日程。
5. 候选阶段使用坐标与有界距离矩阵过滤明显折返，只对待确认组合调用详细路线，避免候选数增长导致路线调用爆炸。
6. 完成 Google/微信/支付宝/Apple 真实授权、Guest 物理清理与多端设备 QA；小程序和原生端继续复用同一服务端状态与 Mobility Observation，不复制提交逻辑。
