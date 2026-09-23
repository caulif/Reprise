# 执行：Controller 与 CandidateRun

执行由 application workflow 编排，`CandidateRun` 是候选运行唯一状态机。Controller 是内部 Agent，会话输入和工具调用均由 Host 装配并写入事件；被测 Runtime 是 Product Pack 创建的外部 Runner。

## CandidateRun 生命周期

状态顺序由 [`state-machine.ts`](../../src/core/state-machine.ts) 和 [`candidate-run.ts`](../../src/application/candidate-run.ts) 实现：`created → preparing → launching → awaiting_target ↔ awaiting_controller → finalizing → finished`。取消、准备失败、Runner 失败或策略限制可以从尚未完成的阶段进入 `finalizing`；非法跳转由 `assertTransition` 拒绝。`CandidateRunState` 是这些状态的实现枚举，不把任务判断或 cleanup 当成额外状态。

Host 为每次 start/send 提供带 `runId`、turn index 和 client message id 的身份。Runner 返回 `accepted`、`rejected` 或 `unknown`，并带证据来源；receipt 不等于任务成功。收到 turn settlement 后，Host 记录 completed/failed/waiting_input/aborted 及其置信度，再决定继续、收尾或停止。

`unknown` 直接以 `uncertain.input_delivery` 收尾，不重发。虽然能力类型有查询与重连标志，[TargetRunner](../../src/core/runtime.ts) 没有通用查询或重连方法，文档不承诺自动确认投递。`failed`/`aborted` settlement 终止当前候选；`completed`/`waiting_input` 才可能返回 Controller。后续 send 在 receipt 返回前已经进入 awaiting_target，因此该状态本身不证明投递已被接受。

## Controller 时机与权限

开场消息由 Controller 在 `created` 状态中生成，这是 opening 例外；后续 steering 只在目标 turn settled 后、状态为 `awaiting_controller` 时发生。Controller 通过 Host 工具观察事件、历史要求、候选工作区和 briefing；其协作工具可以对 `project/` 与 notes 写入，也可以执行受边界限制的 shell。受控写工具禁止写用户 source、凭据目录或实验事实文件；shell 的命令检查不是全局容器沙箱，外部写入审计不能等同于完备隔离。

Controller 的 decision 经过结构化 schema 校验。工具调用和 decision 结果进入事件审计；模型输出不直接改变 CandidateRun 状态。达到 wall-clock、Controller call 或其他 run policy 限制时，Host 停止运行并进入收尾。Controller 的 Agent Session 仍使用 `timeoutMs: 0`；Comparison 使用 harness `budget.callTimeoutMs`（默认 24 小时）作为每轮模型/工具调用的有限截止时间，与 attempt 级 `AbortSignal` 共享取消路径。

## 终止与结果

RunOutcome 分别保存任务判断、运行终止和清理结果；调用 Runner.stop 时的 completed/cancelled/failed/shutdown 是停止请求语义，不能替代 RunOutcome 的终止类别。终止时先停止等待和 Runner，再捕获允许的 artifacts，释放隔离环境，最后提交 `RunRecord`。cleanup 的 released、already_released、unknown 等事实不能被简化成任务成功。

同一 Experiment 可以有多个 run，Store 的 `operationId` 去重仍是实验级的。Controller、CandidateRun、runtime 和 artifact 等 run 所属操作在写入时由 runId 与局部 ID 派生独立身份；旧日志原样重放。离线 fake Runtime 已验证两次完整运行与副本隔离，真实 Runtime 仍需显式 opt-in 验收；身份取舍见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

## 配置与证据

候选启动上下文写入 experiment/run 目录，至少绑定 experimentId、runId、产品、请求模型、解析模型、隔离工作区和权限。实验配置的保存与执行目前没有完整冻结闭环：相同 experiment ID 的冲突 spec 可能被静默忽略，而 workflow 仍读取当前 Harness 配置。Comparison 可使用独立的已记录配置，不应把它混入候选条件。

实际编排见 [Controller loop](../../src/application/experiment-controller-loop.ts)、[cleanup](../../src/application/candidate-run-cleanup.ts) 和 [Run schema](../../src/core/schemas/run.ts)。已知缺口与完成条件集中在[路线图](../roadmap.md#已知实现问题)。


## 记录字段

<!-- BEGIN GENERATED record-fields (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
### TaskCase

| 字段 | 类型 | 可选 |
|---|---|---|
| `schemaVersion` | integer | 否 |
| `caseId` | string | 否 |
| `source` | object | 否 |
| `evidenceLevel` | "transcript" \| "history" | 是 |
| `initialInput` | object | 否 |
| `transcript` | object[] | 否 |
| `historicalEvents` | object[] | 否 |
| `baseline` | object | 否 |
| `sourceRuntimeEvidence` | object | 否 |
| `taskContext` | object | 是 |
| `provenance` | object | 否 |
| `privacy` | object | 否 |
| `contentHash` | string | 否 |

### RunRecord

| 字段 | 类型 | 可选 |
|---|---|---|
| `attempt` | object | 否 |
| `manifest` | object | 是 |
| `state` | "finished" | 否 |
| `stageReached` | "created" \| "preparing" \| "launching" \| "awaiting_target" \| "awaiting_controller" | 否 |
| `outcome` | object | 否 |
| `trace` | object | 否 |
| `session` | object | 是 |
| `artifactRefs` | object \| object[] | 否 |
| `warnings` | object[] | 否 |
<!-- END GENERATED record-fields -->

