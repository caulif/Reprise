# Recovery validation failure preserves completed Agent output

- 状态：Accepted
- 日期：2026-08-21

## 决策

Recovery 将 Agent 完成、Provider/Verifier 验证失败与真正的 runner 崩溃分开处理：

1. `candidateCreated`、`hypothesisCount`、`candidateCount`、`recoveredPaths`、attempts 和 Agent completed envelope 在验证失败时继续写入 evaluation 与 Recovery artifact。
2. 当 Agent 已完成且已经创建候选时，即使 Provider adapter 抛出未包装的验证异常，也保留 `provider_validation_failed`；只有 Agent 未完成或编排/进程真正异常时才使用 `runner_crashed`。
3. `candidateCreated` 不代表 `verified`，验证失败不会提升 `verified` 计数，也不新增 lifecycle state。
4. `recovery-validation.json` 在 Provider validation failure 下写入脱敏、稳定的 `validationFailureReason`。优先使用 verifier reason；没有可用 verifier reason 时使用 `provider_validation_failed`，不写入模型原文、凭据或路径。

## 原因

真实 Runtime 样本中 Claude case 已经产生候选和 Agent completed envelope，但 Provider validation 的异常被 catch 路径覆盖成 `runner_crashed`，导致故障归因和 Agent 产出丢失。该修复只调整分类和持久化摘要，不放宽 `no_task_path_outcome`，也不改变 candidate、verified、accepted 的语义边界。

## 验证

- `npm run build`
- `node --test dist/test/codex-experiment.test.js`

本次变更不运行新的真实 Runtime 5+5；既有 5+5 目录仍作为修复前证据。
