# Recovery 任务就绪与反馈循环

状态：superseded

被 [单工作副本自主三轮循环](../accepted/2026-09-09-recovery-single-workspace-agent-loop.md) 取代。下文冻结。
- 日期：2026-08-22

## 决策

Recovery Host 从原会话提取经过 schema 校验的 `RecoveryReadinessContext`，至少包含任务摘要、相关路径、历史命令和可用检查入口。Agent 每次恢复后，Host 在隔离 staging 中执行只读的路径存在性、非空和可读取性检查，并把结果作为事件和下一轮模型输入反馈。

只有 readiness 为 `ready` 才能把结果交给后续流程；缺失证据会触发有界反馈轮，安全越界进入失败/人工介入路径。候选图、报告和 hypothesis 继续保留为内部审计产物，不作为正常用户交互的完成条件。

## 边界

- Host 不执行从 transcript 任意提取的命令；历史命令只作为显式检查入口，避免把会话文本升级为执行权限。
- 检查只读取 staging，不读取或写回 source。
- feedback turn 受既有 `maxModelAttempts` 限制，并记录独立的模型输入 artifact 和 readiness 事件。
- 当前仍保留旧的 provider verifier 和 `pending_user_review` 兼容路径；自动完成需要 verifier 同时通过，不能由路径存在性单独宣称语义恢复。

## 验证

- `test/recovery-readiness.test.ts` 覆盖路径派生、缺失路径反馈和 staging 边界拒绝。
- `npm run build` 与受影响 Recovery 测试必须通过。
