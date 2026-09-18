# 决策：恢复终态、确认卡片与短候选目录

状态：accepted

## 问题

同一次真实 Codex 恢复已经 `hasAccept`、确认页允许开跑，但 `recovery-diagnosis.json` 仍写 `recovery_agent.failed`，评价行 `readinessStatus=not_ready`。操作者会把「无 Git 的 partial」读成壳没起来。`rc/<id>/candidate-historical-observations` 把物化路径顶到 CreateProcess cwd 上限。运行时间线把重复 `ls` 的信息增益拒绝渲染成失败。确认卡片不展示变更条数、`unresolved` 和跳过的 symlink。项目列表默认落到 Harness 仓库，预览把 `<environment_context>` 当最近活动，列表行标「摘要不完整」。

## 决定

- 用户终态 `recovered` / `partial` 时，诊断 `reasonCode` 分别为 `recovered` 与 `weak_or_incomplete_evidence`（仅 symlink 跳过且无 envelope partial 时用 `workspace.symlink_skipped`）。`recovery_agent.failed` 只留给真正失败且无 `failureStage` 的情况。
- 机械 readiness 在未导出任何任务路径时记 `ready`，不再把空路径清单写成挡住开跑的 `not_ready`。
- 候选工作区磁盘段名为 `sha256(candidateId)` 前 8 位十六进制；事件里的 `candidateId` 仍是原 id。旧实验不迁移。
- 时间线隐藏「repeated tool call with identical inputs」的工具失败；破坏性预算耗尽仍可见并可折叠。
- 确认卡片展示变更条数、第一条 `unresolved`、`excludedEntries`。页脚写变更条数，不把 symlink 跳过说成全部原因。
- 项目光标优先上次打开的项目，再当前工作区；当前工作区若包含 Harness `dataDir`（从仓库里启动）则跳过。`<environment_context>` 按注入块处理。有可用任务标题的残缺摘要不在列表行标「摘要不完整」。

## 备选方案

**继续用 `recovery_agent.failed` 表示一切非 recovered。** 与确认页开跑许可冲突。

**把长 `candidateId` 留在目录名、只靠 Set-Location 兜底。** 候选 Runtime 的 cwd 仍可能超 MAX_PATH。

**项目光标继续优先 process.cwd。** 从 Reprise 仓库启动时总会落到 harness 项目。

## 影响

[Environment §7.1](../../architecture/environment.md#71-内部工作空间与实际边界) 的 `rc` 段名。[TUI](../../product/tui.md) 的确认卡片、时间线、项目默认光标与摘要徽章。诊断 schema 的 `reasonCode` 仍是自由字符串。

## 验证

`test/recovery-user-status.test.ts`：accepted partial → `weak_or_incomplete_evidence`。`test/recovery-readiness.test.ts`：空路径 → `ready`。`test/environment.test.ts`：候选根不含 `candidate-historical-observations`。`test/timeline.test.ts`：重复 `ls` 隐藏。`test/recovery-ui.test.ts`：确认卡含变更/跳过/未决。`test/intake-ui.test.ts`：Harness checkout 不抢光标；有标题的 partial 不标摘要不完整。反向：accepted partial 再写 `recovery_agent.failed`、候选目录再拼 hypothesis 全名、或确认卡省略 `unresolved`，测试红。
