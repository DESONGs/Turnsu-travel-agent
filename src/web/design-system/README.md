# Turnsu 旅行界面样式

统一工作台使用 Turnsu Design System 1.1.2 插件随包提供的 1.1.1 样式。Web、MCP、DSH 和可操作设计稿共用这些资源与 `travel-theme.css`，不依赖开发机上的插件目录或外部字体服务。

## 文件与维护

| 文件 | 用途 |
| --- | --- |
| `colors_and_type.css`、`tokens.css`、`brand.css`、`components/bundle.css` | 固定版本的语义颜色、字阶、间距、圆角与主题变量；bundle.css 仅去除结尾空行 |
| `fonts/InterVariable.woff2` | Inter 4.1 可变字体；中文使用设备字体回退 |
| `fonts/Inter-LICENSE.txt` | 原样保留的 SIL Open Font License 1.1 |
| `sources.json` | 版本、来源及每份原始文件的 SHA-256 |
| `travel-theme.css` | 旅行产品对现有按钮、导航、表单、侧层与分组的适配 |

原始样式作为固定版本快照维护，文件结尾的格式调整在来源清单中记录上游及本地哈希；更新规范时从上游重新复制并核对哈希。产品调整写入适配层与组件自己的样式，不另维护一份品牌调色配置。构建入口最后加载适配层，以保持 Web、嵌入资源和设计稿的级联顺序一致。

## 使用规则

- 新样式使用 `--turnsu-*` 语义变量。旧组件的 `--ink`、`--blue` 等别名在适配层接到同一份变量，不形成另一套配色。
- 原版 Logo 橙用于品牌，白字主按钮使用操作色，文字链接使用更深的链接色。保存、危险和待核验状态各用对应语义色。
- 标题、正文、标签与说明使用规范字阶。价格与时间保留等宽数字；不改变计价口径、币种或时区表达。
- 本轮验收浅色产品界面。资源包中的深色变量不代表所有旧组件已完成深色适配。
- Logo 沿用 `../brand/` 中的原始 SVG；进入动画的触发与停靠规则保留在 `TurnsuFrame.jsx`。

Web 通过 Vite 生成相对路径字体资源；MCP 构建将字体与 SVG 内联到同一 UI 资源，DSH 复用该工作台。构建结果仍须在实际宿主中验收。

上游来源：[Turnsu Design System](https://github.com/DESONGs/turnsu-design-system)。产品级设计规则见仓库根目录 `DESIGN.md`；本轮验证见 `wiki/research/2026-11-14-turnsu-design-system-refinement.md`。
