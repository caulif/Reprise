# 决策：Comparison 使用有限 callTimeoutMs

状态：accepted

## 问题

`createHarnessAgents` 曾把 Comparison 的 Session 设为 `timeoutMs: 0`。模型轮次与工具调用没有 Host 级截止时间；浏览器探测等挂起只会拖住整个对照 attempt，操作者看到长期「进行中」。文档还写明不要把 harness `budget.callTimeoutMs` 当成 Comparison 实际超时，与「预算字段存在却不生效」的直觉冲突。

## 决定

Comparison 与 Recovery 一样，构造时使用已有 harness `budget.callTimeoutMs`（默认 `DEFAULT_BUDGET` 的 24 小时）。不新增持久化字段，不提高默认上限。Controller 仍保持 `timeoutMs: 0`。

每轮模型请求、工具执行与整个 Comparison attempt 共用调用方传入的 `AbortSignal`；Host 在有限 `timeoutMs` 下另起截止定时器并并入同一 abort 路径。超时映射为结构化 `failed`（`code: agent_timeout`，`kind: timeout`），不得写成成功报告。调用方取消优先于普通 timeout（先判 `cancelled`）；取消或超时后 `runTurns` / `compare` 不再发起下一轮模型请求，也不走 envelope 修复重试。

## 备选方案

**继续 `timeoutMs: 0`，只靠 shell/浏览器子超时。** 子进程有界也不能结束 Agent 会话；模型可继续发起等价探测。

**新增独立 `comparison.callTimeoutMs` schema 字段。** 与已有 `AgentBudget.callTimeoutMs` 重复；experiment 清单已持久化该字段却未驱动 Session。

**给 Controller 一并接上有限超时。** 长决策会被误杀；[RunPolicy 安全阀](./2026-09-16-runpolicy-target-only-safety-valves.md)已排除给 Controller 单次有限 `timeoutMs`。

## 影响

- [`harness-agents.ts`](../../../src/application/harness-agents.ts)：Comparison `timeoutMs: budget.callTimeoutMs`。
- 事实层：[架构总览](../../architecture/overview.md) 生成区与[执行](../../architecture/execution.md)改为 Comparison 有界、Controller 仍为 0。
- 不改 `AgentBudget` schema；磁盘上的 `comparison.budget.callTimeoutMs` 语义从「仅记录」变为「驱动 Session 截止」。

## 验证

- `test/application/harness-agents.test.ts`：Comparison 等于传入的 `callTimeoutMs`；Controller 仍为 0。
- `test/application/comparison-agent-timeout.test.ts`：超时 → `agent_timeout` 且不再下一轮；用户取消 → `cancelled` 且优先于 timeout；取消后不修 envelope。
- `npm run build` 后跑相关 `node --test`；收尾 `npm run check`。
