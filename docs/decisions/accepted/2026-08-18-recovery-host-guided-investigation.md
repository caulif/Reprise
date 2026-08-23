# Recovery Host 引导调查与计划提交

- 状态：accepted
- 日期：2026-08-18

## 背景

弱证据不代表没有可调查的信息。原有 Recovery 工具面主要暴露逐文件读写和 shell，Agent 必须自行从冻结会话、当前候选目录和 Git 历史拼接线索，既浪费有限调用预算，也容易在证据不完整时过早放弃。与此同时，恢复方案若只写在自由文本报告中，Host 无法审计它使用了哪些事实、计划哪些候选变更。

## 决策

Recovery 增加由 Host 实现、输出有界的调查工具：

- `derive_task_footprint` 从冻结 observation 导出路径、命令和测试线索，并标记为推断；
- `search_recovery_artifacts` 仅返回已登记 observation 的 Host ref、来源、索引和 hash；
- `inspect_workspace` 与 `inspect_git_history` 在选中的隔离 candidate 内返回有界目录或 Git 元数据，后者不读取 Git object 正文；
- `submit_recovery_plan` 直接接收 TypeBox `RecoveryPlanSchema`，包含竞争 hypothesis 和每个 candidate 的拟议操作。

Agent 在首次 candidate mutation 前提交或修订方案。应用层验证所用 fact ref 属于 Host 调查记录、candidate hypothesis 属于 Host 初始方案，并拒绝越界或 `.git` 操作路径；验证通过的方案以 `recovery.plan_submitted` 事件持久化。计划是调查和审计记录，不是自动执行命令，也不替代最终 manifest、Provider 验证或 candidate verifier。

## 后果

弱证据案例获得更高层、可组合的调查路径，能够在不扩大源目录、凭据和路径边界的前提下产生可复核候选。Host 不把推断线索升级为事实，也不因计划提交而声明恢复已验证；证据不足的成功候选仍可为 `pending_user_review`。新增工具面和计划事件会改变提示词与持久化日志，均由快照和集成测试覆盖。
