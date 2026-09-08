# 决策：Session 与 Invocation 生命周期分开

状态：accepted

延续 [事实源与身份草案](./2026-09-08-session-fact-owner-and-identity.md)。

## 问题

Host 在每次结构化请求成功时写入 `agent.session_completed`，并把 Session 对象的结束与单次 `request` 混在一起。上层无法区分“这次 Invocation 结束”和“这个角色 Session 关闭”，也无法在同一 Session 上安全地拒绝并发。

## 决定

`AgentSessionHost.request` 创建带稳定 `invocationId` 的 Invocation（优先使用调用方 `requestId`）。同一 Session 同时最多一个活动 Invocation；第二次并发 `request` 抛出错误，不串行交织消息。结构化修复继续原 Session，计入该 Invocation 的 `requestIndex`。

请求完成写入 `agent.invocation_completed` / `invocation_failed` / `invocation_cancelled`。`agent.session_completed` 只在 `close()` 时出现；`cancel()` 关闭 Session 并写 `agent.session_cancelled`。关闭后再 `request` 失败且不追加模型输入。

超时由 Host 按 Invocation 截止时间拥有。Provider 重试留在 `PiModelCaller`。Schema 修复由 Host `maxRepairAttempts` 拥有。`PiAgentHost.request` 一次性会话在 Invocation 结束后 `close()`。Controller 在 `release` 时关闭连续 Session。

TUI 对 Invocation 与 Session 生命周期事件保持不投影。晚到的 provider 文本在取消后不能改写 Invocation 终态。

## 备选方案

**把并发 Invocation 排队串行。** 会让取消和超时归属变得模糊，调用方已经有自己的 in-flight 拒绝。

**继续用 `session_completed` 表示请求成功。** 无法支持同一 Session 多次 Invocation，也与关闭语义冲突。

**取消后仍保持 Session 可追加。** 与“操作结束后关闭、禁止继续追加”冲突，且晚到响应容易写进已停止会话。

## 影响

新日志出现 Invocation 事件；旧日志里的 `agent.session_completed` 仍表示当时一次成功请求，由 M1.4 只读解释。磁盘 envelope 的 `type` 本就可以是任意字符串，不升 schemaVersion。完整模型正文仍待 M1.3。

## 验证

`test/agent-session-lifecycle.test.ts`：同 Session 两次调用共享 transcript 且 Invocation 身份不同；并发拒绝；取消后晚到文本不能完成；一次性 `request` 在 Invocation 后关闭 Session。既有 Host 修复、超时与 Controller 取消测试继续成立。
