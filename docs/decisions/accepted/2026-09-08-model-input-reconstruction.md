# 决策：模型可见输入完整记录并可重建

状态：accepted

延续 [事实源与身份草案](./2026-09-08-session-fact-owner-and-identity.md) 与 [生命周期](./2026-09-08-session-invocation-lifecycle.md)。目标批次见 [M1.3](../../plan/reprise-refactoring-execution.md#m13-完整记录并可重建模型输入)。

## 问题

Host 审计长期只存长度与 digest。空进程无法还原每次模型请求的系统输入、工具定义、用户正文、工具配对结果、压缩后的 summary 与 retained tail，也无法区分写失败后的假完成。

## 决定

模型可见输入的权威仍是 Experiment `events.jsonl`。`agent.session_started` 保存过滤后的 system prompt 与工具定义；每次送给模型的用户正文写入 `agent.message_appended`（含修复轮）；模型原文写入 `agent.model_output`；工具调用与结果用稳定 `toolCallId` 配对，结果正文在过滤后写入 `agent.tool_completed`；压缩写入 `agent.context_compacted` 的 summary、原因与 retained tail 正文。超过内联上限的正文与图片原始字节以 `agent_model_input` 附件引用，引用带 contentHash 与 byteLength，重建时校验。

秘密过滤发生在持久化和送给模型之前；事件只保存过滤后的文本，不保存凭据快照。用户正文必须先提交成功再调用模型；模型原文必须先提交成功，调用方才能看到 `invocation_completed`。附件落盘或引用发布失败不得报告成功。压缩不删除事件历史；下一轮试卷是 summary 加 retained tail，不能从压缩结果还原被切正文。`invalid_output` 审计仍只记分类与 digest，不以非法 JSON 原文作为通过校验的事实。

空进程只读 `events.jsonl` 与已提交附件重建每次请求。尾部半行、非法 JSON、缺附件和校验失败给出明确诊断，不补写推测过程。

## 备选方案

**继续只存 digest。** 无法满足从空进程重建试卷。

**以 Pi 会话 JSONL 为试卷源。** 与唯一 Experiment 写者分叉，且 Harness 会话 API 未实现。

**结果返回后再补记模型原文。** 崩溃会留下已成功调用却无输入/输出记录，或把未提交结果当成完成。

## 影响

事件 payload 出现 versioned text body 与可选附件引用；大试卷不再内联进 jsonl。旧日志缺少正文时仍不能补写，由 M1.4 只读解释。TUI 不投影这些内部输入事件。

## 验证

`test/agent-model-input.test.ts`：过滤后才记录和发送；写失败不调用模型；模型原文写失败不报成功；从关闭后的 `events.jsonl` 与附件重建含一次修复和一次压缩的请求；非法 JSON、不完整尾、缺附件和 checksum 失败可诊断。既有 Host 与压缩测试继续成立。
