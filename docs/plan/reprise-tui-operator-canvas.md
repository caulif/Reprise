# Reprise TUI 操作者画布

本文是目标信息设计，不覆盖当前产品规范。按键、页图与阅读合同仍以[阅读与交互](./reprise-tui-design.md)为准；画布与页图收口见[操作者记录面全面重构](./reprise-tui-operator-record-refactor.md)；命令与来源层改法见[界面重构](./reprise-tui-surface-refactor.md)。本机 HTML 草图在 `docs/research/reprise-tui-operator-canvas.html`，不受控，不拥有验收。恢复、模拟用户与对照的短句脊、执行条、Input 卡见[内部 Agent Trace](./reprise-tui-recovery-trace.md)。

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

Reprise 多一个声部：Harness **内部 Agent**（恢复 / 模拟用户 / 对照）与**候选**必须分色，不能画成同一个聊天窗口。三个内部角色**共用薄荷**，候选用**桃色**；不要三色图例。树与键位见[方案 A](./reprise-tui-live-expand.md)。

## 两层画布

**此刻（一行，原地替换）。** 进行中的动作只保留「角色 · 动词 · 叶名」。并发时附「另有 N 项」。命令行、stdout、上下文 JSON、未公开 reasoning 不进这一行。内部 Agent 用 `agent.tool_called` 的 `role` + `tool` + `params.path` 叶名。候选只用 Pack 写入的公开进行中字段；没有公开动词时写 `{声部} · working`。TUI 不解析产品私有 `message.content`，不按 `productId` 分支。

**记录（可滚、可展开）。** 只追加已经值得回顾的事实：恢复发现、模拟用户投递卡、候选用户可见回复、错误、任务判断 / 终止 / 清理、对照结论。调查工具完成后收成 `阅读证据 · 12` 一类组；`write` 与失败各占一行。Enter / 单击 `▸` 在主列露出叶名。运行页不设全文 overlay。折叠只改视图。树渲染、列尾状态行与键位见[方案 A](./reprise-tui-live-expand.md)。

Controller 决策输入与正式时间线仍只使用已校验的 `candidate.user_view_persisted`。此刻行不得进入 briefing。见[此刻行与已结算画布](../decisions/accepted/2026-09-10-tui-live-now-row.md)。

## 模拟用户（Controller）过程

探路与恢复同构同色：短句钉主列，工具只留一行执行条，下一段话到来时收成 `▸`。另外钉 Input 横条与候选可见回复（候选子弹另一色）；有 Input 就不再画 `Decision: SEND`。列尾写「控制Agent」，不另起一张控制色块。模拟用户页不带恢复过程。字段、折轮与改动点见[内部 Agent Trace](./reprise-tui-recovery-trace.md)。

候选无 `live` 时执行条是 `working (Ns)`；有 `live` 则换成动词与叶名。thinking 不进主列。

## 候选产品过程

正式可见正文只来自 `candidate.user_view_persisted`。投递卡来自 `controller.decision` / `input.submitted`。

进行中：无 `live` 时此刻行是 `working · {elapsed}`；Claude `tool_use` 与 Codex `item/started` 由 Adapter 写成 `runtime.tool_started` 并附校验过的 `live`（verb + 叶名）。TUI 只读 `live`，不拆 `message.content`。thinking 与中间 text 块不进主列。`user_view_persisted` 后此刻行让位。

## 全流程

顶栏四项：任务短句、阶段、产品、耗时。恢复阶段不写轮次。页脚只列本页会响应的键。

**封面。** 最近实验一行；`/` 只开应用命令。不把内部模型与候选模型写在同一句。

**来源四层。** 产品 / 项目 / 会话各一行：名、时间、任务短句。核对页展示起点句；Enter 才冻结。发现失败用计数，不展示绝对路径或 transcript。

**恢复。** 标题「正在恢复会话」。内部 Agent 探路：短句钉主列，工具一行执行条，下一段话到来时收成 `▸`。子弹用内部色（与模拟用户、对照相同）。字段与改动点见[内部 Agent Trace](./reprise-tui-recovery-trace.md)。禁止把 argv、compact 和每条 inspect 当过程。终态一词：已恢复 / 部分恢复 / 无法恢复，并摘录 `recovery.md`。

**候选产品与模型。** 只两页：选产品、选模型。选择叠在恢复记录尾。选完模型进入模拟用户运行，不要第三页确认。

**候选运行。** 投递卡是人类可见输入。未结算时画布不能空：无 `live` 时是 `working (Ns)`，有 `live` 则换成动词与叶名（候选色）。回合结算后此刻行让位给 `UserVisibleTurn`。控制 Agent 过程用内部色，见上一节；不把恢复树带进本页。

**对照。** 按 `c` 后新开对照页，不带控制 Agent 的 Input 与候选回复。对照 Agent 探路与恢复同构同色。顶栏「正在写对照报告」。终态：对照完成 / 证据不足 / 对照失败，并摘录 `headline`。字段见[内部 Agent Trace](./reprise-tui-recovery-trace.md)。不把 Host 四次委托画成章节，不把 `headline` 写成任务判断。

**结果。** 三行人话：任务判断、运行终止、清理。token / cost 未采集写 `not recorded`。产物用短标签超链接：`报告`、`隔离副本`、`记录`。标签走已验证绝对路径的 OSC 8 `file:` URI；终端不支持超链接时显示完整可复制路径。键盘 `o` / `t` / `w` 与点击打开同一目标。不把对照 `headline` 写成任务判断。跳过对照写「对照未运行」，并保留 `c`；对照完成后框内换成终态词 + `headline`。

## 截图对应的失败

恢复与模拟用户把每条 inspect、compact 和 `Decision: SEND` 铺进主列，短句进不了脊。对照把 `inspect artifact ×N` 和 `compact tail` 当过程，顶栏仍写候选第 N 轮。候选回合进行中正式列没有公开过程，顶栏一句等待等于空白。结果把盘符路径当正文，超链接能力看不见。这些是投影密度错误，不是缺事件。

## 验收（假终端）

默认帧不含 argv、git 开关或 `compact tail`。候选 `runtime.tool_started` 期间帧上有此刻行。`user_view_persisted` 后此刻行消失、可见回复出现。结果短标签含 OSC 8；无能力时退回完整路径。反向：把工具 stdout 画进默认列，或等待期间画布无此刻行，则红。真终端点击与 IME 仍按[平台矩阵](./2026-09-08-platform-evidence-matrix.md)，HTML 不算关闭。
