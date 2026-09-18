# 2026-08-20：Recovery 批量评估按 case 关联生命周期证据

## 背景

Recovery 的终态行曾只在单 case 时与 `recovery.*` 生命周期事件交叉校验。批量评估可因此发布一个无法证明来源的 aggregate；真实 runner 也没有把每个 case 的事件交给 batch 校验。

## 决策

- 每个用于 Recovery lifecycle integrity 的 `recovery.*` 事件 payload 必须包含不可变 `caseId`；attempt payload 保留其已有 attempt/candidate 标识。
- `runRecoveryEvaluationBatch` 接收每个 case 的 lifecycle events，并在所有 terminal 已持久化、调用方发布 aggregate 之前执行按 case 的校验。
- 校验拒绝缺少 `caseId`、归属未知 case、row 与 model/candidate 数量不符、或 attempt duration 超过 row duration 的事件集合。
- 没有任何生命周期事件的旧/外部测量仍可读取；但只要提供事件，声称有 forensics、model call 或 candidate 的 row 不得缺少其 case 的事件。

## 后果

真实 runner 必须从各 experiment journal 读取并传入 `recovery.*` 事件。旧样本没有 case-scoped event evidence，不能作为通过新完整性门禁或性能结论的依据，需在显式 opt-in 下重新生成。


## 续跑约束（2026-08-21）

- 真实评估 runner 通过 `REPRISE_RECOVERY_EVAL_RESUME=1` 启用续跑；已存在且 schema 有效的 `case.terminal.json` 不得再次进入模型执行路径。
- 续跑必须复用并校验同一 run 的 preflight provider/model identity；缺失、损坏或 identity 不匹配时 fail closed，而不是重新调用模型或静默忽略终态。
- Recovery journal 中的 `caseId` 是冻结 task-case 身份；评估 sink 的 alias 是批次稳定身份。两者只在内存 lifecycle audit view 中映射，原始 append-only journal 不改写。
- resumed rows 与新执行 rows 必须在同一个 aggregate integrity gate 中校验；终态文件保持 immutable。

这样可以在长批次进程中断后安全恢复，同时避免把旧终态、错 run 事件或损坏文件伪装成新样本。
