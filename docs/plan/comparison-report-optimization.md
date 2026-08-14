# 比较报告三方面优化规划

状态：专题计划，实现与本文对齐；真机 e2e 仍需显式 opt-in 重跑
日期：2026-08-14
权威性：不覆盖 [`architecture/comparison.md`](../architecture/comparison.md)、[`architecture/agent-roles-and-system-prompts.md`](../architecture/agent-roles-and-system-prompts.md)、[`product/tui.md`](../product/tui.md)。落码前若与 §5 薄壳约定冲突，先改那份规范或写决策记录。
依据：Claude Code 真机端到端的 `report.html` / `comparison.md` / `controller.decision`；[`agent-system-prompt-redesign.md`](./agent-system-prompt-redesign.md)；[`controller-experiment-conditions.md`](../architecture/controller-experiment-conditions.md)；[`development-plan.md`](../development-plan.md) 模块 6。

## 0. 结论

对照面不好比，不是单一渲染问题。停住候选的是 **Controller 过早 `done/satisfied`**，不是 Harness 回合墙，也不是候选在回合内被掐断。Comparison 把回放条件写成了结果差异；Host 把 Markdown 当纯文本塞进三块灰卡片。

产品约定与用户判断一致：候选在一个目标回合内自主做到 `result`；是否再发下一条用户消息、任务算不算完成，由 Controller 决定。[`controller-experiment-conditions.md`](../architecture/controller-experiment-conditions.md) 写明 Controller 资源预算默认无限制；`RunPolicy` 只应是安全阀，耗尽必须记成 `limit.*`，不能伪装成完成。

这次失败在第二层：Controller 用「当前空目录里已经有文件夹和 PDF」当作验收，而不是用基线终稿里用户已经接受的质量。空 stand-in 让这个低标准更容易成立。

优化顺序：先修正 Controller 的完成判据与 Host 观察，再让 Comparison 按程序写正文，最后做 HTML。只换配色解决不了「在比什么」。

## 1. 候选与执行（谁该停、谁实际停了）

### 1.1 两层时钟

| 层 | 谁跑 | 何时停 | 这次发生了什么 |
|---|---|---|---|
| 目标回合内 | 候选 Runtime | 候选自己交出 `result`，或 Host 安全阀 | 1 回合约 142 秒；`claude-code.assistant` 47 条、`user` 22 条（工具结果）；6 个文件。回合内没有被杀 |
| 回合之间 | Controller | `send` 再开一回合，或 `done` 结束 | 第一次决策就是 `done/satisfied`。`followupSubmission=false` |

「候选执行不受限制直到任务完成」指的是第二层：只要 Controller 认为用户还会说话，候选就应再跑；Harness 不得因为「已经有一回合」而收工。第一层本来就是「一条用户消息，候选自己做到交出结果」——Claude Code 的 `result` 帧就是这个边界。

历史会话也只有 **1 条用户消息**（转录 46 行 = 1 user + 17 assistant + 28 tool）。`historicalUserFollowups` 为空。Controller 不是因为「没把后半段用户话发出去」而停的，历史上就没有后半段用户话。`completedTurns: 2` 是历史 Agent 的回合标记，不是 2 条用户指令。

### 1.2 谁有权停、谁实际停了

终止码是 `completed.controller_satisfied`，`initiatedBy: controller`，任务状态 `apparently_completed`。Controller 自己写的理由是：当前工作目录已有整理文件夹和 PDF，官方链接做过 HTTP 检查。

这不是预算墙。e2e 的 `RunPolicy` 是 2 目标回合、2 次 Controller 决策、5 分钟墙钟；实际用了 1 回合、1 次决策、约 142 秒。若 Controller 当时 `send/verify`，还剩 1 个目标回合和 1 次决策。真正触发的是 prompt 决策序第 1 条：*Goal already satisfied with sufficient evidence → done/satisfied*。

TUI 默认 `TUI_RUN_POLICY` 原先是 4 回合 / 3 次决策 / 30 分钟，同样不是「直到完成」。落地后改为 12 / 12 / 60 分钟安全阀。架构写的是：Controller 预算默认无限制；`RunPolicy` 独立约束 Target；上限耗尽必须是 `limit.*`，不能记成 `done`。e2e 用 2/2 是 smoke 收口，和「任务完成」不是同一套语义。这些上限这次没开火，但只要 Controller 想多协作一轮，第二次就会顶到天花板，那时会变成 `limit.controller_calls` 或 `limit.target_turns`。

禁用 Cron / Schedule / SendMessage 与这次任务无关。`sonnet → deepseek-v4-flash` 只改变归因。

### 1.3 为什么 Controller 会过早 satisfied

四件事叠在一起，缺一则不一定会在第一回合收工。

1. **验收标尺用了 initialInput，没用用户已接受的结果。** 初始输入约 35 字（下载并整理）。基线终稿约 1024 字，写了落点、笔记风格、PDF 体积。Controller prompt 把 baseline 说成「用户想要并接受的结果，不是必须复制的路径」，决策序第 1 条又只要「目标已满足且证据够」。模型把「当前目录里有文件夹和 PDF」当成目标满足，没有把终稿里的质量当验收清单。不同路径可以，更浅的验收不可以。
2. **Host 观察偏「本地已完成」。** `currentSummary` 是结算状态、可见终稿、命令数、改动路径数。`sourceRootKind` 不在 `SteeringContext` 里。Controller 看见的是隔离区现场，很容易把「这里已经有产物」读成「任务完成」。
3. **赛场是空 stand-in。** 脚本不用 `taskContext.historicalCwd`（case 里有这个字段），只放 `note.txt`。原库里的既有文件夹风格不存在，候选只能新建目录。Controller 在空目录里看到新建整理夹，与「下载并整理」字面一致，更难触发 `send/correct` 或 `send/verify`。
4. **隔离写入是产品不变量。** 即使复制了历史 cwd，写入也只在副本。Controller 不应要求「写回用户原库」；它应要求「在副本里对齐用户已接受的相对位置与质量」。Comparison 把「没写回原库」写成结果差异，是把不变量误当成能力。

基线仍然只有终稿、没有工作区快照。Controller 不能核验历史落盘，但能把终稿当作**用户已接受的质量描述**来决定要不要再问一句。这次它没有。

### 1.4 约束

- 不把用户知识库复制进 git，也不在不受控文档里展开其内容。
- 不取消隔离：候选不得写回原目录。
- 不把「只重放 initialInput」改成按转录逐条重放用户消息。本会话本来就只有一条用户消息；有后续用户消息时，由 Controller 决定是否作为自然回复发出，而不是脚本重放。
- 不在本计划采集历史工作区快照作为 baseline artifact。没有快照时，报告必须写「基线只有终稿，不能核验落盘」。
- 不把 `RunPolicy` 安全阀伪装成任务完成。

### 1.5 规划

1. **完成权只给 Controller；安全阀显形。** 真机 / TUI 默认跟架构走：Controller 决策次数默认不设小上限。`RunPolicy` 若保留，只作安全阀，数值明显高于「一条用户消息 + 一次验收」。耗尽记 `limit.*`，报告头栏写「安全阀截断，不是完成」。e2e smoke 的 2/2 不得当作比较实验的完成语义。
2. **Controller 的 satisfied 要对齐用户已接受的质量。** 在 [`agent-system-prompt-redesign.md`](./agent-system-prompt-redesign.md) 的 Controller 提案上追加：`done/satisfied` 必须对照 `baseline.finalMessage` 里用户已接受的结果质量（交付物种类、整理粒度、必要核验），不是对照「当前目录是否已经有点东西」。不同路径、不同文件夹名可以；缺了用户已接受的关键质量应 `send/verify` 或 `send/correct`，而不是 satisfied。禁止要求写回原绝对路径。禁止把历史 Agent 的实现细节当用户先验喂给候选。
3. **SteeringContext 补 Host 事实。** 至少：`sourceRootKind`（`historical_cwd` / `operator_selected` / `stand_in`）；隔离副本说明；请求模型与解析模型；改动路径列表而不只是计数。stand-in 时，Controller 不得仅因「在空目录新建了整理夹」而 satisfied。
4. **e2e 与正式路径对齐。** 比较实验应使用 `historicalCwd` 的隔离副本；若故意用 stand-in，必须写入 `sourceRootKind=stand_in`。TUI 已预填历史 cwd 的保持；操作者改目录记 `operator_selected`。
5. **报告区分三种停法。** `controller_satisfied` / `controller` 其它 `done` / `limit.*`。只有第一种能写成「Controller 认为任务完成」；后两种写成限制。Comparison 不得把隔离不变量或 stand-in 写成能力差异。
6. **workflow 候选选择。** `start()` 使用 `pack.defaultCandidate()`，忽略 `defaults.candidate`。指定模型必须走会生效的路径。

验收：再跑同类任务时，若基线终稿要求的关键质量在副本里未出现，第一次 Controller 决策不得是 `done/satisfied`；头栏能读到谁停的、`sourceRootKind`、是否安全阀；stand-in 运行不得把「没写回原库」写成主要结果差异。

## 2. Comparison Agent 的分析角度与正文

### 2.1 当前情况

现行 prompt 已要求区分观察 / 推断 / 不可用，以及结果 / 过程 / 回放限制；不排名；harness 截断不当能力。这次正文在结果差异上写对了几条，也承认基线无法核验。缺口是**没有强制分析程序**，也**没有可渲染的正文约定**。

具体失败：

- 回放条件（空工作区、隔离、模型别名、Controller 过早 satisfied）被写进「结果差异」。
- 没有基线 vs 候选的对照表，读者要从散文里拼。
- 引用写成 `artifact:candidate-workspace-scope.json`，Host 不改写，页面上不可点。
- 强调靠段落密度，不靠少量加粗。
- [`agent-system-prompt-redesign.md`](./agent-system-prompt-redesign.md) §3 已改分节、调查顺序、语言规则和 `insufficient_evidence`，但没写「先给差异分类」和「Markdown 怎么写才够 Host 渲染」。

[`architecture/comparison.md`](../architecture/comparison.md) 禁止固定评分模板和通用可视化 DSL。优化走 **Markdown 子集 + Host 渲染**，不发明第二种报告语言。

### 2.2 规划

在已有 prompt 重设计之上追加，不另起一份互斥文案。落码仍只改 `src/agents/comparison-agent.ts` 的 `SYSTEM_PROMPT`（及必要时 briefing 字段）。`OUTPUT_CONTRACT`、工具白名单、信封 schema 不动。

**分析程序（有序，写进 prompt）：**

1. 读 Host 回放条件。每一条差异先标成 `result` / `process` / `replay_limitation`，标不成结果就不要写进结果节。
2. 先核验产物：`candidate-workspace-scope.json`、终稿、catalog 附件。briefing summary 是声称，不是核验。
3. 再看过程：`read_observation` 的 `run_events`，只为解释结果或限制服务。
4. 对每条会改变用户判断的发现，读一次最可能反证的证据。
5. 基线没有工作区文件时，基线落盘、体积、格式只能标「按终稿转述，未核验」。不得把转述写成观察。
6. 隔离副本、stand-in、安全阀 `limit.*`、模型别名，全部进「回放限制」。`controller_satisfied` 是完成判断，不是限制；但 stand-in 或过低验收导致的 satisfied 要在限制里写明「完成判据可能过宽」。其中任何一条都不能单独证明能力强弱。
7. 某一整维（过程效率、验证方法、原库风格对齐）比不了，就写不能比的原因；必要时信封用 `insufficient_evidence`。

**正文约定（仍是自由 Markdown，但是 Host 能画出来的子集）：**

```text
# 对比结论
一段话：最值得看的差异。会改变判断的短语用 **加粗**，每篇不超过三处。

## 对照
一张 Markdown 表，列：维度 | 基线 | 候选 | 证据。
只放核验过或已标明「未核验」的格子。不要为对称而造行。

## 结果差异
条目。每条先写差异，再写证据。引用用相对路径
`./runs/<runId>/artifacts/<artifactId>`，不要用 `artifact:` 伪协议。

## 回放限制
Host 已核验的条件用列表复述，可补充解释，不得改写成结果。

## 过程（可选）
只写能解释结果或限制的过程。没有可比过程就写「本维不能比」并停止。
```

加粗规则：只加粗判断句（例如「交付位置不同，可能影响可用性」），不加粗路径、数字、小节标题。表格优先于长段落。代码、命令、标识符保持原文。正文语言跟随 `initialInput` 的主要语言。

不要求固定 finding 数量，不要求每个任务都有过程节，不输出 HTML、分数或胜者。

验收：用本次实验的 briefing（补上 `sourceRootKind=stand_in`）重跑 Comparison 或做夹具回放时，对照表存在；「没写回原库」出现在回放限制而不是结果首条；引用是相对路径；加粗不超过三处。

## 3. HTML 美观与渲染

### 3.1 当前情况

`src/report/comparison-report.ts` 输出三块同权重白卡片：头栏只列候选，正文是转义后的 `<pre>`，Files 只列 `comparison.md` 与 experiment-owned JSON。约 569 字节灰底 CSS。`lang="en"` 包中文。模块 6 要求的基线摘要、停止原因、fidelity、遥测，Host 几乎都不投影。

这与 [`architecture/comparison.md`](../architecture/comparison.md) §5 一致：全文转义、不重新解释、不接受 Agent HTML。用户要的「渲染标题/列表/加粗/表格 + 统一配色」**改变这条约定**。落码前必须把 §5 改成：Host 对白名单 Markdown 做确定性渲染；Agent 原文仍不可当 HTML。

Files 指错对象的原因在采集，不在 CSS。`captureWorkspaceScope` 只提交一份 scope JSON（路径、指纹、最多 16 个文本快照）；含 NUL 的 PDF 被跳过。那 6 个交付文件在隔离工作区磁盘上，不是 catalog 项，所以没有相对链接，也没有 diff。

### 3.2 规划

**渲染（先于配色）：**

1. 白名单 Markdown：`h1`–`h3`、段落、`ul`/`ol`、`strong`/`em`、`code`、GFM 表、`[text](relative)`。其它标记当文本。禁止 raw HTML、`javascript:`、绝对本机路径。
2. 把 `artifact:<id>` 兼容改写成 `./runs/<runId>/artifacts/<id>`（仅当 catalog 拥有该 id）。
3. `html lang` 与 Host 壳文案都跟随 `initialInput` 的主要语言；模型名、路径和终止码保持原文。
4. 无 Comparison 时仍输出 Host 壳 + 降级说明，行为与现门禁一致。

**信息架构：**

```text
题头     Host：任务一句话；模型 · 回合/墙钟 · 不是排名
正文     Comparison：白名单渲染后的 Markdown
限制     Host：最多三条会改变读法的条件，默认折叠
文件     Host：交付路径；JSON 轨迹与 catalog 默认折叠
```

限制是 Host 核验事实，不从 Markdown 反解析。不做基线/候选对照条。

**视觉：**

一套内联 token，不用框架、不用脚本（折叠可用 `<details>`）。纸色底、一种强调色只用于「本次候选」和链接，基线用中性色，限制用警告底。中文正文用系统字体栈并设置标点换行。深浅两套同一语义；打印去掉底色。不要三块同权重白卡片，不要渐变和阴影。

**证据入口（小步，不建预览框架）：**

Files 增加 `changedPaths`（来自已有 scope），每条标明「文本快照 / 仅路径 / 二进制未快照」。不在第一刀做图片预览或通用 diff DSL。完整文件仍在磁盘，用户按相对链接打开。

验收：`test/comparison-report.test.ts` 增加——标题不再以字面 `#` 出现；`**差异**` 变成 `<strong>`；`<script>` 仍被转义；绝对路径不进 `href`；`artifact:` 在 catalog 命中时变成相对链接；对照条同时出现基线与候选；无叙事时壳完整且两次渲染字节相等。

## 4. 实施顺序

| 顺序 | 工作 | 主要文件 | 依赖 |
|---|---|---|---|
| A | Host 回放条件进入 SteeringContext、Comparison briefing 与头栏；三种停法分开写 | `experiment.ts`、`comparison.ts`、`comparison-report.ts` | 无 |
| A2 | Controller satisfied 对齐基线终稿质量；stand-in 不得一回合收工 | `controller-agent.ts`；与 [prompt 重设计](./agent-system-prompt-redesign.md) 一次落地 | A |
| B | Comparison prompt：分类程序 + Markdown 子集 | `comparison-agent.ts`；同上一次落地 | A，否则限制仍会被写成结果 |
| C | 改 [`architecture/comparison.md`](../architecture/comparison.md) §5 后做白名单渲染与对照条 | `comparison-report.ts`、测试 | 规范先改 |
| D | 色板与 `<details>` 证据区 | 同上 | C |
| E | 比较实验用历史 cwd 副本或显式 `stand_in`；提高/去掉 smoke 式 2/2 上限 | `scripts/claude-real-e2e.ts`、`tui-workflow.ts` | A、A2 |

A 可单独合并。A2 与 B 的 prompt 改动与 [prompt 重设计](./agent-system-prompt-redesign.md) 一次落地，不要在 A 之前单独上线。C 必须先改架构文档。D 不单独出「只改颜色」的提交。

## 5. 明确不做

- 不给候选打分、排名或胜者。
- 不发明可视化 DSL、图表组件或 Agent 产出的 HTML。
- 不按转录脚本重放用户消息；有后续用户消息时由 Controller 决定是否发出。
- 不把隔离区写回用户原目录。
- 不把 e2e smoke 的 2 回合 / 2 次决策当成「任务已完成」的证据。
- 不在本计划采集历史工作区作为 baseline artifact。
- 不把 Comparison 改成固定 `summary + observations[]` JSON 模板。
- 不把用户任务正文或密钥写进受控文档。
