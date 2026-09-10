# Reprise TUI 操作者画布

本文是目标信息设计，不覆盖当前产品规范。按键、页图与阅读合同仍以[阅读与交互](./reprise-tui-design.md)为准；画布与页图收口见[操作者记录面全面重构](./reprise-tui-operator-record-refactor.md)；命令与来源层改法见[界面重构](./reprise-tui-surface-refactor.md)。本机 HTML 草图在 `docs/research/reprise-tui-operator-canvas.html`，不受控，不拥有验收。

操作者不是在写代码，而是在观看一次隔离对照。界面回答五个问题即可：任务是什么、此刻谁在干活、有没有卡住、人类在原产品里会看到什么、结束后打开什么。

## 借鉴边界

Codex、Claude Code、Grok 的主视图都是**一条状态 + 最新动作 + 已完成结论**。借鉴的是信息取舍，不复制外观、私有事件或隐藏推理。

| 学 | 不学 |
|---|---|
| 进行中只占一行，被下一动作替换 | 把 argv、git 全文、工具 JSON 铺进主列 |
| 用户可见回复当正文 | 把内部 Agent 的工作独白当正文 |
| 失败、权限、投递拒绝始终露出 | 用 spinner 假装进度百分比 |
| 产物用短标签超链接，完整路径作后备 | 把 180 字盘符路径当唯一入口 |
| 候选回合未结束也要有「活着」的信号 | 等 `UserVisibleTurn` 落盘才画候选 |

Reprise 多一个声部：Harness 内部 Agent（恢复 / 模拟用户 / 对照）与候选产品必须分色，不能画成同一个聊天窗口。

## 两层画布

**此刻（一行，原地替换）。** 进行中的动作只保留「角色 · 动词 · 叶名」。并发时附「另有 N 项」。命令行、stdout、上下文 JSON、未公开 reasoning 不进这一行。内部 Agent 用 `agent.tool_called` 的 `role` + `tool` + `params.path` 叶名。候选只用 Pack 写入的公开进行中字段；没有公开动词时写 `{声部} · working`。TUI 不解析产品私有 `message.content`，不按 `productId` 分支。

**记录（可滚、可展开）。** 只追加已经值得回顾的事实：恢复发现、模拟用户投递卡、候选用户可见回复、错误、任务判断 / 终止 / 清理、对照结论。调查工具完成后收成 `阅读证据 · 12` 一类组；`write` 与失败各占一行。`[o]` / Tab 才打开命令与原文。折叠只改视图。

Controller 决策输入与正式时间线仍只使用已校验的 `candidate.user_view_persisted`。此刻行不得进入 briefing。见[此刻行与已结算画布](../decisions/accepted/2026-09-10-tui-live-now-row.md)。

## 模拟用户（Controller）过程

对照一次真实实验（Claude Code 候选、7 次 `controller.decision`）：公开日志里模拟用户的过程已经够画，不缺事件。

| 画什么 | 事件 | 不画 |
|---|---|---|
| 此刻行：阅读 · INDEX.md | `agent.tool_called` `role=controller` `tool=read` `params.path` | `assistant_visible` 英文独白 |
| 此刻行：检查工作区 | `tool=shell_exec`（叶名能抽就抽，否则只写检查） | argv、stdout |
| 组计数：阅读证据 · N | 连续 `read` / `grep` / `find` 完成后合并 | 每个 `compact tail` |
| 高潮：Decision · SEND + 投递卡 | `controller.decision` 的 `value.type` 与 `value.message` | `rationale` 默认折叠 |
| 结束：DONE · satisfied | 同上 `type=done` | 把 `observation_read.source` 当过程（只有桶名） |

内部 Agent 无工具活动时，此刻行是 `working`（Codex 的 Working 行；Claude Code 默认也不把 thinking 铺进主列）。`assistant_visible` 全文只经 `[o]`。候选无 `live` 时同一条 `Candidate · working`；有 `live` 则换成动词与叶名。

## 候选产品过程

正式可见正文只来自 `candidate.user_view_persisted`。投递卡来自 `controller.decision` / `input.submitted`。

进行中：无 `live` 时此刻行是 `Candidate · working`；Claude `tool_use` 与 Codex `item/started` 由 Adapter 写成 `runtime.tool_started` 并附校验过的 `live`（verb + 叶名）。TUI 只读 `live`，不拆 `message.content`。thinking 与中间 text 块不进主列。`user_view_persisted` 后此刻行让位。

## 全流程

顶栏四项：任务短句、阶段、产品、耗时。恢复阶段不写轮次。页脚只列本页会响应的键。

**封面。** 最近实验一行；`/` 只开应用命令。不把内部模型与候选模型写在同一句。

**来源四层。** 产品 / 项目 / 会话各一行：名、时间、任务短句。核对页展示起点句；Enter 才冻结。发现失败用计数，不展示绝对路径或 transcript。

**恢复。** 标题「正在恢复会话」。进行中必须有过程：此刻行持续换动词；已确认的发现按时间追加短句；检查次数只显示组计数。禁止等全部完成才第一次画出发现，也禁止把独白和 argv 当过程。超过 30 秒无新发现时，此刻行改为「仍在恢复 · {最新动词}」，不用候选的「等待本轮结束」。终态一词：已恢复 / 部分恢复 / 无法恢复。

**候选产品与模型 / 确认。** 选择页不是计费墙。确认页只复述产品、模型、恢复终态、费用与「原目录不变」。Enter 才建副本。

**候选运行。** 投递卡是人类可见输入。未结算时画布不能空：无 `live` 时是 `Candidate · working`，有 `live` 则换成动词与叶名。回合结算后此刻行让位给 `UserVisibleTurn`。模拟用户过程见上一节，不与候选青色混排。

**对照。** 同一记录追加。进行中用对照声部的此刻行（写报告），不继续显示「候选运行中 · 第 N 轮」。

**结果。** 三行人话：任务判断、运行终止、清理。token / cost 未采集写 `not recorded`。产物用短标签超链接：`报告`、`隔离副本`、`记录`。标签走已验证绝对路径的 OSC 8 `file:` URI；终端不支持超链接时显示完整可复制路径。键盘 `o` / `t` / `w` 与点击打开同一目标。不把对照 `headline` 写成任务判断。跳过对照写「对照未运行」，并保留 `c`。

## 截图对应的失败

恢复与模拟用户把 `assistant_visible` 全文和每条 `shell_exec` 当主列，操作者读不到「还差什么」。候选回合进行中正式列没有公开过程，顶栏一句等待等于空白。结果把盘符路径当正文，超链接能力看不见。这些是投影密度错误，不是缺事件。

## 验收（假终端）

默认帧不含 argv、git 开关或 `compact tail`。候选 `runtime.tool_started` 期间帧上有此刻行。`user_view_persisted` 后此刻行消失、可见回复出现。结果短标签含 OSC 8；无能力时退回完整路径。反向：把工具 stdout 画进默认列，或等待期间画布无此刻行，则红。真终端点击与 IME 仍按[平台矩阵](./2026-09-08-platform-evidence-matrix.md)，HTML 不算关闭。
