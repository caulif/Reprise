# 决策：将 Recovery 选样诊断作为 schema-checked 脱敏 artifact

状态：accepted

## 问题

真实弱证据 5+5 在 Recovery Agent 启动前可能因隔离可用源不足而停止。仅记录 `source_unavailable` 无法复核该决定；但把 session ID、cwd、source path、任务正文或原始检查错误写入诊断会泄露本地数据。此前 `selection-diagnostics.json` 已写入汇总，但未经过持久化 schema 边界。

## 决定

新增 `RecoverySelectionDiagnosticsSchema`，并要求真实 runner 在写入 `.reprise/<run-id>/selection-diagnostics.json` 前通过 `Value.Check`。artifact 仅包括：

- schema version；
- product ID；
- discovered、metadata eligible 与 selected 计数；
- source inspection、isolated、not isolated、inspection failed 计数。

它不包含任何 source binding、session ID、cwd、source path、任务正文、原始错误、命令输出或凭据。schema 无法通过时，runner 在写入前失败；不会生成一个未校验的诊断文件。

## 影响

选样不足可以在不泄露本地会话细节的前提下审计，并能与 `source_unavailable` 区分：前者解释批次为什么尚未开始，后者是冻结 manifest 内某个 binding 失效的终态。该 artifact 不改变 selection manifest、抽样规则或 Recovery 接受策略。

## 验证

- `test/recovery-selection.test.ts` 覆盖合法诊断、负计数和包含 source path 的诊断均被 schema 拒绝。
- `scripts/recovery-real-5plus5.mjs` 写入前显式执行 `Value.Check`。
- `npm run build`、受影响 dist 测试、`npm run check` 和 `npm run verify:docs` 通过。
