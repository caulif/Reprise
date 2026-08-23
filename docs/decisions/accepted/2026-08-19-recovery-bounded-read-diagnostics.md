# ADR: Recovery bounded-read diagnostics

- 状态：Accepted
- 日期：2026-08-19
- 范围：Recovery staging 的目录与文件读取工具

## 背景

最大努力恢复不能因为某个候选目录读取或单个文件读取的瞬时 I/O 故障而让 Agent 失去后续调查机会；同时，模型不能把一次失败误读为“目录为空”。此前 Git facts 已有逐操作的脱敏可用性和一次有限重试，staging 读取没有同等审计合同。

## 决策

`inspect_workspace`、`list_dir`、`read_file` 以及 frozen evidence 的 `derive_task_footprint`、`search_recovery_artifacts`、`read_observation` 均由 Host 执行一次有限重试。成功或耗尽后都会以 machine-readable `operation`、`availability` 和 `attempts` 回调；耗尽只返回空的、明确 `available=false` 的工具结果（目录/文件为 `filesystem_error`，frozen evidence 为 `frozen_evidence_error`），不伪造内容，也不取消其他 forensics。应用层分别追加 `recovery.workspace_read` 与 `recovery.frozen_observation_read` 事件。

注入式文件系统 reader 仅是测试 seam，不能从 Agent 工具参数或模型上下文访问。路径边界和 symlink 拒绝仍先于读取；不将 `staging_shell` 外部写入转换为逐文件已观测事实。

## 取舍与验证

读取失败会减少一个候选分支可用事实，不会产生“已恢复”证据。`test/recovery-tools.test.ts` 使用注入的永久 I/O 与 frozen-evidence 读取失败 fixture，断言恰好两次尝试、脱敏失败结果、Host-owned diagnostic 和可继续返回。
