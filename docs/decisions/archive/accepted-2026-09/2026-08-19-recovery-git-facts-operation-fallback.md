# 决策：Recovery Git facts 的逐操作降级与有限重试

状态：accepted

## 背景

Recovery 的 Git 事实此前只以一个聚合结果返回。repository、HEAD、status 和 historical commit object 任一辅助 probe 的进程故障可能中止整段 forensics，或让审查者无法区分“不是 Git 仓库”“unborn HEAD”与“Git 临时不可用”。这会把可继续调查的弱证据场景错误地变成无解释硬失败。

## 决定

`resolvedRecoveryFacts` 为证据目录、repository、HEAD、status，以及存在 historical commit 时的 object probe 生成 Host-owned、脱敏的 operation 记录。每条记录只包含 operation 名、`available`/`unavailable`、尝试次数和受限原因；不保存绝对路径、命令行、Git 输出、任务正文或凭据。该记录随 `recovery.forensics_completed` 事件持久化，因而模型可见的事实收集变化可由事件日志审计。

Git 的辅助 probe 仅在非语义性进程失败时重试一次。非零退出不重试：对于 repository、HEAD 与 object，它是可分类的事实而不是短暂错误；例如非仓库和 unborn HEAD 会安全降级，status 不可用也不会丢弃工作区、transcript 或 preimage 调查。重试耗尽后同样以 `unavailable` 继续，而非中止 maximum-effort forensics。关键的 source/staging 安全检查不采用此降级路径。

## 后果

恢复流程在 Git 部分退化时保留可审查的事实与候选机会，同时不把 Git 元数据当作恢复成功证明。该决策不放宽 source isolation、evidence ownership、manifest/hash verifier 或自动接受条件。冻结 evidence 读取和目录遍历仍须在后续采用同一 operation 合同并增加相应 fixture。

## 验证

`test/recovery-tools.test.ts` 覆盖 non-Git 与 unborn Git 的逐操作降级；`test/codex-experiment.test.ts` 断言空 evidence 场景仍发出带 operation 诊断的 `recovery.forensics_completed`。`npm run check` 作为本次源码变更的工程门禁。