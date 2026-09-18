# 决策：内部 Agent 的模型输入与工具审计进事件日志

状态：accepted

## 问题

Comparison 只有 `comparison.started` / `completed`，briefing 不落库。Controller 有 `controller.requested`，但工具调用不经 `AgentAuditSink`。进入模型的输入必须能从事件日志复原；工具页也必须可审计。

## 决定

调用 Comparison 前写入 `comparison.requested`：briefing JSON 进 artifact（上限 262_144 字节，超限截断并标记 `truncated`），事件保存 digest、artifactId、byteLength。Controller 与 Comparison 的 Pi session 与 Recovery 一样接入 ExperimentStore 的 `AgentAuditSink`，`agent.tool_*` 与 `agent.context_compacted` 进同一事件日志。`comparison.started` / `completed` 保留。

## 备选方案

**继续靠 store 重建 briefing。** 生成函数一改，旧实验无法复原当时的模型输入。

**只给 Comparison 补事件、Controller 不接 audit。** 工具页仍不可解释。

## 影响

`ExperimentStore` 校验 `comparison.requested` payload schema。编排测试断言该事件存在；反向：`experiment-report.ts` 缺少该 type 时架构测试失败。

## 验证

`test/architecture.test.ts` 扫描 `comparison.requested`；编排夹具 Comparison 跑完后事件含该 type 且 artifact 可读。
