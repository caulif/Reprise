# Recovery Evaluation 最大努力指标

状态：accepted

日期：2026-08-18

## 背景

弱证据历史样本没有可用于路径 precision/recall 的任务开始真值。只报告 `recovered`、`partial` 或失败状态，会把运行基础设施、调查范围和候选质量混为一谈，也会错误地把没有真值的样本当成准确率分母。

## 决定

`RecoveryEvaluationCase` 在保持既有核心字段兼容的前提下，可记录以下脱敏、聚合安全的观测字段：

- staging 是否成功；
- forensics 是否完成；
- 已尝试和可用的证据源数量；
- hypothesis 与 candidate 数量；
- verifier 拒绝原因代码；
- provider 失败是否可重试，以及路径边界拒绝标志。

报告按 `history_completed` 与 `interrupted_checkpoint` 分层聚合：staging、forensics、证据覆盖、候选/假设、拒绝原因、`pending_user_review`/`verified` 计数、模型调用、P50/P95 时延、可重试 provider 失败与路径边界拒绝率。只有 checkpoint 层继续计算 verified path precision/recall；历史层的 0/0 比率不表示准确率。

字段不得包含 session ID、cwd、源路径、任务正文、provider 原始错误或模型文本。所有持久化输入仍必须经 `Value.Check(RecoveryEvaluationCaseSchema, value)`。

## 后果

弱证据复测可以回答“Agent 是否完成最大努力调查并产生可审查候选”，但不能由此推出恢复正确率或 99% 承诺。新增指标是评估协议的一部分，真实 runner 必须在可获得的阶段填充它们，未知值保持缺失而非伪造为 0。
