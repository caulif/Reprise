# 内部 Agent 可见过程：恢复单列、运行分屏、对照可选

状态：计划。设计稿见 [recovery-narrative-canvas.html](./recovery-narrative-canvas.html)。落地时改三个内部 Agent 的 prompt、`PiTextSession` 审计、运行页布局、Experiment 收尾（对照不再自动开），并写 `docs/decisions/accepted/`。本文不覆盖当前产品规范。

相关：[TUI §4.1](../product/tui.md#41-主活动时间线)、[内部 Agent 运行画布](../decisions/accepted/2026-09-01-internal-agent-activity-canvas.md)、[Comparison](../architecture/comparison.md)、[Grok 壳原则](./grok-style-tui-redesign.md)、[持久化](../architecture/persistence-and-crash-consistency.md)。

三个内部 Agent 是同一套缺陷：Host 只要 JSON 信封，可见短句不进事件，TUI 只能画工具名。成熟 CLI（Claude Code、Codex、Grok Build）把 **可见 assistant 段落当脊**，工具默认折叠。Reprise 借层次，不借皮肤、快捷键或 hidden reasoning。

JSON 收尾仍是完成合同（最后一条 assistant 只解析信封）。中间轮次允许任务语言 1–3 句。没有句子时只画折叠工具，Host **不编造**旁白。

## 1. 共同合同

新增 `agent.assistant_visible`（`role` 为 `recovery` | `controller` | `comparison`）：本轮可见纯文本，空则不发；JSON 终态不当说明；thinking/reasoning 不投影；Host 试卷（调查包、SteeringContext）不是该声部。

Pi 循环中、每次工具前后观察 `agent.state.messages`（或等价回调）立刻落库。只读 `append()` 的最后一条不够。

Prompt（三角色同一节，不改薄信封）：

- 工具批次之间用任务主语言写将查什么 / 刚确认什么 / 下一步做什么。
- 不写日记、不复述命令日志。Recovery / Comparison 不提 Reprise；Controller 的 **说明**可以写判断，**发给候选的 message** 仍不得泄漏实验。
- 该次 invocation 的最后一条消息仍是且只是 JSON。
- 允许零句。

`[o]` 展开当前工具组或当前思考折叠。完成信封、`recovery.md` / `report.html` 全文不进默认主列。

所有 TUI 画面的可滚动区都接鼠标滚轮，溢出时画滚动条：封面/列表、核对、恢复、确认、运行（左右栏**各自**滚动）、对照门、对照过程、结果。滚轮作用在焦点所在的那一块，不带动另一栏。键盘滚动仍保留。

## 2. Recovery：单列过程

恢复没有候选产品 TUI，保持一列。阶段条跟最近一句说明；没有则跟工具类（调查 / 改工作区 / 写报告），不用 `read_observation` 当标题。等待文案是「仍在恢复」，不是候选的「仍在等待本轮结束」。

```text
正在恢复会话 · 查历史证据                    00:58  ● 进行中

题目  …

调查 → 改工作区 → 写报告 → 校验

先看隔离副本是不是仓库，再对一下会话题目里的路径。

  ▸ 调查  inspect · powershell · transcript ×6
```

## 3. 候选运行：左右分屏

确认开跑之后，主画面是 **两列同时活着的会话**，不是一条事件河。

| 栏 | 画什么 | 不画什么 |
|---|---|---|
| **左 · Controller** | 本轮未折叠的短句、折叠调查、写盘/失败、本轮 `Decision`、即将或已经 `send` 的用户句（紫块，等于发给产品的那句） | Target 的流式回复、产品工具 stdout、完成信封 JSON |
| **右 · 候选产品** | Pack 译出的该产品可见会话。用户角色（含 Controller `send` 的回显）用与左栏投递块相同的**紫色**；产品回复青色；命令/工具折叠 | Controller 的 `read_observation`、SteeringContext、rationale 原文 |

右栏用户句走现有 Input 声部（紫），不要画成青色「助手」。这与成熟 CLI「用户紫 / 助手另一色」一致。

左栏思考也要折叠，不只折工具：

- **已结束的回合**默认一行：`▸ 第 N 轮 · SEND ·` 后跟该句用户输入的截断。
- **当前回合**里，早于最近一句的说明 + 其调查组收成 `▸ 思考  <首句截断> · 调查 ×K`。
- 最近一句说明、本轮 Decision、紫块投递默认展开。
- `[o]` 或 Enter 展开当前折叠项；不一次摊开全部历史。

右栏是 **经 Product Pack 规范化的 Target 活动**，看起来像在看 Claude Code / Codex 的会话主列。不是把对方进程的真实 TTY / 私有 UI 嵌进 Reprise。Pack 看不到的闭源面板保持缺失，不伪造。

时间对齐：

- Controller 决策中：左栏在本栏内滚动；右栏停在上一回合（或「等待 Controller」），右栏滚轮只动右栏。
- `send` 已投递：左栏钉住本轮紫块；右栏跟该产品本回合直到 `TurnSettlement`。
- 结算后左栏把本轮收成一行，开始下一轮。

宽终端默认左右分栏（约 2:3 或对半，焦点栏加竖条）。窄终端同一信息架构，`Tab` 在两栏全宽之间切换，不另做第三套内容。

发给产品的那句：左栏紫块是 Controller 产出，右栏紫条是该回合用户输入回显，颜色相同，不是两套语义。

## 4. Comparison：单独阶段，先问再跑

CandidateRun `finished` 之后 **默认不调用** Comparison。Application 停在「候选已结束、对照未开始」。TUI 给出选择：

- **Enter**：启动 Comparison（单独全屏：绿声部；早先思考同样折叠；`write report.html` 一行）。
- **s**：跳过。本次实验没有 `report.html`；结果页对照为未运行；trace / 隔离产物仍可打开。
- 跳过之后第一版不在同一 Experiment 里补跑（避免半份 comparison.json）；要对照就开下一次实验或另立「事后对照」计划。

无头 CLI 必须显式 `--compare` 才调用；没有标志等于跳过，避免脚本悄悄计费。

对照进行中标题是「正在写对照报告」，不是「候选运行中」。Comparison 失败不改 RunOutcome。

## 5. 实施切面

1. **审计 + prompt**：三角色 `assistant_visible`；OUTPUT_CONTRACT 改为「中间可有短句，最后一条仅 JSON」；更新 snapshot。
2. **时间线**：按 `role` 投影到左栏 / 恢复列 / 对照列；Target 事件只进右栏。
3. **运行页**：候选阶段左右分屏；左栏历史回合与多余思考默认折叠；两栏独立滚轮。恢复、对照、确认、列表、结果同样接滚轮。
4. **收尾**：`finishExperiment` 在对照门之后才 `compareExperimentOutcome`；TUI workflow 增加对照确认态。
5. **测试**：有说明则出现该句；无说明不得 Host 编造；右栏用户句为 Input 紫声部；右栏不含 Controller 工具名；跳过对照则无 `comparison.started`；`--compare` 才写报告。反向：自动对照、把 Controller 工具画进右栏、或右栏用户句走产品青色则红。
6. **文档落地后**：`tui.md` 最短路径在结果前插入对照选择；overview 写明 Comparison 由操作者/CLI 显式启动；写明各页滚轮与分屏独立滚动。

## 6. 验收

- 恢复：短句在上、调查折叠；信封与 `recovery.md` 不进主列。
- 运行：宽屏左 Controller（历史思考折叠）、右候选产品；右栏用户句紫色；两栏滚轮互不带动。
- 对照：候选结束后必须先选择；跳过无报告；启动后有绿色过程短句。
- `npm run check`；提示词改 snapshot。各页可滚动区接滚轮；分屏两栏互不带动。
