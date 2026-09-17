# 决策：RunPolicy 安全阀只约束 Target

状态：accepted
日期：2026-09-16

## 问题

`RunPolicy.maxModelCalls` 与 `maxConsecutiveNoProgress` 写在 schema 和默认值里，但 CandidateRun 不执行；文档仍写「30 分钟 / 12 轮 / 单次 timeout 始终有限」。Controller 循环里 `stalled.no_progress` 分支对 `completed | failed | cancelled` 不可达。若把调用次数改去截 Controller，会推翻 [Controller briefing](./2026-09-03-controller-path-briefing.md) 已拍板的「`maxModelCalls` 只约束 Target」。

## 决定

完成仍由 Controller 决定。`RunPolicy` 是 Target 最后安全阀，默认与代码一致：墙钟 24 小时、256 个 target turns、256 次 Target 模型调用、单 turn 2 小时、连续 2 次无进展。

**模型调用计数。** 只数 Runtime journal 里可机械识别的模型调用事件。类型名单（`event.type`）为：

- `runtime.turn_started`
- `runtime.usage_reported`

计数规则：若本 run 出现过 `runtime.turn_started`，只数该类型（Codex 原生 turn）。否则若出现过 `runtime.usage_reported`，只数该类型（Claude `result` 帧）。两种都没有则 **不可数**：该 run **不按** `maxModelCalls` 截断，也 **不得** 改去截 Controller。Host 自己写的 `runtime.delivery_observed` / `runtime.turn_settled` 不在名单内。`controller.budget.maxCalls` 仍可选、默认不设。Controller 与 Comparison 单次 `timeoutMs = 0`。

**无进展指纹。** 每次 Target `runtime.turn_settled` 且回合进入 `awaiting_controller` 之前，对隔离工作副本做内容指纹。规范清单是相对 POSIX 路径加文件哈希，**排除** `.reprise` 与 `.reprise/` 下全部条目；按 `path` 升序；`JSON.stringify` 后 SHA-256。文件哈希是磁盘字节，不做换行归一。符号链接复用 `fingerprintTree`：树内目标按普通文件/目录计入（路径为链接相对路径），越界、缺失、循环、不可读链接跳过且不进清单。第一次结算只记录基线（连续计数 0）；之后与上一回相同则 +1，不同则清零。达到 `maxConsecutiveNoProgress`（默认 2）则 `stalled.no_progress`。无法取指纹时不得静默当成无进展。

**墙钟。** 仍按 `RunPolicy.wallClockMs` 在 Controller 循环每次回到 `awaiting_controller` 时截断（`limit.wall_clock`）。不可达的循环内 `stalled.no_progress` 分支删除；无进展只由上述指纹触发。

## 备选方案

**删掉未执行的 `maxModelCalls` / `maxConsecutiveNoProgress`。** 无法给 Target 成本封顶。

**数不到模型调用时改截 Controller。** 与 2026-09-03 冲突，且把内部决策次数绑到 Target 政策。

**用 Controller 消息重复当无进展。** 已由 [briefing 与无进展解耦](./2026-09-05-controller-briefing-manifest-and-no-progress.md) 否决。

**给 Controller 单次有限 `timeoutMs`。** 长决策会被误杀；取消与传输失败仍有效。

## 影响

[`DEFAULT_RUN_POLICY`](../../../src/application/default-run-policy.ts)（[`experiment-workflow.ts`](../../../src/application/experiment-workflow.ts) 再导出）、[`CandidateRun`](../../../src/application/candidate-run.ts)、[架构总览](../../architecture/overview.md)。TUI 预计上限与默认政策一致。不改 Comparison resume，不改 Controller 决策语义。

## 验证

`test/application/candidate-run-safety.test.ts`：可数事件超限为 true；无数事件不截；`.reprise/` 不进指纹；有改动则连续计数清零。`test/candidate/run-policy-safety-valves.test.ts`：journal 含 `runtime.turn_started` 达上限 → `limit.model_calls`；无数则继续；连续相同指纹 → `stalled.no_progress`（独立文件，避免与 `hangStop` 同文件被 cancelledByParent）。`test/application/codex-experiment.test.ts`：墙钟与 Controller `maxCalls` 仍独立截断；重复用户句在指纹变化或阈值未到时不因措辞停。`npm run check` 必须通过。
