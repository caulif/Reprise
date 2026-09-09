# 决策：Provider 无关 AgentHost 与 Pi 薄适配

状态：accepted

延续 [Session 事实源](./2026-09-08-session-fact-owner-and-identity.md) 与 [内部 Agent 对齐 Pi 循环](./2026-09-02-internal-agent-pi-alignment.md)。实施计划见 [Agent 基座重构](../../plan/agent-foundation-refactor-plan.md)。

## 问题

Controller、Comparison、Recovery 共用模型执行底座，但公共类型与工厂以 Pi 命名，业务 Agent 直接面对 `PiAgentHost` / `PiTextCaller`。工具调度曾默认并行。若继续把 Pi 类型当作 Host 契约，替换 Provider 或升级 Pi 会改动三个业务模块。

## 决定

公共执行边界是 `AgentHost` / `AgentSession`：`work()` 做自由调查且不 JSON repair，`request()` 做 Schema 校验与有界 repair。同一 Session 同时最多一个 Invocation；并发返回 `concurrent_invocation`，不排队。取消后关闭 Session；`close` 幂等。

首版通过 `PiProviderAdapter` 复用 `@earendil-works/pi-agent-core@0.84.1` 与 `@earendil-works/pi-ai@0.84.1` 的公开 `Agent`（MIT）。固定 `toolExecution: "sequential"`。禁止把 `AgentHarness.prompt` / `compact` / `resume` 当作执行或持久化入口。测试可用 `FakeProviderAdapter`，不访问真实 Provider。

Pi 包许可证为 MIT；升级前先跑基座回归。Experiment `events.jsonl` 仍是唯一事实源。`infrastructure/agent` 不导入 application 业务模块。

## 备选方案

**继续以 `PiAgentHost` 为公共契约。** 三个业务 Agent 锁死 Pi 类型，无法替换 Adapter。

**复制完整 Agent loop。** 与已锁定的公开 `Agent` 重复，且难跟上游 compaction/事件。

**把业务轮次放进底座。** Controller 结算、Comparison 四轮、Recovery 三轮会污染可替换的执行层。

## 影响

业务 Agent 只依赖 Host 的 work/request、工具定义和 Invocation 结果。Pi 命名留在 `providers/pi/` 与兼容别名 `PiAgentHost`。压缩、图片 artifact 与事件复原仍走现有 Experiment 日志与附件。

## 验证

`test/agent-foundation.test.ts`、`test/agent-session-lifecycle.test.ts`、`test/architecture.test.ts`（禁止 AgentHarness、顺序执行、agent 不导入 application）。`npm run check` 必须通过。
