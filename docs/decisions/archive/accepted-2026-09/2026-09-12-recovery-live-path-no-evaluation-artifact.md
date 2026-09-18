# 决策：Recovery 生产路径不再写入评分 evaluation artifact

状态：accepted

## 问题

`recoverExperiment` 在 finalize/fail 时仍写入 `recovery-evaluation` artifact，其中含 `candidateCount`、`hypothesisCount`、`verifierRejectionReasons` 等已 superseded 的多候选评分字段。这与当前 `ready`/`blocked` + Host 机械检查模型冲突。

## 决定

新的 Recovery attempt 不再调用 `persistRecoveryEvaluation`。任务结论留在信封、`EnvironmentBaseline.recovery` 与既有 `recovery.*` 事件。`evaluation.ts` 与 `RecoveryEvaluation*Schema` 只服务于离线批评估脚本和读取旧 artifact；`selection.ts` 仍只给 `scripts/recovery-real-5plus5.mjs` 这类评估入口使用，不进入 `recoverExperiment`。无法安全解读的旧行报告为 incompatible。生产路径不删除 `recovery.forensics_*` 采集（它是 Host 事实，不是评分）。

## 备选方案

**继续写入同一 artifact，只删部分字段。** 仍把评分 schema 绑在 live 写入上。

**连同 forensics 事件一并删除。** 会去掉 Comparison/诊断仍可能依赖的 Host 采集事实，超出本轮。

## 影响

实验目录不再出现 `artifacts/recovery-evaluation`。批评估脚本继续可选用 evaluation 模块。旧磁盘行不迁移。

## 验证

`test/application/codex-experiment-recovery-effort.test.ts`：成功与失败 attempt 均无 `recovery-evaluation` 文件；`taskOutcome` 与 retryable 诊断改从 baseline/事件读取。反向：live 路径再次 `persistRecoveryEvaluation` 时这些断言失败。
