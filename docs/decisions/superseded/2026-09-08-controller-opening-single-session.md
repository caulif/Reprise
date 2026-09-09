# 决策：Controller 首次 Invocation 同时完成理解与 opening

状态：superseded

被 [连续 Session 先理解再决策](../accepted/2026-09-09-controller-understand-then-view.md) 取代。下文冻结。

目标批次见 [M3.1](../../plan/reprise-refactoring-execution.md#m31-合并首次理解与-opening)。取代 [独立理解回合](./2026-09-04-controller-understanding-pass.md) 与 [完成证据护栏](./2026-09-06-controller-completion-evidence-guard.md)。

## 问题

独立 `understand` 会多一次 Invocation、强制 Understanding JSON 和 Host 账本。Host 再按账本与 read 证据拒绝 `done`，会把程序条件当成任务完成，并在同一 run 内插入纠正循环。这些都与「每 run 一个 Controller Session、首次请求直接形成 opening」冲突。

## 决定

- 实验入口只调用 `decide`。首次 Invocation 的 briefing 提供历史、用户目标与来源事实；该调用在本 run 的 Controller Session 内调查并返回 opening `send`。
- 后续 `decide` 复用同一 Session，只追加后续候选回合的真实新事实。
- 新路径不写 `controller.understanding` / `controller.understanding_updated`，不维护 `controller-understanding.json` 账本，不因未读文件或旧 `understandingDelta` 拒绝 `done`。
- briefing 仍准备 INDEX、历史文件、权限隔离和决策 schema 校验。旧事件与旧 briefing 文件只读。

## 备选方案

**保留可选 understand，脚本 Controller 跳过。** 真实路径仍有第二套契约，失败模式与账本守卫会继续约束停止条件。

## 影响

opening 失败仍在投递候选之前进入终态。历史 run 上的理解事件可展示，但不能驱动新 run 的停止。

## 验证

`test/controller-full-session-judgment.test.ts` 证明 opening 与后续 decide 共用一次 `createSession`，且没有 understanding 前置请求。`test/codex-experiment.test.ts` 证明新 run 无 `controller.understanding`，`done` 不被账本守卫拒绝。`npm run check` 必须通过。
