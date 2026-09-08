# 决策：CLI 与 TUI 共用实验操作

状态：accepted

目标批次见 [M5.1](../../plan/reprise-refactoring-execution.md#m51-提取与界面无关的应用操作)。

## 问题

实验编排写在 `tui-workflow` 里，默认 CLI 静态加载 TUI。完整 run 与分步 prepare/run 若各写一套，领域结果会分叉。候选能否启动若只在 TUI 判断，无界面入口会绕过封存完成条件。

## 决定

- 组合根是 `ExperimentWorkflow`（`createExperimentWorkflow` / `createHarnessWorkflow`）。`recover` 是 prepare，`start` 是场景运行。
- `prepareExperiment`、`runPreparedExperiment`、`runFullExperiment` 是 CLI 与 TUI 共用的应用函数。完整 run 等于 prepare 再调用同一个 scene-run 函数。
- `candidateStartBlocked` 属于 application。有 `recoveryAttempt` 时 `start` 先执行该守卫。封存完成前不能启动候选。
- 无子命令仍打开 TUI。`--compare` 只作用于该 TUI 入口，跳过对照确认门，不是 `compare` 子命令。
- `prepare` / `run` / `compare` / `cancel` 不静态加载 TUI。缺少 `--source-root` 或 `--task-case` 立即报用法，不进入隐藏提示。

## 备选方案

**CLI 继续只启动 TUI，用按键脚本完成 prepare/run。** 无 TTY 与管道场景无法使用，且会加载界面组件。

**start 在没有 recoveryAttempt 时再跑一遍 Recovery。** TUI 分步路径会准备两次。

## 影响

查询、JSON/JSONL、历史 run 对照与分页属于后续 CLI 协议批次。本机跨终端 cancel 见[跨终端 cancel](./2026-09-08-cross-terminal-cancel.md)。

## 验证

`test/experiment-operations.test.ts`：完整与分步调用同一 prepare/run 序列；无 prepare 或失败恢复不能 start。`test/cli.test.ts`：prepare/run 缺参退出 2 且无 TUI closed。`test/architecture.test.ts`：`cli/main.ts` 不静态 import `tui/`。`npm run check` 必须通过。
