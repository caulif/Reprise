# 决策：Recovery 只对可观察材料作判断

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-11

承接 [信封 summary 与 seed 同构](./2026-09-11-recovery-envelope-summary.md) 与 [单工作副本自主三轮循环](../../accepted/2026-09-09-recovery-single-workspace-agent-loop.md)。

## 问题

Agent 无法观察未记录的历史，也无法把外部世界恢复到过去。Host 派生的路径清单和命令回放若直接否决 `ready`，会把「未列入清单」或「测试失败」写成不可完成的历史证明要求。`blocked` 若按系统崩溃渲染，操作者无法区分 Agent 的正常停手与 Host 机械失败。

## 决定

`ready` 表示根据可观察材料存在合理可执行起点，不表示逐字节历史一致。未知只有在可能改变任务输入、难度或暴露结果时才由 Agent 标 `blocked`。Prompt 与 Product Playbook 要求建立合理恢复路径，并在 `recovery.md` 区分观察、推断、已执行动作和未决项。Host 不改写 `summary` 或报告。

readiness 只记录可检查的路径与命令事实。缺失 Host 派生路径、命令失败或缓存缺口不得把 `runnable` 改成 `blocked`，不得阻止自动 accept，也不得作为 Candidate 启动门。路径越界仍是机械 `blocked`。source tripwire、报告缺失、workspace 超预算和无法封存仍由 Provider 失败关闭。缺口是否影响任务只允许反馈同一 Session，由 Agent 决定。

模型请求、输出修复和机械反馈保留同一 Session 与 workspace。workspace 损坏、不可恢复的进程边界错误丢弃 Session 并从理解 turn 重建。source tripwire 失败关闭，不走机械反馈。

TUI 把 Agent `blocked` 显示为正常停手并原样展示 `summary`。Provider/Host 自身失败才是技术失败。

本决定取代 [任务继续门](./2026-09-10-recovery-visible-capability-and-readiness-gates.md) 中「`not_ready` 阻止自动 accept 与 Candidate 启动」的条款，以及 [路径语义](./2026-08-23-recovery-readiness-path-semantics.md) 中「输入型任务缺失路径即为 `not_ready` 并挡住发布」的条款。工具面、工作集与机械封存仍有效。

## 备选方案

**继续用 Host 路径清单否决 ready。** 实现简单，但会把 Agent 已判断不影响任务的缺口写成不可完成的证明义务。

**缺失路径一律反馈新一轮。** 会把已取代的任务就绪循环重新做进 Host。

## 影响

`checkRecoveryReadiness` 对路径与命令记录事实；`taskReadinessBlocksPublication` 只对越界为真。确认页与时间线把 `blocked` 与 `failed` 分开。相关测试覆盖无关未知仍 `ready`、关键缺失 `blocked`、机械反馈同 Session、损坏从 Turn 1 重启。

## 验证

`test/application/recovery-readiness.test.ts`：缺失路径与命令失败仍为 `ready`；越界才 `blocked`。`test/application/codex-experiment-recovery-envelope.test.ts`：Host 派生路径缺失时信封 `ready` 仍自动 accept。`test/tui/recovery-ui.test.ts`：blocked 展示 Agent summary，不显示崩溃文案。反向：缺失路径把 `runnable` 改成 `blocked` 并拒绝自动 accept，测试红。
