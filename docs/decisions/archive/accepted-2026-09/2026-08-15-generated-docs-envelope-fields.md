# 决策：生成文档区输出信封字段表，不输出事件类型目录

状态：accepted

## 问题

`EventEnvelope.type` 在 `src/core/schema.ts` 里是 `Type.String`，不是判别联合。从 schema 生成不出「全部 `type` 取值及其 payload」的目录。若文档承诺生成类型清单，门禁即使修好了也兑现不了。

## 决定

生成区只输出 schema 里真实存在的字段表：`EventEnvelope` 的顶层字段，以及 `TaskCase` / `RunRecord` 的字段。事件 `type` 仍是开放字符串；类型清单不以生成文档的形式存在。

## 备选方案

**把 `EventEnvelope` 改成判别联合。** 事件类型由两个 Pack 和 Agent 在运行时追加，收成联合会把跨模块协议冻在 schema 里，每次加事件都要改 Core。信封保持开放字符串是有意的。

**手写类型清单。** 这正是生成区要消灭的漂移来源。

## 影响

- `scripts/gen-docs.mjs` 只从 TypeBox schema 投影字段表。
- 持久化文档的生成区标题是「事件信封字段」，与实现一致。
- 要查某个 `type` 的 payload，读对应 Pack 或 Agent 的写入点，不读生成区。

## 验证

- `docs/architecture/persistence-and-crash-consistency.md` 的 `event-catalog` 区是字段表，不是 `type` 枚举。
- 标记文本含括号时 `npm run verify:generated` 仍能检测篡改。
