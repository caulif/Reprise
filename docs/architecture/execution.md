# 执行：Controller 与 CandidateRun

执行由 application workflow 编排，`CandidateRun` 是候选运行唯一状态机。Controller 是内部 Agent，会话输入和工具调用均由 Host 装配并写入事件；被测 Runtime 是 Product Pack 创建的外部 Runner。

## CandidateRun 生命周期

CandidateRun 构造之前由 [`ExperimentStartup`](../../src/application/experiment-startup.ts) 接纳候选请求：先无副作用校验 ID、路径、attempt 与 TaskCase 冻结快照，再取得实验 writer，校验并无覆盖保存固定场景身份和 case，最后提交 RunAttempt 接纳；activity/control 发布、Agent 初始化、Runtime 校验、baseline、工作区和启动上下文准备随后执行。固定身份或既有 case 冲突在 Agent/probe 和新 run 事实之前拒绝并释放 writer；接纳前残留的 case/spec 不能认证 run。相同实验的竞争请求在写入自己的 attempt 或准备资源之前拒绝；相同 run ID 不用作新的启动。该 admission 不是第二份候选状态机。

构造前失败通过 `run.startup_failed` 与 run 目录内不可变的 `startup-failure.json` 保存诊断阶段、失败或取消、原始错误及清理错误，字段以[启动 schema](../../src/core/schemas/run-startup.ts)为准。它绑定已提交 attempt，不伪造 RunRecord、manifest、Runner 会话或已完成的 Controller；只有文件而未提交事件属于残留，不能作为可信终态。持久化本身失败时调用方收到真实错误，不承诺任何故障都能写入日志。

状态顺序由 [`state-machine.ts`](../../src/core/state-machine.ts) 和 [`candidate-run.ts`](../../src/application/candidate-run.ts) 实现：`created → preparing → launching → awaiting_target ↔ awaiting_controller → finalizing → finished`。取消、准备失败、Runner 失败或策略限制可以从尚未完成的阶段进入 `finalizing`；非法跳转由 `assertTransition` 拒绝。`CandidateRunState` 是这些状态的实现枚举，不把任务判断或 cleanup 当成额外状态。

Host 为每次 start/send 提供带 `runId`、turn index 和 client message id 的身份。Runner 返回 `accepted`、`rejected` 或 `unknown`，并带证据来源；receipt 不等于任务成功。收到 turn settlement 后，Host 记录 completed/failed/waiting_input/aborted 及其置信度，再决定继续、收尾或停止。

`unknown` 直接以 `uncertain.input_delivery` 收尾，不重发。虽然能力类型有查询与重连标志，[TargetRunner](../../src/core/runtime.ts) 没有通用查询或重连方法，文档不承诺自动确认投递。`failed`/`aborted` settlement 终止当前候选；`completed`/`waiting_input` 才可能返回 Controller。后续 send 在 receipt 返回前已经进入 awaiting_target，因此该状态本身不证明投递已被接受。

## Controller 时机与权限

开场消息由 Controller 在 `created` 状态中生成，这是 opening 例外；后续 steering 只在目标 turn settled 后、状态为 `awaiting_controller` 时发生。Controller 通过 Host 工具观察事件、历史要求、候选工作区和 briefing；其协作工具可以对 `project/` 与 notes 写入，也可以执行 managed shell。受控写工具禁止写用户 source、凭据目录或实验事实文件；shell 的命令检查不是全局容器沙箱，外部写入审计不能等同于完备隔离。

Controller 的 decision 经过结构化 schema 校验。工具调用和 decision 结果进入事件审计；模型输出不直接改变 CandidateRun 状态。达到已配置的 wall-clock、Controller call 或其他 run policy 限制时，Host 停止运行并进入收尾。Controller 的 Agent Session 仍使用 `timeoutMs: 0`；Comparison 使用 harness `budget.callTimeoutMs`（默认 24 小时）作为每轮模型/工具调用的有限截止时间，与 attempt 级 `AbortSignal` 共享取消路径。

## 终止与结果

RunOutcome 分别保存任务判断、运行终止和清理结果；调用 Runner.stop 时的 completed/cancelled/failed/shutdown 是停止请求语义，不能替代 RunOutcome 的终止类别。终止时先停止等待和已尝试启动的 Runner，分阶段有界地关闭、捕获 artifacts 和释放环境，最后提交 `RunRecord`。cleanup 的 released、already_released、unknown 等事实不能被简化成任务成功。

构造之前已取得的 Candidate 工作区登记独立释放动作，借用的 Recovery baseline 保留；CandidateRun 接管后的 capture/cleanup 未完成时仍按原协议保留资源，不由外层强行再次释放。activity 按准确对象收尾并在 writer 释放之前撤下 control；重复取消或收尾共享已有动作，外部 AbortSignal listener 在退出时移除。封存记录之后出现的释放错误用 `run.cleanup_failed` 补充，不改写原 record；关键清理或 Store.close 失败会拒绝结果，原始业务错误与各收尾错误一并保留。见[启动所有权决策](../decisions/accepted/2026-10-14-startup-ownership-and-failure.md)。

同一 Experiment 可以有多个 run，Store 的 `operationId` 去重仍是实验级的。Controller、CandidateRun、runtime 和 artifact 等 run 所属操作在写入时由 runId 与局部 ID 派生独立身份；旧日志原样重放。离线 fake Runtime 已验证两次完整运行与副本隔离，真实 Runtime 仍需显式 opt-in 验收；身份取舍见[run 所属操作使用独立身份](../decisions/accepted/2026-09-23-run-operation-identity.md)。

## 配置与证据

候选启动上下文写入 experiment/run 目录，至少绑定 experimentId、runId、产品、请求模型、解析模型、隔离工作区和权限。新 ExperimentSpec v2 只固定 TaskCase 身份；候选、policy 与有效 Harness 配置逐 run 记录，允许后续轮次变化，执行使用本次冻结快照。旧 spec 保留原字节，不能将其中的首次配置当作后续执行事实；旧 v1 case 仅核对当前保留内容，不补历史或 v2 认证。Comparison 使用独立的操作所属配置，不混入候选条件。持久化重比通过中立的已结束运行上下文进入报告层，不构造 Runtime、Controller、CandidateRun 或假 Session；未重建 Controller 决定明确为 not_reconstructed，未记录的起点类别保持未知。契约见[固定实验身份与重比上下文](../decisions/accepted/2026-10-15-fixed-experiment-identity-and-persisted-comparison-context.md)。

实际编排见 [Controller loop](../../src/application/experiment-controller-loop.ts)、[cleanup](../../src/application/candidate-run-cleanup.ts) 和 [Run schema](../../src/core/schemas/run.ts)。已知缺口与完成条件集中在[路线图](../roadmap.md#已知实现问题)。


## 记录字段

<!-- BEGIN GENERATED record-fields (scripts/gen-docs.mjs) — 不要编辑标记之间的内容 -->
### TaskCase

当前新冻结使用 v2；v1 保留原身份，由兼容读端读取。下表为 v2。

| 字段 | 类型 | 可选 |
|---|---|---|
| `schemaVersion` | 2 | 否 |
| `caseId` | string | 否 |
| `source` | object | 否 |
| `evidenceLevel` | "transcript" \| "history" | 是 |
| `initialInput` | object | 否 |
| `execution` | object \| object | 是 |
| `transcript` | object[] | 否 |
| `historicalEvents` | object[] | 否 |
| `baseline` | object | 否 |
| `sourceRuntimeEvidence` | object | 否 |
| `taskContext` | object | 是 |
| `provenance` | object | 否 |
| `privacy` | object | 否 |
| `contentHash` | string | 否 |
| `freezeIdentity` | object | 否 |

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


## Controller 可靠性与执行模式

TaskCase 可显式选择任务完成模式并冻结目标、交付物与授权。该模式首次启动 Candidate 时，Host 在 Controller 开场后补上未逐字包含的冻结目标/交付物、实际副本根目录、已复制外部输入映射、交付位置说明与授权原文；同会话后续消息保持 Controller 原文，新会话重新附上。明确任务授权优先于默认本地操作边界及冲突的仓库惯例，依赖安装不扩大授权。默认不主动本地 commit，不操作云端 PR/issue、不 push 或发布；这只是任务层声明，不是运行权限隔离。完整发送文本经 input.submitted 写入事件，并同步保存 sent-user-messages briefing；controller.decision 保留原始决定。缺失 execution 或显式 historical_simulation 的场景不拼接，继续保留历史信息出现顺序。见[首次交接契约](../decisions/accepted/2026-10-14-candidate-opening-task-contract.md)。

新任务调用方应明确选择完成模式，Host 不从历史答案自动提炼目标。模式与 prompt 随 controller.requested 进入可重建输入；取舍见 [Controller 执行可靠性](../decisions/accepted/2026-10-13-controller-execution-reliability.md)。

Controller 复用 managed 命令 session，轮询只决定何时返回部分输出，不是命令截止。可纠正的参数/路径错误返回拒绝结果，审计和持久化故障保持致命。总时间预算可省略，配置时主动停止进行中的模型和 Candidate；预算、用户与监督器停止分别记录。未启动 Runner 的清理不会伪造停止生命周期。

收尾的 stop、close、capture、release 分阶段可观察并有独立截止。capture 超时保留 unknown、剩余资源和工作树；不把晚到结果加入已结束记录。封存可省略由清单、锁文件及安装/编译器标记共同确认的可重建目录，记录恢复命令；明确保留的交付路径不省略。指纹和执行树保留原语义，快照完整状态只针对声明的封存策略。

candidate.progress_checkpoint 绑定会话、最近投递确认和下一步；实时进展只投影真实工具事件、后台命令和已有 diff。无事件不是模型失败证据。未知投递不重发。当前没有跨进程自动重连/投递查询，Claude 的 reconnectSession 为 false；checkpoint 不等于已支持进程重启续跑。

RunManifest.environment.executionIsolation 记录 Pack 声明，旧 Pack 未声明为 unknown，内置 Pack 为 unrestricted。当前任意 shell 可以读取工作区之外可读内容，不能保证 Host 私有历史与答案的读取隔离或盲测公平性。禁止凭据读取等工具检查继续有效，但不是 OS 沙箱。
