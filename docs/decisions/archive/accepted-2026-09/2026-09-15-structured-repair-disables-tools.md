# 决策：结构化修复轮禁用工具

> 历史记录：正文保留当时的设计，不能据 accepted 或归档目录推定全部条款仍有效。当前规则从[文档导航](../../../README.md)进入。


状态：accepted
日期：2026-09-15

## 问题

结构化 `request` 的修复轮默认仍开启工具。Comparison JSON-only 机械禁工具，Recovery 只在 prompt 里请求不用工具，Controller 未提。修复轮还附带整份 `promptContent`，漏传时会把 `context` JSON 送进模型。

## 决定

`#attempt` 在 `attempts > 0` 时默认 `setToolsEnabled(false)`；请求可设 `allowToolsOnRepair: true`。首轮仍按 `allowTools !== false`。`promptContent` 必填；修复轮模板为契约加错误与 `repairInstruction`，不再附 `promptContent`，删除 `JSON.stringify(context)` 回退。

## 备选方案

**只在 prompt 里要求不用工具。** 模型仍可调用。

**三角色各自传 `allowTools: false`。** 漏传即回到不安全默认。

## 影响

修复轮出现 `agent.tool_called` 视为契约破坏。缺 `promptContent` 的结构化请求抛错。

## 验证

`test/application/agent-foundation.test.ts`：修复轮不得再发 `agent.tool_called`；空白 `promptContent` 抛错。`npm run check` 必须通过。
