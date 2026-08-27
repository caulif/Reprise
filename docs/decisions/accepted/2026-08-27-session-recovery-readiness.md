# 决策：会话恢复按可验证正文分级，不按来源类型一刀切

状态：accepted

## 问题

列表把 SQLite catalog、rollout 文件和 Claude history 显示在同一条路径上。Enter/freeze 曾把 `catalog-only` 一律当作不可读，或把 history 提示词当作可恢复 transcript。列表建立后文件可能被删除或替换；损坏 JSONL 也曾从 `items` 里消失，只剩聚合诊断。

## 决定

Enter/freeze 只接受当场通过 `stat`、大小上限、JSONL 解析和 session ID 校验的正文。`catalog-only`、合成 `.catalog/` 路径和 Claude history locator 禁止创建可回放 TaskCase。Pack inspect/import 在读取后核对 `sessionId`。同 ID 多个 rollout 保留较新且校验通过的文件，并记 `duplicate-source`。摘要失败的文件以 `unreadable` 留在 catalog，不得从 `items` 删除。

## 备选方案

**按 `sourceKind` 允许或禁止 freeze。** 可读的 catalog+transcript 会被误拦；rollout-only 会被误当成次级来源。

**继续允许 history-only 走 TUI freeze。** 会把一条 prompt 伪装成完整 transcript，无法满足用户输入、assistant/tool 记录的恢复前置条件。

## 影响

- TUI 冻结前会再 inspect/import，列表缓存不再是恢复依据。
- Claude history-only 仍可 inspect/import 为 history 证据，但不能作为隔离回放入口。
- 损坏文件会占用列表行，计数包含 unreadable。

## 验证

- `test/session-recovery-contract.test.ts`：extended path、locator、catalog-only、删除后冻结、文件名 UUID、同 cwd、三类来源、损坏 JSONL、刷新归属。
- `test/claude-code-pack.test.ts`：history-only 为 catalog-only 且 `importVerifiedSession` 拒绝。
