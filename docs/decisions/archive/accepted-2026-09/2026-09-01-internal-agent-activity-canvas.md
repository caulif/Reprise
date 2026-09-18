# 决策：内部 Agent 运行画布的压缩与分轨

状态：accepted

## 问题

Recovery / Controller / Comparison 的工具事件曾一律标成 Harness，非错误 Harness 行和 `Decision:` 行又被画布丢掉。操作者只看到「Recovery tool · powershell」或紫盒投递，不知道内部 Agent 在调查、改盘还是写报告。

## 决定

- `agent.tool_*` 按已持久化的 `payload.role` 分轨。调查工具默认可见但连续合并；`powershell` / `edit` 一行带动词和叶名；`write` 单独一行。stdout、SteeringContext、ComparisonContext 和决策 JSON 原文不进默认行。
- Controller 工具与 `Decision:` 使用品红声部，不进入 Target 青色。真正发给产品的话仍是 `Input to Target`。
- Comparison 使用绿色声部，出现在候选对话之后。对照进行中标题为写报告，不继续显示「候选运行中 · 第 N 轮」。
- `agent.context_compacted` 折成 `compact ×N`。identical-input 失败仍隐藏。不伪造 hidden reasoning。
- 阶段条由最近可见工具类推导，不新增事件类型。

## 备选方案

**继续只露出 write/edit/powershell。** 调查过程不可见。

**把内部 Agent 工具画进 Target 青色。** 操作者会以为候选在读历史会话。

**默认展开工具 stdout。** 与 Grok / Pi / Codex / Claude Code 的压缩主视图相反，恢复删除命令会刷屏。

## 影响

[TUI §4.1](../../product/tui.md#41-主活动时间线) 的投影与声部。[TUI §4.2](../../product/tui.md#42-决策与实际输入) 的决策与投递分轨。实现：`src/tui/timeline.ts`、`src/tui/agent-activity.ts`、`src/tui/scrollback.ts`。

## 验证

`test/timeline.test.ts` 与 `test/agent-activity-canvas.test.ts`：recovery `ls` 可见且不含正文；连续 inspect 合并；controller `read_observation` 不是 product 声部；`Decision: SEND` 与 `Input to Target` 分开；comparison `write report.html` 可见。反向：把 controller 工具再标成 Target 青色或再隐藏 `ls`，测试红。
