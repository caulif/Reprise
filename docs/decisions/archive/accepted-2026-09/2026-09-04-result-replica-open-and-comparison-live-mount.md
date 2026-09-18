# 决策：结果页打开隔离副本，对照读活副本

状态：accepted
日期：2026-09-04

## 问题

隔离副本已在 cleanup 后保留，但结果页 `t` 打开的是 `runs/{runId}` 记录目录，用户看不到交付物。Comparison Prompt 仍写 `comparison-sandbox/candidate`，而工具把活副本挂在 `candidate/`，证据目录才在对照沙箱的 `evidence/`。

## 决定

结果页列出 `environment/runs/{runId}`，`w` 用系统打开器打开该目录。路径必须落在该实验的 `environment/runs/{runId}`，不得打开任意 `workspacePath`。

Comparison System Prompt 写明：`candidate/` 是 run 结束后仍保留的隔离副本（只读）；`evidence/` 是报告沙箱里的 Host catalog；`powershell` 的 cwd 仍是报告沙箱。Host 继续把 `recoveryTools` 的 `mounts.candidate` 指到 `PreparedEnvironment.root`。

## 备选方案

**把 `t` 改成打开副本。** 记录目录仍要可开，混在一起更糟。

**把对照 cwd 改成活副本。** `powershell` 会绕过 `candidate/` 只读挂载写盘。

## 影响

对照沙箱仍只物化 `evidence/` 与 `report.html`，不复制整棵副本。

## 验证

`test/result-page.test.ts` 结果页含 `environment/runs/`。`test/page-input.test.ts`：`w` 为 `open-replica`。`test/open-report.test.ts` 拒绝 `../` 与嵌套 runId。`test/snapshots/comparison-system-prompt.txt` 含 live isolated replica，不含 `comparison-sandbox/candidate`。反向：结果页只链到 `runs/{runId}` 或 Prompt 再写 comparison-sandbox/candidate 则红。
