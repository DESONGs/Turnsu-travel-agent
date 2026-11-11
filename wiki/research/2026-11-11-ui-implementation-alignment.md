# 旅行 UI 两条实现的同步说明（迁移前基准）

**更新：两条界面现已统一到 PR #7 的 React／DSH 主线，当前状态以[统一实现记录](./2026-11-11-unified-turnsu-workbench.md)为准。下文保留迁移前差异，用于追溯，不能作为当前缺口清单。**

日期：2026-11-11。本文核对两个已提交版本，帮助继续开发时找到真正接入的界面及服务。**两条 PR 尚未合并；新版记录与共享尚未接入新的主旅行画布。** 本次只同步实现事实和迁移边界，没有合并两套后端，也不代表生产或真实宿主验收。

## 哪些已经实现

| 用户操作 | [PR #6：OpenAI 工作台](https://github.com/DESONGs/Turnsu-travel-agent/pull/6) | [PR #7：Plugin App 旅行画布](https://github.com/DESONGs/Turnsu-travel-agent/pull/7) |
| --- | --- | --- |
| 查看主方案、比较酒店或交通、预览局部修改、采用后撤销 | 六个核心规划画面仍是可点击设计稿；正式界面只有此前的基础草案和采用入口 | 已有 React 主方案、条件比较、路线预览、局部替换、采用和撤销；本地受控验证见交付记录 |
| 从一天、一次到访或手账直接新建 | 已接入；允许纯文字，日期、地点和照片可后补；保存后可编辑、照片可排序 | 当前仍调用旧手账：新建需要地点，服务要求至少一张照片，已有记录不支持原位编辑 |
| 保存已存照片的浮雕效果 | 本机预览；明确点击“保存效果”，写入同一稳定照片标识；源图片不变，未保存离开提醒 | 复用旧浮雕预览；新照片参数随新记录保存，已有照片的调整只用于本次查看 |
| 目的地沉浸 | 已接入章节、热点、切地点、导览、视角控制及返回原旅行 | 已有旧目的地体验与三维渲染器；尚未迁入 PR #6 的完整侧层交互 |
| 给指定 Google 账号共享 | 已接入查找、核对对象与影响、查看/编辑、修改权限、撤销；媒体沿用相同权限 | 本次核对未见 PR #6 的完整共享面板和账号查找链接入主画布；现有成员校验不能代替这些操作 |

PR #7 的主画布不等于 PR #6 六个规划设计场景已全部迁入。例如，“先比较两三条整趟方向”和“到访旁逐项确认未知条件”仍需逐条核对，不能以主方案、比较或采用按钮存在就判定完成。

## 继续接入时保留哪些行为

主画布接入以目标分支的现行约定为依据，记录、沉浸和共享复用已经确认的操作方式；不重新退回依赖候选或必须有照片的手账。桌面侧层与手机全高层均需能保存、重开、返回原位置，并在冲突或保存结果未知时保留编辑。

迁移还必须保留以下数据行为：

- 记录有独立版本，照片有稳定标识；重新排序不改变照片身份。旧版照片使用数组序号，不能直接把序号当作新版稳定标识。
- 保存结果未知时先按原请求核对或恢复，不能换请求标识重建；撤权后恢复回执也不能绕过当前权限。
- 逐项确认按账号保存在同一云端旅行；依据未变的确认保留，只让实际受影响的项重新确认。采用暂定行程后持续显示未核验缺口。
- 查看者不能编辑或删除，编辑者不能管理共享。邮箱、备注及私密照片只送到经授权的应用展示路径；不能直接塞入宿主模型上下文。
- 浮雕只保存参数，源照片保持不变；沉浸场景不能被当作实景扫描、导航或实时旅行事实。

两条分支的提交入口不同：PR #6 使用 Java 领域服务，PR #7 使用 TypeScript 旅行内核和 DSH 执行链。接入必须落到目标分支的唯一旅行提交入口，同时校验权限、版本、重复请求及迟到结果；不能把两个服务并列挂接后声称“共享同一旅行”。

## 开发者从哪里继续

以下链接固定到核对时的提交，避免后来分支变动掩盖差异。

| 对象 | 代码及证据 |
| --- | --- |
| PR #6 基准 | `5fd562402866107eb7ff3ba863106e49933a6c61`；[开发与验收状态](https://github.com/DESONGs/Turnsu-travel-agent/blob/5fd562402866107eb7ff3ba863106e49933a6c61/wiki/current/18-openai-travel-development.md) |
| 新记录、浮雕、沉浸和共享 | [Preact 工作台源码](https://github.com/DESONGs/Turnsu-travel-agent/tree/5fd562402866107eb7ff3ba863106e49933a6c61/plugins/travel-agent-openai/workbench/src)：`JournalPanel.jsx`、`PhotoRelief.jsx`、`DestinationExperience.jsx`、`SharingPanel.jsx`、`Sheet.jsx` 与宿主桥接 |
| 对应持久化与权限 | [Java 领域服务](https://github.com/DESONGs/Turnsu-travel-agent/tree/5fd562402866107eb7ff3ba863106e49933a6c61/services/travel-service/src/main/java/app/travelagent/core) 中 `TravelJournal.java`、`TravelSharing.java`；V16 确认进度与 V17 记录迁移 |
| 十场景设计及桌面/手机截图 | [设计与交互说明](https://github.com/DESONGs/Turnsu-travel-agent/blob/5fd562402866107eb7ff3ba863106e49933a6c61/design/2026-11-11-user-journey-review/README.md) |
| PR #7 基准 | `e5427ed85cbcdc5f7e711109ba1e0a7eabc199be`；[现行约定](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/wiki/current/17-plugin-app-and-dsh.md)、[实现与验证记录](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/wiki/research/2026-11-11-plugin-app-implementation.md) |
| 画布接入位置 | [React 页面](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/src/web/travel-app.jsx) 的 `PlanCanvas`、`PlaceDetailSheet`、`LazyTravelPhotoJournal`；[主方案与比较组件](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/src/web/decision-workspace.jsx) |
| 需要替换或适配的旧记录合同 | [旧手账组件](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/src/web/travel-photo-journal.jsx)、[HTTP 校验与权限](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/src/http/travel-journal.mjs)、[记录仓库](https://github.com/DESONGs/Turnsu-travel-agent/blob/e5427ed85cbcdc5f7e711109ba1e0a7eabc199be/src/persistence/travel-journal-repository.mjs) |

Preact 组件不能直接当作 React 组件导入。可复用已确认的界面结构、状态恢复逻辑和既有三维渲染器；组件、宿主消息桥和服务合同需要在目标分支适配后验证。

## 什么时候才算同步完成

在同一个目标画布中，实际完成“按天或直接新建纯文字 → 上传照片 → 编辑排序 → 保存浮雕 → 刷新重开 → 探索目的地后返回 → 指定账号查看/编辑/撤权”，并核对同一旅行、同一份云端数据和撤权后的媒体拒绝。桌面与窄屏都需操作；主规划的方向选择、连带调整和逐项确认另按原设计逐条验收。

现有证据分别来自两条实现的本地受控环境。PR #6 做过真实 Java/MCP/临时 PostgreSQL 的浏览器操作；PR #7 的交付记录包含真实 HTTP/DSH/隔离 PostgreSQL 和官方 DSH Web 宿主的受控操作。两者均不能替代整合后的验收。真实 Google、授权旅行来源、Codex/ChatGPT 原生安装、物理手机、生产容量和公开发布仍需分别验证。
