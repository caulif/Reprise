# CandidateRun 结果与终止协议

本文约束当前实现。未关闭验收见 [MASTER](../progress/MASTER.md)。

状态：当前模块设计

本文定义一次 `CandidateRun` 结束后如何表达任务判断、终止原因、技术故障和资源清理结果。公共类型与七状态模型以[架构总览](./overview.md)为准；本文细化这些类型的生成规则、约束和用户展示。

## 1. 设计结论

七状态模型描述运行处于哪里，`RunOutcome` 描述运行最终发生了什么。两者不能混用。

结果协议只回答三个问题：

1. 从已有证据看，任务完成了吗；
2. CandidateRun 为什么停止；
3. Harness 自有资源是否清理完成。

匹配程度继续由 `FidelityAssessment` 表达；耗时、token、成本和工具调用属于遥测；输入是否被接收属于单次 `DeliveryReceipt`；非致命异常属于 trace incident。它们都不扩张 `RunOutcome`。

```ts
interface RunOutcome {
  task: TaskAssessment;
  termination: RunTermination;
  cleanup: CleanupResult;
}
```

`EvidenceRef` 使用架构总览定义的稳定不透明引用，可指向 trace event 或 artifact。模块只能引用已经持久化的事实，不能把解释性文字伪装成 evidence。

`RunOutcome` 不是新的服务或 Agent Module。Controller 提供任务判断，Runtime、Environment 和 Trace 提供事实，Run Orchestrator 在 `finalizing` 中组合并固化结果。Comparison 只能读取，不能回写。每个结果至少引用在 `created` 阶段已提交的 `RunAttempt`；只有 Runtime、模型和 Environment 准备成功的运行才包含完整 `RunManifest`，因此 preparation failure 也能形成合法且可追溯的终态记录。

## 2. TaskAssessment

```ts
interface TaskAssessment {
  status:
    | "apparently_completed"
    | "incomplete"
    | "indeterminate"
    | "not_assessed";
  decidedBy?: "controller";
  evidenceRefs: EvidenceRef[];
}
```

- `apparently_completed`：Controller 根据目标输出、环境变化和已有证据判断任务看起来已经完成。它不是形式化验收或统一评分。
- `incomplete`：Controller 已观察到有效运行，并判断目标尚未完成、被阻塞或继续没有价值。
- `indeterminate`：已有有意义的目标执行，但现有证据不足以判断是否完成。
- `not_assessed`：尚未进入可评估阶段，例如环境无法准备、Runtime 启动失败或初始输入在执行前被拒绝。

Runtime 的 turn `completed` 只表示当前 turn 到达稳定边界，不能推导任务完成。Comparison 可以展示更多结果证据，但不能事后修改 `TaskAssessment`。

Controller 是唯一进行任务语义判断的组件。Orchestrator 只能在没有有效 Controller 判断时，根据“是否已经产生可评估执行”填写 `indeterminate` 或 `not_assessed`；它不能自行判断任务质量或完成度。

### 2.1 Controller 决策映射

不增加额外的“最终评估”Agent 调用。Orchestrator 使用最后一个已持久化的有效 Controller 决策：

| 最后有效事实 | TaskAssessment.status |
|---|---|
| `done/satisfied` | `apparently_completed` |
| `done/blocked` | `incomplete` |
| `done/requires_real_user_decision` | `incomplete` |
| `done/no_further_value` | `incomplete` |
| 最后决策为 `send`，随后达到预算 | `incomplete` |
| Target 已有有效执行，但 Controller 未能形成判断 | `indeterminate` |
| Target 尚未产生可评估执行 | `not_assessed` |

如果完成目标本身需要真人授权，`requires_real_user_decision` 表示任务尚未完成；如果任务已完成、只是额外动作需要授权，Controller 应选择 `satisfied`。

## 3. RunTermination

Core 只稳定定义少数终止性质，具体原因使用 namespaced `code` 表达：

```ts
interface RunTermination {
  kind:
    | "completed"
    | "limit_reached"
    | "stalled"
    | "cancelled"
    | "blocked"
    | "failed"
    | "uncertain";
  code: string;
  initiatedBy: "target" | "controller" | "user" | "harness";
  failure?: RunFailure;
}
```

- `completed`：目标满足，CandidateRun 正常结束。
- `limit_reached`：达到时间、turn、模型调用、token 或成本等硬预算。
- `stalled`：尚未达到硬预算，但连续无进展，继续执行预计没有价值。
- `cancelled`：用户或 Harness 明确请求取消。
- `blocked`：必要前提无法满足，但组件本身没有崩溃，例如需要真人授权或无法建立安全环境。
- `failed`：Runtime、Controller、Environment、Harness 或其必要依赖发生技术故障。
- `uncertain`：关键副作用是否发生无法确认，继续可能造成重复操作；第一版只用于无法核查的输入 delivery。

`code` 使用 `<kind>.<reason>`；产品特有扩展使用产品前缀，但仍映射到 Core `kind`。第一版不建立 code registry 或动态注册机制。

```text
completed.controller_satisfied
completed.target_terminal

limit.wall_clock
limit.target_turns
limit.model_calls
limit.tokens
limit.cost
limit.turn_timeout

stalled.no_progress
stalled.no_further_value

cancelled.user
cancelled.harness_shutdown

blocked.real_user_approval
blocked.target
blocked.environment_unsupported
blocked.runtime_unavailable
blocked.credentials_unavailable

failed.runtime_launch
failed.runtime_execution
failed.controller
failed.environment
failed.harness
failed.external_dependency

uncertain.input_delivery
```

原生 Codex、Claude Code 或其他 Runtime 原因保存在规范化事件和 raw artifact 中，不直接扩张 Core 联合类型。`termination.code` 对 Runtime 技术故障保持 `failed.runtime`；细分类只写在 `termination.failure.code`。

### 3.1 Controller 与系统事件映射

| 终止事实 | kind | code |
|---|---|---|
| Controller `done/satisfied` | `completed` | `completed.controller_satisfied` |
| Controller `done/blocked` | `blocked` | `blocked.target` |
| Controller `done/requires_real_user_decision` | `blocked` | `blocked.real_user_approval` |
| Controller `done/no_further_value` | `stalled` | `stalled.no_further_value` |
| 连续达到无进展阈值 | `stalled` | `stalled.no_progress` |
| 达到某项硬预算 | `limit_reached` | 对应 `limit.*` |
| 用户主动取消 | `cancelled` | `cancelled.user` |
| 运行前提不成立 | `blocked` | 对应 `blocked.*` |
| 组件技术故障 | `failed` | 对应 `failed.*` |
| 输入 delivery 无法核查 | `uncertain` | `uncertain.input_delivery` |

`termination.code` 是 Harness 级规范化停止原因；`failure.code` 是更具体的诊断代码，例如 `process_exited_before_admission`。两者粒度不同，不要求使用相同字符串。

## 4. RunFailure

只有技术故障导致 CandidateRun 终止时才存在 `RunFailure`：

```ts
interface RunFailure {
  origin:
    | "runtime"
    | "controller"
    | "environment"
    | "harness"
    | "external_dependency"
    | "unknown";
  code: string;
  message: string;
  evidenceRefs: EvidenceRef[];
}
```

`RunFailure` 不保存 `phase`：失败发生时的七状态和因果链已经存在于 trace。它也不声明 `retryable`：能否重试取决于操作幂等性、delivery、外部副作用、当前状态和剩余预算，不是错误本身的固定属性。

非致命 warning、成功恢复的 Harness 中断、缺失的非关键遥测等只写 incident 事件；它们不产生 `RunFailure`，也不需要持久化一个容易重复表达的 `InfrastructureStatus`。

## 5. CleanupResult

```ts
interface CleanupResult {
  status: "not_needed" | "complete" | "incomplete" | "unknown";
  remainingResourceIds: string[];
  evidenceRefs: EvidenceRef[];
}
```

- `not_needed`：本次运行没有创建需要释放的 Harness-owned 资源；
- `complete`：所有应释放资源均已确认释放；
- `incomplete`：已知仍有 Harness-owned 资源未释放；
- `unknown`：无法确认资源是否已经释放。

CandidateRun 等待 `TargetRunner.stop()` 的上限为 `cleanupTimeoutMs`（缺省 10 秒）。超时将 `cleanup.status` 记为 `unknown`，`remainingResourceIds` 含 `runtime`，并写入 `runtime.stop_failed`（`reason: cleanup_timeout`）。超时后仍可尝试释放环境，但不得把 cleanup 记为 `complete`。

不再区分 `partial` 与 `failed`。对用户和后续程序而言，两者都意味着清理未完成；严重程度由 `remainingResourceIds` 指向的资源类型和 evidence 展示。

Environment Provider 的 `ReleaseResult` 是清理输入事实，Run Orchestrator 将它与 Runtime process、订阅和其他 Harness-owned 资源的清理事实合并为一个 `CleanupResult`。清理失败不能覆盖任务判断或原终止原因。

## 6. Delivery 与 Runtime stop

Delivery 继续是每次 `start/send` 的操作级事实：

```text
accepted → 正常推进
rejected → 按明确错误处理
unknown  → 核查旧 message/turn；仍未知则结束且禁止重发
```

只有最后一种情况投影为：

```ts
{
  kind: "uncertain",
  code: "uncertain.input_delivery",
  initiatedBy: "harness"
}
```

`TargetRunner.stop()` 接收的是窄控制指令，不是运行结果：

```ts
type RuntimeStopReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "shutdown";
```

Runtime 不需要理解 Harness 的 approval、预算或 fidelity 语义；Product Pack 只把该控制意图映射到目标产品的原生 interrupt、stop 或进程终止能力。

## 7. 与七状态模型的关系

终止事实可以在任意活动状态产生，但所有路径都先进入 `finalizing`：

```text
活动状态
→ 持久化触发停止的事实
→ finalizing
   → stop Runtime
   → final fingerprint
   → release Harness-owned resources
   → 固化 RunOutcome
→ finished
```

`finalizing` 不重新执行任务、不追加用户输入，也不启动 Comparison。若进程在收尾中崩溃，恢复逻辑根据已持久化事实和外部状态继续幂等清理；不能补猜没有发生的 Controller 判断。Runtime 已确认停止，或无法确认其状态的事实已固化为 `uncertain`/cleanup unknown 后，均可进入 `finished`；否则 run 会永久卡在无法恢复的 `finalizing`。

## 8. 不变量

```text
termination.kind == "failed"
⇒ failure 必须存在

termination.kind != "failed"
⇒ failure 必须不存在

task.status == "not_assessed"
⇒ 没有形成有效的 Controller 任务判断

cleanup 不能覆盖 task 或 termination
fidelity 不能改写 task 或 termination
Comparison 和 Renderer 不能修改 RunOutcome
manifest 存在 ⇒ stageReached 至少为 launching
manifest 不存在 ⇒ task.status 必须为 not_assessed
finished 后的 late event 不能改写 RunOutcome
```

环境不完全匹配但允许安全探索时，运行照常产生 outcome，并由 `FidelityAssessment.comparisonClass = "exploratory"` 说明条件。当前执行 Runtime 的意外变化使用 `runtime_drift` warning 表达，不改写 outcome 或 comparisonClass；只有无法安全启动时才以 `blocked.*` 结束。

## 9. 默认用户展示

领域模型保持严谨，默认报告只展示最有用的信息：

```text
任务结果：看起来已完成
停止原因：Controller 判断目标已经满足
对照条件：探索性
```

```text
任务结果：未完成
停止原因：达到 30 分钟运行上限
对照条件：严格
```

```text
任务结果：未获得模型表现
停止原因：Codex 在接收初始输入前退出
清理结果：已完成
```

只有 `cleanup.status` 为 `incomplete` 或 `unknown` 时才突出清理警告。具体 failure code、原生错误和 evidence 默认进入诊断详情，而不是占据比较报告主体。

## 10. 持久化记录字段

<!-- BEGIN GENERATED record-fields (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
### TaskCase

| 字段 | 类型 | 可选 |
|---|---|---|
| `schemaVersion` | integer | 否 |
| `caseId` | string | 否 |
| `source` | object | 否 |
| `evidenceLevel` | "transcript" | "history" | 是 |
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
| `stageReached` | "created" | "preparing" | "launching" | "awaiting_target" | "awaiting_controller" | 否 |
| `outcome` | object | 否 |
| `trace` | object | 否 |
| `session` | object | 是 |
| `artifactRefs` | object | object[] | 否 |
| `warnings` | object[] | 否 |
<!-- END GENERATED record-fields -->

## 11. 验收条件

- 生命周期状态、任务判断、终止原因、fidelity 和 cleanup 不混用；
- Runtime turn 完成不会自动变成任务完成；
- 预算、无进展、取消、阻塞、技术失败和 delivery unknown 可以被区分；
- Runtime/Controller/Harness 故障不会被误报为模型任务失败；
- cleanup 失败不会覆盖已经形成的任务结果；
- 新 Product Pack 可以保留原生原因，而无需修改 Core `kind`；
- Comparison 与 Renderer 只能读取结果，不能改变结果。
