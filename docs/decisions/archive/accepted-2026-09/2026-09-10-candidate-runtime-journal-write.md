# 决策：Candidate Runtime Journal 单一写入边界

状态：accepted

延续 [Journal payload](./2026-09-10-candidate-runtime-journal-payload.md)。

## 问题

Product Adapter 与 Application 都曾直接 `store.append` `runtime.*` Envelope。迟到、错误 sessionId 和 Adapter 自带 sequence 没有统一拒绝点。

## 决定

`appendCandidateRuntimeEvent` 是唯一写入 `runtime.*` 的 Application 边界。它补齐 `sessionId`/`evidenceRefs`、校验 Schema、拒绝非法 type、错误 sessionId、payload.sequence、迟到（`run.outcome_created`/`run.finished` 之后）以及同指纹重复。Adapter 只调用 `TargetEventSink.append`；该 sink 由 `createCandidateRuntimeSink` 创建。`CandidateRun` 的 `runtime.delivery_observed` 与 `runtime.turn_settled` 也走同一函数。

## 备选方案

**继续在 experiment.ts 内联组装 Envelope。** 编排器继续持有 Journal 细节，无法单独验收拒绝语义。

## 影响

[`candidate-run-events.ts`](../../../src/application/candidate-run-events.ts) 拥有写入；`experiment.ts` 只创建 sink。协议解析仍在 Pack。

## 验证

`test/application/candidate-run-events.test.ts` 覆盖 type/session/sequence/late/duplicate。`test/core/architecture.test.ts` 要求 `experiment.ts` 使用 `createCandidateRuntimeSink` 且不手写 `type: targetEvent.type`。`npm run check` 必须通过。
