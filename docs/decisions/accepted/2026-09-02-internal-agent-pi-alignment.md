# 决策：内部 Agent 对齐 Pi 循环

状态：accepted

取代 [轮间 digest 占位](../superseded/2026-08-31-internal-agent-turn-compaction.md)。修订 [候选选择与信息增益](../superseded/2026-08-19-recovery-candidate-selection-and-information-gain.md) 中关于重复工具调用与 `maxToolCalls` 的历史条款。

## 问题

内部 Agent 用 `pi-agent-core` 的 `Agent`，但把同批工具钉成全顺序、用自研 digest 压旧 tool 正文、再用 Host 次数预算和相同输入拦截截断 Recovery。这些与 Pi 已导出的并行调度、`prepareCompaction`/`compact`、overflow/retry 重复且冲突：次数预算在压缩之前就把调查掐死；digest 试卷也无法用 Pi 的 structured summary 表示「模型当时看见什么」。

## 决定

内层继续用 `Agent`（`PiModelCaller`），不上 `AgentHarness`、不上 Pi JSONL session 当实验真相、不换 Pi 默认 bash/read/write 工具。工具仍是 Reprise 的八件套，注册进 `Agent`。

同批工具：全局 `toolExecution: "parallel"`；`edit`/`write`/`powershell` 标 `executionMode: "sequential"`。读类不标 sequential。一批里只要出现写类，Pi 把整批改成顺序执行。不自写调度器。

上下文：调用 `prepareCompaction` / `compact` / `shouldCompact` / `estimateContextTokens`。`shouldStopAfterTurn` 在 turn 后按 Pi 阈值压缩；overflow 用 `isContextOverflow` 后 compact，若末条是 user/toolResult 再 `continue()`。流式请求走 Pi 的 `maxRetries`。`append` 在 `abort` 之后 `waitForIdle`。openai-compatible 模型可配置 `contextWindow` / `maxTokens`，缺省 128k/16k。工具 parameters 经 JSON 克隆后再交给 Pi 的 typebox 校验。

可复原定义是试卷：事件日志复原那一次请求实际送给模型的上下文（compaction summary + retained tail），不还原被切掉的 tool 正文。`agent.context_compacted` 记录 summary、tokensBefore、retainedCount。工具全文仍写 `agent.tool_completed`。Host 信封 repair 与 loop 内 `continue()` 分开。ExperimentStore 仍是唯一实验日志。

内部 Agent 不再用工具调用次数、completion 次数、破坏性次数或「相同输入无信息增益」拦截截断。CandidateRun 墙钟等实验策略与 forensics 的 hypothesis 搜索预算仍独立存在。TUI 不隐藏这类历史失败文案。

## 备选方案

**自写读并行写顺序调度器。** 与 Pi 批内规则重复，且要自己处理 toolResult 顺序。

**继续 digest 占位。** 不是 Pi 的 cut+summary+tail；无法作为选 A 的试卷。

**改用 `AgentHarness` 或 Pi 默认文件系统工具。** 会把实验真相和 Windows 工作区边界交给 Pi 应用壳。

**保留 maxToolCalls 与重复输入拒绝。** 在压缩之前截断调查，且 Pi 没有这条约定。

## 影响

上下文压力交给真实窗口与 Pi 压缩，长调查不再被 64 次调用提前杀死。压缩后无法从试卷还原被切历史；审计依赖 `agent.tool_completed`。openai-compatible 未填窗口时仍用 128k/16k 缺省，可能与上游真实窗口不一致。

## 验证

`test/session-compact.test.ts`：`needsPiCompaction` 跟随 usage；`compactPiMessages` 产出 `compactionSummary`；Host 写入 `agent.context_compacted` 的 summary/retainedCount。`test/recovery-tool-limits.test.ts`：17 次破坏性 powershell 与重复 `ls` 不被拒绝。`test/codex-experiment-recovery-envelope.test.ts`：超过十六次删除后仍可完成恢复。`test/timeline.test.ts`：相同输入失败不再 `hidden`。


