# 决策：Controller 用 briefing 目录与 INDEX.md，不用 JSON 内联历史正文

状态：accepted
日期：2026-09-03

## 问题

每轮把 `historicalUserTurns` 与 `baseline.finalMessage` 编进 `SteeringContext` JSON，与开口写在同一次生成里，对照容易变成开场摊后文或种类对齐即停。实验条件要求完整可访问，实现却是每轮灌全文。

## 决定

- Host 在 `{experimentRoot}/runs/{runId}/controller-briefing/` 写入 INDEX、history、本 run 回合文件。该目录不得位于隔离副本内。
- 每次 Controller `append` 的用户消息是固定决策段加 INDEX.md 全文，不含 transcript 正文、不含 `baseline.finalMessage`。
- 每个 CandidateRun 一个 Controller Pi session；结算后对该 session `append`。prompt 写明以磁盘文件为准。
- Host 不因本轮零 `read` 或未用历史用户句拒绝 `done`。
- `outline.tsv` 的 `after_first_deliverable`：该行之前 transcript 里已出现非空助手可见文本则为 1。纯函数，不调用模型。
- `controller.requested` snapshot 含 `promptContent`、`briefingRoot`、所列文件 hash；`inputDigest` 覆盖该对象。
- Controller 决策次数上限是 `ExperimentSpec.controller.budget.maxCalls`（未设置则不按次数截断）。`RunPolicy.maxModelCalls` 只约束 Target。

## 备选方案

**继续内联 historicalUserTurns。** 开口与知情混装。

**每轮新建 Controller session。** 审计更干净，费用高。

**零 read 则拒绝 done。** 改变 Host 不拒绝 `done` 的边界。

## 影响

[Controller 设计](../../architecture/controller.md)、[实验条件](../../architecture/controller-experiment-conditions.md) §5–6。[落地计划](../../plan/controller-path-briefing.md)。

## 验证

- `test/controller-briefing.test.ts`：outline、INDEX、briefing 不在副本、开场 prompt 不含交付后用户句。
- `test/controller-full-session-judgment.test.ts`：append 正文含 INDEX、不含后文全文。
- `test/codex-experiment.test.ts`：`maxCalls` 耗尽记 `limit.controller_calls`；`maxModelCalls` 不再截断 Controller。
- `test/architecture.test.ts`：Controller 七工具。
