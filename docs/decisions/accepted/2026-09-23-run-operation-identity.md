# 决策：run 所属操作使用独立身份

状态：accepted

## 问题

Store 的 operation 去重范围是整个 Experiment。Controller、CandidateRun、runtime 事件和 artifact 审计使用的固定局部 ID 在第二个 run 中可能与第一个 run 冲突，尽管两次运行各有独立的事实与副本。

## 决定

- 保留 Store 的实验级 operation 去重与冲突检查，不改变 `events.jsonl` 格式或旧事件。run 所属事件在各自所有者写入前调用 `runOperationId(runId, localId)`；它对 JSON 编码的二元组计算 SHA-256，生成固定长度的安全 ID。二元组编码避免简单拼接的边界歧义，hash 避免长 artifact/local ID 超出 128 字符。
- Controller 的 started/decision、CandidateRun 非 runtime 生命周期事件、runtime 显式 ID 与默认 fingerprint、Recovery 生命周期/重试/失败清理事件、Store 的 run-owned artifact 和预算/清理事件均在其写入边界加一次 run 作用域。CandidateRun 转交 runtime 事件时仍传局部 ID，由 runtime 事件入口加作用域，不重复转换。
- 未带 runId 的实验级事件保持原身份。相同 run/local ID 与相同 type/run/payload 仍幂等；内容不同仍按 Store 既有规则拒绝。已提交的旧事件按原 operationId 只读重放，不迁移或改写日志。
- Recovery 的固定报告、attempt、调查与验证 artifact 归属各自的 `runs/<runId>/artifacts/`；内容寻址的 controlled-write blob 仍可由整个 Experiment 共享。Recovery 的决定、诊断、验证、解释与 pre-task JSON 写入 `runs/<runId>/`。默认 Workspace Provider 的 Recovery baseline 位于 `environment/recovery/<runId>/baselines/`，显式注入 Provider 与 checkpointRoot 沿用原语义。
- baseline marker 的可选 `reportRunId` 明确报告 owner；缺失时仅查旧实验级 artifact。scene 描述符的可选 `recoveryProviderRunId` 只允许按 ID 构造 Experiment 内的默认 Provider 路径；缺失时从旧 `environment/baselines/` 读取。新写入字段经过 core schema 检查，非法 marker 不降级读取。
- Candidate 的已发布 manifest 记录实际 workspacePath；结果页副本入口与稍后发起的 Comparison 仅在它符合当前 Experiment 的 `environment/runs/<candidateRunId>` 或 `environment/recovery/<recoveryRunId>/runs/<candidateRunId>` 时使用该路径。Comparison 证据仍读封存 snapshot，Git sink 则由受限的 Provider 根定位。

## 备选方案

**把 Store 去重范围改为每个 run。** 会改变已有实验级 operation 的冲突语义，且不能区分无 runId 的事件。

**直接串接 runId 与局部 ID。** 边界可能歧义，两个接近长度上限的合法 ID 也会超过信封限制。

## 影响

同一 Experiment 可从同一封存 baseline 启动不同 run，各自保有 attempt、manifest、record、事件和 artifact。这个离线行为验收不替代真实 Runtime 的 opt-in 验收。事实层见[证据、持久化与 Comparison](../../architecture/evidence-and-comparison.md)。

旧根级 Recovery JSON 与实验级 artifact 保持只读，不迁移或覆写。新代码兼容旧 scene 与旧报告 owner；旧版本代码无法保证自动打开新 run 所属 scene、报告或诊断，因此回退时需保留新版本读端或明确处理这些记录。

## 验证

`test/application/codex-experiment.test.ts` 用 fake Runtime 完整运行两个 run 并改动第一份副本，验证第二份起点仍为封存内容；`test/application/candidate-run-events.test.ts` 验证 runtime 显式 ID 与 fingerprint；`test/core/store.test.ts` 验证身份稳定、长度与幂等冲突。
`test/application/recovery-linear-lifecycle.test.ts` 验证 Recovery 连续成功与后续失败的独立归属、旧字节不变及 scene 重开；`test/application/scene-seal.test.ts` 验证旧 scene 和非法报告 run ID；Recovery 集成测试验证新旧报告 owner 的实际引用。
