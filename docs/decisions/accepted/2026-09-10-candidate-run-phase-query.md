# 决策：候选运行阶段由 Application 事件查询投影

状态：accepted

## 问题

TUI 在 `controller-run.ts` 内独立从事件类型推导阶段，CLI 若再写一份会分叉。

## 决定

活动阶段由 `candidateRunPhaseFromEvent` 投影（recovery / starting / generating / reconnecting）。机器状态与终态由 `candidateRunDisplayFromEvents` 读取 `run.state_changed` 与 `run.outcome_created`（含 awaiting_controller、finalizing、finished、failed、cleanup unknown）。TUI/CLI 只格式化该查询；不得从时间线标题解析 `State:`。结果页的 cleanup/termination 仍以 `RunRecord`/`RunOutcome` 为准。

## 备选方案

**Keep a second phase decoder in the TUI.** CLI would then diverge.

## 影响

TUI 只格式化 Application 查询。

## 验证

`test/application/candidate-run-phase.test.ts` 覆盖活动阶段与终态投影。`test/core/architecture.test.ts` 要求 TUI 导入该查询且 `view-projection.ts` 不解析时间线标题。

