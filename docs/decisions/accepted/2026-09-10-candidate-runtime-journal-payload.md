# 决策：CandidateRuntimeEvent 是 Journal payload

状态：accepted

延续 [Runtime 事件](./2026-09-09-candidate-runtime-events.md)。Journal 行仍是 `EventEnvelope`；`runtime.*` 的身份字段在 payload 上。

## 问题

类型把 `eventId`、`sequence`、`type`、`occurredAt` 与 `sessionId` 写在同一对象上，落盘却是 Envelope 加 payload 身份。调用方容易当成顶层事件去构造。

## 决定

`CandidateRuntimeEvent` 是 `EventEnvelope.payload`：必填 `sessionId` 与 `evidenceRefs`，可选 `turnId`/`messageId`/`callId`，其余为 Adapter 体。Envelope 拥有 `eventId`、`sequence`、`type`（`runtime.<CandidateRuntimeEventType>`）和 `occurredAt`。Journal 写入后对 `envelope.payload` 做 `Value.Check(CandidateRuntimeEventSchema)`。

## 备选方案

**把身份提升到 EventEnvelope 正式字段。** 全库事件表要扩 schema，非 runtime 行也要背这些可选键。

**继续在校验时拼一个顶层 CandidateRuntimeEvent。** 类型与磁盘继续分叉。

## 影响

[`src/core/schemas/candidate.ts`](../../../src/core/schemas/candidate.ts)、[`src/application/candidate-run-events.ts`](../../../src/application/candidate-run-events.ts)。

## 验证

`test/candidate/fake-target-runner.test.ts`：缺 `sessionId` 的 payload 校验失败；带 Envelope 字段但无 `sessionId` 的对象失败。`test/core/architecture.test.ts` 要求校验 `envelope.payload`，且 `CandidateRuntimeEventSchema` 不含 `eventId`。`npm run check` 必须通过。
