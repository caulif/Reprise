# 决策：Comparison 每次 attempt 一个连续 Session

状态：accepted

目标批次见 [M4](../../plan/reprise-refactoring-execution.md#6-m4comparison-单-session-与独立执行)。取代 [双 session attempt](../superseded/2026-09-05-comparison-two-phase-attempts-and-pi-media.md)。Pi 原生媒体块、attempt 目录、原子发布与只读封存挂载仍有效。

## 问题

强制 Planner/Reporter 双 Session 会为同一次对照创建两套对话、两份阶段输入快照和阶段交接状态。这与「一次 attempt 一个连续 Session、内部可多次 Invocation」冲突，也让独立对照入口依赖规划/报告两段调用。

## 决定

- 每次对照创建新的 `comparison-attempts/{attemptId}`，并只创建一个 Comparison Session。调查、`work/comparison-plan.md` 工作笔记、`report.html` 与信封修复都在该 Session 内完成。
- 应用入口只调用 `compare()`。不同 `attemptId` 不共享 Session。
- 输入来自冻结历史、终态 RunRecord/事件，以及封存候选快照。`candidate/` 挂载完成的 `snapshots/{runId}`；未完成快照挂 `candidate-snapshot-unavailable`，不挂活动 `runs/{runId}`。
- 对照不依赖原运行进程、内存 RecoveryAttempt、活动 Runtime 或原产品插件。候选结束后可 `runComparison` / `attachExperimentComparison` 发起新 attempt。
- 调用前写入 `comparison.requested` 输入快照。成功 HTML 从本 attempt 原子发布到实验根；失败或取消写 `comparison-failure.html`，不覆盖此前成功的 `report.html`。
- 报告须区分任务结果、协议/恢复限制与配置差异（产品、工具、策略、沙箱、网络、模型族），不得把这些差写成纯模型能力。
- Pi 适配层仍保留原生 text/image 块、`model.input` 能力说明，以及路径/写入/隐私由工具工厂决定。

旧日志中的 `comparison.plan_requested` / `comparison.report_requested` 仍可按原 schema 校验读取；新路径不再写入它们。

## 备选方案

**保留可选 plan/report 双入口。** 真实路径仍有第二套 Session 契约，阶段交接与双快照会继续约束实现。

**把工作笔记注册成不可变 artifact。** 会抬高临时推理状态的权威性。

## 影响

提示词与应用调用链从双阶段改为单 Session。历史双阶段事件只读。审计仍不保存 base64、凭据或完整敏感 payload。

## 验证

`test/comparison-agent-phases.test.ts`：一次 `compare()` 创建一次 Session 并顺序四次委托，不同 attempt 隔离；取消不改候选 outcome。`test/codex-experiment.test.ts`：候选结束后独立对照；新路径无阶段事件；失败 attempt 不覆盖成功报告。`test/scene-seal.test.ts`：未完成快照不挂活动 run。`npm run check` 必须通过。
