# 决策：内部 Agent 轮间压缩工具正文

状态：accepted

## 问题

Pi session 在一次 `request` 的工具循环里会累积完整 tool 正文。Recovery 一次调查、Controller 多轮 `decide`、Comparison 写报告都会撑破上下文。压缩若只在信封完成之后做，Recovery / Comparison 的 session 已经结束。

## 决定

「一轮」是一次模型 completion 及其工具结果。Host 在 **下一次 completion 之前**（Pi `transformContext`）把早于最近一条 assistant 消息的 tool 正文换成 digest 占位；该 assistant 之后的 tool 结果保持全文。压缩写入 `agent.context_compacted`（被替换项的 toolName、byteLength、content digest）。完整正文已在当轮 `agent.tool_completed`。三个角色默认开启。不在 `src/agents/*.ts` 里改 transcript。

压缩后进入模型的是压缩过的 session（外加新调查包）。digest 对不上原文时不得把占位当作原文复原。

## 备选方案

**只压缩 Controller 两次 `append` 之间。** Recovery 单次调用内部的几十轮工具循环仍然撑窗口。

**丢掉 tool 正文且不记 digest。** 违反模型输入可复原。

## 影响

`PiModelCaller` 必须钩进 Agent 工具循环，不能只在 Host 信封 `completed` 之后压缩。

## 验证

`test/session-compact.test.ts`：较早 tool 正文变成含 digest 的占位，最近一批保持全文；伪造 digest 不等于原文 hash。
