# 决策：回放起点是用户任务句，不是产品注入的指令块

状态：accepted

## 问题

Codex / Claude Code 会把 skill、`AGENTS.md` 等上下文写成会话里靠前的 user 行。冻结若永远取第一条用户消息，`initialInput` 变成注入正文，对照候选会把指令块当成人话任务。列表已经用后续短句当标题，冻结起点仍钉在第一条，题目和回放条件不一致。

## 决定

Case Preparation **确定性**选择 `initialInput`：transcript 里第一条**不像注入指令块**的 user 消息（`AGENTS.md` 标题、`<INSTRUCTIONS>`、长 markdown 指令等）。找不到则退回第一条 user 消息。完整 transcript 仍写入 TaskCase，供 Controller 看到后续轮次。Recovery Agent 不解析产品 JSONL，不改 `initialInput`；它可以把工作区里仍需要、且不超过快照预算的指令文件写入 staging。出根 symlink / junction 不跟随拷贝。

## 备选方案

**永远用物理第一条 user 行。** 实现简单，但会把自动注入当成人话任务。

**让 Recovery 模型每次挑选起点。** 同一会话 freeze 结果不稳定，且把冻结资格交给模型。

**从 TaskCase 里删掉注入行。** Controller 会丢失产品实际见过的上下文。

## 影响

已冻结且 `initialInput` 仍是指令块的 case，在 `initialInput` 与新选择不一致时重写，不复用旧 `case.json`。出根大树（如 `node_modules`）继续跳过。

## 验证

`test/freeze-replay-input.test.ts`：首条 AGENTS、次条短任务 → `initialInput` 是短任务。反向：只有指令块时仍用第一条。`npm run check`。
