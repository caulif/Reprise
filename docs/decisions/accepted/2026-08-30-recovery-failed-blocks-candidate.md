# 决策：无 accept 的恢复失败不得启动隔离候选

状态：accepted

## 问题

用户终态只允许「已恢复 / 部分恢复 / 无法恢复」，但 `userRecoveryStatus()` 把 `recovery.status=failed` 和 `match=current_state_fallback` 都显示成部分恢复。确认页仍提示启动隔离候选。走查中 Agent 二次会话因上下文溢出崩溃后，`hasAccept=false`，诊断 `reasonCode` 却取了 `excludedEntries` 里的 `workspace.symlink_skipped`。操作者会在错误任务标题上对当前脏树计费。

## 决定

无 accept / 无可运行 staging 的失败（含 runner/model 失败导致的 `current_state_fallback`）映射为用户终态 **无法恢复**。确认页禁止 Enter 启动候选；可回上一步。`reasonCode` 优先 `failureStage` / 模型错误类，symlink 跳过只留在 `excludedEntries`。仅环境跳过且仍有 accept 时才是部分恢复。

## 备选方案

**把 fallback 也叫部分恢复，方便用户继续对照。** 没有可接受的隔离树时，对照跑的是当前脏工作区，费用记在错误题目上。

**崩溃后静默拷当前 source 当已准备。** 违反隔离与冻结契约。

**确认页仍允许 Enter，只在 start 时抛错。** 文案仍像可以开跑；门禁必须同时挡住投影快捷键和 `beginRun`。

## 影响

- `userRecoveryStatus` 需要 `hasAccept`；无接受点的 `failed` / `current_state_fallback` 为 `failed`。
- `candidateStartBlocked` 在 `userStatus==='failed'` 或 `hasAccept===false` 时拦截。
- 诊断码不再被 `excludedEntries[0]` 抢先。
- 本决定修正[会话恢复用户终态](./2026-08-28-session-recovery-user-first.md)的实现缺口，不改变三种终态集合。

## 验证

- `test/recovery-user-status.test.ts`：fallback 无 accept → `failed`；symlink + accept → `partial`；`reasonCode` 优先 `failureStage`。
- `test/tui-workflow.test.ts`：无 accept 的 failed 确认不得启动。
- `test/recovery-ui.test.ts` / `test/widgets.test.ts`：无法恢复确认页禁止开跑文案。
