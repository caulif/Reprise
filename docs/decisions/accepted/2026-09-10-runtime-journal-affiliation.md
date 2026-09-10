# 决策：Runtime Journal 校验 turn、message、call 与 Session 生命周期

状态：accepted

延续 [Journal payload](./2026-09-10-candidate-runtime-journal-payload.md)。写入边界仍是 `appendCandidateRuntimeEvent`。

## 问题

单一写入入口已拒绝错误 session、late、duplicate、非法 type/payload/sequence，但 Adapter 仍可能写入不属于当前活动 turn 的 `turnId`、未投递的 `messageId`、重复完成的 `callId`，或在 `session_started` 之前 / `session_closed` 之后写 Runtime 行。

## 决定

Journal 在落盘前额外校验：缺 `turnId`/`messageId`/`callId` 的事件跳过该项；带 `turnId` 时必须属于尚未 `turn_settled` 的活动 turn（`turn_started`/`delivery_observed`/`message_submitted` 可打开新 turn）；带 `messageId` 且非投递开场事件时必须已在 `message_submitted` 或 `delivery_observed` 出现；同一 `callId` 不得第二次 `tool_finished`。`session_started` 或 `session_failed` 之前拒绝其他 Runtime 类型；`session_closed` 之后拒绝全部 Runtime 类型。清理走 `run.*` / Environment，不经该边界。Adapter 不得在 payload 上设置 Journal `sequence`。

## 备选方案

**只靠 CandidateRun 与 Product Adapter 保证归属。** 测试 Runtime 仍可能在 createRunner 时抢先写事件，错误会被记成合法 Journal。

## 影响

[`src/application/candidate-run-events.ts`](../../../src/application/candidate-run-events.ts)。错误码增加 `turn`、`message`、`call`、`lifecycle`。

## 验证

`test/application/candidate-run-events.test.ts` 覆盖先于 session、关闭后写入、未知 turn/message、重复 call。`npm run check` 必须通过。
