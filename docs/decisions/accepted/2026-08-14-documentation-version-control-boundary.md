# 决策：文档受控边界

状态：accepted

## 问题

`docs/` 变成了什么都能扔进去的地方，且「什么该进 git」从未被定义。重构前的实测事实：

- 受版本控制的 190 个 `docs/` 文件中，`tui-audit/` 95 个加 `tui-intake-review/` 34 个共 129 个，占 68%。也就是说三分之二的受控文档是机器生成的 TUI 帧与 HTML 镜像。
- `docs/tui-loop/`（705 个文件、6.24 MB）和 `docs/tui-live-run/`（72 个文件、12.89 MB）处于「未提交也未忽略」的中间态。`.gitignore` 只覆盖了 `tui-live-run/data/` 和 `screenshots/`，因此一次 `git add docs/` 就会把约 19 MB 走查产物写进 git 历史，而 git 历史里的二进制不可撤销。`tui-live-run/data/` 里是 12.2 MB 真实 Codex 会话原始数据，含个人项目名。
- `docs/archive/` 累积了 25 份过期 review 快照，`docs/analysis/` 累积了 9 份时点审查。两者都不能约束当前实现，但都在受控目录里，随时可能被误引用为依据。
- `docs/tui-audit/frames/` 虽然受控，却不提供任何门禁价值：`scripts/tui-audit-analyze.mjs` 只对**新生成的**帧做启发式检查（行宽溢出、面板上下沿宽度是否相等、compact 模式禁用字符、ANSI 逃逸泄漏），**从不与已提交的帧比对**。已提交的帧因此只是碰巧在版本控制里的产物。

## 决定

`docs/` 里的材料分三类，只有第一类进入版本控制。完整规则见[文档结构与路径约定](../../documentation-structure.md#受控边界)。

| 类别 | 位置 | 受控 |
|---|---|---|
| 长期材料：规范、决策、未完成计划、设计依据、进度入口 | 目录模型列出的路径 | 是 |
| 一次性材料：时点审查、走查、体验记录、已完成或被取代的计划 | `docs/.local/` | 否 |
| 生成产物：TUI 帧与 HTML、截图、验收证据 | `docs/tui-*/`、`docs/evidence/` | 否，唯一例外见下 |

三条判据：能重新生成的东西不需要历史副本；价值会随代码失效的材料留在版本控制里只会成为 review 噪音和误引用来源；不受控不等于可以随便写，`docs/.local/` 里的文档同样不得作为当前依据。

**唯一例外是 `docs/tui-audit/frames/`**，并且它的角色同时改变：从「碰巧受控的产物」变成 CI 逐字节比对的快照基线。理由是 TUI 是本项目的主要用户界面，而渲染变化目前只能被启发式规则发现——启发式只能发现「明显坏了」，发现不了「布局意外改变了」。帧作为基线后，任何渲染改动都会在 review 里显示为帧 diff，成为显式信号。`.gitattributes` 因此把该目录固定为 `text eol=lf`：Windows 检出若把帧转成 CRLF，而生成器写的是 LF，每次重新生成都会产生全文件 diff，基线立即失去意义。

一次性材料统一放在单个 `docs/.local/` 下，而不是在各目录逐个列忽略规则——`.gitignore` 只需一行，且路径本身就宣告了「本地保留、不受控」。

## 备选方案

**删除一次性材料，只靠 git 历史追溯。** git 历史确实保留了它们，但要找必须先知道文件名和大致时间。这些审查里仍有未被提炼的观察（例如第六轮的 P2/P3 清单），本地保留的成本接近零，而丢失的成本不可逆。

**保留 `docs/archive/YYYY-MM-DD/` 这一层继续受控。** 这是重构前的机制，它的问题是归档目录会单调增长且始终在受控视图里：25 份快照已经比全部架构规范（11 份）多一倍以上。归档的目的是「不再作为依据但可追溯」，而不受控 + git 历史已经满足这两点。

**把走查产物挪出 `docs/` 到仓库根的 `artifacts/`。** 更彻底，但要同时改 `tui-visual-audit.mjs`、`tui-audit-analyze.mjs`、`tui-full-flow.ts`、`tui-case-replay.mjs` 四个脚本的输出路径，而收益仅是路径更好看。保持路径不变、用 `.gitignore` 表达边界，改动面小得多。

**继续不比对帧，只靠启发式分析。** 启发式规则是白名单式的：它只能发现已经被写成规则的问题。第六轮的实际教训是渲染缺陷（ScrollView 钉底、粘贴失效）恰好落在既有规则之外。逐字节基线不需要预先知道要找什么。

**把帧也移出版本控制，CI 只做启发式检查。** 这样受控文档能再减 42 个，但会永久放弃「渲染改动在 review 中可见」这个信号，而这正是当前最缺的质量信号。

## 影响

- 受控 `docs/` 文件从 190 降到 79，其中 42 个是有门禁价值的快照基线，实际内容文档 37 个。
- 约 19 MB 走查产物和 12.2 MB 含个人信息的真实会话数据不再可能被误提交。
- `docs/archive/`、`docs/analysis/`、`docs/feedback/` 三个目录取消。
- 一次性材料仍在磁盘上（`docs/.local/`），但在别人的检出里不存在，因此受控文档不得链接它们。
- `tui-audit/frames/` 成为基线后，改 TUI 渲染必须重新生成并提交帧，否则 CI 失败。这是新增的持续义务，也是本决策的主要成本。

## 验证

- `git ls-files docs | Measure-Object` 为 79；其中 `docs/tui-audit` 为 42。
- `git check-ignore docs/.local/x`、`docs/tui-loop/x`、`docs/evidence/x` 命中；`docs/tui-audit/frames/01-home-wide.txt` 不命中。
- `.gitattributes` 对 `docs/tui-audit/frames/**` 声明 `text eol=lf`。
- `npm run verify:docs` 比对目录模型与磁盘实际目录，并拒绝从受控文档指向 `docs/.local/` 的链接。
