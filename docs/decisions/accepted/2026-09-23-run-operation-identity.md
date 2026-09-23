# 决策：run 所属操作使用独立身份

状态：accepted

## 问题

Store 的 operation 去重范围是整个 Experiment。Controller、CandidateRun、runtime 事件和 artifact 审计使用的固定局部 ID 在第二个 run 中可能与第一个 run 冲突，尽管两次运行各有独立的事实与副本。

## 决定

- 保留 Store 的实验级 operation 去重与冲突检查，不改变 `events.jsonl` 格式或旧事件。run 所属事件在各自所有者写入前调用 `runOperationId(runId, localId)`；它对 JSON 编码的二元组计算 SHA-256，生成固定长度的安全 ID。二元组编码避免简单拼接的边界歧义，hash 避免长 artifact/local ID 超出 128 字符。
- Controller 的 started/decision、CandidateRun 非 runtime 生命周期事件、runtime 显式 ID 与默认 fingerprint、Store 的 run-owned artifact 和预算/清理事件均在其写入边界加一次 run 作用域。CandidateRun 转交 runtime 事件时仍传局部 ID，由 runtime 事件入口加作用域，不重复转换。
- 未带 runId 的实验级事件保持原身份。相同 run/local ID 与相同 type/run/payload 仍幂等；内容不同仍按 Store 既有规则拒绝。已提交的旧事件按原 operationId 只读重放，不迁移或改写日志。

## 备选方案

**把 Store 去重范围改为每个 run。** 会改变已有实验级 operation 的冲突语义，且不能区分无 runId 的事件。

**直接串接 runId 与局部 ID。** 边界可能歧义，两个接近长度上限的合法 ID 也会超过信封限制。

## 影响

同一 Experiment 可从同一封存 baseline 启动不同 run，各自保有 attempt、manifest、record、事件和 artifact。这个离线行为验收不替代真实 Runtime 的 opt-in 验收。事实层见[证据、持久化与 Comparison](../../architecture/evidence-and-comparison.md)。

## 验证

`test/application/codex-experiment.test.ts` 用 fake Runtime 完整运行两个 run 并改动第一份副本，验证第二份起点仍为封存内容；`test/application/candidate-run-events.test.ts` 验证 runtime 显式 ID 与 fingerprint；`test/core/store.test.ts` 验证身份稳定、长度与幂等冲突。
