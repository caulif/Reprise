# 决策：Controller 私有任务理解回合

状态：superseded

被 [opening 同 Session](../accepted/2026-09-08-controller-opening-single-session.md) 取代。下文冻结，描述被放弃的独立 understand 回合。

## 问题

Controller 需要从完整历史会话中理解用户目标、后续动作、约束和协作习惯。仅在每次 steering 时按需读取历史，可能让最近一轮局部产物掩盖较早的格式变化或未完成交付。

## 决定

- 真实 `ControllerAgent` 在 opening 前执行一次私有 understanding 调用，不向候选发送用户消息。
- understanding 返回受 schema 约束的 Markdown、来源消息 id 和当时未完成动作。
- Host 将结果写入 run-owned、candidate 不可见的 `controller-task-understanding.md`，并记录 `controller.understanding` 事件。
- 后续 opening/steering 仍由 Controller 自己决定自然语言消息或 `done`；不把 HTML、PPT 或其他产品流程写入 Host 状态机。
- `ControllerPort.understand` 为可选能力，保留脚本 Controller 和恢复兼容性。

## 备选方案

**仅在 steering 时按需读取历史**：可能遗漏早期交付要求，故采用 opening 前的私有理解回合。

## 影响

Controller 不获得对候选工作区的写权限。画像由 Agent 生成，Host 只负责 schema 校验、路径隔离、持久化和恢复。理解调用失败时本次 run 不发送 opening，避免在没有任务画像的情况下继续模拟用户。

## 验证

- `test/controller-full-session-judgment.test.ts` 验证私有 understanding 调用和来源动作。
- `test/controller-briefing.test.ts` 验证画像写入 Host-owned briefing。
- `npm run build` 和受影响测试必须通过。
