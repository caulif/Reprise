# 决策：此刻行与已结算画布

状态：accepted

范围：候选 live 仍按本文。运行页树、无 overlay 与滚轮见[方案 A 树](./2026-09-10-tui-option-a-tree.md)。内部 Agent 短句见[内部短句主列](./2026-09-10-internal-agent-narrate-spine.md)。

目标见[操作者画布](../../plan/reprise-tui-operator-canvas.md)与[TUI 阅读](../../plan/reprise-tui-design.md)。延续[正式时间线只投影 UserVisibleTurn](./2026-09-10-user-visible-turn-timeline.md)与[标准 Runtime 事件](./2026-09-09-candidate-runtime-events.md)。

## 问题

正式时间线只投影已校验的 `candidate.user_view_persisted`。候选回合未结算时主列没有公开过程。内部 Agent 的 `assistant_visible` 全文会淹没画布。Claude 的工具过程写在私有 `message.content` 里，TUI 不能拆帧。

## 决定

所有声部共用一条**此刻行**（Codex 的 `Working (Ns)` / Claude Code 默认不展示 thinking，工具另起压缩行）：

- 回合或 invocation 已开、当前没有进行中的工具：`{声部} · working`。
- Pack 或内部 Agent 报告了公开进行中：同一行换成 `{verb} · {leaf}`。
- 可见回复、SEND/DONE、恢复终态落下后，此刻行让位。

候选公开进行中只来自校验过的 `payload.live`（`PublicLiveActivity`）。Claude Adapter 在 `tool_use` 时另写 `runtime.tool_started` 并附 `live`；`visible_output` 仍保存整帧给 Pack 投影终稿。TUI 禁止读取 `message.content`。未带 `live` 的 `tool_started`（例如 MCP 启动）不进主列。内部 Agent 的 `assistant_visible` 只把原文放进 `[o]`，主列仍是 working。

已结算候选正文只来自 `candidate.user_view_persisted`。此刻行不是模型输入。

## 备选方案

**TUI 解析产品私有帧。** 每个产品一套界面，thinking 漏进主列。

**把中间 text 当直播正文。** 与 UserVisibleTurn 双轨。

**无工具时展示独白首句。** 与 Claude Code 默认隐藏 thinking 相反，容易再刷屏。

## 影响

`PublicLiveActivity` 在 `CandidateRuntimeEvent.live`。Claude/Codex `protocol.ts`、`src/tui/timeline.ts`、`src/core/public-live.ts`。Pack API major 仍为 3；`live` 可选。

## 验证

`test/products/public-live-protocol.test.ts`：Claude tool_use 产生 `live.verb=read` 且不含 thinking。`test/tui/timeline.test.ts`：`visible_output` 的 Bash 正文不进主列，`live` 进此刻行。`test/tui/narrative-canvas.test.ts`：`assistant_visible` 标题为 working。反向：`timeline.ts` 出现 `message.content` 则 architecture 测试红。
