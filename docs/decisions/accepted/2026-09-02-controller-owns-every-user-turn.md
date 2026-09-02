# 决策：Controller 写出每一条用户输入

状态：accepted

## 问题

隔离副本就绪后，Host 仍把冻结 `TaskCase.initialInput` 原样交给候选。历史句里的绝对路径指向用户原目录；Controller 要等第一回合结束后才说话。同等人类能力要求等价的是协作条件，不是把原句当脚本重放。

## 决定

- 冻结 `initialInput` 只作考卷原文，不写回 Case，也不作为第一条 Target 输入。
- 候选启动时 Controller 同时启动。开场决策在 `created` 上，只许 `send`。Host 把该 `message` 交给 `TargetRunner.start`。
- 每个已结算回合之后，Controller 继续 `send` 或 `done`。停止仍由 Host 执行预算与 `settleController`。
- 观察摘要用 `CandidateSpec.productId` 的 Pack 翻译事件，不用来源 `productId`。
- 根外写盘仍由 Runtime/Host 隔离处理，不把沙箱写进 Controller 提示词当唯一防线。

## 备选方案

**继续 Host 原样重放第 0 句。** 同等协作在第一轮不成立；候选会跟随历史绝对路径。

**Host 正则替换 `historicalCwd`。** 漏旁路路径，且仍不是用户口吻。

**开场允许 `done`。** 尚无候选回合，完成/卡住判断没有依据。

## 影响

[Controller 设计](../../architecture/controller.md) §4.1 与 §5。[架构总览](../../architecture/overview.md) 的候选启动输入。[Controller 实验条件](../../architecture/controller-experiment-conditions.md)。实现规划：[Controller 拥有每一轮用户输入](../../plan/controller-owns-every-user-turn.md)。

## 验证

- `test/codex-experiment.test.ts`：开场 `input.submitted` 不是冻结原文；开场 `done` 无 Target 输入；`controller.started` 早于第一条 `input.submitted`；取消开场时 `input.submitted` 为 0。
- `test/controller-opening.test.ts`：opening 拒绝 `done`，且要求 `runState === created`。
- `test/experiment-inspection.test.ts`：来源 Codex Pack 看不到 Claude Bash，候选 Pack 看得到。
- `test/candidate-run.test.ts`：`failBeforeStart` 不调用 `runner.start`。
- Controller system prompt snapshot。
