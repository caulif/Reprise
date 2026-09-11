# 决策：三 Agent 契约清理与按需阅读

状态：accepted

承接 [稀疏 source mount](./2026-09-11-recovery-sparse-source-mount.md)、[可观察判断](./2026-09-11-recovery-observable-judgment.md) 与 [先理解再按视图决策](./2026-09-09-controller-understand-then-view.md)。规划见 [三 Agent 统一设计](../../plan/controller-comparison-agent-design.md)。

## 问题

源目录复制预算、跳过的链接和历史磁盘三态仍会在 inspect、预检和用户状态里变成业务 `blocked` / `partial` / `current_state_fallback`。Controller 与 Comparison 的 turn prompt 仍要求按固定顺序读完全部用户输入。Host 因此继续替代 Agent 判断，并暗示脚本化 replay。

## 决定

`inspectBaseline` 把复制预算只记在 `budget.blockedReasons`；`runnable` 保持 `isolated`，除非源目录本身不可用。`resolveBaseline` 仍用复制预算跳过整树复制，但不把 source 标成业务 blocked。新写入的 baseline `match`：`ready`/`recovered` 为 `recovered`，磁盘遗留 `partial` 为 `recovered_partial`，其余（含 `blocked`）为 `observational`，不再新写 `current_state_fallback`。用户状态在 Agent `ready` 时为 `recovered`，不因 `excludedEntries` 降为 `partial`。历史磁盘上的 `partial` / `recovered_partial` / `insufficient_evidence` 仍只读兼容。source 写锁 ACE 以 [source ACL](./2026-09-11-recovery-source-acl-and-diagnostic-readiness.md) 为准，必须允许 Host fingerprint 读取。

Controller 与 Comparison 的首轮委托要求从用户输入索引出发按需阅读，不规定读完全部 turn 的顺序。Host 不按历史下标投递。Comparison 不预生成差异结论或评分。

## 备选方案

**继续用 source 预算把 inspect 标成 blocked。** 大仓库在进入 Recovery 前就被预检和用户状态当成失败。

**跳过链接一律显示部分恢复。** Host 用复制细节覆盖 Agent 的 `ready`/`blocked`。

**强制按索引读完全部用户句。** 把材料索引当成 replay 脚本，与按需调查冲突。

## 影响

预检对超预算源目录报告 `sourceBaseline=available`，限制写在 warnings。封存工作区自身超预算仍由 Provider 机械失败。TUI 仍能展示历史 `partial` 记录。

## 验证

`test/application/recovery-sparse-source.test.ts` 要求超预算 inspect 的 `runnable` 为 `isolated` 且预检为 `available`。`test/core/environment.test.ts` 锁定 match 映射。`test/application/recovery-user-status.test.ts` 要求 skipped symlink 在 `recovered` 时仍为 recovered。`test/core/architecture.test.ts` 禁止 inspect 再写 `workspace-budget`、禁止 `userRecoveryStatus` 用 `excluded > 0`、禁止固定阅读顺序文案。相关测试与 `npm run check` 必须通过。
