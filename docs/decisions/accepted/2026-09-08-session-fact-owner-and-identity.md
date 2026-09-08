# 决策：Session 事实源与身份草案

状态：accepted

延续 [内部 Agent 对齐 Pi 循环](./2026-09-02-internal-agent-pi-alignment.md)。目标批次见 [M1.1](../../plan/reprise-refactoring-execution.md#m11-建立基线并验证-pi-的实际能力)。

## 问题

内部执行同时面对三类可选存储：Pi `Agent` 内存 transcript、Pi `JsonlSessionRepo` / `AgentHarness` 会话文件、Reprise Experiment `events.jsonl`。若把类型导出或高级 API 声明当成已实现能力，会出现第二套 Session 写者，也无法区分 Session 与单次 Invocation。

## 决定

锁定依赖 `@earendil-works/pi-agent-core` 0.84.1。执行循环只使用公开 `Agent`：`prompt`、工具调度、`subscribe` 事件、`abort`/`waitForIdle`，以及已接入的 `prepareCompaction`/`compact`。`AgentHarness.prompt`、`compact`、`resume` 在该版本抛出 `HarnessNotImplemented`，不得作为写入或重开路径。

唯一持久化所有者是 Experiment 的 `events.jsonl`，由 [ExperimentStore](../../../src/infrastructure/store/experiment-store.ts) 顺序写入。Pi 内存 transcript 只是当次 Invocation 的工作集；压缩只改后续模型输入，不另建权威 JSONL。Host audit sink 写入同一份实验日志，不引入平行 transcript。

身份草案（供 M1.2–M1.3 落地，不改变现有磁盘字段直到那些步骤提交）：

- **Session**：稳定 ID；创建时固定角色、模型配置快照、prompt/工具策略版本；同一时间最多一个活动 Invocation。
- **Invocation**：harness 对 Host `request` 的一次投递，拥有稳定 ID 与取消信号；内部可含多次 provider 请求、工具、压缩与输出修复。
- **message**：保留文本/图片/工具块，不压成纯字符串。
- **tool call / tool result**：用 `toolCallId` 配对。
- **request**：Invocation 内的一次 `streamSimple`/`completeSimple` 调用。

Session 关闭与 Invocation 完成分开表达。并发重入必须拒绝或串行，不允许消息交错。

## 备选方案

**以 Pi `JsonlSessionRepo` 为 Session 真相。** 与实验事件日志分叉，且当前 Host 并未接入该写者。

**把 `AgentHarness` 当作执行与存储入口。** 0.84.1 的 `prompt`/`compact`/`resume` 仍是占位实现。

**继续只存长度与 digest。** 无法从空进程重建模型输入，堵住 M1.3。

## 影响

M1 可以在不更换执行库的前提下补 Invocation 身份与完整模型输入。代价是压缩后的工作集不能还原被切历史正文，完整历史必须由实验事件（及受控附件）承担。磁盘事件字段的扩展仍属 M1.3。

## 验证

`test/pi-agent-loop-baseline.test.ts`：公开 `Agent` 完成工具往返并保留原生块与事件顺序；挂起流上 `abort` 得到 `aborted`；`PiModelCaller` 把 `contentBlocks` 交给下一轮模型请求；`AgentHarness.prompt`/`compact`/`resume` 抛出未实现；`src/` 不引用 `AgentHarness` 或 `JsonlSessionRepo`。既有 `test/pi-session-reliability.test.ts` 与 `test/session-compact.test.ts` 继续覆盖 Host 重试、取消退避和压缩。
